-- 專案範本是工作區的本機預設值，不是專案或建立專案申請的依賴。
CREATE TABLE IF NOT EXISTS project_templates (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  visibility TEXT NOT NULL CHECK (visibility IN ('open', 'review', 'private')),
  statuses_json TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_project_templates_active ON project_templates (workspace_id, name, id) WHERE retired_at IS NULL;
