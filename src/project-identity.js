// 專案識別碼：網址英文名（slug:<專案>）與專案代號（pcode:<專案>，卡片顯示 MAIN-12；改代號前的舊代號 pcodeold:<代號> → 專案）（ADR 0004、0005）
//
// 1. 現行推導規則（displayedIdentity）：沒存的值照升級前的規則從網址英文名推導。畫面上看得到的值都從這裡來。
// 2. 啟動正規化（normalize）：先取完整快照（專案、所有識別碼設定），一次算出每個專案（未封存、封存、可復原期內）目前顯示的值，
//    再一批寫入（鎖工作區列、交易內確認快照沒變），同一批寫「已正規化」的標記。可安全重跑；已存的值不動（只有不合規則、畫面上沒用到的代號
//    才換成畫面上顯示的值），舊代號別名不動。讀取失敗照丟（不當作「沒有資料」），部分完成不會被標成已完成。
// 3. 之後所有會動到名稱或識別碼命名空間的寫入：批次裡斷言「已正規化」（沒有就 503，可重試）、斷言自己的識別碼沒被別的專案用掉（含可復原期內
//    專案保留的、所有舊代號）。
// 4. 既有的衝突（重複代號、代號與他案舊代號相同、重複網址英文名、未封存專案同名）原樣保留，identityConflicts 列給平台管理員看。
import { lockWorkspaceStmt, ensureStmt, notRestoringStmt, writeOrdered, RESTORE_STATE_KEY } from './write-order.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { CLAIMS_VERSION, claimsSeeded, seedClaimsStmts, diagnoseClaims, notDisputed, routeToken } from './project-identity-claims.js';

export const CODE_RE = /^[A-Z]{2,5}$/;
export const SLUG_DEFAULT = { '預設專案': 'main', '第二專案': 'second' }; // 舊站固定 id 的專案的網址英文名（卡號前綴取它的字母）
// 「已正規化」的標記（app_settings）：不跟著備份搬（backup.js skipSetting），開始匯入時跟著清掉，還原收尾一定重新正規化
export const IDENTITY_READY_KEY = 'project_identity_ready';
const SETTINGS_RANGE = "(key >= 'pcode:' AND key < 'pcode;') OR (key >= 'pcodeold:' AND key < 'pcodeold;') OR (key >= 'slug:' AND key < 'slug;')";
const letter = n => String.fromCharCode(65 + (n % 26));

// 識別碼設定列 → { codes: 專案→存的代號, slugs: 專案→存的網址英文名, olds: 舊代號→專案 }
export function splitIdentitySettings(rows) {
  const codes = {}, slugs = {}, olds = {};
  for (const r of rows) (r.key.startsWith('pcodeold:') ? olds : r.key.startsWith('pcode:') ? codes : slugs)[r.key.slice(r.key.indexOf(':') + 1)] = r.value;
  return { codes, slugs, olds };
}
// 現行規則下畫面上顯示的值。rows＝所有專案（含封存、可復原期內），照 created_at、id 排序（推導的代號依順序避開前面用掉的）。
// 代號：存了合規則的就用它；沒有就取網址英文名的前 4 個英文字母（不足 2 個用 PJ＋字母），撞到就換最後一個字母。
// 網址英文名：存的值；沒有就用舊站固定專案的預設；再沒有就用專案 id
export function displayedIdentity(rows, { codes: set, slugs, olds }) {
  const codes = {}, used = new Set(Object.values(set));
  rows.forEach((r, i) => {
    if (CODE_RE.test(set[r.id] || '')) { codes[r.id] = set[r.id]; return; }
    const slug = slugs[r.id] || SLUG_DEFAULT[r.id] || '';
    const letters = slug.replace(/[^a-z]/gi, '').toUpperCase();
    let code = letters.length >= 2 ? letters.slice(0, 4) : 'PJ' + letter(i);
    for (let k = 0; used.has(code) && k < 26; k++) code = code.slice(0, 4) + letter(k);
    used.add(code); codes[r.id] = code;
  });
  return { codes, slugs: Object.fromEntries(rows.map(r => [r.id, slugs[r.id] || SLUG_DEFAULT[r.id] || r.id])), olds };
}
// 新專案自動產生的代號（跟推導同一套規則，但一定挑沒被用掉的）。used：別的專案的代號與所有舊代號；index：新專案排在第幾個
export function autoCode(slug, used, index) {
  const letters = String(slug || '').replace(/[^a-z]/gi, '').toUpperCase();
  let code = letters.length >= 2 ? letters.slice(0, 4) : 'PJ' + letter(index);
  for (let k = 0; used.has(code) && k < 26; k++) code = code.slice(0, 4) + letter(k);
  for (let a = 0; used.has(code) && a < 26 * 26; a++) code = code.slice(0, 3) + letter(Math.floor(a / 26)) + letter(a);
  for (let a = 0; used.has(code) && a < 26 * 26 * 26; a++) code = 'Q' + letter(Math.floor(a / 676)) + letter(Math.floor(a / 26)) + letter(a);
  return code;
}

