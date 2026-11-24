// 權限模組：伺服器端所有權限判斷都走這裡（詞彙見 GLOSSARY「成員與權限」；架構見 docs/adr/0002）
// 兩個問題、一個介面：
//   roleIn(人, 範圍)          這個人在這個範圍的實際角色（明確角色與上層管理員的隱含權限取較高者）
//   can(人, 動作, 範圍)        能不能在這個範圍做某件事；check() 不行就丟 ApiError
// 範圍：'platform'、'workspace'、{ project: 專案id }；要看對象的動作再帶 target（例：{ project, target }、{ target }）
//
// 第一階段之前的規則（行為與舊版完全相同，之後的票只改這個檔案的規則）：
// - 工作區管理員＝participants.is_admin 標記的那位人類（沒有標記就是最早加入的人類），也是平台管理員
// - 專案角色存在 project_members：admin＝專案管理員（工作區管理員有隱含權限，取較高者）、member＝專案成員、viewer＝唯讀成員
// - 唯讀成員的 AI 跟著唯讀；明確設成唯讀成員時一律不能寫（工作區管理員不能被設成唯讀成員）
// - AI 不能做任何管理動作
// - 建立專案：工作區管理員；工作區設定「誰可以建立專案」是所有成員時，一般成員（人類）也可以
// - 專案可見度：開放＝直接加入、審核＝送申請、私人＝只有專案成員與有隱含權限的人知道它存在（discover_project；其他人各處都當它不存在，回 404）
// 資料都由呼叫端注入（成員資料歸成員資格模組管），這裡只做判斷。
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

// 管理員：participants.is_admin 標記的那位（可以交給別人）。都沒標記（舊備份）才退回最早加入的人類
export const adminOf = people => {
  const hs = [...people.values()].filter(p => p.kind === 'human' && p.status === 'active');
  return hs.find(p => Number(p.is_admin) === 1) || hs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0] || null;
};

