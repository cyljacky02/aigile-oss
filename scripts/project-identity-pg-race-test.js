// 驗收測試（#42；ADR 0005）：Postgres 上用不同的資料庫連線真的同時進行
// 1. 兩份程式同時開機做識別碼正規化：第一個停在提交前（工作區列鎖還拿著），第二個用同一份快照算好、被鎖擋住；
//    第一個提交後第二個的快照已經過時（交易內確認不成立），重讀後看到已正規化，不會用舊快照覆蓋。結果跟只跑一次一樣
// 2. 直接建立（指定代號）與另一份程式改代號搶同一個代號：第二個等第一個做完後 409，只有一個專案用這個代號
// 只有 Postgres 會有兩個寫入交易同時進行；沒設 AIGILE_TEST_PG_URL 就略過。用法：AIGILE_TEST_PG_URL=… node scripts/project-identity-pg-race-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { createProjectIdentity, IDENTITY_READY_KEY } from '../src/project-identity.js';
import { isAssertionFailure } from '../src/write-order.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';

if (!TEST_PG_URL) { console.log('project-identity-pg-race-test：略過（只有 Postgres 會有兩個寫入交易同時進行）'); process.exit(0); }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pidrace-'));
const opened = [];
const open = async name => { const db = await openTestDb(path.join(dataDir, name)); opened.push(db); return db; };
const { default: pg } = await import('pg');
const ctl = new pg.Client({ connectionString: TEST_PG_URL }); // 測試自己的連線：拿 advisory lock、看誰在等鎖
await ctl.connect();
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('等太久：' + label); await new Promise(r => setTimeout(r, 25)); } };
const lockWait = like => ctl.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]).then(r => r.rows[0].n > 0);
// 包一層資料庫：pause＝下一個含符合 re 那句的批次，在那句之後停住（等測試放開 advisory lock）；errors 記下批次丟的錯
const gated = db => {
  const g = { pause: null, errors: [] };
  g.db = { ...db, batch: async stmts => {
    const p = g.pause && stmts.some(([sql]) => g.pause.re.test(sql)) ? g.pause : null;
    if (p) { g.pause = null; stmts = stmts.flatMap(st => (p.re.test(st[0]) ? [st, [`SELECT pg_advisory_xact_lock(${p.key})`, []]] : [st])); }
    try { return await db.batch(stmts); } catch (e) { g.errors.push(e); throw e; }
  } };
  return g;
};
// first 做到 re 那句停住 → second 開始，等它被工作區列鎖擋住或做完 → 放行 first
let key = 4_236_942_000;
async function race(g1, re, first, second) {
  key++;
  await ctl.query('SELECT pg_advisory_lock($1)', [key]);
  g1.pause = { re, key };
  const p1 = first();
  await until(() => lockWait('%pg_advisory_xact_lock%'), 10000, '第一個停在交易中');
  let done2 = false;
  const p2 = second().finally(() => { done2 = true; });
  await until(async () => done2 || await lockWait('%UPDATE workspaces%'), 10000, '第二個被鎖住或做完');
  const blocked = !done2;
  await ctl.query('SELECT pg_advisory_unlock($1)', [key]);
  return { r1: await p1, r2: await p2, blocked };
}
const identityRows = async db => (await db.all("SELECT key, value FROM app_settings WHERE (key >= 'pcode:' AND key < 'pcode;') OR (key >= 'pcodeold:' AND key < 'pcodeold;') OR (key >= 'slug:' AND key < 'slug;') ORDER BY key")).map(r => `${r.key}=${r.value}`);

try {
  // 1) 兩份程式同時正規化
  {
    const a = await open('norm.db'), b = await open('norm.db'); // 同一個 schema、不同的連線池
    await a.run("INSERT INTO projects (id, name, archived, workspace_id, created_at) VALUES ('p_x', 'X 專案', 0, 'default', '2026-01-02T00:00:00.000Z')");
    await a.run("INSERT INTO projects (id, name, archived, workspace_id, created_at) VALUES ('p_y', 'Yak', 0, 'default', '2026-01-03T00:00:00.000Z')");
    await a.run("INSERT INTO app_settings (key, value) VALUES ('slug:p_y', 'yak'), ('pcode:p_x', 'SECO')");
    const g1 = gated(a), g2 = gated(b);
    const n1 = createProjectIdentity({ db: g1.db, nowIso: () => new Date().toISOString() });
    const n2 = createProjectIdentity({ db: g2.db, nowIso: () => new Date().toISOString() });
    const { r1, r2, blocked } = await race(g1, /^INSERT INTO app_settings \(key, value\) SELECT json_extract/, () => n1.normalize(), () => n2.normalize());
    assert.ok(blocked, '第二個正規化要等第一個做完');
    assert.deepEqual([r1, r2], [true, true], '兩邊都回已正規化');
    assert.ok(g2.errors.length === 1 && isAssertionFailure(g2.errors[0]), '第二個的快照過時：交易內確認不成立、整批沒寫，重讀後看到已正規化');
    assert.deepEqual(await identityRows(a), ['pcode:p_x=SECO', 'pcode:p_y=YAK', 'pcode:第二專案=SECOA', 'pcode:預設專案=MAIN',
      'slug:p_x=p_x', 'slug:p_y=yak', 'slug:第二專案=second', 'slug:預設專案=main'], '結果跟只跑一次一樣（升級前顯示的值）');
    assert.ok(await a.get('SELECT 1 AS x FROM app_settings WHERE key = ?', IDENTITY_READY_KEY));
    console.log('✓ Postgres：兩個連線同時正規化，第二個等第一個做完、不用舊快照覆蓋，結果一致');
  }

  // 2) 直接建立（指定代號）與另一份程式改代號搶同一個代號
  {
    const a = await open('switch.db'), b = await open('switch.db');
    const config = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
    const g1 = gated(a);
    const mk = db => { const app = createApp({ db, storage: dbStorage(a), docText: '', config });
      return async (token, p, method = 'GET', body) => { const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost'); return { status: r.status, body: await r.json().catch(() => ({})) }; }; };
    const call1 = mk(g1.db), call2 = mk(b);
    const boss = (await call1(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    assert.equal((await call2(boss.token, '/api/me')).status, 200, '另一份程式也認得（在線時間先寫掉）');
    assert.equal((await call1(boss.token, '/api/me')).status, 200);
    const { r1, r2, blocked } = await race(g1, /^INSERT INTO projects\b/, () => call1(boss.token, '/api/projects', 'POST', { name: '搶代號', code: 'RACE' }),
      () => call2(boss.token, '/api/projects/第二專案/code', 'PUT', { code: 'RACE' }));
    assert.equal(r1.status, 201, '先開始的建立：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '改代號要等建立做完');
    assert.deepEqual([r2.status, r2.body.error?.code], [409, 'CODE_TAKEN'], '後做的改代號：' + JSON.stringify(r2.body).slice(0, 200));
    assert.equal(Number((await a.get("SELECT COUNT(*) AS n FROM app_settings WHERE key >= 'pcode:' AND key < 'pcode;' AND value = 'RACE'")).n), 1, '只有一個專案用 RACE');
    assert.equal((await a.get("SELECT value FROM app_settings WHERE key = 'pcode:第二專案'")).value, 'SECO', '第二專案的代號沒改');
    console.log('✓ Postgres：直接建立與另一個連線改代號搶同一個代號，後做的等前一個做完後 409');
  }
  console.log('project-identity-pg-race-test：全部通過');
} catch (e) {
  console.error('project-identity-pg-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await ctl.end().catch(() => {});
  for (const d of opened) await d.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
