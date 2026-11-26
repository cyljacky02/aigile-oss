// 畫面測試：平台設定頁列出升級前就有的專案代號、網址英文名衝突（只給平台管理員）；沒有衝突就不顯示
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
  const { js, login, goto, cdp } = await kit.browser(1280, 860);
  await login(boss.token, '/admin/system');
  await until(() => js("!!document.querySelector('.ident-card')"), 10000, '專案代號與網址英文名的提示');
  const text = await js("document.querySelector('.ident-card').innerText");
  assert.match(text, /專案代號與網址英文名/);
  assert.match(text, /升級前就有 1 處重複/);
  assert.match(text, /代號重複\s*MAIN：「預設專案」、「第二專案」/, '明細：種類、值、哪些專案');
  assert.equal((await kit.call(mate.token, '/api/admin/project-identity')).status, 403, '其他人看不到');
  console.log('✓ 平台管理員在平台設定頁看得到衝突的提示與明細');

  assert.ok(await js("!!document.querySelector('.ident-card [data-ident-preview]')"), '診斷明細有修復預覽');
  await js("document.querySelector('.ident-card [data-ident-preview]').click()");
  const submit = value => js(`(() => { const f = document.querySelector('#ident-preview-form'); f.elements.replacement.value = ${JSON.stringify(value)}; f.requestSubmit(); })()`);
  await submit('MAIN');
  await until(() => js("!!document.querySelector('#ident-preview-error')?.textContent.trim()"), 10000, '代號被占用');
  await submit('NEWM');
  const previewText = await until(() => js("document.querySelector('#ident-preview-result')?.textContent.includes('NEWM-N') && document.querySelector('#ident-preview-result').innerText"), 10000, '修復預覽');
  assert.match(previewText, /MAIN-N/);
  assert.match(previewText, /同一個參照無法同時指向兩個專案/);
  assert.ok(await js("!!document.querySelector('#ident-preview-form [name=reference]')"), '可預覽指定卡號');
  await js("document.querySelector('#ident-preview-form [name=reference]').value = 'MAIN-99'");
  await submit('NEWM');
  await until(() => js("document.querySelector('#ident-preview-result')?.textContent.includes('MAIN-99')"), 10000, '指定卡號預覽');
  assert.equal((await kit.call(boss.token, '/api/admin/project-identity')).body.conflicts.length, 1, '預覽後衝突還在');
  const confirmButton = '#ident-preview-form [data-ident-confirm]';
  await until(() => js(`document.querySelector('${confirmButton}')?.disabled`), 10000, '沒有勾選不能確認');
  await js("(() => { const f = document.querySelector('#ident-preview-form'); f.elements.projectId.value = '第二專案'; f.elements.reference.value = ''; f.elements.projectId.dispatchEvent(new Event('input', { bubbles: true })); })()");
  assert.ok(!await js(`!!document.querySelector('${confirmButton}')`), '改動提案後不能確認舊畫面');
  const readyToConfirm = () => until(() => js(`document.querySelector('#ident-preview-result')?.textContent.includes('SECO-N') && !!document.querySelector('${confirmButton}')`), 10000, '已顯示可確認的預覽');
  const confirmRepair = () => js(`(() => { document.querySelector('[data-ident-ack]').click(); document.querySelector('${confirmButton}').click(); })()`);
  await submit('SECO');
  await readyToConfirm();
  assert.equal((await kit.call(boss.token, '/api/projects', 'POST', { name: 'Concurrent project', slug: 'concurrent-project', code: 'RACE' })).status, 201);
  await confirmRepair();
  await until(() => js("document.querySelector('#ident-preview-error')?.textContent.includes('修復預覽已過期')"), 10000, '出現過期訊息，可以重試');
  assert.ok(!await js(`!!document.querySelector('${confirmButton}')`), '過期預覽不能再次確認');
  assert.equal((await kit.call(boss.token, '/api/admin/project-identity')).body.conflicts.length, 1);
  await submit('SECO');
  await readyToConfirm();
  await confirmRepair();
  await until(() => js("!document.querySelector('#ident-preview-form') && !document.querySelector('.ident-card')"), 10000, '確認後診斷重新讀取');
  assert.equal((await kit.call(boss.token, '/api/admin/project-identity')).body.conflicts.length, 0, '沒有衝突了');
  assert.equal((await kit.call(boss.token, '/api/projects')).body.items.find(p => p.id === '第二專案').code, 'SECO');
  console.log('✓ 平台設定確認綁定畫面上的預覽，過期可重試，成功重新讀取診斷');
  // 頁面讀完診斷資料、畫完之後才記一次（讀資料的 then 在 json() 之後的微任務裡畫面，這裡排在它們後面的下一個工作）
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__identLoads = 0; const of = window.fetch;
    window.fetch = async (u, o) => { const r = await of(u, o); if (String(u).includes('/api/admin/project-identity')) { const j = r.json.bind(r); r.json = () => j().then(v => { setTimeout(() => { window.__identLoads++; }); return v; }); } return r; }; })()` });
  await login(boss.token, '/admin/system');
  await until(() => js("document.body.innerText.includes('下載備份')"), 10000, '平台設定頁');
  await until(() => js('window.__identLoads > 0'), 10000, '頁面讀完專案識別碼的診斷');
  assert.ok(!(await js("!!document.querySelector('.ident-card')")), '沒有衝突就不顯示');
  console.log('✓ 沒有衝突就不顯示');

  const post = (project, text) => kit.call(boss.token, '/api/messages', 'POST', { project, text, requestId: text });
  assert.equal((await post('預設專案', 'Route target one')).status, 201);
  assert.equal((await post('第二專案', 'Route target two')).status, 201);
  kit.sql("UPDATE app_settings SET value = 'main' WHERE key = ?", 'slug:第二專案');
  const plan = (await kit.call(boss.token, '/api/admin/project-identity/preview', 'POST', { projectId: '預設專案', field: 'slug', replacement: 'new-main' })).body;
  const route = plan.routes.find(r => r.path === '/p/main');
  assert.deepEqual([route.before.projectId, route.after.projectId], ['預設專案', '第二專案']);
  await goto('/p/main/messages');
  await until(() => js("document.querySelector('#messages')?.innerText.includes('Route target one')"), 10000, '正常網址仍開原專案');
  assert.ok(!(await js("document.querySelector('#messages')?.innerText.includes('Route target two')")));
  console.log('✓ 瀏覽器正常網址與預覽的目前解析相符');
  kit.sql("INSERT INTO app_settings (key, value) VALUES ('pcodeold:MAIN', ?)", '第二專案');
  await goto('/admin/system');
  await until(() => js("[...document.querySelectorAll('.ident-list li')].find(li => li.textContent.includes('舊代號相同'))?.querySelector('button')?.click() ?? !!document.querySelector('#ident-preview-form')"), 10000, '開啟現行代號和舊代號衝突');
  await js("(() => { const form = document.querySelector('#ident-preview-form'); const action = form.elements.repairAction; action.value = 'retireAlias'; action.dispatchEvent(new Event('input', { bubbles: true })); form.requestSubmit(); })()");
  await until(() => js("document.querySelector('#ident-preview-result')?.textContent.includes('將停用這個專案的舊代號')"), 10000, '預覽保留現行代號');
  console.log('✓ 平台設定可預覽停用另一個專案的舊代號');

  kit.sql('UPDATE projects SET archived = 1 WHERE id = ?', '預設專案');
  const archived = (await kit.call(boss.token, '/api/admin/project-identity/preview', 'POST', { projectId: '預設專案', field: 'slug', replacement: 'new-main' })).body;
  assert.equal(archived.routes[0].beforeStatus, 'archived');
  await goto('/p/main/messages');
  await until(() => js("location.pathname === '/'"), 10000, '封存專案的網址回到首頁');
  console.log('✓ 先符合網址的封存專案沒有可開啟的專案頁面');

  await goto('/admin/system');
  await until(() => js("!![...document.querySelectorAll('.ident-list li')].find(li => li.textContent.includes('網址英文名重複'))"), 10000, '找到網址英文名衝突');
  await js("[...document.querySelectorAll('.ident-list li')].find(li => li.textContent.includes('網址英文名重複')).querySelector('button').click()");
  await submit('new-main');
  await until(() => js(`document.querySelector('#ident-preview-result')?.textContent.includes('/p/new-main') && !!document.querySelector('${confirmButton}')`), 10000, '網址英文名修復預覽');
  await confirmRepair();
  await until(() => js("!document.querySelector('#ident-preview-form')"), 10000, '已確認網址英文名修復');
  await goto('/p/main/messages');
  await until(() => js("document.querySelector('#messages')?.innerText.includes('Route target two')"), 10000, '舊網址依預覽開啟第二專案');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(boss.token, '/admin/platlog');
  const line = await until(() => js("[...document.querySelectorAll('.alog-table tbody tr')].find(row => row.textContent.includes('Project slug: main → new-main'))?.textContent"), 10000, '英文版平台稽核紀錄');
  assert.match(line, /Repaired project identifiers/);
  console.log('✓ 確認後正常網址依預覽解析，英文平台稽核紀錄顯示修復動作');
  console.log('project-identity-ui-test：全部通過');
} catch (e) {
  console.error('project-identity-ui-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally { await kit.stop(); }
