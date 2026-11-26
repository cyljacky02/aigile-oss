// 備份匯出與匯入：管理員在「成員與權限 › 系統」下載整個群組的資料，或在空站匯入
// 規則：
//   - 一個 JSON 檔：成員、專案、訊息、卡片、決策、技能、設定…；選填附件（訊息附件、專案文件）
//   - 不含任何登入用的東西：成員 Token、密碼雜湊、裝置登入、登入碼、邀請與救援連結、AI 接入連結
//   - 匯出、匯入都分批（每次一小段），不超過 Workers 的時間與 D1 的單次限制；網頁負責組成一個檔、再分批送回
//   - 匯入只在空站可用（只有你一位人類、沒有 AI、訊息、卡片、技能、文件或專案範本）；先預覽數量再確認
//   - 備份裡的平台管理員、工作區管理員原樣帶回來；匯入後你的登入（密碼、這台裝置）改掛到備份裡的平台管理員身上；其他人要你在「邀請」發重設登入連結，AI 要主人重發 Token
//   - 「還原中」（app_settings 的 restore_state）從開始匯入持續到收尾全部做完：期間會動到共同不變量的寫入在交易內被擋（503 RESTORING，docs/adr/0005）。
//     收尾中途失敗就維持還原中，再按一次收尾從頭重跑（每一步都要能重跑、不重複產生副作用）
import { APP_VERSION, cmpVersion } from './version.js';
import { AUDIT_ACTION, AUDIT_SCOPE } from './audit.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { lockWorkspaceStmt, ensureStmt, isAssertionFailure, RESTORE_STATE_KEY } from './write-order.js';
import { IDENTITY_READY_KEY } from './project-identity.js';
import { PCR_TABLE, restoreRowProblem } from './project-creation-requests.js';
import { TEMPLATE_TABLE, restoreTemplateProblem, templateNotReady } from './project-templates.js';
import { isConstraintViolation, isMissingTable } from './db-errors.js';

export const BACKUP_FORMAT = 'aigile-backup';
export const BACKUP_FORMAT_VERSION = 1;
// 匯出的資料表（順序＝匯入順序）。新增資料表時一定要放進 EXPORT_TABLES 或 SKIP_TABLES（backup-test 會檢查）
export const EXPORT_TABLES = ['workspaces', 'projects', 'project_statuses', 'project_events', 'app_settings', 'accounts', 'participants', 'project_members', 'ai_state', 'messages', 'message_recipients', 'notifications', 'dms',
  'decision_resolutions', 'cards', 'card_log', 'card_msgs', 'suggestions', 'avatars', 'avatar_proposals',
  'skills', 'skill_allows', 'skill_installs', 'skill_syncs', 'join_requests',
  TEMPLATE_TABLE, // 專案範本（含已停用的）
  'project_creation_requests', // 建立專案申請：所有狀態原樣帶（舊備份沒有這張表＝還原後是空的；收尾時檢查待審的，見 core.js 的 restoreSteps）
  'doc_folders', 'docs', 'files', 'file_audit', 'file_chunks',
  'kb_chunks', 'kb_pages', // 知識庫：kb_chunks 是文件抽出的文字（跟著文件走），kb_pages 是 AI 寫的知識頁（一定帶）
  'audit_log']; // 稽核紀錄：還原時不清掉這個站原本的，備份裡的合併進來（同一筆 id 不重複），結束匯入時再加一筆 backup.restore
