// 畫面測試：稽核紀錄頁（管理員設定 › 工作區稽核紀錄、平台稽核紀錄）
// A. 平台管理員：左側有兩頁；平台稽核紀錄列出平台層與工作區的事件（時間、操作者、動作、範圍、對象、細節）
// B. 篩選動作只剩那種；清除篩選回到全部；超過一頁有「載入更多」，按了接著列舊的
// C. 工作區管理員（不是平台管理員）：只有工作區稽核紀錄，看不到平台層事件；打平台稽核紀錄的網址退回待處理
// D. 375 不橫向捲動；英文介面的目錄與動作是英文
// 權限規則由 audit-log-test 驗，這裡只驗看得到、能操作。本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/audit-log-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';
import { adminSession } from './test-admin.js';

if (!findBrowser()) { console.log('audit-log-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('auditlogui');
try {
  const { call } = kit;
  const bossJ = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const boss = await adminSession(call, bossJ.token);
  const lin = (await call(null, '/api/join', 'POST', { name: '林工作', role: 'SM' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const LIN = lin.participant.participantId, CHEN = chen.participant.participantId;
  const okCall = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]}：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };
  await okCall(boss.token, `/api/participants/${CHEN}/disable`, 'POST');
  await okCall(boss.token, `/api/participants/${CHEN}/enable`, 'POST');
  // 超過一頁（50 筆）：升降工作區管理員來回幾次
  for (let i = 0; i < 52; i++) await okCall(boss.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: i % 2 ? 'member' : 'admin' });
  await okCall(boss.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: 'admin' }); // 最後是工作區管理員（共 53 筆）
  await okCall(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' });
  const total = (await call(boss.token, '/api/audit-log?limit=200')).body.items.length;
  assert.ok(total > 50, '事件超過一頁：' + total);

  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const J = async expr => JSON.parse(await js(`JSON.stringify(${expr})`));
  const nav = () => J("[...document.querySelectorAll('.adm-nav [data-adm]')].map(b => b.dataset.adm)");
  const rows = () => J("[...document.querySelectorAll('.alog-table tbody tr')].map(r => [...r.cells].map(c => c.innerText.trim()))");
  const setF = (k, v) => js(`(() => { const s = document.querySelector('[data-alog-f="${k}"]'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await size(1280, 860);

  // ---- A 平台管理員 ----
  await login(bossJ.token, '/admin/platlog');
  await until(() => js("document.querySelectorAll('.alog-table tbody tr').length >= 50"), 15000, '平台稽核紀錄');
  const n = await nav();
  assert.ok(n.includes('auditlog') && n.includes('platlog'), 'A 左側有兩頁稽核紀錄：' + n);
  let rs = await rows();
  assert.equal(rs.length, 50, 'A 一次 50 筆');
  assert.deepEqual(rs[0].slice(1, 5), ['林志明', '修改工作區政策', '工作區', ''], 'A 最新一筆：' + JSON.stringify(rs[0]));
  assert.match(rs[0][5], /誰可以建立專案：所有成員 → 只有工作區管理員/, 'A 細節');
  // ---- B 載入更多、篩選 ----
  await js("document.querySelector('[data-alog=\"more\"]').click(); true");
  await until(async () => (await rows()).length === total, 10000, 'B 載入更多');
  assert.ok(await js("!document.querySelector('[data-alog=\"more\"]')"), 'B 全部列完就沒有「載入更多」');
  assert.ok((await rows()).some(r => r[2] === '停用帳號' && r[3] === '平台' && r[4] === '陳大文'), 'B 平台層事件在平台稽核紀錄');
  await setF('action', 'account.disable');
  await until(async () => { const r = await rows(); return r.length === 1 && r[0][2] === '停用帳號'; }, 10000, 'B 篩選動作');
  await until(() => js("!!document.querySelector('[data-alog=\"clear\"]')"), 5000, '清除篩選');
  await js("document.querySelector('[data-alog=\"clear\"]').click(); true");
  await until(async () => (await rows()).length === 50, 10000, 'B 清除篩選回到全部');
  const today = await js("(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()");
  await setF('to', '2000-01-01');
  await until(() => js("/沒有符合的紀錄/.test(document.querySelector('.adm-alog').innerText)"), 10000, 'B 日期篩選：很久以前沒有紀錄');
  await setF('to', today);
  await until(async () => (await rows()).length === 50, 10000, 'B 結束日期含今天');
  console.log('✓ 平台管理員看得到全平台稽核紀錄，能篩選、翻頁');

  // ---- C 工作區管理員 ----
  await login(lin.token, '/admin/auditlog');
  await until(() => js("document.querySelectorAll('.alog-table tbody tr').length > 0"), 15000, '工作區稽核紀錄');
  const ln = await nav();
  assert.ok(ln.includes('auditlog') && !ln.includes('platlog'), 'C 工作區管理員只有工作區稽核紀錄：' + ln);
  await js("document.querySelector('[data-alog=\"more\"]')?.click(); true");
  await until(async () => (await rows()).length === total - 2, 10000, 'C 工作區的事件都列得出來（少了停用、恢復）');
  assert.ok((await rows()).every(r => r[3] !== '平台'), 'C 看不到平台層事件');
  assert.ok(!(await J("[...document.querySelectorAll('[data-alog-f=\"action\"] option')].map(o => o.value)")).includes('account.disable'), 'C 動作篩選不列平台層動作');
  await login(lin.token, '/admin/platlog');
  await until(() => js("!!document.querySelector('.adm-main h3')"), 10000, '打平台稽核紀錄的網址');
  assert.match(await js("document.querySelector('.adm-main h3').innerText"), /待處理/, 'C 退回待處理');
  console.log('✓ 工作區管理員只看得到工作區的稽核紀錄');

  // ---- D 375、英文 ----
  await size(375, 812);
  await login(bossJ.token, '/admin/platlog');
  await until(() => js("document.querySelectorAll('.alog-table tbody tr').length > 0"), 15000, '手機平台稽核紀錄');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), 'D 375 沒有橫向捲動');
  await size(1280, 860);
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(bossJ.token, '/admin/platlog');
  await until(() => js("document.documentElement.lang === 'en' && document.querySelectorAll('.alog-table tbody tr').length > 0"), 15000, '英文介面');
  await until(async () => /Platform audit log/.test(await js("document.querySelector('.adm-nav').innerText")), 5000, 'D 英文目錄');
  assert.match(await js("document.querySelector('.adm-nav').innerText"), /Workspace audit log/, 'D 英文目錄');
  assert.ok((await rows()).some(r => r[2] === 'Changed workspace policy'), 'D 英文動作：' + JSON.stringify((await rows())[0]));
  console.log('audit-log-ui-test：全部通過');
} catch (e) {
  console.error('audit-log-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
