// 管理員異動通知：管理權有變動（任免管理員、停用與恢復帳號，之後還有清空專案訊息、刪除專案）時，
// 寫進相關管理員的帳號提醒（account_notices；讀取端 GET /api/me/notices 在 src/login.js）
// 介面（core.js 建一個 adminNotify）：
//   await adminNotify.stmts(n)  回 [[sql, args], ...]，跟稽核紀錄放進同一個 db.batch；沒有要寫的回 []
// n 的欄位：
//   ctx       這次請求的 ctx（收件人不看它快取的成員資料，一律重讀改完之後的）
//   scope     'platform'＝所有平台管理員；'workspace'＝該工作區所有工作區管理員
//   except    不通知的人（操作者本人：except: me.id）
//   include   另外要通知的人（例：剛被降級、已經不是管理員的人）
//   kind      ADMIN_NOTICE 其中之一（都以 admin_ 開頭，網頁用同一段顯示）
//   detail    細節物件 { a: 操作者名字, t: 對象名字, p?: 專案名字 }；網頁照語言組成句子，時間看通知的 createdAt
// 沒有真的改到東西、競態檢查擋下來（409）時不通知
// 收件人照「改完之後」的成員資料算：平台＝啟用中的平台管理員；工作區＝明確的工作區管理員（只有平台管理員的隱含權限不算）
// include 的人只收人類；停用中的管理員不收（他也登入不了）

export const ADMIN_NOTICE = Object.freeze({
  PLATFORM_GRANT: 'admin_platform_grant', PLATFORM_REVOKE: 'admin_platform_revoke',
  WORKSPACE_GRANT: 'admin_workspace_grant', WORKSPACE_REVOKE: 'admin_workspace_revoke',
  ACCOUNT_DISABLE: 'admin_account_disable', ACCOUNT_ENABLE: 'admin_account_enable',
  PROJECT_MESSAGES_CLEAR: 'admin_project_messages_clear', PROJECT_MESSAGES_RESTORE: 'admin_project_messages_restore',
  PROJECT_TEMPLATE_CREATE: 'admin_project_template_create', PROJECT_TEMPLATE_EDIT: 'admin_project_template_edit', PROJECT_TEMPLATE_RETIRE: 'admin_project_template_retire',
  PROJECT_DELETE: 'admin_project_delete', PROJECT_RESTORE: 'admin_project_restore',
});
export const NOTIFY_SCOPE = Object.freeze({ PLATFORM: 'platform', WORKSPACE: 'workspace' });

// db、randId：寫 account_notices；peopleMap、access：找出該層的管理員
export function createAdminNotify({ db, randId, peopleMap, access }) {
  const MAX = 200; // account_notices.detail 的長度上限（跟其他帳號提醒一樣）
  // 細節存 JSON；名字太長就截短，整串不超過 MAX
  function encode(detail = {}) {
    const keys = Object.keys(detail).filter(k => detail[k] != null);
    for (let cap = 80; cap > 0; cap -= 10) {
      const s = JSON.stringify(Object.fromEntries(keys.map(k => [k, String(detail[k]).slice(0, cap)])));
      if (s.length <= MAX) return s;
    }
    return '{}';
  }
  async function stmts(n) {
    // 呼叫端剛改完資料（已清快取）：用新的 ctx 重讀成員，不用這次請求一開始讀到的舊資料
    const people = await peopleMap({});
    const v = access.view({ people });
    const admins = n.scope === NOTIFY_SCOPE.PLATFORM ? v.platformAdmins() : v.admins();
    const ids = new Set([...admins.map(p => p.id), ...(n.include || []).filter(id => people.get(id)?.kind === 'human')]);
    for (const id of [].concat(n.except ?? [])) ids.delete(id);
    const detail = encode(n.detail), at = Date.now();
    return [...ids].map(pid => ['INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,?,?,?)', [randId('ntc'), pid, n.kind, detail, at]]);
  }
  // 適用於批次已鎖該工作區、且操作本身不改管理權的情況。收件人以交易內的成員資格為準。
  const workspaceStmt = ({ workspaceId, except, kind, detail, at = Date.now() }) => [
    `INSERT INTO account_notices (id, participant_id, kind, detail, created_at)
      SELECT ? || p.id, p.id, ?, ?, ? FROM participants p
      WHERE p.workspace_id = ? AND p.workspace_status = 'active' AND p.workspace_role = 'admin' AND p.kind = 'human' AND p.status = 'active' AND p.id != ?
        AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.status != 'active')`,
    [`${randId('ntc')}_`, kind, encode(detail), at, workspaceId, except],
  ];
  return { stmts, workspaceStmt };
}
