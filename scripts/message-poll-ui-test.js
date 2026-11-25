// 畫面測試：沒有即時通道（Cloudflare Workers；本機用 LIVE=0 模擬）時，開著的頁面也會換掉被刪除、復原的訊息
// A. 管理員刪掉作者畫面上已載入的訊息：作者不重新整理，輪詢後換成佔位，原文不見
// B. 管理員復原：輪詢後回到原文
// C. 很長的對話（往上載入到 600 則以上）：最新一則被刪，輪詢後也換成佔位
// D. 開著的卡片詳情：關聯訊息被刪，輪詢後換成佔位（刪除者、時間）
// 輪詢的版本號（changesVer）與問哪些變了的 API 由 message-delete-test.js 驗
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/message-poll-ui-test.js（找不到瀏覽器就略過）
import './test-home.mjs';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('message-poll-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const PJ = '預設專案';
const kit = await startKit('msgpoll', { env: { LIVE: '0' } });
try {
  const { call } = kit;
  const lin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  assert.equal((await call(lin.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: [PJ] })).status, 200);
  const r = await call(chen.token, '/api/messages', 'POST', { project: PJ, requestId: 'poll_1', text: '輪詢會換掉的訊息 QPX' });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  const id = r.body.messageId;

  const { js, login } = await kit.browser(1280, 900);
  const q = `document.querySelector('#msg-${id}')`;
  await login(chen.token, '/p/main/messages');
  await until(() => js(`!!${q}`), 20000, '訊息載入');

  // A 刪除：不重新整理，輪詢後換成佔位
  assert.equal((await call(lin.token, `/api/messages/${id}`, 'DELETE')).status, 200, '管理員刪除');
  await until(() => js(`!!${q}?.classList.contains('msg-deleted')`), 20000, 'A 沒有即時通道，輪詢後換成佔位');
  assert.equal(await js(`${q}.textContent.includes('QPX')`), false, 'A 原文不見了');
  // B 復原：輪詢後回到原文
  assert.equal((await call(lin.token, `/api/messages/${id}/restore`, 'POST')).status, 200, '管理員復原');
  await until(() => js(`!!${q} && !${q}.classList.contains('msg-deleted') && ${q}.textContent.includes('QPX')`), 20000, 'B 輪詢後回到原文');

  // C 很長的對話：兩個人輪流發 650 則，重新打開後往上載入到 600 則以上，再刪最新的一則
  let last = null;
  for (let i = 0; i < 650; i++) {
    const w = await call(i % 2 ? lin.token : chen.token, '/api/messages', 'POST', { project: PJ, requestId: 'long_' + i, text: `長對話第 ${i} 則` + (i === 649 ? ' LZQ' : '') });
    assert.ok(w.status < 300, JSON.stringify(w.body));
    last = w.body.messageId;
  }
  await login(chen.token, '/p/main/messages');
  const lq = `document.querySelector('#msg-${last}')`;
  await until(() => js(`!!${lq}`), 20000, 'C 最新一則載入');
  const loaded = () => js("Number((document.querySelector('#messages .win-divider')?.textContent.match(/(\\d+) 則/) || [])[1] || 0)");
  for (let i = 0; i < 6 && await loaded() < 600; i++) {
    const before = await loaded();
    await js("document.querySelector('#load-older').click(); true");
    await until(async () => await loaded() > before, 15000, 'C 載入更早');
  }
  assert.ok(await loaded() >= 600, 'C 已載入 600 則以上：' + await loaded());
  assert.equal((await call(lin.token, `/api/messages/${last}`, 'DELETE')).status, 200, 'C 管理員刪最新一則');
  await until(() => js(`!!${lq}?.classList.contains('msg-deleted')`), 20000, 'C 很長的對話，最新一則輪詢後也換成佔位');
  assert.equal(await js(`${lq}.textContent.includes('LZQ')`), false, 'C 原文不見了');

  // D 卡片詳情開著，關聯訊息被刪：輪詢後換成佔位，寫刪除者，不再是原作者與原文
  const linked = (await call(chen.token, '/api/messages', 'POST', { project: PJ, requestId: 'poll_card', text: '卡片關聯的訊息 DRW' })).body.messageId;
  const card = (await call(chen.token, '/api/cards', 'POST', { title: '關聯訊息會被刪', type: '工作', project: PJ, requestId: 'poll_card', messageIds: [linked] })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  await login(chen.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${card.cardId}"]')`), 20000, 'D 看板上的卡');
  await js(`document.querySelector('[data-card="${card.cardId}"]').click(); true`);
  const dq = `document.querySelector('#card-drawer [data-dmsg="${linked}"]')`;
  await until(() => js(`${dq}?.textContent.includes('DRW')`), 15000, 'D 詳情裡的相關訊息');
  assert.equal((await call(lin.token, `/api/messages/${linked}`, 'DELETE')).status, 200, 'D 管理員刪關聯訊息');
  await until(() => js(`/此訊息已被 林志明 於 .+ 刪除/.test(${dq}?.textContent || '')`), 20000, 'D 輪詢後詳情裡換成佔位（刪除者、時間）');
  assert.equal(await js(`/DRW|陳大文/.test(${dq}.textContent)`), false, 'D 佔位不顯示原文與原作者');
  console.log('message-poll-ui-test：全部通過');
} catch (e) {
  console.error('message-poll-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