const KEEP_TABLES = ['audit_log']; // 開始匯入時不清的表（稽核紀錄只能新增）
// 不匯出：登入用的（Token、密碼雜湊、裝置、登入碼、邀請、救援連結、登入通知、失敗次數）
// schema_migrations：每個站自己套過哪些資料庫升級，不跟著備份搬；legacy_members：升級用的暫存，轉完就是空的
export const SKIP_TABLES = ['devices', 'invites', 'pair_codes', 'credentials', 'login_fails', 'rescue_links', 'account_notices', 'schema_migrations', 'legacy_members'];
const FILE_TABLES = ['docs', 'files', 'kb_chunks']; // 不含附件時整張不帶（kb_chunks 是文件內容，沒文件就不帶）
const BLOB_COLS = { avatars: ['data'], avatar_proposals: ['data'], file_chunks: ['data'] };
const DROP_COLS = { participants: ['token', 'token_expires_at'] }; // 匯入時換新：Token 隨機、已過期
// app_settings 不帶的：AI 接入連結（一次性密鑰的雜湊）、預設管理員要改帳密的標記、快取用的版本（成員、訊息刪除）、匯入中的標記、更新檢查的快取
// IDENTITY_READY_KEY：專案識別碼「已正規化」是這個站自己的狀態，不跟著搬（還原收尾一定重新正規化，舊備份或動過的備份都不會因為帶了標記而跳過）
const skipSetting = k => k.startsWith('olink:') || k.startsWith('must_change_cred:') || k.startsWith('relogin:') || ['people_ver', 'msg_ver', 'restore_state', 'update_check', IDENTITY_READY_KEY].includes(k);
// 每頁幾列：一般 500；大欄位的表少一點（技能一列最多 1 MB、file_chunks 一列 512 KB、頭像是圖片）
const TEMPLATE_RESTORE_PAGE = 97; // 留三句給還原階段的鎖與斷言。
const PAGES = { file_chunks: 1, skills: 4, avatar_proposals: 5, avatars: 20, kb_pages: 50, [TEMPLATE_TABLE]: TEMPLATE_RESTORE_PAGE }; // 知識頁一頁最多 2 萬字
const pageOf = t => PAGES[t] || 500;
// 匯入前逐列檢查的表（跟資料表的 CHECK、NOT NULL 一致）：不合法的列整批不寫，回明確的格式錯誤（不修改資料、不繞過資料庫約束）。
// 檢查回問題說明（合法回 null）。這些表寫入時撞到資料庫約束（例：同一申請人兩份同名的待審申請）也回同一個格式錯誤
const ROW_CHECKS = { [PCR_TABLE]: restoreRowProblem, [TEMPLATE_TABLE]: restoreTemplateProblem };
// 格式錯誤說明的固定句型（英文字典整句比對）
const ROW_INVALID_MSG = { constraint: '違反資料表的約束（重複或欄位不合法）', which: '（資料列 id {0}）' };

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const toU8 = v => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v) : null);

