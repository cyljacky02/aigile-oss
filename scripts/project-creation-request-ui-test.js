// 畫面測試（#44）：「成員申請，管理員核准」時，一般成員所有建立專案的入口都是「申請建立專案」；
// 申請表單（申請原因必填、可見度、沒有程式庫欄位、說明核准後成為專案管理員、送出中停用按鈕、重試沿用同一個 requestId）；
// 總覽專案列表上方的「我的建立專案申請」（狀態、撤回、載入更多）；管理員照樣是「新增專案」；375 寬不橫向捲動；英文介面
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/project-creation-request-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-creation-request-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pcrui', { env: { AIGILE_UNRELEASED_PROJECT_CREATION_REQUESTS: '1' } }); // 暫時的啟用控制（#48 移除）
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 工作區管理員
  const mate = (await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const mateId = mate.participant.participantId;
  await kit.call(boss.token, `/api/participants/${mateId}/projects`, 'PUT', { projects: ['預設專案'] });
  assert.equal((await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' })).status, 200, '政策設成 approval');
  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() || ''`);
  const mine = async () => (await kit.call(mate.token, '/api/project-creation-requests?scope=mine&limit=100')).body.items;
  await size(1280, 860);

  // ---------- 入口：總覽側欄、總覽、手機選單、專案切換器都寫「申請建立專案」 ----------
  await login(mate.token, '/');
  await until(() => js("!!document.querySelector('.hub-side [data-hub-newproj]')"), 10000, '總覽側欄的入口');
  assert.equal(await text('.hub-side [data-hub-newproj] .hs-name'), '申請建立專案', '總覽側欄');
  await until(() => js("!!document.querySelector('.hub-join[data-hub-newproj]')"), 10000, '總覽的入口'); // 總覽右邊的卡片區可能比側欄晚一點畫好（負載高時）
  assert.equal(await text('.hub-join[data-hub-newproj]'), '＋ 申請建立專案', '總覽');
  assert.equal(await js("document.querySelector('#m-newproj').hidden"), false, '手機選單有入口');
  assert.equal(await text('#m-newproj .m-newproj-t'), '申請建立專案', '手機選單');
  assert.ok(!(await js("[...document.querySelectorAll('[data-hub-newproj], [data-ps-act=\"newproj\"]')].some(e => /新增專案/.test(e.textContent))")), '沒有任何「新增專案」入口');
  // 我的建立專案申請：還沒有申請，但能申請 → 顯示
  await until(() => js("!!document.querySelector('.pcr-mine')"), 10000, '我的建立專案申請');
  assert.match(await text('.pcr-mine h3'), /我的建立專案申請/);
  assert.ok(await js("(() => { const s = document.querySelector('.pcr-mine'), g = document.querySelector('.hub-grid'); return !!(s.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING); })()"), '在專案列表上方');
  // 專案切換器
  await click('.hub-side [data-proj="預設專案"]');
  await until(() => js("!!document.querySelector('.ps-act[data-ps-act=\"newproj\"]')"), 10000, '專案切換器的入口');
  assert.equal(await text('.ps-act[data-ps-act="newproj"]'), '＋ 申請建立專案', '專案切換器');
  await click('.ph-back[data-proj="hub"]');
  await until(() => js("!!document.querySelector('.hub')"), 10000, '回總覽');

  // ---------- 申請表單 ----------
  // 攔住送出申請的請求：記下內容；可以讓下一次「網路中斷」或延遲
  await js(`(() => { window.__pcr = { bodies: [], fail: false, delay: 0 }; const of = window.fetch;
    window.fetch = async (u, o) => { if (String(u).startsWith('/api/project-creation-requests') && o?.method === 'POST' && !String(u).includes('/withdraw')) {
      window.__pcr.bodies.push(JSON.parse(o.body)); if (window.__pcr.fail) { window.__pcr.fail = false; throw new TypeError('Failed to fetch'); }
      if (window.__pcr.delay) await new Promise(r => setTimeout(r, window.__pcr.delay)); } return of(u, o); }; return true; })()`);
  await click('.hub-join[data-hub-newproj]');
  await until(() => js("!!document.querySelector('#np-form')"), 8000, '申請表單');
  assert.match(await text('.modal .modal-title, .modal h2, .modal-head'), /申請建立專案/, '標題');
  assert.ok(await js("!!document.querySelector('#np-form textarea[name=\"reason\"][required]')"), '申請原因必填');
  assert.deepEqual(await js("[...document.querySelectorAll('#np-form [name=\"visibility\"]')].map(i => i.value)"), ['open', 'review', 'private'], '可見度');
  assert.ok(!(await js("!!document.querySelector('#np-form [name=\"url\"], #np-form [name=\"branch\"]')")), '沒有程式庫欄位');
  assert.equal(await text('#np-submit'), '送出申請', '送出按鈕');
  assert.match(await text('#pm-new-hint'), /核准[\s\S]*你會成為這個專案的專案管理員/, '說明核准後成為專案管理員');
  const fill = (name, reason) => js(`(() => { const f = document.querySelector('#np-form'); f.name.value = ${JSON.stringify(name)}; f.name.dispatchEvent(new Event('input', { bubbles: true })); f.reason.value = ${JSON.stringify(reason)}; return true; })()`);
  // 沒寫原因：不送
  await fill('行動版', '');
  assert.equal(await js("document.querySelector('#np-form').checkValidity()"), false, '瀏覽器擋下沒寫原因');
  await js("document.querySelector('#np-form').dispatchEvent(new Event('submit', { cancelable: true })); true"); // 繞過瀏覽器的檢查，程式自己也擋
  await until(async () => /申請原因/.test(await text('#np-err')), 5000, '要寫原因');
  assert.equal(await js('window.__pcr.bodies.length'), 0, '沒有送出');
  // 網路中斷：顯示可以重按；重按沿用同一個 requestId，伺服器只有一份
  await fill('行動版', '要做手機 app');
  await click('#np-form [name="visibility"][value="private"]');
  await js('window.__pcr.fail = true; document.querySelector("#np-form").requestSubmit(); true');
  await until(async () => /連線中斷/.test(await text('#np-err')), 5000, '連線中斷的說明');
  assert.equal(await js("document.querySelector('#np-submit').disabled"), false, '失敗後按鈕可以再按');
  // 送出中停用按鈕：連按兩下只送一次
  await js('window.__pcr.delay = 600; const f = document.querySelector("#np-form"); f.requestSubmit(); f.requestSubmit(); true');
  assert.equal(await js("document.querySelector('#np-submit')?.disabled"), true, '送出中停用按鈕');
  await until(() => js("!document.querySelector('#np-form')"), 8000, '送出後關掉表單');
  const bodies = await js('window.__pcr.bodies');
  assert.equal(bodies.length, 2, '中斷那次＋重按那次（連按的第二下沒送）：' + JSON.stringify(bodies));
  assert.equal(bodies[0].requestId, bodies[1].requestId, '重試沿用同一個 requestId');
  assert.equal(bodies[1].visibility, 'private');
  assert.equal(bodies[1].reason, '要做手機 app');
  assert.ok(!('url' in bodies[1]) && !('branch' in bodies[1]), '不送程式庫');
  let list = await mine();
  assert.equal(list.length, 1, '伺服器只有一份申請');
  assert.equal(list[0].state, 'pending');
  // 再開一次表單＝新的一份申請（新的 requestId）
  await js('window.__pcr.delay = 0; true');
  await click('.hub-join[data-hub-newproj]');
  await until(() => js("!!document.querySelector('#np-form')"), 8000, '再開申請表單');
  await fill('資料平台', '整合報表');
  await js("document.querySelector('#np-form').requestSubmit(); true");
  await until(() => js("!document.querySelector('#np-form')"), 8000, '送出第二份');
  const all = await js('window.__pcr.bodies');
  assert.notEqual(all[2].requestId, all[0].requestId, '新的申請用新的 requestId');

  // ---------- 我的建立專案申請：狀態、撤回 ----------
  await until(() => js("document.querySelectorAll('.pcr-mine .pcr-row').length === 2"), 8000, '兩份申請');
  assert.match(await text('.pcr-mine'), /行動版[\s\S]*待審核|待審核[\s\S]*行動版/, '名稱與狀態');
  const firstId = list[0].id;
  await click(`[data-pcr-withdraw="${firstId}"]`);
  await until(async () => (await text(`[data-pcr-withdraw="${firstId}"]`)) === '確定撤回？', 5000, '先確認');
  await click(`[data-pcr-withdraw="${firstId}"]`);
  await until(async () => /已撤回/.test(await text(`.pcr-row[data-pcr="${firstId}"]`)), 8000, '撤回後顯示已撤回');
  assert.ok(!(await js(`!!document.querySelector('[data-pcr-withdraw="${firstId}"]')`)), '已撤回的沒有撤回按鈕');
  list = await mine();
  assert.equal(list.find(x => x.id === firstId).state, 'withdrawn');

  // ---------- 載入更多（一頁 50 份） ----------
  for (let i = 0; i < 50; i++) {
    const r = await kit.call(mate.token, '/api/project-creation-requests', 'POST', { requestId: `bulk-${i}`, name: `批次${i}`, reason: 'x' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  await login(mate.token, '/');
  await until(() => js("document.querySelectorAll('.pcr-mine .pcr-row').length === 50 && !!document.querySelector('[data-pcr-more]')"), 10000, '第一頁 50 份＋載入更多');
  await click('[data-pcr-more]');
  await until(() => js("document.querySelectorAll('.pcr-mine .pcr-row').length === 52 && !document.querySelector('[data-pcr-more]')"), 8000, '載入更多後全部 52 份');

  // ---------- 375：總覽與申請表單不橫向捲動 ----------
  await size(375, 812);
  await login(mate.token, '/');
  await until(() => js("!!document.querySelector('.pcr-mine')"), 10000, '手機總覽');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 總覽不橫向捲動');
  await click('.hub-join[data-hub-newproj]');
  await until(() => js("!!document.querySelector('#np-form textarea[name=\"reason\"]')"), 8000, '手機申請表單');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 申請表單不橫向捲動');
  await size(1280, 860);

  // ---------- 管理員：同樣的政策下照樣「新增專案」 ----------
  await login(boss.token, '/');
  await until(() => js("!!document.querySelector('.hub-side [data-hub-newproj]')"), 10000, '管理員的入口');
  assert.equal(await text('.hub-side [data-hub-newproj] .hs-name'), '新增專案', '管理員直接建立');
  assert.ok(!(await js("!!document.querySelector('.pcr-mine')")), '管理員沒有申請紀錄、也不能申請：不顯示我的建立專案申請');

  // ---------- 英文介面 ----------
  await login(mate.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); location.reload(); true");
  await until(() => js("document.querySelector('.pcr-mine h3')?.textContent === 'My project requests'"), 15000, '英文：我的建立專案申請');
  assert.equal(await text('.hub-side [data-hub-newproj] .hs-name'), 'Request a project', '英文入口');
  console.log('project-creation-request-ui-test：全部通過');
} finally {
  await kit.stop();
}
