---
status: accepted
---

# 共同不變量的寫入以工作區列鎖排序，並在交易內檢查前提 · Writes that share an invariant serialize on the workspace row and assert their preconditions inside the transaction

資料庫介面只有一次送出的批次交易（`db.batch`）：SQLite、PostgreSQL、D1 三種都支援，但沒有互動式交易，也拿不到每句影響的列數；只有語句拋錯才會整批回滾。我們決定：凡是一組寫入共同維護某個不變量（例如「核准前提仍成立」「未封存專案不同名」「識別碼不重複」），這組裡**每一條**寫入路徑都在同一批的第一句取得該工作區列的鎖（對工作區列做一次無變化的 UPDATE），接著用**交易內斷言**確認前提（前提不成立時讓語句違反 NOT NULL 而拋錯，整批回滾），最後才寫入資料。交易前在程式裡讀到的資料只用來準備候選值與產生錯誤訊息，不用來保證一致性。

Writes that jointly protect an invariant all take the same workspace-row lock as the first statement of their batch, then assert their preconditions in-batch (a NOT NULL violation aborts the whole batch), then write. Reads done before the batch only prepare candidates and error messages; they never guarantee consistency.

## 規則 · Rules

- **只有共享不變量的寫入要加鎖。** 聊天、卡片更新等高頻寫入不屬於任何這類不變量，不加工作區鎖，免得鎖變成全域瓶頸。
- **加鎖順序固定：工作區 → 專案 → 其他資源。** 同一批要鎖多樣東西時一律照這個順序，避免死結。
- **斷言的條件不能是 SQL NULL。** `WHERE NOT (cond)` 遇到 NULL 不會觸發失敗；條件用 `EXISTS`／`NOT EXISTS` 或明確處理 NULL 的寫法。
- **持久的東西一起提交。** 狀態、稽核紀錄、站內通知與資料變更在同一批；即時事件與快取更新在提交成功之後才做。
- **候選值衝突就整批重試，次數有限。** 自動產生的值（例如 slug、代碼）若因競態被占用，回滾、重讀、重算後重試；使用者明確指定的值衝突時直接回 409，不自動換值。每次重試都重新斷言所有前提。
- **不假設只有一個程序。** SQLite 的 `SQLITE_BUSY`、PostgreSQL 可重試的交易錯誤，可以有限次重試整批，或回傳明確的可重試錯誤；可以失敗，但失敗不得破壞一致性。
- **三種資料庫都要成立。** 新的 SQL（斷言、部分唯一索引、CHECK 約束）要在 SQLite、PostgreSQL 上有自動測試；D1 至少要有可重複執行的驗證腳本，沒驗證就不宣稱支援。

## Considered Options

- **交易前用權限檢查與查詢確認前提（現行多數管理操作的做法）。** 有毫秒級的競態空窗：兩位管理員同時核准、核准時申請人剛被移出、核准時政策剛被改，都可能產生不該存在的結果。未採用於共享不變量的寫入。
- **另建決策權杖表或專用的鎖表。** 工作區列鎖與既有的交易內斷言工具已經夠用，且已被成員資格的「最後一位管理員保護」採用。未採用。
- **只在 PostgreSQL 上用互動式交易。** D1 不支援，會讓三種資料庫的保證不一致。未採用。

## Consequences

- 現有幾條路徑要補上鎖與交易內檢查：更新建立專案政策、直接建立專案、改名、改 slug、改代碼、封存與取消封存、復原專案，以及建立專案申請的送出與四種終止動作。取消封存會因此開始檢查名稱衝突（修正既有可能產生同名未封存專案的缺陷）。
- 交易前的檢查仍保留，負責回傳友善的錯誤訊息；斷言失敗後再重讀新鮮資料判斷原因，判斷不出時回一般的 409。
- **第二階段注意**：目前專案代碼、slug、卡片代號仍是全站共用的命名空間。真正多工作區之後，只鎖單一工作區不足以保護全站唯一性，要重新檢討命名空間與鎖的範圍。
