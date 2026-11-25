// 刪除已封存的專案（POST /api/projects/:id/delete）：先進入可復原期，期滿才由排程永久清除（docs/adr/0003）
// A. 只有工作區管理員（含平台管理員）；沒封存的擋（409 NOT_ARCHIVED）；要輸入專案名稱；專案管理員、AI 都不行
// B. 刪除是敏感動作：這台裝置沒再驗證過回 403 REAUTH_REQUIRED（登入碼沒有裝置：DEVICE_REQUIRED）；預覽不用再驗證
// C. 預覽列出訊息、卡片、文件、上傳檔、技能、成員數、只屬於這個專案的 AI，以及依生效的可復原期算出的預計永久清除時間
// D. 可復原期內：專案只出現在工作區管理員的「已刪除的專案」（GET /api/deleted-projects，含預計清除時間）；
//    專案清單、卡片代號、搜尋、訊息、MCP、跟別的專案共用的 AI 的私訊（對話、最後一句、通知）都當它不存在；專案代碼與網址英文名保留，新專案不能用
// E. 只屬於這個專案的 AI 暫停（Token 401、所屬人類不能自己啟用）；其他人和 AI 照常
// F. 工作區管理員可以復原（POST /api/projects/:id/restore），復原後回到封存狀態，暫停的 AI 恢復；可復原期過了就不能復原
// G. 刪除與復原通知其他工作區管理員（不含操作者）；刪除、復原、永久清除都寫稽核紀錄（專案名稱快照與數量；清除的操作者是系統）
// H. 期滿由排程（runScheduled）永久清除：卡片與紀錄、訊息與通知、決策、上傳檔與文件（含本體）、技能、知識庫、加入申請、私訊、
//    專案事件與設定；人和 AI 都留著，只屬於這個專案的 AI 此時才刪除；跨專案頻道與其他專案不動；清除後代碼與名稱可以再用
// J. 舊的刪除紀錄端點 GET /api/project-deletions 照舊可用（形狀不變，只給工作區管理員）：資料來自稽核紀錄的永久清除，刪除者是按刪除的人
// I. 可復原期為 0：刪除當下就永久清除（刪除記操作的人，永久清除的操作者是系統）
// 修正前：刪除當下就清除，救不回來
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。本機暫存資料庫，不連正式站。用法：node scripts/project-delete-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { testToken } from './test-token.js'; // 資料庫只存雜湊：換一組已知的 Token
import { makeProjectAdmin } from './test-members.js';
import { adminSession } from './test-admin.js';

