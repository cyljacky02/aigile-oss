// 驗收測試：每個專案自訂看板狀態
// 狀態＝專案看板上的一欄（名稱、順序、顏色自訂）；狀態類別＝系統固定的七種語意，流程規則只看類別。
// 沒自訂過的專案：API 輸出與看板跟以前一樣（狀態名稱＝類別名稱）。
// 用法：node scripts/project-statuses-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pst-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
// 模擬寫入到一半失敗：開了之後，刪除狀態那一步會出錯（在交易裡就換成一步會失敗的語句，讓資料庫自己回復）
// 模擬同時有人改卡：beforeStatusDelete 在刪除狀態的交易開始前執行一次
// beforeCardWrite 在下一次寫卡片（UPDATE／INSERT cards）之前執行一次（模擬讀完狀態清單、還沒寫進去時狀態被刪）
// beforeStatusInit 在下一次補預設狀態組之前執行一次（模擬初始化慢了一步）
let failStatusDelete = false, beforeStatusDelete = null, beforeCardWrite = null, beforeStatusInit = null;
const STATUS_DELETE = /^DELETE FROM project_statuses WHERE id\b/, CARD_WRITE = /^\s*(UPDATE cards SET|INSERT INTO cards)\b/;
const isStatusDelete = sql => failStatusDelete && STATUS_DELETE.test(sql);
const cardWriteHook = async sqls => { if (beforeCardWrite && sqls.some(q => CARD_WRITE.test(q))) { const f = beforeCardWrite; beforeCardWrite = null; await f(); } };
const appDb = { ...db,
  run: async (sql, ...args) => { await cardWriteHook([sql]); if (isStatusDelete(sql)) throw new Error('模擬寫入失敗'); return db.run(sql, ...args); },
  batch: async stmts => {
    await cardWriteHook(stmts.map(([sql]) => sql));
    if (beforeStatusInit && stmts.some(([sql]) => /^INSERT OR IGNORE INTO project_statuses\b/.test(sql))) { const f = beforeStatusInit; beforeStatusInit = null; await f(); }
    if (beforeStatusDelete && stmts.some(([sql]) => STATUS_DELETE.test(sql))) { const f = beforeStatusDelete; beforeStatusDelete = null; await f(); }
    return db.batch(stmts.map(([sql, args]) => (isStatusDelete(sql) ? ['SELECT x FROM no_such_table', []] : [sql, args])));
  } };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const P = encodeURIComponent('預設專案'), P2 = encodeURIComponent('第二專案');
