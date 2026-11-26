// Transactional writes against the global key in ADR 0006. Compose these statements
// into the caller's batch after its workspace lock and guards. Legacy settings
// and claim mutations must commit together.
import { routeToken } from './project-identity-claims.js';
import { ensureStmt } from './write-order.js';

const namespaceOf = { slug: 'slug', project_id: 'slug', current_code: 'code', historical_code: 'code' };
const tokenOf = (namespace, raw) => namespace === 'slug' ? routeToken(raw) : raw.replace(/[a-z]/g, c => c.toUpperCase());
function claimant([source, raw]) {
  const namespace = namespaceOf[source];
  if (!namespace) throw new Error(`Unknown project claim source: ${source}`);
  return { namespace, value: tokenOf(namespace, raw), source, raw };
}

function noOtherClaimant(namespace, raw, projectId) {
  return {
    cond: `NOT EXISTS (SELECT 1 FROM project_identity_claimants WHERE namespace = ? AND value = ? AND project_id != ?)`,
    args: [namespace, tokenOf(namespace, raw), projectId],
  };
}

export function claimAvailable(namespace, raw, projectId) {
  const { cond, args } = noOtherClaimant(namespace, raw, projectId);
  return {
    cond: `${cond} AND NOT EXISTS (SELECT 1 FROM project_identity_claims c WHERE c.namespace = ? AND c.value = ?
      AND NOT EXISTS (SELECT 1 FROM project_identity_claimants s WHERE s.namespace = c.namespace AND s.value = c.value))`,
    args: [...args, ...args.slice(0, 2)],
  };
}

export async function reservedProjectIdentifiers(db) {
  return db.all(`SELECT c.namespace, c.value,
    CASE WHEN COUNT(DISTINCT s.project_id) = 1 THEN MIN(s.project_id) ELSE NULL END AS project_id
    FROM project_identity_claims c LEFT JOIN project_identity_claimants s ON s.namespace = c.namespace AND s.value = c.value
    GROUP BY c.namespace, c.value`);
}

// An UPSERT on an occupied key waits for its holder in PostgreSQL. The next
// statement sees the committed claimants at READ COMMITTED. SQLite and D1
// serialize the same batch. Acquire every affected key in the same order.
export function lockProjectClaimKeysStmts(keys) {
  return [...keys].sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 :
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0).map(({ namespace, value, acquire }) => acquire ? [
    `INSERT INTO project_identity_claims (namespace, value) VALUES (?, ?)
      ON CONFLICT (namespace, value) DO UPDATE SET value = excluded.value`, [namespace, value],
  ] : ['UPDATE project_identity_claims SET value = value WHERE namespace = ? AND value = ?', [namespace, value]]);
}

// add/remove entries are [source, raw value]. requireExclusive also checks a
// released key before a normal identifier edit. Confirmed repairs must supply
// their preview's claimant comparison and explicit retirement rules instead.
export function projectClaimMutationStmts(projectId, { add = [], remove = [], requireExclusive = [] }) {
  const incoming = add.map(claimant), outgoing = remove.map(claimant);
  const keyOf = ({ namespace, value }) => JSON.stringify([namespace, value]);
  const keys = new Map(outgoing.map(row => [keyOf(row), row]));
  for (const row of incoming) keys.set(keyOf(row), { ...row, acquire: true });
  const exclusive = new Map([...incoming, ...requireExclusive.map(claimant)].map(row => [keyOf(row), row]));
  for (const [key, row] of exclusive) if (!keys.has(key)) keys.set(key, row);
  return [
    ...Array.from(keys.values()).filter(row => row.acquire).map(({ namespace, value }) => {
      const { cond, args } = claimAvailable(namespace, value, projectId);
      return ensureStmt(cond, args);
    }),
    ...lockProjectClaimKeysStmts(keys.values()),
    ...Array.from(exclusive.values(), ({ namespace, value }) => {
      const { cond, args } = noOtherClaimant(namespace, value, projectId);
      return ensureStmt(cond, args);
    }),
    ...outgoing.map(({ namespace, value, source, raw }) => [
      `DELETE FROM project_identity_claimants WHERE namespace = ? AND value = ? AND project_id = ? AND source = ? AND raw_value = ?
        AND NOT EXISTS (SELECT 1 FROM project_identity_claimants WHERE namespace = ? AND value = ? AND project_id != ?)`,
      [namespace, value, projectId, source, raw, namespace, value, projectId],
    ]),
    ...incoming.map(({ namespace, value, source, raw }) => [
      `INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (namespace, value, project_id, source, raw_value) DO NOTHING`, [namespace, value, projectId, source, raw],
    ]),
    ...Array.from(new Map(outgoing.map(row => [keyOf(row), row])).values(), ({ namespace, value }) => [
      `DELETE FROM project_identity_claims WHERE namespace = ? AND value = ?
        AND NOT EXISTS (SELECT 1 FROM project_identity_claimants WHERE namespace = ? AND value = ?)`,
      [namespace, value, namespace, value],
    ]),
  ];
}

