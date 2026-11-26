-- 專案識別碼的全站保留表。由應用程式與舊設定一併正規化（ADR 0006）。
CREATE TABLE IF NOT EXISTS project_identity_claims (
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, value),
  CHECK ((namespace = 'slug' AND value = lower(value)) OR (namespace = 'code' AND value = upper(value)))
);
-- 保留每種來源。一個代號可以同時是同一專案的現行代號、舊代號；也可能有多個專案宣稱。
-- 舊代號即使找不到對應的專案也保留，因此 project_id 不設專案外鍵。
CREATE TABLE IF NOT EXISTS project_identity_claimants (
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  PRIMARY KEY (namespace, value, project_id, source, raw_value),
  FOREIGN KEY (namespace, value) REFERENCES project_identity_claims (namespace, value),
  CHECK ((namespace = 'slug' AND source IN ('slug', 'project_id'))
    OR (namespace = 'code' AND source IN ('current_code', 'historical_code')))
);
