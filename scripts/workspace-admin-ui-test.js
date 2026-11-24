// 畫面測試：管理員設定 › 帳號與救援可以升降工作區管理員（#8）
// 最後一位工作區管理員的「降為成員」停用並說明原因；升別人之後可以降自己；沒有「交接管理員」
// 升降規則本身在 workspace-admin-test.js 驗。需要 Chrome 或 Edge；找不到就略過。用法：node scripts/workspace-admin-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('workspace-admin-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('wsadmui');
try {
  const { call } = kit;
  const liu = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位＝工作區管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  const Lu = liu.participant.participantId, Wg = wang.participant.participantId;
  const { js, login } = await kit.browser(1280, 860);
  const btn = id => `.adm-acc [data-pm-wsrole="${id}"]`;
  const attr = (sel, a) => js(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)}) ?? null`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const okConfirm = async () => { await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 8000, '確認框'); await click('.confirm-root [data-ok]'); };
  const roleOf = async (tok, id) => (await call(tok, '/api/participants')).body.items.find(p => p.participantId === id)?.workspaceRole;

  await login(liu.token, '/admin/accounts');
  await until(() => js(`!!document.querySelector(${JSON.stringify(btn(Lu))})`), 10000, '帳號與救援');
  assert.equal(await js('document.querySelectorAll(".adm-acc [data-pm-admin]").length'), 0, '沒有交接管理員');
  assert.equal(await attr(btn(Lu), 'data-role'), 'member', '自己這列是「降為成員」');
  assert.notEqual(await attr(btn(Lu), 'disabled'), null, '最後一位：按鈕停用');
  assert.match(await attr(btn(Lu), 'title'), /最後一位工作區管理員不能降級/, '說明原因');
  assert.equal(await attr(btn(Wg), 'data-role'), 'admin', '王小明這列是「升為工作區管理員」');
  assert.match(await js(`document.querySelector(${JSON.stringify(btn(Wg))}).textContent`), /升為工作區管理員/);

  // 升王小明
  await click(btn(Wg));
  await okConfirm();
  await until(async () => (await roleOf(liu.token, Wg)) === 'admin', 8000, '王小明升為工作區管理員');
  await until(() => js(`document.querySelector(${JSON.stringify(btn(Wg))})?.getAttribute('data-role') === 'member'`), 8000, '王小明那列換成「降為成員」');
  assert.equal(await attr(btn(Lu), 'disabled'), null, '有兩位之後，自己的「降為成員」可以按');
  assert.match(await js("[...document.querySelectorAll('.adm-acc .c-name')].find(td => td.textContent.includes('王小明'))?.textContent || ''"), /管理員/, '王小明標管理員');

  // 降自己
  await click(btn(Lu));
  await okConfirm();
  await until(async () => (await roleOf(wang.token, Lu)) === 'member', 8000, '林志明降為成員');
  await login(wang.token, '/admin/accounts');
  await until(() => js(`!!document.querySelector(${JSON.stringify(btn(Wg))})`), 10000, '王小明看帳號與救援');
  assert.notEqual(await attr(btn(Wg), 'disabled'), null, '王小明現在是最後一位：停用');
  assert.equal(await attr(btn(Lu), 'data-role'), 'admin', '林志明那列是「升為工作區管理員」');
  console.log('workspace-admin-ui-test：全部通過');
} catch (e) {
  console.error('workspace-admin-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
