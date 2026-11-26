// 規格 #39 的核心驗收條件（#48）：
//   每一份成功核准的建立專案申請，恰好對應一個在同一次核准中完整建立的專案；
//   任何失敗、拒絕、撤回、取消或未核准的申請，都不會因此建立專案。
// 做法：讓申請走過所有結局——核准（含不同內容、同時核准、重送核准）、核准失敗（同名、指定識別碼被占用、政策已改、申請人不符資格、
// 核准那一批在資料庫裡做到一半才失敗：每一句之後各試一次）、拒絕、撤回、各種系統取消、一直待審——最後從 API 讀全部申請、全部專案、
// 全部 project.create 稽核、專案成員，逐份對照：
//   已核准 ⇔ 有 project_id；那個專案存在、內容跟申請一樣、建立時間＝核准時間、唯一的成員是申請人（專案管理員）、剛好一筆 approved_request 稽核指向這份申請
//   其他狀態 ⇔ 沒有 project_id、沒有任何稽核指向它；所有專案都有自己的 project.create（沒有多出來的專案、沒有孤兒成員資格）
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-core-acceptance-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pccore-'));
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.deepEqual([r.status, r.body?.error?.code], [status, errCode], `${label}：${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const db = await openTestDb(path.join(dataDir, 'switch.db'));
// hooks：before＝下一個含符合 re 那句的批次送出前先執行 run()；breakAfter＝下一個含符合 re 那句的批次，在那句之後插一句會在資料庫裡失敗的語句
// （前面的句子已經在交易裡執行了，交易要整批回復）。都只作用一次
const hooks = { before: null, breakAfter: null };
const hit = (slot, stmts) => (hooks[slot] && stmts.some(([sql]) => hooks[slot].re.test(sql)) ? hooks[slot] : null);
const appDb = { ...db, batch: async stmts => {
  const b = hit('before', stmts); if (b) { hooks.before = null; await b.run(); }
  const k = hit('breakAfter', stmts);
  if (k) { hooks.breakAfter = null; let done = false; stmts = stmts.flatMap(st => (!done && k.re.test(st[0]) ? (done = true, [st, ['SELECT x FROM no_such_table_core_acceptance', []]]) : [st])); }
  return db.batch(stmts);
} };
const call = appCaller(createApp({ db: appDb, storage: dbStorage(db), docText: '', config: CONFIG }));
const APPROVE_BATCH = /^INSERT INTO projects \(/;
let seq = 0;

try {
  const join = async name => { const b = ok(await call(null, '/api/join', 'POST', { name, role: 'PG' }), name); return { token: b.token, id: b.participant.participantId, name }; };
  const boss = await join('林志明'); // 平台管理員＋工作區管理員（審核人）
  const ann = await join('安娜'); // 另一位審核人
  boss.token = (await adminSession(call, boss.token)).token;
  ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升為工作區管理員');
  const people = {};
  for (const n of ['陳大文', '王小美', '丹尼', '伊芙', '菲菲', '古斯']) { people[n] = await join(n); ok(await call(boss.token, `/api/participants/${people[n].id}/projects`, 'PUT', { projects: ['預設專案'] }), n); }
  const { 陳大文: chen, 王小美: wang, 丹尼: dan, 伊芙: eve, 菲菲: fay, 古斯: gus } = people;
  const setPolicy = async v => ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: v }), `政策設成 ${v}`);
  await setPolicy('approval');
  const submit = async (who, body = {}) => ok(await call(who.token, '/api/project-creation-requests', 'POST', { requestId: `core-${++seq}`, name: `核心${seq}`, reason: '要做', ...body }), '送出');
  const approve = (q, who = boss) => call(who.token, `/api/project-creation-requests/${q.id}/approve`, 'POST', {});
  const reject = (q, who = boss) => call(who.token, `/api/project-creation-requests/${q.id}/reject`, 'POST', { reason: '不需要' });
  const expected = new Map(); // 申請 id → 預期的結局（state）

  // ---------- 核准成功：各種內容 ----------
  const STATUSES = [{ name: '想法', category: '待處理' }, { name: '動手', category: '進行中' }, { name: '收工', category: '已完成' }];
  for (const [who, body] of [[chen, {}], [chen, { visibility: 'private', slug: 'core-secret', code: 'CSEC' }], [wang, { visibility: 'open', statuses: STATUSES }], [wang, { name: 'Core Auto' }]]) {
    const q = await submit(who, body);
    assert.equal(ok(await approve(q), '核准').state, 'approved');
    expected.set(q.id, 'approved');
  }
  // 重送核准（另一位審核人、同一位）：拿回原本的結果，不建第二個
  {
    const q = await submit(chen);
    const first = ok(await approve(q, ann), '核准');
    const again = ok(await approve(q, boss), '重送核准');
    assert.deepEqual([again.duplicate, again.project.id], [true, first.project.id]);
    ok(await approve(q, ann), '同一位再按一次');
    expected.set(q.id, 'approved');
  }
  // 同時核准（第二個在第一個寫入前整個做完）：只建一個
  {
    const q = await submit(wang);
    let inner = null;
    hooks.before = { re: APPROVE_BATCH, run: async () => { inner = await approve(q, ann); } };
    const outer = ok(await approve(q, boss), '後寫入的核准');
    assert.equal(inner.status, 200);
    assert.equal(outer.project.id, inner.body.project.id, '同一個專案');
    expected.set(q.id, 'approved');
  }

  // ---------- 核准那一批做到一半在資料庫裡失敗：每一句之後各試一次，什麼都不留；之後再核准成功 ----------
  for (const re of [/^INSERT INTO projects \(/, /^INSERT INTO project_events/, /^INSERT INTO project_statuses/, /^INSERT INTO app_settings/, /^INSERT INTO project_members/,
    /^UPDATE participants SET updated_at/, /^INSERT INTO audit_log/, /^UPDATE project_creation_requests SET state/, /^INSERT INTO account_notices/]) {
    const q = await submit(fay, { statuses: STATUSES });
    hooks.breakAfter = { re };
    const r = await approve(q);
    assert.equal(hooks.breakAfter, null, `真的在 ${re} 之後失敗`);
    assert.ok(r.status >= 500, `${re} 之後失敗：5xx，不冒充業務衝突：${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM projects WHERE name = ?', q.name)).n), 0, `${re} 之後失敗：沒有留下專案`);
    assert.equal((await db.get('SELECT state FROM project_creation_requests WHERE id = ?', q.id)).state, 'pending', '申請維持待審核');
    if (seq % 2) { ok(await approve(q), '重試核准成功'); expected.set(q.id, 'approved'); } else expected.set(q.id, 'pending');
  }

  // ---------- 核准失敗（業務原因）：申請維持待審核，不建立 ----------
  ok(await call(boss.token, '/api/projects', 'POST', { name: '已有的專案', slug: 'taken-slug', code: 'TAKN' }), '管理員直接建立一個專案');
  for (const [body, errCode] of [[{ name: '已有的專案' }, 'NAME_TAKEN'], [{ slug: 'taken-slug' }, 'SLUG_TAKEN'], [{ code: 'TAKN' }, 'CODE_TAKEN']]) {
    const q = await submit(gus, body);
    is(await approve(q), 409, errCode, `核准失敗：${errCode}`);
    expected.set(q.id, 'pending');
  }
  {
    const q = await submit(gus);
    hooks.before = { re: APPROVE_BATCH, run: () => db.run("UPDATE participants SET workspace_status = 'removed' WHERE id = ?", gus.id) };
    is(await approve(q), 409, 'REQUESTER_NOT_ELIGIBLE', '交易內才發現申請人不符資格');
    await db.run("UPDATE participants SET workspace_status = 'active' WHERE id = ?", gus.id);
    hooks.before = { re: APPROVE_BATCH, run: () => db.run("UPDATE workspaces SET create_projects = 'members' WHERE id = 'default'") };
    is(await approve(q), 409, 'POLICY_CHANGED', '交易內才發現政策已改');
    await db.run("UPDATE workspaces SET create_projects = 'approval' WHERE id = 'default'");
    expected.set(q.id, 'pending');
  }

  // ---------- 拒絕、撤回；拒絕或撤回之後再核准 ----------
  {
    const r1 = await submit(chen); ok(await reject(r1), '拒絕'); is(await approve(r1), 409, 'REQUEST_NOT_PENDING', '拒絕後核准'); expected.set(r1.id, 'rejected');
    const w1 = await submit(wang); ok(await call(wang.token, `/api/project-creation-requests/${w1.id}/withdraw`, 'POST'), '撤回'); is(await approve(w1), 409, 'REQUEST_NOT_PENDING', '撤回後核准'); expected.set(w1.id, 'withdrawn');
    // 核准與拒絕交錯：拒絕先寫入 → 核准 409
    const r2 = await submit(chen);
    hooks.before = { re: APPROVE_BATCH, run: async () => ok(await reject(r2, ann), '另一位先拒絕') };
    is(await approve(r2), 409, 'REQUEST_NOT_PENDING', '拒絕先完成');
    expected.set(r2.id, 'rejected');
  }

  // ---------- 系統取消：移出、停用、離開、政策切走；取消之後再核准 ----------
  {
    const d = await submit(dan); ok(await call(boss.token, `/api/participants/${dan.id}/remove`, 'POST'), '移出丹尼'); expected.set(d.id, 'cancelled');
    const e = await submit(eve); ok(await call(boss.token, `/api/participants/${eve.id}/disable`, 'POST'), '停用伊芙'); expected.set(e.id, 'cancelled');
    const g = await submit(gus, { name: '古斯要離開' }); ok(await call(gus.token, '/api/leave', 'POST'), '古斯離開'); expected.set(g.id, 'cancelled');
    for (const [k, v] of expected) if (v === 'pending' && (await db.get('SELECT requester_id FROM project_creation_requests WHERE id = ?', k)).requester_id === gus.id) expected.set(k, 'cancelled'); // 古斯其他待審的也一起取消
    for (const q of [d, e, g]) is(await approve(q), 409, 'REQUEST_NOT_PENDING', '取消後核准');
    // 核准交錯：政策在核准那一批之前切走（取消全部待審）→ 核准 409，不建立
    const p = await submit(chen);
    hooks.before = { re: APPROVE_BATCH, run: () => setPolicy('admins') };
    assert.equal((await approve(p)).status, 409, '政策先切走');
    for (const [k, v] of expected) if (v === 'pending') expected.set(k, 'cancelled');
    expected.set(p.id, 'cancelled');
    await setPolicy('approval');
  }
  // ---------- 一直待審 ----------
  for (let i = 0; i < 2; i++) expected.set((await submit(wang)).id, 'pending');

  // ================= 對照 =================
  const all = [];
  for (let cursor = null; ;) {
    const page = ok(await call(boss.token, `/api/project-creation-requests?scope=review&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), '審核人讀全部申請');
    all.push(...page.items);
    if (!(cursor = page.nextCursor)) break;
  }
  assert.equal(all.length, expected.size, '每一份申請都讀得到');
  const audits = [];
  for (let before = null; ;) {
    const page = ok(await call(boss.token, `/api/audit-log?action=project.create&limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`), '稽核紀錄');
    audits.push(...page.items);
    if (!(before = page.next)) break;
  }
  const projects = ok(await call(boss.token, '/api/projects'), '全部專案').items;
  const byProject = new Map(projects.map(p => [p.id, p]));
  const auditsFor = id => audits.filter(a => a.detail?.requestId === id);
  let approved = 0;
  for (const r of all) {
    assert.equal(r.state, expected.get(r.id), `${r.name} 的結局：${r.state}（預期 ${expected.get(r.id)}）`);
    const row = await db.get('SELECT project_id, ended_at, ended_by, requester_id FROM project_creation_requests WHERE id = ?', r.id);
    if (r.state !== 'approved') {
      assert.equal(row.project_id, null, `${r.name}（${r.state}）沒有專案`);
      assert.equal(auditsFor(r.id).length, 0, `${r.name}（${r.state}）沒有 project.create`);
      continue;
    }
    approved++;
    const p = byProject.get(row.project_id);
    assert.ok(p, `${r.name}：核准建立的專案存在`);
    assert.deepEqual([p.name, p.visibility], [r.name, r.visibility], `${r.name}：專案內容跟申請一樣`);
    if (r.slug) assert.equal(p.slug, r.slug, '指定的網址英文名');
    if (r.code) assert.equal(p.code, r.code, '指定的代號');
    if (r.statuses) assert.deepEqual(ok(await call(boss.token, `/api/projects/${p.id}/statuses`), '看板狀態').items.map(s => s.name), r.statuses.map(s => s.name), '看板狀態');
    const created = await db.get('SELECT created_at, created_by FROM projects WHERE id = ?', p.id);
    assert.deepEqual([created.created_at, created.created_by], [row.ended_at, row.ended_by], `${r.name}：專案在同一次核准中建立（時間、執行者＝核准）`);
    const a = auditsFor(r.id);
    assert.equal(a.length, 1, `${r.name}：剛好一筆 project.create`);
    assert.deepEqual([a[0].detail.method, a[0].target.id, a[0].actor.id, a[0].detail.requester.id], ['approved_request', p.id, row.ended_by, row.requester_id], `${r.name}：稽核指向這份申請與專案`);
    const members = ok(await call(boss.token, `/api/projects/${p.id}/members`), '專案成員').members;
    assert.deepEqual(members.map(m => [m.participantId, m.role]), [[row.requester_id, 'admin']], `${r.name}：唯一的成員是申請人（專案管理員），審核人不加入`);
  }
  // 反方向：每一筆 approved_request 稽核都對到一份已核准的申請；每個專案都有自己的 project.create；沒有孤兒成員資格
  const viaRequest = audits.filter(a => a.detail?.method === 'approved_request');
  assert.equal(viaRequest.length, approved, 'approved_request 稽核數＝已核准申請數');
  assert.equal(new Set(viaRequest.map(a => a.target.id)).size, approved, '每個核准建立的專案只有一筆');
  const allProjects = await db.all('SELECT id FROM projects');
  const audited = new Set(audits.map(a => a.target.id));
  for (const { id } of allProjects) if (!['預設專案', '第二專案'].includes(id)) assert.ok(audited.has(id), `專案 ${id} 有自己的 project.create（沒有多出來的專案）`);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM project_members m WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = m.project_id)')).n), 0, '沒有孤兒成員資格');
  assert.ok(approved >= 8 && [...expected.values()].filter(v => v !== 'approved').length >= 10, '各種結局都有走到');
  console.log(`project-creation-core-acceptance-test：全部通過（${all.length} 份申請，${approved} 份核准＝${approved} 個專案）`);
} finally {
  await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
