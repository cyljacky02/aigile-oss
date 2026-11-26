// 平台診斷的試算，只讀現有的專案與識別碼設定。
import { CODE_RE, displayedIdentity, identityConflicts, projectForCardCode, splitIdentitySettings } from './project-identity.js';

const CONFLICT_FIELDS = { duplicate_code: 'code', code_is_old_alias: 'code', duplicate_slug: 'slug', duplicate_name: 'name' };
const isActive = row => row && !row.deleted_at && !Number(row.archived);
const projectStatus = row => !row ? 'missing' : row.deleted_at ? 'recoverable' : Number(row.archived) ? 'archived' : 'reachable';

export async function previewProjectIdentity({ db, projectIdentity, ApiError, sha256 }, { projectId, field, replacement, reference, retireAlias }) {
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
  const cardWitnesses = new Map();
  if (field === 'code') {
    const proposed = splitIdentitySettings(settings);
    if (retiredAlias) delete proposed.olds[current];
    else {
      proposed.codes[projectId] = replacement;
      // 舊代號還有其他持有者時，由他們保留，不能另外加上自己的別名。
      if (!codeClaimants(current).some(id => id !== projectId)) proposed.olds[current] = projectId;
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
    cardReferences = await previewCardReferences(db, byId, projectId, shown, after, codes, sampledCodes, codeClaimants, reference, cardWitnesses);
  } else {
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
  const resolutionState = await sha256(JSON.stringify([state, reference ?? null, routes, cardReferences, [...cardWitnesses]]));
  return { projectId, field, current, replacement, retiredAlias, projects: [...affected].map(info), conflicts, routes, cardReferences, codeChanges, state, resolutionState };
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

async function previewCardReferences(db, byId, projectId, before, after, codes, sampledCodes, claimants, reference, cardWitnesses) {
  const active = id => isActive(byId.get(id));
  const rule = (identity, code) => {
    const target = projectForCardCode(code, identity.codes, identity.olds, active);
    return target && { ...target, available: !byId.get(target.projectId).deleted_at };
  };
  const cardCache = new Map();
  const resolve = async (identity, target, status, no) => {
    if (!target?.available) return { ref: null, status };
    const key = `${target.projectId}:${no}`;
    if (!cardCache.has(key)) {
      // 比照正常查卡，先查專案內的卡號，再用移卡別名，並記錄這個卡號的別名狀態。
      const { moved, ...direct } = await db.get(`SELECT c.seq, c.uid, c.project, c.proj_no, m.value AS moved
        FROM (SELECT 1) AS base LEFT JOIN cards c ON c.project = ? AND c.proj_no = ?
        LEFT JOIN app_settings m ON m.key = ?`, target.projectId, no, `cardmoved:${target.projectId}:${no}`);
      const movedSeq = Number(moved);
      const card = direct.seq ? direct : Number.isSafeInteger(movedSeq) && movedSeq > 0
        ? await db.get('SELECT seq, uid, project, proj_no FROM cards WHERE seq = ?', movedSeq) : null;
      cardCache.set(key, card);
      cardWitnesses.set(key, { direct: direct.seq, moved, card });
    }
    const card = cardCache.get(key);
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
      const first = await db.get('SELECT proj_no FROM cards WHERE project = ? AND proj_no > 0 ORDER BY proj_no LIMIT 1', id);
      if (first) numbers.add(Number(first.proj_no));
      const prefix = `cardmoved:${id}:`;
      const moved = await db.get('SELECT key FROM app_settings WHERE key >= ? AND key < ? ORDER BY key LIMIT 1', prefix, `cardmoved:${id};`);
      const movedNo = Number(moved?.key.slice(prefix.length));
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
