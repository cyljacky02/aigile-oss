// ADR 0006：正規化時留下全站識別碼及來源的快照。切換所有寫入之前，舊設定仍負責查找與碰撞檢查。
export const CLAIMS_VERSION = 1;
export function claimsSeeded(marker) {
  try { return JSON.parse(marker)?.claimsVersion === CLAIMS_VERSION; } catch { return false; }
}

function claimants(rows, shown) {
  const slug = (projectId, source, rawValue) => ({ namespace: 'slug', value: rawValue.toLowerCase(), projectId, source, rawValue });
  const code = (projectId, source, rawValue) => ({ namespace: 'code', value: rawValue.toUpperCase(), projectId, source, rawValue });
  return [
    ...rows.flatMap(({ id }) => [slug(id, 'slug', shown.slugs[id]), slug(id, 'project_id', id), code(id, 'current_code', shown.codes[id])]),
    // 舊代號的專案可能已不存在，舊設定仍保留這個代號。
    ...Object.entries(shown.olds).map(([value, projectId]) => code(projectId, 'historical_code', value)),
  ];
}

// 整批取代快照：還原時可能是完全不同的資料集。由呼叫端在工作區列鎖與快照斷言之後提交。
export function seedClaimsStmts(rows, shown) {
  const sources = JSON.stringify(claimants(rows, shown));
  const ns = "json_extract(value, '$.namespace')", value = "json_extract(value, '$.value')";
  return [
    ['DELETE FROM project_identity_claimants', []],
    ['DELETE FROM project_identity_claims', []],
    [`INSERT INTO project_identity_claims (namespace, value) SELECT DISTINCT ${ns}, ${value} FROM json_each(?)`, [sources]],
    [`INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value)
      SELECT ${ns}, ${value}, json_extract(value, '$.projectId'), json_extract(value, '$.source'), json_extract(value, '$.rawValue') FROM json_each(?)`, [sources]],
  ];
}

export async function diagnoseClaims(db, { rows, shown, marker, restoring }) {
  if (restoring) return { status: 'restoring', disputes: [] };
  if (!claimsSeeded(marker)) return { status: 'pending', disputes: [] };
  const stored = await db.all(`SELECT c.namespace, c.value, s.project_id, s.source, s.raw_value
    FROM project_identity_claims c LEFT JOIN project_identity_claimants s ON s.namespace = c.namespace AND s.value = c.value
    ORDER BY c.namespace, c.value, s.project_id, s.source, s.raw_value`);
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
