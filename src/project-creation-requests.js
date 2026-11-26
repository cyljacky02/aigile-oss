// 建立專案申請（docs/adr/0004、0005；GLOSSARY「成員與權限」：建立專案申請、申請人、審核人、撤回、取消）
// 申請不是專案：核准前專案不存在。內容送出後不可修改（要改就撤回重提）。
// 狀態：pending（待審核）→ approved（已核准）／rejected（已拒絕）／withdrawn（已撤回）／cancelled（已取消）。只有 pending 可以轉換，終止狀態不可逆。
//
// 這個模組負責申請的生命週期；權限判斷在權限模組（request_project_creation、see_own_project_creation_requests、
// withdraw_project_creation_request、review_project_creation_requests），建立專案在 src/project-create.js。
//
// 給之後的票接的地方（seam）：
//   transitionStmts({ id, to, at, by, rejectReason, cancelCode, projectId })：唯一的狀態轉換。斷言申請仍待審核，再改成終止狀態。
//     撤回（這裡）、核准與拒絕（#45）都走它；放進呼叫端那一批（第一句工作區列鎖之後）
//   cancelStmts({ workspaceId, requesterId?, cancelCode, at })：取消（系統依規則，不是使用者動作，沒有公開 API）。
//     政策切走、移出、離開、停用帳號（#46）、還原後檢查（#47）在自己的交易裡呼叫；pendingCountSql 給稽核的 countOf 與預覽數字
//   activeMemberCond／directCreateCond／policyCond／reviewerCond／pendingCond：交易內斷言的條件（核准要斷言申請人仍是有效成員、政策仍是 approval、審核人仍有管理權）
//   核准與拒絕（#45）：POST …/:id/approve、…/:id/reject；核准用 creation.create（src/project-create.js）在同一批建立專案
//   registerProjectCreationRequests 回傳的 visibleTo(v, me, row)、view(row, ...)：審核清單與單筆的審核人欄位（#45）沿用同一套可見範圍與輸出
//
// 交易（ADR 0005）：送出與撤回都在 writeInWorkspace（第一句工作區列鎖 → 不在還原中 → 斷言 → 寫入）；即時事件在提交後才發。
// 隱私：無權查看一律 404（不透露申請是否存在）；即時事件只發「請重新抓取」，不帶任何申請內容；通知只寫給審核人，內容最小化。
import { ensureStmt } from './write-order.js';
import { isUniqueConstraintViolation, isMissingTable } from './db-errors.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { CREATE_PROJECTS } from './workspace-settings.js';
import { CREATION_METHOD } from './project-create.js';
import { AUDIT_ACTION, AUDIT_SCOPE } from './audit.js';
import { holdsNow } from './project-identity.js';

export const PCR_TABLE = 'project_creation_requests';
export const PCR_STATE = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', WITHDRAWN: 'withdrawn', CANCELLED: 'cancelled' });
export const PCR_STATES = Object.freeze(Object.values(PCR_STATE));
// 取消原因代碼（系統取消；跟 migrations/015 的 CHECK 一致）
export const PCR_CANCEL_CODE = Object.freeze({
  POLICY_CHANGED: 'policy_changed', MEMBER_REMOVED: 'workspace_member_removed', MEMBER_LEFT: 'workspace_member_left',
  ACCOUNT_DISABLED: 'account_disabled', RESTORE_INVALID: 'restore_invalid',
});
export const PCR_CANCEL_CODES = Object.freeze(Object.values(PCR_CANCEL_CODE));
export const PCR_REASON_MAX = 200; // 申請原因、拒絕理由（去頭尾空白後 1～200 字，跟加入申請一樣）
export const PCR_REQUEST_ID_MAX = 128;
export const PCR_PAGE = Object.freeze({ DEFAULT: 50, MAX: 100 });
// 送出時通知審核人（account_notices 的 kind）；細節只有申請人名字
export const PCR_NOTICE_SUBMITTED = 'project_creation_request';
// 核准、拒絕時通知申請人（#45）；細節只有申請的名稱（申請人自己的資料）
export const PCR_NOTICE_APPROVED = 'project_creation_request_approved';
export const PCR_NOTICE_REJECTED = 'project_creation_request_rejected';
// 即時事件：只說「資料可能變了，請重新抓取」，不帶任何內容；事件名稱不帶業務語意（只推給相關的人）
export const LIVE_STALE = 'stale';

// ---------- 交易內斷言的條件（都寫成 EXISTS／NOT EXISTS，不會是 SQL NULL） ----------
// 政策仍是某個值
export const policyCond = (workspaceId = DEFAULT_WORKSPACE, value = CREATE_PROJECTS.APPROVAL) => ({ cond: 'EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND create_projects = ?)', args: [workspaceId, value] });
// 有效的人類工作區成員（啟用中、沒被移出、帳號沒停用）
export const activeMemberCond = (id, workspaceId = DEFAULT_WORKSPACE) => ({
  cond: `EXISTS (SELECT 1 FROM participants p WHERE p.id = ? AND p.kind = 'human' AND p.status = 'active' AND p.workspace_id = ? AND p.workspace_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.status != 'active'))`, args: [id, workspaceId] });
