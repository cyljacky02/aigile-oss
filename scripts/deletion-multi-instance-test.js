// 刪除在另一份程式（Cloudflare 同時跑好幾份、各有自己的快取）也馬上看得到（docs/adr/0003）
// A. 團隊狀態：另一份程式剛算好、還在快取裡的團隊狀態，訊息被刪後不再露出它的標題（給人與 AI 都一樣）
// B. 專案清單：另一份程式剛讀過專案清單（快取 60 秒），專案被刪後那份程式馬上當它不存在（訊息 404、專案清單沒有）；復原後馬上回來
// C. 團隊狀態重算時，可復原期內的專案裡的訊息也不算（不會變成成員的目前狀態）
// 修正前：A、B 要等快取過期（團隊狀態 180 秒、專案 60 秒）；C 只排除被刪的訊息、沒排除被刪的專案
// 兩份程式＝同一個資料庫各建一個 createApp。SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/deletion-multi-instance-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { appCaller } from './test-call.js';
import { testToken } from './test-token.js';

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-delmulti-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  const mk = () => createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '600000' } });
  const a = appCaller(mk()), b = appCaller(mk()); // 兩份程式
  const owner = (await a(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const boss = await adminSession(a, owner.token);
  const chen = (await a(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;
  const ai = (await a(owner.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = await testToken(db, ai.participantId);
  let rq = 0;
  const post = async (token, project, text) => (await a(token, '/api/messages', 'POST', { project, text, requestId: 'rq' + ++rq })).body;
  const titleOf = async (call, token) => (await call(token, '/api/team-status')).body.members.find(m => m.participantId === CHEN)?.status?.title ?? null;

  // ---------- A 團隊狀態快取 ----------
  assert.equal((await a(boss.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] })).status, 200);
  const m = await post(chen.token, PJ, '[接單] 機密的工作標題');
  assert.equal(await titleOf(b, owner.token), '機密的工作標題', 'A 另一份程式的團隊狀態（人）有這個標題');
  assert.equal(await titleOf(b, aiTok), '機密的工作標題', 'A 另一份程式的團隊狀態（AI）有這個標題');
  assert.equal((await a(chen.token, `/api/messages/${m.messageId}`, 'DELETE')).status, 200, '刪除');
  assert.notEqual(await titleOf(b, owner.token), '機密的工作標題', 'A 刪除後另一份程式的團隊狀態（人）不再露出');
  assert.notEqual(await titleOf(b, aiTok), '機密的工作標題', 'A 刪除後另一份程式的團隊狀態（AI）不再露出');

  // ---------- B 專案快取 ----------
  const pid = (await a(boss.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL' })).body.items.find(p => p.name === '要刪的專案').id;
  const enc = encodeURIComponent(pid);
  assert.equal((await a(boss.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ, pid] })).status, 200);
  const inDel = await post(chen.token, pid, '[接單] 要刪的專案裡的工作');
  assert.equal((await b(owner.token, `/api/messages/${inDel.messageId}`)).status, 200, 'B 刪除前另一份程式讀得到');
  assert.ok((await b(owner.token, '/api/projects')).body.items.some(p => p.id === pid), 'B 刪除前另一份程式的專案清單有它');
  assert.equal((await a(boss.token, `/api/projects/${enc}/archive`, 'POST')).status, 200, '封存');
  assert.equal((await a(boss.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: '要刪的專案' })).status, 200, '刪除專案');
  assert.equal((await b(owner.token, `/api/messages/${inDel.messageId}`)).status, 404, 'B 刪除後另一份程式馬上讀不到');
  assert.ok(!(await b(owner.token, '/api/projects')).body.items.some(p => p.id === pid), 'B 刪除後另一份程式的專案清單沒有它');

  // ---------- C 團隊狀態重算時不算被刪的專案 ----------
  assert.notEqual(await titleOf(b, owner.token), '要刪的專案裡的工作', 'C 另一份程式：團隊狀態不露出被刪專案裡的訊息');
  const c = appCaller(createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } }));
  assert.notEqual(await titleOf(c, owner.token), '要刪的專案裡的工作', 'C 剛啟動的程式重算：團隊狀態不露出被刪專案裡的訊息');
  assert.notEqual(await titleOf(c, aiTok), '要刪的專案裡的工作', 'C 給 AI 的也一樣');

  // B 復原後另一份程式馬上看得到
  assert.equal((await a(boss.token, `/api/projects/${enc}/restore`, 'POST')).status, 200, '復原');
  assert.equal((await b(owner.token, `/api/messages/${inDel.messageId}`)).status, 200, 'B 復原後另一份程式馬上讀得到');
  console.log('deletion-multi-instance-test：全部通過');
} catch (e) {
  console.error('deletion-multi-instance-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await db?.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
