// 驗收測試：可重試的備份還原收尾（#41；docs/adr/0005）
// A. 收尾的修整步驟中途失敗：「還原中」保留、回錯誤；這時建立專案、改名、政策更新在交易內被擋（503 RESTORING）；
//    再按一次收尾從頭重跑成功，結果跟一次成功一樣，backup.restore 稽核只有一筆、內容正確
// B. 收尾的稽核寫入失敗：一樣保留「還原中」、沒有稽核；重試後只有一筆
// 模擬寫入失敗：包一層資料庫，指定的那一次寫入丟錯（資料庫照交易規則整批不寫）。
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。本機暫存資料庫，不連任何站。用法：node scripts/restore-finish-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { appCaller } from './test-call.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rfin-'));
const opened = [];
// 一個站：fail(規則) 讓下一次符合的寫入丟錯；trace 記下所有寫入（run、batch 各一筆，內容是 SQL 清單）
const site = async name => {
  const db = await openTestDb(path.join(dataDir, name + '.db'), { legacyProjects: false });
  opened.push(db);
  let rule = null;
  const trace = [];
  const trip = (kind, stmts) => {
    trace.push({ kind, sqls: stmts.map(s => s[0]), args: stmts.map(s => s[1] || []) });
    if (rule && stmts.some(rule)) { rule = null; throw new Error('模擬的資料庫寫入失敗'); }
  };
  const flaky = { ...db,
    run: (sql, ...a) => { trip('run', [[sql, a]]); return db.run(sql, ...a); },
    batch: stmts => { trip('batch', stmts); return db.batch(stmts); } };
  const app = createApp({ db: flaky, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1' } });
  return { db, call: appCaller(app), trace, fail: r => { rule = r; }, armed: () => !!rule };
};
const sqlIs = re => s => re.test(s[0]);
const restoreAudits = db => db.all("SELECT actor_id, actor_name, detail FROM audit_log WHERE action = 'backup.restore'");
const restoring = async db => !!(await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'restore_state'"));

async function exportAll(s, tok) {
  const info = (await s.call(tok, '/api/admin/backup?files=0')).body;
  const out = { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion, tables: {} };
  for (const t of info.tables) {
    out.tables[t.name] = [];
    for (let after = 0; ;) {
      const r = await s.call(tok, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=0`);
      assert.equal(r.status, 200, t.name + JSON.stringify(r.body));
      out.tables[t.name].push(...r.body.rows);
      if (r.body.next == null) break;
      after = r.body.next;
    }
  }
  return out;
}
async function importRows(s, tok, bk) {
  const r = await s.call(tok, '/api/admin/restore/begin', 'POST', { format: bk.format, formatVersion: bk.formatVersion, appVersion: bk.appVersion });
  assert.equal(r.status, 200, '開始匯入：' + JSON.stringify(r.body));
  for (const [t, rows] of Object.entries(bk.tables)) {
    const w = await s.call(tok, '/api/admin/restore/rows', 'POST', { table: t, rows });
    assert.equal(w.status, 200, t + JSON.stringify(w.body));
  }
}
const finish = (s, tok) => s.call(tok, '/api/admin/restore/finish', 'POST', {});

// 「還原中」時會動到共同不變量的寫入：交易內斷言不在還原中，回 503（可重試），什麼都沒寫
async function sharedWritesBlocked(s, tok, pj, why) {
  const before = (await s.db.get('SELECT COUNT(*) AS n FROM projects')).n, name = (await s.db.get('SELECT name FROM projects WHERE id = ?', pj)).name;
  const create = await s.call(tok, '/api/projects', 'POST', { name: '還原中建的專案' });
  assert.deepEqual([create.status, create.body?.error?.code], [503, 'RESTORING'], why + '：建立專案回 503：' + JSON.stringify(create.body));
  const rename = await s.call(tok, `/api/projects/${encodeURIComponent(pj)}`, 'PATCH', { name: '還原中改的名字' });
  assert.deepEqual([rename.status, rename.body?.error?.code], [503, 'RESTORING'], why + '：改名回 503：' + JSON.stringify(rename.body));
  const was = (await s.db.get('SELECT create_projects FROM workspaces')).create_projects, flip = was === 'members' ? 'admins' : 'members';
  const policy = await s.call(tok, '/api/workspace/settings', 'PUT', { createProjects: flip });
  assert.deepEqual([policy.status, policy.body?.error?.code], [503, 'RESTORING'], why + '：政策更新回 503：' + JSON.stringify(policy.body));
  assert.equal((await s.db.get('SELECT COUNT(*) AS n FROM projects')).n, before, why + '：沒有多出專案');
  assert.equal((await s.db.get('SELECT name FROM projects WHERE id = ?', pj))?.name, name, why + '：名字沒改');
  assert.equal((await s.db.get('SELECT create_projects FROM workspaces')).create_projects, was, why + '：政策沒改');
}

try {
  // ---- 站 A：備份來源 ----
  const A = await site('a');
  const boss = (await A.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body; // 第一位＝平台管理員兼工作區管理員
  const chen = (await A.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  assert.equal((await A.call(boss.token, '/api/projects', 'POST', { name: '搬家專案' })).status, 201);
  const pj = (await A.db.get("SELECT id FROM projects WHERE name = '搬家專案'")).id;
  const ai = (await A.call(boss.token, '/api/my-ais', 'POST', { projects: [pj], roleKey: 'PG', role: 'PG', name: '小明的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.ok(ai.participantId, JSON.stringify(ai));
  const backup = await exportAll(A, boss.token);
  const BOSS = boss.participant.participantId, CHEN = chen.participant.participantId;

  // ---- A. 修整步驟（成員與帳號轉換之後的成員資料修整）失敗 ----
  {
    const B = await site('b');
    const me = (await B.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
    const ME = me.participant.participantId;
    await importRows(B, me.token, backup);
    B.fail(sqlIs(/UPDATE projects SET workspace_id = \? WHERE workspace_id IS NULL/)); // 成員資料修整的第一批
    const bad = await finish(B, me.token);
    assert.ok(!B.armed(), '失敗真的發生在修整步驟');
    assert.ok(bad.status >= 500, '收尾失敗回錯誤：' + bad.status + JSON.stringify(bad.body));
    assert.equal(await restoring(B.db), true, 'A：「還原中」保留');
    assert.equal((await restoreAudits(B.db)).length, 0, 'A：還沒有 backup.restore 稽核');
    // 登入已經轉到備份裡的管理員（收尾的第一段已完成），重試照樣用同一個登入碼
    assert.equal((await B.call(me.token, '/api/me')).body.participantId, BOSS, 'A：登入已轉到備份裡的管理員');
    const st = (await B.call(me.token, '/api/admin/backup/status')).body;
    assert.deepEqual([st.restoring, st.finishing], [true, true], 'A：狀態是還原中、只差收尾：' + JSON.stringify(st));
    await sharedWritesBlocked(B, me.token, pj, 'A');
    const again = await B.call(me.token, '/api/admin/restore/begin', 'POST', { format: backup.format, formatVersion: backup.formatVersion, appVersion: backup.appVersion });
    assert.equal(again.body?.error?.code, 'RESTORE_FINISHING', 'A：只差收尾時不能從頭匯入（資料已轉移）：' + JSON.stringify(again.body));

    const ok = await finish(B, me.token);
    assert.equal(ok.status, 200, 'A：重試收尾成功：' + JSON.stringify(ok.body));
    assert.deepEqual(ok.body.admin, { participantId: BOSS, name: '王小明' }, 'A：管理員是備份裡的');
    assert.deepEqual([ok.body.humans, ok.body.ais], [2, 1], 'A：人數');
    assert.equal(await restoring(B.db), false, 'A：解除還原中');
    const audits = await restoreAudits(B.db);
    assert.equal(audits.length, 1, 'A：backup.restore 只有一筆');
    assert.deepEqual([audits[0].actor_id, audits[0].actor_name], [ME, '新站管理員'], 'A：操作者是按還原的人（開始匯入時的身分與名字）');
    assert.deepEqual(JSON.parse(audits[0].detail), { appVersion: backup.appVersion, humans: 2, ais: 1 }, 'A：稽核內容正確');
    // 既有行為不變：其他人類要重設登入、自己不用；舊的登入不能用；流水號接續
    const ppl = (await B.call(me.token, '/api/participants')).body.items;
    assert.equal(ppl.find(p => p.participantId === CHEN)?.needsLogin, true, 'A：其他人類標要重設登入');
    assert.ok(!ppl.find(p => p.participantId === BOSS)?.needsLogin, 'A：自己不標');
    assert.equal((await B.call(chen.token, '/api/me')).status, 401, 'A：其他人的舊登入不能用');
    assert.equal(await B.db.get('SELECT 1 AS x FROM participants WHERE id = ?', ME), undefined, 'A：暫時的你刪掉了');
    const msg = await B.call(me.token, '/api/messages', 'POST', { requestId: 'after', project: pj, text: '還原後第一則' });
    assert.equal(msg.status, 201, 'A：還原後能發文（流水號接續）：' + JSON.stringify(msg.body));
    // 恢復正常操作：共同不變量的寫入不再被擋
    assert.equal((await B.call(me.token, '/api/projects', 'POST', { name: '還原後的專案' })).status, 201, 'A：還原完成後能建立專案');
    // 再按一次收尾：不重複
    assert.equal((await finish(B, me.token)).body?.error?.code, 'NOT_RESTORING', 'A：已完成的還原不能再收尾');
    assert.equal((await restoreAudits(B.db)).length, 1, 'A：稽核還是一筆');
  }

  // ---- B. 收尾的稽核寫入失敗 ----
  {
    const C = await site('c');
    const me = (await C.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
    await importRows(C, me.token, backup);
    C.fail(s => /INSERT INTO audit_log/i.test(s[0]) && (s[1] || []).includes('backup.restore'));
    const bad = await finish(C, me.token);
    assert.ok(!C.armed(), '失敗真的發生在稽核寫入');
    assert.ok(bad.status >= 500, 'B：收尾失敗回錯誤：' + bad.status);
    assert.equal(await restoring(C.db), true, 'B：「還原中」保留');
    assert.equal((await restoreAudits(C.db)).length, 0, 'B：沒有稽核');
    await sharedWritesBlocked(C, me.token, pj, 'B');
    const ok = await finish(C, me.token);
    assert.equal(ok.status, 200, 'B：重試收尾成功：' + JSON.stringify(ok.body));
    assert.equal(await restoring(C.db), false, 'B：解除還原中');
    const audits = await restoreAudits(C.db);
    assert.equal(audits.length, 1, 'B：backup.restore 只有一筆');
    assert.deepEqual(JSON.parse(audits[0].detail), { appVersion: backup.appVersion, humans: 2, ais: 1 }, 'B：稽核內容正確');
  }
  // ---- C. 舊版備份（第一階段之前）：成員資料轉換做到一半失敗（每個人已轉、跨專案角色還沒轉），重試後跟一次成功一樣 ----
  {
    const D = await site('d');
    const P1 = '預設專案', P2 = '第二專案';
    const at = d => `2026-01-0${d}T00:00:00.000Z`;
    const person = (id, name, d, extra) => ({ id, kind: 'human', name, role: 'PG', role_key: '', code: id.slice(2, 6).toUpperCase(), owner_id: null, status: 'active', version: 1, created_at: at(d), updated_at: at(d), last_seen_at: 0, standby_at: 0, ...extra });
    const old = { format: 'aigile-backup', formatVersion: 1, appVersion: '1.0.7', tables: {
      projects: [{ id: P1, name: P1, archived: 0, created_by: null, created_at: at(1) }, { id: P2, name: P2, archived: 0, created_by: null, created_at: at(1) }],
      app_settings: [{ key: 'project_leaders', value: JSON.stringify({ [P1]: ['p_lead'] }) }, { key: 'read_only', value: JSON.stringify({ [P2]: ['p_ro'] }) }],
      participants: [
        person('p_lead', '李帶頭', 2, { is_admin: 0, projects: P1 }), // 最早加入的不是管理員
        person('p_boss', '林老闆', 3, { is_admin: 1, projects: `${P1},${P2}` }),
        person('p_ro', '陳唯讀', 4, { is_admin: 0, projects: `${P1},${P2}` }),
        person('p_sm', '張敘事', 5, { is_admin: 0, projects: P1, role: 'SM' }), // 舊的跨專案角色：每個未封存專案都是成員
      ] } };
    const me = (await D.call(null, '/api/join', 'POST', { name: '匯入的人', role: 'PO' })).body;
    await importRows(D, me.token, old);
    D.fail(sqlIs(/INSERT OR IGNORE INTO project_members \(project_id, participant_id, role\) SELECT json_extract\(value, '\$\.p'\), json_extract\(value, '\$\.id'\)/)); // 跨專案角色那一批
    const bad = await finish(D, me.token);
    assert.ok(!D.armed(), 'C：失敗真的發生在跨專案角色轉換');
    assert.ok(bad.status >= 500, 'C：收尾失敗回錯誤');
    assert.equal(await restoring(D.db), true, 'C：「還原中」保留');
    await sharedWritesBlocked(D, me.token, P1, 'C');
    const ok = await finish(D, me.token);
    assert.equal(ok.status, 200, 'C：重試收尾成功：' + JSON.stringify(ok.body));
    assert.equal(ok.body.admin.participantId, 'p_boss', 'C：接上備份裡的管理員（看 is_admin）');
    const tok = me.token;
    const pr = (await D.call(tok, '/api/projects')).body;
    assert.deepEqual(pr.projectAdmins[P1], ['p_lead'], 'C：負責人＝專案管理員');
    assert.deepEqual(pr.viewers[P2], ['p_ro'], 'C：唯讀＝唯讀成員');
    const people = new Map((await D.call(tok, '/api/participants')).body.items.map(p => [p.participantId, p]));
    assert.deepEqual([...people.get('p_sm').projects].sort(), [P1, P2].sort(), 'C：舊的跨專案角色重試後照樣轉成每個專案的成員');
    assert.deepEqual([...people.values()].filter(p => p.workspaceRole === 'admin').map(p => p.participantId), ['p_boss'], 'C：只有一位工作區管理員');
    assert.equal(people.get('p_lead').needsLogin, true, 'C：其他人類要重設登入');
    assert.equal((await D.db.get('SELECT COUNT(*) AS n FROM legacy_members')).n, 0, 'C：舊資料轉完就刪');
    assert.deepEqual((await D.db.all("SELECT key FROM app_settings WHERE key IN ('project_leaders', 'read_only', 'cross_roles')")).map(r => r.key), [], 'C：舊設定刪了');
    assert.equal((await restoreAudits(D.db)).length, 1, 'C：backup.restore 只有一筆');
  }

  // ---- D. 順序：開始匯入只清快取；收尾是 登入轉移 → 修整步驟 → 稽核＋解除還原中（同一批）→ 清快取 ----
  {
    const E = await site('e');
    const me = (await E.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
    await E.call(me.token, '/api/me'); // 升級轉換已在前面的請求做完
    const repair = s => /UPDATE projects SET workspace_id = \? WHERE workspace_id IS NULL|INSERT OR IGNORE INTO workspaces|FROM app_settings WHERE key >= \?|INSERT OR IGNORE INTO project_members|DELETE FROM app_settings WHERE key IN \('project_leaders'/.test(s);
    let from = E.trace.length;
    const begin = await E.call(me.token, '/api/admin/restore/begin', 'POST', { format: backup.format, formatVersion: backup.formatVersion, appVersion: backup.appVersion });
    assert.equal(begin.status, 200);
    const beginWrites = E.trace.slice(from).flatMap(t => t.sqls);
    assert.ok(/^UPDATE workspaces SET name = name/.test(beginWrites[0]), '開始匯入：第一句鎖工作區（跟共同不變量的寫入排隊）');
    assert.deepEqual(beginWrites.filter(repair), [], '開始匯入：只清快取，不做任何資料修整：' + beginWrites.filter(repair).join(' | '));
    for (const [t, rows] of Object.entries(backup.tables)) assert.equal((await E.call(me.token, '/api/admin/restore/rows', 'POST', { table: t, rows })).status, 200);
    from = E.trace.length;
    assert.equal((await finish(E, me.token)).status, 200);
    const w = E.trace.slice(from).flatMap((t, b) => t.sqls.map((sql, i) => ({ sql, args: t.args[i], b })));
    const first = re => w.findIndex(x => re.test(x.sql));
    const transfer = first(/^UPDATE credentials SET participant_id/), steps = first(/UPDATE projects SET workspace_id = \? WHERE workspace_id IS NULL/);
    const audit = w.findIndex(x => /INSERT INTO audit_log/.test(x.sql) && x.args.includes('backup.restore'));
    const release = w.findIndex(x => /^DELETE FROM app_settings WHERE key = \?/.test(x.sql) && x.args[0] === 'restore_state');
    const caches = w.findIndex((x, i) => i > release && /people_ver/.test(x.sql));
    assert.ok(transfer >= 0 && transfer < steps && steps < audit && audit < release && release < caches,
      `收尾順序：登入轉移 ${transfer} < 修整 ${steps} < 稽核 ${audit} < 解除還原中 ${release} < 清快取 ${caches}`);
    assert.equal(w[audit].b, w[release].b, '稽核跟解除還原中同一批');
    assert.ok(!w.slice(0, transfer).some(x => /restore_state/.test(x.sql) && /DELETE/.test(x.sql)), '登入轉移之前沒有解除還原中');
  }
  console.log('restore-finish-test：全部通過');
} catch (e) {
  console.error('restore-finish-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const db of opened) await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
