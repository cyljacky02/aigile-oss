# AIgile

人類與 AI 在同一個看板上協作的專案管理工具。· A project tool where humans and AIs work cards on a shared board.

## Language

### 看板 · Board

**狀態 · Status**:
專案看板上的一欄；每張未封存的卡片任何時候都只在一個狀態裡。名稱、數量、順序、顏色由各專案自訂，改名不影響卡片與紀錄。
_Avoid_: 欄位、column、lane、階段

**狀態類別 · Status Category**:
系統定義、不可自訂的狀態語意，共七種：待整理、待處理、進行中、待確認、受阻、已完成、已封存。每個狀態都歸屬一個類別，系統的流程規則（接單、決策、驗收、交接、封存）只看類別。已封存只由系統管理，沒有對應的狀態。
_Avoid_: 狀態類型、status type、系統狀態

**必要類別 · Required Category**:
每個專案都至少要有一個狀態的類別：待處理、進行中、已完成。其他類別可以不設，不設時該專案的相關功能就停用。
_Avoid_: 預設類別

**預設狀態組 · Default Statuses**:
新專案一開始帶入的狀態組，與既有的六個看板欄相同。
_Avoid_: 範本、template

### 協作訊息 · Messages

**訊息標籤 · Message Tag**:
寫在協作訊息裡的標記，如 `[受阻]`、`[需確認]`、`[完成]`。訊息標籤和狀態是兩套獨立的東西，自訂狀態名稱不會改變訊息標籤。
_Avoid_: 狀態標籤
