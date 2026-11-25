// 工作區政策「誰可以刪除自己的訊息」（GLOSSARY「成員與權限」：工作區政策；docs/adr/0003）
// A. 預設＝所有成員：一般成員刪得了自己的訊息；網頁旗標 canDeleteOwnMessages 為 true
// B. 只有工作區管理員（含平台管理員）能改；AI、一般成員 403；值只能是 members 或 admins（400 INVALID_REQUEST）
// C. 設為「只有管理員」：一般成員刪自己的被拒（403 NOT_ADMIN，訊息說明是工作區政策）；工作區管理員、平台管理員刪自己的、刪別人的都照常
//    作者自己刪掉的訊息照樣能自己復原（政策只管刪除）
// D. 每次修改寫一筆稽核紀錄 workspace_policy.update（detail { field: 'deleteOwnMessages', from, to }）；值沒變時不存、不記；工作區異動紀錄也有一行
// E. 別份程式剛改的政策，這份程式下一次刪除就照新的判斷（不吃 10 秒快取）
// F. 升級的站：預設所有成員
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/delete-policy-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { appCaller } from './test-call.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';
import { toPrePhase1 } from './legacy-db.js';

const PJ = '預設專案';
const SETTINGS = '/api/workspace/settings';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-delpol-'));
const mkCall = db => {
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  return appCaller(app);
};
const code = r => `${r.status} ${r.body?.error?.code || ''}`;

