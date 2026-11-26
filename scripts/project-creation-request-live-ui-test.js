// 畫面測試（規格 #39「即時事件」「介面」）：審核人與申請人在對方操作後自動重新抓取（不用重新整理），
// 「要你處理」的待審數量在各種操作後都正確（用伺服器的待審總數，不是載入的筆數），審核清單可以載入更多。
//   審核人：成員送出 → 出現；超過一頁 → 數字是總數、可以載入更多；申請人撤回、另一位審核人拒絕、政策切走 → 數字跟著變
//   申請人：被拒絕、被系統取消 → 「我的建立專案申請」跟著變
// 本機暫存資料庫＋無頭 Chrome／Edge（本機版有即時通道）。用法：node scripts/project-creation-request-live-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { adminSession } from './test-admin.js';

if (!findBrowser()) { console.log('project-creation-request-live-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pcrlive');
try {
  const join = async (name, role = 'PG') => { const b = (await kit.call(null, '/api/join', 'POST', { name, role })).body; return { token: b.token, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 審核人（工作區管理員兼平台管理員）
  const ann = await join('安娜'); // 另一位審核人
  const mate = await join('陳大文'); // 申請人
  const bossAdm = (await adminSession(kit.call, boss.token)).token;
  assert.equal((await kit.call(bossAdm, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' })).status, 200);
  assert.equal((await kit.call(boss.token, `/api/participants/${mate.id}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  assert.equal((await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' })).status, 200);
  let n = 0;
  const submit = async name => { const r = await kit.call(mate.token, '/api/project-creation-requests', 'POST', { requestId: `live-${++n}`, name, reason: 'x' }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const { js, login } = await kit.browser(1280, 860);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
  const rows = () => js("document.querySelectorAll('.wpcr [data-pcr-rev-row]').length");
  const badge = () => js("(() => { const b = document.querySelector('.inbox-badge'); return b && !b.hidden ? b.textContent : '0'; })()");

  // ---------- 審核人：成員送出 → 即時出現 ----------
  await login(boss.token, '/cross/inbox');
  await until(() => js("!!document.querySelector('.work-head')"), 15000, '要你處理');
  assert.equal(await rows(), 0);
  const first = await submit('即時一');
  await until(async () => (await rows()) === 1, 10000, '成員送出後審核清單即時出現（不用重新整理）');
  assert.equal(await text('.wpcr .wcount'), '1');
  await until(async () => (await badge()) === '1', 5000, '收件匣徽章 1');

  // ---------- 超過一頁：數字是待審總數；載入更多 ----------
  for (let i = 0; i < 55; i++) await submit(`批次${i}`);
  await until(async () => (await text('.wpcr .wcount')) === '56', 15000, '待審總數 56');
  assert.equal(await rows(), 50, '一頁 50 份');
  assert.equal(await badge(), '56', '徽章是總數（不是載入的筆數）');
  assert.match(await text('.work-head .muted'), /56 件/, '「要你處理」的件數是總數');
  assert.ok(await js("!!document.querySelector('[data-pcr-rev-more]')"), '有「載入更多」');
  await click('[data-pcr-rev-more]');
  await until(async () => (await rows()) === 56, 8000, '載入更多後 56 份');
  assert.ok(!(await js("!!document.querySelector('[data-pcr-rev-more]')")), '全部載入了');
  assert.equal(await badge(), '56');
  // 總覽右欄的數字也是總數
  await login(boss.token, '/');
  await until(async () => (await text('.hub-todo .ht-head .ps-count')) === '56', 15000, '總覽「要你處理」56');
  await login(boss.token, '/cross/inbox');
  await until(async () => (await rows()) === 50, 15000, '重新進來：第一頁');

  // ---------- 申請人撤回、另一位審核人拒絕：數字即時變 ----------
  assert.equal((await kit.call(mate.token, `/api/project-creation-requests/${first.id}/withdraw`, 'POST')).status, 200);
  await until(async () => (await text('.wpcr .wcount')) === '55', 10000, '撤回後 55');
  await until(async () => (await badge()) === '55', 5000, '徽章 55');
  const list = (await kit.call(boss.token, '/api/project-creation-requests?scope=review&state=pending&limit=1')).body.items;
  assert.equal((await kit.call(ann.token, `/api/project-creation-requests/${list[0].id}/reject`, 'POST', { reason: '先不需要' })).status, 200);
  await until(async () => (await text('.wpcr .wcount')) === '54', 10000, '另一位審核人拒絕後 54');
  const next = (await kit.call(boss.token, '/api/project-creation-requests?scope=review&state=pending&limit=1')).body.items[0];
  const approved = (await kit.call(ann.token, `/api/project-creation-requests/${next.id}/approve`, 'POST', {})).body;
  assert.ok(approved.project?.id, JSON.stringify(approved));
  await until(async () => (await text('.wpcr .wcount')) === '53', 10000, '另一位審核人核准後 53');

  // ---------- 申請人：被拒絕、被系統取消即時看到 ----------
  await login(mate.token, '/');
  await until(() => js("document.querySelectorAll('.pcr-mine .pcr-row').length === 50"), 15000, '申請人的清單');
  const mine = (await kit.call(mate.token, '/api/project-creation-requests?scope=mine&state=pending&limit=1')).body.items[0];
  assert.equal((await kit.call(boss.token, `/api/project-creation-requests/${mine.id}/reject`, 'POST', { reason: '名稱再想想' })).status, 200);
  await until(async () => /已拒絕[\s\S]*名稱再想想/.test(await text(`.pcr-row[data-pcr="${mine.id}"]`)), 10000, '申請人即時看到已拒絕與理由');
  assert.equal((await kit.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' })).status, 200, '政策切走');
  await until(async () => !(await js("[...document.querySelectorAll('.pcr-mine .pcr-row')].some(r => /待審核/.test(r.textContent))")), 10000, '申請人即時看到待審的都已取消');
  assert.match(await text('.pcr-mine'), /已取消[\s\S]*工作區政策已改變/);

  // ---------- 審核人：政策切走後沒有待審的 ----------
  await login(boss.token, '/cross/inbox');
  await until(() => js("!!document.querySelector('.work-head')"), 15000, '要你處理');
  assert.ok(!(await js("!!document.querySelector('.wpcr')")), '沒有待審的建立專案申請');
  assert.equal(await badge(), '0');
  console.log('project-creation-request-live-ui-test：全部通過');
} finally {
  await kit.stop();
}
