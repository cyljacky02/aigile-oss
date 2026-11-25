// 畫面測試：再驗證身分
// A. 敏感操作被擋（REAUTH_REQUIRED）時跳出輸入密碼的對話框；輸錯留在對話框顯示原因，輸對後自動重送原本的操作
// B. 取消：操作沒做成，對話框關掉
// C. 還沒設密碼（PASSWORD_REQUIRED）：說明要先設定密碼，按鈕打開「個人設定 › 帳號與登入」
// D. 手機 375 對話框不橫向捲動
// 規則（誰要再驗證、多久有效）在 reauth-test.js 驗。需要 Chrome 或 Edge；找不到就略過。用法：node scripts/reauth-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('reauth-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('reauthui');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const chen = await join('陳昭宇', 'PG'), wang = await join('王小美', 'QA');
  const Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  const PW = 'pass-word-1';
  assert.equal((await call(boss.token, '/api/me/password', 'PUT', { username: 'boss', newPassword: PW, newPasswordAgain: PW })).status, 200);
  const dev = (await call(null, '/api/auth/password', 'POST', { username: 'boss', password: PW })).body.token; // 這台裝置還沒再驗證

  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const confirmVia = async sel => {
    await until(async () => (await js("!!document.querySelector('.confirm-root [data-ok]')")) || (await click(sel), false), 8000, '確認框：' + sel);
    await click('.confirm-root [data-ok]');
  };
  const roleOf = async id => (await call(dev, '/api/roster')).body.members.find(p => p.participantId === id);
  const typePw = pw => js(`(() => { const i = document.querySelector('.reauth-root #reauth-pw'); i.value = ${JSON.stringify(pw)}; document.querySelector('.reauth-root [data-reauth-ok]').click(); return true; })()`);
  const pf = id => `.rs-table [data-pm-platrole="${id}"]`, ws = id => `.rs-table [data-pm-wsrole="${id}"]`;

  // ---- B 取消 ----
  await size(375, 812);
  await login(dev, '/roster');
  await until(() => js(`!!document.querySelector(${JSON.stringify(ws(Wg))})`), 10000, '成員名冊');
  await confirmVia(ws(Wg));
  await until(() => js("!!document.querySelector('.reauth-root #reauth-pw')"), 8000, '再驗證對話框');
  assert.match(await js("document.querySelector('.reauth-root').innerText"), /再輸入一次你的密碼[\s\S]*10 分鐘/, '對話框說明為什麼要輸入密碼、多久有效');
  assert.ok(await js("document.activeElement?.id === 'reauth-pw'"), '游標在密碼欄');
  // ---- D 375 ----
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), 'D 375 沒有橫向捲動');
  await click('.reauth-root [data-close]:not(.modal-x)');
  await until(() => js("!document.querySelector('.reauth-root')"), 5000, '取消後對話框關掉');
  assert.notEqual((await roleOf(Wg)).workspaceRole, 'admin', 'B 取消：沒有升為工作區管理員');
  console.log('✓ 取消再驗證：操作沒做');

  // ---- A 輸錯、輸對後自動重送 ----
  await size(1280, 860);
  await confirmVia(pf(Cn));
  await until(() => js("!!document.querySelector('.reauth-root #reauth-pw')"), 8000, '再驗證對話框');
  await typePw('wrong-pass');
  await until(() => js("/密碼不對/.test(document.querySelector('.reauth-root #reauth-err')?.textContent || '')"), 8000, '輸錯顯示原因');
  assert.ok(await js("!!document.querySelector('.reauth-root')"), 'A 輸錯留在對話框');
  assert.equal((await roleOf(Cn)).platformRole, 'none', 'A 輸錯：還沒做');
  await typePw(PW);
  await until(() => js("!document.querySelector('.reauth-root')"), 8000, '輸對後對話框關掉');
  await until(async () => (await roleOf(Cn))?.platformRole === 'admin', 8000, 'A 輸對後自動重送：陳昭宇升為平台管理員');
  // 10 分鐘內不再問
  await confirmVia(ws(Wg));
  await until(async () => (await roleOf(Wg))?.workspaceRole === 'admin', 8000, 'A 10 分鐘內：直接升王小美為工作區管理員');
  assert.ok(await js("!document.querySelector('.reauth-root')"), 'A 10 分鐘內不再跳對話框');
  console.log('✓ 再驗證：輸錯留在對話框、輸對自動重送、10 分鐘內不再問');

  // ---- C 還沒設密碼 ----
  await login(chen.token, '/roster'); // 剛升為平台管理員、還沒設密碼的人
  await until(() => js(`!!document.querySelector(${JSON.stringify(ws(Wg))})`), 10000, '陳昭宇的成員名冊');
  await confirmVia(ws(Wg));
  await until(() => js("!!document.querySelector('.pwdreq-root [data-ok]')"), 8000, '要先設密碼的說明');
  assert.match(await js("document.querySelector('.pwdreq-root').innerText"), /帳號與登入/, 'C 說明去哪裡設定密碼');
  assert.ok(await js("!document.querySelector('.reauth-root')"), 'C 沒有密碼：不跳輸入密碼的對話框');
  await click('.pwdreq-root [data-ok]');
  await until(() => js("document.querySelector('#st-acct')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#pwd-set')"), 8000, 'C 打開個人設定的帳號與登入');
  assert.equal((await roleOf(Wg)).workspaceRole, 'admin', 'C 沒做成');
  console.log('reauth-ui-test：全部通過');
} catch (e) {
  console.error('reauth-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