// 卡號前綴先找現行代號，再找使用中的舊代號；即使第一個專案的卡找不到，也不往下一個專案找。
export function projectForCardCode(code, codes, olds, active) {
  const id = Object.keys(codes).find(k => codes[k] === code);
  if (id) return { projectId: id, source: 'current' };
  if (active(olds[code])) return { projectId: olds[code], source: 'historical' };
  return null;
}

export async function cardSeqInProject(db, projectId, no) {
  const hit = (await db.get('SELECT seq FROM cards WHERE project = ? AND proj_no = ?', projectId, no))?.seq;
  if (hit) return hit;
  const moved = await db.get('SELECT value FROM app_settings WHERE key = ?', `cardmoved:${projectId}:${no}`).catch(() => null);
  return moved ? Number(moved.value) : null;
}

// ---------- 交易內斷言（條件都是 EXISTS／NOT EXISTS，不會是 SQL NULL） ----------
// 已正規化：識別碼都存進資料庫了，下面的唯一性斷言才有意義
export const identityReadyStmt = () => ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ?)', [IDENTITY_READY_KEY]);
// 這個網址英文名沒被別的專案用（存的網址英文名，或別的專案的 id；含可復原期內的）
export const slugFreeCond = (slug, id) => ({
  cond: `NOT EXISTS (SELECT 1 FROM app_settings WHERE key >= 'slug:' AND key < 'slug;' AND value = ? AND key != ?)
    AND NOT EXISTS (SELECT 1 FROM projects WHERE lower(id) = ? AND id != ?) AND ${notDisputed('slug')}`,
  args: [slug, 'slug:' + id, routeToken(slug), id, routeToken(slug)] });
// 現行代號、舊代號以及有衝突的代號保留。
export const codeFreeCond = (code, id) => ({
  cond: `NOT EXISTS (SELECT 1 FROM app_settings WHERE key >= 'pcode:' AND key < 'pcode;' AND value = ? AND key != ?)
    AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value != ?) AND ${notDisputed('code')}`,
  args: [code, 'pcode:' + id, 'pcodeold:' + code, id, code] });
// 這個專案現在存的代號、網址英文名都沒跟別的專案重複（取消封存、復原：既有的衝突不能因此變成使用中）
export const ownIdentityFreeCond = id => ({
  cond: `NOT EXISTS (SELECT 1 FROM app_settings m JOIN app_settings o ON o.value = m.value AND o.key != m.key WHERE m.key = ? AND o.key >= 'pcode:' AND o.key < 'pcode;')
    AND NOT EXISTS (SELECT 1 FROM app_settings m JOIN app_settings o ON o.key = 'pcodeold:' || m.value AND o.value != ? WHERE m.key = ?)
    AND NOT EXISTS (SELECT 1 FROM app_settings m JOIN app_settings o ON o.value = m.value AND o.key != m.key WHERE m.key = ? AND o.key >= 'slug:' AND o.key < 'slug;')
    AND NOT EXISTS (SELECT 1 FROM app_settings m JOIN projects o ON lower(o.id) = m.value AND o.id != ? WHERE m.key = ?)`,
  args: ['pcode:' + id, id, 'pcode:' + id, 'slug:' + id, id, 'slug:' + id] });
