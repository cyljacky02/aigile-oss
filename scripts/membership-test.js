// 成員資格模組（src/membership.js）的介面契約：寫入語句執行後，讀取看得到；換資料表（#7）後同一份測試要照樣通過
// 只透過模組介面讀寫；participant 列用 API 建，讀整列交給模組（就像 core.js 從成員快取拿到的那列）
// 用法：node scripts/membership-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { createMembership } from '../src/membership.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-membership-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const A = '預設專案', B = '第二專案';
const PROJECTS = [A, B]; // 未封存的專案（core.js 原地更新同一個陣列）
const m = createMembership({ db, PROJECTS, nowIso: () => new Date().toISOString() });
const row = id => db.get('SELECT * FROM participants WHERE id = ?', id);
const sorted = l => [...l].sort();
const run = stmts => db.batch(stmts);

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PG' })).body.participant.participantId; // 第一位：所有專案
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'QA' })).body.participant.participantId; // 沒有專案
  await m.load(true);

  // 專案歸屬：寫入後讀得到；封存的專案只在 allProjectsOf
  assert.deepEqual(sorted(m.projectsOf(await row(boss))), sorted([A, B]), '第一位在所有專案');
  assert.deepEqual(m.projectsOf(await row(chen)), [], '後來的人沒有專案');
  await run(m.setProjectsStmts(chen, [B, A], new Date().toISOString()));
  await m.load(true);
  assert.deepEqual(sorted(m.projectsOf(await row(chen))), sorted([A, B]), '加入兩個專案');
  PROJECTS.splice(1, 1); // 第二專案封存
  assert.deepEqual(m.projectsOf(await row(chen)), [A], '封存的專案不算目前所屬');
  assert.deepEqual(sorted(m.allProjectsOf(await row(chen))), sorted([A, B]), '含封存的清單還在');
  PROJECTS.push(B);
  await run(m.setProjectsStmts(chen, [], new Date().toISOString()));
  await m.load(true);
  assert.deepEqual(m.allProjectsOf(await row(chen)), [], '可以回到沒有專案');
  // onlyIf：條件不符就不寫（加入群組時「第一位才在所有專案」用）
  await run(m.setProjectsStmts(chen, [A, B], null, { onlyIf: 'is_admin = 1' }));
  await m.load(true);
  assert.deepEqual(m.allProjectsOf(await row(chen)), [], '不是管理員就不寫');
  console.log('✓ 專案歸屬');

  // leader：整份換掉（沒列的專案就沒有 leader）；封存專案的 leader 留著（才能還原），但不算「目前帶的專案」
  // 是專案角色（#7 起存在 project_members）：指定 leader 等於以專案管理員加入；移出專案就沒有角色
  assert.deepEqual(m.leadersOf(A), [], '一開始沒有 leader');
  await run(m.setLeadersStmts({ [A]: [boss], [B]: [boss, chen] }));
  await m.load(true);
  assert.deepEqual(m.leadersOf(A), [boss]);
  assert.deepEqual(sorted(m.leadersOf(B)), sorted([boss, chen]));
  assert.deepEqual(sorted(m.leaderProjectsOf(boss)), sorted([A, B]));
  assert.deepEqual((await m.loadLeaders())[B].length, 2, 'loadLeaders 回整份對照表');
  PROJECTS.splice(1, 1);
  assert.deepEqual(m.leaderProjectsOf(chen), [], '封存專案不算目前帶的');
  assert.deepEqual(sorted(m.leadersOf(B)), sorted([boss, chen]), '封存專案的 leader 還查得到');
  PROJECTS.push(B);
  await run(m.setLeadersStmts({ [A]: [boss] }));
  await m.load(true);
  assert.deepEqual(m.leadersOf(B), [], '沒列的專案就沒有 leader');
  assert.deepEqual(m.allProjectsOf(await row(chen)), [B], '指定 leader 時加入專案；不再是 leader 還是專案成員');
  await run(m.setLeadersStmts({ [B]: [chen] }));
  await run(m.setProjectsStmts(chen, [], null));
  await run(m.setProjectsStmts(chen, [B], null));
  await m.load(true);
  assert.deepEqual(m.leadersOf(B), [], '移出專案就沒有角色（再加入是專案成員）');
  await run(m.setProjectsStmts(chen, [], null));
  await m.load(true);
  console.log('✓ leader');

  // 唯讀：只記人類；他名下的 AI 在那個專案跟著唯讀
  const chenTok = (await call(null, '/api/join', 'POST', { name: '陳小妹', role: 'UX' })).body; // 另一位人類，用來建 AI
  const ux = chenTok.participant.participantId;
  await run(m.setProjectsStmts(ux, [A, B], new Date().toISOString()));
  const ai = (await call(chenTok.token, '/api/my-ais', 'POST', { projects: [A, B], roleKey: 'PG', role: '程式開發', name: '小妹的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body.participantId;
  assert.ok(ai, '建了 AI');
  await m.load(true);
  assert.equal(m.isReadOnly(await row(ux), A), false);
  await m.addReadOnly(ux, [A]);
  await m.load(true);
  assert.equal(m.isReadOnly(await row(ux), A), true, '人類唯讀');
  assert.equal(m.isReadOnly(await row(ux), B), false, '只有那個專案');
  assert.equal(m.isReadOnly(await row(ai), A), true, 'AI 跟著所屬人類唯讀');
  assert.equal(m.isReadOnlyHuman(ux, A), true);
  assert.deepEqual(m.readOnlyProjectsOf(await row(ai)), [A]);
  assert.deepEqual(m.readOnlyOf(A), [ux]);
  await m.addReadOnly(ux, [A, B]);
  await m.load(true);
  assert.deepEqual(m.readOnlyOf(A), [ux], '重複加不會重複記');
  assert.deepEqual(sorted(m.readOnlyProjectsOf(await row(ux))), sorted([A, B]));
  await run(m.setReadOnlyStmts({ [B]: [ux] }));
  await m.load(true);
  assert.deepEqual(m.readOnlyProjectsOf(await row(ux)), [B], '整份換掉');
  console.log('✓ 唯讀');

  // 跨專案角色：先在草稿上改（還沒存就不生效），存了才算；之後加入的 PO 不會自動跨專案
  await m.loadCrossRoles(true);
  assert.equal(m.isCrossRole(await row(boss)), false);
  const draft = m.crossRoles();
  m.setCrossRole(draft, await row(boss), true);
  assert.equal(m.isCrossRole(await row(boss), draft), true, '草稿上開了');
  assert.equal(m.isCrossRole(await row(boss)), false, '還沒存');
  await run(m.setCrossRolesStmts(draft));
  await m.load(true);
  assert.equal(m.isCrossRole(await row(boss)), true, '存了就生效');
  const po = (await call(null, '/api/join', 'POST', { name: '王經理', role: 'PO' })).body.participant.participantId;
  await m.load(true);
  assert.equal(m.isCrossRole(await row(po)), false, '新加入的 PO 不自動跨專案');
  const off = m.crossRoles();
  m.setCrossRole(off, await row(boss), false);
  await run(m.setCrossRolesStmts(off));
  await m.load(true);
  assert.equal(m.isCrossRole(await row(boss)), false, '關掉');
  console.log('✓ 跨專案角色');

  // 直接讀資料庫（不看快取）
  assert.deepEqual(sorted(await m.fetchProjectsOf(ux)), sorted([A, B]));
  assert.deepEqual(sorted((await m.fetchMembersOf(B)).map(x => x.id)), sorted([boss, ux, ai]), '在第二專案的人');
  assert.deepEqual((await m.fetchMembersOf(B)).find(x => x.id === ux).projects.length, 2, '連同各自的專案');
  console.log('✓ 直接讀資料庫');

  // 永久刪除專案：所有人的歸屬、leader、唯讀都拿掉那個專案，別的專案不動
  await run(m.setLeadersStmts({ [A]: [boss], [B]: [boss] }));
  await m.load(true);
  const people = await db.all('SELECT * FROM participants');
  await run(await m.removeProjectStmts(B, people, new Date().toISOString()));
  await m.load(true);
  assert.deepEqual(m.allProjectsOf(await row(ux)), [A]);
  assert.deepEqual(m.allProjectsOf(await row(ai)), [A]);
  assert.deepEqual(m.allProjectsOf(await row(boss)), [A]);
  assert.deepEqual(m.leadersOf(B), [], 'leader 拿掉');
  assert.deepEqual(m.leadersOf(A), [boss], '別的專案的 leader 還在');
  assert.deepEqual(m.readOnlyOf(B), [], '唯讀拿掉');
  assert.deepEqual(await m.fetchMembersOf(B), []);
  console.log('✓ 刪除專案');

  console.log('membership-test：全部通過');
} catch (e) {
  console.error('membership-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
