// 驗收測試（#47、ADR 0004、0005）：還原備份後檢查建立專案申請，取消不再成立的待審申請
// - 檢查順序固定：資料關聯（工作區不存在、申請人不存在或關聯無效 → restore_invalid）→ 政策（不是 approval → policy_changed）
//   → 成員資格（停用 → account_disabled、不在工作區 → workspace_member_removed）；仍有效的保留待審核（申請人升為管理員也保留）
// - 已終止的申請原樣保留；已核准但找不到專案的不重新建立、不取消；不通知、不自動核准、不建立專案
// - backup.restore 稽核記下因還原而取消的數量；收尾中途失敗（檢查那一步、或稽核寫入）後重試，數量不會被錯記為零
// - 備份裡狀態或必要欄位不合法的申請列：明確的格式錯誤（400 BACKUP_ROW_INVALID），什麼都沒寫，不繞過資料庫約束
// - 舊版備份（沒有申請資料表）：還原後申請是空的，政策預設值照舊
// - 同一份資料每次還原得到相同原因
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-request-restore-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrr-'));
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const opened = [];
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
// 一個站：fail(規則) 讓下一次符合的寫入整批丟錯（資料庫照交易規則什麼都不寫）
const site = async name => {
  const db = await openTestDb(path.join(dataDir, name, 'switch.db'), { legacyProjects: false });
  opened.push(db);
  let rule = null;
  const trip = stmts => { if (rule && stmts.some(rule)) { rule = null; throw new Error('模擬的資料庫寫入失敗'); } };
  const flaky = { ...db, run: (sql, ...a) => { trip([[sql, a]]); return db.run(sql, ...a); }, batch: stmts => { trip(stmts); return db.batch(stmts); } };
  const app = createApp({ db: flaky, storage: dbStorage(db), docText: '', config: CONFIG });
  return { db, call: appCaller(app), fail: r => { rule = r; }, armed: () => !!rule };
};
async function exportAll(s, tok) {
  const info = ok(await s.call(tok, '/api/admin/backup?files=0'), '匯出清單');
  const out = { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion, tables: {} };
  for (const t of info.tables) {
    out.tables[t.name] = [];
    for (let after = 0; ;) {
      const r = ok(await s.call(tok, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=0`), t.name);
      out.tables[t.name].push(...r.rows);
      if (r.next == null) break;
      after = r.next;
    }
  }
  return out;
}
const begin = (s, tok, bk) => s.call(tok, '/api/admin/restore/begin', 'POST', { format: bk.format, formatVersion: bk.formatVersion, appVersion: bk.appVersion });
async function importRows(s, tok, bk) {
  ok(await begin(s, tok, bk), '開始匯入');
  for (const [t, rows] of Object.entries(bk.tables)) ok(await s.call(tok, '/api/admin/restore/rows', 'POST', { table: t, rows }), '匯入 ' + t);
}
const finish = (s, tok) => s.call(tok, '/api/admin/restore/finish', 'POST', {});
const newcomer = async (s, name) => (await s.call(null, '/api/join', 'POST', { name, role: 'PO' })).body;
const requests = async db => Object.fromEntries((await db.all('SELECT id, state, cancel_code, ended_at, ended_by, project_id, reject_reason FROM project_creation_requests ORDER BY id')).map(r => [r.id, { ...r }]));
const restoreAudits = db => db.all("SELECT count, detail FROM audit_log WHERE action = 'backup.restore'");
const restoring = async db => !!(await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'restore_state'"));
const n = async (db, sql, ...a) => Number((await db.get(sql, ...a)).n);
const clone = v => JSON.parse(JSON.stringify(v));

try {
  // ---------- 備份來源：approval 政策，五位申請人各有待審申請，外加各種終止的申請 ----------
  const A = await site('a');
  const join = async name => { const b = await newcomer(A, name); return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明'); // 平台管理員＋工作區管理員
  const [chen, wang, lee, zhang, hu] = [await join('陳大文'), await join('王小美'), await join('李四'), await join('張三'), await join('胡適')];
  boss.token = (await adminSession(A.call, boss.token)).token;
  const pj = (await A.db.get('SELECT id FROM projects ORDER BY created_at LIMIT 1')).id;
  for (const p of [chen, wang, lee, zhang, hu]) ok(await A.call(boss.token, `/api/participants/${p.id}/projects`, 'PUT', { projects: [pj] }), p.id + ' 加入專案');
  const ai = ok(await A.call(boss.token, '/api/my-ais', 'POST', { projects: [pj], roleKey: 'PG', role: 'PG', name: '志明的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }), 'AI');
  ok(await A.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
  let seq = 0;
  const submit = async (who, name) => (await A.call(who.token, '/api/project-creation-requests', 'POST', { requestId: `req-${++seq}`, name, reason: '要做新功能' })).body;
  const sub = {};
  for (const [key, who] of Object.entries({ chen, wang, lee, zhang, hu })) { sub[key] = await submit(who, `${key} 的專案`); assert.equal(sub[key].state, 'pending', key + ' 送出：' + JSON.stringify(sub[key])); }
  const wd = await submit(chen, '撤回的專案');
  ok(await A.call(chen.token, `/api/project-creation-requests/${wd.id}/withdraw`, 'POST', {}), '撤回');
  ok(await A.call(boss.token, `/api/participants/${hu.id}/workspace-role`, 'PUT', { role: 'admin' }), '胡適升為工作區管理員（申請保留）');
  const base = await exportAll(A, boss.token);
  const projectsInBackup = base.tables.projects.length;

  // 備份資料（模擬不同時間點、或被動過的備份）：停用、移出、關聯無效、各種終止狀態
  const backup = clone(base);
  const T = backup.tables;
  const P = T.participants, accountOf = id => T.accounts.find(a => a.id === P.find(p => p.id === id).account_id);
  accountOf(wang.id).status = 'disabled'; // 帳號停用 → account_disabled
  Object.assign(P.find(p => p.id === lee.id), { status: 'disabled', workspace_status: 'removed' }); // 停用又被移出：先看停用 → account_disabled
  P.find(p => p.id === zhang.id).workspace_status = 'removed'; // 不在工作區 → workspace_member_removed
  const shape = T.project_creation_requests.find(r => r.id === sub.chen.id);
  const row = (id, extra) => ({ ...shape, id, request_id: 'r-' + id, name: '專案 ' + id, ...extra });
  const at = '2026-01-02T00:00:00.000Z';
  T.project_creation_requests.push(
    row('pcr_nows', { workspace_id: 'ws_gone' }), // 工作區不存在
    row('pcr_ghost', { requester_id: 'p_ghost' }), // 申請人不存在
    row('pcr_ai', { requester_id: ai.participantId }), // 申請人不是人類
    row('pcr_nows_disabled', { workspace_id: 'ws_gone', requester_id: lee.id }), // 關聯無效又停用：先看關聯 → restore_invalid
    row('pcr_approved_gone', { state: 'approved', ended_at: at, ended_by: boss.id, project_id: 'p_gone' }), // 已核准、專案找不到：不重建、不取消
    row('pcr_rejected', { state: 'rejected', ended_at: at, ended_by: boss.id, reject_reason: '再想想' }),
    row('pcr_cancelled', { state: 'cancelled', ended_at: at, cancel_code: 'workspace_member_left' }),
    row('pcr_withdrawn_ghost', { requester_id: 'p_ghost', state: 'withdrawn', ended_at: at, ended_by: 'p_ghost' }), // 終止的申請就算關聯無效也不動
  );
  const expectPending = [sub.chen.id, sub.hu.id];
  const expectCancelled = { [sub.wang.id]: 'account_disabled', [sub.lee.id]: 'account_disabled', [sub.zhang.id]: 'workspace_member_removed',
    pcr_nows: 'restore_invalid', pcr_ghost: 'restore_invalid', pcr_ai: 'restore_invalid', pcr_nows_disabled: 'restore_invalid' };
  const terminal = Object.fromEntries(T.project_creation_requests.filter(r => r.state !== 'pending').map(r => [r.id, r]));
  const CANCELLED = Object.keys(expectCancelled).length;

  async function checkOutcome(s, label, { cancelled = expectCancelled, pending = expectPending } = {}) {
    const got = await requests(s.db);
    for (const id of pending) assert.deepEqual([got[id].state, got[id].ended_at, got[id].cancel_code], ['pending', null, null], `${label}：${id} 仍待審核`);
    for (const [id, code] of Object.entries(cancelled)) {
      assert.deepEqual([got[id].state, got[id].cancel_code, got[id].ended_by, got[id].project_id], ['cancelled', code, null, null], `${label}：${id} 取消（${code}）：${JSON.stringify(got[id])}`);
      assert.ok(got[id].ended_at, `${label}：${id} 有結束時間`);
    }
    for (const [id, r] of Object.entries(terminal)) {
      const g = got[id];
      assert.deepEqual([g.state, g.ended_at, g.ended_by ?? null, g.cancel_code ?? null, g.project_id ?? null, g.reject_reason ?? null],
        [r.state, r.ended_at, r.ended_by ?? null, r.cancel_code ?? null, r.project_id ?? null, r.reject_reason ?? null], `${label}：終止的 ${id} 原樣保留`);
    }
    assert.equal(Object.keys(got).length, T.project_creation_requests.length, `${label}：申請一份不多不少`);
    assert.equal(await n(s.db, 'SELECT COUNT(*) AS n FROM projects'), projectsInBackup, `${label}：沒有建立任何專案（已核准但找不到專案的也不重建）`);
    assert.equal(await n(s.db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind LIKE 'project_creation_request%'"), 0, `${label}：不通知任何人`);
  }
  const auditOk = async (s, label, count) => {
    const audits = await restoreAudits(s.db);
    assert.equal(audits.length, 1, `${label}：backup.restore 只有一筆`);
    assert.equal(Number(audits[0].count), count, `${label}：稽核記下因還原而取消的數量`);
    assert.equal(JSON.parse(audits[0].detail).counted, 'cancelledProjectCreationRequests', `${label}：稽核標明數的是取消的建立專案申請`);
  };

  // ---------- 1) approval 政策的備份：依固定順序取消不再成立的，有效的保留 ----------
  {
    const B = await site('b');
    const me = await newcomer(B, '新站管理員');
    await importRows(B, me.token, backup);
    const r = ok(await finish(B, me.token), '收尾');
    assert.equal(r.cancelledProjectCreationRequests, CANCELLED, '收尾回應：因還原而取消的數量');
    await checkOutcome(B, '1');
    await auditOk(B, '1', CANCELLED);
    // 還原後：仍待審的申請人照樣是有效的申請人（政策仍是 approval）
    assert.equal((await B.db.get("SELECT create_projects FROM workspaces WHERE id = 'default'")).create_projects, 'approval', '政策照備份');
    // 「要你處理」：審核人（登入已改掛到備份裡的平台管理員）只看到仍有效的待審申請，而且每一份都能核准並建立專案
    const todo = ok(await B.call(me.token, '/api/project-creation-requests?scope=review&state=pending'), '審核清單');
    assert.deepEqual([todo.pendingTotal, todo.items.map(i => i.id).sort()], [expectPending.length, [...expectPending].sort()], '要你處理：只有仍有效的待審申請');
    for (const id of expectPending) assert.equal(ok(await B.call(me.token, `/api/project-creation-requests/${id}/approve`, 'POST', {}), '核准 ' + id).state, 'approved', `還原後留下的 ${id} 能核准`);
    assert.equal(await n(B.db, 'SELECT COUNT(*) AS n FROM projects'), projectsInBackup + expectPending.length, '核准後才建立專案');
    console.log('✓ approval 備份：關聯無效 → restore_invalid、停用 → account_disabled、移出 → workspace_member_removed；有效與升管理員的保留；終止的原樣；不建專案、不通知');
  }

  // ---------- 2) 政策不是 approval 的備份：關聯無效先，其餘一律 policy_changed（政策先於成員資格） ----------
  {
    const bk = clone(backup);
    bk.tables.workspaces.find(w => w.id === 'default').create_projects = 'admins';
    const B = await site('b2');
    const me = await newcomer(B, '新站管理員');
    await importRows(B, me.token, bk);
    ok(await finish(B, me.token), '收尾');
    const policy = Object.fromEntries([sub.chen.id, sub.hu.id, sub.wang.id, sub.lee.id, sub.zhang.id].map(id => [id, 'policy_changed']));
    await checkOutcome(B, '2', { pending: [], cancelled: { ...policy, pcr_nows: 'restore_invalid', pcr_ghost: 'restore_invalid', pcr_ai: 'restore_invalid', pcr_nows_disabled: 'restore_invalid' } });
    await auditOk(B, '2', CANCELLED + 2);
    console.log('✓ 政策不是 approval：關聯無效 → restore_invalid，其他待審 → policy_changed（停用、移出的也是）');
  }

  // ---------- 3) 收尾中途失敗後重試：檢查那一步失敗什麼都不取消；稽核寫入失敗後重試，數量不記成零；同一份資料原因相同 ----------
  {
    const C = await site('c');
    const me = await newcomer(C, '新站管理員');
    await importRows(C, me.token, backup);
    C.fail(s => /UPDATE project_creation_requests SET state = 'cancelled'/.test(s[0]));
    let r = await finish(C, me.token);
    assert.ok(!C.armed(), '失敗真的發生在檢查待審申請');
    assert.deepEqual([r.status, r.body?.error?.code], [503, 'RESTORE_UNFINISHED'], '檢查失敗：收尾沒做完：' + JSON.stringify(r.body));
    assert.equal(await restoring(C.db), true, '維持還原中');
    assert.equal(await n(C.db, "SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'cancelled' AND id NOT IN ('pcr_cancelled')"), 0, '檢查那一批整批沒做：一份都沒取消');
    C.fail(s => /INSERT INTO audit_log/i.test(s[0]) && (s[1] || []).includes('backup.restore'));
    r = await finish(C, me.token);
    assert.ok(!C.armed(), '失敗真的發生在稽核寫入');
    assert.deepEqual([r.status, r.body?.error?.code], [503, 'RESTORE_UNFINISHED'], '稽核失敗：收尾沒做完');
    assert.equal(await restoring(C.db), true, '維持還原中');
    assert.equal(await n(C.db, "SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'"), expectPending.length, '檢查那一步已經做完（取消已提交）');
    assert.equal((await restoreAudits(C.db)).length, 0, '還沒有稽核');
    r = ok(await finish(C, me.token), '重試收尾');
    assert.equal(r.cancelledProjectCreationRequests, CANCELLED, '重試的回應：取消數是第一次實際取消的（不是零）');
    await checkOutcome(C, '3');
    await auditOk(C, '3', CANCELLED);
    console.log('✓ 收尾中途失敗後重試：取消數與稽核正確（不記成零）；同一份資料每次還原原因相同');
  }

  // ---------- 4) 備份裡不合法的申請列：明確的格式錯誤，什麼都沒寫 ----------
  {
    const E = await site('e');
    const me = await newcomer(E, '新站管理員');
    const bk = clone(base);
    delete bk.tables.project_creation_requests;
    await importRows(E, me.token, bk);
    const good = clone(shape);
    const bad = {
      不認得的狀態: { ...good, state: 'approving' },
      沒有狀態: { ...good, state: null },
      缺名稱: { ...good, name: null },
      空白名稱: { ...good, name: '  ' },
      缺申請人: { ...good, requester_id: undefined },
      不認得的可見度: { ...good, visibility: 'secret' },
      待審卻有結束時間: { ...good, ended_at: at },
      核准卻沒有專案: { ...good, state: 'approved', ended_at: at, ended_by: boss.id },
      拒絕卻沒有理由: { ...good, state: 'rejected', ended_at: at, ended_by: boss.id, reject_reason: ' ' },
      撤回的人不是申請人: { ...good, state: 'withdrawn', ended_at: at, ended_by: boss.id },
      不認得的取消原因: { ...good, state: 'cancelled', ended_at: at, cancel_code: 'because' },
      取消卻記了操作者: { ...good, state: 'cancelled', ended_at: at, ended_by: boss.id, cancel_code: 'policy_changed' },
      同名的待審申請兩份: [good, { ...good, id: 'pcr_dup', request_id: 'r-dup' }],
    };
    for (const [why, rows] of Object.entries(bad)) {
      const r = await E.call(me.token, '/api/admin/restore/rows', 'POST', { table: 'project_creation_requests', rows: [].concat(rows) });
      assert.deepEqual([r.status, r.body?.error?.code], [400, 'BACKUP_ROW_INVALID'], `${why}：明確的格式錯誤：${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(String(r.body.error.message).includes('project_creation_requests'), `${why}：錯誤說明是哪張表：${r.body.error.message}`);
      assert.equal(await n(E.db, 'SELECT COUNT(*) AS n FROM project_creation_requests'), 0, `${why}：什麼都沒寫`);
    }
    ok(await E.call(me.token, '/api/admin/restore/rows', 'POST', { table: 'project_creation_requests', rows: [good] }), '合法的列照常匯入');
    assert.equal(await n(E.db, 'SELECT COUNT(*) AS n FROM project_creation_requests'), 1);
    console.log('✓ 不合法的申請列：明確的格式錯誤（BACKUP_ROW_INVALID），什麼都沒寫');
  }

  // ---------- 5) 沒有申請資料表的備份：還原後申請是空的、政策照舊 ----------
  {
    const bk = clone(base);
    delete bk.tables.project_creation_requests;
    bk.tables.workspaces.find(w => w.id === 'default').create_projects = 'members';
    const F = await site('f');
    const me = await newcomer(F, '新站管理員');
    await importRows(F, me.token, bk);
    ok(await finish(F, me.token), '收尾');
    assert.equal(await n(F.db, 'SELECT COUNT(*) AS n FROM project_creation_requests'), 0, '沒有申請資料表的備份：申請是空的');
    assert.equal((await F.db.get("SELECT create_projects FROM workspaces WHERE id = 'default'")).create_projects, 'members', '政策照備份');
    await auditOk(F, '5', 0);
    // 第一階段之前的備份（1.0.7：沒有 workspaces、accounts、申請）：申請是空的，政策是升級的站的預設值（只有管理員）
    const G = await site('g');
    const me2 = await newcomer(G, '新站管理員');
    const d = x => `2026-01-0${x}T00:00:00.000Z`;
    await importRows(G, me2.token, { format: 'aigile-backup', formatVersion: 1, appVersion: '1.0.7', tables: {
      projects: [{ id: '預設專案', name: '預設專案', archived: 0, created_by: null, created_at: d(1) }],
      participants: [{ id: 'p_boss', kind: 'human', name: '林老闆', role: 'PO', role_key: '', code: 'BOSS', owner_id: null, status: 'active', version: 1, created_at: d(2), updated_at: d(2), last_seen_at: 0, standby_at: 0, is_admin: 1, projects: '預設專案' }],
    } });
    ok(await finish(G, me2.token), '舊版收尾');
    assert.equal(await n(G.db, 'SELECT COUNT(*) AS n FROM project_creation_requests'), 0, '舊版備份：申請是空的');
    assert.equal((await G.db.get("SELECT create_projects FROM workspaces WHERE id = 'default'")).create_projects, 'admins', '舊版備份：政策是升級的預設值');
    await auditOk(G, '5（舊版）', 0);
    console.log('✓ 沒有申請資料表的備份：申請是空的、政策預設值照舊');
  }
  console.log('project-creation-request-restore-test：全部通過');
} catch (e) {
  console.error('project-creation-request-restore-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const db of opened) await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
