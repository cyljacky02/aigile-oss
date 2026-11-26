// 稽核紀錄（詞彙見 GLOSSARY「刪除與稽核」；決策見 docs/adr/0003）：管理操作只能新增的紀錄
// 介面（core.js 建一個 auditLog，傳給需要記錄的模組）：
//   auditLog.stmt(evt)   回一句 [sql, args]，跟資料異動放進同一個 db.batch；沒有要寫的回 null
//   auditLog.write(evt)  單獨寫一筆（就是 stmt 那一句的 db.run）
//   auditLog.list(q)     查詢（GET /api/audit-log 用；可見範圍由呼叫端依權限決定）
//   auditLog.latestForProject(q)  某個專案某個時間前最後一筆某種紀錄（舊的刪除紀錄端點找按刪除的人）
//   auditLog.migrateLegacy()  舊的專案刪除紀錄（app_settings 的 pdel:）轉進來；core.js 每份程式第一個請求跑一次
// 只能新增：這裡沒有修改或刪除的方法（還原備份時保留原本的、合併備份裡的，在 src/backup.js）
// 呼叫端把 stmt 的結果放進清單時要去掉 null（core.js 的 writeStmts 會去掉；清單空了就不呼叫 db.batch）
// 確認資料表還不存在（還沒跑資料庫升級）時 stmt 一律回 null（什麼都不寫）；確認時的其他錯誤不算，照寫
//
// evt 的欄位：
//   actor      操作者 { id, name, kind }（傳 participant 列就行）；null＝系統
//   action     AUDIT_ACTION 其中之一
//   scope      AUDIT_SCOPE：platform／workspace／project
//   workspaceId  非平台層的事件所屬工作區；不給＝預設工作區
//   project    { id, name }：專案層的事件
//   target     對象 { kind, id, name }，kind：participant／project／message／workspace；名字在寫入時快照
//   count      摘要數字（例：清除了幾則訊息）
//   countOf    [sql, args]：數字在同一批裡用這句 SELECT 算（例：這次清空了幾則），取代 count
//   detail     細節物件（存成 JSON）；不放訊息原文
//   at         ISO 時間；不給＝現在
//   id         這筆的 id；不給＝隨機。提交後要讀回 countOf 算出的數字時給（例：這次實際取消了幾份建立專案申請）
// 不寫的情況：沒有真的改到東西（no-op）、競態檢查擋下來（409）都不寫

// 動作（存在 action 欄位；網頁的篩選與顯示文字照這張表）
import { isMissingTable } from './db-errors.js';

export const AUDIT_ACTION = Object.freeze({
  PLATFORM_ADMIN_GRANT: 'platform_admin.grant', PLATFORM_ADMIN_REVOKE: 'platform_admin.revoke',
  WORKSPACE_ADMIN_GRANT: 'workspace_admin.grant', WORKSPACE_ADMIN_REVOKE: 'workspace_admin.revoke',
  ACCOUNT_DISABLE: 'account.disable', ACCOUNT_ENABLE: 'account.enable',
  MEMBER_REMOVE: 'member.remove', MEMBER_LEAVE: 'member.leave',
  BACKUP_RESTORE: 'backup.restore',
  WORKSPACE_POLICY_UPDATE: 'workspace_policy.update', // detail { field: createProjects｜deleteOwnMessages, from, to }
  RECOVERY_WINDOW_UPDATE: 'recovery_window.update', // 平台或工作區；detail { from, to }
  MESSAGE_DELETE: 'message.delete', MESSAGE_RESTORE: 'message.restore', MESSAGE_PURGE: 'message.purge',
  PROJECT_MESSAGES_CLEAR: 'project_messages.clear', PROJECT_MESSAGES_RESTORE: 'project_messages.restore',
  PROJECT_CREATE: 'project.create', // detail { method: direct｜approved_request｜first_run｜demo, requestId?, requester?, code, slug, visibility }（src/project-create.js）
  PROJECT_CREATION_REQUEST_REJECT: 'project_creation_request.reject', // 拒絕建立專案申請；target＝申請人，detail { requestId, requester }（不複製申請內容）
  PROJECT_DELETE: 'project.delete', PROJECT_RESTORE: 'project.restore', PROJECT_PURGE: 'project.purge', // 舊的專案刪除紀錄轉成 project.purge，detail.legacy＝true
});
export const AUDIT_SCOPE = Object.freeze({ PLATFORM: 'platform', WORKSPACE: 'workspace', PROJECT: 'project' });