// clearCaches：只清快取（不改資料）。restoreSteps：還原收尾的修整步驟 [{ name, run }]，依序執行（見 restore/finish）
export function registerBackup({ route, db, ApiError, invalid, readJson, readBody, randId, nowIso, access, requireHuman, adminOf, storage, docStorage, auditLog, membership, clearCaches, restoreSteps = [] }) {
  const adminOnly = async (ctx, me) => { requireHuman(me); await access.check(ctx, me, 'manage_platform', 'platform', { what: '備份與匯入' }); };
  const columnsOf = async t => (await db.all(`PRAGMA table_info(${t})`)).map(c => c.name);
  // 匯入中只認開始匯入的那位（備份的成員寫進來後，最早的人類會變成管理員，不能再用權限模組的管理員判斷）。
  // 收尾已經把登入轉到備份裡的管理員（restore_state.you）：認那位，而且只剩收尾能做（finishing）
  const holder = st => st.you || st.by;
  // 回 { st, raw }：raw 是這次讀到的 restore_state 原字串。之後的寫入在交易內比對它（還是同一個階段），不再另外重讀
  const restorer = async (me, { finishing = false } = {}) => {
    requireHuman(me);
    const cur = await readState().catch(() => null);
    const st = cur?.st;
    if (!st || holder(st) !== me.id) throw notRestoring();
    if (st.you && !finishing) throw finishingError();
    return cur;
  };
  // restore_state 還是 raw（沒被收尾或別的匯入改過）：先鎖工作區列、再鎖 restore_state 這列（順序：工作區 → 其他），再斷言。
  // 匯入到一半工作區列可能還不在（鎖不到任何東西），restore_state 這列的鎖一定在：跟收尾每一段的寫入排隊
  const samePhaseStmts = raw => [lockWorkspaceStmt(DEFAULT_WORKSPACE), ['UPDATE app_settings SET value = value WHERE key = ?', [RESTORE_STATE_KEY]],
    ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value = ?)', [RESTORE_STATE_KEY, raw])];
  // 程式可以先於範本表部署；只把這張表不存在的查詢錯誤視為尚未升級。
  const templatesReady = async () => {
    try { await db.get(`SELECT 1 AS x FROM ${TEMPLATE_TABLE} LIMIT 1`); return true; }
    catch (err) { if (isMissingTable(err)) return false; throw err; }
  };
  const templateTablePresent = "EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)";
  const contentTables = withTemplates => ['messages', 'dms', 'cards', 'skills', 'docs', ...(withTemplates ? [TEMPLATE_TABLE] : [])];
  const emptyCond = withTemplates => `NOT EXISTS (SELECT 1 FROM participants WHERE id != ?) AND ${contentTables(withTemplates).map(t => `NOT EXISTS (SELECT 1 FROM ${t})`).join(' AND ')}`;
  const notEmpty = () => new ApiError(409, 'NOT_EMPTY', '只有空站能匯入：這個站已經有其他成員、訊息、卡片、技能、文件或專案範本。請在新架的站匯入。');
  const finishingError = () => new ApiError(409, 'RESTORE_FINISHING', '備份的資料已經匯入，只差收尾：請再按一次「完成匯入」（restore/finish）。');
  // restore_state 這一列：raw 是存的原字串（收尾比對「沒被別的收尾改過」用）
  const readState = async () => {
    const raw = (await db.get('SELECT value FROM app_settings WHERE key = ?', RESTORE_STATE_KEY))?.value;
    try { return raw ? { raw, st: JSON.parse(raw) } : null; } catch { return null; }
  };
  const restoring = async () => (await readState().catch(() => null))?.st || null;
  // 預設專案與預設設定不算資料；不論是否停用，已儲存的範本都算。只查有沒有，不數全部。
  async function isEmpty(me, withTemplates) {
    if (withTemplates === undefined) withTemplates = await templatesReady();
    return !!(await db.get(`SELECT 1 AS x WHERE ${emptyCond(withTemplates)}`, me.id));
  }
  const fileFilter = (t, withFiles) => (t === 'file_chunks' && !withFiles ? " WHERE file_id LIKE 'skillpack\\_%' ESCAPE '\\'" : ''); // 不含附件時，技能包還是要帶
  const settingOk = r => !skipSetting(r.key);

  // 管理頁打開「系統」時看的：能不能匯入（空站）、是不是匯入到一半
  route('GET', '/api/admin/backup/status', async ({ ctx, me }) => {
    const st = await restoring();
    if (st && holder(st) === me.id) return { empty: true, restoring: true, finishing: !!st.you }; // finishing：資料已匯入、登入已轉移，只差收尾
    await adminOnly(ctx, me);
    return { empty: await isEmpty(me), restoring: !!st };
  });
  // ---------- 匯出 ----------
  // 先拿清單（每張表幾列、要不要帶附件），網頁再一張一張分頁拿
  route('GET', '/api/admin/backup', async ({ ctx, me, url }) => {
    await adminOnly(ctx, me);
    const withFiles = url.searchParams.get('files') === '1', withTemplates = await templatesReady();
    const tables = [];
    for (const t of EXPORT_TABLES) {
      if ((!withFiles && FILE_TABLES.includes(t)) || (t === TEMPLATE_TABLE && !withTemplates)) continue;
      const n = (await db.get(`SELECT COUNT(*) AS n FROM ${t}${fileFilter(t, withFiles)}`))?.n || 0;
      tables.push({ name: t, count: n });
    }
    const docs = withFiles && docStorage ? (await db.all('SELECT id FROM docs WHERE deleted_at IS NULL')).map(r => r.id) : [];
    return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, appVersion: APP_VERSION, exportedAt: nowIso(), includeFiles: withFiles, tables, docs,
      empty: await isEmpty(me, withTemplates), restoring: !!(await restoring()) };
  });
  // 一張表的一頁：照 rowid 順序；BLOB 欄位轉 { $b64 }；登入用欄位不帶
  route('GET', '/api/admin/backup/rows', async ({ ctx, me, url }) => {
    await adminOnly(ctx, me);
    const q = url.searchParams, t = q.get('table'), withFiles = q.get('files') === '1';
    if (!EXPORT_TABLES.includes(t) || (!withFiles && FILE_TABLES.includes(t))) throw invalid('table 不在可匯出的清單');
    if (t === TEMPLATE_TABLE && !(await templatesReady())) return { table: t, rows: [], next: null };
    const after = Math.max(0, Number.parseInt(q.get('after') || '0', 10) || 0), limit = pageOf(t);
    const f = fileFilter(t, withFiles);
    const rows = await db.all(`SELECT rowid AS __rowid, * FROM ${t}${f ? f + ' AND' : ' WHERE'} rowid > ? ORDER BY rowid LIMIT ?`, after, limit + 1);
    const more = rows.length > limit, page = rows.slice(0, limit);
    const drop = DROP_COLS[t] || [], blobs = BLOB_COLS[t] || [];
    const out = page.filter(r => t !== 'app_settings' || settingOk(r)).map(r => {
      const o = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === '__rowid' || drop.includes(k)) continue;
        o[k] = blobs.includes(k) && v != null ? { $b64: b64(toU8(v) || new Uint8Array(0)) } : v;
      }
      return o;
    });
    return { table: t, rows: out, next: more ? page[page.length - 1].__rowid : null };
  });
  // 專案文件本體（檔案在 R2 或本機資料夾，不在資料庫）：一次一個，回原始位元組
  route('GET', '/api/admin/backup/doc', async ({ ctx, me, url }) => {
    await adminOnly(ctx, me);
    if (!docStorage) throw new ApiError(503, 'DOCS_DISABLED', '此環境沒有專案文件區');
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw invalid('id 不對');
    const bytes = await docStorage.get(`docs/${id}`);
    if (!bytes) throw new ApiError(404, 'NOT_FOUND', '這份文件的檔案不見了');
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
  });

  // ---------- 匯入 ----------
  // 開始：確認空站與版本 → 清掉新站自動建的資料 → 把你暫時改名（避免跟備份裡的同名成員撞）
  // 中途失敗可以再按一次（有 restore_state 時允許重來，會再清一次）
  route('POST', '/api/admin/restore/begin', async ({ ctx, me, req }) => {
    const cur = await readState().catch(() => null), state = cur?.st || null;
    if (state?.you && state.you === me.id) { requireHuman(me); throw finishingError(); } // 收尾已經開始（登入已轉移）：不能從頭來，只能重試收尾
    if (state?.by === me.id) requireHuman(me); else await adminOnly(ctx, me); // 中途失敗重來：開始匯入的那位可以再按
    const body = await readJson(req);
    if (body.format !== BACKUP_FORMAT || Number(body.formatVersion) !== BACKUP_FORMAT_VERSION) throw invalid('不是這個平台的備份檔（format／formatVersion 不對）');
    if (cmpVersion(body.appVersion, APP_VERSION) > 0) throw new ApiError(400, 'BACKUP_TOO_NEW', `備份是 ${body.appVersion} 版，比這個站（${APP_VERSION}）新；請先把這個站升級到 ${body.appVersion} 以上再匯入`);
    if (String(body.appVersion).split('.')[0] !== APP_VERSION.split('.')[0]) throw new ApiError(400, 'BACKUP_MAJOR', `備份是 ${body.appVersion} 版，跟這個站（${APP_VERSION}）的主版本不同，不能直接匯入`);
    const withTemplates = await templatesReady();
    if (!state && !(await isEmpty(me, withTemplates))) throw notEmpty();
    if (state && holder(state) !== me.id) throw new ApiError(409, 'RESTORE_BY_OTHER', '別的管理員正在匯入');
    // 與範本寫入以同一列鎖排隊；範本表若剛好在部署時建好，重試前不得清掉任何資料。
    const stmts = [lockWorkspaceStmt(DEFAULT_WORKSPACE),
      ensureStmt(withTemplates ? templateTablePresent : `NOT (${templateTablePresent})`, [TEMPLATE_TABLE]),
      cur ? ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value = ?)', [RESTORE_STATE_KEY, cur.raw])
        : ensureStmt(`NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?) AND ${emptyCond(withTemplates)}`, [RESTORE_STATE_KEY, me.id]),
      ...[...EXPORT_TABLES.filter(t => !['participants', 'accounts', ...KEEP_TABLES].includes(t) && (t !== TEMPLATE_TABLE || withTemplates)), 'legacy_members'].map(t => [`DELETE FROM ${t}`, []])];
    stmts.push(['DELETE FROM accounts WHERE id NOT IN (SELECT account_id FROM participants WHERE id = ? AND account_id IS NOT NULL)', [me.id]]); // 你的帳號留著
    stmts.push(['DELETE FROM participants WHERE id != ?', [me.id]]);
    const orig = state ? { name: state.name, code: state.code } : { name: me.name, code: me.code }; // 重來時你已經是暫時的名字：用第一次記下的
    stmts.push(['UPDATE participants SET name = ?, code = ? WHERE id = ?', [`${orig.name}#匯入中${me.id.slice(-6)}`, `R${me.id.slice(-7)}`, me.id]]);
    stmts.push(["INSERT INTO app_settings (key, value) VALUES ('restore_state', ?)", [JSON.stringify({ by: me.id, at: nowIso(), name: orig.name, code: orig.code, appVersion: body.appVersion })]]);
    try { await db.batch(stmts); } catch (e) {
      if (!isAssertionFailure(e)) throw e;
      // 用新鮮資料判斷原因（只用來產生回應）
      const now = await restoring();
      if (now && holder(now) !== me.id) throw new ApiError(409, 'RESTORE_BY_OTHER', '別的管理員正在匯入');
      if (!now && !(await isEmpty(me))) throw notEmpty();
      throw new ApiError(409, 'CONFLICT', '剛好有人同時在改同樣的資料，這次沒有存；請重新讀取後再試。');
    }
    if (docStorage) for (const d of await db.all('SELECT id FROM docs')) await docStorage.delete(`docs/${d.id}`).catch(() => {}); // 上面已清表；這裡保險
    await clearCaches?.(); // 資料清空了：只清快取。成員、稽核等修整一律等收尾才做（資料還沒匯入）
    return { ok: true };
  });
  // 一批資料列：只收可匯入的表、只寫這個站有的欄位（舊版備份少的欄位用預設值）。
  // 第一階段之前的備份（成員沒有 workspace_id）：舊的 is_admin、projects 這版沒有欄位了，抄到 legacy_members，
  // 匯入完由成員資格的升級轉換（membership.migrateLegacy）轉成新表；原本的管理員先標成工作區管理員，結束匯入時才找得到他
  route('POST', '/api/admin/restore/rows', async ({ ctx, me, req }) => {
    const { raw } = await restorer(me);
    const body = await readJson(req, 6 * 1024 * 1024); // file_chunks 一列 512 KB，base64 後約 700 KB
    const t = body.table;
    if (!EXPORT_TABLES.includes(t)) throw invalid('table 不在可匯入的清單');
    if (!Array.isArray(body.rows) || body.rows.length > 1000) throw invalid('rows 要是陣列，一次最多 1000 列');
    if (t === TEMPLATE_TABLE && !(await templatesReady())) {
      if (body.rows.length) throw templateNotReady(ApiError);
      return { table: t, inserted: 0 };
    }
    // 範本頁在一批內寫入。唯一鍵衝突時，整頁一起回滾。
    if (t === TEMPLATE_TABLE && body.rows.length > TEMPLATE_RESTORE_PAGE) throw invalid('專案範本每批最多 97 列');
    const have = new Set(await columnsOf(t)), drop = [...(DROP_COLS[t] || []), ...(t === 'audit_log' ? ['seq'] : [])], blobs = BLOB_COLS[t] || [];
    const stmts = [];
    let inserted = 0;
    for (const r of body.rows) {
      if (!r || typeof r !== 'object') throw invalid('rows 每一列要是物件');
      if (t === 'participants' && r.id === me.id) continue; // 你自己（同一個站匯回自己）：保留現在的
      if (t === 'accounts' && r.id === me.account_id) continue;
      if (t === 'app_settings' && (typeof r.key !== 'string' || skipSetting(r.key))) continue;
      const row = {};
      for (const [k, v] of Object.entries(r)) {
        if (!have.has(k) || drop.includes(k)) continue;
        row[k] = blobs.includes(k) && v && typeof v === 'object' ? unb64(String(v.$b64 || '')) : v;
      }
      if (t === 'participants') Object.assign(row, { token: 'h:rs_' + randId('t') + randId('t'), token_expires_at: 1 }); // 登入一律重發：AI 顯示「Token 已過期」請主人重發；人類的登入碼是沒人拿得到的亂數
      if (t === 'participants' && (r.workspace_id === undefined || r.workspace_id === null) && typeof r.id === 'string') {
        const admin = Number(r.is_admin) === 1 && r.kind === 'human';
        if (admin && have.has('workspace_role')) row.workspace_role = 'admin';
        stmts.push(['INSERT OR IGNORE INTO legacy_members (participant_id, is_admin, projects) VALUES (?, ?, ?)', [r.id, admin ? 1 : 0, r.projects === undefined ? '' : r.projects]]);
      }
      const problem = ROW_CHECKS[t]?.(row);
      if (problem) throw rowInvalid(t, row, problem);
      const cols = Object.keys(row);
      if (!cols.length) continue;
      inserted++;
      // 稽核紀錄跟這個站原本的合併：流水號重新編（不跟原本的撞），已經有的 id 略過（中途重來不重複）
      stmts.push([`INSERT${t === 'audit_log' ? ' OR IGNORE' : ''} INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${t === 'app_settings' ? ' ON CONFLICT(key) DO UPDATE SET value = excluded.value' : ''}`, cols.map(c => row[c])]);
    }
    // 每一批在交易內確認還在匯入（restore_state 還是這次讀到的）。收尾開始後才到的資料列不寫。
    for (let i = 0; i < stmts.length; i += 100) {
      try { await db.batch([...samePhaseStmts(raw), ...stmts.slice(i, i + 100)]); } catch (e) {
        if (isAssertionFailure(e)) throw (await restoring())?.you ? finishingError() : notRestoring();
        if (ROW_CHECKS[t] && isConstraintViolation(e)) throw rowInvalid(t, null, ROW_INVALID_MSG.constraint);
        throw e;
      }
    }
    return { table: t, inserted };
  });
  function rowInvalid(t, row, problem) {
    const which = row && typeof row.id === 'string' ? ROW_INVALID_MSG.which.replace('{0}', row.id.slice(0, 80)) : '';
    return new ApiError(400, 'BACKUP_ROW_INVALID', `備份檔的 ${t} 有不合法的資料列${which}：${problem}。這一批沒有寫入；請確認備份檔沒有被改壞。`, { table: t });
  }
  // 專案文件本體：資料表的 docs 列先匯入，才收它的檔案
  route('POST', '/api/admin/restore/doc', async ({ ctx, me, req, url }) => {
    await restorer(me);
    if (!docStorage) throw new ApiError(503, 'DOCS_DISABLED', '此環境沒有專案文件區，文件檔案沒辦法匯入');
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !(await db.get('SELECT 1 AS x FROM docs WHERE id = ?', id))) throw invalid('沒有這份文件的資料列');
    const bytes = await readBody(req, 25 * 1024 * 1024, '單一文件超過 25 MB', 'FILE_TOO_LARGE');
    await docStorage.put(`docs/${id}`, bytes);
    return { ok: true };
  });
  // 結束：備份裡的平台、工作區角色原樣帶回來（不幫任何人升級）。你的登入（密碼、裝置、登入碼、登入通知）改掛到備份裡的平台管理員身上
  // （最早加入的那位；他本來就是平台管理員，沒多給權限），刪掉暫時的你；清快取。
  // 第一階段之前的備份沒有平台角色：照升級的對應（is_admin，沒有就最早加入的啟用人類 → 平台管理員兼工作區管理員，由升級轉換寫入），登入掛到那位。
  // 備份裡找不到平台管理員（沒有人類，或都停用了）：你照舊是你，名字改回來。
  // 收尾的固定順序（每一步都要能重跑；任何一步失敗都維持「還原中」、回 503 RESTORE_UNFINISHED，再按一次從第 1 步重跑）：
  //   1. 成員與帳號轉換：登入改掛、其他人要重設登入，跟「已轉移」的記號同一批（重跑時已轉移就略過）；Postgres 接續流水號
  //   2. 收尾修整步驟 restoreSteps（依序；這時還在還原中，其他會動到共同不變量的寫入都被擋下）。
  //      每一步拿到 { state, keepStmts }：state 是目前的 restore_state（前一次收尾記下的結果也在）；keepStmts(patch) 回把 patch 記進 restore_state 的語句，
  //      放進那一步自己的那一批（跟那一步的修改一起提交或一起不做）。重試時不能從現況重算的結果（例：這次還原取消了幾份申請）就這樣跨次保留
  //   3. 寫入 backup.restore 稽核（含檢查待審申請時因還原而取消的數量），跟解除「還原中」同一批（稽核只會有一筆）
  //   4. 清快取
  route('POST', '/api/admin/restore/finish', async ({ me }) => {
    const started = await restorer(me, { finishing: true });
    let state = started.st;
    try {
      if (!state.you) state = await transferLogin(me, started);
      await db.syncIds?.(); // Postgres：匯入時明寫了流水號，自動編號要接到最大號後面（SQLite／D1 會自己接，沒有這個方法）
      for (const step of restoreSteps) {
        const cur = await readState();
        if (!cur) throw notRestoring();
        // 斷言 restore_state 沒被別的收尾改過，再寫入新的值（同時按兩次收尾：後提交的那批整批不做）
        const keepStmts = patch => [ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value = ?)', [RESTORE_STATE_KEY, cur.raw]),
          ['UPDATE app_settings SET value = ? WHERE key = ?', [JSON.stringify({ ...cur.st, ...patch }), RESTORE_STATE_KEY]]];
        if ((await step.run({ state: cur.st, keepStmts })) === false) throw new Error(`還原收尾的「${step.name}」沒有做完`);
      }
      state = (await readState())?.st || state;
      // 檢查待審申請時因還原而取消的數量：記在 restore_state（第一次收尾已取消、之後重試的不會被數成零）
      const cancelled = Number(state.cancelledProjectCreationRequests) || 0;
      const counts = new Map((await db.all("SELECT kind, COUNT(*) AS n FROM participants WHERE kind IN ('human', 'ai') GROUP BY kind")).map(r => [r.kind, Number(r.n)]));
      const humans = counts.get('human') || 0, ais = counts.get('ai') || 0;
      // 稽核紀錄在還原完才寫（備份裡的紀錄已經合併進來）；操作者是按還原的平台管理員（開始匯入時記下的身分與名字），不是登入改掛過去的那位。
      // 第一句鎖工作區這列（跟「不在還原中」的寫入排隊），再確認還在還原中（同時按兩次收尾：只有一次寫稽核）
      try {
        await db.batch([lockWorkspaceStmt(DEFAULT_WORKSPACE),
          ensureStmt('EXISTS (SELECT 1 FROM app_settings WHERE key = ?)', [RESTORE_STATE_KEY]),
          auditLog.stmt({ actor: { id: state.by, name: state.name, kind: 'human' }, action: AUDIT_ACTION.BACKUP_RESTORE, scope: AUDIT_SCOPE.PLATFORM, count: cancelled,
            detail: { appVersion: state.appVersion, humans, ais, counted: 'cancelledProjectCreationRequests' } }),
          ['DELETE FROM app_settings WHERE key = ?', [RESTORE_STATE_KEY]]].filter(Boolean));
      } catch (e) { if (isAssertionFailure(e)) throw notRestoring(); throw e; }
      await clearCaches?.().catch(e => console.error('還原完成，清快取失敗（快取過期後自然重讀）', e));
      return { ok: true, admin: state.admin, humans, ais, cancelledProjectCreationRequests: cancelled };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      console.error('還原收尾失敗（維持還原中，可以再按一次收尾）', e);
      throw new ApiError(503, 'RESTORE_UNFINISHED', '還原的收尾沒有做完，平台仍在還原中；請再按一次「完成匯入」（restore/finish）。', { retryAfter: 1 });
    }
  });
  const notRestoring = () => new ApiError(409, 'NOT_RESTORING', '沒有你開始的匯入（先按匯入，restore/begin）');
  // 收尾第 1 步：你的登入改掛到備份裡的管理員，其他人類標要重設登入；跟 restore_state 記下「已轉移」（you、admin）同一批。
  // 先鎖工作區列與 restore_state 這列，再確認它還是這次收尾開始時讀到的值（state 就是從它來的）：同時按兩次只轉一次、不蓋掉別的收尾寫的值。
  // 回記下之後的 restore_state
  async function transferLogin(me, { st: state, raw }) {
    const rows = await db.all("SELECT * FROM participants WHERE id != ? AND kind = 'human' AND status = 'active'", me.id);
    const platform = await db.get("SELECT p.id FROM participants p JOIN accounts a ON a.id = p.account_id WHERE a.platform_role = 'admin' AND a.status = 'active' AND p.kind = 'human' AND p.status = 'active' AND p.id != ? ORDER BY p.created_at, p.id", me.id);
    const legacy = rows.filter(p => p.workspace_id === null || p.workspace_id === undefined); // 還沒轉的舊成員（is_admin 已標成工作區管理員）
    const target = platform ? rows.find(p => p.id === platform.id) : legacy.length ? adminOf(new Map(legacy.map(p => [p.id, p]))) : null;
    const stmts = samePhaseStmts(raw);
    if (target) {
      for (const t of ['credentials', 'devices', 'account_notices']) stmts.push([`UPDATE ${t} SET participant_id = ? WHERE participant_id = ?`, [target.id, me.id]]);
      stmts.push(...membership.forgetStmts([me.id]), ['DELETE FROM participants WHERE id = ?', [me.id]]);
      stmts.push(['UPDATE participants SET token = ?, token_expires_at = ? WHERE id = ?', [me.token, me.token_expires_at || 0, target.id]]); // 你現在的登入碼也跟著過去（不是備份裡的）
    } else {
      const taken = await db.get('SELECT 1 AS x FROM participants WHERE name = ? AND id != ?', state.name, me.id);
      if (!taken) stmts.push(['UPDATE participants SET name = ?, code = ? WHERE id = ?', [state.name, state.code, me.id]]);
    }
    // 其他人類的登入不在備份裡：標「要重設登入」，成員頁與總覽寫出來（他用重設連結登入、或你發了重設連結就清掉）
    const you = target?.id || me.id;
    if (rows.length) stmts.push(['UPDATE participants SET last_seen_at = 0, standby_at = 0 WHERE id != ?', [you]]); // 在線、待命是舊站的狀態：這個站還沒人見過他們（不然進不來的人會顯示在線、AI 顯示待命）
    for (const p of rows) if (p.id !== you) stmts.push(["INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['relogin:' + p.id, nowIso()]]);
    const next = { ...state, you, admin: target ? { participantId: target.id, name: target.name } : { participantId: me.id, name: state.name } };
    stmts.push(['UPDATE app_settings SET value = ? WHERE key = ?', [JSON.stringify(next), RESTORE_STATE_KEY]]);
    try { await db.batch(stmts); } catch (e) {
      if (isAssertionFailure(e)) throw new ApiError(409, 'CONFLICT', '剛好有人同時在改同樣的資料，這次沒有存；請重新讀取後再試。'); // 別的收尾剛好先轉了
      throw e;
    }
    return next;
  }
}
