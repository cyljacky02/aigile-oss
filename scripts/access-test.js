// 權限模組（src/access.js）：「這個人在這個範圍的實際角色」與「能不能在這個範圍做某件事」
// 用法：node scripts/access-test.js
// 規則依第一階段之前的行為（GLOSSARY「成員與權限」用語）：
//   工作區管理員＝workspace_role 是 admin 的人類，可以有多位，對所有專案有隱含權限；平台管理員（帳號 platform_role）對工作區有隱含的管理權；
//   leader＝專案管理員；唯讀＝唯讀成員；AI 不能做任何管理動作
import assert from 'node:assert';
import { createAccess, ACCESS_ROLE } from '../src/access.js';

class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const requireHuman = me => { if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '此操作僅限人類成員'); };

const P = (id, kind, projects, extra = {}) => ({ id, kind, name: id, status: 'active', created_at: '2026-01-0' + id.length, projects, ...extra });
const admin = P('admin', 'human', ['main', 'side'], { workspace_role: 'admin', platform_role: 'admin' });
const admin2 = P('admin2', 'human', [], { workspace_role: 'admin' }); // 第二位工作區管理員，沒加入任何專案
const exAdmin = P('exAdmin', 'human', [], { workspace_role: 'admin', status: 'disabled' }); // 停用的不算
const lead = P('lead', 'human', ['main']);
const member = P('member', 'human', ['main']);
const viewer = P('viewer', 'human', ['main']);
const loner = P('loner', 'human', []);
const plat = P('plat', 'human', [], { workspace_role: 'member', platform_role: 'admin', workspace_status: 'removed' }); // 平台管理員：不是工作區成員（被移出）
const gone = P('gone', 'human', ['main'], { workspace_status: 'removed' }); // 已移出工作區的一般成員
const sider = P('sider', 'human', ['side']);
const bot = P('bot', 'ai', ['main'], { owner_id: 'member' });
const viewerBot = P('viewerBot', 'ai', ['main'], { owner_id: 'viewer' });
const people = new Map([admin, admin2, exAdmin, lead, member, viewer, loner, sider, bot, viewerBot, plat, gone].map(p => [p.id, p]));
const ACTIVE = ['main', 'side']; // 「old」是封存的專案
const leaders = { main: ['lead'], old: ['lead'] };
const readOnly = { main: ['viewer'] };
const titles = { lead: { main: 'PO' } };

