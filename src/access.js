// 權限模組：伺服器端所有權限判斷都走這裡（詞彙見 GLOSSARY「成員與權限」；架構見 docs/adr/0002）
// 兩個問題、一個介面：
//   roleIn(人, 範圍)          這個人在這個範圍的實際角色（明確角色與上層管理員的隱含權限取較高者）
//   can(人, 動作, 範圍)        能不能在這個範圍做某件事；check() 不行就丟 ApiError
// 範圍：'platform'、'workspace'、{ project: 專案id }；要看對象的動作再帶 target（例：{ project, target }、{ target }）
//
// 目前的規則（之後的票只改這個檔案的規則）：
// - 工作區管理員＝participants.workspace_role 是 admin 的啟用中人類，可以有多位（#8）；
//   平台管理員暫時等同工作區管理員（第一階段只有一個工作區；#9 才改看 accounts.platform_role）
// - 專案管理員＝該專案的 leader（project_members.role＝admin），或有隱含權限的工作區管理員
// - 隱含權限不算成員資格：工作區管理員在沒加入、也沒有職稱的專案不列為成員（implicitOnlyIn）
// - 唯讀成員＝app_settings.read_only 列的人類，他名下的 AI 跟著唯讀；明確設成唯讀時一律不能寫（不看其他角色）
// - AI 不能做任何管理動作
// - 建立專案：工作區管理員；工作區設定「誰可以建立專案」是所有成員時，一般成員（人類）也可以
// 資料都由呼叫端注入（成員資料歸成員資格模組管），這裡只做判斷。
export const ACCESS_ROLE = Object.freeze({
  PLATFORM_ADMIN: 'platform_admin',
  WORKSPACE_ADMIN: 'workspace_admin', MEMBER: 'member',
  PROJECT_ADMIN: 'project_admin', PROJECT_MEMBER: 'project_member', VIEWER: 'viewer',
});
const R = ACCESS_ROLE;

// 這一列是不是工作區管理員（啟用中的人類、workspace_role＝admin）。只看這一列，不必讀成員資料
export const isWorkspaceAdmin = p => !!p && p.kind === 'human' && p.status === 'active' && p.workspace_role === 'admin';
const byJoined = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
// 所有工作區管理員（照加入順序）
export const adminsOf = people => [...people.values()].filter(isWorkspaceAdmin).sort(byJoined);
// 顯示用的「管理員」（錯誤訊息的名字、通知對象）：最早加入的工作區管理員。
// 都沒有（還沒轉換的舊資料、舊備份）才退回 is_admin 標記、最早加入的人類。「能不能」不看這個
export const adminOf = people => {
  const admins = adminsOf(people);
  if (admins.length) return admins[0];
  const hs = [...people.values()].filter(p => p.kind === 'human' && p.status === 'active');
  return hs.find(p => Number(p.is_admin) === 1) || hs.sort(byJoined)[0] || null;
};