export const ensureCond = c => ensureStmt(c.cond, c.args);
// 用新鮮資料看條件現在成不成立（斷言失敗後判斷原因用）
export const holdsNow = async (db, c) => !!(await db.get(`SELECT 1 AS x WHERE ${c.cond}`, ...c.args));

// ---------- 既有衝突的診斷 ----------
// rows：所有專案（含封存、可復原期內）；shown：displayedIdentity 的結果。回 [{ kind, value, projects: [id…] }]
export const CONFLICT_KINDS = ['duplicate_code', 'code_is_old_alias', 'duplicate_slug', 'duplicate_name'];
export function identityConflicts(rows, shown) {
  const out = [], ids = new Set(rows.map(r => r.id));
  const dup = (kind, keyOf, list = rows) => {
    const by = new Map();
    for (const r of list) {
      const k = keyOf(r);
      if (!k) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r.id);
    }
    for (const [value, projects] of by) if (projects.length > 1) out.push({ kind, value, projects });
  };
  dup('duplicate_code', r => shown.codes[r.id]);
  for (const r of rows) {
    const code = shown.codes[r.id], owner = shown.olds[code];
    if (code && owner !== undefined && owner !== r.id) out.push({ kind: 'code_is_old_alias', value: code, projects: [r.id, ...(ids.has(owner) ? [owner] : [])] });
  }
  dup('duplicate_slug', r => shown.slugs[r.id]);
  dup('duplicate_name', r => r.name, rows.filter(r => !Number(r.archived) && !r.deleted_at));
  return out;
}

// D1 限制單一綁定值的位元組數。逐頁綁定，完整斷言與寫入仍用同一批交易。
function* jsonPages(rows) {
  const limit = 512 * 1024, encoder = new TextEncoder();
  let page = [], bytes = 2;
  for (const row of rows) {
    const json = JSON.stringify(row), size = encoder.encode(json).byteLength + 1;
    if (page.length && bytes + size > limit) {
      yield ['[' + page.join(',') + ']', page.length];
      page = []; bytes = 2;
    }
    page.push(json); bytes += size;
  }
  if (page.length) yield ['[' + page.join(',') + ']', page.length];
}

