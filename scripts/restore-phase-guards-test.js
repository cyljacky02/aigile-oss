// 驗收測試（ADR 0005）：備份還原的每一段在交易內確認自己仍在該做的階段，交易前讀到的狀態不算數
// 1. 開始匯入：交易前是空站，寫入前剛好有人加入 → 409 NOT_EMPTY，什麼都沒清
// 2. 匯入資料列：交易前還在匯入，寫入前收尾已經做完 → 不寫（409），資料列不會在收尾之後才進來
// 3. 收尾的登入轉移：比對的是這次收尾開始時讀到的 restore_state；中間被別的收尾改過 → 409，不蓋掉別人寫的
// 4. 識別碼正規化：交易內確認快照的值沒變（不只是數量），變了就重讀重算，不會寫出重複的代號
// 做法：攔下讀取或寫入，中間插入別的操作或直接改資料（SQLite、D1 一次只做一個交易，這就是會發生的交錯）。
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/restore-phase-guards-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { createProjectIdentity, IDENTITY_READY_KEY } from '../src/project-identity.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rguard-'));
const opened = [];
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1', joinLimitPerHour: '100000' };
// 一個站：hooks.batch＝下一個含有符合 re 那句的寫入送出前先執行 run()；hooks.get、hooks.all＝下一個符合 re（與參數 arg）的讀取讀完後先執行 run()（都只作用一次）
async function site(name, opts = { legacyProjects: false }) {
  const db = await openTestDb(path.join(dataDir, name + '.db'), opts);
  opened.push(db);
  const hooks = { batch: null, get: null, all: null };
  const fire = async (slot, sql, args) => { const h = hooks[slot]; if (h && h.re.test(sql) && (h.arg === undefined || args.includes(h.arg))) { hooks[slot] = null; await h.run(); } };
  const wrapped = { ...db,
    batch: async stmts => { const h = hooks.batch; if (h && stmts.some(([sql]) => h.re.test(sql))) { hooks.batch = null; await h.run(); } return db.batch(stmts); },
    get: async (sql, ...args) => { const out = await db.get(sql, ...args); await fire('get', sql, args); return out; },
    all: async (sql, ...args) => { const out = await db.all(sql, ...args); await fire('all', sql, args); return out; } };
  return { db, wrapped, hooks, call: appCaller(createApp({ db: wrapped, storage: dbStorage(db), docText: '', config: CONFIG })) };
}
const code = r => r.body?.error?.code;
const is = (r, status, errCode, label) => { assert.equal(r.status, status, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); if (errCode) assert.equal(code(r), errCode, label); return r.body; };
const n = async (db, sql, ...a) => Number((await db.get(sql, ...a)).n);
const stateOf = async db => (await db.get("SELECT value FROM app_settings WHERE key = 'restore_state'"))?.value ?? null;

