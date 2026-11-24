// 驗收測試：唯讀成員（專案角色 viewer，以專案為單位）與他的 AI 在該專案只能看、不能寫
// 設定方式：PUT /api/projects/:id/members/:participantId { role: 'viewer' }（#11；舊的成員矩陣已移除）
// 用法：node scripts/readonly-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { addToProject, setProjectRole } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ro-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const msg = (tok, b) => call(tok, '/api/messages', 'POST', { requestId: 'm' + (++n), project: '預設專案', ...b });
const code = r => r.body.error?.code;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const L = boss.participant.participantId, Cn = chen.participant.participantId;
  await call(boss.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['預設專案'] });
  const mkAi = (tok, name) => call(tok, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(r => r.body);
  const pgC = await mkAi(chen.token, '陳的PG');
  await call(boss.token, '/api/projects/預設專案/dm', 'PUT', { on: true });
  const card = (await call(chen.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '陳負責的卡', ownerId: Cn, status: '進行中' })).body;
  const aiCard = (await call(pgC.token, '/api/cards', 'POST', { requestId: 'c2', project: '預設專案', title: 'AI 負責的卡', ownerId: pgC.participantId, status: '進行中' })).body;
  const RO = (tok, id, role, dryRun) => setProjectRole(call, tok, '預設專案', id, role, dryRun ? { dryRun } : {});

  // 設成唯讀成員：先看影響（他和名下 AI 的卡會退回）
  let r = await RO(boss.token, Cn, 'viewer', true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.returnedCards.sort(), [card.cardId, aiCard.cardId].sort(), '先列出會退回的卡');
  assert.equal((await RO(chen.token, L, 'viewer')).status, 403, '專案成員不能設');
  await addToProject(call, boss.token, '預設專案', [L]); // 工作區管理員靠隱含權限，先明確加入才有專案角色可改
  assert.equal(code(await RO(boss.token, L, 'viewer')), 'INVALID_REQUEST', '工作區管理員不能設成唯讀成員');
  assert.equal(code(await RO(boss.token, pgC.participantId, 'viewer')), 'INVALID_REQUEST', 'AI 不能設（跟著所屬人類）');
  r = await RO(boss.token, Cn, 'viewer');
  assert.equal(r.status, 200);
  assert.deepEqual((await call(boss.token, '/api/projects')).body.viewers['預設專案'], [Cn], '專案清單帶唯讀成員');
  const c1 = (await call(boss.token, `/api/cards/${card.cardId}`)).body;
  assert.ok(c1.owner === null && c1.status === '待處理', '他的卡退回待處理、未指派');
  assert.equal((await call(boss.token, `/api/cards/${aiCard.cardId}`)).body.owner, null, '他 AI 的卡也退回');
  assert.deepEqual((await call(chen.token, '/api/me')).body.readOnlyIn, ['預設專案'], '/api/me 帶 readOnlyIn');
  assert.deepEqual((await call(pgC.token, '/api/me')).body.readOnlyIn, ['預設專案'], 'AI 跟著唯讀');

  // 唯讀的人：看得到，寫入一律 403 READ_ONLY
  assert.equal((await call(chen.token, '/api/messages?limit=5')).status, 200, '看得到訊息');
  assert.equal((await call(chen.token, `/api/cards/${card.cardId}`)).status, 200, '看得到卡片');
  assert.equal(code(await msg(chen.token, { text: '我想說話' })), 'READ_ONLY', '不能發訊息');
  assert.equal(code(await msg(chen.token, { text: '回覆', replyToMessageId: (await msg(boss.token, { text: "公告" })).body.messageId })), 'READ_ONLY', '不能回覆');
  assert.equal(code(await call(chen.token, '/api/cards', 'POST', { requestId: 'c3', project: '預設專案', title: 'x' })), 'READ_ONLY', '不能建卡');
  assert.equal(code(await call(chen.token, `/api/cards/${card.cardId}`, 'PATCH', { next: 'x', version: c1.version })), 'READ_ONLY', '不能改卡');
  assert.equal(code(await call(chen.token, `/api/cards/${card.cardId}/handover`, 'POST', { toId: L, version: c1.version, note: 'x' })), 'READ_ONLY', '不能交接');
  assert.equal(code(await call(chen.token, `/api/cards/${card.cardId}/messages`, 'POST', { text: 'x', requestId: 'cm1' })), 'READ_ONLY', '不能在卡上留言');
  assert.equal(code(await call(chen.token, '/api/dm', 'POST', { aiId: pgC.participantId, text: '嗨', requestId: 'd1' })), 'READ_ONLY', '不能私訊');
  assert.equal(code(await call(chen.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '陳的PG2', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })), 'READ_ONLY', '不能在唯讀的專案建 AI');
  const up = await app(new Request(BASE + '/api/files?project=預設專案&name=a.txt&declared=1', { method: 'POST', headers: { Authorization: `Bearer ${chen.token}`, 'Content-Type': 'text/plain' }, body: 'hello' }), BASE);
  assert.equal((await up.json()).error?.code, 'READ_ONLY', '不能上傳');
  assert.equal(code(await msg(pgC.token, { text: 'AI 想說話' })), 'READ_ONLY', '他的 AI 也不能發訊息');
  // 別人那邊：不能 @ 他、不能交給他、不能當決策者；@所有人跳過他
  assert.equal(code(await msg(boss.token, { text: '@陳昭宇 看一下', recipientIds: [Cn] })), 'READ_ONLY_RECIPIENT', '不能 @ 唯讀的人');
  r = await msg(boss.token, { text: '@所有人 公告', audience: 'all' });
  assert.ok(r.status === 201 && !r.body.recipients.some(x => x.participantId === Cn), '@所有人跳過唯讀的人');
  const c2 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c4', project: '預設專案', title: '劉的卡', ownerId: L })).body;
  assert.equal(code(await call(boss.token, `/api/cards/${c2.cardId}/handover`, 'POST', { toId: Cn, version: c2.version, note: 'x' })), 'READ_ONLY_MEMBER', '不能交給唯讀的人');
  assert.equal(code(await call(boss.token, '/api/cards', 'POST', { requestId: 'c5', project: '預設專案', title: '指派給唯讀', ownerId: Cn })), 'READ_ONLY_MEMBER', '不能指派給唯讀的人');
  assert.equal(code(await call(boss.token, '/api/cards', 'POST', { requestId: 'c6', project: '預設專案', type: '決策', title: '要決定', deciderId: Cn, question: 'A 還是 B？', options: ['A', 'B'] })), 'READ_ONLY_MEMBER', '不能當決策者');
  assert.equal((await call(boss.token, '/api/projects/預設專案/members')).body.members.find(m => m.participantId === pgC.participantId).role, 'viewer', '他的 AI 在成員清單也是唯讀成員');

  // 改回專案成員就能發
  await RO(boss.token, Cn, 'member');
  assert.equal((await msg(chen.token, { text: '我回來了' })).status, 201, '改回專案成員就能發訊息');
  assert.deepEqual((await call(chen.token, '/api/me')).body.readOnlyIn, [], '改回專案成員');

  // 邀請時就選唯讀
  r = await call(boss.token, '/api/invites', 'POST', { name: '王唯讀', projects: ['預設專案'], readOnly: ['預設專案'] });
  assert.equal(r.status, 201); assert.deepEqual(r.body.invite.readOnly, ['預設專案'], '邀請帶唯讀');
  assert.equal(code(await call(boss.token, '/api/invites', 'POST', { name: '李錯', projects: ['預設專案'], readOnly: ['第二專案'] })), 'INVALID_REQUEST', '唯讀專案要先勾選');
  const tok = r.body.url.split('/invite/')[1];
  const joined = (await call(null, '/api/auth/invite', 'POST', { token: tok })).body;
  assert.ok(joined.token, '用邀請加入');
  assert.deepEqual((await call(joined.token, '/api/me')).body.readOnlyIn, ['預設專案'], '加入就是唯讀');
  // 唯讀畫面只藏寫入的按鈕；「↩ 名字」是跳到原訊息的連結，要看得到（UX 驗收提醒）
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.ok(/\.ro-here \.composer/.test(css) && /\.ro-here \.cg-reply/.test(css), '唯讀藏輸入框與回覆');
  assert.ok(!/\.ro-here \.gm-re\b/.test(css), '「↩ 名字」連結不藏');
  console.log('readonly-test：全部通過');
} catch (e) {
  console.error('readonly-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
