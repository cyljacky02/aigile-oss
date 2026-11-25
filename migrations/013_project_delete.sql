-- 刪除專案先進入可復原期（docs/adr/0003）：期滿才由排程永久清除，期間工作區管理員可以復原
-- deleted_at 刪除時間（ISO）、deleted_by 刪除者、purge_at 預計永久清除時間（epoch 毫秒，刪除當下決定）、
-- paused_ais 刪除時暫停的 AI（JSON 陣列，復原時恢復）
-- 只加不刪：舊版程式不讀這幾欄，照常能跑
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_by TEXT;
ALTER TABLE projects ADD COLUMN purge_at INTEGER;
ALTER TABLE projects ADD COLUMN paused_ais TEXT;
