---
status: accepted
---

# 專案識別碼維持全站唯一 · Project identifiers stay global

第一版多工作區平台沿用全站共用的網址英文名與專案代號，讓既有的專案網址和 `MAIN-12` 形式的卡片代號繼續有效。專案代號和舊代號共用同一套保留規則。專案在可復原期內仍保有其識別碼，永久清除時釋放。工作區仍是授權與資料可見度的邊界。

The first multi-workspace release keeps project slugs and codes global to preserve existing project URLs and card references. Current and historical codes share one namespace. A project keeps its claims through the recovery window and releases them on permanent purge. Workspace authorization still applies to every lookup.

## Consequences

- Enforce global uniqueness in the database before enabling identifier writes in multiple workspaces. A workspace row lock protects writes within that workspace. The global unique constraint protects identifier claims across workspaces.
- During migration, reserve disputed legacy values and retain their claimant history. The platform admin previews and confirms repairs that change a displayed card code or its resolution. Backfill and restore preserve existing values.
- Keep slug claims and code claims distinct. Preserve route tokens that still resolve through existing project IDs when checking slug availability.

## Drained cutover for #72

Activation and every reactivation require a maintenance window: stop and fence all legacy writers, schedulers, background work, and in-flight transactions; then reconcile and validate claims from the target database before admitting claim-enabled writers. The readiness marker alone is not evidence. Legacy read-only coexistence is optional only where all request, startup, and scheduled paths are proven write-free; otherwise stop the old instances. Keep legacy settings synchronized with claims during this compatibility window; do not retire them in #72.

The deployment remains single-workspace. Mixed-version identifier writers and implicit rollback after multi-workspace writes are unsupported. Proposed rollback floor: `edc10175` (migrations through 018), only after compatibility is demonstrated. `v1.2.0` is an upgrade source, not an in-place downgrade target; recovery to it requires a compatible pre-upgrade backup. A platform without an enforceable writer drain must fail closed and leave claim activation disabled.

Sources: [ADR 0002](0002-platform-workspace-project-tenancy.md), [ADR 0004](0004-project-creation-requests.md), [ADR 0005](0005-workspace-write-serialization.md), [#55](https://github.com/cyljacky02/aigile-oss/issues/55), [#56](https://github.com/cyljacky02/aigile-oss/issues/56), [#59](https://github.com/cyljacky02/aigile-oss/issues/59), [#72](https://github.com/cyljacky02/aigile-oss/issues/72).
