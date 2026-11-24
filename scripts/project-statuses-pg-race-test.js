// 驗收測試（Postgres）：刪除狀態與寫卡片「兩個交易同時進行」時，卡片不會留在已刪除的狀態
// SQLite、D1 的寫入一次只做一個交易，不會這樣交錯；Postgres 會，所以只在設了 AIGILE_TEST_PG_URL 時跑。
// 做法：先開始的那個請求做到某一句之後停住（交易還開著、鎖還拿著：在那句後面插一句等測試手上的 advisory lock），
// 再送另一個請求，等它被鎖住（或沒被鎖住、直接做完），測試才放行第一個。順序固定，每次結果一樣。
// 每一段最後都檢查：沒有未封存的卡指向不存在、別的專案或別的類別的狀態。
// 用法：AIGILE_TEST_PG_URL=postgres://…@127.0.0.1/… node scripts/project-statuses-pg-race-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

if (!TEST_PG_URL) { console.log('project-statuses-pg-race-test：略過（只有 Postgres 會有兩個寫入交易同時進行）'); process.exit(0); }
const { default: pg } = await import('pg');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pgrace-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const ctl = new pg.Client({ connectionString: TEST_PG_URL }); // 測試自己的連線：拿 advisory lock、看誰在等鎖
await ctl.connect();

// 下一個含有符合 re 那句的交易，做完那句就停住，等測試放行（只作用一次）
let pause = null;
const appDb = { ...db, batch: stmts => {
  const p = pause && stmts.some(([sql]) => pause.re.test(sql)) ? pause : null;
  if (p) pause = null;
  return db.batch(p ? stmts.flatMap(st => (p.re.test(st[0]) ? [st, [`SELECT pg_advisory_xact_lock(${p.key})`, []]] : [st])) : stmts);
} };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('等太久：' + label); await new Promise(r => setTimeout(r, 25)); } };
const lockWait = like => ctl.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]).then(r => r.rows[0].n > 0);

// first 做到 re 那句停住 → second 開始，等它被鎖住或做完 → 放行 first；回傳兩邊的回應
let lockKey = 4_236_900_100;
async function race({ re, first, second, secondSql }) {
  const key = ++lockKey;
  await ctl.query('SELECT pg_advisory_lock($1)', [key]);
  pause = { re, key };
  const p1 = first();
  await until(() => lockWait('%pg_advisory_xact_lock%'), 10000, '第一個請求停在交易中');
  let done2 = false;
  const p2 = second().finally(() => { done2 = true; });
  await until(async () => done2 || await lockWait(secondSql), 10000, '第二個請求被鎖住或做完');
  const blocked = !done2;
  await ctl.query('SELECT pg_advisory_unlock($1)', [key]);
  return { r1: await p1, r2: await p2, blocked };
}

const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
let pj = '預設專案', P = encodeURIComponent(pj); // 每一段用一個新專案，彼此不影響
// 不變條件：這個專案未封存的卡都指向同專案、同類別、還存在的狀態
const stranded = async () => (await db.all(`SELECT c.seq, c.status, c.status_id FROM cards c WHERE c.project = ? AND c.status != '已封存'
  AND (c.status_id IS NULL OR NOT EXISTS (SELECT 1 FROM project_statuses ps WHERE ps.id = c.status_id AND ps.project = c.project AND ps.category = c.status))`, pj));
