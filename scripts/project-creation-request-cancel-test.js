// 驗收測試（#46、ADR 0004、0005）：政策或成員資格改變時，安全取消待審的建立專案申請
// - 政策三選一；approval → admins／members：同一批取消該工作區所有待審申請（policy_changed）、通知每位申請人；其他方向不處理
// - 預覽（只給有權修改政策的人）回目前的待審數量；儲存回應回交易內實際取消的數量；稽核 workspace_policy.update 記實際數
// - 預覽與實際不同（預覽之後又多了申請）時以實際為準
// - 移出（workspace_member_removed）、離開（workspace_member_left）、停用（account_disabled）：同一批取消、不通知；實際數記進該操作既有的稽核
// - 最後一位管理員保護讓操作失敗時，不取消任何申請
// - 申請人升為工作區管理員：申請保留待審核；重新啟用、重新加入、政策切回 approval 都不恢復已取消的申請
// - 移出、離開、停用、升降管理員、恢復帳號：還原備份中在交易內被擋（503 RESTORING），什麼都沒寫
// - 申請資料表還沒建立（程式先部署）：政策切換、移出、停用照常
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-creation-request-cancel-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrc-'));
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.equal(r.status, status, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); if (errCode) assert.equal(code(r), errCode, label); return r.body; };
const dbs = [];
// hooks.before：下一個含符合 re 那句的寫入送出前先執行 run()（只作用一次）
function harness(db, config = CONFIG) {
  const hooks = { before: null };
  const wrapped = { ...db, batch: async stmts => {
    const b = hooks.before && stmts.some(([sql]) => hooks.before.re.test(sql)) ? hooks.before : null;
    if (b) { hooks.before = null; await b.run(); }
    return db.batch(stmts);
  } };
  const events = [];
  const live = { toPeople: (ids, type, data) => { events.push({ ids: [...ids], type, data }); return ids.length; }, connectedIds: () => [], dropPerson: () => {}, open: () => new Response('') };
  const app = createApp({ db: wrapped, storage: dbStorage(db), docText: '', config, live });
  return { hooks, events, call: appCaller(app) };
}
const count = async (db, sql, ...args) => Number((await db.get(sql, ...args)).n);
let seq = 0;
const rid = () => `req-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

try {
  const db = await openTestDb(path.join(dataDir, 'main', 'switch.db'));
  dbs.push(db);
  const { hooks, events, call } = harness(db);
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const chen = await join('陳大文'); // 申請人
  const wang = await join('王小美'); // 申請人
  const bossS = await adminSession(call, boss.token);
  boss.token = bossS.token;
  for (const p of [chen, wang]) ok(await call(boss.token, `/api/participants/${p.id}/projects`, 'PUT', { projects: ['預設專案'] }), `${p.id} 加入預設專案`);
  const setPolicy = async value => ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: value }), `政策設成 ${value}`);
  const submit = async (who, name) => is(await call(who.token, '/api/project-creation-requests', 'POST', { requestId: rid(), name, reason: '要做新功能' }), 201, null, `${name} 送出`);
  const stateOf = async id => (await db.get('SELECT state, cancel_code, ended_by, ended_at FROM project_creation_requests WHERE id = ?', id));
  const lastAudit = async action => db.get('SELECT * FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1', action);
  const preview = () => call(boss.token, '/api/workspace/settings/create-projects-preview');

  // ---------- 1) 政策 approval → admins：預覽、同一批取消、實際數量、稽核、通知申請人 ----------
  await setPolicy('approval');
  const c1 = await submit(chen, '陳的申請一');
  const c2 = await submit(chen, '陳的申請二');
  const w1 = await submit(wang, '王的申請');
  is(await call(chen.token, '/api/workspace/settings/create-projects-preview'), 403, null, '一般成員不能看預覽');
  const pv = ok(await preview(), '預覽');
  assert.deepEqual(pv, { createProjects: 'approval', pendingProjectCreationRequests: 3 }, '預覽＝目前的待審數量');
  // 預覽之後、儲存之前又多一份：實際取消 4 份（以實際為準）
  const w2 = await submit(wang, '王的第二份');
  events.length = 0;
  const noticesBefore = await count(db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_cancelled'");
  const saved = ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }), '切到只有管理員');
  assert.equal(saved.createProjects, 'admins');
  assert.equal(saved.cancelledProjectCreationRequests, 4, '儲存回應回實際取消的數量（不是預覽的 3）');
  for (const r of [c1, c2, w1, w2]) {
    const s = await stateOf(r.id);
    assert.deepEqual([s.state, s.cancel_code, s.ended_by], ['cancelled', 'policy_changed', null], `${r.name} 已取消（policy_changed）`);
    assert.ok(s.ended_at, '有結束時間');
  }
  const pa = await lastAudit('workspace_policy.update');
  assert.deepEqual(JSON.parse(pa.detail), { field: 'createProjects', from: 'approval', to: 'admins', counted: 'cancelledProjectCreationRequests' }, '稽核：政策變更');
  assert.equal(Number(pa.count), 4, '稽核記下實際取消數');
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'project_creation_request%'"), 0, '不為每份申請另寫稽核');
  // 通知：每位申請人一則（陳兩份也只一則），不帶申請內容
  const notices = await db.all("SELECT participant_id, detail FROM account_notices WHERE kind = 'project_creation_request_cancelled'");
  assert.equal(notices.length - noticesBefore, 2, '兩位申請人各一則');
  assert.deepEqual(notices.map(n => n.participant_id).sort(), [chen.id, wang.id].sort());
  assert.ok(notices.every(n => !/申請/.test(n.detail)), '通知不帶申請內容');
  const chenNotice = ok(await call(chen.token, '/api/me/notices'), '陳讀通知').items.filter(n => n.kind === 'project_creation_request_cancelled');
  assert.equal(chenNotice.length, 1, '申請人在帳號提醒看得到');
  // 申請人看得到已取消與原因
  const mine = ok(await call(chen.token, '/api/project-creation-requests?scope=mine'), '陳的申請').items;
  assert.ok(mine.filter(x => [c1.id, c2.id].includes(x.id)).every(x => x.state === 'cancelled' && x.cancelCode === 'policy_changed'), '我的建立專案申請顯示已取消與原因');
  // 即時事件：只發「請重新抓取」，給申請人（與審核人），不帶內容
  const stale = events.filter(e => e.type === 'stale');
  assert.ok(stale.length >= 1 && stale.every(e => JSON.stringify(e.data) === '{}'), '只發不帶內容的重新抓取：' + JSON.stringify(events));
  assert.ok([chen.id, wang.id].every(id => stale.some(e => e.ids.includes(id))), '申請人收到重新抓取');
  // 預覽：不是 approval 時照樣回目前的待審數量（0）
  assert.deepEqual(ok(await preview(), '預覽（admins）'), { createProjects: 'admins', pendingProjectCreationRequests: 0 });

  // ---------- 2) 其他方向不處理任何申請；政策切回 approval 不恢復已取消的 ----------
  await setPolicy('members');
  const pm = await lastAudit('workspace_policy.update');
  assert.deepEqual(JSON.parse(pm.detail), { field: 'createProjects', from: 'admins', to: 'members' }, 'admins → members 不涉及申請');
  assert.equal(pm.count, null, '沒有取消數');
  const back = ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '切回 approval');
  assert.equal(back.cancelledProjectCreationRequests, 0, '切回 approval：沒有取消');
  assert.equal((await stateOf(c1.id)).state, 'cancelled', '切回 approval 不恢復');
  // approval → members 一樣取消
  const c3 = await submit(chen, '陳的申請三');
  const toMembers = ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'members' }), 'approval → members');
  assert.equal(toMembers.cancelledProjectCreationRequests, 1);
  assert.equal((await stateOf(c3.id)).cancel_code, 'policy_changed');
  // 沒有待審時切走：0，照樣記稽核
  await setPolicy('approval');
  const none = ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }), '沒有待審時切走');
  assert.equal(none.cancelledProjectCreationRequests, 0);
  assert.equal(Number((await lastAudit('workspace_policy.update')).count), 0, '稽核記 0');
  // 同時改了別的設定（只改刪除訊息政策）：回應不帶取消數
  const other = ok(await call(boss.token, '/api/workspace/settings', 'PUT', { deleteOwnMessages: 'admins' }), '只改刪除訊息政策');
  assert.ok(!('cancelledProjectCreationRequests' in other), '沒改建立專案政策：不帶取消數');

  // ---------- 3) 移出、離開、停用：同一批取消這位申請人的待審申請、不通知、實際數記進既有的稽核 ----------
  await setPolicy('approval');
  const dan = await join('丹尼'), lee = await join('李四'), eve = await join('伊芙');
  const dReqs = [await submit(dan, '丹尼一'), await submit(dan, '丹尼二')];
  const lReq = await submit(lee, '李四的申請');
  const eReq = await submit(eve, '伊芙的申請');
  const keep = await submit(wang, '王留著的');
  const ntc0 = await count(db, 'SELECT COUNT(*) AS n FROM account_notices');
  const removed = ok(await call(boss.token, `/api/participants/${dan.id}/remove`, 'POST'), '移出丹尼');
  assert.equal(removed.cancelledProjectCreationRequests, 2, '移出：回實際取消的數量');
  for (const r of dReqs) assert.deepEqual(Object.values(await stateOf(r.id)).slice(0, 3), ['cancelled', 'workspace_member_removed', null], '移出：workspace_member_removed');
  const ra = await lastAudit('member.remove');
  assert.equal(Number(ra.count), 2, 'member.remove 稽核記實際取消數');
  assert.equal(JSON.parse(ra.detail).counted, 'cancelledProjectCreationRequests');
  const left = ok(await call(lee.token, '/api/leave', 'POST'), '李四離開');
  assert.equal(left.cancelledProjectCreationRequests, 1, '離開：回實際取消的數量');
  assert.equal((await stateOf(lReq.id)).cancel_code, 'workspace_member_left', '離開：workspace_member_left');
  assert.equal(Number((await lastAudit('member.leave')).count), 1, 'member.leave 稽核記實際取消數');
  const disabled = ok(await call(boss.token, `/api/participants/${eve.id}/disable`, 'POST'), '停用伊芙');
  assert.equal(disabled.cancelledProjectCreationRequests, 1, '停用：回實際取消的數量');
  assert.equal((await stateOf(eReq.id)).cancel_code, 'account_disabled', '停用：account_disabled');
  assert.equal(Number((await lastAudit('account.disable')).count), 1, 'account.disable 稽核記實際取消數');
  assert.equal((await stateOf(keep.id)).state, 'pending', '別人的申請不受影響');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM account_notices WHERE participant_id IN (?, ?, ?)', dan.id, lee.id, eve.id), 0, '移出、離開、停用不通知申請人');
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM account_notices WHERE kind = 'project_creation_request_cancelled'"), notices.length + 1, '只有政策切走時通知申請人（上面 approval → members 那次）');
  assert.ok(await count(db, 'SELECT COUNT(*) AS n FROM account_notices') >= ntc0);
  // 沒有待審申請的人被移出：0，稽核記 0
  const fay = await join('菲菲');
  assert.equal(ok(await call(boss.token, `/api/participants/${fay.id}/remove`, 'POST'), '移出菲菲').cancelledProjectCreationRequests, 0);
  assert.equal(Number((await lastAudit('member.remove')).count), 0);

  // ---------- 4) 重新啟用、重新加入不恢復已取消的申請 ----------
  ok(await call(boss.token, `/api/participants/${eve.id}/enable`, 'POST'), '恢復伊芙');
  assert.equal((await stateOf(eReq.id)).state, 'cancelled', '重新啟用不恢復');
  const inv = ok(await call(boss.token, '/api/invites', 'POST', { name: '丹尼' }), '邀請丹尼回來');
  ok(await call(null, '/api/auth/invite', 'POST', { token: inv.url.split('/invite/')[1], code: dan.token }), '丹尼用原本的登入碼回來');
  assert.equal((await db.get('SELECT workspace_status FROM participants WHERE id = ?', dan.id)).workspace_status, 'active', '丹尼回到工作區');
  for (const r of dReqs) assert.equal((await stateOf(r.id)).state, 'cancelled', '重新加入不恢復');

  // ---------- 5) 申請人升為工作區管理員：申請保留待審核；降回成員也保留 ----------
  ok(await call(boss.token, `/api/participants/${wang.id}/workspace-role`, 'PUT', { role: 'admin' }), '王小美升為工作區管理員');
  assert.equal((await stateOf(keep.id)).state, 'pending', '升為管理員：申請保留待審核');
  ok(await call(boss.token, `/api/participants/${wang.id}/workspace-role`, 'PUT', { role: 'member' }), '王小美降回成員');
  assert.equal((await stateOf(keep.id)).state, 'pending', '降回成員：申請保留待審核');

  // ---------- 6) 最後一位管理員保護讓操作失敗：不取消任何申請 ----------
  // 王小美是工作區管理員、有待審申請；移出她的那一批送出前，林志明（另一位工作區管理員）剛好被王小美降為成員 → 移出 409，申請照舊待審
  {
    ok(await call(boss.token, `/api/participants/${wang.id}/workspace-role`, 'PUT', { role: 'admin' }), '王小美再升為工作區管理員');
    const wangS = await adminSession(call, wang.token);
    wang.token = wangS.token;
    const ann = await join('安娜');
    ok(await call(boss.token, `/api/participants/${ann.id}/platform-role`, 'PUT', { role: 'admin' }), '安娜升為平台管理員（不是工作區管理員）');
    const annS = await adminSession(call, ann.token);
    ann.token = annS.token;
    hooks.before = { re: /SET workspace_status = 'removed'/, run: async () => { ok(await call(wang.token, `/api/participants/${boss.id}/workspace-role`, 'PUT', { role: 'member' }), '林志明剛好被降為成員'); } };
    const auditN = await count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member.remove'");
    is(await call(ann.token, `/api/participants/${wang.id}/remove`, 'POST'), 409, 'LAST_WORKSPACE_ADMIN', '移出最後一位工作區管理員');
    assert.equal(hooks.before, null, '真的有交錯');
    assert.equal((await stateOf(keep.id)).state, 'pending', '操作失敗：申請不取消');
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member.remove'"), auditN, '操作失敗：不寫稽核');
    // 停用最後一位工作區管理員：409，申請照舊待審
    is(await call(ann.token, `/api/participants/${wang.id}/disable`, 'POST'), 409, 'LAST_WORKSPACE_ADMIN', '停用最後一位工作區管理員');
    assert.equal((await stateOf(keep.id)).state, 'pending', '停用失敗：申請不取消');
    // 自己離開（最後一位工作區管理員）：409，申請照舊待審
    is(await call(wang.token, '/api/leave', 'POST'), 409, 'LAST_WORKSPACE_ADMIN', '最後一位工作區管理員離開');
    assert.equal((await stateOf(keep.id)).state, 'pending', '離開失敗：申請不取消');
    ok(await call(wang.token, `/api/participants/${boss.id}/workspace-role`, 'PUT', { role: 'admin' }), '林志明升回工作區管理員');
  }

  // ---------- 7) 還原備份中：移出、離開、停用、恢復、升降管理員在交易內被擋（503 RESTORING），什麼都沒寫、不取消 ----------
  {
    const gus = await join('古斯'), hal = await join('哈爾');
    const gReq = await submit(gus, '古斯的申請');
    ok(await call(boss.token, `/api/participants/${hal.id}/disable`, 'POST'), '先停用哈爾（之後測恢復）');
    const snapshot = async () => JSON.stringify([await db.all('SELECT id, status, workspace_status, workspace_role FROM participants ORDER BY id'), await db.all('SELECT id, state FROM project_creation_requests ORDER BY id'),
      await count(db, 'SELECT COUNT(*) AS n FROM audit_log'), await db.all('SELECT id, platform_role, status FROM accounts ORDER BY id')]);
    await db.run("INSERT INTO app_settings (key, value) VALUES ('restore_state', ?)", JSON.stringify({ by: 'someone', at: new Date().toISOString() }));
    try {
      const before = await snapshot();
      const blocked = [
        ['移出', () => call(boss.token, `/api/participants/${gus.id}/remove`, 'POST')],
        ['停用', () => call(boss.token, `/api/participants/${gus.id}/disable`, 'POST')],
        ['恢復', () => call(boss.token, `/api/participants/${hal.id}/enable`, 'POST')],
        ['升為工作區管理員', () => call(boss.token, `/api/participants/${gus.id}/workspace-role`, 'PUT', { role: 'admin' })],
        ['降為成員', () => call(boss.token, `/api/participants/${wang.id}/workspace-role`, 'PUT', { role: 'member' })],
        ['升為平台管理員', () => call(boss.token, `/api/participants/${gus.id}/platform-role`, 'PUT', { role: 'admin' })],
        ['離開', () => call(gus.token, '/api/leave', 'POST')],
      ];
      for (const [label, run] of blocked) is(await run(), 503, 'RESTORING', `還原中：${label}`);
      assert.equal(await snapshot(), before, '還原中：什麼都沒寫');
      assert.equal((await stateOf(gReq.id)).state, 'pending', '還原中：不取消');
    } finally { await db.run("DELETE FROM app_settings WHERE key = 'restore_state'"); }
    assert.equal(ok(await call(boss.token, `/api/participants/${gus.id}/remove`, 'POST'), '還原完成後移出').cancelledProjectCreationRequests, 1, '還原完成後照常');
  }

  // ---------- 8) 申請資料表還沒建立（程式先部署）：政策切換、預覽、移出、停用、離開照常 ----------
  {
    const db2 = await openTestDb(path.join(dataDir, 'nopcr', 'switch.db'));
    dbs.push(db2);
    const { call: c2 } = harness(db2);
    const j2 = async name => { const b = (await c2(null, '/api/join', 'POST', { name, role: 'PG' })).body; return { ...b, id: b.participant.participantId }; };
    const b2 = await j2('林志明'), m2 = await j2('陳大文'), n2 = await j2('王小美'), o2 = await j2('丹尼');
    b2.token = (await adminSession(c2, b2.token)).token;
    ok(await c2(b2.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策設成 approval');
    await db2.run('DROP TABLE project_creation_requests');
    assert.deepEqual(ok(await c2(b2.token, '/api/workspace/settings/create-projects-preview'), '預覽'), { createProjects: 'approval', pendingProjectCreationRequests: 0 });
    assert.equal(ok(await c2(b2.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }), '切走 approval').cancelledProjectCreationRequests, 0);
    assert.equal((await db2.get("SELECT detail FROM audit_log WHERE action = 'workspace_policy.update' ORDER BY seq DESC LIMIT 1")).detail, JSON.stringify({ field: 'createProjects', from: 'approval', to: 'admins' }), '稽核照舊');
    assert.equal(ok(await c2(b2.token, `/api/participants/${m2.id}/remove`, 'POST'), '移出').cancelledProjectCreationRequests, 0);
    assert.equal(ok(await c2(b2.token, `/api/participants/${n2.id}/disable`, 'POST'), '停用').cancelledProjectCreationRequests, 0);
    assert.equal(ok(await c2(o2.token, '/api/leave', 'POST'), '離開').cancelledProjectCreationRequests, 0);
  }

  console.log('建立專案申請的自動取消測試通過');
} finally {
  for (const db of dbs) await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
