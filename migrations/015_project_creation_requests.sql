-- 建立專案申請（docs/adr/0004；GLOSSARY「成員與權限」）：一般成員在「成員申請，管理員核准」（approval）政策下送出，審核人核准後才建立專案。
-- 申請不是專案：核准前專案不存在。內容送出後不可修改；只有 pending 可以轉換，四種終止狀態不可逆。
-- 狀態與欄位的一致性由 CHECK 保證（條件明確處理 NULL）；冪等、同名待審由唯一與部分唯一索引保證（不靠程式先查）。
-- 只加新表與索引，舊版程式照常能跑。不設外鍵：專案永久清除、成員移出或帳號停用都不得連帶刪除申請歷史
CREATE TABLE IF NOT EXISTS project_creation_requests (
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
  reject_reason TEXT,
  cancel_code TEXT,
  project_id TEXT,
  CHECK (visibility IN ('open', 'review', 'private')),
  CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
  CHECK (
    (state = 'pending' AND ended_at IS NULL AND ended_by IS NULL AND project_id IS NULL AND reject_reason IS NULL AND cancel_code IS NULL)
    OR (state = 'approved' AND ended_at IS NOT NULL AND ended_by IS NOT NULL AND project_id IS NOT NULL AND reject_reason IS NULL AND cancel_code IS NULL)
    OR (state = 'rejected' AND ended_at IS NOT NULL AND ended_by IS NOT NULL AND project_id IS NULL AND reject_reason IS NOT NULL AND length(trim(reject_reason)) > 0 AND cancel_code IS NULL)
    OR (state = 'withdrawn' AND ended_at IS NOT NULL AND ended_by IS NOT NULL AND ended_by = requester_id AND project_id IS NULL AND reject_reason IS NULL AND cancel_code IS NULL)
    OR (state = 'cancelled' AND ended_at IS NOT NULL AND ended_by IS NULL AND project_id IS NULL AND reject_reason IS NULL AND cancel_code IS NOT NULL
      AND cancel_code IN ('policy_changed', 'workspace_member_removed', 'workspace_member_left', 'account_disabled', 'restore_invalid'))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_request ON project_creation_requests (workspace_id, requester_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_pending_name ON project_creation_requests (workspace_id, requester_id, name) WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_project ON project_creation_requests (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcr_state ON project_creation_requests (workspace_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_pcr_requester ON project_creation_requests (workspace_id, requester_id, created_at);
