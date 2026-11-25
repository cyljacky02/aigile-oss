// 畫面測試：清空專案訊息與整批復原
// A. 專案 ⚙ 選單有「清空專案訊息…」→ 對話框先顯示會刪掉幾則訊息、幾個附件
// B. 按「清空訊息…」→ 輸入專案名稱確認 → 訊息畫面換成佔位；對話框列出這次清空
// C. 在對話框按「復原」→ 訊息回到原文、清單清空
// 權限、範圍、通知、稽核紀錄由 message-clear-test.js 驗
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/message-clear-ui-test.js（找不到瀏覽器就略過）
import './test-home.mjs';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { adminSession } from './test-admin.js';

if (!findBrowser()) { console.log('message-clear-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const PJ = '預設專案';
const kit = await startKit('msgclear');
try {
  const { call } = kit;
  const lin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const boss = await adminSession(call, lin.token); // 裝置登入、已再驗證（清空是敏感動作）
  let n = 0;
  const post = async text => { const r = await call(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'mc_' + n++, text }); assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body.messageId; };
  const ids = [await post('第一則要清空的'), await post('第二則要清空的'), await post('第三則要清空的')];

  const { js, login } = await kit.browser(1280, 900);
  const q = id => `document.querySelector('#msg-${id}')`;
  await login(boss.token, '/p/main/messages');
  await until(() => js(`!!${q(ids[2])}`), 20000, '訊息載入');

  // A ⚙ → 清空專案訊息… → 預覽
  await until(() => js(`(() => { const b = [...document.querySelectorAll('.ph-gear[data-pset="${PJ}"]')].find(b => b.offsetParent); if (!b) return false; b.click(); return true; })()`), 8000, '專案 ⚙');
  await until(() => js(`!!document.querySelector('#pset-menu [data-pset-act="clearmsgs"]')`), 5000, 'A 選單有清空專案訊息');
  await js(`document.querySelector('#pset-menu [data-pset-act="clearmsgs"]').click(); true`);
  await until(() => js(`!!document.querySelector('.mc-box [data-mc-clear]')`), 8000, 'A 清空對話框');
  assert.match(await js(`document.querySelector('.mc-box').textContent`), /訊息 3 則、附件 0 個/, 'A 預覽數量');
  assert.match(await js(`document.querySelector('.mc-box').textContent`), /沒有可以復原的清空/, 'A 還沒有清空');

  // B 清空：輸入專案名稱確認
  await js(`document.querySelector('.mc-box [data-mc-clear]').click(); true`);
  await until(() => js("!!document.querySelector('.confirm-root [data-expect]')"), 5000, 'B 確認框要輸入名稱');
  assert.equal(await js("document.querySelector('.confirm-root [data-ok]').disabled"), true, 'B 沒輸入名稱不能按');
  await js(`(() => { const i = document.querySelector('.confirm-root [data-expect]'); i.value = '${PJ}'; i.dispatchEvent(new Event('input')); document.querySelector('.confirm-root [data-ok]').click(); return true; })()`);
  await until(() => js(`!!document.querySelector('.mc-box [data-mc-restore]')`), 10000, 'B 對話框列出這次清空');
  assert.match(await js(`document.querySelector('.mc-box li').textContent`), /林志明 清空 3 則/, 'B 清單寫誰清空幾則');
  for (const id of ids) assert.equal((await call(lin.token, `/api/messages/${id}`)).body.deleted, true, 'B 伺服器上清空了');
  await until(() => js(`${JSON.stringify(ids)}.every(id => document.querySelector('#msg-' + id)?.classList.contains('msg-deleted'))`), 10000, 'B 訊息畫面換成佔位');

  // C 整批復原
  await js(`document.querySelector('.mc-box [data-mc-restore]').click(); true`);
  await until(() => js(`!!document.querySelector('.mc-box') && !document.querySelector('.mc-box [data-mc-restore]')`), 10000, 'C 復原後清單空了');
  for (const id of ids) assert.equal((await call(lin.token, `/api/messages/${id}`)).body.deleted, undefined, 'C 伺服器上復原了');
  await until(() => js(`${JSON.stringify(ids)}.every(id => { const el = document.querySelector('#msg-' + id); return el && !el.classList.contains('msg-deleted') && el.textContent.includes('要清空的'); })`), 10000, 'C 訊息回到原文');
  console.log('message-clear-ui-test：全部通過');
} catch (e) {
  console.error('message-clear-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
