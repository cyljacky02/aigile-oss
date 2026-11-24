// 工作區設定（GLOSSARY「成員與權限」：工作區）：存在 workspaces 表的那一列（第一階段只有預設工作區）。
// 目前只有「誰可以建立專案」（create_projects）；工作區名稱、開放加入、房間碼、AI 工具、附件保存期限還在 app_settings，
// 由 core.js 的工作區設定 API 一起回傳（#14 再搬開放加入與房間碼）。
// 預設值：新安裝（schema.sql）＝所有成員；升級的站（migrations/008、匯入舊備份）＝只有管理員。
// 讀：同步，看已載入的快照（10 秒快取；load(true) 重讀）。寫：回傳 [sql, args] 給呼叫端的 db.batch，執行後呼叫 load(true)。
import { DEFAULT_WORKSPACE } from './membership.js';

export const CREATE_PROJECTS = Object.freeze({ MEMBERS: 'members', ADMINS: 'admins' });

export function createWorkspaceSettings({ db }) {
  // 讀不到（工作區還沒建好）就當只有管理員：寧可擋，不要多放
  let snap = { createProjects: CREATE_PROJECTS.ADMINS }, at = 0;
  async function load(force = false) {
    if (!force && at && Date.now() - at < 10_000) return snap;
    const row = await db.get('SELECT create_projects FROM workspaces WHERE id = ?', DEFAULT_WORKSPACE).catch(() => null);
    snap = { createProjects: row?.create_projects === CREATE_PROJECTS.MEMBERS ? CREATE_PROJECTS.MEMBERS : CREATE_PROJECTS.ADMINS };
    at = Date.now();
    return snap;
  }
  const current = () => ({ ...snap });
  // 一般成員可以建立專案嗎（工作區管理員永遠可以，由權限模組判斷）
  const membersCreateProjects = () => snap.createProjects === CREATE_PROJECTS.MEMBERS;
  const setCreateProjectsStmts = value => [['UPDATE workspaces SET create_projects = ? WHERE id = ?', [value, DEFAULT_WORKSPACE]]];
  return { load, current, membersCreateProjects, setCreateProjectsStmts, invalidate: () => { at = 0; } };
}
