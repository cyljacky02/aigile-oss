// 驗收測試（ADR 0004、0005）：專案網址英文名與代號存進資料庫，新寫入不得新增衝突
// A. 升級：舊結構的資料（沒存的網址英文名與代號、舊代號、既有的衝突）開機後正規化，每個專案顯示的網址英文名與代號前後完全相同；
//    正規化沒做成時，動到名稱或識別碼的寫入回 503，其他功能照常；重跑結果相同；既有衝突原樣保留，平台管理員看得到診斷
// B. 新寫入：建立一定存代號；指定值撞到（含舊代號、可復原期內的專案）回 409，不透露看不到的私人專案；
//    改代號不轉移衝突；取消封存、復原不讓既有衝突變成使用中；卡片代號與舊代號連結照舊
// C. 交錯：直接建立與改代號搶同一個代號只有一方成功；自動產生的網址英文名被搶走時重算重試
// D. 新站的預設專案、示範資料一定寫入網址英文名與代號
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-identity-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import { createProjectIdentity } from '../src/project-identity.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pident-'));
const opened = [];
const READY = 'project_identity_ready';
const config = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
// 一個站：failReady＝寫入「已正規化」標記的那批一律失敗（模擬正規化寫不進去）；before＝下一個含符合 re 的寫入之前先跑 run()（一次）
function site(db) {
  const ctl = { failReady: false, before: null };
  const appDb = { ...db, batch: async stmts => {
    if (ctl.failReady && stmts.some(([sql, a]) => /VALUES/.test(sql) && (a || [])[0] === READY)) throw new Error('模擬的資料庫寫入失敗');
    const b = ctl.before && stmts.some(([sql]) => ctl.before.re.test(sql)) ? ctl.before : null;
    if (b) { ctl.before = null; await b.run(); }
    return db.batch(stmts);
  } };
  const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config });
  ctl.call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  };
  return ctl;
}
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => assert.deepEqual([r.status, code(r)], [status, errCode], `${label}：${JSON.stringify(r.body).slice(0, 300)}`);
const at = n => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
// 識別碼設定（網址英文名、代號、舊代號）全部列出來，比對前後用
const identityRows = async db => (await db.all("SELECT key, value FROM app_settings WHERE (key >= 'pcode:' AND key < 'pcode;') OR (key >= 'pcodeold:' AND key < 'pcodeold;') OR (key >= 'slug:' AND key < 'slug;') ORDER BY key")).map(r => `${r.key}=${r.value}`);

// 升級前每個專案畫面上的網址英文名與代號（照升級前的規則手算：存了就用存的；沒存的代號取網址英文名前 4 個英文字母，
// 撞到明確設定的或前面專案的就換最後一個字母；網址英文名沒有字母就 PJ＋第幾個專案的字母；網址英文名沒存：固定專案用預設、其他用 id）
const EXPECTED = {
  '預設專案': ['main', 'MAIN'], '第二專案': ['second', 'SECOA'], p_alpha: ['alpha', 'ALPH'], p_alpha2: ['alpha-two', 'ALPHA'], p_zh: ['p_zh', 'PJE'],
  p_sec: ['sec-x', 'SECO'], p_old: ['old-one', 'OLD'], p_gone: ['gone', 'GONE'], p_dup1: ['twin', 'DUP'], p_dup2: ['twin', 'DUP'],
  p_beta: ['beta', 'BETA'], p_same1: ['same-a', 'SAME'], p_same2: ['same-b', 'SAMEA'], p_bad: ['bad-x', 'BADX'],
};

