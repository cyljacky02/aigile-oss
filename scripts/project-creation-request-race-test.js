// 驗收測試（ADR 0004、0005）：建立專案申請在交錯時的結果
// - 兩位審核人同時核准：後到的回 200 與先完成的結果（duplicate），不回 NAME_TAKEN
// - 送出冪等重送：原本的申請先寫成、政策接著改掉，重送仍回原本的申請（200），不回 403
// - 審核清單 scope=review：沒有審核權一律 404（跟其他看不到的申請一樣）
// - 預設看板狀態跟專案同一批建立（核准、直接建立），不等第一次讀取才補
// 做法：攔下第一個請求的讀取或寫入，先讓別的操作整個做完，再放行（SQLite、D1 一次只做一個交易，這就是會發生的交錯）。
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-request-race-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { DEFAULT_STATUSES } from '../src/statuses.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrrace-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
// beforeBatch：下一個含有符合 re 那句的寫入送出前先執行 run()；afterGet：下一個符合 re 的單列讀取讀完後先執行 run()（都只作用一次）
// seen：記下每一批寫入（看看預設狀態跟專案是不是同一批）
let beforeBatch = null, afterGet = null;
const seen = [];
const appDb = { ...db,
  batch: async stmts => {
    seen.push(stmts.map(s => s[0]));
    if (beforeBatch && stmts.some(([sql]) => beforeBatch.re.test(sql))) { const b = beforeBatch; beforeBatch = null; await b.run(); }
    return db.batch(stmts);
  },
  get: async (sql, ...args) => {
    const out = await db.get(sql, ...args);
    if (afterGet && afterGet.re.test(sql)) { const a = afterGet; afterGet = null; await a.run(); }
    return out;
  } };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = appCaller(app);
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.equal(r.status, status, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); if (errCode) assert.equal(code(r), errCode, label); return r.body; };
const n = async (sql, ...a) => Number((await db.get(sql, ...a)).n);
let seq = 0;
const rid = () => `race-${++seq}`;

try {
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const ann = await join('安娜'); // 第二位審核人
  const chen = await join('陳大文'); // 申請人
  const { adminSession } = await import('./test-admin.js');
  boss.token = (await adminSession(call, boss.token)).token;
  ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升為工作區管理員');
  ok(await call(boss.token, `/api/participants/${chen.id}/projects`, 'PUT', { projects: ['預設專案'] }), '陳加入預設專案');
  ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
  const submit = async (body, requestId = rid()) => is(await call(chen.token, '/api/project-creation-requests', 'POST', { requestId, reason: '要做新功能', ...body }), 201, null, `送出 ${body.name}`);
  const approve = (who, id) => call(who.token, `/api/project-creation-requests/${id}/approve`, 'POST', {});

  // 1) 兩位審核人同時核准：後到的那位在名稱預檢之前，先完成的已經建好專案 → 200、duplicate、同一個專案，不回 NAME_TAKEN
  {
    const r = await submit({ name: '同時核准' });
    let first = null;
    afterGet = { re: /^SELECT id, name FROM participants WHERE id = \?$/, run: async () => { first = await approve(boss, r.id); } };
    const late = await approve(ann, r.id);
    assert.equal(afterGet, null, '真的有交錯');
    const won = ok(first, '先完成的核准');
    const lost = is(late, 200, null, '後到的核准');
    assert.equal(lost.duplicate, true, '後到的回原本的結果');
    assert.equal(lost.state, 'approved');
    assert.equal(lost.project?.id ?? null, won.project?.id ?? null, '同一個專案');
    assert.equal(await n('SELECT COUNT(*) AS n FROM projects WHERE name = ?', '同時核准'), 1, '只建了一個專案');
    console.log('✓ 兩位審核人同時核准：後到的回 200 與原結果');
  }

  // 2) 送出冪等重送：原本的那次在重送寫入前完成，而且政策接著改掉（待審申請被取消）→ 重送回原本的申請（200），不回 403
  {
    const body = { requestId: rid(), reason: '要做新功能', name: '重送' };
    let first = null;
    beforeBatch = { re: /^INSERT INTO project_creation_requests/, run: async () => {
      first = await call(chen.token, '/api/project-creation-requests', 'POST', body);
      ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'members' }), '政策改成所有成員');
    } };
    const again = await call(chen.token, '/api/project-creation-requests', 'POST', body);
    assert.equal(beforeBatch, null, '真的有交錯');
    const orig = is(first, 201, null, '原本的送出');
    const dup = is(again, 200, null, '重送');
    assert.equal(dup.duplicate, true);
    assert.equal(dup.id, orig.id, '回原本那份申請');
    assert.equal(dup.state, 'cancelled', '原本那份已因政策改變而取消');
    assert.equal(await n('SELECT COUNT(*) AS n FROM project_creation_requests WHERE request_id = ?', body.requestId), 1, '只有一份申請');
    ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策改回 approval');
    console.log('✓ 送出冪等重送：原本的先寫成、政策接著改掉，仍回原本的申請');
  }

  // 3) 審核清單：沒有審核權的人一律 404
  {
    is(await call(chen.token, '/api/project-creation-requests?scope=review'), 404, 'NOT_FOUND', '成員看審核清單');
    ok(await call(ann.token, '/api/project-creation-requests?scope=review'), '審核人看審核清單');
    console.log('✓ 審核清單：沒有審核權 404');
  }

  // 4) 預設看板狀態跟專案同一批寫入：核准（沒指定看板狀態）後還沒人讀看板，資料庫裡就已經有預設狀態組
  {
    const r = await submit({ name: '預設狀態' });
    ok(await approve(boss, r.id), '核准');
    const pid = (await db.get('SELECT id FROM projects WHERE name = ?', '預設狀態')).id;
    const rows = await db.all('SELECT name, category, color FROM project_statuses WHERE project = ? ORDER BY position', pid);
    assert.deepEqual(rows.map(s => ({ name: s.name, category: s.category, color: s.color })), DEFAULT_STATUSES, '預設狀態組');
    // 直接建立：建立專案那一批就含預設狀態組
    ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'members' }), '政策改成所有成員');
    seen.length = 0;
    ok(await call(chen.token, '/api/projects', 'POST', { name: '直接建立的預設狀態' }), '直接建立');
    const createBatch = seen.find(b => b.some(sql => /^INSERT INTO projects \(/.test(sql)));
    assert.equal(createBatch.filter(sql => /^INSERT INTO project_statuses/.test(sql)).length > 0, true, '建立那一批就寫預設狀態');
    const did = (await db.get('SELECT id FROM projects WHERE name = ?', '直接建立的預設狀態')).id;
    assert.equal(await n('SELECT COUNT(*) AS n FROM project_statuses WHERE project = ?', did), DEFAULT_STATUSES.length, '恰好一組預設狀態');
    console.log('✓ 預設看板狀態跟專案同一批建立');
  }

  console.log('project-creation-request-race-test：全部通過');
} catch (e) {
  console.error('project-creation-request-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