// 動作表。admin：管理動作（AI 一律不行）；human：check 時先擋 AI（回「僅限人類」）；light：只看唯讀名單，不必讀成員；
// leads：看 leader 名單，check 時重讀（別份程式剛改過也算數）
// rule(v, me, s)：v 是 load() 的判斷視圖，s 是整理過的範圍 { kind, project, target }
const platformAdmin = (v, me) => v.roleIn(me, 'platform') === R.PLATFORM_ADMIN;
const workspaceAdmin = (v, me) => v.roleIn(me, 'workspace') === R.WORKSPACE_ADMIN;
// 改程式庫、私訊、AI 職務、職稱、專案成員：工作區管理員，或未封存專案的專案管理員
const activeProjectAdmin = (v, me, s) => workspaceAdmin(v, me) || (v.active(s.project) && v.roleIn(me, s) === R.PROJECT_ADMIN);
const ACTIONS = {
  // 平台
  manage_platform: { admin: true, rule: platformAdmin }, // 備份與還原、示範資料、更新檢查
  manage_accounts: { admin: true, rule: platformAdmin }, // 停用／恢復帳號、已停用清單
  assign_platform_admin: { admin: true, rule: platformAdmin }, // 任免平台管理員（#9）
  // 工作區
  manage_workspace: { admin: true, rule: workspaceAdmin }, // 工作區（群組）設定、AI 工具、附件保存時間、第一次設定、檔案稽核全站
  assign_workspace_admin: { admin: true, rule: workspaceAdmin }, // 升降工作區管理員
  invite: { admin: true, rule: workspaceAdmin },
  reset_login: { admin: true, rule: workspaceAdmin },
  assign_members: { admin: true, rule: workspaceAdmin }, // 直接改某人所屬專案、某專案成員名單、跨專案角色
  assign_project_admin: { admin: true, rule: workspaceAdmin }, // 指定 leader
  create_project: { admin: true, fresh: true, rule: (v, me) => workspaceAdmin(v, me) || (v.membersCreateProjects() && v.roleIn(me, 'workspace') === R.MEMBER) }, // fresh：check 時重讀工作區設定
  // 專案（只有工作區管理員）
  delete_project: { admin: true, rule: workspaceAdmin },
  set_project_code: { admin: true, rule: workspaceAdmin },
  set_project_slug: { admin: true, rule: workspaceAdmin },
  // 專案（專案管理員）
  manage_project: { admin: true, human: true, leads: true, rule: (v, me, s) => v.roleIn(me, s) === R.PROJECT_ADMIN }, // 改名、封存、還原、看板狀態、知識庫、技能審核、加入申請（封存的專案也算）
  configure_project: { admin: true, leads: true, rule: activeProjectAdmin }, // 程式庫、私訊開關、AI 職務
  manage_project_members: { admin: true, leads: true, rule: activeProjectAdmin }, // 成員與權限頁：加入／移出、唯讀、職稱
  set_title: { admin: true, leads: true, rule: (v, me, s) => activeProjectAdmin(v, me, s) || (!!s.target && s.target.id === me.id) },
  // 一般
  write: { light: true, rule: (v, me, s) => !v.readOnlyAt(me, s.project) },
  see_project: { light: true, rule: (v, me, s) => !v.isolatedFrom(me) || v.projectsOf(me).includes(s.project) },
  see_project_events: { rule: (v, me, s) => v.projectsOf(me).includes(s.project) || workspaceAdmin(v, me) },
  see_member: { rule: (v, me, { target: p }) => !v.isolatedFrom(me) || p.id === me.id || v.crossRole(p) || v.projectsOf(p).some(x => v.projectsOf(me).includes(x))
    || (p.kind === 'human' && !v.projectsOf(p).length && v.projects().some(pj => v.leads(me, pj))) }, // 專案 leader 另外看得到「還沒有任何專案」的人類，才能把新成員加進自己的專案
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
//   isCrossRole(p)           → 跨專案角色
//   loadLeaders(force)       → 讀 leader 名單（10 秒快取；force 重讀）；leadersOf(pj) → 目前快取裡該專案的 leader id（含封存專案）
//   loadReadOnly(force)      → 讀唯讀名單；isReadOnly(p, pj) → 目前快取裡 p 在 pj 唯讀（AI 跟著所屬人類）
//   titles()                 → { 成員id: { 專案id: 職稱 } }（目前快取）
//   memberProjectsOf(p)      → 他明確加入的（未封存）專案（不含隱含權限；沒給就用 projectsOf）
//   loadWorkspace(force)     → 讀工作區設定（10 秒快取）；membersCreateProjects() → 目前快取裡「一般成員可以建立專案」（沒注入＝不行）
export function createAccess(deps) {
  const { ApiError, requireHuman, nameOf, projects, projectsOf, isolatedFrom, isCrossRole, leadersOf, isReadOnly, titles } = deps;
  const memberProjectsOf = deps.memberProjectsOf || projectsOf;
  // 隱含權限不算成員：工作區管理員在沒加入、也沒有職稱的專案不列為成員（名單、人數、團隊狀態、@所有人都不算）
  const implicitOnly = (p, pj) => !!pj && isWorkspaceAdmin(p) && !memberProjectsOf(p).includes(pj) && !titles()[p.id]?.[pj];

  const readOnlyIn = (p, pj) => !!p && !!pj && isReadOnly(p, pj);
  const readOnlyList = p => projects().filter(pj => readOnlyIn(p, pj));
  const readOnlyError = (p, pj) => new ApiError(403, 'READ_ONLY', `${p?.kind === 'ai' ? '你的所屬人類' : '你'}在「${nameOf(pj)}」是唯讀，只能看，不能發訊息、回覆、建卡、改卡、交接、上傳或私訊。需要權限請找管理員或該專案 leader。AI 收到這個就停下、在本機對話告訴所屬人類，不要重試。`);

  // 判斷視圖：綁定一份成員資料，判斷都是同步的（可以放在 filter 裡）；leader、唯讀看目前快取（load() 會先讀好）
  function view({ people = null } = {}) {
    let admin;
    const needPeople = () => { if (!people) throw new Error('權限判斷需要成員資料（access.load 沒讀成員）'); return people; };
    const adminNow = () => {
      if (admin === undefined) admin = adminOf(needPeople());
      return admin;
    };
    const isAdmin = isWorkspaceAdmin;
    const v = {
      people, admin: adminNow, projects, projectsOf, isolatedFrom, crossRole: isCrossRole,
      admins: () => adminsOf(needPeople()),
      // 最後一位保護：p 是工作區管理員，而且除了他沒有別的（降級、移出、停用、離開都要先問）
      lastAdmin: (p, scope = 'workspace') => scopeOf(scope).kind !== 'project' && isAdmin(p) && !adminsOf(needPeople()).some(x => x.id !== p.id),
      active: pj => projects().includes(pj),
      membersCreateProjects: () => !!deps.membersCreateProjects?.(),
      leads: (p, pj) => !!p && leadersOf(pj).includes(p.id),
      readOnlyAt: (p, pj) => (pj ? readOnlyIn(p, pj) : readOnlyList(p).length > 0),
      roleIn(p, scope) {
        if (!p) return null;
        const s = scopeOf(scope);
        if (s.kind === 'platform') return isAdmin(p) ? R.PLATFORM_ADMIN : null;
        if (s.kind === 'workspace') return isAdmin(p) ? R.WORKSPACE_ADMIN : p.status === 'active' && (p.kind === 'human' || p.kind === 'ai') ? R.MEMBER : null;
        if (isAdmin(p) || v.leads(p, s.project)) return R.PROJECT_ADMIN; // 隱含權限、leader
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
    await deps.loadLeaders(fresh);
    await deps.loadWorkspace?.(fresh);
    return view({ people });
  }

  // 不行就丟錯。opts.what：預設訊息裡「能…」的部分；opts.deny()：自己給錯誤
  // （訊息都要在 public/i18n/en.js 有英文，i18n-test 會掃；新訊息請沿用既有句型或一起加翻譯）
  function denial(v, me, action, s, { what, deny } = {}) {
    if (deny) return deny();
    const adminName = () => v.admin()?.name || '未設定';
    switch (action) {
      case 'write': return readOnlyError(me, s.project || readOnlyList(me)[0]);
      case 'manage_project': case 'configure_project': case 'manage_project_members':
        return new ApiError(403, 'NOT_ADMIN', `只有群組管理員（${adminName()}）或這個專案的 leader 能${what || '管理這個專案'}。`);
      case 'set_title': return new ApiError(403, 'NOT_PROJECT_LEADER', `只有管理員、「${nameOf(s.project)}」的 leader 或 ${s.target?.name || ''} 本人能改他在這個專案的角色。`);
      case 'see_project': return new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案。');
      case 'see_ai_state': return new ApiError(403, 'PROJECT_FORBIDDEN', '這位 AI 不屬於你的專案，看不到它的工作記憶。');
      case 'see_member': return new ApiError(404, 'NOT_FOUND', `找不到成員 ${s.target?.id || ''}`);
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
    load, view, check, adminOf, adminsOf, isWorkspaceAdmin, implicitOnly, readOnlyIn, readOnlyError,
    roleIn: async (ctx, p, scope) => (await load(ctx)).roleIn(p, scope),
    can: async (ctx, me, action, scope) => (await load(ctx, { light: ACTIONS[action]?.light })).can(me, action, scope),
  };
}