export function newProjectClaimStmts(id, slug, code) {
  return projectClaimMutationStmts(id, { add: [['project_id', id], ['slug', slug], ['current_code', code]] });
}

// Recover/unarchive only when the current identifiers and the ID route have
// their expected claimant rows and none has another claimant. Historical-only
// disputes remain reserved independently of the recovery window.
export function recoverableProjectClaims(id) {
  return {
    cond: `EXISTS (SELECT 1 FROM project_identity_claimants c WHERE c.project_id = ? AND c.source = 'project_id' AND c.value = ?)
      AND EXISTS (SELECT 1 FROM project_identity_claimants c JOIN app_settings s ON s.key = ? AND lower(s.value) = c.value WHERE c.project_id = ? AND c.source = 'slug')
      AND EXISTS (SELECT 1 FROM project_identity_claimants c JOIN app_settings s ON s.key = ? AND s.value = c.value WHERE c.project_id = ? AND c.source = 'current_code')
      AND (${undisputedCurrentClaimsSql()})`,
    args: [id, routeToken(id), 'slug:' + id, id, 'pcode:' + id, id, id],
  };
}

// Legacy readers can fall through to another project if a disputed current
// claimant disappears. Permanent removal waits for a confirmed repair.
export const undisputedCurrentClaimsSql = (projectIdExpr = '?') => `NOT EXISTS (
  SELECT 1 FROM project_identity_claimants c JOIN project_identity_claimants other
    ON other.namespace = c.namespace AND other.value = c.value AND other.project_id != c.project_id
  WHERE c.project_id = ${projectIdExpr} AND c.source IN ('project_id', 'slug', 'current_code'))`;

// Take the snapshot outside the batch and check it again under the workspace
// lock. Release a disputed key only through a confirmed repair, even when a
// claimant's project is permanently purged.
export async function purgeProjectClaimStmts(db, id) {
  const rows = await db.all('SELECT source, raw_value FROM project_identity_claimants WHERE project_id = ?', id);
  const remove = rows.map(r => [r.source, r.raw_value]);
  const snapshot = JSON.stringify(rows);
  return [
    ensureStmt(undisputedCurrentClaimsSql(), [id]),
    ensureStmt(`(SELECT COUNT(*) FROM project_identity_claimants WHERE project_id = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM (SELECT json_extract(value, '$.source') AS source, json_extract(value, '$.raw_value') AS raw_value
        FROM json_each(?)) AS snapshot WHERE NOT EXISTS (SELECT 1 FROM project_identity_claimants c
          WHERE c.project_id = ? AND c.source = snapshot.source AND c.raw_value = snapshot.raw_value))`, [id, rows.length, snapshot, id]),
    ...projectClaimMutationStmts(id, { remove }),
  ];
}
