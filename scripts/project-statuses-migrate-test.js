// 驗收測試：升級到「每個專案自訂看板狀態」（migrations/007_project_statuses.sql）
// 舊站的卡片只有 status（七種類別字樣）。升級後：每個專案有預設狀態組、未封存的卡都對到狀態、已封存的沒有狀態，
// 而且 API 讀到的卡片 status 跟升級前一樣（沒自訂過的專案看不出變化）
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑：升級（套 007）與第一次讀狀態時補資料分開驗；用法：node scripts/project-statuses-migrate-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb, tableNames } from './test-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pstm-'));
const file = path.join(dir, 'switch.db');

// 1) 做出升級前的資料庫：沒有 project_statuses、cards 沒有 status_id、007 還沒套
{
  const old = await openTestDb(file);
  for (const sql of ['DROP TABLE project_statuses', 'ALTER TABLE cards DROP COLUMN status_id', "DELETE FROM schema_migrations WHERE name = '007_project_statuses.sql'"]) await old.run(sql);
  const at = '2026-01-02T00:00:00.000Z';
  for (const [i, st] of ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', '已封存'].entries())
    await old.run('INSERT INTO cards (uid, type, title, status, created_by, created_at, updated_at, project, proj_no) VALUES (?,?,?,?,?,?,?,?,?)', 'old' + i, '工作', '舊卡 ' + st, st, 'p_old', at, at, '預設專案', i + 1);
  await old.close();
}

// 2) 用新版程式打開：升級只套 007（加表與欄位、不補資料）
const db = await openTestDb(file);
try {
  assert.ok((await db.all("SELECT name FROM schema_migrations WHERE name = '007_project_statuses.sql'")).length, '007 套上了');
  assert.ok((await tableNames(db)).includes('project_statuses'), '007 建了 project_statuses');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM project_statuses')).n, 0, '升級本身不補狀態（第一次讀狀態時才補）');
  assert.ok((await db.all("SELECT status_id FROM cards WHERE uid LIKE 'old%'")).every(r => r.status_id === null), 'cards.status_id 加上了、還是空的');
  // 3) 第一次讀狀態：補上預設狀態組與卡片的 status_id
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const list = await call(boss.token, `/api/cards?include=archived&project=${encodeURIComponent('預設專案')}`);
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
  const st = (await call(boss.token, `/api/projects/${encodeURIComponent('預設專案')}/statuses`)).body.items;
  assert.deepEqual(st.map(s => s.name), ['待整理', '待處理', '進行中', '受阻', '待確認', '已完成'], '既有專案補上預設狀態組');
  const byTitle = new Map(list.body.items.map(c => [c.title, c]));
  for (const s of ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成']) {
    const c = byTitle.get('舊卡 ' + s);
    assert.equal(c.status, s, `${s}：API 輸出跟升級前一樣`);
    assert.equal(c.category, s);
    assert.equal(c.statusId, st.find(x => x.name === s).id, `${s}：對到預設狀態`);
  }
  const arch = byTitle.get('舊卡 已封存');
  assert.equal(arch.status, '已封存'); assert.equal(arch.statusId, null, '已封存的卡沒有狀態');
  // 資料庫裡也補齊了（之後依 status_id 篩選、刪狀態時搬卡都靠它）
  const rows = await db.all("SELECT status, status_id FROM cards WHERE uid LIKE 'old%'");
  assert.ok(rows.every(r => (r.status === '已封存') === (r.status_id === null)), '未封存的卡都有 status_id');
  console.log('project-statuses-migrate-test：全部通過');
} finally {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