// 動作表。admin：管理動作（AI 一律不行）；human：check 時先擋 AI（回「僅限人類」）；light：只看唯讀名單，不必讀成員；
// leads：看專案管理員名單，check 時重讀（別份程式剛改過也算數）
// rule(v, me, s)：v 是 load() 的判斷視圖，s 是整理過的範圍 { kind, project, target }
const platformAdmin = (v, me) => v.roleIn(me, 'platform') === R.PLATFORM_ADMIN;
const workspaceAdmin = (v, me) => v.roleIn(me, 'workspace') === R.WORKSPACE_ADMIN;
// 改程式庫、私訊、AI 職務、職稱、專案成員：工作區管理員，或未封存專案的專案管理員
const activeProjectAdmin = (v, me, s) => workspaceAdmin(v, me) || (v.active(s.project) && v.roleIn(me, s) === R.PROJECT_ADMIN);
const ACTIONS = {
  // 平台
  manage_platform: { admin: true, rule: platformAdmin }, // 備份與還原、示範資料、更新檢查
  manage_accounts: { admin: true, rule: platformAdmin }, // 停用／恢復帳號、已停用清單
  assign_platform_admin: { admin: true, rule: platformAdmin }, // 交出管理員
  // 工作區
  manage_workspace: { admin: true, rule: workspaceAdmin }, // 工作區（群組）設定、AI 工具、附件保存時間、第一次設定、檔案稽核全站
  invite: { admin: true, rule: workspaceAdmin },
  reset_login: { admin: true, rule: workspaceAdmin },
  assign_members: { admin: true, rule: workspaceAdmin }, // 直接改某人所屬的整份專案清單（PUT /api/participants/:id/projects）
  create_project: { admin: true, fresh: true, rule: (v, me) => workspaceAdmin(v, me) || (v.membersCreateProjects() && v.roleIn(me, 'workspace') === R.MEMBER) }, // fresh：check 時重讀工作區設定
  // 專案（只有工作區管理員）
  delete_project: { admin: true, rule: workspaceAdmin },
  set_project_code: { admin: true, rule: workspaceAdmin },
  set_project_slug: { admin: true, rule: workspaceAdmin },
  // 專案（專案管理員）
  manage_project: { admin: true, human: true, leads: true, rule: (v, me, s) => v.roleIn(me, s) === R.PROJECT_ADMIN }, // 改名、封存、還原、看板狀態、知識庫、技能審核、加入申請（封存的專案也算）
  configure_project: { admin: true, leads: true, rule: activeProjectAdmin }, // 程式庫、私訊開關、AI 職務
  manage_project_members: { admin: true, leads: true, rule: activeProjectAdmin }, // 專案成員：從工作區成員挑人加入、移出、設專案成員／唯讀成員
  assign_project_admin: { admin: true, leads: true, rule: activeProjectAdmin }, // 任免專案管理員：工作區管理員，以及該專案的專案管理員
  set_title: { admin: true, leads: true, rule: (v, me, s) => activeProjectAdmin(v, me, s) || (!!s.target && s.target.id === me.id) },
  set_visibility: { admin: true, leads: true, rule: activeProjectAdmin }, // 專案可見度：開放／審核／私人
  // 專案可見度
  discover_project: { rule: (v, me, s) => v.discovers(me, s.project) }, // 知道這個專案存在（專案清單、卡片代號、搜尋、訊息、MCP、名冊）；看內容另外看 see_project
  join_project: { human: true, rule: (v, me, s) => !!v.roleIn(me, 'workspace') && v.visibilityOf(s.project) === VIS.OPEN }, // 自己直接加入：開放專案
  request_join: { human: true, rule: (v, me, s) => !!v.roleIn(me, 'workspace') && v.visibilityOf(s.project) === VIS.REVIEW }, // 送加入申請：審核專案
  // 一般
  write: { light: true, rule: (v, me, s) => !v.readOnlyAt(me, s.project) },
  see_project: { rule: (v, me, s) => !v.isolatedFrom(me) || v.projectsOf(me).includes(s.project) },
  see_project_events: { rule: (v, me, s) => v.projectsOf(me).includes(s.project) || workspaceAdmin(v, me) },
  see_member: { rule: (v, me, { target: p }) => !v.isolatedFrom(me) || p.id === me.id || v.projectsOf(p).some(x => v.projectsOf(me).includes(x))
    || (p.kind === 'human' && !v.projectsOf(p).length && v.projects().some(pj => v.leads(me, pj))) }, // 專案管理員另外看得到「還沒有任何專案」的人類，才能把新成員加進自己的專案
  see_ai_state: { light: true, rule: (v, me, { target }) => v.projectsOf(target).some(p => v.projectsOf(me).includes(p)) }, // 工作記憶：至少一個共同專案
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
//   loadLeaders(force)       → 讀專案管理員名單（10 秒快取；force 重讀）；leadersOf(pj) → 目前快取裡該專案的專案管理員 id（含封存專案）
//   loadReadOnly(force)      → 讀唯讀成員名單；isReadOnly(p, pj) → 目前快取裡 p 在 pj 是唯讀成員（AI 跟著所屬人類）
//   titles()                 → { 成員id: { 專案id: 職稱 } }（目前快取）
//   loadWorkspace(force)     → 讀工作區設定（10 秒快取）；membersCreateProjects() → 目前快取裡「一般成員可以建立專案」（沒注入＝不行）
//   visibilityOf(pj)         → 專案可見度（PROJECT_VISIBILITY；沒注入或不認得的值＝審核）
export function createAccess(deps) {
  const { ApiError, requireHuman, nameOf, projects, projectsOf, isolatedFrom, leadersOf, isReadOnly, titles } = deps;

  const readOnlyIn = (p, pj) => !!p && !!pj && isReadOnly(p, pj);
  const readOnlyList = p => projects().filter(pj => readOnlyIn(p, pj));
  const readOnlyError = (p, pj) => new ApiError(403, 'READ_ONLY', `${p?.kind === 'ai' ? '你的所屬人類' : '你'}在「${nameOf(pj)}」是唯讀成員，只能看，不能發訊息、回覆、建卡、改卡、交接、上傳或私訊。需要權限請找管理員或該專案的專案管理員。AI 收到這個就停下、在本機對話告訴所屬人類，不要重試。`);

  // 判斷視圖：綁定一份成員資料，判斷都是同步的（可以放在 filter 裡）；專案管理員、唯讀成員看目前快取（load() 會先讀好）
  function view({ people = null } = {}) {
    let admin;
    const adminNow = () => {
      if (admin === undefined) { if (!people) throw new Error('權限判斷需要成員資料（access.load 沒讀成員）'); admin = adminOf(people); }
      return admin;
    };
    const isAdmin = p => !!p && p.kind === 'human' && adminNow()?.id === p.id;
    const v = {
      people, admin: adminNow, projects, projectsOf, isolatedFrom,
      active: pj => projects().includes(pj),
      membersCreateProjects: () => !!deps.membersCreateProjects?.(),
      visibilityOf: pj => { const x = deps.visibilityOf?.(pj); return PROJECT_VISIBILITIES.includes(x) ? x : VIS.REVIEW; },
      // 私人專案只有專案成員與有隱含權限的人（工作區管理員等）看得到它存在；開放、審核所有人都看得到
      // （成員先判，不必讀成員資料；非成員看私人專案才要判上層管理員）
      discovers: (p, pj) => !!p && (p.kind === 'system' || v.visibilityOf(pj) !== VIS.PRIVATE || projectsOf(p).includes(pj) || v.roleIn(p, { project: pj }) !== null),
      // 看得到存在的專案（未封存）；錯誤訊息列可選的專案也用這個，不洩漏私人專案
      visibleProjects: p => projects().filter(pj => v.discovers(p, pj)),
      leads: (p, pj) => !!p && leadersOf(pj).includes(p.id),
      readOnlyAt: (p, pj) => (pj ? readOnlyIn(p, pj) : readOnlyList(p).length > 0),
      roleIn(p, scope) {
        if (!p) return null;
        const s = scopeOf(scope);
        if (s.kind === 'platform') return isAdmin(p) ? R.PLATFORM_ADMIN : null;
        if (s.kind === 'workspace') return isAdmin(p) ? R.WORKSPACE_ADMIN : p.status === 'active' && (p.kind === 'human' || p.kind === 'ai') ? R.MEMBER : null;
        if (isAdmin(p) || v.leads(p, s.project)) return R.PROJECT_ADMIN; // 隱含權限、專案管理員
        if (!projectsOf(p).includes(s.project)) return null;
        return readOnlyIn(p, s.project) ? R.VIEWER : R.PROJECT_MEMBER;
      },
      can(me, action, scope) {
        const def = ACTIONS[action];
        if (!def) throw new Error(`沒有這個權限動作：${action}`);
        if (!me || (def.admin && me.kind !== 'human')) return false; // AI 不能做任何管理動作
        return !!def.rule(v, me, scopeOf(scope));
      },
      // 隱含權限不算成員：管理員在沒有職稱的專案不列為成員（名單、人數、團隊狀態、@所有人都不算）
      implicitOnlyIn: (id, pj) => !!pj && isAdmin(people?.get(id)) && !titles()[id]?.[pj],
    };
    return v;
  }

  async function load(ctx, { fresh = false, light = false } = {}) {
    await deps.loadReadOnly();
    if (light) return view();
    const people = await deps.people(ctx);
    await deps.loadLeaders(fresh);
    await deps.loadWorkspace?.(fresh);
    return view({ people });
  }

  // 不行就丟錯。opts.what：預設訊息裡「能…」的部分；opts.deny()：自己給錯誤
  // （訊息都要在 public/i18n/en.js 有英文，i18n-test 會掃；新訊息請沿用既有句型或一起加翻譯）
  function denial(v, me, action, s, { what, deny } = {}) {
    // 私人專案對看不到的人＝沒有這個專案（跟專案不存在一樣回 404，不說「你不屬於」）
    if (s.project && v.people && !v.discovers(me, s.project)) return new ApiError(404, 'NOT_FOUND', '找不到這個專案');
    if (deny) return deny();
    const adminName = () => v.admin()?.name || '未設定';
    switch (action) {
      case 'write': return readOnlyError(me, s.project || readOnlyList(me)[0]);
      case 'manage_project': case 'configure_project': case 'manage_project_members': case 'set_visibility':
        return new ApiError(403, 'NOT_ADMIN', `只有群組管理員（${adminName()}）或這個專案的專案管理員能${what || '管理這個專案'}。`);
      case 'set_title': return new ApiError(403, 'NOT_PROJECT_LEADER', `只有管理員、「${nameOf(s.project)}」的專案管理員或 ${s.target?.name || ''} 本人能改他在這個專案的職稱。`);
      case 'see_project': return new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案。');
      case 'see_ai_state': return new ApiError(403, 'PROJECT_FORBIDDEN', '這位 AI 不屬於你的專案，看不到它的工作記憶。');
      case 'see_member': return new ApiError(404, 'NOT_FOUND', `找不到成員 ${s.target?.id || ''}`);
      case 'discover_project': return new ApiError(404, 'NOT_FOUND', '找不到這個專案');
      case 'join_project': case 'request_join': {
        const vis = v.visibilityOf(s.project); // （看不到的私人專案上面已經回 404）
        if (vis === VIS.PRIVATE) return new ApiError(403, 'JOIN_PRIVATE', `「${nameOf(s.project)}」是私人專案，只能由專案管理員把人加入。`);
        if (vis === VIS.OPEN) return new ApiError(409, 'JOIN_DIRECTLY', `「${nameOf(s.project)}」是開放專案，直接加入就好，不用申請。`);
        if (vis === VIS.REVIEW && action === 'join_project') return new ApiError(403, 'JOIN_NEEDS_APPROVAL', `「${nameOf(s.project)}」要送加入申請、由專案管理員核准才能加入。`);
        return new ApiError(403, 'FORBIDDEN', '只有工作區成員能加入專案。');
      }
      default: return new ApiError(403, 'NOT_ADMIN', `只有群組管理員（${adminName()}）能${what || '管理專案與成員所屬專案'}。`);
    }
  }
  async function check(ctx, me, action, scope, opts = {}) {
    const def = ACTIONS[action];
    if (!def) throw new Error(`沒有這個權限動作：${action}`);
    if (def.human) requireHuman(me);
    const v = await load(ctx, { fresh: !!(def.leads || def.fresh), light: def.light });
    if (!v.can(me, action, scope)) throw denial(v, me, action, scopeOf(scope), opts);
    return v;
  }

  return {
    load, view, check, adminOf, readOnlyIn, readOnlyError, visibilityOf: pj => view().visibilityOf(pj),
    roleIn: async (ctx, p, scope) => (await load(ctx)).roleIn(p, scope),
    can: async (ctx, me, action, scope) => (await load(ctx, { light: ACTIONS[action]?.light })).can(me, action, scope),
  };
}
