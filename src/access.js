// 權限模組：伺服器端所有權限判斷都走這裡（詞彙見 GLOSSARY「成員與權限」；架構見 docs/adr/0002）
// 兩個問題、一個介面：
//   roleIn(人, 範圍)          這個人在這個範圍的實際角色（明確角色與上層管理員的隱含權限取較高者）
//   can(人, 動作, 範圍)        能不能在這個範圍做某件事；check() 不行就丟 ApiError
// 範圍：'platform'、'workspace'、{ project: 專案id }；要看對象的動作再帶 target（例：{ project, target }、{ target }）
//
// 目前的規則（改權限規則只改這個檔案）：
// - 工作區管理員＝participants.workspace_role 是 admin 的啟用中人類，可以有多位
// - 平台管理員＝帳號的 platform_role 是 admin（deps.isPlatformAdmin），可以有多位；對工作區有隱含的工作區管理權（不必是工作區成員）
// - 已移出工作區（workspace_status＝removed）的人不是工作區成員（平台管理員照樣有隱含權）
// - 專案角色存在 project_members：admin＝專案管理員（工作區管理員有隱含權限，取較高者）、member＝專案成員、viewer＝唯讀成員
// - 隱含權限不算成員資格：工作區管理員（含平台管理員）在沒加入的專案不列為成員，只有職稱也一樣（implicitOnlyIn）
// - 唯讀成員的 AI 跟著唯讀；明確的唯讀成員跟隱含權限取較高者：升為工作區／平台管理員就能寫，他的 AI 也是（工作區管理員不能被設成唯讀成員）
// - AI 不能做任何管理動作
// - 敏感動作（動作表標 sensitive: true）：權限檢查通過後，還要這台裝置剛再驗證過（deps.requireRecentAuth 不行就丟錯；沒注入時不檢查）
// - 成員名冊：工作區成員（含 AI）看得到工作區裡所有人（see_member）；已移出的人只有工作區管理員看得到（see_removed_members；待接受的邀請走 invite）
// - 建立專案：工作區管理員；工作區設定「誰可以建立專案」是所有成員時，一般成員（人類）也可以
// - 專案可見度：開放＝直接加入、審核＝送申請、私人＝只有專案成員與有隱含權限的人知道它存在（discover_project；其他人各處都當它不存在，回 404）
// 資料都由呼叫端注入（成員資料歸成員資格模組管），這裡只做判斷。
import { WORKSPACE_ROLE } from './membership.js';

export const ACCESS_ROLE = Object.freeze({
  PLATFORM_ADMIN: 'platform_admin',
  WORKSPACE_ADMIN: 'workspace_admin', MEMBER: 'member',
  PROJECT_ADMIN: 'project_admin', PROJECT_MEMBER: 'project_member', VIEWER: 'viewer',
});
const R = ACCESS_ROLE;
// 專案可見度（存在 projects.visibility）：open＝開放（工作區成員直接加入）、review＝審核（申請後由專案管理員核准）、
// private＝私人（只有專案成員與有隱含權限的人看得到，其他人查不到它的存在）。舊專案與新專案預設審核
export const PROJECT_VISIBILITY = Object.freeze({ OPEN: 'open', REVIEW: 'review', PRIVATE: 'private' });
export const PROJECT_VISIBILITIES = Object.freeze(Object.values(PROJECT_VISIBILITY));
const VIS = PROJECT_VISIBILITY;

// 一個人實際能進的（未封存）專案。有隱含權限的人＝所有專案；其他人＝自己的專案成員資格；
// AI＝它的專案成員資格 ∩ 所屬人類能進的專案（所屬人類不論怎麼失去一個專案，AI 當下就進不去，不靠寫入時的連帶刪除）。
// deps：projects()（未封存專案）、memberProjectsOf(p)（明確的成員資格）、implicitAll(p)（有隱含權限）、ownerOf(ai)（所屬人類的列）
export function effectiveProjects({ projects, memberProjectsOf, implicitAll, ownerOf }) {
  const of = p => {
    if (implicitAll(p)) return [...projects()];
    const mine = memberProjectsOf(p);
    if (p?.kind !== 'ai') return mine;
    const owner = of(ownerOf(p));
    return mine.filter(pj => owner.includes(pj));
  };
  return of;
}

