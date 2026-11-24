-- 成員與權限：平台 > 工作區 > 專案（docs/adr/0002，第一階段只有一個預設工作區）。
-- 只建表與欄位；舊資料（participants.projects 逗號字串、app_settings 的 project_leaders／read_only、is_admin、停用、已刪除）
-- 由程式啟動時轉進新表（src/membership.js 的 migrateLegacy），SQLite、D1、Postgres 同一套。
-- 預設工作區在這裡先建：升級的站「誰可以建立專案」＝只有管理員；新站由 schema.sql 建（所有成員）
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  create_projects TEXT NOT NULL DEFAULT 'members',
  created_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO workspaces (id, name, create_projects) VALUES ('default', '', 'admins');
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform_role TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_participant ON project_members (participant_id);
ALTER TABLE participants ADD COLUMN account_id TEXT;
ALTER TABLE participants ADD COLUMN workspace_id TEXT;
ALTER TABLE participants ADD COLUMN workspace_role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE participants ADD COLUMN workspace_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN workspace_id TEXT;
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'review';
