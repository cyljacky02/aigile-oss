// 驗收測試：平台管理員、移出工作區與停用帳號（詞彙見 GLOSSARY「成員與權限」）
// 1. 平台管理員可以有多位：平台管理員能升降平台管理員；最後一位受保護；工作區管理員、一般成員、AI 都不能升降
// 2. 平台管理員對工作區有隱含的工作區管理權（不是工作區管理員、甚至被移出工作區也一樣）；participant 回傳 platformRole
// 3. 停用／恢復帳號、已停用清單、平台設定、備份與還原只有平台管理員
// 4. 工作區管理員能把人移出工作區：進不來、歷史紀錄的名字還在；帳號沒停用
// 5. 停用帳號後不能登入，恢復後可以
// 6. 擁有者被移出工作區或帳號被停用時，他的 AI 的 Token 失效
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/platform-admin-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-platadmin-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const A = '預設專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const setPlat = (tok, id, role) => call(tok, `/api/participants/${id}/platform-role`, 'PUT', { role });
const setWs = (tok, id, role) => call(tok, `/api/participants/${id}/workspace-role`, 'PUT', { role });
const me = async tok => (await call(tok, '/api/me')).body;
const join = async (name, role, extra = {}) => (await call(null, '/api/join', 'POST', { name, role, ...extra })).body;

