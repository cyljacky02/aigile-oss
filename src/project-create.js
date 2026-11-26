// 建立專案（ADR 0004、0005；GLOSSARY「成員與權限」）：直接建立、核准建立、新站預設專案、示範資料共用同一套建立邏輯。
// 這裡只組出「一整批寫入」與它的重試、失敗判斷；不發 HTTP、不模擬管理員身分、沒有跳過授權的旗標：能不能建立由呼叫端先用權限模組檢查，
// 呼叫端自己的前提（例：申請仍待審核、審核人仍有管理權）以 guards 放進同一批，在交易內斷言。
//
// 一批的內容（第一句工作區列鎖、不在還原中、識別碼已正規化由 write 加；見 src/write-order.js）：
//   呼叫端的 guards → 名稱、網址英文名、代號沒被用掉的斷言 → 專案（含可見度）→ 專案異動紀錄 → 看板狀態（沒指定＝預設狀態組）
//   → 網址英文名與代號 → 受益人的專案管理員成員資格（只新增這一筆，不覆寫他其他專案的成員資格）→ project.create 稽核 → 呼叫端的 extra 寫入
//
// 介面（core.js 建一個，傳給需要的地方）：
//   creation.create({ actor, beneficiary, method, requestId?, spec, guards?, extra?, explain?, workspaceId? }) → { id, name, slug, code, visibility }
//     actor：執行者（participant 列或 { kind: 'account', id, name }）；beneficiary：成為唯一初始專案管理員的人（participant 列）
//     method：CREATION_METHOD.DIRECT（直接建立，beneficiary＝actor）或 APPROVED_REQUEST（核准建立，beneficiary＝申請人、actor＝審核人，帶 requestId）
//     spec：已驗證的內容 { name, visibility, slug｜null（自動）, code｜null（自動）, statuses｜null（預設） }
//     guards：呼叫端的交易內斷言（ensureStmt），放在所有寫入之前；extra({ id, at, slug, code })：同一批的其他寫入（例：申請轉為已核准、通知）
//     explain()：斷言沒過時先問呼叫端「是不是你的前提不成立」（用新鮮資料），回 ApiError 就丟它；回 null 再判斷名稱與識別碼
//     自動產生的網址英文名或代號因競態被用掉：重讀重算整批重試（次數有限）；指定的值被用掉、同名：409，不改值
//   creation.stmts({ id, at, actor, beneficiary, method, requestId, spec: { name, visibility, slug, code, statuses }, eventText? }) → 這一批的斷言與寫入（不含鎖）
//     給自己管寫入與重試的呼叫端用（新站預設專案、示範資料）
//   creation.preview({ name, slug|null, code|null }) → { slug, code, slugEstimated, codeEstimated, conflicts }：審核畫面的預估值與衝突欄位
import { ensureStmt } from './write-order.js';
import { slugFreeCond, codeFreeCond, ensureCond, holdsNow } from './project-identity.js';
import { notDisputed, routeToken } from './project-identity-claims.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { AUDIT_ACTION, AUDIT_SCOPE } from './audit.js';
import { PROJECT_VISIBILITIES } from './access.js';
import { DEFAULT_STATUSES } from './statuses.js';

// 建立方式（記在 project.create 稽核的 detail.method）
export const CREATION_METHOD = Object.freeze({
  DIRECT: 'direct', // 直接建立（POST /api/projects）
  APPROVED_REQUEST: 'approved_request', // 核准建立專案申請
  FIRST_RUN: 'first_run', // 新站第一次啟動，系統自動建立的預設專案
  DEMO: 'demo', // 載入示範資料
});
export const DEFAULT_VISIBILITY = 'review';
// 可見度（選填）：沒給＝審核；不認得的值 400
export function readVisibility(raw, invalid) {
  if (raw === undefined || raw === null) return DEFAULT_VISIBILITY;
  if (!PROJECT_VISIBILITIES.includes(raw)) throw invalid('visibility 需為 open（開放）、review（審核）或 private（私人）');
  return raw;
}
// 核准建立的稽核一定要寫成（稽核表還沒建立時不核准）；直接建立、預設專案、示範資料在稽核表還沒建立的升級空窗期照常（不寫稽核）
const AUDIT_REQUIRED = new Set([CREATION_METHOD.APPROVED_REQUEST]);
const IDENTITY_TRIES = 3; // 自動產生的值最多試幾次

