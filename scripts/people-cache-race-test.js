// 驗收測試：成員快取不會被「寫入之前開始讀、寫入之後才讀完」的舊資料蓋掉
// Postgres 的查詢是非同步的（連線池），一個請求整張讀成員表讀到一半時，另一個請求可以寫完並清掉快取；
// 先開始的那次讀完時不能把舊資料存回快取（不然接下來 30 秒內每個請求都看到舊的成員資料，例如邀請回來的人不在名冊上）。
// 做法：讓第一次整張讀成員表讀完後停住，這時另一個請求接受「重新加入」的邀請，再放行第一次讀取，最後看名冊。
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/people-cache-race-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrace-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
let hold = null; // 下一次整張讀成員表：讀完先停住，等測試放行（只作用一次）
const appDb = { ...db, all: async (sql, ...args) => {
  const rows = await db.all(sql, ...args);
  if (hold && /^SELECT \* FROM participants ORDER BY rowid/.test(sql)) { const h = hold; hold = null; h.reached(); await h.released; }
  return rows;
} };
const mk = () => {
  const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', joinLimitPerHour: '100000' } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
};
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

try {
  const setup = mk();
  const boss = ok(await setup(null, '/api/join', 'POST', { name: '林志明', role: 'PO' }), '第一位');
  const old = ok(await setup(null, '/api/join', 'POST', { name: '趙前同事', role: 'PG' }), '之後被移出的人');
  const Od = old.participant.participantId;
  ok(await setup(boss.token, `/api/participants/${Od}/remove`, 'POST'), '移出工作區');
  const back = ok(await setup(boss.token, '/api/invites', 'POST', { name: '趙前同事' }), '邀請回來');

  const call = mk(); // 新的一份程式：成員快取是空的
  let reached;
  const atHold = new Promise(r => { reached = r; });
  let release;
  hold = { reached, released: new Promise(r => { release = r; }) };
  const slow = call(boss.token, '/api/roster'); // 讀到移出時的成員表後停住
  await atHold;
  ok(await call(null, '/api/auth/invite', 'POST', { token: back.url.split('/invite/')[1], code: old.token }), '用原本的登入碼接受邀請回來');
  release();
  await slow;
  const roster = ok(await call(boss.token, '/api/roster'), '名冊');
  assert.ok(roster.members.some(p => p.participantId === Od), '回來的人在名冊上（快取沒被先開始的舊讀取蓋掉）');
  assert.ok(!(roster.removed || []).some(p => p.participantId === Od), '不在已移出');
  console.log('people-cache-race-test：全部通過');
} catch (e) {
  console.error('people-cache-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
