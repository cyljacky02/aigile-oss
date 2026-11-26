// 測試：申請加入專案（leader 打開才看得到；只有人類能申請；leader／管理員人工核准或拒絕，不自動加入）
// 隔離與權限：沒開放看不到、非 leader 與 AI 403、核准前不是成員、核准後才是（角色、唯讀、異動紀錄、通知）
// 用法：node scripts/join-request-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';
import { makeProjectAdmin, setProjectRole, listProjectMembers } from './test-members.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
let failNotice, writeGate;
const decisionDb = { ...db, async batch(stmts) {
  if (writeGate && stmts.some(([sql]) => writeGate.match.test(sql))) {
    const { entered, resume } = writeGate;
    writeGate = undefined;
    entered.resolve();
    await resume.promise;
  }
  // Fail the notice's actual INSERT so the database exercises batch rollback.
  return db.batch(stmts.map(([sql, args]) => {
    if (!failNotice || !/^INSERT INTO account_notices\b/i.test(sql) || args[2] !== failNotice) return [sql, args];
    failNotice = undefined;
    return [sql, [args[0], args[1], null, ...args.slice(3)]];
  }));
} };
const app = createApp({ db: decisionDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('林志明', 'PO'); // 管理員
  const wang = await join('王小明', 'UX'), chen = await join('陳大文', 'PG'), wu = await join('吳大同', 'PG');
  const id = p => p.participant.participantId;
  const setPj = (p, projects) => call(boss.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects });
  await setPj(boss, ['預設專案', '第二專案']); await setPj(wang, ['預設專案']); await setPj(chen, ['第二專案']); await setPj(wu, ['第二專案']);
  assert.equal((await makeProjectAdmin(call, boss.token, id(wang), ['預設專案'])).status, 200);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: ['第二專案'], roleKey: 'PG', role: 'PG', name: '陳的AI', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await testToken(db, ai.participantId));
  const list = tok => call(tok, '/api/join/projects');
  const apply = (tok, pj, note) => call(tok, `/api/projects/${encodeURIComponent(pj)}/join-requests`, 'POST', { note });
  const myProjects = async tok => (await call(tok, '/api/me')).body.projects;
  async function beforeWrite(match, request, competingWrite) {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    writeGate = { match, entered, resume };
    const first = request();
    try {
      await Promise.race([entered.promise, first.then(r => assert.fail('request returned before its write: ' + JSON.stringify(r)))]);
      await competingWrite();
    } finally {
      resume.resolve();
    }
    return first;
  }

  const whileApproving = (approve, competingWrite) => beforeWrite(/^UPDATE join_requests SET status = 'approved'/, approve, competingWrite);
  const expectError = (result, status, code, label) => assert.deepEqual([result.status, result.body.error?.code], [status, code], label);

  // 1. 預設開放：沒設過的專案，非成員看得到、可以申請；leader 關掉就看不到、不能申請；只有 leader／管理員能改
  assert.ok((await list(chen.token)).body.items.some(p => p.id === '預設專案'), '沒設過＝開放，看得到');
  assert.equal((await call(wang.token, '/api/projects')).body.join['預設專案'].open, true, '專案清單：預設開放');
  assert.equal((await call(chen.token, '/api/projects/預設專案/join-settings', 'PUT', { open: false })).status, 403, '非 leader 不能關');
  let r = await call(wang.token, '/api/projects/預設專案/join-settings', 'PUT', { open: false });
  assert.equal(r.status, 200); assert.equal(r.body.open, false);
  assert.ok(!(await list(chen.token)).body.items.some(p => p.id === '預設專案'), '關掉後看不到');
  assert.equal((await apply(chen.token, '預設專案')).body.error.code, 'JOIN_CLOSED', '關掉後不能申請');
  r = await call(wang.token, '/api/projects/預設專案/join-settings', 'PUT', { open: true, note: '外食熱量 POC，歡迎 UX' });
  assert.equal(r.status, 200); assert.equal(r.body.open, true);
  assert.equal((await call(wang.token, '/api/projects')).body.join['預設專案'].open, true, '專案清單帶開放設定');
  // 2. 開放後：只露名稱、說明、leader、人數；隔離不變（專案清單仍看不到）
  const it = (await list(chen.token)).body.items.filter(p => p.id === '預設專案');
  assert.equal(it.length, 1); assert.equal(it[0].id, '預設專案'); assert.equal(it[0].note, '外食熱量 POC，歡迎 UX');
  assert.deepEqual(it[0].leaders, ['王小明']); assert.ok(it[0].members >= 2);
  assert.ok(!(await call(chen.token, '/api/projects')).body.items.some(p => p.id === '預設專案'), '還不是成員，專案清單看不到');
  assert.ok(!('預設專案' in ((await call(chen.token, '/api/projects')).body.join || {})), '開放設定也不外流到專案清單');
  // 3. 只有人類能申請；已是成員有清楚訊息
  assert.equal((await list(aiTok)).status, 403, 'AI 不能看申請清單');
  assert.equal((await apply(aiTok, '預設專案')).status, 403, 'AI 不能申請');
  assert.equal((await apply(boss.token, '預設專案')).body.error.code, 'ALREADY_MEMBER');
  // 4. 送出：不自動加入；重送＝審核中；通知 leader
  r = await apply(chen.token, '預設專案', '我想幫忙做手機畫面');
  assert.equal(r.status, 200); assert.equal(r.body.status, 'pending');
  assert.equal((await apply(chen.token, '預設專案')).body.error.code, 'JOIN_PENDING');
  assert.ok(!(await myProjects(chen.token)).includes('預設專案'), '送出不會加入');
  assert.equal((await list(chen.token)).body.items[0].status, 'pending');
  assert.ok((await call(wang.token, '/api/me/notices')).body.items.some(n => n.kind === 'join_request' && n.detail.includes('陳大文')), '通知 leader');
  assert.equal((await call(wang.token, '/api/projects')).body.join['預設專案'].pending, 1, '待審數');
  // 5. 誰能審：leader、管理員；其他人與 AI 403
  const reqs = (await call(wang.token, '/api/join-requests')).body.items;
  assert.equal(reqs.length, 1); assert.equal(reqs[0].name, '陳大文'); assert.equal(reqs[0].note, '我想幫忙做手機畫面');
  assert.deepEqual((await call(wu.token, '/api/join-requests')).body.items, [], '非 leader 看不到待審');
  assert.equal((await call(wu.token, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).status, 403);
  assert.equal((await call(aiTok, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).status, 403);
  assert.equal((await call(chen.token, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).status, 403, '申請人不能自己核准');
  // 6. 拒絕要寫原因；申請人收到；可隨時再申請，看得到上次原因
  assert.equal((await call(wang.token, `/api/join-requests/${reqs[0].id}/reject`, 'POST', { reason: ' ' })).status, 400);
  const reject = () => call(wang.token, `/api/join-requests/${reqs[0].id}/reject`, 'POST', { reason: '目前人夠了' });
  failNotice = 'join_rejected';
  assert.equal((await reject()).status, 500);
  assert.equal((await list(chen.token)).body.items[0].status, 'pending', 'failed rejection leaves the request pending');
  assert.ok(!(await call(chen.token, '/api/me/notices')).body.items.some(n => n.kind === 'join_rejected'));
  assert.equal((await reject()).status, 200);
  assert.equal((await call(chen.token, '/api/me/notices')).body.items.filter(n => n.kind === 'join_rejected' && n.detail.includes('目前人夠了')).length, 1);
  const again = (await list(chen.token)).body.items[0];
  assert.equal(again.status, null); assert.equal(again.lastRejected.reason, '目前人夠了');
  assert.equal((await call(wang.token, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).body.error.code, 'JOIN_DECIDED');
  assert.equal((await apply(chen.token, '預設專案', '再試一次')).status, 200, '被拒可隨時再申請');
  // 7. 核准：選角色＋唯讀 → 才變成員、角色、唯讀、異動紀錄、通知
  const r2 = (await call(wang.token, '/api/join-requests')).body.items[0];
  assert.equal(r2.lastRejected.reason, '目前人夠了', '審核時看得到上次被拒');
  const approve = () => call(wang.token, `/api/join-requests/${r2.id}/approve`, 'POST', { role: 'UX', readOnly: true });
  const notices = async () => (await call(chen.token, '/api/me/notices')).body.items;
  const events = async () => (await call(wang.token, '/api/projects/預設專案/events')).body.items;
  const otherTitle = title => call(chen.token, `/api/participants/${id(chen)}/project-roles`, 'PUT', { roles: { '第二專案': title } });
  assert.equal((await otherTitle('QA')).status, 200);
  failNotice = 'join_approved';
  assert.equal((await approve()).status, 500);
  const afterFailure = (await call(chen.token, '/api/me')).body;
  assert.deepEqual({
    pending: (await call(wang.token, '/api/join-requests')).body.items.some(item => item.id === r2.id),
    member: afterFailure.projects.includes('預設專案'),
    noticed: (await notices()).some(n => n.kind === 'join_approved'),
  }, { pending: true, member: false, noticed: false }, 'failed approval is entirely rolled back');
  assert.deepEqual(afterFailure.projects, ['第二專案']);
  assert.ok(!afterFailure.readOnlyIn.includes('預設專案'));
  assert.ok(!(await events()).some(e => e.text.includes('核准 陳大文')));
  r = await whileApproving(approve, async () => assert.equal((await otherTitle('BA')).status, 200));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = (await call(chen.token, '/api/me')).body;
  assert.deepEqual([...me.projects].sort(), ['第二專案', '預設專案'].sort());
  assert.ok(me.readOnlyIn.includes('預設專案'), '唯讀');
  const roles = me.projectRoles ?? (await call(boss.token, '/api/participants')).body.items.find(p => p.participantId === id(chen)).projectRoles;
  assert.deepEqual(roles, { '預設專案': 'UX', '第二專案': 'BA' });
  assert.equal((await events()).filter(e => /王小明 核准 陳大文 加入（UX），唯讀/.test(e.text)).length, 1);
  assert.equal((await notices()).filter(n => n.kind === 'join_approved').length, 1);
  assert.equal((await apply(chen.token, '預設專案')).body.error.code, 'ALREADY_MEMBER');
  // 8. 管理員不是 leader 也能審；封存的專案有清楚訊息
  await call(boss.token, '/api/projects/第二專案/join-settings', 'PUT', { open: true });
  r = await apply(wang.token, '第二專案');
  const bank = (await call(boss.token, '/api/join-requests?project=第二專案')).body.items[0];
  assert.equal(bank.name, '王小明');
  assert.equal((await call(boss.token, `/api/join-requests/${bank.id}/approve`, 'POST', { role: 'PO' })).status, 200, '管理員能核准');
  const np = (await call(boss.token, '/api/projects', 'POST', { name: '封存測試' })).body;
  const pid = (np.items || []).find(p => p.name === '封存測試')?.id || np.id;
  await call(boss.token, `/api/projects/${encodeURIComponent(pid)}/join-settings`, 'PUT', { open: true });
  await call(boss.token, `/api/projects/${encodeURIComponent(pid)}/archive`, 'POST');
  assert.ok(!(await list(chen.token)).body.items.some(p => p.id === pid), '封存的不列');
  assert.equal((await apply(chen.token, pid)).body.error.code, 'PROJECT_ARCHIVED');

  // Both reviewers are authorized. Reject wins after approve has checked its preconditions.
  const approveWu = request => () => call(wang.token, `/api/join-requests/${request}/approve`, 'POST', { role: 'UX' });
  const race = await apply(wu.token, '預設專案');
  assert.equal(race.status, 200);
  const rejectWu = () => call(boss.token, `/api/join-requests/${race.body.id}/reject`, 'POST', { reason: '目前不缺人' });
  const lost = await whileApproving(approveWu(race.body.id), async () => assert.equal((await rejectWu()).status, 200));
  assert.deepEqual([lost.status, lost.body.error?.code], [409, 'JOIN_DECIDED']);
  assert.deepEqual(await myProjects(wu.token), ['第二專案']);
  assert.deepEqual((await call(wu.token, '/api/me/notices')).body.items.filter(n => /^join_(approved|rejected)$/.test(n.kind)).map(n => n.kind), ['join_rejected']);
  assert.ok(!(await events()).some(e => e.text.includes('核准 吳大同')));

  // Reviewer authority is checked again after acquiring the workspace lock.
  const race2 = await apply(wu.token, '預設專案');
  assert.equal(race2.status, 200);
  const demoted = await whileApproving(approveWu(race2.body.id), async () => {
    assert.equal((await setProjectRole(call, boss.token, '預設專案', id(wang), 'member')).status, 200);
  });
  assert.deepEqual([demoted.status, demoted.body.error?.code], [403, 'NOT_REVIEWER']);
  assert.equal((await list(wu.token)).body.items.find(p => p.id === '預設專案').status, 'pending');
  assert.deepEqual(await myProjects(wu.token), ['第二專案']);
  boss.token = (await adminSession(call, boss.token)).token;
  const create = async (name, visibility) => {
    const r = await call(boss.token, '/api/projects', 'POST', { name, visibility });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  const direct = await create('直接加入競態', 'open');
  const afterPrivate = await beforeWrite(/^INSERT OR IGNORE INTO project_members/, () => call(wu.token, `/api/projects/${direct}/join`, 'POST'), async () => {
    assert.equal((await call(boss.token, `/api/projects/${direct}/visibility`, 'PUT', { visibility: 'private' })).status, 200);
  });
  expectError(afterPrivate, 404, 'NOT_FOUND', '專案改為私人後不能直接加入');
  assert.ok(!(await myProjects(wu.token)).includes(direct));
  const review = await create('送出申請競態', 'review');
  const afterClose = await beforeWrite(/^INSERT INTO join_requests/, () => apply(wu.token, review), async () => {
    assert.equal((await call(boss.token, `/api/projects/${review}/join-settings`, 'PUT', { open: false })).status, 200);
  });
  expectError(afterClose, 403, 'JOIN_CLOSED', '關閉後不能送出申請');
  const privateSubmit = await create('私人申請競態', 'review');
  const afterPrivateSubmit = await beforeWrite(/^INSERT INTO join_requests/, () => apply(wu.token, privateSubmit), async () => {
    assert.equal((await call(boss.token, `/api/projects/${privateSubmit}/visibility`, 'PUT', { visibility: 'private' })).status, 200);
  });
  expectError(afterPrivateSubmit, 404, 'NOT_FOUND', '私人專案不能送出申請');
  for (const project of [review, privateSubmit]) assert.deepEqual((await call(boss.token, '/api/join-requests?project=' + project)).body.items, []);

  const deleted = await create('刪除競態', 'review');
  const doomed = await apply(wu.token, deleted);
  assert.equal(doomed.status, 200);
  const decision = (req, action = 'approve', body = {}) => () => call(boss.token, `/api/join-requests/${req}/${action}`, 'POST', body);
  const afterArchive = await whileApproving(decision(doomed.body.id), async () => {
    assert.equal((await call(boss.token, `/api/projects/${deleted}/archive`, 'POST')).status, 200);
  });
  expectError(afterArchive, 409, 'PROJECT_ARCHIVED');
  assert.equal((await call(boss.token, `/api/projects/${deleted}/unarchive`, 'POST')).status, 200);
  const afterDelete = await whileApproving(decision(doomed.body.id), async () => {
    assert.equal((await call(boss.token, `/api/projects/${deleted}/archive`, 'POST')).status, 200);
    assert.equal((await call(boss.token, `/api/projects/${deleted}/delete`, 'POST', { confirmName: '刪除競態' })).status, 200);
  });
  expectError(afterDelete, 404, 'NOT_FOUND', '刪除的專案一律回 404');
  expectError(await decision(doomed.body.id)(), 404, 'NOT_FOUND');
  const promoted = await whileApproving(decision(race2.body.id, 'approve', { role: 'UX' }), async () => {
    assert.equal((await call(boss.token, `/api/participants/${id(wu)}/workspace-role`, 'PUT', { role: 'admin' })).status, 200);
  });
  assert.equal(promoted.status, 200);
  assert.ok(!(await listProjectMembers(call, boss.token, '預設專案')).body.members.some(m => m.participantId === id(wu)), '一般核准不為已有隱含權限的申請人建立明確的成員資格');
  assert.ok(!(await events()).some(e => e.text.endsWith('加入 吳大同')));
  assert.equal((await call(boss.token, `/api/participants/${id(wu)}/workspace-role`, 'PUT', { role: 'member' })).status, 200);
  assert.deepEqual(await myProjects(wu.token), ['第二專案']);

  const readonlyApplicant = await join('唯讀申請人', 'PG');
  const readonlyRequest = await apply(readonlyApplicant.token, '預設專案');
  assert.equal(readonlyRequest.status, 200);
  assert.equal((await call(boss.token, `/api/participants/${id(readonlyApplicant)}/workspace-role`, 'PUT', { role: 'admin' })).status, 200);
  assert.equal((await decision(readonlyRequest.body.id, 'approve', { readOnly: true })()).status, 200);
  const viewer = (await listProjectMembers(call, boss.token, '預設專案')).body.members.find(m => m.participantId === id(readonlyApplicant));
  assert.equal(viewer?.role, 'viewer', '核准時明確選擇唯讀，照舊加入明確的唯讀成員');
  assert.ok(!(await events()).some(e => e.text.endsWith('加入 唯讀申請人')));

  const removed = await apply(wu.token, '預設專案');
  assert.equal(removed.status, 200);
  const lostRejection = await beforeWrite(/^UPDATE join_requests SET status = 'rejected'/, decision(removed.body.id, 'reject', { reason: '稍後再試' }), async () => {
    assert.equal((await call(boss.token, `/api/participants/${id(wu)}/remove`, 'POST')).status, 200);
  });
  expectError(lostRejection, 404, 'NOT_FOUND', '已移除的申請一律回 404');
  expectError(await decision(removed.body.id)(), 404, 'NOT_FOUND');
  console.log('join-request-test：全部通過');
} catch (e) {
  console.error('join-request-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