// deps：
//   db、randId、nowIso、ApiError、auditLog、membership、projEvent
//   nameFreeCond(name, id, workspaceId) → { cond, args }：沒有別的未封存、未刪除專案用這個名稱
//   write(stmts) → true｜false：工作區列鎖 → 不在還原中 → 已正規化 → stmts；斷言不成立回 false（core.js 的 writeIdentity）
//   names：讀現況、產生候選值與友善的錯誤（core.js 的專案快取與識別碼規則）
//     refresh()、nameInUse(name, workspaceId)、usedSlugs() → Set、autoSlug(name, used)、autoCode(slug)、
//     checkCode(code, actor)（被用掉丟 CODE_TAKEN）、slugTaken(slug, used) → ApiError、nameWriteFailed(id, name, workspaceId) → ApiError、afterWrite()
export function createProjectCreation({ db, randId, nowIso, ApiError, auditLog, membership, projEvent, nameFreeCond, write, names }) {
  const auditNotReady = () => new ApiError(503, 'AUDIT_NOT_READY', '稽核紀錄還沒準備好（資料庫還沒升級），這次沒有建立；請稍後再試。', { retryAfter: 5 });

  function stmts({ id, at, actor = null, beneficiary = null, method, requestId = null, spec, eventText = null, workspaceId = DEFAULT_WORKSPACE }) {
    const { name, visibility = DEFAULT_VISIBILITY, slug, code, statuses = null } = spec;
    const participantActorId = actor?.kind === 'account' ? null : actor?.id ?? 'system';
    const audit = auditLog.stmt({ actor, action: AUDIT_ACTION.PROJECT_CREATE, scope: AUDIT_SCOPE.PROJECT, workspaceId, project: { id, name }, target: { kind: 'project', id, name }, // 稽核時間＝現在（示範專案的 created_at 是假的過去時間）
      detail: { method, ...(requestId ? { requestId } : {}), ...(method === CREATION_METHOD.APPROVED_REQUEST && beneficiary ? { requester: { id: beneficiary.id, name: beneficiary.name } } : {}), code, slug, visibility } });
    if (!audit && AUDIT_REQUIRED.has(method)) throw auditNotReady();
    const nf = nameFreeCond(name, id, workspaceId);
    return [
      ensureStmt(nf.cond, nf.args), ensureCond(slugFreeCond(slug, id)), ensureCond(codeFreeCond(code, id)),
      ensureStmt(notDisputed('slug'), [routeToken(id)]), // 舊網址也可以用專案 ID 開啟
      ['INSERT INTO projects (id, name, archived, workspace_id, created_by, created_at, visibility) VALUES (?,?,0,?,?,?,?)', [id, name, workspaceId, participantActorId, at, visibility]],
      projEvent(id, participantActorId, eventText ?? `${actor?.name ?? '系統'} 建立專案`, at),
      // 看板狀態跟專案同一批：沒指定就寫預設狀態組。每個狀態一句單列 INSERT（D1 一個複合 SELECT 最多 5 段，不用 UNION ALL）
      ...(statuses || DEFAULT_STATUSES).map((st, i) => ['INSERT INTO project_statuses (project, name, category, position, color) VALUES (?,?,?,?,?)', [id, st.name, st.category, i, st.color]]),
      ['INSERT INTO app_settings (key, value) VALUES (?, ?)', ['slug:' + id, slug]],
      ['INSERT INTO app_settings (key, value) VALUES (?, ?)', ['pcode:' + id, code]],
      // 受益人成為唯一的初始專案管理員：只新增新專案這一筆（新專案還沒有任何成員資格），不碰他其他專案的成員資格
      ...(beneficiary ? [...membership.makeProjectAdminStmts(beneficiary.id, id), ['UPDATE participants SET updated_at = ? WHERE id = ?', [at, beneficiary.id]]] : []),
      audit,
    ].filter(Boolean);
  }

  async function create({ actor, beneficiary, method, requestId = null, spec, guards = [], extra = () => [], explain = async () => null, workspaceId = DEFAULT_WORKSPACE }) {
    if (!actor || !beneficiary) throw new Error('建立專案：要有執行者與受益人');
    if (method === CREATION_METHOD.DIRECT && beneficiary.id !== actor.id) throw new Error('直接建立：受益人就是執行者');
    if (method === CREATION_METHOD.APPROVED_REQUEST && !requestId) throw new Error('核准建立：要帶申請編號');
    if (![CREATION_METHOD.DIRECT, CREATION_METHOD.APPROVED_REQUEST].includes(method)) throw new Error(`建立專案：不認得的建立方式 ${method}`);
    const { name, visibility = DEFAULT_VISIBILITY, statuses = null } = spec;
    for (let attempt = 1; ; attempt++) {
      // 交易前讀到的資料只用來準備候選值與友善的錯誤；保證靠下面那一批的交易內斷言
      await names.refresh();
      if (await names.nameInUse(name, workspaceId)) throw new ApiError(409, 'NAME_TAKEN', '已有同名的專案');
      if (spec.code) names.checkCode(spec.code, actor);
      const used = await names.usedSlugs();
      const slug = spec.slug || names.autoSlug(name, used);
      if (used.has(slug)) throw names.slugTaken(slug, used);
      const code = spec.code || names.autoCode(slug);
      const id = randId('prj'), at = nowIso();
      const list = [...guards, ...stmts({ id, at, actor, beneficiary, method, requestId, spec: { name, visibility, slug, code, statuses }, workspaceId }), ...extra({ id, at, slug, code })];
      if (await write(list, workspaceId)) { await names.afterWrite?.(); return { id, name, slug, code, visibility }; }
      // 斷言沒過：先看呼叫端的前提，再用新鮮資料判斷名稱與識別碼。同名 → NAME_TAKEN；指定的值被用掉 → SLUG_TAKEN／CODE_TAKEN；自動產生的被用掉 → 重算重試
      const mine = await explain();
      if (mine) throw mine;
      const why = await names.nameWriteFailed(id, name, workspaceId);
      if (why.code === 'NAME_TAKEN') throw why;
      const slugLost = !(await holdsNow(db, slugFreeCond(slug, id))), codeLost = !(await holdsNow(db, codeFreeCond(code, id)));
      await names.refresh();
      if (slugLost && spec.slug) throw names.slugTaken(slug, await names.usedSlugs());
      if (codeLost && spec.code) names.checkCode(spec.code, actor); // 丟 CODE_TAKEN（占用者是看不到的私人專案時不說是哪個）
      if (!(slugLost || codeLost) || attempt >= IDENTITY_TRIES) throw why;
    }
  }
  // 審核畫面用的預估：沒指定的網址英文名與代號現在會產生什麼（只是預估，建立時重算）、哪些欄位現在有衝突。
  // conflicts 只列欄位（name、slug、code），不說被哪個專案占用；自動產生的值會避開已用的，不算衝突
  async function preview({ name, slug = null, code = null }, workspaceId = DEFAULT_WORKSPACE) {
    await names.refresh();
    const used = await names.usedSlugs();
    const conflicts = [];
    if (await names.nameInUse(name, workspaceId)) conflicts.push('name');
    if (slug && used.has(slug)) conflicts.push('slug');
    if (code) { try { names.checkCode(code, null); } catch (e) { if (e?.code !== 'CODE_TAKEN') throw e; conflicts.push('code'); } }
    const s = slug || names.autoSlug(name, used);
    return { slug: s, code: code || names.autoCode(s), slugEstimated: !slug, codeEstimated: !code, conflicts };
  }
  return { create, stmts, preview };
}
