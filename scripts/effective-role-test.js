// 驗收測試：專案裡的實際角色＝明確的專案角色與上層管理員的隱含權限「取較高者」
// 1. 唯讀成員升為工作區管理員（或平台管理員）後能寫，他的 AI 也能寫（AI 的權限不超過所屬人類）
// 2. 只有職稱不算成員：有隱含權限的人在沒加入的專案設了職稱，照樣不列在專案成員、名單、人數裡
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/effective-role-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import { addToProject, setProjectRole, listProjectMembers, removeFromProject } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-effrole-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
let beforeTitleWrite;
const appDb = { ...db, async batch(stmts) {
  if (beforeTitleWrite && stmts.some(([sql, args]) => sql.startsWith('INSERT INTO project_events') && args[3]?.includes('「UX」'))) {
    const run = beforeTitleWrite;
    beforeTitleWrite = undefined;
    await run();
  }
  return db.batch(stmts);
} };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const A = '預設專案', B = '第二專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const join = async name => (await call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
let rq = 0;
const post = (tok, pj) => call(tok, '/api/messages', 'POST', { requestId: 'm' + ++rq, project: pj, text: '測試訊息 ' + rq });

try {
  const boss = await join('林志明'); // 平台管理員＋工作區管理員
  const chen = await join('陳昭宇'), wang = await join('王小美');
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  boss.token = (await adminSession(call, boss.token)).token; // 任免管理員、停用帳號是敏感操作：用設了密碼、剛再驗證過的裝置登入
  ok(await addToProject(call, boss.token, A, Cn), '陳昭宇加入');
  ok(await addToProject(call, boss.token, A, Wg, 'viewer'), '王小美以唯讀成員加入');
  const ai = ok(await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S }), '建 AI');
  ok(await setProjectRole(call, boss.token, A, Cn, 'viewer'), '陳昭宇改為唯讀成員');
  assert.equal(code(await post(chen.token, A)), 'READ_ONLY', '唯讀成員不能寫');
  assert.equal(code(await post(ai.token, A)), 'READ_ONLY', '他的 AI 也不能寫');

  // 1) 升為工作區管理員：隱含的專案管理權比明確的唯讀成員高
  ok(await call(boss.token, `/api/participants/${Cn}/workspace-role`, 'PUT', { role: 'admin' }), '陳昭宇升為工作區管理員');
  assert.equal((await post(chen.token, A)).status, 201, '升為工作區管理員後能寫（取較高者）');
  assert.equal((await post(ai.token, A)).status, 201, '他的 AI 也能寫');
  assert.equal((await call(ai.token, '/api/cards', 'POST', { requestId: 'card' + ++rq, project: A, title: 'AI 建的卡' })).status, 201, 'AI 也能建卡');
  //    升為平台管理員也一樣
  ok(await call(boss.token, `/api/participants/${Wg}/platform-role`, 'PUT', { role: 'admin' }), '王小美升為平台管理員');
  assert.equal((await post(wang.token, A)).status, 201, '升為平台管理員後能寫');
  //    降回成員：又是唯讀成員
  ok(await call(boss.token, `/api/participants/${Cn}/workspace-role`, 'PUT', { role: 'member' }), '陳昭宇降回成員');
  assert.equal(code(await post(chen.token, A)), 'READ_ONLY', '降回成員後照舊唯讀');
  assert.equal(code(await post(ai.token, A)), 'READ_ONLY', '他的 AI 也照舊唯讀');
  console.log('✓ 唯讀成員升為工作區／平台管理員後能寫，AI 跟著');

  // 2) 只有職稱不算成員：林志明沒加入第二專案，只設了職稱
  const setTitle = (tok, id, project, title) => call(tok, `/api/participants/${id}/project-roles`, 'PUT', { roles: { [project]: title } });
  assert.equal(ok(await setTitle(boss.token, Bo, B, 'PO'), '設職稱').projectRoles[B], 'PO');
  assert.equal(ok(await setTitle(wang.token, Wg, B, 'QA'), '平台管理員設職稱').projectRoles[B], 'QA');
  const members = ok(await listProjectMembers(call, boss.token, B), '第二專案成員').members;
  assert.ok(!members.some(m => [Bo, Wg].includes(m.participantId)), '專案成員不列只有職稱的上層管理員');
  const listed = ok(await call(boss.token, `/api/participants?project=${B}`), '專案名單').items;
  assert.ok(!listed.some(p => p.participantId === Bo), '專案名單不列他');
  const item = ok(await call(boss.token, '/api/projects'), '專案清單').items.find(p => p.id === B);
  assert.equal(item.memberCount, 0, '人數不算他');
  console.log('✓ 只有職稱不算成員');

  beforeTitleWrite = async () => ok(await removeFromProject(call, boss.token, A, Cn), '移出專案');
  const stale = await setTitle(chen.token, Cn, A, 'UX');
  assert.deepEqual([stale.status, code(stale)], [409, 'CONFLICT']);
  ok(await addToProject(call, boss.token, A, Cn), '重新加入');
  assert.equal(ok(await call(chen.token, '/api/me'), '讀取職稱').projectRoles[A], '', '過期的職稱寫入沒有生效');

  console.log('effective-role-test：全部通過');
} catch (e) {
  console.error('effective-role-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
