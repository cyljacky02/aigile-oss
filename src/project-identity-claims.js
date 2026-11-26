// ADR 0006：正規化時留下全站識別碼及來源的快照。切換所有寫入之前，舊設定仍負責查找與碰撞檢查。
export const CLAIMS_VERSION = 1;
export const CLAIM_TABLES = ['project_identity_claims', 'project_identity_claimants'];
export function isMissingClaimTable(error) {
  const message = String(error?.message ?? '');
  const table = error?.code === '42P01' ? message.match(/relation "(?:[^".]+\.)?([^".]+)" does not exist/)?.[1]
    : message.match(/\bno such table: (?:\w+\.)?(\w+)(?=[:\s]|$)/i)?.[1];
  return CLAIM_TABLES.includes(table);
}
// LIMIT 0：確認兩張表都已存在，不讀資料列。
export const CLAIM_SCHEMA_QUERY = 'SELECT 1 FROM project_identity_claims CROSS JOIN project_identity_claimants LIMIT 0';
export function claimsSeeded(marker) {
  try { return JSON.parse(marker)?.claimsVersion === CLAIMS_VERSION; } catch { return false; }
}

// 新網址英文名與代號只含 ASCII。舊專案 ID 的非 ASCII 字元保留原樣，只折疊 ASCII 大小寫，與 SQLite／D1 及 Postgres 的 C 排序一致。
export const routeToken = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
const codeToken = value => value.replace(/[a-z]/g, c => c.toUpperCase());
const DISPUTED = 'HAVING COUNT(DISTINCT project_id) > 1';
export const notDisputed = namespace => `NOT EXISTS (SELECT 1 FROM project_identity_claimants
  WHERE namespace = '${namespace}' AND value = ? GROUP BY namespace, value ${DISPUTED})`;
export async function readDisputed(db) {
  try { return await db.all(`SELECT namespace, value FROM project_identity_claimants GROUP BY namespace, value ${DISPUTED}`); }
  catch (error) { if (isMissingClaimTable(error)) return []; throw error; }
}

function claimants(rows, shown) {
  const slug = (projectId, source, rawValue) => ({ namespace: 'slug', value: routeToken(rawValue), projectId, source, rawValue });
  const code = (projectId, source, rawValue) => ({ namespace: 'code', value: codeToken(rawValue), projectId, source, rawValue });
  return [
    ...rows.flatMap(({ id }) => [slug(id, 'slug', shown.slugs[id]), slug(id, 'project_id', id), code(id, 'current_code', shown.codes[id])]),
    // 舊代號的專案可能已不存在，舊設定仍保留這個代號。
    ...Object.entries(shown.olds).map(([value, projectId]) => code(projectId, 'historical_code', value)),
  ];
}

// 以正規化後的資料直接寫入保留表，避免把全部來源序列化成一個 D1 綁定值。
const SOURCE_ROWS = `SELECT 'slug' AS namespace, lower(s.value) AS value, p.id AS project_id, 'slug' AS source, s.value AS raw_value
  FROM projects p JOIN app_settings s ON s.key = 'slug:' || p.id
  UNION ALL SELECT 'slug', lower(id), id, 'project_id', id FROM projects
  UNION ALL SELECT 'code', s.value, p.id, 'current_code', s.value
  FROM projects p JOIN app_settings s ON s.key = 'pcode:' || p.id
  UNION ALL SELECT 'code', upper(substr(key, 10)), value, 'historical_code', substr(key, 10)
  FROM app_settings WHERE key >= 'pcodeold:' AND key < 'pcodeold;'`;

// 還原先保留備份裡由不同專案共同宣稱的值，再用舊設定重建現況。由呼叫端在同一批交易內提交。
export function seedClaimsStmts({ keepDisputes }) {
  return [
    [keepDisputes ? `DELETE FROM project_identity_claimants WHERE (namespace, value) IN (
      SELECT namespace, value FROM project_identity_claimants GROUP BY namespace, value HAVING COUNT(DISTINCT project_id) = 1
    )` : 'DELETE FROM project_identity_claimants', []],
    [`DELETE FROM project_identity_claims WHERE NOT EXISTS (SELECT 1 FROM project_identity_claimants s
      WHERE s.namespace = project_identity_claims.namespace AND s.value = project_identity_claims.value)`, []],
    [`INSERT INTO project_identity_claims (namespace, value)
      SELECT DISTINCT namespace, value FROM (${SOURCE_ROWS}) AS sources WHERE 1 = 1
      ON CONFLICT (namespace, value) DO NOTHING`, []],
    [`INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value)
      SELECT namespace, value, project_id, source, raw_value FROM (${SOURCE_ROWS}) AS sources WHERE 1 = 1
      ON CONFLICT (namespace, value, project_id, source, raw_value) DO NOTHING`, []],
  ];
}

export async function diagnoseClaims(db, { rows, shown, marker, restoring }) {
  if (restoring) return { status: 'restoring', disputes: [] };
  if (!claimsSeeded(marker)) return { status: 'pending', disputes: [] };
  let stored;
  try {
    stored = await db.all(`SELECT c.namespace, c.value, s.project_id, s.source, s.raw_value
      FROM project_identity_claims c LEFT JOIN project_identity_claimants s ON s.namespace = c.namespace AND s.value = c.value
      ORDER BY c.namespace, c.value, s.project_id, s.source, s.raw_value`);
  } catch (error) { if (isMissingClaimTable(error)) return { status: 'pending', disputes: [] }; throw error; }
  const key = (namespace, value, id, source, raw) => JSON.stringify([namespace, value, id, source, raw]);
  const expected = new Set(claimants(rows, shown).map(c => key(c.namespace, c.value, c.projectId, c.source, c.rawValue)));
  const expectedCount = expected.size, groups = new Map();
  for (const r of stored) {
    expected.delete(key(r.namespace, r.value, r.project_id, r.source, r.raw_value));
    const token = JSON.stringify([r.namespace, r.value]);
    if (!groups.has(token)) groups.set(token, { namespace: r.namespace, value: r.value, claimants: [] });
    if (r.project_id !== null) groups.get(token).claimants.push({ projectId: r.project_id, source: r.source, rawValue: r.raw_value });
  }
  const current = expected.size === 0 && stored.length === expectedCount;
  const disputes = [...groups.values()].filter(g => new Set(g.claimants.map(c => c.projectId)).size > 1);
  return { status: current ? 'current' : 'stale', disputes };
}
