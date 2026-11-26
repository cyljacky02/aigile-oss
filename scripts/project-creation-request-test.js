// 驗收測試（#44、ADR 0004、0005）：成員可以送出、查看、撤回建立專案申請
// - 權限矩陣：三種政策 × 平台管理員／工作區管理員／只有平台管理權／成員／AI／被移出／停用，對送出、查看與專案列表的三個 capability
// - 一般成員在 approval 呼叫直接建立：403 PROJECT_CREATION_REQUIRES_APPROVAL，不建立申請
// - 送出：正規化、201；冪等重送 200、內容不同 409 IDEMPOTENCY_CONFLICT；同名待審 409（資料庫索引）；注入寫入失敗整批回復
// - 通知：審核人（明確工作區管理員＋平台管理員）每人一則、不通知申請人；即時事件只發「請重新抓取」，不帶內容
// - 查看：scope=mine 游標分頁；別人與 AI 一律 404；被移出、停用後查不到
// - 撤回：本人、待審核才行；不通知、不寫稽核；之後可以用同名重送
// - 送出與政策切換交錯：交易內斷言擋下，不留申請
// - 資料表：CHECK 約束、部分唯一索引；唯一的狀態轉換（只有 pending 能轉）與取消入口
// - 申請資料表還沒建立：503；暫時的啟用控制沒開時不能把政策設成 approval
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-request-test.js
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
import { transitionStmts, cancelStmts, pendingCountSql } from '../src/project-creation-requests.js';
import { lockWorkspaceStmt, isAssertionFailure } from '../src/write-order.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcr-'));
const BASE_CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const CONFIG = { ...BASE_CONFIG, unreleasedProjectCreationRequests: '1' }; // 暫時的啟用控制（#48 移除）
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.equal(r.status, status, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); if (errCode) assert.equal(code(r), errCode, label); return r.body; };
const dbs = [];
// hooks：before＝下一個含符合 re 那句的寫入送出前先執行 run()；fail＝那一批丟錯（都只作用一次）
function harness(db, config = CONFIG) {
  const hooks = { before: null, fail: null };
  const hit = (slot, stmts) => (hooks[slot] && stmts.some(([sql]) => hooks[slot].re.test(sql)) ? hooks[slot] : null);
  const wrapped = { ...db, batch: async stmts => {
    const b = hit('before', stmts); if (b) { hooks.before = null; await b.run(); }
    const f = hit('fail', stmts); if (f) { hooks.fail = null; throw new Error('模擬的資料庫寫入失敗'); }
    return db.batch(stmts);
  } };
  const events = [];
  const live = { toPeople: (ids, type, data) => { events.push({ ids: [...ids], type, data }); return ids.length; }, connectedIds: () => [], dropPerson: () => {}, open: () => new Response('') };
  const app = createApp({ db: wrapped, storage: dbStorage(db), docText: '', config, live });
  return { hooks, events, call: appCaller(app) };
}
const count = async (db, sql, ...args) => Number((await db.get(sql, ...args)).n);
const AI_BODY = { roleKey: 'PG', role: '程式開發', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
let seq = 0;
const rid = () => `req-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

try {
  const db = await openTestDb(path.join(dataDir, 'main', 'switch.db'));
  dbs.push(db);
  const { hooks, events, call } = harness(db);
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const ann = await join('安娜'); // 之後升為工作區管理員（不是平台管理員）
  const pla = await join('柏拉'); // 之後升為平台管理員（工作區角色仍是成員：只有隱含的工作區管理權）
  const chen = await join('陳大文'); // 一般成員（申請人）
  const wang = await join('王小美'); // 一般成員（看不到別人的申請）
  const dan = await join('丹尼'); // 一般成員：之後被移出
  const eve = await join('伊芙'); // 一般成員：之後被停用
  const bossS = await adminSession(call, boss.token);
  boss.token = bossS.token;
  ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升為工作區管理員');
  ok(await call(boss.token, `/api/participants/${pla.id}/platform-role`, 'PUT', { role: 'admin' }), '柏拉升為平台管理員');
  for (const p of [chen, wang, dan, eve]) ok(await call(boss.token, `/api/participants/${p.id}/projects`, 'PUT', { projects: ['預設專案'] }), `${p.id} 加入預設專案`);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: ['預設專案'], name: '陳的PG', ...AI_BODY })).body;
  const aiToken = ai.token || await testToken(db, ai.participantId);
  const setPolicy = async value => ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: value }), `政策設成 ${value}`);
  const submit = (who, body) => call(who.token, '/api/project-creation-requests', 'POST', { requestId: rid(), reason: '要做新功能', ...body });
  const rows = () => db.all('SELECT * FROM project_creation_requests ORDER BY created_at, id');

  // ---------- 1) 權限矩陣：三種政策 × 角色（送出、查看、capability） ----------
  const actors = { boss, ann, pla, chen, ai: { token: aiToken } };
  const expectCaps = (policy, who) => ({
    canCreateProject: ['boss', 'ann', 'pla'].includes(who) || (who === 'chen' && policy === 'members'),
    canRequestProjectCreation: who === 'chen' && policy === 'approval',
    canReviewProjectCreationRequests: ['boss', 'ann', 'pla'].includes(who),
  });
  for (const policy of ['admins', 'approval', 'members']) {
    await setPolicy(policy);
    for (const [who, a] of Object.entries(actors)) {
      const pr = ok(await call(a.token, '/api/projects'), `${policy}/${who} 專案列表`);
      const caps = { canCreateProject: pr.canCreateProject, canRequestProjectCreation: pr.canRequestProjectCreation, canReviewProjectCreationRequests: pr.canReviewProjectCreationRequests };
      assert.deepEqual(caps, expectCaps(policy, who), `${policy}/${who} 的 capability`);
      const r = await submit(a, { name: `矩陣${policy.slice(0, 3)}${who}` });
      if (who === 'chen' && policy === 'approval') is(r, 201, null, `${policy}/${who} 送出`);
      else if (who === 'ai') assert.equal(r.status, 403, `AI 不能送出：${JSON.stringify(r.body)}`);
      else if (who === 'chen') is(r, 403, 'PROJECT_CREATION_REQUESTS_CLOSED', `${policy}/${who} 送出`);
      else is(r, 403, 'CAN_CREATE_DIRECTLY', `${policy}/${who} 送出`);
      const mine = await call(a.token, '/api/project-creation-requests?scope=mine');
      if (who === 'ai') assert.equal(mine.status, 403, 'AI 看不到申請列表');
      else is(mine, 200, null, `${policy}/${who} 看自己的申請`);
    }
  }
  assert.equal((await rows()).length, 1, '矩陣只有一份申請：' + JSON.stringify(await rows()));
  await setPolicy('approval');

  // ---------- 2) 一般成員在 approval 呼叫直接建立：403，不建申請；管理員照常直接建立 ----------
  const before = (await rows()).length;
  is(await call(chen.token, '/api/projects', 'POST', { name: '直接建立' }), 403, 'PROJECT_CREATION_REQUIRES_APPROVAL', '成員直接建立');
  assert.equal((await rows()).length, before, '沒有自動轉成申請');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM projects WHERE name = ?', '直接建立'), 0);
  is(await call(aiToken, '/api/projects', 'POST', { name: 'AI建立' }), 403, 'NOT_ADMIN', 'AI 直接建立維持既有拒絕');
  is(await call(ann.token, '/api/projects', 'POST', { name: '管理員專案' }), 201, null, '工作區管理員照常直接建立');

  // ---------- 3) 送出：正規化、通知、即時事件 ----------
  events.length = 0;
  const noticesBefore = await count(db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request'");
  const reqId = rid();
  const STATUSES = [{ name: '待辦', category: '待處理' }, { name: '做', category: '進行中' }, { name: '好', category: '已完成' }];
  const body = { requestId: reqId, name: '  新的專案  ', reason: '  想做行動版  ', visibility: 'private', slug: 'Mobile-App', code: 'mob', statuses: STATUSES };
  const first = is(await call(chen.token, '/api/project-creation-requests', 'POST', body), 201, null, '送出');
  assert.equal(first.state, 'pending');
  assert.equal(first.name, '新的專案', '名稱去頭尾空白');
  assert.equal(first.reason, '想做行動版', '原因去頭尾空白');
  assert.equal(first.visibility, 'private');
  assert.equal(first.slug, 'mobile-app', '網址英文名正規化成小寫');
  assert.equal(first.code, 'MOB', '代號正規化成大寫');
  assert.deepEqual(first.statuses.map(s => s.name), ['待辦', '做', '好']);
  assert.equal(first.requestId, reqId);
  assert.equal(first.canWithdraw, true);
  assert.equal(first.project, null);
  // 通知：明確工作區管理員（林、安娜）＋平台管理員（林、柏拉），林只有一則；不通知申請人與其他成員
  const added = await count(db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request'") - noticesBefore;
  assert.equal(added, 3, '三位審核人各一則');
  const mineNotices = await db.all("SELECT participant_id, detail FROM account_notices WHERE kind = 'project_creation_request' AND id LIKE ?", `ntc_${first.id}_%`);
  assert.deepEqual(mineNotices.map(n => n.participant_id).sort(), [boss.id, ann.id, pla.id].sort(), '收件人＝審核人、同一人一次、不含申請人');
  assert.ok(mineNotices.every(n => !n.detail.includes('新的專案') && !n.detail.includes('想做行動版')), '通知不帶申請內容');
  const meNotices = ok(await call(ann.token, '/api/me/notices'), '安娜讀通知').items.filter(n => n.kind === 'project_creation_request');
  assert.equal(meNotices.length >= 1, true, '審核人在帳號提醒看得到');
  // 即時事件：只推給申請人與審核人，事件名稱與內容不帶業務語意
  const stale = events.filter(e => e.type === 'stale');
  assert.equal(stale.length, 1, '一次重新抓取訊號：' + JSON.stringify(events));
  assert.deepEqual(stale[0].ids.sort(), [chen.id, boss.id, ann.id, pla.id].sort(), '只推給相關的人');
  assert.deepEqual(stale[0].data, {}, '不帶任何內容');
  assert.ok(!events.some(e => /project|creation|request/i.test(e.type)), '事件名稱不帶業務語意');

  // ---------- 4) 冪等與同名 ----------
  events.length = 0;
  const n0 = (await rows()).length, a0 = await count(db, 'SELECT COUNT(*) AS n FROM account_notices');
  const dup = is(await call(chen.token, '/api/project-creation-requests', 'POST', body), 200, null, '同一 requestId、同內容重送');
  assert.equal(dup.id, first.id, '回原本的申請');
  assert.equal(dup.state, 'pending');
  assert.equal((await rows()).length, n0, '沒有新申請');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM account_notices'), a0, '重送不再通知');
  assert.equal(events.filter(e => e.type === 'stale').length, 0, '重送不發事件');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { ...body, name: '新的專案' }), 200, null, '正規化後相同＝同內容');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { ...body, reason: '不同的原因' }), 409, 'IDEMPOTENCY_CONFLICT', '同 requestId 不同內容');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { ...body, slug: '' }), 409, 'IDEMPOTENCY_CONFLICT', '自動網址英文名≠指定的值');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { ...body, requestId: rid() }), 409, 'DUPLICATE_PENDING_REQUEST', '同名待審（不同 requestId）');
  is(await call(wang.token, '/api/project-creation-requests', 'POST', { ...body, requestId: reqId }), 201, null, '別人用同一個 requestId、同名：各自的申請');
  // 同時送出（交易前都沒看到對方）：同一 requestId → 後寫的撞唯一索引，回先寫的那份（200）；不同 requestId 同名 → 撞部分唯一索引，409
  {
    const raceBody = { requestId: rid(), name: '同時送出', reason: 'x' };
    let inner = null;
    hooks.before = { re: /^INSERT INTO project_creation_requests\b/, run: async () => { inner = await call(chen.token, '/api/project-creation-requests', 'POST', raceBody); } };
    const outer = is(await call(chen.token, '/api/project-creation-requests', 'POST', raceBody), 200, null, '同一 requestId 同時送出：後寫的回原本的');
    assert.equal(inner?.status, 201, '先寫的建立');
    assert.equal(outer.id, inner.body.id, '同一份');
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM project_creation_requests WHERE name = ?', '同時送出'), 1);
    hooks.before = { re: /^INSERT INTO project_creation_requests\b/, run: async () => { inner = await submit(chen, { name: '同時同名' }); } };
    is(await submit(chen, { name: '同時同名' }), 409, 'DUPLICATE_PENDING_REQUEST', '同名同時送出：資料庫索引擋下後寫的');
    assert.equal(inner?.status, 201);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM project_creation_requests WHERE name = ?', '同時同名'), 1);
  }
  // 驗證
  is(await submit(chen, { name: '缺原因', reason: '   ' }), 400, 'INVALID_REQUEST', '原因必填');
  is(await submit(chen, { name: '長原因', reason: 'x'.repeat(201) }), 400, 'INVALID_REQUEST', '原因最多 200 字');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { name: '沒有鍵', reason: 'x' }), 400, 'INVALID_REQUEST', 'requestId 必填');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { requestId: 'x'.repeat(129), name: '長鍵', reason: 'x' }), 400, 'INVALID_REQUEST', 'requestId 最多 128');
  is(await submit(chen, { name: '一二三四五六七八九十一二三四五六七八九十一' }), 400, 'INVALID_REQUEST', '名稱最多 20 字');
  is(await submit(chen, { name: '逗號,名稱' }), 400, 'INVALID_REQUEST', '名稱不可含逗號');
  is(await submit(chen, { name: '壞可見度', visibility: 'secret' }), 400, 'INVALID_REQUEST', '可見度');
  is(await submit(chen, { name: '壞代號', code: 'X1' }), 400, 'INVALID_REQUEST', '代號格式');
  is(await submit(chen, { name: '壞網址', slug: 'a b' }), 400, 'INVALID_SLUG', '網址英文名格式');
  const defaults = is(await submit(chen, { name: '預設值' }), 201, null, '只填必填');
  assert.equal(defaults.visibility, 'review', '可見度預設審核');
  assert.equal(defaults.slug, null, '網址英文名自動＝null');
  assert.equal(defaults.code, null, '代號自動＝null');
  assert.equal(defaults.statuses, null, '看板狀態預設＝null');

  // ---------- 5) 注入寫入失敗：整批回復，重試成功 ----------
  const failKey = rid();
  hooks.fail = { re: /^INSERT INTO account_notices\b/ };
  const failed = await call(chen.token, '/api/project-creation-requests', 'POST', { requestId: failKey, name: '失敗申請', reason: 'x' });
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(hooks.fail, null, '真的注入了失敗');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM project_creation_requests WHERE name = ?', '失敗申請'), 0, '沒有留下申請');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { requestId: failKey, name: '失敗申請', reason: 'x' }), 201, null, '重試成功');

  // ---------- 7) 查看：游標分頁、可見範圍 ----------
  for (const n of ['分頁一', '分頁二', '分頁三']) is(await submit(wang, { name: n }), 201, null, n);
  const p1 = ok(await call(wang.token, '/api/project-creation-requests?scope=mine&limit=2'), '第一頁');
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor, '有下一頁');
  const p2 = ok(await call(wang.token, `/api/project-creation-requests?scope=mine&limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`), '第二頁');
  const p3 = p2.nextCursor ? ok(await call(wang.token, `/api/project-creation-requests?scope=mine&limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`), '第三頁') : { items: [], nextCursor: null };
  const all = [...p1.items, ...p2.items, ...p3.items];
  assert.equal(all.length, 4, '王的四份申請（含同 requestId 那份）：' + JSON.stringify(all.map(x => x.name)));
  assert.equal(new Set(all.map(x => x.id)).size, 4, '不重複');
  assert.equal(p3.nextCursor, null, '最後一頁沒有游標');
  assert.deepEqual(all.map(x => x.createdAt), [...all.map(x => x.createdAt)].sort().reverse(), '新的在前');
  assert.ok(all.every(x => x.requesterId === wang.id), '只有自己的');
  const big = ok(await call(wang.token, '/api/project-creation-requests?scope=mine&limit=1000'), '超過上限照最多 100');
  assert.equal(big.items.length, 4);
  is(await call(wang.token, '/api/project-creation-requests?scope=mine&limit=0'), 400, 'INVALID_REQUEST', 'limit 0');
  is(await call(wang.token, '/api/project-creation-requests?scope=mine&cursor=%%%'), 400, 'INVALID_REQUEST', '壞游標');
  is(await call(wang.token, '/api/project-creation-requests?scope=nope'), 400, 'INVALID_REQUEST', '不認得的 scope');
  is(await call(wang.token, '/api/project-creation-requests?state=draft'), 400, 'INVALID_REQUEST', '不認得的狀態');
  assert.equal(ok(await call(wang.token, '/api/project-creation-requests?state=withdrawn'), '只看已撤回').items.length, 0);
  // 單筆：本人、審核人看得到；別的成員、AI、不存在一律 404（同一種錯誤）
  is(await call(chen.token, `/api/project-creation-requests/${first.id}`), 200, null, '本人');
  for (const a of [boss, ann, pla]) is(await call(a.token, `/api/project-creation-requests/${first.id}`), 200, null, '審核人');
  const hidden = is(await call(wang.token, `/api/project-creation-requests/${first.id}`), 404, 'NOT_FOUND', '別的成員');
  const missing = is(await call(wang.token, '/api/project-creation-requests/pcr_nope'), 404, 'NOT_FOUND', '不存在');
  assert.deepEqual(hidden, missing, '跟不存在一模一樣');
  is(await call(aiToken, `/api/project-creation-requests/${first.id}`), 404, 'NOT_FOUND', 'AI（申請人自己的 AI）');
  is(await call(aiToken, `/api/project-creation-requests/${first.id}/withdraw`, 'POST'), 404, 'NOT_FOUND', 'AI 不能撤回');
  is(await call(aiToken, '/api/project-creation-requests', 'POST', { ...body, requestId: reqId }), 403, null, 'AI 不能用申請人的 requestId 讀資料');
  const chenList = ok(await call(chen.token, '/api/project-creation-requests'), '陳的列表（預設 scope=mine）');
  assert.ok(!chenList.items.some(x => x.requesterId !== chen.id), '看不到別人的');

  // ---------- 8) 撤回 ----------
  events.length = 0;
  const auditBefore = await count(db, 'SELECT COUNT(*) AS n FROM audit_log');
  const ntcBefore = await count(db, 'SELECT COUNT(*) AS n FROM account_notices');
  is(await call(wang.token, `/api/project-creation-requests/${first.id}/withdraw`, 'POST'), 404, 'NOT_FOUND', '別的成員不能撤回（看不到）');
  is(await call(ann.token, `/api/project-creation-requests/${first.id}/withdraw`, 'POST'), 403, 'NOT_REQUESTER', '審核人不能代撤回');
  const w = is(await call(chen.token, `/api/project-creation-requests/${first.id}/withdraw`, 'POST'), 200, null, '本人撤回');
  assert.equal(w.state, 'withdrawn');
  assert.equal(w.canWithdraw, false);
  assert.ok(w.endedAt);
  const wr = await db.get('SELECT * FROM project_creation_requests WHERE id = ?', first.id);
  assert.equal(wr.ended_by, chen.id, 'ended_by＝申請人本人');
  is(await call(chen.token, `/api/project-creation-requests/${first.id}/withdraw`, 'POST'), 409, 'REQUEST_NOT_PENDING', '再撤回一次');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM audit_log'), auditBefore, '撤回不寫稽核');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM account_notices'), ntcBefore, '撤回不通知任何人');
  const ws = events.filter(e => e.type === 'stale');
  assert.equal(ws.length, 1, '撤回發一次重新抓取訊號');
  assert.deepEqual(ws[0].data, {});
  is(await call(chen.token, '/api/project-creation-requests', 'POST', { ...body, requestId: rid() }), 201, null, '撤回後可以用同名重送');
  is(await call(chen.token, '/api/project-creation-requests', 'POST', body), 200, null, '舊的 requestId 拿回已撤回的那份');
  assert.equal((await call(chen.token, '/api/project-creation-requests', 'POST', body)).body.state, 'withdrawn', '回傳目前狀態');

  // ---------- 6) 送出與政策切換交錯：政策在送出那一批之前被切走 → 交易內斷言擋下（放在撤回之後：從 approval 切走會取消所有待審申請，#46） ----------
  hooks.before = { re: /^INSERT INTO project_creation_requests\b/, run: async () => { await setPolicy('members'); } };
  is(await submit(chen, { name: '交錯申請' }), 403, 'PROJECT_CREATION_REQUESTS_CLOSED', '政策剛切走');
  assert.equal(hooks.before, null, '真的有交錯');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM project_creation_requests WHERE name = ?', '交錯申請'), 0, '沒有留下申請');
  await setPolicy('approval');
  // 申請人剛被升為工作區管理員：不能再送（直接建立就好）
  const gina = await join('吉娜');
  hooks.before = { re: /^INSERT INTO project_creation_requests\b/, run: async () => { ok(await call(boss.token, `/api/participants/${gina.id}/workspace-role`, 'PUT', { role: 'admin' }), '吉娜剛被升級'); } };
  is(await submit(gina, { name: '升級中申請' }), 403, 'REQUESTER_NOT_ELIGIBLE', '申請人剛升為管理員');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM project_creation_requests WHERE name = ?', '升級中申請'), 0);

  // ---------- 9) 被移出、停用：查不到；審核人照樣看得到 ----------
  const dReq = is(await submit(dan, { name: '丹尼的申請' }), 201, null, '丹尼送出');
  const eReq = is(await submit(eve, { name: '伊芙的申請' }), 201, null, '伊芙送出');
  ok(await call(boss.token, `/api/participants/${dan.id}/remove`, 'POST'), '移出丹尼');
  ok(await call(boss.token, `/api/participants/${eve.id}/disable`, 'POST'), '停用伊芙');
  for (const [p, r] of [[dan, dReq], [eve, eReq]]) {
    const one = await call(p.token, `/api/project-creation-requests/${r.id}`);
    assert.ok(one.status >= 400 && !JSON.stringify(one.body).includes('的申請'), `${p.id} 查不到單筆：${one.status} ${JSON.stringify(one.body)}`);
    const list = await call(p.token, '/api/project-creation-requests');
    assert.ok(list.status >= 400 && !JSON.stringify(list.body).includes('的申請'), `${p.id} 查不到列表：${list.status}`);
    const again = await call(p.token, '/api/project-creation-requests', 'POST', { requestId: r.requestId, name: r.name, reason: r.reason });
    assert.ok(again.status >= 400 && !JSON.stringify(again.body).includes('的申請'), `${p.id} 不能用 requestId 取得資料：${again.status}`);
    is(await call(boss.token, `/api/project-creation-requests/${r.id}`), 200, null, '審核人照樣看得到');
  }

  // ---------- 10) 資料表：CHECK 約束與索引（SQLite／Postgres 都要擋） ----------
  const ins = (o) => db.run(`INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, visibility, state, created_at, ended_at, ended_by, reject_reason, cancel_code, project_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, o.id, 'default', o.requester ?? 'u_x', o.rid ?? o.id, o.name ?? o.id, 'r', o.visibility ?? 'review', o.state, '2020-01-01T00:00:00.000Z',
    o.ended_at ?? null, o.ended_by ?? null, o.reject_reason ?? null, o.cancel_code ?? null, o.project_id ?? null);
  const T = '2020-01-02T00:00:00.000Z';
  const bad = {
    'pending 有結束時間': { state: 'pending', ended_at: T },
    'pending 有拒絕理由': { state: 'pending', reject_reason: 'x' },
    'approved 沒有專案': { state: 'approved', ended_at: T, ended_by: 'u_r' },
    'approved 沒有審核人': { state: 'approved', ended_at: T, project_id: 'p1' },
    'rejected 理由空白': { state: 'rejected', ended_at: T, ended_by: 'u_r', reject_reason: '   ' },
    'rejected 沒有理由': { state: 'rejected', ended_at: T, ended_by: 'u_r' },
    'rejected 有專案': { state: 'rejected', ended_at: T, ended_by: 'u_r', reject_reason: 'no', project_id: 'p2' },
    'withdrawn 不是本人': { state: 'withdrawn', ended_at: T, ended_by: 'u_other' },
    'withdrawn 沒有時間': { state: 'withdrawn', ended_by: 'u_x' },
    'cancelled 有人': { state: 'cancelled', ended_at: T, ended_by: 'u_r', cancel_code: 'policy_changed' },
    'cancelled 不認得的代碼': { state: 'cancelled', ended_at: T, cancel_code: 'expired' },
    'cancelled 沒有代碼': { state: 'cancelled', ended_at: T },
    '不認得的狀態': { state: 'draft' },
    '不認得的可見度': { state: 'pending', visibility: 'secret' },
  };
  let k = 0;
  for (const [label, o] of Object.entries(bad)) await assert.rejects(ins({ id: `chk_bad_${++k}`, ...o }), /CHECK|check constraint|23514/i, `CHECK 要擋：${label}`);
  const good = [
    { state: 'pending' },
    { state: 'approved', ended_at: T, ended_by: 'u_r', project_id: 'prj_good' },
    { state: 'rejected', ended_at: T, ended_by: 'u_r', reject_reason: '不需要' },
    { state: 'withdrawn', ended_at: T, ended_by: 'u_x' },
    ...['policy_changed', 'workspace_member_removed', 'workspace_member_left', 'account_disabled', 'restore_invalid'].map(c => ({ state: 'cancelled', ended_at: T, cancel_code: c })),
  ];
  for (const o of good) await ins({ id: `chk_ok_${++k}`, ...o });
  // 部分唯一索引：同一申請人同名只能有一份待審；終止狀態不算
  await ins({ id: 'uq_1', name: '同名', state: 'pending' });
  await assert.rejects(ins({ id: 'uq_2', name: '同名', state: 'pending' }), /UNIQUE|duplicate|23505/i, '同名待審');
  await ins({ id: 'uq_3', name: '同名', state: 'withdrawn', ended_at: T, ended_by: 'u_x' });
  await ins({ id: 'uq_4', name: '同名', state: 'pending', requester: 'u_y' });
  await assert.rejects(ins({ id: 'uq_5', rid: 'uq_1', name: '別名', state: 'pending' }), /UNIQUE|duplicate|23505/i, '同一申請人同一 requestId');
  await assert.rejects(ins({ id: 'uq_6', state: 'approved', ended_at: T, ended_by: 'u_r', project_id: 'prj_good' }), /UNIQUE|duplicate|23505/i, '同一個專案只對應一份申請');

  // ---------- 11) 唯一的狀態轉換、取消入口 ----------
  const at = new Date().toISOString();
  assert.throws(() => transitionStmts({ id: 'uq_1', to: 'pending', at }), /不能轉換/, '不能轉回 pending');
  assert.throws(() => transitionStmts({ id: 'uq_1', to: 'approved', at, by: 'u_r' }), /欄位不對/, '核准要有專案');
  assert.throws(() => transitionStmts({ id: 'uq_1', to: 'rejected', at, by: 'u_r', rejectReason: '  ' }), /欄位不對/, '拒絕要有理由');
  assert.throws(() => transitionStmts({ id: 'uq_1', to: 'cancelled', at, cancelCode: 'nope' }), /欄位不對/, '取消要有合法代碼');
  assert.throws(() => cancelStmts({ cancelCode: 'nope', at }), /不認得/);
  // 終止狀態不可逆：已撤回的不能再轉（交易內斷言擋下，整批回復）
  await assert.rejects(db.batch([lockWorkspaceStmt('default'), ...transitionStmts({ id: 'uq_3', to: 'rejected', at, by: 'u_r', rejectReason: 'x' })]), e => isAssertionFailure(e), '已撤回不能再拒絕');
  assert.equal((await db.get('SELECT state FROM project_creation_requests WHERE id = ?', 'uq_3')).state, 'withdrawn');
  await db.batch([lockWorkspaceStmt('default'), ...transitionStmts({ id: 'uq_1', to: 'rejected', at, by: 'u_r', rejectReason: '  不需要 ' })]);
  assert.deepEqual({ ...(await db.get('SELECT state, reject_reason, ended_by FROM project_creation_requests WHERE id = ?', 'uq_1')) }, { state: 'rejected', reject_reason: '不需要', ended_by: 'u_r' });
  // 取消：只動交易內實際待審的那幾份；數量用 pendingCountSql
  const [cs, ca] = pendingCountSql({ requesterId: 'u_y' });
  assert.equal(Number(Object.values(await db.get(cs, ...ca))[0]), 1);
  await db.batch(cancelStmts({ requesterId: 'u_y', cancelCode: 'workspace_member_left', at }));
  assert.deepEqual({ ...(await db.get('SELECT state, cancel_code, ended_by FROM project_creation_requests WHERE id = ?', 'uq_4')) }, { state: 'cancelled', cancel_code: 'workspace_member_left', ended_by: null });
  assert.equal((await db.get('SELECT state FROM project_creation_requests WHERE id = ?', 'uq_3')).state, 'withdrawn', '終止狀態不受影響');

  // ---------- 12) 暫時的啟用控制沒開：不能把政策設成 approval；已經是 approval 的照常可以切走 ----------
  {
    const { call: plain } = harness(db, BASE_CONFIG);
    is(await plain(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), 400, 'INVALID_REQUEST', '沒開啟用控制不能選 approval');
    assert.equal((await plain(boss.token, '/api/workspace/settings')).body.createProjects, 'approval', '已存的值照常讀得到');
    ok(await plain(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }), '可以切回只有管理員');
  }

  // ---------- 13) 申請資料表還沒建立（程式先部署）：申請 API 回 503，直接建立照常 ----------
  {
    const db2 = await openTestDb(path.join(dataDir, 'nopcr', 'switch.db'));
    dbs.push(db2);
    const { call: c2 } = harness(db2);
    const b2 = (await c2(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    const m2 = (await c2(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
    ok(await c2(b2.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
    await db2.run('DROP TABLE project_creation_requests');
    is(await c2(m2.token, '/api/project-creation-requests', 'POST', { requestId: 'r1', name: '空窗期', reason: 'x' }), 503, 'PROJECT_CREATION_REQUESTS_NOT_READY', '送出');
    is(await c2(m2.token, '/api/project-creation-requests'), 503, 'PROJECT_CREATION_REQUESTS_NOT_READY', '列表');
    is(await c2(m2.token, '/api/project-creation-requests/x'), 503, 'PROJECT_CREATION_REQUESTS_NOT_READY', '單筆');
    is(await c2(b2.token, '/api/projects', 'POST', { name: '空窗期直接建立' }), 201, null, '直接建立照常');
  }
  console.log('建立專案申請（送出、查看、撤回）測試通過');
} finally {
  for (const db of dbs) await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