async function exportAll(s, tok) {
  const info = (await s.call(tok, '/api/admin/backup?files=0')).body;
  const out = { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion, tables: {} };
  for (const t of info.tables) {
    out.tables[t.name] = [];
    for (let after = 0; ;) {
      const r = await s.call(tok, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=0`);
      out.tables[t.name].push(...r.body.rows);
      if (r.body.next == null) break;
      after = r.body.next;
    }
  }
  return out;
}
const head = bk => ({ format: bk.format, formatVersion: bk.formatVersion, appVersion: bk.appVersion });
const upload = (s, tok, t, rows) => s.call(tok, '/api/admin/restore/rows', 'POST', { table: t, rows });

try {
  // 備份來源
  const A = await site('a');
  const boss = (await A.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  await A.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' });
  is(await A.call(boss.token, '/api/projects', 'POST', { name: '搬家專案' }), 201, null, '建立專案');
  const backup = await exportAll(A, boss.token);
  assert.ok(backup.tables.project_events.length > 0, '備份裡有專案事件');

  // 1) 開始匯入：交易前是空站，寫入前剛好有人加入 → 409 NOT_EMPTY，什麼都沒清、沒有進入還原中
  {
    const B = await site('b1');
    const me = (await B.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
    let late = null;
    B.hooks.batch = { re: /^DELETE FROM participants WHERE id != \?/, run: async () => { late = (await B.call(null, '/api/join', 'POST', { name: '剛加入的人', role: 'PG' })).body; } };
    const r = await B.call(me.token, '/api/admin/restore/begin', 'POST', head(backup));
    assert.equal(B.hooks.batch, null, '真的有交錯');
    is(r, 409, 'NOT_EMPTY', '寫入前已經不是空站');
    assert.equal(await stateOf(B.db), null, '沒有進入還原中');
    assert.ok(await B.db.get('SELECT 1 AS x FROM participants WHERE id = ?', late.participant.participantId), '剛加入的人還在');
    console.log('✓ 開始匯入：寫入前剛好有人加入 → 409，什麼都沒清');
  }

  // 2) 匯入資料列：交易前還在匯入，寫入前收尾已經做完 → 409，這批沒寫
  {
    const B = await site('b2');
    const me = (await B.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
    is(await B.call(me.token, '/api/admin/restore/begin', 'POST', head(backup)), 200, null, '開始匯入');
    for (const [t, rows] of Object.entries(backup.tables)) if (t !== 'project_events') is(await upload(B, me.token, t, rows), 200, null, `匯入 ${t}`);
    const events = await n(B.db, 'SELECT COUNT(*) AS n FROM project_events');
    let fin = null;
    B.hooks.batch = { re: /^INSERT INTO project_events/, run: async () => { fin = await B.call(me.token, '/api/admin/restore/finish', 'POST', {}); } };
    const r = await upload(B, me.token, 'project_events', backup.tables.project_events);
    assert.equal(B.hooks.batch, null, '真的有交錯');
    is(fin, 200, null, '中間的收尾');
    assert.equal(r.status, 409, '收尾之後才到的資料列：' + JSON.stringify(r.body));
    assert.equal(await n(B.db, 'SELECT COUNT(*) AS n FROM project_events'), events, '這批沒寫');
    console.log('✓ 匯入資料列：寫入前收尾已經做完 → 409，沒寫');
  }

  // 3) 收尾的登入轉移：讀到 restore_state 之後、轉移之前，它被別的收尾改了 → 409 CONFLICT，不蓋掉別人寫的
  {
    const B = await site('b3');
    const me = (await B.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
    is(await B.call(me.token, '/api/admin/restore/begin', 'POST', head(backup)), 200, null, '開始匯入');
    for (const [t, rows] of Object.entries(backup.tables)) is(await upload(B, me.token, t, rows), 200, null, `匯入 ${t}`);
    let changed = null;
    B.hooks.get = { re: /^SELECT value FROM app_settings WHERE key = \?$/, arg: 'restore_state', run: async () => {
      changed = JSON.stringify({ ...JSON.parse(await stateOf(B.db)), byOtherFinish: true });
      await B.db.run("UPDATE app_settings SET value = ? WHERE key = 'restore_state'", changed);
    } };
    const r = await B.call(me.token, '/api/admin/restore/finish', 'POST', {});
    assert.equal(B.hooks.get, null, '真的有交錯');
    is(r, 409, 'CONFLICT', '讀到之後被改過');
    assert.equal(await stateOf(B.db), changed, '別人寫的 restore_state 沒被蓋掉');
    assert.ok(await B.db.get('SELECT 1 AS x FROM participants WHERE id = ?', me.participant.participantId), '登入沒有轉移（暫時的你還在）');
    console.log('✓ 收尾的登入轉移：比對這次讀到的 restore_state，被改過就 409');
  }

  // 4) 識別碼正規化：快照之後別的專案的代號剛好改成這次要替沒存代號的專案推導出來的值（數量沒變）→ 重讀重算，不寫出重複的代號
  {
    const db = await openTestDb(path.join(dataDir, 'norm.db')); // 舊站：預設專案、第二專案，識別碼都還沒存
    opened.push(db);
    await db.run("DELETE FROM app_settings WHERE key = ? OR (key >= 'pcode:' AND key < 'pcode;') OR (key >= 'slug:' AND key < 'slug;')", IDENTITY_READY_KEY);
    await db.run("INSERT INTO app_settings (key, value) VALUES ('pcode:預設專案', 'MAIN')");
    let hit = false;
    const wrapped = { ...db, all: async (sql, ...a) => {
      const out = await db.all(sql, ...a);
      if (!hit && /key >= 'pcode:'/.test(sql)) { hit = true; await db.run("UPDATE app_settings SET value = 'SECO' WHERE key = 'pcode:預設專案'"); } // 第二專案沒存代號，推導出來的是 SECO
      return out;
    } };
    const done = await createProjectIdentity({ db: wrapped, nowIso: () => new Date().toISOString() }).normalize();
    assert.ok(hit && done, '正規化做完（中間有改）');
    const codes = (await db.all("SELECT key, value FROM app_settings WHERE key >= 'pcode:' AND key < 'pcode;'")).map(r => r.value);
    assert.equal(codes.length, 2, '兩個專案都有代號');
    assert.equal(new Set(codes).size, 2, '代號沒有重複：' + codes.join(','));
    assert.equal((await db.get("SELECT value FROM app_settings WHERE key = 'pcode:預設專案'")).value, 'SECO', '別人改的值留著');
    console.log('✓ 識別碼正規化：交易內確認快照的值沒變，變了就重算');
  }

  console.log('restore-phase-guards-test：全部通過');
} catch (e) {
  console.error('restore-phase-guards-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const db of opened) await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
