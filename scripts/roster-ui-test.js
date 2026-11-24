// 畫面測試：成員名冊（#13）
// A. 一般成員：頭像選單有「成員名冊」；名冊列出所有人（包括沒有專案的人）；只有「啟用中」，沒有升降、移出、停用
// B. 平台管理員：可篩選啟用中／已移出／待接受邀請／所有帳號
// C. 從名冊升降工作區管理員、平台管理員；最後一位時按鈕停用並說明原因
// D. 從名冊移出工作區、停用帳號（停用的在「所有帳號」可以恢復）
// E. 帳號與救援不再有升降、移出、停用（入口搬到名冊）；375 不橫向捲動
// 名冊的權限規則在 roster-test.js 驗。需要 Chrome 或 Edge；找不到就略過。用法：node scripts/roster-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('roster-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('rosterui');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const chen = await join('陳昭宇', 'PG'), wang = await join('王小美', 'QA'), lin = await join('林小新', 'BA'), zhao = await join('趙前同事', 'UX');
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId, Ln = lin.participant.participantId, Zo = zhao.participant.participantId;
  for (const id of [Cn, Wg]) assert.equal((await call(boss.token, `/api/participants/${id}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '張新人', projects: [{ project: '預設專案', role: 'viewer' }] })).status, 201);
  assert.equal((await call(boss.token, `/api/participants/${Zo}/remove`, 'POST')).status, 200);
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '趙前同事' })).status, 201, '邀請已移出的人回來（#14 rejoin）');

  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const attr = (sel, a) => js(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)}) ?? null`);
  const count = sel => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const rows = () => js("JSON.stringify([...document.querySelectorAll('.rs-table tbody .rs-tr')].map(tr => tr.querySelector('.rs-name')?.textContent.trim()))").then(JSON.parse);
  const has = async name => (await rows()).some(t => t.includes(name));
  const filters = () => js("[...document.querySelectorAll('[data-rs-filter]')].map(b => b.dataset.rsFilter).join(',')");
  const okConfirm = async () => { await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 8000, '確認框'); await click('.confirm-root [data-ok]'); };
  const filter = k => until(async () => { // 名冊重讀中按鈕還沒出來就再按一次
    if (await js(`document.querySelector('[data-rs-filter="${k}"]')?.getAttribute('aria-pressed') === 'true'`)) return true;
    await click(`[data-rs-filter="${k}"]`);
    return false;
  }, 8000, '篩選 ' + k);
  const api = async (tok, id) => (await call(tok, '/api/roster')).body.members.find(p => p.participantId === id);
  await size(1280, 860);

  // ---- A 一般成員 ----
  await login(lin.token, '/');
  await click('.av-btn');
  await until(() => js("!!document.querySelector('#av-menu [data-av=\"roster\"]')"), 8000, '頭像選單有成員名冊');
  await click('#av-menu [data-av="roster"]');
  await until(() => js("!!document.querySelector('.rs-table')"), 10000, '成員名冊');
  assert.match(await js("location.pathname"), /^\/roster$/, '網址 /roster');
  for (const n of ['林志明', '陳昭宇', '王小美', '林小新']) assert.ok(await has(n), '名冊有 ' + n);
  assert.ok(!(await has('趙前同事')), '已移出的不在名冊');
  assert.equal(await filters(), 'active', '一般成員只有啟用中');
  assert.equal(await count('[data-pm-wsrole], [data-pm-platrole], [data-pm-remove], [data-pm-disable]'), 0, '一般成員沒有管理按鈕');
  console.log('✓ 一般成員看得到名冊，沒有管理按鈕');

  // ---- B 篩選 ----
  await login(boss.token, '/roster');
  await until(() => js("!!document.querySelector('.rs-table')"), 10000, '管理員的成員名冊');
  assert.equal(await filters(), 'active,removed,pending,accounts', '平台管理員：啟用中、已移出、待接受邀請、所有帳號');
  await filter('removed');
  await until(() => has('趙前同事'), 8000, '已移出有趙前同事');
  assert.ok(!(await has('陳昭宇')));
  assert.match(await js("document.querySelector('.rs-table').innerText"), /已邀請回來/, '已移出的人有邀請回來的標記');
  await filter('pending');
  await until(() => has('張新人'), 8000, '待接受邀請有張新人');
  const pend = await js("document.querySelector('.rs-table').innerText");
  assert.match(pend, /張新人[\s\S]*預設專案[\s\S]*唯讀成員/, '待接受邀請顯示預設的專案與專案角色：' + pend);
  assert.match(pend, /趙前同事[\s\S]*重新加入/, '重新加入的邀請');
  await filter('accounts');
  await until(() => has('趙前同事') && has('林小新'), 8000, '所有帳號');
  await filter('active');
  await until(() => has('陳昭宇'), 8000, '回到啟用中');
  console.log('✓ 可篩選啟用中／已移出／待接受邀請／所有帳號');

  // ---- C 升降 ----
  const ws = id => `.rs-table [data-pm-wsrole="${id}"]`, pf = id => `.rs-table [data-pm-platrole="${id}"]`;
  assert.equal(await attr(ws(Bo), 'data-role'), 'member');
  assert.notEqual(await attr(ws(Bo), 'disabled'), null, '最後一位工作區管理員：降級按鈕停用');
  assert.match(await attr(ws(Bo), 'title'), /最後一位工作區管理員/, '說明原因');
  assert.notEqual(await attr(pf(Bo), 'disabled'), null, '最後一位平台管理員：降級按鈕停用');
  assert.match(await attr(pf(Bo), 'title'), /最後一位平台管理員/, '說明原因');
  assert.equal(await count(`.rs-table [data-pm-remove="${Bo}"], .rs-table [data-pm-disable="${Bo}"]`), 0, '自己這列沒有移出、停用');
  await click(ws(Cn)); await okConfirm();
  await until(async () => (await api(boss.token, Cn))?.workspaceRole === 'admin', 8000, '陳昭宇升為工作區管理員');
  await until(async () => (await attr(ws(Bo), 'disabled')) === null, 8000, '有兩位之後可以降自己');
  await click(pf(Cn)); await okConfirm();
  await until(async () => (await api(boss.token, Cn))?.platformRole === 'admin', 8000, '陳昭宇升為平台管理員');
  await until(async () => (await attr(pf(Bo), 'disabled')) === null, 8000, '有兩位平台管理員之後可以降自己');
  await click(ws(Cn)); await okConfirm();
  await until(async () => (await api(boss.token, Cn))?.workspaceRole === 'member', 8000, '陳昭宇降回成員');
  console.log('✓ 從名冊升降工作區管理員、平台管理員；最後一位時按鈕停用');

  // ---- D 移出、停用 ----
  await click(`.rs-table [data-pm-remove="${Wg}"]`); await okConfirm();
  await until(async () => !(await api(boss.token, Wg)), 8000, '王小美移出工作區');
  await until(async () => !(await has('王小美')), 8000, '王小美不在啟用中');
  await filter('removed');
  await until(() => has('王小美'), 8000, '王小美在已移出');
  await filter('active');
  await until(() => js(`!!document.querySelector('.rs-table [data-pm-disable="${Ln}"]')`), 8000, '停用按鈕');
  await click(`.rs-table [data-pm-disable="${Ln}"]`); await okConfirm();
  await until(async () => (await call(lin.token, '/api/me')).status === 401, 8000, '林小新停用後登不進來');
  await filter('accounts');
  await until(() => js(`!!document.querySelector('.rs-table [data-pm-enable="${Ln}"]')`), 8000, '所有帳號裡可以恢復林小新');
  console.log('✓ 從名冊移出工作區、停用帳號');

  // ---- E 帳號與救援沒有這些按鈕；375 ----
  await login(boss.token, '/admin/accounts');
  await until(() => js("!!document.querySelector('.adm-acc')"), 10000, '帳號與救援');
  assert.equal(await count('.adm-acc [data-pm-wsrole], .adm-acc [data-pm-remove], .adm-acc [data-pm-disable], .pm-disabled'), 0, '帳號與救援不再有升降、移出、停用');
  assert.ok(await js("!!document.querySelector('[data-rs-open]')"), '帳號與救援連到成員名冊');
  await size(375, 812);
  await login(boss.token, '/roster');
  await until(() => js("!!document.querySelector('.rs-table')"), 10000, '手機的成員名冊');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 沒有橫向捲動');
  console.log('roster-ui-test：全部通過');
} catch (e) {
  console.error('roster-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
