import './test-home.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/core.js';
import { adminSession } from './test-admin.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ddlToPg, splitStatements } from '../src/sql-pg.js';
import { lockWorkspaceStmt } from '../src/write-order.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcr-account-'));
const file = path.join(dir, 'switch.db');
let db = await openTestDb(file);
let secondDb;
const servers = [];
const requests = '/api/project-creation-requests';
const workspaceId = 'private-workspace';
const config = { openJoin: '1', rateLimitPerMin: '100000', joinLimitPerHour: '100000' };

async function listen(options = {}) {
  const app = createApp({ db, docText: '', config, ...options });
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const out = await app(new Request(base + req.url, { method: req.method, headers: req.headers, body: body.length ? Buffer.concat(body) : undefined }), base);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return async (token, route, method = 'GET', body) => {
    const out = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
    }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: out.status, body: await out.json() };
  };
}

function expect(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body.error.code, code);
  return result.body;
}

try {
  const stock = await listen();
  const join = async name => {
    const { token, participant } = expect(await stock(null, '/api/join', 'POST', { name, role: 'PO' }), 201);
    const id = participant.participantId;
    return { id, name, token, accountId: (await db.get('SELECT account_id FROM participants WHERE id = ?', id)).account_id };
  };
  const boss = await join('PlatformAdmin');
  const member = await join('PrivateRequester');
  const defaultMember = await join('DefaultRequester');
  const other = await join('OtherMember');
  const workspaceAdmin = await join('PrivateAdmin');
  const session = await adminSession(stock, boss.token);
  const secondSession = await adminSession(stock, boss.token);
  expect(await stock(session.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), 200);
  const submit = (requestId, name) => stock(defaultMember.token, requests, 'POST', { requestId, name, reason: 'Default client', visibility: 'private' });
  const historical = expect(await submit('legacy', 'Legacy Project'), 201);
  expect(await stock(session.token, `${requests}/${historical.id}/approve`, 'POST', {}), 200);
  const defaultPending = expect(await submit('default', 'Default Pending'), 201);
  // Same project name in default, different slug and code. Only the name check is workspace-local.
  expect(await stock(session.token, '/api/projects', 'POST', { name: 'Private Project', slug: 'default-private', code: 'DEFP', visibility: 'private' }), 201);
  const at = new Date().toISOString();
  await db.batch([
    ["INSERT INTO workspaces (id, name, create_projects) VALUES (?, 'Private Workspace', 'approval')", [workspaceId]],
    ['UPDATE participants SET workspace_id = ? WHERE id = ?', [workspaceId, member.id]],
    ["UPDATE participants SET workspace_id = ?, workspace_role = 'admin' WHERE id = ?", [workspaceId, workspaceAdmin.id]],
    ...[['private-approve', 'Private Project', 'private-project', 'PRIV'], ['private-reject', 'Not Now', 'not-now', 'NOPE'], ['private-race', 'Race', 'race', 'RACE']].map(([id, name, slug, code]) =>
      ["INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, visibility, slug, code, state, created_at) VALUES (?, ?, ?, ?, ?, 'A project for this workspace', 'private', ?, ?, 'pending', ?)", [id, workspaceId, member.id, id, name, slug, code, at]]),
  ]);
  const writes = [];
  let beforeDecision = null;
  const selections = [];
  const selected = await listen({
    resolveReviewWorkspace: context => { selections.push(context); return workspaceId; },
    db: { ...db, async batch(stmts) {
      if (stmts.some(([sql]) => /^UPDATE project_creation_requests SET state = \?/.test(sql))) {
        writes.push(stmts.filter(([sql]) => sql === lockWorkspaceStmt('')[0]));
        if (beforeDecision) { const mutate = beforeDecision; beforeDecision = null; await mutate(); }
      }
      return db.batch(stmts);
    } },
  });
  const mine = expect(await stock(defaultMember.token, `${requests}?scope=mine`), 200);
  assert.deepEqual(mine.items.find(r => r.id === historical.id).endedBy, { kind: 'participant', id: boss.id });
  expect(await stock(defaultMember.token, `${requests}/${defaultPending.id}/approve`, 'POST', {}), 403, 'NOT_REVIEWER');
  assert.equal(expect(await stock(session.token, `${requests}?scope=review&state=pending&workspaceId=${workspaceId}`), 200).pendingTotal, 1);
  expect(await stock(session.token, `${requests}/private-approve/approve`, 'POST', {}), 404, 'NOT_FOUND');
  expect(await selected(session.token, '/api/workspace/settings'), 200);
  assert.equal(expect(await selected(defaultMember.token, `${requests}?scope=mine`), 200).items.length, 2);
  assert.deepEqual(selections, []);
  expect(await selected(session.token, `${requests}/${defaultPending.id}`), 404, 'NOT_FOUND');
  assert.deepEqual(selections, [{ accountId: boss.accountId, participantId: boss.id, authKind: 'device', deviceId: selections[0].deviceId }]);
  assert.ok(selections[0].deviceId);
  expect(await selected(secondSession.token, `${requests}/private-approve`), 200);
  assert.equal(selections[1].accountId, selections[0].accountId);
  assert.notEqual(selections[1].deviceId, selections[0].deviceId);
  const byDevice = await listen({ resolveReviewWorkspace: ({ deviceId }) => deviceId === selections[1].deviceId ? workspaceId : null });
  expect(await byDevice(session.token, `${requests}/${defaultPending.id}`), 200);
  expect(await byDevice(secondSession.token, `${requests}/${defaultPending.id}`), 404, 'NOT_FOUND');
  expect(await byDevice(secondSession.token, `${requests}/private-approve`), 200);
  expect(await stock(workspaceAdmin.token, `${requests}?scope=review`), 404, 'NOT_FOUND');
  expect(await stock(workspaceAdmin.token, `${requests}/${defaultPending.id}`), 404, 'NOT_FOUND');
  for (const action of ['approve', 'reject', 'withdraw'])
    expect(await stock(workspaceAdmin.token, `${requests}/${defaultPending.id}/${action}`, 'POST', { reason: 'No access' }), 404, 'NOT_FOUND');
  expect(await stock(workspaceAdmin.token, requests, 'POST', { requestId: 'wrong-scope', name: 'Wrong Workspace', reason: 'No access' }), 403, 'FORBIDDEN');
  expect(await stock(workspaceAdmin.token, '/api/projects', 'POST', { name: 'Wrong Workspace' }), 403, 'NOT_ADMIN');
  expect(await stock(workspaceAdmin.token, '/api/workspace/settings', 'PUT', { name: 'Wrong Workspace' }), 403, 'NOT_ADMIN');
  expect(await stock(workspaceAdmin.token, '/api/workspace/settings/create-projects-preview'), 403, 'NOT_ADMIN');
  assert.equal(expect(await selected(workspaceAdmin.token, `${requests}?scope=review`), 200).pendingTotal, 3);
  const own = expect(await selected(member.token, `${requests}/private-approve`), 200);
  assert.equal(own.requesterId, member.id);
  assert.equal(own.review, undefined);
  expect(await selected(member.token, `${requests}?scope=review`), 404, 'NOT_FOUND');
  expect(await selected(session.token, `${requests}/private-reject/withdraw`, 'POST', {}), 404, 'NOT_FOUND');
  const queue = expect(await selected(session.token, `${requests}?scope=review&state=pending`), 200);
  assert.equal(queue.pendingTotal, 3);
  assert.deepEqual(queue.items.map(r => r.id).sort(), ['private-approve', 'private-race', 'private-reject']);
  const detail = expect(await selected(session.token, `${requests}/private-approve`), 200);
  assert.equal(detail.requesterName, member.name);
  assert.deepEqual(detail.review.conflicts, []);
  assert.equal(detail.review.canApprove, true);
  const reject = (caller, token, id) => caller(token, `${requests}/${id}/reject`, 'POST', { reason: 'Not this quarter' });
  expect(await reject(selected, member.token, 'private-reject'), 403, 'NOT_REVIEWER');
  expect(await reject(selected, other.token, 'private-reject'), 404, 'NOT_FOUND');
  expect(await reject(selected, null, 'private-reject'), 401, 'INVALID_TOKEN');
  const approved = expect(await selected(session.token, `${requests}/private-approve/approve`, 'POST', {}), 200);
  assert.equal(approved.state, 'approved');
  assert.deepEqual(approved.endedBy, { kind: 'account', id: boss.accountId });
  assert.equal(approved.requesterId, member.id);
  assert.equal(approved.project.available, true);
  assert.deepEqual(await db.all('SELECT participant_id, role FROM project_members WHERE project_id = ?', approved.project.id).then(rows => rows.map(r => ({ ...r }))),
    [{ participant_id: member.id, role: 'admin' }]);
  assert.equal(await db.get('SELECT id FROM participants WHERE account_id = ? AND workspace_id = ?', boss.accountId, workspaceId), null);
  assert.equal(expect(await selected(session.token, `${requests}/private-approve/approve`, 'POST', {}), 200).duplicate, true);
  const rejected = expect(await reject(selected, session.token, 'private-reject'), 200);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.endedBy, approved.endedBy);
  assert.equal(rejected.project, null);
  assert.equal(rejected.rejectReason, 'Not this quarter');
  assert.deepEqual(writes, [[lockWorkspaceStmt('default'), lockWorkspaceStmt(workspaceId)], [lockWorkspaceStmt(workspaceId)]]);
  const audits = expect(await stock(session.token, `/api/audit-log?actor=${boss.accountId}`), 200);
  assert.deepEqual(audits.items.map(e => e.action).sort(), ['project.create', 'project_creation_request.reject']);
  for (const e of audits.items) {
    assert.deepEqual(e.actor, { kind: 'account', id: boss.accountId, name: boss.name });
    assert.equal(e.scope.workspaceId, workspaceId);
    assert.equal(e.detail.requester.id, member.id);
  }
  assert.deepEqual(expect(await stock(session.token, '/api/audit-log?scope=workspace'), 200).items.filter(e => e.scope.workspaceId === workspaceId), []);
  await db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", boss.accountId);
  expect(await reject(selected, session.token, 'private-race'), 401, 'INVALID_TOKEN');
  await db.run("UPDATE accounts SET status = 'active' WHERE id = ?", boss.accountId);
  beforeDecision = () => db.run("UPDATE accounts SET platform_role = 'none' WHERE id = ?", boss.accountId);
  expect(await reject(selected, session.token, 'private-race'), 404, 'NOT_FOUND');
  expect(await selected(session.token, `${requests}?scope=review`), 404, 'NOT_FOUND');
  await db.run("UPDATE accounts SET platform_role = 'admin' WHERE id = ?", boss.accountId);
  assert.equal(expect(await selected(session.token, `${requests}/private-race`), 200).state, 'pending');
  assert.equal(expect(await stock(session.token, `/api/audit-log?actor=${boss.accountId}`), 200).items.length, 2);
  const memberReview = expect(await reject(selected, workspaceAdmin.token, 'private-race'), 200);
  assert.deepEqual(memberReview.endedBy, { kind: 'participant', id: workspaceAdmin.id });
  assert.deepEqual(expect(await stock(session.token, `/api/audit-log?actor=${workspaceAdmin.id}`), 200).items.map(e => [e.actor.id, e.scope.workspaceId]), [[workspaceAdmin.id, workspaceId]]);
  await db.run('UPDATE participants SET account_id = ? WHERE id = ?', other.accountId, workspaceAdmin.id);
  await db.run(`INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, state, created_at)
    VALUES ('alternate-member', ?, ?, 'alternate', 'Alternate Member', 'Membership context', 'pending', ?)`, workspaceId, member.id, at);
  // The authenticated participant is a default member. The role and recorded actor come from its account's selected membership.
  expect(await stock(other.token, `${requests}?scope=review`), 404, 'NOT_FOUND');
  const alternate = expect(await reject(selected, other.token, 'alternate-member'), 200);
  assert.deepEqual(alternate.endedBy, { kind: 'participant', id: workspaceAdmin.id });
  const defaultId = expect(await stock(session.token, '/api/projects', 'POST', { name: 'Default Rename', slug: 'default-rename', code: 'DRNM' }), 201).id;
  expect(await stock(session.token, `/api/projects/${approved.project.id}`, 'PATCH', { name: 'Outside Default' }), 404, 'NOT_FOUND');
  expect(await stock(workspaceAdmin.token, `/api/projects/${defaultId}`, 'PATCH', { name: 'Outside Scope' }), 404, 'NOT_FOUND');
  await db.run('UPDATE projects SET name = ? WHERE id = ?', 'Taken Only In B', approved.project.id);
  expect(await stock(session.token, `/api/projects/${defaultId}`, 'PATCH', { name: 'Taken Only In B' }), 200);
  expect(await stock(session.token, '/api/projects', 'POST', { name: 'Private Project', slug: 'name-scope', code: 'NMSC' }), 409, 'NAME_TAKEN');
  await db.run('UPDATE projects SET name = ? WHERE id = ?', 'Only In Workspace B', approved.project.id);
  expect(await stock(session.token, '/api/projects', 'POST', { name: 'Only In Workspace B', slug: 'name-scope', code: 'NMSC' }), 201);
  expect(await stock(session.token, `/api/projects/${defaultId}`, 'PATCH', { name: 'Only In Workspace B' }), 409, 'NAME_TAKEN');
  console.log('OK: real HTTP workspace review, account attribution, authorization, locking and default clients');

  secondDb = await openTestDb(file);
  let rendezvous;
  const racingDb = connection => ({ ...connection, async batch(stmts) {
    if (rendezvous && stmts.some(([sql]) => /^UPDATE project_creation_requests SET state = ?/.test(sql))) await rendezvous(stmts);
    return connection.batch(stmts);
  } });
  const raceDefault = await listen({ db: racingDb(db) });
  const raceSelected = await listen({ db: racingDb(secondDb), resolveReviewWorkspace: () => workspaceId });
  for (const [field, defaults, privateSpec, errorCode] of [
    ['slug', { slug: 'claim-race', code: 'RACEA' }, { slug: 'claim-race', code: 'RACEB' }, 'SLUG_TAKEN'],
    ['code', { slug: 'claim-default', code: 'CLMS' }, { slug: 'claim-private', code: 'CLMS' }, 'CODE_TAKEN'],
  ]) {
    const name = `Parallel ${field}`;
    const pending = expect(await stock(defaultMember.token, requests, 'POST', { requestId: name, name, reason: name, ...defaults }), 201);
    const scopedId = `claim-${field}`;
    await db.run(`INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, slug, code, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, scopedId, workspaceId, member.id, scopedId, name, name, privateSpec.slug, privateSpec.code, at);
    const batches = [];
    const { promise, resolve, reject } = Promise.withResolvers();
    const timeout = setTimeout(() => reject(new Error('both connections must reach the write after their prechecks')), 5000);
    rendezvous = stmts => {
      batches.push(stmts);
      if (batches.length === 2) resolve();
      return promise;
    };
    const approve = (caller, id) => caller(session.token, `${requests}/${id}/approve`, 'POST', {});
    let results;
    try {
      results = await Promise.all([approve(raceDefault, pending.id), approve(raceSelected, scopedId)]);
    } finally {
      clearTimeout(timeout);
      rendezvous = null;
    }
    assert.equal(batches.length, 2);
    const target = batches.find(stmts => stmts[1][0] === lockWorkspaceStmt('')[0]);
    assert.deepEqual(target?.slice(0, 2), [lockWorkspaceStmt('default'), lockWorkspaceStmt(workspaceId)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    expect(results.find(r => r.status === 409), 409, errorCode);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE ? AND value = ?',
      field === 'slug' ? 'slug:%' : 'pcode:%', defaults[field])).n), 1);
    const states = await db.all('SELECT state FROM project_creation_requests WHERE id IN (?, ?)', pending.id, scopedId);
    assert.deepEqual(states.map(r => r.state).sort(), ['approved', 'pending']);
  }
  console.log('OK: two database connections serialize matching slug and code claims across workspaces');

  // Recreate the pre-018 shape on the fixture and exercise the code-before-migration window.
  await db.batch([
    ['DROP TABLE project_creation_requests', []],
    ['ALTER TABLE audit_log DROP COLUMN actor_account_id', []],
    ['DELETE FROM schema_migrations WHERE name = ?', ['018_account_review_actors.sql']],
    ['DELETE FROM audit_log WHERE actor_kind = ?', ['account']],
  ]);
  const oldSchema = fs.readFileSync(new URL('../migrations/015_project_creation_requests.sql', import.meta.url), 'utf8');
  await db.batch(splitStatements(db.kind === 'postgres' ? ddlToPg(oldSchema) : oldSchema).map(sql => [sql, []]));
  await db.run(`INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, state, created_at)
    VALUES ('before-018', ?, ?, 'old', 'Before 018', 'Old shape', 'pending', ?)`, workspaceId, member.id, at);
  expect(await reject(selected, session.token, 'before-018'), 503, 'PROJECT_CREATION_REQUESTS_NOT_READY');
  assert.equal(expect(await selected(session.token, `${requests}/before-018`), 200).state, 'pending');
  assert.ok(expect(await stock(session.token, `/api/audit-log?actor=${boss.id}`), 200).items.some(e => e.action === 'project.create'));
  const preMigration = expect(await submit('pre-migration', 'Legacy Review'), 201);
  assert.deepEqual(expect(await reject(stock, session.token, preMigration.id), 200).endedBy, { kind: 'participant', id: boss.id });
  if (db.kind === 'postgres') {
    const [{ default: pg }, { setPgSearchPath, testSchemaFor }] = await Promise.all([import('pg'), import('../src/db-pg.js')]);
    const writer = new pg.Client({ connectionString: TEST_PG_URL });
    await writer.connect();
    let upgrade;
    try {
      await setPgSearchPath(writer, testSchemaFor(dir));
      await writer.query('BEGIN');
      await writer.query(`UPDATE project_creation_requests SET name = 'Committed by old writer' WHERE id = 'before-018'`);
      upgrade = openTestDb(file);
      upgrade.catch(() => {});
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rowCount } = await writer.query(`SELECT 1 FROM pg_locks WHERE relation = 'project_creation_requests'::regclass
          AND mode = 'AccessExclusiveLock' AND NOT granted`);
        if (rowCount) break;
        assert.ok(Date.now() < deadline, 'migration waits for the old writer');
        await delay(20);
      }
      await writer.query('COMMIT');
      const upgraded = await upgrade;
      await db.close();
      db = upgraded;
      assert.equal((await db.get(`SELECT name FROM project_creation_requests WHERE id = 'before-018'`)).name, 'Committed by old writer');
    } finally {
      await writer.end();
      if (upgrade) await upgrade.then(upgraded => upgraded === db ? undefined : upgraded.close()).catch(() => {});
    }
  } else {
    await db.close();
    db = await openTestDb(file);
  }
  const after = await listen({ resolveReviewWorkspace: () => workspaceId });
  const upgradedStock = await listen();
  assert.deepEqual(expect(await upgradedStock(session.token, `${requests}/${preMigration.id}`), 200).endedBy, { kind: 'participant', id: boss.id });
  assert.deepEqual(expect(await reject(after, session.token, 'before-018'), 200).endedBy, { kind: 'account', id: boss.accountId });
  console.log('OK: pre-018 fallback and migration preserve participant history and enable account attribution');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await secondDb?.close();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
