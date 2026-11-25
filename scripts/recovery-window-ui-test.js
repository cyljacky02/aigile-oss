// 畫面測試：可復原期的設定介面
// A. 平台設定有「可復原期」（預設 30 天），平台管理員改成 7 天會存進平台設定
// B. 工作區設定有「可復原期」：可以「跟平台預設」或覆寫成自己的天數；0 天顯示「立即永久清除」
// 權限、允許值、再驗證、稽核紀錄由 recovery-window-test.js 驗（這裡用剛再驗證過的裝置登入）
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/recovery-window-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { adminSession } from './test-admin.js';

if (!findBrowser()) { console.log('recovery-window-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('recui');
try {
  const { call } = kit;
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'QA' })).body;
  boss.token = (await adminSession(call, boss.token)).token; // 改可復原期是敏感操作：用設了密碼、剛再驗證過的裝置登入
  const { js, login } = await kit.browser(1280, 860);
  const pick = (sel, v, btn) => js(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(v)}; document.querySelector('[data-pp="${btn}"]').click(); return true; })()`);
  const eff = async () => (await call(wang.token, '/api/recovery-window')).body;

  // ---- A 平台設定 ----
  await login(boss.token, '/admin/system');
  await until(() => js("!!document.querySelector('#adm-rec')"), 15000, '平台設定的可復原期');
  assert.equal(await js("document.querySelector('#adm-rec').value"), '30', '預設 30 天');
  assert.match(await js("document.querySelector('#adm-rec option[value=\"30\"]').textContent"), /30 天（預設）/);
  assert.match(await js("document.querySelector('#adm-rec option[value=\"0\"]').textContent"), /立即永久清除/, '0 天寫明立即永久清除');
  await pick('#adm-rec', '7', 'platrec');
  await until(async () => (await eff()).defaultDays === 7, 8000, '平台預設存成 7 天');
  assert.equal((await eff()).days, 7, '沒覆寫的工作區跟著平台預設');
  console.log('✓ 平台設定可以改可復原期預設值');

  // ---- B 工作區設定 ----
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('#ws-rec')"), 10000, '工作區設定的可復原期');
  assert.equal(await js("document.querySelector('#ws-rec').value"), '', '預設跟平台');
  assert.match(await js("document.querySelector('#ws-rec option[value=\"\"]').textContent"), /跟平台預設（7 天）/);
  await pick('#ws-rec', '0', 'wsrec');
  await until(async () => (await eff()).workspaceDays === 0, 8000, '工作區覆寫成 0 天');
  await until(() => js("document.querySelector('#ws-rec')?.value === '0'"), 8000, '重畫後停在 0 天');
  await pick('#ws-rec', '', 'wsrec');
  await until(async () => (await eff()).workspaceDays === null, 8000, '回到跟平台預設');
  assert.equal((await eff()).days, 7, '跟平台預設 7 天');
  console.log('recovery-window-ui-test：全部通過');
} catch (e) {
  console.error('recovery-window-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
