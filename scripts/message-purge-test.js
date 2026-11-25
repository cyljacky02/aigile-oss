// 訊息永久清除（詞彙見 GLOSSARY「刪除與稽核」；決策見 docs/adr/0003）
// A. 可復原期到期前排程不動；到期後由排程入口（runScheduled，跟附件到期清除同一處）永久清除
// B. 清除後：內文、附件本體與附件列都消失（下載 404、備份裡也沒有）；佔位（id、作者、時間、刪除者）留著，
//    回覆串、卡片關聯、決策結果的參照不斷
// C. 永久清除後不能復原（作者、管理員都是 RECOVERY_EXPIRED）
// D. 每次清除寫稽核紀錄 message.purge（排程的操作者是系統，附數量，不含原文）；附件寫進檔案稽核 purge
// E. 每次處理有上限，沒處理完的下次繼續
// F. 可復原期 0 天：刪除當下就永久清除（同樣清掉附件、寫稽核紀錄）
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/message-purge-test.js
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
import { testToken } from './test-token.js';

const PJ = '預設專案';
const GONE = '（此訊息已刪除）';
const BATCH = 2; // 測試把每次上限調小，才看得到「下次繼續」
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-msgpurge-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', purgeBatch: String(BATCH) } });
  const call = async (token, p, method = 'GET', body, raw = false) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 下載是檔案內容 */ }
    return { status: r.status, body: json, text };
  };
  const code = r => `${r.status} ${r.body?.error?.code || ''}`;
  let rq = 0;
  const post = async (token, text, extra = {}) => {
    const r = await call(token, '/api/messages', 'POST', { project: PJ, text, requestId: 'rq' + ++rq, ...extra });
    assert.ok(r.status === 201 || r.status === 200, '發訊息：' + JSON.stringify(r.body));
    return r.body;
  };
  const del = (token, id) => call(token, `/api/messages/${id}`, 'DELETE');
  const restore = (token, id) => call(token, `/api/messages/${id}/restore`, 'POST');
  const read = async (token, id) => (await call(token, `/api/messages/${id}`)).body;
  const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
  const upload = async (token, name, n) => (await call(token, `/api/files?${new URLSearchParams({ name, declared: 'true', project: PJ, post: 'false' })}`, 'POST', png(n), true)).body.file.fileId;
  // 模擬時間經過：把預計永久清除時間改到過去（比照私訊測試處理過期提案的做法）
  const expire = ids => db.run('UPDATE messages SET purge_at = ? WHERE id IN (SELECT value FROM json_each(?))', new Date(Date.now() - 60_000).toISOString(), JSON.stringify(ids));
  const run = async () => (await app.runScheduled()).purged.messages;

  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 平台管理員＋工作區管理員
  const WANG = wang.participant.participantId;
  const boss = await adminSession(call, wang.token);
  const join = async (name, role) => {
    const b = (await call(null, '/api/join', 'POST', { name, role })).body;
    assert.equal((await call(boss.token, `/api/participants/${b.participant.participantId}/projects`, 'PUT', { projects: [PJ] })).status, 200, `${name} 加進預設專案`);
    return { token: b.token, id: b.participant.participantId, name };
  };
  const chen = await join('陳大文', 'PG');
  const lin = await join('林工作', 'SM');
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '陳大文的助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const chenAi = { id: ai.participantId, token: await testToken(db, ai.participantId) };

  // 備份（平台管理員下載）：一張表的所有列，用來確認內容真的不在資料裡
  const dump = async table => {
    const rows = [];
    for (let after = 0; after !== null;) {
      const r = await call(boss.token, `/api/admin/backup/rows?table=${table}&files=1&after=${after}`);
      assert.equal(r.status, 200, `備份 ${table}：` + JSON.stringify(r.body));
      rows.push(...r.body.rows);
      after = r.body.next;
    }
    return rows;
  };
  const inBackup = async needle => JSON.stringify(await dump('messages')).includes(needle);
  const purgeLogs = async () => (await call(boss.token, '/api/audit-log?action=message.purge&limit=200')).body.items;

  // ---------- 準備：有附件、被回覆、掛在卡片上的訊息；被標「已處理」的 [需確認] ----------
  const card = (await call(boss.token, '/api/cards', 'POST', { requestId: 'card1', project: PJ, title: '修登入頁', ownerId: chenAi.id, status: '待處理' })).body;
  assert.ok(card.cardId, '建卡：' + JSON.stringify(card));
  const f1 = await upload(chen.token, '密碼截圖.png', 7), f2 = await upload(chen.token, '第二張.png', 8);
  const secret = await post(chen.token, '秘密字串 ZQX 請看附件', { recipientIds: [lin.id], fileIds: [f1, f2], cardId: card.cardId });
  const reply = await post(lin.token, '收到', { replyToMessageId: secret.messageId });
  const ask = await post(chen.token, '[需確認] 要不要換掉 ZQY？', { recipientIds: [WANG], replyFrom: [WANG] });
  assert.equal((await call(wang.token, `/api/decisions/${ask.messageId}/resolve`, 'POST')).status, 200, '王小美把 [需確認] 標成已處理');
  const later = await post(chen.token, '還在可復原期 ZQW');
  assert.equal((await call(lin.token, `/api/files/${f1}`)).status, 200, '刪除前附件下載得到');
  for (const m of [secret, ask, later]) assert.equal((await del(chen.token, m.messageId)).status, 200, '作者刪自己的訊息');

  // ---------- A 到期前排程不動 ----------
  assert.equal(await run(), 0, 'A 還在可復原期：排程不清除');
  assert.ok(await inBackup('ZQX'), 'A 可復原期內內文還在（備份裡有）');
  assert.equal((await purgeLogs()).length, 0, 'A 沒清除就不寫稽核紀錄');

  // ---------- A/B 到期後排程清除 ----------
  await expire([secret.messageId, ask.messageId]);
  assert.equal(await run(), 2, 'A 到期的兩則被永久清除');
  let x = await read(chen.token, secret.messageId);
  assert.deepEqual([x.text, x.deleted, x.purged, x.author.participantId, x.createdAt, x.deletedBy?.participantId, typeof x.deletedAt], [GONE, true, true, chen.id, secret.createdAt, chen.id, 'string'],
    'B 佔位留著（作者、時間、刪除者）：' + JSON.stringify(x));
  assert.deepEqual(x.file, { fileId: f1, available: false }, 'B 附件只剩 id，不可用');
  assert.equal(code(await call(lin.token, `/api/files/${f1}`)), '404 NOT_FOUND', 'B 附件本體與附件列消失：下載 404');
  assert.equal(code(await call(lin.token, `/api/files/${f2}`)), '404 NOT_FOUND', 'B 同一則的第二個附件也消失');
  assert.ok(!(await inBackup('ZQX')), 'B 內文從資料裡消失（備份裡沒有）');
  assert.ok(!(await inBackup('ZQY')), 'B [需確認] 的內文也消失');
  assert.ok(await inBackup('ZQW'), 'B 還沒到期的不動');
  const files = await dump('files'), chunks = await dump('file_chunks');
  assert.ok(!files.some(f => [f1, f2].includes(f.id)), 'B 附件列消失（備份裡沒有）');
  assert.ok(!chunks.some(c => [f1, f2].includes(c.file_id)), 'B 附件本體消失（備份裡沒有）');
  assert.equal((await read(lin.token, reply.messageId)).replyToMessageId, secret.messageId, 'B 回覆串的參照不斷');
  const around = (await call(lin.token, `/api/messages/${reply.messageId}/around?n=5`)).body.items;
  assert.equal(around.find(m => m.messageId === secret.messageId)?.purged, true, 'B 前後文裡是清除後的佔位');
  assert.ok((await call(chen.token, `/api/cards/${card.cardId}`)).body.messageIds.includes(secret.messageId), 'B 卡片關聯還在');
  x = await read(wang.token, ask.messageId);
  assert.deepEqual([x.text, x.purged, x.resolution?.by?.participantId], [GONE, true, WANG], 'B 決策結果的參照不斷：' + JSON.stringify(x));
  x = await read(chenAi.token, secret.messageId);
  assert.deepEqual([x.text, x.deleted, x.purged], [GONE, true, undefined], 'B AI 讀到的形狀照舊（只有 deleted）');

  // ---------- C 不能復原 ----------
  assert.equal(code(await restore(chen.token, secret.messageId)), '409 RECOVERY_EXPIRED', 'C 作者不能復原已永久清除的');
  assert.equal(code(await restore(boss.token, secret.messageId)), '409 RECOVERY_EXPIRED', 'C 管理員也不能');

  // ---------- D 稽核紀錄 ----------
  let logs = await purgeLogs();
  assert.equal(logs.length, 1, 'D 一次清除一筆稽核紀錄：' + JSON.stringify(logs));
  assert.deepEqual([logs[0].actor.id, logs[0].actor.kind, logs[0].actor.name, logs[0].count, logs[0].scope.kind, logs[0].scope.projectId], ['system', 'system', '系統', 2, 'project', PJ], 'D 操作者是系統、附數量：' + JSON.stringify(logs[0]));
  assert.deepEqual([...logs[0].detail.messageIds].sort(), [secret.messageId, ask.messageId].sort(), 'D 記下清除了哪幾則');
  assert.ok(!/ZQ[XY]|密碼截圖/.test(JSON.stringify(logs)), 'D 稽核紀錄不含原文與檔名');
  const fa = (await call(boss.token, '/api/files/audit?limit=500')).body.items.filter(a => a.action === 'purge');
  assert.deepEqual(fa.map(a => a.fileId).sort(), [f1, f2].sort(), 'D 附件清除寫進檔案稽核：' + JSON.stringify(fa));
  assert.ok(fa.every(a => a.actor.memberType === 'system'), 'D 檔案稽核的操作者是系統：' + JSON.stringify(fa[0]));
  assert.equal(await run(), 0, 'D 再跑一次沒有要清的');
  assert.equal((await purgeLogs()).length, 1, 'D 沒清除就不再寫');

  // ---------- E 每次有上限，沒處理完的下次繼續 ----------
  const many = [];
  for (let i = 0; i < BATCH + 1; i++) many.push(await post(chen.token, `批次 ZQB${i}`));
  for (const m of many) assert.equal((await del(boss.token, m.messageId)).status, 200, "管理員刪");
  await expire(many.map(m => m.messageId));
  assert.equal(await run(), BATCH, 'E 第一次只清上限那麼多');
  assert.equal(await run(), 1, 'E 剩下的下次繼續');
  assert.equal(await run(), 0, 'E 清完了');
  assert.ok(!(await inBackup('ZQB')), 'E 全部清掉');
  logs = await purgeLogs();
  assert.deepEqual(logs.slice(0, 2).map(l => l.count).sort(), [1, BATCH], 'E 每次一筆稽核紀錄');

  // ---------- F 可復原期 0 天：刪除當下就清除 ----------
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: 0 })).status, 200, '可復原期改 0 天');
  const f0 = await upload(chen.token, '馬上清.png', 9);
  const now0 = await post(chen.token, '馬上清掉 ZQ0', { fileIds: [f0] });
  x = (await del(chen.token, now0.messageId)).body.message;
  assert.deepEqual([x.text, x.deleted, x.purged], [GONE, true, true], 'F 0 天：刪除當下永久清除');
  assert.equal(code(await call(lin.token, `/api/files/${f0}`)), '404 NOT_FOUND', 'F 附件也當下消失');
  assert.ok(!(await inBackup('ZQ0')), 'F 內文當下消失');
  assert.equal(code(await restore(chen.token, now0.messageId)), '409 RECOVERY_EXPIRED', 'F 不能復原');
  const zero = (await purgeLogs()).find(l => l.detail?.messageIds?.includes(now0.messageId));
  assert.deepEqual([zero?.count, zero?.actor.id], [1, chen.id], 'F 寫稽核紀錄（操作者是刪除的人）：' + JSON.stringify(zero));
  assert.equal(await run(), 0, 'F 排程沒有剩下要清的');
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: null })).status, 200, '改回跟平台預設');

  console.log('message-purge-test：全部通過');
} finally {
  await db?.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
