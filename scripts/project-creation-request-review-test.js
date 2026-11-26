// 驗收測試（ADR 0004、0005）：管理員核准並建立專案，或附理由拒絕
// - 審核清單 scope=review（游標分頁、準確的待審總數）；單筆的審核欄位（預估值、衝突欄位不透露占用者、能否核准或拒絕）
// - 核准：恰好一個專案（申請的可見度、識別碼、看板狀態）、申請人是唯一的初始專案管理員、審核人不是成員、一筆 project.create、一則通知
// - 冪等：任一位合法審核人再核准回 200 與原結果、不重複寫入；已拒絕／撤回／取消 409；能看但沒審核權 403；看不到 404
// - 拒絕：理由必填、project_creation_request.reject 稽核、通知申請人
// - 衝突：同名、指定的網址英文名或代號被占用 → 409（指出欄位、不透露占用者）、申請維持待審核；自動網址英文名被搶走 → 重算重試
// - 交易內斷言：政策已改、申請人已不符資格、審核人剛被降級、另一位審核人同時核准或拒絕、申請人同時撤回
// - 必要稽核：稽核表還沒就緒時不核准也不拒絕（503）；注入寫入失敗整批回復
// - 權限矩陣：平台管理員、工作區管理員、只有平台管理權、其他專案的專案管理員、成員、AI、申請人本人
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-request-review-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { testToken } from './test-token.js';
import { adminSession } from './test-admin.js';
import { setProjectRole, listProjectMembers } from './test-members.js';
import { cancelStmts } from '../src/project-creation-requests.js';
import { lockWorkspaceStmt } from '../src/write-order.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrrev-'));
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.equal(r.status, status, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); if (errCode) assert.equal(code(r), errCode, label); return r.body; };
const dbs = [];
// hooks：before＝下一個含符合 re 那句的寫入送出前先執行 run()；fail＝那一批丟錯（都只作用一次）
function harness(db) {
  const hooks = { before: null, fail: null };
  const hit = (slot, stmts) => (hooks[slot] && stmts.some(([sql]) => hooks[slot].re.test(sql)) ? hooks[slot] : null);
  const wrapped = { ...db, batch: async stmts => {
    const b = hit('before', stmts); if (b) { hooks.before = null; await b.run(); }
    const f = hit('fail', stmts); if (f) { hooks.fail = null; throw new Error('模擬的資料庫寫入失敗'); }
    return db.batch(stmts);
  } };
  const events = [];
  const live = { toPeople: (ids, type, data) => { events.push({ ids: [...ids], type, data }); return ids.length; }, connectedIds: () => [], dropPerson: () => {}, open: () => new Response('') };
  const app = createApp({ db: wrapped, storage: dbStorage(db), docText: '', config: CONFIG, live });
  return { hooks, events, call: appCaller(app), wdb: wrapped };
}
const n = async (db, sql, ...args) => Number((await db.get(sql, ...args)).n);
const AI_BODY = { roleKey: 'PG', role: '程式開發', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
let seq = 0;
const rid = () => `req-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const APPROVE_BATCH = /^INSERT INTO projects \(/; // 核准那一批（建立專案）
const REJECT_BATCH = /^UPDATE project_creation_requests SET state/; // 拒絕、撤回那一批

try {
  const db = await openTestDb(path.join(dataDir, 'main', 'switch.db'));
  dbs.push(db);
  const { hooks, events, call, wdb } = harness(db);
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const ann = await join('安娜'); // 工作區管理員（不是平台管理員）
  const pla = await join('柏拉'); // 只有平台管理權（工作區角色是成員）
  const chen = await join('陳大文'); // 申請人
  const wang = await join('王小美'); // 一般成員
  const lee = await join('李專管'); // 預設專案的專案管理員（其他專案的管理身分不給審核權）
  const bossS = await adminSession(call, boss.token);
  boss.token = bossS.token;
  ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升為工作區管理員');
  ok(await call(boss.token, `/api/participants/${pla.id}/platform-role`, 'PUT', { role: 'admin' }), '柏拉升為平台管理員');
  for (const p of [chen, wang, lee]) ok(await call(boss.token, `/api/participants/${p.id}/projects`, 'PUT', { projects: ['預設專案'] }), `${p.id} 加入預設專案`);
  ok(await setProjectRole(call, boss.token, '預設專案', lee.id, 'admin'), '李成為預設專案的專案管理員');
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: ['預設專案'], name: '陳的PG', ...AI_BODY })).body;
  const aiToken = ai.token || await testToken(db, ai.participantId);
  ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
  const submit = async (who, body) => is(await call(who.token, '/api/project-creation-requests', 'POST', { requestId: rid(), reason: '要做新功能', ...body }), 201, null, `送出 ${body.name}`);
  const get = (who, id) => call(who.token, `/api/project-creation-requests/${id}`);
  const approve = (who, id) => call(who.token, `/api/project-creation-requests/${id}/approve`, 'POST', {});
  const reject = (who, id, reason = '目前不需要') => call(who.token, `/api/project-creation-requests/${id}/reject`, 'POST', { reason });
  const reqRow = id => db.get('SELECT * FROM project_creation_requests WHERE id = ?', id);
  const counts = async () => ({ projects: await n(db, 'SELECT COUNT(*) AS n FROM projects'), audits: await n(db, 'SELECT COUNT(*) AS n FROM audit_log'),
    notices: await n(db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind != 'project_creation_request'"), members: await n(db, 'SELECT COUNT(*) AS n FROM project_members') });
  const projByName = name => db.get('SELECT * FROM projects WHERE name = ?', name);

  // ---------- 1) 審核清單：scope=review、游標分頁、準確的待審總數 ----------
  const r1 = await submit(chen, { name: '審核一' });
  const r2 = await submit(wang, { name: '審核二' });
  const r3 = await submit(chen, { name: '審核三' });
  for (const a of [boss, ann, pla]) {
    const l = ok(await call(a.token, '/api/project-creation-requests?scope=review&state=pending&limit=2'), '審核人看待審清單');
    assert.equal(l.pendingTotal, 3, '待審總數');
    assert.equal(l.items.length, 2);
    assert.ok(l.nextCursor, '有下一頁');
    const l2 = ok(await call(a.token, `/api/project-creation-requests?scope=review&state=pending&limit=2&cursor=${encodeURIComponent(l.nextCursor)}`), '第二頁');
    assert.equal(l2.pendingTotal, 3, '每頁都是準確的總數（不是載入的筆數）');
    assert.deepEqual([...l.items, ...l2.items].map(x => x.id).sort(), [r1.id, r2.id, r3.id].sort(), '別人的申請也看得到');
    assert.equal(l.items.find(x => x.requesterId === chen.id || x.requesterId === wang.id)?.requesterName != null, true, '列出申請人名字');
  }
  for (const [label, t] of [['成員', wang.token], ['申請人', chen.token], ['其他專案的專案管理員', lee.token]]) is(await call(t, '/api/project-creation-requests?scope=review'), 404, 'NOT_FOUND', `${label}看不到審核清單（無權查看一律 404）`);
  assert.equal((await call(aiToken, '/api/project-creation-requests?scope=review')).status, 403, 'AI 不能看審核清單');

  // ---------- 2) 單筆的審核欄位 ----------
  {
    const asReviewer = ok(await get(ann, r1.id), '審核人看單筆');
    assert.deepEqual({ canApprove: asReviewer.review.canApprove, canReject: asReviewer.review.canReject }, { canApprove: true, canReject: true });
    assert.equal(asReviewer.requesterName, '陳大文');
    assert.equal(asReviewer.review.preview.slugEstimated, true, '沒指定網址英文名：預估值');
    assert.equal(asReviewer.review.preview.codeEstimated, true);
    assert.match(asReviewer.review.preview.slug, /^project-\d+$/, '中文名稱的自動網址英文名');
    assert.match(asReviewer.review.preview.code, /^[A-Z]{2,5}$/);
    assert.deepEqual(asReviewer.review.conflicts, []);
    const asRequester = ok(await get(chen, r1.id), '申請人看自己的');
    assert.equal(asRequester.review, undefined, '申請人沒有審核欄位');
    is(await get(wang, r1.id), 404, 'NOT_FOUND', '別的成員');
    is(await get(lee, r1.id), 404, 'NOT_FOUND', '其他專案的專案管理員');
  }

  // ---------- 3) 核准：恰好一個專案、申請人是唯一的專案管理員、審核人不是成員、一筆稽核、一則通知 ----------
  const STATUSES = [{ name: '待辦', category: '待處理' }, { name: '開發中', category: '進行中' }, { name: '完成', category: '已完成' }];
  const full = await submit(chen, { name: '行動版', visibility: 'private', slug: 'mobile-app', code: 'MOB', statuses: STATUSES });
  {
    const pv = ok(await get(ann, full.id), '有指定值的預估');
    assert.deepEqual(pv.review.preview, { slug: 'mobile-app', code: 'MOB', slugEstimated: false, codeEstimated: false });
    events.length = 0;
    const c0 = await counts();
    const res = is(await approve(ann, full.id), 200, null, '安娜核准');
    assert.equal(res.state, 'approved');
    assert.equal(res.duplicate, false);
    assert.ok(res.project?.id && res.project.available, '回傳結果專案：' + JSON.stringify(res.project));
    const p = await projByName('行動版');
    assert.equal(p.id, res.project.id);
    assert.equal(p.visibility, 'private', '申請的可見度');
    assert.equal(p.created_by, ann.id, '專案的建立者＝審核人（執行者）');
    assert.equal((await db.get("SELECT value FROM app_settings WHERE key = ?", 'slug:' + p.id)).value, 'mobile-app');
    assert.equal((await db.get("SELECT value FROM app_settings WHERE key = ?", 'pcode:' + p.id)).value, 'MOB');
    assert.deepEqual((await db.all('SELECT name FROM project_statuses WHERE project = ? ORDER BY position', p.id)).map(s => s.name), ['待辦', '開發中', '完成'], '申請的看板狀態');
    const c1 = await counts();
    assert.equal(c1.projects - c0.projects, 1, '恰好一個專案');
    assert.equal(c1.audits - c0.audits, 1, '恰好一筆稽核');
    const ms = await db.all('SELECT * FROM project_members WHERE project_id = ?', p.id);
    assert.deepEqual(ms.map(m => m.participant_id), [chen.id], '新專案只有申請人一筆成員資格（審核人不是成員）');
    const admins = ok(await call(chen.token, '/api/projects'), '申請人的專案列表');
    assert.ok(admins.items.some(x => x.id === p.id), '申請人看得到新的私人專案');
    assert.deepEqual(admins.projectAdmins?.[p.id] ?? admins.leaders?.[p.id], [chen.id], '申請人是唯一的初始專案管理員');
    const members = ok(await listProjectMembers(call, ann.token, p.id), '成員清單').members;
    assert.deepEqual(members.map(m => [m.participantId, m.role]), [[chen.id, 'admin']], '成員清單只有申請人（專案管理員），審核人不在裡面');
    const audit = ok(await call(boss.token, '/api/audit-log?action=project.create'), '稽核').items.find(x => x.target?.id === p.id);
    assert.equal(audit.actor.id, ann.id, '執行者＝審核人');
    assert.equal(audit.detail.method, 'approved_request');
    assert.equal(audit.detail.requestId, full.id, '附申請編號');
    assert.equal(audit.detail.requester.id, chen.id, '附申請人');
    const nt = await db.all("SELECT * FROM account_notices WHERE kind = 'project_creation_request_approved' AND participant_id = ?", chen.id);
    assert.equal(nt.length, 1, '一則通知給申請人');
    assert.equal(c1.notices - c0.notices, 1, '只有這一則通知');
    const rr = await reqRow(full.id);
    assert.deepEqual({ state: rr.state, project_id: rr.project_id, ended_by: rr.ended_by }, { state: 'approved', project_id: p.id, ended_by: ann.id });
    const stale = events.filter(e => e.type === 'stale');
    assert.equal(stale.length, 1, '提交後一次重新抓取訊號');
    assert.deepEqual(stale[0].data, {}, '不帶內容');
    assert.ok(stale[0].ids.includes(chen.id) && stale[0].ids.includes(ann.id), '申請人與審核人');
    const mine = ok(await get(chen, full.id), '申請人看到已核准');
    assert.deepEqual(mine.project, { id: p.id, name: '行動版', available: true }, '申請人看得到專案連結');

    // ---------- 4) 冪等 ----------
    const c2 = await counts();
    const again = is(await approve(ann, full.id), 200, null, '同一位再核准');
    assert.equal(again.duplicate, true);
    assert.equal(again.project.id, p.id, '原本的結果');
    const other = is(await approve(boss, full.id), 200, null, '另一位審核人再核准');
    assert.equal(other.project.id, p.id);
    is(await approve(pla, full.id), 200, null, '只有平台管理權的審核人再核准');
    assert.deepEqual(await counts(), c2, '不重複寫入任何東西');
    is(await reject(ann, full.id), 409, 'REQUEST_NOT_PENDING', '已核准不能拒絕');
    is(await approve(chen, full.id), 403, 'NOT_REVIEWER', '申請人本人（看得到、沒審核權）');
    is(await approve(wang, full.id), 404, 'NOT_FOUND', '別的成員（看不到）');
    is(await approve(lee, full.id), 404, 'NOT_FOUND', '其他專案的專案管理員');
    is(await approve({ token: aiToken }, full.id), 404, 'NOT_FOUND', 'AI');
    is(await approve(wang, 'pcr_nope'), 404, 'NOT_FOUND', '不存在');
    assert.deepEqual(await counts(), c2);
  }

  // ---------- 5) 拒絕 ----------
  {
    is(await reject(ann, r1.id, '   '), 400, 'INVALID_REQUEST', '理由必填');
    is(await reject(ann, r1.id, 'x'.repeat(201)), 400, 'INVALID_REQUEST', '理由最多 200 字');
    is(await reject(chen, r1.id), 403, 'NOT_REVIEWER', '申請人不能拒絕自己的');
    is(await reject(wang, r1.id), 404, 'NOT_FOUND', '別的成員');
    is(await reject({ token: aiToken }, r1.id), 404, 'NOT_FOUND', 'AI');
    const c0 = await counts();
    events.length = 0;
    const res = is(await reject(boss, r1.id, '  名稱太籠統，請具體一點  '), 200, null, '拒絕');
    assert.equal(res.state, 'rejected');
    assert.equal(res.rejectReason, '名稱太籠統，請具體一點');
    const c1 = await counts();
    assert.deepEqual({ p: c1.projects - c0.projects, a: c1.audits - c0.audits, n: c1.notices - c0.notices }, { p: 0, a: 1, n: 1 }, '沒有專案、一筆稽核、一則通知');
    const audit = ok(await call(boss.token, '/api/audit-log?action=project_creation_request.reject'), '拒絕的稽核').items[0];
    assert.equal(audit.actor.id, bossS.participantId ?? boss.id);
    assert.equal(audit.target.id, chen.id, '對象＝申請人');
    assert.deepEqual(audit.detail, { requestId: r1.id, requester: { id: chen.id, name: '陳大文' } }, '只記編號與申請人，不複製申請內容');
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_rejected' AND participant_id = ?", chen.id), 1);
    assert.equal(events.filter(e => e.type === 'stale').length, 1);
    assert.equal(ok(await get(chen, r1.id), '申請人看到理由').rejectReason, '名稱太籠統，請具體一點');
    is(await reject(ann, r1.id), 409, 'REQUEST_NOT_PENDING', '再拒絕');
    is(await approve(ann, r1.id), 409, 'REQUEST_NOT_PENDING', '已拒絕不能核准');
    // 已撤回、已取消
    const w = await submit(wang, { name: '要撤回' });
    ok(await call(wang.token, `/api/project-creation-requests/${w.id}/withdraw`, 'POST'), '撤回');
    is(await approve(ann, w.id), 409, 'REQUEST_NOT_PENDING', '已撤回不能核准');
    const cx = await submit(wang, { name: '要取消' });
    await db.batch([lockWorkspaceStmt('default'), ...cancelStmts({ requesterId: wang.id, cancelCode: 'policy_changed', at: new Date().toISOString() })]);
    const cxErr = is(await approve(ann, cx.id), 409, 'REQUEST_NOT_PENDING', '已取消不能核准');
    assert.deepEqual([cxErr.error.state, cxErr.error.cancelCode], ['cancelled', 'policy_changed'], '錯誤帶目前的狀態與取消原因（分得出政策已改變）：' + JSON.stringify(cxErr));
    is(await reject(ann, cx.id), 409, 'REQUEST_NOT_PENDING', '已取消不能拒絕');
  }

  // ---------- 6) 衝突：409 指出欄位、不透露占用者、申請維持待審核 ----------
  {
    ok(await call(boss.token, '/api/projects', 'POST', { name: '機密計畫X', visibility: 'private', code: 'SEC', slug: 'secret-x' }), '管理員建了一個私人專案');
    const c0 = await counts();
    const dupName = await submit(chen, { name: '機密計畫X' });
    const pv = ok(await get(ann, dupName.id), '審核人看到衝突');
    assert.deepEqual(pv.review.conflicts, ['name']);
    const e1 = is(await approve(ann, dupName.id), 409, 'NAME_TAKEN', '同名');
    assert.equal(e1.error.field ?? e1.error.details?.field ?? e1.field, 'name', '指出欄位：' + JSON.stringify(e1));
    const byCode = await submit(chen, { name: '代號衝突', code: 'SEC' });
    assert.deepEqual(ok(await get(ann, byCode.id), '代號衝突').review.conflicts, ['code']);
    const e2 = is(await approve(ann, byCode.id), 409, 'CODE_TAKEN', '指定代號被占用');
    assert.ok(!JSON.stringify(e2).includes('機密計畫X'), '不透露占用者：' + JSON.stringify(e2));
    const bySlug = await submit(chen, { name: '網址衝突', slug: 'secret-x' });
    const pvs = ok(await get(ann, bySlug.id), '網址衝突');
    assert.deepEqual(pvs.review.conflicts, ['slug']);
    assert.ok(!JSON.stringify(pvs).includes('機密計畫X'), '單筆不透露占用者');
    const e3 = is(await approve(ann, bySlug.id), 409, 'SLUG_TAKEN', '指定網址英文名被占用');
    assert.ok(!JSON.stringify(e3).includes('機密計畫X') && !JSON.stringify(e3).includes('suggestion'), '不透露占用者、不給建議值：' + JSON.stringify(e3));
    for (const r of [dupName, byCode, bySlug]) assert.equal((await reqRow(r.id)).state, 'pending', '申請維持待審核');
    assert.deepEqual(await counts(), c0, '衝突時什麼都沒寫');
    // 交易前沒衝突、送出那一批之前剛好被別人用掉：交易內斷言擋下，一樣 409
    const late = await submit(chen, { name: '晚到的代號', code: 'LATE' });
    hooks.before = { re: APPROVE_BATCH, run: async () => ok(await call(boss.token, '/api/projects', 'POST', { name: '搶先', code: 'LATE' }), '別人先用掉 LATE') };
    const e4 = is(await approve(ann, late.id), 409, 'CODE_TAKEN', '交易內才發現代號被占用');
    assert.ok(!JSON.stringify(e4).includes('搶先'), '不透露占用者');
    assert.equal((await reqRow(late.id)).state, 'pending');
    // 自動網址英文名被搶走：重算重試，照樣建立
    const auto = await submit(chen, { name: 'Data Lake' });
    const est = ok(await get(ann, auto.id), '預估值').review.preview;
    assert.equal(est.slug, 'data-lake');
    hooks.before = { re: APPROVE_BATCH, run: async () => ok(await call(boss.token, '/api/projects', 'POST', { name: '別的湖', slug: 'data-lake', code: est.code }), '別人先用掉預估的網址英文名與代號') };
    const res = is(await approve(ann, auto.id), 200, null, '自動識別碼被搶走後重試成功');
    const p = await projByName('Data Lake');
    assert.equal(res.project.id, p.id);
    assert.notEqual((await db.get("SELECT value FROM app_settings WHERE key = ?", 'slug:' + p.id)).value, 'data-lake', '換了一個網址英文名');
    assert.notEqual((await db.get("SELECT value FROM app_settings WHERE key = ?", 'pcode:' + p.id)).value, est.code, '換了一個代號');
  }

  // ---------- 7) 前提不成立（交易前、交易內）：政策已改、申請人不符資格、審核人剛被降級 ----------
  {
    const c0 = await counts();
    // 政策：直接改資料（不經過政策 API，只測核准自己的斷言）
    const pol = await submit(chen, { name: '政策交錯' });
    await db.run("UPDATE workspaces SET create_projects = 'members' WHERE id = 'default'");
    is(await approve(ann, pol.id), 409, 'POLICY_CHANGED', '交易前就看到政策已改');
    await db.run("UPDATE workspaces SET create_projects = 'approval' WHERE id = 'default'");
    hooks.before = { re: APPROVE_BATCH, run: () => db.run("UPDATE workspaces SET create_projects = 'admins' WHERE id = 'default'") };
    is(await approve(ann, pol.id), 409, 'POLICY_CHANGED', '交易內才發現政策已改');
    await db.run("UPDATE workspaces SET create_projects = 'approval' WHERE id = 'default'");
    assert.equal((await reqRow(pol.id)).state, 'pending');
    // 申請人已不符資格（被移出）
    hooks.before = { re: APPROVE_BATCH, run: () => db.run("UPDATE participants SET workspace_status = 'removed' WHERE id = ?", chen.id) };
    is(await approve(ann, pol.id), 409, 'REQUESTER_NOT_ELIGIBLE', '交易內才發現申請人被移出');
    is(await approve(ann, pol.id), 409, 'REQUESTER_NOT_ELIGIBLE', '交易前就看到申請人被移出');
    await db.run("UPDATE participants SET workspace_status = 'active' WHERE id = ?", chen.id);
    assert.deepEqual(await counts(), c0, '都沒有寫入');
    // 審核人剛被降級：看不到 → 404（申請人本人被降級 → 403，見下面）
    const dem = await submit(wang, { name: '降級交錯' });
    hooks.before = { re: APPROVE_BATCH, run: () => db.run("UPDATE participants SET workspace_role = 'member' WHERE id = ?", ann.id) };
    is(await approve(ann, dem.id), 404, 'NOT_FOUND', '交易內才發現審核人被降級');
    await db.run("UPDATE participants SET workspace_role = 'admin' WHERE id = ?", ann.id);
    hooks.before = { re: REJECT_BATCH, run: () => db.run("UPDATE participants SET workspace_role = 'member' WHERE id = ?", ann.id) };
    is(await reject(ann, dem.id), 404, 'NOT_FOUND', '拒絕時審核人剛被降級');
    await db.run("UPDATE participants SET workspace_role = 'admin' WHERE id = ?", ann.id);
    assert.equal((await reqRow(dem.id)).state, 'pending');
    // 判斷不出原因：一般的 409。送出那一批之前把政策切走（斷言失敗），判斷原因前又切回來（新鮮資料看不出原因）
    const realGet = wdb.get;
    let armed = false;
    wdb.get = async (sql, ...a) => { if (armed && /FROM workspaces WHERE id = \? AND create_projects/.test(sql)) { armed = false; await db.run("UPDATE workspaces SET create_projects = 'approval' WHERE id = 'default'"); } return realGet(sql, ...a); };
    hooks.before = { re: APPROVE_BATCH, run: async () => { await db.run("UPDATE workspaces SET create_projects = 'admins' WHERE id = 'default'"); armed = true; } };
    try { is(await approve(ann, dem.id), 409, 'CONFLICT', '判斷不出原因回一般的 409'); } finally { wdb.get = realGet; }
    assert.equal(armed, false, '真的有在判斷原因前切回來');
    assert.equal((await reqRow(dem.id)).state, 'pending');
    assert.deepEqual(await counts(), c0, '都沒有寫入');
  }

  // ---------- 8) 交錯：另一位審核人同時核准或拒絕、申請人同時撤回 ----------
  {
    const a = await submit(wang, { name: '同時核准' });
    let inner = null;
    hooks.before = { re: APPROVE_BATCH, run: async () => { inner = await approve(boss, a.id); } };
    const outer = is(await approve(ann, a.id), 200, null, '後完成的核准看到已核准的結果');
    assert.equal(inner?.status, 200, '先完成的核准');
    assert.equal(outer.duplicate, true);
    assert.equal(outer.project.id, inner.body.project.id, '同一個專案');
    assert.equal(await n(db, 'SELECT COUNT(*) AS n FROM projects WHERE name = ?', '同時核准'), 1, '只建立一個專案');
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.create' AND target_id = ?", inner.body.project.id), 1, '只有一筆稽核');

    const b = await submit(wang, { name: '核准與拒絕' });
    hooks.before = { re: APPROVE_BATCH, run: async () => { inner = await reject(boss, b.id); } };
    is(await approve(ann, b.id), 409, 'REQUEST_NOT_PENDING', '先拒絕了，核准 409');
    assert.equal(inner?.status, 200);
    assert.equal(await n(db, 'SELECT COUNT(*) AS n FROM projects WHERE name = ?', '核准與拒絕'), 0, '沒有建立專案');

    const c = await submit(wang, { name: '核准與撤回' });
    hooks.before = { re: APPROVE_BATCH, run: async () => { inner = await call(wang.token, `/api/project-creation-requests/${c.id}/withdraw`, 'POST'); } };
    is(await approve(ann, c.id), 409, 'REQUEST_NOT_PENDING', '先撤回了，核准 409');
    assert.equal(inner?.status, 200);
    assert.equal(await n(db, 'SELECT COUNT(*) AS n FROM projects WHERE name = ?', '核准與撤回'), 0);

    const d = await submit(wang, { name: '拒絕與核准' });
    hooks.before = { re: REJECT_BATCH, run: async () => { inner = await approve(boss, d.id); } };
    is(await reject(ann, d.id), 409, 'REQUEST_NOT_PENDING', '先核准了，拒絕 409');
    assert.equal(inner?.status, 200);
  }

  // ---------- 9) 注入寫入失敗：整批回復，重試成功 ----------
  {
    const f = await submit(wang, { name: '寫入失敗', code: 'FAIL' });
    const c0 = await counts();
    hooks.fail = { re: /^INSERT INTO audit_log\b/ };
    const r = await approve(ann, f.id);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(hooks.fail, null, '真的注入了失敗');
    assert.deepEqual(await counts(), c0, '沒有部分專案、成員資格、稽核或通知');
    assert.equal((await reqRow(f.id)).state, 'pending');
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM app_settings WHERE value = 'FAIL'"), 0, '沒有留下識別碼');
    is(await approve(ann, f.id), 200, null, '重試成功');
    assert.equal(await n(db, 'SELECT COUNT(*) AS n FROM projects WHERE name = ?', '寫入失敗'), 1);
    const g = await submit(wang, { name: '拒絕失敗' });
    const c1 = await counts();
    hooks.fail = { re: /^INSERT INTO audit_log\b/ };
    assert.equal((await reject(ann, g.id)).status, 500);
    assert.deepEqual(await counts(), c1);
    assert.equal((await reqRow(g.id)).state, 'pending');
    is(await reject(ann, g.id), 200, null, '重試拒絕成功');
  }

  // ---------- 10) 自己的申請：升為管理員後可以自己核准；被降級後看得到但不能核准（403） ----------
  {
    const gina = await join('吉娜');
    const own = await submit(gina, { name: '吉娜的專案' });
    ok(await call(boss.token, `/api/participants/${gina.id}/workspace-role`, 'PUT', { role: 'admin' }), '吉娜升為工作區管理員');
    const own2 = await submit({ token: gina.token }, { name: '不會送出' }).catch(e => e);
    assert.ok(own2 instanceof Error, '管理員不送申請');
    ok(await call(boss.token, `/api/participants/${gina.id}/workspace-role`, 'PUT', { role: 'member' }), '吉娜被降級');
    is(await approve(gina, own.id), 403, 'NOT_REVIEWER', '看得到自己的申請、但沒有審核權');
    ok(await call(boss.token, `/api/participants/${gina.id}/workspace-role`, 'PUT', { role: 'admin' }), '吉娜再升級');
    const res = is(await approve(gina, own.id), 200, null, '不禁止審核自己的申請');
    assert.deepEqual((await db.all('SELECT participant_id FROM project_members WHERE project_id = ?', res.project.id)).map(m => m.participant_id), [gina.id]);
  }

  // ---------- 11) 稽核表還沒就緒：核准、拒絕都 503，什麼都沒寫 ----------
  {
    const db2 = await openTestDb(path.join(dataDir, 'noaudit', 'switch.db'));
    dbs.push(db2);
    const pre = harness(db2);
    const b2 = (await pre.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    const m2 = (await pre.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
    ok(await pre.call(b2.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
    const q = ok(await pre.call(m2.token, '/api/project-creation-requests', 'POST', { requestId: 'r1', name: '空窗期', reason: 'x' }), '送出');
    await db2.run('DROP TABLE audit_log');
    const { call: c2 } = harness(db2); // 新的一份程式：第一個請求發現稽核表不存在
    const projects0 = await n(db2, 'SELECT COUNT(*) AS n FROM projects');
    is(await c2(b2.token, `/api/project-creation-requests/${q.id}/approve`, 'POST', {}), 503, 'AUDIT_NOT_READY', '核准');
    is(await c2(b2.token, `/api/project-creation-requests/${q.id}/reject`, 'POST', { reason: 'x' }), 503, 'AUDIT_NOT_READY', '拒絕');
    assert.equal(await n(db2, 'SELECT COUNT(*) AS n FROM projects'), projects0, '沒有建立專案');
    assert.equal((await db2.get('SELECT state FROM project_creation_requests WHERE id = ?', q.id)).state, 'pending');
    is(await c2(b2.token, '/api/projects', 'POST', { name: '空窗期直接建立' }), 201, null, '直接建立照常（部署相容的例外）');
  }
  console.log('建立專案申請（核准、拒絕）測試通過');
} finally {
  for (const db of dbs) await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