export const AUDIT_ACTIONS = Object.freeze(Object.values(AUDIT_ACTION));
const SYSTEM = { id: 'system', name: '系統', kind: 'system' }; // 系統操作（例：到期的永久清除）
const DEFAULT_WS = 'default';
const COLS = 'id, at, actor_id, actor_name, actor_kind, action, scope_kind, workspace_id, project_id, project_name, target_kind, target_id, target_name, count, detail';
const INSERT = `INSERT INTO audit_log (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const LEGACY_FROM = 'pdel:', LEGACY_TO = 'pdel;'; // 舊的專案刪除紀錄：app_settings 的 pdel:<時間>:<專案 id>
const str = v => (v == null ? null : String(v));
const parse = s => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

// 一筆的欄位值（照 COLS 的順序）
function values(evt, id, at) {
  const a = evt.actor || SYSTEM, platform = evt.scope === AUDIT_SCOPE.PLATFORM, t = evt.target || null;
  return [id, at, str(a.id), String(a.name ?? ''), a.kind === 'ai' ? 'ai' : a.kind === 'system' || !evt.actor ? 'system' : 'human', evt.action, evt.scope,
    platform ? null : evt.workspaceId || DEFAULT_WS, str(evt.project?.id), str(evt.project?.name),
    t ? str(t.kind) : null, t ? str(t.id) : null, t ? str(t.name) : null,
    Number.isInteger(evt.count) ? evt.count : null, evt.detail == null ? null : JSON.stringify(evt.detail)];
}
// API 輸出的一筆
const view = r => ({
  id: r.id, at: r.at, action: r.action,
  actor: { id: r.actor_id, name: r.actor_name, kind: r.actor_kind },
  scope: { kind: r.scope_kind, workspaceId: r.workspace_id ?? null, projectId: r.project_id ?? null, projectName: r.project_name ?? null },
  target: r.target_kind ? { kind: r.target_kind, id: r.target_id, name: r.target_name } : null,
  count: r.count ?? null, detail: parse(r.detail),
});

// randId、nowIso：寫入時的 id 與時間
export function createAudit({ db, randId, nowIso }) {
  // 資料表在不在：Cloudflare 可能先部署程式、後跑資料庫升級；還沒有表時什麼都不寫（不擋管理操作）。轉換舊紀錄時確認
  let ready = true;
  const stmt = evt => {
    if (!ready || !evt?.action) return null;
    const v = values(evt, evt.id || randId('aud'), evt.at || nowIso());
    if (!evt.countOf) return [INSERT, v];
    const [sql, args = []] = evt.countOf; // count 是倒數第二欄
    return [INSERT.replace(/\?,\?\)$/, `(${sql}),?)`), [...v.slice(0, -2), ...args, v[v.length - 1]]];
  };
  async function write(evt) {
    const s = stmt(evt);
    if (s) await db.run(s[0], ...s[1]);
  }

  // 查詢（新的在前）。看得到哪些：platform＝平台管理員看全部；否則只有 workspaceId 這個工作區、非平台層的
  // only：'workspace'＝只要工作區（含專案）事件、'platform'＝只要平台層事件；before：上一頁的 next 游標（時間|序號）
  async function list({ platform = false, workspaceId = DEFAULT_WS, only = null, action, actor, from, to, before, limit = 50, withActors = false }) {
    const vis = [], args = [];
    if (!platform || only === 'workspace') { vis.push("scope_kind != 'platform'", 'workspace_id = ?'); args.push(workspaceId); }
    if (only === 'platform') vis.push("scope_kind = 'platform'");
    const where = [...vis], wargs = [...args];
    if (action) { where.push('action = ?'); wargs.push(action); }
    if (actor) { where.push('actor_id = ?'); wargs.push(actor); }
    if (from) { where.push('at >= ?'); wargs.push(from); }
    if (to) { where.push('at < ?'); wargs.push(to); }
    if (before) { where.push('(at < ? OR (at = ? AND seq < ?))'); wargs.push(before.at, before.at, before.seq); }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await db.all(`SELECT seq, ${COLS} FROM audit_log ${cond} ORDER BY at DESC, seq DESC LIMIT ?`, ...wargs, limit + 1);
    const more = rows.length > limit, page = rows.slice(0, limit), last = page[page.length - 1];
    const out = { items: page.map(view), next: more ? `${last.at}|${last.seq}` : null };
    if (withActors) { // 篩選用：看得到的紀錄裡出現過的操作者（名字取最新一筆）
      const vc = vis.length ? 'WHERE ' + vis.join(' AND ') : '';
      const as = await db.all(`SELECT actor_id, actor_name, actor_kind FROM audit_log ${vc} ORDER BY seq DESC LIMIT 5000`, ...args);
      const seen = new Map();
      for (const a of as) if (!seen.has(a.actor_id)) seen.set(a.actor_id, { id: a.actor_id, name: a.actor_name, kind: a.actor_kind });
      out.actors = [...seen.values()];
    }
    return out;
  }

  // 某個專案在 at 之前（含）最後一筆 action 紀錄（沒有回 null）：例如永久清除前最後按刪除的人
  async function latestForProject({ action, projectId, at }) {
    const r = await db.get(`SELECT ${COLS} FROM audit_log WHERE action = ? AND project_id = ? AND at <= ? ORDER BY at DESC, seq DESC LIMIT 1`, action, projectId, at);
    return r ? view(r) : null;
  }

  // 舊的專案刪除紀錄（pdel:）轉進稽核紀錄後移除：一筆一批（新增＋刪鍵），id 由鍵決定，重跑、多份程式同時跑都不會重複
  // 回 false＝這次沒做完（匯入備份中、還沒有資料表），下個請求再試。還原收尾（finishingRestore）時還在還原中，照樣做
  async function migrateLegacy({ finishingRestore = false } = {}) {
    if (!finishingRestore && await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'restore_state'").catch(() => null)) return false;
    // 只有「沒有這張表」才當還沒升級；其他錯誤（連線中斷…）照寫，不能因為一次讀不到就不記
    try { await db.get('SELECT seq FROM audit_log LIMIT 1'); ready = true; } catch (e) { if (!isMissingTable(e)) throw e; ready = false; return false; }
    const rows = await db.all('SELECT key, value FROM app_settings WHERE key >= ? AND key < ?', LEGACY_FROM, LEGACY_TO);
    for (let i = 0; i < rows.length; i += 20) {
      const stmts = [];
      for (const { key, value } of rows.slice(i, i + 20)) {
        const v = parse(value) || {}, rest = key.slice(LEGACY_FROM.length), cut = rest.lastIndexOf(':');
        const pid = v.projectId || rest.slice(cut + 1), at = v.at || rest.slice(0, cut), name = v.name ?? '';
        const evt = { actor: v.by ? { id: v.by, name: v.byName ?? '', kind: 'human' } : null, action: AUDIT_ACTION.PROJECT_PURGE, scope: AUDIT_SCOPE.PROJECT,
          project: { id: pid, name }, target: { kind: 'project', id: pid, name },
          detail: { legacy: true, code: v.code ?? null, counts: v.counts || {}, aisDeleted: v.aisDeleted || [] } };
        stmts.push([INSERT.replace('INSERT INTO', 'INSERT OR IGNORE INTO'), values(evt, 'aud_pdel_' + rest, at)], ['DELETE FROM app_settings WHERE key = ?', [key]]);
      }
      await db.batch(stmts);
    }
    if (rows.length) console.log(`舊的專案刪除紀錄轉進稽核紀錄：${rows.length} 筆`);
    return true;
  }
  return { stmt, write, list, latestForProject, migrateLegacy };
}
