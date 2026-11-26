// 兩個 run-all 用同一個 DATA_DIR 並行時，資料仍隔離，各自結束後只清自己的 schema。
// 用檔案握手，確定第二個 run-all 啟動前，第一個已在 Postgres 寫入資料。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestPgUrl } from '../src/db-pg.js';
import { spawnLogged, untilStarted } from './browser-kit.js';

const url = process.env.AIGILE_TEST_PG_URL;
if (!url) {
  console.log('run-all-pg-isolation-test：略過（沒設 AIGILE_TEST_PG_URL）');
  process.exit(0);
}

const runner = fileURLToPath(new URL('./run-all.js', import.meta.url));
const legacySchema = `t_${randomBytes(10).toString('hex')}`;
const testUrl = new URL(url);
// 若 schema 隔離壞了，升級也只會寫到這支測試自己建的 schema。
testUrl.searchParams.set('options', `-c statement_timeout=48000 -c search_path=${legacySchema}`);
const runUrl = testUrl.toString();
const helper = new URL('./test-db.js', import.meta.url).href;
const dbHelper = new URL('../src/db-pg.js', import.meta.url).href;
const fixture = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openTestDb } from ${JSON.stringify(helper)};
import { testSchemaFor } from ${JSON.stringify(dbHelper)};

const dir = path.dirname(process.argv[1]);
const role = process.env.AIGILE_PG_ISOLATION_ROLE;
const file = path.join(dir, 'same-data', 'switch.db');
assert.deepEqual(Object.keys(process.env).filter(k => /^DATABASE_(URL|SCHEMA)$/i.test(k)), [], 'run-all passed inherited database defaults to the test');
const db = await openTestDb(file);
const { schema } = await db.get('SELECT current_schema() AS schema');
assert.equal(schema, testSchemaFor(path.dirname(file)), 'connection options overrode the run-scoped test schema');
assert.deepEqual(await db.get('SHOW statement_timeout'), { statement_timeout: '48s' });
await db.run('CREATE TABLE run_all_marker (value TEXT NOT NULL)');
await db.run('INSERT INTO run_all_marker VALUES (?)', role);
await db.close();
fs.writeFileSync(path.join(dir, role + '.json'), JSON.stringify({ schema }));

if (role === 'first') {
  while (!fs.existsSync(path.join(dir, 'release'))) await sleep(25);
  const reopened = await openTestDb(file);
  try { assert.deepEqual(await reopened.all('SELECT value FROM run_all_marker'), [{ value: role }]); }
  finally { await reopened.close(); }
} else {
  process.exitCode = 41;
}
`;

const { default: pg } = await import('pg');
const c = new pg.Client({ connectionString: assertTestPgUrl(url) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-runpg-'));
const kids = [];
const done = [];
function start(role) {
  const child = spawnLogged(kids, process.execPath, [runner, 'pg-fixture'], {
    AIGILE_TEST_PG_URL: runUrl, AIGILE_TEST_RUN_DIR: tmp, AIGILE_PG_ISOLATION_ROLE: role, TEST_JOBS: '1', TEST_TIMEOUT_SEC: '60',
    DATABASE_URL: 'ignored-inherited-url', database_schema: 'ignored_inherited_schema',
  });
  const closed = new Promise(resolve => child.on('close', resolve));
  done.push(closed);
  return { child, closed };
}
function readReport(role) {
  const { schema } = JSON.parse(fs.readFileSync(path.join(tmp, role + '.json'), 'utf8'));
  assert.match(schema, /^t_[0-9a-f_]+$/);
  assert.ok(Buffer.byteLength(schema) <= 63, 'schema 名稱不能被 Postgres 截斷');
  return schema;
}
const schemaExists = async schema => (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount === 1;
const marker = async schema => (await c.query(`SELECT value FROM "${schema}".run_all_marker`)).rows;
const legacyMarker = async () => (await c.query(`SELECT value FROM "${legacySchema}".legacy_run_marker`)).rows;
let legacyCreated = false;

try {
  await c.connect();
  fs.writeFileSync(path.join(tmp, 'pg-fixture-test.js'), fixture);
  await c.query(`CREATE SCHEMA "${legacySchema}"`);
  legacyCreated = true;
  await c.query(`CREATE TABLE "${legacySchema}".legacy_run_marker (value text PRIMARY KEY)`);
  await c.query(`INSERT INTO "${legacySchema}".legacy_run_marker VALUES ('retained')`);
  assert.deepEqual(await legacyMarker(), [{ value: 'retained' }]);

  // 即使覆寫值指到本機，測試網址也只接受用網址主體指定主機。
  for (const key of ['host', 'HOSTADDR']) {
    const overridden = new URL(runUrl);
    overridden.searchParams.set(key, '127.0.0.1');
    const rejected = spawnSync(process.execPath, [runner, 'pg-fixture'], {
      env: { ...process.env, AIGILE_TEST_PG_URL: overridden.href, AIGILE_TEST_RUN_DIR: tmp },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(rejected.status, 1, `run-all 應拒絕 ${key}`);
    assert.match(rejected.stderr, /AIGILE_TEST_PG_URL 不接受用查詢參數指定連線目標/);
  }

  const first = start('first');
  const firstSchema = await untilStarted(first.child, () => readReport('first'), '第一個 run-all 寫入資料');
  assert.deepEqual(await marker(firstSchema), [{ value: 'first' }]);
  assert.deepEqual(await legacyMarker(), [{ value: 'retained' }]);

  const second = start('second');
  assert.equal(await second.closed, 1, second.child.tail);
  assert.match(second.child.tail, /exit 41/, '確認是測試刻意失敗');
  assert.ok(await schemaExists(firstSchema), '第二個 run-all 刪除了第一個 run-all 的 schema');
  assert.deepEqual(await marker(firstSchema), [{ value: 'first' }]);
  const secondSchema = readReport('second');
  assert.notEqual(secondSchema, firstSchema, '不同 run-all 的同一個 DATA_DIR 要各用一個 schema');
  assert.ok(!(await schemaExists(secondSchema)), '測試失敗也要清自己的 schema');

  fs.writeFileSync(path.join(tmp, 'release'), '');
  assert.equal(await first.closed, 0, first.child.tail);
  assert.ok(!(await schemaExists(firstSchema)), '測試成功後清掉自己的 schema');
  assert.deepEqual(await legacyMarker(), [{ value: 'retained' }], 'nested run-all dropped a legacy standalone schema');
  const { rows: legacyTables } = await c.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [legacySchema]);
  assert.deepEqual(legacyTables, [{ tablename: 'legacy_run_marker' }], 'nested run-all migrated or wrote fixture data into the legacy schema');
  console.log('run-all-pg-isolation-test：全部通過');
} finally {
  fs.writeFileSync(path.join(tmp, 'release'), '');
  await Promise.all(done);
  try {
    if (legacyCreated) await c.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
  } finally {
    await c.end();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
