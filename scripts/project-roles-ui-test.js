// 畫面測試（#11）：成員管理依專案檢視時，每位人類成員可設定三種專案角色（專案管理員／專案成員／唯讀成員），改了直接存；
// 改成唯讀成員先確認；畫面不再出現「負責人」「跨專案角色」「AI 角色」
// 用法：node scripts/project-roles-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-roles-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('prole');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 工作區管理員
  const ids = {};
  for (const [n, r] of [['王小明', 'UX'], ['陳大文', 'QA']]) {
    const p = (await kit.call(null, '/api/join', 'POST', { name: n, role: r })).body;
    ids[n] = p.participant.participantId;
    await kit.call(boss.token, `/api/participants/${ids[n]}/projects`, 'PUT', { projects: ['預設專案'] });
  }
  ids['林美玲'] = (await kit.call(null, '/api/join', 'POST', { name: '林美玲', role: 'BA' })).body.participant.participantId; // 還沒有專案
  const meta = async () => (await kit.call(boss.token, '/api/projects')).body;
  const projectsOf = async id => (await kit.call(boss.token, '/api/participants')).body.items.find(p => p.participantId === id)?.projects || [];
  const { js, login, cdp } = await kit.browser(1280, 860);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await login(boss.token, '/members');
  await until(() => js("!!document.querySelector('[data-pm-proj=\"預設專案\"]')"), 10000, '成員管理');
  await js("document.querySelector('[data-pm-proj=\"預設專案\"]').click(); true");
  const sel = id => `.pm-detail [data-pm-prole="${id}"]`;
  await until(() => js(`!!document.querySelector('${sel(ids['王小明'])}')`), 8000, '專案角色選單');

  // 三種專案角色
  const opts = JSON.parse(await js(`JSON.stringify([...document.querySelector('${sel(ids['王小明'])}').options].map(o => [o.value, o.textContent]))`));
  assert.deepEqual(opts, [['admin', '專案管理員'], ['member', '專案成員'], ['viewer', '唯讀成員']], '三種專案角色');
  assert.equal(await js(`document.querySelector('${sel(ids['王小明'])}').value`), 'member', '目前是專案成員');
  assert.match(await js("document.querySelector('.pm-detail .pm-table thead').textContent"), /職稱[\s\S]*專案角色/, '表頭：職稱、專案角色');

  // 設為專案管理員：直接存
  const pick = (id, v) => js(`(() => { const s = document.querySelector('${sel(id)}'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await pick(ids['王小明'], 'admin');
  await until(async () => ((await meta()).projectAdmins['預設專案'] || []).includes(ids['王小明']), 8000, '存成專案管理員');
  await until(() => js(`document.querySelector('${sel(ids['王小明'])}')?.value === 'admin'`), 8000, '畫面跟著更新');

  // 設為唯讀成員：先確認
  await pick(ids['陳大文'], 'viewer');
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 8000, '確認視窗');
  assert.match(await js("document.querySelector('.confirm-root').textContent"), /唯讀成員/, '確認視窗說明唯讀成員');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(async () => ((await meta()).viewers['預設專案'] || []).includes(ids['陳大文']), 8000, '存成唯讀成員');
  // 改回專案成員
  await until(() => js(`document.querySelector('${sel(ids['陳大文'])}')?.value === 'viewer'`), 8000, '畫面顯示唯讀成員');
  await pick(ids['陳大文'], 'member');
  await until(async () => !((await meta()).viewers['預設專案'] || []).includes(ids['陳大文']), 8000, '改回專案成員');

  // 「＋ 加入成員」以唯讀成員加入：直接存
  await js("document.querySelector('[data-pm-pick]').click(); true");
  await until(() => js(`!!document.querySelector('[data-pm-picksel="${ids['林美玲']}"]')`), 8000, '加入成員清單');
  await js(`document.querySelector('[data-pm-picksel="${ids['林美玲']}"]').click(); true`);
  await until(() => js("!document.querySelector('[data-pm-pick-ok]').disabled"), 5000, '勾了');
  await js("document.querySelector('#pm-pick-ro').checked = true; document.querySelector('[data-pm-pick-ok]').click(); true");
  await until(async () => ((await meta()).viewers['預設專案'] || []).includes(ids['林美玲']), 8000, '以唯讀成員加入');
  // 移出：放進變更列，檢查並儲存→確認
  await until(() => js(`!!document.querySelector('.pm-detail [data-pm-rm="${ids['陳大文']}"]')`), 8000, '移出鈕');
  await js(`document.querySelector('.pm-detail [data-pm-rm="${ids['陳大文']}"]').click(); true`);
  await until(() => js("!document.querySelector('#pm-bar').hidden"), 5000, '變更列');
  await js("document.querySelector('[data-pm-act=\"save\"]').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 8000, '確認儲存');
  assert.match(await js("document.querySelector('.confirm-root').textContent"), /陳大文：離開 預設專案/, '確認清單列出移出');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(async () => !(await projectsOf(ids['陳大文'])).includes('預設專案'), 8000, '移出了');

  // 用語：依專案、依成員、AI 職務分頁都不再出現舊詞
  const banned = /負責人|跨專案角色|AI 角色/;
  const panel = () => js("document.querySelector('.pm-panel').innerText + document.querySelector('.work-head').innerText");
  assert.ok(!banned.test(await panel()), '依專案：' + (await panel()).match(banned));
  await js("document.querySelector('[data-pm-view=\"byMember\"]').click(); true");
  await until(() => js("!!document.querySelector('.pm-detail .pm-table')"), 8000, '依成員');
  assert.ok(!banned.test(await panel()), '依成員：' + (await panel()).match(banned));
  await js("document.querySelector('[data-pm-tab=\"roles\"]').click(); true");
  await until(() => js("!!document.querySelector('.pm-tab-roles')"), 8000, 'AI 職務分頁');
  assert.equal(await js("document.querySelector('[data-pm-tab=\"roles\"]').textContent"), 'AI 職務', '分頁叫 AI 職務');
  assert.ok(!banned.test(await panel()), 'AI 職務分頁：' + (await panel()).match(banned));
  await login(boss.token, '/admin/accounts');
  await until(() => js("!!document.querySelector('.adm-acc')"), 8000, '帳號與救援');
  assert.ok(!banned.test(await js('document.body.innerText')), '帳號與救援沒有跨專案角色');
  console.log('project-roles-ui-test：全部通過');
} catch (e) {
  console.error('project-roles-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
