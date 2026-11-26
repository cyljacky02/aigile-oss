// 驗收測試（規格 #39「部署與啟用」「核准結果與錯誤」）：建立專案申請的所有部署防護，每個申請端點各自確認，擋下時什麼都沒寫
// 1. 申請資料表還沒建立（程式先部署）：送出、列表、單筆、核准、拒絕、撤回都 503 PROJECT_CREATION_REQUESTS_NOT_READY；直接建立、政策預覽照常
// 2. 還原備份中：送出、撤回、核准、拒絕都 503 RESTORING；還原完成後照常
// 3. 識別碼正規化還沒完成：核准（會建立專案）503 IDENTITY_NOT_READY；送出、撤回、拒絕不動識別碼，照常
// 4. 稽核表還沒建立：核准、拒絕 503 AUDIT_NOT_READY（必要稽核）；送出、撤回不寫稽核，照常
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-request-guards-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { IDENTITY_READY_KEY } from '../src/project-identity.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrguard-'));
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const dbs = [];
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.deepEqual([r.status, r.body?.error?.code], [status, errCode], `${label}：${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const count = async (db, sql, ...args) => Number((await db.get(sql, ...args)).n);
// 一個站：blockReady＝寫入「識別碼已正規化」標記的那批一律失敗（正規化做不成）
async function site(name) {
  const db = await openTestDb(path.join(dataDir, name, 'switch.db'));
  dbs.push(db);
  const ctl = { blockReady: false, db };
  const appDb = { ...db, batch: async stmts => {
    if (ctl.blockReady && stmts.some(([sql, a]) => /VALUES/.test(sql) && (a || [])[0] === IDENTITY_READY_KEY)) throw new Error('模擬：正規化寫不進去');
    return db.batch(stmts);
  } };
  ctl.app = () => appCaller(createApp({ db: appDb, storage: dbStorage(db), docText: '', config: CONFIG }));
  ctl.call = ctl.app();
  const join = async n => { const b = ok(await ctl.call(null, '/api/join', 'POST', { name: n, role: 'PG' }), n); return { token: b.token, id: b.participant.participantId }; };
  ctl.boss = await join('林志明'); // 平台管理員＋工作區管理員
  ctl.chen = await join('陳大文'); // 一般成員
  ok(await ctl.call(ctl.boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
  let n = 0;
  ctl.submit = (call = ctl.call) => call(ctl.chen.token, '/api/project-creation-requests', 'POST', { requestId: `${name}-${++n}`, name: `${name}${n}`, reason: 'x' });
  // 會被寫入的東西（擋下時要完全不變）
  ctl.snapshot = async () => JSON.stringify(await Promise.all([
    db.all('SELECT id, state FROM project_creation_requests ORDER BY id').catch(() => null),
    count(db, 'SELECT COUNT(*) AS n FROM projects'), count(db, 'SELECT COUNT(*) AS n FROM project_members'),
    count(db, 'SELECT COUNT(*) AS n FROM audit_log').catch(() => null), count(db, 'SELECT COUNT(*) AS n FROM account_notices'),
  ]));
  return ctl;
}
const endpoints = (s, id) => ({
  核准: (call = s.call) => call(s.boss.token, `/api/project-creation-requests/${id}/approve`, 'POST', {}),
  拒絕: (call = s.call) => call(s.boss.token, `/api/project-creation-requests/${id}/reject`, 'POST', { reason: '不需要' }),
  撤回: (call = s.call) => call(s.chen.token, `/api/project-creation-requests/${id}/withdraw`, 'POST'),
});

try {
  // ---------- 1) 申請資料表還沒建立：所有申請端點 503；直接建立與政策預覽照常 ----------
  {
    const s = await site('notable');
    const q = ok(await s.submit(), '送出');
    await s.db.run('DROP TABLE project_creation_requests');
    const e = endpoints(s, q.id);
    const blocked = {
      送出: () => s.submit(), 列表: () => s.call(s.chen.token, '/api/project-creation-requests'), 審核清單: () => s.call(s.boss.token, '/api/project-creation-requests?scope=review'),
      單筆: () => s.call(s.boss.token, `/api/project-creation-requests/${q.id}`), 核准: e.核准, 拒絕: e.拒絕, 撤回: e.撤回,
    };
    const before = await s.snapshot();
    for (const [label, run] of Object.entries(blocked)) is(await run(), 503, 'PROJECT_CREATION_REQUESTS_NOT_READY', `資料表未就緒：${label}`);
    assert.equal(await s.snapshot(), before, '什麼都沒寫');
    assert.equal(ok(await s.call(s.boss.token, '/api/workspace/settings/create-projects-preview'), '政策預覽').pendingProjectCreationRequests, 0);
    is(await s.call(s.boss.token, '/api/projects', 'POST', { name: '空窗期直接建立' }), 201, undefined, '直接建立照常');
    console.log('✓ 申請資料表未就緒：送出、列表、單筆、核准、拒絕、撤回都 503，直接建立照常');
  }

  // ---------- 2) 還原備份中：送出、撤回、核准、拒絕都 503 RESTORING，什麼都沒寫 ----------
  {
    const s = await site('restoring');
    const q = ok(await s.submit(), '送出');
    const e = endpoints(s, q.id);
    await s.db.run("INSERT INTO app_settings (key, value) VALUES ('restore_state', ?)", JSON.stringify({ by: 'someone', at: new Date().toISOString() }));
    const before = await s.snapshot();
    try {
      for (const [label, run] of Object.entries({ 送出: () => s.submit(), 核准: e.核准, 拒絕: e.拒絕, 撤回: e.撤回 })) is(await run(), 503, 'RESTORING', `還原中：${label}`);
      assert.equal(await s.snapshot(), before, '還原中：什麼都沒寫');
      ok(await s.call(s.boss.token, `/api/project-creation-requests/${q.id}`), '還原中照樣讀得到');
    } finally { await s.db.run("DELETE FROM app_settings WHERE key = 'restore_state'"); }
    assert.equal(ok(await e.核准(), '還原完成後核准').state, 'approved');
    console.log('✓ 還原中：送出、撤回、核准、拒絕都 503 RESTORING，什麼都沒寫；還原完成後照常');
  }

  // ---------- 3) 識別碼正規化還沒完成：核准 503 IDENTITY_NOT_READY；送出、撤回、拒絕照常 ----------
  {
    const s = await site('identity');
    const q = ok(await s.submit(), '送出');
    s.blockReady = true;
    await s.db.run('DELETE FROM app_settings WHERE key = ?', IDENTITY_READY_KEY);
    const call = s.app(); // 新的一份程式（開機時正規化做不成）
    const e = endpoints(s, q.id);
    const before = await s.snapshot();
    is(await e.核准(call), 503, 'IDENTITY_NOT_READY', '正規化未完成：核准');
    is(await e.核准(call), 503, 'IDENTITY_NOT_READY', '再按一次也一樣');
    assert.equal(await s.snapshot(), before, '核准什麼都沒寫');
    assert.equal((await s.db.get('SELECT state FROM project_creation_requests WHERE id = ?', q.id)).state, 'pending');
    const q2 = ok(await s.submit(call), '正規化未完成：送出照常（不保留識別碼）');
    assert.equal(ok(await endpoints(s, q2.id).撤回(call), '撤回照常').state, 'withdrawn');
    assert.equal(ok(await e.拒絕(call), '拒絕照常').state, 'rejected');
    s.blockReady = false;
    const q3 = ok(await s.submit(call), '送出');
    assert.equal(ok(await endpoints(s, q3.id).核准(call), '正規化完成後核准').state, 'approved');
    console.log('✓ 識別碼正規化未完成：核准 503 IDENTITY_NOT_READY、什麼都沒寫；送出、撤回、拒絕照常');
  }

  // ---------- 4) 稽核表還沒建立：核准、拒絕 503 AUDIT_NOT_READY；送出、撤回照常 ----------
  {
    const s = await site('noaudit');
    const q = ok(await s.submit(), '送出');
    await s.db.run('DROP TABLE audit_log');
    const call = s.app(); // 新的一份程式：發現稽核表不存在
    const e = endpoints(s, q.id);
    const before = await s.snapshot();
    is(await e.核准(call), 503, 'AUDIT_NOT_READY', '稽核未就緒：核准');
    is(await e.拒絕(call), 503, 'AUDIT_NOT_READY', '稽核未就緒：拒絕');
    assert.equal(await s.snapshot(), before, '什麼都沒寫（沒有專案、申請維持待審核）');
    const q2 = ok(await s.submit(call), '稽核未就緒：送出照常（不寫稽核）');
    assert.equal(ok(await endpoints(s, q2.id).撤回(call), '撤回照常').state, 'withdrawn');
    console.log('✓ 稽核未就緒：核准、拒絕 503 AUDIT_NOT_READY、什麼都沒寫；送出、撤回照常');
  }
  console.log('project-creation-request-guards-test：全部通過');
} finally {
  for (const db of dbs) await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
