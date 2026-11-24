// 驗收測試：最後一位平台管理員、最後一位工作區管理員「兩件事同時發生」也保得住
// 停用帳號、降平台管理員、降工作區管理員、移出工作區，各自先檢查「還有別位」再寫入；兩個請求都檢查完才寫，
// 兩邊都看到「還有別位」。寫入那一批要自己再擋一次：後做的那個回 409，至少留一位啟用中的管理員。
// 1. 兩位平台管理員互相停用
// 2. 停用一位工作區管理員時，另一位工作區管理員剛好把自己降為成員
// 3. 移出一位工作區管理員時，他剛好把另一位降為成員
// 4. 停用一位平台管理員時，他剛好把另一位降為一般帳號
// 做法：攔下第一個請求的寫入（db.batch），先讓第二個請求整個做完，再放行第一個（SQLite、D1 一次只做一個交易，這就是會發生的交錯）。
// Postgres（設了 AIGILE_TEST_PG_URL）另外真的讓兩個交易同時開著：第一個停在提交前，第二個要等它做完，然後回 409。
// 用法：node scripts/last-admin-race-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-lastadm-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
// before：下一個含有符合 re 那句的寫入，先執行 run()（只作用一次）；pause：Postgres 在符合的那句之後停住，等測試放行
let before = null, pause = null;
const appDb = { ...db, batch: async stmts => {
  const b = before && stmts.some(([sql]) => before.re.test(sql)) ? before : null;
  if (b) { before = null; await b.run(); }
  const p = pause && stmts.some(([sql]) => pause.re.test(sql)) ? pause : null;
  if (p) pause = null;
  return db.batch(p ? stmts.flatMap(st => (p.re.test(st[0]) ? [st, [`SELECT pg_advisory_xact_lock(${p.key})`, []]] : [st])) : stmts);
} };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const join = async name => (await call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
const setPlat = (tok, id, role) => call(tok, `/api/participants/${id}/platform-role`, 'PUT', { role });
const setWs = (tok, id, role) => call(tok, `/api/participants/${id}/workspace-role`, 'PUT', { role });
const disable = (tok, id) => call(tok, `/api/participants/${id}/disable`, 'POST');
const enable = (tok, id) => call(tok, `/api/participants/${id}/enable`, 'POST');
const remove = (tok, id) => call(tok, `/api/participants/${id}/remove`, 'POST');
// 讓 second() 在 first() 寫入前整個做完；回傳 first 的回應與 second 的回應
async function interleave(re, first, second) {
  let r2 = null;
  before = { re, run: async () => { r2 = await second(); } };
  const r1 = await first();
  assert.equal(before, null, '真的有交錯（第二個請求在第一個寫入前做完）');
  return { r1, r2 };
}
// 目前啟用中的平台管理員、工作區管理員（直接看資料庫）
const platformAdmins = async () => (await db.all("SELECT p.id FROM participants p JOIN accounts a ON a.id = p.account_id WHERE a.platform_role = 'admin' AND a.status = 'active' AND p.status = 'active' AND p.kind = 'human'")).map(r => r.id).sort();
const workspaceAdmins = async () => (await db.all("SELECT id FROM participants WHERE workspace_role = 'admin' AND status = 'active' AND kind = 'human'")).map(r => r.id).sort();
const DISABLE = /SET status = 'disabled'/, REMOVE = /SET workspace_status = 'removed'/;

try {
  const boss = await join('林志明'); // 第一位＝平台管理員＋工作區管理員
  const chen = await join('陳昭宇');
  const wang = await join('王小美');
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  ok(await setWs(boss.token, Cn, 'admin'), '陳昭宇升為工作區管理員');
  ok(await setPlat(boss.token, Wg, 'admin'), '王小美升為平台管理員');
  // 平台管理員：林志明、王小美；工作區管理員：林志明、陳昭宇

  // 1) 林志明停用王小美、同時王小美停用林志明：先做完的成功，後做的 409，留一位平台管理員
  {
    const { r1, r2 } = await interleave(DISABLE, () => disable(boss.token, Wg), () => disable(wang.token, Bo));
    ok(r2, '先做完的停用');
    assert.equal(r1.status, 409, '後做的停用要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'LAST_PLATFORM_ADMIN');
    assert.deepEqual(await platformAdmins(), [Wg], '還有一位啟用中的平台管理員');
    const w = await db.get('SELECT status FROM participants WHERE id = ?', Wg);
    assert.equal(w.status, 'active', '王小美沒被停用');
    assert.equal((await call(wang.token, '/api/me')).status, 200, '王小美還進得來');
    ok(await enable(wang.token, Bo), '王小美恢復林志明的帳號');
    boss.token = await testToken(db, Bo); // 停用時登入碼換掉了，恢復後用新的
    console.log('✓ 兩位平台管理員互相停用：留一位');
  }

  // 2) 王小美（平台管理員）停用陳昭宇、同時林志明把自己降為成員：停用 409，留一位工作區管理員
  {
    const { r1, r2 } = await interleave(DISABLE, () => disable(wang.token, Cn), () => setWs(boss.token, Bo, 'member'));
    ok(r2, '先做完的降級');
    assert.equal(r1.status, 409, '後做的停用要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'LAST_WORKSPACE_ADMIN');
    assert.deepEqual(await workspaceAdmins(), [Cn], '還有一位啟用中的工作區管理員');
    assert.equal((await db.get('SELECT status FROM participants WHERE id = ?', Cn)).status, 'active', '陳昭宇沒被停用');
    ok(await setWs(chen.token, Bo, 'admin'), '林志明升回工作區管理員');
    console.log('✓ 停用工作區管理員時另一位剛好降級：留一位');
  }

  // 3) 林志明把陳昭宇移出工作區、同時陳昭宇把林志明降為成員：移出 409，留一位工作區管理員
  {
    const { r1, r2 } = await interleave(REMOVE, () => remove(boss.token, Cn), () => setWs(chen.token, Bo, 'member'));
    ok(r2, '先做完的降級');
    assert.equal(r1.status, 409, '後做的移出要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'LAST_WORKSPACE_ADMIN');
    assert.deepEqual(await workspaceAdmins(), [Cn], '還有一位啟用中的工作區管理員');
    assert.equal((await db.get('SELECT workspace_status FROM participants WHERE id = ?', Cn)).workspace_status, 'active', '陳昭宇沒被移出');
    ok(await setWs(chen.token, Bo, 'admin'), '林志明升回工作區管理員');
    console.log('✓ 移出工作區管理員時他剛好降了另一位：留一位');
  }

  // 4) 林志明停用王小美、同時王小美把林志明降為一般帳號：停用 409，留一位平台管理員
  {
    const { r1, r2 } = await interleave(DISABLE, () => disable(boss.token, Wg), () => setPlat(wang.token, Bo, 'none'));
    ok(r2, '先做完的降級');
    assert.equal(r1.status, 409, '後做的停用要擋下：' + JSON.stringify(r1.body).slice(0, 200));
    assert.equal(code(r1), 'LAST_PLATFORM_ADMIN');
    assert.deepEqual(await platformAdmins(), [Wg], '還有一位啟用中的平台管理員');
    ok(await setPlat(wang.token, Bo, 'admin'), '林志明升回平台管理員');
    console.log('✓ 停用平台管理員時他剛好降了另一位：留一位');
  }

  // Postgres：兩個交易真的同時開著。第一個停用停在提交前（鎖還拿著），第二個停用要等它做完，然後回 409
  if (TEST_PG_URL) {
    const { default: pg } = await import('pg');
    const ctl = new pg.Client({ connectionString: TEST_PG_URL });
    await ctl.connect();
    try {
      const until = async (fn, ms, label) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('等太久：' + label); await new Promise(r => setTimeout(r, 25)); } };
      const lockWait = like => ctl.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]).then(r => r.rows[0].n > 0);
      const key = 4_236_900_500;
      await ctl.query('SELECT pg_advisory_lock($1)', [key]);
      pause = { re: DISABLE, key };
      const p1 = disable(boss.token, Wg);
      await until(() => lockWait('%pg_advisory_xact_lock%'), 10000, '第一個停用停在交易中');
      let done2 = false;
      const p2 = disable(wang.token, Bo).finally(() => { done2 = true; });
      await until(async () => done2 || await lockWait('%UPDATE workspaces%'), 10000, '第二個停用被鎖住或做完');
      const blocked = !done2;
      await ctl.query('SELECT pg_advisory_unlock($1)', [key]);
      const r1 = await p1, r2 = await p2;
      ok(r1, '第一個停用');
      assert.ok(blocked, '第二個停用要等第一個做完');
      assert.equal(r2.status, 409, '第二個停用：' + JSON.stringify(r2.body).slice(0, 200));
      assert.equal(code(r2), 'LAST_PLATFORM_ADMIN');
      assert.deepEqual(await platformAdmins(), [Bo], '還有一位啟用中的平台管理員');
      console.log('✓ Postgres：兩個停用同時進行，第二個等第一個做完後 409');
    } finally { await ctl.end(); }
  }

  console.log('last-admin-race-test：全部通過');
} catch (e) {
  console.error('last-admin-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
