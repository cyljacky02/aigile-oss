---
status: accepted
---

# 沒有工作區成員資格的審核人以帳號記錄 · Attribute reviews by platform admins without workspace membership to their accounts

平台管理員可在具有隱含管理權的工作區審核建立專案申請。如果該帳號沒有對應的工作區成員資格，申請決定與稽核都要記錄真實的帳號身分與工作區範圍。審核不會建立成員資格。

A review by a platform admin without membership records the admin’s account in both the decision and audit event. The workspace remains the scope of the decision. Recording the account preserves attribution without granting the actor membership.

Existing participant-based records retain their meaning. Requesters and the resulting project memberships still use workspace member identity. The workspace context and the account’s current platform role determine whether the action is authorized.

This resolves the phase-one actor limitation described in [ADR 0004](0004-project-creation-requests.md). The workspace isolation boundary comes from [ADR 0002](0002-platform-workspace-project-tenancy.md).
