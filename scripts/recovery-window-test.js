// 可復原期設定：東西被刪除後多久才永久清除。平台預設（平台設定）＋工作區覆寫（工作區設定），用法比照附件保存期限
// A. GET /api/recovery-window 誰都能讀實際生效的值（人類、AI）；沒登入 401。預設 30 天
// B. 平台預設（PUT /api/platform/settings { recoveryDays }）只有平台管理員能改；工作區管理員、一般成員、AI 一律 403
//    工作區覆寫（PUT /api/recovery-window { days | null }）只有工作區管理員（含平台管理員）；null＝改回跟隨平台預設
// C. 只收 0、7、14、30、60、90（天），其他值 400；0＝刪除當下就永久清除
// D. 兩種修改都是敏感動作：這台裝置沒再驗證過回 403 REAUTH_REQUIRED；權限不夠的人照舊回權限錯誤
// E. 每次修改寫一筆稽核紀錄（recovery_window.update，detail { from, to }；平台層／工作區層）；值沒變不存、不記
// F. 覆寫時平台預設改了不影響實際生效的值；改回跟隨平台預設後照平台預設
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/recovery-window-test.js
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

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-recovery-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = appCaller(app);
  const code = r => `${r.status} ${r.body?.error?.code || ''}`;
  const eff = async token => (await call(token, '/api/recovery-window')).body;

  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const lin = (await call(null, '/api/join', 'POST', { name: '林工作', role: 'SM' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;
  const boss = await adminSession(call, wang.token); // 設了密碼、剛再驗證過的裝置
  assert.equal((await call(boss.token, `/api/participants/${lin.participant.participantId}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '林工作是工作區管理員（不是平台管理員）');
  const linS = await adminSession(call, lin.token);
  assert.equal((await call(boss.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] })).status, 200, '陳大文加進預設專案');
  const ai = (await call(wang.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '王小美的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = await testToken(db, ai.participantId);

  // ---------- A 預設 30 天，誰都能讀 ----------
  let r = await call(chen.token, '/api/recovery-window');
  assert.equal(r.status, 200, 'A 一般成員能讀：' + JSON.stringify(r.body));
  assert.deepEqual([r.body.days, r.body.defaultDays, r.body.workspaceDays, r.body.choices], [30, 30, null, [0, 7, 14, 30, 60, 90]], 'A 預設 30 天、沒有工作區覆寫、六個選項：' + JSON.stringify(r.body));
  assert.equal((await eff(aiToken)).days, 30, 'A AI 也能讀');
  assert.equal((await call(null, '/api/recovery-window')).status, 401, 'A 沒登入不能讀');
  const logs = async (scope = 'all') => (await call(boss.token, `/api/audit-log?action=recovery_window.update&scope=${scope}`)).body.items;
  const plat = (token, days) => call(token, '/api/platform/settings', 'PUT', { recoveryDays: days });

  // ---------- 平台預設：平台設定看得到、只有平台管理員能改 ----------
  r = await call(boss.token, '/api/platform/settings');
  assert.deepEqual([r.body.recoveryWindow?.days, r.body.recoveryWindow?.custom, r.body.recoveryWindow?.choices], [30, false, [0, 7, 14, 30, 60, 90]], 'A 平台設定帶可復原期預設：' + JSON.stringify(r.body));
  assert.ok(r.body.fileTtl, 'A 平台設定照舊帶附件保存期限');
  assert.equal(code(await plat(linS.token, 7)), '403 NOT_ADMIN', 'B 工作區管理員不能改平台預設');
  assert.equal(code(await plat(chen.token, 7)), '403 NOT_ADMIN', 'B 一般成員不能改平台預設');
  assert.equal((await plat(aiToken, 7)).status, 403, 'B AI 不能改平台預設');
  for (const bad of [1, 5, 31, -7, '7', null, 7.5]) assert.equal(code(await plat(boss.token, bad)), '400 INVALID_REQUEST', `C 平台預設不收 ${JSON.stringify(bad)}`);
  assert.equal(code(await call(boss.token, '/api/platform/settings', 'PUT', {})), '400 INVALID_REQUEST', 'C 什麼都沒帶 400');
  // D 沒再驗證的裝置：同一人用帳號密碼另外登入一台
  const fresh = (await call(null, '/api/auth/password', 'POST', { username: boss.username, password: boss.password })).body.token;
  assert.equal(code(await plat(fresh, 7)), '403 REAUTH_REQUIRED', 'D 改平台預設要先再驗證身分');
  assert.equal((await eff(chen.token)).days, 30, 'D 被擋下來就沒改');
  assert.equal(code(await call(fresh, '/api/platform/settings', 'PUT', { fileTtlHours: 6 })), '200 ', 'D 只改附件保存期限不用再驗證');
  assert.deepEqual(await logs(), [], 'E 還沒有任何可復原期紀錄');

  r = await plat(boss.token, 7);
  assert.deepEqual([r.status, r.body.recoveryWindow?.days, r.body.recoveryWindow?.custom], [200, 7, true], 'B 平台管理員改成 7 天：' + JSON.stringify(r.body));
  assert.deepEqual([(await eff(chen.token)).days, (await eff(chen.token)).defaultDays], [7, 7], 'B 實際生效的值跟著平台預設');
  let L = await logs('platform');
  assert.equal(L.length, 1, 'E 一筆平台層紀錄');
  assert.deepEqual([L[0].actor.id, L[0].scope.kind, L[0].detail], [wang.participant.participantId, 'platform', { from: 30, to: 7 }], 'E 紀錄操作者、範圍、from/to：' + JSON.stringify(L[0]));
  assert.equal((await plat(boss.token, 7)).status, 200, 'E 沒變也回 200');
  assert.equal((await logs()).length, 1, 'E 沒變不記');
  assert.equal((await plat(boss.token, 0)).body.recoveryWindow.days, 0, 'C 0 天可以（刪除當下就永久清除）');
  assert.equal((await eff(chen.token)).days, 0, 'C 實際生效 0 天（不會被當成沒設）');
  assert.deepEqual((await logs())[0].detail, { from: 7, to: 0 }, 'E 0 也記');
  assert.equal((await call(linS.token, '/api/audit-log?action=recovery_window.update')).body.items.length, 0, 'E 工作區管理員看不到平台層的紀錄');
  assert.equal((await plat(boss.token, 30)).status, 200, '平台預設改回 30 天');

  // ---------- 工作區覆寫：工作區管理員（含平台管理員） ----------
  const ws = (token, days) => call(token, '/api/recovery-window', 'PUT', { days });
  assert.equal(code(await ws(chen.token, 14)), '403 NOT_ADMIN', 'B 一般成員不能覆寫');
  assert.equal((await ws(aiToken, 14)).status, 403, 'B AI 不能覆寫');
  assert.equal(code(await ws(lin.token, 14)), '403 DEVICE_REQUIRED', 'D 工作區管理員直接用登入碼（沒有裝置）：過不了再驗證');
  assert.equal(code(await ws(fresh, 14)), '403 REAUTH_REQUIRED', 'D 覆寫要先再驗證身分');
  for (const bad of [3, 100, '14', 1.5, undefined]) assert.equal(code(await call(linS.token, '/api/recovery-window', 'PUT', bad === undefined ? {} : { days: bad })), '400 INVALID_REQUEST', `C 工作區覆寫不收 ${JSON.stringify(bad)}`);
  assert.equal((await eff(chen.token)).days, 30, 'B 被擋下來就沒改');
  r = await ws(linS.token, 14);
  assert.deepEqual([r.status, r.body.days, r.body.defaultDays, r.body.workspaceDays], [200, 14, 30, 14], 'B 工作區管理員覆寫成 14 天：' + JSON.stringify(r.body));
  assert.equal((await eff(aiToken)).days, 14, 'B 覆寫後實際生效 14 天');
  L = await logs('workspace');
  assert.equal(L.length, 1, 'E 一筆工作區層紀錄');
  assert.deepEqual([L[0].actor.id, L[0].scope.kind, L[0].scope.workspaceId, L[0].detail], [lin.participant.participantId, 'workspace', 'default', { from: null, to: 14 }], 'E 工作區紀錄：null＝原本跟平台預設：' + JSON.stringify(L[0]));
  assert.equal((await call(linS.token, '/api/audit-log?action=recovery_window.update')).body.items.length, 1, 'E 工作區管理員看得到工作區層的紀錄');
  assert.equal((await ws(linS.token, 14)).status, 200, 'E 沒變也回 200');
  assert.equal((await logs('workspace')).length, 1, 'E 沒變不記');
  // F 覆寫時平台預設改了不影響實際生效的值
  assert.equal((await plat(boss.token, 90)).status, 200, 'F 平台預設改成 90 天');
  assert.deepEqual([(await eff(chen.token)).days, (await eff(chen.token)).defaultDays], [14, 90], 'F 工作區覆寫優先');
  // 平台管理員的隱含權限也能覆寫；0 天也可以
  assert.equal((await ws(boss.token, 0)).body.days, 0, 'B 平台管理員也能覆寫；0 天');
  // 改回跟隨平台預設
  r = await ws(linS.token, null);
  assert.deepEqual([r.status, r.body.days, r.body.workspaceDays], [200, 90, null], 'B 改回跟隨平台預設：' + JSON.stringify(r.body));
  assert.deepEqual((await logs('workspace')).map(x => x.detail), [{ from: 0, to: null }, { from: 14, to: 0 }, { from: null, to: 14 }], 'E 工作區的每次修改都記');
  assert.equal((await ws(linS.token, null)).status, 200, 'E 已經跟平台預設，再送 null 沒變');
  assert.equal((await logs('workspace')).length, 3, 'E 沒變不記');

  console.log('recovery-window-test 通過');
} finally {
  await db?.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
