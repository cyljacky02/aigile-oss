// 工作區設定與「誰可以建立專案」（GLOSSARY「成員與權限」）
// - 新安裝：所有成員都能建立專案；升級的站：只有工作區管理員能建立（升級前的行為）
// - 只有工作區管理員能改這個設定；AI 不能建立專案、不能改設定
// - 建立專案的人自動成為該專案的專案管理員
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/workspace-settings-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { testToken } from './test-token.js';
import { toPrePhase1 } from './legacy-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wset-'));
const mkApp = db => {
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
};
const code = r => r.body.error?.code;
const SETTINGS = '/api/workspace/settings';

// 1) 新安裝
const freshFile = path.join(dir, 'fresh', 'switch.db');
fs.mkdirSync(path.dirname(freshFile));
let db = await openTestDb(freshFile);
try {
  const call = mkApp(db);
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位＝工作區管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body; // 一般成員
  const Cn = chen.participant.participantId;
  await call(boss.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['預設專案'] });
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '陳的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.ok(ai.token, '建了 AI');

  // 預設：所有成員
  const s0 = await call(boss.token, SETTINGS);
  assert.equal(s0.status, 200, JSON.stringify(s0.body));
  assert.equal(s0.body.createProjects, 'members', '新安裝：所有成員都能建立專案');
  assert.equal((await call(chen.token, '/api/projects')).body.canCreateProject, true, '一般成員看得到自己能建專案');

  // 一般成員建立專案 → 成為專案管理員
  const mine = await call(chen.token, '/api/projects', 'POST', { name: '陳的專案' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const pj = mine.body.id;
  const seen = (await call(chen.token, '/api/projects')).body;
  assert.ok(seen.items.some(p => p.id === pj), '建立者看得到自己的專案');
  assert.deepEqual(seen.leaders[pj], [Cn], '建立者是該專案的專案管理員');
  assert.equal((await call(chen.token, `/api/projects/${pj}`, 'PATCH', { name: '陳的新專案' })).status, 200, '建立者能管理自己的專案（改名）');
  assert.equal((await call(chen.token, `/api/projects/${pj}/delete-preview`)).status, 403, '刪除專案仍只有工作區管理員');

  // AI 不能建立專案、不能看或改設定
  assert.equal((await call(ai.token, '/api/projects', 'POST', { name: 'AI 的專案' })).status, 403, 'AI 不能建立專案');
  assert.equal((await call(ai.token, '/api/projects')).body.canCreateProject, false, 'AI 看到自己不能建專案');
  assert.equal((await call(ai.token, SETTINGS, 'PUT', { createProjects: 'admins' })).status, 403, 'AI 不能改設定');

  // 只有工作區管理員能改
  assert.equal((await call(chen.token, SETTINGS)).status, 403, '一般成員不能看工作區設定');
  assert.equal((await call(chen.token, SETTINGS, 'PUT', { createProjects: 'admins' })).status, 403, '一般成員不能改');
  assert.equal(code(await call(boss.token, SETTINGS, 'PUT', { createProjects: 'everyone' })), 'INVALID_REQUEST', '只能是 members 或 admins');
  const s1 = await call(boss.token, SETTINGS, 'PUT', { createProjects: 'admins' });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal(s1.body.createProjects, 'admins');
  assert.equal((await call(boss.token, SETTINGS)).body.createProjects, 'admins', '存起來了');
  const log = (await call(boss.token, '/api/group/events')).body.items.map(e => e.text);
  assert.ok(log.some(t => /林志明 .*只有工作區管理員/.test(t)), '異動紀錄有記：' + log.join('｜'));

  // 只有管理員：一般成員被拒，管理員可以且成為專案管理員
  const denied = await call(chen.token, '/api/projects', 'POST', { name: '又一個' });
  assert.equal(denied.status, 403, '設成只有管理員後一般成員被拒');
  assert.equal(code(denied), 'NOT_ADMIN');
  assert.equal((await call(chen.token, '/api/projects')).body.canCreateProject, false);
  assert.equal((await call(boss.token, '/api/projects')).body.canCreateProject, true, '工作區管理員永遠能建');
  const bp = await call(boss.token, '/api/projects', 'POST', { name: '管理員的專案' });
  assert.equal(bp.status, 201, JSON.stringify(bp.body));
  assert.deepEqual((await call(boss.token, '/api/projects')).body.leaders[bp.body.id], [boss.participant.participantId], '工作區管理員建立的專案：他也是專案管理員');

  // 改回所有成員：立刻生效
  assert.equal((await call(boss.token, SETTINGS, 'PUT', { createProjects: 'members' })).body.createProjects, 'members');
  assert.equal((await call(chen.token, '/api/projects', 'POST', { name: '又一個' })).status, 201, '改回所有成員後可以建');
  console.log('✓ 新安裝：誰可以建立專案');
} finally {
  await db.close();
}

// 2) 升級的站：預設只有管理員（建立專案的行為跟升級前一樣）
const oldFile = path.join(dir, 'old', 'switch.db');
fs.mkdirSync(path.dirname(oldFile));
{
  const old = await openTestDb(oldFile);
  await toPrePhase1(old);
  const person = (id, name, at, projects, extra = {}) => {
    const row = { id, kind: 'human', name, role: '', code: id.slice(2, 6).toUpperCase(), token: 'h:old_' + id, created_at: at, updated_at: at, projects, ...extra };
    const cols = Object.keys(row);
    return old.run(`INSERT INTO participants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map(c => row[c]));
  };
  await person('p_boss', '林老闆', '2026-01-02T00:00:00.000Z', '預設專案,第二專案', { is_admin: 1 });
  await person('p_mem', '陳成員', '2026-01-03T00:00:00.000Z', '預設專案');
  await old.close();
}
for (const label of ['第一次啟動', '重新啟動']) {
  db = await openTestDb(oldFile);
  try {
    const call = mkApp(db);
    const boss = await testToken(db, 'p_boss'), mem = await testToken(db, 'p_mem');
    assert.equal((await call(boss, SETTINGS)).body.createProjects, 'admins', `${label}：升級的站預設只有管理員能建立專案`);
    assert.equal((await call(mem, '/api/projects', 'POST', { name: '成員偷建' + label })).status, 403, `${label}：升級後一般成員照舊不能建`);
    assert.equal((await call(boss, '/api/projects', 'POST', { name: '老闆建' + label })).status, 201, `${label}：工作區管理員照舊能建`);
  } finally {
    await db.close();
  }
}
console.log('✓ 升級的站：只有管理員');
fs.rmSync(dir, { recursive: true, force: true });
console.log('workspace-settings-test：全部通過');
