// 驗收測試：升級到稽核紀錄（migrations/010_audit_log.sql）
// 舊站把「永久刪除專案」記在設定表（app_settings 的 pdel:<時間>:<專案 id>）。升級後：
// - 010 建好稽核紀錄表；舊的專案刪除紀錄在程式啟動後轉進稽核紀錄（project.purge，detail.legacy＝true），設定表裡的鍵移除
// - 操作者、專案名字、代號、數量照舊
// - 重複啟動不會重複轉換；同一筆舊紀錄又出現（例：另一份程式還沒轉完就寫回來）也只留一筆
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/audit-log-migrate-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, tableNames } from './test-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-auditmig-'));
const file = path.join(dir, 'switch.db');
const AT1 = '2026-03-01T08:00:00.000Z', AT2 = '2026-04-02T09:30:00.000Z';
const OLD = [
  [`pdel:${AT1}:proj_old1`, { projectId: 'proj_old1', name: '舊專案一', code: 'OLD', by: 'p_boss', byName: '林志明', at: AT1, counts: { messages: 12, cards: 3, docs: 1, files: 0, skills: 0 }, aisDeleted: ['舊 AI'] }],
  [`pdel:${AT2}:proj_old2`, { projectId: 'proj_old2', name: '舊專案二', code: null, by: 'p_boss', byName: '林志明', at: AT2, counts: { messages: 0, cards: 0, docs: 0, files: 0, skills: 0 }, aisDeleted: [] }],
];

// 1) 做出升級前的資料庫：沒有 audit_log、010 還沒套、設定表有兩筆舊的專案刪除紀錄
{
  const old = await openTestDb(file);
  for (const sql of ['DROP TABLE audit_log', "DELETE FROM schema_migrations WHERE name = '010_audit_log.sql'"]) await old.run(sql);
  for (const [key, v] of OLD) await old.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', key, JSON.stringify(v));
  await old.close();
}

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

// 2) 用新版程式打開：套 010；第一個請求把舊紀錄轉進稽核紀錄
let { db, call } = await open();
try {
  assert.ok((await db.all("SELECT name FROM schema_migrations WHERE name = '010_audit_log.sql'")).length, '010 套上了');
  assert.ok((await tableNames(db)).includes('audit_log'), '010 建了 audit_log');
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  let r = await call(boss.token, '/api/audit-log');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const purged = r.body.items.filter(x => x.action === 'project.purge');
  assert.deepEqual(purged.map(x => [x.at, x.scope.projectId, x.scope.projectName, x.target?.name, x.actor.name]),
    [[AT2, 'proj_old2', '舊專案二', '舊專案二', '林志明'], [AT1, 'proj_old1', '舊專案一', '舊專案一', '林志明']], '舊紀錄轉進來（新的在前）：' + JSON.stringify(purged));
  assert.deepEqual([purged[1].scope.kind, purged[1].scope.workspaceId, purged[1].detail], ['project', 'default', { legacy: true, code: 'OLD', counts: OLD[0][1].counts, aisDeleted: ['舊 AI'] }], '細節照舊、標 legacy');
  assert.deepEqual(await pdelKeys(db), [], '設定表裡的舊鍵移除了');
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
