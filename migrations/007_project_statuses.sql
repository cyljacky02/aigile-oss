-- 每個專案自訂看板狀態（docs/adr/0001）：
-- cards.status 照舊存狀態類別；新增 cards.status_id 指向專案自訂的狀態。
-- 既有專案的預設狀態組與卡片的 status_id 由程式第一次讀狀態時補上（SQLite、D1、Postgres 同一套）
CREATE TABLE IF NOT EXISTS project_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_statuses_name ON project_statuses (project, name);
ALTER TABLE cards ADD COLUMN status_id INTEGER;
