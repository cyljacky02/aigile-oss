// 專案看板狀態（GLOSSARY：狀態、狀態類別、必要類別、預設狀態組；資料存法見 docs/adr/0001）
// - 狀態類別：系統固定的七種語意；所有流程規則（接單、決策、驗收、交接、封存）只看類別，存在 cards.status
// - 狀態：各專案自訂的看板欄（名稱、順序、顏色），存在 project_statuses；卡片的 cards.status_id 指向它
// - cards.status_id 為空或對不上（別的專案、別的類別）時，卡片算在「同專案、同類別、排最前面」的狀態；已封存的卡沒有狀態
export const ARCHIVED = '已封存';
export const CATEGORIES = ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', ARCHIVED];
export const BOARD_CATEGORIES = CATEGORIES.filter(c => c !== ARCHIVED);
export const REQUIRED_CATEGORIES = ['待處理', '進行中', '已完成'];
export const STATUS_COLORS = ['gray', 'indigo', 'blue', 'green', 'amber', 'orange', 'red', 'violet'];
export const CATEGORY_COLOR = { 待整理: 'gray', 待處理: 'indigo', 進行中: 'amber', 受阻: 'red', 待確認: 'orange', 已完成: 'green' };
// 預設狀態組＝以前寫死的六欄（名稱就是類別名稱，所以沒自訂過的專案 API 輸出跟以前一樣）
export const DEFAULT_STATUSES = ['待整理', '待處理', '進行中', '受阻', '待確認', '已完成'].map(c => ({ name: c, category: c, color: CATEGORY_COLOR[c] }));
export const STATUS_LIMITS = { name: 20, min: 3, max: 12 };

// 卡片換類別時，status_id 改成那個專案、那個類別排最前面的狀態（UPDATE cards 用；cards.project 是正在改的那張卡）
export const firstStatusSql = category => `(SELECT ps.id FROM project_statuses ps WHERE ps.project = cards.project AND ps.category = '${category}' ORDER BY ps.position, ps.id LIMIT 1)`;
// 同上，專案與類別用參數（INSERT、或同時改專案時用）
export const FIRST_STATUS_SQL = '(SELECT ps.id FROM project_statuses ps WHERE ps.project = ? AND ps.category = ? ORDER BY ps.position, ps.id LIMIT 1)';

const ARCHIVED_ROW = Object.freeze({ id: null, name: ARCHIVED, category: ARCHIVED, color: 'gray', position: null });
const pub = s => ({ id: s.id, name: s.name, category: s.category, position: s.position, color: s.color });