let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  const call = mkCall(db);
  let rq = 0;
  const post = async (token, text) => {
    const r = await call(token, '/api/messages', 'POST', { project: PJ, text, requestId: 'rq' + ++rq });
    assert.ok(r.status === 201 || r.status === 200, '發訊息：' + JSON.stringify(r.body));
    return r.body.messageId;
  };
  const del = (token, id) => call(token, `/api/messages/${id}`, 'DELETE');
  const policyLog = async token => (await call(token, '/api/audit-log?action=workspace_policy.update')).body.items.filter(e => e.detail?.field === 'deleteOwnMessages');
  const canDel = async token => (await call(token, '/api/projects')).body.canDeleteOwnMessages;

  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const boss = await adminSession(call, wang.token);
  const join = async (name, role) => {
    const b = (await call(null, '/api/join', 'POST', { name, role })).body;
    assert.equal((await call(boss.token, `/api/participants/${b.participant.participantId}/projects`, 'PUT', { projects: [PJ] })).status, 200, `${name} 加進預設專案`);
    return { token: b.token, id: b.participant.participantId, name };
  };
  const lin = await join('林工作', 'SM'); // 工作區管理員（不是平台管理員）
  assert.equal((await call(boss.token, `/api/participants/${lin.id}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '林工作升為工作區管理員');
  const chen = await join('陳大文', 'PG'); // 一般成員
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '陳的助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = await testToken(db, ai.participantId);

  // ---------- A 預設：所有成員 ----------
  const s0 = await call(boss.token, SETTINGS);
  assert.equal(s0.status, 200, JSON.stringify(s0.body));
  assert.equal(s0.body.deleteOwnMessages, 'members', 'A 新安裝預設所有成員都能刪自己的訊息');
  assert.equal(await canDel(chen.token), true, 'A 一般成員的旗標：可以刪自己的訊息');
  assert.equal(await canDel(aiToken), false, 'A AI 一律不能刪');
  assert.equal(code(await del(chen.token, await post(chen.token, '貼錯了'))), '200 ', 'A 所有成員：作者刪自己的訊息');
  console.log('✓ A 預設所有成員');

  // ---------- B 修改權限與允許值 ----------
  assert.equal(code(await call(chen.token, SETTINGS, 'PUT', { deleteOwnMessages: 'admins' })), '403 NOT_ADMIN', 'B 一般成員不能改');
  assert.equal(code(await call(aiToken, SETTINGS, 'PUT', { deleteOwnMessages: 'admins' })), '403 NOT_ADMIN', 'B AI 不能改');
  assert.equal(code(await call(boss.token, SETTINGS, 'PUT', { deleteOwnMessages: 'nobody' })), '400 INVALID_REQUEST', 'B 只能是 members 或 admins');
  assert.equal((await call(boss.token, SETTINGS)).body.deleteOwnMessages, 'members', 'B 被拒的修改沒有存');
  assert.equal((await policyLog(boss.token)).length, 0, 'B 被拒的修改不記稽核紀錄');
  console.log('✓ B 只有工作區管理員能改');

  // ---------- C 只有管理員 ----------
  const before = await post(chen.token, '政策改之前自己刪的'); // 作者先自己刪，政策改了之後還能自己復原
  assert.equal(code(await del(chen.token, before)), '200 ');
  const s1 = await call(lin.token, SETTINGS, 'PUT', { deleteOwnMessages: 'admins' }); // 工作區管理員（不是平台管理員）也能改；不是敏感操作
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal(s1.body.deleteOwnMessages, 'admins');
  assert.equal((await call(boss.token, SETTINGS)).body.deleteOwnMessages, 'admins', 'C 存起來了');
  const own = await post(chen.token, '想自己收回');
  const denied = await del(chen.token, own);
  assert.equal(code(denied), '403 NOT_ADMIN', 'C 只有管理員：一般成員刪自己的被拒');
  assert.match(denied.body.error.message, /工作區政策/, 'C 錯誤訊息說明是工作區政策：' + denied.body.error.message);
  assert.match(denied.body.error.message, /只有工作區管理員/, 'C 錯誤訊息說明誰能刪');
  assert.equal((await call(chen.token, `/api/messages/${own}`)).body.deleted, undefined, 'C 被拒的訊息沒有被刪');
  assert.equal(await canDel(chen.token), false, 'C 一般成員的旗標：不能刪');
  assert.equal(await canDel(lin.token), true, 'C 工作區管理員的旗標：可以刪');
  assert.equal(await canDel(boss.token), true, 'C 平台管理員的旗標：可以刪');
  assert.equal(code(await del(lin.token, await post(lin.token, '林刪自己的'))), '200 ', 'C 工作區管理員刪自己的不受影響');
  assert.equal(code(await del(boss.token, await post(boss.token, '王刪自己的'))), '200 ', 'C 平台管理員刪自己的不受影響');
  assert.equal(code(await del(lin.token, own)), '200 ', 'C 工作區管理員照樣能刪一般成員的訊息');
  assert.equal(code(await call(chen.token, `/api/messages/${before}/restore`, 'POST')), '200 ', 'C 政策只管刪除：作者照樣能復原自己刪的');
  console.log('✓ C 只有管理員：一般成員被拒、管理員不受影響');

  // ---------- D 稽核紀錄 ----------
  let log = await policyLog(boss.token);
  assert.equal(log.length, 1, 'D 修改寫一筆稽核紀錄：' + JSON.stringify(log));
  assert.deepEqual([log[0].scope.kind, log[0].actor.id, log[0].detail], ['workspace', lin.id, { field: 'deleteOwnMessages', from: 'members', to: 'admins' }], 'D 稽核紀錄內容：' + JSON.stringify(log[0]));
  assert.equal((await call(lin.token, SETTINGS, 'PUT', { deleteOwnMessages: 'admins' })).status, 200, 'D 存一樣的值');
  assert.equal((await policyLog(boss.token)).length, 1, 'D 值沒變時不記');
  assert.equal((await call(boss.token, SETTINGS, 'PUT', { name: '改名不動政策' })).status, 200);
  assert.equal((await policyLog(boss.token)).length, 1, 'D 沒帶這個欄位不記');
  const ev = (await call(boss.token, '/api/group/events')).body.items.map(e => e.text);
  assert.ok(ev.some(t => /林工作 .*刪除自己的訊息.*只有工作區管理員/.test(t)), 'D 工作區異動紀錄有一行：' + ev.join('｜'));

  // 改回所有成員：立刻生效
  assert.equal((await call(boss.token, SETTINGS, 'PUT', { deleteOwnMessages: 'members' })).body.deleteOwnMessages, 'members');
  assert.equal(code(await del(chen.token, await post(chen.token, '又可以自己刪了'))), '200 ', 'D 改回所有成員後作者又能刪');
  log = await policyLog(boss.token);
  assert.equal(log.length, 2, 'D 改回也記一筆');
  assert.deepEqual(log[0].detail, { field: 'deleteOwnMessages', from: 'admins', to: 'members' }, 'D 最新的在前');
  console.log('✓ D 稽核紀錄');

  // ---------- E 別份程式剛改的也立刻算數 ----------
  const other = mkCall(db); // 同一個資料庫的另一份程式（多台、Worker）
  const m = await post(chen.token, '另一份程式');
  assert.equal(await canDel(chen.token), true); // 這份程式先讀過（快取是所有成員）
  assert.equal((await other(boss.token, SETTINGS, 'PUT', { deleteOwnMessages: 'admins' })).status, 200);
  assert.equal(code(await del(chen.token, m)), '403 NOT_ADMIN', 'E 別份程式剛改成只有管理員：這份程式刪除時照新的判斷');
  assert.equal((await other(boss.token, SETTINGS, 'PUT', { deleteOwnMessages: 'members' })).status, 200);
  assert.equal(code(await del(chen.token, m)), '200 ', 'E 改回後也立刻算數');
  console.log('✓ E 多份程式立刻生效');
} finally {
  await db?.close();
}

// ---------- F 升級的站：預設所有成員 ----------
const oldFile = path.join(dataDir, 'old', 'switch.db');
fs.mkdirSync(path.dirname(oldFile));
{
  const old = await openTestDb(oldFile);
  await toPrePhase1(old);
  const at = '2026-01-02T00:00:00.000Z';
  await old.run("INSERT INTO participants (id, kind, name, role, code, token, created_at, updated_at, projects, is_admin) VALUES ('p_boss', 'human', '林老闆', '', 'BOSS', 'h:old_p_boss', ?, ?, '預設專案', 1)", at, at);
  await old.close();
}
db = await openTestDb(oldFile);
try {
  const call = mkCall(db);
  assert.equal((await call(await testToken(db, 'p_boss'), SETTINGS)).body.deleteOwnMessages, 'members', 'F 升級的站預設所有成員都能刪自己的訊息');
  console.log('✓ F 升級的站預設所有成員');
} finally {
  await db.close();
}
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('delete-policy-test：全部通過');
