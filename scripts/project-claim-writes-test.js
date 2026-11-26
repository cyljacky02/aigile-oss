// Exercise the staged writer through HTTP with the same limits as local D1.
import './test-home.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/core.js';
import { D1_SQLITE_LIMITS } from '../src/db-d1.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

const db = await openTestDb(TEST_PG_URL ? `project-claim-writes-${randomUUID()}.db` : ':memory:', { legacyProjects: false, limits: D1_SQLITE_LIMITS });
try {
  const app = createApp({ db, docText: '', projectClaimWrites: true });
  const call = appCaller(app);
  const ok = r => {
    assert.ok(r.status < 400, `${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const { token } = ok(await call(null, '/api/join', 'POST', { name: 'ClaimAdmin', role: 'PO' }));
  const diagnose = async () => ok(await call(token, '/api/admin/project-identity')).claims;
  assert.equal((await diagnose()).status, 'current', 'bootstrap reserves its route and code');
  const create = body => call(token, '/api/projects', 'POST', body);
  const { id } = ok(await create({ name: 'Claimed project', slug: 'claimed', code: 'CLAIM' })).items.find(p => p.name === 'Claimed project');
  assert.equal((await diagnose()).status, 'current', 'direct creation commits ownership alongside the project');
  const edit = (field, value) => call(token, `/api/projects/${id}/${field}`, 'PUT', { [field]: value });
  ok(await call(token, '/api/cards', 'POST', { project: id, title: 'Original card', requestId: 'claimed-card' }));
  ok(await edit('slug', 'new-claimed'));
  ok(await edit('code', 'NEXT'));
  ok(await edit('code', 'CLAIM'));
  assert.equal((await diagnose()).status, 'current', 'claim can be both current and historical for one project');
  assert.equal(ok(await call(token, '/api/cards/NEXT-1')).title, 'Original card');
  assert.equal(ok(await call(token, '/api/cards/CLAIM-1')).title, 'Original card');
  const aliasConflict = await create({ name: 'Blocked project', code: 'NEXT' });
  assert.deepEqual([aliasConflict.status, aliasConflict.body.error?.code], [409, 'CODE_TAKEN']);
  ok(await create({ name: 'Reuse old slug', slug: 'claimed', code: 'REUSE' }));
  assert.equal((await diagnose()).status, 'current');

  const { token: admin } = await adminSession(call, token);
  const { token: requester } = ok(await call(null, '/api/join', 'POST', { name: 'ClaimRequester', role: 'PG' }));
  ok(await call(admin, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }));
  const request = ok(await call(requester, '/api/project-creation-requests', 'POST', {
    requestId: 'claim-request', name: 'Approval project', reason: 'Exercise approval', slug: 'approved-route', code: 'APPR',
  }));
  assert.equal((await diagnose()).status, 'current', 'pending requests do not reserve identifiers');
  const approve = () => call(admin, `/api/project-creation-requests/${request.id}/approve`, 'POST', {});
  assert.equal(ok(await approve()).state, 'approved');
  assert.equal((await diagnose()).status, 'current', 'approval creates the project and claims together');
  assert.equal(ok(await approve()).state, 'approved', 'approval retry reuses the existing ownership');

  await db.run("UPDATE cards SET status = '已完成' WHERE project = ?", id); // Archive requires closed cards.
  const archive = () => call(token, `/api/projects/${id}/archive`, 'POST');
  const remove = () => call(admin, `/api/projects/${id}/delete`, 'POST', { confirmName: 'Claimed project' });
  ok(await archive());
  ok(await remove());
  const inWindow = await create({ name: 'Reserved in recovery', slug: 'new-claimed' });
  assert.deepEqual([inWindow.status, inWindow.body.error?.code], [409, 'SLUG_TAKEN']);
  ok(await call(admin, `/api/projects/${id}/restore`, 'POST'));
  ok(await call(token, `/api/projects/${id}/unarchive`, 'POST'));
  assert.equal(ok(await call(token, '/api/cards/NEXT-1')).title, 'Original card');
  ok(await archive());
  ok(await remove());
  await db.run('UPDATE projects SET purge_at = ? WHERE id = ?', Date.now() - 1, id);
  assert.equal((await app.runScheduled()).purged.projects, 1);
  const reused = ok(await create({ name: 'Reuse after purge', slug: 'new-claimed', code: 'NEXT' })).id;
  assert.equal((await diagnose()).status, 'current', 'purge releases slug, ID, current and historical claims');

  ok(await call(admin, '/api/admin/demo', 'POST', {}));
  assert.equal((await diagnose()).status, 'current', 'demo reserves identifiers');
  assert.equal(ok(await call(admin, '/api/admin/demo', 'DELETE')).keptProject, false);
  assert.equal((await diagnose()).status, 'current', 'demo removal releases identifiers');

  // Imported provenance can outlive the legacy alias setting. Ordinary writes
  // must still leave that dispute for the platform administrator to repair.
  await db.run("INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value) VALUES ('code', 'NEXT', ?, 'historical_code', 'NEXT')",
    'legacy-project');
  const before = (await diagnose()).disputes;
  assert.equal(before.find(d => d.value === 'NEXT')?.claimants.length, 2);
  const competing = await create({ name: 'Disputed code', code: 'NEXT' });
  assert.deepEqual([competing.status, competing.body.error?.code], [409, 'CODE_TAKEN']);
  const codeEdit = await call(admin, `/api/projects/${reused}/code`, 'PUT', { code: 'DIFF' });
  assert.deepEqual([codeEdit.status, codeEdit.body.error?.code], [409, 'IDENTITY_CONFLICT']);
  ok(await call(admin, `/api/projects/${reused}/archive`, 'POST'));
  ok(await call(admin, `/api/projects/${reused}/delete`, 'POST', { confirmName: 'Reuse after purge' }));
  const restore = await call(admin, `/api/projects/${reused}/restore`, 'POST');
  assert.deepEqual([restore.status, restore.body.error?.code], [409, 'IDENTITY_CONFLICT']);
  await db.run('UPDATE projects SET purge_at = ? WHERE id = ?', Date.now() - 1, reused);
  assert.equal((await app.runScheduled()).purged.projects, 0, 'purge waits for repair of a disputed current code');
  assert.deepEqual((await diagnose()).disputes, before);
  console.log('project-claim-writes-test: passed');
} finally { await db.close(); }
