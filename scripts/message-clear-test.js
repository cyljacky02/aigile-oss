// 清空專案訊息與整批復原（詞彙見 GLOSSARY「協作訊息」「刪除與稽核」；決策見 docs/adr/0003）
// A. 只有工作區管理員（含平台管理員的隱含權限）能預覽、清空、列出與整批復原；專案管理員、其他成員、AI 一律被拒
// B. 預覽：會刪掉多少則訊息、多少個附件（已單獨刪除的不算）、照現在生效的可復原期算出的預計永久清除時間
// C. 清空要輸入專案名稱確認；是敏感動作，這台裝置要先再驗證身分
// D. 範圍只有該專案的群組訊息與附件：卡片、卡片紀錄、決策結果、私訊、跨專案頻道、別的專案都不變；被清空的訊息跟單則刪除一樣是佔位、搜尋不到、附件不能下載（清空、整批復原都寫進檔案稽核）、待處理通知自動確認
// E. 每次清空是一筆有 id 的操作；工作區管理員看得到最近可復原的清空，可在可復原期內整批復原；
//    清空前已被單獨刪除的不會被帶回來；清空後單獨復原的一則不再屬於那次清空；過了可復原期 RECOVERY_EXPIRED
// F. 清空、整批復原都通知所有工作區管理員（不含操作者本人），寫稽核紀錄（附數量、不含原文）
// G. 可復原期 0 天：清空當下就永久清除，不能整批復原；清空記操作的人，永久清除的操作者是系統
// H. 即時通道：一個專案推一則（messages_cleared／messages_restored）
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/message-clear-test.js
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

