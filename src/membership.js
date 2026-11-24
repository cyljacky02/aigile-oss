// 成員資格模組（GLOSSARY「成員與權限」）：誰在哪個工作區、哪些專案，專案角色（專案管理員＝leader、唯讀成員），跨專案角色。
// 這些資料的讀寫都只經過這裡。資料表依 docs/adr/0002（migrations/008）：
//   participants.workspace_id／workspace_role／workspace_status／account_id、accounts、workspaces、
//   project_members(project_id, participant_id, role)：role＝admin（專案管理員）| member（專案成員）| viewer（唯讀成員）。
// 跨專案角色還在 app_settings 的 cross_roles（#11 才轉成各專案的成員資格）。
//
// 讀：同步，看已載入的快照（project_members 整張＋cross_roles，10 秒快取；load(true) 重讀；invalidate() 標成過期）。
//     快照以成員 id 查：呼叫端拿到的 participant 列（不論從哪讀的）只用到 p.id、p.kind、p.owner_id。
// 寫：回傳 [sql, args] 語句陣列，呼叫端跟卡片退回、專案事件放進同一個 db.batch（一起成功或一起失敗）；執行後呼叫 load(true)。
// PROJECTS：未封存專案 id 的陣列（core.js 原地更新的同一個陣列）。
// onChange：模組自己改了資料（跨專案角色第一次載入時的補資料）後通知呼叫端（core.js 清成員快取）。
export const DEFAULT_WORKSPACE = 'default';
export const PROJECT_ROLE = Object.freeze({ ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' });
const PR = PROJECT_ROLE;
const accountIdOf = id => 'acct_' + id; // 第一階段一人一個工作區：帳號 id 由成員 id 推得（升級轉換可以重跑）
const pairKey = (id, pj) => `${id} ${pj}`; // SQL 端：participant_id || ' ' || project_id（成員 id 沒有空白）
const PAIR_SQL = "(participant_id || ' ' || project_id)";

export function createMembership({ db, PROJECTS, nowIso, onChange = () => {} }) {
  // ---------- 快照：project_members 整張 ----------
  // byId：成員 id → [{ project, role }]（照專案建立順序）；leaderMap／roMap：{ 專案id: [成員id] }（含封存專案、含停用的人）
  let snap = { byId: new Map(), leaders: {}, ro: {} }, snapAt = 0;
  async function loadMembers(force = false) {
    if (!force && snapAt && Date.now() - snapAt < 10_000) return snap;
    const rows = await db.all('SELECT m.project_id, m.participant_id, m.role FROM project_members m LEFT JOIN projects p ON p.id = m.project_id ORDER BY p.created_at, m.project_id, m.rowid');
    const byId = new Map(), leaders = {}, ro = {};
    for (const r of rows) {
      if (!byId.has(r.participant_id)) byId.set(r.participant_id, []);
      byId.get(r.participant_id).push({ project: r.project_id, role: r.role });
      if (r.role === PR.ADMIN) (leaders[r.project_id] ||= []).push(r.participant_id);
      if (r.role === PR.VIEWER) (ro[r.project_id] ||= []).push(r.participant_id);
    }
    snap = { byId, leaders, ro }; snapAt = Date.now();
    return snap;
  }
  // 只重讀一個人（發請求的人）：他的權限一定看最新的（別份程式剛改過也算），別人的照快取
  async function refreshOne(id) {
    const rows = await db.all('SELECT m.project_id, m.role FROM project_members m LEFT JOIN projects p ON p.id = m.project_id WHERE m.participant_id = ? ORDER BY p.created_at, m.project_id', id);
    const key = l => JSON.stringify(l.map(r => [r.project ?? r.project_id, r.role]));
    if (key(rows) === key(snap.byId.get(id) || [])) return; // 沒變（幾乎都是）：不動，順序照舊
    const drop = map => { for (const pj of Object.keys(map)) if (map[pj].includes(id)) map[pj] = map[pj].filter(x => x !== id); };
    const leaders = { ...snap.leaders }, ro = { ...snap.ro }, byId = new Map(snap.byId);
    drop(leaders); drop(ro);
    for (const r of rows) {
      if (r.role === PR.ADMIN) leaders[r.project_id] = [...(leaders[r.project_id] || []), id];
      if (r.role === PR.VIEWER) ro[r.project_id] = [...(ro[r.project_id] || []), id];
    }
    if (rows.length) byId.set(id, rows.map(r => ({ project: r.project_id, role: r.role }))); else byId.delete(id);
    snap = { byId, leaders, ro };
  }

  // ---------- 專案歸屬 ----------
  // 含封存專案的清單
  const allProjectsOf = p => (snap.byId.get(p?.id) || []).map(x => x.project);
  // 目前所屬（未封存）；沒有這個人（null）照舊當所有專案
  const projectsOf = p => {
    if (p === undefined || p === null) return [...PROJECTS];
    const mine = new Set(allProjectsOf(p));
    return PROJECTS.filter(x => mine.has(x));
  };
  // 把某人的專案歸屬整個換成 projects（含封存的也要列，沒列＝移出；移出就沒有那個專案的角色）。新加入的是專案成員，已在的角色不變。
  // at：同時更新 updated_at（null＝不動）。onlyIf：只在這位成員的列符合條件時才寫（participants 欄位的 SQL 條件，例如 'is_admin = 1'），用在同一批剛建的人
  function setProjectsStmts(id, projects, at, { onlyIf = null } = {}) {
    const cond = onlyIf ? ` AND (${onlyIf})` : '';
    const list = JSON.stringify([...new Set(projects)]), rows = JSON.stringify([...new Set(projects)].map(p => ({ p })));
    const stmts = [
      [`DELETE FROM project_members WHERE participant_id = ? AND project_id NOT IN (SELECT value FROM json_each(?))${onlyIf ? ` AND EXISTS (SELECT 1 FROM participants WHERE id = ?${cond})` : ''}`, onlyIf ? [id, list, id] : [id, list]],
      [`INSERT OR IGNORE INTO project_members (project_id, participant_id, role) SELECT json_extract(value, '$.p'), ?, '${PR.MEMBER}' FROM json_each(?) WHERE EXISTS (SELECT 1 FROM participants WHERE id = ?${cond})`, [id, rows, id]],
    ];
    if (at) stmts.push([`UPDATE participants SET updated_at = ? WHERE id = ?${cond}`, [at, id]]);
    return stmts;
  }

  // ---------- 專案管理員（leader；每個專案可多位、只能人類、要是專案成員） ----------
  const loadLeaders = async force => (await loadMembers(force)).leaders; // 回 { 專案id: [成員id] }（含封存專案）
  const leadersOf = pj => [...(snap.leaders[pj] || [])]; // 含封存專案、含已停用的人（呼叫端自己過濾）
  const leaderProjectsOf = (id, map = snap.leaders) => Object.keys(map).filter(pj => (map[pj] || []).includes(id) && PROJECTS.includes(pj)); // 目前帶的（未封存）專案
  // 整份換掉：map 沒列的就降為專案成員（還在專案裡）；列了但還不在專案的，以這個角色加入
  const pairs = map => JSON.stringify(Object.entries(map || {}).flatMap(([pj, ids]) => (ids || []).map(id => pairKey(id, pj))));
  const rowsOf = map => JSON.stringify(Object.entries(map || {}).flatMap(([pj, ids]) => (ids || []).map(id => ({ p: pj, id }))));
  const setRoleStmts = (map, role) => [
    [`UPDATE project_members SET role = '${PR.MEMBER}' WHERE role = '${role}' AND ${PAIR_SQL} NOT IN (SELECT value FROM json_each(?))`, [pairs(map)]],
    [`UPDATE project_members SET role = '${role}' WHERE role != '${role}' AND ${PAIR_SQL} IN (SELECT value FROM json_each(?))`, [pairs(map)]],
    [`INSERT OR IGNORE INTO project_members (project_id, participant_id, role) SELECT json_extract(value, '$.p'), json_extract(value, '$.id'), '${role}' FROM json_each(?)`, [rowsOf(map)]],
  ];
  const setLeadersStmts = map => setRoleStmts(map, PR.ADMIN);

  // ---------- 唯讀成員：只記人類；他名下的 AI 在該專案跟著唯讀（AI 權限不超過主人） ----------
  const loadReadOnly = async force => (await loadMembers(force)).ro; // 回 { 專案id: [人類id] }
  const isReadOnlyHuman = (id, pj, map = snap.ro) => !!pj && (map[pj] || []).includes(id);
  const isReadOnly = (p, pj, map = snap.ro) => !!p && isReadOnlyHuman(p.kind === 'ai' ? p.owner_id : p.id, pj, map);
  const readOnlyProjectsOf = (p, map = snap.ro) => PROJECTS.filter(pj => isReadOnly(p, pj, map)); // 未封存專案裡唯讀的
  const readOnlyOf = pj => [...(snap.ro[pj] || [])]; // 該專案唯讀的人類（含已停用的）
  // 整份換掉：map 沒列的就回到專案成員；列了但還不在專案的，以唯讀成員加入（一個專案只有一個專案角色：呼叫端擋「leader 不能唯讀」）
  const setReadOnlyStmts = map => setRoleStmts(map, PR.VIEWER);
  // 把某人設成這些專案的唯讀成員（已經是就不動），寫完重讀
  async function addReadOnly(id, projects) {
    await db.batch([
      [`UPDATE project_members SET role = '${PR.VIEWER}' WHERE participant_id = ? AND project_id IN (SELECT value FROM json_each(?))`, [id, JSON.stringify(projects)]],
      [`INSERT OR IGNORE INTO project_members (project_id, participant_id, role) SELECT json_extract(value, '$.p'), ?, '${PR.VIEWER}' FROM json_each(?)`, [id, JSON.stringify(projects.map(p => ({ p })))]],
    ]);
    await loadMembers(true);
  }

  // ---------- 跨專案角色：固定屬於所有專案、不能移出；cross_roles＝{ add: [id], remove: [id], frozen: 時間 } ----------
  // 新成員一律不自動跨專案（不看 PO／SM 角色），只能管理員手動開。
  // 原本「角色是 PO／SM 就跨」的規則在第一次載入時寫成固定名單（frozen），現有的人照舊
  const upsert = key => `INSERT INTO app_settings (key, value) VALUES ('${key}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  const readSetting = async key => (await db.get('SELECT value FROM app_settings WHERE key = ?', key).catch(() => null))?.value;
  const readJson = async key => { try { return JSON.parse((await readSetting(key)) || 'null'); } catch { return null; } };
  const legacyCross = p => ['PO', 'SM'].includes(p.role_key) || ['PO', 'SM'].includes(String(p.role || '').trim().toUpperCase());
  const defaultCross = () => false;
  let cross = { add: new Set(), remove: new Set(), frozen: null }, crossAt = 0;
  async function loadCrossRoles(force = false) {
    if (!force && Date.now() - crossAt < 10_000) return cross;
    let v = {};
    try { v = JSON.parse((await readSetting('cross_roles')) || '{}'); } catch {}
    if (!v.frozen) {
      const remove = new Set(v.remove || []), add = new Set(v.add || []);
      for (const p of await db.all("SELECT * FROM participants WHERE status = 'active' AND kind != 'system'")) if (legacyCross(p) && !remove.has(p.id)) add.add(p.id);
      v = { add: [...add], remove: [], frozen: nowIso() };
      await db.run(upsert('cross_roles'), JSON.stringify(v));
      onChange();
    }
    cross = { add: new Set(v.add || []), remove: new Set(v.remove || []), frozen: v.frozen }; crossAt = Date.now();
    return cross;
  }
  // draft：還沒存的草稿（crossRoles() 複製一份、setCrossRole 改）；沒帶就看目前的
  const isCrossRole = (p, draft = cross) => p.status === 'active' && p.kind !== 'system' && !draft.remove.has(p.id) && (draft.add.has(p.id) || defaultCross(p));
  const crossRoles = () => ({ add: new Set(cross.add), remove: new Set(cross.remove), frozen: cross.frozen });
  function setCrossRole(draft, p, on) {
    if (on) { draft.remove.delete(p.id); if (!defaultCross(p)) draft.add.add(p.id); } else { draft.add.delete(p.id); if (defaultCross(p)) draft.remove.add(p.id); }
  }
  // frozen 要留著，不然會重新套舊規則
  const setCrossRolesStmts = draft => [[upsert('cross_roles'), [JSON.stringify({ add: [...draft.add], remove: [...draft.remove], frozen: draft.frozen || nowIso() })]]];

  // ---------- 直接讀資料庫（不經快取；示範資料這類一次性的整批修改用） ----------
  // 某人含封存專案的清單
  const fetchProjectsOf = async id => (await db.all('SELECT m.project_id FROM project_members m LEFT JOIN projects p ON p.id = m.project_id WHERE m.participant_id = ? ORDER BY p.created_at, m.project_id', id)).map(r => r.project_id);
  // 在某專案的所有人（不分狀態）：[{ id, projects: 各自含封存專案的清單 }]
  async function fetchMembersOf(pj) {
    const rows = await db.all('SELECT m.participant_id, m.project_id FROM project_members m LEFT JOIN projects p ON p.id = m.project_id WHERE m.participant_id IN (SELECT participant_id FROM project_members WHERE project_id = ?) ORDER BY m.participant_id, p.created_at, m.project_id', pj);
    const out = new Map();
    for (const r of rows) { if (!out.has(r.participant_id)) out.set(r.participant_id, []); out.get(r.participant_id).push(r.project_id); }
    return [...out].map(([id, projects]) => ({ id, projects }));
  }

  // ---------- 永久刪除專案：所有人的專案歸屬與角色都拿掉它 ----------
  // people：要檢查的成員列（含停用、已刪除的；改到的人更新 updated_at）。舊的 leader／唯讀設定（升級前的資料）也一併清掉
  async function removeProjectStmts(pj, people, at) {
    const stmts = [];
    for (const key of ['read_only', 'project_leaders']) {
      const v = await readJson(key);
      if (v && typeof v === 'object' && pj in v) { delete v[pj]; stmts.push([upsert(key), [JSON.stringify(v)]]); }
    }
    const members = new Set((await db.all('SELECT participant_id FROM project_members WHERE project_id = ?', pj)).map(r => r.participant_id));
    stmts.push(['DELETE FROM project_members WHERE project_id = ?', [pj]]);
    for (const p of people) if (members.has(p.id)) stmts.push(['UPDATE participants SET updated_at = ? WHERE id = ?', [at, p.id]]);
    return stmts;
  }

  // ---------- 工作區成員資格 ----------
  // 剛建的成員（同一批的 INSERT 之後）加入預設工作區：人類另建帳號；工作區角色、平台角色跟著 is_admin（#8／#9 才改成各自管理）
  const enterWorkspaceStmts = (id, at) => [
    [`INSERT OR IGNORE INTO accounts (id, platform_role, status, created_at, updated_at)
      SELECT ?, CASE WHEN is_admin = 1 THEN 'admin' ELSE 'none' END, 'active', ?, ? FROM participants WHERE id = ? AND kind = 'human'`, [accountIdOf(id), at, at, id]],
    [`UPDATE participants SET workspace_id = ?, account_id = CASE WHEN kind = 'human' THEN ? ELSE NULL END,
      workspace_role = CASE WHEN kind = 'human' AND is_admin = 1 THEN 'admin' ELSE 'member' END WHERE id = ?`, [DEFAULT_WORKSPACE, accountIdOf(id), id]],
  ];
  // is_admin 改了（交出管理員、匯入備份）：工作區管理員、平台管理員跟著
  const syncAdminStmts = () => [
    ["UPDATE participants SET workspace_role = CASE WHEN kind = 'human' AND is_admin = 1 THEN 'admin' ELSE 'member' END WHERE workspace_id IS NOT NULL", []],
    ["UPDATE accounts SET platform_role = CASE WHEN EXISTS (SELECT 1 FROM participants p WHERE p.account_id = accounts.id AND p.is_admin = 1) THEN 'admin' ELSE 'none' END", []],
  ];
  // 停用／恢復（人類）：帳號狀態跟著
  const accountStatusStmts = (id, status, at) => [['UPDATE accounts SET status = ?, updated_at = ? WHERE id IN (SELECT account_id FROM participants WHERE id = ?)', [status, at, id]]];
  // 成員列整個刪掉（加入失敗收回、清示範資料）：他的專案成員資格與帳號一起刪。要放在 DELETE FROM participants 之前
  const forgetStmts = ids => [
    ['DELETE FROM project_members WHERE participant_id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]],
    ['DELETE FROM accounts WHERE id IN (SELECT account_id FROM participants WHERE id IN (SELECT value FROM json_each(?)))', [JSON.stringify(ids)]],
  ];

  // ---------- 升級轉換（ADR 0001 的做法：程式啟動後第一個請求做，SQLite、D1、Postgres 共用） ----------
  // 標記：participants.workspace_id 是空的＝還沒轉（新程式建的成員一定有）。每位成員的轉換是一批、每句都看這個標記，
  // 所以重跑、兩份程式同時跑都不會重複（project_members、accounts 的主鍵再擋一次）。
  // 舊資料：projects 逗號字串（NULL＝所有未封存專案）、project_leaders → 專案管理員、read_only → 唯讀成員（leader 優先）、
  // is_admin（沒有就最早加入的啟用人類）→ 工作區管理員＋平台管理員、停用 → 停用帳號、已刪除（人類）→ 已移出工作區。
  // 跨專案角色、隱形管理員的成員資格原樣保留（#11、#8 才改）。匯入備份中（restore_state）不做，回 false。
  async function migrateLegacy() {
    if (await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'restore_state'").catch(() => null)) return false;
    const base = [
      [`INSERT OR IGNORE INTO workspaces (id, name, create_projects) VALUES (?, '', 'admins')`, [DEFAULT_WORKSPACE]], // 匯入舊版備份後沒有工作區：當升級的站
      ["UPDATE workspaces SET name = (SELECT value FROM app_settings WHERE key = 'group_name') WHERE id = ? AND name = '' AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'group_name')", [DEFAULT_WORKSPACE]],
      ['UPDATE projects SET workspace_id = ? WHERE workspace_id IS NULL', [DEFAULT_WORKSPACE]],
    ];
    const todo = await db.all('SELECT id, kind, status, role, role_key, projects FROM participants WHERE workspace_id IS NULL ORDER BY created_at, id');
    if (!todo.length) { await db.batch(base); return true; }
    const humans = await db.all("SELECT id, is_admin FROM participants WHERE kind = 'human' AND status = 'active' ORDER BY created_at, id");
    const adminId = (humans.find(p => Number(p.is_admin) === 1) || humans[0])?.id;
    const projects = await db.all('SELECT id, archived FROM projects');
    const exists = new Set(projects.map(r => r.id)), active = projects.filter(r => !r.archived).map(r => r.id);
    const leaders = (await readJson('project_leaders')) || {}, ro = (await readJson('read_only')) || {}, cr = (await readJson('cross_roles')) || {};
    const listed = (map, pj, id) => Array.isArray(map?.[pj]) && map[pj].includes(id);
    // 跨專案角色（還沒寫成固定名單的套舊規則）：沒在逗號字串裡也能當 leader、設唯讀 → 以那個角色加入；其他人不在專案裡的角色是移出時沒清掉的，不算
    const isCross = p => p.status === 'active' && !(cr.remove || []).includes(p.id) && ((cr.add || []).includes(p.id) || (!cr.frozen && legacyCross(p)));
    const at = nowIso(), each = [];
    for (const p of todo) {
      const stmts = [];
      const human = p.kind === 'human', admin = human && p.id === adminId, guard = 'EXISTS (SELECT 1 FROM participants WHERE id = ? AND workspace_id IS NULL)';
      const list = p.projects === null || p.projects === undefined ? active : [...new Set(String(p.projects).split(',').map(x => x.trim()))].filter(x => exists.has(x));
      const roleIn = pj => (human && listed(leaders, pj, p.id) ? PR.ADMIN : human && listed(ro, pj, p.id) ? PR.VIEWER : PR.MEMBER);
      const extra = human && isCross(p) ? [...exists].filter(pj => !list.includes(pj) && roleIn(pj) !== PR.MEMBER) : [];
      const rows = [...list, ...extra].map(pj => ({ p: pj, r: roleIn(pj) }));
      if (rows.length) stmts.push([`INSERT OR IGNORE INTO project_members (project_id, participant_id, role) SELECT json_extract(value, '$.p'), ?, json_extract(value, '$.r') FROM json_each(?) WHERE ${guard}`, [p.id, JSON.stringify(rows), p.id]]);
      if (human) stmts.push([`INSERT OR IGNORE INTO accounts (id, platform_role, status, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`, [accountIdOf(p.id), admin ? 'admin' : 'none', p.status === 'disabled' ? 'disabled' : 'active', at, at, p.id]]);
      stmts.push(['UPDATE participants SET workspace_id = ?, account_id = ?, workspace_role = ?, workspace_status = ? WHERE id = ? AND workspace_id IS NULL',
        [DEFAULT_WORKSPACE, human ? accountIdOf(p.id) : null, admin ? 'admin' : 'member', human && p.status === 'deleted' ? 'removed' : 'active', p.id]]);
      each.push(stmts);
    }
    await db.batch(base);
    for (let i = 0; i < each.length; i += 30) await db.batch(each.slice(i, i + 30).flat()); // 一批 30 人（D1 單批不要太大）
    console.log(`成員與權限：已把 ${todo.length} 位成員轉到新的資料表`);
    onChange();
    return true;
  }

  // 重讀所有快取（force）；invalidate 只標成過期，下次讀時重讀
  async function load(force = false) {
    await Promise.all([loadMembers(force), loadCrossRoles(force)]);
  }
  function invalidate() { snapAt = 0; crossAt = 0; }

  return { projectsOf, allProjectsOf, setProjectsStmts,
    loadLeaders, leadersOf, leaderProjectsOf, setLeadersStmts,
    loadReadOnly, isReadOnlyHuman, isReadOnly, readOnlyProjectsOf, readOnlyOf, setReadOnlyStmts, addReadOnly,
    loadCrossRoles, isCrossRole, crossRoles, setCrossRole, setCrossRolesStmts,
    fetchProjectsOf, fetchMembersOf, removeProjectStmts,
    enterWorkspaceStmts, syncAdminStmts, accountStatusStmts, forgetStmts, migrateLegacy,
    loadMembers, refreshOne, load, invalidate };
}
