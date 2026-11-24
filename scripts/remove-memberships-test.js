// 驗收測試：移出工作區＝他在所有專案的成員資格都結束，封存的專案也算，帳號已停用時也一樣
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/remove-memberships-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { addToProject, listProjectMembers } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rmmem-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const A = '預設專案';
const inProject = async (tok, pj, id) => ok(await listProjectMembers(call, tok, pj), '專案成員').members.some(m => m.participantId === id);

try {
  const boss = ok(await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' }), '第一位');
  const chen = ok(await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' }), '陳昭宇');
  const zhao = ok(await call(null, '/api/join', 'POST', { name: '趙小安', role: 'QA' }), '趙小安');
  const Cn = chen.participant.participantId, Zh = zhao.participant.participantId;
  const X = ok(await call(boss.token, '/api/projects', 'POST', { name: '舊專案' }), '建專案').id;
  ok(await addToProject(call, boss.token, A, [Cn, Zh]), '加入預設專案');
  ok(await addToProject(call, boss.token, X, [Cn, Zh]), '加入舊專案');
  ok(await call(boss.token, `/api/projects/${X}/archive`, 'POST'), '封存舊專案');

  // 1) 封存專案的成員資格也結束
  ok(await call(boss.token, `/api/participants/${Cn}/remove`, 'POST'), '陳昭宇移出工作區');
  ok(await call(boss.token, `/api/projects/${X}/unarchive`, 'POST'), '還原舊專案');
  assert.ok(!(await inProject(boss.token, X, Cn)), '封存專案的成員資格也結束（還原後不在裡面）');
  assert.ok(!(await inProject(boss.token, A, Cn)), '未封存的專案也結束');
  console.log('✓ 移出工作區：封存專案的成員資格也結束');

  // 2) 帳號已停用的人被移出工作區：成員資格一樣結束
  ok(await call(boss.token, `/api/participants/${Zh}/disable`, 'POST'), '停用趙小安');
  ok(await call(boss.token, `/api/participants/${Zh}/remove`, 'POST'), '移出工作區');
  ok(await call(boss.token, `/api/participants/${Zh}/enable`, 'POST'), '恢復帳號（還是已移出工作區）');
  assert.ok(!(await inProject(boss.token, A, Zh)), '停用中被移出的人也不再是專案成員');
  assert.ok(!(await inProject(boss.token, X, Zh)), '封存過的專案也是');
  console.log('✓ 帳號已停用時移出工作區：成員資格一樣結束');

  console.log('remove-memberships-test：全部通過');
} catch (e) {
  console.error('remove-memberships-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
