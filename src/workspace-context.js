import { DEFAULT_WORKSPACE } from './membership.js';

// Selection chooses only a workspace ID. Account and membership always come from authenticated identity and current rows.
export async function resolveWorkspaceContext({ db, request, principal, selectWorkspace, ApiError }) {
  const hidden = () => new ApiError(404, 'NOT_FOUND', '找不到這個專案');
  if (principal.kind !== 'human') {
    // AI credentials stay bound to their participant's workspace; they cannot select another.
    if (principal.workspace_id !== DEFAULT_WORKSPACE) throw hidden();
    return { workspaceId: DEFAULT_WORKSPACE, participantId: principal.id, accountId: null, platformAdmin: false };
  }
  const accountId = principal.account_id;
  const workspaceId = (accountId && await selectWorkspace?.({ request, accountId })) ?? DEFAULT_WORKSPACE;
  if (typeof workspaceId !== 'string' || !workspaceId) throw hidden();
  const rows = await db.all(`SELECT a.status, a.platform_role, w.id AS workspace_id, w.create_projects, w.delete_own_messages, p.id AS participant_id
    FROM accounts a LEFT JOIN workspaces w ON w.id = ?
    LEFT JOIN participants p ON p.account_id = a.id AND p.workspace_id = w.id AND p.kind = 'human'
      AND p.status = 'active' AND p.workspace_status = 'active'
    WHERE a.id = ? LIMIT 2`, workspaceId, accountId);
  const row = rows[0];
  if (row?.status !== 'active') throw new ApiError(401, 'INVALID_TOKEN', 'Token 不存在、已重設或已撤銷');
  const platformAdmin = row.platform_role === 'admin';
  if (!row.workspace_id || rows.length !== 1 || (!row.participant_id && !platformAdmin)) {
    if (workspaceId === DEFAULT_WORKSPACE && !platformAdmin && !row.participant_id && principal.workspace_id === workspaceId && principal.workspace_status === 'removed')
      throw new ApiError(401, 'INVALID_TOKEN', '你已不是這個工作區的成員');
    throw hidden();
  }
  return { workspaceId, accountId, participantId: row.participant_id, platformAdmin,
    createProjects: row.create_projects, deleteOwnMessages: row.delete_own_messages };
}
