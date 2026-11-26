// 畫面測試：工作區設定的「誰可以建立專案」三個單選項（正式環境都能選）；
// 從「成員申請」切走時跳確認視窗、顯示預估會取消幾份待審申請，取消就不改；確認後顯示實際取消數（預覽之後又多了申請時以實際為準）；
// 申請人的「我的建立專案申請」顯示已取消與原因、帳號提醒有一則通知；375 寬不橫向捲動；英文介面
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/project-creation-policy-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-creation-policy-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pcpolui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 工作區管理員
  const mate = (await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const mateId = mate.participant.participantId;
  await kit.call(boss.token, `/api/participants/${mateId}/projects`, 'PUT', { projects: ['預設專案'] });
  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() || ''`);
  const checked = () => js("document.querySelector('[data-pp=\"createprojects\"]:checked')?.value || ''");
  const policy = async () => (await kit.call(boss.token, '/api/workspace/settings')).body.createProjects;
  let n = 0;
  const submit = name => kit.call(mate.token, '/api/project-creation-requests', 'POST', { requestId: `ui-${++n}`, name, reason: '要做新功能' }).then(r => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; });
  await size(1280, 860);

  // ---------- 三個單選項；切到「成員申請」不用確認 ----------
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('.pm-create-proj [data-pp=\"createprojects\"]')"), 10000, '誰可以建立專案');
  assert.deepEqual(await js("[...document.querySelectorAll('[data-pp=\"createprojects\"]')].map(i => i.value)"), ['members', 'approval', 'admins'], '三個單選項');
  assert.match(await text('.pm-create-proj'), /所有成員[\s\S]*成員申請，管理員核准[\s\S]*只有工作區管理員/);
  await click('[data-pp="createprojects"][value="approval"]');
  await until(async () => (await policy()) === 'approval', 8000, '存成成員申請');
  assert.ok(!(await js("!!document.querySelector('.confirm-root')")), '切到成員申請不用確認');
  await until(async () => (await checked()) === 'approval', 8000, '畫面停在成員申請');

  // ---------- 切走：確認視窗顯示預估數量；取消就不改 ----------
  const first = await submit('行動版');
  await submit('資料平台');
  await click('[data-pp="createprojects"][value="admins"]');
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 8000, '確認視窗');
  assert.match(await text('.confirm-root .confirm-msg'), /2 份待審核的建立專案申請/, '預估數量：' + await text('.confirm-root .confirm-msg'));
  await click('.confirm-root [data-close]:not(.modal-x)');
  await until(() => js("!document.querySelector('.confirm-root')"), 5000, '確認視窗關了');
  await until(async () => (await checked()) === 'approval', 5000, '取消：畫面回到成員申請');
  assert.equal(await policy(), 'approval', '取消：政策沒改');

  // ---------- 確認：儲存後顯示實際取消數（預覽之後又多一份：以實際為準） ----------
  await click('[data-pp="createprojects"][value="members"]');
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 8000, '確認視窗');
  assert.match(await text('.confirm-root .confirm-msg'), /2 份/);
  await submit('又一份'); // 預覽之後、確認之前
  await click('.confirm-root [data-ok]');
  await until(async () => /已取消 3 份待審核的建立專案申請/.test(await text('#toast')), 8000, '顯示實際取消數：' + await text('#toast'));
  assert.equal(await policy(), 'members');
  await until(async () => (await checked()) === 'members', 5000, '畫面停在所有成員');
  await until(() => js("/成員申請，管理員核准 → 所有成員|設定誰可以建立專案：所有成員/.test(document.querySelector('.pm-gs-log')?.textContent || '')"), 8000, '異動紀錄');

  // 沒有待審申請時切走：照樣確認（0 份），儲存後說沒有取消
  await click('[data-pp="createprojects"][value="approval"]');
  await until(async () => (await policy()) === 'approval', 8000, '再存成成員申請');
  await until(async () => (await checked()) === 'approval', 8000, '畫面停在成員申請');
  await click('[data-pp="createprojects"][value="admins"]');
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 8000, '確認視窗（0 份）');
  assert.match(await text('.confirm-root .confirm-msg'), /目前沒有待審核的建立專案申請/);
  await click('.confirm-root [data-ok]');
  await until(async () => (await policy()) === 'admins', 8000, '存成只有管理員');

  // ---------- 申請人：我的建立專案申請顯示已取消與原因；帳號提醒有一則 ----------
  await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' });
  await login(mate.token, '/');
  await until(() => js(`/已取消/.test(document.querySelector('.pcr-row[data-pcr="${first.id}"]')?.textContent || '')`), 10000, '我的建立專案申請：已取消');
  assert.match(await text(`.pcr-row[data-pcr="${first.id}"]`), /工作區政策已改變/, '取消原因');
  assert.ok(!(await js(`!!document.querySelector('[data-pcr-withdraw="${first.id}"]')`)), '已取消的不能撤回');
  await login(mate.token, '/p/main/inbox'); // 帳號提醒在「要你處理」的「給你知道」
  await until(() => js("[...document.querySelectorAll('.sec-note')].some(e => /建立專案申請已取消/.test(e.textContent))"), 10000, '帳號提醒');
  assert.match(await js("[...document.querySelectorAll('.sec-note')].find(e => /建立專案申請已取消/.test(e.textContent)).textContent"), /工作區政策已改變/);

  // ---------- 375：三個單選項與確認視窗不橫向捲動 ----------
  await size(375, 812);
  await submit('手機版');
  await login(boss.token, '/admin/group');
  await until(() => js("!!document.querySelector('[data-pp=\"createprojects\"][value=\"approval\"]:checked')"), 10000, '手機工作區設定');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 設定頁不橫向捲動');
  await click('[data-pp="createprojects"][value="admins"]');
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 8000, '手機確認視窗');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 確認視窗不橫向捲動');
  await click('.confirm-root [data-close]:not(.modal-x)');
  await until(() => js("!document.querySelector('.confirm-root')"), 5000, '確認視窗關了');
  await size(1280, 860);

  // ---------- 英文介面 ----------
  await js("localStorage.setItem('aigile-lang', 'en'); location.reload(); true");
  await until(() => js("/Members request, admins approve/.test(document.querySelector('.pm-create-proj')?.textContent || '')"), 15000, '英文：成員申請');
  await click('[data-pp="createprojects"][value="admins"]');
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 8000, '英文確認視窗');
  assert.match(await text('.confirm-root .confirm-msg'), /1 pending project creation request/, '英文預估數量：' + await text('.confirm-root .confirm-msg'));
  await click('.confirm-root [data-ok]');
  await until(async () => /Cancelled 1 pending project creation request/.test(await text('#toast')), 8000, '英文實際取消數：' + await text('#toast'));
  console.log('project-creation-policy-ui-test：全部通過');
} catch (e) {
  console.error('project-creation-policy-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