const access = createAccess({
  ApiError, requireHuman, nameOf: id => ({ main: '主專案', side: '副專案', old: '舊專案' })[id] || id,
  people: async () => people, projects: () => ACTIVE, projectsOf: p => (p.projects || []).filter(x => ACTIVE.includes(x)),
  isolatedFrom: me => ACTIVE.some(x => !(me.projects || []).includes(x)),
  loadProjectAdmins: async () => leaders, projectAdminsOf: pj => leaders[pj] || [],
  loadReadOnly: async () => readOnly, isReadOnly: (p, pj) => (readOnly[pj] || []).includes(p.kind === 'ai' ? p.owner_id : p.id),
  titles: () => titles, memberProjectsOf: p => (p.projects || []).filter(x => ACTIVE.includes(x)),
  isPlatformAdmin: p => p.platform_role === 'admin',
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
  for (const action of ['manage_platform', 'manage_accounts', 'disable_account', 'assign_platform_admin']) {
    assert.ok(v.can(admin, action, 'platform'), action);
    assert.ok(!v.can(lead, action, 'platform'), action + '：leader 不行');
  }
  for (const action of ['manage_workspace', 'assign_workspace_admin', 'invite', 'reset_login', 'assign_members', 'create_project']) {
    assert.ok(v.can(admin, action, 'workspace'), action);
    assert.ok(v.can(admin2, action, 'workspace'), action + '：第二位工作區管理員也可以');
    assert.ok(!v.can(exAdmin, action, 'workspace'), action + '：停用的不行');
    assert.ok(!v.can(lead, action, 'workspace'), action + '：leader 不行');
  }
  for (const action of ['delete_project', 'set_project_code', 'set_project_slug']) {
    assert.ok(v.can(admin, action, { project: 'main' }), action);
    assert.ok(!v.can(lead, action, { project: 'main' }), action + '：leader 不行');
  }
  console.log('✓ 平台、工作區動作只有管理員');

  // 平台管理員：工作區管理員不等於平台管理員；平台管理員不是工作區成員也有工作區管理權、所有專案的專案管理權
  assert.equal(v.roleIn(admin2, 'platform'), null, '工作區管理員不是平台管理員');
  for (const action of ['manage_platform', 'manage_accounts', 'disable_account', 'assign_platform_admin']) assert.ok(!v.can(admin2, action, 'platform'), action + '：工作區管理員不行');
  assert.equal(v.roleIn(plat, 'platform'), PLATFORM_ADMIN);
  assert.equal(v.roleIn(plat, 'workspace'), WORKSPACE_ADMIN, '平台管理員有隱含的工作區管理權（被移出工作區也一樣）');
  assert.equal(v.roleIn(plat, { project: 'main' }), PROJECT_ADMIN, '也有所有專案的專案管理權');
  assert.ok(v.can(plat, 'manage_workspace', 'workspace') && v.can(plat, 'remove_member', 'workspace'));
  assert.ok(v.implicitOnlyIn(plat.id, 'main'), '隱含權不算成員資格');
  assert.ok(!v.can({ ...plat, status: 'disabled' }, 'manage_platform', 'platform'), '停用的平台管理員不行');
  assert.equal(v.roleIn(gone, 'workspace'), null, '已移出工作區的一般成員不是工作區成員');
  assert.ok(!v.can(member, 'remove_member', 'workspace') && v.can(admin2, 'remove_member', 'workspace'), '移出工作區：工作區管理員');
  assert.deepEqual(v.platformAdmins().map(p => p.id), ['plat', 'admin'], '兩位平台管理員（照加入順序）');
  assert.ok(!v.lastAdmin(admin, 'platform'), '還有別的平台管理員');
  assert.ok(access.view({ people: new Map([admin, admin2].map(p => [p.id, p])) }).lastAdmin(admin, 'platform'), '只剩他：最後一位平台管理員');
  assert.ok(!access.view({ people: new Map([admin, admin2].map(p => [p.id, p])) }).lastAdmin(admin2, 'platform'), '不是平台管理員就不算');
  await assert.rejects(access.check(ctx, admin2, 'manage_platform', 'platform', { what: '改平台設定' }), e => e.code === 'NOT_ADMIN' && e.message === '只有平台管理員能改平台設定。');
  console.log('✓ 平台管理員');

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

  // 名冊可見範圍（誰看得到誰）：成員名冊所有工作區成員都看得到所有人
  assert.ok(v.can(admin, 'see_member', { target: sider }), '在所有專案的人看得到所有人');
  assert.ok(v.can(member, 'see_member', { target: lead }), '同專案看得到');
  assert.ok(v.can(member, 'see_member', { target: sider }), '不同專案也看得到');
  assert.ok(v.can(member, 'see_member', { target: loner }), '還沒有專案的人也看得到');
  assert.ok(v.can(bot, 'see_member', { target: loner }), 'AI 也是工作區成員');
  assert.ok(v.can(plat, 'see_member', { target: loner }), '平台管理員（隱含權限）');
  assert.ok(!v.can(gone, 'see_member', { target: loner }), '已移出工作區的人看不到');
  assert.ok(v.can(loner, 'see_member', { target: loner }), '看得到自己');
  assert.ok(v.can(admin, 'see_removed_members', 'workspace') && v.can(plat, 'see_removed_members', 'workspace'), '工作區管理員看得到已移出的人');
  assert.ok(!v.can(member, 'see_removed_members', 'workspace') && !v.can(bot, 'see_removed_members', 'workspace'));
  assert.ok(v.can(member, 'see_ai_state', { target: bot }));
  assert.ok(!v.can(sider, 'see_ai_state', { target: bot }));
  console.log('✓ 名冊可見範圍');

  // 隱含權限不算成員：工作區管理員在沒加入、也沒有職稱的專案不列為成員
  assert.ok(v.implicitOnlyIn(admin2.id, 'main'), '沒加入的專案：只有隱含權限');
  assert.ok(!v.implicitOnlyIn(admin.id, 'main'), '有加入的專案照舊是成員');
  assert.ok(!v.implicitOnlyIn(lead.id, 'main'));
  assert.equal(v.roleIn(admin2, { project: 'side' }), PROJECT_ADMIN, '沒加入也是專案管理員（隱含）');
  console.log('✓ 隱含權限');

  // 多位工作區管理員與最後一位保護
  assert.deepEqual(v.admins().map(p => p.id), ['admin', 'admin2'], '兩位啟用中的工作區管理員');
  assert.ok(!v.lastAdmin(admin), '還有別人：不是最後一位');
  assert.ok(!v.lastAdmin(member), '一般成員不算');
  const solo = access.view({ people: new Map([admin, exAdmin, member].map(p => [p.id, p])) });
  assert.ok(solo.lastAdmin(admin), '停用的不算：admin 是最後一位');
  assert.equal(solo.admin().id, 'admin');
  console.log('✓ 多位工作區管理員、最後一位');

  // 建立專案：工作區設定是「所有成員」時一般成員也可以；AI 永遠不行（上面沒注入設定＝只有管理員）
  let wsRead = 0;
  const open = createAccess({
    ApiError, requireHuman, nameOf: id => id, people: async () => people, projects: () => ACTIVE, projectsOf: p => (p.projects || []).filter(x => ACTIVE.includes(x)),
    isolatedFrom: () => false, isCrossRole: () => false, loadProjectAdmins: async () => leaders, projectAdminsOf: pj => leaders[pj] || [],
    loadReadOnly: async () => readOnly, isReadOnly: () => false, titles: () => titles,
    loadWorkspace: async force => { if (force) wsRead++; }, membersCreateProjects: () => true,
  });
  const ov = await open.load(ctx);
  for (const p of [admin, lead, member, loner]) assert.ok(ov.can(p, 'create_project', 'workspace'), `所有成員：${p.id} 可以建立專案`);
  assert.ok(!ov.can(bot, 'create_project', 'workspace'), 'AI 不能建立專案');
  assert.ok(!ov.can({ ...member, status: 'disabled' }, 'create_project', 'workspace'), '停用的人不行');
  assert.ok(!ov.can(member, 'manage_workspace', 'workspace'), '建立專案不等於管理工作區');
  await open.check(ctx, member, 'create_project', 'workspace');
  assert.equal(wsRead, 1, 'check 時重讀工作區設定（別份程式剛改過也算）');
  console.log('✓ 建立專案');

  // 建立專案申請：政策是 approval；規則本身要求有效的人類，can 與 check 對 AI 都回否
  const appr = createAccess({
    ApiError, requireHuman, nameOf: id => id, people: async () => people, projects: () => ACTIVE, projectsOf: p => (p.projects || []).filter(x => ACTIVE.includes(x)),
    isolatedFrom: () => false, loadProjectAdmins: async () => leaders, projectAdminsOf: pj => leaders[pj] || [],
    loadReadOnly: async () => readOnly, isReadOnly: () => false, isPlatformAdmin: p => p.platform_role === 'admin',
    loadWorkspace: async () => {}, membersCreateProjects: () => false, membersRequestProjects: () => true,
  });
  const av = await appr.load(ctx);
  assert.ok(av.can(member, 'request_project_creation', 'workspace'), '一般成員可以申請');
  assert.ok(!av.can(member, 'create_project', 'workspace'), '但不能直接建立');
  assert.equal(await code(appr.check(ctx, member, 'create_project', 'workspace')), 'PROJECT_CREATION_REQUIRES_APPROVAL', '直接建立的錯誤代碼');
  assert.equal(await code(appr.check(ctx, bot, 'create_project', 'workspace')), 'NOT_ADMIN', 'AI 直接建立維持既有拒絕');
  for (const p of [admin, admin2, plat]) assert.ok(!av.can(p, 'request_project_creation', 'workspace'), `${p.id} 直接建立，不送申請`);
  for (const action of ['review_project_creation_requests', 'approve_project_creation_request', 'reject_project_creation_request']) { // 查看待審、核准、拒絕
    for (const p of [admin, admin2, plat]) assert.ok(av.can(p, action, 'workspace'), `${p.id} 能 ${action}`);
    for (const p of [lead, member]) assert.ok(!av.can(p, action, 'workspace'), `${p.id}（專案管理員也一樣）不能 ${action}`);
    // 查看審核清單：無權查看一律 404；核准、拒絕：看得到申請但沒有審核權 403
    assert.equal(await code(appr.check(ctx, member, action, 'workspace')), action === 'review_project_creation_requests' ? 'NOT_FOUND' : 'NOT_REVIEWER', `成員 ${action} 的錯誤代碼`);
  }
  for (const action of ['request_project_creation', 'see_own_project_creation_requests', 'withdraw_project_creation_request', 'review_project_creation_requests', 'approve_project_creation_request', 'reject_project_creation_request']) {
    for (const ai of [bot, { ...bot, owner_id: 'admin' }]) {
      assert.ok(!av.can(ai, action, { target: ai }), `can：AI 不能 ${action}`);
      assert.ok(await code(appr.check(ctx, ai, action, { target: ai })), `check：AI 不能 ${action}`);
    }
    assert.ok(!av.can({ ...member, status: 'disabled' }, action, { target: member }), `停用的人不能 ${action}`);
  }
  assert.ok(av.can(member, 'see_own_project_creation_requests', { target: member }), '看自己的');
  assert.ok(!av.can(member, 'see_own_project_creation_requests', { target: lead }), '不能看別人的');
  assert.ok(!av.can(gone, 'see_own_project_creation_requests', { target: gone }), '被移出後看不到自己的');
  assert.ok(!av.can(gone, 'withdraw_project_creation_request', { target: gone }), '被移出後不能撤回');
  assert.ok(!av.can(admin, 'withdraw_project_creation_request', { target: member }), '審核人不能代撤回');
  assert.ok(!ov.can(member, 'request_project_creation', 'workspace'), '政策不是 approval：不能申請');
  console.log('✓ 建立專案申請');

  // 專案可見度：main 開放、side 私人；沒注入（上面的 access）＝審核
  assert.equal(v.visibilityOf('main'), 'review', '沒設可見度＝審核');
  const vis = { main: 'open', side: 'private' };
  const va = await createAccess({
    ApiError, requireHuman, nameOf: id => id, people: async () => people, projects: () => ACTIVE, projectsOf: p => (p.projects || []).filter(x => ACTIVE.includes(x)),
    isolatedFrom: me => ACTIVE.some(x => !(me.projects || []).includes(x)), loadProjectAdmins: async () => leaders, projectAdminsOf: pj => leaders[pj] || [],
    loadReadOnly: async () => readOnly, isReadOnly: () => false, titles: () => titles, visibilityOf: pj => vis[pj],
  }).load(ctx);
  assert.ok(va.can(loner, 'discover_project', { project: 'main' }), '開放專案人人看得到');
  assert.ok(!va.can(member, 'discover_project', { project: 'side' }), '私人專案非成員看不到');
  assert.ok(!va.can(bot, 'discover_project', { project: 'side' }), 'AI 也看不到');
  assert.ok(va.can(sider, 'discover_project', { project: 'side' }), '成員看得到');
  assert.ok(va.can({ ...admin, projects: [] }, 'discover_project', { project: 'side' }), '工作區管理員靠隱含權限看得到');
  assert.deepEqual(va.visibleProjects(member), ['main']);
  assert.ok(va.can(loner, 'join_project', { project: 'main' }) && !va.can(loner, 'request_join', { project: 'main' }), '開放：直接加入，不用申請');
  assert.ok(!va.can(loner, 'join_project', { project: 'side' }) && !va.can(loner, 'request_join', { project: 'side' }), '私人：不能自己加入或申請');
  assert.ok(v.can(loner, 'request_join', { project: 'main' }) && !v.can(loner, 'join_project', { project: 'main' }), '審核：申請，不能直接加入');
  for (const [p, ok] of [[admin, true], [lead, true], [member, false], [bot, false], [sider, false]]) assert.equal(v.can(p, 'set_visibility', { project: 'main' }), ok, `改可見度：${p.id}`);
  console.log('✓ 專案可見度');

  // check 的錯誤：預設訊息帶 what；可以換掉
  await assert.rejects(access.check(ctx, member, 'manage_workspace', 'workspace', { what: '改工作區名稱' }), e => e.code === 'NOT_ADMIN' && e.message === '只有工作區管理員（admin）能改工作區名稱。');
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
