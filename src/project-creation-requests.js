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
//   activeMemberCond／directCreateCond／policyCond：交易內斷言的條件（核准要斷言申請人仍是有效成員、政策仍是 approval）
//   registerProjectCreationRequests 回傳的 visibleTo(v, me, row)、view(row, ...)：審核清單與單筆的審核人欄位（#45）沿用同一套可見範圍與輸出
//
// 交易（ADR 0005）：送出與撤回都在 writeInWorkspace（第一句工作區列鎖 → 不在還原中 → 斷言 → 寫入）；即時事件在提交後才發。
// 隱私：無權查看一律 404（不透露申請是否存在）；即時事件只發「請重新抓取」，不帶任何申請內容；通知只寫給審核人，內容最小化。
import { ensureStmt } from './write-order.js';
import { isUniqueConstraintViolation, isMissingTable } from './db-errors.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { CREATE_PROJECTS } from './workspace-settings.js';

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
const pendingWhere = (workspaceId, requesterId) => ({ where: `workspace_id = ? AND state = 'pending'${requesterId ? ' AND requester_id = ?' : ''}`, args: requesterId ? [workspaceId, requesterId] : [workspaceId] });
export function cancelStmts({ workspaceId = DEFAULT_WORKSPACE, requesterId = null, cancelCode, at }) {
  if (!PCR_CANCEL_CODES.includes(cancelCode)) throw new Error(`建立專案申請：不認得的取消原因 ${cancelCode}`);
  if (!at) throw new Error('建立專案申請：取消要有時間');
  const { where, args } = pendingWhere(workspaceId, requesterId);
  return [[`UPDATE ${PCR_TABLE} SET state = 'cancelled', ended_at = ?, cancel_code = ? WHERE ${where}`, [at, cancelCode, ...args]]];
}
// 待審申請的數量（[sql, args]；放在 cancelStmts 之前的稽核 countOf，或交易外的預覽）
export const pendingCountSql = ({ workspaceId = DEFAULT_WORKSPACE, requesterId = null } = {}) => { const { where, args } = pendingWhere(workspaceId, requesterId); return [`SELECT COUNT(*) FROM ${PCR_TABLE} WHERE ${where}`, args]; };

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
export function registerProjectCreationRequests(d) {
  const { route, db, ApiError, invalid, readJson, randId, nowIso, requireHuman, access, peopleMap, writeInWorkspace, readSpec,
    loadProjects = async () => {}, projectInfo = () => null, liveTo = () => {}, workspaceId = DEFAULT_WORKSPACE } = d;
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這份建立專案申請');
  const notReady = () => new ApiError(503, 'PROJECT_CREATION_REQUESTS_NOT_READY', '建立專案申請還沒準備好（資料庫還沒升級），請稍後再試。', { retryAfter: 5 });
  const conflict = () => new ApiError(409, 'CONFLICT', '剛好有人同時在改同樣的資料，這次沒有存；請重新讀取後再試。');
  const ended = r => new ApiError(409, 'REQUEST_NOT_PENDING', '這份申請已經結束（不是待審核），不能再變更。', { state: r.state });
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
    return { id: r.id, requestId: r.request_id, requesterId: r.requester_id, name: r.name, reason: r.reason, visibility: r.visibility, slug: r.slug ?? null, code: r.code ?? null, statuses,
      state: r.state, createdAt: r.created_at, endedAt: r.ended_at ?? null, rejectReason: r.reject_reason ?? null, cancelCode: r.cancel_code ?? null, project,
      canWithdraw: r.state === PCR_STATE.PENDING && v.can(me, 'withdraw_project_creation_request', { target: { id: r.requester_id } }) };
  }
  const byId = id => db.get(`SELECT * FROM ${PCR_TABLE} WHERE id = ?`, String(id));
  const byRequestId = (requesterId, requestId) => db.get(`SELECT * FROM ${PCR_TABLE} WHERE workspace_id = ? AND requester_id = ? AND request_id = ?`, workspaceId, requesterId, requestId);
  // 提交後：叫申請人與目前的審核人重新抓取（不帶內容）。收件人照改完之後的成員資料
  async function poke(requesterId) {
    const people = await peopleMap({});
    const v = access.view({ people });
    const ids = new Set([requesterId, ...v.admins().map(p => p.id), ...v.platformAdmins().map(p => p.id)]);
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

  // 列表：scope=mine＝自己的申請（新的在前）；游標分頁（預設 50、最多 100）。scope=review（審核人看全部）在 #45
  const SCOPES = {
    mine: async (ctx, me) => {
      const v = await access.check(ctx, me, 'see_own_project_creation_requests', { target: me });
      return { v, where: 'workspace_id = ? AND requester_id = ?', args: [workspaceId, me.id] };
    },
  };
  route('GET', '/api/project-creation-requests', guarded(async ({ ctx, me, url }) => {
    requireHuman(me);
    const q = url.searchParams;
    const scope = SCOPES[q.get('scope') || 'mine'];
    if (!scope) throw invalid('scope 只能是 mine');
    const state = q.get('state') || null;
    if (state && !PCR_STATES.includes(state)) throw invalid('state 只能是 pending、approved、rejected、withdrawn、cancelled');
    const raw = q.get('limit');
    const limit = raw === null || raw === '' ? PCR_PAGE.DEFAULT : Math.trunc(Number(raw));
    if (!Number.isFinite(limit) || limit < 1) throw invalid(`limit 需為 1～${PCR_PAGE.MAX}`);
    const take = Math.min(limit, PCR_PAGE.MAX);
    const cur = q.get('cursor') ? decodeCursor(q.get('cursor')) : null;
    if (q.get('cursor') && !cur) throw invalid('cursor 不對（請用上一頁回傳的 nextCursor）');
    const { v, where, args } = await scope(ctx, me);
    await loadProjects();
    const rows = await db.all(`SELECT * FROM ${PCR_TABLE} WHERE ${where}${state ? ' AND state = ?' : ''}${cur ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`, ...args, ...(state ? [state] : []), ...(cur ? [cur[0], cur[0], cur[1]] : []), take + 1);
    const page = rows.slice(0, take);
    return { items: page.map(r => view(v, me, r)), nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null };
  }));

  // 單筆：申請人本人或審核人；其他人（含 AI）一律 404。審核人額外的欄位（預估識別碼、衝突、能否核准）在 #45
  route('GET', '/api/project-creation-requests/:id', guarded(async ({ ctx, me, params }) => {
    const row = await byId(params.id);
    const v = await access.load(ctx, { fresh: true });
    if (!visibleTo(v, me, row)) throw notFound();
    await loadProjects();
    return view(v, me, row);
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

  return { visibleTo, view, transitionStmts, cancelStmts, pendingCountSql };
}