try {
  // ---------- A. 舊結構的資料 ----------
  const db = await openTestDb(path.join(dataDir, 'switch.db')); // 預設專案、第二專案（沒存網址英文名與代號）
  opened.push(db);
  const project = (id, name, n, extra = {}) => db.run('INSERT INTO projects (id, name, archived, workspace_id, created_at, deleted_at, purge_at) VALUES (?,?,?,?,?,?,?)',
    id, name, extra.archived ? 1 : 0, 'default', at(n), extra.deleted ? at(20) : null, extra.deleted ? Date.now() + 30 * 86400_000 : null);
  const setting = (key, value) => db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', key, value);
  await project('p_alpha', 'Alpha', 2); await setting('slug:p_alpha', 'alpha');
  await project('p_alpha2', 'Alpha Two', 3); await setting('slug:p_alpha2', 'alpha-two'); await setting('pcodeold:ALF', 'p_alpha2');
  await project('p_zh', '中文專案', 4);
  await project('p_sec', 'Sec', 5); await setting('slug:p_sec', 'sec-x'); await setting('pcode:p_sec', 'SECO');
  await project('p_old', 'Old', 6, { archived: true }); await setting('slug:p_old', 'old-one'); await setting('pcode:p_old', 'OLD'); await setting('pcodeold:OLDO', 'p_old');
  await project('p_gone', 'Gone', 7, { archived: true, deleted: true }); await setting('slug:p_gone', 'gone');
  await project('p_dup1', 'Dup One', 8); await setting('slug:p_dup1', 'twin'); await setting('pcode:p_dup1', 'DUP');
  await project('p_dup2', 'Dup Two', 9); await setting('slug:p_dup2', 'twin'); await setting('pcode:p_dup2', 'DUP');
  await project('p_beta', 'Beta', 10); await setting('slug:p_beta', 'beta'); await setting('pcodeold:BETA', 'p_alpha');
  await project('p_same1', 'Same', 11); await setting('slug:p_same1', 'same-a');
  await project('p_same2', 'Same', 12); await setting('slug:p_same2', 'same-b');
  await project('p_bad', 'Bad', 13); await setting('slug:p_bad', 'bad-x'); await setting('pcode:p_bad', 'bad'); // 不合規則的代號：畫面上用推導的
  const aliasesBefore = (await identityRows(db)).filter(x => x.startsWith('pcodeold:'));

  const A = site(db);
  A.failReady = true; // 正規化寫不進去
  const boss = ok(await A.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' }), '第一位（平台管理員兼工作區管理員）');
  const chen = ok(await A.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' }), '一般成員');
  const shown = async s => {
    const items = ok(await s.call(boss.token, '/api/projects'), '專案清單').items;
    const out = Object.fromEntries(items.map(p => [p.id, [p.slug, p.code]]));
    for (const d of ok(await s.call(boss.token, '/api/deleted-projects'), '已刪除的專案').items) out[d.projectId] = [null, d.code];
    return out;
  };
  const expectedShown = { ...EXPECTED, p_gone: [null, 'GONE'] };
  const before = await shown(A);
  assert.deepEqual(before, expectedShown, '升級前畫面上的值（照舊規則推導）');
  assert.equal(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', READY), null, '正規化沒做成：沒有標記');
  assert.equal(await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'slug:預設專案'"), null, '正規化沒做成：沒有寫入一半');

  // 正規化沒做成：動到名稱或識別碼命名空間的寫入回 503（可重試），什麼都沒寫；其他功能照常
  {
    const count = async () => Number((await db.get('SELECT COUNT(*) AS n FROM projects')).n);
    const n0 = await count();
    const r = await A.call(boss.token, '/api/projects', 'POST', { name: '新專案' });
    is(r, 503, 'IDENTITY_NOT_READY', '建立專案');
    assert.ok(Number(r.headers.get('retry-after')) > 0, '附 Retry-After');
    is(await A.call(boss.token, '/api/projects/p_alpha', 'PATCH', { name: 'Alpha 改' }), 503, 'IDENTITY_NOT_READY', '改名');
    is(await A.call(boss.token, '/api/projects/p_alpha/slug', 'PUT', { slug: 'alpha-new' }), 503, 'IDENTITY_NOT_READY', '改網址英文名');
    is(await A.call(boss.token, '/api/projects/p_alpha/code', 'PUT', { code: 'ALNE' }), 503, 'IDENTITY_NOT_READY', '改代號');
    is(await A.call(boss.token, '/api/projects/p_same2/archive', 'POST'), 503, 'IDENTITY_NOT_READY', '封存');
    is(await A.call(boss.token, '/api/projects/p_old/unarchive', 'POST'), 503, 'IDENTITY_NOT_READY', '取消封存');
    assert.equal(await count(), n0, '沒有多出專案');
    assert.equal((await db.get("SELECT name FROM projects WHERE id = 'p_alpha'")).name, 'Alpha', '名字沒改');
    assert.equal(Number((await db.get("SELECT archived FROM projects WHERE id = 'p_same2'")).archived), 0, '沒有封存');
    // 其他功能：發卡片、發訊息照常
    const card = ok(await A.call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: 'p_alpha2', title: '升級前的卡' }), '建立卡片');
    assert.equal(card.cardId, 'ALPHA-1', '卡片代號');
    ok(await A.call(boss.token, '/api/messages', 'POST', { requestId: 'm1', text: '大家好', project: 'p_alpha' }), '發訊息');
    // 診斷：還沒正規化也看得到
    const d = ok(await A.call(boss.token, '/api/admin/project-identity'), '診斷');
    assert.equal(d.normalized, false);
    console.log('✓ 正規化沒做成：建立、改名、改網址英文名與代號、封存、取消封存回 503；卡片、訊息照常');
  }

  // 正規化做成：每個專案顯示的值跟升級前完全相同，而且都存進資料庫；舊代號別名照舊
  A.failReady = false;
  const after = await shown(A);
  assert.deepEqual(after, before, '升級前後每個專案顯示的網址英文名與代號完全相同');
  for (const [id, [slug, pcode]] of Object.entries(EXPECTED)) {
    assert.equal((await db.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + id))?.value, slug, `${id} 的網址英文名存進資料庫`);
    assert.equal((await db.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + id))?.value, pcode, `${id} 的代號存進資料庫`);
  }
  assert.deepEqual((await identityRows(db)).filter(x => x.startsWith('pcodeold:')), aliasesBefore, '舊代號別名不動');
  assert.ok(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', READY), '標記已正規化');
  console.log('✓ 升級前後每個專案顯示的網址英文名與代號完全相同，且都存進資料庫');

  // 卡片代號、舊代號連結照舊
  {
    assert.equal(ok(await A.call(boss.token, '/api/cards/ALPHA-1'), '卡片代號').cardId, 'ALPHA-1');
    assert.equal(ok(await A.call(boss.token, '/api/cards/ALF-1'), '舊代號').cardId, 'ALPHA-1', '舊代號查得到同一張卡');
    console.log('✓ 卡片代號、舊代號連結照舊');
  }

  // 重跑：清掉標記、另一份程式開機再正規化一次，結果完全相同
  {
    const rows = await identityRows(db);
    await db.run('DELETE FROM app_settings WHERE key = ?', READY);
    const A2 = site(db);
    assert.deepEqual(await shown(A2), before, '重跑後顯示的值一樣');
    assert.deepEqual(await identityRows(db), rows, '重跑後存的值一樣');
    assert.ok(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', READY), '重跑後標記已正規化');
    console.log('✓ 正規化重跑結果相同');
  }

  // 既有衝突：原樣保留、平台管理員看得到診斷，其他人看不到
  const conflicts = async () => ok(await A.call(boss.token, '/api/admin/project-identity'), '診斷').conflicts
    .map(c => `${c.kind} ${c.value} ${c.projects.map(p => p.id).join(',')}`).sort();
  {
    const d = ok(await A.call(boss.token, '/api/admin/project-identity'), '診斷');
    assert.equal(d.normalized, true);
    assert.deepEqual(await conflicts(), [
      'code_is_old_alias BETA p_beta,p_alpha', 'duplicate_code DUP p_dup1,p_dup2', 'duplicate_name Same p_same1,p_same2', 'duplicate_slug twin p_dup1,p_dup2'].sort(), '既有的衝突');
    assert.equal(d.conflicts.find(c => c.kind === 'duplicate_code').projects[0].name, 'Dup One', '明細有專案名稱');
    is(await A.call(chen.token, '/api/admin/project-identity'), 403, 'NOT_ADMIN', '一般成員看不到');
    const lin = ok(await A.call(null, '/api/join', 'POST', { name: '林工作', role: 'PG' }), '另一位');
    const admin = await adminSession(A.call, boss.token);
    ok(await A.call(admin.token, `/api/participants/${lin.participant.participantId}/workspace-role`, 'PUT', { role: 'admin' }), '升為工作區管理員');
    is(await A.call(lin.token, '/api/admin/project-identity'), 403, 'NOT_ADMIN', '工作區管理員（不是平台管理員）看不到');
    // 既有衝突不停用建立專案
    const g = ok(await A.call(boss.token, '/api/projects', 'POST', { name: 'Gamma' }), '有既有衝突照樣能建立專案').id;
    assert.deepEqual([(await db.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + g))?.value, (await db.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + g))?.value], ['gamma', 'GAMM'], '直接建立一定存網址英文名與代號');
    console.log('✓ 既有衝突原樣保留；只有平台管理員看得到診斷；照樣能建立專案（一定存代號）');
  }

  // ---------- B. 新寫入不得新增、擴大或轉移衝突 ----------
  {
    const create = body => A.call(boss.token, '/api/projects', 'POST', body);
    is(await create({ name: 'X1', code: 'DUP' }), 409, 'CODE_TAKEN', '建立：撞到既有代號');
    is(await create({ name: 'X1', code: 'OLDO' }), 409, 'CODE_TAKEN', '建立：撞到別的專案的舊代號');
    is(await create({ name: 'X1', code: 'GONE' }), 409, 'CODE_TAKEN', '建立：撞到可復原期內的專案的代號');
    is(await create({ name: 'X1', slug: 'gone' }), 409, 'SLUG_TAKEN', '建立：撞到可復原期內的專案的網址英文名');
    is(await create({ name: 'X1', slug: 'twin' }), 409, 'SLUG_TAKEN', '建立：撞到既有重複的網址英文名');
    // 改代號、改網址英文名：撞到回 409
    is(await A.call(boss.token, '/api/projects/p_alpha/code', 'PUT', { code: 'DUP' }), 409, 'CODE_TAKEN', '改代號撞到既有代號');
    is(await A.call(boss.token, '/api/projects/p_alpha/code', 'PUT', { code: 'ALF' }), 409, 'CODE_TAKEN', '改代號撞到別的專案的舊代號');
    is(await A.call(boss.token, '/api/projects/p_alpha/slug', 'PUT', { slug: 'beta' }), 409, 'SLUG_TAKEN', '改網址英文名撞到');
    // 自己的舊代號可以改回來
    ok(await A.call(boss.token, '/api/projects/p_alpha2/code', 'PUT', { code: 'ALF' }), '改回自己的舊代號');
    assert.equal((await db.get("SELECT value FROM app_settings WHERE key = 'pcodeold:ALPHA'"))?.value, 'p_alpha2', '舊代號留作別名');
    assert.equal(ok(await A.call(boss.token, '/api/cards/ALPHA-1'), '舊代號連結').cardId, 'ALF-1', '舊卡號照樣查得到，現在顯示新代號');
    // 重複代號的其中一個改掉：舊代號同時是別的專案的代號，不寫成別名（不把重複代號轉成「代號與他案舊代號相同」）
    ok(await A.call(boss.token, '/api/projects/p_dup1/code', 'PUT', { code: 'DUPA' }), '重複代號的一方改代號');
    assert.equal(await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'pcodeold:DUP'"), null, '沒有寫 DUP 的別名');
    // 重複的代號改成別人的舊代號：409，不會把別人的舊代號搬走
    is(await A.call(boss.token, '/api/projects/p_dup2/code', 'PUT', { code: 'OLDO' }), 409, 'CODE_TAKEN', '不能拿別人的舊代號');
    assert.equal((await db.get("SELECT value FROM app_settings WHERE key = 'pcodeold:OLDO'")).value, 'p_old', '別人的舊代號沒被搬走');
    assert.deepEqual(await conflicts(), ['code_is_old_alias BETA p_beta,p_alpha', 'duplicate_name Same p_same1,p_same2', 'duplicate_slug twin p_dup1,p_dup2'].sort(), '衝突只少不多');
    console.log('✓ 指定值撞到（含舊代號、可復原期內的專案）回 409；改代號不轉移衝突');
  }

  // 取消封存、復原：既有衝突不能因此變成使用中（409 IDENTITY_CONFLICT），改掉之後就可以
  {
    ok(await A.call(boss.token, '/api/projects/p_dup2/archive', 'POST'), '封存 p_dup2');
    is(await A.call(boss.token, '/api/projects/p_dup2/unarchive', 'POST'), 409, 'IDENTITY_CONFLICT', '取消封存：網址英文名跟別的專案重複');
    assert.equal(Number((await db.get("SELECT archived FROM projects WHERE id = 'p_dup2'")).archived), 1, '維持封存');
    ok(await A.call(boss.token, '/api/projects/p_dup2/slug', 'PUT', { slug: 'twin-2' }), '封存中改網址英文名');
    ok(await A.call(boss.token, '/api/projects/p_dup2/unarchive', 'POST'), '改掉後可以取消封存');
    // 復原：可復原期內的專案的網址英文名被舊資料重複用了（直接改資料庫模擬升級前就有的衝突）
    await db.run("UPDATE app_settings SET value = 'gone' WHERE key = 'slug:p_same1'");
    const admin = await adminSession(A.call, boss.token);
    is(await A.call(admin.token, '/api/projects/p_gone/restore', 'POST'), 409, 'IDENTITY_CONFLICT', '復原：網址英文名跟別的專案重複');
    assert.ok((await db.get("SELECT deleted_at FROM projects WHERE id = 'p_gone'")).deleted_at, '維持已刪除');
    await db.run("UPDATE app_settings SET value = 'same-a' WHERE key = 'slug:p_same1'");
    ok(await A.call(admin.token, '/api/projects/p_gone/restore', 'POST'), '沒有衝突就能復原');
    console.log('✓ 取消封存、復原不讓既有衝突變成使用中');
  }

  // 撞到看不到的私人專案：409 但不說是哪個專案
  {
    ok(await A.call(boss.token, '/api/projects/p_sec/visibility', 'PUT', { visibility: 'private' }), '設成私人專案');
    const r1 = await A.call(chen.token, '/api/projects', 'POST', { name: 'Chen 的專案', code: 'SECO' });
    is(r1, 409, 'CODE_TAKEN', '一般成員建立撞到私人專案的代號');
    assert.ok(!r1.body.error.message.includes('Sec'), '不透露私人專案的名稱：' + r1.body.error.message);
    const r2 = await A.call(chen.token, '/api/projects', 'POST', { name: 'Chen 的專案', slug: 'sec-x' });
    is(r2, 409, 'SLUG_TAKEN', '一般成員建立撞到私人專案的網址英文名');
    assert.ok(!r2.body.error.message.includes('Sec'), '不透露私人專案的名稱：' + r2.body.error.message);
    console.log('✓ 撞到看不到的私人專案：409，不透露是哪個專案');
  }

  // ---------- C. 交錯（SQLite、D1 一次一個交易：第二個請求在第一個寫入前整個做完） ----------
  const interleave = async (re, first, second) => {
    let r2 = null;
    A.before = { re, run: async () => { r2 = await second(); } };
    const r1 = await first();
    assert.equal(A.before, null, '真的有交錯');
    return { r1, r2 };
  };
  const CREATE = /^INSERT INTO projects\b/;
  {
    const { r1, r2 } = await interleave(CREATE, () => A.call(boss.token, '/api/projects', 'POST', { name: 'Race', code: 'RACE' }),
      () => A.call(boss.token, '/api/projects/p_alpha/code', 'PUT', { code: 'RACE' }));
    ok(r2, '先做完的改代號');
    is(r1, 409, 'CODE_TAKEN', '後做的建立');
    assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key >= 'pcode:' AND key < 'pcode;' AND value = 'RACE'")).n), 1, '只有一個專案用 RACE');
    assert.equal(await db.get("SELECT 1 AS x FROM projects WHERE name = 'Race'"), null, '後做的建立什麼都沒寫');
    console.log('✓ 直接建立與改代號搶同一個代號：只有一方成功');
  }
  {
    const { r1, r2 } = await interleave(CREATE, () => A.call(boss.token, '/api/projects', 'POST', { name: 'Delta' }),
      () => A.call(boss.token, '/api/projects', 'POST', { name: 'delta' }));
    const a = ok(r1, '後做的建立（自動產生的值被搶走，重算重試）').id, b = ok(r2, '先做完的建立').id;
    const ident = async id => [(await db.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + id)).value, (await db.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + id)).value];
    assert.deepEqual(await ident(b), ['delta', 'DELT']);
    assert.deepEqual(await ident(a), ['delta-2', 'DELTA'], '重算出沒被用的網址英文名與代號');
    console.log('✓ 自動產生的網址英文名與代號被搶走：重讀重算重試');
  }

  // ---------- D. 新站的預設專案、示範資料 ----------
  {
    const fresh = await openTestDb(path.join(dataDir, 'fresh.db'), { legacyProjects: false });
    opened.push(fresh);
    const F = site(fresh);
    const me = ok(await F.call(null, '/api/join', 'POST', { name: '新站站長', role: 'PO' }), '新站第一位');
    const pj = ok(await F.call(me.token, '/api/projects'), '專案清單').items[0];
    assert.deepEqual([pj.slug, pj.code], [pj.id, 'PJA'], '新站預設專案顯示的值照舊（網址英文名還沒取＝專案 id）');
    assert.deepEqual([(await fresh.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + pj.id))?.value, (await fresh.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + pj.id))?.value], [pj.id, 'PJA'], '新站預設專案的網址英文名與代號存進資料庫');
    // 示範資料：demo／DEMO 被用了就挑別的，一定存
    ok(await F.call(me.token, `/api/projects/${pj.id}/slug`, 'PUT', { slug: 'demo' }), '預設專案取名 demo');
    ok(await F.call(me.token, `/api/projects/${pj.id}/code`, 'PUT', { code: 'DEMO' }), '預設專案代號 DEMO');
    const demo = ok(await F.call(me.token, '/api/admin/demo', 'POST', {}), '載入示範資料');
    const items = ok(await F.call(me.token, '/api/projects'), '專案清單').items;
    const dp = items.find(p => p.id === demo.projectId);
    assert.deepEqual([dp?.slug, dp?.code], ['demo-2', 'DEMOA'], '示範專案的網址英文名與代號沒撞到');
    assert.deepEqual([(await fresh.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + dp.id))?.value, (await fresh.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + dp.id))?.value], ['demo-2', 'DEMOA'], '示範專案的值存進資料庫');
    assert.ok((await fresh.get("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%DEMOA-%'")).n > 0, '示範對話用示範專案的卡號');
    console.log('✓ 新站預設專案、示範資料一定寫入網址英文名與代號');
  }

  // ---------- E. 讀取失敗跟「沒有資料」分得清楚 ----------
  {
    const odd = await openTestDb(path.join(dataDir, 'readfail.db')); // 預設專案、第二專案；第二專案明確設了代號 MAIN
    opened.push(odd);
    await odd.run("INSERT INTO app_settings (key, value) VALUES ('pcode:第二專案', 'MAIN')");
    let failReads = true;
    const flaky = { ...odd, all: (sql, ...a) => (failReads && /app_settings/.test(sql) ? Promise.reject(new Error('模擬的讀取失敗')) : odd.all(sql, ...a)) };
    const ident = createProjectIdentity({ db: flaky, nowIso: () => new Date().toISOString() });
    await assert.rejects(() => ident.normalize(), /模擬的讀取失敗/, '讀不到就丟，不當作沒有設定');
    assert.equal(await odd.get('SELECT 1 AS x FROM app_settings WHERE key = ?', READY), null, '沒有標記已正規化');
    assert.deepEqual(await identityRows(odd), ['pcode:第二專案=MAIN'], '什麼都沒寫');
    failReads = false;
    assert.equal(await ident.normalize(), true);
    assert.deepEqual(await identityRows(odd), ['pcode:第二專案=MAIN', 'pcode:預設專案=MAINA', 'slug:第二專案=second', 'slug:預設專案=main'], '讀得到之後照實際的設定算（預設專案避開明確設定的 MAIN）');
    console.log('✓ 正規化讀取失敗就丟、什麼都不寫，不當作沒有資料');
  }

  console.log('project-identity-test：全部通過');
} catch (e) {
  console.error('project-identity-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const d of opened) await d.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