// 有直接建立權（工作區管理員或啟用中的平台管理員）：送申請時要「沒有」
export const directCreateCond = id => ({
  cond: `EXISTS (SELECT 1 FROM participants p WHERE p.id = ? AND (p.workspace_role = 'admin'
    OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.platform_role = 'admin' AND a.status = 'active')))`, args: [id] });
// 審核人（#45）：有效的人類，是這個工作區的工作區管理員，或帳號是啟用中的平台管理員（隱含權限）。核准、拒絕在交易內斷言
export const reviewerCond = (id, workspaceId = DEFAULT_WORKSPACE) => ({
  cond: `EXISTS (SELECT 1 FROM participants p WHERE p.id = ? AND p.kind = 'human' AND p.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.status != 'active')
    AND ((p.workspace_role = 'admin' AND p.workspace_id = ? AND p.workspace_status = 'active')
      OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.platform_role = 'admin' AND a.status = 'active')))`, args: [id, workspaceId] });
// 申請仍待審核
export const pendingCond = id => ({ cond: `EXISTS (SELECT 1 FROM ${PCR_TABLE} WHERE id = ? AND state = 'pending')`, args: [id] });
const ensure = ({ cond, args }) => ensureStmt(cond, args);
const ensureNot = ({ cond, args }) => ensureStmt(`NOT ${cond}`, args);

// ---------- 唯一的狀態轉換 ----------
// 每種終止狀態要帶的欄位（跟 CHECK 一致）；不合的是程式錯誤，直接丟
const TRANSITION = {
  [PCR_STATE.APPROVED]: t => t.by && t.projectId && !t.rejectReason && !t.cancelCode,
  [PCR_STATE.REJECTED]: t => t.by && String(t.rejectReason ?? '').trim() && !t.projectId && !t.cancelCode,
  [PCR_STATE.WITHDRAWN]: t => t.by && !t.projectId && !t.rejectReason && !t.cancelCode,
  [PCR_STATE.CANCELLED]: t => !t.by && PCR_CANCEL_CODES.includes(t.cancelCode) && !t.projectId && !t.rejectReason,
};
// 只有 pending 可以轉換：先斷言申請仍待審核（撞到別人先處理＝整批回復），再改狀態（WHERE 也限 pending，不會改到終止狀態）
export function transitionStmts({ id, to, at, by = null, rejectReason = null, cancelCode = null, projectId = null }) {
  if (!TRANSITION[to]) throw new Error(`建立專案申請：不能轉換成 ${to}（只有 pending 能轉成終止狀態）`);
  if (!at || !TRANSITION[to]({ by, rejectReason, cancelCode, projectId })) throw new Error(`建立專案申請：轉成 ${to} 的欄位不對`);
  return [
    ensureStmt(`EXISTS (SELECT 1 FROM ${PCR_TABLE} WHERE id = ? AND state = 'pending')`, [id]),
    [`UPDATE ${PCR_TABLE} SET state = ?, ended_at = ?, ended_by = ?, reject_reason = ?, cancel_code = ?, project_id = ? WHERE id = ? AND state = 'pending'`,
      [to, at, by, to === PCR_STATE.REJECTED ? String(rejectReason).trim() : null, cancelCode, projectId, id]],
  ];
}
// 取消（系統）：這個工作區（requesterId：只取消這位申請人的）交易內實際存在的待審申請。不通知、不寫稽核（數字記在觸發它的操作的稽核，用 pendingCountSql）
// workspaceId＝null：所有工作區（停用帳號；一定要給 requesterId）。第一階段一個帳號只有一個成員列（participant）；第二階段要改成帳號的所有成員列
function pendingWhere(workspaceId, requesterId) {
  if (workspaceId === null && !requesterId) throw new Error('建立專案申請：跨工作區取消一定要指定申請人');
  const where = [...(workspaceId === null ? [] : ['workspace_id = ?']), "state = 'pending'", ...(requesterId ? ['requester_id = ?'] : [])];
  return { where: where.join(' AND '), args: [...(workspaceId === null ? [] : [workspaceId]), ...(requesterId ? [requesterId] : [])] };
}
// 取消的那一句（where 一定要含 state = 'pending'：只動待審的）
function cancelWhereStmt(where, args, cancelCode, at) {
  if (!PCR_CANCEL_CODES.includes(cancelCode)) throw new Error(`建立專案申請：不認得的取消原因 ${cancelCode}`);
  if (!at) throw new Error('建立專案申請：取消要有時間');
  return [`UPDATE ${PCR_TABLE} SET state = 'cancelled', ended_at = ?, cancel_code = ? WHERE ${where}`, [at, cancelCode, ...args]];
}
export function cancelStmts({ workspaceId = DEFAULT_WORKSPACE, requesterId = null, cancelCode, at }) {
  const { where, args } = pendingWhere(workspaceId, requesterId);
  return [cancelWhereStmt(where, args, cancelCode, at)];
}

