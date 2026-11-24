# 卡片的 `status` 欄位存類別，自訂狀態另存 `status_id` · `cards.status` stores the Status Category; the custom Status lives in `status_id`

各專案可以自訂狀態（見 GLOSSARY「狀態」「狀態類別」），但流程規則（接單、決策、驗收、交接、自動封存、未結卡計數）都寫死在七個類別的中文字面值上，散在 `src/cards.js`、`src/core.js`、`src/kb-pages.js` 的 SQL `IN (...)` 清單與判斷裡，並有約 34 個測試檔依賴。我們決定 `cards.status` 保持存類別（值仍是 `待整理…已封存` 七個字），另加 `cards.status_id` 指向 `project_statuses` 表中的自訂狀態；已封存卡片的 `status_id` 為空。這讓既有規則、索引 `idx_cards_status` 與資料幾乎不必改動。

Projects can define their own Statuses, but every workflow rule is keyed on the seven Category literals across the server, its SQL `IN (...)` lists, and ~34 test files. So `cards.status` keeps holding the Category and a new `cards.status_id` points at the project's Status row (NULL once archived), leaving the existing rules, the `idx_cards_status` index and existing data intact.

## Considered Options

- **`cards.status` 改存狀態 ID，類別查表取得。** 名稱與語意一致，但每條寫死清單與規則都要改成 JOIN 或查表，風險與改動面大。未採用。

## Consequences

- 資料庫欄位 `cards.status` 的意思是「類別」，而 API 回傳的 `status` 是自訂狀態名稱（另附 `category`、`statusId`）。兩者同名不同義，是刻意的取捨，不要「修正」成一致。
- 改變卡片狀態時兩欄必須一起寫：跨類別移動走既有規則並更新 `status`；同類別內移動只改 `status_id`。只改 `status` 的寫入要一併把 `status_id` 設成「該類別排最前面的狀態」（`src/statuses.js` 的 `FIRST_STATUS_SQL`／`firstStatusSql`）。
- `status_id` 為空或對不上（別的專案、別的類別、已刪除）時，卡片算在「同專案、同類別、排最前面」的狀態；程式第一次讀到沒有狀態的專案時補上預設狀態組並補齊卡片的 `status_id`，改狀態設定前也會先補齊。所以升級（007）只加表與欄位，SQLite、D1、Postgres 共用同一套補資料的程式。
- The DB column `cards.status` means Category while the API field `status` means the Status name. The mismatch is deliberate; don't "fix" it.
