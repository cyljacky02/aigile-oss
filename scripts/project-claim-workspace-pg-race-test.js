// Two workspaces use different row locks. Only the global claim key can
// serialize the competing batches, including the compatibility and audit writes.
import './test-home.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createAudit } from '../src/audit.js';
import { createProjectCreation, CREATION_METHOD } from '../src/project-create.js';
import { lockWorkspaceStmt, writeOrdered } from '../src/write-order.js';
import { assertTestPgUrl } from '../src/db-pg.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';

if (!TEST_PG_URL) {
  console.log('project-claim-workspace-pg-race-test: skipped (set AIGILE_TEST_PG_URL)');
  process.exit(0);
}
const file = `project-claim-race-${randomUUID()}.db`;
const a = await openTestDb(file, { legacyProjects: false });
const b = await openTestDb(file, { legacyProjects: false });
const { default: pg } = await import('pg');
const control = new pg.Client({ connectionString: assertTestPgUrl(TEST_PG_URL) });
await control.connect();
const nowIso = () => new Date().toISOString();
const randId = prefix => `${prefix}-${randomUUID()}`;
const creation = db => createProjectCreation({
  db, randId, nowIso, claimWrites: true,
  auditLog: createAudit({ db, randId, nowIso }),
  projEvent: (id, actor, text, at) => ['INSERT INTO project_events (project_id, actor_id, text, at) VALUES (?, ?, ?, ?)', [id, actor, text, at]],
  nameFreeCond: (name, id) => ({ cond: 'NOT EXISTS (SELECT 1 FROM projects WHERE name = ? AND id != ?)', args: [name, id] }),
});
async function waitFor(check, message) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(message);
    await setTimeout(20);
  }
}
const pgWaiting = sql => control.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
  AND wait_event_type = 'Lock' AND query LIKE $1`, [sql]).then(r => r.rowCount > 0);

try {
  await a.run("INSERT INTO workspaces (id, name) VALUES ('alpha', 'Alpha'), ('beta', 'Beta')");
  const run = (db, workspaceId, id, spec, pause = []) => writeOrdered(db, [lockWorkspaceStmt(workspaceId),
    ...creation(db).stmts({ id, at: nowIso(), method: CREATION_METHOD.FIRST_RUN, workspaceId, spec }), ...pause]);
  for (const [index, namespace, value, alpha, beta] of [
    [1, 'slug', 'shared-route', { slug: 'shared-route', code: 'SLUGA' }, { slug: 'shared-route', code: 'SLUGB' }],
    [2, 'code', 'SHARE', { slug: 'alpha-code', code: 'SHARE' }, { slug: 'beta-code', code: 'SHARE' }],
  ]) {
    const lock = 4_720_000_000 + index;
    const marker = `SELECT pg_advisory_xact_lock(${lock})`;
    await control.query('SELECT pg_advisory_lock($1)', [lock]);
    let first, second, secondDone = false, blocked = false;
    try {
      first = run(a, 'alpha', `alpha-${index}`, { ...alpha, name: `Alpha ${index}` }, [[marker, []]]);
      first.catch(() => {});
      await waitFor(() => pgWaiting(marker), 'first transaction did not reach the pre-commit pause');
      second = run(b, 'beta', `beta-${index}`, { ...beta, name: `Beta ${index}` }).finally(() => { secondDone = true; });
      second.catch(() => {});
      await waitFor(async () => secondDone || (blocked = await pgWaiting('INSERT INTO project_identity_claims (namespace, value)%')),
        'second transaction did not reach the global claim key');
    } finally {
      await control.query('SELECT pg_advisory_unlock($1)', [lock]);
      await Promise.allSettled([first, second]);
    }
    assert.deepEqual([await first, await second], [true, false], `only one workspace acquires ${namespace} ${value}`);
    assert.equal(blocked, true, 'the second transaction waited on its global key');
    assert.equal((await a.get('SELECT project_id FROM project_identity_claimants WHERE namespace = ? AND value = ?', namespace, value)).project_id, `alpha-${index}`);
    assert.equal(await a.get('SELECT id FROM projects WHERE id = ?', `beta-${index}`), null);
    assert.equal(await a.get('SELECT key FROM app_settings WHERE key = ?', `pcode:beta-${index}`), null);
    const [unusedNamespace, unusedValue] = namespace === 'slug' ? ['code', beta.code] : ['slug', beta.slug];
    assert.equal(await a.get('SELECT value FROM project_identity_claims WHERE namespace = ? AND value = ?', unusedNamespace, unusedValue), null);
    assert.equal(await a.get('SELECT id FROM audit_log WHERE project_id = ?', `beta-${index}`), null);
  }
  console.log('project-claim-workspace-pg-race-test: slug and code collisions passed');
} finally {
  await control.end();
  await Promise.all([a.close(), b.close()]);
}
