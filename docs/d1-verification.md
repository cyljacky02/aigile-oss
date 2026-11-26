# 本機 D1 驗證（`npm run verify:d1`）

一個指令，從**空的本機 D1** 跑完建立專案申請在 Cloudflare D1 上的關鍵資料庫行為，逐項印出 PASS／FAIL。一般的 `npm test` 只跑 SQLite（與選用的 Postgres）。CI 會另外執行這支腳本，檢查 D1 才有的限制與錯誤格式。

只用**本機 D1**：`wrangler d1 execute --local` 與 `wrangler dev --local`（Miniflare／workerd），資料放在系統暫存資料夾。不需要 Cloudflare 帳號或憑證，也不會連到正式的 D1。手動執行時也可設 `NODE_ENV=test`，讓 Miniflare 直接使用本機的 `Request.cf` 預設值。

## 執行前提

- Node.js 22.13 以上（建議 24）。不需要 `npm install`。
- `wrangler@4` 預設由 `npx` 取得，下載時**需要網路**。也可設 `D1_VERIFY_WRANGLER` 指到已有的 `wrangler/bin/wrangler.js`，直接使用該版本。
- `generated/`（`worker.js` 會打包）：沒有的話腳本自動跑 `node scripts/releases.mjs` 產生（gitignore，跟 `npm run deploy` 前一樣）。
- 約 1 分鐘（第一次下載 wrangler 另計）。

## 指令

```bash
npm run verify:d1                 # = node scripts/d1-verify.mjs
npm run verify:d1 -- --verbose    # 每項多印細節（D1 錯誤原文、每個請求的 D1 用量）
npm run verify:d1 -- --keep       # 保留暫存資料夾（本機 D1 檔、wrangler dev 紀錄）
```

退出碼：`0`＝全部 PASS；`1`＝有 FAIL（暫存資料夾會保留，路徑印在最後）；`2`＝沒辦法驗證（例：拿不到 wrangler）。**退出碼不是 0 時，發布說明與測試報告要寫「D1 未驗證」**，不能宣稱三種資料庫都通過（規格 #39）。

這支不在 `npm test` 裡（要 wrangler、要開 Worker）。`npm test` 裡有兩支相關的快速測試：
- `d1-sqlite-limits-test`：用 node:sqlite 開一個套上 D1 限制（`src/db-d1.js` 的 `D1_SQLITE_LIMITS`，數字是在本機 D1 實測的）的資料庫，跑建立專案與申請的主要流程。
- `d1-verify-guard-test`：驗證腳本的「只碰本機」防護。

## CI

[CI 的 `test-d1` 工作](../.github/workflows/ci.yml)在 Ubuntu 上用 Node.js 24 執行 `npm run verify:d1`，上限 10 分鐘。它從 npm 下載固定版本的 `wrangler@4.168.0` 到 runner 的暫存資料夾，並用 `D1_VERIFY_WRANGLER` 指定該版本。驗證步驟設 `NODE_ENV=test`，讓 Miniflare 直接用本機的 `Request.cf` 預設值，省去向 Cloudflare 取得範例資料。安裝或初始化失敗，或任何驗證項目未通過，都會讓 CI 失敗。

這項工作在 CI 手動觸發或發版流程呼叫時執行。發佈映像要等整個 CI（含本機 D1 驗證）通過。

## 怎麼驗證

1. **資料庫升級**用 `scripts/migrate.js` 的同一個純函式 `d1Steps` 產生 SQL，經 `wrangler d1 execute --local` 套用（不執行 `migrate.js` 本身：它預設 `--remote`）。
2. 其餘全部經 HTTP 打 `wrangler dev --local` 跑的真 Worker：入口 `scripts/d1-verify-worker.mjs` 把請求原樣交給 `worker.js`（同一套 `createApp`、`wrapD1(env.DB)`），只把 `env.DB` 包一層量用量。HTTP 表達不了的（直接寫入違反約束的列、在正式程式的那一批中間注入失敗、事後核對資料）用同一個 Worker 的 `/__d1verify/*` 控制端點（每次執行的隨機 token；只存在這個驗證入口，不會部署）。
3. 還原用第二個全新的本機 D1。