// ---------- 還原備份後的待審申請檢查（#47） ----------
// 每一份待審申請依固定順序檢查，第一個成立的就是取消原因（同一份資料每次還原得到相同原因）；都不成立的保留待審核。
// 條件都寫成 EXISTS／NOT EXISTS（不會是 SQL NULL）；用表名參照外層那一列（UPDATE 不用別名，SQLite／Postgres／D1 都能用）
const R = PCR_TABLE;
export const RESTORE_CHECKS = Object.freeze([
  // 1. 資料關聯：工作區不存在；申請人不存在、不是人類、不屬於這個工作區、或沒有對應的帳號
  { cancelCode: PCR_CANCEL_CODE.RESTORE_INVALID, cond: `(NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${R}.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = ${R}.requester_id AND p.kind = 'human' AND p.status != 'deleted' AND p.workspace_id = ${R}.workspace_id
      AND p.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id)))` },
  // 2. 政策：不是 approval（不認得或缺少的值當作 admins，一樣不是 approval）
  { cancelCode: PCR_CANCEL_CODE.POLICY_CHANGED, cond: `NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${R}.workspace_id AND w.create_projects = '${CREATE_PROJECTS.APPROVAL}')` },
  // 3. 成員資格：成員列或帳號停用
  { cancelCode: PCR_CANCEL_CODE.ACCOUNT_DISABLED, cond: `EXISTS (SELECT 1 FROM participants p WHERE p.id = ${R}.requester_id
    AND (p.status != 'active' OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.status != 'active')))` },
  // 4. 成員資格：不在工作區（已移出）
  { cancelCode: PCR_CANCEL_CODE.MEMBER_REMOVED, cond: `EXISTS (SELECT 1 FROM participants p WHERE p.id = ${R}.requester_id AND p.workspace_status != 'active')` },
]);
const staleWhere = `state = 'pending' AND (${RESTORE_CHECKS.map(c => c.cond).join(' OR ')})`;
// 這次要取消幾份（[sql, args]，回一列 n）：收尾在交易外先數，交易內再斷言數字沒變（見 restoreCheckStmts）
export const restoreStaleCountSql = () => [`SELECT COUNT(*) AS n FROM ${PCR_TABLE} WHERE ${staleWhere}`, []];
// 還原收尾的取消：先斷言交易內不再成立的待審申請剛好 expected 份（數字跟實際取消的一致），再依順序每個原因一句
// （前面的句子取消過的已經不是 pending，後面的句子不會再動到它）。所有工作區一起做；不通知、不寫稽核（數字記在 backup.restore）。
// 只動 pending：終止的申請（含已核准但專案已不存在的）原樣保留
export function restoreCheckStmts({ at, expected }) {
  if (!Number.isInteger(expected) || expected < 0) throw new Error('建立專案申請：還原檢查要給預期取消數');
  return [
    ensureStmt(`(SELECT COUNT(*) FROM ${PCR_TABLE} WHERE ${staleWhere}) = ?`, [expected]),
    ...RESTORE_CHECKS.map(c => cancelWhereStmt(`state = 'pending' AND ${c.cond}`, [], c.cancelCode, at)),
  ];
}

// 備份裡的一列申請合不合法（跟資料表的 CHECK、NOT NULL 一致）：回問題說明，合法回 null。
// 還原匯入時先檢查，不合法就整批不寫、回明確的格式錯誤（不修改資料、不繞過資料庫約束）
const filled = v => typeof v === 'string' && v.trim() !== '';
const none = v => v === null || v === undefined;
const ROW_SHAPE = {
  [PCR_STATE.PENDING]: r => none(r.ended_at) && none(r.ended_by) && none(r.project_id) && none(r.reject_reason) && none(r.cancel_code),
  [PCR_STATE.APPROVED]: r => filled(r.ended_at) && filled(r.ended_by) && filled(r.project_id) && none(r.reject_reason) && none(r.cancel_code),
  [PCR_STATE.REJECTED]: r => filled(r.ended_at) && filled(r.ended_by) && none(r.project_id) && filled(r.reject_reason) && none(r.cancel_code),
  [PCR_STATE.WITHDRAWN]: r => filled(r.ended_at) && filled(r.ended_by) && r.ended_by === r.requester_id && none(r.project_id) && none(r.reject_reason) && none(r.cancel_code),
  [PCR_STATE.CANCELLED]: r => filled(r.ended_at) && none(r.ended_by) && none(r.project_id) && none(r.reject_reason) && PCR_CANCEL_CODES.includes(r.cancel_code),
};
// 說明的句型放在表裡（英文字典整句比對，{0} 是欄位名稱或值）
const ROW_PROBLEM_MSG = {
  missing: '缺少必要欄位：{0}',
  state: '不認得的狀態：{0}',
  visibility: '不認得的可見度：{0}',
  shape: '狀態 {0} 的結束時間、處理人、專案、拒絕理由或取消原因不合',
};
const problem = (k, v) => ROW_PROBLEM_MSG[k].replace('{0}', String(v));
export function restoreRowProblem(r) {
  const missing = ['id', 'workspace_id', 'requester_id', 'request_id', 'name', 'reason', 'created_at'].filter(k => !filled(r[k]));
  if (missing.length) return problem('missing', missing.join(', '));
  if (!PCR_STATES.includes(r.state)) return problem('state', r.state ?? 'null');
  if (r.visibility !== undefined && !['open', 'review', 'private'].includes(r.visibility)) return problem('visibility', r.visibility);
  if (!ROW_SHAPE[r.state](r)) return problem('shape', r.state);
  return null;
}
// 待審申請的數量（[sql, args]；放在 cancelStmts 之前的稽核 countOf，或交易外的預覽）
export const pendingCountSql = ({ workspaceId = DEFAULT_WORKSPACE, requesterId = null } = {}) => { const { where, args } = pendingWhere(workspaceId, requesterId); return [`SELECT COUNT(*) FROM ${PCR_TABLE} WHERE ${where}`, args]; };
// 因政策改變而取消時通知申請人（#46）：交易內實際待審的申請人每人一則（同一人好幾份也只一則），內容最小化（不帶名稱、原因、數量）。
// 放在 cancelStmts 之前（之後就沒有待審的了）。noticeId：這次操作的前綴（每位申請人一列：前綴＋申請人 id）
export const PCR_NOTICE_CANCELLED = 'project_creation_request_cancelled';
export function cancelNoticeStmts({ workspaceId = DEFAULT_WORKSPACE, noticeId, now = Date.now() }) {
  const { where, args } = pendingWhere(workspaceId, null);
  return [[`INSERT INTO account_notices (id, participant_id, kind, detail, created_at)
    SELECT ? || requester_id, requester_id, ?, '', ? FROM ${PCR_TABLE} WHERE ${where} GROUP BY requester_id`, [`${noticeId}_`, PCR_NOTICE_CANCELLED, now, ...args]]];
}
// 申請資料表在不在（程式先部署、資料庫還沒升級時沒有）：沒有就不取消（也就沒有待審申請），觸發的操作照常。其他讀取錯誤照丟
export async function requestsTableReady(db) {
  try { await db.get(`SELECT 1 AS x FROM ${PCR_TABLE} LIMIT 1`); return true; } catch (e) { if (isMissingTable(e)) return false; throw e; }
}

