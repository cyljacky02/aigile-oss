---
status: accepted
---

# 刪除採可復原期加稽核紀錄，不採核准制 · Deletion uses a recovery window plus an audit log, not approval

刪除訊息、清空專案訊息、刪除專案，一律先進入**可復原期**（平台預設 30 天，工作區可覆寫；0＝立即），期滿由排程**永久清除**；被刪的訊息留下「已刪除」佔位，不斷掉回覆、卡片關聯與決策的參照。所有管理與破壞性操作寫進平台層、只能新增、專案清除後仍保留的**稽核紀錄**（不存被刪內容原文），並通知相關管理員。我們不做「另一位管理員核准」：自架的小團隊常常只有一位管理員，核准會卡死；可復原期讓誤刪能救回，稽核紀錄與通知讓惡意刪除留下痕跡、被看見。

Deletes are soft with a configurable recovery window and a scheduled purge; every admin or destructive action lands in a platform-level, append-only audit log that outlives the project, and the relevant admins are notified. We chose this over two-person approval because many self-hosted workspaces have a single admin, and recoverability plus visibility already covers mistakes and abuse.

## Considered Options

- **直接硬刪除（現狀的專案永久刪除）。** 簡單，但誤刪救不回，訊息硬刪還會破壞 `reply_to`、卡片關聯、決策紀錄的參照。未採用。
- **另一位管理員核准後才刪。** 防得住單人惡意，但只有一位管理員時無法運作，且每次刪除都要等人。未採用；日後若需要，可加成預設關閉的平台設定。
- **異動紀錄沿用 `project_events`。** 專案清除時紀錄會跟著消失（現在只好另外塞 `app_settings` 的 `pdel:`）。改為獨立的稽核紀錄。

## Consequences

- 「永久刪除」一詞退場：刪除＝進入可復原期，永久清除由系統在期滿時做。
- 例外：**單則訊息的刪除與復原不通知管理員**，只寫稽核紀錄。作者刪自己貼錯的訊息是日常動作，每次都通知只會讓管理員忽略通知；要追查時稽核紀錄裡都有。清空專案訊息、刪除專案等整批的破壞性操作照常通知。Single-message delete and restore are the one exception to "admins are notified": they are audit-only, because authors deleting their own slips is routine and per-message notices would train admins to ignore them. Bulk actions (clearing a project's messages, deleting a project) still notify.
- 舊的 `pdel:` 紀錄併入稽核紀錄。
- 還原舊備份會帶回已永久清除的內容；這點寫進說明文件，不另外追蹤。