| 項目 | 驗證什麼 |
|---|---|
| D1-01 資料庫升級 | 空的 D1 走全新路線（`schema.sql`＋標記全部升級）；再模擬「015 之前」的舊 D1，只套 `015_project_creation_requests.sql`，得到的欄位與索引跟全新的一樣；重跑沒有要套的 |
| D1-02 Worker 啟動 | `worker.js` 在本機 D1 上啟動：預設管理員改帳密、再驗證、註冊、升工作區管理員、政策設成 approval |
| D1-03 部分唯一索引 | 同一申請人同名待審：HTTP 回 `DUPLICATE_PENDING_REQUEST`；6 個同時送出只有 1 份成功；直接寫入時 D1 的錯誤原文被 `isUniqueConstraintViolation` 認成 `idx_pcr_pending_name`；已結束的同名不擋 |
| D1-04 CHECK 約束 | 12 種不一致的 INSERT、1 種不一致的 UPDATE 被 CHECK 擋下；五種狀態的合法列都寫得進去 |
| D1-05 生命週期 | 送出（通知審核人）、核准（專案、唯一的專案管理員、識別碼、看板狀態、`project.create` 稽核、通知）、拒絕（稽核）、撤回（再撤回回 409，證明 D1 的斷言錯誤被認出）、移出成員取消、政策切換取消（每位申請人一則通知、稽核記數） |
| D1-06 整批回滾 | 同一批寫兩次同一鍵 → 第一句也回滾；`ensureStmt` 斷言失敗的 D1 錯誤被 `isNotNullViolation(e, 'app_settings')` 認出；核准那一批在專案、狀態、成員、稽核、申請、通知每一句之後各注入一次執行期失敗 → 5xx、什麼都不留、重試成功；核准前一刻政策被切走或申請人被移出 → 交易內發現（409），不建立。直接建立時，在同一批寫入程式庫設定後注入失敗 → 專案與程式庫設定都回滾，重試成功並立即回傳程式庫 |
| D1-07 同時核准 | 兩位審核人 10 個請求同時核准同一份：全部 200、只有 1 個真的建立、1 個專案、1 筆稽核、1 筆成員資格、1 則通知；核准與拒絕同時（3 次）：結局一致 |
| D1-08 識別碼 | 名稱、網址英文名、代號衝突（直接建立與核准都只說欄位）；自動代號不重複；舊資料正規化前寫入回 503 `IDENTITY_NOT_READY`，正規化後保留並列出既有衝突。預覽和確認修復代號與網址英文名、正常查卡及稽核；交易前剛變更移卡別名時回 409，整批回復 |
| D1-09 D1 限制 | 120 位申請人、180 份待審、5 位審核人：送出通知、審核清單、通知、稽核清單、政策切走一次取消全部、停用帳號——每個請求單句 ≤ 100 個參數、≤ 100,000 位元組，每次 Worker 執行的查詢數 ≤ 50（免費方案上限；付費 1000） |
| D1-10 備份還原 | 匯出 → 改成「停用、移出、申請人不存在、拿掉識別碼」的備份 → 匯入全新的 D1 → 收尾取消 3 份（`account_disabled`、`workspace_member_removed`、`restore_invalid`）、保留有效的、重新正規化、`backup.restore` 稽核記數；沒有建立專案、沒有通知；還原後可核准 |
| D1-11 加入申請 | 專案加入申請的拒絕／核准批次中，通知寫入後注入失敗：仍待審、沒有成員資格、異動紀錄或通知；重試後只生效一次 |

## 預期輸出

```
本機 D1 驗證（#49）　暫存：C:\Users\…\Temp\aigile-d1-verify-XXXXXX
wrangler 4.168.0（…\wrangler\bin\wrangler.js）
PASS  D1-01  資料庫升級：全新的 D1 與「015 之前」的舊 D1 都用 d1Steps 升到最新，結構相同  (22.8s)
PASS  D1-02  Worker（worker.js）在本機 D1 上啟動：…  (2.2s)
PASS  D1-03  部分唯一索引：…
…
PASS  D1-10  備份還原：…  (7.9s)

D1 用量（每個請求＝一次 Worker 執行；查詢數裡 db.batch 整批算一次）：
  還原收尾：查詢 38 次（批次 6，最大一批 140 句）、單句最多 15 個參數、最長 1021 位元組
  新執行個體的第一個請求（GET /api/health，含啟動時的建表、預設管理員、識別碼正規化）：查詢 35 次…
  正規化後建立專案（含啟動正規化）：查詢 31 次…
  核准：查詢 30 次（批次 1，最大一批 23 句）…
  …
  全部量到的請求：單句最多 29 個參數（上限 100）、單句最長 1021 位元組（上限 100000）

11/11 PASS
D1 驗證：全部通過（本機 D1；正式 D1 的差異見 docs/d1-verification.md）
```

FAIL 時印出第一個沒過的斷言（例：`FAIL  D1-08 … 直接建立：HTTP 500 …`），Worker 的錯誤在保留下來的 `site-*/wrangler-dev.log`。

## 只碰本機的防護

