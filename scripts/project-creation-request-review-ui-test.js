// 畫面測試：審核人在「要你處理」處理建立專案申請，申請人看到結果
// - 「要你處理」有「建立專案申請」一類（待審總數）；總覽右欄也列出
// - 審核視窗：完整內容、自動識別碼的預估值（標明預估）、衝突提示；「核准並建立」、「拒絕」（理由必填）
// - 另一位審核人已先處理、名稱衝突、審核權失效（清掉已載入的審核資料）
// - 申請人：「我的建立專案申請」即時看到已核准（新專案出現、可以進入）與拒絕理由
// - 375 寬不橫向捲動；英文介面
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/project-creation-request-review-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { adminSession } from './test-admin.js';

if (!findBrowser()) { console.log('project-creation-request-review-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pcrrevui');
try {
  const join = async (name, role = 'PG') => { const b = (await kit.call(null, '/api/join', 'POST', { name, role })).body; return { token: b.token, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 工作區管理員兼平台管理員
  const ann = await join('安娜'); // 之後被降級的工作區管理員
  const mate = await join('陳大文'); // 申請人
  const bossAdm = (await adminSession(kit.call, boss.token)).token;
  assert.equal((await kit.call(bossAdm, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '安娜升為工作區管理員');
  assert.equal((await kit.call(boss.token, `/api/participants/${mate.id}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  assert.equal((await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' })).status, 200, '政策設成 approval');
  let n = 0;
  const submit = async (name, extra = {}) => { const r = await kit.call(mate.token, '/api/project-creation-requests', 'POST', { requestId: `ui-${++n}`, name, reason: `${name} 的原因`, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const reqState = async id => (await kit.call(boss.token, `/api/project-creation-requests/${id}`)).body;
  const alpha = await submit('Alpha', { code: 'ALP', visibility: 'private' });
  const beta = await submit('Beta');
  const gamma = await submit('Gamma');

  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
  await size(1280, 860);

  // ---------- 「要你處理」：建立專案申請一類、待審總數；總覽右欄 ----------
  await login(boss.token, '/');
  await until(() => js(`!!document.querySelector('.hub-todo [data-hub-todo="r:${alpha.id}"]')`), 10000, '總覽右欄列出建立專案申請');
  assert.match(await text(`.hub-todo [data-hub-todo="r:${alpha.id}"]`), /建立專案[\s\S]*陳大文 申請建立「Alpha」/, '總覽右欄的一項');
  // 分組：建立專案申請是工作區層的事，放在「工作區」下，不是「跨專案頻道」
  const groupOf = id => js(`(() => { let e = document.querySelector('.hub-todo [data-hub-todo="r:${id}"]'); while (e && !e.classList.contains('ht-group')) e = e.previousElementSibling; return e?.textContent.trim() || ''; })()`);
  assert.equal(await groupOf(alpha.id), '工作區', '建立專案申請分在「工作區」');
  assert.equal(await text('.hub-todo .ht-head .ps-count'), '3', '「要你處理」的數字＝3 份待審');
  await login(boss.token, '/p/main/inbox');
  await until(() => js("!!document.querySelector('.work-head') && document.title.startsWith('(3)')"), 10000, '專案內的「要你處理」已載入');
  assert.equal(await js("!!document.querySelector('.wpcr')"), false, '工作區的申請不出現在專案內');
  await login(boss.token, '/cross/inbox');
  await until(() => js("!!document.querySelector('.wpcr')"), 10000, '「要你處理」的建立專案申請');
  assert.equal(await text('.wpcr .wsugg-head h3'), '建立專案申請');
  assert.equal(await text('.wpcr .wcount'), '3', '待審總數');
  assert.equal(await js("document.querySelectorAll('.wpcr [data-pcr-rev-row]').length"), 3);
  assert.match(await text(`[data-pcr-rev-row="${alpha.id}"]`), /Alpha.*工作區 · 陳大文.*Alpha 的原因/, '列出工作區範圍與申請摘要');

  // ---------- 審核視窗：內容、預估值、核准並建立 ----------
  await click(`[data-pcr-review="${alpha.id}"]`);
  await until(() => js("!!document.querySelector('#pcr-rv .pcr-dl')"), 8000, '審核視窗');
  const box = await text('#pcr-rv');
  assert.match(box, /Alpha/);
  assert.match(box, /Alpha 的原因/, '申請原因');
  assert.match(box, /陳大文/, '申請人');
  assert.match(box, /私人專案/, '可見度');
  assert.match(box, /ALP/, '指定的代號');
  assert.ok(await js("[...document.querySelectorAll('#pcr-rv .pcr-f')].find(f => /網址英文名/.test(f.textContent))?.textContent.includes('預估')"), '自動網址英文名標明預估');
  assert.ok(!(await js("[...document.querySelectorAll('#pcr-rv .pcr-f')].find(f => /專案代號/.test(f.textContent))?.textContent.includes('預估')")), '指定的代號不是預估');
  assert.match(box, /預設狀態/, '看板狀態');
  await click('#pcr-rv [data-pcr-ok]');
  await until(() => js("!document.querySelector('#pcr-rv')"), 8000, '核准後關掉視窗');
  assert.match(await text('#toast'), /已核准，已建立專案「Alpha」/);
  assert.equal((await reqState(alpha.id)).state, 'approved');
  await until(async () => (await text('.wpcr .wcount')) === '2', 8000, '待審總數變 2');

  // ---------- 另一位審核人已先處理 ----------
  await click(`[data-pcr-review="${beta.id}"]`);
  await until(() => js("!!document.querySelector('#pcr-rv [data-pcr-ok]')"), 8000, 'Beta 的審核視窗');
  assert.equal((await kit.call(ann.token, `/api/project-creation-requests/${beta.id}/reject`, 'POST', { reason: '安娜先拒絕了' })).status, 200, '安娜先拒絕');
  await click('#pcr-rv [data-pcr-ok]');
  await until(async () => /另一位審核人已經處理了這份申請/.test(await text('#pcr-rv-msg')), 8000, '另一位審核人已先處理');
  await until(async () => /已拒絕/.test(await text('#pcr-rv .pcr-done')), 8000, '顯示目前的狀態');
  assert.ok(!(await js("!!document.querySelector('#pcr-rv [data-pcr-ok]')")), '不能再核准');
  await js("document.querySelector('.modal [data-close]')?.click(); true");
  await until(() => js("!document.querySelector('#pcr-rv')"), 5000, '關掉視窗');

  // ---------- 衝突提示與核准失敗；拒絕（理由必填） ----------
  assert.equal((await kit.call(boss.token, '/api/projects', 'POST', { name: 'Gamma' })).status, 201, '先有一個同名專案');
  await click(`[data-pcr-review="${gamma.id}"]`);
  await until(() => js("!!document.querySelector('#pcr-rv .pcr-warn')"), 8000, '衝突提示');
  assert.ok(await js("[...document.querySelectorAll('#pcr-rv .pcr-f')].find(f => /專案名稱/.test(f.textContent))?.textContent.includes('已有專案在用')"), '名稱欄位標示衝突');
  await click('#pcr-rv [data-pcr-ok]');
  await until(async () => /已有同名的專案/.test(await text('#pcr-rv-msg')), 8000, '核准失敗的原因');
  assert.equal((await reqState(gamma.id)).state, 'pending', '申請維持待審核');
  await click('#pcr-rv [data-pcr-rej]');
  await until(() => js("!!document.querySelector('#pcr-rej')"), 5000, '拒絕理由欄');
  await click('#pcr-rv [data-pcr-rej-go]');
  await until(async () => /請寫拒絕理由/.test(await text('#pcr-rv-msg')), 5000, '理由必填');
  assert.equal((await reqState(gamma.id)).state, 'pending', '沒寫理由不送出');
  await js("document.querySelector('#pcr-rej').value = '名稱跟現有專案重複，請改名再申請'; true");
  await click('#pcr-rv [data-pcr-rej-go]');
  await until(() => js("!document.querySelector('#pcr-rv')"), 8000, '拒絕後關掉視窗');
  const g = await reqState(gamma.id);
  assert.deepEqual([g.state, g.rejectReason], ['rejected', '名稱跟現有專案重複，請改名再申請']);
  await until(() => js("!document.querySelector('.wpcr')"), 8000, '沒有待審的了：這一類不顯示');

  // ---------- 稽核紀錄：核准建立與拒絕都有紀錄 ----------
  await login(boss.token, '/admin/auditlog');
  await until(() => js("/拒絕建立專案申請/.test(document.querySelector('.alog-table')?.innerText || '')"), 15000, '稽核紀錄有拒絕');
  const alog = await js("document.querySelector('.alog-table').innerText");
  assert.match(alog, /拒絕建立專案申請[\s\S]*申請人 陳大文/, '拒絕的紀錄與申請人');
  assert.match(alog, /核准申請後建立/, '核准建立的 project.create');

  // ---------- 審核權失效：清掉已載入的審核資料 ----------
  const delta = await submit('Delta');
  await login(ann.token, '/cross/inbox');
  await until(() => js(`!!document.querySelector('[data-pcr-review="${delta.id}"]')`), 10000, '安娜看到 Delta');
  await click(`[data-pcr-review="${delta.id}"]`);
  await until(() => js("!!document.querySelector('#pcr-rv [data-pcr-ok]')"), 8000, '安娜的審核視窗');
  assert.equal((await kit.call(bossAdm, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'member' })).status, 200, '安娜被降級');
  await click('#pcr-rv [data-pcr-ok]');
  await until(() => js("!document.querySelector('#pcr-rv') && !document.querySelector('.wpcr')"), 8000, '視窗關掉、審核清單清掉');
  assert.match(await text('#toast'), /你已經沒有審核這份申請的權限/);
  assert.equal((await reqState(delta.id)).state, 'pending');

  // ---------- 申請人：即時看到核准結果、進入新專案；拒絕理由 ----------
  await login(mate.token, '/');
  await until(() => js("document.querySelectorAll('.pcr-mine .pcr-row').length === 4"), 10000, '我的建立專案申請');
  assert.match(await text(`.pcr-row[data-pcr="${alpha.id}"]`), /已核准[\s\S]*進入專案/, '已核准、可以進入專案');
  assert.match(await text(`.pcr-row[data-pcr="${gamma.id}"]`), /已拒絕[\s\S]*名稱跟現有專案重複，請改名再申請/, '拒絕理由');
  assert.match(await text(`.pcr-row[data-pcr="${beta.id}"]`), /已拒絕[\s\S]*安娜先拒絕了/);
  const approved = (await kit.call(boss.token, `/api/project-creation-requests/${delta.id}/approve`, 'POST', {})).body; // 申請人開著畫面時核准
  assert.ok(approved.project?.id, JSON.stringify(approved));
  await until(async () => /已核准/.test(await text(`.pcr-row[data-pcr="${delta.id}"]`)), 10000, '即時看到已核准（不用重新整理）');
  await until(() => js(`!!document.querySelector('.hub-side [data-proj="${approved.project.id}"]')`), 10000, '新專案出現在側欄');
  await click(`.pcr-row[data-pcr="${alpha.id}"] [data-proj]`);
  await until(() => js("location.pathname.startsWith('/p/')"), 8000, '進入專案');

  // ---------- 375：審核視窗不橫向捲動 ----------
  const eps = await submit('Epsilon', { slug: 'epsilon-long-name', code: 'EPS' });
  await size(375, 812);
  await login(boss.token, '/cross/inbox');
  await until(() => js(`!!document.querySelector('[data-pcr-review="${eps.id}"]')`), 10000, '手機的建立專案申請');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375「要你處理」不橫向捲動');
  await click(`[data-pcr-review="${eps.id}"]`);
  await until(() => js("!!document.querySelector('#pcr-rv [data-pcr-ok]')"), 8000, '手機的審核視窗');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 審核視窗不橫向捲動');
  await size(1280, 860);

  // ---------- 英文介面 ----------
  await js("localStorage.setItem('aigile-lang', 'en'); location.reload(); true");
  await until(() => js("document.querySelector('.wpcr .wsugg-head h3')?.textContent === 'Project creation requests'"), 15000, '英文：建立專案申請');
  await click(`[data-pcr-review="${eps.id}"]`);
  await until(async () => (await text('#pcr-rv [data-pcr-ok]')) === 'Approve and create', 8000, '英文：核准並建立');
  await js("document.querySelector('.modal [data-close]')?.click(); true");
  await login(boss.token, '/');
  await until(() => js(`!!document.querySelector('.hub-todo [data-hub-todo="r:${eps.id}"]')`), 15000, '英文：總覽右欄');
  await until(async () => (await groupOf(eps.id)) === 'Workspace', 8000, '英文：建立專案申請分在 Workspace（不是 Cross-project channel）');
  console.log('project-creation-request-review-ui-test：全部通過');
} finally {
  await kit.stop();
}