try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  let rq = 0;
  const mkCard = body => call(boss.token, '/api/cards', 'POST', { requestId: 'c' + (++rq), project: pj, title: '卡 ' + rq, ...body });
  const items = async () => ok(await call(boss.token, `/api/projects/${P}/statuses`), '讀狀態').items;
  const add = async (name, category) => ok(await call(boss.token, `/api/projects/${P}/statuses`, 'POST', { name, category }), '新增狀態').items.find(s => s.name === name);
  const del = (id, body = {}) => () => call(boss.token, `/api/projects/${P}/statuses/${id}`, 'DELETE', body);
  const getCard = async id => ok(await call(boss.token, `/api/cards/${id}`), '讀卡');
  const fresh = async name => { const r = ok(await call(boss.token, '/api/projects', 'POST', { name }), '建專案'); pj = r.id; P = encodeURIComponent(pj); await items(); };
  const DELETE_DONE = /^INSERT INTO project_events\b/; // 刪除／改類別交易的最後一句（檢查完、還沒提交）

  // 1) 先刪狀態（停在提交前），同時有人把卡改到那個狀態：改卡片要等刪除做完，然後回 409 STATUS_DELETED
  {
    await fresh('競態一');
    const qa = await add('QA', '待確認');
    const c = ok(await mkCard({ status: '進行中' }), '建卡');
    const { r1, r2, blocked } = await race({ re: DELETE_DONE, first: del(qa.id), second: () => call(boss.token, `/api/cards/${c.cardId}`, 'PATCH', { status: 'QA' }), secondSql: '%UPDATE cards%' });
    assert.equal(r1.status, 200, '刪除成功：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '改卡片要等刪除的交易做完');
    assert.equal(r2.status, 409, '改卡片：' + JSON.stringify(r2.body).slice(0, 200)); assert.equal(r2.body.error?.code, 'STATUS_DELETED');
    assert.equal((await getCard(c.cardId)).status, '進行中', '卡片沒改');
    assert.deepEqual(await stranded(), [], '沒有卡指向不存在的狀態');
  }

  // 2) 先建卡（停在 INSERT 之後），同時刪掉那個狀態：刪除要等建卡做完，然後回 409 CONFLICT，狀態與卡都還在
  {
    await fresh('競態二');
    const hold = await add('擱置', '受阻');
    const { r1, r2, blocked } = await race({ re: /^\s*INSERT INTO cards\b/, first: () => mkCard({ status: '擱置', title: '同時建的卡' }), second: del(hold.id), secondSql: '%DELETE FROM project_statuses%' });
    assert.equal(r1.status, 201, '建卡成功：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '刪除要等建卡的交易做完');
    assert.equal(r2.status, 409, '刪除：' + JSON.stringify(r2.body).slice(0, 200)); assert.equal(r2.body.error?.code, 'CONFLICT');
    assert.ok((await items()).some(s => s.id === hold.id), '狀態還在');
    assert.equal((await getCard(r1.body.cardId)).status, '擱置');
    assert.deepEqual(await stranded(), [], '沒有卡指向不存在的狀態');
  }

  // 3) 先刪掉最後一個「受阻」（停在提交前），同時暫緩一張決策卡（系統依類別移到受阻）：暫緩回 409，卡留在待確認
  {
    await fresh('競態三');
    const dc = ok(await mkCard({ type: '決策', question: '要不要？', options: ['要', '不要'] }), '決策卡');
    const blocked0 = (await items()).find(s => s.category === '受阻');
    const { r1, r2, blocked } = await race({ re: DELETE_DONE, first: del(blocked0.id), second: () => call(boss.token, `/api/cards/${dc.cardId}/defer`, 'POST', { reason: '下季' }), secondSql: '%UPDATE cards%' });
    assert.equal(r1.status, 200, '刪除成功：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '暫緩要等刪除的交易做完');
    assert.equal(r2.status, 409, '暫緩：' + JSON.stringify(r2.body).slice(0, 200)); assert.equal(r2.body.error?.code, 'STATUS_DELETED');
    assert.equal((await getCard(dc.cardId)).category, '待確認', '卡片沒改');
    assert.deepEqual(await stranded(), [], '沒有卡指向不存在的狀態');
  }

  // 4) 先刪掉排最前面的「進行中」（停在提交前），同時 AI 發 [接單]（系統移到進行中類別第一個狀態）：落在剩下的那個進行中狀態
  {
    await fresh('競態四');
    const doing2 = await add('進行中二', '進行中');
    const doing = (await items()).find(s => s.name === '進行中');
    const a = ok(await call(boss.token, '/api/my-ais', 'POST', { projects: [pj], roleKey: 'PG', role: 'PG', name: '甲PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }), '建 AI');
    const aiTok = await testToken(db, a.participantId);
    const w = ok(await mkCard({ status: '待處理', ownerId: a.participantId }), 'AI 的卡');
    const { r1, r2, blocked } = await race({ re: DELETE_DONE, first: del(doing.id, { moveTo: doing2.id }),
      second: () => call(aiTok, '/api/messages', 'POST', { project: pj, requestId: 'm1', text: '[接單] 開始', cardId: w.cardId, recipientIds: [], replyFrom: [] }), secondSql: '%UPDATE cards%' });
    assert.equal(r1.status, 200, '刪除成功：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '[接單] 移卡要等刪除的交易做完');
    assert.equal(r2.status, 201, '[接單]：' + JSON.stringify(r2.body).slice(0, 200));
    const d = await getCard(w.cardId);
    assert.equal(d.statusId, doing2.id, '落在剩下的進行中狀態'); assert.equal(d.status, '進行中二');
    assert.deepEqual(await stranded(), [], '沒有卡指向不存在的狀態');
  }

  // 5) 先建卡（停在 INSERT 之後），同時把那個狀態改類別（只有空的狀態能改）：改類別要等建卡做完，然後回 409 STATUS_NOT_EMPTY
  {
    await fresh('競態五');
    const tmp = await add('暫時', '待處理');
    const { r1, r2, blocked } = await race({ re: /^\s*INSERT INTO cards\b/, first: () => mkCard({ status: '暫時' }),
      second: () => call(boss.token, `/api/projects/${P}/statuses/${tmp.id}`, 'PATCH', { category: '受阻' }), secondSql: '%UPDATE project_statuses%' });
    assert.equal(r1.status, 201, '建卡成功：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '改類別要等建卡的交易做完');
    assert.equal(r2.status, 409, '改類別：' + JSON.stringify(r2.body).slice(0, 200)); assert.equal(r2.body.error?.code, 'STATUS_NOT_EMPTY');
    assert.equal((await items()).find(s => s.id === tmp.id)?.category, '待處理', '類別沒改');
    assert.deepEqual(await stranded(), [], '沒有卡指向別的類別的狀態');
  }

  // 6) 先改類別（停在提交前），同時有人把卡改到那個狀態：改卡片要等改類別做完，然後回 409 STATUS_DELETED
  {
    await fresh('競態六');
    const tmp = await add('暫時', '待處理');
    const c = ok(await mkCard({ status: '進行中' }), '建卡');
    const { r1, r2, blocked } = await race({ re: DELETE_DONE, first: () => call(boss.token, `/api/projects/${P}/statuses/${tmp.id}`, 'PATCH', { category: '受阻' }),
      second: () => call(boss.token, `/api/cards/${c.cardId}`, 'PATCH', { status: '暫時' }), secondSql: '%UPDATE cards%' });
    assert.equal(r1.status, 200, '改類別成功：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '改卡片要等改類別的交易做完');
    assert.equal(r2.status, 409, '改卡片：' + JSON.stringify(r2.body).slice(0, 200)); assert.equal(r2.body.error?.code, 'STATUS_DELETED');
    assert.equal((await getCard(c.cardId)).status, '進行中', '卡片沒改');
    assert.deepEqual(await stranded(), [], '沒有卡指向別的類別的狀態');
  }

  // 7) 兩個人同時刪「待處理」類別僅有的兩個狀態（第一個停在提交前）：第二個要等第一個做完，然後回 409，待處理類別還有狀態
  {
    await fresh('競態七');
    const todo2 = await add('待處理二', '待處理');
    const todo = (await items()).find(s => s.name === '待處理');
    const { r1, r2, blocked } = await race({ re: DELETE_DONE, first: del(todo.id), second: del(todo2.id), secondSql: '%UPDATE projects%' });
    assert.equal(r1.status, 200, '第一個刪除：' + JSON.stringify(r1.body).slice(0, 200));
    assert.ok(blocked, '第二個刪除要等第一個做完');
    assert.equal(r2.status, 409, '第二個刪除：' + JSON.stringify(r2.body).slice(0, 200)); assert.equal(r2.body.error?.code, 'CONFLICT');
    assert.deepEqual((await items()).filter(s => s.category === '待處理').map(s => s.name), ['待處理二'], '待處理類別還有狀態');
  }

  console.log('project-statuses-pg-race-test：全部通過');
} finally {
  await ctl.end();
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
