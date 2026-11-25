// 復原跟到期的永久清除同時發生（docs/adr/0003）：只有一邊會成功
// A. 專案：復原檢查時還在可復原期內、真的寫入前剛好到期，排程也已經挑中它 → 復原成功就不清除（專案照常在），
//    復原失敗（RECOVERY_EXPIRED）就照常永久清除；不會出現「復原回 200、專案卻被清除了」
// B. 單則訊息：同樣的時間點 → 復原成功就不清除（內容與附件都在），失敗就照常永久清除；不會出現「復原回 200、附件卻被清掉了」
// 修正前：復原只在寫入前用程式比對時間，寫入那句不看期限；排程挑中之後也不再確認，照 id 清除
// 時間點的安排：包一層資料庫，在復原第一次寫入前等到期、讓排程跑到第一次寫入前停住，復原做完排程再繼續（只看外部行為，不看資料表）
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。本機暫存資料庫，不連任何站。用法：node scripts/deletion-race-test.js
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

const PJ = '預設專案';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-delrace-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  let hook = null;
  const gated = { ...db,
    get: async (s, ...a) => { await hook?.(s); return db.get(s, ...a); },
    all: async (s, ...a) => { await hook?.(s); return db.all(s, ...a); },
    run: async (s, ...a) => { await hook?.(s); return db.run(s, ...a); },
    batch: async st => { for (const [s] of st) await hook?.(s); return db.batch(st); } };
  const app = createApp({ db: gated, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = appCaller(app);
  const code = r => `${r.status} ${r.body?.error?.code || ''}`;
  const owner = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const boss = await adminSession(call, owner.token);
  const isWrite = s => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s);

  // 復原（send）第一次寫入 isRestoreWrite 前：等到 expireAt 過了，讓排程跑到挑中到期的（isDueSelect）之後的第一次寫入前停住；復原做完排程再繼續
  async function race({ send, isRestoreWrite, isDueSelect, expireAt }) {
    let phase = 0, selected = false, signal, restored;
    const picked = new Promise(r => { signal = r; });
    const restoreDone = new Promise(r => { restored = r; });
    let sched;
    hook = async s => {
      if (phase === 0 && isRestoreWrite(s)) {
        phase = 1;
        while (Date.now() <= expireAt + 20) await sleep(10);
        sched = app.runScheduled();
        await picked;
        phase = 2;
        return;
      }
      if (phase === 1 && isDueSelect(s)) selected = true;
      else if (phase === 1 && selected && isWrite(s)) { phase = 3; signal(); await restoreDone; }
    };
    const r = await send();
    restored();
    const run = await sched;
    hook = null;
    return { r, run, picked: phase >= 2 };
  }

  // ---------- A 專案 ----------
  const pid = (await call(boss.token, '/api/projects', 'POST', { name: '同時的專案', code: 'RACE' })).body.items.find(p => p.name === '同時的專案').id;
  const enc = encodeURIComponent(pid);
  assert.equal((await call(boss.token, `/api/projects/${enc}/archive`, 'POST')).status, 200, '封存');
  assert.equal((await call(boss.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: '同時的專案' })).status, 200, '刪除');
  const projExpire = Date.now() + 1500; // 留足時間給復原請求先做完檢查（慢的機器、Postgres）
  await db.run('UPDATE projects SET purge_at = ? WHERE id = ?', projExpire, pid); // 模擬時間經過：快到期了
  const a = await race({
    send: () => call(boss.token, `/api/projects/${enc}/restore`, 'POST'),
    isRestoreWrite: s => /^\s*UPDATE projects SET/i.test(s),
    isDueSelect: s => /FROM projects WHERE deleted_at IS NOT NULL AND purge_at <=/i.test(s),
    expireAt: projExpire,
  });
  assert.ok(a.picked, 'A 排程在復原寫入前挑中了這個專案');
  const exists = (await call(boss.token, '/api/projects')).body.items.some(p => p.id === pid);
  const listed = (await call(boss.token, '/api/deleted-projects')).body.items.some(p => p.projectId === pid);
  assert.ok(!(a.r.status === 200 && !exists), `A 復原回 200 的話專案要還在（復原 ${a.r.status}、專案 ${exists ? '在' : '不在'}）`);
  if (a.r.status === 200) assert.deepEqual([exists, listed, a.run.purged?.projects], [true, false, 0], 'A 復原成功：不清除：' + JSON.stringify(a.run));
  else assert.deepEqual([code(a.r), exists, listed, a.run.purged?.projects], ['409 RECOVERY_EXPIRED', false, false, 1], 'A 復原失敗：照常永久清除：' + JSON.stringify([a.r.body, a.run]));

  // ---------- B 單則訊息 ----------
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const fid = (await call(boss.token, `/api/files?${new URLSearchParams({ name: '圖.png', declared: 'true', project: PJ, post: 'false' })}`, 'POST', png, true)).body.file.fileId;
  const m = (await call(boss.token, '/api/messages', 'POST', { project: PJ, text: '有附件的訊息', requestId: 'rq1', fileIds: [fid] })).body;
  assert.equal((await call(boss.token, `/api/files/${fid}`)).status, 200, '刪除前下載得到');
  assert.equal((await call(boss.token, `/api/messages/${m.messageId}`, 'DELETE')).status, 200, '刪除訊息');
  const msgExpire = Date.now() + 1500; // 留足時間給復原請求先做完檢查（慢的機器、Postgres）
  await db.run('UPDATE messages SET purge_at = ? WHERE id = ?', new Date(msgExpire).toISOString(), m.messageId); // 模擬時間經過：快到期了
  const b = await race({
    send: () => call(boss.token, `/api/messages/${m.messageId}/restore`, 'POST'),
    isRestoreWrite: s => /^\s*UPDATE messages SET/i.test(s),
    isDueSelect: s => /FROM messages WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_at <=/i.test(s),
    expireAt: msgExpire,
  });
  assert.ok(b.picked, 'B 排程在復原寫入前挑中了這則');
  const after = (await call(boss.token, `/api/messages/${m.messageId}`)).body;
  const download = (await call(boss.token, `/api/files/${fid}`)).status;
  assert.ok(!(b.r.status === 200 && (after.deleted || download !== 200)), `B 復原回 200 的話內容與附件都要還在（復原 ${b.r.status}、下載 ${download}）`);
  if (b.r.status === 200) assert.deepEqual([!!after.deleted, after.text.startsWith('有附件的訊息'), download, b.run.purged?.messages], [false, true, 200, 0], 'B 復原成功：不清除：' + JSON.stringify([after.text, download, b.run]));
  else assert.deepEqual([code(b.r), after.deleted, after.purged, b.run.purged?.messages], ['409 RECOVERY_EXPIRED', true, true, 1], 'B 復原失敗：照常永久清除：' + JSON.stringify([b.r.body, after, b.run]).slice(0, 300));
  console.log('deletion-race-test：全部通過');
} catch (e) {
  console.error('deletion-race-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await db?.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
