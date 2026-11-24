// 權限模組：伺服器端所有權限判斷都走這裡（詞彙見 GLOSSARY「成員與權限」；架構見 docs/adr/0002）
// 兩個問題、一個介面：
//   roleIn(人, 範圍)          這個人在這個範圍的實際角色（明確角色與上層管理員的隱含權限取較高者）
//   can(人, 動作, 範圍)        能不能在這個範圍做某件事；check() 不行就丟 ApiError
// 範圍：'platform'、'workspace'、{ project: 專案id }；要看對象的動作再帶 target（例：{ project, target }、{ target }）
//
// 第一階段之前的規則（行為與舊版完全相同，之後的票只改這個檔案的規則）：
// - 工作區管理員＝participants.is_admin 標記的那位人類（沒有標記就是最早加入的人類），也是平台管理員
// - 專案管理員＝該專案的 leader（app_settings.project_leaders），或有隱含權限的工作區管理員
// - 唯讀成員＝app_settings.read_only 列的人類，他名下的 AI 跟著唯讀；明確設成唯讀時一律不能寫（不看其他角色）
// - AI 不能做任何管理動作
// 資料都由呼叫端注入（成員資料歸成員資格模組管），這裡只做判斷。
export const ACCESS_ROLE = Object.freeze({
  PLATFORM_ADMIN: 'platform_admin',
  WORKSPACE_ADMIN: 'workspace_admin', MEMBER: 'member',
  PROJECT_ADMIN: 'project_admin', PROJECT_MEMBER: 'project_member', VIEWER: 'viewer',
});
const R = ACCESS_ROLE;

// 管理員：participants.is_admin 標記的那位（可以交給別人）。都沒標記（舊備份）才退回最早加入的人類
export const adminOf = people => {
  const hs = [...people.values()].filter(p => p.kind === 'human' && p.status === 'active');
  return hs.find(p => Number(p.is_admin) === 1) || hs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0] || null;
};

// 動作表。admin：管理動作（AI 一律不行）；human：check 時先擋 AI（回「僅限人類」）；light：只看唯讀名單，不必讀成員
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
  assign_members: { admin: true, rule: workspaceAdmin }, // 直接改某人所屬專案、某專案成員名單、跨專案角色
  assign_project_admin: { admin: true, rule: workspaceAdmin }, // 指定 leader
  create_project: { admin: true, rule: workspaceAdmin },
  // 專案（只有工作區管理員）
  delete_project: { admin: true, rule: workspaceAdmin },
  set_project_code: { admin: true, rule: workspaceAdmin },
  set_project_slug: { admin: true, rule: workspaceAdmin },
  // 專案（專案管理員）
  manage_project: { admin: true, human: true, rule: (v, me, s) => v.roleIn(me, s) === R.PROJECT_ADMIN }, // 改名、封存、還原、看板狀態、知識庫、技能審核、加入申請（封存的專案也算）
  configure_project: { admin: true, rule: activeProjectAdmin }, // 程式庫、私訊開關、AI 職務
  manage_project_members: { admin: true, rule: activeProjectAdmin }, // 成員與權限頁：加入／移出、唯讀、職稱
  set_title: { admin: true, rule: (v, me, s) => activeProjectAdmin(v, me, s) || (!!s.target && s.target.id === me.id) },
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

