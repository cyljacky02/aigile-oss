// 選取專案範本後可核對和修改值；審核人看到的是送出的內容，不是最新範本。
import assert from 'node:assert/strict';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-templates-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('ptui');
const base = '/api/workspace/project-templates';
const statuses = [
  { name: '待處理', category: '待處理', color: 'violet' },
  { name: '進行中', category: '進行中', color: 'amber' },
  { name: '已完成', category: '已完成', color: 'green' },
];
try {
  const join = async name => (await kit.call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
  const admin = await join('林志明'), member = await join('陳大文');
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  ok(await kit.call(admin.token, `/api/participants/${member.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] }));
  const { js, login, cdp } = await kit.browser(1280, 860);
  const click = s => js(`document.querySelector(${JSON.stringify(s)})?.click(); true`);
  const exists = s => js(`!!document.querySelector(${JSON.stringify(s)})`);
  const value = (s, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const submit = id => js(`document.getElementById(${JSON.stringify(id)}).requestSubmit(); true`);
  const policy = async createProjects => ok(await kit.call(admin.token, '/api/workspace/settings', 'PUT', { createProjects }));
  const templates = async () => ok(await kit.call(admin.token, base)).items;
  const adminSettings = async () => {
    await login(admin.token, '/admin/group');
    await until(() => exists('[data-pp="template-new"]'), 10000, '工作區設定中的專案範本');
  };
  await adminSettings();
  await click('[data-pp="template-new"]');
  await until(() => exists('#pt-form'), 5000, '新增範本表單');
  await value('#pt-form [name=name]', '交付流程');
  await click('#pt-form [name=visibility][value=private]');
  for (const index of [5, 4, 1]) await click(`#pt-form .st-row:nth-child(${index}) [data-np-st-del]`);
  await value('#pt-form .st-row:first-child .st-color', 'violet');
  await submit('pt-form');
  await until(() => exists('[data-pp="template-edit"]'), 8000, '範本儲存後出現在設定');
  const [template] = await templates();
  assert.deepEqual(template.statuses, statuses);
  const openCreate = async () => {
    await login(member.token, '/');
    await until(() => exists('.hub-join[data-hub-newproj]'), 10000, '建立專案入口');
    await click('.hub-join[data-hub-newproj]');
    await until(() => exists('#np-form'), 5000, '建立表單');
  };
  const selectTemplate = async () => {
    await until(() => exists(`#np-form [name=template] option[value="${template.id}"]`), 5000, '可選取專案範本');
    await value('#np-form [name=template]', template.id);
    await until(() => js("document.querySelector('#np-form [name=visibility]:checked')?.value === 'private'"), 5000, '表單顯示範本可見度');
    assert.equal(await js("document.querySelector('#np-form details.np-st').open"), true);
    assert.deepEqual(await js("[...document.querySelectorAll('#np-st .st-name')].map(e => e.value)"), ['待處理', '進行中', '已完成']);
    assert.equal(await exists('#np-st .st-swatch[data-color="violet"]'), true);
  };
  const projects = async () => ok(await kit.call(member.token, '/api/projects')).items;
  const requests = async () => ok(await kit.call(member.token, '/api/project-creation-requests')).items;

  await policy('members');
  await openCreate();
  await selectTemplate();
  await click('#np-form [name=visibility][value=open]'); // 複製後仍然可以改
  await value('#np-form [name=name]', '直接套用');
  await submit('np-form');
  await until(async () => (await projects()).some(p => p.name === '直接套用'), 8000, '直接建立成功');
  const direct = (await projects()).find(p => p.name === '直接套用');
  assert.equal(direct.visibility, 'open');
  assert.deepEqual(direct.statuses.map(({ name, category, color }) => ({ name, category, color })), statuses);

  await policy('approval');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await openCreate();
  await selectTemplate();
  assert.ok(await js("document.querySelector('.modal-body').scrollWidth <= document.querySelector('.modal-body').clientWidth + 1"));
  await value('#np-form [name=name]', '申請套用');
  await value('#np-st .st-name', '自訂準備');
  await value('#np-form [name=reason]', '需要這個看板');
  await submit('np-form');
  await until(async () => (await requests()).some(q => q.name === '申請套用'), 8000, '送出建立專案申請');
  const pending = (await requests()).find(q => q.name === '申請套用');
  assert.equal(pending.visibility, 'private');
  assert.deepEqual(pending.statuses[0], { name: '自訂準備', category: '待處理', color: 'violet' });
  await adminSettings();
  const edit = `[data-pp="template-edit"][data-id="${template.id}"]`;
  const retire = `[data-pp="template-retire"][data-id="${template.id}"]`;
  await click(edit);
  await until(() => exists('#pt-form'), 5000, '編輯範本表單');
  await value('#pt-form [name=name]', '新範本');
  await click('#pt-form [name=visibility][value=open]');
  await submit('pt-form');
  await until(async () => (await templates())[0]?.visibility === 'open' && !(await exists('#pt-form')), 8000, '範本已更新');
  await openCreate();
  await until(() => exists(`#np-form [name=template] option[value="${template.id}"]`), 5000, '可選取更新後的範本');
  await value('#np-form [name=template]', template.id);
  await until(() => js("document.querySelector('#np-form [name=visibility]:checked')?.value === 'open'"), 5000, '未來選取讀到新可見度');
  await adminSettings();
  await click(retire);
  await until(() => exists('.confirm-root [data-ok]'), 5000, '確認停用範本');
  await click('.confirm-root [data-ok]');
  await until(async () => (await templates()).length === 0, 8000, '範本已停用');

  await login(admin.token, '/cross/inbox');
  const review = `[data-pcr-review="${pending.id}"]`;
  await until(() => exists(review), 10000, '建立專案申請審核入口');
  await click(review);
  await until(() => exists('#pcr-rv .pcr-dl'), 8000, '審核畫面');
  assert.match(await js("document.querySelector('#pcr-rv .pcr-dl').textContent"), /私人專案[\s\S]*自訂準備/);
  assert.equal(await exists('#pcr-rv .st-swatch[data-color="violet"]'), true);
  await click('#pcr-rv [data-pcr-ok]');
  await until(async () => (await requests()).find(q => q.id === pending.id)?.state === 'approved', 8000, '核准後建立本機專案');
  const approved = (await projects()).find(p => p.name === '申請套用');
  assert.equal(approved.visibility, 'private');
  assert.deepEqual(approved.statuses.map(({ name, category, color }) => ({ name, category, color })), pending.statuses);
  await openCreate();
  await until(() => js("document.querySelector('#np-form [name=template]')?.disabled === false"), 5000, '範本已載入');
  assert.equal(await exists(`#np-form [name=template] option[value="${template.id}"]`), false, '已停用的範本不再出現');
  console.log('project-templates-ui-test：全部通過');
} finally { await kit.stop(); }
