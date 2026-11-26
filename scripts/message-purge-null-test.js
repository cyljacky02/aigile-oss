// 回歸測試（ADR 0005「斷言的條件不能是 SQL NULL」）：訊息永久清除那批的交易內斷言「這批每則都還是已刪除、未清除、已到期」，
// 遇到 purge_at 是 NULL 的列時不能被當成「沒問題」放行（NOT (NULL) 是 NULL，NOT EXISTS 會漏掉它）。
// 做法：挑中兩則到期的訊息後、清除那批寫入前，把其中一則的 purge_at 改成 NULL（還是已刪除）：整批不寫，兩則都沒清除；
// 下一次排程只挑到期的那則，正常清除。
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/message-purge-null-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { appCaller } from './test-call.js';

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-purgenull-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
let before = null; // 下一個含有符合 re 那句的寫入，先執行 run()（只作用一次）
const appDb = { ...db, batch: async stmts => {
  const b = before && stmts.some(([sql]) => before.re.test(sql)) ? before : null;
  if (b) { before = null; await b.run(); }
  return db.batch(stmts);
} };
try {
  const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = appCaller(app);
  const boss = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body;
  let rq = 0;
  const post = async text => {
    const r = await call(boss.token, '/api/messages', 'POST', { project: PJ, text, requestId: 'rq' + ++rq });
    assert.ok(r.status === 201 || r.status === 200, '發訊息：' + JSON.stringify(r.body));
    return r.body.messageId;
  };
  const a = await post('甲訊息'), b = await post('乙訊息');
  for (const id of [a, b]) assert.equal((await call(boss.token, `/api/messages/${id}`, 'DELETE')).status, 200, '刪除');
  await db.run('UPDATE messages SET purge_at = ? WHERE id IN (?, ?)', new Date(Date.now() - 60_000).toISOString(), a, b); // 模擬可復原期到期
  const purged = async id => !!(await db.get('SELECT purged_at FROM messages WHERE id = ?', id)).purged_at;

  // 清除那批送出前，乙的 purge_at 變成 NULL（還是已刪除）：乙不是「已到期」，整批不寫
  before = { re: /^UPDATE messages SET purge_at = purge_at WHERE id IN/, run: () => db.run('UPDATE messages SET purge_at = NULL WHERE id = ?', b) };
  const first = (await app.runScheduled()).purged.messages;
  assert.equal(before, null, '真的在清除那批之前改了乙');
  assert.equal(first, 0, '有一則不是已到期：整批不寫');
  assert.equal(await purged(a), false, '甲還沒清除');
  assert.equal(await purged(b), false, '乙沒有清除');
  // 下一次排程只挑到期的甲
  assert.equal((await app.runScheduled()).purged.messages, 1, '下一次清除甲');
  assert.equal(await purged(a), true, '甲清除了');
  assert.equal(await purged(b), false, '乙還是沒清除');
  console.log('message-purge-null-test：全部通過');
} catch (e) {
  console.error('message-purge-null-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
