-- Aigile-Switch 資料表（本機 node:sqlite 與 Cloudflare D1 共用）
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- human | ai
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT '',
  role_key TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,               -- 顯示用短代碼，如 TG57
  owner_id TEXT,                           -- AI 所屬的人類
  duties TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  autonomy TEXT NOT NULL DEFAULT '',
  must_confirm TEXT NOT NULL DEFAULT '',
  handoff TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',         -- 頭像文字（空白＝自動：AI 角色代碼、人類名字首字）
  avatar_v INTEGER NOT NULL DEFAULT 0,     -- 頭像圖片版本（0＝沒有圖片；圖片存在 avatars）
  token TEXT NOT NULL UNIQUE,              -- 登入碼／AI Token 的雜湊（h: 開頭）；原文只在產生當下給一次
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active | disabled（停用，可恢復）| deleted
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  standby_at INTEGER NOT NULL DEFAULT 0,  -- watcher 最近一次待命心跳
  wake_day TEXT NOT NULL DEFAULT '',       -- 叫醒次數算到哪一天（台灣日期 YYYY-MM-DD；migrations/002）
  wake_count INTEGER NOT NULL DEFAULT 0,   -- wake_day 那天叫醒幾次
  wake_at INTEGER NOT NULL DEFAULT 0,      -- 最近一次叫醒（0＝從沒回報過）
  account_id TEXT,                         -- 人類的帳號（accounts.id）；AI 沒有（migrations/008）
  workspace_id TEXT,                       -- 所屬工作區；空的＝舊資料還沒轉換（啟動時補）
  workspace_role TEXT NOT NULL DEFAULT 'member', -- admin（工作區管理員）| member
  workspace_status TEXT NOT NULL DEFAULT 'active' -- active | removed（已移出工作區）
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  request_id TEXT,
  audience TEXT,
  payload_hash TEXT,
  file_id TEXT,                            -- 附帶的上傳文件
  reply_from TEXT,                         -- 要回覆的人（JSON 陣列，收件人子集合）；NULL＝沒標
  project TEXT,                            -- 所屬專案（原本只靠 migration 0012 補，新站會少）
  created_at TEXT NOT NULL,
  deleted_at TEXT,                         -- 刪除時間（ISO；佔位留著；migrations/012）
  deleted_by TEXT,                         -- 刪除者 participantId（migrations/012）
  purge_at TEXT,                           -- 預計永久清除時間（ISO，刪除當下依可復原期決定；migrations/012）
  clear_id TEXT,                           -- 所屬的清空專案訊息操作（單獨刪除為空；migrations/012）
  purged_at TEXT,                          -- 永久清除時間（ISO；內文與附件已清掉；migrations/012）
  UNIQUE (author_id, request_id)
);
-- 私訊自己的 AI：只有人類與他名下的 AI 兩方；不進群組訊息
CREATE TABLE IF NOT EXISTS dms (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  human_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  text TEXT NOT NULL,
  project TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_dms_pair ON dms (human_id, ai_id, seq);
CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  PRIMARY KEY (message_id, participant_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reasons TEXT NOT NULL,                   -- JSON 陣列：mention | reply | all
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | acked
  created_at TEXT NOT NULL,
  acked_at TEXT,
  UNIQUE (recipient_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications (recipient_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_participants_seen ON participants (last_seen_at); -- 在線狀態只讀最近有活動的人
-- 上傳文件（需求 v1.1，方案 B）：中繼資料
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  declared INTEGER NOT NULL,               -- 上傳者已聲明不含程式碼與客戶個資
  message_id TEXT,                         -- 自動發出的群組訊息
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,             -- 毫秒；超過即視為不存在並由排程清除
  deleted_at TEXT,
  deleted_by TEXT                          -- participantId，或 system（到期清除）
);
CREATE INDEX IF NOT EXISTS idx_files_active ON files (deleted_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_files_message ON files (message_id); -- 一則訊息多個檔
-- 稽核：上傳、下載、刪除、拒絕、到期清除
CREATE TABLE IF NOT EXISTS file_audit (
  id TEXT PRIMARY KEY,
  file_id TEXT,
  action TEXT NOT NULL,                    -- upload | download | delete | reject | expire
  actor_id TEXT,
  actor_kind TEXT,                         -- human | ai | system
  at TEXT NOT NULL,
  name TEXT,
  size INTEGER,
  sha256 TEXT,
  declared INTEGER,
  detail TEXT                              -- 拒絕原因等
);
CREATE INDEX IF NOT EXISTS idx_file_audit_at ON file_audit (at);
-- 檔案本體（分塊，每塊 ≤ 512 KB；D1 單筆上限約 2 MB）
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_participants_owner ON participants (owner_id);
-- AI 產的頭像提案：只在私訊顯示，被產圖的人類按「套用」才換；24 小時沒按作廢、圖刪掉
CREATE TABLE IF NOT EXISTS avatar_proposals (
  id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  dm_id TEXT,
  mime TEXT,
  data BLOB,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_avprop_status ON avatar_proposals (status, created_at);
-- 頭像圖片（256×256，網頁裁切後上傳；不會過期）。participant_id 為 prev:<id> 的列＝套用提案前的上一張
CREATE TABLE IF NOT EXISTS avatars (
  participant_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- 查詢效能索引（降低 D1 讀取量）
CREATE INDEX IF NOT EXISTS idx_notif_status_created ON notifications (status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_project_seq ON messages (project, seq);
CREATE INDEX IF NOT EXISTS idx_messages_purge ON messages (purge_at); -- migrations/012

-- 「等你決定」清單：人類按「已處理」的紀錄
CREATE TABLE IF NOT EXISTS decision_resolutions (
  message_id TEXT PRIMARY KEY,
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
-- 工作卡片（第一階段）：顯示編號 C-(seq+100)
CREATE TABLE IF NOT EXISTS cards (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT '工作',
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT '待整理',
  next TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',
  wait_for_id TEXT,
  criteria TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  request_id TEXT,
  done_by TEXT, done_at TEXT,
  verified_by TEXT, verified_at TEXT,
  decider_id TEXT, proposer_id TEXT,        -- 決策卡片：指定決策者、提案人
  question TEXT NOT NULL DEFAULT '', recommendation TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '',         -- 選項，JSON 陣列
  impact TEXT NOT NULL DEFAULT '', after_next TEXT NOT NULL DEFAULT '',
  decision_result TEXT, decision_by TEXT, decision_at TEXT, decision_note TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',    -- 所屬專案（寫入時一定帶）
  proj_no INTEGER,                         -- 專案內連號（顯示 MAIN-12）
  status_id INTEGER,                       -- 自訂狀態（project_statuses.id）；status 存的是狀態類別，見 docs/adr/0001
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards (updated_at);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_proj_no ON cards (project, proj_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_request ON cards (created_by, request_id);
-- 專案看板狀態：各專案自訂的看板欄；category 是系統固定的狀態類別（流程規則只看類別）
CREATE TABLE IF NOT EXISTS project_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_statuses_name ON project_statuses (project, name);
CREATE TABLE IF NOT EXISTS card_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  by_id TEXT NOT NULL,
  via TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_log_card ON card_log (card_seq, id);
CREATE TABLE IF NOT EXISTS card_msgs (
  card_seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (card_seq, message_id)
);
-- AI 建議（第三階段）：AI 想改別人的卡片或替別人建卡片時，只能提建議，由人類採用或略過
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- create | status
  from_id TEXT NOT NULL,
  card_seq INTEGER,                   -- status 建議針對的卡片
  payload TEXT NOT NULL,              -- JSON：create 的卡片欄位，或 status 的 { to, waitForId }
  basis_message_id TEXT,
  why TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | skipped
  created_at TEXT NOT NULL,
  resolved_by TEXT, resolved_at TEXT, result_card_seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_state ON suggestions (state, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_request ON suggestions (from_id, request_id);

-- AI 工作記憶：每個 AI 一列，JSON 文字，內容相同就不重寫
CREATE TABLE IF NOT EXISTS ai_state (
  participant_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 專案清單：id 沿用既有專案名稱，改名只改 name
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT,                   -- 所屬工作區（migrations/008）
  visibility TEXT NOT NULL DEFAULT 'review', -- 專案可見度：open（開放，工作區成員直接加入）| review（審核，申請後核准；預設）| private（私人，只有專案成員與有隱含權限的人看得到）
  deleted_at TEXT,                     -- 刪除時間（ISO）；有值＝在可復原期，只有工作區管理員看得到（migrations/013）
  deleted_by TEXT,                     -- 刪除者 participant id（migrations/013）
  purge_at INTEGER,                    -- 預計永久清除時間（epoch 毫秒，刪除當下決定；migrations/013）
  paused_ais TEXT,                     -- 刪除時暫停的 AI id（JSON 陣列；participants.status 改 paused，復原時恢復 active；migrations/013）
  created_by TEXT,
  created_at TEXT NOT NULL
);
-- 新站不帶專案；第一次啟動時自動建「預設專案」
-- 專案異動紀錄：建立、改名、封存、還原、成員加入／移除
CREATE TABLE IF NOT EXISTS project_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_events ON project_events (project_id, id);
-- 系統設定。isolation_since＝隔離起算時間，之前的舊訊息兩邊都看得到（當跨專案頻道）
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('isolation_since', '1970-01-01T00:00:00.000Z');

-- 新登入：邀請連結、裝置、6 位數配對碼
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,         -- 裝置登入（dv_ 開頭）的 SHA-256，不存原文
  label TEXT NOT NULL DEFAULT '',          -- 瀏覽器 · 系統
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,             -- 使用中自動展延
  reauth_at INTEGER,                       -- 最近一次在這台再驗證身分（敏感操作 10 分鐘內有效）
  revoked_at INTEGER                       -- 登出這台／重設登入
);
CREATE INDEX IF NOT EXISTS idx_devices_participant ON devices (participant_id);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,         -- 邀請連結的 SHA-256；重新產生時換掉
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  projects TEXT NOT NULL DEFAULT '',
  participant_id TEXT,                     -- 有值＝重設登入（給既有成員）
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- 15 分鐘
  used_at INTEGER,
  used_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_created ON invites (created_at);
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,                   -- 6 位數字，5 分鐘、一次性
  participant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- 帳號密碼登入（只存加鹽慢雜湊）、同帳號輸錯鎖定、主機救援連結、只給本人看的安全通知
CREATE TABLE IF NOT EXISTS credentials (
  participant_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,           -- 小寫；全群組不重複
  pwd_hash TEXT NOT NULL,                  -- pbkdf2-sha256$次數$鹽$雜湊
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_fails (
  username TEXT PRIMARY KEY,               -- 不存在的帳號也記，鎖不鎖不透露帳號有沒有人用
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rescue_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,         -- 只能由主機上的 npm run admin-rescue 產生
  participant_id TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',     -- 主機使用者@主機名稱
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- 15 分鐘
  used_at INTEGER,
  used_device TEXT
);
CREATE TABLE IF NOT EXISTS account_notices (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- password_login／rescue_login／rescue_link
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_account_notices ON account_notices (participant_id, created_at);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,                 -- sk_xxx，一個版本一列
  project TEXT NOT NULL,
  name TEXT NOT NULL,                  -- 技能名稱＝資料夾名（小寫英數與 -）
  version INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL,                 -- JSON [{ path, text }]
  sha256 TEXT NOT NULL,                -- 整包雜湊（依路徑排序的 [路徑, 內容]）
  size INTEGER NOT NULL,
  has_scripts INTEGER NOT NULL DEFAULT 0,  -- 腳本檔數
  roles TEXT NOT NULL DEFAULT '[]',    -- 給哪些角色的 AI（JSON，空＝全部）
  status TEXT NOT NULL,                -- pending | published | rejected | superseded | removed
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_version ON skills (project, name, version); -- 版本號唯一（取代 idx_skills_project）
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills (status, project);
CREATE TABLE IF NOT EXISTS skill_allows (
  ai_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,              -- 允許的是「這一版」，新版要重新允許
  by_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (ai_id, skill_id)
);
CREATE TABLE IF NOT EXISTS skill_installs (
  ai_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,              -- AI 同步後回報裝了哪一版（技能庫的「已裝」）
  at TEXT NOT NULL,
  place TEXT,                          -- own＝自己的代號資料夾、shared＝共用區；舊腳本不回報＝NULL
  PRIMARY KEY (ai_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_installs_skill ON skill_installs (skill_id);
-- 技能同步進度：每隻 AI 一列
CREATE TABLE IF NOT EXISTS skill_syncs (
  ai_id TEXT PRIMARY KEY,
  requested_at TEXT,                   -- 主人按同步
  requested_by TEXT,
  started_at TEXT,                     -- 同步工具開始（腳本回報）
  finished_at TEXT,                    -- 結束：ok 1 成功、0 失敗（last_line＝失敗的最後一行）
  ok INTEGER,
  last_line TEXT,
  tool TEXT,                           -- claude／codex／other（叫醒私訊帶 --tool）
  setup_sha TEXT                       -- 同步工具 aigile-setup.mjs 的 SHA-256（跟平台不同＝太舊）
);

-- 申請加入專案
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reason TEXT NOT NULL DEFAULT '',          -- 拒絕原因（給申請人看）
  role TEXT NOT NULL DEFAULT '',            -- 核准時選的角色
  read_only INTEGER NOT NULL DEFAULT 0,     -- 核准時選唯讀
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_pending ON join_requests (project, participant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_status ON join_requests (status, project);
CREATE INDEX IF NOT EXISTS idx_join_person ON join_requests (participant_id, created_at);
-- 專案文件區：本體存 R2（本機用資料夾），這裡是目錄與中繼資料；資料夾最多兩層，刪除只標記
CREATE TABLE IF NOT EXISTS doc_folders (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  parent_id TEXT,                      -- 空＝第一層
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_folders ON doc_folders (project, deleted_at);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  folder_id TEXT,                      -- 空＝放在最上層
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  kb_status TEXT,                      -- 抽字狀態：pending／indexed／original／secret／failed／full；空＝舊文件還沒建索引
  kb_chunks INTEGER NOT NULL DEFAULT 0,
  kb_chars INTEGER NOT NULL DEFAULT 0,
  kb_truncated INTEGER NOT NULL DEFAULT 0,
  kb_at TEXT,
  kb_org TEXT,                         -- 整理排程：todo＝排在整理卡裡、還沒寫頁
  kb_card INTEGER,                     -- 哪張整理卡（cards.seq）
  in_kb INTEGER NOT NULL DEFAULT 0     -- 1＝放進知識庫（抽字、整理、被搜）；0＝一般專案文件，只存原檔
);
CREATE INDEX IF NOT EXISTS idx_docs ON docs (project, deleted_at);
-- 知識庫底層：文件抽出來的純文字分段（可重建）。每段約 1,000～2,000 字
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,                 -- kbc_xxx
  project TEXT NOT NULL,
  doc_id TEXT NOT NULL,                -- docs.id
  idx INTEGER NOT NULL,                -- 同一份文件的段落序號 0,1,2…
  section TEXT NOT NULL DEFAULT '',    -- 標題路徑，例如「出貨流程 > 異常處理」「投影片第 3 頁」「工作表：代碼表」
  content TEXT NOT NULL,
  doc_sha256 TEXT NOT NULL,            -- 抽字時的文件雜湊
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks ON kb_chunks (project, doc_id, idx);
-- 知識頁：AI 寫的 Markdown（每份文件一頁 source、跨文件主題 topic）。不需核准：status 只用 published／stale
CREATE TABLE IF NOT EXISTS kb_pages (
  id TEXT PRIMARY KEY,                 -- kbp_xxx
  project TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- source | topic
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',    -- 一行說明（≤ 120 字），總目錄用
  body TEXT NOT NULL,                  -- Markdown，≤ 20,000 字
  sources TEXT NOT NULL DEFAULT '[]',  -- JSON：[{ docId, sha256, name }]
  status TEXT NOT NULL,                -- published | stale
  author_id TEXT NOT NULL,             -- 寫的 AI
  reviewed_by TEXT, reviewed_at TEXT,  -- 保留給之後的核准流程
  card_id TEXT,                        -- 從哪張整理卡來的（專案卡號）
  notices TEXT NOT NULL DEFAULT '[]',  -- JSON：整理 AI 發給 leader 的 [需確認] messageId（文件互相矛盾）
  stale_note TEXT, stale_at TEXT,      -- 為什麼可能過時（來源換版、刪除、被退回）
  update_card INTEGER,                 -- 正在更新這頁的卡（cards.seq）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_pages ON kb_pages (project, status, deleted_at);
-- 成員與權限（docs/adr/0002；migrations/008）：帳號、工作區、專案成員
-- 預設工作區：新站「誰可以建立專案」＝所有成員（升級的站由 008 先建成只有管理員）
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,                 -- 第一階段只有 default
  name TEXT NOT NULL DEFAULT '',       -- 工作區名稱（升級時取群組名稱）
  create_projects TEXT NOT NULL DEFAULT 'members', -- 誰可以建立專案：members | admins
  created_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO workspaces (id, name, create_projects) VALUES ('default', '', 'members');
-- 帳號：一個人在平台上的登入身分（人類的 participants.account_id 指過來；第一階段一人一個工作區）
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,                 -- acct_<participant id>
  platform_role TEXT NOT NULL DEFAULT 'none', -- admin（平台管理員）| none
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled（停用帳號）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 升級用的暫存（migrations/009）：從第一階段之前升級、還沒轉到新表的成員，舊的 is_admin 與逗號字串專案歸屬（projects；NULL＝所有未封存專案）。
-- 匯入舊版備份時也寫在這裡。程式啟動後轉進新表就刪掉，平常是空的
CREATE TABLE IF NOT EXISTS legacy_members (
  participant_id TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0,
  projects TEXT
);
-- 專案成員：誰在哪個專案、專案角色（取代舊的 participants.projects 與 project_leaders／read_only 設定）
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- admin（專案管理員）| member（專案成員）| viewer（唯讀成員；他的 AI 跟著唯讀）
  PRIMARY KEY (project_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_participant ON project_members (participant_id);
-- 稽核紀錄（docs/adr/0003；migrations/010）：管理與破壞性操作只能新增的紀錄；平台層，專案永久清除後仍保留。不存訊息原文
-- 沒有修改、刪除的 API；跟著備份走（還原時換成備份裡的，再加一筆 backup.restore）
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, -- 分頁游標（新的在前）
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,                    -- ISO 時間
  actor_id TEXT,                       -- 操作者；系統操作是 system
  actor_name TEXT NOT NULL DEFAULT '', -- 寫入當時的名字（系統）
  actor_kind TEXT NOT NULL DEFAULT 'human', -- human | ai | system
  action TEXT NOT NULL,                -- src/audit.js 的 AUDIT_ACTION（例 platform_admin.grant）
  scope_kind TEXT NOT NULL,            -- platform | workspace | project；平台層的只有平台管理員看得到
  workspace_id TEXT,                   -- 非平台層的事件所屬工作區（第一階段只有 default）；平台層 NULL
  project_id TEXT,                     -- 專案層的事件
  project_name TEXT,                   -- 寫入當時的專案名字
  target_kind TEXT,                    -- participant | project | message | workspace
  target_id TEXT,
  target_name TEXT,                    -- 寫入當時的名字
  count INTEGER,                       -- 摘要數字（例：清除了幾則訊息）
  detail TEXT                          -- 細節 JSON；不放訊息原文
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log (workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor_id, seq);