let rq = 0;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const fail = (r, status, label) => { assert.equal(r.status, status, `${label}：預期 ${status}，實際 ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位人類＝管理員
  const mkCard = (tok, body) => call(tok, '/api/cards', 'POST', { requestId: 'c' + (++rq), project: '預設專案', title: '卡 ' + rq, ...body });
  const statuses = async (pj = P, tok = boss.token) => ok(await call(tok, `/api/projects/${pj}/statuses`), '讀狀態').items;

  // 1) 沒自訂過的專案：預設狀態組＝現在的六欄，名稱就是類別名稱，順序照看板
  {
    const items = await statuses();
    assert.deepEqual(items.map(s => s.name), ['待整理', '待處理', '進行中', '受阻', '待確認', '已完成']);
    assert.deepEqual(items.map(s => s.category), ['待整理', '待處理', '進行中', '受阻', '待確認', '已完成']);
    assert.ok(items.every(s => s.id && s.color), '每個狀態有 id 與顏色');
    const c = ok(await mkCard(boss.token, {}), '建卡');
    assert.equal(c.status, '待整理', '預設進待整理，輸出跟以前一樣');
    assert.equal(c.category, '待整理');
    assert.equal(c.statusId, items[0].id, 'statusId 指向那個狀態');
  }

  // 其他成員：leader（預設專案）、一般成員、AI
  const lead = (await call(null, '/api/join', 'POST', { name: '陳小美', role: 'SM' })).body;
  const member = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PG' })).body;
  ok(await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: lead.participant.participantId, leaderOf: ['預設專案'] }] }), '指定 leader');
  const mkAi = async name => { const a = ok(await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案', '第二專案'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }), '建 AI'); return { id: a.participantId, name, tok: await testToken(db, a.participantId) }; };
  const ai = await mkAi('甲PG');
  const add = (body, tok = boss.token, pj = P) => call(tok, `/api/projects/${pj}/statuses`, 'POST', body);
  const patchSt = (id, body, tok = boss.token, pj = P) => call(tok, `/api/projects/${pj}/statuses/${id}`, 'PATCH', body);
  const del = (id, body = {}, tok = boss.token, pj = P) => call(tok, `/api/projects/${pj}/statuses/${id}`, 'DELETE', body);
  const byName = async (name, pj = P) => (await statuses(pj)).find(s => s.name === name);
  const getCard = async id => ok(await call(boss.token, `/api/cards/${id}`), '讀卡');
  const patchCard = async (id, body, tok = boss.token) => call(tok, `/api/cards/${id}`, 'PATCH', body);

  // 2) 權限：管理員、該專案 leader 能改；一般成員、AI 不能（但看得到專案就讀得到）
  {
    fail(await add({ name: '一般人加的', category: '進行中' }, member.token), 403, '一般成員不能改');
    fail(await add({ name: 'AI 加的', category: '進行中' }, ai.tok), 403, 'AI 不能改');
    assert.equal((await statuses(P, ai.tok)).length, 6, 'AI 讀得到');
    const items = ok(await add({ name: '測試中', category: '進行中' }, lead.token), 'leader 新增').items;
    assert.equal(items.at(-1).name, '測試中', '新狀態排在最後');
    assert.equal(items.at(-1).color, 'amber', '預設用類別的顏色');
  }

  // 3) 改名不影響卡片：待確認 → Review；卡片跟著顯示新名稱、類別不變、舊紀錄不改寫
  {
    const c = ok(await mkCard(boss.token, { status: '待處理' }), '建卡');
    ok(await patchCard(c.cardId, { status: '待確認' }), '改待確認');
    const review = await byName('待確認');
    ok(await patchSt(review.id, { name: 'Review' }), '改名');
    const d = await getCard(c.cardId);
    assert.equal(d.status, 'Review'); assert.equal(d.category, '待確認'); assert.equal(d.statusId, review.id);
    assert.ok(d.log.some(l => l.text === '狀態 待處理 → 待確認'), '舊紀錄保留當時的名稱');
    ok(await patchCard(c.cardId, { status: 'Review' }), '送同一個狀態：不變');
    assert.equal((await getCard(c.cardId)).version, d.version, '沒有改動');
  }

  // 4) status 輸入：狀態名稱 → 狀態 ID → 類別名稱（對到該類別排最前面的）；同類別只換欄、留「移到」紀錄
  {
    const testing = await byName('測試中'), doing = await byName('進行中');
    ok(await patchSt(doing.id, { name: '開發中' }), '改名後「進行中」只剩類別名稱的意思');
    const c = ok(await mkCard(boss.token, { status: '測試中' }), '用名稱建卡');
    assert.equal(c.status, '測試中'); assert.equal(c.category, '進行中');
    let r = ok(await patchCard(c.cardId, { status: '進行中' }), '用類別名稱');
    assert.equal(r.statusId, doing.id, '類別名稱對到該類別第一個狀態'); assert.equal(r.status, '開發中');
    r = ok(await patchCard(c.cardId, { status: String(testing.id) }), '用 ID');
    assert.equal(r.status, '測試中');
    const d = await getCard(c.cardId);
    assert.ok(d.log.some(l => l.text === '移到 測試中'), '同類別移動留紀錄');
    assert.ok(!d.log.some(l => /標為已完成|完成/.test(l.text)), '沒觸發規則');
    const e = fail(await patchCard(c.cardId, { status: '不存在的欄' }), 400, '不存在的狀態');
    assert.match(e.error.message, /測試中/, '錯誤列出可用的狀態');
    // 系統自動移動：[接單] 落在「進行中」類別排最前面的狀態（把測試中排到最前面）
    const order = (await statuses()).map(s => s.id);
    ok(await call(boss.token, `/api/projects/${P}/statuses/order`, 'PUT', { ids: [testing.id, ...order.filter(id => id !== testing.id)] }), '重新排序');
    assert.equal((await statuses())[0].name, '測試中');
    const w = ok(await mkCard(ai.tok, { ownerId: ai.id, status: '待處理' }), 'AI 建卡');
    const m = ok(await call(ai.tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'm' + (++rq), text: '[接單] 開始', cardId: w.cardId, recipientIds: [], replyFrom: [] }), '接單');
    assert.equal(m.cardStatus, '測試中', '回傳實際的狀態名稱');
    assert.equal((await getCard(w.cardId)).statusId, testing.id);
    // 按類別停留在原本的欄：之前在「進行中」的卡不會因為排序改變而跳欄
    const stay = ok(await mkCard(boss.token, { status: '進行中' }), '建卡');
    assert.equal(stay.statusId, testing.id, '類別名稱對到現在排最前面的');
    ok(await patchCard(stay.cardId, { status: String(doing.id) }), '改到進行中欄');
    ok(await call(boss.token, `/api/projects/${P}/statuses/order`, 'PUT', { ids: order }), '排回來');
    assert.equal((await getCard(stay.cardId)).statusId, doing.id, '卡片留在原來的欄');
  }

  // 5) 名稱與數量規則：同專案不重複、最多 20 字、不能取別的類別的名稱；每專案最多 12 個
  {
    fail(await add({ name: '測試中', category: '待處理' }), 400, '名稱重複');
    fail(await add({ name: '待確認', category: '進行中' }), 400, '不能取別的類別的名稱');
    fail(await add({ name: '一'.repeat(21), category: '進行中' }), 400, '太長');
    fail(await add({ name: '封存區', category: '已封存' }), 400, '已封存由系統管理');
    fail(await add({ name: '亮色', category: '進行中', color: 'neon' }), 400, '顏色要從調色盤選');
    ok(await add({ name: '另一個進行中', category: '待處理' }), '自己類別以外的名稱都行（這個只是字面像）');
    const n = (await statuses()).length;
    for (let i = n; i < 12; i++) ok(await add({ name: '欄' + i, category: '待處理' }), '補到 12 個');
    fail(await add({ name: '欄 13', category: '待處理' }), 400, '最多 12 個');
    for (const s of (await statuses()).filter(s => /^欄\d+$|^另一個/.test(s.name))) ok(await del(s.id), '空的狀態直接刪');
  }

  // 6) 刪除：有卡要選目標（跨類別照規則）、必要類別最後一個不能刪；只有空的狀態能改類別
  {
    const testing = await byName('測試中'), dev = await byName('開發中'), done = await byName('已完成');
    const c = ok(await mkCard(boss.token, { status: '測試中' }), '建卡');
    fail(await patchSt(testing.id, { category: '待處理' }), 409, '有卡不能改類別');
    fail(await del(testing.id), 409, '有卡要指定 moveTo');
    fail(await del(testing.id, { moveTo: testing.id }), 400, '不能搬到自己');
    const inTesting = ok(await call(boss.token, `/api/cards?status=${encodeURIComponent('測試中')}&project=${P}`), '用狀態名稱篩選').items;
    assert.deepEqual(inTesting.map(x => x.status), inTesting.map(() => '測試中'), '篩出來的都在測試中');
    assert.ok(inTesting.some(x => x.cardId === c.cardId));
    const r = ok(await del(testing.id, { moveTo: done.id }), '刪除並搬到已完成');
    assert.equal(r.moved, inTesting.length, '裡面的卡全部搬走');
    assert.ok(!r.items.some(s => s.id === testing.id), '狀態刪掉了');
    const d = await getCard(c.cardId);
    assert.equal(d.status, '已完成'); assert.ok(d.done, '跨類別照規則：記完成者');
    assert.ok(d.log.some(l => l.text === '狀態 測試中 → 已完成'), '紀錄寫當時的名稱');
    fail(await del(dev.id), 409, '最後一個進行中不能刪');
    const tmp = ok(await add({ name: '暫存', category: '待處理' }), '新增').items.at(-1);
    const moved = ok(await patchSt(tmp.id, { category: '受阻', color: 'violet' }), '空的狀態改類別').items.find(s => s.id === tmp.id);
    assert.equal(moved.category, '受阻'); assert.equal(moved.color, 'violet');
    ok(await del(tmp.id), '刪掉');
  }

  // 7) 決策卡擋住刪除：還有未決定的決策卡 → 最後一個待確認不能刪；還有暫緩中的 → 最後一個受阻不能刪
  {
    const review = await byName('Review'), blocked = await byName('受阻'), todo = await byName('待處理');
    const dc = ok(await mkCard(boss.token, { type: '決策', title: '要不要改版', question: '要不要改版？', options: ['要', '不要'] }), '建決策卡');
    assert.equal(dc.status, 'Review', '決策卡在待確認類別的狀態');
    let e = fail(await del(review.id, { moveTo: todo.id }), 409, '有未決定的決策卡');
    assert.equal(e.error.code, 'HAS_DECISIONS'); assert.deepEqual(e.error.cards, [dc.cardId], '列出卡住的卡');
    ok(await call(boss.token, `/api/cards/${dc.cardId}/defer`, 'POST', { reason: '下季再說' }), '暫緩');
    e = fail(await del(blocked.id, { moveTo: todo.id }), 409, '有暫緩中的決策卡');
    assert.equal(e.error.code, 'HAS_DEFERRED');
    ok(await call(boss.token, `/api/cards/${dc.cardId}/resume`, 'POST', {}), '恢復');
    assert.equal((await getCard(dc.cardId)).status, 'Review', '恢復回到待確認類別');
  }

  // 8) 拿掉可選類別（第二專案只留 待處理、進行中、已完成）：相關功能停用
  {
    for (const name of ['待整理', '受阻', '待確認']) ok(await del((await byName(name, P2)).id, {}, boss.token, P2), `拿掉${name}`);
    assert.deepEqual((await statuses(P2)).map(s => s.category), ['待處理', '進行中', '已完成']);
    fail(await del((await byName('已完成', P2)).id, {}, boss.token, P2), 409, '必要類別最後一個不能刪');
    const c = ok(await mkCard(ai.tok, { project: '第二專案', ownerId: ai.id }), '沒有待整理：新卡進待處理');
    assert.equal(c.category, '待處理');
    assert.equal(ok(await mkCard(ai.tok, { project: '第二專案', status: '待整理' }), '舊 AI 送待整理').category, '待處理');
    assert.equal(fail(await mkCard(boss.token, { project: '第二專案', type: '阻塞' }), 400, '沒有受阻：不能建阻塞卡').error.code, 'NO_BLOCKED_STATUS');
    assert.equal(fail(await mkCard(boss.token, { project: '第二專案', type: '決策', question: 'q' }), 400, '沒有待確認：不能建決策卡').error.code, 'NO_CONFIRM_STATUS');
    fail(await patchCard(c.cardId, { status: '受阻' }, ai.tok), 400, '沒有受阻類別的狀態');
    // AI 交給人類：沒有待確認 → 移到進行中、負責人換人類，不進入請驗收
    const h = ok(await call(ai.tok, `/api/cards/${c.cardId}/handover`, 'POST', { toId: boss.participant.participantId, progress: '做完了', nextStep: '請看' }), '交接');
    assert.equal(h.category, '進行中'); assert.equal(h.owner.participantId, boss.participant.participantId); assert.equal(h.waitFor, null);
  }

  // 9) 搬卡到別的專案：落在同類別第一個狀態；沒有待整理就進待處理；沒有受阻、待確認就拒絕
  {
    const toP2 = id => patchCard(id, { project: '第二專案' });
    const triage = ok(await mkCard(boss.token, {}), '待整理的卡');
    let r = ok(await toP2(triage.cardId), '搬待整理');
    assert.equal(r.category, '待處理'); assert.equal(r.statusId, (await byName('待處理', P2)).id);
    const doing = ok(await mkCard(boss.token, { status: '開發中' }), '進行中的卡');
    r = ok(await toP2(doing.cardId), '搬進行中');
    assert.equal(r.status, '進行中'); assert.equal(r.statusId, (await byName('進行中', P2)).id);
    const blockedCard = ok(await mkCard(boss.token, { type: '阻塞', blocker: '等廠商' }), '阻塞卡');
    assert.equal(fail(await toP2(blockedCard.cardId), 400, '目標專案沒有受阻').error.code, 'NO_BLOCKED_STATUS');
    const blockedWork = ok(await mkCard(boss.token, { status: '受阻' }), '受阻的工作卡');
    assert.equal(fail(await toP2(blockedWork.cardId), 400, '目標專案沒有受阻類別').error.code, 'NO_SUCH_CATEGORY');
    const dc = ok(await mkCard(boss.token, { type: '決策', question: '哪個？', options: ['A', 'B'] }), '決策卡');
    assert.equal(fail(await toP2(dc.cardId), 400, '目標專案沒有待確認').error.code, 'NO_CONFIRM_STATUS');
  }

  // 10) AI 建議記狀態 ID；採用前狀態被刪就拒絕，不自動改成別的狀態
  {
    const queue = ok(await add({ name: '排隊中', category: '待處理' }), '新增').items.at(-1);
    const c = ok(await mkCard(boss.token, { status: '開發中' }), '人類的卡');
    const sug = ok(await call(ai.tok, '/api/suggestions', 'POST', { requestId: 's' + (++rq), kind: 'status', cardId: c.cardId, status: '排隊中', why: '還沒開始' }), '建議');
    const sug2 = ok(await call(ai.tok, '/api/suggestions', 'POST', { requestId: 's' + (++rq), kind: 'status', cardId: (ok(await mkCard(boss.token, {}), '另一張')).cardId, status: '排隊中', why: '排隊' }), '建議 2');
    const applied = ok(await call(boss.token, `/api/suggestions/${sug2.suggestionId}/apply`, 'POST', {}), '採用');
    assert.equal(applied.status, '排隊中', '採用後在建議的那個狀態');
    ok(await del(queue.id, { moveTo: (await byName('待處理')).id }), '刪掉建議的狀態');
    assert.equal(fail(await call(boss.token, `/api/suggestions/${sug.suggestionId}/apply`, 'POST', {}), 409, '狀態已刪除').error.code, 'STATUS_DELETED');
    assert.equal((await getCard(c.cardId)).status, '開發中', '卡片沒被改');
  }

  // 11) 建立專案時直接給狀態清單；專案資料附上狀態清單；必要類別不能少
  {
    const three = [{ name: 'Todo', category: '待處理' }, { name: 'Doing', category: '進行中' }, { name: 'Done', category: '已完成', color: 'blue' }];
    fail(await call(boss.token, '/api/projects', 'POST', { name: '缺完成', statuses: three.slice(0, 2).concat({ name: 'X', category: '待處理' }) }), 400, '缺必要類別');
    fail(await call(member.token, '/api/projects', 'POST', { name: '非管理員', statuses: three }), 403, '只有管理員建專案');
    const r = ok(await call(boss.token, '/api/projects', 'POST', { name: '精簡專案', statuses: three }), '建專案');
    const pj = r.items.find(p => p.id === r.id);
    assert.deepEqual(pj.statuses.map(s => [s.name, s.category, s.color]), [['Todo', '待處理', 'indigo'], ['Doing', '進行中', 'amber'], ['Done', '已完成', 'blue']]);
    const plain = ok(await call(boss.token, '/api/projects', 'POST', { name: '預設組專案' }), '建專案（不給狀態）');
    assert.equal(plain.items.find(p => p.id === plain.id).statuses.length, 6, '沒給就是預設狀態組');
    const doing = pj.statuses.find(s => s.name === 'Doing');
    fail(await patchSt(doing.id, { category: '待處理' }, boss.token, encodeURIComponent(r.id)), 400, '改類別不能清掉必要類別');
    fail(await del(doing.id, {}, boss.token, encodeURIComponent(r.id)), 409, '最少 3 個、必要類別不能刪');
  }

  // 12) 類別沒變就不換欄：卡在第二個待確認類別的狀態（QA 審核），AI 交給人類（請驗收）後仍在 QA 審核
  {
    const qa = ok(await add({ name: 'QA 審核', category: '待確認' }), '新增').items.at(-1);
    const c = ok(await mkCard(ai.tok, { ownerId: ai.id, status: 'QA 審核' }), 'AI 建卡');
    const h = ok(await call(ai.tok, `/api/cards/${c.cardId}/handover`, 'POST', { toId: boss.participant.participantId, progress: '做完', nextStep: '請驗收' }), '交給人類');
    assert.equal(h.statusId, qa.id, '還在 QA 審核，沒跳到第一個待確認類別的狀態');
    assert.equal(h.waitFor.participantId, boss.participant.participantId, '等人類驗收');
  }

  // 13) 卡片清單的 status 篩選跟 PATCH 同一個順序：狀態名稱 → 狀態 ID → 類別名稱
  //     預設專案的「待處理」類別有兩個狀態（待處理、待辦）：status=待處理 是那個狀態，不是整個類別；別的專案照類別
  {
    const later = ok(await add({ name: '待辦', category: '待處理' }), '新增').items.at(-1);
    const a = ok(await mkCard(boss.token, { status: '待處理' }), '待處理的卡');
    const b = ok(await mkCard(boss.token, { status: '待辦' }), '待辦的卡');
    const other = ok(await mkCard(boss.token, { project: '第二專案', status: '待處理' }), '第二專案待處理的卡');
    const list = async qs => ok(await call(boss.token, `/api/cards?limit=200&${qs}`), '篩選').items.map(x => x.cardId);
    let ids = await list(`status=${encodeURIComponent('待處理')}&project=${P}`);
    assert.ok(ids.includes(a.cardId) && !ids.includes(b.cardId), '狀態名稱優先：只有「待處理」那個狀態');
    ids = await list(`status=${later.id}&project=${P}`);
    assert.ok(ids.includes(b.cardId) && !ids.includes(a.cardId), '狀態 ID');
    ids = await list(`status=${encodeURIComponent('待處理')}`);
    assert.ok(ids.includes(a.cardId) && !ids.includes(b.cardId) && ids.includes(other.cardId), '不指定專案：各專案各自比對');
    ids = await list(`status=${encodeURIComponent('進行中')}&project=${P}`);
    const dev = ok(await call(boss.token, `/api/cards?limit=200&status=${encodeURIComponent('開發中')}&project=${P}`), '開發中').items.map(x => x.cardId);
    assert.ok(dev.length && dev.every(id => ids.includes(id)), '沒有叫「進行中」的狀態：照類別');
  }

  // 14) 成員被移出專案、改唯讀、AI 被刪除：卡退回第一個待處理類別的狀態，卡片紀錄與專案異動寫狀態名稱
  {
    ok(await patchSt((await byName('待處理', P2)).id, { name: '排隊' }, boss.token, P2), '改名');
    const h = (await call(null, '/api/join', 'POST', { name: '趙小華', role: 'PG' })).body, hid = h.participant.participantId;
    const join = async () => ok(await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: hid, projects: ['預設專案', '第二專案'] }] }), '加入兩個專案');
    const mk2 = async owner => ok(await mkCard(boss.token, { project: '第二專案', ownerId: owner, status: '進行中' }), '第二專案的卡');
    const logged = async id => (await getCard(id)).log.map(l => l.text);
    const events = async () => ok(await call(boss.token, `/api/projects/${P2}/events`), '異動紀錄').items.map(e => e.text);
    await join();
    const removed = await mk2(hid);
    ok(await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: hid, projects: ['預設專案'] }] }), '移出第二專案');
    assert.equal((await getCard(removed.cardId)).status, '排隊');
    assert.ok((await logged(removed.cardId)).some(t => t.includes('狀態 進行中 → 排隊')), '移出：紀錄寫狀態名稱');
    assert.ok((await events()).some(t => t.includes('1 張卡退回排隊')), '移出：專案異動寫狀態名稱');
    await join();
    const ro = await mk2(hid);
    ok(await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: hid, readOnlyIn: ['第二專案'] }] }), '設唯讀');
    assert.ok((await logged(ro.cardId)).some(t => t.includes('狀態 進行中 → 排隊')), '唯讀：紀錄寫狀態名稱');
    assert.ok((await events()).some(t => /設為唯讀（1 張卡退回排隊）/.test(t)), '唯讀：專案異動寫狀態名稱');
    const aiCard = await mk2(ai.id);
    ok(await call(boss.token, `/api/my-ais/${ai.id}/delete`, 'POST', { confirmName: ai.name }), '刪除 AI');
    assert.ok((await logged(aiCard.cardId)).some(t => t.includes('狀態 進行中 → 排隊')), 'AI 刪除：紀錄寫狀態名稱');
  }

  // 15) 刪除有卡的狀態是一個動作：中途失敗就一張卡都沒搬、狀態還在
  {
    const box = ok(await add({ name: '暫放', category: '待處理' }), '新增').items.at(-1);
    const cards = [ok(await mkCard(boss.token, { status: '暫放' }), '卡 1'), ok(await mkCard(boss.token, { status: '暫放' }), '卡 2')];
    failStatusDelete = true;
    try { assert.ok((await del(box.id, { moveTo: (await byName('開發中')).id })).status >= 500, '刪除失敗'); }
    finally { failStatusDelete = false; }
    assert.ok(await byName('暫放'), '狀態還在');
    for (const c of cards) {
      const d = await getCard(c.cardId);
      assert.equal(d.status, '暫放', '卡片沒搬'); assert.equal(d.version, c.version, '卡片沒改');
      assert.ok(!d.log.some(l => /開發中/.test(l.text)), '沒有搬卡紀錄');
    }
    const r = ok(await del(box.id, { moveTo: (await byName('開發中')).id }), '再刪一次');
    assert.equal(r.moved, 2);
    for (const c of cards) assert.equal((await getCard(c.cardId)).status, '開發中', '都搬過去了');
  }

  // 16) 刪除時剛好有人改了裡面的卡：整個不做、回 409（不然那張卡會留在已經沒有的「受阻」類別、從看板消失）
  {
    const blocked = await byName('受阻'), dev = await byName('開發中');
    const c = ok(await mkCard(boss.token, { status: '受阻' }), '受阻的卡');
    beforeStatusDelete = async () => ok(await patchCard(c.cardId, { title: '同時改的標題' }), '同時有人改卡');
    assert.equal(fail(await del(blocked.id, { moveTo: dev.id }), 409, '卡片剛被改過').error.code, 'CONFLICT');
    assert.equal(beforeStatusDelete, null, '真的有同時改卡');
    assert.ok(await byName('受阻'), '狀態還在');
    const d = await getCard(c.cardId);
    assert.equal(d.status, '受阻', '卡片沒搬'); assert.equal(d.title, '同時改的標題', '別人的修改還在');
    ok(await del(blocked.id, { moveTo: dev.id }), '重新讀取後再刪');
    assert.equal((await getCard(c.cardId)).status, '開發中');
  }

  // 17) 刪除時剛好有卡搬進來（狀態原本是空的、是這個類別最後一個）：整個不做、回 409，卡片留在它搬進去的狀態
  {
    const stuck = ok(await add({ name: '卡住', category: '受阻' }), '新增').items.at(-1);
    const c = ok(await mkCard(boss.token, { status: '開發中' }), '卡');
    beforeStatusDelete = async () => ok(await patchCard(c.cardId, { status: '卡住' }), '同時有卡搬進來');
    assert.equal(fail(await del(stuck.id), 409, '剛有卡搬進來').error.code, 'CONFLICT');
    assert.equal(beforeStatusDelete, null, '真的有同時搬卡');
    assert.ok(await byName('卡住'), '狀態還在');
    assert.equal((await getCard(c.cardId)).status, '卡住', '卡片在看板上的「卡住」');
  }

  // 18) 寫卡片時狀態剛被刪（已經讀到狀態清單、還沒寫進去）：改狀態、建卡、採用建議建卡都回 409 STATUS_DELETED，不會留下沒有欄的卡
  {
    const dev = await byName('開發中');
    ok(await del((await byName('卡住')).id, { moveTo: dev.id }), '清掉上一段的卡住');
    const blockedOnly = async name => { const s = ok(await add({ name, category: '受阻' }), '新增').items.at(-1); beforeCardWrite = async () => ok(await del(s.id), '同時刪掉狀態'); return s; };
    const c = ok(await mkCard(boss.token, { status: '開發中' }), '卡');
    await blockedOnly('卡住2');
    assert.equal(fail(await patchCard(c.cardId, { status: '卡住2' }), 409, '改狀態').error.code, 'STATUS_DELETED');
    assert.equal(beforeCardWrite, null, '真的有同時刪');
    assert.equal((await getCard(c.cardId)).status, '開發中', '卡片沒改');
    await blockedOnly('卡住3');
    assert.equal(fail(await mkCard(boss.token, { status: '卡住3', title: '不該建立的卡' }), 409, '建卡').error.code, 'STATUS_DELETED');
    assert.equal(ok(await call(boss.token, `/api/cards?q=${encodeURIComponent('不該建立')}&include=archived`), '搜尋').items.length, 0, '沒有建出卡');
    const ai2 = await mkAi('乙PG');
    const sug = ok(await call(ai2.tok, '/api/suggestions', 'POST', { requestId: 's' + (++rq), kind: 'create', project: '預設專案', title: '建議的阻塞卡', type: '阻塞', blocker: '等廠商', ownerId: boss.participant.participantId, why: '卡住了' }), '建議建卡');
    await blockedOnly('卡住4');
    assert.equal(fail(await call(boss.token, `/api/suggestions/${sug.suggestionId}/apply`, 'POST', {}), 409, '採用建議').error.code, 'STATUS_DELETED');
    assert.equal(ok(await call(boss.token, `/api/cards?q=${encodeURIComponent('建議的阻塞')}&include=archived`), '搜尋').items.length, 0, '沒有建出卡');
  }

  // 19) 兩個請求都發現專案還沒有狀態：一個先補好、使用者接著拿掉「受阻」，慢的那個再補也不會把它加回來
  {
    let pj = null;
    beforeStatusInit = async () => {
      pj = (await db.get('SELECT p.id FROM projects p WHERE NOT EXISTS (SELECT 1 FROM project_statuses s WHERE s.project = p.id)')).id;
      const P3 = encodeURIComponent(pj);
      ok(await del((await byName('受阻', P3)).id, {}, boss.token, P3), '另一個請求補好之後拿掉受阻');
    };
    ok(await call(boss.token, '/api/projects', 'POST', { name: '初始化慢一步' }), '建專案（不給狀態）');
    assert.ok(pj && beforeStatusInit === null, '真的有兩個初始化');
    assert.deepEqual((await statuses(encodeURIComponent(pj))).map(s => s.name), ['待整理', '待處理', '進行中', '待確認', '已完成'], '拿掉的受阻沒有被加回來');
  }

  // 20) 卡片清單的 status 篩選跟 PATCH 一樣解讀輸入：前後空白、前面補 0 的 ID；all＝不篩；
  //     status_id 對不上的卡（舊資料）算在同類別第一個狀態（ADR 0001）
  {
    const todo = await byName('待處理'), later = await byName('待辦');
    const a = ok(await mkCard(boss.token, { status: '待處理', title: '狀態對不上的卡' }), '卡');
    const b = ok(await mkCard(boss.token, { status: '待辦' }), '待辦的卡');
    await db.run('UPDATE cards SET status_id = 999999 WHERE project = ? AND title = ?', '預設專案', '狀態對不上的卡'); // 舊資料：指向不存在的狀態
    assert.equal((await getCard(a.cardId)).status, '待處理', '讀卡時算在第一個待處理類別的狀態');
    const list = async qs => ok(await call(boss.token, `/api/cards?limit=200&project=${P}&${qs}`), '篩選').items.map(x => x.cardId);
    for (const v of ['待處理', ' 待處理 ', String(todo.id), '00' + todo.id]) {
      const ids = await list(`status=${encodeURIComponent(v)}`);
      assert.ok(ids.includes(a.cardId) && !ids.includes(b.cardId), `status=「${v}」：只有待處理那個狀態，含 status_id 對不上的卡`);
    }
    assert.ok((await list(`status=${encodeURIComponent(' ' + later.id)}`)).includes(b.cardId), 'ID 前後空白');
    assert.deepEqual((await list('status=all')).sort(), (await list('')).sort(), 'all＝不篩（跟 MCP 一樣）');
  }

  console.log('project-statuses-test：全部通過');
} finally {
  db.close?.();
}
