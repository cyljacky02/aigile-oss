// 驗收測試（#45；ADR 0005）：Postgres 上用不同的資料庫連線真的同時核准建立專案申請
// 第一個請求停在提交前（工作區列鎖還拿著），第二個請求在另一份程式（另一組連線）開始、被工作區列鎖擋住；第一個提交後第二個才繼續：
//   1. 同時核准：只建立一個專案，後完成的拿到原本的結果（200）
//   2. 核准與拒絕：拒絕 409，申請維持已核准
//   3. 核准與撤回：撤回 409
//   4. 審核人被降級與核准：降級先完成，核准的交易內斷言擋下（看不到了 → 404），沒有專案
//   5. 直接建立與核准搶同一個指定代號：核准 409 CODE_TAKEN（指出欄位、不透露占用者），申請維持待審核
// 申請與政策切換、移出、停用的交錯在 project-creation-request-pg-race-test.js（#46）。
// 只有 Postgres 會有兩個寫入交易同時進行；沒設 AIGILE_TEST_PG_URL 就略過。用法：AIGILE_TEST_PG_URL=… node scripts/project-creation-request-approve-pg-race-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { adminSession } from './test-admin.js';

if (!TEST_PG_URL) { console.log('project-creation-request-approve-pg-race-test：略過（只有 Postgres 會有兩個寫入交易同時進行）'); process.exit(0); }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrapprace-'));
const opened = [];
const open = async name => { const db = await openTestDb(path.join(dataDir, name)); opened.push(db); return db; };
const { default: pg } = await import('pg');
const ctl = new pg.Client({ connectionString: TEST_PG_URL }); // 測試自己的連線：拿 advisory lock、看誰在等鎖
await ctl.connect();
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('等太久：' + label); await new Promise(r => setTimeout(r, 25)); } };
const lockWait = like => ctl.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]).then(r => r.rows[0].n > 0);
// 包一層資料庫：pause＝下一個含符合 re 那句的批次，在那句之後停住（等測試放開 advisory lock）
const gated = db => {
  const g = { pause: null };
  g.db = { ...db, batch: async stmts => {
    const p = g.pause && stmts.some(([sql]) => g.pause.re.test(sql)) ? g.pause : null;
    if (p) { g.pause = null; stmts = stmts.flatMap(st => (p.re.test(st[0]) ? [st, [`SELECT pg_advisory_xact_lock(${p.key})`, []]] : [st])); }
    return db.batch(stmts);
  } };
  return g;
};
// first 做到 re 那句停住 → second 開始，等它被工作區列鎖擋住或做完 → 放行 first
let key = 4_245_450_000;
async function race(g1, re, first, second) {
  key++;
  await ctl.query('SELECT pg_advisory_lock($1)', [key]);
  g1.pause = { re, key };
  const p1 = first();
  await until(() => lockWait(`%pg_advisory_xact_lock(${key})%`), 10000, '第一個停在交易中');
  let done2 = false;
  const p2 = second().finally(() => { done2 = true; });
  await until(async () => done2 || await lockWait('%UPDATE workspaces%'), 10000, '第二個被鎖住或做完');
  const blocked = !done2;
  await ctl.query('SELECT pg_advisory_unlock($1)', [key]);
  return { r1: await p1, r2: await p2, blocked };
}
const show = r => `${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;

try {
  const a = await open('switch.db'), b = await open('switch.db'); // 同一個 schema、不同的連線池
  const config = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
  const g1 = gated(a);
  const mk = db => { const app = createApp({ db, storage: dbStorage(a), docText: '', config });
    return async (token, p, method = 'GET', body) => { const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost'); return { status: r.status, body: await r.json().catch(() => ({})) }; }; };
  const call1 = mk(g1.db), call2 = mk(b);
  const join = async (name, role = 'PG') => { const x = (await call1(null, '/api/join', 'POST', { name, role })).body; return { token: x.token, id: x.participant.participantId }; };
  const boss = await join('林志明', 'PO');
  const ann = await join('安娜');
  const chen = await join('陳大文');
  boss.token = (await adminSession(call1, boss.token)).token; // 升降管理員要再驗證過的裝置
  assert.equal((await call1(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '安娜升為工作區管理員');
  assert.equal((await call1(boss.token, `/api/participants/${chen.id}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  assert.equal((await call1(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' })).status, 200, '政策設成 approval');
  for (const t of [boss.token, ann.token, chen.token]) for (const c of [call1, call2]) assert.equal((await c(t, '/api/me')).status, 200, '兩份程式都認得（在線時間先寫掉）');
  let n = 0;
  const submit = async (body = {}) => { const r = await call1(chen.token, '/api/project-creation-requests', 'POST', { requestId: `race-${++n}`, name: `競態${n}`, reason: 'x', ...body }); assert.equal(r.status, 201, show(r)); return r.body; };
  const approve = (call, who, id) => call(who.token, `/api/project-creation-requests/${id}/approve`, 'POST', {});
  const count = async (sql, ...args) => Number((await a.get(sql, ...args)).n);
  const state = async id => (await a.get('SELECT state FROM project_creation_requests WHERE id = ?', id)).state;
  const CREATE = /^INSERT INTO projects \(/;

  // 1) 同時核准
  {
    const q = await submit();
    const { r1, r2, blocked } = await race(g1, CREATE, () => approve(call1, ann, q.id), () => approve(call2, boss, q.id));
    assert.ok(blocked, '第二個核准要等第一個做完');
    assert.equal(r1.status, 200, show(r1));
    assert.equal(r1.body.duplicate, false);
    assert.equal(r2.status, 200, '後完成的核准拿到原本的結果：' + show(r2));
    assert.equal(r2.body.duplicate, true);
    assert.equal(r2.body.project.id, r1.body.project.id, '同一個專案');
    assert.equal(await count('SELECT COUNT(*) AS n FROM projects WHERE name = ?', q.name), 1, '只建立一個專案');
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.create' AND target_id = ?", r1.body.project.id), 1, '一筆稽核');
    assert.equal(await count("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_approved' AND participant_id = ?", chen.id), 1, '一則通知');
    console.log('✓ Postgres：兩個連線同時核准，只建立一個專案，後完成的拿到原本的結果');
  }
  // 2) 核准與拒絕
  {
    const q = await submit();
    const { r1, r2, blocked } = await race(g1, CREATE, () => approve(call1, ann, q.id), () => call2(boss.token, `/api/project-creation-requests/${q.id}/reject`, 'POST', { reason: '不需要' }));
    assert.ok(blocked, '拒絕要等核准做完');
    assert.equal(r1.status, 200, show(r1));
    assert.deepEqual([r2.status, r2.body.error?.code], [409, 'REQUEST_NOT_PENDING'], '拒絕：' + show(r2));
    assert.equal(await state(q.id), 'approved');
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project_creation_request.reject' AND detail LIKE ?", `%${q.id}%`), 0, '沒有拒絕的稽核');
    console.log('✓ Postgres：核准與拒絕同時進行，只有先完成的核准生效，拒絕 409');
  }
  // 3) 核准與撤回
  {
    const q = await submit();
    const { r1, r2, blocked } = await race(g1, CREATE, () => approve(call1, ann, q.id), () => call2(chen.token, `/api/project-creation-requests/${q.id}/withdraw`, 'POST'));
    assert.ok(blocked, '撤回要等核准做完');
    assert.equal(r1.status, 200, show(r1));
    assert.deepEqual([r2.status, r2.body.error?.code], [409, 'REQUEST_NOT_PENDING'], '撤回：' + show(r2));
    assert.equal(await state(q.id), 'approved');
    console.log('✓ Postgres：核准與撤回同時進行，撤回 409');
  }
  // 4) 直接建立與核准搶同一個指定代號
  {
    const q = await submit({ code: 'SAME' });
    const { r1, r2, blocked } = await race(g1, CREATE, () => call1(boss.token, '/api/projects', 'POST', { name: '直接建立的祕密', code: 'SAME', visibility: 'private' }), () => approve(call2, ann, q.id));
    assert.ok(blocked, '核准要等直接建立做完');
    assert.equal(r1.status, 201, show(r1));
    assert.deepEqual([r2.status, r2.body.error?.code, r2.body.error?.field], [409, 'CODE_TAKEN', 'code'], '核准：' + show(r2));
    assert.ok(!JSON.stringify(r2.body).includes('直接建立的祕密'), '不透露占用者');
    assert.equal(await state(q.id), 'pending', '申請維持待審核');
    assert.equal(await count("SELECT COUNT(*) AS n FROM app_settings WHERE key >= 'pcode:' AND key < 'pcode;' AND value = 'SAME'"), 1, '只有一個專案用 SAME');
    assert.equal(await count('SELECT COUNT(*) AS n FROM projects WHERE name = ?', q.name), 0, '沒有建立申請的專案');
    console.log('✓ Postgres：直接建立與核准搶同一個代號，核准 409 CODE_TAKEN、申請維持待審核');
  }
  // 5) 審核人被降級與核准（降級先開始）
  {
    const q = await submit();
    const { r1, r2, blocked } = await race(g1, /^UPDATE participants SET workspace_role/, () => call1(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'member' }), () => approve(call2, ann, q.id));
    assert.ok(blocked, '核准要等降級做完');
    assert.equal(r1.status, 200, '降級：' + show(r1));
    assert.deepEqual([r2.status, r2.body.error?.code], [404, 'NOT_FOUND'], '被降級的審核人（看不到這份申請了）：' + show(r2));
    assert.equal(await state(q.id), 'pending');
    assert.equal(await count('SELECT COUNT(*) AS n FROM projects WHERE name = ?', q.name), 0, '沒有建立專案');
    console.log('✓ Postgres：審核人被降級與核准同時進行，降級先完成，核准被交易內斷言擋下');
  }
  console.log('project-creation-request-approve-pg-race-test：全部通過');
} catch (e) {
  console.error('project-creation-request-approve-pg-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await ctl.end().catch(() => {});
  for (const d of opened) await d.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
