// 升級後保留專案網址、卡號與舊代號，並留下有衝突的識別碼及來源。
import './test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { D1_SQLITE_LIMITS } from '../src/db-d1.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-identity-claims-'));
const file = path.join(dir, 'switch.db');
const open = () => openTestDb(file, { legacyProjects: false, limits: D1_SQLITE_LIMITS });
const at = '2026-01-01T00:00:00.000Z';
const diagnostic = '/api/admin/project-identity';
const migration = '016_project_identity_claims.sql';
let db;
function site(adapter) {
  const app = createApp({ db: adapter, docText: '' });
  return async (token, route, method = 'GET', body) => {
    const response = await app(new Request('http://localhost' + route, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body && JSON.stringify(body) }), 'http://localhost');
    return { status: response.status, body: await response.json() };
  };
}
const ok = ({ status, body }) => { assert.ok(status < 400, `${status} ${JSON.stringify(body)}`); return body; };

try {
  db = await open();
  let call = site(db);
  const admin = ok(await call(null, '/api/join', 'POST', { name: 'PlatformAdmin', role: 'PO' })).token;
  const member = ok(await call(null, '/api/join', 'POST', { name: 'WorkspaceMember', role: 'PG' })).token;
  // 模擬已經正規化、還沒加識別碼保留表的站。兩張卡的專案內編號相同。
  await db.batch([
    ['DROP TABLE IF EXISTS project_identity_claimants', []],
    ['DROP TABLE IF EXISTS project_identity_claims', []],
    ['DELETE FROM schema_migrations WHERE name = ?', [migration]],
    ["UPDATE app_settings SET value = '{}' WHERE key = 'project_identity_ready'", []],
    ["INSERT INTO projects (id, name, workspace_id, created_at, visibility) VALUES ('a', 'Canonical', 'default', ?, 'open'), ('Legacy-Web', 'Historical', 'default', ?, 'open'), ('tomb', 'Recoverable', 'default', ?, 'open'), ('Kelvin-Web', 'Kelvin', 'default', ?, 'open')", [at, at, at, at]],
    ["UPDATE projects SET archived = 1, deleted_at = ?, purge_at = ? WHERE id = 'tomb'", [at, Date.now() + 86400_000]],
    ["INSERT INTO app_settings (key, value) VALUES ('slug:a','legacy-web'), ('slug:Legacy-Web','website'), ('slug:tomb','dead'), ('pcode:a','CLSH'), ('pcode:Legacy-Web','WEBS'), ('pcode:tomb','DEAD'), ('pcodeold:CLSH','Legacy-Web'), ('pcodeold:SITE','Legacy-Web'), ('pcodeold:WEBS','Legacy-Web')", []],
    ["INSERT INTO cards (uid, title, project, proj_no, created_by, created_at, updated_at) VALUES ('fixture-c1', 'Canonical card', 'a', 1, 'system', ?, ?), ('fixture-c2', 'Historical card', 'Legacy-Web', 1, 'system', ?, ?)", [at, at, at, at]],
  ]);
  const beforeMigration = site(db);
  ok(await beforeMigration(null, '/api/health'));
  const projects = ok(await beforeMigration(admin, '/api/projects')).items;
  const legacyProject = projects.find(p => p.id === 'Legacy-Web');
  assert.deepEqual([legacyProject?.slug, legacyProject?.code], ['website', 'WEBS']);
  for (const [method, route, body] of [
    ['POST', '/api/projects', { name: 'Blocked project', slug: 'blocked-project', code: 'BLCK' }],
    ['PUT', '/api/projects/Legacy-Web/slug', { slug: 'blocked-slug' }],
    ['PUT', '/api/projects/Legacy-Web/code', { code: 'BLCK' }],
  ]) {
    const r = await beforeMigration(admin, route, method, body);
    assert.deepEqual([r.status, r.body.error?.code], [503, 'IDENTITY_NOT_READY']);
  }
  assert.deepEqual(ok(await beforeMigration(admin, '/api/projects')).items, projects);
  const backup = ok(await beforeMigration(admin, '/api/admin/backup?files=0'));
  assert.ok(backup.tables.some(t => t.name === 'projects'));
  assert.ok(backup.tables.every(t => !['project_identity_claims', 'project_identity_claimants'].includes(t.name)));

  await db.close();
  db = await open();
  call = site(db);
  assert.deepEqual(ok(await call(admin, '/api/projects')).items.filter(p => ['a', 'Legacy-Web'].includes(p.id)).map(p => [p.id, p.slug, p.code]).sort(), [
    ['Legacy-Web', 'website', 'WEBS'], ['a', 'legacy-web', 'CLSH'],
  ]);
  for (const [route, cardId, title] of [['CLSH-1', 'CLSH-1', 'Canonical card'], ['SITE-1', 'WEBS-1', 'Historical card']]) {
    const card = ok(await call(admin, `/api/cards/${route}`));
    assert.deepEqual([card.cardId, card.title], [cardId, title]);
  }
  const { claims } = ok(await call(admin, diagnostic));
  assert.equal(claims?.status, 'current', '已正規化的舊站也會補上保留表');
  assert.deepEqual(claims.disputes, [
    { namespace: 'code', value: 'CLSH', claimants: [
      { projectId: 'Legacy-Web', source: 'historical_code', rawValue: 'CLSH' },
      { projectId: 'a', source: 'current_code', rawValue: 'CLSH' },
    ] },
    { namespace: 'slug', value: 'legacy-web', claimants: [
      { projectId: 'Legacy-Web', source: 'project_id', rawValue: 'Legacy-Web' },
      { projectId: 'a', source: 'slug', rawValue: 'legacy-web' },
    ] },
  ], '沒有替任何有衝突的值選出贏家');
  const routeToken = await db.get("SELECT value FROM project_identity_claimants WHERE source = 'project_id' AND project_id = ?", 'Kelvin-Web');
  assert.equal(routeToken.value, 'Kelvin-web', '只折疊 ASCII 字元，保留舊專案 ID 的 Kelvin 字元');
  assert.equal((await call(admin, '/api/projects', 'POST', { name: 'ASCII Kelvin', slug: 'kelvin-web', code: 'ASK' })).status, 201);
  assert.equal((await call(member, diagnostic)).status, 403);
  // 主鍵保留整個值。有衝突的值不能再 INSERT，兩個命名空間可以各用一次相同的文字。
  for (const [namespace, value] of [['code', 'CLSH'], ['code', 'SITE'], ['slug', 'legacy-web'], ['code', 'DEAD'], ['slug', 'dead']]) {
    await assert.rejects(() => db.run('INSERT INTO project_identity_claims (namespace, value) VALUES (?, ?)', namespace, value), /unique|duplicate/i);
  }
  await assert.rejects(() => db.run("INSERT INTO project_identity_claims (namespace, value) VALUES ('slug', 'Legacy-Web')"), /check/i);
  await assert.rejects(() => db.run("INSERT INTO project_identity_claims (namespace, value) VALUES ('code', 'clsh')"), /check/i);
  await db.run("INSERT INTO project_identity_claims (namespace, value) VALUES ('slug', '123'), ('code', '123')");
  await db.run("DELETE FROM project_identity_claims WHERE value = '123'");
  const winners = await Promise.allSettled([1, 2].map(() => db.run("INSERT INTO project_identity_claims (namespace, value) VALUES ('code', 'RACE')")));
  assert.deepEqual(winners.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(winners.find(r => r.status === 'rejected').reason.message, /unique|duplicate/i);
  await db.run("DELETE FROM project_identity_claims WHERE namespace = 'code' AND value = 'RACE'");
  assert.equal(ok(await call(admin, '/api/deleted-projects')).items.find(p => p.projectId === 'tomb')?.code, 'DEAD');
  ok(await call(admin, '/api/projects/a/code', 'PUT', { code: 'ANEW' }));
  const restarted = site(db);
  const afterWrite = ok(await restarted(admin, diagnostic));
  assert.equal(afterWrite.claims.status, 'stale', '舊寫入後不能把快照當成現況');
  assert.deepEqual(afterWrite.claims.disputes, claims.disputes, '新執行個體不會覆寫既有爭議的來源');
  assert.equal(afterWrite.conflicts.some(c => c.kind === 'code_is_old_alias'), false, '既有診斷仍反映現況');
  assert.equal(ok(await restarted(admin, '/api/cards/CLSH-1')).title, 'Historical card', '改代號後沿用既有的舊代號查找規則');

  // 把爭議寫在交易外檢查之後，驗證建立的交易內仍會擋下。
  for (const [namespace, value, source, field, error] of [
    ['slug', 'racing-slug', 'slug', 'slug', 'SLUG_TAKEN'],
    ['code', 'RACEC', 'current_code', 'code', 'CODE_TAKEN'],
  ]) {
    let injected = false;
    const interleaved = site({ ...db, batch: async stmts => {
      if (!injected && stmts.some(([sql]) => sql.startsWith('INSERT INTO projects '))) {
        injected = true;
        await db.batch([
          ['INSERT INTO project_identity_claims (namespace, value) VALUES (?, ?)', [namespace, value]],
          ...['a', 'Legacy-Web'].map(id => ['INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value) VALUES (?,?,?,?,?)', [namespace, value, id, source, value]]),
        ]);
      }
      return db.batch(stmts);
    } });
    const r = await interleaved(admin, '/api/projects', 'POST', { name: 'Racing claim', [field]: value });
    assert.equal(injected, true);
    assert.deepEqual([r.status, r.body.error?.code], [409, error]);
  }
  console.log('project-identity-claims-test：通過');
} finally {
  await db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