`scripts/d1-local.mjs`（`d1-verify-guard-test` 會測）：
- 只允許 `wrangler d1 execute` 與 `wrangler dev`，一定要有 `--local`；`--remote`、`-r`、`--tunnel` 等一律拒絕。
- `--persist-to` 一定在這次的暫存資料夾、不在 repo 裡；`--config` 一定是這次產生的設定檔（D1 名稱與 ID 是假的、沒有 `account_id`／`remote`／R2），repo 的 `wrangler.toml` 不能用。
- 子程序拿不到 Cloudflare 憑證：刪掉 `CLOUDFLARE_*`／`CF_*` 環境變數，`XDG_CONFIG_HOME` 指到暫存資料夾（看不到 `wrangler login` 存的登入）。
- 不執行 `scripts/migrate.js`（預設 `--remote`）與 `scripts/admin-rescue.js`（永遠 `--remote`）；`d1-verify.mjs` 收到 `--remote` 直接拒絕。

## 本機 D1 實測的 SQLite 限制

| 限制 | 本機 D1 | 官方文件 |
|---|---|---|
| 每句綁定參數 | 100 | 100 |
| 每句 SQL 長度 | 約 100 KB（100,001 位元組可、200,000 不行） | 100,000 位元組 |
| 結果欄數 | 100 | 100 |
| 複合 SELECT（`UNION`／`UNION ALL`…）段數 | **5** | 沒寫 |
| `LIKE`／`GLOB` 樣式長度 | **50 位元組** | 沒寫 |
| 函式參數個數 | 127 | 沒寫 |

這些記在 `src/db-d1.js` 的 `D1_SQLITE_LIMITS`。

## 這支腳本找到的問題

- **已修**：沒指定看板狀態的專案第一次被讀到時，補預設狀態組那一句是 6 段 `UNION ALL`，D1 回 `too many terms in compound SELECT`——直接建立或核准建立後讀專案清單就 500。改用多列 `VALUES`（`src/statuses.js`）；回歸測試 `d1-sqlite-limits-test`。
- **沒修（另開）**：搜尋的 `LIKE '%關鍵字%'`（卡片、訊息、文件、知識庫）在 D1 上樣式超過 50 位元組會失敗（中文約 16 個字）。不在建立專案申請的範圍。

## 已知限制（本機 D1 與正式 D1 的差異）

CI 和開發機都使用 Miniflare／workerd 的本機 D1。正式 D1 的行為仍要在正式（或測試用的）Cloudflare 帳號上人工驗收（#50）。

- **交易與並行**：本機是一個 workerd 程序裡模擬的 D1，`env.DB.batch()` 在本機確實整批回滾、寫入一次一個。正式 D1 是遠端的單一主要資料庫，請求可能來自不同地點的多個 Worker 執行個體；官方說 batch 是交易，但跨執行個體的同時核准、核准與政策切換交錯在正式 D1 上沒驗證。
- **每次執行的查詢數**（免費 50、付費 1000）本機不會擋；腳本是自己數的（`get`／`all`／`run` 各一次、`db.batch` 整批一次），而且只數到回應送出為止，`waitUntil` 的背景工作（門鈴、抽字）沒算進去。還原收尾 38 次、新執行個體的第一個請求 35 次，離免費方案的 50 次不遠。
- **時間與資源**：30 秒查詢時限、Worker CPU 時間、資料庫大小、單列 2 MB 本機都沒有模擬；大量資料（上萬份申請、很大的備份）的耗時沒測。
- **錯誤訊息格式**：本機 Worker 綁定的錯誤長這樣：`D1_ERROR: NOT NULL constraint failed: app_settings.value: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)`，`src/db-errors.js` 認得出來；正式 D1 的前後綴若不同，斷言失敗會變成 500 而不是 409——要在正式 D1 上跑一次撤回兩次、同名待審。
- **資料庫升級的傳送方式**：腳本用 `wrangler d1 execute --local --file`；正式部署是 `migrate.js` 用 `--remote --command`。SQL 內容相同，但遠端一次送多句是否整段原子沒驗證。
- **SQLite 限制**：複合 SELECT 5 段、LIKE 50 位元組是本機 workerd 的值，官方文件沒寫，正式 D1 可能不同。
- **沒涵蓋**：D1 的讀取副本（Sessions API，本程式沒用）、D1 自己的 Time Travel 備份、R2（文件區）、排程（cron）、Supabase 門鈴。

## 加一項檢查

在 `scripts/d1-verify.mjs` 照現有的 `check('D1-NN', '標題', async note => { … })` 加：用 `a.call(token, 路徑, method, body)` 打 API、`a.q`／`a.one`／`a.n` 事後核對、`a.batch` 直接寫入、`a.fault` 在正式程式的那一批中間注入失敗；`within(標籤, 回應)` 確認那個請求的 D1 用量在限制內。
