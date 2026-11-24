-- 成員與權限第一階段收尾（docs/adr/0002）：拿掉舊的單一管理員欄位（is_admin）、逗號字串的專案歸屬（participants.projects），
-- 以及設定裡的負責人、唯讀、跨專案角色（app_settings 的 project_leaders、read_only、cross_roles）。
-- 從第一階段之前直接升級的站，成員還沒轉到新表（workspace_id 是空的）：先把他們的 is_admin、projects 抄到 legacy_members，
-- 程式啟動後第一個請求的補資料（src/membership.js 的 migrateLegacy）從那裡轉進新表，轉完刪掉那些列與舊設定。
-- 每個人都轉過的站（跑過 008 之後的版本）舊設定在這裡直接刪。
CREATE TABLE IF NOT EXISTS legacy_members (
  participant_id TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0,
  projects TEXT
);
INSERT OR IGNORE INTO legacy_members (participant_id, is_admin, projects) SELECT id, is_admin, projects FROM participants WHERE workspace_id IS NULL;
DELETE FROM app_settings WHERE key IN ('project_leaders', 'read_only', 'cross_roles') AND NOT EXISTS (SELECT 1 FROM participants WHERE workspace_id IS NULL);
ALTER TABLE participants DROP COLUMN is_admin;
ALTER TABLE participants DROP COLUMN projects;
