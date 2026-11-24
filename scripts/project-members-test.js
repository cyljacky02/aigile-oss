// 驗收測試：專案角色（專案管理員／專案成員／唯讀成員）與專案成員端點（#11；詞彙見 GLOSSARY「成員與權限」）
// GET／POST /api/projects/:id/members、PUT／DELETE /api/projects/:id/members/:participantId
// 用法：node scripts/project-members-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { addToProject, setProjectRole, removeFromProject, listProjectMembers } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pmem-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const A = '預設專案', B = '第二專案';
const roleOf = async (tok, pj, id) => (await listProjectMembers(call, tok, pj)).body.members?.find(m => m.participantId === id)?.role;

try {
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { token: b.token, id: b.participant.participantId, name }; };
  const boss = await join('林志明', 'PO'); // 第一位＝工作區管理員
  const wang = await join('王小明');
  const chen = await join('陳昭宇');
  const lin = await join('林美玲');
  await call(boss.token, `/api/participants/${wang.id}/projects`, 'PUT', { projects: [A] });

  // 1) 工作區管理員任命專案管理員；成員清單帶專案角色
  let r = await setProjectRole(call, boss.token, A, wang.id, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await listProjectMembers(call, boss.token, A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.members.find(m => m.participantId === wang.id)?.role, 'admin', '王小明是專案管理員');
  console.log('✓ 工作區管理員任命專案管理員');

  // 2) 專案管理員從工作區成員挑人加入（專案成員、唯讀成員）
  r = await addToProject(call, wang.token, A, chen.id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await roleOf(wang.token, A, chen.id), 'member', '陳昭宇以專案成員加入');
  r = await addToProject(call, wang.token, A, lin.id, 'viewer');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await roleOf(wang.token, A, lin.id), 'viewer', '林美玲以唯讀成員加入');
  assert.equal(code(await addToProject(call, wang.token, A, chen.id)), 'ALREADY_MEMBER', '已在專案裡');
  console.log('✓ 專案管理員加入工作區成員');

  // 3) 不能加入工作區以外的人（停用的帳號、不存在的人）
  const gone = await join('趙離開');
  assert.equal((await call(boss.token, `/api/participants/${gone.id}/disable`, 'POST')).status, 200);
  r = await addToProject(call, wang.token, A, gone.id);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(code(r), 'NOT_WORKSPACE_MEMBER', '停用的人不是工作區成員');
  assert.equal((await addToProject(call, wang.token, A, 'p_nobody')).status, 404, '不存在的人');
  assert.equal((await roleOf(boss.token, A, gone.id)), undefined, '沒有被加進去');
  console.log('✓ 不能加入工作區以外的人');

  // 4) 專案管理員任免其他專案管理員
  r = await setProjectRole(call, wang.token, A, chen.id, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await roleOf(wang.token, A, chen.id), 'admin', '王小明任命陳昭宇為專案管理員');
  assert.equal((await setProjectRole(call, chen.token, A, wang.id, 'member')).status, 200, '陳昭宇也能把王小明降為專案成員');
  assert.equal(await roleOf(boss.token, A, wang.id), 'member');
  assert.equal((await setProjectRole(call, boss.token, A, wang.id, 'admin')).status, 200, '工作區管理員再任命回來');
  assert.equal(code(await setProjectRole(call, wang.token, A, chen.id, 'owner')), 'INVALID_REQUEST', '只有三種專案角色');
  console.log('✓ 專案管理員任免專案管理員');

  // 5) 不能動工作區管理員；工作區管理員也不能被設成唯讀成員
  r = await setProjectRole(call, wang.token, A, boss.id, 'member');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(code(r), 'CANNOT_MANAGE_ADMIN', '專案管理員不能改工作區管理員的專案角色');
  assert.equal(code(await removeFromProject(call, wang.token, A, boss.id)), 'CANNOT_MANAGE_ADMIN', '也不能把他移出');
  assert.equal(code(await setProjectRole(call, boss.token, A, boss.id, 'viewer')), 'INVALID_REQUEST', '工作區管理員不能是唯讀成員');
  assert.equal((await call(boss.token, '/api/projects')).body.adminId, boss.id, '工作區管理員照舊');
  console.log('✓ 不能動工作區管理員');

  // 6) 只管得到自己的專案
  await call(boss.token, `/api/participants/${lin.id}/projects`, 'PUT', { projects: [A, B] });
  r = await addToProject(call, wang.token, B, chen.id);
  assert.equal(r.status, 403, '王小明不是第二專案的專案管理員');
  assert.equal((await setProjectRole(call, wang.token, B, lin.id, 'viewer')).status, 403);
  console.log('✓ 只管得到自己的專案');

  // 7) 專案成員、唯讀成員、AI 不能管理成員
  const mkAi = (tok, name, projects = [A]) => call(tok, '/api/my-ais', 'POST', { projects, roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(x => x.body);
  await setProjectRole(call, boss.token, A, chen.id, 'member');
  const linAi = await mkAi(lin.token, '林的PG', [B]);
  assert.ok(linAi.token, JSON.stringify(linAi));
  for (const [who, tok] of [['專案成員', chen.token], ['唯讀成員', lin.token], ['AI', linAi.token]]) {
    assert.equal((await addToProject(call, tok, A, gone.id)).status, 403, `${who}不能加人`);
    assert.equal((await setProjectRole(call, tok, A, wang.id, 'member')).status, 403, `${who}不能改專案角色`);
    assert.equal((await removeFromProject(call, tok, A, wang.id)).status, 403, `${who}不能移出`);
  }
  assert.equal((await listProjectMembers(call, chen.token, A)).status, 200, '專案成員看得到成員清單');
  console.log('✓ 專案成員、唯讀成員、AI 不能管理成員');

  // 8) 唯讀成員和他的 AI 在那個專案不能寫；在別的專案可以
  assert.equal(code(await addToProject(call, wang.token, A, linAi.participantId, 'viewer')), 'INVALID_REQUEST', 'AI 只能是專案成員（唯讀跟著所屬人類）');
  let n = 0;
  const msg = (tok, project) => call(tok, '/api/messages', 'POST', { requestId: 'm' + (++n), project, text: '說話' });
  assert.equal(code(await msg(lin.token, A)), 'READ_ONLY', '唯讀成員不能寫');
  assert.equal((await msg(lin.token, B)).status, 201, '在別的專案可以寫');
  r = await addToProject(call, wang.token, A, linAi.participantId);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await roleOf(wang.token, A, linAi.participantId), 'viewer', 'AI 跟著所屬人類是唯讀成員');
  assert.equal(code(await msg(linAi.token, A)), 'READ_ONLY', '唯讀成員的 AI 不能寫');
  assert.equal((await msg(linAi.token, B)).status, 201, 'AI 在別的專案可以寫');
  console.log('✓ 唯讀成員與他的 AI 寫入被拒');

  // 9) AI 的專案範圍是所屬人類的子集
  const chenAi = await mkAi(chen.token, '陳的PG');
  r = await addToProject(call, boss.token, B, chenAi.participantId);
  assert.equal(code(r), 'OWNER_NOT_IN_PROJECT', '所屬人類不在第二專案，AI 不能加入');
  assert.equal(code(await addToProject(call, boss.token, B, chenAi.participantId, 'admin')), 'INVALID_REQUEST', 'AI 不能當專案管理員');
  r = await addToProject(call, boss.token, B, [chen.id, chenAi.participantId]);
  assert.equal(r.status, 201, '所屬人類同一次加入就可以');
  assert.deepEqual((await call(chenAi.token, '/api/me')).body.projects.sort(), [A, B].sort());
  console.log('✓ AI 的專案不超出所屬人類');

  // 10) 移出：他負責的未結案卡退回；設成唯讀成員也一樣（都先 dryRun 看）
  const card = (await call(chen.token, '/api/cards', 'POST', { requestId: 'c1', project: A, title: '陳負責的卡', ownerId: chen.id, status: '進行中' })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  r = await setProjectRole(call, wang.token, A, chen.id, 'viewer', { dryRun: true });
  assert.deepEqual(r.body.returnedCards, [card.cardId], '設唯讀前先看會退回的卡');
  assert.equal(await roleOf(wang.token, A, chen.id), 'member', 'dryRun 不改');
  r = await removeFromProject(call, wang.token, A, chen.id, { dryRun: true });
  assert.deepEqual(r.body.returnedCards, [card.cardId], '移出前先看會退回的卡');
  r = await removeFromProject(call, wang.token, A, chen.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await roleOf(wang.token, A, chen.id), undefined, '移出了');
  const c1 = (await call(boss.token, `/api/cards/${card.cardId}`)).body;
  assert.ok(c1.owner === null && c1.status === '待處理', '他的卡退回待處理、未指派');
  assert.equal(code(await removeFromProject(call, wang.token, A, chen.id)), 'NOT_MEMBER', '已經不在');
  console.log('✓ 移出專案');

  // 11) 舊的成員矩陣、整批名單端點回 410；專案清單不再有跨專案角色
  assert.equal((await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: wang.id, leaderOf: [A] }] })).status, 410, '成員矩陣已移除');
  assert.equal((await call(boss.token, `/api/projects/${A}/members`, 'PUT', { memberIds: [boss.id] })).status, 410, '整批名單已移除');
  const pr = (await call(boss.token, '/api/projects')).body;
  assert.equal(pr.crossRoleIds, undefined, '沒有跨專案角色');
  assert.deepEqual(pr.projectAdmins[A], [wang.id], '專案清單帶專案管理員');
  assert.deepEqual(pr.viewers[A], [lin.id], '專案清單帶唯讀成員');
  console.log('✓ 舊端點回 410');

  console.log('project-members-test：全部通過');
} catch (e) {
  console.error('project-members-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
