// 權限模組（src/access.js）：「這個人在這個範圍的實際角色」與「能不能在這個範圍做某件事」
// 用法：node scripts/access-test.js
// 規則依第一階段之前的行為（GLOSSARY「成員與權限」用語）：
//   工作區管理員＝唯一的管理員（同時是平台管理員），對所有專案有隱含權限；leader＝專案管理員；唯讀＝唯讀成員；AI 不能做任何管理動作
import assert from 'node:assert';
import { createAccess, ACCESS_ROLE } from '../src/access.js';

class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const requireHuman = me => { if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '此操作僅限人類成員'); };

const P = (id, kind, projects, extra = {}) => ({ id, kind, name: id, status: 'active', created_at: '2026-01-0' + id.length, projects, ...extra });
const admin = P('admin', 'human', ['main', 'side'], { is_admin: 1 });
const lead = P('lead', 'human', ['main']);
const member = P('member', 'human', ['main']);
const viewer = P('viewer', 'human', ['main']);
const loner = P('loner', 'human', []);
const sider = P('sider', 'human', ['side']);
const bot = P('bot', 'ai', ['main'], { owner_id: 'member' });
const viewerBot = P('viewerBot', 'ai', ['main'], { owner_id: 'viewer' });
const people = new Map([admin, lead, member, viewer, loner, sider, bot, viewerBot].map(p => [p.id, p]));
const ACTIVE = ['main', 'side']; // 「old」是封存的專案
const leaders = { main: ['lead'], old: ['lead'] };
const readOnly = { main: ['viewer'] };
const titles = { lead: { main: 'PO' } };

const access = createAccess({
  ApiError, requireHuman, nameOf: id => ({ main: '主專案', side: '副專案', old: '舊專案' })[id] || id,
  people: async () => people, projects: () => ACTIVE, projectsOf: p => (p.projects || []).filter(x => ACTIVE.includes(x)),
  isolatedFrom: me => ACTIVE.some(x => !(me.projects || []).includes(x)),
  loadLeaders: async () => leaders, leadersOf: pj => leaders[pj] || [],
  loadReadOnly: async () => readOnly, isReadOnly: (p, pj) => (readOnly[pj] || []).includes(p.kind === 'ai' ? p.owner_id : p.id),
  titles: () => titles,
});
const ctx = {};
const code = async p => { try { await p; return null; } catch (e) { return e.code; } };

