// 成員資格模組（GLOSSARY「成員與權限」）：誰在哪些專案、誰是專案的 leader（專案管理員）、誰唯讀（唯讀成員）、誰是跨專案角色。
// 這些資料的讀寫都只經過這裡。目前存在 participants.projects 逗號字串，與 app_settings 的 project_leaders／read_only／cross_roles JSON；
// 換成 ADR 0002 的資料表（#7：project_members 帶專案角色）時只改這個檔的內部，呼叫端不用動。
//
// 讀：同步，看已載入的快照（participant 列＋各設定的 10 秒快取；load(true) 重讀）。
// 寫：回傳 [sql, args] 語句陣列，呼叫端跟卡片退回、專案事件放進同一個 db.batch（一起成功或一起失敗）；執行後呼叫 load(true)。
// PROJECTS：未封存專案 id 的陣列（core.js 原地更新的同一個陣列）。
// onChange：模組自己改了資料（跨專案角色第一次載入時的補資料）後通知呼叫端（core.js 清成員快取）。
export function createMembership({ db, PROJECTS, nowIso, onChange = () => {} }) {
  // ---------- 專案歸屬 ----------
  // 含封存專案的原始清單（不過濾）；舊資料欄位沒有值也當空的
  const allProjectsOf = p => String(p?.projects ?? '').split(',').map(x => x.trim()).filter(Boolean);
  // 目前所屬（未封存）：欄位空字串＝沒有任何專案；沒有欄位值（舊資料）＝所有專案
  const projectsOf = p => {
    const raw = p?.projects;
    if (raw === undefined || raw === null) return [...PROJECTS];
    return allProjectsOf(p).filter(x => PROJECTS.includes(x));
  };
  // 把某人的專案歸屬整個換成 projects（含封存的也要列，沒列＝移出）。at：同時更新 updated_at（null＝不動）
  // onlyIf：只在這位成員的列符合條件時才寫（participants 欄位的 SQL 條件，例如 'is_admin = 1'），用在同一批剛建的人
  function setProjectsStmts(id, projects, at, { onlyIf = null } = {}) {
    const where = `id = ?${onlyIf ? ` AND (${onlyIf})` : ''}`;
    return [at
      ? [`UPDATE participants SET projects = ?, updated_at = ? WHERE ${where}`, [projects.join(','), at, id]]
      : [`UPDATE participants SET projects = ? WHERE ${where}`, [projects.join(','), id]]];
  }

  // ---------- 存在 app_settings 的 JSON（每份程式 10 秒快取） ----------
  const upsert = key => `INSERT INTO app_settings (key, value) VALUES ('${key}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  const readSetting = async key => (await db.get('SELECT value FROM app_settings WHERE key = ?', key).catch(() => null))?.value;
  function jsonMap(key) {
    let map = {}, at = 0;
    return {
      async load(force = false) {
        if (!force && Date.now() - at < 10_000) return map;
        try { map = JSON.parse((await readSetting(key)) || '{}') || {}; } catch { map = {}; }
        at = Date.now();
        return map;
      },
      get: () => map,
      reset() { at = 0; },
    };
  }

  // ---------- 專案 leader（每個專案可多位、只能人類）：project_leaders＝{ 專案id: [成員id] } ----------
  const leaders = jsonMap('project_leaders');
  const loadLeaders = force => leaders.load(force); // 回 { 專案id: [成員id] }（含封存專案）
  const leadersOf = pj => [...(leaders.get()[pj] || [])]; // 含封存專案、含已停用的人（呼叫端自己過濾）
  const leaderProjectsOf = (id, map = leaders.get()) => Object.keys(map).filter(pj => (map[pj] || []).includes(id) && PROJECTS.includes(pj)); // 目前帶的（未封存）專案
  // 整份換掉：map 沒列的專案就沒有 leader
  const setLeadersStmts = map => [[upsert('project_leaders'), [JSON.stringify(map)]]];

  // ---------- 唯讀（唯讀成員）：read_only＝{ 專案id: [人類id] }；他名下的 AI 在該專案跟著唯讀（AI 權限不超過主人） ----------
  const readOnly = jsonMap('read_only');
  const loadReadOnly = force => readOnly.load(force); // 回 { 專案id: [人類id] }
  const isReadOnlyHuman = (id, pj, map = readOnly.get()) => !!pj && (map[pj] || []).includes(id);
  const isReadOnly = (p, pj, map = readOnly.get()) => !!p && isReadOnlyHuman(p.kind === 'ai' ? p.owner_id : p.id, pj, map);
  const readOnlyProjectsOf = (p, map = readOnly.get()) => PROJECTS.filter(pj => isReadOnly(p, pj, map)); // 未封存專案裡唯讀的
  const readOnlyOf = pj => [...(readOnly.get()[pj] || [])]; // 該專案唯讀的人類（含已停用的）
  // 整份換掉：map 沒列的專案就沒有人唯讀
  const setReadOnlyStmts = map => [[upsert('read_only'), [JSON.stringify(map)]]];
  // 把某人加成這些專案的唯讀成員（已經是就不動）；讀最新的再寫，寫完重讀
  async function addReadOnly(id, projects) {
    const next = { ...(await readOnly.load(true)) };
    for (const pj of projects) if (!(next[pj] || []).includes(id)) next[pj] = [...(next[pj] || []), id];
    await db.batch(setReadOnlyStmts(next));
    await readOnly.load(true);
  }

  // ---------- 跨專案角色：固定屬於所有專案、不能移出；cross_roles＝{ add: [id], remove: [id], frozen: 時間 } ----------
  // 新成員一律不自動跨專案（不看 PO／SM 角色），只能管理員手動開。
  // 原本「角色是 PO／SM 就跨」的規則在第一次載入時寫成固定名單（frozen），現有的人照舊
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
  // 某人含封存專案的原始清單
  const fetchProjectsOf = async id => allProjectsOf(await db.get('SELECT projects FROM participants WHERE id = ?', id));
  // 在某專案的所有人（不分狀態）：[{ id, projects: 各自含封存專案的清單 }]
  async function fetchMembersOf(pj) {
    const rows = await db.all("SELECT id, projects FROM participants WHERE ',' || projects || ',' LIKE ?", `%,${pj},%`);
    return rows.map(r => ({ id: r.id, projects: allProjectsOf(r) })).filter(r => r.projects.includes(pj));
  }

  // ---------- 永久刪除專案：所有人的歸屬、leader、唯讀都拿掉它 ----------
  // people：要檢查的成員列（含停用、已刪除的）；設定從資料庫讀最新的
  async function removeProjectStmts(pj, people, at) {
    const stmts = [];
    for (const key of ['read_only', 'project_leaders']) {
      let v; try { v = JSON.parse((await readSetting(key)) || 'null'); } catch { v = null; }
      if (v && typeof v === 'object' && pj in v) { delete v[pj]; stmts.push([upsert(key), [JSON.stringify(v)]]); }
    }
    for (const p of people) if (allProjectsOf(p).includes(pj)) stmts.push(...setProjectsStmts(p.id, allProjectsOf(p).filter(x => x !== pj), at));
    return stmts;
  }

  // 重讀所有快取（force）；invalidate 只標成過期，下次讀時重讀
  async function load(force = false) {
    await Promise.all([leaders.load(force), readOnly.load(force), loadCrossRoles(force)]);
  }
  function invalidate() { leaders.reset(); readOnly.reset(); crossAt = 0; }

  return { projectsOf, allProjectsOf, setProjectsStmts,
    loadLeaders, leadersOf, leaderProjectsOf, setLeadersStmts,
    loadReadOnly, isReadOnlyHuman, isReadOnly, readOnlyProjectsOf, readOnlyOf, setReadOnlyStmts, addReadOnly,
    loadCrossRoles, isCrossRole, crossRoles, setCrossRole, setCrossRolesStmts,
    fetchProjectsOf, fetchMembersOf, removeProjectStmts,
    load, invalidate };
}
