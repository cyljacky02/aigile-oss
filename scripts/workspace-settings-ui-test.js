// 畫面測試：管理員設定 ›「工作區設定」（原「群組設定」）顯示新名稱與「誰可以建立專案」，可以切換；
// 設成所有成員時，一般成員看得到「＋ 新增專案」、建好後是該專案的專案管理員；只有管理員時看不到
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/workspace-settings-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('workspace-settings-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('wsui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 工作區管理員
  const mate = (await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const mateId = mate.participant.participantId;
  await kit.call(boss.token, `/api/participants/${mateId}/projects`, 'PUT', { projects: ['預設專案'] });
  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const checked = () => js("document.querySelector('[data-pp=\"createprojects\"]:checked')?.value || ''");
  await size(1280, 860);

  // 工作區設定頁：新名稱、六項設定
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('.pm-create-proj [data-pp=\"createprojects\"]')"), 10000, '誰可以建立專案');
  assert.equal(await js("document.querySelector('.adm-nav [data-adm=\"group\"] .adm-t b').textContent"), '工作區設定', '左側目錄叫工作區設定');
  assert.match(await js("document.querySelector('.adm-h').textContent"), /工作區設定/, '大標題');
  assert.equal(await js("document.querySelector('label[for=\"pm-group-name\"]').textContent"), '工作區名稱');
  assert.match(await js("document.querySelector('.pm-create-proj').innerText"), /誰可以建立專案[\s\S]*所有成員[\s\S]*只有工作區管理員/);
  assert.deepEqual(await js("[...document.querySelectorAll('[data-pp=\"createprojects\"]')].map(i => i.value)"), ['members', 'approval', 'admins'], '三個選項：所有成員、成員申請（正式環境可選）、只有工作區管理員');
  assert.match(await js("document.querySelector('.pm-tools strong').textContent"), /可連線的 AI 工具/);
  assert.ok(await js("!!document.querySelector('.pm-join-set [data-pp=\"openjoin\"]') && !!document.querySelector('#pm-room-code')"), '開放註冊、房間碼');
  await until(() => js("!!document.querySelector('.adm-main #ws-ttl')"), 8000, '附件保存期限（工作區覆寫）');
  assert.equal(await checked(), 'members', '新安裝：所有成員');
  assert.ok(!(await js("document.body.innerText.includes('群組設定')")), '畫面上沒有「群組設定」');

  // 切到「只有管理員」：存起來、異動紀錄多一筆
  await click('[data-pp="createprojects"][value="admins"]');
  await until(async () => (await kit.call(boss.token, '/api/workspace/settings')).body.createProjects === 'admins', 8000, '存成只有管理員');
  await until(async () => (await checked()) === 'admins', 8000, '畫面停在只有管理員');
  await until(() => js("/設定誰可以建立專案：只有工作區管理員/.test(document.querySelector('.pm-gs-log').textContent)"), 8000, '異動紀錄');

  // 一般成員：看不到新增專案
  await login(mate.token, '/');
  await until(() => js("!!document.querySelector('.hub')"), 10000, '總覽');
  assert.ok(!(await js("!!document.querySelector('[data-hub-newproj]:not([hidden])')")), '只有管理員時一般成員沒有「＋ 新增專案」');

  // 切回「所有成員」→ 一般成員看得到、建好後是專案管理員
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('[data-pp=\"createprojects\"][value=\"members\"]')"), 10000, '設定頁');
  await click('[data-pp="createprojects"][value="members"]');
  await until(async () => (await kit.call(boss.token, '/api/workspace/settings')).body.createProjects === 'members', 8000, '存成所有成員');
  await login(mate.token, '/');
  await until(() => js("!!document.querySelector('.hub-join[data-hub-newproj]')"), 10000, '一般成員看得到「＋ 新增專案」');
  await click('.hub-join[data-hub-newproj]');
  await until(() => js("!!document.querySelector('#np-form')"), 8000, '新增專案視窗');
  await js("(() => { const i = document.querySelector('#np-form input[name=\"name\"]'); i.value = '陳的專案'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#np-form').requestSubmit(); return true; })()");
  const mine = await until(async () => (await kit.call(mate.token, '/api/projects')).body.items.find(p => p.name === '陳的專案'), 8000, '建好專案');
  assert.deepEqual((await kit.call(mate.token, '/api/projects')).body.leaders[mine.id], [mateId], '建立者是專案管理員');
  assert.equal(mine.visibility, 'review', '沒動可見度：審核');

  // 新增專案表單有可見度選項（預設審核）；選私人建好就是私人專案
  await until(() => js("!document.querySelector('#np-form')"), 8000, '視窗關了');
  await until(() => js("!!document.querySelector('.hub-join[data-hub-newproj]')"), 10000, '「＋ 新增專案」');
  await click('.hub-join[data-hub-newproj]');
  await until(() => js("!!document.querySelector('#np-form [name=\"visibility\"]')"), 8000, '新增專案視窗有可見度');
  assert.deepEqual(await js("[...document.querySelectorAll('#np-form [name=\"visibility\"]')].map(i => i.value)"), ['open', 'review', 'private'], '三種可見度');
  assert.equal(await js("document.querySelector('#np-form [name=\"visibility\"]:checked')?.value"), 'review', '預設審核');
  await click('#np-form [name="visibility"][value="private"]');
  await js("(() => { const i = document.querySelector('#np-form input[name=\"name\"]'); i.value = '陳的私人專案'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#np-form').requestSubmit(); return true; })()");
  const priv = await until(async () => (await kit.call(mate.token, '/api/projects')).body.items.find(p => p.name === '陳的私人專案'), 8000, '建好私人專案');
  assert.equal(priv.visibility, 'private', '選私人：建好就是私人');
  // 375：新增專案視窗（含可見度）不橫向捲動
  await until(() => js("!document.querySelector('#np-form')"), 8000, '視窗關了');
  await size(375, 812);
  await login(mate.token, '/');
  await until(() => js("document.querySelector('.hub-join[data-hub-newproj]')?.offsetParent != null"), 10000, '手機「＋ 新增專案」');
  await click('.hub-join[data-hub-newproj]');
  await until(() => js("!!document.querySelector('#np-form [name=\"visibility\"]')"), 8000, '手機新增專案視窗');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 新增專案視窗不橫向捲動');
  await size(1280, 860);

  // 375：不橫向捲動
  await size(375, 812);
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('.pm-create-proj')"), 10000, '手機工作區設定');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 不橫向捲動');
  console.log('workspace-settings-ui-test：全部通過');
} catch (e) {
  console.error('workspace-settings-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
