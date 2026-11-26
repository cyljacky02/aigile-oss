import './test-home.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/core.js';
import { adminSession } from './test-admin.js';
import { openTestDb } from './test-db.js';
import { ddlToPg, splitStatements } from '../src/sql-pg.js';
import { lockWorkspaceStmt } from '../src/write-order.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcr-account-'));
let db = await openTestDb(path.join(dir, 'switch.db'));
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
  const session = await adminSession(stock, boss.token);
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
    ...[['private-approve', 'Private Project', 'private-project', 'PRIV'], ['private-reject', 'Not Now', 'not-now', 'NOPE'], ['private-race', 'Race', 'race', 'RACE']].map(([id, name, slug, code]) =>
      ["INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, visibility, slug, code, state, created_at) VALUES (?, ?, ?, ?, ?, 'A project for this workspace', 'private', ?, ?, 'pending', ?)", [id, workspaceId, member.id, id, name, slug, code, at]]),
  ]);
  const writes = [];
  let beforeDecision = null;
  const resolvedAccounts = [];
  const selected = await listen({
    resolveReviewWorkspace: ({ accountId }) => { resolvedAccounts.push(accountId); return workspaceId; },
    db: { ...db, async batch(stmts) {
      if (stmts.some(([sql]) => /^UPDATE project_creation_requests SET state = \?/.test(sql))) {
        writes.push(stmts[0]);
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
  assert.deepEqual(resolvedAccounts, []);
  expect(await selected(session.token, `${requests}/${defaultPending.id}`), 404, 'NOT_FOUND');
  assert.deepEqual(resolvedAccounts, [boss.accountId]);
  expect(await selected(session.token, `${requests}/private-reject/withdraw`, 'POST', {}), 404, 'NOT_FOUND');
  const queue = expect(await selected(session.token, `${requests}?scope=review&state=pending`), 200);
  assert.equal(queue.pendingTotal, 3);
  assert.deepEqual(queue.items.map(r => r.id).sort(), ['private-approve', 'private-race', 'private-reject']);
  const detail = expect(await selected(session.token, `${requests}/private-approve`), 200);
  assert.equal(detail.requesterName, member.name);
  assert.deepEqual(detail.review.conflicts, []);
  assert.equal(detail.review.canApprove, true);
  const reject = (caller, token, id) => caller(token, `${requests}/${id}/reject`, 'POST', { reason: 'Not this quarter' });
  for (const t of [member.token, other.token]) expect(await reject(selected, t, 'private-reject'), 404, 'NOT_FOUND');
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
  assert.deepEqual(writes, [lockWorkspaceStmt(workspaceId), lockWorkspaceStmt(workspaceId)]);
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
  console.log('OK: real HTTP workspace review, account attribution, authorization, locking and default clients');

  // Recreate the pre-017 shape on the fixture and exercise the code-before-migration window.
  await db.batch([
    ['DROP TABLE project_creation_requests', []],
    ['ALTER TABLE audit_log DROP COLUMN actor_account_id', []],
    ['DELETE FROM schema_migrations WHERE name = ?', ['017_account_review_actors.sql']],
    ['DELETE FROM audit_log WHERE actor_kind = ?', ['account']],
  ]);
  const oldSchema = fs.readFileSync(new URL('../migrations/015_project_creation_requests.sql', import.meta.url), 'utf8');
  await db.batch(splitStatements(db.kind === 'postgres' ? ddlToPg(oldSchema) : oldSchema).map(sql => [sql, []]));
  await db.run(`INSERT INTO project_creation_requests (id, workspace_id, requester_id, request_id, name, reason, state, created_at)
    VALUES ('before-017', ?, ?, 'old', 'Before 017', 'Old shape', 'pending', ?)`, workspaceId, member.id, at);
  expect(await reject(selected, session.token, 'before-017'), 503, 'PROJECT_CREATION_REQUESTS_NOT_READY');
  assert.equal(expect(await selected(session.token, `${requests}/before-017`), 200).state, 'pending');
  assert.ok(expect(await stock(session.token, `/api/audit-log?actor=${boss.id}`), 200).items.some(e => e.action === 'project.create'));
  const preMigration = expect(await submit('pre-migration', 'Legacy Review'), 201);
  assert.deepEqual(expect(await reject(stock, session.token, preMigration.id), 200).endedBy, { kind: 'participant', id: boss.id });
  await db.close();
  db = await openTestDb(path.join(dir, 'switch.db'));
  const after = await listen({ resolveReviewWorkspace: () => workspaceId });
  const upgradedStock = await listen();
  assert.deepEqual(expect(await upgradedStock(session.token, `${requests}/${preMigration.id}`), 200).endedBy, { kind: 'participant', id: boss.id });
  assert.deepEqual(expect(await reject(after, session.token, 'before-017'), 200).endedBy, { kind: 'account', id: boss.accountId });
  console.log('OK: pre-017 fallback and migration preserve participant history and enable account attribution');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
