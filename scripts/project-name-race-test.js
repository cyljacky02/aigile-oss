// 驗收測試（#40、ADR 0005）：「未封存專案不同名」在同時寫入時也保得住
// 直接建立、改名、取消封存都先在交易外檢查名稱（給友善的錯誤），寫入那一批再在交易內斷言一次（第一句先拿工作區列鎖）。
// 做法：攔下第一個請求的寫入（db.batch），先讓第二個請求整個做完，再放行第一個（SQLite、D1 一次只做一個交易，這就是會發生的交錯）。
// 另外：取消封存撞名、注入寫入失敗後沒有部分資料、SQLite 忙碌時整批重試。
// Postgres（設了 AIGILE_TEST_PG_URL）另外用不同的資料庫連線真的讓兩個建立同時開著：第一個停在提交前，第二個要等它做完，然後回 409。
// 用法：node scripts/project-name-race-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pname-'));
const dbFile = path.join(dataDir, 'switch.db');
const db = await openTestDb(dbFile);
// before：下一個含有符合 re 那句的寫入，先執行 run()（只作用一次）；after：那一批失敗後、錯誤往上丟之前執行（只作用一次）
// pause：Postgres 在符合的那句之後停住，等測試放行；inject：下一個含有符合 re 那句的寫入，在那句後面插入 sql（只作用一次）
let before = null, after = null, pause = null, inject = null;
const once = (slot, stmts) => slot && stmts.some(([sql]) => slot.re.test(sql)) ? slot : null;
const appDb = { ...db, batch: async stmts => {
  const b = once(before, stmts);
  if (b) { before = null; await b.run(); }
  const a = once(after, stmts);
  if (a) after = null;
  const p = once(pause, stmts);
  if (p) pause = null;
  const i = once(inject, stmts);
  if (i) inject = null;
  if (p) stmts = stmts.flatMap(st => (p.re.test(st[0]) ? [st, [`SELECT pg_advisory_xact_lock(${p.key})`, []]] : [st]));
  if (i) stmts = stmts.flatMap(st => (i.re.test(st[0]) ? [st, [i.sql, []]] : [st]));
  if (i?.hook) i.hook();
  try { return await db.batch(stmts); } catch (e) { if (a) await a.run(e); throw e; }
} };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const code = r => r.body.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
// 讓 second() 在 first() 寫入前整個做完；回傳 first 的回應與 second 的回應
async function interleave(re, first, second) {
  let r2 = null;
  before = { re, run: async () => { r2 = await second(); } };
  const r1 = await first();
  assert.equal(before, null, '真的有交錯（第二個請求在第一個寫入前做完）');
  return { r1, r2 };
}
// 直接看資料庫：叫這個名字、未封存、未刪除的專案有幾個
const activeNamed = async name => Number((await db.get('SELECT COUNT(*) AS n FROM projects WHERE name = ? AND archived = 0 AND deleted_at IS NULL', name)).n);
const CREATE = /^INSERT INTO projects\b/, RENAME = /^UPDATE projects SET name = \?/, UNARCHIVE = /^UPDATE projects SET archived = 0/;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位＝平台管理員＋工作區管理員
  const create = name => call(boss.token, '/api/projects', 'POST', { name });

  // 1) 兩個人同時直接建立同名專案：先做完的成功，後做的 409 NAME_TAKEN，只有一個同名的未封存專案
  {
    const { r1, r2 } = await interleave(CREATE, () => create('甲案'), () => create('甲案'));
    assert.equal(r2.status, 201, '先做完的建立：' + JSON.stringify(r2.body).slice(0, 200));
    assert.equal(r1.status, 409, '後做的建立要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'NAME_TAKEN');
    assert.equal(await activeNamed('甲案'), 1, '只有一個叫「甲案」的未封存專案');
    console.log('✓ 同時直接建立同名專案：只有一個成功');
  }

  const archive = id => call(boss.token, `/api/projects/${id}/archive`, 'POST');
  const unarchive = id => call(boss.token, `/api/projects/${id}/unarchive`, 'POST');
  const archivedOf = async id => Number((await db.get('SELECT archived FROM projects WHERE id = ?', id)).archived);

  // 2) 取消封存一個名稱已被別人用掉的專案：409 NAME_TAKEN，它維持封存
  {
    const old = ok(await create('乙案'), '建立舊的乙案').id;
    ok(await archive(old), '封存舊的乙案');
    ok(await create('乙案'), '名稱空出來了：建立新的乙案');
    const r = await unarchive(old);
    assert.equal(r.status, 409, '取消封存撞名：' + JSON.stringify(r.body).slice(0, 200));
    assert.equal(code(r), 'NAME_TAKEN');
    assert.equal(await archivedOf(old), 1, '舊的乙案還是封存');
    assert.equal(await activeNamed('乙案'), 1, '只有一個叫「乙案」的未封存專案');
    console.log('✓ 取消封存撞名：409');
  }

  // 3) 取消封存時剛好有人建立同名專案：建立先做完，取消封存 409 NAME_TAKEN，它維持封存
  {
    const old = ok(await create('戊案'), '建立戊案').id;
    ok(await archive(old), '封存戊案');
    const { r1, r2 } = await interleave(UNARCHIVE, () => unarchive(old), () => create('戊案'));
    assert.equal(r2.status, 201, '先做完的建立：' + JSON.stringify(r2.body).slice(0, 200));
    assert.equal(r1.status, 409, '後做的取消封存要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'NAME_TAKEN');
    assert.equal(await archivedOf(old), 1, '舊的戊案還是封存');
    assert.equal(await activeNamed('戊案'), 1, '只有一個叫「戊案」的未封存專案');
    console.log('✓ 取消封存時剛好有人建立同名專案：409');
  }

  const rename = (id, name) => call(boss.token, `/api/projects/${id}`, 'PATCH', { name });
  const nameOf = async id => (await db.get('SELECT name FROM projects WHERE id = ?', id)).name;

  // 4) 改名成別的未封存專案的名稱：409 NAME_TAKEN；同時改名與建立同名：建立先做完，改名 409
  {
    const a = ok(await create('己案'), '建立己案').id;
    const r = await rename(a, '乙案');
    assert.equal(r.status, 409, '改名撞名：' + JSON.stringify(r.body).slice(0, 200));
    assert.equal(code(r), 'NAME_TAKEN');
    assert.equal(await nameOf(a), '己案', '名稱沒改');
    const { r1, r2 } = await interleave(RENAME, () => rename(a, '庚案'), () => create('庚案'));
    assert.equal(r2.status, 201, '先做完的建立：' + JSON.stringify(r2.body).slice(0, 200));
    assert.equal(r1.status, 409, '後做的改名要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'NAME_TAKEN');
    assert.equal(await nameOf(a), '己案', '名稱沒改');
    assert.equal(await activeNamed('庚案'), 1, '只有一個叫「庚案」的未封存專案');
    console.log('✓ 改名撞名：409（含同時建立同名）');
  }

  // 5) 斷言失敗後用新鮮資料判斷原因：擋下它的同名專案剛好又改名了（判斷不出原因）→ 一般的 409 CONFLICT，什麼都沒建
  {
    let r2 = null;
    before = { re: CREATE, run: async () => {
      r2 = await create('辛案');
      after = { re: CREATE, run: async () => { await db.run('UPDATE projects SET name = ? WHERE id = ?', '辛案二', r2.body.id); } };
    } };
    const r1 = await create('辛案');
    assert.equal(r2.status, 201, '先做完的建立：' + JSON.stringify(r2.body).slice(0, 200));
    assert.equal(after, null, '第一個建立的寫入失敗後才改名');
    assert.equal(r1.status, 409, '後做的建立要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'CONFLICT', '判斷不出原因：一般的 409');
    assert.equal(await activeNamed('辛案'), 0, '沒有建出「辛案」');
    console.log('✓ 斷言失敗後用新鮮資料判斷：判斷不出回一般的 409');
  }

  // 這個名稱留下的所有痕跡：專案列、專案事件、網址英文名、專案成員資格
  const traces = async name => {
    const ids = (await db.all('SELECT id FROM projects WHERE name = ?', name)).map(r => r.id);
    const n = async (sql, ...a) => Number((await db.get(sql, ...a)).n);
    return { projects: ids.length,
      events: await n("SELECT COUNT(*) AS n FROM project_events WHERE text LIKE ? AND text LIKE '%建立專案%'", `%${boss.participant.name}%`) - eventsBase,
      orphanSlugs: await n("SELECT COUNT(*) AS n FROM app_settings WHERE key >= 'slug:' AND key < 'slug;' AND substr(key, 6) NOT IN (SELECT id FROM projects)"),
      orphanMembers: await n('SELECT COUNT(*) AS n FROM project_members WHERE project_id NOT IN (SELECT id FROM projects)') };
  };
  let eventsBase = 0;
  eventsBase = (await traces('')).events;

  // 6) 注入寫入失敗（建立專案那句之後、同一批裡的一句壞掉）：整批回復，沒有部分資料；再送一次就成功
  {
    inject = { re: CREATE, sql: 'INSERT INTO no_such_table_for_test (x) VALUES (1)' };
    const r = await create('壬案');
    assert.equal(inject, null, '真的注入了失敗');
    assert.equal(r.status, 500, '寫入失敗：' + JSON.stringify(r.body).slice(0, 200));
    assert.deepEqual(await traces('壬案'), { projects: 0, events: 0, orphanSlugs: 0, orphanMembers: 0 }, '沒有留下部分資料');
    ok(await create('壬案'), '再送一次');
    assert.equal(await activeNamed('壬案'), 1);
    eventsBase += 1;
    console.log('✓ 注入寫入失敗：沒有部分資料，重試成功');
  }

  // 7) SQLite 忙碌（別的程序拿著寫入鎖）：整批重試幾次就成功；一直忙碌回 503 RETRY_LATER（附 Retry-After），什麼都沒寫
  // （Postgres 沒有 SQLITE_BUSY；它的寫入會等鎖，由下面的不同連線測試驗）
  if (!TEST_PG_URL) {
    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(dbFile); // 另一個連線＝另一份程式
    try {
      // 建立那批開始前才拿鎖（前面的驗證、在線時間不受影響），50 毫秒後放開
      inject = { re: CREATE, sql: 'SELECT 1', hook: () => { other.exec('BEGIN IMMEDIATE'); setTimeout(() => { try { other.exec('COMMIT'); } catch {} }, 50); } };
      const r = await create('癸案');
      assert.equal(r.status, 201, '忙碌後重試：' + JSON.stringify(r.body).slice(0, 200));
      assert.equal(await activeNamed('癸案'), 1);
      eventsBase += 1;
      // 一直忙碌
      inject = { re: CREATE, sql: 'SELECT 1', hook: () => other.exec('BEGIN IMMEDIATE') };
      const busy = await create('子案');
      other.exec('COMMIT');
      assert.equal(busy.status, 503, '一直忙碌：' + JSON.stringify(busy.body).slice(0, 200));
      assert.equal(code(busy), 'RETRY_LATER');
      assert.ok(Number(busy.headers.get('retry-after')) > 0, '附 Retry-After');
      assert.deepEqual(await traces('子案'), { projects: 0, events: 0, orphanSlugs: 0, orphanMembers: 0 }, '沒有留下部分資料');
      ok(await create('子案'), '不忙了再送一次');
      console.log('✓ SQLite 忙碌：整批重試；一直忙碌回 503，沒有部分資料');
    } finally { try { other.exec('ROLLBACK'); } catch {} other.close(); }
  }

  // Postgres：兩個交易用不同的資料庫連線真的同時開著。第一個停在提交前（工作區列鎖還拿著），第二個要等它做完，然後回 409
  if (TEST_PG_URL) {
    const { default: pg } = await import('pg');
    const ctl = new pg.Client({ connectionString: TEST_PG_URL }); // 測試自己的連線：拿 advisory lock、看誰在等鎖
    await ctl.connect();
    try {
      const until = async (fn, ms, label) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('等太久：' + label); await new Promise(r => setTimeout(r, 25)); } };
      const lockWait = like => ctl.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]).then(r => r.rows[0].n > 0);
      let key = 4_236_900_700;
      // first 做到 re 那句停住 → second 開始，等它被工作區列鎖擋住或做完 → 放行 first
      const race = async (re, first, second) => {
        key++;
        ok(await call(boss.token, '/api/me'), '先讀一次（在線時間先寫掉，第二個請求不會在驗證身分時等第一個交易的成員列）');
        await ctl.query('SELECT pg_advisory_lock($1)', [key]);
        pause = { re, key };
        const p1 = first();
        await until(() => lockWait('%pg_advisory_xact_lock%'), 10000, '第一個請求停在交易中');
        let done2 = false;
        const p2 = second().finally(() => { done2 = true; });
        await until(async () => done2 || await lockWait('%UPDATE workspaces%'), 10000, '第二個請求被鎖住或做完');
        const blocked = !done2;
        await ctl.query('SELECT pg_advisory_unlock($1)', [key]);
        return { r1: await p1, r2: await p2, blocked };
      };
      {
        const { r1, r2, blocked } = await race(CREATE, () => create('丑案'), () => create('丑案'));
        assert.equal(r1.status, 201, '第一個建立：' + JSON.stringify(r1.body).slice(0, 200));
        assert.ok(blocked, '第二個建立要等第一個做完');
        assert.equal(r2.status, 409, '第二個建立：' + JSON.stringify(r2.body).slice(0, 200));
        assert.equal(code(r2), 'NAME_TAKEN');
        assert.equal(await activeNamed('丑案'), 1, '只有一個叫「丑案」的未封存專案');
        console.log('✓ Postgres：兩個連線同時建立同名專案，第二個等第一個做完後 409');
      }
      {
        const old = ok(await create('寅案'), '建立寅案').id;
        ok(await archive(old), '封存寅案');
        const { r1, r2, blocked } = await race(CREATE, () => create('寅案'), () => unarchive(old));
        assert.equal(r1.status, 201, '建立：' + JSON.stringify(r1.body).slice(0, 200));
        assert.ok(blocked, '取消封存要等建立做完');
        assert.equal(r2.status, 409, '取消封存：' + JSON.stringify(r2.body).slice(0, 200));
        assert.equal(code(r2), 'NAME_TAKEN');
        assert.equal(await archivedOf(old), 1, '舊的寅案還是封存');
        assert.equal(await activeNamed('寅案'), 1, '只有一個叫「寅案」的未封存專案');
        console.log('✓ Postgres：建立與取消封存同名專案同時進行，取消封存等建立做完後 409');
      }
    } finally { await ctl.end(); }
  }

  console.log('project-name-race-test：全部通過');
} catch (e) {
  console.error('project-name-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
