// 畫面測試（真的瀏覽器）：專案看板照「這個專案自訂的狀態」畫欄
// 1. 桌面：欄＝專案的狀態（名稱、順序、顏色）；改過名的顯示新名稱；卡片在它的狀態那一欄
// 2. 拖到同類別的另一欄：卡片換欄（伺服器記成那個狀態）
// 3. 手機：預設顯示第一個「進行中」類別的欄
// 規則本身在 project-statuses-test.js 測；這裡只看畫面。需要 Chrome 或 Edge；找不到就略過。
// 用法：node scripts/project-statuses-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('project-statuses-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pstui', { env: { AIGILE_TEST_PROJECTS: '0', UPDATE_CHECK: '0' } });
try {
  await until(async () => (await kit.call(null, '/api/health')).status === 200, 10000, '伺服器');
  const tok = (await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  assert.equal((await kit.call(tok, '/api/me/password', 'PUT', { username: 'owner1', currentPassword: 'admin', newPassword: 'pass-word-9', newPasswordAgain: 'pass-word-9' })).status, 200, '改帳密');
  const pj = (await kit.call(tok, '/api/projects')).body.items[0].id;
  const base = `/api/projects/${encodeURIComponent(pj)}/statuses`;
  const items = async () => (await kit.call(tok, base)).body.items;
  const byName = async n => (await items()).find(s => s.name === n);
  // 專案自訂：進行中類別多一個「測試中」（紫色），待確認改名 Review
  assert.equal((await kit.call(tok, base, 'POST', { name: '測試中', category: '進行中', color: 'violet' })).status, 201, '新增狀態');
  assert.equal((await kit.call(tok, `${base}/${(await byName('待確認')).id}`, 'PATCH', { name: 'Review' })).status, 200, '改名');
  const testing = await byName('測試中'), doing = await byName('進行中');
  const card = (await kit.call(tok, '/api/cards', 'POST', { requestId: 'ui1', project: pj, title: '畫面測試卡', status: '測試中' })).body;
  assert.equal(card.status, '測試中', JSON.stringify(card).slice(0, 200));

  const { js, login, cdp } = await kit.browser(1400, 900);
  await login(tok, '/');
  await until(() => js("!!document.querySelector('[data-sw=\"skipall\"]')"), 15000, '第一次設定引導');
  await js("document.querySelector('[data-sw=\"skipall\"]').click(); true");
  await until(() => js("!document.querySelector('[data-sw=\"skipall\"]')"), 5000, '引導關掉');
  const openBoard = async () => {
    await js(`history.pushState(null, '', '/p/${encodeURIComponent(pj)}/work'); window.__r = 1; location.reload(); true`);
    await until(() => js('!window.__r'), 20000, '重新整理');
    await until(() => js("document.readyState === 'complete' && !!document.querySelector('[data-view=\"B\"]')"), 20000, '工作頁');
    await js("document.querySelector('[data-view=\"B\"]').click(); true");
    await until(() => js("!!document.querySelector('.board .bcol')"), 10000, '看板');
  };

  // 1. 桌面：欄名、順序、顏色、卡片位置
  await openBoard();
  const heads = await js("[...document.querySelectorAll('.board .bcol')].map(c => c.querySelector('.bcol-head b').textContent)");
  assert.deepEqual(heads, ['待處理', '進行中', '受阻', 'Review', '已完成', '測試中'], '欄＝專案的狀態（待整理沒卡不顯示）');
  assert.equal(await js(`document.querySelector('.bcol[data-sid="${testing.id}"] .wdot').dataset.color`), 'violet', '欄頭用狀態的顏色');
  assert.equal(await js(`document.querySelector('.bcol[data-sid="${testing.id}"]').dataset.col`), '進行中', 'data-col 是狀態類別');
  assert.ok(await js(`!!document.querySelector('.bcol[data-sid="${testing.id}"] [data-card="${card.cardId}"]')`), '卡片在測試中那一欄');

  // 2. 拖到同類別的「進行中」欄
  await js(`(() => {
    const tile = document.querySelector('[data-card="${card.cardId}"]'), col = document.querySelector('.bcol[data-sid="${doing.id}"]');
    const dt = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  await until(async () => (await kit.call(tok, `/api/cards/${card.cardId}`)).body.statusId === doing.id, 10000, '伺服器記成進行中');
  await until(() => js(`!!document.querySelector('.bcol[data-sid="${doing.id}"] [data-card="${card.cardId}"]')`), 10000, '畫面換欄');

  // 3. 手機：預設第一個「進行中」類別的欄（把測試中排到最前面）
  const order = (await items()).map(s => s.id);
  assert.equal((await kit.call(tok, `${base}/order`, 'PUT', { ids: [testing.id, ...order.filter(id => id !== testing.id)] })).status, 200, '排序');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await openBoard();
  await sleep(200);
  assert.equal(await js("document.querySelector('.board .bcol .bcol-head b').textContent"), '測試中', '手機預設第一個進行中類別的欄');
  console.log('project-statuses-ui-test：全部通過');
} catch (e) {
  console.error('project-statuses-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
