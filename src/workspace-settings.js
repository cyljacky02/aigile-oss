// 工作區設定（GLOSSARY「成員與權限」：工作區）：第一階段只有預設工作區。
// - 誰可以建立專案（create_projects）：存在 workspaces 表的那一列
// - 開放自行註冊、房間碼：預設工作區的值存 app_settings 的 open_join（'1'／'0'）與 room_code（密碼雜湊，''＝清除），
//   沒改過才用環境變數 OPEN_JOIN／ROOM_CODE（升級的站照舊）。房間碼只存雜湊，不回傳、不寫日誌。每次從資料庫讀，多份程式也立刻生效
// 工作區名稱、AI 工具、附件保存期限還在 core.js（由工作區設定 API 一起回傳）。
// 預設值：新安裝（schema.sql）＝所有成員；升級的站（migrations/008、匯入舊備份）＝只有管理員。
// 讀：同步，看已載入的快照（10 秒快取；load(true) 重讀）。寫：回傳 [sql, args] 給呼叫端的 db.batch，執行後呼叫 load(true)。
import { DEFAULT_WORKSPACE } from './membership.js';

export const CREATE_PROJECTS = Object.freeze({ MEMBERS: 'members', ADMINS: 'admins' });

// env：{ openJoin（布林，預設開）, roomCode（原文，''＝沒設） }；hashPassword／verifyPassword：房間碼雜湊（src/password.js）
export function createWorkspaceSettings({ db, env = {}, hashPassword, verifyPassword }) {
  // 讀不到（工作區還沒建好）就當只有管理員：寧可擋，不要多放
  let snap = { createProjects: CREATE_PROJECTS.ADMINS }, at = 0;
  async function load(force = false) {
    if (!force && at && Date.now() - at < 10_000) return snap;
    const row = await db.get('SELECT create_projects FROM workspaces WHERE id = ?', DEFAULT_WORKSPACE).catch(() => null);
    snap = { createProjects: row?.create_projects === CREATE_PROJECTS.MEMBERS ? CREATE_PROJECTS.MEMBERS : CREATE_PROJECTS.ADMINS };
    at = Date.now();
    return snap;
  }
  // 一般成員可以建立專案嗎（工作區管理員永遠可以，由權限模組判斷）
  const membersCreateProjects = () => snap.createProjects === CREATE_PROJECTS.MEMBERS;
  const setCreateProjectsStmts = value => [['UPDATE workspaces SET create_projects = ? WHERE id = ?', [value, DEFAULT_WORKSPACE]]];

  // ---------- 自行加入：開放自行註冊、房間碼 ----------
  const OPEN_JOIN = env.openJoin !== false, ROOM_CODE = String(env.roomCode || '');
  // { openJoin, roomCodeSet, checkRoomCode(code), source: { openJoin, roomCode: 'web'｜'env' } }（不快取：自行註冊不常發生）
  async function joinRules() {
    const m = Object.fromEntries((await db.all("SELECT key, value FROM app_settings WHERE key IN ('open_join', 'room_code')").catch(() => [])).map(r => [r.key, r.value]));
    const webOpen = 'open_join' in m, webCode = 'room_code' in m;
    return {
      openJoin: webOpen ? m.open_join === '1' : OPEN_JOIN,
      roomCodeSet: webCode ? !!m.room_code : !!ROOM_CODE,
      checkRoomCode: async code => webCode ? (!m.room_code || await verifyPassword(String(code ?? ''), m.room_code)) : (!ROOM_CODE || code === ROOM_CODE),
      source: { openJoin: webOpen ? 'web' : 'env', roomCode: webCode ? 'web' : 'env' },
    };
  }
  const upsert = 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  const setOpenJoinStmts = on => [[upsert, ['open_join', on ? '1' : '0']]];
  // code：''＝清除（之後不用房間碼，也不再看環境變數）
  const setRoomCodeStmts = async code => [[upsert, ['room_code', code ? await hashPassword(code) : '']]];

  return { load, membersCreateProjects, setCreateProjectsStmts, joinRules, setOpenJoinStmts, setRoomCodeStmts, invalidate: () => { at = 0; } };
}
