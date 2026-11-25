-- 稽核紀錄（docs/adr/0003）：管理與破壞性操作只能新增的紀錄；平台層，專案永久清除後仍保留，不存訊息原文
-- 只加新表與索引，舊版程式照常能跑。舊的專案刪除紀錄（app_settings 的 pdel: 鍵）由程式啟動後轉進來
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'human',
  action TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  workspace_id TEXT,
  project_id TEXT,
  project_name TEXT,
  target_kind TEXT,
  target_id TEXT,
  target_name TEXT,
  count INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log (workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor_id, seq);
