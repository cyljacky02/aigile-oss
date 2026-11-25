// 稽核紀錄（詞彙見 GLOSSARY「刪除與稽核」；決策見 docs/adr/0003）：管理操作只能新增的紀錄
// 介面（core.js 建一個 auditLog，傳給需要記錄的模組）：
//   auditLog.stmt(evt)   回一句 [sql, args]，跟資料異動放進同一個 db.batch；沒有要寫的回 null
//   auditLog.write(evt)  單獨寫一筆（就是 stmt 那一句的 db.run）
// 呼叫端把 stmt 的結果放進清單時要去掉 null（core.js 的 writeStmts 會去掉；清單空了就不呼叫 db.batch）
// 資料表還沒建立前 stmt 一律回 null（什麼都不寫）
//
// evt 的欄位：
//   actor      操作者 { id, name, kind }（傳 participant 列就行）；null＝系統
//   action     AUDIT_ACTION 其中之一
//   scope      AUDIT_SCOPE：platform／workspace／project
//   workspaceId  非平台層的事件所屬工作區；不給＝預設工作區
//   project    { id, name }：專案層的事件
//   target     對象 { kind, id, name }，kind：participant／project／message／workspace；名字在寫入時快照
//   count      摘要數字（例：清除了幾則訊息）
//   detail     細節物件（存成 JSON）；不放訊息原文
//   at         ISO 時間；不給＝現在
// 不寫的情況：沒有真的改到東西（no-op）、競態檢查擋下來（409）都不寫

// 動作（存在 action 欄位；網頁的篩選與顯示文字照這張表）
export const AUDIT_ACTION = Object.freeze({
  PLATFORM_ADMIN_GRANT: 'platform_admin.grant', PLATFORM_ADMIN_REVOKE: 'platform_admin.revoke',
  WORKSPACE_ADMIN_GRANT: 'workspace_admin.grant', WORKSPACE_ADMIN_REVOKE: 'workspace_admin.revoke',
  ACCOUNT_DISABLE: 'account.disable', ACCOUNT_ENABLE: 'account.enable',
  MEMBER_REMOVE: 'member.remove', MEMBER_LEAVE: 'member.leave',
  BACKUP_RESTORE: 'backup.restore',
  WORKSPACE_POLICY_UPDATE: 'workspace_policy.update', // detail { field: createProjects｜deleteOwnMessages, from, to }
  RECOVERY_WINDOW_UPDATE: 'recovery_window.update', // 平台或工作區；detail { from, to }
  MESSAGE_DELETE: 'message.delete', MESSAGE_RESTORE: 'message.restore', MESSAGE_PURGE: 'message.purge',
  PROJECT_MESSAGES_CLEAR: 'project_messages.clear', PROJECT_MESSAGES_RESTORE: 'project_messages.restore',
  PROJECT_DELETE: 'project.delete', PROJECT_RESTORE: 'project.restore', PROJECT_PURGE: 'project.purge', // 舊的專案刪除紀錄轉成 project.purge，detail.legacy＝true
});
export const AUDIT_SCOPE = Object.freeze({ PLATFORM: 'platform', WORKSPACE: 'workspace', PROJECT: 'project' });

// randId、nowIso：寫入時的 id 與時間（資料表建立後才會用到）
export function createAudit({ db, randId, nowIso }) {
  const stmt = evt => null;
  async function write(evt) {
    const s = stmt(evt);
    if (s) await db.run(s[0], ...s[1]);
  }
  return { stmt, write };
}
