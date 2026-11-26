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
    expect(await call(begin, 'POST', header), 200);
    assert.equal(expect(await call(restoreRows, 'POST', { table, rows: [{ id: 'saved' }] }), 503).error.code, 'PROJECT_TEMPLATES_NOT_READY');
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
