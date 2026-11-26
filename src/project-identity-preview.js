// 平台診斷的試算，只讀現有的專案與識別碼設定。
import { cardSeqInProject, identityConflicts, projectForCardCode } from './project-identity.js';

const CONFLICT_FIELDS = { duplicate_code: 'code', code_is_old_alias: 'code', duplicate_slug: 'slug', duplicate_name: 'name' };
const isActive = row => row && !row.deleted_at && !Number(row.archived);

export async function previewProjectIdentity({ db, projectIdentity, ApiError, sha256 }, { projectId, field, replacement }) {
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
  if (owners.length || replacement === current) {
    const error = { code: ['CODE_TAKEN', '這個專案代號已被使用或保留。'], slug: ['SLUG_TAKEN', '這個網址英文名已被使用或保留。'], name: ['NAME_TAKEN', '已有同名的專案'] }[field];
    throw new ApiError(409, ...error, { field, projects: owners.map(info) });
  }

  const affected = new Set([projectId, ...claimants(current)]);
  let cardReferences = [], routes = [];
  if (field === 'code') {
    const after = { ...shown, codes: { ...shown.codes, [projectId]: replacement }, olds: { ...shown.olds } };
    // 舊代號還有其他持有者時，由他們保留，不能另外加上自己的別名。
    if (!codeClaimants(current).some(id => id !== projectId)) after.olds[current] = projectId;
    cardReferences = await previewCardReferences(db, byId, projectId, shown, after, [current, replacement], codeClaimants);
  } else {
    const before = rows.filter(row => !row.deleted_at).map(row => ({ id: row.id, name: row.name, slug: shown.slugs[row.id] }));
    const after = before.map(row => row.id === projectId ? { ...row, [field]: replacement } : row);
    routes = [current, replacement].map(value => previewProjectRoute(value, before, after));
    for (const route of routes) for (const id of route.claimants) affected.add(id);
  }
  // 指紋綁定正規化後的提案與讀到的專案、識別碼設定。確認端仍需在交易中驗證狀態。
  const state = await sha256(JSON.stringify([projectId, field, replacement,
    rows.map(r => [r.id, r.name, Number(r.archived), r.deleted_at, r.created_at]),
    settings.map(r => [r.key, r.value]).sort(),
  ]));
  return { projectId, field, current, replacement, projects: [...affected].map(info), conflicts, routes, cardReferences, state };
}

function previewProjectRoute(value, before, after) {
  // 與網頁 parseRoute() 同順序：先網址英文名、再專案 id、最後是舊的專案名稱網址。
  const order = ['slug', 'id', 'name'];
  const target = rows => {
    for (const source of order) {
      const row = rows.find(r => r[source] === value);
      if (row) return { projectId: row.id, source };
    }
    return null;
  };
  const matchingProjects = rows => rows.filter(row => order.some(source => row[source] === value)).map(row => row.id);
  const claimants = matchingProjects(before);
  return { path: '/p/' + encodeURIComponent(value), before: target(before), after: target(after), claimants,
    ambiguous: claimants.length > 1 || matchingProjects(after).length > 1 };
}

async function previewCardReferences(db, byId, projectId, before, after, codes, claimants) {
  const active = id => isActive(byId.get(id));
  const rule = (identity, code) => {
    const target = projectForCardCode(code, identity.codes, identity.olds, active);
    return target && { ...target, available: !byId.get(target.projectId).deleted_at };
  };
  const cardCache = new Map();
  const resolve = async (identity, target, no) => {
    if (!target?.available) return null;
    const key = `${target.projectId}:${no}`;
    if (!cardCache.has(key)) {
      const seq = await cardSeqInProject(db, target.projectId, no);
      cardCache.set(key, seq ? await db.get('SELECT seq, project, proj_no FROM cards WHERE seq = ?', seq) : null);
    }
    const card = cardCache.get(key);
    if (!card || !byId.has(card.project) || byId.get(card.project).deleted_at) return null;
    const code = identity.codes[card.project];
    const legacyId = `C-${Number(card.seq) + 100}`;
    return { projectId: card.project, cardId: card.proj_no && code ? `${code}-${card.proj_no}` : legacyId, legacyId };
  };
  const out = [];
  for (const code of codes) {
    const from = rule(before, code), to = rule(after, code);
    // 只挑少量實例，先挑會改代號的專案，以及解析到它或其他專案的例子。
    const ids = [...new Set([projectId, from?.projectId, to?.projectId].filter(Boolean))];
    const numbers = new Set();
    for (const id of ids) {
      const first = await db.get('SELECT proj_no FROM cards WHERE project = ? AND proj_no > 0 ORDER BY proj_no LIMIT 1', id);
      if (first) numbers.add(Number(first.proj_no));
      const prefix = `cardmoved:${id}:`;
      const moved = await db.get('SELECT key FROM app_settings WHERE key >= ? AND key < ? ORDER BY key LIMIT 1', prefix, `cardmoved:${id};`);
      const movedNo = Number(moved?.key.slice(prefix.length));
      if (Number.isSafeInteger(movedNo) && movedNo > 0) numbers.add(movedNo);
      if (numbers.size >= 2) break;
    }
    const examples = [];
    for (const no of [...numbers].slice(0, 2)) examples.push({ reference: `${code}-${no}`, before: await resolve(before, from, no), after: await resolve(after, to, no) });
    const owners = claimants(code);
    out.push({ code, before: from, after: to, claimants: owners, ambiguous: owners.length > 1, examples });
  }
  return out;
}
