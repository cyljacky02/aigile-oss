// 再驗證身分：敏感的管理操作前，要在這台裝置上再輸入一次密碼；驗證後 10 分鐘內不必重複輸入
// A. 敏感操作（任免平台管理員、任免工作區管理員、停用帳號）：這台裝置沒再驗證過回 403 REAUTH_REQUIRED；
//    POST /api/auth/reauth { password } 通過後 10 分鐘內可以做；過了 10 分鐘再被擋
// B. 綁在這台裝置的登入：同一個人的另一台裝置照樣要再驗證
// C. 沒有密碼的帳號（只用配對碼、登入碼登入）回 403 PASSWORD_REQUIRED；有密碼但直接拿登入碼呼叫 API（沒有裝置）回 403 DEVICE_REQUIRED
// D. 權限先判斷：不是管理員的人照舊回權限錯誤，不會被要求再驗證
// E. 不敏感的操作（恢復帳號、看已停用清單）不用再驗證
// F. 再驗證輸錯密碼 400 WRONG_PASSWORD，計入既有的登入失敗次數：連錯 5 次鎖 15 分鐘，鎖住時密碼對也不行、帳號密碼登入也被擋
// G. AI 不能再驗證
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/reauth-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const PJ = '預設專案';
const MIN = 60_000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-reauth-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '1000' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const code = r => `${r.status} ${r.body?.error?.code || ''}`;
  const login = async (username, password) => {
    const r = await call(null, '/api/auth/password', 'POST', { username, password });
    assert.equal(r.status, 200, '帳號密碼登入：' + JSON.stringify(r.body));
    return r.body.token;
  };
  const deviceIdOf = async token => (await call(token, '/api/devices')).body.items.find(d => d.current).id;

  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位：平台管理員兼工作區管理員
  const lee = (await call(null, '/api/join', 'POST', { name: '李大華', role: 'PG' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳小明', role: 'PG' })).body;
  const platRole = (token, id, role) => call(token, `/api/participants/${id}/platform-role`, 'PUT', { role });
  const wsRole = (token, id, role) => call(token, `/api/participants/${id}/workspace-role`, 'PUT', { role });
  const disable = (token, id) => call(token, `/api/participants/${id}/disable`, 'POST');
  const enable = (token, id) => call(token, `/api/participants/${id}/enable`, 'POST');

  // C. 還沒設密碼：三種敏感操作都要先設定密碼
  let r = await platRole(wang.token, lee.participant.participantId, 'admin');
  assert.equal(code(r), '403 PASSWORD_REQUIRED', 'C 沒有密碼：任免平台管理員');
  assert.match(r.body.error.message, /密碼/, 'C 說明要先設定密碼');
  assert.equal(code(await wsRole(wang.token, lee.participant.participantId, 'admin')), '403 PASSWORD_REQUIRED', 'C 沒有密碼：任免工作區管理員');
  assert.equal(code(await disable(wang.token, lee.participant.participantId)), '403 PASSWORD_REQUIRED', 'C 沒有密碼：停用帳號');
  assert.equal(code(await call(wang.token, '/api/auth/reauth', 'POST', { password: 'x' })), '403 PASSWORD_REQUIRED', 'C 沒有密碼：再驗證也是先設定密碼');

  // D. 權限先判斷：一般成員不會被要求再驗證
  r = await platRole(lee.token, chen.participant.participantId, 'admin');
  assert.equal(r.status, 403, 'D 一般成員不能任免平台管理員');
  assert.ok(!['REAUTH_REQUIRED', 'PASSWORD_REQUIRED', 'DEVICE_REQUIRED'].includes(r.body.error.code), 'D 權限錯誤優先：' + r.body.error.code);
  r = await wsRole(lee.token, chen.participant.participantId, 'admin');
  assert.ok(r.status === 403 && !/REAUTH|PASSWORD|DEVICE/.test(r.body.error.code), 'D 一般成員不能任免工作區管理員：' + code(r));
  r = await disable(lee.token, chen.participant.participantId);
  assert.ok(r.status === 403 && !/REAUTH|PASSWORD|DEVICE/.test(r.body.error.code), 'D 一般成員不能停用帳號：' + code(r));

  // 設定密碼（用登入碼）
  const PW = 'pass-word-1';
  r = await call(wang.token, '/api/me/password', 'PUT', { username: 'wang', newPassword: PW, newPasswordAgain: PW });
  assert.equal(r.status, 200, '設定密碼');
  // C. 有密碼但沒有裝置（直接拿登入碼呼叫）：要在已登入的瀏覽器裡操作
  const wangCode = (await call(wang.token, '/api/me/login-code', 'POST')).body.code; // 設密碼時登入碼換新了
  assert.equal(code(await platRole(wangCode, lee.participant.participantId, 'admin')), '403 DEVICE_REQUIRED', 'C 登入碼沒有裝置：敏感操作');
  assert.equal(code(await call(wangCode, '/api/auth/reauth', 'POST', { password: PW })), '403 DEVICE_REQUIRED', 'C 登入碼沒有裝置：不能再驗證');

  // A. 裝置登入但還沒再驗證
  const dev1 = await login('wang', PW);
  for (const [what, res] of [['任免平台管理員', await platRole(dev1, lee.participant.participantId, 'admin')], ['任免工作區管理員', await wsRole(dev1, lee.participant.participantId, 'admin')], ['停用帳號', await disable(dev1, chen.participant.participantId)]]) {
    assert.equal(code(res), '403 REAUTH_REQUIRED', 'A 沒再驗證：' + what);
    assert.match(res.body.error.message, /密碼/, 'A 說明要再輸入密碼：' + what);
  }
  // 被擋下的操作沒有生效：對象沒升為管理員、沒被停用
  let roster = (await call(dev1, '/api/participants')).body;
  const person = id => roster.items.find(p => p.participantId === id);
  assert.notEqual(person(lee.participant.participantId)?.workspaceRole, 'admin', 'A 被擋下的操作沒有生效');

  // F. 輸錯密碼
  r = await call(dev1, '/api/auth/reauth', 'POST', { password: 'wrong-pass' });
  assert.equal(code(r), '400 WRONG_PASSWORD', 'F 輸錯密碼');
  assert.equal(code(await platRole(dev1, lee.participant.participantId, 'admin')), '403 REAUTH_REQUIRED', 'F 輸錯不算再驗證');

  // A. 再驗證通過：10 分鐘內三種敏感操作都可以做
  const before = Date.now();
  r = await call(dev1, '/api/auth/reauth', 'POST', { password: PW });
  assert.equal(r.status, 200, 'A 再驗證：' + JSON.stringify(r.body));
  const until = Date.parse(r.body.reauthUntil);
  assert.ok(until >= before + 10 * MIN - 1000 && until <= Date.now() + 10 * MIN + 1000, 'A 有效 10 分鐘：' + r.body.reauthUntil);
  r = await platRole(dev1, lee.participant.participantId, 'admin');
  assert.equal(r.status, 200, 'A 再驗證後：任免平台管理員 ' + JSON.stringify(r.body));
  assert.equal((await wsRole(dev1, chen.participant.participantId, 'admin')).status, 200, 'A 再驗證後：任免工作區管理員');
  assert.equal((await wsRole(dev1, chen.participant.participantId, 'member')).status, 200, 'A 再驗證後：降級工作區管理員');
  assert.equal((await disable(dev1, chen.participant.participantId)).status, 200, 'A 再驗證後：停用帳號');

  // E. 不敏感的操作：另一台沒再驗證的裝置也能做
  const dev2 = await login('wang', PW);
  assert.equal((await call(dev2, '/api/participants/disabled')).status, 200, 'E 看已停用清單不用再驗證');
  assert.equal((await enable(dev2, chen.participant.participantId)).status, 200, 'E 恢復帳號不用再驗證');

  // B. 綁在裝置上：dev1 驗過，dev2 照樣被擋
  assert.equal(code(await platRole(dev2, lee.participant.participantId, 'none')), '403 REAUTH_REQUIRED', 'B 另一台裝置要自己再驗證');
  assert.equal((await platRole(dev1, lee.participant.participantId, 'none')).status, 200, 'B 驗過的那台照樣可以');

  // A. 10 分鐘後再被擋（把這台的再驗證時間改到 10 分鐘前）
  await db.run('UPDATE devices SET reauth_at = ? WHERE id = ?', Date.now() - 10 * MIN - 1000, await deviceIdOf(dev1));
  assert.equal(code(await platRole(dev1, lee.participant.participantId, 'admin')), '403 REAUTH_REQUIRED', 'A 過了 10 分鐘再被擋');
  await db.run('UPDATE devices SET reauth_at = ? WHERE id = ?', Date.now() - 9 * MIN, await deviceIdOf(dev1));
  assert.equal((await platRole(dev1, lee.participant.participantId, 'admin')).status, 200, 'A 10 分鐘內照樣可以');

  // G. AI 不能再驗證
  const ai = (await call(dev1, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '王小美的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = await testToken(db, ai.participantId);
  r = await call(aiToken, '/api/auth/reauth', 'POST', { password: PW });
  assert.equal(r.status, 403, 'G AI 不能再驗證：' + code(r));

  // F. 連錯 5 次鎖住（前面錯過 1 次已被成功清掉）：第 5 次回 429，之後密碼對也不行、帳號密碼登入也被擋
  for (let i = 1; i <= 4; i++) assert.equal(code(await call(dev2, '/api/auth/reauth', 'POST', { password: 'wrong-' + i })), '400 WRONG_PASSWORD', `F 第 ${i} 次輸錯`);
  r = await call(dev2, '/api/auth/reauth', 'POST', { password: 'wrong-5' });
  assert.equal(code(r), '429 ACCOUNT_LOCKED', 'F 第 5 次輸錯就鎖住');
  assert.equal(code(await call(dev2, '/api/auth/reauth', 'POST', { password: PW })), '429 ACCOUNT_LOCKED', 'F 鎖住時密碼對也不行');
  assert.equal(code(await call(null, '/api/auth/password', 'POST', { username: 'wang', password: PW })), '429 ACCOUNT_LOCKED', 'F 帳號密碼登入也被鎖');
  assert.equal(code(await platRole(dev2, lee.participant.participantId, 'none')), '403 REAUTH_REQUIRED', 'F 鎖住期間還是沒再驗證');

  console.log('reauth-test：全部通過（敏感操作要再驗證、10 分鐘有效、綁裝置、沒密碼與沒裝置各自說明、權限先判斷、不敏感的不擋、輸錯計入鎖定、AI 不行）');
} catch (err) {
  console.error('reauth-test 失敗：', err.stack || err.message);
  process.exitCode = 1;
} finally {
  try { await db?.close?.(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
