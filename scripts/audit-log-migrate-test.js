// 驗收測試：升級到稽核紀錄（migrations/010_audit_log.sql）
// 舊站把「永久刪除專案」記在設定表（app_settings 的 pdel:<時間>:<專案 id>）。升級後：
// - 010 建好稽核紀錄表；舊的專案刪除紀錄在程式啟動後轉進稽核紀錄（project.purge，detail.legacy＝true），設定表裡的鍵移除
// - 操作者、專案名字、代號、數量照舊
// - 重複啟動不會重複轉換；同一筆舊紀錄又出現（例：另一份程式還沒轉完就寫回來）也只留一筆
// 從刪除、可復原期、稽核紀錄、再驗證之前的版本升級（010 之後的升級都還沒套）：
// - 既有的裝置登入、訊息、專案都還在、照常可用
// - 升級加的欄位讀得到、用得上：裝置可以再驗證（011）、訊息可以刪除與復原（012）、專案可以刪除進入可復原期（013）、
//   工作區政策「誰可以刪除自己的訊息」是預設的所有成員（workspaces 的新欄）
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/audit-log-migrate-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, tableNames } from './test-db.js';
import { adminSession, reauth } from './test-admin.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-auditmig-'));
const file = path.join(dir, 'switch.db');
const AT1 = '2026-03-01T08:00:00.000Z', AT2 = '2026-04-02T09:30:00.000Z';
const OLD = [
  [`pdel:${AT1}:proj_old1`, { projectId: 'proj_old1', name: '舊專案一', code: 'OLD', by: 'p_boss', byName: '林志明', at: AT1, counts: { messages: 12, cards: 3, docs: 1, files: 0, skills: 0 }, aisDeleted: ['舊 AI'] }],
  [`pdel:${AT2}:proj_old2`, { projectId: 'proj_old2', name: '舊專案二', code: null, by: 'p_boss', byName: '林志明', at: AT2, counts: { messages: 0, cards: 0, docs: 0, files: 0, skills: 0 }, aisDeleted: [] }],
];

const open = async () => {
  const db = await openTestDb(file);
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { db, call };
};
const pdelKeys = async db => (await db.all("SELECT key FROM app_settings WHERE key >= 'pdel:' AND key < 'pdel;'")).map(r => r.key);

// 1) 做出升級前的資料庫：先有人、裝置登入、訊息、專案；再拿掉 010 之後的升級加的表、欄位、索引，標成還沒套；設定表有兩筆舊的專案刪除紀錄
const NEW_MIGS = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d{3}_.*\.sql$/.test(f) && f >= '010');
let seed;
{
  const { db: old, call } = await open();
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const dev = await adminSession(call, boss.token); // 帳號密碼登入的裝置
  const msg = (await call(boss.token, '/api/messages', 'POST', { project: '預設專案', text: '升級前的訊息', requestId: 'old1' })).body;
  const pj = (await call(boss.token, '/api/projects', 'POST', { name: '升級前的專案', code: 'OLDP' })).body.items.find(p => p.name === '升級前的專案');
  assert.ok(msg.messageId && pj?.id && dev.token, '升級前的資料：' + JSON.stringify([msg, pj]));
  seed = { boss, dev, msg, pj };
  for (const sql of ['DROP TABLE audit_log', 'DROP INDEX IF EXISTS idx_messages_purge', 'DROP INDEX IF EXISTS idx_messages_clear', 'ALTER TABLE devices DROP COLUMN reauth_at',
    ...['deleted_at', 'deleted_by', 'purge_at', 'clear_id', 'purged_at'].map(c => `ALTER TABLE messages DROP COLUMN ${c}`),
    ...['deleted_at', 'deleted_by', 'purge_at', 'paused_ais'].map(c => `ALTER TABLE projects DROP COLUMN ${c}`), 'ALTER TABLE workspaces DROP COLUMN delete_own_messages',
    `DELETE FROM schema_migrations WHERE name IN (${NEW_MIGS.map(n => `'${n}'`).join(', ')})`]) await old.run(sql);
  for (const [key, v] of OLD) await old.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', key, JSON.stringify(v));
  await old.close();
}

