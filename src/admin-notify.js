// 管理員異動通知：管理權有變動（任免管理員、停用與恢復帳號，之後還有清空專案訊息、刪除專案）時，
// 寫進相關管理員的帳號提醒（account_notices；讀取端 GET /api/me/notices 在 src/login.js）
// 介面（core.js 建一個 adminNotify）：
//   await adminNotify.stmts(n)  回 [[sql, args], ...]，跟稽核紀錄放進同一個 db.batch；沒有要寫的回 []
// n 的欄位：
//   ctx       這次請求的 ctx（要讀成員資料時用）
//   scope     'platform'＝所有平台管理員；'workspace'＝該工作區所有工作區管理員
//   except    不通知的人（操作者本人：except: me.id）
//   include   另外要通知的人（例：剛被降級、已經不是管理員的人）
//   kind      ADMIN_NOTICE 其中之一（都以 admin_ 開頭，網頁用同一段顯示）
//   detail    細節物件 { a: 操作者名字, t: 對象名字, p?: 專案名字 }；網頁照語言組成句子，時間看通知的 createdAt
// 沒有真的改到東西、競態檢查擋下來（409）時不通知
// 目前還沒有收件人：一律回 []

export const ADMIN_NOTICE = Object.freeze({
  PLATFORM_GRANT: 'admin_platform_grant', PLATFORM_REVOKE: 'admin_platform_revoke',
  WORKSPACE_GRANT: 'admin_workspace_grant', WORKSPACE_REVOKE: 'admin_workspace_revoke',
  ACCOUNT_DISABLE: 'admin_account_disable', ACCOUNT_ENABLE: 'admin_account_enable',
  PROJECT_MESSAGES_CLEAR: 'admin_project_messages_clear', PROJECT_MESSAGES_RESTORE: 'admin_project_messages_restore',
  PROJECT_DELETE: 'admin_project_delete', PROJECT_RESTORE: 'admin_project_restore',
});
export const NOTIFY_SCOPE = Object.freeze({ PLATFORM: 'platform', WORKSPACE: 'workspace' });

// db、randId：寫 account_notices；peopleMap、access：找出該層的管理員
export function createAdminNotify({ db, randId, peopleMap, access }) {
  async function stmts(n) {
    return [];
  }
  return { stmts };
}
