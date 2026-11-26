// 畫面測試（#42）：平台設定頁列出升級前就有的專案代號、網址英文名衝突（只給平台管理員）；沒有衝突就不顯示
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/project-identity-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-identity-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pidui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員兼工作區管理員
  const mate = (await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  // 升級前就有的衝突（直接改資料庫模擬）：第二專案的代號跟預設專案一樣
  kit.sql("UPDATE app_settings SET value = 'MAIN' WHERE key = ?", 'pcode:第二專案');
  const { js, login } = await kit.browser(1280, 860);
  await login(boss.token, '/admin/system');
  await until(() => js("!!document.querySelector('.ident-card')"), 10000, '專案代號與網址英文名的提示');
  const text = await js("document.querySelector('.ident-card').innerText");
  assert.match(text, /專案代號與網址英文名/);
  assert.match(text, /升級前就有 1 處重複/);
  assert.match(text, /代號重複\s*MAIN：「預設專案」、「第二專案」/, '明細：種類、值、哪些專案');
  assert.equal((await kit.call(mate.token, '/api/admin/project-identity')).status, 403, '其他人看不到');
  console.log('✓ 平台管理員在平台設定頁看得到衝突的提示與明細');

  // 改掉其中一個專案的代號：重新整理後不再顯示
  assert.equal((await kit.call(boss.token, `/api/projects/${encodeURIComponent('第二專案')}/code`, 'PUT', { code: 'SECO' })).status, 200);
  await login(boss.token, '/admin/system');
  await until(() => js("document.body.innerText.includes('下載備份')"), 10000, '平台設定頁');
  await until(async () => (await kit.call(boss.token, '/api/admin/project-identity')).body.conflicts.length === 0, 5000, '沒有衝突了');
  await new Promise(r => setTimeout(r, 800));
  assert.ok(!(await js("!!document.querySelector('.ident-card')")), '沒有衝突就不顯示');
  console.log('✓ 沒有衝突就不顯示');
  console.log('project-identity-ui-test：全部通過');
} catch (e) {
  console.error('project-identity-ui-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally { await kit.stop(); }
