// 驗收測試：工作區可以有多位工作區管理員（#8；詞彙見 GLOSSARY「成員與權限」）
// 1. 工作區管理員可以把成員升為工作區管理員、把自己或別人降為成員；兩位都能做管理動作
// 2. 最後一位工作區管理員不能被降級（也不能自己離開工作區）；「先升別人、再降自己」可以
// 3. 一般成員、AI 不能升降；只能升降啟用中的人類
// 4. 移交管理員的端點拿掉，回 410
// 5. 隱含權限：工作區管理員沒加入專案也能看到、進入、管理它，但不出現在該專案的成員清單與人數；降為成員後就沒有了
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/workspace-admin-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wsadmin-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const A = '預設專案', B = '第二專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const setRole = (tok, id, role) => call(tok, `/api/participants/${id}/workspace-role`, 'PUT', { role });
const me = async tok => (await call(tok, '/api/me')).body;
const listed = async (tok, pj) => (await call(tok, `/api/participants?project=${pj}`)).body.items.map(p => p.participantId);
const memberCount = async (tok, pj) => (await call(tok, '/api/projects')).body.items.find(x => x.id === pj).memberCount;
const say = (tok, project) => call(tok, '/api/messages', 'POST', { requestId: 'm' + Math.random(), project, text: '大家好' });

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位＝工作區管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'QA' })).body;
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  assert.equal((await call(boss.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: [A] })).status, 200);
  assert.equal((await call(boss.token, `/api/participants/${Wg}/projects`, 'PUT', { projects: [A] })).status, 200);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S })).body;

  // ---- 回傳的工作區角色 ----
  const b0 = await me(boss.token), c0 = await me(chen.token);
  assert.equal(b0.workspaceRole, 'admin', '第一位是工作區管理員');
  assert.equal(b0.isAdmin, true, 'isAdmin 保留，等同工作區管理員');
  assert.equal(c0.workspaceRole, 'member', '之後加入的是成員');
  assert.ok(!c0.isAdmin, '成員沒有 isAdmin');
  assert.equal((await me(ai.token)).workspaceRole, 'member', 'AI 是工作區成員');
  console.log('✓ participant 回傳 workspaceRole');

  // ---- 一般成員、AI 不能升降 ----
  assert.equal(code(await setRole(chen.token, Cn, 'admin')), 'NOT_ADMIN', '一般成員不能把自己升為管理員');
  assert.equal(code(await setRole(chen.token, Bo, 'member')), 'NOT_ADMIN', '一般成員不能降管理員');
  assert.equal(code(await setRole(ai.token, Cn, 'admin')), 'NOT_ADMIN', 'AI 不能升降管理員');
  assert.equal((await setRole(boss.token, ai.participantId, 'admin')).status, 404, 'AI 不能當工作區管理員');
  assert.equal(code(await setRole(boss.token, ai.participantId, 'admin')), 'NOT_WORKSPACE_MEMBER');
  assert.equal((await setRole(boss.token, 'p_nobody', 'admin')).status, 404, '找不到的人');
  assert.equal((await setRole(boss.token, Cn, 'owner')).status, 400, 'role 只能是 admin 或 member');
  console.log('✓ 一般成員、AI 不能升降；只能升降人類成員');

  // ---- 最後一位不能降級、不能離開 ----
  const last = await setRole(boss.token, Bo, 'member');
  assert.equal(last.status, 409, JSON.stringify(last.body));
  assert.equal(code(last), 'LAST_WORKSPACE_ADMIN', '降級最後一位工作區管理員回錯誤');
  assert.equal((await me(boss.token)).workspaceRole, 'admin', '擋下後還是管理員');
  assert.equal(code(await call(boss.token, '/api/leave', 'POST')), 'LAST_WORKSPACE_ADMIN', '最後一位管理員不能離開工作區');
  assert.equal((await me(boss.token)).workspaceRole, 'admin');
  console.log('✓ 最後一位工作區管理員受保護');

  // ---- 升別人：兩位管理員都能做管理動作 ----
  const up = await setRole(boss.token, Cn, 'admin');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.participant.workspaceRole, 'admin');
  assert.equal((await me(chen.token)).workspaceRole, 'admin', '陳昭宇升為工作區管理員');
  assert.deepEqual((await call(boss.token, '/api/participants')).body.items.filter(p => p.workspaceRole === 'admin').map(p => p.participantId).sort(), [Bo, Cn].sort(), '名單上兩位管理員');
  for (const [tok, who] of [[boss.token, '林志明'], [chen.token, '陳昭宇']]) {
    assert.equal((await call(tok, '/api/invites')).status, 200, `${who} 能看邀請`);
    assert.equal((await call(tok, '/api/invites', 'POST', { name: '新人' + who, projects: [A] })).status, 201, `${who} 能發邀請`);
    assert.equal((await call(tok, '/api/group/settings', 'PUT', { openJoin: true })).status, 200, `${who} 能改工作區設定`);
  }
  assert.equal((await setRole(chen.token, Wg, 'admin')).status, 200, '新的管理員也能升別人');
  assert.equal((await setRole(chen.token, Wg, 'member')).status, 200, '也能降別人');
  assert.equal((await me(wang.token)).workspaceRole, 'member');
  assert.equal((await setRole(boss.token, Cn, 'admin')).status, 200, '已經是管理員再升一次：不變');
  console.log('✓ 兩位工作區管理員都能執行管理動作');

  // ---- 隱含權限：陳昭宇沒加入第二專案，也能看到、進入、管理它；但不算成員 ----
  assert.ok((await me(chen.token)).projects.includes(B), '看得到第二專案');
  assert.equal((await say(chen.token, B)).status, 201, '能在第二專案發訊息');
  assert.equal((await call(chen.token, `/api/projects/${B}/statuses`)).status, 200, '能看第二專案的看板狀態');
  assert.equal((await call(chen.token, `/api/projects/${B}/join-settings`, 'PUT', { open: true, note: '' })).status, 200, '能管理第二專案');
  assert.ok(!(await listed(boss.token, B)).includes(Cn), '不出現在第二專案的成員清單');
  assert.ok(!(await listed(boss.token, B)).includes(Bo), '第一位管理員也一樣（沒有加入任何專案）');
  assert.equal(await memberCount(chen.token, B), 0, '第二專案人數不算有隱含權限的管理員');
  assert.ok((await listed(wang.token, A)).includes(Cn), '有加入的專案照舊列');
  assert.ok(!(await listed(wang.token, A)).includes(Bo), '沒加入的專案不列');
  assert.equal(await memberCount(chen.token, A), 3, '預設專案：陳昭宇、王小美、陳的PG');
  console.log('✓ 隱含權限：不必加入就能管理，且不出現在成員清單');

  // ---- 先升別人、再降自己 ----
  const bossAi = (await call(boss.token, '/api/my-ais', 'POST', { projects: [B], roleKey: 'PG', role: '程式開發', name: '林的PG', ...S })).body;
  assert.ok(bossAi.participantId, '管理員靠隱含權限把 AI 放進沒加入的第二專案');
  // 林志明也是平台管理員（對工作區有隱含管理權，#9）：平台管理員一樣先升別人、再降自己
  assert.equal((await call(boss.token, `/api/participants/${Cn}/platform-role`, 'PUT', { role: 'admin' })).status, 200);
  assert.equal((await call(boss.token, `/api/participants/${Bo}/platform-role`, 'PUT', { role: 'none' })).status, 200);
  const down = await setRole(boss.token, Bo, 'member');
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal((await me(boss.token)).workspaceRole, 'member', '林志明降為成員');
  assert.ok(!(await me(boss.token)).isAdmin);
  assert.equal(code(await call(boss.token, '/api/participants/disabled')), 'NOT_ADMIN', '降級後不能做管理動作');
  assert.equal(code(await setRole(boss.token, Bo, 'admin')), 'NOT_ADMIN', '降級後不能自己升回來');
  assert.deepEqual((await me(boss.token)).projects, [B], '降級後沒有隱含權限；他的 AI 在的專案，他也成為成員（AI 不超出所屬人類）');
  assert.ok((await listed(chen.token, B)).includes(Bo), '所以列在第二專案');
  assert.equal(code(await say(boss.token, A)), 'PROJECT_FORBIDDEN', '降級後不能進沒加入的預設專案');
  assert.equal((await say(bossAi.token, B)).status, 201, '他的 AI 照常工作');
  assert.equal(code(await setRole(chen.token, Cn, 'member')), 'LAST_WORKSPACE_ADMIN', '現在陳昭宇是最後一位');
  assert.equal((await setRole(chen.token, Bo, 'admin')).status, 200, '陳昭宇可以把林志明升回來');
  console.log('✓ 先升別人、再降自己');

  // ---- 移交管理員的端點拿掉 ----
  const tr = await call(boss.token, '/api/admin/transfer', 'POST', { toId: Wg });
  assert.equal(tr.status, 410, JSON.stringify(tr.body));
  assert.equal(code(tr), 'GONE');
  assert.equal((await me(wang.token)).workspaceRole, 'member', '410 之後什麼都沒改');
  console.log('✓ 移交端點回 410');

  // ---- 自己離開工作區＝移出工作區：帳號照舊（不是停用），可以再被邀請回來 ----
  const li = (await call(null, '/api/join', 'POST', { name: '李大同', role: 'UX', username: 'li.dt', password: 'pass-word-1', passwordAgain: 'pass-word-1' })).body;
  const Li = li.participant.participantId;
  assert.equal((await call(boss.token, `/api/participants/${Li}/projects`, 'PUT', { projects: [A] })).status, 200);
  const liAi = (await call(li.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'UX', role: '設計', name: '李的UX', ...S })).body;
  const left = await call(li.token, '/api/leave', 'POST');
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal((await call(li.token, '/api/me')).status, 401, '離開後進不來');
  assert.equal((await call(liAi.token, '/api/me')).status, 401, '他的 AI 也進不來');
  const roster = (await call(chen.token, '/api/roster')).body; // 陳昭宇是平台管理員：看得到全平台帳號
  assert.ok(roster.removed.some(p => p.participantId === Li), '名冊列在已移出：' + JSON.stringify(roster.removed));
  assert.ok(!roster.members.some(p => p.participantId === Li || p.participantId === liAi.participantId), '他與他的 AI 不再是工作區成員');
  assert.deepEqual([roster.accounts.find(a => a.participantId === Li)?.accountStatus, roster.accounts.find(a => a.participantId === Li)?.workspaceStatus], ['active', 'removed'], '帳號沒有停用，只是移出工作區');
  assert.ok(!(await call(chen.token, '/api/participants/disabled')).body.items.some(p => p.participantId === Li), '不在已停用清單');
  assert.equal(code(await call(null, '/api/auth/password', 'POST', { username: 'li.dt', password: 'pass-word-1' })), 'NOT_WORKSPACE_MEMBER', '帳密還對，只是不是工作區成員');
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '李大同' })).body.invite?.kind, 'rejoin', '可以邀請他回來');
  console.log('✓ 自己離開＝移出工作區，帳號沒有停用');

  // ---- 停用的人不能被升 ----
  assert.equal((await call(chen.token, `/api/participants/${Wg}/disable`, 'POST')).status, 200, '停用帳號是平台管理員的事');
  assert.equal(code(await setRole(boss.token, Wg, 'admin')), 'NOT_WORKSPACE_MEMBER', '停用的人不能升');
  console.log('workspace-admin-test：全部通過');
} catch (e) {
  console.error('workspace-admin-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