// deps：
//   ApiError、requireHuman、nameOf(專案id)
//   people(ctx)            → Map<id, participant>
//   projects()             → 未封存的專案 id
//   projectsOf(p)          → 他所在、未封存的專案
//   isolatedFrom(p)        → 不在所有專案（看不到別專案的東西）
//   crossRole(p)           → 跨專案角色
//   leaders/readOnly       → { load(force) 非同步重讀, now() 目前快取 }：{ 專案id: [成員id] }
//   titles()               → { 成員id: { 專案id: 職稱 } }（目前快取）
export function createAccess(deps) {
  const { ApiError, requireHuman, nameOf, projects, projectsOf, isolatedFrom, crossRole, leaders, readOnly, titles } = deps;

  const readOnlyIn = (p, pj, ro = readOnly.now()) => !!p && !!pj && (ro[pj] || []).includes(p.kind === 'ai' ? p.owner_id : p.id);
  const readOnlyList = (p, ro = readOnly.now()) => projects().filter(pj => readOnlyIn(p, pj, ro));
  const readOnlyError = (p, pj) => new ApiError(403, 'READ_ONLY', `${p?.kind === 'ai' ? '你的所屬人類' : '你'}在「${nameOf(pj)}」是唯讀，只能看，不能發訊息、回覆、建卡、改卡、交接、上傳或私訊。需要權限請找管理員或該專案 leader。AI 收到這個就停下、在本機對話告訴所屬人類，不要重試。`);

  // 判斷視圖：一份成員、leader、唯讀名單的快照，判斷都是同步的（可以放在 filter 裡）
  function view({ people = null, leaderMap = leaders.now(), roMap = readOnly.now() } = {}) {
    let admin;
    const adminNow = () => {
      if (admin === undefined) { if (!people) throw new Error('權限判斷需要成員資料（access.load 沒讀成員）'); admin = adminOf(people); }
      return admin;
    };
    const isAdmin = p => !!p && p.kind === 'human' && adminNow()?.id === p.id;
    const v = {
      people, admin: adminNow, projects, projectsOf, isolatedFrom, crossRole,
      active: pj => projects().includes(pj),
      leads: (p, pj) => !!p && (leaderMap[pj] || []).includes(p.id),
      readOnlyAt: (p, pj) => (pj ? readOnlyIn(p, pj, roMap) : readOnlyList(p, roMap).length > 0),
      roleIn(p, scope) {
        if (!p) return null;
        const s = scopeOf(scope);
        if (s.kind === 'platform') return isAdmin(p) ? R.PLATFORM_ADMIN : null;
        if (s.kind === 'workspace') return isAdmin(p) ? R.WORKSPACE_ADMIN : p.status === 'active' && (p.kind === 'human' || p.kind === 'ai') ? R.MEMBER : null;
        if (isAdmin(p) || v.leads(p, s.project)) return R.PROJECT_ADMIN; // 隱含權限、leader
        if (!projectsOf(p).includes(s.project)) return null;
        return readOnlyIn(p, s.project, roMap) ? R.VIEWER : R.PROJECT_MEMBER;
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
    if (light) return view({ roMap: await readOnly.load() });
    const [people, leaderMap, roMap] = [await deps.people(ctx), await leaders.load(fresh), await readOnly.load()];
    return view({ people, leaderMap, roMap });
  }

  // 不行就丟錯。opts.what：預設訊息裡「能…」的部分；opts.deny()：自己給錯誤
  function denial(v, me, action, s, { what, deny } = {}) {
    if (deny) return deny();
    const adminName = () => v.admin()?.name || '未設定';
    switch (action) {
      case 'write': return readOnlyError(me, s.project || readOnlyList(me)[0]);
      case 'manage_project': return new ApiError(403, 'NOT_ADMIN', `只有群組管理員（${adminName()}）或這個專案的 leader 能${what}。`);
      case 'configure_project': return new ApiError(403, 'NOT_ADMIN', `只有群組管理員或「${nameOf(s.project)}」的 leader 能${what}。`);
      case 'manage_project_members': return new ApiError(403, 'NOT_PROJECT_LEADER', `你不是「${nameOf(s.project)}」的 leader，不能改那個專案的成員。`);
      case 'set_title': return new ApiError(403, 'NOT_PROJECT_LEADER', `只有管理員、「${nameOf(s.project)}」的 leader 或 ${s.target?.name || ''} 本人能改他在這個專案的角色。`);
      case 'see_project': return new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案。');
      case 'see_ai_state': return new ApiError(403, 'PROJECT_FORBIDDEN', '這位 AI 不屬於你的專案，看不到它的工作記憶。');
      case 'see_member': return new ApiError(404, 'NOT_FOUND', '找不到這位成員');
      default: return new ApiError(403, 'NOT_ADMIN', `只有群組管理員（${adminName()}）能${what || '管理專案與成員所屬專案'}。`);
    }
  }
  async function check(ctx, me, action, scope, opts = {}) {
    const def = ACTIONS[action];
    if (!def) throw new Error(`沒有這個權限動作：${action}`);
    if (def.human) requireHuman(me);
    const v = await load(ctx, { fresh: true, light: def.light });
    if (!v.can(me, action, scope)) throw denial(v, me, action, scopeOf(scope), opts);
    return v;
  }

  return {
    load, view, check, adminOf, readOnlyIn, readOnlyError,
    roleIn: async (ctx, p, scope) => (await load(ctx)).roleIn(p, scope),
    can: async (ctx, me, action, scope) => (await load(ctx, { light: ACTIONS[action]?.light })).can(me, action, scope),
  };
}
