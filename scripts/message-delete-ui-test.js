// 畫面測試：刪除與復原訊息
// A. 作者在自己的訊息按「刪除」→ 確認後變成一行佔位「此訊息已被 X 於 T 刪除」，有「復原」；按「復原」回到原文
// B. 管理員刪的佔位，作者看不到「復原」；別人的訊息沒有「刪除」
// C. 開著的頁面即時更新：管理員刪除時，作者的畫面不重新整理就換成佔位
// D. 開著的卡片詳情：關聯訊息被刪時即時換成佔位（刪除者、時間，不是原作者與發送時間）；復原後回到原文
// 權限、佔位形狀、稽核紀錄由 message-delete-test.js 驗
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/message-delete-ui-test.js（找不到瀏覽器就略過）
import './test-home.mjs';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('message-delete-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const PJ = '預設專案';
const kit = await startKit('msgdel');
try {
  const { call } = kit;
  const lin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  assert.equal((await call(lin.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: [PJ] })).status, 200);
  let n = 0;
  const post = async (token, text) => { const r = await call(token, '/api/messages', 'POST', { project: PJ, requestId: 'md_' + n++, text }); assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body.messageId; };
  const other = await post(lin.token, '林志明的訊息');
  const byAdmin = await post(chen.token, '會被管理員刪掉的');
  const mine = await post(chen.token, '貼錯了，要刪掉');
  const later = await post(chen.token, '等一下管理員會刪這則');
  assert.equal((await call(lin.token, `/api/messages/${byAdmin}`, 'DELETE')).status, 200, '管理員先刪一則');

  const { js, login } = await kit.browser(1280, 900);
  const q = (id, sel = '') => `document.querySelector('#msg-${id}${sel ? ' ' + sel : ''}')`;
  await login(chen.token, '/p/main/messages');
  await until(() => js(`!!${q(mine)}`), 20000, '訊息載入');

  // B 別人的訊息沒有「刪除」；管理員刪的佔位沒有「復原」
  assert.equal(await js(`!!${q(other, '[data-msg-del]')}`), false, 'B 別人的訊息沒有刪除');
  assert.match(await js(`${q(byAdmin)}.textContent`), /此訊息已被 林志明 於 .+ 刪除/, 'B 管理員刪的是佔位');
  assert.equal(await js(`!!${q(byAdmin, '[data-msg-restore]')}`), false, 'B 作者不能復原管理員刪的');

  // A 刪除自己的 → 佔位 → 復原
  await js(`${q(mine, '[data-msg-del]')}.click(); true`);
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認框');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(() => js(`!!${q(mine)}?.classList.contains('msg-deleted')`), 8000, 'A 變成佔位');
  assert.match(await js(`${q(mine)}.textContent`), /此訊息已被 陳大文 於 .+ 刪除/, 'A 佔位寫刪除者與時間');
  assert.equal(await js(`${q(mine)}.textContent.includes('貼錯了')`), false, 'A 原文不見了');
  assert.equal((await call(lin.token, `/api/messages/${mine}`)).body.deleted, true, 'A 伺服器上也刪了');
  await js(`${q(mine, '[data-msg-restore]')}.click(); true`);
  await until(() => js(`!!${q(mine)} && !${q(mine)}.classList.contains('msg-deleted') && ${q(mine)}.textContent.includes('貼錯了')`), 8000, 'A 復原回到原文');

  // C 即時更新
  assert.equal((await call(lin.token, `/api/messages/${later}`, 'DELETE')).status, 200);
  await until(() => js(`!!${q(later)}?.classList.contains('msg-deleted')`), 15000, 'C 管理員刪除，畫面即時換成佔位');

  // D 卡片詳情裡的相關訊息
  const linked = await post(chen.token, '卡片關聯的訊息 DRW');
  const card = (await call(chen.token, '/api/cards', 'POST', { title: '關聯訊息會被刪', type: '工作', project: PJ, requestId: 'md_card', messageIds: [linked] })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  await login(chen.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${card.cardId}"]')`), 20000, 'D 看板上的卡');
  await js(`document.querySelector('[data-card="${card.cardId}"]').click(); true`);
  const dq = `document.querySelector('#card-drawer [data-dmsg="${linked}"]')`;
  await until(() => js(`${dq}?.textContent.includes('DRW')`), 15000, 'D 詳情裡的相關訊息');
  assert.equal((await call(lin.token, `/api/messages/${linked}`, 'DELETE')).status, 200, 'D 管理員刪關聯訊息');
  await until(() => js(`/此訊息已被 林志明 於 .+ 刪除/.test(${dq}?.textContent || '')`), 15000, 'D 詳情裡即時換成佔位（刪除者、時間）');
  assert.equal(await js(`/DRW|陳大文/.test(${dq}.textContent)`), false, 'D 佔位不顯示原文與原作者');
  // 重新打開詳情（重畫）也一樣是佔位
  await js("document.querySelector('#card-drawer [data-close-drawer]').click(); true");
  await js(`document.querySelector('[data-card="${card.cardId}"]').click(); true`);
  await until(() => js(`/此訊息已被 林志明 於 .+ 刪除/.test(${dq}?.textContent || '')`), 15000, 'D 重新打開也是佔位');
  assert.equal((await call(lin.token, `/api/messages/${linked}/restore`, 'POST')).status, 200, 'D 管理員復原');
  await until(() => js(`${dq}?.textContent.includes('DRW')`), 15000, 'D 復原後詳情裡回到原文');
  console.log('message-delete-ui-test：全部通過');
} catch (e) {
  console.error('message-delete-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