// 這一列是不是工作區管理員（啟用中的人類、workspace_role＝admin）。只看這一列，不必讀成員資料
export const isWorkspaceAdmin = p => !!p && p.kind === 'human' && p.status === 'active' && p.workspace_role === WORKSPACE_ROLE.ADMIN;
// 實際的工作區管理權：工作區管理員，或平台管理員（隱含權限）。isPlatformAdmin(p)：他的帳號是平台管理員（成員資格模組）
export const hasWorkspaceAdminRights = (p, isPlatformAdmin) => isWorkspaceAdmin(p) || (!!p && p.kind === 'human' && p.status === 'active' && !!isPlatformAdmin?.(p));
// 還在工作區裡（沒被移出；沒有 workspace_status 的舊列＝在）
export const inWorkspace = p => (p?.workspace_status ?? 'active') === 'active';
// 進不了這個工作區（登入、每個請求都看）：已移出的人；AI 看所屬人類有沒有被移出（owner_ws_status）。平台管理員有隱含權，照樣進得來
export const shutOutOfWorkspace = (p, isPlatformAdmin) => (!inWorkspace(p) && !hasWorkspaceAdminRights(p, isPlatformAdmin)) || p?.owner_ws_status === 'removed';
// 照加入順序（名冊、管理員清單）
export const byJoined = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
// 所有工作區管理員（照加入順序）
export const adminsOf = people => [...people.values()].filter(isWorkspaceAdmin).sort(byJoined);
// 顯示用的「管理員」（錯誤訊息的名字、通知對象）：最早加入的工作區管理員；都沒有才退回最早加入的人類。「能不能」不看這個
export const adminOf = people => {
  const admins = adminsOf(people);
  if (admins.length) return admins[0];
  return [...people.values()].filter(p => p.kind === 'human' && p.status === 'active').sort(byJoined)[0] || null;
};

