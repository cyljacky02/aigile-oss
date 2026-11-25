// 畫面測試：沒有即時通道（Cloudflare Workers；本機用 LIVE=0 模擬）時，開著的頁面也會換掉被刪除、復原的訊息
// A. 管理員刪掉作者畫面上已載入的訊息：作者不重新整理，輪詢後換成佔位，原文不見
// B. 管理員復原：輪詢後回到原文
// 輪詢的版本號（changesVer）由 message-delete-test.js 驗
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
  console.log('message-poll-ui-test：全部通過');
} catch (e) {
  console.error('message-poll-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
