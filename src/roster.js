// 成員名冊（GLOSSARY「成員與權限」：一個工作區裡所有人與 AI 的清單，所有工作區成員都看得到）
// GET /api/roster：
//   members   所有工作區成員：工作區裡啟用中的人與 AI（包括還沒有專案的人）。有隱含權限的人（平台管理員）不因此列進來
//   removed   已移出工作區的人類（只有工作區管理員，含平台管理員的隱含權）
//   accounts  全平台帳號（含停用；只有平台管理員）
//   members[].upgradeReview  升級前同時是 leader 又是唯讀、先當了唯讀成員的專案 [{ project, projectName }]（只有工作區管理員看得到；
//             升為專案管理員、改了專案角色或按略過（DELETE /api/roster/:id/upgrade-review）後不再列）
//   can       查詢者在名冊上能做的事（畫面決定要不要顯示按鈕；伺服器端照樣各自檢查）
// 每個人的專案資訊（memberships）只列查詢者看得到的專案（私人專案不外洩，access discovers）；AI 查詢時看的是擁有者看得到的。
// 欄位叫 memberships 而不是 projects：core 的 scrubProjects 會把別人的 projects 過濾成「自己在的專案」，名冊要照可見度過濾，不照共同專案。
// 待接受的邀請不在這裡：畫面直接讀 GET /api/invites?status=pending（只有工作區管理員；邀請的存法歸 src/login.js 管）。
import { inWorkspace, byJoined } from './access.js';
import { WORKSPACE_ROLE } from './membership.js';

export const ROSTER_STATUS = Object.freeze({ ACTIVE: 'active', REMOVED: 'removed' });

// deps：route、db、access、peopleMap(ctx)、membership、PROJECTS（未封存專案 id）、nameOf(專案id)、loadTitles()（{ 成員id: { 專案id: 職稱 } }）、
//       isWorkspaceAdmin(p)、isOnline(p, now)、iso(ms)
export function registerRoster({ route, db, access, peopleMap, membership, PROJECTS, nameOf, loadTitles, isWorkspaceAdmin, isOnline, iso }) {
  const human = p => p.kind === 'human';

  route('GET', '/api/roster', async ({ ctx, me }) => {
    const v = await access.load(ctx), people = v.people, now = Date.now();
    const titles = (await loadTitles()) || {};
    // 專案資訊看誰的可見度：人類看自己；AI 看擁有者（AI 在名冊上的範圍跟擁有者一致）
    const viewer = me.kind === 'ai' ? people.get(me.owner_id) || me : me;
    const visible = new Set(PROJECTS.filter(pj => v.discovers(viewer, pj)));
    const roleOf = (p, pj) => {
      if (p.kind === 'ai') return membership.isReadOnly(p, pj) ? 'viewer' : 'member'; // AI 跟著擁有者的唯讀
      return membership.roleOf(p.id, pj) || 'member';
    };
    // 明確的專案成員資格（隱含權限不算），只列看得到的專案
    const memberships = p => membership.projectsOf(p).filter(pj => visible.has(pj)).map(pj => ({ project: pj, projectName: nameOf(pj), role: roleOf(p, pj), title: (human(p) && titles[p.id]?.[pj]) || '' }));
    const personOf = (p, status) => {
      const owner = p.kind === 'ai' ? people.get(p.owner_id) : null;
      return {
        participantId: p.id, name: p.name, memberType: p.kind, role: p.role || '', avatar: p.avatar || null, avatarImg: p.avatar_v || null, shortCode: p.code,
        workspaceRole: isWorkspaceAdmin(p) ? WORKSPACE_ROLE.ADMIN : WORKSPACE_ROLE.MEMBER, platformRole: membership.isPlatformAdmin(p) ? 'admin' : 'none',
        ...(p.kind === 'ai' ? { ownerParticipantId: p.owner_id, ownerName: owner?.name ?? null } : {}),
        status, isOnline: status === ROSTER_STATUS.ACTIVE && isOnline(p, now), joinedAt: p.created_at,
        memberships: status === ROSTER_STATUS.ACTIVE ? memberships(p) : [],
      };
    };
    const all = [...people.values()].sort(byJoined);
    // 升級時要確認的專案角色：只列現在實際上還是唯讀成員的專案（升為工作區管理員、改了專案角色就不列）
    const reviews = v.can(me, 'review_upgrade', 'workspace') ? await membership.upgradeReviews() : new Map();
    const reviewOf = p => (reviews.get(p.id) || []).filter(pj => visible.has(pj) && v.roleIn(p, { project: pj }) === 'viewer').map(pj => ({ project: pj, projectName: nameOf(pj) }));
    const can = {
      assignWorkspaceAdmin: v.can(me, 'assign_workspace_admin', 'workspace'),
      removeMember: v.can(me, 'remove_member', 'workspace'),
      assignPlatformAdmin: v.can(me, 'assign_platform_admin', 'platform'),
      manageAccounts: v.can(me, 'manage_accounts', 'platform'),
    };
    const out = {
      members: all.filter(p => p.status === 'active' && (human(p) || p.kind === 'ai') && inWorkspace(p)).map(p => {
        const out = personOf(p, ROSTER_STATUS.ACTIVE), review = human(p) ? reviewOf(p) : [];
        return review.length ? { ...out, upgradeReview: review } : out;
      }),
      can,
    };
    if (v.can(me, 'see_removed_members', 'workspace')) {
      out.removed = all.filter(p => human(p) && !inWorkspace(p)).map(p => ({ ...personOf(p, ROSTER_STATUS.REMOVED), removedAt: p.updated_at || null }));
    }
    if (can.manageAccounts) {
      const rows = await db.all("SELECT p.id, a.platform_role, a.status FROM participants p JOIN accounts a ON a.id = p.account_id WHERE p.kind = 'human'");
      const acct = new Map(rows.map(r => [r.id, r]));
      out.accounts = all.filter(p => human(p) && acct.has(p.id)).map(p => ({
        participantId: p.id, name: p.name, accountStatus: acct.get(p.id).status === 'disabled' || p.status === 'disabled' ? 'disabled' : 'active',
        platformRole: acct.get(p.id).platform_role === 'admin' ? 'admin' : 'none', workspaceRole: p.workspace_role === WORKSPACE_ROLE.ADMIN ? WORKSPACE_ROLE.ADMIN : WORKSPACE_ROLE.MEMBER,
        workspaceStatus: inWorkspace(p) ? 'active' : 'removed', joinedAt: p.created_at,
      }));
    }
    return out;
  });
  // 略過升級時的專案角色確認（工作區管理員）：專案角色不變，只是名冊上不再標
  route('DELETE', '/api/roster/:id/upgrade-review', async ({ ctx, me, params }) => {
    await access.check(ctx, me, 'review_upgrade', 'workspace', { what: '略過升級時的專案角色確認' });
    await membership.clearUpgradeReview(params.id);
    return { ok: true };
  });
}
