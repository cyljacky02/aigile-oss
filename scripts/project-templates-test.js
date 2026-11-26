// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-templates-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { appCaller } from './test-call.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-project-templates-'));
const db = await openTestDb(path.join(dir, 'switch.db'));
const call = appCaller(createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', teamCacheMs: '0' } }));
const base = '/api/workspace/project-templates';
const expect = (r, status) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const statuses = [
  { name: '準備', category: '待處理', color: 'violet' },
  { name: '製作', category: '進行中', color: 'amber' },
  { name: '交付', category: '已完成', color: 'green' },
];

try {
  const join = async name => expect(await call(null, '/api/join', 'POST', { name, role: 'PG' }), 201);
  const platform = await join('林志明'), admin = await join('李安娜'), member = await join('陳大文');
  const session = await adminSession(call, platform.token);
  expect(await call(session.token, `/api/participants/${admin.participant.participantId}/workspace-role`, 'PUT', { role: 'admin' }), 200);
  const defaults = { name: '交付流程', visibility: 'private', statuses };
  const template = expect(await call(admin.token, base, 'POST', defaults), 201);
  assert.deepEqual(expect(await call(member.token, base), 200).items, [template]);
  const selection = expect(await call(member.token, `${base}/${template.id}`), 200);
  assert.deepEqual(selection, { id: template.id, ...defaults });
  assert.equal((await call(member.token, base, 'POST', defaults)).status, 403);
  assert.equal((await call(admin.token, base, 'POST', { ...defaults, statuses: statuses.slice(0, 2) })).status, 400);
  assert.equal((await call(admin.token, base, 'POST', { ...defaults, visibility: 'secret' })).status, 400);

  // Phase 1 has no second-workspace UI. Seed a foreign row and verify the public list and selection routes.
  await db.run("INSERT INTO workspaces (id, name) VALUES ('other', 'Other')");
  await db.run('INSERT INTO project_templates (workspace_id, id, name, visibility, statuses_json) VALUES (?,?,?,?,?)', 'other', 'pt_other', '其他範本', 'open', JSON.stringify(statuses));
  assert.deepEqual(expect(await call(member.token, base), 200).items, [template]);
  for (const [method, body] of [['GET'], ['PUT', defaults], ['DELETE']]) {
    expect(await call(admin.token, `${base}/pt_other`, method, body), 404);
  }

  const policy = async createProjects => expect(await call(admin.token, '/api/workspace/settings', 'PUT', { createProjects }), 200);
  const direct = spec => call(member.token, '/api/projects', 'POST', { name: '直接建立', ...spec });
  const requestBody = { requestId: 'template-request', name: '申請建立', reason: '要新看板', visibility: selection.visibility, statuses: selection.statuses };
  const requests = '/api/project-creation-requests';
  await policy('admins');
  expect(await direct(selectionFields()), 403);
  expect(await call(member.token, requests, 'POST', requestBody), 403);
  await policy('members');
  expect(await direct({ ...selectionFields(), statuses: [] }), 400);
  const directResult = expect(await direct(selectionFields()), 201);
  assertProject(directResult.items.find(p => p.id === directResult.id));
  await policy('approval');
  expect(await direct(selectionFields()), 403);
  expect(await call(member.token, requests, 'POST', { ...requestBody, statuses: [] }), 400);
  const request = expect(await call(member.token, requests, 'POST', requestBody), 201);
  const selectedPath = `${base}/${template.id}`;
  const requestPath = `${requests}/${request.id}`;
  assert.equal(request.state, 'pending');
  assertSnapshot(request);

  const update = { ...defaults, name: '新版流程', visibility: 'open', statuses: statuses.map((s, i) => i === 0 ? { ...s, name: '新版準備' } : s) };
  expect(await call(member.token, selectedPath, 'PUT', update), 403);
  expect(await call(member.token, selectedPath, 'DELETE'), 403);
  expect(await call(admin.token, selectedPath, 'PUT', update), 200);
  assert.deepEqual(expect(await call(member.token, selectedPath), 200), { id: template.id, ...update });
  assertSnapshot(expect(await call(admin.token, requestPath), 200));
  expect(await call(admin.token, selectedPath, 'DELETE'), 200);
  assert.deepEqual(expect(await call(member.token, base), 200).items, []);
  expect(await call(member.token, selectedPath), 404);
  expect(await call(admin.token, selectedPath, 'PUT', update), 404);
  assertSnapshot(expect(await call(admin.token, requestPath), 200));
  assert.equal(expect(await call(member.token, requests, 'POST', requestBody), 200).duplicate, true);
  const approval = expect(await call(admin.token, `${requestPath}/approve`, 'POST', {}), 200);
  assert.equal(approval.state, 'approved');
  const projects = expect(await call(member.token, '/api/projects'), 200).items;
  assertProject(projects.find(p => p.id === approval.project.id));
  console.log('project-templates-test：全部通過');

  function selectionFields() { return { visibility: selection.visibility, statuses: selection.statuses }; }
  function assertSnapshot(q) { assert.deepEqual({ visibility: q.visibility, statuses: q.statuses }, selectionFields()); }
  function assertProject(project) {
    assert.equal(project.visibility, 'private');
    assert.deepEqual(project.statuses.map(({ name, category, color }) => ({ name, category, color })), statuses);
  }
} finally {
  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
}
