// 驗收測試：第一階段之前的備份（成員有 is_admin 與逗號字串的 projects、設定裡有負責人與唯讀）匯入這一版。
// 這一版沒有那兩個欄位：匯入時舊資料抄到 legacy_members，結束匯入後轉成工作區管理員、專案成員與專案角色，
// 透過 API 看到的跟升級前一樣（管理員看 is_admin、不是最早加入的人；負責人＝專案管理員；唯讀＝唯讀成員）；舊結構不留。
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/legacy-backup-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-lgbk-'));
const db = await openTestDb(path.join(dir, 'switch.db'), { legacyProjects: false });
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const A = '預設專案', B = '第二專案';
const at = d => `2026-01-0${d}T00:00:00.000Z`;
const person = (id, name, d, extra) => ({ id, kind: 'human', name, role: 'PG', role_key: '', code: id.slice(2, 6).toUpperCase(), owner_id: null, status: 'active', version: 1, created_at: at(d), updated_at: at(d), last_seen_at: 0, standby_at: 0, ...extra });
// 1.0.7 匯出的樣子：沒有 workspaces／accounts／project_members，成員列帶 is_admin、projects
const backup = {
  format: 'aigile-backup', formatVersion: 1, appVersion: '1.0.7',
  tables: {
    projects: [{ id: A, name: A, archived: 0, created_by: null, created_at: at(1) }, { id: B, name: B, archived: 0, created_by: null, created_at: at(1) }],
    app_settings: [
      { key: 'project_leaders', value: JSON.stringify({ [A]: ['p_lead'] }) },
      { key: 'read_only', value: JSON.stringify({ [B]: ['p_ro'] }) },
      { key: 'project_roles', value: JSON.stringify({ p_boss: { [A]: 'PO' } }) },
    ],
    participants: [
      person('p_lead', '李帶頭', 2, { is_admin: 0, projects: A }), // 最早加入的不是管理員
      person('p_boss', '林老闆', 3, { is_admin: 1, projects: `${A},${B}` }),
      person('p_ro', '陳唯讀', 4, { is_admin: 0, projects: `${A},${B}` }),
      { ...person('p_ai', '陳的PG', 5, { is_admin: 0, projects: B }), kind: 'ai', owner_id: 'p_ro', role_key: 'PG' },
    ],
  },
};

try {
  const me = (await call(null, '/api/join', 'POST', { name: '匯入的人', role: 'PO' })).body;
  let r = await call(me.token, '/api/admin/restore/begin', 'POST', { format: backup.format, formatVersion: backup.formatVersion, appVersion: backup.appVersion });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const [table, rows] of Object.entries(backup.tables)) {
    r = await call(me.token, '/api/admin/restore/rows', 'POST', { table, rows });
    assert.equal(r.status, 200, table + JSON.stringify(r.body));
    assert.equal(r.body.inserted, rows.length, `${table} 每列都寫進去`);
  }
  r = await call(me.token, '/api/admin/restore/finish', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.admin.participantId, 'p_boss', '匯入的人接上備份裡的管理員（看 is_admin，不是最早加入的人）');

  const tok = me.token; // 你的登入碼跟著到備份裡的管理員身上
  const mine = (await call(tok, '/api/me')).body;
  assert.equal(mine.participantId, 'p_boss');
  assert.deepEqual([mine.workspaceRole, mine.platformRole], ['admin', 'admin'], '原本的管理員＝工作區管理員兼平台管理員');
  const pr = (await call(tok, '/api/projects')).body;
  assert.deepEqual(pr.projectAdmins[A], ['p_lead'], '負責人＝專案管理員');
  assert.deepEqual(pr.viewers[B], ['p_ro'], '唯讀＝唯讀成員');
  const people = new Map((await call(tok, '/api/participants')).body.items.map(p => [p.participantId, p]));
  assert.deepEqual(people.get('p_boss').memberProjects, [A], '管理員只在有職稱的專案是成員，其他靠隱含權限');
  assert.deepEqual(people.get('p_lead').projects, [A]);
  assert.deepEqual([...people.get('p_ro').projects].sort(), [A, B].sort());
  assert.deepEqual(people.get('p_ai').projects, [B]);
  assert.deepEqual([...people.values()].filter(p => p.isAdmin).map(p => p.participantId), ['p_boss'], '只有一位管理員');
  assert.deepEqual([...people.values()].filter(p => p.platformRole === 'admin' || p.workspaceRole === 'admin').map(p => p.participantId), ['p_boss'], '平台、工作區角色照升級的對應：只有 is_admin 的人是平台管理員兼工作區管理員');
  const members = (await call(tok, `/api/projects/${B}/members`)).body.members;
  assert.equal(members.find(m => m.participantId === 'p_ai')?.role, 'viewer', 'AI 跟著所屬人類唯讀');

  // 舊結構不留
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM legacy_members')).n, 0, '抄起來的舊資料轉完就刪');
  assert.deepEqual((await db.all("SELECT key FROM app_settings WHERE key IN ('project_leaders', 'read_only', 'cross_roles')")).map(r => r.key), [], '舊設定刪了');
  const cols = (await db.all('PRAGMA table_info(participants)')).map(c => c.name);
  assert.ok(!cols.includes('is_admin') && !cols.includes('projects'), '沒有舊欄位');
  console.log('legacy-backup-test：全部通過');
} catch (e) {
  console.error('legacy-backup-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
}
