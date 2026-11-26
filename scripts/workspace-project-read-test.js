import './test-home.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, tokenKey } from '../src/core.js';
import { openTestDb } from './test-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-workspace-reads-'));
const db = await openTestDb(path.join(dir, 'switch.db'), { legacyProjects: false });
const at = '2026-01-01T00:00:00.000Z';
const collection = '/api/projects';
const events = id => `/api/projects/${id}/events`;
const dualToken = 'dual-session';
const platformToken = 'platform-session';
const outsiderToken = 'outsider-session';
const entered = Promise.withResolvers(), resume = Promise.withResolvers();
const config = { rateLimitPerMin: '100000' };
const stock = createApp({ db, docText: '', config });
const selected = createApp({ db, docText: '', config, async selectWorkspace({ request, accountId }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('testWorkspace');
  if (id && url.searchParams.has('hold')) {
    assert.equal(accountId, 'dual-account');
    entered.resolve();
    await resume.promise;
  }
  return id;
} });
// Same Web Request/Response handler, reused for every request as in a warm Worker.
const server = createServer(async (req, res) => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const app = req.headers['x-fixture-app'] === 'stock' ? stock : selected;
    const out = await app(new Request(base + req.url, { headers: req.headers }), base, { waitUntil() {} });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const call = async (token, route, workspace, { stock = false, hold = false } = {}) => {
  const url = new URL(route, `http://127.0.0.1:${server.address().port}`);
  if (workspace) url.searchParams.set('testWorkspace', workspace);
  if (hold) url.searchParams.set('hold', '1');
  const response = await fetch(url, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(stock ? { 'x-fixture-app': 'stock', 'x-workspace-id': 'other' } : {}) }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.json() };
};
function ok({ status, body }) { assert.equal(status, 200, JSON.stringify(body)); return body; }
function error({ status, body }, expected, code) { assert.deepEqual([status, body.error?.code], [expected, code], JSON.stringify(body)); }
const ids = body => body.items.map(p => p.id);
const person = async (id, account, workspace, role, token = id, kind = 'human', owner = null) => [
  'INSERT INTO participants (id, name, kind, code, token, created_at, updated_at, account_id, workspace_id, workspace_role, owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  [id, id, kind, id, await tokenKey(token), at, at, account, workspace, role, owner],
];
const project = (id, workspace, visibility, archived = 0, deletedAt = null) => [
  ['INSERT INTO projects (id, name, workspace_id, visibility, archived, deleted_at, created_at) VALUES (?,?,?,?,?,?,?)', [id, id, workspace, visibility, archived, deletedAt, at]],
  ['INSERT INTO project_events (project_id, at, text) VALUES (?,?,?)', [id, at, `event for ${id}`]],
];
try {
  await db.batch([
    ["UPDATE workspaces SET create_projects = 'approval' WHERE id = 'default'", []],
    ["INSERT INTO workspaces (id, name, create_projects, delete_own_messages) VALUES ('other', 'Other', 'admins', 'admins')", []],
    ...['dual-account', 'outsider-account', 'platform-account', 'local-admin-account'].map(id => [
      'INSERT INTO accounts (id, platform_role, created_at, updated_at) VALUES (?,?,?,?)', [id, id === 'platform-account' ? 'admin' : 'none', at, at],
    ]),
    await person('a-dual-default', 'dual-account', 'default', 'member', dualToken),
    await person('dual-other', 'dual-account', 'other', 'admin'),
    await person('outsider', 'outsider-account', 'default', 'member', outsiderToken),
    await person('platform-default', 'platform-account', 'default', 'member', platformToken),
    await person('local-admin', 'local-admin-account', 'default', 'admin'),
    await person('default-ai', null, 'default', 'member', 'ai-session', 'ai', 'a-dual-default'),
    ...project('default-open', 'default', 'open'), ...project('default-private', 'default', 'private'),
    ['INSERT INTO project_members (project_id, participant_id, role) VALUES (?,?,?)', ['default-open', 'a-dual-default', 'viewer']],
    ['INSERT INTO project_members (project_id, participant_id, role) VALUES (?,?,?)', ['default-open', 'default-ai', 'member']],
    ["INSERT INTO app_settings (key, value) VALUES ('slug:default-open', 'legacy-link'), ('pcode:default-open', 'MAIN')", []],
  ]);
  const baseline = ok(await call(dualToken, collection, null, { stock: true }));
  const defaultEvents = ok(await call(dualToken, events('default-open'), null, { stock: true }));
  const ai = ok(await call('ai-session', collection, null, { stock: true }));
  assert.deepEqual(ids(baseline), ['default-open']);
  assert.deepEqual([baseline.items[0].slug, baseline.items[0].code], ['legacy-link', 'MAIN']);
  assert.deepEqual(baseline.viewers, { 'default-open': ['a-dual-default'] });
  assert.equal(baseline.adminId, 'local-admin');
  assert.deepEqual([baseline.canCreateProject, baseline.canRequestProjectCreation, baseline.canReviewProjectCreationRequests, baseline.canDeleteOwnMessages], [false, true, false, true]);

  await db.batch([
    ...project('other-open', 'other', 'open'), ...project('other-private', 'other', 'private'),
    ...project('other-archive', 'other', 'private', 1), ...project('other-deleted', 'other', 'private', 1, at),
    // A stale cross-workspace edge must not make the participant a member or leak their ID in rollups.
    ['INSERT INTO project_members (project_id, participant_id, role) VALUES (?,?,?)', ['default-open', 'dual-other', 'admin']],
    ['INSERT INTO project_members (project_id, participant_id, role) VALUES (?,?,?)', ['other-private', 'outsider', 'admin']],
  ]);
  assert.deepEqual(ok(await call(dualToken, collection, 'other', { stock: true })), baseline);
  assert.deepEqual(ok(await call(dualToken, collection, 'default')), baseline);
  assert.deepEqual(ok(await call('ai-session', collection, 'other')), ai);
  assert.equal('canDeleteOwnMessages' in ai, false);
  const other = ok(await call(dualToken, collection, 'other'));
  assert.deepEqual(ids(other), ['other-archive', 'other-open', 'other-private']);
  assert.equal(other.adminId, 'dual-other');
  assert.deepEqual([other.canCreateProject, other.canRequestProjectCreation, other.canReviewProjectCreationRequests, other.canDeleteOwnMessages], [true, false, true, true]);
  assert.deepEqual(other.projectAdmins, { 'other-open': [], 'other-private': [] });
  assert.deepEqual(other.archivedProjectAdmins, { 'other-archive': [] });
  assert.deepEqual(other.items.map(p => p.memberCount), [0, 0, 0]);
  assert.deepEqual(Object.keys(other.join).sort(), ['other-open', 'other-private']);
  assert.deepEqual(ok(await call(dualToken, events('default-open'), 'default')), defaultEvents);
  assert.deepEqual(ok(await call(dualToken, events('other-private'), 'other')).items.map(e => e.text), ['event for other-private']);
  const missing = await call(dualToken, events('no-such-project'), 'default');
  error(missing, 404, 'NOT_FOUND');
  assert.deepEqual(await call(dualToken, events('other-open'), 'default'), missing);
  assert.deepEqual(await call(dualToken, events('default-private'), 'default'), missing);
  assert.deepEqual(await call(dualToken, events('default-open'), 'other'), missing);
  assert.deepEqual(await call(dualToken, events('other-deleted'), 'other'), missing);
  error(await call(outsiderToken, events('default-open'), 'default'), 403, 'NOT_ADMIN');
  error(await call(outsiderToken, collection, 'other'), 404, 'NOT_FOUND');
  assert.deepEqual(await call(outsiderToken, events('other-private'), 'other'), missing);
  error(await call('local-admin', collection, 'other'), 404, 'NOT_FOUND');
  error(await call(dualToken, collection, 'missing'), 404, 'NOT_FOUND');
  error(await call(null, collection, 'other'), 401, 'INVALID_TOKEN');
  assert.deepEqual(ids(ok(await call(platformToken, collection, 'other'))), ids(other));
  assert.equal(ok(await call(platformToken, collection, 'other')).adminId, 'dual-other');
  assert.deepEqual(ids(ok(await call(platformToken, collection, 'other', { stock: true }))), ['default-open', 'default-private']);
  assert.deepEqual(ok(await call(platformToken, events('other-private'), 'other')).items.map(e => e.text), ['event for other-private']);
  assert.deepEqual(await call(platformToken, events('other-open'), null, { stock: true }), missing);
  assert.equal(await db.get("SELECT id FROM participants WHERE account_id = 'platform-account' AND workspace_id = 'other'"), null);

  // Pause one request after authentication while both a different workspace and a default-only handler complete.
  const delayed = call(dualToken, collection, 'other', { hold: true });
  await Promise.race([entered.promise, delayed.then(r => assert.fail(`request did not enter selector: ${JSON.stringify(r)}`))]);
  try {
    assert.deepEqual(ok(await call(dualToken, collection)), baseline);
    assert.deepEqual(ok(await call(dualToken, '/api/me', 'other')).projects, ['default-open']);
  } finally { resume.resolve(); }
  assert.deepEqual(ok(await delayed), other);
  assert.deepEqual(ok(await call(dualToken, collection)), baseline);

  await db.run("UPDATE participants SET workspace_status = 'removed' WHERE id = 'dual-other'");
  error(await call(dualToken, collection, 'other'), 404, 'NOT_FOUND');
  assert.deepEqual(await call(dualToken, events('other-private'), 'other'), missing);
  assert.deepEqual(ok(await call(dualToken, collection)), baseline);
  await db.run("UPDATE participants SET workspace_status = 'active', status = 'disabled' WHERE id = 'dual-other'");
  error(await call(dualToken, collection, 'other'), 404, 'NOT_FOUND');
  await db.run("UPDATE participants SET status = 'active', workspace_role = 'member' WHERE id = 'dual-other'");
  await db.run("INSERT INTO project_members (project_id, participant_id, role) VALUES ('other-open', 'dual-other', 'member')");
  const demoted = ok(await call(dualToken, collection, 'other'));
  assert.deepEqual(ids(demoted), ['other-open']);
  assert.equal(demoted.canDeleteOwnMessages, false);
  assert.equal(demoted.canCreateProject, false);
  assert.equal(demoted.canReviewProjectCreationRequests, false);
  await db.run("UPDATE participants SET workspace_status = 'removed' WHERE id = 'a-dual-default'");
  error(await call(dualToken, collection), 401, 'INVALID_TOKEN');
  assert.deepEqual(ok(await call(dualToken, collection, 'other')), demoted);
  await db.run("UPDATE participants SET workspace_status = 'active' WHERE id = 'a-dual-default'");
  await db.run("UPDATE accounts SET status = 'disabled' WHERE id = 'dual-account'");
  error(await call(dualToken, collection, 'other'), 401, 'INVALID_TOKEN');
  error(await call(dualToken, collection), 401, 'INVALID_TOKEN');
  await db.run("UPDATE accounts SET platform_role = 'none' WHERE id = 'platform-account'");
  error(await call(platformToken, collection, 'other'), 404, 'NOT_FOUND');
  console.log('OK: fixture accounts, project collection and event isolation, request overlap and revocation');
} finally {
  resume.resolve();
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
