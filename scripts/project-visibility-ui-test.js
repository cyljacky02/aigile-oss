// 畫面測試：專案可見度
// 1. 專案設定（⚙）可以選三種可見度：開放、審核、私人；存了 API 就是那個值
// 2. 專案清單依可見度顯示按鈕：開放＝「加入」（按了直接成為專案成員）、審核＝「申請加入」；私人專案不列
// 權限規則由 project-visibility-test 驗，這裡只驗看得到、能操作。
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/project-visibility-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-visibility-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pvisui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 工作區管理員
  const lin = (await kit.call(null, '/api/join', 'POST', { name: '林新人', role: 'UX' })).body; // 還沒有專案
  const priv = (await kit.call(boss.token, '/api/projects', 'POST', { name: '機密專案' })).body.id;
  assert.equal((await kit.call(boss.token, `/api/projects/${priv}/visibility`, 'PUT', { visibility: 'private' })).status, 200);
  const visOf = async pj => (await kit.call(boss.token, '/api/projects')).body.items.find(p => p.id === pj)?.visibility;

  // 1. ⚙ 專案設定 › 專案可見度：三種可選，預設審核
  const b = await kit.browser(1280, 860);
  await b.login(boss.token, '/p/main/messages');
  await until(() => b.js("!!document.querySelector('[data-pset=\"預設專案\"]')"), 10000, '專案 ⚙');
  await b.js("(() => { const x = document.querySelector('[data-pset=\"預設專案\"]'); x.scrollIntoView(); x.click(); return true; })()");
  await until(() => b.js("!!document.querySelector('#pset-menu [data-pset-act=\"visibility\"]')"), 5000, '⚙ 選單有專案可見度');
  assert.match(await b.js("document.querySelector('#pset-menu [data-pset-act=\"visibility\"]').textContent"), /專案可見度\s*審核專案/, '選單小字寫目前的可見度');
  await b.js("document.querySelector('#pset-menu [data-pset-act=\"visibility\"]').click(); true");
  await until(() => b.js("!!document.querySelector('#vis-form')"), 5000, '可見度視窗');
  assert.equal(await b.js("[...document.querySelectorAll('#vis-form input[name=visibility]')].map(x => x.value).join(',')"), 'open,review,private', '三種可見度');
  assert.equal(await b.js("document.querySelector('#vis-form input:checked').value"), 'review', '目前是審核');
  assert.match(await b.js("document.querySelector('#vis-form').textContent"), /開放專案[\s\S]*審核專案[\s\S]*私人專案/);
  await b.js("document.querySelector('#vis-form input[value=open]').click(); document.querySelector('button[form=vis-form]').click(); true");
  await until(async () => (await visOf('預設專案')) === 'open', 8000, '存成開放');
  await until(() => b.js("!document.querySelector('#vis-form')"), 5000, '存了關視窗');
  console.log('✓ 專案設定可選三種可見度');

  // 2. 還沒有專案的人：開放＝加入、審核＝申請加入；私人不列
  const l = await kit.browser(375, 800);
  await l.login(lin.token, '/');
  await until(() => l.js("!!document.querySelector('.hub-joinable [data-join-now=\"預設專案\"]')"), 15000, '開放專案有「加入」');
  assert.equal(await l.js("document.querySelector('.hub-joinable [data-join-now=\"預設專案\"]').textContent"), '加入');
  assert.equal(await l.js("document.querySelector('.hub-joinable [data-join-open=\"第二專案\"]')?.textContent"), '申請加入', '審核專案是「申請加入」');
  assert.ok(!(await l.js("document.querySelector('.hub-joinable').textContent")).includes('機密專案'), '私人專案不列');
  assert.equal(await l.js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '375 不橫向捲動');
  await l.js("document.querySelector('.hub-joinable [data-join-now=\"預設專案\"]').click(); true");
  await until(async () => (await kit.call(lin.token, '/api/me')).body.projects.includes('預設專案'), 8000, '按加入就成為專案成員');
  await until(() => l.js("[...document.querySelectorAll('.toast, #toast')].some(t => /你已加入「預設專案」/.test(t.textContent))"), 8000, '提示已加入');
  // 申請加入專案視窗也一樣
  await l.js("document.querySelector('[data-join-open]')?.click(); true");
  await until(() => l.js("!!document.querySelector('#jl [data-jl-apply=\"第二專案\"]')"), 8000, '視窗裡審核專案是申請加入');
  assert.equal(await l.js("document.querySelector('#jl [data-jl-apply=\"第二專案\"]').textContent"), '申請加入');
  console.log('✓ 專案清單依可見度顯示加入／申請加入');

  console.log('project-visibility-ui-test：全部通過');
} catch (e) {
  console.error('project-visibility-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
