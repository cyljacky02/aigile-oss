// 畫面測試（規格 #39「介面」）：三種「誰可以建立專案」政策下，所有建立專案的入口（總覽側欄、總覽、專案切換器、手機選單）一致，
// 而且跟 GET /api/projects 的 capability、實際 API 的結果一致：
//   members：一般成員「新增專案」（直接建立表單，沒有申請原因）；approval：一般成員「申請建立專案」（申請表單）；admins：一般成員看不到任何入口
//   工作區管理員三種政策下都是「新增專案」；AI 的 capability 一律為否
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/project-creation-entries-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-creation-entries-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pcentry');
try {
  const join = async (name, role = 'PG') => { const b = (await kit.call(null, '/api/join', 'POST', { name, role })).body; return { token: b.token, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 工作區管理員兼平台管理員
  const mate = await join('陳大文'); // 一般成員
  assert.equal((await kit.call(boss.token, `/api/participants/${mate.id}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  const ai = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '林的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = ai.token || kit.aiToken(ai.participantId);
  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  const caps = async token => { const b = (await kit.call(token, '/api/projects')).body; return [b.canCreateProject, b.canRequestProjectCreation, b.canReviewProjectCreationRequests]; };

  // 四個入口的文字（沒有入口＝null）
  async function entries(token) {
    await size(1280, 860);
    await login(token, '/');
    await until(() => js("!!document.querySelector('.hub-side [data-proj=\"預設專案\"]') && !!document.querySelector('.hub-grid')"), 15000, '總覽畫好');
    await until(() => js("!!document.querySelector('.hub-cross')"), 10000, '總覽的卡片區');
    const side = await text('.hub-side [data-hub-newproj] .hs-name');
    const hub = await text('.hub-join[data-hub-newproj]');
    const mobileHidden = await js("document.querySelector('#m-newproj').hidden");
    const mobile = mobileHidden ? null : await text('#m-newproj .m-newproj-t');
    await click('.hub-side [data-proj="預設專案"]');
    await until(() => js("!!document.querySelector('.ps-list')"), 10000, '進專案（專案切換器）');
    const switcher = await text('.ps-act[data-ps-act="newproj"]');
    return { side, hub, switcher, mobile };
  }
  // 從總覽的入口打開表單：申請表單有申請原因、送出鈕寫「送出申請」；直接建立的沒有
  async function formKind(token) {
    await login(token, '/');
    await until(() => js("!!document.querySelector('.hub-join[data-hub-newproj]')"), 15000, '總覽的入口');
    await click('.hub-join[data-hub-newproj]');
    await until(() => js("!!document.querySelector('#np-form')"), 8000, '表單');
    const kind = (await js("!!document.querySelector('#np-form [name=\"reason\"]')")) ? 'request' : 'direct';
    assert.equal(await text('#np-submit'), kind === 'request' ? '送出申請' : '新增專案', '送出按鈕');
    await js("document.querySelector('.modal [data-close]')?.click(); true");
    return kind;
  }

  const EXPECT = {
    members: { mate: { side: '新增專案', hub: '＋ 新增專案', switcher: '＋ 新增專案', mobile: '新增專案' }, caps: [true, false, false], form: 'direct' },
    approval: { mate: { side: '申請建立專案', hub: '＋ 申請建立專案', switcher: '＋ 申請建立專案', mobile: '申請建立專案' }, caps: [false, true, false], form: 'request' },
    admins: { mate: { side: null, hub: null, switcher: null, mobile: null }, caps: [false, false, false], form: null },
  };
  const ADMIN = { side: '新增專案', hub: '＋ 新增專案', switcher: '＋ 新增專案', mobile: '新增專案' };
  let n = 0;
  for (const [policy, want] of Object.entries(EXPECT)) {
    assert.equal((await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: policy })).status, 200, `政策設成 ${policy}`);
    // capability ↔ 實際 API
    assert.deepEqual(await caps(mate.token), want.caps, `${policy}：一般成員的 capability`);
    assert.deepEqual(await caps(boss.token), [true, false, true], `${policy}：管理員的 capability`);
    if (aiToken) assert.deepEqual(await caps(aiToken), [false, false, false], `${policy}：AI 一律為否`);
    const direct = await kit.call(mate.token, '/api/projects', 'POST', { name: `直接${++n}` });
    assert.equal(direct.status, want.caps[0] ? 201 : 403, `${policy}：一般成員直接建立 ${JSON.stringify(direct.body)}`);
    const req = await kit.call(mate.token, '/api/project-creation-requests', 'POST', { requestId: `entry-${n}`, name: `申請${n}`, reason: 'x' });
    assert.equal(req.status, want.caps[1] ? 201 : 403, `${policy}：一般成員送申請 ${JSON.stringify(req.body)}`);
    if (aiToken) {
      assert.equal((await kit.call(aiToken, '/api/projects', 'POST', { name: `AI${n}` })).status, 403, `${policy}：AI 不能直接建立`);
      assert.equal((await kit.call(aiToken, '/api/project-creation-requests', 'POST', { requestId: `ai-${n}`, name: `AI申請${n}`, reason: 'x' })).status, 403, `${policy}：AI 不能送申請`);
    }
    // 畫面上的四個入口
    assert.deepEqual(await entries(mate.token), want.mate, `${policy}：一般成員的入口`);
    if (want.form) assert.equal(await formKind(mate.token), want.form, `${policy}：一般成員打開的表單`);
    assert.deepEqual(await entries(boss.token), ADMIN, `${policy}：管理員的入口`);
    assert.equal(await formKind(boss.token), 'direct', `${policy}：管理員直接建立`);
    console.log(`✓ ${policy}：入口、表單、capability 與 API 一致`);
  }
  // admins：一般成員之前在 approval 送過申請 → 有紀錄，「我的建立專案申請」照樣看得到（已取消），但沒有申請按鈕
  await login(mate.token, '/');
  await until(() => js("!!document.querySelector('.pcr-mine .pcr-row')"), 15000, '我的建立專案申請（有紀錄）');
  assert.match(await text('.pcr-mine'), /已取消/, '政策切走後申請已取消');
  assert.ok(!(await js("!!document.querySelector('.pcr-mine [data-hub-newproj]')")), '不能申請時沒有申請按鈕');
  // 375：手機選單的入口跟桌面一致（approval）
  assert.equal((await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' })).status, 200);
  await size(375, 812);
  await login(mate.token, '/');
  await until(() => js("document.querySelector('#m-newproj')?.hidden === false"), 15000, '手機選單的入口');
  assert.equal(await text('#m-newproj .m-newproj-t'), '申請建立專案', '手機選單');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 不橫向捲動');
  console.log('project-creation-entries-ui-test：全部通過');
} finally {
  await kit.stop();
}
