---
status: accepted
---

# 平台 > 工作區 > 專案三層架構，分兩階段導入 · Platform > Workspace > Project tenancy, rolled out in two phases

目前整個部署實例就是一個隱含的工作區：只有一位管理員（`participants.is_admin`），成員資格是 `participants.projects` 逗號字串，專案層權限散在 `app_settings` 的 JSON 裡。我們決定採三層架構（見 GLOSSARY「平台」「工作區」「帳號」）：帳號屬於平台，成員資格與角色分屬工作區與專案；工作區是硬隔離邊界；平台管理員與工作區管理員都可以有多位、且至少要有一位；專案管理員也可以有多位，但專案可以一位明確的專案管理員都沒有（工作區管理員對每個專案都有隱含權限）；上層管理員對下層只有隱含權限，不算成員。

We're moving to a three-tier model: Accounts live on the Platform, memberships and roles live per Workspace and per Project, a Workspace is a hard isolation boundary, platform and workspace admins allow many holders with last-one protection, a project may have several project admins or none at all (workspace admins always have implicit rights over every project), and upper-tier admins get implicit access rather than membership.

## Considered Options

- **單一工作區，只修權限。** 解決眼前痛點，但之後要多租戶時得再改一次資料結構。未採用。
- **一個工作區一個部署，平台層只做帳號與切換。** 隔離最徹底、程式改動最少，但跨工作區的帳號、管理與升級都要額外協調。保留到第二階段再與應用內多租戶比較。
- **`participants` 直接代表帳號，另加工作區成員資格表。** 卡片、訊息、紀錄裡所有 `participant_id` 參照都得重新思考「是哪個工作區裡的這個人」。未採用。
- **平台擁有者 + 平台管理員兩層。** 只多出「任免平台管理員」一件事；多位管理員加最後一位保護已經解決「移交後自己沒權限」的問題。未採用。後來再檢討一次（含 Slack 式唯一的主要擁有者），仍不採用：自架部署的站長本來就有主機權限，救援腳本就是最後手段；「一位管理員把其他人全降級」的風險，改用稽核紀錄、通知所有平台管理員、敏感操作前再驗證一次來處理。

## 資料模型 · Data model

- `accounts`：登入身分、帳密、平台角色。
- `participants` 改為「一個帳號在一個工作區的成員資格」：加 `account_id`、`workspace_id`、工作區角色。AI 的列只有 `workspace_id`，沒有 `account_id`。既有指向 `participant_id` 的資料不必改；第二階段一個人在多個工作區就是多筆 `participants`。
- `project_members(project_id, participant_id, role)` 取代 `participants.projects` 逗號字串與 `app_settings` 的 `project_leaders`、`read_only`、`cross_roles`。

`participants` now means "an Account's membership in one Workspace" (AIs have no Account), so every existing `participant_id` reference stays valid; `project_members` replaces the comma-string and JSON permission blobs.

## Consequences

- **第一階段**：只有一個預設工作區。改用正規的成員資格表（工作區成員、專案成員帶角色），資料結構預留 `workspace_id`。拿掉 `is_admin` 單一旗標與 `/api/admin/transfer`；負責人改為專案管理員。`/api/admin/transfer` 不直接拿掉，而是保留一個版本、回 410 `GONE` 並說明改用「先升別人、再降自己」，讓還在呼叫它的整合拿到看得懂的錯誤，下一版再移除。The transfer endpoint stays for one version as a 410 tombstone that points to promote-then-demote, instead of disappearing into a 404.
- **第二階段**才真正開放多個工作區。盤點到的阻礙：全域唯一性（帳號名、成員名、專案代碼與 slug、卡片代號 `MAIN-12`）、行程層級快取（`PROJECTS`、`peopleCache`、`leadersMap` 等）、`projectsOf()` 76 處呼叫、網址沒有工作區段、跨專案頻道與 `audience='all'`、Supabase 單一頻道、整庫備份還原、全實例容量上限。
