// 遷移測試：跨專案角色取消（#11）。升級時跨專案角色的人（與 AI）變成每個未封存專案的明確成員資格，
// 原本的專案角色照舊（負責人＝專案管理員、唯讀成員）；設定裡不再有跨專案角色（cross_roles 轉完就刪掉），重跑不會再加回來。
// 舊規則：還沒寫成固定名單（沒有 frozen）時，角色是 PO／SM 的人算跨專案角色。
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/cross-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { testToken } from './test-token.js';
import { removeFromProject } from './test-members.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-cross-'));
const A = '預設專案', B = '第二專案', C = 'p_third', OLD = 'p_old';
const mkApp = db => {
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
};
const sorted = l => [...l].sort();
const crossSetting = async db => (await db.get("SELECT value FROM app_settings WHERE key = 'cross_roles'"))?.value;

// 升級前（008 之前）的資料庫：逗號字串的專案歸屬、app_settings 的 leader／唯讀／跨專案角色
async function oldDb(file, { cross, people }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = await openTestDb(file);
  for (const sql of ['DROP TABLE project_members', 'DROP TABLE accounts', 'DROP TABLE workspaces',
    'ALTER TABLE participants DROP COLUMN account_id', 'ALTER TABLE participants DROP COLUMN workspace_id',
    'ALTER TABLE participants DROP COLUMN workspace_role', 'ALTER TABLE participants DROP COLUMN workspace_status',
    'ALTER TABLE projects DROP COLUMN workspace_id', 'ALTER TABLE projects DROP COLUMN visibility',
    "DELETE FROM schema_migrations WHERE name = '008_members_access.sql'"]) await old.run(sql);
  await old.run('INSERT INTO projects (id, name, archived, created_at) VALUES (?, ?, 0, ?)', C, '第三專案', '2026-01-01T00:00:01.000Z');
  await old.run('INSERT INTO projects (id, name, archived, created_at) VALUES (?, ?, 1, ?)', OLD, '舊專案', '2026-01-01T00:00:02.000Z');
  let i = 0;
  for (const [id, kind, name, projects, extra = {}] of people) {
    const at = `2026-01-0${++i}T00:00:00.000Z`;
    const row = { id, kind, name, role: '', code: 'XC' + i + 'Z', token: 'h:old_' + id, created_at: at, updated_at: at, projects, ...extra };
    const cols = Object.keys(row);
    await old.run(`INSERT INTO participants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map(c => row[c]));
  }
  const set = (k, v) => old.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  await set('project_leaders', { [B]: ['p_cross'] });
  await set('read_only', { [C]: ['p_crossro'] });
  if (cross) await set('cross_roles', cross);
  await old.close();
}

// 1) 固定名單（frozen）：名單上的人與 AI 在每個未封存專案都有明確成員資格；原本的角色照舊；手動關掉的不算
const file = path.join(dir, 'frozen', 'switch.db');
await oldDb(file, {
  cross: { add: ['p_cross', 'p_crossro', 'p_crossai'], remove: ['p_sm'], frozen: '2026-01-01T00:00:00.000Z' },
  people: [
    ['p_boss', 'human', '林老闆', `${A},${B},${C},${OLD}`, { is_admin: 1, role: 'PO' }],
    ['p_cross', 'human', '王跨專', A, { role: 'PG' }],
    ['p_crossro', 'human', '陳唯讀', A, { role: 'QA' }],
    ['p_crossai', 'ai', '王的PG', A, { owner_id: 'p_cross', role: '程式開發', role_key: 'PG' }],
    ['p_sm', 'human', '老SM', A, { role: 'SM' }],
    ['p_plain', 'human', '張一般', B, { role: 'PG' }],
  ],
});
let db = await openTestDb(file);
try {
  let call = mkApp(db);
  const tok = {};
  for (const id of ['p_boss', 'p_cross', 'p_crossro', 'p_crossai', 'p_sm']) tok[id] = await testToken(db, id);
  const projectsOf = async id => sorted((await call(tok[id], '/api/me')).body.projects);
  assert.deepEqual(await projectsOf('p_cross'), sorted([A, B, C]), '跨專案角色 → 每個未封存專案的成員');
  assert.deepEqual(await projectsOf('p_crossai'), sorted([A, B, C]), '跨專案角色的 AI 也是');
  assert.deepEqual(await projectsOf('p_crossro'), sorted([A, B, C]), '唯讀的跨專案角色也是');
  assert.deepEqual(await projectsOf('p_sm'), [A], '手動關掉的（remove）照舊只在原本的專案');
  const pr = (await call(tok.p_boss, '/api/projects')).body;
  assert.deepEqual(pr.projectAdmins[B], ['p_cross'], '負責人身分保留：第二專案的專案管理員');
  assert.deepEqual(pr.viewers[C], ['p_crossro'], '唯讀成員照舊');
  assert.equal(pr.crossRoleIds, undefined, '回傳裡不再有跨專案角色');
  const members = async pj => (await call(tok.p_boss, `/api/projects/${pj}/members`)).body.members.map(m => m.participantId);
  assert.ok((await members(C)).includes('p_cross'), '第三專案的成員清單列出他（明確成員資格）');
  assert.ok(!(await members(OLD)).includes('p_cross'), '封存的專案不加');
  assert.equal(await crossSetting(db), undefined, '設定裡不再有跨專案角色');
  console.log('✓ 固定名單：跨專案角色轉成每個專案的成員資格，角色照舊');

  // 2) 轉過就不再轉：把他移出第三專案、重新啟動，不會被加回來
  assert.equal((await removeFromProject(call, tok.p_boss, C, 'p_cross')).status, 200, '跨專案角色取消後可以移出');
  await db.close();
  db = await openTestDb(file);
  call = mkApp(db);
  assert.deepEqual(sorted((await call(tok.p_cross, '/api/me')).body.projects), sorted([A, B]), '重新啟動不會再加回來');
  console.log('✓ 重複啟動不重複轉換');

  // 3) 已經轉過新資料表、但還留著 cross_roles 的資料庫（例如 #7 之後、#11 之前的版本）：一樣轉
  await db.run("INSERT INTO app_settings (key, value) VALUES ('cross_roles', ?)", JSON.stringify({ add: ['p_sm'], remove: [], frozen: '2026-01-01T00:00:00.000Z' }));
  call = mkApp(db);
  assert.deepEqual(sorted((await call(tok.p_sm, '/api/me')).body.projects), sorted([A, B, C]), '已轉過新表的站：跨專案角色一樣轉');
  assert.equal(await crossSetting(db), undefined);
  console.log('✓ 已轉過新資料表的站也轉');
} finally {
  await db.close();
}

// 4) 還沒寫成固定名單（沒有 cross_roles）：舊規則——角色是 PO／SM 的人與 AI 算跨專案角色
const file2 = path.join(dir, 'legacy', 'switch.db');
await oldDb(file2, {
  cross: null,
  people: [
    ['p_boss', 'human', '林老闆', `${A},${B},${C}`, { is_admin: 1, role: 'PG' }],
    ['p_cross', 'human', '王跨專', A, { role: 'SM' }],
    ['p_crossro', 'human', '陳唯讀', A, { role: 'QA' }],
    ['p_crossai', 'ai', '產品規劃助手', A, { owner_id: 'p_crossro', role: '產品規劃', role_key: 'PO' }],
  ],
});
db = await openTestDb(file2);
try {
  const call = mkApp(db);
  const me = async id => sorted((await call(await testToken(db, id), '/api/me')).body.projects);
  assert.deepEqual(await me('p_cross'), sorted([A, B, C]), '角色 SM 的人：每個專案');
  assert.deepEqual(await me('p_crossai'), sorted([A, B, C]), '角色 PO 的 AI：每個專案');
  assert.deepEqual(await me('p_crossro'), [A], '其他人照舊');
  assert.equal(await crossSetting(db), undefined);
  console.log('✓ 沒有固定名單的舊站：PO／SM 照舊規則轉');
  console.log('cross-test：全部通過');
} catch (e) {
  console.error('cross-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