const PJ = '預設專案', PJ2 = '第二專案', ENC = encodeURIComponent(PJ);
const GONE = '（此訊息已刪除）';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-msgclear-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
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
  const read = async (token, id) => (await call(token, `/api/messages/${id}`)).body;
  const preview = (token, pj = ENC) => call(token, `/api/projects/${pj}/messages/clear-preview`);
  const clear = (token, confirmName = PJ, pj = ENC) => call(token, `/api/projects/${pj}/messages/clear`, 'POST', { confirmName });
  const clears = (token, q = '') => call(token, `/api/message-clears${q}`);
  const restoreClear = (token, id) => call(token, `/api/message-clears/${id}/restore`, 'POST');

  const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const WANG = wang.participant.participantId;
  const boss = await adminSession(call, wang.token);
  const join = async (name, role) => {
    const b = (await call(null, '/api/join', 'POST', { name, role })).body;
    assert.equal((await call(boss.token, `/api/participants/${b.participant.participantId}/projects`, 'PUT', { projects: [PJ, PJ2] })).status, 200, `${name} 加進專案`);
    return { token: b.token, id: b.participant.participantId, name };
  };
  const lin = await join('林工作', 'SM'); // 工作區管理員（不是平台管理員）
  await reauth(call, boss);
  assert.equal((await call(boss.token, `/api/participants/${lin.id}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '林工作升為工作區管理員');
  const linS = await adminSession(call, lin.token);
  const chen = await join('陳大文', 'PG'); // 專案成員
  const zhao = await join('趙專案', 'PM'); // 專案管理員
  assert.equal((await call(boss.token, `/api/projects/${ENC}/members/${zhao.id}`, 'PUT', { role: 'admin' })).status, 200, '趙專案是專案管理員');
  const zhaoS = await adminSession(call, zhao.token);
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: [PJ, PJ2], roleKey: 'PG', role: 'PG', name: '王小美的助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = await testToken(db, ai.participantId);

  // ---------- 內容：預設專案的群組訊息（含附件、回覆、卡片關聯、決策）、單獨先刪的一則；別的專案、跨專案頻道、私訊各一 ----------
  const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
  const upload = async n => (await call(chen.token, `/api/files?${new URLSearchParams({ name: `圖${n}.png`, declared: 'true', project: PJ, post: 'false' })}`, 'POST', png(n), true)).body.file.fileId;
  const f1 = await upload(1), f2 = await upload(2);
  const card = (await call(boss.token, '/api/cards', 'POST', { requestId: 'card1', project: PJ, title: '修登入頁', ownerId: ai.participantId, status: '待處理' })).body;
  assert.ok(card.cardId, '建卡：' + JSON.stringify(card));
  const a1 = await post(chen.token, '第一則 SECRETCLR 附件', { fileIds: [f1, f2], recipientIds: [zhao.id], replyFrom: [zhao.id] });
  const a2 = await post(aiTok, '[接單] 我來修 SECRETCLR', { cardId: card.cardId });
  const a3 = await post(zhao.token, '[需確認] 要不要上線 SECRETCLR？\n選項：\nA. 要\nB. 不要', { recipientIds: [WANG] });
  assert.equal((await call(wang.token, `/api/decisions/${a3.messageId}/resolve`, 'POST')).status, 200, '決策標為已處理');
  const a4 = await post(lin.token, '收到', { replyToMessageId: a1.messageId });
  const solo = await post(chen.token, '先單獨刪掉的 SECRETCLR');
  assert.equal((await call(chen.token, `/api/messages/${solo.messageId}`, 'DELETE')).status, 200, '作者先單獨刪一則');
  const other = await post(chen.token, '第二專案的 SECRETCLR', { project: PJ2 });
  const cross = await post(chen.token, '跨專案頻道的 SECRETCLR', { project: 'all' });
  const groupIds = [a1, a2, a3, a4].map(m => m.messageId);
  assert.equal((await call(boss.token, `/api/projects/${ENC}/dm`, 'PUT', { on: true })).status, 200, '開私訊');
  assert.equal((await call(boss.token, '/api/dm', 'POST', { requestId: 'd1', aiId: ai.participantId, text: '私訊 SECRETCLR' })).status, 201, '私訊');
  const claimOf = async () => (await call(boss.token, `/api/cards/${card.cardId}`)).body.claim?.by?.participantId;
  assert.equal(await claimOf(), ai.participantId, '卡片被認領');
  const pending = async who => (await call(who.token, '/api/notifications?status=pending')).body.items.filter(n => n.messageId === a1.messageId).length;
  assert.equal(await pending(zhao), 1, '趙專案有一則待處理通知');

  // ---------- A 權限、B 預覽 ----------
  for (const [who, tok, want] of [['專案管理員', zhaoS.token, '403 NOT_ADMIN'], ['專案成員', chen.token, '403 NOT_ADMIN'], ['AI', aiTok, '403 FORBIDDEN']]) {
    assert.equal(code(await preview(tok)), want, `A ${who}不能預覽`);
    assert.equal(code(await clear(tok)), want, `A ${who}不能清空`);
    assert.equal(code(await clears(tok)), want, `A ${who}看不到清空清單`);
  }
  let r = await preview(lin.token);
  assert.equal(r.status, 200, 'B 工作區管理員能預覽（不用再驗證）：' + JSON.stringify(r.body));
  assert.deepEqual([r.body.projectId, r.body.name, r.body.counts], [PJ, PJ, { messages: 5, files: 2 }], 'B 預覽數量（建卡的 [通知] 也是群組訊息；已單獨刪除的不算）：' + JSON.stringify(r.body));
  assert.equal(r.body.recoveryDays, 30, 'B 帶生效的可復原期');
  assert.equal(Math.round((Date.parse(r.body.purgeAt) - Date.now()) / 86400_000), 30, 'B 預計永久清除時間');
  assert.equal(code(await preview(lin.token, 'nope')), '404 NOT_FOUND', 'B 不存在的專案 404');

  // ---------- C 確認名稱、再驗證 ----------
  assert.equal(code(await clear(lin.token)), '403 DEVICE_REQUIRED', 'C 登入碼（沒有裝置）不能清空');
  const fresh = (await call(null, '/api/auth/password', 'POST', { username: linS.username, password: linS.password })).body.token;
  assert.equal(code(await clear(fresh)), '403 REAUTH_REQUIRED', 'C 沒再驗證不能清空');
  assert.equal(code(await clear(linS.token, '錯的名字')), '400 INVALID_REQUEST', 'C 名稱不對不能清空');
  assert.equal((await read(chen.token, a1.messageId)).deleted, undefined, 'C 被擋下的沒有清空');

  // ---------- D 清空 ----------
  connected = [chen.id, zhao.id, lin.id];
  events.length = 0;
  r = await clear(linS.token);
  assert.equal(r.status, 200, 'D 工作區管理員清空：' + JSON.stringify(r.body));
  const c1 = r.body.clear;
  assert.ok(c1.clearId, 'E 清空是一筆有 id 的操作');
  assert.deepEqual([c1.projectId, c1.messages, c1.files, c1.recoveryDays, c1.purged], [PJ, 5, 2, 30, false], 'D 回傳數量：' + JSON.stringify(c1));
  for (const id of groupIds) {
    const x = await read(chen.token, id);
    assert.deepEqual([x.text, x.deleted, x.deletedBy?.participantId], [GONE, true, lin.id], 'D 被清空的訊息跟單則刪除一樣是佔位：' + JSON.stringify(x));
  }
  assert.equal((await read(chen.token, solo.messageId)).deletedBy.participantId, chen.id, 'D 先單獨刪的，刪除者不變');
  assert.equal((await read(chen.token, other.messageId)).deleted, undefined, 'D 別的專案不變');
  assert.equal((await read(chen.token, cross.messageId)).deleted, undefined, 'D 跨專案頻道不變');
  assert.equal((await call(boss.token, `/api/dm?aiId=${ai.participantId}`)).body.items.length, 1, 'D 私訊不變');
  const cv = (await call(boss.token, `/api/cards/${card.cardId}`)).body;
  assert.deepEqual([cv.title, cv.messageIds.includes(a2.messageId)], ['修登入頁', true], 'D 卡片與關聯不變');
  assert.equal(await claimOf(), ai.participantId, 'D 卡片紀錄（認領）不變');
  assert.deepEqual((await call(chen.token, '/api/search/messages?q=SECRETCLR')).body.items.map(m => m.messageId).sort(), [other.messageId, cross.messageId].sort(), 'D 搜尋不到被清空的');
  assert.equal(code(await call(chen.token, `/api/files/${f1}`)), '410 MESSAGE_DELETED', 'D 附件不能下載');
  const fileAudit = async (fid, action) => (await call(boss.token, '/api/files/audit?limit=500')).body.items.filter(a => a.fileId === fid && a.action === action).map(a => [a.detail, a.actor.participantId]);
  for (const f of [f1, f2]) assert.deepEqual(await fileAudit(f, 'msg_delete'), [['PROJECT_MESSAGES_CLEARED', lin.id]], 'D 清空寫進檔案稽核（每個附件一筆、操作者）');
  assert.equal(await pending(zhao), 0, 'D 待處理通知自動確認');
  assert.deepEqual(events.filter(e => e.type === 'messages_cleared').map(e => [e.to, e.data.project, e.data.clearId]).sort(), [chen.id, zhao.id, lin.id].map(id => [id, PJ, c1.clearId]).sort(), 'H 一個專案推一則');
  assert.equal(events.filter(e => e.type === 'message_deleted').length, 0, 'H 不逐則推送');
  r = await preview(lin.token);
  assert.deepEqual(r.body.counts, { messages: 0, files: 0 }, 'B 清空後預覽是 0');
  r = await clear(linS.token);
  assert.deepEqual([r.status, r.body.clear?.clearId ?? null, r.body.clear?.messages], [200, null, 0], 'D 沒有訊息可清空：什麼都不做');

  // ---------- E 最近的清空、整批復原 ----------
  const after = await post(chen.token, '清空後的新訊息');
  r = await clears(lin.token);
  assert.equal(r.status, 200, 'E 工作區管理員看得到清空清單：' + JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map(c => [c.clearId, c.projectId, c.name, c.messages, c.clearedBy?.participantId, c.clearedBy?.name]), [[c1.clearId, PJ, PJ, 5, lin.id, '林工作']], 'E 清單內容');
  assert.ok(r.body.items[0].clearedAt && r.body.items[0].purgeAt > r.body.items[0].clearedAt, 'E 清空時間與預計永久清除時間');
  assert.deepEqual((await clears(lin.token, `?project=${encodeURIComponent(PJ2)}`)).body.items, [], 'E 可以只看某個專案');
  // 清空後單獨復原一則：它不再屬於這次清空
  assert.equal((await call(linS.token, `/api/messages/${a4.messageId}/restore`, 'POST')).status, 200, 'E 單獨復原一則');
  assert.equal((await clears(lin.token)).body.items[0].messages, 4, 'E 單獨復原的那則不再算在清空裡');
  assert.equal(code(await restoreClear(zhaoS.token, c1.clearId)), '403 NOT_ADMIN', 'A 專案管理員不能整批復原');
  assert.equal(code(await restoreClear(aiTok, c1.clearId)), '403 FORBIDDEN', 'A AI 不能整批復原');
  assert.equal(code(await restoreClear(lin.token, 'clr_nope')), '404 NOT_FOUND', 'E 不存在的清空 404');
  connected = [chen.id];
  events.length = 0;
  r = await restoreClear(boss.token, c1.clearId);
  assert.equal(r.status, 200, 'E 平台管理員（隱含權限）整批復原：' + JSON.stringify(r.body));
  assert.deepEqual([r.body.restored.clearId, r.body.restored.projectId, r.body.restored.messages], [c1.clearId, PJ, 4], 'E 復原數量');
  for (const m of [a1, a2, a3]) assert.ok((await read(chen.token, m.messageId)).text.includes('SECRETCLR'), 'E 整批復原後是原文');
  const res = (await read(chen.token, a3.messageId)).resolution;
  assert.deepEqual([res?.state, res?.by?.participantId], ['已處理（未回覆）', WANG], 'D 決策結果不變：' + JSON.stringify(res));
  const s = await read(chen.token, solo.messageId);
  assert.deepEqual([s.deleted, s.deletedBy.participantId], [true, chen.id], 'E 清空前已被單獨刪除的沒有被帶回來');
  assert.equal((await read(chen.token, after.messageId)).text, '清空後的新訊息', 'E 清空後的新訊息不受影響');
  assert.equal((await call(chen.token, `/api/files/${f1}`)).status, 200, 'E 復原後附件下載得到');
  for (const f of [f1, f2]) assert.deepEqual(await fileAudit(f, 'msg_restore'), [['PROJECT_MESSAGES_RESTORED', WANG]], 'E 整批復原寫進檔案稽核');
  assert.equal(await pending(zhao), 0, 'E 復原不重發通知');
  assert.deepEqual(events.filter(e => e.type === 'messages_restored').map(e => [e.to, e.data.project, e.data.clearId]), [[chen.id, PJ, c1.clearId]], 'H 整批復原推一則');
  assert.deepEqual((await clears(lin.token)).body.items, [], 'E 復原後不在清單');
  assert.equal(code(await restoreClear(lin.token, c1.clearId)), '404 NOT_FOUND', 'E 已復原的不能再復原');

  // 過了可復原期
  r = await clear(linS.token);
  const c2 = r.body.clear;
  assert.equal(c2.messages, 6, 'E 第二次清空（含剛才新發的）：' + JSON.stringify(c2));
  await db.run('UPDATE messages SET purge_at = ? WHERE clear_id = ?', new Date(Date.now() - 60_000).toISOString(), c2.clearId); // 模擬可復原期過了
  assert.deepEqual((await clears(lin.token)).body.items, [], 'E 過了可復原期的不列');
  assert.equal(code(await restoreClear(lin.token, c2.clearId)), '409 RECOVERY_EXPIRED', 'E 過了可復原期不能整批復原');

  // ---------- F 通知、稽核紀錄 ----------
  const notices = async who => (await call(who.token, '/api/me/notices')).body.items.filter(n => /^admin_project_messages/.test(n.kind)).map(n => n.kind);
  assert.deepEqual(await notices(boss), ['admin_project_messages_clear', 'admin_project_messages_clear'], 'F 其他工作區管理員收到清空通知（整批復原是自己做的，不通知自己）');
  assert.deepEqual((await notices(linS)).sort(), ['admin_project_messages_restore'], 'F 操作者本人不通知；收到別人整批復原的通知');
  assert.deepEqual(await notices({ token: chen.token }), [], 'F 一般成員不收');
  const logs = async action => (await call(boss.token, `/api/audit-log?action=${action}&limit=50`)).body.items;
  const cl = await logs('project_messages.clear'), rs = await logs('project_messages.restore');
  assert.deepEqual(cl.map(e => [e.actor.id, e.scope.kind, e.scope.projectId, e.count, e.detail?.clearId]).sort(), [[lin.id, 'project', PJ, 5, c1.clearId], [lin.id, 'project', PJ, 6, c2.clearId]].sort(), 'F 清空的稽核紀錄附數量：' + JSON.stringify(cl));
  assert.deepEqual(rs.map(e => [e.actor.id, e.scope.projectId, e.count, e.detail?.clearId]), [[WANG, PJ, 4, c1.clearId]], 'F 整批復原的稽核紀錄');
  assert.ok(!/SECRETCLR|清空後的新訊息/.test(JSON.stringify([cl, rs])), 'F 稽核紀錄不含原文');
  assert.equal((await call(lin.token, `/api/audit-log?action=project_messages.clear`)).body.items.length, 2, 'F 工作區管理員看得到（專案範圍）');

  // ---------- G 可復原期 0 天 ----------
  await reauth(call, linS);
  assert.equal((await call(linS.token, '/api/recovery-window', 'PUT', { days: 0 })).status, 200, '可復原期改 0 天');
  const z = await post(chen.token, '馬上清掉', { project: PJ2 });
  r = await clear(linS.token, PJ2, encodeURIComponent(PJ2));
  assert.deepEqual([r.status, r.body.clear?.recoveryDays, r.body.clear?.purged], [200, 0, true], 'G 0 天：清空當下永久清除：' + JSON.stringify(r.body));
  const zz = await read(chen.token, z.messageId);
  assert.deepEqual([zz.text, zz.deleted, zz.purged], [GONE, true, true], 'G 已永久清除，佔位留著');
  assert.equal((await read(chen.token, other.messageId)).purged, true, 'G 同專案的都清除');
  assert.equal(code(await restoreClear(lin.token, r.body.clear.clearId)), '409 RECOVERY_EXPIRED', 'G 0 天的清空不能復原');
  const zl = async action => (await call(boss.token, `/api/audit-log?action=${action}&limit=200`)).body.items.filter(e => e.scope.projectId === PJ2);
  assert.deepEqual((await zl('project_messages.clear')).filter(e => e.detail?.clearId === r.body.clear.clearId).map(e => e.actor.id), [lin.id], 'G 清空的稽核紀錄是操作的人');
  const zp = (await zl('message.purge')).filter(e => e.detail?.messageIds?.includes(z.messageId));
  assert.deepEqual(zp.map(e => [e.actor.id, e.actor.kind]), [['system', 'system']], 'G 永久清除的稽核紀錄是系統：' + JSON.stringify(zp));

  console.log('message-clear-test：全部通過');
} finally {
  await db?.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