// 申請內容的正規化（冪等比較用的就是這份）：name、reason、visibility、slug、code、statuses；「自動」的欄位是 null，不以預估值比較
const sameContent = (row, c) => row.name === c.name && row.reason === c.reason && row.visibility === c.visibility
  && (row.slug ?? null) === c.slug && (row.code ?? null) === c.code && (row.statuses_json ?? null) === c.statusesJson;

// 游標：最後一筆的 [created_at, id]（base64url）
const encodeCursor = r => btoa(JSON.stringify([r.created_at, r.id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor(raw) {
  try {
    const v = JSON.parse(atob(String(raw).replace(/-/g, '+').replace(/_/g, '/')));
    if (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'string')) return v;
  } catch {}
  return null;
}

// d：
//   route、db、ApiError、invalid、readJson、randId、nowIso、requireHuman、access、peopleMap
//   writeInWorkspace(list) → true｜false：第一句工作區列鎖 → 不在還原中 → list；斷言不成立回 false（core.js）
//   readSpec(body) → { name, visibility, slug｜null, code｜null, statuses｜null }：跟直接建立同一套驗證與正規化（core.js）
//   loadProjects()、projectInfo(id) → { id, name }｜null：專案還在（沒被刪除）時的資料（核准的申請顯示連結；#45 之後才會有）
//   liveTo(ids, type, data)：內建即時通道（只推給指定的人；沒有就不推）
//   creation：共用的建立專案邏輯（src/project-create.js），核准就是用它建立（#45）；auditLog：稽核紀錄（拒絕的 project_creation_request.reject）
export function registerProjectCreationRequests(d) {
  const { route, db, ApiError, invalid, readJson, randId, nowIso, requireHuman, access, peopleMap, writeInWorkspace, readSpec,
    loadProjects = async () => {}, projectInfo = () => null, liveTo = () => {}, workspaceId = DEFAULT_WORKSPACE, creation = null, auditLog = null } = d;
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這份建立專案申請');
  const notReady = () => new ApiError(503, 'PROJECT_CREATION_REQUESTS_NOT_READY', '建立專案申請還沒準備好（資料庫還沒升級），請稍後再試。', { retryAfter: 5 });
  const conflict = () => new ApiError(409, 'CONFLICT', '剛好有人同時在改同樣的資料，這次沒有存；請重新讀取後再試。');
  const ended = r => new ApiError(409, 'REQUEST_NOT_PENDING', '這份申請已經結束（不是待審核），不能再變更。', { state: r.state, ...(r.state === PCR_STATE.CANCELLED ? { cancelCode: r.cancel_code } : {}) }); // 帶目前的狀態與取消原因（呼叫者已經看得到這份申請）
  // 申請相關資料表還沒建立（程式先部署、資料庫還沒升級）：503，可以重試；直接建立專案照常
  const guarded = fn => async args => { try { return await fn(args); } catch (e) { if (isMissingTable(e)) throw notReady(); throw e; } };

  // 可見範圍：申請人本人（仍是有效的人類工作區成員），或這個工作區的審核人。其他人、AI 都看不到（呼叫端回 404）
  const visibleTo = (v, me, row) => !!row && row.workspace_id === workspaceId
    && (v.can(me, 'see_own_project_creation_requests', { target: { id: row.requester_id } }) || v.can(me, 'review_project_creation_requests', 'workspace'));
  // 輸出。結果專案：依呼叫者現行的專案權限決定給不給連結；看不到或已不存在只說「無法前往」
  function view(v, me, r) {
    let project = null;
    if (r.project_id) {
      const p = projectInfo(r.project_id);
      project = p && v.can(me, 'discover_project', { project: p.id }) ? { id: p.id, name: p.name, available: true } : { available: false };
    }
    let statuses = null;
    try { statuses = r.statuses_json ? JSON.parse(r.statuses_json) : null; } catch {}
    return { id: r.id, requestId: r.request_id, requesterId: r.requester_id, requesterName: v.people?.get(r.requester_id)?.name ?? null, name: r.name, reason: r.reason, visibility: r.visibility, slug: r.slug ?? null, code: r.code ?? null, statuses,
      state: r.state, createdAt: r.created_at, endedAt: r.ended_at ?? null, rejectReason: r.reject_reason ?? null, cancelCode: r.cancel_code ?? null, project,
      canWithdraw: r.state === PCR_STATE.PENDING && v.can(me, 'withdraw_project_creation_request', { target: { id: r.requester_id } }) };
  }
  const byId = id => db.get(`SELECT * FROM ${PCR_TABLE} WHERE id = ?`, String(id));
  const byRequestId = (requesterId, requestId) => db.get(`SELECT * FROM ${PCR_TABLE} WHERE workspace_id = ? AND requester_id = ? AND request_id = ?`, workspaceId, requesterId, requestId);
  // 提交後：叫申請人與目前的審核人重新抓取（不帶內容）。收件人照改完之後的成員資料
  async function poke(requesterId) { // 一位或好幾位申請人（陣列）
    const people = await peopleMap({});
    const v = access.view({ people });
    const ids = new Set([...[].concat(requesterId), ...v.admins().map(p => p.id), ...v.platformAdmins().map(p => p.id)]);
    liveTo([...ids], LIVE_STALE, {});
  }
  const pokeLater = requesterId => poke(requesterId).catch(e => console.error('建立專案申請的即時事件沒送出', e?.message));

  // 申請內容：跟直接建立同一套規則（readSpec），加上必填的申請原因；不收 Git repository、分支、初始 AI 或其他成員
  async function readContent(body) {
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId || requestId.length > PCR_REQUEST_ID_MAX) throw invalid(`requestId 為必填，長度 1～${PCR_REQUEST_ID_MAX}`);
    const reason = String(body.reason ?? '').trim();
    if (!reason || reason.length > PCR_REASON_MAX) throw invalid(`申請原因為必填，最多 ${PCR_REASON_MAX} 字`);
    const spec = await readSpec(body);
    return { requestId, reason, ...spec, statusesJson: spec.statuses ? JSON.stringify(spec.statuses) : null };
  }
  // 同一申請人、同一 requestId 已經有申請：內容相同回原本的（200，不再寫任何東西）；不同回 409。只要他現在還看得到自己的申請
  function replay(v, me, row, c) {
    if (!visibleTo(v, me, row)) throw notFound();
    if (!sameContent(row, c)) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同 requestId 已用於不同內容');
    return { __status: 200, duplicate: true, ...view(v, me, row) };
  }

  // 送出申請：201；冪等重送 200；同名待審 409（資料庫的部分唯一索引）
  route('POST', '/api/project-creation-requests', guarded(async ({ ctx, me, req }) => {
    requireHuman(me);
    const c = await readContent(await readJson(req));
    const prior = await byRequestId(me.id, c.requestId);
    if (prior) return replay(await access.load(ctx), me, prior, c);
    const v = await access.check(ctx, me, 'request_project_creation', 'workspace');
    const id = randId('pcr'), at = nowIso();
    const detail = JSON.stringify({ a: String(me.name || '').slice(0, 80) });
    let done;
    try {
      // 第一句工作區列鎖（跟政策切換排隊）；交易內確認政策仍是 approval、申請人仍有資格，才寫申請與給審核人的通知
      done = await writeInWorkspace([
        ensure(policyCond(workspaceId)), ensure(activeMemberCond(me.id, workspaceId)), ensureNot(directCreateCond(me.id)),
        [`INSERT INTO ${PCR_TABLE} (id, workspace_id, requester_id, request_id, name, reason, visibility, slug, code, statuses_json, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, workspaceId, me.id, c.requestId, c.name, c.reason, c.visibility, c.slug, c.code, c.statusesJson, PCR_STATE.PENDING, at]],
        // 審核人＝這個工作區有效的明確工作區管理員＋有效的平台管理員（交易內的資料；每人一列＝同一人只通知一次），不通知申請人
        [`INSERT INTO account_notices (id, participant_id, kind, detail, created_at)
          SELECT ? || p.id, p.id, ?, ?, ? FROM participants p
          WHERE p.kind = 'human' AND p.status = 'active' AND p.id != ?
            AND ((p.workspace_role = 'admin' AND p.workspace_id = ? AND p.workspace_status = 'active')
              OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.platform_role = 'admin' AND a.status = 'active'))`,
          [`ntc_${id}_`, PCR_NOTICE_SUBMITTED, detail, Date.now(), me.id, workspaceId]],
      ]);
    } catch (e) {
      const sameKey = isUniqueConstraintViolation(e, { constraint: 'idx_pcr_request', columns: [`${PCR_TABLE}.workspace_id`, `${PCR_TABLE}.requester_id`, `${PCR_TABLE}.request_id`] });
      const sameName = isUniqueConstraintViolation(e, { constraint: 'idx_pcr_pending_name', columns: [`${PCR_TABLE}.workspace_id`, `${PCR_TABLE}.requester_id`, `${PCR_TABLE}.name`] });
      // 同一 requestId 同時送了兩次：另一個先寫入了。兩個索引可能同時撞到（SQLite 只報第一個），先看同一 requestId 的申請在不在
      if (sameKey || sameName) {
        const again = await byRequestId(me.id, c.requestId);
        if (again) return replay(await access.load(ctx), me, again, c);
      }
      if (sameName)
        throw new ApiError(409, 'DUPLICATE_PENDING_REQUEST', `你已經有一份「${c.name}」的建立專案申請在等審核；要改內容請先撤回再重送。`);
      throw e;
    }
    if (!done) {
      // 斷言沒過：用新鮮資料判斷原因（只用來產生回應）
      const ws = await db.get('SELECT create_projects FROM workspaces WHERE id = ?', workspaceId);
      if (ws?.create_projects !== CREATE_PROJECTS.APPROVAL) throw new ApiError(403, 'PROJECT_CREATION_REQUESTS_CLOSED', '工作區政策目前不是「成員申請，管理員核准」，不收建立專案申請。');
      const eligible = (await db.get(`SELECT 1 AS x WHERE ${activeMemberCond(me.id, workspaceId).cond}`, me.id, workspaceId)) && !(await db.get(`SELECT 1 AS x WHERE ${directCreateCond(me.id).cond}`, me.id));
      if (!eligible) throw new ApiError(403, 'REQUESTER_NOT_ELIGIBLE', '你目前不能送建立專案申請（可能已經可以直接建立專案，或已不是有效的工作區成員）。');
      throw conflict();
    }
    pokeLater(me.id);
    return { __status: 201, ...view(v, me, await byId(id)) };
  }));

  // 列表：scope=mine＝自己的申請（新的在前）；游標分頁（預設 50、最多 100）。
  // scope=review＝審核人看這個工作區全部的申請（#45），另外回準確的待審總數 pendingTotal（不用載入的筆數推算）
  const SCOPES = {
    mine: async (ctx, me) => {
      const v = await access.check(ctx, me, 'see_own_project_creation_requests', { target: me });
      return { v, where: 'workspace_id = ? AND requester_id = ?', args: [workspaceId, me.id] };
    },
    review: async (ctx, me) => {
      const v = await access.check(ctx, me, 'review_project_creation_requests', 'workspace');
      return { v, where: 'workspace_id = ?', args: [workspaceId], pendingTotal: true };
    },
  };
  route('GET', '/api/project-creation-requests', guarded(async ({ ctx, me, url }) => {
    requireHuman(me);
    const q = url.searchParams;
    const scope = SCOPES[q.get('scope') || 'mine'];
    if (!scope) throw invalid('scope 只能是 mine 或 review');
    const state = q.get('state') || null;
    if (state && !PCR_STATES.includes(state)) throw invalid('state 只能是 pending、approved、rejected、withdrawn、cancelled');
    const raw = q.get('limit');
    const limit = raw === null || raw === '' ? PCR_PAGE.DEFAULT : Math.trunc(Number(raw));
    if (!Number.isFinite(limit) || limit < 1) throw invalid(`limit 需為 1～${PCR_PAGE.MAX}`);
    const take = Math.min(limit, PCR_PAGE.MAX);
    const cur = q.get('cursor') ? decodeCursor(q.get('cursor')) : null;
    if (q.get('cursor') && !cur) throw invalid('cursor 不對（請用上一頁回傳的 nextCursor）');
    const { v, where, args, pendingTotal } = await scope(ctx, me);
    await loadProjects();
    const rows = await db.all(`SELECT * FROM ${PCR_TABLE} WHERE ${where}${state ? ' AND state = ?' : ''}${cur ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`, ...args, ...(state ? [state] : []), ...(cur ? [cur[0], cur[0], cur[1]] : []), take + 1);
    const page = rows.slice(0, take);
    const out = { items: page.map(r => view(v, me, r)), nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null };
    if (pendingTotal) { const [sql, a] = pendingCountSql({ workspaceId }); out.pendingTotal = Number(Object.values(await db.get(sql, ...a))[0]) || 0; }
    return out;
  }));

  // 單筆：申請人本人或審核人；其他人（含 AI）一律 404。
  // 審核人另外得到 review：自己能不能核准或拒絕；待審核的再加自動網址英文名與代號的預估值、目前衝突的欄位（只說哪個欄位，不透露被哪個專案占用）
  route('GET', '/api/project-creation-requests/:id', guarded(async ({ ctx, me, params }) => {
    const row = await byId(params.id);
    const v = await access.load(ctx, { fresh: true });
    if (!visibleTo(v, me, row)) throw notFound();
    await loadProjects();
    const out = view(v, me, row);
    if (v.can(me, 'review_project_creation_requests', 'workspace')) {
      const pending = row.state === PCR_STATE.PENDING;
      out.review = { canApprove: pending && v.can(me, 'approve_project_creation_request', 'workspace'), canReject: pending && v.can(me, 'reject_project_creation_request', 'workspace') };
      if (pending && creation) {
        const p = await creation.preview(specOf(row));
        Object.assign(out.review, { preview: { slug: p.slug, code: p.code, slugEstimated: p.slugEstimated, codeEstimated: p.codeEstimated }, conflicts: p.conflicts });
      }
    }
    return out;
  }));

  // ---------- 核准與拒絕（#45） ----------
  const notReviewer = () => new ApiError(403, 'NOT_REVIEWER', '只有工作區管理員或平台管理員能審核建立專案申請。');
  const policyChanged = () => new ApiError(409, 'POLICY_CHANGED', '工作區政策已經不是「成員申請，管理員核准」，不能核准這份申請。');
  const requesterGone = () => new ApiError(409, 'REQUESTER_NOT_ELIGIBLE', '申請人已經不是有效的工作區成員（可能已被移出或帳號已停用），不能核准。');
  const auditNotReady = () => new ApiError(503, 'AUDIT_NOT_READY', '稽核紀錄還沒準備好（資料庫還沒升級），這次沒有處理；請稍後再試。', { retryAfter: 5 });
  // 名稱或指定的識別碼被占用：409，只說是哪個欄位（field），不說被哪個專案占用、也不給建議值（核准不能改申請內容）
  const TAKEN = {
    NAME_TAKEN: ['name', '已有同名的專案，這份申請暫時不能核准；可以附理由拒絕，或等申請人撤回重提。'],
    SLUG_TAKEN: ['slug', '申請指定的網址英文名已經有專案在用，這份申請暫時不能核准；可以附理由拒絕，或等申請人撤回重提。'],
    CODE_TAKEN: ['code', '申請指定的專案代號已經有專案在用（或是舊代號），這份申請暫時不能核准；可以附理由拒絕，或等申請人撤回重提。'],
  };
  const taken = e => new ApiError(409, e.code, TAKEN[e.code][1], { field: TAKEN[e.code][0] });
  // 另一位審核人剛好先核准了（不是錯誤：回原本的結果）
  class ApprovedMeanwhile { constructor(row) { this.row = row; } }
  const holds = c => holdsNow(db, c);
  function specOf(row) {
    let statuses = null;
    try { statuses = row.statuses_json ? JSON.parse(row.statuses_json) : null; } catch {}
    return { name: row.name, visibility: row.visibility, slug: row.slug ?? null, code: row.code ?? null, statuses };
  }
  // 呼叫者還能不能審核（新鮮資料，不用快取）：不能→還看得到（是申請人本人）403、看不到 404
  async function callerBlocked(me, row) {
    if (await holds(reviewerCond(me.id, workspaceId))) return null;
    const own = !!row && row.requester_id === me.id && await holds(activeMemberCond(me.id, workspaceId));
    return own ? notReviewer() : notFound();
  }
  // 核准的前提（規格 (a)–(d)）用新鮮資料判斷：先確認呼叫者的權限，再看申請狀態、政策、申請人資格。都成立回 null
  // 交易前用來給明確的錯誤；交易內斷言沒過時（explain）只用來產生回應。保證靠交易內的斷言
  async function approvalBlocked(me, id) {
    const now = await byId(id);
    const who = await callerBlocked(me, now);
    if (who) return who;
    if (!now || now.workspace_id !== workspaceId) return notFound();
    if (now.state === PCR_STATE.APPROVED) return new ApprovedMeanwhile(now);
    if (now.state !== PCR_STATE.PENDING) return ended(now);
    if (!(await holds(policyCond(workspaceId)))) return policyChanged();
    if (!(await holds(activeMemberCond(now.requester_id, workspaceId)))) return requesterGone();
    return null;
  }
  // 已核准：回原本的結果（200，不再寫任何東西）。結果專案依呼叫者現行的專案權限（專案後來封存、刪除、清除也不重建）
  async function approvedResult(ctx, me, row, duplicate) {
    await loadProjects(true); // 專案可能是別份程式剛建的
    const v = await access.load(ctx, { fresh: true });
    return { __status: 200, duplicate, ...view(v, me, row) };
  }
  const notice = (requesterId, kind, row) => ['INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,?,?,?)',
    [randId('ntc'), requesterId, kind, JSON.stringify({ n: String(row.name).slice(0, 40) }), Date.now()]];

  // 核准並建立：用共用的建立專案邏輯（受益人＝申請人、執行者＝審核人、建立方式＝approved_request）。
  // 同一批（第一句工作區列鎖）：斷言 (a) 仍待審核 (b) 審核人仍有管理權 (c) 申請人仍是有效成員 (d) 政策仍是 approval (e) 名稱與識別碼沒被占用
  // → 專案、申請人的專案管理員身分、project.create 稽核（必要：稽核還沒就緒 503）、申請轉為已核准、給申請人的通知。審核人不成為專案成員。
  // 自動產生的識別碼因競態被用掉：建立模組重算重試（每次整批重新斷言 (a)–(e)）
  route('POST', '/api/project-creation-requests/:id/approve', guarded(async ({ ctx, me, params }) => {
    const row = await byId(params.id);
    const v = await access.load(ctx, { fresh: true });
    if (!visibleTo(v, me, row)) throw notFound();
    if (!v.can(me, 'approve_project_creation_request', 'workspace')) throw notReviewer();
    // 冪等：合法的審核人對已核准的申請再核准，回原本的結果（不重新檢查政策或申請人資格）
    if (row.state === PCR_STATE.APPROVED) return approvedResult(ctx, me, row, true);
    if (row.state !== PCR_STATE.PENDING) throw ended(row);
    try {
      const why = await approvalBlocked(me, row.id);
      if (why) throw why;
      const requester = await db.get('SELECT id, name FROM participants WHERE id = ?', row.requester_id);
      if (!requester) throw requesterGone();
      await creation.create({ actor: me, beneficiary: requester, method: CREATION_METHOD.APPROVED_REQUEST, requestId: row.id, spec: specOf(row), workspaceId,
        guards: [ensure(pendingCond(row.id)), ensure(reviewerCond(me.id, workspaceId)), ensure(activeMemberCond(row.requester_id, workspaceId)), ensure(policyCond(workspaceId))],
        extra: ({ id, at }) => [...transitionStmts({ id: row.id, to: PCR_STATE.APPROVED, at, by: me.id, projectId: id }), notice(row.requester_id, PCR_NOTICE_APPROVED, row)],
        explain: () => approvalBlocked(me, row.id) });
    } catch (e) {
      if (e instanceof ApprovedMeanwhile) return approvedResult(ctx, me, e.row, true); // 另一位審核人同時核准、先完成
      if (e instanceof ApiError && TAKEN[e.code]) throw taken(e);
      throw e;
    }
    pokeLater(row.requester_id);
    return approvedResult(ctx, me, await byId(row.id), false);
  }));

  // 拒絕：理由必填（1～200 字）。同一批（第一句工作區列鎖）斷言仍待審核、審核人仍有管理權 → 申請轉為已拒絕、
  // project_creation_request.reject 稽核（必要：稽核還沒就緒 503）、給申請人的通知
  route('POST', '/api/project-creation-requests/:id/reject', guarded(async ({ ctx, me, params, req }) => {
    const row = await byId(params.id);
    const v = await access.load(ctx, { fresh: true });
    if (!visibleTo(v, me, row)) throw notFound();
    if (!v.can(me, 'reject_project_creation_request', 'workspace')) throw notReviewer();
    const reason = String((await readJson(req)).reason ?? '').trim();
    if (!reason || reason.length > PCR_REASON_MAX) throw invalid(`拒絕理由為必填，最多 ${PCR_REASON_MAX} 字`);
    if (row.state !== PCR_STATE.PENDING) throw ended(row);
    const requester = await db.get('SELECT id, name FROM participants WHERE id = ?', row.requester_id);
    const who = { id: row.requester_id, name: requester?.name ?? '' };
    const audit = auditLog?.stmt({ actor: me, action: AUDIT_ACTION.PROJECT_CREATION_REQUEST_REJECT, scope: AUDIT_SCOPE.WORKSPACE, workspaceId,
      target: { kind: 'participant', ...who }, detail: { requestId: row.id, requester: who } });
    if (!audit) throw auditNotReady();
    const done = await writeInWorkspace([
      ensure(reviewerCond(me.id, workspaceId)),
      ...transitionStmts({ id: row.id, to: PCR_STATE.REJECTED, at: nowIso(), by: me.id, rejectReason: reason }),
      audit, notice(row.requester_id, PCR_NOTICE_REJECTED, row),
    ]);
    if (!done) {
      // 用新鮮資料判斷：先看呼叫者的權限，再看申請狀態；判斷不出回一般的 409
      const now = await byId(row.id);
      const why = await callerBlocked(me, now);
      if (why) throw why;
      if (now && now.state !== PCR_STATE.PENDING) throw ended(now);
      throw conflict();
    }
    pokeLater(row.requester_id);
    await loadProjects();
    return view(await access.load(ctx, { fresh: true }), me, await byId(row.id));
  }));

  // 撤回：申請人本人；交易內斷言仍待審核、操作者仍是有效成員。不通知任何人、不寫稽核（歷史在申請本身）
  route('POST', '/api/project-creation-requests/:id/withdraw', guarded(async ({ ctx, me, params }) => {
    const row = await byId(params.id);
    const v = await access.load(ctx, { fresh: true });
    if (!visibleTo(v, me, row)) throw notFound();
    await access.check(ctx, me, 'withdraw_project_creation_request', { target: { id: row.requester_id } });
    if (row.state !== PCR_STATE.PENDING) throw ended(row);
    const at = nowIso();
    const done = await writeInWorkspace([
      ensure(activeMemberCond(me.id, workspaceId)), ensureStmt(`EXISTS (SELECT 1 FROM ${PCR_TABLE} WHERE id = ? AND requester_id = ?)`, [row.id, me.id]),
      ...transitionStmts({ id: row.id, to: PCR_STATE.WITHDRAWN, at, by: me.id }),
    ]);
    if (!done) {
      const now = await byId(row.id);
      if (now && now.state !== PCR_STATE.PENDING) throw ended(now);
      throw conflict();
    }
    pokeLater(row.requester_id);
    return view(v, me, await byId(row.id));
  }));

  // pokeLater(ids)：系統取消（#46）提交後叫這些申請人與目前的審核人重新抓取
  return { visibleTo, view, transitionStmts, cancelStmts, pendingCountSql, pokeLater: ids => pokeLater([...new Set(ids)]) };
}
