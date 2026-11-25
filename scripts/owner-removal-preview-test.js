// 驗收測試：把人移出專案時，他的 AI 也一起移出、AI 負責的未結案卡退回待處理；
// 移出前的預覽（dryRun）就要列出這些 AI 的卡，管理員確認前就看得到
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/owner-removal-preview-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { addToProject, removeFromProject, listProjectMembers } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ownrm-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const A = '預設專案', B = '第二專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };

try {
  const boss = ok(await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' }), '第一位');
  const chen = ok(await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' }), '陳昭宇');
  const Cn = chen.participant.participantId;
  ok(await addToProject(call, boss.token, A, Cn), '加入預設專案');
  ok(await addToProject(call, boss.token, B, Cn), '加入第二專案');
  const ai = ok(await call(chen.token, '/api/my-ais', 'POST', { projects: [A, B], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S }), '建 AI');
  const mine = ok(await call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: A, title: '陳的卡', ownerId: Cn }), '陳昭宇的卡');
  const aiCard = ok(await call(boss.token, '/api/cards', 'POST', { requestId: 'c2', project: A, title: 'AI 的卡', ownerId: ai.participantId }), 'AI 的卡');
  const other = ok(await call(boss.token, '/api/cards', 'POST', { requestId: 'c3', project: B, title: 'AI 在第二專案的卡', ownerId: ai.participantId }), 'AI 在別的專案的卡');

  const dry = ok(await removeFromProject(call, boss.token, A, Cn, { dryRun: true }), '預覽');
  assert.deepEqual([...dry.returnedCards].sort(), [mine.cardId, aiCard.cardId].sort(), '預覽列出他和他的 AI 在這個專案要退回的卡（不含別的專案）');
  assert.deepEqual(dry.ais, [{ participantId: ai.participantId, name: '陳的PG', returnedCards: [aiCard.cardId] }], '預覽分開列出跟著移出的 AI 與它的卡');
  assert.ok((await listProjectMembers(call, boss.token, A)).body.members.some(m => m.participantId === ai.participantId), '預覽不改資料');

  const done = ok(await removeFromProject(call, boss.token, A, Cn), '移出');
  assert.deepEqual([...done.returnedCards].sort(), [mine.cardId, aiCard.cardId].sort(), '實際退回的卡跟預覽一樣');
  const card = ok(await call(boss.token, `/api/cards/${aiCard.cardId}`), 'AI 的卡');
  assert.equal(card.owner?.participantId ?? null, null, 'AI 的卡改為未指派');
  assert.equal(card.status, '待處理', 'AI 的卡退回待處理');
  assert.ok(!(await listProjectMembers(call, boss.token, A)).body.members.some(m => m.participantId === ai.participantId), 'AI 也移出了');
  assert.equal(ok(await call(boss.token, `/api/cards/${other.cardId}`), '別的專案的卡').owner?.participantId, ai.participantId, '別的專案的卡不動');
  console.log('owner-removal-preview-test：全部通過');
} catch (e) {
  console.error('owner-removal-preview-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
