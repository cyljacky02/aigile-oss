// 平台診斷的試算（唯讀）：預覽和確認共用提案、解析與指紋。
import { CODE_RE, displayedIdentity, identityConflicts, identitySnapshotStmt, projectForCardCode, splitIdentitySettings } from './project-identity.js';
import { ensureStmt } from './write-order.js';

const setIdentity = (key, value) => ['INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]];

const CONFLICT_FIELDS = { duplicate_code: 'code', code_is_old_alias: 'code', duplicate_slug: 'slug', duplicate_name: 'name' };
const isActive = row => row && !row.deleted_at && !Number(row.archived);
const projectStatus = row => !row ? 'missing' : row.deleted_at ? 'recoverable' : Number(row.archived) ? 'archived' : 'reachable';

export async function prepareProjectIdentityRepair({ db, projectIdentity, ApiError, sha256 }, { projectId, field, replacement, reference, retireAlias }) {
  const { rows, settings, shown } = await projectIdentity.snapshot();
  const byId = new Map(rows.map(row => [row.id, row]));
  const project = byId.get(projectId);
  if (!project) throw new ApiError(404, 'NOT_FOUND', '找不到這個專案');
  const current = field === 'code' ? shown.codes[projectId] : field === 'slug' ? shown.slugs[projectId] : project.name;
  const conflicts = identityConflicts(rows, shown).filter(c => CONFLICT_FIELDS[c.kind] === field && c.value === current && c.projects.includes(projectId));
  if (!conflicts.length) throw new ApiError(409, 'IDENTITY_CONFLICT_CHANGED', '這個值已不在專案識別碼的衝突清單中，請重新讀取診斷。');

  const codeClaimants = value => [...new Set([
    ...rows.filter(row => shown.codes[row.id] === value).map(row => row.id),
    ...settings.filter(r => r.key.startsWith('pcode:') && r.value === value).map(r => r.key.slice(6)),
    ...(Object.hasOwn(shown.olds, value) ? [shown.olds[value]] : []),
  ])];
  const slugClaimants = value => [...new Set([
    ...rows.filter(row => shown.slugs[row.id] === value || row.id.toLowerCase() === value).map(row => row.id),
    ...settings.filter(r => r.key.startsWith('slug:') && r.value === value).map(r => r.key.slice(5)),
  ])];
  const nameClaimants = value => rows.filter(row => isActive(row) && row.name === value).map(row => row.id);
  const claimants = { code: codeClaimants, slug: slugClaimants, name: nameClaimants }[field];
  const info = id => {
    const row = byId.get(id);
    return { id, name: row?.name ?? null, slug: shown.slugs[id] ?? null, code: shown.codes[id] ?? null,
      archived: !!Number(row?.archived), deleted: !!row?.deleted_at };
  };
  const owners = claimants(replacement).filter(id => id !== projectId);
  let retiredAlias = null;
  if (retireAlias) {
    if (replacement !== current) throw new ApiError(400, 'INVALID_REQUEST', '停用舊代號時，替換值須為要保留的現行代號。');
    if (!conflicts.some(c => c.kind === 'code_is_old_alias') || conflicts.some(c => c.kind === 'duplicate_code'))
      throw new ApiError(409, 'IDENTITY_CONFLICT_CHANGED', '停用舊代號需要唯一的現行代號和另一個專案的舊代號。');
    retiredAlias = { code: current, projectId: shown.olds[current] };
  } else if (owners.length || replacement === current) {
    const error = { code: ['CODE_TAKEN', '這個專案代號已被使用或保留。'], slug: ['SLUG_TAKEN', '這個網址英文名已被使用或保留。'], name: ['NAME_TAKEN', '已有同名的專案'] }[field];
    throw new ApiError(409, ...error, { field, projects: owners.map(info) });
  }

  const affected = new Set([projectId, ...claimants(current)]);
  let cardReferences = [], routes = [], codeChanges = [];
  const cardWitnesses = new Map(), sampleWitnesses = new Map(), changes = [];
  if (field === 'code') {
    const proposed = splitIdentitySettings(settings);
    if (retiredAlias) {
      delete proposed.olds[current];
      changes.push(['DELETE FROM app_settings WHERE key = ?', ['pcodeold:' + current]]);
    } else {
      proposed.codes[projectId] = replacement;
      changes.push(setIdentity('pcode:' + projectId, replacement));
      // 舊代號還有其他持有者時，由他們保留，不能另外加上自己的別名。
      if (!codeClaimants(current).some(id => id !== projectId)) {
        proposed.olds[current] = projectId;
        changes.push(setIdentity('pcodeold:' + current, projectId));
      }
    }
    const after = displayedIdentity(rows, proposed);
    for (const { id } of rows) {
      if (shown.codes[id] === after.codes[id]) continue;
      codeChanges.push({ projectId: id, before: shown.codes[id], after: after.codes[id] });
      affected.add(id);
    }
    const sampledCodes = new Set([current, replacement]);
    const codes = new Set(sampledCodes);
    const changed = new Set(codeChanges.map(c => c.projectId));
    for (const { before, after } of codeChanges) { codes.add(before); codes.add(after); }
    for (const [code, id] of Object.entries(shown.olds)) if (changed.has(id) && CODE_RE.test(code)) codes.add(code);
    if (reference && !codes.has(reference.split('-')[0])) throw new ApiError(400, 'INVALID_REQUEST', '請輸入受影響的卡號前綴。');
    cardReferences = await previewCardReferences(db, byId, projectId, shown, after, codes, sampledCodes, codeClaimants, reference, cardWitnesses, sampleWitnesses);
  } else {
    if (field === 'name') changes.push(['UPDATE projects SET name = ? WHERE id = ?', [replacement, projectId]]);
    else {
      // Just like the regular slug writer, keep the current card code even if it was only derived.
      const proposed = splitIdentitySettings(settings);
      if (!CODE_RE.test(proposed.codes[projectId] ?? '')) {
        proposed.codes[projectId] = shown.codes[projectId];
        proposed.slugs[projectId] = replacement;
        const after = displayedIdentity(rows, proposed);
        if (rows.some(({ id }) => after.codes[id] !== shown.codes[id])) {
          // In an unnormalized legacy snapshot, pin the remaining derived codes too if their derivation would shift.
          for (const { id } of rows) if (!CODE_RE.test(proposed.codes[id] ?? '')) changes.push(setIdentity('pcode:' + id, shown.codes[id]));
        }
        changes.push(setIdentity('pcode:' + projectId, shown.codes[projectId]));
      }
      changes.push(setIdentity('slug:' + projectId, replacement));
    }
    const before = rows.map(row => ({ ...row, slug: shown.slugs[row.id] }));
    const after = before.map(row => row.id === projectId ? { ...row, [field]: replacement } : row);
    routes = [current, replacement].map(value => previewProjectRoute(value, before, after));
    for (const route of routes) for (const id of route.claimants) affected.add(id);
  }
  // 指紋綁定正規化後的提案與讀到的專案、識別碼設定。確認端仍需在交易中驗證狀態。
  const state = await sha256(JSON.stringify([projectId, field, replacement, retiredAlias,
    rows.map(r => [r.id, r.name, Number(r.archived), r.deleted_at, r.created_at]),
    settings.map(r => [r.key, r.value]).sort(),
  ]));
  const resolutionState = await sha256(JSON.stringify([state, reference ?? null, routes, cardReferences,
    [...cardWitnesses].map(([key, { direct, moved, card }]) => [key, { direct, moved, card }]),
  ]));
  return {
    plan: { projectId, field, current, replacement, retiredAlias, projects: [...affected].map(info), conflicts, routes, cardReferences, codeChanges, state, resolutionState },
    changes,
    assertions: () => ({ identity: identitySnapshotStmt({ rows, settings }), resolution: cardResolutionStmt(cardWitnesses, sampleWitnesses) }),
  };
}

// Check every represented lookup (including absent rows and shadowed aliases) in a single SQL snapshot.
// Also check the queries that selected the samples; an inserted earlier card/alias can change the examples.
function cardResolutionStmt(witnesses, samples) {
  if (!witnesses.size && !samples.size) return null;
  const lookups = [...witnesses.values()].map(({ projectId, no, direct, moved, movedSeq, card }) => ({
    projectId, no, direct, moved, movedSeq, seq: card?.seq, uid: card?.uid, project: card?.project, projNo: card?.proj_no,
  }));
  return ensureStmt(`NOT EXISTS (
    SELECT 1 FROM (SELECT value FROM json_each(?)) AS w WHERE EXISTS (
      SELECT c.seq, m.value, COALESCE(c.seq, mc.seq), COALESCE(c.uid, mc.uid),
        COALESCE(c.project, mc.project), CASE WHEN c.seq IS NULL THEN mc.proj_no ELSE c.proj_no END
      FROM (SELECT 1) AS base
      LEFT JOIN cards c ON c.project = json_extract(w.value, '$.projectId') AND c.proj_no = CAST(json_extract(w.value, '$.no') AS INTEGER)
      LEFT JOIN app_settings m ON m.key = 'cardmoved:' || json_extract(w.value, '$.projectId') || ':' || json_extract(w.value, '$.no')
      LEFT JOIN cards mc ON c.seq IS NULL AND mc.seq = CAST(json_extract(w.value, '$.movedSeq') AS INTEGER)
      EXCEPT SELECT CAST(json_extract(w.value, '$.direct') AS INTEGER), json_extract(w.value, '$.moved'),
        CAST(json_extract(w.value, '$.seq') AS INTEGER), json_extract(w.value, '$.uid'),
        json_extract(w.value, '$.project'), CAST(json_extract(w.value, '$.projNo') AS INTEGER)
    )) AND NOT EXISTS (
    SELECT 1 FROM (SELECT value FROM json_each(?)) AS s WHERE EXISTS (
      SELECT (SELECT proj_no FROM cards WHERE project = json_extract(s.value, '$.id') AND proj_no > 0 ORDER BY proj_no LIMIT 1),
        (SELECT key FROM app_settings WHERE key >= 'cardmoved:' || json_extract(s.value, '$.id') || ':'
          AND key < 'cardmoved:' || json_extract(s.value, '$.id') || ';' ORDER BY key LIMIT 1)
      EXCEPT SELECT CAST(json_extract(s.value, '$.first') AS INTEGER), json_extract(s.value, '$.movedKey')
    ))`, [JSON.stringify(lookups), JSON.stringify([...samples.values()])]);
}

function previewProjectRoute(value, before, after) {
  // 與網頁 parseRoute() 同順序：先網址英文名、再專案 id、最後是舊的專案名稱網址。
  const order = ['slug', 'id', 'name'];
  const target = rows => {
    for (const source of order) {
      const row = rows.find(r => !r.deleted_at && r[source] === value);
      if (row) return { ref: { projectId: row.id, source }, status: projectStatus(row) };
    }
    return { ref: null, status: rows.some(r => r.deleted_at && order.some(source => r[source] === value)) ? 'recoverable' : 'missing' };
  };
  const matchingProjects = rows => rows.filter(row => order.some(source => row[source] === value)).map(row => row.id);
  const claimants = matchingProjects(before), from = target(before), to = target(after);
  return { path: '/p/' + encodeURIComponent(value), before: from.ref, after: to.ref, claimants,
    beforeStatus: from.status, afterStatus: to.status, ambiguous: claimants.length > 1 || matchingProjects(after).length > 1 };
}

async function previewCardReferences(db, byId, projectId, before, after, codes, sampledCodes, claimants, reference, cardWitnesses, sampleWitnesses) {
  const active = id => isActive(byId.get(id));
  const rule = (identity, code) => {
    const target = projectForCardCode(code, identity.codes, identity.olds, active);
    return target && { ...target, available: !byId.get(target.projectId).deleted_at };
  };
  const resolve = async (identity, target, status, no) => {
    if (!target?.available) return { ref: null, status };
    const key = `${target.projectId}:${no}`;
    if (!cardWitnesses.has(key)) {
      // 比照正常查卡，先查專案內的卡號，再用移卡別名，並記錄這個卡號的別名狀態。
      const { moved, ...direct } = await db.get(`SELECT c.seq, c.uid, c.project, c.proj_no, m.value AS moved
        FROM (SELECT 1) AS base LEFT JOIN cards c ON c.project = ? AND c.proj_no = ?
        LEFT JOIN app_settings m ON m.key = ?`, target.projectId, no, `cardmoved:${target.projectId}:${no}`);
      const seq = Number(moved);
      const movedSeq = Number.isSafeInteger(seq) && seq > 0 ? seq : null;
      const card = direct.seq ? direct : movedSeq ? await db.get('SELECT seq, uid, project, proj_no FROM cards WHERE seq = ?', movedSeq) : null;
      cardWitnesses.set(key, { projectId: target.projectId, no, direct: direct.seq, moved, movedSeq, card });
    }
    const { card } = cardWitnesses.get(key);
    const destination = card ? byId.get(card.project) : null;
    const resultStatus = projectStatus(destination);
    if (!destination || destination.deleted_at) return { ref: null, status: resultStatus };
    const code = identity.codes[card.project];
    const legacyId = `C-${Number(card.seq) + 100}`;
    return { ref: { projectId: card.project, cardId: card.proj_no && code ? `${code}-${card.proj_no}` : legacyId, legacyId }, status: resultStatus };
  };
  const out = [];
  for (const code of codes) {
    const from = rule(before, code), to = rule(after, code);
    const beforeStatus = projectStatus(byId.get(from?.projectId ?? before.olds[code]));
    const afterStatus = projectStatus(byId.get(to?.projectId ?? after.olds[code]));
    // 只挑少量實例，先挑會改代號的專案，以及解析到它或其他專案的例子。
    const ids = [...new Set([projectId, from?.projectId, to?.projectId].filter(Boolean))];
    const numbers = new Set();
    const inspect = reference?.startsWith(`${code}-`);
    const sample = !reference && sampledCodes.has(code);
    if (inspect) numbers.add(Number(reference.split('-')[1]));
    for (const id of sample ? ids : []) {
      const prefix = `cardmoved:${id}:`;
      if (!sampleWitnesses.has(id)) {
        const first = await db.get('SELECT proj_no FROM cards WHERE project = ? AND proj_no > 0 ORDER BY proj_no LIMIT 1', id);
        const moved = await db.get('SELECT key FROM app_settings WHERE key >= ? AND key < ? ORDER BY key LIMIT 1', prefix, `cardmoved:${id};`);
        sampleWitnesses.set(id, { id, first: first?.proj_no, movedKey: moved?.key });
      }
      const { first, movedKey } = sampleWitnesses.get(id);
      if (first) numbers.add(Number(first));
      const movedNo = Number(movedKey?.slice(prefix.length));
      if (Number.isSafeInteger(movedNo) && movedNo > 0) numbers.add(movedNo);
      if (numbers.size >= 2) break;
    }
    const examples = [];
    for (const no of [...numbers].slice(0, 2)) {
      const prev = await resolve(before, from, beforeStatus, no), next = await resolve(after, to, afterStatus, no);
      const outcome = !prev.ref ? (next.ref ? 'gained' : 'missing') : !next.ref ? 'lost' : prev.ref.legacyId !== next.ref.legacyId ? 'redirected' : 'same_card';
      examples.push({ reference: `${code}-${no}`, before: prev.ref, after: next.ref, beforeStatus: prev.status, afterStatus: next.status, outcome });
    }
    const owners = claimants(code);
    out.push({ code, before: from, after: to, beforeStatus, afterStatus, claimants: owners, ambiguous: owners.length > 1,
      exampleCoverage: inspect ? 'requested' : sample ? 'sample' : 'none', examples });
  }
  return out;
}
