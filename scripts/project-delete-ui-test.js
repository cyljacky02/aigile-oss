// 網頁：管理員設定 › 專案，已封存的列有「刪除…」（只有工作區管理員）
// A. 確認框寫可復原期與預計永久清除的時間、數量、只屬於這個專案的 AI 會先暫停；要輸入專案名稱才能按
// B. 刪除是敏感操作：這台裝置沒再驗證過就跳出輸入密碼的對話框，輸對後自動重送
// C. 刪完表格沒有它，下面「已刪除的專案」列出它（刪除者、預計永久清除時間、復原按鈕）；按復原後回到表格、是封存狀態
// D. 手機 375 不橫向捲動；英文介面翻成英文
// 規則（權限、各處查不到、排程清除）在 project-delete-test.js 驗。本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。
// 用法：node scripts/project-delete-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('project-delete-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('projdel');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const wang = (await kit.call(null, '/api/join', 'POST', { name: '陳小美', role: 'UX' })).body;
  const PW = 'pass-word-1';
  assert.equal((await kit.call(liu.token, '/api/me/password', 'PUT', { username: 'liuadmin', newPassword: PW, newPasswordAgain: PW })).status, 200);
  const dev = (await kit.call(null, '/api/auth/password', 'POST', { username: 'liuadmin', password: PW })).body.token; // 這台裝置還沒再驗證
  const np = (await kit.call(liu.token, '/api/projects', 'POST', { name: '舊專案', code: 'OLD' })).body;
  const pid = np.items.find(p => p.name === '舊專案').id;
  await kit.call(liu.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['預設專案', pid] });
  await kit.call(liu.token, '/api/my-ais', 'POST', { projects: [pid], roleKey: 'PG', role: 'PG', name: '舊專案的AI', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  for (let i = 0; i < 3; i++) await kit.call(liu.token, '/api/messages', 'POST', { project: pid, text: '舊專案訊息 ' + i, requestId: 'm' + i });
  assert.equal((await kit.call(liu.token, `/api/projects/${encodeURIComponent(pid)}/archive`, 'POST')).status, 200, '封存');

  const { js, login, cdp } = await kit.browser(1280, 900);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const openProjects = async () => {
    await login(dev, '/admin/projects'); // 專案在管理員設定 › 專案
    await until(() => js("!!document.querySelector('.pm-ptable')"), 8000, '專案表格');
    await sleep(300);
  };
  const row = `.pm-prow[data-pj="${pid}"]`;
  await openProjects();
  assert.ok(await js(`!!document.querySelector('${row} [data-pp="pdelete"]')`), '已封存的列有「刪除…」');
  assert.equal(await js(`document.querySelector('${row} [data-pp="pdelete"]').textContent`), '刪除…');
  assert.ok(!(await js("[...document.querySelectorAll('.pm-prow:not(.archived) [data-pp=\"pdelete\"]')].length")), '沒封存的沒有');
  assert.ok(!(await hscroll()), '375 沒有橫向捲動');
  // A 確認框
  await js(`document.querySelector('${row} [data-pp="pdelete"]').click(); true`);
  await until(() => js("!!document.querySelector('.confirm-root [data-expect]')"), 8000, '確認框');
  const msg = await js("document.querySelector('.confirm-root').textContent");
  for (const k of ['刪除「舊專案」？', '可復原期（30 天）', '由系統永久清除', '「已刪除的專案」復原', '訊息 3 則', '卡片 0 張', '只屬於這個專案的 AI 會先暫停、永久清除時一起刪除：舊專案的AI', '帳號會留著', '跨專案頻道的訊息不動', '請輸入「舊專案」確認']) assert.ok(msg.includes(k), 'A 確認框寫：' + k + '｜' + msg);
  assert.ok(!/救不回來|永久刪除/.test(msg), 'A 不再說救不回來');
  assert.ok(await js("document.querySelector('.confirm-root [data-ok]').disabled"), 'A 還沒輸入名稱不能按');
  assert.ok(await js("document.querySelector('.confirm-root [data-ok]').classList.contains('danger')"), 'A 紅色按鈕');
  assert.ok(!(await hscroll()), '375 確認框沒有橫向捲動');
  await js("(() => { const i = document.querySelector('.confirm-root [data-expect]'); i.value = '舊專'; i.dispatchEvent(new Event('input')); return true; })()");
  assert.ok(await js("document.querySelector('.confirm-root [data-ok]').disabled"), 'A 名稱不對不能按');
  await js("(() => { const i = document.querySelector('.confirm-root [data-expect]'); i.value = '舊專案'; i.dispatchEvent(new Event('input')); return true; })()");
  assert.ok(!(await js("document.querySelector('.confirm-root [data-ok]').disabled")), 'A 名稱對了可以按');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  // B 再驗證身分
  await until(() => js("!!document.querySelector('.reauth-root #reauth-pw')"), 8000, 'B 再驗證對話框');
  assert.ok(await js(`!!document.querySelector('${row}')`), 'B 還沒輸入密碼：還沒刪');
  await js(`(() => { document.querySelector('.reauth-root #reauth-pw').value = ${JSON.stringify(PW)}; document.querySelector('.reauth-root [data-reauth-ok]').click(); return true; })()`);
  // C 刪完：表格沒有它；下面列出已刪除的專案
  await until(() => js(`!document.querySelector('${row}')`), 8000, 'C 表格拿掉');
  await until(() => js("!!document.querySelector('.pm-dels')"), 8000, 'C 已刪除的專案');
  const dels = await js("document.querySelector('.pm-dels').textContent");
  assert.match(dels, /已刪除的專案 · 1[\s\S]*舊專案[\s\S]*OLD[\s\S]*林志明[\s\S]*訊息 3 則[\s\S]*\d{4}-\d\d-\d\d \d\d:\d\d 永久清除/, 'C 已刪除的專案：' + dels);
  assert.ok(await js(`!!document.querySelector('.pm-dels [data-pj="${pid}"] [data-pp="restore"]')`), 'C 有復原按鈕');
  assert.ok(!(await hscroll()), 'D 375 已刪除的專案沒有橫向捲動');
  assert.equal((await kit.call(wang.token, '/api/me')).status, 200, '成員照常');
  // C 復原：回到表格、是封存狀態
  await js(`document.querySelector('.pm-dels [data-pj="${pid}"] [data-pp="restore"]').click(); true`);
  await until(() => js(`!!document.querySelector('${row}.archived')`), 8000, 'C 復原後回到表格（封存）');
  await until(() => js("!document.querySelector('.pm-dels')"), 8000, 'C 已刪除的專案清空');
  // D 英文介面
  assert.equal((await kit.call(dev, `/api/projects/${encodeURIComponent(pid)}/delete`, 'POST', { confirmName: '舊專案' })).status, 200, '再刪一次（10 分鐘內不用再驗證）');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await openProjects();
  await until(() => js("!!document.querySelector('.pm-dels')"), 8000, 'D 英文已刪除的專案');
  const enDels = await js("document.querySelector('.pm-dels').textContent");
  assert.match(enDels, /Deleted projects · 1[\s\S]*3 messages, 0 cards, 0 documents[\s\S]*purged on[\s\S]*Restore/, 'D 英文：' + enDels);
  console.log('project-delete-ui-test：全部通過');
} catch (e) {
  console.error('project-delete-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