try {
  const boss = await join('林志明', 'PO'); // 第一位＝平台管理員＋工作區管理員
  const chen = await join('陳昭宇', 'PG');
  const wang = await join('王小美', 'QA');
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  boss.token = (await adminSession(call, boss.token)).token; // 任免管理員、停用帳號是敏感操作：用設了密碼、剛再驗證過的裝置登入
  for (const id of [Cn, Wg]) assert.equal((await call(boss.token, `/api/participants/${id}/projects`, 'PUT', { projects: [A] })).status, 200);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S })).body;

  // ---- 回傳的平台角色 ----
  assert.equal((await me(boss.token)).platformRole, 'admin', '第一位是平台管理員');
  assert.equal((await me(chen.token)).platformRole, 'none', '之後加入的不是');
  assert.equal((await me(ai.token)).platformRole, 'none', 'AI 沒有平台角色');
  assert.equal((await call(boss.token, '/api/participants')).body.items.find(p => p.participantId === Bo).platformRole, 'admin', '名單也帶 platformRole');
  console.log('✓ participant 回傳 platformRole');

  // ---- 最後一位平台管理員 ----
  const last = await setPlat(boss.token, Bo, 'none');
  assert.equal(last.status, 409, JSON.stringify(last.body));
  assert.equal(code(last), 'LAST_PLATFORM_ADMIN', '降級最後一位平台管理員回錯誤');
  assert.equal((await me(boss.token)).platformRole, 'admin', '擋下後還是平台管理員');
  console.log('✓ 最後一位平台管理員受保護');

  // ---- 工作區管理員不是平台管理員：不能升降平台管理員、不能停用帳號、不能用平台設定與備份 ----
  assert.equal((await setWs(boss.token, Cn, 'admin')).status, 200, '陳昭宇升為工作區管理員');
  const c1 = await me(chen.token);
  assert.deepEqual([c1.workspaceRole, c1.platformRole], ['admin', 'none'], '工作區管理員不等於平台管理員');
  for (const [tok, who] of [[chen.token, '工作區管理員'], [wang.token, '一般成員'], [ai.token, 'AI']]) {
    assert.equal(code(await setPlat(tok, Wg, 'admin')), 'NOT_ADMIN', `${who}不能升平台管理員`);
    assert.equal(code(await setPlat(tok, Bo, 'none')), 'NOT_ADMIN', `${who}不能降平台管理員`);
    assert.equal(code(await call(tok, `/api/participants/${Wg}/disable`, 'POST')), 'NOT_ADMIN', `${who}不能停用帳號`);
    assert.equal(code(await call(tok, '/api/participants/disabled')), 'NOT_ADMIN', `${who}不能看已停用的帳號`);
    assert.equal(code(await call(tok, '/api/platform/settings')), 'NOT_ADMIN', `${who}不能看平台設定`);
    assert.equal(code(await call(tok, '/api/platform/settings', 'PUT', { fileTtlHours: 6 })), 'NOT_ADMIN', `${who}不能改平台設定`);
    assert.equal(code(await call(tok, '/api/admin/backup/status')), tok === ai.token ? 'FORBIDDEN' : 'NOT_ADMIN', `${who}不能用備份`);
    assert.notEqual((await call(tok, '/api/admin/restore/begin', 'POST', {})).status, 200, `${who}不能還原`);
  }
  assert.equal((await call(chen.token, '/api/workspace/settings')).status, 200, '工作區管理員照舊能用工作區設定');
  assert.equal((await setPlat(boss.token, ai.participantId, 'admin')).status, 404, 'AI 不能當平台管理員');
  assert.equal((await setPlat(boss.token, 'p_nobody', 'admin')).status, 404, '找不到的人');
  assert.equal(code(await setPlat(boss.token, Wg, 'owner')), 'INVALID_REQUEST', 'role 只能是 admin 或 none');
  console.log('✓ 非平台管理員不能升降平台管理員、停用帳號、用平台設定與備份還原');

  // ---- 升別人為平台管理員：不是工作區管理員也有工作區管理權 ----
  const up = await setPlat(boss.token, Wg, 'admin');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.participant.platformRole, 'admin');
  wang.token = (await adminSession(call, wang.token)).token; // 接著要任免平台管理員：換成剛再驗證過的裝置登入
  const w1 = await me(wang.token);
  assert.deepEqual([w1.platformRole, w1.workspaceRole, w1.isAdmin], ['admin', 'member', true], '平台管理員：明確的工作區角色仍是成員，isAdmin（含隱含）是 true');
  assert.equal((await call(wang.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' })).status, 200, '平台管理員能改工作區設定');
  assert.equal((await call(wang.token, '/api/invites', 'POST', { name: '新人甲', projects: [A] })).status, 201, '平台管理員能發邀請');
  assert.equal((await call(wang.token, '/api/platform/settings')).status, 200, '新的平台管理員能用平台設定');
  assert.ok((await me(wang.token)).projects.includes('第二專案'), '平台管理員看得到沒加入的專案（隱含權限）');
  assert.equal((await setPlat(wang.token, Wg, 'admin')).status, 200, '已經是平台管理員再升一次：不變');
  console.log('✓ 平台管理員有隱含的工作區管理權');

  // ---- 先升別人、再降自己 ----
  const down = await setPlat(wang.token, Bo, 'none');
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal((await me(boss.token)).platformRole, 'none', '林志明不再是平台管理員');
  assert.equal(code(await call(boss.token, '/api/participants/disabled')), 'NOT_ADMIN', '降級後不能看已停用帳號');
  assert.equal((await call(boss.token, '/api/workspace/settings')).status, 200, '但他還是工作區管理員');
  assert.equal(code(await setPlat(wang.token, Wg, 'none')), 'LAST_PLATFORM_ADMIN', '現在王小美是最後一位');
  assert.equal((await setPlat(wang.token, Bo, 'admin')).status, 200, '王小美可以把林志明升回來');
  console.log('✓ 先升別人、再降自己');

  // ---- 移出工作區：進不來、他的 AI 失效、歷史紀錄的名字還在、帳號沒停用 ----
  const li = await join('李大同', 'UX', { username: 'li.dt', password: 'pass-word-1', passwordAgain: 'pass-word-1' });
  const Li = li.participant.participantId;
  assert.equal((await call(chen.token, `/api/participants/${Li}/projects`, 'PUT', { projects: [A] })).status, 200);
  const liAi = (await call(li.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'UX', role: '設計', name: '李的UX', ...S })).body;
  assert.equal((await call(li.token, '/api/messages', 'POST', { requestId: 'li-hello', project: A, text: '大家好，我是李大同' })).status, 201);
  const remove = (tok, id) => call(tok, `/api/participants/${id}/remove`, 'POST');
  assert.equal(code(await remove(ai.token, Li)), 'NOT_ADMIN', 'AI 不能把人移出工作區');
  assert.equal(code(await remove(li.token, Cn)), 'NOT_ADMIN', '一般成員不能把人移出工作區');
  assert.equal(code(await remove(chen.token, Cn)), 'SELF', '不能把自己移出');
  assert.equal(code(await remove(chen.token, Wg)), 'CANNOT_MANAGE_ADMIN', '工作區管理員不能移出平台管理員');
  // 重設登入也一樣：工作區管理員不能拿到平台管理員的登入連結（不能動對方的上層管理權）
  const reset = (tok, id) => call(tok, `/api/participants/${id}/reset-login`, 'POST', {});
  const rs = await reset(chen.token, Wg);
  assert.equal(rs.status, 403, JSON.stringify(rs.body));
  assert.equal(code(rs), 'CANNOT_MANAGE_ADMIN', '工作區管理員不能重設平台管理員的登入');
  assert.ok(!JSON.stringify(rs.body).includes('/invite/'), '沒有拿到連結');
  assert.equal((await me(wang.token)).platformRole, 'admin', '王小美的登入照舊');
  const rsOk = await reset(wang.token, Bo);
  assert.equal(rsOk.status, 200, '平台管理員可以重設另一位平台管理員的登入：' + JSON.stringify(rsOk.body));
  // 重發平台管理員還沒用的重設登入連結也一樣：工作區管理員不能重發，也不能拿到新連結
  const renew = await call(chen.token, `/api/invites/${rsOk.body.invite.id}/regenerate`, 'POST', {});
  assert.equal(renew.status, 403, '工作區管理員不能重發平台管理員的重設登入連結：' + JSON.stringify(renew.body));
  assert.equal(code(renew), 'CANNOT_MANAGE_ADMIN');
  assert.ok(!JSON.stringify(renew.body).includes('/invite/'), '沒有拿到新連結');
  const renewOk = await call(wang.token, `/api/invites/${rsOk.body.invite.id}/regenerate`, 'POST', {});
  assert.equal(renewOk.status, 200, '平台管理員可以重發：' + JSON.stringify(renewOk.body));
  rsOk.body.url = renewOk.body.url;
  boss.token = (await call(null, '/api/auth/invite', 'POST', { token: rsOk.body.url.split('/invite/')[1] })).body.token;
  assert.equal((await me(boss.token)).platformRole, 'admin', '林志明用新連結登入');
  boss.token = (await adminSession(call, boss.token)).token; // 重設登入把密碼清掉了：重設密碼、再驗證
  assert.equal((await remove(chen.token, liAi.participantId)).status, 404, 'AI 不是用這個移出（主人刪掉它）');
  const rm = await remove(chen.token, Li); // 工作區管理員（不是平台管理員）就能移出
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal(rm.body.participant.removed, true);
  assert.equal(rm.body.revokedAiTokens, 1, '他的 AI Token 失效');
  assert.equal((await call(li.token, '/api/me')).status, 401, '移出後進不來');
  assert.equal((await call(liAi.token, '/api/me')).status, 401, '他的 AI 也進不來');
  const relog = await call(null, '/api/auth/password', 'POST', { username: 'li.dt', password: 'pass-word-1' });
  assert.equal(code(relog), 'NOT_WORKSPACE_MEMBER', '帳密還對，但不是工作區成員：登入被擋：' + JSON.stringify(relog.body));
  const hist = (await call(boss.token, `/api/messages?project=${A}`)).body.items.find(m => m.requestId === 'li-hello' || /我是李大同/.test(m.text));
  assert.equal(hist?.author?.name, '李大同', '歷史訊息照樣顯示名字');
  assert.ok(!(await call(boss.token, '/api/participants')).body.items.some(p => p.participantId === Li || p.participantId === liAi.participantId), '成員名單不列移出的人與他的 AI');
  assert.ok(!(await call(boss.token, '/api/participants/disabled')).body.items.some(p => p.participantId === Li), '帳號沒有停用');
  assert.ok(!(await call(boss.token, `/api/projects/${A}/members`)).body.members.some(m => m.participantId === Li), '專案成員資格一併結束');
  assert.equal((await remove(chen.token, Li)).body.alreadyRemoved, true, '再移一次：不變');
  console.log('✓ 移出工作區：進不來、AI 失效、名字還在、帳號沒停用');

  // ---- 最後一位工作區管理員不能被移出 ----
  assert.equal((await setWs(boss.token, Bo, 'member')).status, 200, '林志明降為成員（仍是平台管理員）');
  assert.equal(code(await remove(boss.token, Cn)), 'LAST_WORKSPACE_ADMIN', '陳昭宇是最後一位工作區管理員');
  assert.equal((await setWs(boss.token, Bo, 'admin')).status, 200, '平台管理員可以把自己升回工作區管理員');
  console.log('✓ 最後一位工作區管理員不能被移出');

  // ---- 平台管理員不是工作區成員也有工作區管理權 ----
  assert.equal((await remove(boss.token, Wg)).status, 200, '平台管理員可以把另一位平台管理員移出工作區');
  const w2 = await call(wang.token, '/api/me');
  assert.equal(w2.status, 200, '被移出的平台管理員還能進來');
  assert.deepEqual([w2.body.removed, w2.body.platformRole, w2.body.isAdmin], [true, 'admin', true]);
  assert.equal((await call(wang.token, '/api/workspace/settings', 'PUT', { createProjects: 'members' })).status, 200, '不是工作區成員也能管理工作區');
  assert.equal((await call(wang.token, `/api/projects/${A}/join-settings`, 'PUT', { open: true, note: '' })).status, 200, '也能管理專案');
  assert.ok(!(await call(boss.token, '/api/participants')).body.items.some(p => p.participantId === Wg), '不出現在成員名單');
  assert.equal((await call(boss.token, '/api/projects/第二專案/visibility', 'PUT', { visibility: 'private' })).status, 200, '第二專案設成私人');
  assert.equal((await call(wang.token, '/api/projects/第二專案/members')).status, 200, '平台管理員看得到私人專案（隱含權）');
  assert.equal((await call(chen.token, '/api/projects/第二專案/visibility', 'PUT', { visibility: 'review' })).status, 200, '還原');
  console.log('✓ 平台管理員不是工作區成員也有工作區管理權');

  // ---- 停用帳號：登不進來、AI 失效；恢復後可以登入 ----
  const zhao = await join('趙小安', 'BA', { username: 'zhao.xa', password: 'pass-word-2', passwordAgain: 'pass-word-2' });
  const Zh = zhao.participant.participantId;
  assert.equal((await call(boss.token, `/api/participants/${Zh}/projects`, 'PUT', { projects: [A] })).status, 200);
  const zhAi = (await call(zhao.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'BA', role: '分析', name: '趙的BA', ...S })).body;
  const login = () => call(null, '/api/auth/password', 'POST', { username: 'zhao.xa', password: 'pass-word-2' });
  assert.equal((await login()).status, 200, '停用前可以登入');
  assert.equal(code(await call(chen.token, `/api/participants/${Zh}/disable`, 'POST')), 'NOT_ADMIN', '工作區管理員不能停用帳號');
  const self = await call(boss.token, `/api/participants/${Bo}/disable`, 'POST');
  assert.equal(code(self), 'SELF', '不能停用自己');
  assert.ok(!/交給|管理員交/.test(self.body.error.message) && /工作區管理員/.test(self.body.error.message), '說法照詞彙表（升別人為工作區管理員，不是「把管理員交給別人」）：' + self.body.error.message);
  const dis = await call(boss.token, `/api/participants/${Zh}/disable`, 'POST');
  assert.equal(dis.status, 200, JSON.stringify(dis.body));
  assert.equal(dis.body.revokedAiTokens, 1);
  assert.equal((await call(zhao.token, '/api/me')).status, 401, '停用後進不來');
  assert.equal((await call(zhAi.token, '/api/me')).status, 401, '他的 AI 也進不來');
  assert.equal((await login()).status, 400, '停用後不能登入');
  assert.ok((await call(boss.token, '/api/participants/disabled')).body.items.some(p => p.participantId === Zh), '列在已停用的帳號');
  assert.equal(code(await call(chen.token, `/api/participants/${Zh}/enable`, 'POST')), 'NOT_ADMIN', '工作區管理員不能恢復帳號');
  assert.equal((await call(boss.token, `/api/participants/${Zh}/enable`, 'POST')).status, 200, '平台管理員恢復');
  const back = await login();
  assert.equal(back.status, 200, '恢復後可以登入');
  assert.equal((await call(back.body.token, '/api/me')).body.name, '趙小安');
  assert.equal((await call(zhAi.token, '/api/me')).status, 401, 'AI 舊的 Token 不會復活（主人重發）');
  console.log('✓ 停用帳號後不能登入、恢復後可以');

  // ---- 不能停用最後一位工作區管理員 ----
  assert.equal((await setWs(boss.token, Bo, 'member')).status, 200);
  assert.equal(code(await call(boss.token, `/api/participants/${Cn}/disable`, 'POST')), 'LAST_WORKSPACE_ADMIN', '陳昭宇是最後一位工作區管理員');
  assert.equal((await setWs(boss.token, Bo, 'admin')).status, 200);
  console.log('✓ 不能停用最後一位工作區管理員');

  console.log('platform-admin-test：全部通過');
} catch (e) {
  console.error('platform-admin-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
