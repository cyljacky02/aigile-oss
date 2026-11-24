# 卡片的 `status` 欄位存類別，自訂狀態另存 `status_id` · `cards.status` stores the Status Category; the custom Status lives in `status_id`

各專案可以自訂狀態（見 GLOSSARY「狀態」「狀態類別」），但流程規則（接單、決策、驗收、交接、自動封存、未結卡計數）都寫死在七個類別的中文字面值上，散在 `src/cards.js`、`src/core.js`、`src/kb-pages.js` 的 SQL `IN (...)` 清單與判斷裡，並有約 34 個測試檔依賴。我們決定 `cards.status` 保持存類別（值仍是 `待整理…已封存` 七個字），另加 `cards.status_id` 指向 `project_statuses` 表中的自訂狀態；已封存卡片的 `status_id` 為空。這讓既有規則、索引 `idx_cards_status` 與資料幾乎不必改動。

Projects can define their own Statuses, but every workflow rule is keyed on the seven Category literals across the server, its SQL `IN (...)` lists, and ~34 test files. So `cards.status` keeps holding the Category and a new `cards.status_id` points at the project's Status row (NULL once archived), leaving the existing rules, the `idx_cards_status` index and existing data intact.

## Considered Options

- **`cards.status` 改存狀態 ID，類別查表取得。** 名稱與語意一致，但每條寫死清單與規則都要改成 JOIN 或查表，風險與改動面大。未採用。

## Consequences

- 資料庫欄位 `cards.status` 的意思是「類別」，而 API 回傳的 `status` 是自訂狀態名稱（另附 `category`、`statusId`）。兩者同名不同義，是刻意的取捨，不要「修正」成一致。
- 改變卡片狀態時兩欄必須一起寫：跨類別移動走既有規則並更新 `status`；同類別內移動只改 `status_id`。只改 `status` 的寫入要一併把 `status_id` 設成「該類別排最前面的狀態」（`src/statuses.js` 的 `FIRST_STATUS_SQL`／`firstStatusSql`）。
- `status_id` 為空或對不上（別的專案、別的類別、已刪除）時，卡片算在「同專案、同類別、排最前面」的狀態；程式第一次讀到沒有狀態的專案時補上預設狀態組並補齊卡片的 `status_id`，改狀態設定前也會先補齊。所以升級（007）只加表與欄位，SQLite、D1、Postgres 共用同一套補資料的程式。補預設狀態組只在專案還沒有任何狀態時做（整組一句插入），同時補兩次或補好後使用者已經改過，都不會把改掉的狀態加回來。
- 不加外鍵（`status_id` 對不上時照上面的規則算），改用交易與列鎖防止卡片指向已刪除或改了類別的狀態：寫卡片時的狀態子查詢都帶 `LOCK_STATUS`（Postgres 轉成 `FOR SHARE`；SQLite、D1 的寫入一次一個交易，不需要），新增、刪除狀態與改類別先鎖住專案那一列（同專案一次一個），在同一個交易的最後一句檢查：沒有卡留在裡面、必要類別還有狀態、狀態數在 3～12 個之間、還有未決定的決策卡時待確認還有狀態，不成立就整個回復（409）。兩個交易同時進行的情況由 `scripts/project-statuses-pg-race-test.js` 驗證。
- The DB column `cards.status` means Category while the API field `status` means the Status name. The mismatch is deliberate; don't "fix" it.