const DAY = 86400_000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-projdel-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  const docs = memStorage();
  const app = createApp({ db, storage: dbStorage(db), docStorage: docs, docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const code = r => `${r.status} ${r.body?.error?.code || ''}`;
  const n = async (sql, ...a) => Number((await db.get(sql, ...a)).n);
  let rq = 0;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'); // 第一位人類＝平台管理員＋工作區管理員
  const wang = await join('陳小美', 'UX');
  const lin = await join('林工作', 'SM');
  const id = p => p.participant.participantId;
  const boss = await adminSession(call, liu.token); // 設了密碼、剛再驗證過的裝置
  assert.equal((await call(boss.token, `/api/participants/${id(lin)}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '林工作是另一位工作區管理員');
  const np = (await call(liu.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL', slug: 'to-del' })).body;
  const pid = np.items.find(p => p.name === '要刪的專案').id;
  const enc = encodeURIComponent(pid);
  assert.equal((await call(liu.token, `/api/participants/${id(wang)}/projects`, 'PUT', { projects: ['預設專案', pid] })).status, 200);
  assert.equal((await makeProjectAdmin(call, liu.token, id(wang), [pid])).status, 200, 'wang 當專案管理員');
  const mkAi = async (name, projects) => (await call(liu.token, '/api/my-ais', 'POST', { projects, roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiOnly = await mkAi('只在這裡的AI', [pid]);
  const aiBoth = await mkAi('兩邊都有的AI', ['預設專案', pid]);
  const aiAll = await mkAi('全專案的AI', ['預設專案', '第二專案']); // 在所有未封存專案（不受隔離）：封存專案的訊息照樣讀得到
  const aiOnlyTok = await testToken(db, aiOnly.participantId), aiBothTok = await testToken(db, aiBoth.participantId), aiAllTok = await testToken(db, aiAll.participantId);
  // 內容：這個專案的訊息（含通知）、卡片、文件、上傳檔、技能、知識庫、私訊、加入申請；別的專案與跨專案頻道各一則
  const post = (project, text, extra = {}) => call(liu.token, '/api/messages', 'POST', { project, text, requestId: 'r' + (++rq), recipientIds: [id(wang)], ...extra });
  const m1 = (await post(pid, '[需確認] 這個專案的問題\n選項：\nA. 好\nB. 不好')).body;
  const m2 = (await post(pid, '第二則', { recipientIds: [id(wang), id(lin)] })).body; // 林工作是工作區管理員（不受隔離），封存專案的通知照樣看得到
  const keepPlat = (await post('預設專案', '另一個專案的訊息')).body, keepAll = (await post('all', '跨專案頻道的訊息')).body;
  assert.ok(m1.messageId && keepPlat.messageId && keepAll.messageId, '發文成功：' + JSON.stringify([m1, keepPlat, keepAll]).slice(0, 300));
  assert.equal((await call(liu.token, `/api/decisions/${m1.messageId}/resolve`, 'POST')).status, 200, '標為已處理');
  const card = (await call(liu.token, '/api/cards', 'POST', { title: '這個專案的卡', project: pid, requestId: 'c1' })).body;
  const keepCard = (await call(liu.token, '/api/cards', 'POST', { title: '另一個專案的卡', project: '預設專案', requestId: 'c2' })).body;
  assert.ok(card.cardId === 'DEL-1' && keepCard.cardId, '建卡：' + JSON.stringify(card).slice(0, 200));
  const cardSeq = (await db.get('SELECT seq FROM cards WHERE project = ?', pid)).seq;
  const at = new Date().toISOString();
  await db.run("INSERT INTO files (id, uploader_id, name, ext, mime, size, sha256, declared, message_id, created_at, expires_at) VALUES ('fil_del', ?, 'a.txt', 'txt', 'text/plain', 3, 'x', 1, ?, ?, ?)", id(liu), m1.messageId, at, Date.now() + 864e5);
  await db.run("INSERT INTO file_chunks (file_id, idx, data) VALUES ('fil_del', 0, X'616263')");
  await db.run("INSERT INTO files (id, uploader_id, name, ext, mime, size, sha256, declared, message_id, created_at, expires_at) VALUES ('fil_keep', ?, 'b.txt', 'txt', 'text/plain', 3, 'x', 1, ?, ?, ?)", id(liu), keepPlat.messageId, at, Date.now() + 864e5);
  await db.run("INSERT INTO docs (id, project, name, ext, mime, size, sha256, uploader_id, created_at, updated_at) VALUES ('doc_del', ?, '規格', 'md', 'text/markdown', 3, 'x', ?, ?, ?)", pid, id(liu), at, at);
  await db.run("INSERT INTO doc_folders (id, project, name, created_at) VALUES ('fd_del', ?, '資料夾', ?)", pid, at);
  await docs.put('docs/doc_del', new Uint8Array([1, 2, 3])); await docs.put('docs/doc_keep', new Uint8Array([4]));
  await db.run("INSERT INTO kb_chunks (id, project, doc_id, idx, content, doc_sha256, created_at) VALUES ('kbc_del', ?, 'doc_del', 0, '段落', 'x', ?)", pid, at);
  await db.run("INSERT INTO kb_pages (id, project, kind, title, body, status, author_id, created_at, updated_at) VALUES ('kbp_del', ?, 'topic', '知識頁', '內容', 'published', ?, ?, ?)", pid, aiBoth.participantId, at, at);
  await db.run("INSERT INTO skills (id, project, name, version, files, sha256, size, status, uploaded_by, uploaded_at) VALUES ('sk_del', ?, 'del-skill', 1, '[]', 'x', 1, 'published', ?, ?)", pid, id(liu), at);
  await db.run("INSERT INTO skill_installs (ai_id, skill_id, at) VALUES (?, 'sk_del', ?)", aiBoth.participantId, at);
  await db.run("INSERT INTO skill_syncs (ai_id, requested_at, tool) VALUES (?, ?, 'claude')", aiOnly.participantId, at);
  await db.run("INSERT INTO dms (id, human_id, ai_id, from_id, text, project, request_id, created_at) VALUES ('dm_keep', ?, ?, ?, '另一個專案的私訊', '預設專案', 'd0', ?)", id(liu), aiBoth.participantId, id(liu), at);
  await db.run("INSERT INTO dms (id, human_id, ai_id, from_id, text, project, request_id, created_at) VALUES ('dm_del', ?, ?, ?, '私訊', ?, 'd1', ?)", id(liu), aiBoth.participantId, id(liu), pid, at);
  await db.run("INSERT INTO notifications (id, recipient_id, message_id, reasons, created_at) VALUES ('notif_dmdel', ?, 'dm_del', '[\"dm\"]', ?)", aiBoth.participantId, at);
  // 跟別的專案共用的 AI 的私訊：人類讀對話、最後一句，AI 讀對話與待處理通知
  const dmSeen = async () => {
    const human = (await call(liu.token, `/api/dm?aiId=${aiBoth.participantId}`)).body.items, ai = (await call(aiBothTok, '/api/dm')).body.items;
    const last = (await call(liu.token, '/api/dm/summary')).body.items.find(x => x.aiId === aiBoth.participantId)?.text;
    const inbox = (await call(aiBothTok, '/api/notifications')).body.items.some(x => x.messageId === 'dm_del');
    const count = (await call(aiBothTok, '/api/notifications/count')).body.pending;
    return { human: human.map(d => [d.dmId, d.project]), ai: ai.map(d => d.dmId), last, inbox, count };
  };
  const dmBefore = await dmSeen();
  assert.deepEqual([dmBefore.human, dmBefore.ai, dmBefore.last, dmBefore.inbox], [[['dm_keep', '預設專案'], ['dm_del', pid]], ['dm_keep', 'dm_del'], '私訊', true], '刪除前私訊都看得到：' + JSON.stringify(dmBefore));
  await db.run("INSERT INTO join_requests (id, project, participant_id, created_at) VALUES ('jr_del', ?, ?, ?)", pid, id(liu), at);
  await db.run("INSERT INTO app_settings (key, value) VALUES (?, '{\"url\":\"https://example.com/repo\"}')", 'repo:' + pid);
  assert.ok(await n('SELECT COUNT(*) AS n FROM notifications WHERE message_id = ?', m1.messageId), '有通知');
  const preview = token => call(token, `/api/projects/${enc}/delete-preview`);
  const del = (token, confirmName = '要刪的專案') => call(token, `/api/projects/${enc}/delete`, 'POST', { confirmName });
  const notices = async person => {
    const items = (await call(person.token, '/api/me/notices')).body.items.filter(x => /^admin_project/.test(x.kind));
    if (items.length) await call(person.token, '/api/me/notices/read', 'POST', { ids: items.map(x => x.id) });
    return items;
  };
  const audit = async action => (await call(boss.token, `/api/audit-log?action=${action}`)).body.items;
  const deletedList = async (token = boss.token) => call(token, '/api/deleted-projects');

  // ---------- A 沒封存：擋 ----------
  let r = await preview(boss.token);
  assert.equal(code(r), '409 NOT_ARCHIVED', 'A 沒封存不能預覽');
  assert.equal(code(await del(boss.token)), '409 NOT_ARCHIVED', 'A 沒封存不能刪');
  await db.run("UPDATE cards SET status = '已完成' WHERE project = ?", pid); // 封存要先結案
  assert.equal((await call(liu.token, `/api/projects/${enc}/archive`, 'POST')).status, 200, '封存');
  // 封存了、還沒刪：管理員照樣讀得到這個專案的訊息、卡片、搜尋（下面確認刪除後都查不到）
  assert.equal((await call(liu.token, `/api/messages/${m1.messageId}`)).status, 200, '刪除前讀得到訊息');
  assert.equal((await call(liu.token, '/api/cards/DEL-1')).status, 200, '刪除前卡片代號查得到');
  assert.ok((await call(liu.token, '/api/search?q=' + encodeURIComponent('這個專案的問題'))).body.messages.length, '刪除前搜尋得到');
  const mcpRead = async token => {
    const out = (await call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aigile_read', arguments: { messageId: m1.messageId } } })).body;
    return out.result?.isError ? 'error' : JSON.parse(out.result?.content?.[0]?.text ?? '{}').messageId || 'error';
  };
  assert.equal(await mcpRead(aiAllTok), m1.messageId, '刪除前 MCP 讀得到');
  const notified = async () => (await call(lin.token, '/api/notifications')).body.items.some(x => x.messageId === m2.messageId);
  assert.ok(await notified(), '刪除前工作區管理員的待處理通知有這則');

  // ---------- A 只有工作區管理員 ----------
  assert.equal((await preview(wang.token)).status, 403, 'A 專案管理員看不到預覽');
  assert.equal((await del(wang.token)).status, 403, 'A 專案管理員不能刪');
  assert.equal((await del(aiBothTok)).status, 403, 'A AI 不能刪');
  // ---------- C 預覽（不用再驗證） ----------
  r = await preview(liu.token);
  assert.equal(r.status, 200, 'C 預覽不用再驗證：' + JSON.stringify(r.body));
  assert.deepEqual({ ...r.body.counts }, { messages: 2, cards: 1, docs: 1, files: 1, skills: 1, members: 3 }, 'C 預覽數量：' + JSON.stringify(r.body.counts));
  assert.deepEqual(r.body.aisToDelete, ['只在這裡的AI'], 'C 列出只屬於這個專案的 AI');
  assert.deepEqual(r.body.blockers, []);
  assert.equal(r.body.recoveryDays, 30, 'C 生效的可復原期（預設 30 天）');
  assert.ok(Math.abs(Date.parse(r.body.purgeAt) - (Date.now() + 30 * DAY)) < 60_000, 'C 預計永久清除時間＝現在＋30 天：' + r.body.purgeAt);
  assert.equal((await call(aiOnlyTok, '/api/me')).status, 200, '刪之前 AI 能用');
  // ---------- A 名稱要打對；B 要再驗證 ----------
  r = await del(boss.token, '要刪的');
  assert.equal(r.status, 400, 'A 名稱不對'); assert.match(r.body.error.message, /要刪的專案/);
  assert.equal(code(await del(liu.token)), '403 DEVICE_REQUIRED', 'B 登入碼沒有裝置，不能刪');
  const unverified = (await call(null, '/api/auth/password', 'POST', { username: boss.username, password: boss.password })).body.token;
  assert.equal(code(await del(unverified)), '403 REAUTH_REQUIRED', 'B 沒再驗證的裝置不能刪');
  assert.equal((await call(liu.token, '/api/projects')).body.items.filter(p => p.id === pid).length, 1, 'B 被擋下來就沒刪');

  // ---------- 刪除：進入可復原期 ----------
  r = await del(boss.token, ' 要刪的專案 ');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.items.some(p => p.id === pid), 'D 專案清單沒有它了');
  assert.equal(r.body.deleted.name, '要刪的專案');
  assert.ok(Math.abs(Date.parse(r.body.deleted.purgeAt) - (Date.now() + 30 * DAY)) < 60_000, 'D 回傳預計清除時間');
  // D 已刪除的專案：只有工作區管理員看得到
  r = await deletedList();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map(x => [x.projectId, x.name, x.code, x.deletedBy?.name]), [[pid, '要刪的專案', 'DEL', '林志明']], 'D 已刪除的專案清單：' + JSON.stringify(r.body));
  assert.ok(Math.abs(Date.parse(r.body.items[0].purgeAt) - (Date.now() + 30 * DAY)) < 60_000, 'D 清單有預計清除時間');
  assert.equal(r.body.items[0].counts.messages, 2, 'D 清單有數量');
  assert.equal((await deletedList(lin.token)).status, 200, 'D 另一位工作區管理員也看得到');
  assert.equal((await deletedList(wang.token)).status, 403, 'D 一般成員看不到');
  assert.equal((await deletedList(aiBothTok)).status, 403, 'D AI 看不到');
  // D 各處都當它不存在
  for (const t of [liu.token, wang.token]) assert.ok(!(await call(t, '/api/projects')).body.items.some(p => p.id === pid), 'D 專案清單沒有');
  assert.equal((await call(liu.token, `/api/messages/${m1.messageId}`)).status, 404, 'D 訊息讀不到');
  assert.equal((await call(wang.token, `/api/messages/${m1.messageId}`)).status, 404, 'D 成員也讀不到訊息');
  assert.equal((await call(liu.token, `/api/messages/${keepPlat.messageId}`)).status, 200, 'D 別的專案的訊息照常');
  assert.equal((await call(liu.token, '/api/cards/DEL-1')).status, 404, 'D 卡片代號查不到');
  assert.equal((await call(liu.token, `/api/cards/C-${cardSeq + 100}`)).status, 404, 'D 舊卡號也查不到');
  r = await call(liu.token, '/api/search?q=' + encodeURIComponent('這個專案的問題'));
  assert.deepEqual([r.body.messages.length, r.body.cards.length], [0, 0], 'D 搜尋不到：' + JSON.stringify(r.body).slice(0, 200));
  assert.equal((await call(liu.token, '/api/search?q=' + encodeURIComponent('這個專案的卡'))).body.cards.length, 0, 'D 卡片搜尋不到');
  assert.equal(await mcpRead(aiAllTok), 'error', 'D MCP 讀不到');
  assert.ok(!(await notified()), 'D 待處理通知不列這個專案的訊息');
  const dmDuring = await dmSeen();
  assert.deepEqual([dmDuring.human, dmDuring.ai, dmDuring.last, dmDuring.inbox, dmDuring.count], [[['dm_keep', '預設專案']], ['dm_keep'], '另一個專案的私訊', false, dmBefore.count - 1],
    'D 共用 AI 的私訊不露出這個專案（對話、最後一句、通知與數量）：' + JSON.stringify(dmDuring));
  assert.equal((await call(liu.token, `/api/cards?project=${enc}`)).status, 400, 'D 不能當專案篩選');
  assert.equal((await preview(boss.token)).status, 404, 'D 刪除預覽 404');
  assert.equal((await call(liu.token, `/api/projects/${enc}/unarchive`, 'POST')).status, 404, 'D 不能用「還原封存」帶回來');
  assert.equal((await call(liu.token, `/api/projects/${enc}`, 'PATCH', { name: '改名' })).status, 404, 'D 不能改名');
  // D 專案底下的端點（看板狀態、成員、設定、文件、知識庫、技能、加入…）：工作區管理員、專案管理員都當它不存在（404）
  const underProject = [['GET', '/statuses'], ['POST', '/statuses', { name: '新狀態', category: '進行中' }], ['PUT', '/statuses/order', { ids: [] }],
    ['GET', '/members'], ['POST', '/members', { participantIds: [id(lin)] }], ['GET', '/events'], ['PUT', '/repo', { url: 'https://example.com/x' }],
    ['PUT', '/visibility', { visibility: 'open' }], ['PUT', '/code', { code: 'NEW' }], ['PUT', '/slug', { slug: 'new-slug' }], ['PUT', '/dm', { enabled: true }],
    ['PUT', '/roles/PG', { duties: 'x' }], ['GET', '/docs'], ['POST', '/doc-folders', { name: '資料夾' }], ['GET', '/kb/pages'], ['GET', '/kb/settings'],
    ['GET', '/kb/search?q=x'], ['GET', '/skills'], ['PUT', '/join-settings', { open: true }], ['POST', '/join'], ['POST', '/join-requests'],
    ['GET', '/messages/clear-preview'], ['POST', '/archive'], ['GET', '/delete-preview']];
  for (const t of [liu.token, wang.token]) {
    const leaks = [];
    for (const [method, p, body] of underProject) { const r = await call(t, `/api/projects/${enc}${p}`, method, body); if (r.status !== 404) leaks.push(`${method} ${p} ${r.status}`); }
    assert.deepEqual(leaks, [], `D 專案底下的端點都 404（${t === liu.token ? '工作區管理員' : '專案管理員'}）：${leaks.join('、')}`);
  }
  // D 代碼與網址英文名保留
  assert.equal(code(await call(liu.token, '/api/projects', 'POST', { name: '新專案', code: 'DEL' })), '409 CODE_TAKEN', 'D 代碼保留');
  assert.equal(code(await call(liu.token, '/api/projects', 'POST', { name: '新專案', slug: 'to-del' })), '409 SLUG_TAKEN', 'D 網址英文名保留');
  // E 只屬於這個專案的 AI 暫停；其他照常
  assert.equal((await call(aiOnlyTok, '/api/me')).status, 401, 'E 只屬於它的 AI 的 Token 暫時無效');
  assert.equal((await call(aiBothTok, '/api/me')).status, 200, 'E 兩邊都有的 AI 照常');
  assert.equal((await call(wang.token, '/api/me')).status, 200, 'E 成員照常');
  const mine = (await call(liu.token, '/api/my-ais')).body.items;
  assert.equal(mine.find(a => a.participantId === aiOnly.participantId)?.status, 'paused', 'E 我的 AI 清單顯示暫停：' + JSON.stringify(mine.map(a => [a.name, a.status])));
  assert.equal(code(await call(liu.token, `/api/my-ais/${aiOnly.participantId}/enable`, 'POST')), '409 AI_PAUSED', 'E 所屬人類不能自己啟用');
  assert.equal(code(await call(liu.token, `/api/my-ais/${aiOnly.participantId}/reissue`, 'POST')), '409 AI_PAUSED', 'E 不能重發 Token');
  assert.equal(code(await call(liu.token, `/api/my-ais/${aiOnly.participantId}`, 'PATCH', { projects: ['預設專案'] })), '409 AI_PAUSED', 'E 不能改專案');
  // G 通知其他工作區管理員、不含操作者；稽核紀錄
  assert.deepEqual((await notices(lin)).map(x => x.kind), ['admin_project_delete'], 'G 林工作收到刪除通知');
  assert.deepEqual((await notices(liu)).map(x => x.kind), [], 'G 操作者自己不收');
  assert.deepEqual((await notices(wang)).map(x => x.kind), [], 'G 一般成員不收');
  let L = await audit('project.delete');
  assert.equal(L.length, 1, 'G 一筆刪除紀錄');
  assert.deepEqual([L[0].actor.name, L[0].scope.projectName, L[0].target?.name, L[0].detail?.counts?.messages, L[0].detail?.code], ['林志明', '要刪的專案', '要刪的專案', 2, 'DEL'], 'G 刪除紀錄：' + JSON.stringify(L[0]));
  assert.ok(!JSON.stringify(L[0]).includes('這個專案的問題'), 'G 不記訊息原文');

  // ---------- F 復原 ----------
  const restore = token => call(token, `/api/projects/${enc}/restore`, 'POST');
  assert.equal((await restore(wang.token)).status, 403, 'F 一般成員不能復原');
  assert.equal((await restore(aiBothTok)).status, 403, 'F AI 不能復原');
  r = await restore(liu.token);
  assert.equal(r.status, 200, 'F 復原不用再驗證：' + JSON.stringify(r.body));
  const back = r.body.items.find(p => p.id === pid);
  assert.ok(back && back.archived && back.code === 'DEL', 'F 復原後回到封存狀態、代碼不變：' + JSON.stringify(back));
  assert.equal((await restore(liu.token)).status, 404, 'F 沒被刪除的不能復原');
  assert.deepEqual((await deletedList()).body.items, [], 'F 已刪除的清單空了');
  assert.equal((await call(aiOnlyTok, '/api/me')).status, 200, 'F 暫停的 AI 恢復');
  assert.equal((await call(liu.token, `/api/messages/${m1.messageId}`)).status, 200, 'F 訊息回來了');
  assert.equal((await call(liu.token, '/api/cards/DEL-1')).status, 200, 'F 卡片代號查得到');
  assert.ok(await notified(), 'F 待處理通知回來了');
  assert.deepEqual(await dmSeen(), dmBefore, 'F 私訊回來了');
  assert.deepEqual((await notices(lin)).map(x => x.kind), ['admin_project_restore'], 'G 林工作收到復原通知');
  assert.deepEqual((await notices(liu)).map(x => x.kind), [], 'G 操作者自己不收');
  L = await audit('project.restore');
  assert.deepEqual([L.length, L[0]?.scope.projectName, L[0]?.actor.name], [1, '要刪的專案', '林志明'], 'G 復原紀錄：' + JSON.stringify(L));

  // ---------- H 期滿由排程永久清除 ----------
  r = await del(boss.token);
  assert.equal(r.status, 200, '再刪一次：' + JSON.stringify(r.body));
  await db.run('UPDATE projects SET purge_at = ? WHERE id = ?', Date.now() - 1000, pid); // 模擬時間經過
  assert.equal(code(await restore(liu.token)), '409 RECOVERY_EXPIRED', 'F 可復原期過了不能復原');
  const run = await app.runScheduled();
  assert.equal(run.purged?.projects, 1, 'H 排程清除一個專案：' + JSON.stringify(run));
  const left = {};
  for (const [t, sql] of Object.entries({
    messages: 'SELECT COUNT(*) AS n FROM messages WHERE project = ?', cards: 'SELECT COUNT(*) AS n FROM cards WHERE project = ?',
    docs: 'SELECT COUNT(*) AS n FROM docs WHERE project = ?', doc_folders: 'SELECT COUNT(*) AS n FROM doc_folders WHERE project = ?',
    kb_chunks: 'SELECT COUNT(*) AS n FROM kb_chunks WHERE project = ?', kb_pages: 'SELECT COUNT(*) AS n FROM kb_pages WHERE project = ?',
    skills: 'SELECT COUNT(*) AS n FROM skills WHERE project = ?', dms: 'SELECT COUNT(*) AS n FROM dms WHERE project = ?',
    join_requests: 'SELECT COUNT(*) AS n FROM join_requests WHERE project = ?', project_events: 'SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?',
    projects: 'SELECT COUNT(*) AS n FROM projects WHERE id = ?',
  })) left[t] = await n(sql, pid);
  left.settings = await n('SELECT COUNT(*) AS n FROM app_settings WHERE key IN (?, ?, ?, ?, ?, ?)', ...['pcode:', 'slug:', 'repo:', 'roles:', 'pnomax:', 'dm:'].map(k => k + pid));
  assert.ok(Object.values(left).every(v => v === 0), 'H 這個專案的資料都清除了：' + JSON.stringify(left));
  assert.equal(await n('SELECT COUNT(*) AS n FROM notifications WHERE message_id = ?', m1.messageId), 0, 'H 通知清除了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?', m1.messageId), 0, 'H 收件人清除了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM decision_resolutions WHERE message_id = ?', m1.messageId), 0, 'H 決策紀錄清除了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM card_log WHERE card_seq = ?', cardSeq), 0, 'H 卡片紀錄清除了');
  assert.equal(await n("SELECT COUNT(*) AS n FROM files WHERE id = 'fil_del'"), 0, 'H 上傳檔清除了');
  assert.equal(await n("SELECT COUNT(*) AS n FROM file_chunks WHERE file_id = 'fil_del'"), 0, 'H 上傳檔本體清除了');
  assert.equal(await n("SELECT COUNT(*) AS n FROM skill_installs WHERE skill_id = 'sk_del'"), 0, 'H 技能安裝紀錄清除了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM skill_syncs WHERE ai_id = ?', aiOnly.participantId), 0, 'H 刪除的 AI 的同步紀錄清除了');
  assert.ok(!docs.map.has('docs/doc_del') && docs.map.has('docs/doc_keep'), 'H 文件本體清除了、別人的留著');
  // 其他專案與跨專案頻道不動
  assert.equal(await n('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?)', keepPlat.messageId, keepAll.messageId), 2, 'H 另一個專案與跨專案頻道的訊息留著');
  assert.equal(await n("SELECT COUNT(*) AS n FROM files WHERE id = 'fil_keep'"), 1, 'H 另一個專案的上傳檔留著');
  assert.equal(await n("SELECT COUNT(*) AS n FROM cards WHERE project = '預設專案'"), 1, 'H 另一個專案的卡留著');
  for (const t of [liu.token, wang.token, aiBothTok]) assert.equal((await call(t, '/api/me')).status, 200, 'H 帳號留著');
  // 只屬於這個專案的 AI：此時才刪除（跟「刪除 AI」一樣）
  assert.equal(await n('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?', pid), 0, 'H 沒有人還在這個專案（含專案管理員）');
  assert.equal((await db.get('SELECT status FROM participants WHERE id = ?', aiOnly.participantId)).status, 'deleted', 'H 只屬於它的 AI 刪除了');
  assert.equal((await call(aiOnlyTok, '/api/me')).status, 401, 'H 那隻 AI 的 Token 失效');
  assert.ok(!(await call(liu.token, '/api/my-ais')).body.items.some(a => a.participantId === aiOnly.participantId), 'H 我的 AI 清單沒有它');
  for (const key of ['project_roles', 'join_settings']) {
    const v = (await db.get('SELECT value FROM app_settings WHERE key = ?', key))?.value || '';
    assert.ok(!v.includes(pid), `H ${key} 沒有殘留：${v}`);
  }
  assert.deepEqual((await deletedList()).body.items, [], 'H 已刪除的清單沒有它了');
  assert.equal((await restore(liu.token)).status, 404, 'H 清除後不能復原');
  L = await audit('project.purge');
  assert.equal(L.length, 1, 'H 一筆永久清除紀錄');
  assert.deepEqual([L[0].actor.kind, L[0].actor.name, L[0].scope.projectName, L[0].detail?.counts?.cards, L[0].detail?.aisDeleted], ['system', '系統', '要刪的專案', 1, ['只在這裡的AI']], 'H 清除紀錄（操作者是系統）：' + JSON.stringify(L[0]));
  assert.equal((await audit('project.delete')).length, 2, 'H 刪除紀錄在專案清除後仍在');
  assert.deepEqual((await notices(lin)).map(x => x.kind), ['admin_project_delete'], 'G 再刪一次也通知（永久清除不另外通知）');
  assert.equal((await app.runScheduled()).purged?.projects, 0, 'H 沒有到期的就不清');
  // J 舊的刪除紀錄端點
  r = await call(liu.token, '/api/project-deletions');
  assert.equal(r.status, 200, 'J 舊端點照舊可用：' + JSON.stringify(r.body));
  const pd = r.body.items[0];
  assert.deepEqual([pd?.projectId, pd?.name, pd?.code, pd?.by, pd?.byName, pd?.counts?.cards, pd?.aisDeleted], [pid, '要刪的專案', 'DEL', id(liu), '林志明', 1, ['只在這裡的AI']], 'J 形狀跟以前一樣：' + JSON.stringify(pd));
  assert.ok(!Number.isNaN(Date.parse(pd.at)), 'J 有時間');
  assert.equal(r.body.items.length, 1, 'J 只列永久清除了的（可復原期內的不算）');
  assert.equal((await call(lin.token, '/api/project-deletions')).status, 200, 'J 另一位工作區管理員看得到（不用再驗證）');
  assert.equal((await call(wang.token, '/api/project-deletions')).status, 403, 'J 只有管理員看得到刪除紀錄');
  assert.equal((await call(aiBothTok, '/api/project-deletions')).status, 403, 'J AI 看不到');
  // 清除後同名同代號、同網址英文名可以再建
  r = await call(liu.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL', slug: 'to-del' });
  assert.ok(r.status < 300 && r.body.items.some(p => p.name === '要刪的專案' && p.code === 'DEL'), 'H 清除後代碼可以再用：' + JSON.stringify(r.body).slice(0, 200));

  // ---------- I 可復原期 0：刪除當下就永久清除 ----------
  assert.equal((await call(boss.token, '/api/recovery-window', 'PUT', { days: 0 })).status, 200, '工作區可復原期改成 0');
  const p0 = (await call(liu.token, '/api/projects', 'POST', { name: '馬上清除', code: 'NOW' })).body.items.find(p => p.name === '馬上清除').id;
  await post(p0, '馬上清除的訊息');
  assert.equal((await call(liu.token, `/api/projects/${encodeURIComponent(p0)}/archive`, 'POST')).status, 200);
  r = await call(liu.token, `/api/projects/${encodeURIComponent(p0)}/delete-preview`);
  assert.equal(r.body.recoveryDays, 0, 'I 預覽寫 0 天');
  r = await call(boss.token, `/api/projects/${encodeURIComponent(p0)}/delete`, 'POST', { confirmName: '馬上清除' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted.purged, true, 'I 回傳已永久清除');
  assert.equal(await n('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p0), 0, 'I 專案當下就清除了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM messages WHERE project = ?', p0), 0, 'I 訊息當下就清除了');
  assert.deepEqual((await deletedList()).body.items, [], 'I 不會出現在已刪除的清單');
  L = (await audit('project.purge')).filter(e => e.scope.projectId === p0);
  assert.deepEqual([L.length, L[0]?.actor.kind, L[0]?.actor.name], [1, 'system', '系統'], 'I 立即清除也寫稽核紀錄（操作者是系統）：' + JSON.stringify(L));
  assert.deepEqual((await audit('project.delete')).filter(e => e.scope.projectId === p0).map(e => e.actor.name), ['林志明'], 'I 刪除也有紀錄（操作的人）');
  assert.deepEqual((await call(liu.token, '/api/project-deletions')).body.items.map(x => [x.name, x.byName]), [['馬上清除', '林志明'], ['要刪的專案', '林志明']], 'J 舊端點新的在前');
  r = await call(liu.token, '/api/projects', 'POST', { name: '馬上清除', code: 'NOW' });
  assert.ok(r.status < 300, 'I 代碼馬上可以再用：' + JSON.stringify(r.body).slice(0, 200));
  console.log('project-delete-test：全部通過');
} catch (e) {
  console.error('project-delete-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await db?.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
