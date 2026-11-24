// 驗收測試：只有工作區成員能被加進專案
// 1. PUT /api/participants/:id/projects（保留一版）跟專案成員端點一樣：已移出工作區、已停用的人回 403 NOT_WORKSPACE_MEMBER
// 2. 移出工作區時，他還在審核的加入申請一併清掉；申請人已不是工作區成員時，核准失敗（不會把他加回專案）
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/workspace-member-only-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wsonly-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const A = '預設專案', B = '第二專案';
const join = async name => (await call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
const put = (tok, id, projects) => call(tok, `/api/participants/${id}/projects`, 'PUT', { projects });

try {
  const boss = await join('林志明');
  const chen = await join('陳昭宇'), wang = await join('王小美'), zhao = await join('趙小安');
  const Cn = chen.participant.participantId, Wg = wang.participant.participantId, Zh = zhao.participant.participantId;

  // 1) 舊的整份專案清單端點也只收工作區成員
  ok(await put(boss.token, Cn, [A]), '工作區成員照常');
  ok(await call(boss.token, `/api/participants/${Cn}/remove`, 'POST'), '陳昭宇移出工作區');
  const r1 = await put(boss.token, Cn, [A, B]);
  assert.equal(r1.status, 403, '已移出的人不能被加進專案：' + JSON.stringify(r1.body));
  assert.equal(code(r1), 'NOT_WORKSPACE_MEMBER');
  ok(await call(boss.token, `/api/participants/${Zh}/disable`, 'POST'), '趙小安停用');
  assert.equal(code(await put(boss.token, Zh, [A])), 'NOT_WORKSPACE_MEMBER', '停用的人也不行');
  assert.equal((await put(boss.token, 'p_nobody', [A])).status, 404, '找不到的人');
  console.log('✓ PUT /api/participants/:id/projects 只收工作區成員');

  // 2) 加入申請：移出時清掉；申請人已不是工作區成員時不能核准
  ok(await call(boss.token, `/api/projects/${B}/join-settings`, 'PUT', { open: true, note: '' }), '第二專案開放申請');
  const req = ok(await call(wang.token, `/api/projects/${B}/join-requests`, 'POST', { note: '想幫忙' }), '王小美申請');
  ok(await call(boss.token, `/api/participants/${Wg}/remove`, 'POST'), '王小美移出工作區');
  const pending = ok(await call(boss.token, '/api/join-requests'), '待審申請').items;
  assert.ok(!pending.some(x => x.participantId === Wg), '移出時他的待審申請一併清掉');
  const ap = await call(boss.token, `/api/join-requests/${req.id}/approve`, 'POST', {});
  assert.ok(ap.status >= 400, '清掉的申請不能核准：' + JSON.stringify(ap.body));
  //    申請還在（例如別份程式移出時剛好有人申請）：核准也要擋
  await db.run("INSERT INTO join_requests (id, project, participant_id, note, status, created_at) VALUES ('jr_left', ?, ?, '', 'pending', ?)", B, Wg, new Date().toISOString());
  const ap2 = await call(boss.token, '/api/join-requests/jr_left/approve', 'POST', {});
  assert.equal(ap2.status, 403, '申請人已不是工作區成員：' + JSON.stringify(ap2.body));
  assert.equal(code(ap2), 'NOT_WORKSPACE_MEMBER');
  const members = ok(await call(boss.token, `/api/projects/${B}/members`), '第二專案成員').members;
  assert.ok(!members.some(m => m.participantId === Wg), '沒有被加回專案');
  assert.equal((await db.get("SELECT status FROM join_requests WHERE id = 'jr_left'")).status, 'pending', '申請沒有被標成核准');
  console.log('✓ 移出工作區清掉待審申請；申請人不是工作區成員時不能核准');

  console.log('workspace-member-only-test：全部通過');
} catch (e) {
  console.error('workspace-member-only-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
