// 驗收測試：邀請與自行加入以工作區為範圍（詞彙見 GLOSSARY「成員與權限」）
// 1. 工作區管理員發邀請：接受後成為工作區成員（沒帳號就順便建帳號），依預設加入專案、帶專案角色與職稱
// 2. 專案管理員、一般成員、AI 不能發邀請（也不能看、重發、取消）
// 3. 自行註冊：關閉時被拒、房間碼錯誤被拒；自行加入者是工作區成員、沒有專案、在名冊上
// 4. 「第一位自行註冊的人成為管理員」只在平台還沒有平台管理員時：該人成為平台管理員兼工作區管理員
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/workspace-invite-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { addToProject, listProjectMembers, makeProjectAdmin } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wsinvite-'));
const dbs = [];
const mk = async (name, config = {}) => {
  const db = await openTestDb(path.join(dataDir, name, 'switch.db'));
  dbs.push(db);
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000', ...config } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { db, call };
};
const code = r => r.body.error?.code;
const A = '預設專案', B = '第二專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const tokenOf = url => url.split('/invite/')[1];

try {
  const { call } = await mk('main', { openJoin: '1' });
  const me = async tok => (await call(tok, '/api/me')).body;
  const join = async (name, role, extra = {}) => (await call(null, '/api/join', 'POST', { name, role, ...extra })).body;
  const boss = await join('林志明', 'PO'); // 第一位＝平台管理員＋工作區管理員

  // ---- 1. 工作區管理員發邀請，預設專案與專案角色 ----
  let r = await call(boss.token, '/api/invites', 'POST', { name: '李新人', projects: [{ project: A, role: 'admin', title: 'PO' }, { project: B, role: 'viewer' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.invite.presets, [{ project: A, role: 'admin', title: 'PO' }, { project: B, role: 'viewer', title: '' }], '邀請帶預設的專案、專案角色與職稱');
  assert.deepEqual(r.body.invite.projects, [A, B], '舊欄位 projects 照舊');
  const acc = await call(null, '/api/auth/invite', 'POST', { token: tokenOf(r.body.url), username: 'li.new', password: 'longpassword1', passwordAgain: 'longpassword1' });
  assert.equal(acc.status, 200, '接受邀請：' + JSON.stringify(acc.body));
  const li = acc.body, Li = li.participant.participantId;
  const liMe = await me(li.token);
  assert.deepEqual([liMe.workspaceRole, liMe.platformRole, !!liMe.isAdmin], ['member', 'none', false], '接受邀請＝工作區成員（不是管理員）：' + JSON.stringify(liMe).slice(0, 300));
  assert.deepEqual(liMe.projects, [A, B], '依預設加入專案');
  const roleIn = async (pj, id) => (await listProjectMembers(call, boss.token, pj)).body.members.find(m => m.participantId === id);
  assert.deepEqual([(await roleIn(A, Li)).role, (await roleIn(A, Li)).title], ['admin', 'PO'], '在預設專案是專案管理員、職稱 PO');
  assert.equal((await roleIn(B, Li)).role, 'viewer', '在第二專案是唯讀成員');
  assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'li.new', password: 'longpassword1' })).status, 200, '沒帳號的人接受邀請時順便建了帳號（帳密登入得了）');
  console.log('✓ 工作區管理員發邀請，接受後依預設加入專案與專案角色');

  // ---- 2. 專案管理員、一般成員、AI 不能發邀請 ----
  const chen = await join('陳昭宇', 'PG');
  const Cn = chen.participant.participantId;
  assert.equal((await addToProject(call, boss.token, A, Cn)).status, 201);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S })).body;
  assert.ok(ai.token, JSON.stringify(ai));
  const pending = (await call(boss.token, '/api/invites', 'POST', { name: '待接受', projects: [A] })).body.invite;
  for (const [tok, who] of [[li.token, '專案管理員'], [chen.token, '一般成員'], [ai.token, 'AI']]) {
    for (const [m, p, body] of [['POST', '/api/invites', { name: '不該有', projects: [A] }], ['GET', '/api/invites'],
      ['POST', `/api/invites/${pending.id}/regenerate`, {}], ['POST', `/api/invites/${pending.id}/cancel`, {}]]) {
      const x = await call(tok, p, m, body);
      assert.equal(x.status, 403, `${who}不能 ${m} ${p}：${JSON.stringify(x.body)}`);
    }
  }
  assert.equal((await call(boss.token, '/api/invites')).body.items.filter(i => i.name === '不該有').length, 0, '沒有多出邀請');
  console.log('✓ 專案管理員、一般成員、AI 不能發邀請');

  // ---- 3. 自行註冊與房間碼是工作區設定 ----
  const ws = body => call(boss.token, '/api/workspace/settings', 'PUT', body);
  assert.equal((await call(li.token, '/api/workspace/settings', 'PUT', { openJoin: false })).status, 403, '專案管理員不能改開放註冊');
  assert.equal((await ws({ openJoin: false })).body.openJoin, false);
  r = await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' });
  assert.equal(code(r), 'JOIN_CLOSED', '關閉自行註冊時被拒：' + JSON.stringify(r.body));
  assert.match(r.body.error.message, /工作區/, '訊息說的是加入工作區');
  r = await ws({ openJoin: true, roomCode: 'abc123' });
  assert.deepEqual([r.body.openJoin, r.body.roomCodeSet], [true, true], '工作區設定：開放註冊、房間碼已設');
  assert.equal(code(await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })), 'ROOM_CODE_REQUIRED', '沒填房間碼');
  r = await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX', roomCode: 'nope' });
  assert.equal(r.status, 403, '房間碼錯誤被拒');
  assert.match(r.body.error.message, /房間碼/, '訊息說房間碼：' + r.body.error.message);
  r = await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX', roomCode: 'abc123' });
  assert.equal(r.status, 201, '房間碼對就能加入：' + JSON.stringify(r.body));
  const wang = r.body, Wg = wang.participant.participantId;
  const wMe = await me(wang.token);
  assert.deepEqual([wMe.workspaceRole, wMe.platformRole, wMe.projects], ['member', 'none', []], '自行加入者是工作區成員、不在任何專案');
  for (const pj of [A, B]) assert.ok(!(await listProjectMembers(call, boss.token, pj)).body.members.some(m => m.participantId === Wg), `不在${pj}的成員清單`);
  assert.ok((await call(boss.token, '/api/participants')).body.items.some(p => p.participantId === Wg), '自行加入者在名冊上');
  console.log('✓ 自行註冊：關閉被拒、房間碼錯誤被拒、自行加入者沒有專案但在名冊上');

  // ---- 邀請的預設要對；待接受的邀請清單 ----
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '錯角色', projects: [{ project: A, role: 'owner' }] })).status, 400, '專案角色只能是 admin／member／viewer');
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '錯專案', projects: [{ project: '沒這個', role: 'member' }] })).status, 400, '沒有的專案不行');
  const gone = (await call(boss.token, '/api/invites', 'POST', { name: '取消掉', projects: [A] })).body.invite;
  await call(boss.token, `/api/invites/${gone.id}/cancel`, 'POST', {});
  const pend = (await call(boss.token, '/api/invites?status=pending')).body.items;
  assert.deepEqual(pend.map(i => i.name), ['待接受'], '待接受的邀請：只有還有效的（已用、已取消的不算）：' + JSON.stringify(pend));
  assert.deepEqual([pend[0].kind, pend[0].status, pend[0].presets], ['new', '有效', [{ project: A, role: 'member', title: '' }]], '待接受的邀請帶預設專案');
  assert.equal((await call(chen.token, '/api/invites?status=pending')).status, 403, '一般成員看不到待接受的邀請');
  console.log('✓ 待接受的邀請清單');

  // ---- 已移出工作區的人再被邀請：用原本的帳號回來，依預設加入專案 ----
  assert.equal((await call(boss.token, `/api/participants/${Cn}/remove`, 'POST', {})).status, 200, '陳昭宇被移出工作區');
  assert.equal((await call(chen.token, '/api/me')).status, 401, '移出後進不來');
  r = await call(boss.token, '/api/invites', 'POST', { name: '陳昭宇', projects: [{ project: B, role: 'member', title: 'PG' }] });
  assert.equal(r.status, 201, '可以邀請已移出的人回來：' + JSON.stringify(r.body));
  assert.equal(r.body.invite.kind, 'rejoin', '邀請標出是重新加入');
  assert.equal(code(await call(boss.token, '/api/invites', 'POST', { name: '陳昭宇' })), 'INVITE_EXISTS', '已經有有效的邀請就不再發');
  assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(r.body.url) })).body.kind, 'rejoin', '被邀請的人看得到是重新加入');
  // 已有帳號的人要先用原本的帳號登入才接受：只有連結不會讓任何人登入
  const linkOnly = await call(null, '/api/auth/invite', 'POST', { token: tokenOf(r.body.url) });
  assert.deepEqual([linkOnly.status, code(linkOnly)], [400, 'INVITE_LOGIN_REQUIRED'], '只有連結：要先登入：' + JSON.stringify(linkOnly.body));
  assert.ok(!linkOnly.body.token, '沒有拿到登入');
  const otherAccount = await call(null, '/api/auth/invite', 'POST', { token: tokenOf(r.body.url), code: boss.token });
  assert.deepEqual([otherAccount.status, code(otherAccount), !!otherAccount.body.token], [400, 'LOGIN_FAILED', false], '用別人的帳號登入不行');
  assert.equal(code(await call(null, '/api/auth/invite', 'POST', { token: tokenOf(r.body.url), code: 'not-a-real-code-xxxxxxxxxxxx' })), 'LOGIN_FAILED', '登入碼不對不行');
  assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(r.body.url) })).body.valid, true, '沒登入成功時邀請照樣有效');
  const back = await call(null, '/api/auth/invite', 'POST', { token: tokenOf(r.body.url), code: chen.token }); // 用他自己的登入碼登入
  assert.equal(back.status, 200, '接受邀請：' + JSON.stringify(back.body));
  assert.equal(back.body.participant.participantId, Cn, '回來的是原本的帳號（歷史紀錄接得上）');
  const cBack = await me(back.body.token);
  assert.deepEqual([cBack.workspaceRole, cBack.projects, !!cBack.removed], ['member', [B], false], '重新是工作區成員，依預設加入專案');
  assert.equal((await roleIn(B, Cn)).title, 'PG', '職稱照預設');
  assert.ok((await call(boss.token, '/api/participants')).body.items.some(p => p.participantId === Cn), '回到名冊上');
  console.log('✓ 已移出的人可以再被邀請回來');

  // ---- 4. 第一位自行註冊的人：只在還沒有平台管理員時成為管理員 ----
  {
    const N = await mk('first', { openJoin: '1' });
    const nJoin = async name => (await N.call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
    const nMe = async tok => (await N.call(tok, '/api/me')).body;
    const roles = m => [m.platformRole, m.workspaceRole];
    const first = await nJoin('林志明');
    const f = await nMe(first.token);
    assert.deepEqual(roles(f), ['admin', 'admin'], '平台還沒有平台管理員：第一位是平台管理員兼工作區管理員');
    assert.deepEqual(f.memberProjects, [], '第一位不加入專案（靠隱含權限）');
    assert.deepEqual(roles(await nMe((await nJoin('王小明')).token)), ['none', 'member'], '已有平台管理員：自行註冊者不會成為管理員');
    // 平台沒有任何平台管理員、但已經有人（API 做不出來的狀態，例如手動改過的舊資料）：下一位自行註冊的人成為平台管理員兼工作區管理員
    await N.db.run("UPDATE accounts SET platform_role = 'none'");
    const zhang = await nJoin('張大平');
    assert.deepEqual(roles(await nMe(zhang.token)), ['admin', 'admin'], '沒有平台管理員時，自行註冊的人成為平台管理員兼工作區管理員');
    assert.equal((await N.call(zhang.token, '/api/invites', 'POST', { name: '新人甲' })).status, 201, '他能發邀請');
    assert.deepEqual(roles(await nMe((await nJoin('趙一')).token)), ['none', 'member'], '之後的人又是一般成員');
  }
  console.log('✓ 第一位自行註冊者只在沒有平台管理員時成為平台管理員兼工作區管理員');

  console.log('workspace-invite-test：全部通過');
} catch (e) {
  console.error('workspace-invite-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const db of dbs) await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
