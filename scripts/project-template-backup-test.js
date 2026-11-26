// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-template-backup-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { APP_VERSION } from '../src/version.js';
import { appCaller } from './test-call.js';
import { openTestDb } from './test-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-template-backup-'));
const backup = '/api/admin/backup', begin = '/api/admin/restore/begin', restoreRows = '/api/admin/restore/rows';
const templates = '/api/workspace/project-templates', table = 'project_templates';
const header = { format: 'aigile-backup', formatVersion: 1, appVersion: APP_VERSION };
const spec = { name: '交付流程', visibility: 'private', statuses: [{ name: '待辦', category: '待處理' }, { name: '製作', category: '進行中' }, { name: '交付', category: '已完成' }] };
const expect = (r, status) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function site(name, run) {
  const db = await openTestDb(path.join(dir, name, 'switch.db'));
  const hooks = {};
  try {
    const appDb = { ...db,
      get: async (sql, ...args) => { await hooks.beforeGet?.(sql); return db.get(sql, ...args); },
      batch: async stmts => {
        if (hooks.beforeBegin && stmts.some(([sql]) => sql.startsWith("INSERT INTO app_settings (key, value) VALUES ('restore_state'"))) {
          const hook = hooks.beforeBegin;
          delete hooks.beforeBegin;
          await hook();
        }
        return db.batch(stmts);
      },
    };
    const caller = appCaller(createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', teamCacheMs: '0' } }));
    const admin = expect(await caller(null, '/api/join', 'POST', { name: '林志明', role: 'PO' }), 201);
    return await run({ db, hooks, call: (...args) => caller(admin.token, ...args) });
  } finally { await db.close?.(); }
}
const checks = {
  async 'template-only site'({ call }) {
    const t = expect(await call(templates, 'POST', spec), 201);
    assert.equal(expect(await call(`${backup}/status`), 200).empty, false);
    assert.equal(expect(await call(backup), 200).empty, false);
    assert.equal(expect(await call(begin, 'POST', header), 409).error.code, 'NOT_EMPTY');
    expect(await call(templates + '/' + t.id, 'DELETE', { expected: t }), 200);
    assert.equal(expect(await call(`${backup}/status`), 200).empty, false, '已停用的範本也是資料');
    assert.equal(expect(await call(begin, 'POST', header), 409).error.code, 'NOT_EMPTY');
  },
  async 'template saved after preflight'({ call, hooks }) {
    assert.equal(expect(await call(`${backup}/status`), 200).empty, true);
    hooks.beforeBegin = async () => expect(await call(templates, 'POST', spec), 201);
    assert.equal(expect(await call(begin, 'POST', header), 409).error.code, 'NOT_EMPTY');
    assert.equal(hooks.beforeBegin, undefined, '真的在匯入交易前新增了範本');
    assert.equal(expect(await call(templates), 200).items.length, 1, '新增的範本沒有被清掉');
  },
  async 'Worker before migration'({ db, call }) {
    await db.run('DROP TABLE project_templates');
    await db.run('DELETE FROM schema_migrations WHERE name = ?', '018_project_templates.sql');
    const result = expect(await call(backup), 200);
    assert.ok(!result.tables.some(t => t.name === table));
    assert.equal(result.empty, true);
    assert.deepEqual(expect(await call(`${backup}/rows?table=${table}`), 200), { table, rows: [], next: null });
    const legacy = expect(await call(`${backup}/rows?table=workspaces`), 200).rows;
    assert.equal(legacy.length, 1);
    expect(await call(begin, 'POST', header), 200);
    assert.equal(expect(await call(restoreRows, 'POST', { table, rows: [{ id: 'saved' }] }), 503).error.code, 'PROJECT_TEMPLATES_NOT_READY');
    expect(await call(restoreRows, 'POST', { table: 'workspaces', rows: [{ ...legacy[0], name: '從舊版還原的工作區' }] }), 200);
    expect(await call('/api/admin/restore/finish', 'POST', {}), 200);
    assert.equal((await db.get('SELECT name FROM workspaces WHERE id = ?', legacy[0].id)).name, '從舊版還原的工作區');
  },
  async 'template import validates an entire page before writing'({ call, db }) {
    expect(await call(begin, 'POST', header), 200);
    const row = { workspace_id: 'default', id: 'duplicate', name: '重複', visibility: 'private', statuses_json: JSON.stringify(spec.statuses.map((status, i) => ({ ...status, color: ['indigo', 'amber', 'green'][i] }))), retired_at: null };
    const duplicate = [row, ...Array.from({ length: 95 }, (_, i) => ({ ...row, id: `unique-${i}` })), row];
    const failed = expect(await call(restoreRows, 'POST', { table, rows: duplicate }), 400);
    assert.equal(failed.error.code, 'BACKUP_ROW_INVALID');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM project_templates')).n, 0, '重複的整批沒有寫入');
    const rows = Array.from({ length: 97 }, (_, i) => ({ ...row, id: `page-${i}` }));
    const saved = expect(await call(restoreRows, 'POST', { table, rows }), 200);
    assert.equal(saved.inserted, 97, '合法頁面可完整匯入');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM project_templates')).n, 97);
    const tooMany = expect(await call(restoreRows, 'POST', { table, rows: Array.from({ length: 98 }, (_, i) => ({ ...row, id: `large-${i}` })) }), 400);
    assert.equal(tooMany.error.code, 'INVALID_REQUEST');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM project_templates')).n, 97, '超大範本頁不寫入');
  },
  async 'template migration racing restore begin'({ call, db, hooks }) {
    await db.run('DROP TABLE project_templates');
    await db.run('DELETE FROM schema_migrations WHERE name = ?', '018_project_templates.sql');
    hooks.beforeBegin = async () => {
      await db.batch([
        [`CREATE TABLE IF NOT EXISTS project_templates (workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30), visibility TEXT NOT NULL CHECK (visibility IN ('open', 'review', 'private')), statuses_json TEXT NOT NULL, retired_at TEXT, PRIMARY KEY(workspace_id, id))`, []],
        ['INSERT INTO project_templates (workspace_id, id, name, visibility, statuses_json) VALUES (?,?,?,?,?)', ['default', 'during-migration', '部署中的範本', 'private', JSON.stringify(spec.statuses)]],
      ]);
    };
    const result = expect(await call(begin, 'POST', header), 409);
    assert.equal(result.error.code, 'NOT_EMPTY');
    assert.equal(hooks.beforeBegin, undefined, '範本表在交易鎖之前完成建立');
    assert.equal((await db.get('SELECT name FROM project_templates WHERE id = ?', 'during-migration')).name, '部署中的範本');
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'restore_state'")).n, 0, '沒有開始清空');
  },
  async 'a database error is not a missing table'({ call, hooks }) {
    hooks.beforeGet = sql => { if (sql.includes('COUNT(*)') && sql.includes('FROM project_templates')) throw new Error('test: template export failed to read'); };
    expect(await call(backup), 500);
    hooks.beforeGet = sql => { if (sql === 'SELECT 1 AS x FROM project_templates LIMIT 1') throw new Error('test: template presence probe failed'); };
    expect(await call(`${backup}/status`), 500);
    expect(await call(backup), 500);
    expect(await call(begin, 'POST', header), 500);
  },
};
try {
  const cases = Object.entries(checks);
  const results = await Promise.allSettled(cases.map(([name, check], i) => site(String(i), check)));
  const failures = results.flatMap((result, i) => {
    const label = cases[i][0];
    if (result.status === 'fulfilled') { console.log(`PASS ${label}`); return []; }
    console.error(`FAIL ${label}: ${result.reason.stack || result.reason}`);
    return [label];
  });
  assert.deepEqual(failures, []);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
