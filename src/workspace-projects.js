import { createAccess, effectiveProjects, inWorkspace } from './access.js';
import { PROJECT_ROLE } from './membership.js';
import { CREATE_PROJECTS, DELETE_OWN_MESSAGES } from './workspace-settings.js';

// Read models for the opted-in project GETs. No authorization data here is stored in the legacy app caches.
export async function loadWorkspaceProjects({ db, scope, principal, ApiError }) {
  const { workspaceId, participantId, platformAdmin } = scope;
  const [rows, peopleRows, memberships] = await Promise.all([
    db.all('SELECT * FROM projects WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id', workspaceId),
    db.all(`SELECT p.id, p.name, p.kind, p.status, p.workspace_status, p.workspace_role, p.owner_id, p.role_key, p.created_at,
      a.status AS account_status, a.platform_role FROM participants p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.workspace_id = ?`, workspaceId),
    db.all(`SELECT m.project_id, m.participant_id, m.role FROM project_members m
      JOIN projects j ON j.id = m.project_id JOIN participants p ON p.id = m.participant_id AND p.workspace_id = j.workspace_id
      WHERE j.workspace_id = ? AND j.deleted_at IS NULL ORDER BY j.created_at, j.id, m.rowid`, workspaceId),
  ]);
  const people = new Map(peopleRows.map(p => [p.id, p]));
  const activeMember = p => p?.status === 'active' && inWorkspace(p) && (p.kind !== 'human' || p.account_status === 'active');
  const members = new Map([...people].filter(([, p]) => activeMember(p)));
  const member = members.get(participantId);
  // Implicit platform access is not a workspace or project membership.
  const viewer = member ?? (platformAdmin ? { id: null, kind: 'human', status: 'active', workspace_status: 'removed' } : null);
  const isPlatformAdmin = p => p === viewer ? platformAdmin : p.account_status === 'active' && p.platform_role === 'admin';
  const active = rows.filter(r => !r.archived).map(r => r.id);
  const visibility = new Map(rows.map(r => [r.id, r.visibility]));
  const byPerson = new Map(), byProject = new Map();
  for (const { project_id: pj, participant_id: id, role } of memberships) {
    if (!members.has(id)) continue;
    if (!byPerson.has(id)) byPerson.set(id, new Map());
    if (!byProject.has(pj)) byProject.set(pj, new Map());
    byPerson.get(id).set(pj, role);
    byProject.get(pj).set(id, role);
  }
  const listOf = p => [...(byPerson.get(p?.id)?.keys() || [])];
  const ownerOf = p => members.get(p.owner_id);
  const idsWith = (pj, role) => [...(byProject.get(pj) || [])].filter(([, r]) => r === role).map(([id]) => id);
  const projectsOf = effectiveProjects({ projects: () => active, memberProjectsOf: p => active.filter(pj => byPerson.get(p?.id)?.has(pj)),
    implicitAll: p => permissions.adminInWorkspace(p), ownerOf });
  const isolatedFrom = p => !!p && active.some(pj => !projectsOf(p).includes(pj));
  const hiddenArchived = p => rows.filter(r => r.archived && !listOf(p).includes(r.id) && !v.discovers(p, r.id)).map(r => r.id);
  const permissions = createAccess({ ApiError, nameOf: pj => rows.find(r => r.id === pj)?.name,
    people: async () => members, loadReadOnly: async () => {}, loadProjectAdmins: async () => {},
    projects: () => active, projectsOf, isolatedFrom, hiddenArchived, ownerOf, isPlatformAdmin, memberProjectsOf: listOf,
    visibilityOf: pj => visibility.get(pj), projectAdminsOf: pj => idsWith(pj, PROJECT_ROLE.ADMIN),
    isReadOnly: (p, pj) => byPerson.get(p.kind === 'ai' ? p.owner_id : p.id)?.get(pj) === PROJECT_ROLE.VIEWER,
    membersCreateProjects: () => scope.createProjects === CREATE_PROJECTS.MEMBERS,
    membersRequestProjects: () => scope.createProjects === CREATE_PROJECTS.APPROVAL,
  });
  const v = permissions.view({ people: members });
  // If the workspace no longer contains the AI's owning human, its old project edges cannot grant access.
  const me = principal.kind === 'ai' && !ownerOf(principal) ? null : viewer;
  return { workspaceId, rows, active, people, members, me, v, check: permissions.check, listOf, projectsOf, isolatedFrom, hiddenArchived, ownerOf,
    projectAdminsOf: pj => idsWith(pj, PROJECT_ROLE.ADMIN), readOnlyOf: pj => idsWith(pj, PROJECT_ROLE.VIEWER),
    projectFlags: p => ({
      canCreateProject: v.can(p, 'create_project', 'workspace'),
      canRequestProjectCreation: v.can(p, 'request_project_creation', 'workspace'),
      canReviewProjectCreationRequests: v.can(p, 'review_project_creation_requests', 'workspace'),
      ...(p.kind === 'human' ? { canDeleteOwnMessages: (inWorkspace(p) && scope.deleteOwnMessages === DELETE_OWN_MESSAGES.MEMBERS) || v.can(p, 'delete_message', 'workspace') } : {}),
    }),
  };
}
