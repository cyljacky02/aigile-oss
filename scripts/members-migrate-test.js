// 驗收測試：升級到「成員與權限」新資料模型（migrations/008_members_access.sql，docs/adr/0002 第一階段）
// 舊站：單一管理員（is_admin）、逗號字串的專案歸屬、app_settings 的 leader／唯讀／跨專案角色／專案角色標籤、
// 隱形管理員（在專案裡但沒有角色標籤）、已停用、已刪除。用新版打開後，透過 API 看到的成員、專案、權限跟升級前一樣；
// 重複啟動不重複轉換；新站有預設工作區，第一位管理員是平台管理員兼工作區管理員。
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/members-migrate-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, tableNames } from './test-db.js';
import { testToken } from './test-token.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-mmig-'));
const file = path.join(dir, 'switch.db');
const A = '預設專案', B = '第二專案', OLD = 'p_old';
const mkApp = (db, config = {}) => {
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', ...config } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
};
const sorted = l => [...l].sort();
const n = async (db, sql, ...a) => Number((await db.get(sql, ...a)).n);

// 1) 做出升級前的資料庫：沒有新表與新欄位、008 還沒套；舊資料直接寫進去
{
  const old = await openTestDb(file);
  for (const sql of ['DROP TABLE project_members', 'DROP TABLE accounts', 'DROP TABLE workspaces',
    'ALTER TABLE participants DROP COLUMN account_id', 'ALTER TABLE participants DROP COLUMN workspace_id',
    'ALTER TABLE participants DROP COLUMN workspace_role', 'ALTER TABLE participants DROP COLUMN workspace_status',
    'ALTER TABLE projects DROP COLUMN workspace_id', 'ALTER TABLE projects DROP COLUMN visibility',
    "DELETE FROM schema_migrations WHERE name = '008_members_access.sql'"]) await old.run(sql);
  await old.run('INSERT INTO projects (id, name, archived, created_at) VALUES (?, ?, 1, ?)', OLD, '舊專案', '2026-01-01T00:00:02.000Z');
  const person = (id, kind, name, at, projects, extra = {}) => {
    const row = { id, kind, name, role: '', code: id.slice(2, 6).toUpperCase(), token: 'h:old_' + id, created_at: at, updated_at: at, projects, ...extra };
    const cols = Object.keys(row);
    return old.run(`INSERT INTO participants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map(c => row[c]));
  };
  // 最早加入的不是管理員：管理員看 is_admin，不是看誰最早
  await person('p_lead', 'human', '李帶頭', '2026-01-02T00:00:00.000Z', `${A},${OLD}`, { role: 'PG' });
  await person('p_boss', 'human', '林老闆', '2026-01-03T00:00:00.000Z', `${A},${B},${OLD}`, { role: 'PO', is_admin: 1 });
  await person('p_ro', 'human', '陳唯讀', '2026-01-04T00:00:00.000Z', `${A},${B}`, { role: 'QA' });
  await person('p_ai', 'ai', '陳的PG', '2026-01-05T00:00:00.000Z', B, { owner_id: 'p_ro', role: '程式開發', role_key: 'PG' });
  await person('p_cross', 'human', '王跨專', '2026-01-06T00:00:00.000Z', `${A},${B}`, { role: 'SM' });
  await person('p_off', 'human', '趙停用', '2026-01-07T00:00:00.000Z', A, { status: 'disabled' });
  await person('p_gone', 'human', '錢已刪', '2026-01-08T00:00:00.000Z', B, { status: 'deleted' });
  await person('p_new', 'human', '孫新人', '2026-01-09T00:00:00.000Z', '');
  const set = (k, v) => old.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  await set('project_leaders', { [A]: ['p_lead'], [OLD]: ['p_lead'] });
  await set('read_only', { [B]: ['p_ro'] });
  await set('cross_roles', { add: ['p_cross'], remove: [], frozen: '2026-01-01T00:00:00.000Z' });
  // 專案角色標籤；管理員只在預設專案有標籤 → 在第二專案是「隱形」的
  await set('project_roles', { p_boss: { [A]: 'PO' }, p_lead: { [A]: 'PG', [OLD]: 'PG' }, p_ro: { [A]: 'QA', [B]: 'QA' }, p_cross: { [A]: 'SM', [B]: 'SM' } });
  await old.run("INSERT INTO app_settings (key, value) VALUES ('group_name', '舊群組')");
  await old.close();
}

// 升級後透過 API 看到的：跟升級前的畫面一樣
async function seesSameAsBefore(db, call, label) {
  const tok = {};
  for (const id of ['p_boss', 'p_lead', 'p_ro', 'p_ai', 'p_cross', 'p_new']) tok[id] = await testToken(db, id);
  const pr = await call(tok.p_boss, '/api/projects');
  assert.equal(pr.status, 200, label + JSON.stringify(pr.body).slice(0, 300));
  assert.equal(pr.body.adminId, 'p_boss', `${label}：管理員照舊（看 is_admin，不是最早加入的人）`);
  assert.deepEqual(pr.body.leaders[A], ['p_lead'], `${label}：leader 照舊`);
  assert.deepEqual(pr.body.leaders[B] || [], [], `${label}：沒有 leader 的專案照舊沒有`);
  assert.deepEqual(pr.body.archivedLeaders, { [OLD]: ['p_lead'] }, `${label}：封存專案的 leader 照舊（才能還原）`);
  assert.deepEqual(pr.body.readOnly[B], ['p_ro'], `${label}：唯讀照舊`);
  assert.deepEqual(pr.body.readOnly[A] || [], [], `${label}：別的專案不唯讀`);
  assert.deepEqual(pr.body.crossRoleIds, ['p_cross'], `${label}：跨專案角色照舊`);
  const count = id => pr.body.items.find(x => x.id === id).memberCount;
  assert.equal(count(A), 4, `${label}：預設專案 4 人（管理員有角色標籤、停用的不算）`);
  assert.equal(count(B), 3, `${label}：第二專案 3 人（隱形管理員、已刪除的不算）`);

  const people = new Map((await call(tok.p_boss, '/api/participants')).body.items.map(p => [p.participantId, p]));
  const projectsOf = id => sorted(people.get(id).projects);
  assert.deepEqual(projectsOf('p_boss'), sorted([A, B]), `${label}：隱形管理員的成員資格先原樣保留`);
  assert.deepEqual(projectsOf('p_lead'), [A], label);
  assert.deepEqual(projectsOf('p_ro'), sorted([A, B]), label);
  assert.deepEqual(projectsOf('p_ai'), [B], label);
  assert.deepEqual(projectsOf('p_cross'), sorted([A, B]), label);
  assert.deepEqual(projectsOf('p_new'), [], `${label}：沒有專案的人照舊沒有`);
  assert.ok(!people.has('p_off') && !people.has('p_gone'), `${label}：停用、已刪除的不在成員清單`);
  assert.deepEqual([...people.values()].filter(p => p.isAdmin).map(p => p.participantId), ['p_boss'], `${label}：只有一位管理員`);
  assert.deepEqual(people.get('p_boss').projectRoles, { [A]: 'PO', [B]: '' }, `${label}：角色標籤照舊`);
  const disabled = (await call(tok.p_boss, '/api/participants/disabled')).body.items.map(p => p.participantId);
  assert.deepEqual(disabled, ['p_off'], `${label}：停用的人照舊列在已停用`);

  // 權限：唯讀的人與他的 AI 在那個專案不能寫、別的專案可以；leader 能管自己的專案、一般成員不行
  assert.deepEqual((await call(tok.p_ro, '/api/me')).body.readOnlyIn, [B], label);
  assert.deepEqual((await call(tok.p_ai, '/api/me')).body.readOnlyIn, [B], `${label}：AI 跟著所屬人類唯讀`);
  const msg = (t, project) => call(t, '/api/messages', 'POST', { requestId: 'm' + Math.random(), project, text: '升級後說話' });
  assert.equal((await msg(tok.p_ai, B)).body.error?.code, 'READ_ONLY', `${label}：唯讀成員的 AI 不能寫`);
  assert.equal((await msg(tok.p_ro, B)).body.error?.code, 'READ_ONLY', `${label}：唯讀成員不能寫`);
  assert.equal((await msg(tok.p_ro, A)).status, 201, `${label}：在別的專案可以寫`);
  const joinSet = t => call(t, `/api/projects/${A}/join-settings`, 'PUT', { open: true, note: '' });
  assert.equal((await joinSet(tok.p_lead)).status, 200, `${label}：leader 能管自己的專案`);
  assert.equal((await joinSet(tok.p_ro)).status, 403, `${label}：一般成員不能管`);
  assert.equal((await call(tok.p_new, '/api/me')).body.projects.length, 0, label);
}

let db = await openTestDb(file);
try {
  // 2) 升級只建表與欄位（資料轉換在程式第一個請求時做）
  assert.ok((await db.all("SELECT name FROM schema_migrations WHERE name = '008_members_access.sql'")).length, '008 套上了');
  for (const t of ['workspaces', 'accounts', 'project_members']) assert.ok((await tableNames(db)).includes(t), `建了 ${t}`);
  assert.equal(await n(db, 'SELECT COUNT(*) AS n FROM project_members'), 0, '升級本身不轉資料');

  // 3) 第一個請求：轉換舊資料，API 看到的跟升級前一樣
  await seesSameAsBefore(db, mkApp(db), '第一次啟動');
  console.log('✓ 升級後成員、專案、權限照舊');

  // 新結構裡的樣子（遷移測試例外，直接看表）
  const ws = await db.get("SELECT name, create_projects FROM workspaces WHERE id = 'default'");
  assert.deepEqual({ ...ws }, { name: '舊群組', create_projects: 'admins' }, '預設工作區：名稱取群組名稱；升級的站只有管理員能建專案');
  const pp = new Map((await db.all('SELECT id, account_id, workspace_id, workspace_role, workspace_status FROM participants')).map(r => [r.id, r]));
  assert.ok([...pp.values()].every(r => r.workspace_id === 'default'), '每個人都在預設工作區');
  assert.equal(pp.get('p_ai').account_id, null, 'AI 沒有帳號');
  assert.deepEqual([...pp.values()].filter(r => r.workspace_role === 'admin').map(r => r.id), ['p_boss'], '現任管理員＝工作區管理員');
  assert.equal(pp.get('p_gone').workspace_status, 'removed', '已刪除＝已移出工作區');
  const acc = new Map((await db.all('SELECT a.id, a.platform_role, a.status, p.id AS pid FROM accounts a JOIN participants p ON p.account_id = a.id')).map(r => [r.pid, r]));
  assert.equal(acc.size, 7, '每位人類一個帳號');
  assert.deepEqual([...acc.values()].filter(r => r.platform_role === 'admin').map(r => r.pid), ['p_boss'], '現任管理員＝平台管理員');
  assert.deepEqual([...acc.values()].filter(r => r.status === 'disabled').map(r => r.pid), ['p_off'], '停用＝停用帳號');
  const role = async (pj, id) => (await db.get('SELECT role FROM project_members WHERE project_id = ? AND participant_id = ?', pj, id))?.role;
  assert.equal(await role(A, 'p_lead'), 'admin', 'leader＝專案管理員');
  assert.equal(await role(OLD, 'p_lead'), 'admin', '封存專案的 leader 也是');
  assert.equal(await role(B, 'p_ro'), 'viewer', '唯讀＝唯讀成員');
  assert.equal(await role(A, 'p_ro'), 'member');
  assert.equal(await role(B, 'p_boss'), 'member', '隱形管理員的成員資格先保留');
  assert.ok((await db.all('SELECT workspace_id, visibility FROM projects')).every(r => r.workspace_id === 'default' && r.visibility === 'review'), '專案都在預設工作區、可見度先存審核');
  console.log('✓ 新表的內容');

  // 4) 重複啟動：不重複轉換（另一份程式、重開資料庫都一樣）
  const before = [await n(db, 'SELECT COUNT(*) AS n FROM project_members'), await n(db, 'SELECT COUNT(*) AS n FROM accounts')];
  await seesSameAsBefore(db, mkApp(db), '同時另一份程式');
  await db.close();
  db = await openTestDb(file);
  await seesSameAsBefore(db, mkApp(db), '重新啟動');
  assert.deepEqual([await n(db, 'SELECT COUNT(*) AS n FROM project_members'), await n(db, 'SELECT COUNT(*) AS n FROM accounts')], before, '沒有多出列');
  console.log('✓ 重複啟動不重複轉換');
} finally {
  await db.close();
}

// 5) 新站：預設工作區；第一位管理員是平台管理員兼工作區管理員
const freshFile = path.join(dir, 'fresh', 'switch.db');
fs.mkdirSync(path.dirname(freshFile));
const fdb = await openTestDb(freshFile);
try {
  const call = mkApp(fdb);
  const first = (await call(null, '/api/join', 'POST', { name: '第一位', role: 'PO' })).body.participant.participantId;
  const second = (await call(null, '/api/join', 'POST', { name: '第二位', role: 'PG' })).body.participant.participantId;
  assert.deepEqual({ ...(await fdb.get("SELECT create_projects FROM workspaces WHERE id = 'default'")) }, { create_projects: 'members' }, '新站：所有成員都能建專案');
  const who = async id => ({ ...(await fdb.get('SELECT p.workspace_id, p.workspace_role, a.platform_role FROM participants p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?', id)) });
  assert.deepEqual(await who(first), { workspace_id: 'default', workspace_role: 'admin', platform_role: 'admin' }, '第一位：平台管理員兼工作區管理員');
  assert.deepEqual(await who(second), { workspace_id: 'default', workspace_role: 'member', platform_role: 'none' }, '之後的人：一般成員');
  assert.equal(await n(fdb, 'SELECT COUNT(*) AS n FROM project_members WHERE participant_id = ?', first), 2, '第一位在所有專案');
  assert.equal(await n(fdb, 'SELECT COUNT(*) AS n FROM project_members WHERE participant_id = ?', second), 0, '之後的人沒有專案');
  console.log('✓ 新站（第一位自己註冊）');
} finally {
  await fdb.close();
}
// 預設管理員（正式站）：admin 帳號也是平台管理員兼工作區管理員
const adminFile = path.join(dir, 'admin', 'switch.db');
fs.mkdirSync(path.dirname(adminFile));
const adb = await openTestDb(adminFile, { legacyProjects: false });
try {
  const call = mkApp(adb, { defaultAdmin: '1' });
  assert.equal((await call(null, '/api/health')).status, 200);
  const r = await adb.get("SELECT p.workspace_id, p.workspace_role, a.platform_role FROM participants p JOIN accounts a ON a.id = p.account_id WHERE p.kind = 'human'");
  assert.deepEqual({ ...r }, { workspace_id: 'default', workspace_role: 'admin', platform_role: 'admin' }, '預設管理員：平台管理員兼工作區管理員');
  assert.equal(await n(adb, 'SELECT COUNT(*) AS n FROM project_members'), 1, '預設管理員在自動建的預設專案');
  console.log('✓ 新站（預設管理員）');
  console.log('members-migrate-test：全部通過');
} finally {
  await adb.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