// 2) 用新版程式打開：套 010；第一個請求把舊紀錄轉進稽核紀錄
let { db, call } = await open();
try {
  assert.deepEqual((await db.all('SELECT name FROM schema_migrations')).map(x => x.name).filter(n => NEW_MIGS.includes(n)).sort(), NEW_MIGS, '010 之後的升級都套上了');
  assert.ok((await tableNames(db)).includes('audit_log'), '010 建了 audit_log');
  const { boss, dev, msg, pj } = seed;
  let r = await call(boss.token, '/api/audit-log');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const purged = r.body.items.filter(x => x.action === 'project.purge');
  assert.deepEqual(purged.map(x => [x.at, x.scope.projectId, x.scope.projectName, x.target?.name, x.actor.name]),
    [[AT2, 'proj_old2', '舊專案二', '舊專案二', '林志明'], [AT1, 'proj_old1', '舊專案一', '舊專案一', '林志明']], '舊紀錄轉進來（新的在前）：' + JSON.stringify(purged));
  assert.deepEqual([purged[1].scope.kind, purged[1].scope.workspaceId, purged[1].detail], ['project', 'default', { legacy: true, code: 'OLD', counts: OLD[0][1].counts, aisDeleted: ['舊 AI'] }], '細節照舊、標 legacy');
  assert.deepEqual(await pdelKeys(db), [], '設定表裡的舊鍵移除了');

  // 既有的資料還在、照常可用
  r = await call(dev.token, '/api/me');
  assert.equal(r.status, 200, '升級前的裝置登入照常可用：' + JSON.stringify(r.body));
  const m = (await call(boss.token, `/api/messages/${msg.messageId}`)).body;
  assert.deepEqual([m.text, m.deleted], ['升級前的訊息', undefined], '升級前的訊息還在、沒有被當成刪除：' + JSON.stringify(m));
  const projects = (await call(boss.token, '/api/projects')).body;
  assert.ok(projects.items.some(p => p.id === pj.id && p.name === '升級前的專案'), '升級前的專案還在');
  assert.equal(projects.canDeleteOwnMessages, true, '工作區政策的新欄位：預設所有成員都能刪自己的訊息');
  assert.equal((await call(boss.token, '/api/workspace/settings')).body.deleteOwnMessages, 'members', '工作區設定讀得到新欄位（預設 members）');
  // 新欄位用得上
  assert.ok(await reauth(call, dev), '011：裝置可以再驗證');
  r = await call(boss.token, `/api/messages/${msg.messageId}`, 'DELETE');
  assert.deepEqual([r.status, r.body.message?.deleted, typeof r.body.message?.purgeAt], [200, true, 'string'], '012：升級前的訊息可以刪除：' + JSON.stringify(r.body));
  assert.equal((await call(boss.token, `/api/messages/${msg.messageId}/restore`, 'POST')).status, 200, '012：也可以復原');
  assert.equal((await call(boss.token, `/api/projects/${encodeURIComponent(pj.id)}/archive`, 'POST')).status, 200, '封存升級前的專案');
  r = await call(dev.token, `/api/projects/${encodeURIComponent(pj.id)}/delete`, 'POST', { confirmName: '升級前的專案' });
  assert.equal(r.status, 200, '013：升級前的專案可以刪除：' + JSON.stringify(r.body));
  assert.deepEqual((await call(dev.token, '/api/deleted-projects')).body.items.map(x => x.projectId), [pj.id], '013：進入可復原期');
  await db.close();

  // 3) 再啟動一次：不重複轉換
  ({ db, call } = await open());
  r = await call(boss.token, '/api/audit-log?action=project.purge');
  assert.equal(r.body.items.length, 2, '重開不重複：' + JSON.stringify(r.body.items.map(x => x.id)));
  // 同一筆舊紀錄又出現（另一份程式還沒轉完時寫回）：再開一次也只留一筆，鍵照樣移除
  await db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', OLD[0][0], JSON.stringify(OLD[0][1]));
  await db.close();
  ({ db, call } = await open());
  r = await call(boss.token, '/api/audit-log?action=project.purge');
  assert.equal(r.body.items.length, 2, '同一筆舊紀錄轉兩次也只有一筆');
  assert.deepEqual(await pdelKeys(db), [], '鍵照樣移除');
  console.log('audit-log-migrate-test：全部通過');
} finally {
  try { await db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