// ---------- 讀取與正規化 ----------
export function createProjectIdentity({ db, nowIso, waits }) {
  // 讀取一律不吞錯：讀不到就丟，不會被當成「沒有資料」
  const isNormalized = async () => !!(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', IDENTITY_READY_KEY));
  const markers = async () => new Map((await db.all('SELECT key, value FROM app_settings WHERE key IN (?, ?)', IDENTITY_READY_KEY, RESTORE_STATE_KEY)).map(r => [r.key, r.value]));
  async function snapshot() {
    // 一句查詢取同一時間的專案與設定，避免把並行調整前後的資料混成一份快照。
    const data = await db.all(`SELECT id, name, archived, deleted_at, created_at, NULL AS key, NULL AS value FROM projects
      UNION ALL SELECT NULL, NULL, NULL, NULL, NULL, key, value FROM app_settings WHERE ${SETTINGS_RANGE}
      ORDER BY created_at, id`);
    const rows = [], settings = [];
    for (const { key, value, ...row } of data) {
      if (key === null) rows.push(row);
      else settings.push({ key, value });
    }
    return { rows, settings, shown: displayedIdentity(rows, splitIdentitySettings(settings)) };
  }
  // restoreRaw：還原收尾時確定仍是同一次還原，且不看正規化標記（一定重新算）。啟動時若還原中，先回 false。
  // 回 true＝已正規化；false＝這次沒做成（之後再試）；讀寫錯誤照丟
  async function normalize({ restoreRaw, keepDisputes = false, attempts = 5 } = {}) {
    const finishingRestore = restoreRaw !== undefined;
    for (let i = 0; i < attempts; i++) {
      const state = await markers();
      const ready = state.get(IDENTITY_READY_KEY);
      if (state.get(RESTORE_STATE_KEY) !== restoreRaw) return false;
      if (!finishingRestore && claimsSeeded(ready)) return true;
      const { rows, settings, shown } = await snapshot();
      const stored = new Map(settings.map(r => [r.key, r.value]));
      const items = rows.flatMap(r => [['slug:' + r.id, shown.slugs[r.id]], ['pcode:' + r.id, shown.codes[r.id]]])
        .filter(([k, v]) => stored.get(k) !== v).map(([k, v]) => ({ k, v, p: k.slice(k.indexOf(':') + 1) }));
      const conflicts = identityConflicts(rows, shown);
      // 第一句工作區列鎖（跟建立、改名、改識別碼、開始匯入排隊）；確認快照之後專案與識別碼設定都沒變，變了就重讀重算。
      // 逐頁比對每個主鍵與值，再比總列數。建案時間決定代號推導的順序。
      const projectKeys = jsonPages(rows.map(r => ({ id: r.id, at: r.created_at })));
      const settingKeys = jsonPages(settings);
      const stmts = [lockWorkspaceStmt(DEFAULT_WORKSPACE),
        finishingRestore ? ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value = ?)', [RESTORE_STATE_KEY, restoreRaw]) : notRestoringStmt(),
        // 別的執行個體先做完時，重讀標記。舊程式之後的寫入可能讓快照過時，不能在每次啟動時洗掉爭議來源。
        ...(finishingRestore ? [] : [ready === undefined
          ? ensureStmt('NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)', [IDENTITY_READY_KEY])
          : ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value = ?)', [IDENTITY_READY_KEY, ready])]),
        ensureStmt(`(SELECT COUNT(*) FROM projects) = ? AND (SELECT COUNT(*) FROM app_settings WHERE ${SETTINGS_RANGE}) = ?`, [rows.length, settings.length]),
        ...Array.from(projectKeys, ([json, count]) => ensureStmt(`(SELECT COUNT(*) FROM
          (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.at') AS at FROM json_each(?)) AS snapshot
          JOIN projects p ON p.id = snapshot.id AND p.created_at = snapshot.at) = ?`, [json, count])),
        ...Array.from(settingKeys, ([json, count]) => ensureStmt(`(SELECT COUNT(*) FROM
          (SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.value') AS value FROM json_each(?)) AS snapshot
          JOIN app_settings s ON s.key = snapshot.key AND s.value = snapshot.value) = ?`, [json, count])),
        ...Array.from(jsonPages(items), ([json]) => [`INSERT INTO app_settings (key, value) SELECT json_extract(value, '$.k'), json_extract(value, '$.v') FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM projects WHERE id = json_extract(value, '$.p')) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [json]]),
        ...seedClaimsStmts({ keepDisputes: finishingRestore && keepDisputes }),
        ['INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [IDENTITY_READY_KEY, JSON.stringify({ at: nowIso(), projects: rows.length, written: items.length, conflicts: conflicts.length, claimsVersion: CLAIMS_VERSION })]]];
      if (await writeOrdered(db, stmts, waits ? { waits } : {})) {
        if (conflicts.length) console.warn(`專案識別碼：既有的衝突 ${conflicts.length} 處（原樣保留，平台管理員在平台設定看得到）`, JSON.stringify(conflicts));
        return true;
      }
    }
    return false;
  }
  // 平台管理員的診斷：已不已正規化、既有的衝突（每次都用新鮮資料算）
  async function diagnose() {
    const state = await markers();
    const { rows, shown } = await snapshot();
    const claims = await diagnoseClaims(db, { rows, shown, marker: state.get(IDENTITY_READY_KEY), restoring: state.has(RESTORE_STATE_KEY) });
    return { normalized: state.has(IDENTITY_READY_KEY), rows, shown, conflicts: identityConflicts(rows, shown), claims };
  }
  return { normalize, isNormalized, diagnose, snapshot };
}
