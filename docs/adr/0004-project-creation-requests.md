---
status: accepted
---

# 建立專案改為三種政策，申請與專案分開，核准即建立 · Project creation gets a three-mode policy and a separate request that is approved and created in one step

工作區政策「誰可以建立專案」從兩種（只有管理員／所有成員）改為三種互斥的值：`admins`（只有工作區管理員與平台管理員直接建立）、`approval`（一般成員提出**建立專案申請**，由任一位審核人核准後建立）、`members`（成員直接建立）。建立專案申請是獨立的概念：核准前專案不存在，不寫進專案表、沒有成員資格、看板或 AI 存取。申請內容送出後不可修改；狀態只有待審核與四種終止狀態（已核准、已拒絕、已撤回、已取消）。**核准與建立專案在同一筆交易裡完成**，所以已核准就代表專案在那一刻已經建立。申請人成為新專案唯一的初始專案管理員，審核人不因核准而成為成員。直接建立與核准建立走同一套建立邏輯。只有人類能申請、審核、撤回；取消只由系統依規則觸發。

The create-projects workspace policy becomes a three-valued enum (`admins` / `approval` / `members`). In `approval` mode a member files a Project Creation Request — a separate, immutable record, never a "pending project" — and any one reviewer (workspace admin or platform admin) approves it, which creates the project in the same transaction; "approved" therefore means "the project was created then". The requester becomes the sole initial project admin; the reviewer gains no membership. Direct and approved creation share one creation path. Only humans request, review, or withdraw; cancellation is a system action tied to the change that causes it.

## Considered Options

- **「只有管理員」再加一個「允許申請」開關。** 兩個布林會出現「所有成員都能建立＋允許申請」這種沒有意義的組合。未採用。
- **在專案表加 `pending` 狀態。** 看板、訊息、AI、跨專案頻道、備份等所有讀專案的地方都得學會排除待審專案，漏一處就是資料外洩。未採用。
- **通用的審批引擎（一張萬用申請表＋任意 JSON 內容）。** 加入申請、技能審核、建立專案的審核人、前提與結果都不同，統一後規則會變成大量分支。等真的有第三、四種相同形狀的流程再抽共同元件。未採用。
- **核准與建立分成兩個生命週期（approved → provisioning → succeeded/failed）。** 目前建立專案只有資料庫寫入，可以原子完成；拆開只會多出「核准了卻沒建好」的狀態。等到要建立外部資源（Git repository、CI 等）時再拆。未採用。
- **禁止申請人自己核准。** 申請人升為管理員後本來就能直接建立專案，禁止自審沒有實質保護。未採用；技能審核的禁止自審是那個領域自己的規則，不受影響。
- **申請內容存成一包有版本號的 JSON。** 欄位固定，且要在 SQL 裡檢查、建唯一索引；一般欄位更直接。未採用。

## Consequences

- 既有安裝、升級與舊備份的政策預設值不變（新站 `members`，舊站升級 `admins`），不會自動改成 `approval`。
- 從 `approval` 切到其他模式，在同一筆交易裡取消所有待審申請；申請人被移出、自己離開或帳號停用時，取消他的待審申請。取消原因用固定代碼。
- 專案代碼一律存進資料庫（不再於讀取時由 slug 推導），讓核准時能在交易內檢查唯一性；既有資料原樣保存，不改動任何看得到的代碼。既有的識別碼衝突保留並提供診斷，不因此停用建立專案；新寫入不得新增或擴大衝突。
- 還原備份時，在收尾階段先正規化識別碼、再檢查待審申請，不符合條件的取消；還原不會自動核准或建立任何專案。
- 每個新專案都有一筆 `project.create` 稽核。核准建立一定要寫成，否則不核准；直接建立在「程式先部署、稽核表尚未建立」的升級空窗期沿用既有的略過慣例。
- `POST /api/projects` 的語意不變：只代表直接建立，不會偷偷改成送出申請；`canCreateProject` 仍只表示能直接建立。
- **第一階段限制**：申請人、審核人與稽核紀錄的執行者都記工作區成員資格（participant）。第二階段（真正的多工作區）可能出現沒有該工作區成員資格、卻有隱含審核權的平台管理員，屆時要和稽核紀錄的執行者身分、帳號與成員資格的關係一起重新設計。
- 交易一致性做法見 ADR 0005。
