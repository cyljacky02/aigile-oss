// 驗收測試：還原舊版備份後，專案網址英文名與代號已正規化（還原收尾在成員轉換之後執行同一個正規化）
// - 這個站本來已正規化（有標記）；備份裡就算帶了「已正規化」的標記也不採用，收尾一定照備份的資料重算
// - 收尾的正規化寫不進去：維持還原中、回 503 RESTORE_UNFINISHED；再按一次收尾就做完
// - 還原後每個專案顯示的值跟舊站一樣，而且都存進資料庫；舊代號連結照舊
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-identity-restore-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { IDENTITY_READY_KEY } from '../src/project-identity.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pidrs-'));
const db = await openTestDb(path.join(dir, 'switch.db'), { legacyProjects: false });
let failReady = false; // 寫入「已正規化」標記的那批一律失敗
const flaky = { ...db, batch: stmts => {
  if (failReady && stmts.some(([sql, a]) => /VALUES/.test(sql) && (a || [])[0] === IDENTITY_READY_KEY)) return Promise.reject(new Error('模擬的資料庫寫入失敗'));
  return db.batch(stmts);
} };
const app = createApp({ db: flaky, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const at = d => `2026-01-0${d}T00:00:00.000Z`;
const person = (id, name, d, extra) => ({ id, kind: 'human', name, role: 'PG', role_key: '', code: id.slice(2, 6).toUpperCase(), owner_id: null, status: 'active', version: 1, created_at: at(d), updated_at: at(d), last_seen_at: 0, standby_at: 0, ...extra });
const A = '預設專案', B = '第二專案';
// 1.0.7 匯出的樣子：網址英文名只有一個專案存了、代號都沒存；一個舊代號；外加一筆偽造的「已正規化」標記
const backup = {
  format: 'aigile-backup', formatVersion: 1, appVersion: '1.0.7',
  tables: {
    projects: [{ id: A, name: A, archived: 0, created_by: null, created_at: at(1) }, { id: B, name: B, archived: 0, created_by: null, created_at: at(2) },
      { id: 'p_web', name: '官網', archived: 0, created_by: null, created_at: at(3) }],
    app_settings: [
      { key: 'slug:p_web', value: 'website' },
      { key: 'pcodeold:SITE', value: 'p_web' },
      { key: IDENTITY_READY_KEY, value: '{"forged":true}' },
    ],
    participants: [person('p_boss', '林老闆', 3, { is_admin: 1, projects: `${A},${B},p_web` })],
    cards: [{ seq: 1, uid: 'c1', type: '工作', title: '官網首頁', status: '待處理', created_by: 'p_boss', request_id: 'r1', project: 'p_web', proj_no: 7, created_at: at(4), updated_at: at(4) }],
  },
};
const stored = async id => [(await db.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + id))?.value, (await db.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + id))?.value];

try {
  const me = (await call(null, '/api/join', 'POST', { name: '匯入的人', role: 'PO' })).body;
  assert.ok(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', IDENTITY_READY_KEY), '這個站本來已正規化');
  let r = await call(me.token, '/api/admin/restore/begin', 'POST', { format: backup.format, formatVersion: backup.formatVersion, appVersion: backup.appVersion });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const [table, rows] of Object.entries(backup.tables)) {
    r = await call(me.token, '/api/admin/restore/rows', 'POST', { table, rows });
    assert.equal(r.status, 200, table + JSON.stringify(r.body));
  }
  assert.equal(await db.get('SELECT 1 AS x FROM app_settings WHERE key = ?', IDENTITY_READY_KEY), null, '開始匯入清掉標記，備份帶的標記不匯入');

  // 收尾的正規化寫不進去：維持還原中，什麼識別碼都沒寫
  failReady = true;
  r = await call(me.token, '/api/admin/restore/finish', 'POST', {});
  assert.deepEqual([r.status, r.body.error?.code], [503, 'RESTORE_UNFINISHED'], JSON.stringify(r.body));
  assert.ok(await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'restore_state'"), '維持還原中');
  assert.deepEqual(await stored(A), [undefined, undefined], '沒有寫入一半');
  failReady = false;
  r = await call(me.token, '/api/admin/restore/finish', 'POST', {});
  assert.equal(r.status, 200, '再按一次收尾：' + JSON.stringify(r.body));
  console.log('✓ 收尾的正規化沒做成時維持還原中；再按一次收尾就做完');

  const tok = me.token; // 登入改掛到備份裡的管理員
  const items = (await call(tok, '/api/projects')).body.items;
  assert.deepEqual(Object.fromEntries(items.map(p => [p.id, [p.slug, p.code]])), { [A]: ['main', 'MAIN'], [B]: ['second', 'SECO'], p_web: ['website', 'WEBS'] }, '還原後顯示的值跟舊站一樣');
  assert.deepEqual([await stored(A), await stored(B), await stored('p_web')], [['main', 'MAIN'], ['second', 'SECO'], ['website', 'WEBS']], '都存進資料庫');
  assert.equal((await db.get("SELECT value FROM app_settings WHERE key = 'pcodeold:SITE'"))?.value, 'p_web', '舊代號別名照舊');
  const mark = await db.get('SELECT value FROM app_settings WHERE key = ?', IDENTITY_READY_KEY);
  assert.ok(mark && !mark.value.includes('forged'), '標記是收尾正規化寫的，不是備份帶的');
  assert.equal((await call(tok, '/api/cards/WEBS-7')).body.cardId, 'WEBS-7', '卡片代號');
  assert.equal((await call(tok, '/api/cards/SITE-7')).body.cardId, 'WEBS-7', '舊代號連結照舊');
  const d = (await call(tok, '/api/admin/project-identity')).body;
  assert.deepEqual([d.normalized, d.conflicts], [true, []], '診斷：已正規化、沒有衝突');
  // 還原後建立專案照常（不會撞到備份裡的代號）
  const n = await call(tok, '/api/projects', 'POST', { name: 'Website Two', code: 'WEBS' });
  assert.deepEqual([n.status, n.body.error?.code], [409, 'CODE_TAKEN'], JSON.stringify(n.body));
  assert.equal((await call(tok, '/api/projects', 'POST', { name: 'Website Two' })).status, 201);
  console.log('✓ 還原舊版備份後已正規化：顯示的值不變、都存進資料庫、舊代號連結照舊；備份帶的標記不採用');
  console.log('project-identity-restore-test：全部通過');
} catch (e) {
  console.error('project-identity-restore-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
