// 畫面測試：工作區政策「誰可以刪除自己的訊息」
// A. 工作區設定頁有這一項（所有成員／只有工作區管理員），點了就存、異動紀錄多一行
// B. 設成只有管理員：一般成員自己的訊息上的「刪除」按了說明原因（工作區政策），訊息沒被刪；管理員照常能刪
// 權限、稽核紀錄由 delete-policy-test.js 驗
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/delete-policy-ui-test.js（找不到瀏覽器就略過）
import './test-home.mjs';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('delete-policy-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const PJ = '預設專案';
const kit = await startKit('delpol');
try {
  const { call } = kit;
  const lin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  assert.equal((await call(lin.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: [PJ] })).status, 200);
  const mine = (await call(chen.token, '/api/messages', 'POST', { project: PJ, requestId: 'dp_1', text: '想自己收回這則' })).body.messageId;
  assert.ok(mine, '發了訊息');

  const { js, login } = await kit.browser(1280, 900);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const checked = () => js("document.querySelector('[data-pp=\"deleteown\"]:checked')?.value || ''");

  // A 工作區設定頁
  await login(lin.token, '/admin/group');
  await until(() => js("!!document.querySelector('.pm-delete-own [data-pp=\"deleteown\"]')"), 10000, 'A 誰可以刪除自己的訊息');
  assert.match(await js("document.querySelector('.pm-delete-own').innerText"), /誰可以刪除自己的訊息[\s\S]*所有成員[\s\S]*只有工作區管理員/, 'A 兩個選項');
  assert.equal(await checked(), 'members', 'A 預設所有成員');
  await click('[data-pp="deleteown"][value="admins"]');
  await until(async () => (await call(lin.token, '/api/workspace/settings')).body.deleteOwnMessages === 'admins', 8000, 'A 存成只有管理員');
  await until(async () => (await checked()) === 'admins', 8000, 'A 畫面停在只有管理員');
  await until(() => js("/設定誰可以刪除自己的訊息：只有工作區管理員/.test(document.querySelector('.pm-gs-log').textContent)"), 8000, 'A 異動紀錄');

  // B 一般成員：按「刪除」說明原因，訊息不動
  const q = (sel = '') => `document.querySelector('#msg-${mine}${sel ? ' ' + sel : ''}')`;
  await login(chen.token, '/p/main/messages');
  await until(() => js(`!!${q('[data-msg-del]')}`), 20000, 'B 自己的訊息有「刪除」（按了說明原因）');
  await js(`${q('[data-msg-del]')}.click(); true`);
  await until(() => js("!document.querySelector('#toast').hidden && /工作區政策/.test(document.querySelector('#toast').textContent)"), 5000, 'B 說明是工作區政策');
  assert.equal(await js("!!document.querySelector('.confirm-root [data-ok]')"), false, 'B 不跳確認框');
  assert.equal((await call(lin.token, `/api/messages/${mine}`)).body.deleted, undefined, 'B 訊息沒被刪');

  // 管理員照常能刪
  await login(lin.token, '/p/main/messages');
  await until(() => js(`!!${q('[data-msg-del]')}`), 20000, 'B 管理員看得到刪除');
  await js(`${q('[data-msg-del]')}.click(); true`);
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認框');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(() => js(`!!${q()}?.classList.contains('msg-deleted')`), 8000, 'B 管理員刪掉了');
  console.log('delete-policy-ui-test：全部通過');
} catch (e) {
  console.error('delete-policy-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
