// 刪除與復原單則訊息（詞彙見 GLOSSARY「協作訊息」「刪除與稽核」；決策見 docs/adr/0003）
// A. 人類作者可以刪自己的訊息；工作區管理員（含平台管理員的隱含權）可以刪任何人的，包括平台管理員與 AI 發的（不受「不能動上層管理員」限制）
// B. 專案管理員、專案成員不能刪別人的；唯讀成員不能刪任何訊息（包括自己以前發的）；AI 一律不能刪（包括自己發的）
// C. 刪除後在單則、列表、前後文、卡片關聯都是佔位：text＝「（此訊息已刪除）」、deleted: true，人類看得到刪除者與時間；
//    附件形狀不變（file、多個檔的 files 照舊在），但 available: false、拿不到內容
// D. 給 AI 的 API 與 MCP（讀單則、歷史、收件匣）形狀不變，只多 deleted；任何 AI 都拿不到原文（管理員名下的 AI 也一樣）
// E. 搜尋找不到被刪的訊息；團隊狀態也不露出原文
// F. 被刪訊息的待處理通知自動確認；復原時不重發
// G. [接單] 訊息被刪，卡片的認領不變
// H. 附件在可復原期內不能下載（MESSAGE_DELETED），照常寫進檔案稽核
// I. 復原：作者復原自己刪的；作者復原管理員刪的回 RESTORE_FORBIDDEN；工作區管理員復原任何被刪的；過了可復原期 RECOVERY_EXPIRED；沒被刪的 NOT_DELETED
// J. 刪除當下依生效的可復原期決定永久清除時間，之後改設定不影響；0 天＝刪除當下就永久清除
// K. 刪除與復原寫稽核紀錄（不存原文）、不發通知；刪除單則訊息不用再驗證身分
// L. 即時通道推送刪除與復原
// M. 已刪除（可復原期內）的專案裡的訊息：刪除、復原都當它不存在（404）；專案復原後照常
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/message-delete-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { adminSession, reauth } from './test-admin.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const PJ = '預設專案';
const GONE = '（此訊息已刪除）';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-msgdel-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  // 即時通道：假的 hub，記下推給誰、什麼事件
  let connected = [];
  const events = [];
  const live = { connectedIds: () => connected, has: id => connected.includes(id), toPeople: (ids, type, data) => { for (const id of ids) events.push({ to: id, type, data }); } };
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), live, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
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

  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const WANG = wang.participant.participantId;
  const boss = await adminSession(call, wang.token);
  const join = async (name, role) => {
    const b = (await call(null, '/api/join', 'POST', { name, role })).body;
    assert.equal((await call(boss.token, `/api/participants/${b.participant.participantId}/projects`, 'PUT', { projects: [PJ] })).status, 200, `${name} 加進預設專案`);
    return { token: b.token, id: b.participant.participantId, name };
  };
  const lin = await join('林工作', 'SM'); // 工作區管理員（不是平台管理員）
  assert.equal((await call(boss.token, `/api/participants/${lin.id}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '林工作升為工作區管理員');
  const chen = await join('陳大文', 'PG'); // 專案成員
  const zhao = await join('趙專案', 'PM'); // 專案管理員
  assert.equal((await call(boss.token, `/api/projects/${encodeURIComponent(PJ)}/members/${zhao.id}`, 'PUT', { role: 'admin' })).status, 200, '趙專案是專案管理員');
  const sun = await join('孫唯讀', 'QA'); // 之後改成唯讀成員
  const mkAi = async (owner, name) => {
    const ai = (await call(owner.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    assert.ok(ai.participantId, '建 AI：' + JSON.stringify(ai));
    return { id: ai.participantId, token: await testToken(db, ai.participantId), name };
  };
  const chenAi = await mkAi(chen, '陳大文的助手');
  const wangAi = await mkAi({ token: wang.token }, '王小美的助手');

  // ---------- A 作者刪自己的訊息 → 單則讀到佔位 ----------
  const m1 = await post(chen.token, '貼錯了：密碼 hunter2');
  let r = await del(chen.token, m1.messageId);
  assert.equal(r.status, 200, 'A 作者能刪自己的訊息：' + JSON.stringify(r.body));
  let x = await read(chen.token, m1.messageId);
  assert.deepEqual([x.text, x.deleted, x.deletedBy?.participantId, x.deletedBy?.name, typeof x.deletedAt], [GONE, true, chen.id, '陳大文', 'string'], 'C 單則讀到佔位、刪除者與時間：' + JSON.stringify(x));
  assert.equal(x.author.participantId, chen.id, 'C 作者照舊');
  assert.equal(code(await del(chen.token, m1.messageId)), '410 MESSAGE_DELETED', 'A 已刪除的不能再刪');

  // ---------- A/B 權限矩陣 ----------
  const byWang = await post(wang.token, '平台管理員的訊息');
  const byAi = await post(chenAi.token, 'AI 發的訊息');
  const byChen = await post(chen.token, '陳大文的訊息');
  const bySun = await post(sun.token, '孫唯讀還是專案成員時發的');
  assert.equal(code(await del(zhao.token, byChen.messageId)), '403 NOT_ADMIN', 'B 專案管理員不能刪別人的');
  assert.equal(code(await del(sun.token, byChen.messageId)), '403 NOT_ADMIN', 'B 專案成員不能刪別人的');
  assert.equal(code(await del(chenAi.token, byAi.messageId)), '403 FORBIDDEN', 'B AI 不能刪自己發的');
  assert.equal(code(await del(wangAi.token, byChen.messageId)), '403 FORBIDDEN', 'B 管理員名下的 AI 也不能刪');
  assert.equal(code(await del(chen.token, byAi.messageId)), '403 NOT_ADMIN', 'B 所屬人類不是作者，不能刪自己 AI 發的');
  assert.equal((await call(boss.token, `/api/projects/${encodeURIComponent(PJ)}/members/${sun.id}`, 'PUT', { role: 'viewer' })).status, 200, '孫唯讀改為唯讀成員');
  assert.equal(code(await del(sun.token, bySun.messageId)), '403 READ_ONLY', 'B 唯讀成員不能刪自己以前發的');
  assert.equal((await read(chen.token, byChen.messageId)).deleted, undefined, 'B 被擋下的沒有刪');
  assert.equal((await del(lin.token, byWang.messageId)).status, 200, 'A 工作區管理員能刪平台管理員的訊息（不受上層管理員限制）');
  assert.equal((await del(lin.token, byAi.messageId)).status, 200, 'A 工作區管理員能刪 AI 發的');
  assert.equal((await del(wang.token, bySun.messageId)).status, 200, 'A 平台管理員（登入碼、沒再驗證）也能刪任何人的：刪除單則訊息不用再驗證');
  assert.equal(code(await del(chen.token, 'msg_nope')), '404 NOT_FOUND', 'A 不存在的訊息 404');
  const cross = await post(chen.token, '跨專案頻道的訊息', { project: 'all' });
  assert.equal((await del(chen.token, cross.messageId)).status, 200, 'A 作者也能刪自己在跨專案頻道發的');

  // ---------- C/D/E/F/G/H 佔位形狀、AI、搜尋、通知、認領、附件 ----------
  let rid = 0;
  const tool = async (token, name, args) => {
    const r = await call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
    try { return JSON.parse(r.body.result.content[0].text); } catch { throw new Error(name + ' ' + r.body.result.content[0].text); }
  };
  const card = (await call(boss.token, '/api/cards', 'POST', { requestId: 'card1', project: PJ, title: '修登入頁', ownerId: chenAi.id, status: '待處理' })).body;
  assert.ok(card.cardId, '建卡：' + JSON.stringify(card));
  const claim = await post(chenAi.token, '[接單] 我來修 秘密字串 ZQX', { cardId: card.cardId });
  const claimOf = async () => (await call(boss.token, `/api/cards/${card.cardId}`)).body.claim?.by?.participantId;
  assert.equal(await claimOf(), chenAi.id, 'G 卡片被認領');
  const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
  const fid = (await call(chen.token, `/api/files?${new URLSearchParams({ name: '密碼截圖.png', declared: 'true', project: PJ, post: 'false' })}`, 'POST', png(7), true)).body.file.fileId;
  const cur0 = (await call(wangAi.token, '/api/messages?limit=1')).body.nextCursor; // 收件匣從這裡往後讀
  const secret = await post(chen.token, '秘密字串 ZQX 請看附件', { recipientIds: [zhao.id, wangAi.id], replyFrom: [zhao.id], fileIds: [fid], cardId: card.cardId });
  const reply = await post(lin.token, '收到', { replyToMessageId: secret.messageId });
  const upload = async (name, n) => (await call(chen.token, `/api/files?${new URLSearchParams({ name, declared: 'true', project: PJ, post: 'false' })}`, 'POST', png(n), true)).body.file.fileId;
  const multi = await post(chen.token, '兩個附件', { recipientIds: [wangAi.id], fileIds: [await upload('一.png', 8), await upload('二.png', 9)] });
  const liveSecret = await read(chen.token, secret.messageId), liveMulti = await read(chen.token, multi.messageId), liveMultiAi = await read(wangAi.token, multi.messageId);
  assert.equal(liveMulti.files?.length, 2, '多個附件有 files');
  assert.equal((await call(lin.token, `/api/files/${fid}`)).status, 200, 'H 刪除前下載得到');
  const pending = async who => (await call(who.token, '/api/notifications?status=pending')).body.items.filter(n => n.messageId === secret.messageId).length;
  assert.equal(await pending(zhao), 1, 'F 趙專案有一則待處理通知');
  assert.equal(await pending(wangAi), 1, 'F 王小美的 AI 有一則待處理通知');
  assert.equal((await call(chen.token, '/api/search/messages?q=ZQX')).body.items.length, 2, 'E 刪除前搜得到');
  connected = [chen.id, lin.id, wangAi.id];
  events.length = 0;
  r = await del(wang.token, secret.messageId);
  assert.equal(r.status, 200, '平台管理員刪陳大文的訊息：' + JSON.stringify(r.body));
  assert.deepEqual([r.body.message.deleted, r.body.message.text], [true, GONE], 'C 回傳佔位');
  assert.deepEqual(events.filter(e => e.type === 'message_deleted').map(e => [e.to, e.data.id]).sort(), [chen.id, lin.id, wangAi.id].map(id => [id, secret.messageId]).sort(), 'L 即時推給看得到的人（只帶 id）');
  assert.equal(events.filter(e => e.type === 'notify').length, 0, 'K 刪除不發通知');
  await post(chen.token, '[接單] 別的事'); // 讓列表有新訊息；不影響卡片
  const status = await post(zhao.token, '[進度] 正在處理 ZQX 外洩');
  const ask = await post(zhao.token, '[需確認] 要不要換掉 ZQX？', { recipientIds: [wang.participant.participantId], replyFrom: [WANG] });
  const teamHas = async () => JSON.stringify((await call(wangAi.token, '/api/team-status')).body).includes('ZQX');
  assert.ok(await teamHas(), 'E 刪除前團隊狀態看得到標題');
  assert.equal((await del(lin.token, status.messageId)).status, 200);
  assert.equal((await del(lin.token, ask.messageId)).status, 200);

  // C 人類：單則、列表、前後文、卡片關聯都是佔位
  x = await read(chen.token, secret.messageId);
  assert.deepEqual([x.text, x.deleted, x.deletedBy.participantId, x.deletedBy.name], [GONE, true, WANG, '王小美'], 'C 單則：' + JSON.stringify(x));
  assert.ok(x.purgeAt > x.deletedAt, 'C 帶預計永久清除時間');
  assert.deepEqual(x.file, { ...liveSecret.file, available: false }, 'C 附件形狀不變、拿不到內容：' + JSON.stringify(x.file));
  assert.equal((await del(chen.token, multi.messageId)).status, 200, '作者刪掉有兩個附件的訊息');
  const xm = await read(chen.token, multi.messageId);
  assert.deepEqual([xm.file, xm.files], [{ ...liveMulti.file, available: false }, liveMulti.files.map(f => ({ ...f, available: false }))], 'C 多個附件：file 與 files 照舊在、available: false：' + JSON.stringify([xm.file, xm.files]));
  const multiAi = await read(wangAi.token, multi.messageId);
  assert.deepEqual(Object.keys(multiAi).filter(k => !Object.keys(liveMultiAi).includes(k)), ['deleted'], 'D 給 AI 的形狀只多 deleted（含 files）：' + JSON.stringify(Object.keys(multiAi)));
  assert.deepEqual(Object.keys(liveMultiAi).filter(k => !Object.keys(multiAi).includes(k)), [], 'D 給 AI 的欄位一個都沒少');
  assert.ok(multiAi.files.every(f => f.available === false), 'D AI 看到的附件都拿不到內容');
  assert.deepEqual([x.recipients.map(p => p.participantId).sort(), x.author.participantId], [[zhao.id, wangAi.id].sort(), chen.id], 'C 收件人、作者照舊');
  const list = (await call(chen.token, `/api/messages?project=${encodeURIComponent(PJ)}&limit=50`)).body.items;
  const inList = list.find(m => m.messageId === secret.messageId);
  assert.deepEqual([inList?.text, inList?.deleted, inList?.deletedBy?.participantId], [GONE, true, WANG], 'C 列表裡是佔位（不是消失）');
  assert.ok(!JSON.stringify(list).includes('ZQX 請看'), 'C 列表沒有原文');
  const around = (await call(chen.token, `/api/messages/${reply.messageId}/around?n=5`)).body.items;
  assert.equal(around.find(m => m.messageId === secret.messageId)?.text, GONE, 'C 前後文裡是佔位');
  assert.equal(around.find(m => m.messageId === reply.messageId)?.replyToMessageId, secret.messageId, 'C 回覆串不斷');
  const cardView = (await call(chen.token, `/api/cards/${card.cardId}`)).body;
  assert.ok(cardView.messageIds.includes(secret.messageId), 'C 卡片關聯還在');
  assert.equal(await claimOf(), chenAi.id, 'G 認領不變');
  await del(chenAi.token, claim.messageId); // AI 刪不掉
  assert.equal((await del(lin.token, claim.messageId)).status, 200, 'G 管理員刪掉 [接單] 訊息');
  assert.equal(await claimOf(), chenAi.id, 'G [接單] 訊息被刪，認領不變');

  // D AI：REST 只多 deleted；管理員名下的 AI 也拿不到原文
  const before = Object.keys(await read(wangAi.token, reply.messageId));
  x = await read(wangAi.token, secret.messageId);
  assert.deepEqual([x.text, x.deleted], [GONE, true], 'D AI 讀單則是佔位');
  assert.deepEqual(Object.keys(x).filter(k => !before.includes(k)), ['deleted'], 'D 給 AI 的形狀只多 deleted：' + JSON.stringify(Object.keys(x)));
  const leaks = s => /ZQX/.test(JSON.stringify(s));
  const mRead = await tool(wangAi.token, 'aigile_read', { messageId: secret.messageId, context: true });
  assert.deepEqual([mRead.message.text, mRead.message.deleted], [GONE, true], 'D MCP aigile_read 是佔位');
  assert.ok(!leaks(mRead), 'D MCP aigile_read（含前後文）沒有原文：' + JSON.stringify(mRead));
  assert.equal(mRead.context.find(m => m.messageId === claim.messageId)?.deleted, true, 'D MCP 前後文帶 deleted');
  const hist = await tool(wangAi.token, 'aigile_history', { hours: 1 });
  assert.equal(hist.messages.find(m => m.messageId === secret.messageId)?.deleted, true, 'D MCP aigile_history 帶 deleted');
  assert.ok(!leaks(hist), 'D MCP aigile_history 沒有原文');
  const cardHist = await tool(wangAi.token, 'aigile_history', { cardId: card.cardId });
  assert.equal(cardHist.messages.find(m => m.messageId === secret.messageId)?.text, GONE, 'D 卡片歷史是佔位');
  assert.ok(!leaks(cardHist), 'D 卡片歷史沒有原文');
  const inbox = await tool(wangAi.token, 'aigile_inbox', { after: cur0, limit: 50 });
  const inInbox = inbox.messages.find(m => m.messageId === secret.messageId);
  assert.equal(inInbox?.deleted, true, 'D MCP aigile_inbox 帶 deleted：' + JSON.stringify(inbox));
  assert.ok(!leaks(inbox), 'D MCP aigile_inbox 沒有原文');
  const mMulti = inbox.messages.find(m => m.messageId === multi.messageId);
  assert.deepEqual([mMulti?.file, mMulti?.files], [{ fileId: liveMulti.files[0].fileId, name: '一.png', available: false }, liveMulti.files.map(f => ({ fileId: f.fileId, name: f.name, available: false }))], 'D MCP 精簡格式的附件形狀不變、available: false：' + JSON.stringify(mMulti));
  assert.ok(!(await teamHas()), 'E 團隊狀態不露出被刪訊息的標題');
  const done = (await call(wangAi.token, '/api/notifications?status=confirmed&limit=50')).body.items.find(n => n.messageId === secret.messageId);
  assert.equal(done?.preview, GONE, 'F 已確認的通知還在，預覽是佔位：' + JSON.stringify(done));

  // E 搜尋找不到
  assert.deepEqual((await call(chen.token, '/api/search/messages?q=ZQX')).body.items, [], 'E 搜尋找不到被刪的訊息');
  assert.equal((await call(chen.token, '/api/search?q=ZQX')).body.messages.length, 0, 'E 綜合搜尋也找不到');
  // F 待處理通知自動確認
  assert.equal(await pending(zhao), 0, 'F 趙專案的通知自動確認');
  assert.equal(await pending(wangAi), 0, 'F AI 的通知自動確認');
  // H 附件不能下載、寫進檔案稽核；檔案清單也不列
  assert.equal(code(await call(lin.token, `/api/files/${fid}`)), '410 MESSAGE_DELETED', 'H 可復原期內附件不能下載');
  const fa = (await call(boss.token, '/api/files/audit')).body.items.filter(a => a.fileId === fid).map(a => [a.action, a.detail]);
  assert.deepEqual(fa[0], ['reject', 'MESSAGE_DELETED'], 'H 被拒的下載寫進檔案稽核：' + JSON.stringify(fa));
  assert.ok(!(await call(chen.token, '/api/files')).body.items.some(f => f.fileId === fid), 'H 檔案清單不列被刪訊息的附件');

  // ---------- I 復原 ----------
  assert.equal(code(await restore(chen.token, byChen.messageId)), '409 NOT_DELETED', 'I 沒被刪的 NOT_DELETED');
  assert.equal(code(await restore(chen.token, secret.messageId)), '403 RESTORE_FORBIDDEN', 'I 作者不能復原管理員刪的');
  assert.equal(code(await restore(zhao.token, m1.messageId)), '403 NOT_ADMIN', 'I 專案管理員不能復原別人的');
  assert.equal(code(await restore(chenAi.token, m1.messageId)), '403 FORBIDDEN', 'I AI 不能復原');
  connected = [chen.id, zhao.id];
  events.length = 0;
  r = await restore(chen.token, m1.messageId);
  assert.equal(r.status, 200, 'I 作者復原自己刪的：' + JSON.stringify(r.body));
  assert.deepEqual([r.body.message.text, r.body.message.deleted, r.body.message.deletedBy], ['貼錯了：密碼 hunter2', undefined, undefined], 'I 復原後是原文');
  assert.deepEqual(events.map(e => [e.to, e.type]).sort(), [[chen.id, 'message_restored'], [zhao.id, 'message_restored']].sort(), 'L 復原即時推送、不發通知');
  r = await restore(lin.token, secret.messageId);
  assert.equal(r.status, 200, 'I 工作區管理員復原平台管理員刪的');
  assert.ok((await read(wangAi.token, secret.messageId)).text.startsWith('秘密字串 ZQX 請看附件'), 'I 復原後 AI 讀得到原文');
  assert.equal((await call(lin.token, `/api/files/${fid}`)).status, 200, 'I 復原後附件下載得到');
  assert.equal((await call(chen.token, '/api/search/messages?q=ZQX')).body.items.some(m => m.messageId === secret.messageId), true, 'I 復原後搜得到');
  assert.equal(await pending(zhao), 0, 'F 復原不重發通知');
  assert.equal(await pending(wangAi), 0, 'F 復原不重發通知（AI）');

  // ---------- J 可復原期：刪除當下決定；過了就 RECOVERY_EXPIRED；0 天當下永久清除 ----------
  const days = ms => Math.round(ms / 86400_000);
  const m7 = await post(chen.token, '七天的');
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: 7 })).status, 200, '工作區可復原期改 7 天');
  x = (await del(chen.token, m7.messageId)).body.message;
  assert.equal(days(Date.parse(x.purgeAt) - Date.parse(x.deletedAt)), 7, 'J 依當下生效的可復原期（7 天）');
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: 90 })).status, 200, '之後改成 90 天');
  assert.equal((await read(chen.token, m7.messageId)).purgeAt, x.purgeAt, 'J 改設定不影響已刪除的');
  await db.run('UPDATE messages SET deleted_at = ?, purge_at = ? WHERE id = ?', new Date(Date.now() - 8 * 86400_000).toISOString(), new Date(Date.now() - 86400_000).toISOString(), m7.messageId); // 模擬時間過了 8 天
  assert.equal(code(await restore(chen.token, m7.messageId)), '409 RECOVERY_EXPIRED', 'J 過了可復原期作者不能復原');
  assert.equal(code(await restore(lin.token, m7.messageId)), '409 RECOVERY_EXPIRED', 'J 管理員也不能');
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: 0 })).status, 200, '改成 0 天');
  const m0 = await post(chen.token, '馬上清掉 ZQX0');
  x = (await del(chen.token, m0.messageId)).body.message;
  assert.deepEqual([x.text, x.deleted, x.purged, x.purgeAt <= new Date().toISOString()], [GONE, true, true, true], 'J 0 天：刪除當下永久清除：' + JSON.stringify(x));
  assert.equal(code(await restore(chen.token, m0.messageId)), '409 RECOVERY_EXPIRED', 'J 0 天刪的不能復原');
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: null })).status, 200, '改回跟平台預設');

  // ---------- K 稽核紀錄：刪除、復原都記，不含原文 ----------
  const logs = async action => (await call(boss.token, `/api/audit-log?action=${action}&limit=200`)).body.items;
  const dels = await logs('message.delete'), ress = await logs('message.restore');
  const one = dels.find(e => e.target?.id === secret.messageId);
  assert.deepEqual([one?.actor.id, one?.scope.kind, one?.scope.projectId, one?.target.kind, one?.target.name, one?.detail?.authorId], [WANG, 'project', PJ, 'message', '陳大文', chen.id], 'K 刪除紀錄操作者、專案、對象與作者：' + JSON.stringify(one));
  assert.equal(dels.find(e => e.target?.id === cross.messageId)?.scope.kind, 'workspace', 'K 跨專案頻道的訊息記在工作區層');
  assert.equal(dels.length, 12, 'K 每次刪除一筆（被擋下的不記）：' + dels.length);
  assert.deepEqual(ress.map(e => [e.actor.id, e.target.id]).sort(), [[chen.id, m1.messageId], [lin.id, secret.messageId]].sort(), 'K 復原紀錄');
  assert.ok(!/ZQX|hunter2|七天的/.test(JSON.stringify([dels, ress])), 'K 稽核紀錄不含原文');
  assert.equal((await call(lin.token, '/api/me/notices')).body.items?.filter(n => /message/.test(n.kind)).length ?? 0, 0, 'K 不發帳號提醒');

  // ---------- M 已刪除的專案裡的訊息 ----------
  const np = (await call(boss.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'MDEL' })).body;
  const pid = np.items.find(p => p.name === '要刪的專案').id, enc = encodeURIComponent(pid);
  const inPj = await post(boss.token, '專案裡的訊息', { project: pid });
  const inPjGone = await post(boss.token, '專案裡先刪的訊息', { project: pid });
  assert.equal((await del(boss.token, inPjGone.messageId)).status, 200, 'M 專案刪除前先刪一則');
  assert.equal((await call(boss.token, `/api/projects/${enc}/archive`, 'POST')).status, 200, 'M 封存');
  await reauth(call, boss);
  assert.equal((await call(boss.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: '要刪的專案' })).status, 200, 'M 刪除專案（進入可復原期）');
  assert.equal(code(await del(boss.token, inPj.messageId)), '404 NOT_FOUND', 'M 已刪除專案裡的訊息不能刪');
  assert.equal(code(await restore(boss.token, inPjGone.messageId)), '404 NOT_FOUND', 'M 已刪除專案裡的訊息不能復原');
  assert.equal(code(await call(boss.token, `/api/messages/${inPjGone.messageId}`)), '404 NOT_FOUND', 'M 也讀不到');
  assert.equal((await call(boss.token, `/api/projects/${enc}/restore`, 'POST')).status, 200, 'M 專案復原');
  assert.equal((await restore(boss.token, inPjGone.messageId)).status, 200, 'M 專案復原後，訊息照常可以復原');

  console.log('message-delete-test：全部通過');
} finally {
  await db?.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
