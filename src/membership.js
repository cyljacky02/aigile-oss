// 成員資格模組（GLOSSARY「成員與權限」）：誰在哪個工作區、哪些專案，專案角色（專案管理員、專案成員、唯讀成員）。
// 這些資料的讀寫都只經過這裡。資料表依 docs/adr/0002（migrations/008）：
//   participants.workspace_id／workspace_role／workspace_status／account_id、accounts、workspaces、
//   project_members(project_id, participant_id, role)：role＝admin（專案管理員）| member（專案成員）| viewer（唯讀成員）。
// 舊結構（is_admin、逗號字串的 participants.projects、app_settings 的 project_leaders／read_only／cross_roles）由 migrations/009 拿掉；
// 從第一階段之前升級的站，舊資料由 migrateLegacy 轉進新表（只有它讀舊資料）。
//
// 讀：同步，看已載入的快照（project_members 整張，10 秒快取；load(true) 重讀；invalidate() 標成過期）。
//     快照以成員 id 查：呼叫端拿到的 participant 列（不論從哪讀的）只用到 p.id、p.kind、p.owner_id。
// 寫：回傳 [sql, args] 語句陣列，呼叫端跟卡片退回、專案事件放進同一個 db.batch（一起成功或一起失敗）；執行後呼叫 load(true)。
// PROJECTS：未封存專案 id 的陣列（core.js 原地更新的同一個陣列）。
// onChange：模組自己改了資料（升級轉換）後通知呼叫端（core.js 清成員快取）。
export const DEFAULT_WORKSPACE = 'default';
export const PROJECT_ROLE = Object.freeze({ ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' });
const PR = PROJECT_ROLE;
const accountIdOf = id => 'acct_' + id; // 第一階段一人一個工作區：帳號 id 由成員 id 推得（升級轉換可以重跑）
const pairKey = (id, pj) => `${id} ${pj}`; // SQL 端：participant_id || ' ' || project_id（成員 id 沒有空白）
const PAIR_SQL = "(participant_id || ' ' || project_id)";
// 平台管理員：帳號 platform_role＝admin、帳號啟用中（快照與單人重讀共用；單人重讀另加 AND p.id = ?）
const PLATFORM_SQL = "SELECT p.id FROM participants p JOIN accounts a ON a.id = p.account_id WHERE a.platform_role = 'admin' AND a.status = 'active' AND p.kind = 'human'";

export function createMembership({ db, PROJECTS, nowIso, onChange = () => {} }) {
  // ---------- 快照：project_members 整張 ----------
  // byId：成員 id → [{ project, role }]（照專案建立順序）；leaderMap／roMap：{ 專案id: [成員id] }（含封存專案、含停用的人）
  // platform：帳號是平台管理員、帳號啟用中的成員 id（#9）
  let snap = { byId: new Map(), leaders: {}, ro: {}, platform: new Set() }, snapAt = 0;
  async function loadMembers(force = false) {
    if (!force && snapAt && Date.now() - snapAt < 10_000) return snap;
    const [rows, plat] = await Promise.all([
      db.all('SELECT m.project_id, m.participant_id, m.role FROM project_members m LEFT JOIN projects p ON p.id = m.project_id ORDER BY p.created_at, m.project_id, m.rowid'),
      db.all(PLATFORM_SQL).catch(() => []),
    ]);
    const byId = new Map(), leaders = {}, ro = {};
    for (const r of rows) {
      if (!byId.has(r.participant_id)) byId.set(r.participant_id, []);
      byId.get(r.participant_id).push({ project: r.project_id, role: r.role });
      if (r.role === PR.ADMIN) (leaders[r.project_id] ||= []).push(r.participant_id);
      if (r.role === PR.VIEWER) (ro[r.project_id] ||= []).push(r.participant_id);
    }
    snap = { byId, leaders, ro, platform: new Set(plat.map(r => r.id)) }; snapAt = Date.now();
    return snap;
  }
  // 只重讀一個人（發請求的人）：他的權限一定看最新的（別份程式剛改過也算），別人的照快取
  async function refreshOne(id) {
    const [rows, plat] = await Promise.all([
      db.all('SELECT m.project_id, m.role FROM project_members m LEFT JOIN projects p ON p.id = m.project_id WHERE m.participant_id = ? ORDER BY p.created_at, m.project_id', id),
      db.get(PLATFORM_SQL + ' AND p.id = ?', id).catch(() => null),
    ]);
    if (!!plat !== snap.platform.has(id)) { // 平台角色也看最新的
      const platform = new Set(snap.platform);
      if (plat) platform.add(id); else platform.delete(id);
      snap = { ...snap, platform };
    }
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
    snap = { ...snap, byId, leaders, ro };
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
  // at：同時更新 updated_at（null＝不動）。onlyIf：只在這位成員的列符合條件時才寫（participants 欄位的 SQL 條件，例如 "workspace_role = 'member'"）
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
  // 某人在某專案設成專案管理員（不在專案就以專案管理員加入）：建立專案的人用
  const makeProjectAdminStmts = (id, pj) => [[`INSERT INTO project_members (project_id, participant_id, role) VALUES (?, ?, '${PR.ADMIN}') ON CONFLICT(project_id, participant_id) DO UPDATE SET role = excluded.role`, [pj, id]]];

  // ---------- 單一成員的專案角色（專案成員端點） ----------
  // roleOf：快照裡 id 在 pj 的專案角色（不在專案回 null；AI 一律 member，唯讀跟著所屬人類看 isReadOnly）
  const roleOf = (id, pj) => (snap.byId.get(id) || []).find(x => x.project === pj)?.role || null;
  // 以這個專案角色加入（已在專案就不動）；改已在專案的人的專案角色。移出專案走 setProjectsStmts（卡片退回、職稱清掉在呼叫端）
  const addMemberStmts = (id, pj, role) => [['INSERT OR IGNORE INTO project_members (project_id, participant_id, role) VALUES (?, ?, ?)', [pj, id, role]]];
  const setMemberRoleStmts = (id, pj, role) => [['UPDATE project_members SET role = ? WHERE project_id = ? AND participant_id = ?', [role, pj, id]]];

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

  // ---------- 舊設定（app_settings） ----------
  const readSetting = async key => (await db.get('SELECT value FROM app_settings WHERE key = ?', key).catch(() => null))?.value;
  const readJson = async key => { try { return JSON.parse((await readSetting(key)) || 'null'); } catch { return null; } };
  // 舊的跨專案角色：cross_roles＝{ add: [id], remove: [id], frozen: 時間 }；還沒寫成固定名單（沒有 frozen）時，角色是 PO／SM 的人與 AI 也算
  const legacyCross = p => ['PO', 'SM'].includes(p.role_key) || ['PO', 'SM'].includes(String(p.role || '').trim().toUpperCase());
  const crossOf = (cr, p) => p.status === 'active' && p.kind !== 'system' && !(cr.remove || []).includes(p.id) && ((cr.add || []).includes(p.id) || (!cr.frozen && legacyCross(p)));

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
  // people：要檢查的成員列（含停用、已刪除的；改到的人更新 updated_at）
  async function removeProjectStmts(pj, people, at) {
    const stmts = [];
    const members = new Set((await db.all('SELECT participant_id FROM project_members WHERE project_id = ?', pj)).map(r => r.participant_id));
    stmts.push(['DELETE FROM project_members WHERE project_id = ?', [pj]]);
    for (const p of people) if (members.has(p.id)) stmts.push(['UPDATE participants SET updated_at = ? WHERE id = ?', [at, p.id]]);
    return stmts;
  }

  // ---------- 工作區成員資格 ----------
  // 剛建的成員（同一批的 INSERT 之後）加入預設工作區：人類另建帳號。工作區角色由 INSERT 決定（預設 member）；
  // INSERT 時就是工作區管理員的（第一位自行註冊的人、預設管理員）同時是平台管理員。AI 一律是工作區成員
  const enterWorkspaceStmts = (id, at) => [
    [`INSERT OR IGNORE INTO accounts (id, platform_role, status, created_at, updated_at)
      SELECT ?, CASE WHEN workspace_role = 'admin' THEN 'admin' ELSE 'none' END, 'active', ?, ? FROM participants WHERE id = ? AND kind = 'human'`, [accountIdOf(id), at, at, id]],
    [`UPDATE participants SET workspace_id = ?, account_id = CASE WHEN kind = 'human' THEN ? ELSE NULL END,
      workspace_role = CASE WHEN kind = 'human' THEN workspace_role ELSE 'member' END WHERE id = ?`, [DEFAULT_WORKSPACE, accountIdOf(id), id]],
  ];
  // 升降工作區管理員（role：admin | member；只有啟用中的人類能升）。降級在同一句 SQL 裡檢查「還有別的啟用中工作區管理員」，
  // 沒有就什麼都不改（呼叫端再讀一次看有沒有改到）。第一句先鎖工作區這列：兩位管理員同時互降時排隊，後到的看得到前一位的結果（Postgres）。
  // 平台角色另外管（setPlatformRoleStmts）
  const setWorkspaceRoleStmts = (id, role, at) => [
    ['UPDATE workspaces SET name = name WHERE id = ?', [DEFAULT_WORKSPACE]],
    role === 'admin'
      ? ["UPDATE participants SET workspace_role = 'admin', updated_at = ? WHERE id = ? AND kind = 'human' AND status = 'active' AND workspace_role != 'admin'", [at, id]]
      : [`UPDATE participants SET workspace_role = 'member', updated_at = ? WHERE id = ? AND workspace_role = 'admin'
          AND EXISTS (SELECT 1 FROM participants o WHERE o.workspace_id = ? AND o.workspace_role = 'admin' AND o.kind = 'human' AND o.status = 'active' AND o.id != ?)`, [at, id, DEFAULT_WORKSPACE, id]],
  ];
  // 平台管理員（帳號的 platform_role）：是平台管理員、帳號啟用中、成員列是啟用中的人類（平台管理員被移出工作區也還是）
  const isPlatformAdmin = p => !!p && p.kind === 'human' && p.status === 'active' && snap.platform.has(p.id);
  // 升降平台管理員（role：admin | none；只有啟用中的人類帳號能升）。跟工作區管理員一樣：降級在同一句檢查「還有別的啟用中平台管理員」，
  // 沒有就不改（呼叫端再讀一次）；先鎖工作區這列讓同時互降的人排隊（第一階段只有一個工作區，拿它當全平台的鎖）
  const setPlatformRoleStmts = (id, role, at) => [
    ['UPDATE workspaces SET name = name WHERE id = ?', [DEFAULT_WORKSPACE]],
    role === 'admin'
      ? ["UPDATE accounts SET platform_role = 'admin', updated_at = ? WHERE platform_role != 'admin' AND status = 'active' AND id IN (SELECT account_id FROM participants WHERE id = ? AND kind = 'human' AND status = 'active')", [at, id]]
      : [`UPDATE accounts SET platform_role = 'none', updated_at = ? WHERE platform_role = 'admin' AND id IN (SELECT account_id FROM participants WHERE id = ?)
          AND EXISTS (SELECT 1 FROM accounts o JOIN participants op ON op.account_id = o.id WHERE o.platform_role = 'admin' AND o.status = 'active' AND op.status = 'active' AND op.kind = 'human' AND o.id != accounts.id)`, [at, id]],
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
  // 舊欄位 is_admin、projects 由 migrations/009 抄到 legacy_members 再拿掉；009 還沒套的資料庫（例：D1 先換程式、後跑升級）照舊讀欄位。
  // 舊資料：projects 逗號字串（NULL＝所有未封存專案）、project_leaders → 專案管理員、read_only → 唯讀成員（leader 優先）、
  // is_admin（沒有就最早加入的啟用人類）→ 工作區管理員＋平台管理員、停用 → 停用帳號、已刪除（人類）→ 已移出工作區。
  // 跨專案角色 → 每個未封存專案的明確成員資格（migrateCrossRoles）。隱形管理員（#8）：現任管理員在「沒有職稱（project_roles）也不是 leader」的專案
  // 移除成員資格，改靠隱含權限（升級前這些專案本來就不列他），其他保留；跨專案角色的轉換也照這個規則。匯入備份中（restore_state）不做，回 false。
  // 每個人都轉完後，刪掉抄起來的舊資料與舊設定（project_leaders、read_only、cross_roles）。
  async function migrateLegacy() {
    if (await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'restore_state'").catch(() => null)) return false;
    const base = [
      [`INSERT OR IGNORE INTO workspaces (id, name, create_projects) VALUES (?, '', 'admins')`, [DEFAULT_WORKSPACE]], // 匯入舊版備份後沒有工作區：當升級的站
      ["UPDATE workspaces SET name = (SELECT value FROM app_settings WHERE key = 'group_name') WHERE id = ? AND name = '' AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'group_name')", [DEFAULT_WORKSPACE]],
      ['UPDATE projects SET workspace_id = ? WHERE workspace_id IS NULL', [DEFAULT_WORKSPACE]],
    ];
    const todo = await db.all('SELECT id, kind, status, role, role_key, owner_id FROM participants WHERE workspace_id IS NULL ORDER BY created_at, id');
    if (!todo.length) { await db.batch(base); await migrateCrossRoles(false); await dropLegacy(); return true; }
    const { rows: old, table } = await legacyRows();
    // 管理員：還沒轉的看舊的 is_admin，已轉的看工作區角色；都沒有就最早加入的啟用人類
    const humans = await db.all("SELECT id, workspace_id, workspace_role FROM participants WHERE kind = 'human' AND status = 'active' ORDER BY created_at, id");
    const wasAdmin = h => (h.workspace_id === null || h.workspace_id === undefined ? Number(old.get(h.id)?.is_admin) === 1 : h.workspace_role === 'admin');
    const adminId = (humans.find(wasAdmin) || humans[0])?.id;
    const projects = await db.all('SELECT id, archived FROM projects');
    const exists = new Set(projects.map(r => r.id)), active = projects.filter(r => !r.archived).map(r => r.id);
    const leaders = (await readJson('project_leaders')) || {}, ro = (await readJson('read_only')) || {}, cr = (await readJson('cross_roles')) || {};
    const titles = (await readJson('project_roles')) || {};
    const listed = (map, pj, id) => Array.isArray(map?.[pj]) && map[pj].includes(id);
    // 跨專案角色（還沒寫成固定名單的套舊規則）：沒在逗號字串裡也能當 leader、設唯讀 → 以那個角色加入；其他人不在專案裡的角色是移出時沒清掉的，不算
    const isCross = p => crossOf(cr, p);
    // 已刪除的人類＝已移出工作區，跟升級後才被移出的人一樣：成員列是啟用的（帳號沒停用，可以再被邀請回來）、沒有專案成員資格、
    // 名下的 AI 停用並移出工作區
    const gone = new Set(todo.filter(p => p.kind === 'human' && p.status === 'deleted').map(p => p.id));
    const at = nowIso(), each = [];
    for (const p of todo) {
      const stmts = [];
      const human = p.kind === 'human', admin = human && p.id === adminId, guard = 'EXISTS (SELECT 1 FROM participants WHERE id = ? AND workspace_id IS NULL)';
      const raw = old.has(p.id) ? old.get(p.id).projects : ''; // 沒有舊資料＝沒有專案
      const list = raw === null || raw === undefined ? active : [...new Set(String(raw).split(',').map(x => x.trim()))].filter(x => exists.has(x));
      const roleIn = pj => (human && listed(leaders, pj, p.id) ? PR.ADMIN : human && listed(ro, pj, p.id) ? PR.VIEWER : PR.MEMBER);
      const extra = human && isCross(p) ? [...exists].filter(pj => !list.includes(pj) && roleIn(pj) !== PR.MEMBER) : [];
      const ghost = pj => admin && !titles[p.id]?.[pj] && roleIn(pj) !== PR.ADMIN; // 隱形管理員的專案：改靠隱含權限
      const rows = gone.has(p.id) ? [] : [...list, ...extra].filter(pj => !ghost(pj)).map(pj => ({ p: pj, r: roleIn(pj) }));
      if (rows.length) stmts.push([`INSERT OR IGNORE INTO project_members (project_id, participant_id, role) SELECT json_extract(value, '$.p'), ?, json_extract(value, '$.r') FROM json_each(?) WHERE ${guard}`, [p.id, JSON.stringify(rows), p.id]]);
      if (human) stmts.push([`INSERT OR IGNORE INTO accounts (id, platform_role, status, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`, [accountIdOf(p.id), admin ? 'admin' : 'none', p.status === 'disabled' ? 'disabled' : 'active', at, at, p.id]]);
      const removed = gone.has(p.id) || (p.kind === 'ai' && gone.has(p.owner_id));
      const status = gone.has(p.id) ? 'active' : removed && p.status === 'active' ? 'disabled' : p.status;
      stmts.push(['UPDATE participants SET workspace_id = ?, account_id = ?, workspace_role = ?, workspace_status = ?, status = ? WHERE id = ? AND workspace_id IS NULL',
        [DEFAULT_WORKSPACE, human ? accountIdOf(p.id) : null, admin ? 'admin' : 'member', removed ? 'removed' : 'active', status, p.id]]);
      if (table) stmts.push(['DELETE FROM legacy_members WHERE participant_id = ?', [p.id]]);
      each.push(stmts);
    }
    await db.batch(base);
    for (let i = 0; i < each.length; i += 30) await db.batch(each.slice(i, i + 30).flat()); // 一批 30 人（D1 單批不要太大）
    console.log(`成員與權限：已把 ${todo.length} 位成員轉到新的資料表`);
    await migrateCrossRoles(true);
    await dropLegacy();
    onChange();
    return true;
  }
  // 還沒轉的成員的舊資料：Map(成員 id → { is_admin, projects })；table＝legacy_members 在不在。
  // 009 之後在 legacy_members；009 還沒套時舊欄位還在 participants 上（兩邊都有時 legacy_members 優先，例如匯入的舊版備份）
  async function legacyRows() {
    const rows = new Map();
    const cols = new Set((await db.all('PRAGMA table_info(participants)').catch(() => [])).map(c => c.name));
    if (cols.has('is_admin') || cols.has('projects')) {
      const sql = `SELECT id, ${cols.has('is_admin') ? 'is_admin' : '0 AS is_admin'}, ${cols.has('projects') ? 'projects' : "'' AS projects"} FROM participants WHERE workspace_id IS NULL`;
      for (const r of await db.all(sql)) rows.set(r.id, r);
    }
    let table = true;
    try { for (const r of await db.all('SELECT participant_id, is_admin, projects FROM legacy_members')) rows.set(r.participant_id, r); } catch { table = false; }
    return { rows, table };
  }
  // 每個人都轉完了：抄起來的舊資料、舊設定都不需要了（還有人沒轉就留著，下次再轉）
  async function dropLegacy() {
    const done = 'NOT EXISTS (SELECT 1 FROM participants WHERE workspace_id IS NULL)';
    await db.batch([[`DELETE FROM app_settings WHERE key IN ('project_leaders', 'read_only', 'cross_roles') AND ${done}`, []]]);
    await db.run(`DELETE FROM legacy_members WHERE ${done}`).catch(() => {}); // 009 還沒套就沒有這張表
  }
  // 跨專案角色 → 每個未封存專案的明確成員資格（INSERT OR IGNORE：已在的專案角色不變，負責人照舊是專案管理員）；轉完刪掉 cross_roles。
  // 同一批裡每句都看 cross_roles 還在不在：重跑、兩份程式同時跑都只轉一次，之後被移出的人不會被加回來。
  // legacy：這次也轉了舊成員（升級前的站）；沒有 cross_roles＝還沒寫成固定名單，套舊規則（PO／SM）
  async function migrateCrossRoles(legacy) {
    const raw = await readSetting('cross_roles');
    if ((raw === undefined || raw === null) && !legacy) return;
    let cr = {};
    try { cr = JSON.parse(raw || '{}') || {}; } catch {}
    const people = (await db.all("SELECT id, kind, status, role, role_key, workspace_role FROM participants WHERE status = 'active' AND kind != 'system' ORDER BY created_at, id")).filter(p => crossOf(cr, p));
    const ids = people.map(p => p.id);
    const active = (await db.all('SELECT id FROM projects WHERE archived = 0')).map(r => r.id);
    // 工作區管理員靠隱含權限：只在有職稱的專案成為成員（#8 隱形管理員的規則；是專案管理員的專案本來就有成員資格）
    const titles = (await readJson('project_roles')) || {};
    const wsAdmin = p => p.kind === 'human' && p.workspace_role === 'admin';
    const rows = JSON.stringify(people.flatMap(x => active.filter(pj => !wsAdmin(x) || titles[x.id]?.[pj]).map(p => ({ p, id: x.id }))));
    const still = raw === undefined || raw === null ? '1 = 1' : "EXISTS (SELECT 1 FROM app_settings WHERE key = 'cross_roles')";
    await db.batch([
      [`INSERT OR IGNORE INTO project_members (project_id, participant_id, role) SELECT json_extract(value, '$.p'), json_extract(value, '$.id'), '${PR.MEMBER}' FROM json_each(?) WHERE ${still}`, [rows]],
      ["DELETE FROM app_settings WHERE key = 'cross_roles'", []],
    ]);
    if (ids.length) console.log(`成員與權限：跨專案角色已取消，${ids.length} 位改成各專案的成員`);
    onChange();
  }

  // 重讀所有快取（force）；invalidate 只標成過期，下次讀時重讀
  async function load(force = false) {
    await loadMembers(force);
  }
  function invalidate() { snapAt = 0; }

  return { projectsOf, allProjectsOf, setProjectsStmts,
    loadLeaders, leadersOf, leaderProjectsOf, setLeadersStmts, roleOf, addMemberStmts, setMemberRoleStmts,
    makeProjectAdminStmts,
    loadReadOnly, isReadOnlyHuman, isReadOnly, readOnlyProjectsOf, readOnlyOf, setReadOnlyStmts, addReadOnly,
    fetchProjectsOf, fetchMembersOf, removeProjectStmts,
    enterWorkspaceStmts, setWorkspaceRoleStmts, isPlatformAdmin, setPlatformRoleStmts, accountStatusStmts, forgetStmts, migrateLegacy,
    loadMembers, refreshOne, load, invalidate };
}
