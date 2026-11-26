-- ADR 0007: retain participant history; review decisions have exactly one actor.
-- Rebuild the table to replace its state CHECK on SQLite, PostgreSQL and D1.
CREATE TABLE IF NOT EXISTS project_creation_requests_017 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'review',
  slug TEXT,
  code TEXT,
  statuses_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  ended_by_account_id TEXT,
  reject_reason TEXT,
  cancel_code TEXT,
  project_id TEXT,
  CHECK (visibility IN ('open', 'review', 'private')),
  CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
  CHECK (
    (state = 'pending' AND ended_at IS NULL AND ended_by IS NULL AND ended_by_account_id IS NULL AND project_id IS NULL AND reject_reason IS NULL AND cancel_code IS NULL)
    OR (state = 'approved' AND ended_at IS NOT NULL AND ((ended_by IS NULL) <> (ended_by_account_id IS NULL)) AND project_id IS NOT NULL AND reject_reason IS NULL AND cancel_code IS NULL)
    OR (state = 'rejected' AND ended_at IS NOT NULL AND ((ended_by IS NULL) <> (ended_by_account_id IS NULL)) AND project_id IS NULL AND reject_reason IS NOT NULL AND length(trim(reject_reason)) > 0 AND cancel_code IS NULL)
    OR (state = 'withdrawn' AND ended_at IS NOT NULL AND ended_by IS NOT NULL AND ended_by = requester_id AND ended_by_account_id IS NULL AND project_id IS NULL AND reject_reason IS NULL AND cancel_code IS NULL)
    OR (state = 'cancelled' AND ended_at IS NOT NULL AND ended_by IS NULL AND ended_by_account_id IS NULL AND project_id IS NULL AND reject_reason IS NULL AND cancel_code IS NOT NULL
      AND cancel_code IN ('policy_changed', 'workspace_member_removed', 'workspace_member_left', 'account_disabled', 'restore_invalid'))
  )
);
INSERT INTO project_creation_requests_017 (id, workspace_id, requester_id, request_id, name, reason, visibility, slug, code, statuses_json, state, created_at, ended_at, ended_by, reject_reason, cancel_code, project_id)
SELECT id, workspace_id, requester_id, request_id, name, reason, visibility, slug, code, statuses_json, state, created_at, ended_at, ended_by, reject_reason, cancel_code, project_id
FROM project_creation_requests;
DROP TABLE project_creation_requests;
ALTER TABLE project_creation_requests_017 RENAME TO project_creation_requests;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_request ON project_creation_requests (workspace_id, requester_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_pending_name ON project_creation_requests (workspace_id, requester_id, name) WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_project ON project_creation_requests (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcr_state ON project_creation_requests (workspace_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_pcr_requester ON project_creation_requests (workspace_id, requester_id, created_at);
ALTER TABLE audit_log ADD COLUMN actor_account_id TEXT;