// 一份請求用的狀態清單（全部專案，量很小）
function makeBook(rows, invalid) {
  const byProject = new Map(), byId = new Map();
  for (const r of rows) {
    const s = { id: Number(r.id), project: r.project, name: r.name, category: r.category, position: Number(r.position), color: r.color };
    byId.set(s.id, s);
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  for (const l of byProject.values()) l.sort((a, b) => a.position - b.position || a.id - b.id);
  const list = pj => byProject.get(pj) || [];
  const first = (pj, cat) => list(pj).find(s => s.category === cat) || null;
  const has = (pj, cat) => cat === ARCHIVED || !!first(pj, cat);
  // 卡片實際所在的狀態
  const of = c => {
    if (c.status === ARCHIVED) return ARCHIVED_ROW;
    const s = c.status_id != null ? byId.get(Number(c.status_id)) : null;
    return s && s.project === c.project && s.category === c.status ? s : first(c.project, c.status);
  };
  const names = pj => list(pj).map(s => s.name).join('、');
  // status 輸入的前兩步：這個專案的狀態名稱 → 狀態 ID（改卡片的 resolve 與卡片清單的篩選共用）
  const match = (pj, input) => {
    const raw = String(input ?? '').trim(), l = list(pj);
    return l.find(s => s.name === raw) || (/^\d+$/.test(raw) ? l.find(s => s.id === Number(raw)) : null) || null;
  };
  // 依序比對：這個專案的狀態名稱 → 狀態 ID → 狀態類別名稱（對到該類別第一個狀態；沒有待整理就用待處理）
  function resolve(pj, input) {
    const raw = String(input ?? '').trim();
    const hit = match(pj, raw);
    if (hit) return hit;
    if (raw === ARCHIVED) return ARCHIVED_ROW;
    if (CATEGORIES.includes(raw)) {
      const f = first(pj, raw) || (raw === '待整理' ? first(pj, '待處理') : null);
      if (f) return f;
    }
    throw invalid(`status 需為這個專案的狀態：${names(pj)}（也可以用狀態 ID 或狀態類別名稱）`);
  }
  return {
    list: pj => list(pj).map(pub), first, has, of, match, resolve, names,
    byId: id => byId.get(Number(id)) || null,
    // 卡片對外的狀態欄位：status＝狀態名稱、category＝狀態類別、statusId
    fields: c => { const s = of(c); return { status: s ? s.name : c.status, category: c.status, statusId: s ? s.id : null }; },
  };
}

export function createStatuses({ db, invalid }) {
  const ROWS_SQL = 'SELECT p.id AS pj, s.id, s.project, s.name, s.category, s.position, s.color FROM projects p LEFT JOIN project_statuses s ON s.project = p.id';
  // 還沒有狀態的專案（剛升級、剛建立）補上預設狀態組，並把卡片的 status_id 補齊。
  // 整組用一句插入、而且只在專案還沒有任何狀態時插：兩個請求同時補，或先補好、使用者接著改過，慢的那個什麼都不做
  const DEFAULTS_SQL = DEFAULT_STATUSES.map((s, i) => `SELECT '${s.name}' AS name, '${s.category}' AS category, ${i} AS position, '${s.color}' AS color`).join(' UNION ALL ');
  async function ensureDefaults(pjs) {
    const stmts = [];
    for (const pj of pjs) {
      stmts.push([`INSERT OR IGNORE INTO project_statuses (project, name, category, position, color) SELECT p.id, d.name, d.category, d.position, d.color
        FROM projects p CROSS JOIN (${DEFAULTS_SQL}) d WHERE p.id = ? AND NOT EXISTS (SELECT 1 FROM project_statuses ps WHERE ps.project = p.id)`, [pj]]);
      stmts.push([`UPDATE cards SET status_id = (SELECT ps.id FROM project_statuses ps WHERE ps.project = cards.project AND ps.category = cards.status ORDER BY ps.position, ps.id LIMIT 1) WHERE project = ? AND status_id IS NULL AND status != '${ARCHIVED}'`, [pj]]);
    }
    await db.batch(stmts);
  }
  // 每個請求讀一次（ctx 快取）；改過狀態設定後 ctx.statusBook = null 重讀
  async function load(ctx = null) {
    if (ctx?.statusBook) return ctx.statusBook;
    let rows = await db.all(ROWS_SQL);
    const missing = [...new Set(rows.filter(r => r.id === null || r.id === undefined).map(r => r.pj))];
    if (missing.length) { await ensureDefaults(missing); rows = await db.all(ROWS_SQL); }
    const book = makeBook(rows.filter(r => r.id !== null && r.id !== undefined), invalid);
    if (ctx) ctx.statusBook = book;
    return book;
  }
  // 把專案裡「status_id 空的或對不上」的卡補成實際所在的狀態（改設定前先做，之後只看 status_id）
  const normalize = pj => db.run(`UPDATE cards SET status_id = (SELECT ps.id FROM project_statuses ps WHERE ps.project = cards.project AND ps.category = cards.status ORDER BY ps.position, ps.id LIMIT 1)
    WHERE project = ? AND status != '${ARCHIVED}' AND (status_id IS NULL OR status_id NOT IN (SELECT ps2.id FROM project_statuses ps2 WHERE ps2.project = cards.project AND ps2.category = cards.status))`, pj);
  return { load, normalize, ensureDefaults };
}

// 狀態名稱：1～20 字、不可換行；不能取成「別的」類別的名稱（免得「進行中」到底是哪一欄說不清）
export function checkStatusName(raw, category, invalid) {
  const name = String(raw ?? '').trim();
  if (!name || [...name].length > STATUS_LIMITS.name || /[\n\r]/.test(name)) throw invalid(`狀態名稱需為 1～${STATUS_LIMITS.name} 字，不可換行`);
  if (CATEGORIES.includes(name) && name !== category) throw invalid(`狀態名稱不能叫「${name}」：那是另一個狀態類別的名稱`);
  return name;
}
export function checkCategory(raw, invalid) {
  if (!BOARD_CATEGORIES.includes(raw)) throw invalid(`category 需為：${BOARD_CATEGORIES.join('、')}（已封存由系統管理）`);
  return raw;
}
export function checkColor(raw, category, invalid) {
  if (raw === undefined || raw === null || raw === '') return CATEGORY_COLOR[category];
  if (!STATUS_COLORS.includes(raw)) throw invalid(`color 需為：${STATUS_COLORS.join('、')}`);
  return raw;
}
// 整份狀態清單的規則（建立專案時給整份；之後的單項修改也用它檢查改完的結果）
export function checkStatusList(list, invalid) {
  if (list.length < STATUS_LIMITS.min || list.length > STATUS_LIMITS.max) throw invalid(`每個專案要有 ${STATUS_LIMITS.min}～${STATUS_LIMITS.max} 個狀態`);
  const seen = new Set();
  for (const s of list) {
    if (seen.has(s.name)) throw invalid(`狀態名稱「${s.name}」重複了`);
    seen.add(s.name);
  }
  const missing = REQUIRED_CATEGORIES.filter(c => !list.some(s => s.category === c));
  if (missing.length) throw invalid(`每個專案至少要有一個這些類別的狀態：${missing.join('、')}`);
}
// 建立專案時帶的狀態清單 → [{ name, category, color }]
export function readStatusList(raw, invalid) {
  if (!Array.isArray(raw)) throw invalid('statuses 要是陣列：[{ name, category, color }]');
  const list = raw.map(s => { const category = checkCategory(s?.category, invalid); return { name: checkStatusName(s?.name, category, invalid), category, color: checkColor(s?.color, category, invalid) }; });
  checkStatusList(list, invalid);
  return list;
}

// 狀態管理 API：讀（看得到這個專案的人）；新增、改名／改色／改類別、排序、刪除（管理員或該專案 leader）
// moveCardStmts(ctx, me, card, target, at)：刪除狀態時把卡搬到目標狀態的語句（跨類別照卡片規則；卡片同時被改過就讓交易失敗），由 cards.js 提供
export function registerStatusRoutes({ route, db, statuses, ApiError, invalid, readJson, nowIso, requireAdminOrLeader, canSeeProject, projectExists, cardKey, moveCardStmts, invalidatePeople, projEvent }) {
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這個狀態');
  async function projectOf(ctx, me, pj, { manage = false } = {}) {
    if (!(await projectExists(pj))) throw new ApiError(404, 'NOT_FOUND', '找不到這個專案');
    if (manage) await requireAdminOrLeader(ctx, me, pj, '改專案的看板狀態');
    else if (!canSeeProject(me, pj)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案。');
    return statuses.load(ctx);
  }
  // 改設定前先把卡片的 status_id 補齊，之後「狀態裡有幾張卡」只看 status_id
  async function managed(ctx, me, pj) {
    const book = await projectOf(ctx, me, pj, { manage: true });
    await statuses.normalize(pj);
    return book;
  }
  const reply = async (ctx, pj, extra = {}) => { ctx.statusBook = null; return { items: (await statuses.load(ctx)).list(pj), ...extra }; };
  const find = (book, pj, sid) => { const s = book.byId(sid); if (!s || s.project !== pj) throw notFound(); return s; };
  const cardsIn = sid => db.all(`SELECT * FROM cards WHERE status_id = ? AND status != '${ARCHIVED}' ORDER BY seq`, sid);
  const event = (pj, me, text) => (projEvent ? db.batch([projEvent(pj, me.id, `${me.name} ${text}`, nowIso())]) : null);
  const keys = rows => rows.slice(0, 20).map(c => cardKey(c)).filter(Boolean);

  route('GET', '/api/projects/:id/statuses', async ({ ctx, me, params }) => {
    const book = await projectOf(ctx, me, params.id);
    return { items: book.list(params.id), categories: BOARD_CATEGORIES, required: REQUIRED_CATEGORIES, colors: STATUS_COLORS, limits: STATUS_LIMITS };
  });

  route('POST', '/api/projects/:id/statuses', async ({ ctx, me, req, params }) => {
    const pj = params.id, book = await managed(ctx, me, pj), body = await readJson(req);
    const category = checkCategory(body.category, invalid), name = checkStatusName(body.name, category, invalid), color = checkColor(body.color, category, invalid);
    const list = book.list(pj);
    checkStatusList([...list, { name, category }], invalid);
    const position = list.reduce((m, s) => Math.max(m, s.position), -1) + 1;
    await db.run('INSERT INTO project_statuses (project, name, category, position, color) VALUES (?,?,?,?,?)', pj, name, category, position, color);
    await event(pj, me, `新增看板狀態「${name}」（${category}）`);
    return { __status: 201, ...(await reply(ctx, pj)) };
  });

  route('PATCH', '/api/projects/:id/statuses/:sid', async ({ ctx, me, req, params }) => {
    const pj = params.id, book = await managed(ctx, me, pj), body = await readJson(req);
    const s = find(book, pj, params.sid);
    const category = body.category === undefined ? s.category : checkCategory(body.category, invalid);
    const name = body.name === undefined ? s.name : checkStatusName(body.name, category, invalid);
    if (body.name === undefined) checkStatusName(name, category, invalid); // 改類別後原名稱也要合規則
    const color = body.color === undefined ? s.color : checkColor(body.color, category, invalid);
    if (category !== s.category) {
      // 只有空的狀態能改類別：有卡就等於一次觸發大量完成／驗收規則
      const n = (await cardsIn(s.id)).length;
      if (n) throw new ApiError(409, 'STATUS_NOT_EMPTY', `「${s.name}」裡還有 ${n} 張卡，不能改類別：請新建一個狀態，把卡片搬過去。`);
    }
    checkStatusList(book.list(pj).map(x => (x.id === s.id ? { name, category } : x)), invalid);
    await db.run('UPDATE project_statuses SET name = ?, category = ?, color = ? WHERE id = ?', name, category, color, s.id);
    const what = [name !== s.name && `改名「${s.name}」→「${name}」`, category !== s.category && `類別 ${s.category} → ${category}`, color !== s.color && '改顏色'].filter(Boolean);
    if (what.length) await event(pj, me, `看板狀態${what.join('、')}`);
    return reply(ctx, pj);
  });

  route('PUT', '/api/projects/:id/statuses/order', async ({ ctx, me, req, params }) => {
    const pj = params.id, book = await managed(ctx, me, pj), body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    const have = book.list(pj).map(s => s.id);
    if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every(id => have.includes(id))) throw invalid(`ids 要列出這個專案的全部狀態 ID（各一次）：${have.join(', ')}`);
    await db.batch(ids.map((id, i) => ['UPDATE project_statuses SET position = ? WHERE id = ?', [i, id]]));
    return reply(ctx, pj);
  });

  route('DELETE', '/api/projects/:id/statuses/:sid', async ({ ctx, me, req, params, url }) => {
    const pj = params.id, book = await managed(ctx, me, pj), body = await readJson(req);
    const s = find(book, pj, params.sid), list = book.list(pj);
    const last = !list.some(x => x.id !== s.id && x.category === s.category);
    if (last && REQUIRED_CATEGORIES.includes(s.category)) throw new ApiError(409, 'LAST_REQUIRED', `「${s.name}」是這個專案最後一個「${s.category}」類別的狀態，不能刪：每個專案都要有 ${REQUIRED_CATEGORIES.join('、')}。`);
    if (list.length <= STATUS_LIMITS.min) throw new ApiError(409, 'TOO_FEW_STATUSES', `每個專案至少要有 ${STATUS_LIMITS.min} 個狀態。`);
    // 決策卡只能待在待確認（暫緩時在受阻）：還有這種卡就不能拿掉最後一個對應的狀態
    if (last && s.category === '待確認') {
      const open = await db.all(`SELECT seq, project, proj_no FROM cards WHERE project = ? AND type = '決策' AND decision_result IS NULL AND status IN ('待確認', '受阻') ORDER BY seq`, pj);
      if (open.length) throw new ApiError(409, 'HAS_DECISIONS', `還有 ${open.length} 張未決定的決策卡（${keys(open).join('、')}），先決定或刪掉它們，才能拿掉最後一個「待確認」狀態。`, { cards: keys(open) });
    }
    if (last && s.category === '受阻') {
      const deferred = await db.all(`SELECT seq, project, proj_no FROM cards WHERE project = ? AND type = '決策' AND decision_result IS NULL AND status = '受阻' AND blocker LIKE '暫緩（%' ORDER BY seq`, pj);
      if (deferred.length) throw new ApiError(409, 'HAS_DEFERRED', `還有 ${deferred.length} 張暫緩中的決策卡（${keys(deferred).join('、')}），先恢復它們，才能拿掉最後一個「受阻」狀態。`, { cards: keys(deferred) });
    }
    const rows = await cardsIn(s.id);
    let target = null;
    if (rows.length) {
      const raw = body.moveTo ?? url.searchParams.get('moveTo');
      if (raw === undefined || raw === null || raw === '') throw new ApiError(409, 'STATUS_NOT_EMPTY', `「${s.name}」裡還有 ${rows.length} 張卡：請用 moveTo 指定要搬到哪個狀態。`, { cardCount: rows.length });
      target = book.byId(raw);
      if (!target || target.project !== pj || target.id === s.id) throw invalid('moveTo 要是這個專案的另一個狀態 ID');
      if (target.category === '已完成' && rows.some(c => c.type === '決策')) throw invalid('裡面有決策卡：決策卡要由決策者決定，不能直接搬到已完成。');
    }
    // 搬卡、刪狀態、異動紀錄在同一個交易：中途失敗就整個回復，不會留下搬了一半的卡。
    // 會被留下的卡＝還在這個狀態（這是類別最後一個狀態時：還在這個類別）；剛讀完就有卡搬進來，交易裡就會查到
    const left = pjCol => `SELECT seq, version FROM cards WHERE project = ${pjCol} AND status != '${ARCHIVED}' AND (status_id = ?${last ? ' OR status = ?' : ''})`;
    const leftArgs = [s.id, ...(last ? [s.category] : [])];
    const at = nowIso(), stmts = [];
    for (const c of rows) stmts.push(...(await moveCardStmts(ctx, me, c, target, at)));
    // 最後一句寫異動紀錄兼檢查：還有會被留下的卡，project_id 就查不到、是 NULL，違反 NOT NULL，整個交易回復
    stmts.push(['DELETE FROM project_statuses WHERE id = ?', [s.id]],
      [`INSERT INTO project_events (project_id, at, actor_id, text) VALUES ((SELECT p.id FROM projects p WHERE p.id = ? AND NOT EXISTS (${left('p.id')})),?,?,?)`,
        [pj, ...leftArgs, at, me.id, `${me.name} 刪除看板狀態「${s.name}」${target ? `（${rows.length} 張卡搬到「${target.name}」）` : ''}`]]);
    try { await db.batch(stmts); }
    catch (e) {
      // 交易失敗：讀完之後卡片有進出或被改過、或要搬去的狀態剛被刪（搬卡語句與上面的檢查會讓交易失敗）就回 409；其他錯誤照丟
      const now = new Map((await db.all(left('?'), pj, ...leftArgs)).map(c => [c.seq, c.version]));
      const changed = now.size !== rows.length || rows.some(c => now.get(c.seq) !== c.version) || (target && !(await db.get('SELECT id FROM project_statuses WHERE id = ?', target.id)));
      if (changed) throw new ApiError(409, 'CONFLICT', `「${s.name}」裡的卡片或要搬去的狀態剛有變動，這次沒有刪除；請重新讀取後再試。`);
      throw e;
    }
    if (rows.length) invalidatePeople();
    return reply(ctx, pj, { moved: rows.length });
  });
}
