// 驗收測試：成員名冊（詞彙見 GLOSSARY「成員與權限」）
// 1. 所有工作區成員都看得到工作區裡所有啟用中的人與 AI（名字、類型、工作區角色、職稱、AI 的擁有者），包括還沒有專案的人
// 2. 每個人的專案資訊只列查詢者看得到的專案（私人專案不外洩）
// 3. 已移出與待接受邀請只有工作區管理員看得到（待接受的邀請：GET /api/invites?status=pending）；全平台帳號清單（含停用）只有平台管理員看得到
// 4. 有隱含權限的人不因此出現在名冊上
// 5. 給 AI 用的成員查詢（aigile_team → /api/team-status）回傳形狀不變，範圍依新規則
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/roster-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-roster-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const A = '預設專案', B = '第二專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
const roster = async tok => { const r = await call(tok, '/api/roster'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const names = list => list.map(p => p.name).sort();
const person = (list, id) => list.find(p => p.participantId === id);

try {
  const boss = await join('林志明', 'PO'); // 第一位＝平台管理員＋工作區管理員（靠隱含權限，不在任何專案）
  const chen = await join('陳昭宇', 'PG');
  const wang = await join('王小美', 'QA');
  const lin = await join('林小新', 'BA'); // 還沒加入任何專案
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId, Ln = lin.participant.participantId;
  boss.token = (await adminSession(call, boss.token)).token; // 任免管理員、停用帳號是敏感操作：用設了密碼、剛再驗證過的裝置登入
  assert.equal((await call(boss.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: [A] })).status, 200);
  assert.equal((await call(boss.token, `/api/participants/${Wg}/projects`, 'PUT', { projects: [A] })).status, 200);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S })).body;
  assert.ok(ai.token, JSON.stringify(ai));

  // ---- 1. 一般成員看得到所有啟用中的人與 AI，包括沒有專案的人 ----
  {
    const r = await roster(lin.token);
    assert.deepEqual(names(r.members), names([{ name: '林志明' }, { name: '陳昭宇' }, { name: '王小美' }, { name: '林小新' }, { name: '陳的PG' }]), '沒有專案的人也看得到所有人與 AI');
    const c = person(r.members, Cn), a = person(r.members, ai.participantId), b = person(r.members, Bo), l = person(r.members, Ln);
    assert.equal(c.memberType, 'human');
    assert.equal(c.workspaceRole, 'member');
    assert.equal(b.workspaceRole, 'admin', '工作區角色');
    assert.equal(b.platformRole, 'admin', '平台角色');
    assert.equal(a.memberType, 'ai');
    assert.equal(a.ownerParticipantId, Cn, 'AI 的擁有者');
    assert.equal(a.ownerName, '陳昭宇');
    assert.deepEqual(l.memberships, [], '沒有專案');
    assert.deepEqual(c.memberships.map(m => [m.project, m.role]), [[A, 'member']], '專案資訊：專案與專案角色');
    for (const k of ['removed', 'pending', 'accounts']) assert.ok(!(k in r), `一般成員看不到 ${k}`);
    assert.deepEqual(names((await roster(ai.token)).members), names(r.members), 'AI 看得到的範圍跟擁有者一樣');
  }
  console.log('✓ 一般成員看得到所有啟用中的人與 AI，包括沒有專案的人');

  // ---- 2. 專案資訊依查詢者可見度過濾：私人專案不外洩；審核專案不是成員也看得到 ----
  {
    const np = await call(boss.token, '/api/projects', 'POST', { name: '第三專案' });
    assert.equal(np.status, 201, JSON.stringify(np.body));
    const C = np.body.id;
    assert.equal((await call(boss.token, `/api/projects/${C}/members`, 'POST', { participantIds: [Wg] })).status, 201, '王小美加入第三專案（審核）');
    assert.equal((await call(boss.token, `/api/projects/${B}/visibility`, 'PUT', { visibility: 'private' })).status, 200);
    assert.equal((await call(boss.token, `/api/projects/${B}/members`, 'POST', { participantIds: [Wg], role: 'admin' })).status, 201, '王小美是私人專案的專案管理員');
    assert.equal((await call(boss.token, `/api/participants/${Wg}/project-roles`, 'PUT', { roles: { [A]: 'QA' } })).status, 200);
    const proj = (r, id) => person(r.members, id).memberships.map(m => m.project).sort();
    const mine = await roster(chen.token);
    assert.deepEqual(proj(mine, Wg), [A, C].sort(), '不在的審核專案也列；私人專案不列');
    assert.ok(!JSON.stringify(mine).includes(B), '私人專案的名字沒有出現在名冊裡');
    assert.equal(person(mine.members, Wg).memberships.find(m => m.project === A).title, 'QA', '職稱');
    assert.ok(!JSON.stringify(await roster(ai.token)).includes(B), 'AI 也看不到私人專案');
    const theirs = await roster(wang.token);
    assert.deepEqual(proj(theirs, Wg), [A, B, C].sort(), '自己在的私人專案看得到');
    assert.equal(person(theirs.members, Wg).memberships.find(m => m.project === B).role, 'admin', '專案角色');
    const adm = await roster(boss.token);
    assert.deepEqual(proj(adm, Wg), [A, B, C].sort(), '工作區管理員看得到私人專案（隱含權限）');
    assert.deepEqual(proj(adm, Bo), [C], '管理員自己只列明確加入的專案（隱含權限不算成員資格）');
    assert.equal(person(adm.members, Bo).memberships[0].role, 'admin', '建立者是專案管理員');
  }
  console.log('✓ 專案資訊依查詢者可見度過濾，私人專案不外洩');

  // ---- 3. 已移出與待邀請只有工作區管理員看得到；停用帳號清單只有平台管理員看得到 ----
  const zhou = await join('周大同', 'UX');
  const Zh = zhou.participant.participantId;
  {
    assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '張新人', projects: [{ project: A, role: 'viewer' }] })).status, 201, '邀請新的人');
    const used = (await call(boss.token, '/api/invites', 'POST', { name: '已取消', projects: [] })).body.invite;
    assert.equal((await call(boss.token, `/api/invites/${used.id}/cancel`, 'POST')).status, 200, '取消的邀請不算待接受');
    assert.equal((await call(boss.token, `/api/participants/${Ln}/remove`, 'POST')).status, 200, '把林小新移出工作區');
    assert.equal((await call(boss.token, `/api/participants/${Zh}/disable`, 'POST')).status, 200, '停用周大同的帳號');

    const m = await roster(chen.token);
    assert.ok(!person(m.members, Ln) && !person(m.members, Zh), '已移出、已停用的不在啟用中的名冊');
    for (const [tok, who] of [[chen.token, '一般成員'], [ai.token, 'AI']]) {
      const r = await roster(tok);
      for (const k of ['removed', 'pending', 'accounts']) assert.ok(!(k in r), `${who}看不到 ${k}`);
      assert.equal((await call(tok, '/api/invites?status=pending')).status, 403, `${who}看不到待接受的邀請`);
      assert.ok(!JSON.stringify(r).includes('張新人') && !JSON.stringify(r).includes('林小新') && !JSON.stringify(r).includes('周大同'), `${who}看不到這些人`);
      assert.deepEqual(r.can, { assignWorkspaceAdmin: false, removeMember: false, assignPlatformAdmin: false, manageAccounts: false });
    }

    assert.equal((await call(boss.token, `/api/participants/${Cn}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '陳昭宇升為工作區管理員（不是平台管理員）');
    const w = await roster(chen.token);
    assert.deepEqual(names(w.removed), ['林小新'], '工作區管理員看得到已移出的人');
    assert.equal(w.removed[0].status, 'removed');
    const pending = (await call(chen.token, '/api/invites?status=pending')).body.items;
    assert.deepEqual(pending.map(x => x.name), ['張新人'], '工作區管理員看得到待接受的邀請（取消的不算）');
    assert.deepEqual(pending[0].presets.map(x => [x.project, x.role]), [[A, 'viewer']], '邀請預設的專案與專案角色');
    assert.ok(!('accounts' in w), '工作區管理員看不到全平台帳號清單');
    assert.ok(!JSON.stringify(w).includes('周大同'), '工作區管理員看不到停用的帳號');
    assert.deepEqual(w.can, { assignWorkspaceAdmin: true, removeMember: true, assignPlatformAdmin: false, manageAccounts: false });

    const p = await roster(boss.token);
    assert.deepEqual(names(p.removed), ['林小新'], '平台管理員有隱含的工作區管理權');
    const acc = id => p.accounts.find(x => x.participantId === id);
    assert.deepEqual(names(p.accounts), names([{ name: '林志明' }, { name: '陳昭宇' }, { name: '王小美' }, { name: '林小新' }, { name: '周大同' }]), '全平台帳號（只有人類）');
    assert.deepEqual([acc(Zh).accountStatus, acc(Zh).workspaceStatus], ['disabled', 'active'], '停用的帳號');
    assert.deepEqual([acc(Ln).accountStatus, acc(Ln).workspaceStatus], ['active', 'removed'], '移出工作區不是停用帳號');
    assert.deepEqual([acc(Bo).platformRole, acc(Cn).platformRole, acc(Cn).workspaceRole], ['admin', 'none', 'admin'], '平台角色、工作區角色');
    assert.deepEqual(p.can, { assignWorkspaceAdmin: true, removeMember: true, assignPlatformAdmin: true, manageAccounts: true });
  }
  console.log('✓ 已移出與待邀請只有工作區管理員看得到；停用帳號只有平台管理員');

  // ---- 4. 有隱含權限的人不因此出現在名冊上：被移出工作區的平台管理員 ----
  {
    assert.equal((await call(boss.token, `/api/participants/${Wg}/platform-role`, 'PUT', { role: 'admin' })).status, 200, '王小美升為平台管理員');
    assert.equal((await call(boss.token, `/api/participants/${Wg}/remove`, 'POST')).status, 200, '再把她移出工作區');
    const r = await roster(wang.token); // 她靠平台管理員的隱含權限還進得來
    assert.ok(!person(r.members, Wg), '隱含權限不讓她出現在名冊上');
    assert.ok(person(r.removed, Wg), '她列在已移出');
    assert.ok(!person((await roster(chen.token)).members, Wg), '別人也看不到她在名冊上');
    assert.ok(!person((await roster(boss.token)).members, Bo).memberships.some(m => m.project === A), '工作區管理員沒加入的專案不列（隱含權限）');
  }
  console.log('✓ 有隱含權限的人不因此出現在名冊上');

  // ---- 5. 給 AI 用的成員查詢（MCP aigile_team → /api/team-status）：回傳形狀不變，範圍跟所屬人類一樣 ----
  {
    assert.equal((await call(boss.token, `/api/participants/${Cn}/workspace-role`, 'PUT', { role: 'member' })).status, 200, '陳昭宇降回成員（看不到私人專案）');
    const he = await join('何小平', 'PG'); // 沒有專案：舊規則下只在預設專案的 AI 看不到他
    const He = he.participant.participantId;
    const r = await call(ai.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aigile_team', arguments: {} } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = JSON.parse(r.body.result.content[0].text);
    assert.deepEqual(Object.keys(t).filter(k => k !== 'untrusted_content').sort(), ['now', 'decisions', 'members', 'staleMinutes', 'tokenWarnHours', 'unanswered', 'unansweredMinutes'].sort(), '最外層欄位不變');
    assert.deepEqual(names(t.members), names([{ name: '林志明' }, { name: '陳昭宇' }, { name: '何小平' }, { name: '陳的PG' }]), 'AI 看得到所有啟用中的工作區成員（包括沒有共同專案的人）；已移出、已停用的不列');
    const HUMAN_KEYS = ['participantId', 'name', 'role', 'roleKey', 'avatar', 'avatarImg', 'shortCode', 'memberType', 'projects', 'workspaceRole', 'platformRole', 'projectRoles', 'aiState', 'lastSeenAt', 'isOnline', 'stale', 'standby', 'wakesToday', 'lastWakeAt', 'status', 'tokenExpiresAt', 'tokenExpired', 'tokenExpiringSoon', 'pendingCount', 'oldestPendingAt'];
    assert.deepEqual(Object.keys(person(t.members, He)).sort(), [...HUMAN_KEYS].sort(), '成員欄位不變');
    assert.deepEqual(Object.keys(person(t.members, ai.participantId)).sort(), [...HUMAN_KEYS.filter(k => k !== 'projectRoles'), 'ownerParticipantId', 'ownerName'].sort(), 'AI 成員欄位不變');
    assert.deepEqual(person(t.members, He).projects, [], '沒有專案');
    assert.ok(!JSON.stringify(t).includes(B), '私人專案不外洩');
    const own = (await call(chen.token, '/api/team-status')).body.members;
    for (const m of t.members) assert.deepEqual(m.projects, person(own, m.participantId).projects, `AI 看到 ${m.name} 的專案跟所屬人類一樣`);
    const people = await call(ai.token, '/api/participants');
    assert.ok(people.body.items.some(p => p.participantId === He), 'GET /api/participants 的範圍也一樣');
  }
  console.log('✓ 給 AI 用的成員查詢回傳形狀不變，範圍依新規則');

  console.log('roster-test：全部通過');
} catch (e) {
  console.error('roster-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