try {
  const v = await access.load(ctx);
  const { PLATFORM_ADMIN, WORKSPACE_ADMIN, MEMBER, PROJECT_ADMIN, PROJECT_MEMBER, VIEWER } = ACCESS_ROLE;

  // 實際角色：平台／工作區／專案
  assert.equal(v.roleIn(admin, 'platform'), PLATFORM_ADMIN, '管理員是平台管理員');
  assert.equal(v.roleIn(member, 'platform'), null, '一般成員沒有平台角色');
  assert.equal(v.roleIn(admin, 'workspace'), WORKSPACE_ADMIN);
  assert.equal(v.roleIn(loner, 'workspace'), MEMBER, '沒有專案的人也是工作區成員');
  assert.equal(v.roleIn(bot, 'workspace'), MEMBER, 'AI 是工作區成員');
  assert.equal(v.roleIn(admin, { project: 'side' }), PROJECT_ADMIN, '工作區管理員對每個專案有隱含權限');
  assert.equal(v.roleIn(lead, { project: 'main' }), PROJECT_ADMIN, 'leader＝專案管理員');
  assert.equal(v.roleIn(lead, { project: 'old' }), PROJECT_ADMIN, '封存的專案 leader 還是專案管理員（才能還原）');
  assert.equal(v.roleIn(member, { project: 'main' }), PROJECT_MEMBER);
  assert.equal(v.roleIn(viewer, { project: 'main' }), VIEWER);
  assert.equal(v.roleIn(viewerBot, { project: 'main' }), VIEWER, 'AI 跟著所屬人類唯讀');
  assert.equal(v.roleIn(bot, { project: 'main' }), PROJECT_MEMBER);
  assert.equal(v.roleIn(member, { project: 'side' }), null, '不在專案＝沒有專案角色');
  console.log('✓ 實際角色');

  // 平台、工作區動作：只有管理員
  for (const action of ['manage_platform', 'manage_accounts', 'assign_platform_admin']) {
    assert.ok(v.can(admin, action, 'platform'), action);
    assert.ok(!v.can(lead, action, 'platform'), action + '：leader 不行');
  }
  for (const action of ['manage_workspace', 'invite', 'reset_login', 'assign_members', 'create_project']) {
    assert.ok(v.can(admin, action, 'workspace'), action);
    assert.ok(!v.can(lead, action, 'workspace'), action + '：leader 不行');
  }
  for (const action of ['delete_project', 'set_project_code', 'set_project_slug']) {
    assert.ok(v.can(admin, action, { project: 'main' }), action);
    assert.ok(!v.can(lead, action, { project: 'main' }), action + '：leader 不行');
  }
  console.log('✓ 平台、工作區動作只有管理員');

  // 專案管理：管理員或該專案 leader；封存的專案 leader 只能改名、封存、還原這類 manage_project
  assert.ok(v.can(lead, 'manage_project', { project: 'main' }));
  assert.ok(v.can(lead, 'manage_project', { project: 'old' }), '封存專案的 leader 能還原');
  assert.ok(!v.can(member, 'manage_project', { project: 'main' }));
  assert.ok(v.can(admin, 'manage_project', { project: 'side' }));
  assert.ok(v.can(lead, 'configure_project', { project: 'main' }));
  assert.ok(!v.can(lead, 'configure_project', { project: 'old' }), '封存專案的 leader 不能改程式庫、私訊、AI 職務');
  assert.ok(v.can(admin, 'configure_project', { project: 'old' }));
  assert.ok(v.can(lead, 'manage_project_members', { project: 'main' }));
  assert.ok(!v.can(lead, 'manage_project_members', { project: 'side' }));
  assert.ok(!v.can(member, 'manage_project_members', { project: 'main' }), '專案成員不能管理成員');
  assert.ok(!v.can(viewer, 'manage_project_members', { project: 'main' }), '唯讀成員不能管理成員');
  // 任免專案管理員：工作區管理員，以及該（未封存）專案的專案管理員
  assert.ok(v.can(admin, 'assign_project_admin', { project: 'side' }));
  assert.ok(v.can(lead, 'assign_project_admin', { project: 'main' }), '專案管理員能任免自己專案的專案管理員');
  assert.ok(!v.can(lead, 'assign_project_admin', { project: 'side' }));
  assert.ok(!v.can(lead, 'assign_project_admin', { project: 'old' }), '封存的專案不行');
  assert.ok(!v.can(member, 'assign_project_admin', { project: 'main' }));
  console.log('✓ 專案管理');

  // 職稱：管理員、該專案 leader、本人
  assert.ok(v.can(lead, 'set_title', { project: 'main', target: member }));
  assert.ok(v.can(member, 'set_title', { project: 'main', target: member }), '本人可以改自己的職稱');
  assert.ok(!v.can(member, 'set_title', { project: 'main', target: viewer }));
  assert.ok(v.can(admin, 'set_title', { project: 'main', target: viewer }));
  console.log('✓ 職稱');

  // 寫入：唯讀成員與他的 AI 不行；沒有專案（全部專案頻道）時在任何專案唯讀就不行
  assert.ok(v.can(member, 'write', { project: 'main' }));
  assert.ok(!v.can(viewer, 'write', { project: 'main' }));
  assert.ok(!v.can(viewerBot, 'write', { project: 'main' }));
  assert.ok(!v.can(viewer, 'write', { project: null }));
  assert.ok(v.can(member, 'write', { project: null }));
  assert.equal(await code(access.check(ctx, viewerBot, 'write', { project: 'main' })), 'READ_ONLY');
  console.log('✓ 寫入');

  // AI 不能做任何管理動作
  const aiAdmin = { ...bot, id: 'admin' }; // 就算 id 對上管理員也不行
  for (const [action, scope] of [['manage_workspace', 'workspace'], ['manage_project', { project: 'main' }], ['configure_project', { project: 'main' }], ['manage_platform', 'platform'], ['set_title', { project: 'main', target: bot }]]) {
    assert.ok(!v.can(aiAdmin, action, scope), 'AI 不能 ' + action);
    assert.ok(!v.can(bot, action, scope), 'AI 不能 ' + action);
  }
  assert.equal(await code(access.check(ctx, bot, 'manage_project', { project: 'main' })), 'FORBIDDEN', 'AI 管專案：僅限人類');
  assert.equal(await code(access.check(ctx, bot, 'manage_workspace', 'workspace')), 'NOT_ADMIN');
  console.log('✓ AI 不能做管理動作');

  // 名冊可見範圍（誰看得到誰）
  assert.ok(v.can(admin, 'see_member', { target: sider }), '在所有專案的人看得到所有人');
  assert.ok(v.can(member, 'see_member', { target: lead }), '同專案看得到');
  assert.ok(!v.can(member, 'see_member', { target: sider }), '不同專案看不到');
  assert.ok(!v.can(member, 'see_member', { target: loner }));
  assert.ok(v.can(lead, 'see_member', { target: loner }), 'leader 看得到還沒有專案的人類（才能加進來）');
  assert.ok(v.can(loner, 'see_member', { target: loner }), '看得到自己');
  assert.ok(v.can(member, 'see_ai_state', { target: bot }));
  assert.ok(!v.can(sider, 'see_ai_state', { target: bot }));
  console.log('✓ 名冊可見範圍');

  // 隱含權限不算成員：管理員在沒有職稱的專案不列為成員
  assert.ok(v.implicitOnlyIn(admin.id, 'main'));
  assert.ok(!v.implicitOnlyIn(lead.id, 'main'));
  console.log('✓ 隱含權限');

  // check 的錯誤：預設訊息帶 what；可以換掉
  await assert.rejects(access.check(ctx, member, 'manage_workspace', 'workspace', { what: '改群組名稱' }), e => e.code === 'NOT_ADMIN' && e.message === '只有群組管理員（admin）能改群組名稱。');
  await assert.rejects(access.check(ctx, member, 'manage_project', { project: 'main' }, { deny: () => new ApiError(403, 'NOT_REVIEWER', 'x') }), e => e.code === 'NOT_REVIEWER');
  assert.equal(await code(access.check(ctx, admin, 'manage_workspace', 'workspace')), null);
  assert.equal(await access.can(ctx, lead, 'manage_project', { project: 'main' }), true, 'access.can 不先 load 也能用');
  assert.throws(() => v.can(admin, 'fly', 'workspace'), /fly/, '沒有的動作要報錯，不要默默回 false');
  console.log('✓ check');

  console.log('access-test：全部通過');
} catch (e) {
  console.error('access-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