// 動作表。admin：管理動作（AI 一律不行）；human：check 時先擋 AI（回「僅限人類」）；light：只看唯讀名單，不必讀成員；
// fresh：check 時重讀專案管理員名單與工作區設定（別份程式剛改過也算數）
// rule(v, me, s)：v 是 load() 的判斷視圖，s 是整理過的範圍 { kind, project, target }
// deny(d)：不行時回的錯誤（沒寫＝DENY.workspace）。d＝{ v, me, s, action, what, err(status, code, message), adminName(), nameOf, readOnly() }
// （訊息都要在 public/i18n/en.js 有英文，i18n-test 會掃；新訊息請沿用既有句型或一起加翻譯）
const platformAdmin = (v, me) => v.roleIn(me, 'platform') === R.PLATFORM_ADMIN;
const workspaceAdmin = (v, me) => v.roleIn(me, 'workspace') === R.WORKSPACE_ADMIN;
// 改程式庫、私訊、AI 職務、職稱、專案成員：工作區管理員，或未封存專案的專案管理員
const activeProjectAdmin = (v, me, s) => workspaceAdmin(v, me) || (v.active(s.project) && v.roleIn(me, s) === R.PROJECT_ADMIN);
// 不能動對方的上層管理權：對象是平台管理員時，要是平台管理員才行（沒帶對象＝不看）
const notAboveMe = (v, me, { target }) => !target || v.roleIn(target, 'platform') !== R.PLATFORM_ADMIN || platformAdmin(v, me);
const DENY = {
  platform: d => d.err(403, 'NOT_ADMIN', `只有平台管理員能${d.what || '管理平台'}。`),
  workspace: d => d.err(403, 'NOT_ADMIN', `只有工作區管理員（${d.adminName()}）能${d.what || '管理專案與成員所屬專案'}。`),
  project: d => d.err(403, 'NOT_ADMIN', `只有工作區管理員（${d.adminName()}）或這個專案的專案管理員能${d.what || '管理這個專案'}。`),
  // 移出工作區、重設登入：是工作區管理員、但對象是平台管理員（不能動上層管理權）
  upper: msg => d => (d.v.can(d.me, d.action, 'workspace') ? d.err(403, 'CANNOT_MANAGE_ADMIN', msg(d.s.target?.name || '')) : DENY.workspace(d)),
  notFound: d => d.err(404, 'NOT_FOUND', '找不到這個專案'),
  join: d => {
    const vis = d.v.visibilityOf(d.s.project), name = d.nameOf(d.s.project); // （看不到的私人專案在 denial 已經回 404）
    if (vis === VIS.PRIVATE) return d.err(403, 'JOIN_PRIVATE', `「${name}」是私人專案，只能由專案管理員把人加入。`);
    if (vis === VIS.OPEN) return d.err(409, 'JOIN_DIRECTLY', `「${name}」是開放專案，直接加入就好，不用申請。`);
    if (vis === VIS.REVIEW && d.action === 'join_project') return d.err(403, 'JOIN_NEEDS_APPROVAL', `「${name}」要送加入申請、由專案管理員核准才能加入。`);
    return d.err(403, 'FORBIDDEN', '只有工作區成員能加入專案。');
  },
};
const ACTIONS = {
  // 平台
  manage_platform: { admin: true, rule: platformAdmin, deny: DENY.platform }, // 備份與還原、示範資料、更新檢查
  manage_accounts: { admin: true, rule: platformAdmin, deny: DENY.platform }, // 恢復帳號、已停用清單
  disable_account: { admin: true, sensitive: true, rule: platformAdmin, deny: DENY.platform }, // 停用帳號（敏感：要再驗證身分）
  assign_platform_admin: { admin: true, sensitive: true, rule: platformAdmin, deny: DENY.platform }, // 任免平台管理員（敏感）
  // 工作區
  manage_workspace: { admin: true, rule: workspaceAdmin }, // 工作區設定、AI 工具、附件保存時間、第一次設定、檔案稽核全站
  assign_workspace_admin: { admin: true, sensitive: true, rule: workspaceAdmin }, // 升降工作區管理員（敏感）
  // 可復原期（敏感）：scope 'platform'＝平台預設（平台管理員），'workspace'＝工作區覆寫（工作區管理員）。讀實際生效的值不用權限
  set_recovery_window: { admin: true, sensitive: true, rule: (v, me, s) => (s.kind === 'platform' ? platformAdmin(v, me) : workspaceAdmin(v, me)),
    deny: d => (d.s.kind === 'platform' ? DENY.platform : DENY.workspace)(d) },
  remove_member: { admin: true, rule: (v, me, s) => workspaceAdmin(v, me) && notAboveMe(v, me, s), deny: DENY.upper(n => `${n} 是平台管理員，只有平台管理員能把他移出工作區。`) }, // 把人移出工作區（帳號不受影響）；target 是平台管理員時只有平台管理員能
  see_removed_members: { admin: true, rule: workspaceAdmin },
  review_upgrade: { admin: true, rule: workspaceAdmin }, // 成員名冊：升級時同時是 leader 又是唯讀、先當唯讀成員的人（upgradeReview），略過標記 // 成員名冊：已移出工作區的人（待接受的邀請是 GET /api/invites?status=pending，invite）
  invite: { admin: true, rule: workspaceAdmin },
  reset_login: { admin: true, rule: (v, me, s) => workspaceAdmin(v, me) && notAboveMe(v, me, s), deny: DENY.upper(n => `${n} 是平台管理員，只有平台管理員能重設他的登入。`) }, // target 是平台管理員時只有平台管理員能
  assign_members: { admin: true, rule: workspaceAdmin }, // 直接改某人所屬的整份專案清單（PUT /api/participants/:id/projects）
  create_project: { admin: true, fresh: true, rule: (v, me) => workspaceAdmin(v, me) || (v.membersCreateProjects() && v.roleIn(me, 'workspace') === R.MEMBER) }, // fresh：check 時重讀工作區設定
  // 刪除專案：先進入可復原期，期滿由系統永久清除（只有工作區管理員）
  delete_project: { admin: true, sensitive: true, rule: workspaceAdmin }, // 刪除已封存的專案（敏感）
  preview_project_delete: { admin: true, rule: workspaceAdmin }, // 刪除前的預覽：會刪掉多少、預計永久清除的時間（不用再驗證）
  see_deleted_projects: { admin: true, rule: workspaceAdmin }, // 可復原期內的「已刪除的專案」
  restore_project: { admin: true, rule: workspaceAdmin }, // 可復原期內復原（回到封存狀態）
  // 專案（只有工作區管理員）
  set_project_code: { admin: true, rule: workspaceAdmin },
  set_project_slug: { admin: true, rule: workspaceAdmin },
  // 專案（專案管理員）
  manage_project: { admin: true, human: true, fresh: true, rule: (v, me, s) => v.roleIn(me, s) === R.PROJECT_ADMIN, deny: DENY.project }, // 改名、封存、還原、看板狀態、知識庫、技能審核、加入申請（封存的專案也算）
  configure_project: { admin: true, fresh: true, rule: activeProjectAdmin, deny: DENY.project }, // 程式庫、私訊開關、AI 職務
  manage_project_members: { admin: true, fresh: true, rule: activeProjectAdmin, deny: DENY.project }, // 專案成員：從工作區成員挑人加入、移出、設專案成員／唯讀成員
  assign_project_admin: { admin: true, fresh: true, rule: activeProjectAdmin }, // 任免專案管理員：工作區管理員，以及該專案的專案管理員
  set_title: { admin: true, fresh: true, rule: (v, me, s) => activeProjectAdmin(v, me, s) || (!!s.target && s.target.id === me.id),
    deny: d => d.err(403, 'NOT_PROJECT_LEADER', `只有工作區管理員、「${d.nameOf(d.s.project)}」的專案管理員或 ${d.s.target?.name || ''} 本人能改他在這個專案的職稱。`) },
  set_visibility: { admin: true, fresh: true, rule: activeProjectAdmin, deny: DENY.project }, // 專案可見度：開放／審核／私人
  // 專案可見度
  discover_project: { rule: (v, me, s) => v.discovers(me, s.project), deny: DENY.notFound }, // 知道這個專案存在（專案清單、卡片代號、搜尋、訊息、MCP、名冊）；看內容另外看 see_project
  join_project: { human: true, rule: (v, me, s) => !!v.roleIn(me, 'workspace') && v.visibilityOf(s.project) === VIS.OPEN, deny: DENY.join }, // 自己直接加入：開放專案
  request_join: { human: true, rule: (v, me, s) => !!v.roleIn(me, 'workspace') && v.visibilityOf(s.project) === VIS.REVIEW, deny: DENY.join }, // 送加入申請：審核專案
  // 一般
  write: { light: true, rule: (v, me, s) => !v.readOnlyAt(me, s.project), deny: d => d.readOnly() },
  see_project: { rule: (v, me, s) => (!v.isolatedFrom(me) && !v.hiddenArchived(me).includes(s.project)) || v.projectsOf(me).includes(s.project), deny: d => d.err(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案。') },
  see_project_events: { rule: (v, me, s) => v.projectsOf(me).includes(s.project) || workspaceAdmin(v, me) },
  see_member: { rule: (v, me, { target: p }) => p.id === me.id || !!v.roleIn(me, 'workspace'), deny: d => d.err(404, 'NOT_FOUND', `找不到成員 ${d.s.target?.id || ''}`) }, // 成員名冊：工作區成員（含 AI）看得到工作區裡所有人；對象是不是啟用中的工作區成員由呼叫端過濾
  see_ai_state: { light: true, rule: (v, me, { target }) => v.projectsOf(target).some(p => v.projectsOf(me).includes(p)), deny: d => d.err(403, 'PROJECT_FORBIDDEN', '這位 AI 不屬於你的專案，看不到它的工作記憶。') }, // 工作記憶：至少一個共同專案
  // 稽核紀錄（只能新增：沒有改、刪的動作）
  see_audit_log: { admin: true, rule: workspaceAdmin }, // 工作區（含專案）範圍的事件
  see_platform_audit_log: { admin: true, rule: platformAdmin, deny: DENY.platform }, // 平台層的事件（任免平台管理員、停用帳號、備份還原…）
};
export const ACCESS_ACTIONS = Object.freeze(Object.keys(ACTIONS));

const scopeOf = scope => {
  if (scope === 'platform' || scope === 'workspace') return { kind: scope, project: null, target: null };
  const s = scope || {};
  return { kind: 'project' in s ? 'project' : 'workspace', project: s.project ?? null, target: s.target ?? null };
};

// deps（成員資料的讀法，名字跟成員資格模組 src/membership.js 一致）：
//   ApiError、requireHuman、nameOf(專案id)
//   people(ctx)              → Map<id, participant>
//   projects()               → 未封存的專案 id
//   projectsOf(p)            → 他所在、未封存的專案
//   isolatedFrom(p)          → 不在所有專案（看不到別專案的東西）
//   hiddenArchived(p)        → 他看不到的封存私人專案（沒注入＝沒有）
//   loadProjectAdmins(force)       → 讀專案管理員名單（10 秒快取；force 重讀）；projectAdminsOf(pj) → 目前快取裡該專案的專案管理員 id（含封存專案）
//   loadReadOnly(force)      → 讀唯讀成員名單；isReadOnly(p, pj) → 目前快取裡 p 在 pj 是唯讀成員（AI 跟著所屬人類）
//   ownerOf(ai)              → AI 所屬人類的列（實際的唯讀要看他有沒有隱含權限）
//   memberProjectsOf(p)      → 他明確加入的（未封存）專案（不含隱含權限；沒給就用 projectsOf）
//   loadWorkspace(force)     → 讀工作區設定（10 秒快取）；membersCreateProjects() → 目前快取裡「一般成員可以建立專案」（沒注入＝不行）
//   isPlatformAdmin(p)       → 他的帳號是平台管理員（沒注入＝沒有平台管理員）
//   visibilityOf(pj)         → 專案可見度（PROJECT_VISIBILITY；沒注入或不認得的值＝審核）
//   isDeletedProject(pj)     → 專案在可復原期（已刪除、還沒永久清除）：對所有人都當它不存在（沒注入＝沒有）
export function createAccess(deps) {
  const { ApiError, requireHuman, nameOf, projects, projectsOf, isolatedFrom, projectAdminsOf, isReadOnly } = deps;
  const memberProjectsOf = deps.memberProjectsOf || projectsOf;
  // 平台管理員（啟用中的人類）；實際的工作區管理權＝工作區管理員或平台管理員（隱含）
  const isPlatformAdmin = p => !!p && p.kind === 'human' && p.status === 'active' && !!deps.isPlatformAdmin?.(p);
  const adminInWorkspace = p => hasWorkspaceAdminRights(p, deps.isPlatformAdmin);
  // 隱含權限不算成員：工作區管理員（含平台管理員）在沒加入、也沒有職稱的專案不列為成員（名單、人數、團隊狀態、@所有人都不算）
  // （只有職稱不算成員：職稱不帶權限，也不帶成員資格）
  const implicitOnly = (p, pj) => !!pj && adminInWorkspace(p) && !memberProjectsOf(p).includes(pj);

  // 實際的唯讀：明確是唯讀成員，而且沒有更高的隱含權限（取較高者：升為工作區／平台管理員就能寫）。AI 看所屬人類
  // ownerOf(ai)：所屬人類的列（沒注入／讀不到＝當他沒有隱含權限，寧可少給）
  const implicitAdmin = p => adminInWorkspace(p?.kind === 'ai' ? deps.ownerOf?.(p) : p);
  const readOnlyIn = (p, pj) => !!p && !!pj && isReadOnly(p, pj) && !implicitAdmin(p);
  const readOnlyList = p => projects().filter(pj => readOnlyIn(p, pj));
  const readOnlyError = (p, pj) => new ApiError(403, 'READ_ONLY', `${p?.kind === 'ai' ? '你的所屬人類' : '你'}在「${nameOf(pj)}」是唯讀成員，只能看，不能發訊息、回覆、建卡、改卡、交接、上傳或私訊。需要權限請找工作區管理員或該專案的專案管理員。AI 收到這個就停下、在本機對話告訴所屬人類，不要重試。`);

  // 判斷視圖：綁定一份成員資料，判斷都是同步的（可以放在 filter 裡）；專案管理員、唯讀成員看目前快取（load() 會先讀好）
  function view({ people = null } = {}) {
    let admin;
    const needPeople = () => { if (!people) throw new Error('權限判斷需要成員資料（access.load 沒讀成員）'); return people; };
    const adminNow = () => {
      if (admin === undefined) admin = adminOf(needPeople());
      return admin;
    };
    const isAdmin = adminInWorkspace;
    const v = {
      people, admin: adminNow, projects, projectsOf, isolatedFrom, hiddenArchived: p => deps.hiddenArchived?.(p) || [],
      admins: () => adminsOf(needPeople()),
      platformAdmins: () => [...needPeople().values()].filter(isPlatformAdmin).sort(byJoined),
      // 最後一位保護：p 是該層的管理員，而且除了他沒有別的（降級、移出、停用、離開都要先問）。工作區只算明確的工作區管理員
      lastAdmin: (p, scope = 'workspace') => {
        const kind = scopeOf(scope).kind;
        if (kind === 'platform') return isPlatformAdmin(p) && !v.platformAdmins().some(x => x.id !== p.id);
        return kind !== 'project' && isWorkspaceAdmin(p) && !adminsOf(needPeople()).some(x => x.id !== p.id);
      },
      active: pj => projects().includes(pj),
      membersCreateProjects: () => !!deps.membersCreateProjects?.(),
      visibilityOf: pj => { const x = deps.visibilityOf?.(pj); return PROJECT_VISIBILITIES.includes(x) ? x : VIS.REVIEW; },
      // 私人專案只有專案成員與有隱含權限的人（工作區管理員等）看得到它存在；開放、審核所有人都看得到
      // （成員先判，不必讀成員資料；非成員看私人專案才要判上層管理員）
      discovers: (p, pj) => !!p && !deps.isDeletedProject?.(pj) && (p.kind === 'system' || v.visibilityOf(pj) !== VIS.PRIVATE || projectsOf(p).includes(pj) || v.roleIn(p, { project: pj }) !== null),
      // 看得到存在的專案（未封存）；錯誤訊息列可選的專案也用這個，不洩漏私人專案
      visibleProjects: p => projects().filter(pj => v.discovers(p, pj)),
      isProjectAdmin: (p, pj) => !!p && projectAdminsOf(pj).includes(p.id),
      readOnlyAt: (p, pj) => (pj ? readOnlyIn(p, pj) : readOnlyList(p).length > 0),
      roleIn(p, scope) {
        if (!p) return null;
        const s = scopeOf(scope);
        if (s.kind === 'platform') return isPlatformAdmin(p) ? R.PLATFORM_ADMIN : null;
        if (s.kind === 'workspace') return isAdmin(p) ? R.WORKSPACE_ADMIN : p.status === 'active' && inWorkspace(p) && (p.kind === 'human' || p.kind === 'ai') ? R.MEMBER : null;
        if (isAdmin(p) || v.isProjectAdmin(p, s.project)) return R.PROJECT_ADMIN; // 隱含權限、專案管理員
        if (!projectsOf(p).includes(s.project)) return null;
        return readOnlyIn(p, s.project) ? R.VIEWER : R.PROJECT_MEMBER;
      },
      can(me, action, scope) {
        const def = ACTIONS[action];
        if (!def) throw new Error(`沒有這個權限動作：${action}`);
        if (!me || (def.admin && me.kind !== 'human')) return false; // AI 不能做任何管理動作
        return !!def.rule(v, me, scopeOf(scope));
      },
      implicitOnlyIn: (id, pj) => implicitOnly(people?.get(id), pj),
    };
    return v;
  }

  async function load(ctx, { fresh = false, light = false } = {}) {
    await deps.loadReadOnly();
    if (light) return view();
    const people = await deps.people(ctx);
    await deps.loadProjectAdmins(fresh);
    await deps.loadWorkspace?.(fresh);
    return view({ people });
  }

  // 不行就丟錯：動作表的 deny。opts.what：預設訊息裡「能…」的部分；opts.deny()：自己給錯誤
  function denial(v, me, action, s, { what, deny } = {}) {
    const d = { v, me, s, action, what, nameOf, err: (status, code, message) => new ApiError(status, code, message),
      adminName: () => v.admin()?.name || '未設定', readOnly: () => readOnlyError(me, s.project || readOnlyList(me)[0]) };
    // 私人專案對看不到的人＝沒有這個專案（跟專案不存在一樣回 404，不說「你不屬於」）
    if (s.project && v.people && !v.discovers(me, s.project)) return DENY.notFound(d);
    if (deny) return deny();
    return (ACTIONS[action].deny || DENY.workspace)(d);
  }
  async function check(ctx, me, action, scope, opts = {}) {
    const def = ACTIONS[action];
    if (!def) throw new Error(`沒有這個權限動作：${action}`);
    if (def.human) requireHuman(me);
    const v = await load(ctx, { fresh: !!def.fresh, light: def.light });
    if (!v.can(me, action, scope)) throw denial(v, me, action, scopeOf(scope), opts);
    if (def.sensitive) await deps.requireRecentAuth?.(me, ctx); // 敏感動作：再驗證身分
    return v;
  }

  return {
    load, view, check, adminOf, adminsOf, isWorkspaceAdmin, isPlatformAdmin, adminInWorkspace, implicitOnly, shutOut: p => shutOutOfWorkspace(p, deps.isPlatformAdmin), readOnlyIn, readOnlyError, visibilityOf: pj => view().visibilityOf(pj),
    roleIn: async (ctx, p, scope) => (await load(ctx)).roleIn(p, scope),
    can: async (ctx, me, action, scope) => (await load(ctx, { light: ACTIONS[action]?.light })).can(me, action, scope),
  };
}
