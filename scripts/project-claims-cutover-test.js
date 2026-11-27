import './test-home.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/core.js';
import { createProjectIdentity } from '../src/project-identity.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { appCaller } from './test-call.js';

const db = await openTestDb(TEST_PG_URL ? join(tmpdir(), `project-claims-cutover-${randomUUID()}.db`) : ':memory:', { legacyProjects: false });
try {
  const legacy = appCaller(createApp({ db, docText: '' }));
  const claimWriter = () => appCaller(createApp({ db, docText: '', projectClaimWrites: true }));
  const identity = createProjectIdentity({ db, nowIso: () => new Date().toISOString() });
  const reconcile = async () => assert.equal(await identity.reconcileDrainedClaims(), true, 'reconcile before admitting claim writers');
  const ok = r => { assert.ok(r.status < 400, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const { token } = ok(await legacy(null, '/api/join', 'POST', { name: 'LegacyWriter', role: 'PO' }));
  const create = (call, name, slug, code) => call(token, '/api/projects', 'POST', { name, slug, code });
  const diagnose = async call => ok(await call(token, '/api/admin/project-identity')).claims;
  const legacyId = ok(await create(legacy, 'Legacy project', 'legacy-route', 'LGY')).id;
  assert.equal((await diagnose(legacy)).status, 'stale');
  await reconcile();
  const active = claimWriter();
  assert.equal((await diagnose(active)).status, 'current', 'legacy projects gain their missing claimant rows');
  const changed = ok(await create(active, 'Claimed project', 'old-route', 'OLD')).id;

  // Roll back with all claim writers stopped. The legacy write updates settings only.
  ok(await legacy(token, `/api/projects/${changed}/slug`, 'PUT', { slug: 'new-route' }));
  ok(await legacy(token, `/api/projects/${legacyId}/code`, 'PUT', { code: 'LGNEW' }));
  assert.equal((await diagnose(legacy)).status, 'stale');
  await reconcile();
  const resumed = claimWriter();
  assert.equal((await diagnose(resumed)).status, 'current');
  const reuse = await create(resumed, 'Reused route', 'old-route', 'REUSE');
  assert.equal(reuse.status, 201, `reactivation releases a stale slug: ${JSON.stringify(reuse.body)}`);
  const historical = await create(resumed, 'Reserved code', 'available', 'LGY');
  assert.deepEqual([historical.status, historical.body.error?.code], [409, 'CODE_TAKEN']);

  // Old backups may contain reservations with no corresponding legacy setting.
  await db.batch([
    ["INSERT INTO project_identity_claims (namespace, value) VALUES ('code', 'HELD'), ('code', 'LOCK'), ('slug', 'old-dispute')", []],
    ["INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value) VALUES ('code', 'HELD', ?, 'historical_code', 'HELD'), ('slug', 'old-dispute', ?, 'slug', 'old-dispute'), ('slug', 'old-dispute', ?, 'slug', 'old-dispute')", [legacyId, legacyId, changed]],
  ]);
  await reconcile();
  const reconciled = claimWriter();
  for (const [name, slug, code, error] of [
    ['Historical only', 'available', 'HELD', 'CODE_TAKEN'],
    ['Opaque claim', 'available', 'LOCK', 'CODE_TAKEN'],
    ['Preserved dispute', 'old-dispute', 'AVAIL', 'SLUG_TAKEN'],
  ]) {
    const result = await create(reconciled, name, slug, code);
    assert.deepEqual([result.status, result.body.error?.code], [409, error]);
  }
  assert.deepEqual((await diagnose(reconciled)).disputes.map(d => d.value), ['old-dispute']);

  // A legacy writer cannot see a single-owner, claim-only code. Refuse to
  // normalize its conflicting assignment into an accepted active deployment.
  assert.equal((await create(legacy, 'Legacy took a code', 'legacy-took', 'HELD')).status, 201);
  assert.equal(await identity.reconcileDrainedClaims(), false, 'activation blocks on an unresolved assignment to a claim-only historical code');
  const stillReserved = (await diagnose(reconciled)).disputes;
  assert.deepEqual(stillReserved.map(d => d.value), ['old-dispute'], 'a rejected activation does not change stored claimants');
  console.log(`project-claims-cutover-test: drained activation and reactivation passed${TEST_PG_URL ? ' (PostgreSQL)' : ' (SQLite)'}`);
} finally { await db.close(); }
