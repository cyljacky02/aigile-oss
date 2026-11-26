// 本機 D1 驗證（規格 #39「Testing Decisions → D1」）：一個指令，從空的本機 D1 跑完建立專案申請的關鍵資料庫行為，逐項印 PASS／FAIL。
// 用法：npm run verify:d1   （= node scripts/d1-verify.mjs [--keep] [--verbose]）
//   --keep     保留暫存資料夾（本機 D1 檔、wrangler dev 的紀錄）方便查
//   --verbose  每項多印細節（量到的 D1 用量等）
// 退出碼：0＝全部 PASS；1＝有 FAIL；2＝沒辦法驗證（找不到 wrangler、沒有網路下載 wrangler@4…）＝D1 未驗證。
//
// 只碰本機：wrangler d1 execute --local 與 wrangler dev --local，資料在 os.tmpdir() 的暫存資料夾；防護見 scripts/d1-local.mjs。
// 不呼叫 scripts/migrate.js（預設 --remote）、scripts/admin-rescue.js（永遠 --remote）；不需要 Cloudflare 帳號或憑證。
//
// 怎麼驗證：
//   1. 資料庫升級：用 scripts/migrate.js 的同一個純函式 d1Steps 產生 SQL，經 wrangler d1 execute --local 套到空的 D1（全新），
//      再模擬「015 之前」的舊 D1 套升級，確認兩條路得到一樣的表、欄位與索引。
//   2. 其餘全部經 HTTP 打 wrangler dev --local 跑的真 Worker（scripts/d1-verify-worker.mjs 原樣轉給 worker.js），
//      資料庫是 Worker 綁定的 env.DB（D1 的 prepare／batch，不是 node:sqlite）。HTTP 表達不了的（直接寫入違反 CHECK 的列、
//      在正式程式的那一批中間注入失敗、事後核對資料）用同一個 Worker 的 /__d1verify/* 控制端點（隨機 token，只存在這個驗證入口）。
// 細節、預期輸出與已知限制：docs/d1-verification.md
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { d1Steps } from './migrate.js';
import { listMigrations } from '../src/migrations.js';
import { isUniqueConstraintViolation, isNotNullViolation } from '../src/db-errors.js';
import { findWrangler, localD1, makeTmpRoot, removeDir } from './d1-local.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.some(a => /remote/i.test(a))) { console.error('拒絕執行：D1 驗證只能對本機 D1（不接受 --remote）'); process.exit(2); }
const KEEP = argv.includes('--keep'), VERBOSE = argv.includes('--verbose');
// D1 的限制（https://developers.cloudflare.com/d1/platform/limits/）：每句最多 100 個綁定參數、每句 SQL 最長 100,000 位元組、
// 每次 Worker 執行最多 50 次（免費方案）／1000 次（付費方案）查詢（db.batch 整批算一次）
const LIMITS = { params: 100, sqlBytes: 100_000, callsFree: 50, callsPaid: 1000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = () => crypto.randomBytes(6).toString('hex');

// ---------- 結果 ----------
const results = [];
let blocked = null; // 前置失敗時，後面的項目不跑（記 FAIL：沒有執行）
async function check(id, title, fn) {
  const t0 = Date.now();
  const notes = [];
  if (blocked) { results.push({ id, title, ok: false, msg: `沒有執行（${blocked}）` }); console.log(`FAIL  ${id}  ${title} — 沒有執行（${blocked}）`); return false; }
  try {
    await fn(m => notes.push(m));
    results.push({ id, title, ok: true });
    console.log(`PASS  ${id}  ${title}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (VERBOSE) for (const n of notes) console.log(`        ${n}`);
    return true;
  } catch (e) {
    results.push({ id, title, ok: false, msg: e.message });
    console.log(`FAIL  ${id}  ${title}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n        ${String(e.message).split('\n').slice(0, 6).join('\n        ')}`);
    for (const n of notes) console.log(`        ${n}`);
    return false;
  }
}

// ---------- 對 Worker 的 HTTP ----------
function site(base, token) {
  const call = async (tok, p, method = 'GET', body) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      if (r.status === 429 && attempt < 3) { await sleep(((Number(json?.error?.retryAfter) || 5) * 1000) + 250); continue; } // 每人每分鐘 120 次的頻率限制
      return { status: r.status, body: json, text, stats: JSON.parse(r.headers.get('x-d1-verify-stats') || 'null') };
    }
  };
  const ctl = async (p, body) => {
    const r = await fetch(`${base}/__d1verify/${p}`, { method: 'POST', headers: { 'x-d1-verify-token': token }, body: JSON.stringify(body ?? {}) });
    const j = await r.json();
    if (r.status !== 200) throw new Error(`控制端點 ${p}：${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const q = async (sql, ...args) => (await ctl('query', { sql, args })).rows;
  const one = async (sql, ...args) => (await q(sql, ...args))[0] ?? null;
  const n = async (sql, ...args) => Number(Object.values((await one(sql, ...args)) ?? { n: 0 })[0]);
  return { base, call, ctl, q, one, n, batch: stmts => ctl('batch', { stmts }), fault: f => ctl('fault', f), faultStatus: () => ctl('fault-status') };
}
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：HTTP ${r.status} ${r.text.slice(0, 300)}`); return r.body; };
const is = (r, status, code, label) => { assert.deepEqual([r.status, r.body?.error?.code ?? null], [status, code], `${label}：${r.text.slice(0, 300)}`); return r.body; };
// 這個請求的 D1 用量在限制內（硬限制：參數、SQL 長度、付費方案查詢數；免費方案 50 次也要過）
const usage = [];
function within(label, r) {
  assert.ok(r.stats, `${label}：沒有量到 D1 用量`);
  const s = r.stats;
  usage.push({ label, ...s });
  assert.ok(s.maxParams <= LIMITS.params, `${label}：單句綁了 ${s.maxParams} 個參數（D1 上限 ${LIMITS.params}）`);
  assert.ok(s.maxSqlBytes <= LIMITS.sqlBytes, `${label}：單句 SQL ${s.maxSqlBytes} 位元組（D1 上限 ${LIMITS.sqlBytes}）`);
  assert.ok(s.calls <= LIMITS.callsPaid, `${label}：一次執行查詢 ${s.calls} 次（D1 付費方案上限 ${LIMITS.callsPaid}）`);
  assert.ok(s.calls <= LIMITS.callsFree, `${label}：一次執行查詢 ${s.calls} 次（D1 免費方案上限 ${LIMITS.callsFree}）`);
  return r;
}
const fmtUsage = u => `${u.label}：查詢 ${u.calls} 次（批次 ${u.batches}，最大一批 ${u.maxBatch} 句）、單句最多 ${u.maxParams} 個參數、最長 ${u.maxSqlBytes} 位元組`;

// ---------- 帳號 ----------
const ADMIN_PASSWORD = 'd1-verify-' + rid();
const NEW_PASSWORD = 'd1-verify-new-' + rid();
// 新站的預設管理員（worker.js 一定開 defaultAdmin）：登入 → 改帳密 → 重新登入 → 再驗證（敏感的管理操作要）
async function defaultAdmin(s, username) {
  const first = ok(await s.call(null, '/api/auth/password', 'POST', { username: 'admin', password: ADMIN_PASSWORD }), '預設管理員登入');
  ok(await s.call(first.token, '/api/me/password', 'PUT', { username, currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD, newPasswordAgain: NEW_PASSWORD }), '預設管理員改帳密');
  const login = ok(await s.call(null, '/api/auth/password', 'POST', { username, password: NEW_PASSWORD }), '用新帳密登入');
  ok(await s.call(login.token, '/api/auth/reauth', 'POST', { password: NEW_PASSWORD }), '再驗證');
  return { token: login.token, id: login.participant?.participantId, password: NEW_PASSWORD };
}
const reauth = async (s, who) => ok(await s.call(who.token, '/api/auth/reauth', 'POST', { password: who.password }), '再驗證'); // 再驗證 10 分鐘過期
const join = async (s, name) => { const b = ok(await s.call(null, '/api/join', 'POST', { name, role: 'PG' }), `${name} 註冊`); return { token: b.token, id: b.participant.participantId, name }; };

// ---------- 主程式 ----------
const tmpRoot = makeTmpRoot(repoRoot);
const running = [];
let exitCode = 0;
try {
  console.log(`本機 D1 驗證　暫存：${tmpRoot}`);
  let wrangler;
  try {
    wrangler = findWrangler();
    const v = spawnSync(process.execPath, [wrangler, '--version'], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    const version = (v.stdout || '').trim().split('\n').pop();
    if (!/^4\./.test(version)) throw new Error(`wrangler 版本不是 4.x：${version || v.stderr}`);
    console.log(`wrangler ${version}（${wrangler}）`);
  } catch (e) {
    console.log(`SKIP  D1 未驗證：${e.message}`);
    console.log('（要用的話：有網路時跑一次 npx --yes wrangler@4 --version，或設 D1_VERIFY_WRANGLER＝wrangler/bin/wrangler.js 的路徑）');
    exitCode = 2;
    throw null;
  }
  // worker.js 會打包 generated/（npm run deploy 前由 scripts/releases.mjs 產生；gitignore）
  if (!fs.existsSync(path.join(repoRoot, 'generated', 'releases.json')) || !fs.existsSync(path.join(repoRoot, 'generated', 'script-hashes.json'))) {
    const g = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'releases.mjs')], { cwd: repoRoot, encoding: 'utf8' });
    if (g.status !== 0) throw new Error('產生 generated/ 失敗：' + g.stderr);
  }
  const main = path.join(repoRoot, 'scripts', 'd1-verify-worker.mjs');
  const TOKEN = rid() + rid();
  const VARS = { D1_VERIFY_TOKEN: TOKEN, ADMIN_PASSWORD, JOIN_LIMIT_PER_HOUR: '100000', OPEN_JOIN: '1', UPDATE_CHECK: '0' };
  const schema = fs.readFileSync(path.join(repoRoot, 'src', 'schema.sql'), 'utf8');
  const files = listMigrations(path.join(repoRoot, 'migrations'));
  const PCR_MIGRATION = files.find(f => /_project_creation_requests\.sql$/.test(f.name))?.name;
  const CLAIMS_MIGRATION = '016_project_identity_claims.sql';
  const migrate = (d, label) => {
    const tables = d.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('participants', 'schema_migrations')").map(r => r.name);
    const fresh = !tables.includes('participants');
    const applied = tables.includes('schema_migrations') ? d.query('SELECT name FROM schema_migrations').map(r => r.name) : [];
    const plan = d1Steps({ fresh, applied, files, schema });
    for (const s of plan.steps) d.exec(s.sql, { label: `${label}：${s.label}` });
    return plan;
  };
  const structure = d => ({
    columns: d.query(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('project_creation_requests') ORDER BY cid`),
    indexes: d.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_creation_requests' AND sql IS NOT NULL ORDER BY name")
      .map(r => ({ name: r.name, sql: r.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /i, '') })),
  });

  // ===== D1-01 資料庫升級 =====
  const A = localD1({ wrangler, tmpRoot, repoRoot, name: 'site-a', main });
  const migrated = await check('D1-01', '資料庫升級：全新的 D1 與「015 之前」的舊 D1 都用 d1Steps 升到最新，結構相同', async note => {
    assert.ok(PCR_MIGRATION, 'migrations/ 裡有建立專案申請的升級');
    const plan = migrate(A, '全新');
    assert.equal(plan.plan.fresh, true, '空的 D1 走全新路線');
    const names = A.query('SELECT name FROM schema_migrations ORDER BY name').map(r => r.name);
    assert.deepEqual(names, files.map(f => f.name).sort(), '全部升級都標成已套');
    const fresh = structure(A);
    assert.ok(fresh.columns.length >= 17, '申請資料表有完整欄位');
    for (const ix of ['idx_pcr_request', 'idx_pcr_pending_name', 'idx_pcr_project', 'idx_pcr_state', 'idx_pcr_requester']) assert.ok(fresh.indexes.some(i => i.name === ix), `有索引 ${ix}`);
    assert.match(fresh.indexes.find(i => i.name === 'idx_pcr_pending_name').sql, /WHERE state = 'pending'/, '同名待審是部分唯一索引');
    assert.match(A.query("SELECT sql FROM sqlite_master WHERE name = 'project_creation_requests'")[0].sql, /CHECK \(state IN/, '有 CHECK 約束');
    // 模擬 015 之前的舊 D1：拿掉申請資料表與它的升級紀錄，再升級一次
    A.exec(`DROP TABLE project_identity_claimants; DROP TABLE project_identity_claims; DROP TABLE project_creation_requests;
      DELETE FROM schema_migrations WHERE name IN ('${PCR_MIGRATION}', '${CLAIMS_MIGRATION}')`, { label: '模擬舊 D1' });
    const up = migrate(A, '舊 D1');
    assert.deepEqual(up.plan.apply.map(f => f.name), [PCR_MIGRATION, CLAIMS_MIGRATION], '舊 D1 套用申請及識別碼保留表的升級');
    assert.deepEqual(structure(A), fresh, '升級後的表、欄位、索引跟全新建的一樣');
    const again = migrate(A, '重跑');
    assert.deepEqual(again.plan.apply, [], '重跑沒有要套的升級（可安全重跑）');
    note(`升級 ${files.length} 個，舊 D1 套 ${PCR_MIGRATION} 與 ${CLAIMS_MIGRATION}`);
  });
  if (!migrated) blocked = '資料庫升級沒過';

  // ===== 啟動 Worker（site A）=====
  let a = null, boss = null, ann = null;
  const people = {};
  await check('D1-02', 'Worker（worker.js）在本機 D1 上啟動：預設管理員、註冊、工作區管理員、政策設成 approval', async note => {
    const w = await A.dev({ vars: VARS });
    running.push(w);
    a = site(w.base, TOKEN);
    const first = await a.call(null, '/api/health');
    usage.push({ label: '新執行個體的第一個請求（GET /api/health，含啟動時的建表、預設管理員、識別碼正規化）', ...first.stats });
    assert.equal(first.status, 200, `GET /api/health：${first.status} ${first.text.slice(0, 200)}`);
    boss = await defaultAdmin(a, 'd1boss');
    ann = await join(a, '安娜');
    ok(await a.call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升為工作區管理員');
    for (const n of ['陳大文', '王小美', '丹尼', '伊芙', '菲菲', '古斯']) people[n] = await join(a, n);
    ok(within('政策設成 approval', await a.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' })), '政策設成 approval');
    assert.equal((await a.one("SELECT create_projects AS v FROM workspaces WHERE id = 'default'")).v, 'approval');
    note(`Worker：${w.base}；紀錄：${w.logFile}`);
  });
  if (!a) blocked ??= 'Worker 沒有啟動';
  const { 陳大文: chen, 王小美: wang, 丹尼: dan, 伊芙: eve, 菲菲: fay, 古斯: gus } = people;
  let seq = 0;
  const THREE = [{ name: '想法', category: '待處理' }, { name: '動手', category: '進行中' }, { name: '收工', category: '已完成' }];
  const submit = async (who, body = {}, label = '送出') => {
    const r = await a.call(who.token, '/api/project-creation-requests', 'POST', { requestId: `d1v-${++seq}`, name: `D1 驗證 ${seq}`, reason: '驗證 D1', ...body });
    return ok(r, label);
  };
  const approve = (q, who = boss) => a.call(who.token, `/api/project-creation-requests/${q.id}/approve`, 'POST', {});
  const reject = (q, who = boss, reason = '不需要') => a.call(who.token, `/api/project-creation-requests/${q.id}/reject`, 'POST', { reason });
  const withdraw = (q, who) => a.call(who.token, `/api/project-creation-requests/${q.id}/withdraw`, 'POST', {});
  const stateOf = async id => a.one('SELECT state, cancel_code, project_id, ended_by, reject_reason FROM project_creation_requests WHERE id = ?', id);
  const projectsNamed = name => a.n('SELECT COUNT(*) AS n FROM projects WHERE name = ?', name);
  const createAudits = id => a.n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.create' AND json_extract(detail, '$.requestId') = ?", id);

  // ===== D1-03 部分唯一索引 =====
  await check('D1-03', '部分唯一索引：同一申請人的同名待審申請被擋（HTTP 送出、同時送出、直接寫入都一樣）；結束的不擋', async note => {
    const q1 = await submit(chen, { name: 'D1 同名' });
    let r = await a.call(chen.token, '/api/project-creation-requests', 'POST', { requestId: 'd1v-dup-2', name: 'D1 同名', reason: '再一次' });
    is(r, 409, 'DUPLICATE_PENDING_REQUEST', '同名第二份');
    r = await a.call(chen.token, '/api/project-creation-requests', 'POST', { requestId: q1.requestId, name: 'D1 同名', reason: '驗證 D1' });
    assert.deepEqual([r.status, r.body?.duplicate, r.body?.id], [200, true, q1.id], '同一 requestId 同內容重送：回原本的');
    ok(await a.call(wang.token, '/api/project-creation-requests', 'POST', { requestId: 'd1v-dup-w', name: 'D1 同名', reason: '別人可以' }), '另一位申請人同名可以');
    // 同時送出 6 份同名（不同 requestId）：剛好一份成功
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => a.call(chen.token, '/api/project-creation-requests', 'POST', { requestId: `d1v-burst-${i}`, name: 'D1 同時同名', reason: '同時' })));
    assert.deepEqual(burst.map(x => x.status).sort(), [201, 409, 409, 409, 409, 409], '同時送出：一份 201、其他 409：' + burst.map(x => `${x.status}${x.body?.error?.code ? ' ' + x.body.error.code : ''}`).join(', '));
    assert.ok(burst.filter(x => x.status === 409).every(x => x.body?.error?.code === 'DUPLICATE_PENDING_REQUEST'), '其他都是 DUPLICATE_PENDING_REQUEST');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE requester_id = ? AND name = 'D1 同時同名' AND state = 'pending'", chen.id), 1, '資料庫裡只有一份待審');
    // 撤回後同名可以再送（索引只涵蓋 pending）
    ok(await withdraw(q1, chen), '撤回');
    ok(await a.call(chen.token, '/api/project-creation-requests', 'POST', { requestId: 'd1v-dup-3', name: 'D1 同名', reason: '撤回後重送' }), '撤回後同名重送');
    // 直接寫入（Worker 的 env.DB）：錯誤原文要被正式程式的判斷認出來是這個索引
    const row = (id, extra = {}) => ['INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, state, created_at, ended_at, ended_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, 'default', gus.id, 'raw-' + id, 'D1 直接寫入', '直接', extra.state ?? 'pending', '2026-01-01T00:00:00.000Z', extra.ended_at ?? null, extra.ended_by ?? null]];
    assert.deepEqual(await a.batch([row('pcr_raw_1')]), { ok: true }, '第一份待審');
    const dup = await a.batch([row('pcr_raw_2')]);
    assert.equal(dup.ok, false, '第二份同名待審被擋');
    assert.ok(isUniqueConstraintViolation({ message: dup.error }, { constraint: 'idx_pcr_pending_name', columns: ['project_creation_requests.workspace_id', 'project_creation_requests.requester_id', 'project_creation_requests.name'] }),
      `D1 的錯誤原文要被 isUniqueConstraintViolation 認出是 idx_pcr_pending_name：${dup.error}`);
    assert.deepEqual(await a.batch([row('pcr_raw_3', { state: 'withdrawn', ended_at: '2026-01-02T00:00:00.000Z', ended_by: gus.id })]), { ok: true }, '同名但已撤回的可以');
    await a.batch([["DELETE FROM project_creation_requests WHERE id IN ('pcr_raw_1', 'pcr_raw_3')", []]]);
    note(`D1 錯誤原文：${dup.error}`);
  });

  // ===== D1-04 CHECK 約束 =====
  await check('D1-04', 'CHECK 約束：不一致的狀態與欄位組合寫不進去（INSERT 與 UPDATE），合法的每種狀態都寫得進去', async note => {
    const at = '2026-01-01T00:00:00.000Z';
    const cols = ['id', 'workspace_id', 'requester_id', 'request_id', 'name', 'reason', 'visibility', 'state', 'created_at', 'ended_at', 'ended_by', 'reject_reason', 'cancel_code', 'project_id'];
    let k = 0;
    const ins = (o = {}) => { const id = `pcr_chk_${++k}`; const r = { id, workspace_id: 'default', requester_id: fay.id, request_id: 'chk-' + k, name: 'CHECK ' + k, reason: 'x', visibility: 'review', state: 'pending', created_at: at, ended_at: null, ended_by: null, reject_reason: null, cancel_code: null, project_id: null, ...o };
      return [`INSERT INTO project_creation_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => r[c])]; };
    const bad = {
      '不認得的狀態': { state: 'done' },
      '不認得的可見度': { visibility: 'secret' },
      '待審卻有結束時間': { ended_at: at },
      '待審卻有專案': { project_id: 'prj_x' },
      '已核准沒有專案': { state: 'approved', ended_at: at, ended_by: boss.id },
      '已核准沒有處理人': { state: 'approved', ended_at: at, project_id: 'prj_y' },
      '已拒絕沒有理由': { state: 'rejected', ended_at: at, ended_by: boss.id },
      '已拒絕理由只有空白': { state: 'rejected', ended_at: at, ended_by: boss.id, reject_reason: '   ' },
      '已撤回但處理人不是申請人': { state: 'withdrawn', ended_at: at, ended_by: boss.id },
      '已取消卻有處理人': { state: 'cancelled', ended_at: at, ended_by: boss.id, cancel_code: 'policy_changed' },
      '已取消原因不認得': { state: 'cancelled', ended_at: at, cancel_code: 'because' },
      '已取消沒有結束時間': { state: 'cancelled', cancel_code: 'policy_changed' },
    };
    for (const [label, o] of Object.entries(bad)) {
      const r = await a.batch([ins(o)]);
      assert.equal(r.ok, false, `${label}：應該寫不進去`);
      assert.match(r.error, /CHECK constraint failed/, `${label}：是 CHECK 擋下（${r.error}）`);
    }
    const good = { pending: {}, approved: { state: 'approved', ended_at: at, ended_by: boss.id, project_id: 'prj_chk' }, rejected: { state: 'rejected', ended_at: at, ended_by: boss.id, reject_reason: '不要' },
      withdrawn: { state: 'withdrawn', ended_at: at, ended_by: fay.id }, cancelled: { state: 'cancelled', ended_at: at, cancel_code: 'restore_invalid' } };
    const goodIds = [];
    for (const [label, o] of Object.entries(good)) { const st = ins(o); goodIds.push(st[1][0]); assert.deepEqual(await a.batch([st]), { ok: true }, `合法的 ${label} 寫得進去`); }
    // UPDATE 也一樣：待審直接改成已核准但沒帶專案
    const upd = await a.batch([["UPDATE project_creation_requests SET state = 'approved', ended_at = ?, ended_by = ? WHERE id = ?", [at, boss.id, goodIds[0]]]]);
    assert.equal(upd.ok, false, 'UPDATE 成不一致的狀態被擋');
    assert.match(upd.error, /CHECK constraint failed/);
    assert.equal((await stateOf(goodIds[0])).state, 'pending', '被擋的 UPDATE 沒有改到');
    await a.batch([[`DELETE FROM project_creation_requests WHERE id IN (${goodIds.map(() => '?').join(', ')})`, goodIds]]);
    note(`擋下 ${Object.keys(bad).length + 1} 種不一致；例：${upd.error}`);
  });

  // ===== D1-05 送出、核准、拒絕、撤回、因政策切換而取消 =====
  await check('D1-05', '生命週期：送出、核准（建立專案）、拒絕、撤回、移出成員與政策切換的系統取消；結束後不能再變', async note => {
    // 送出：通知審核人（boss、ann），不通知申請人
    const q1 = await submit(chen, { name: 'D1 核准', visibility: 'private', slug: 'd1-approved', code: 'DAPP', statuses: THREE });
    assert.equal(q1.state, 'pending');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request' AND id LIKE ?", `ntc_${q1.id}_%`), 2, '送出時通知兩位審核人');
    // 核准：建立專案、申請人是唯一的專案管理員、project.create 稽核、通知申請人
    const ap = within('核准', await approve(q1));
    assert.equal(ap.body?.state, 'approved', '核准：' + ap.text.slice(0, 200));
    const pid = ap.body.project.id;
    const proj = await a.one('SELECT name, visibility, created_at FROM projects WHERE id = ?', pid);
    assert.deepEqual([proj.name, proj.visibility], ['D1 核准', 'private'], '專案內容跟申請一樣');
    assert.deepEqual((await a.q('SELECT participant_id, role FROM project_members WHERE project_id = ?', pid)).map(m => [m.participant_id, m.role]), [[chen.id, 'admin']], '唯一的成員是申請人（專案管理員）');
    assert.deepEqual((await a.q("SELECT key, value FROM app_settings WHERE key IN (?, ?) ORDER BY key", 'pcode:' + pid, 'slug:' + pid)).map(r => r.value), ['DAPP', 'd1-approved'], '識別碼存進資料庫');
    assert.equal(await a.n('SELECT COUNT(*) AS n FROM project_statuses WHERE project = ?', pid), 3, '看板狀態照申請');
    assert.equal(await createAudits(q1.id), 1, '一筆 project.create 稽核指向這份申請');
    assert.equal((await stateOf(q1.id)).project_id, pid);
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE participant_id = ? AND kind = 'project_creation_request_approved'", chen.id), 1, '通知申請人');
    const mine = ok(await a.call(chen.token, '/api/projects'), '申請人看得到專案');
    assert.ok(mine.items.some(p => p.id === pid && p.slug === 'd1-approved' && p.code === 'DAPP'), '申請人的專案清單有它');
    // 拒絕
    const q2 = await submit(wang);
    const rj = within('拒絕', await reject(q2));
    assert.equal(rj.body?.state, 'rejected');
    assert.equal((await stateOf(q2.id)).reject_reason, '不需要');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project_creation_request.reject' AND json_extract(detail, '$.requestId') = ?", q2.id), 1, '拒絕稽核');
    is(await approve(q2), 409, 'REQUEST_NOT_PENDING', '拒絕後核准');
    // 撤回；再撤回一次（交易內斷言失敗 → D1 的錯誤要被認成「前提不成立」，回 409 而不是 500）
    const q3 = await submit(wang);
    assert.equal(ok(within('撤回', await withdraw(q3, wang)), '撤回').state, 'withdrawn');
    is(await withdraw(q3, wang), 409, 'REQUEST_NOT_PENDING', '再撤回');
    is(await reject(q3), 409, 'REQUEST_NOT_PENDING', '撤回後拒絕');
    // 移出成員：他的待審申請取消（workspace_member_removed）
    const q4 = await submit(gus);
    ok(within('移出成員', await a.call(boss.token, `/api/participants/${gus.id}/remove`, 'POST')), '移出古斯');
    assert.deepEqual([(await stateOf(q4.id)).state, (await stateOf(q4.id)).cancel_code], ['cancelled', 'workspace_member_removed']);
    // 政策切走：所有待審的取消（policy_changed）、每位申請人一則通知、稽核記下取消數
    const q5 = await submit(dan), q6 = await submit(eve), q7 = await submit(eve);
    const pendingBefore = await a.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'");
    const requesters = await a.n("SELECT COUNT(DISTINCT requester_id) AS n FROM project_creation_requests WHERE state = 'pending'");
    const noticesBefore = await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_cancelled'");
    ok(within('政策切走', await a.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' })), '政策切成 admins');
    for (const q of [q5, q6, q7]) assert.deepEqual([(await stateOf(q.id)).state, (await stateOf(q.id)).cancel_code], ['cancelled', 'policy_changed'], `${q.id} 因政策切換取消`);
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'"), 0, '沒有待審的了');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_cancelled'") - noticesBefore, requesters, '每位申請人一則取消通知');
    const pol = await a.one("SELECT count, detail FROM audit_log WHERE action = 'workspace_policy.update' ORDER BY seq DESC LIMIT 1");
    assert.equal(Number(pol.count), pendingBefore, 'workspace_policy.update 稽核記下取消數');
    is(await approve(q5), 409, 'REQUEST_NOT_PENDING', '取消後核准');
    is(await a.call(dan.token, '/api/project-creation-requests', 'POST', { requestId: 'd1v-closed', name: 'D1 關閉', reason: 'x' }), 403, 'PROJECT_CREATION_REQUESTS_CLOSED', '政策不是 approval 不能送');
    ok(await a.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策切回 approval');
    note(`政策切換取消 ${pendingBefore} 份、通知 ${requesters} 位`);
  });

  // ===== D1-06 交易內斷言失敗與中途失敗：整批回滾 =====
  await check('D1-06', '整批回滾：交易內斷言失敗、或核准那一批做到一半在 D1 裡失敗，什麼都不留；之後重試成功', async note => {
    // 直接用 Worker 的 wrapD1(env.DB).batch：第二句只有在第一句真的寫入後才會撞唯一 → 證明前面的句子執行過、而且被回滾
    const k = 'd1verify_marker_' + rid();
    let r = await a.batch([["INSERT INTO app_settings (key, value) VALUES (?, '1')", [k]], ["INSERT INTO app_settings (key, value) VALUES (?, '2')", [k]]]);
    assert.equal(r.ok, false, '同一批寫兩次同一鍵：失敗');
    assert.equal(await a.n('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?', k), 0, '第一句也被回滾');
    // ensureStmt 的斷言（app_settings NOT NULL）：錯誤原文要被 isNotNullViolation(e, 'app_settings') 認出
    r = await a.batch([["INSERT INTO app_settings (key, value) VALUES (?, '1')", [k]], ['UPDATE workspaces SET name = name WHERE id = ?', ['default']], ['INSERT INTO app_settings (key, value) SELECT NULL, NULL WHERE NOT (1 = 0)', []]]);
    assert.equal(r.ok, false, '斷言不成立：整批失敗');
    assert.ok(isNotNullViolation({ message: r.error }, 'app_settings'), `D1 的錯誤原文要被 isNotNullViolation(e, 'app_settings') 認出：${r.error}`);
    assert.equal(await a.n('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?', k), 0, '斷言前的寫入被回滾');
    note(`斷言失敗的 D1 錯誤原文：${r.error}`);
    // 正式程式：核准那一批，在每個寫入之後注入一句執行到才失敗的語句
    const points = [['INSERT INTO projects', 'dup', /^INSERT INTO projects \(/], ['INSERT INTO project_statuses', 'json', /^INSERT INTO project_statuses/], ['INSERT INTO project_members', 'json', /INSERT (OR \w+ )?INTO project_members/],
      ['INSERT INTO audit_log', 'json', /^INSERT INTO audit_log/], ['UPDATE project_creation_requests SET state', 'json', /^UPDATE project_creation_requests SET state/], ['INSERT INTO account_notices', 'json', /^INSERT INTO account_notices/]];
    for (const [label, mode, re] of points) {
      const q = await submit(fay, { statuses: THREE });
      await a.fault({ re: re.source, mode, times: 1 });
      const res = await approve(q);
      const st = await a.faultStatus();
      await a.fault({ re: null });
      assert.equal(st.hits, 1, `${label}：真的注入了`);
      assert.ok(res.status >= 500, `${label} 之後失敗：5xx（不冒充業務衝突）：${res.status} ${res.text.slice(0, 200)}`);
      assert.equal(await projectsNamed(q.name), 0, `${label} 之後失敗：沒有留下專案`);
      assert.equal((await stateOf(q.id)).state, 'pending', `${label} 之後失敗：申請維持待審`);
      assert.equal(await createAudits(q.id), 0, `${label} 之後失敗：沒有稽核`);
      assert.equal(await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE participant_id = ? AND kind = 'project_creation_request_approved' AND detail LIKE ?", fay.id, `%${q.name}%`), 0, `${label} 之後失敗：沒有通知`);
      assert.equal(await a.n('SELECT COUNT(*) AS n FROM project_members m WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = m.project_id)'), 0, `${label} 之後失敗：沒有孤兒成員資格`);
      const again = await approve(q);
      assert.equal(again.body?.state, 'approved', `${label}：重試核准成功：${again.text.slice(0, 200)}`);
      assert.equal(await projectsNamed(q.name), 1);
    }
    // 交易內斷言（核准前提）：核准那一批送出前，政策剛好被切走 → 交易內發現、409 POLICY_CHANGED、什麼都沒寫
    const q = await submit(fay);
    await a.fault({ re: /^INSERT INTO projects \(/.source, mode: 'before', sql: "UPDATE workspaces SET create_projects = 'members' WHERE id = 'default'", times: 1 });
    const res = await approve(q);
    const st = await a.faultStatus();
    await a.fault({ re: null });
    await a.batch([["UPDATE workspaces SET create_projects = 'approval' WHERE id = 'default'", []]]);
    assert.equal(st.hits, 1, '真的在核准那一批之前切走政策');
    is(res, 409, 'POLICY_CHANGED', '交易內才發現政策已改');
    assert.equal(await projectsNamed(q.name), 0, '沒有建立專案');
    assert.equal((await stateOf(q.id)).state, 'pending', '申請維持待審');
    // 申請人交易前一刻被移出（另一種前提）
    await a.fault({ re: /^INSERT INTO projects \(/.source, mode: 'before', sql: "UPDATE participants SET workspace_status = 'removed' WHERE id = ?", args: [fay.id], times: 1 });
    const res2 = await approve(q);
    await a.fault({ re: null });
    await a.batch([["UPDATE participants SET workspace_status = 'active' WHERE id = ?", [fay.id]]]);
    is(res2, 409, 'REQUESTER_NOT_ELIGIBLE', '交易內才發現申請人不符資格');
    assert.equal(await projectsNamed(q.name), 0, '沒有建立專案');
    assert.equal((await approve(q)).body?.state, 'approved', '前提恢復後核准成功');
    note(`注入點：${points.map(p => p[0]).join('、')}`);
  });

  // ===== D1-07 同時核准 =====
  await check('D1-07', '同一申請並行核准（兩位審核人、10 個請求同時）只建立一個專案；核准與拒絕同時只有一個生效', async note => {
    const q = await submit(wang, { name: 'D1 同時核准' });
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => approve(q, i % 2 ? ann : boss)));
    assert.ok(rs.every(r => r.status === 200 && r.body?.state === 'approved'), '全部回 200 已核准：' + rs.map(r => `${r.status}${r.body?.error?.code ? ' ' + r.body.error.code : ''}`).join(', '));
    assert.equal(new Set(rs.map(r => r.body.project?.id)).size, 1, '全部指向同一個專案');
    assert.equal(rs.filter(r => r.body.duplicate === false).length, 1, '只有一個是真的建立（其他 duplicate）');
    assert.equal(await projectsNamed('D1 同時核准'), 1, '資料庫只有一個專案');
    assert.equal(await createAudits(q.id), 1, '只有一筆 project.create');
    const pid = rs[0].body.project.id;
    assert.equal(await a.n('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?', pid), 1, '只有一筆成員資格');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE participant_id = ? AND kind = 'project_creation_request_approved' AND detail LIKE '%D1 同時核准%'", wang.id), 1, '只通知一次');
    // 核准與拒絕同時
    let approvedRuns = 0;
    for (let i = 0; i < 3; i++) {
      const x = await submit(wang, { name: `D1 核准或拒絕 ${i}` });
      const [ra, rr] = await Promise.all([approve(x, boss), reject(x, ann)]);
      const s = await stateOf(x.id);
      assert.ok(['approved', 'rejected'].includes(s.state), `結局是核准或拒絕：${s.state}`);
      assert.equal(await projectsNamed(x.name), s.state === 'approved' ? 1 : 0, '核准 ⇔ 有專案');
      assert.equal(ra.status === 200, s.state === 'approved', `核准的回應跟結局一致：${ra.status} ${ra.text.slice(0, 120)}`);
      assert.equal(rr.status === 200, s.state === 'rejected', `拒絕的回應跟結局一致：${rr.status} ${rr.text.slice(0, 120)}`);
      if (s.state === 'approved') approvedRuns++;
    }
    note(`10 個同時核准：1 個建立、9 個 duplicate；核准與拒絕同時 3 次，核准贏 ${approvedRuns} 次`);
  });

  // ===== D1-08 識別碼衝突與正規化 =====
  await check('D1-08', '識別碼：名稱、網址英文名、代號衝突（直接建立與核准）；舊資料的識別碼正規化（存進資料庫、既有衝突原樣保留並列出）', async note => {
    await reauth(a, boss);
    ok(await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 已有', slug: 'd1-taken', code: 'DTKN' }), '直接建立');
    is(await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 已有' }), 409, 'NAME_TAKEN', '同名');
    is(await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 另一個', slug: 'd1-taken' }), 409, 'SLUG_TAKEN', '網址英文名被占用');
    is(await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 另一個', code: 'DTKN' }), 409, 'CODE_TAKEN', '代號被占用');
    for (const [body, code, field] of [[{ name: 'D1 已有' }, 'NAME_TAKEN', 'name'], [{ slug: 'd1-taken' }, 'SLUG_TAKEN', 'slug'], [{ code: 'DTKN' }, 'CODE_TAKEN', 'code']]) {
      const q = await submit(dan, body);
      const r = is(await approve(q), 409, code, `核准撞到 ${field}`);
      assert.equal(r.error.field, field, '只說是哪個欄位');
      assert.equal((await stateOf(q.id)).state, 'pending', '申請維持待審');
      ok(await withdraw(q, dan), '撤回');
    }
    // 自動產生的代號避開已用的：名稱字母相同的兩個專案
    const p1 = ok(await a.call(boss.token, '/api/projects', 'POST', { name: 'Delta Echo', slug: 'delta-echo' }), '自動代號 1');
    const p2 = ok(await a.call(boss.token, '/api/projects', 'POST', { name: 'Delta Echo 2', slug: 'delta-echo-2' }), '自動代號 2');
    const codes = Object.fromEntries((await a.q("SELECT key, value FROM app_settings WHERE key IN (?, ?)", 'pcode:' + p1.id, 'pcode:' + p2.id)).map(r => [r.key, r.value]));
    assert.ok(codes['pcode:' + p1.id] && codes['pcode:' + p2.id] && codes['pcode:' + p1.id] !== codes['pcode:' + p2.id], `自動代號不重複：${JSON.stringify(codes)}`);
    // 舊資料（識別碼存進資料庫之前）：識別碼沒存、還有既有的衝突（兩個專案存了同一個網址英文名）；拿掉「已正規化」的標記
    const at = '2026-01-01T00:00:00.000Z';
    assert.deepEqual(await a.batch([
      ["INSERT INTO projects (id, name, archived, workspace_id, created_by, created_at, visibility) VALUES ('p_legacy_a', 'Legacy Alpha', 0, 'default', 'system', ?, 'open')", [at]],
      ["INSERT INTO projects (id, name, archived, workspace_id, created_by, created_at, visibility) VALUES ('p_legacy_b', 'Legacy Beta', 0, 'default', 'system', ?, 'open')", [at]],
      ["INSERT INTO app_settings (key, value) VALUES ('slug:p_legacy_a', 'legacy-site'), ('slug:p_legacy_b', 'legacy-site'), ('pcodeold:OLDL', 'p_legacy_a')", []],
      ["DELETE FROM app_settings WHERE key = 'project_identity_ready'", []],
    ]), { ok: true }, '寫入舊資料');
    // 第一個動到識別碼的寫入：還沒正規化 → 503 IDENTITY_NOT_READY（什麼都沒寫）；下一個請求先正規化，就成功
    const r1 = await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 正規化後' });
    is(r1, 503, 'IDENTITY_NOT_READY', '還沒正規化的寫入');
    assert.equal(await projectsNamed('D1 正規化後'), 0, '什麼都沒寫');
    const r2 = within('正規化後建立專案（含啟動正規化）', await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 正規化後' }));
    assert.equal(r2.status, 201, '正規化後建立成功：' + r2.text.slice(0, 200));
    assert.ok(await a.one("SELECT 1 AS x FROM app_settings WHERE key = 'project_identity_ready'"), '已正規化的標記');
    const stored = Object.fromEntries((await a.q("SELECT key, value FROM app_settings WHERE key IN ('pcode:p_legacy_a', 'pcode:p_legacy_b', 'slug:p_legacy_a', 'slug:p_legacy_b')")).map(r => [r.key, r.value]));
    assert.equal(Object.keys(stored).length, 4, `舊專案的代號都存進資料庫：${JSON.stringify(stored)}`);
    assert.notEqual(stored['pcode:p_legacy_a'], stored['pcode:p_legacy_b'], '推導的代號不重複');
    assert.deepEqual([stored['slug:p_legacy_a'], stored['slug:p_legacy_b']], ['legacy-site', 'legacy-site'], '既有的網址英文名衝突原樣保留');
    const items = ok(await a.call(boss.token, '/api/projects'), '專案清單').items;
    const shown = Object.fromEntries(items.filter(p => p.id.startsWith('p_legacy')).map(p => [p.id, p.code]));
    assert.deepEqual(shown, { p_legacy_a: stored['pcode:p_legacy_a'], p_legacy_b: stored['pcode:p_legacy_b'] }, '畫面顯示的就是存的值');
    const diag = ok(await a.call(boss.token, '/api/admin/project-identity'), '診斷');
    assert.equal(diag.normalized, true);
    assert.ok(diag.conflicts.some(c => c.kind === 'duplicate_slug' && c.value === 'legacy-site'), '診斷列出既有的網址英文名衝突：' + JSON.stringify(diag.conflicts));
    assert.deepEqual(diag.claims, { status: 'stale', disputes: [{ namespace: 'slug', value: 'legacy-site', claimants: [
      { projectId: 'p_legacy_a', source: 'slug', rawValue: 'legacy-site' }, { projectId: 'p_legacy_b', source: 'slug', rawValue: 'legacy-site' },
    ] }] }, '保留所有爭議來源，建立專案的舊寫入後標為過時');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM project_identity_claimants WHERE project_id = 'p_legacy_a' AND source IN ('historical_code', 'project_id')"), 2);
    const duplicate = await a.batch([["INSERT INTO project_identity_claims (namespace, value) VALUES ('slug', 'legacy-site')", []]]);
    assert.match(duplicate.error, /UNIQUE constraint failed/i, JSON.stringify(duplicate));
    is(await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 舊代號', code: 'OLDL' }), 409, 'CODE_TAKEN', '舊代號別名也算占用');
    is(await a.call(boss.token, '/api/projects', 'POST', { name: 'D1 撞正規化', code: stored['pcode:p_legacy_b'] }), 409, 'CODE_TAKEN', '正規化寫入的代號也算占用');
    note(`舊專案代號：${stored['pcode:p_legacy_a']}、${stored['pcode:p_legacy_b']}；既有衝突 ${diag.conflicts.length} 處`);
  });

  // ===== D1-09 大量取消、通知、稽核在 D1 限制內 =====
  await check('D1-09', '通知、稽核、大量取消的 SQL 在 D1 限制內（120 位申請人、180 份待審；每句 ≤100 參數、≤100 KB，每次執行查詢數 ≤50）', async note => {
    await reauth(a, boss);
    // 多幾位審核人（送出時的通知是一句 INSERT … SELECT 給所有審核人）
    for (const n of ['審核人甲', '審核人乙', '審核人丙']) { const p = await join(a, n); ok(await a.call(boss.token, `/api/participants/${p.id}/workspace-role`, 'PUT', { role: 'admin' }), n); }
    const crowd = [];
    for (let i = 0; i < 120; i += 10) crowd.push(...await Promise.all(Array.from({ length: 10 }, (_, j) => join(a, `申請人${String(i + j).padStart(3, '0')}`))));
    const subs = [];
    for (let i = 0; i < crowd.length; i += 10) {
      subs.push(...await Promise.all(crowd.slice(i, i + 10).flatMap((p, j) => [p, ...((i + j) % 2 ? [] : [p])].map((who, k) =>
        a.call(who.token, '/api/project-creation-requests', 'POST', { requestId: `bulk-${i + j}-${k}`, name: `大量 ${i + j}-${k}`, reason: '大量取消' })))));
    }
    assert.ok(subs.every(r => r.status === 201), '全部送出成功：' + [...new Set(subs.map(r => r.status))].join(','));
    within('送出（通知所有審核人）', subs[0]);
    const pending = await a.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'");
    const requesters = await a.n("SELECT COUNT(DISTINCT requester_id) AS n FROM project_creation_requests WHERE state = 'pending'");
    assert.ok(pending >= 180 && requesters >= 120, `待審 ${pending} 份、申請人 ${requesters} 位`);
    const reviewers = await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request' AND id LIKE ?", `ntc_${subs[0].body.id}_%`);
    assert.equal(reviewers, 5, '每份送出都通知 5 位審核人（2 位原本的 + 3 位新的）');
    // 審核清單分頁、通知清單
    const page = ok(within('審核清單（limit=100）', await a.call(boss.token, '/api/project-creation-requests?scope=review&state=pending&limit=100')), '審核清單');
    assert.deepEqual([page.items.length, page.pendingTotal, !!page.nextCursor], [100, pending, true], '審核清單一頁 100 份、待審總數準確、有下一頁');
    within('我的通知', await a.call(boss.token, '/api/me/notices'));
    // 大量取消：政策切走 → 一批取消全部、每位申請人一則通知、稽核記數
    const noticesBefore = await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_cancelled'");
    const t0 = Date.now();
    const r = within('政策切走（大量取消＋通知＋稽核）', await a.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }));
    const ms = Date.now() - t0;
    assert.equal(r.status, 200, '政策切走：' + r.text.slice(0, 200));
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'"), 0, '全部取消');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE cancel_code = 'policy_changed' AND ended_at = (SELECT MAX(ended_at) FROM project_creation_requests)"), pending, '這一批取消的數量');
    assert.equal(await a.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_cancelled'") - noticesBefore, requesters, '每位申請人一則通知');
    assert.equal(Number((await a.one("SELECT count FROM audit_log WHERE action = 'workspace_policy.update' ORDER BY seq DESC LIMIT 1")).count), pending, '稽核記下取消數');
    ok(await a.call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策切回 approval');
    // 停用帳號（跨工作區取消這位申請人的）
    const victim = crowd[0];
    ok(await a.call(victim.token, '/api/project-creation-requests', 'POST', { requestId: 'bulk-disable', name: '停用前', reason: 'x' }), '送出');
    within('停用帳號（取消他的待審）', await a.call(boss.token, `/api/participants/${victim.id}/disable`, 'POST'));
    assert.equal((await a.one("SELECT state, cancel_code FROM project_creation_requests WHERE request_id = 'bulk-disable'")).cancel_code, 'account_disabled');
    // 稽核清單
    within('稽核清單', await a.call(boss.token, '/api/audit-log?limit=100'));
    note(`待審 ${pending} 份、申請人 ${requesters} 位；政策切走 ${ms} ms`);
  });

  // ===== D1-10 備份還原 =====
  await check('D1-10', '備份還原：匯出 → 另一個全新的本機 D1 匯入 → 收尾取消不再成立的待審申請、識別碼正規化、稽核記數；沒有建立專案、沒有通知', async note => {
    await reauth(a, boss);
    // 備份來源：幾份待審申請（申請人之後在備份裡被停用、移出、或根本不存在），一份仍有效
    const keep = await submit(chen, { name: 'D1 還原保留' });
    const dis = await submit(wang, { name: 'D1 還原停用' });
    const rem = await submit(dan, { name: 'D1 還原移出' });
    const exportAll = async (s, tok) => {
      const info = ok(await s.call(tok, '/api/admin/backup?files=0'), '匯出清單');
      const out = { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion, tables: {} };
      for (const t of info.tables) {
        out.tables[t.name] = [];
        for (let after = 0; ;) {
          const r = within(`匯出 ${t.name}`, await s.call(tok, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=0`));
          out.tables[t.name].push(...ok(r, t.name).rows);
          if (r.body.next == null) break;
          after = r.body.next;
        }
      }
      return out;
    };
    const bk = await exportAll(a, boss.token);
    const T = bk.tables;
    const acct = id => T.accounts.find(x => x.id === T.participants.find(p => p.id === id).account_id);
    acct(wang.id).status = 'disabled'; // → account_disabled
    T.participants.find(p => p.id === dan.id).workspace_status = 'removed'; // → workspace_member_removed
    const shape = T.project_creation_requests.find(r => r.id === keep.id);
    T.project_creation_requests.push({ ...shape, id: 'pcr_ghost', request_id: 'r-ghost', name: 'D1 幽靈', requester_id: 'p_ghost' }); // → restore_invalid
    // 舊版的識別碼：拿掉一個專案存的代號、拿掉「已正規化」標記（收尾一定重新正規化）
    const strip = T.app_settings.find(s => s.key === 'pcode:p_legacy_a');
    T.app_settings = T.app_settings.filter(s => s !== strip);
    const projectsInBackup = T.projects.length;
    const expected = { [keep.id]: ['pending', null], [dis.id]: ['cancelled', 'account_disabled'], [rem.id]: ['cancelled', 'workspace_member_removed'], pcr_ghost: ['cancelled', 'restore_invalid'] };
    const terminalBefore = T.project_creation_requests.filter(r => r.state !== 'pending').length;
    // 全新的第二個本機 D1
    const B = localD1({ wrangler, tmpRoot, repoRoot, name: 'site-b', main });
    migrate(B, '還原目標');
    const w = await B.dev({ vars: VARS });
    running.push(w);
    const b = site(w.base, TOKEN);
    const first = await b.call(null, '/api/health');
    assert.equal(first.status, 200);
    const admin = await defaultAdmin(b, 'd1restorer');
    ok(within('開始匯入', await b.call(admin.token, '/api/admin/restore/begin', 'POST', { format: bk.format, formatVersion: bk.formatVersion, appVersion: bk.appVersion })), '開始匯入');
    for (const [t, rows] of Object.entries(bk.tables)) for (let i = 0; i < rows.length || i === 0; i += 1000) {
      ok(within(`匯入 ${t}`, await b.call(admin.token, '/api/admin/restore/rows', 'POST', { table: t, rows: rows.slice(i, i + 1000) })), '匯入 ' + t);
      if (!rows.length) break;
    }
    const claimsBefore = await b.q('SELECT namespace, value FROM project_identity_claims ORDER BY namespace, value');
    await b.fault({ re: /^INSERT INTO project_identity_claimants /.source, mode: 'json', times: 1 });
    is(await b.call(admin.token, '/api/admin/restore/finish', 'POST', {}), 503, 'RESTORE_UNFINISHED', '保留表寫入後失敗');
    assert.equal((await b.faultStatus()).hits, 1);
    assert.deepEqual(await b.q('SELECT namespace, value FROM project_identity_claims ORDER BY namespace, value'), claimsBefore, '新保留表整批回復');
    assert.equal(await b.n("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'project_identity_ready'"), 0, '沒有留下完成標記');
    const fin = within('還原收尾', await b.call(admin.token, '/api/admin/restore/finish', 'POST', {}));
    assert.equal(fin.status, 200, '收尾：' + fin.text.slice(0, 300));
    assert.equal(fin.body.cancelledProjectCreationRequests, 3, '收尾回應：因還原而取消 3 份');
    for (const [id, [state, code]] of Object.entries(expected)) {
      const s = await b.one('SELECT state, cancel_code, ended_by, project_id FROM project_creation_requests WHERE id = ?', id);
      assert.deepEqual([s?.state, s?.cancel_code ?? null], [state, code], `${id}：${state}${code ? `（${code}）` : ''}`);
    }
    assert.equal(await b.n("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state != 'pending' AND cancel_code IS NOT 'restore_invalid' AND id NOT IN (?, ?)", dis.id, rem.id), terminalBefore, '已結束的申請原樣保留');
    assert.equal(await b.n('SELECT COUNT(*) AS n FROM projects'), projectsInBackup, '沒有建立任何專案');
    assert.equal(await b.n("SELECT COUNT(*) AS n FROM account_notices WHERE kind LIKE 'project_creation_request%'"), 0, '不通知任何人');
    const audit = await b.q("SELECT count, detail FROM audit_log WHERE action = 'backup.restore'");
    assert.equal(audit.length, 1, '一筆 backup.restore 稽核');
    assert.equal(Number(audit[0].count), 3, '稽核記下因還原而取消的數量');
    assert.ok(await b.one("SELECT 1 AS x FROM app_settings WHERE key = 'project_identity_ready'"), '收尾後已正規化');
    assert.ok(await b.one("SELECT value FROM app_settings WHERE key = 'pcode:p_legacy_a'"), '拿掉的代號在收尾時重新存進資料庫');
    assert.equal(await b.n("SELECT COUNT(*) AS n FROM project_identity_claimants WHERE namespace = 'slug' AND value = 'legacy-site' AND source = 'slug'"), 2, '重建爭議識別碼及來源');
    assert.equal(await b.n("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'restore_state'"), 0, '不再是還原中');
    // 還原後照常運作：（登入已改掛到備份裡的平台管理員）有效的那份可以核准
    const ap = await b.call(admin.token, `/api/project-creation-requests/${keep.id}/approve`, 'POST', {});
    assert.equal(ap.body?.state, 'approved', '還原後核准保留的申請：' + ap.text.slice(0, 200));
    assert.equal(await b.n('SELECT COUNT(*) AS n FROM projects WHERE name = ?', 'D1 還原保留'), 1);
    note(`備份：${Object.values(T).reduce((x, r) => x + r.length, 0)} 列；收尾取消 3 份`);
  });

  await check('D1-11', '大量識別碼：26,000 個既有專案，逐頁正規化', async note => {
    const C = localD1({ wrangler, tmpRoot, repoRoot, name: 'site-large', main });
    migrate(C, '大量專案站');
    const w = await C.dev({ vars: VARS });
    running.push(w);
    const c = site(w.base, TOKEN), total = 26_000;
    assert.deepEqual(await c.batch([
      [`WITH RECURSIVE nums(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM nums WHERE n < ?)
        INSERT INTO projects (id, name, archived, created_at) SELECT 'legacy-網址英文名專案-' || n, 'Legacy ' || n, 1, '2026-01-01T00:00:00.000Z' FROM nums`, [total]],
      [`WITH RECURSIVE nums(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM nums WHERE n < ?)
        INSERT INTO app_settings (key, value) SELECT 'pcode:legacy-網址英文名專案-' || n,
          char(65+(n/17576)%26, 65+(n/676)%26, 65+(n/26)%26, 65+n%26) FROM nums`, [total]],
      ["INSERT INTO app_settings (key, value) SELECT 'slug:' || id, id FROM projects WHERE rowid % 2 = 0", []],
    ]), { ok: true });
    const boot = await c.call(null, '/api/health');
    assert.equal(boot.status, 200, boot.text.slice(0, 200));
    assert.equal(await c.n("SELECT COUNT(*) AS n FROM project_identity_claimants WHERE source = 'project_id'"), total);
    assert.equal(await c.n("SELECT COUNT(*) AS n FROM project_identity_claimants WHERE source = 'slug'"), total);
    assert.equal(await c.n("SELECT COUNT(*) AS n FROM project_identity_claimants WHERE source = 'current_code'"), total);
    assert.ok(await c.one("SELECT value FROM app_settings WHERE key = 'project_identity_ready'"));
    note(`${total} 個專案全部寫入保留表`);
  });

  if (usage.length) {
    console.log('\nD1 用量（每個請求＝一次 Worker 執行；查詢數裡 db.batch 整批算一次）：');
    const worst = [...usage].sort((x, y) => y.calls - x.calls);
    for (const u of VERBOSE ? worst : worst.slice(0, 8)) console.log('  ' + fmtUsage(u));
    const mp = Math.max(...usage.map(u => u.maxParams)), mb = Math.max(...usage.map(u => u.maxSqlBytes));
    console.log(`  全部量到的請求：單句最多 ${mp} 個參數（上限 ${LIMITS.params}）、單句最長 ${mb} 位元組（上限 ${LIMITS.sqlBytes}）`);
  }
} catch (e) {
  if (e) { console.log(`FAIL  執行中斷：${e.stack || e.message}`); exitCode = 1; }
} finally {
  for (const w of running) await w.stop().catch(() => {});
  const passed = results.filter(r => r.ok).length;
  if (results.length) console.log(`\n${passed}/${results.length} PASS${passed === results.length ? '' : `；FAIL：${results.filter(r => !r.ok).map(r => r.id).join('、')}`}`);
  if (exitCode === 0 && results.some(r => !r.ok)) exitCode = 1;
  if (exitCode === 0 && !results.length) exitCode = 1;
  if (KEEP || exitCode === 1) console.log(`本機 D1 與 wrangler dev 紀錄留在：${tmpRoot}`);
  else await removeDir(tmpRoot);
  console.log(exitCode === 0 ? 'D1 驗證：全部通過（本機 D1；正式 D1 的差異見 docs/d1-verification.md）' : exitCode === 2 ? 'D1 驗證：沒有執行（D1 未驗證）' : 'D1 驗證：有項目沒過');
  process.exit(exitCode);
}
