// 畫面測試：平台設定頁（#9）只有平台管理員看得到且可操作
// A. 平台管理員：管理員設定左側有「平台設定」；頁面有版本、附件保存時間預設、示範資料、備份；改附件保存預設會存進平台設定
// B. 工作區管理員（不是平台管理員）：左側沒有「平台設定」，打 /admin/system 只看到待處理；帳號頁有「移出工作區…」、沒有「停用…」
// C. 工作區設定：附件保存時間可以「跟平台預設」或覆寫
// D. 375 不橫向捲動
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/platform-settings-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('platform-settings-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('platui');
try {
  const { call } = kit;
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'QA' })).body;
  assert.equal((await call(boss.token, `/api/participants/${chen.participant.participantId}/workspace-role`, 'PUT', { role: 'admin' })).status, 200);
  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const nav = () => js("JSON.stringify([...document.querySelectorAll('.adm-nav [data-adm]')].map(b => b.dataset.adm))").then(JSON.parse);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  await size(1280, 860);

  // ---- B 工作區管理員看不到平台設定 ----
  await login(chen.token, '/admin/system');
  await until(() => js("!!document.querySelector('.adm-nav') && !!document.querySelector('.adm-main')"), 10000, '工作區管理員的管理員設定');
  assert.ok(!(await nav()).includes('system'), '工作區管理員左側沒有平台設定');
  assert.ok(!(await js("!!document.querySelector('#adm-ttl')")), '打平台設定的網址也看不到平台設定');
  assert.match(await js("document.querySelector('.adm-main h3').innerText"), /待處理/, '退回待處理');
  await click('[data-adm="accounts"]');
  await until(() => js("!!document.querySelector('.adm-acc')"), 8000, '帳號與救援');
  assert.ok(await js(`!!document.querySelector('[data-pm-remove="${wang.participant.participantId}"]')`), '有「移出工作區…」');
  assert.equal(await js("document.querySelectorAll('[data-pm-disable]').length"), 0, '沒有「停用…」（停用帳號是平台管理員的事）');
  console.log('✓ 工作區管理員看不到平台設定、不能停用帳號');

  // ---- A 平台管理員 ----
  await login(boss.token, '/admin/system');
  await until(() => js("!!document.querySelector('#adm-ttl') && /下載備份/.test(document.querySelector('.adm-main').innerText)"), 15000, '平台設定');
  const n = await nav();
  assert.equal(n[n.length - 1], 'system', '左側最後是平台設定');
  assert.match(await js("document.querySelector('.adm-nav [data-adm=\"system\"]').innerText"), /平台設定/);
  assert.match(await js("document.querySelector('.adm-main').innerText"), /版本[\s\S]*訊息附件保存時間[\s\S]*示範資料[\s\S]*下載備份[\s\S]*匯入備份/, '版本、附件保存預設、示範資料、備份');
  assert.match(await js("document.querySelector('.adm-ttl-ws').innerText"), /這是平台預設/, '寫明是平台預設');
  await js("(() => { const s = document.querySelector('#adm-ttl'); s.value = '6'; s.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-pp=\"filettl\"]').click(); return true; })()");
  await until(async () => (await call(boss.token, '/api/platform/settings')).body.fileTtl?.hours === 6, 8000, '平台預設存成 6 小時');
  assert.equal((await call(wang.token, '/api/file-ttl')).body.hours, 6, '沒覆寫的工作區跟著平台預設');
  await click('[data-adm="accounts"]');
  await until(() => js("!!document.querySelector('.adm-acc')"), 8000, '帳號與救援');
  assert.ok(await js(`!!document.querySelector('[data-pm-disable="${wang.participant.participantId}"]')`), '平台管理員有「停用…」');
  console.log('✓ 平台管理員看得到、能改平台設定');

  // ---- C 工作區設定：覆寫附件保存時間 ----
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('#ws-ttl')"), 10000, '工作區設定的附件保存時間');
  assert.equal(await js("document.querySelector('#ws-ttl').value"), '', '預設跟平台');
  assert.match(await js("document.querySelector('#ws-ttl option[value=\"\"]').textContent"), /跟平台預設（6 小時）/);
  await js("(() => { const s = document.querySelector('#ws-ttl'); s.value = '72'; document.querySelector('[data-pp=\"wsttl\"]').click(); return true; })()");
  await until(async () => (await call(wang.token, '/api/file-ttl')).body.hours === 72, 8000, '工作區覆寫成 3 天');
  await until(() => js("document.querySelector('#ws-ttl')?.value === '72'"), 8000, '重畫後停在 3 天');
  await js("(() => { const s = document.querySelector('#ws-ttl'); s.value = ''; document.querySelector('[data-pp=\"wsttl\"]').click(); return true; })()");
  await until(async () => (await call(wang.token, '/api/file-ttl')).body.workspaceHours === null, 8000, '回到跟平台預設');
  console.log('✓ 工作區設定可以覆寫附件保存時間');

  // ---- D 375 ----
  await size(375, 812);
  await login(boss.token, '/admin/system');
  await until(() => js("!!document.querySelector('#adm-ttl')"), 15000, '手機平台設定');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 沒有橫向捲動');
  console.log('platform-settings-ui-test：全部通過');
} catch (e) {
  console.error('platform-settings-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
