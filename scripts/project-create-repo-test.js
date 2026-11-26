// 透過直接建立 API 測試程式庫設定。預設用 SQLite，設 AIGILE_TEST_PG_URL 時用 Postgres。
import './test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';

await test('直接建立專案與程式庫設定', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrepo-'));
  const db = await openTestDb(path.join(dir, 'switch.db'));
  t.after(async () => { await db.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });
  let fault = null;
  let failRepoRead = false;
  const isRepoSetting = ([sql, [key]]) => /^INSERT INTO app_settings\b/i.test(sql) && typeof key === 'string' && key.startsWith('repo:');
  const isRepoEvent = ([sql, args]) => /^INSERT INTO project_events\b/i.test(sql) && args[3]?.includes('設定程式庫：');
  const appDb = { ...db,
    all: async (sql, ...args) => {
      if (failRepoRead && sql.includes("key >= 'repo:' AND key < 'repo;'")) {
        failRepoRead = false;
        throw new Error('模擬的程式庫讀取失敗');
      }
      return db.all(sql, ...args);
    },
    batch: stmts => {
      if (!fault || fault.batch) return db.batch(stmts);
      const setting = stmts.findIndex(isRepoSetting), event = stmts.findIndex(isRepoEvent);
      const index = fault.step === 'setting' ? setting : event;
      if (index < 0) return db.batch(stmts);
      const id = fault.step === 'setting' ? stmts[index][1][0].slice('repo:'.length) : stmts[index][1][0];
      const project = stmts.findIndex(([sql, args]) => /^INSERT INTO projects\b/i.test(sql) && args[0] === id);
      fault.batch = { id, project, setting, event, eventProject: stmts[event]?.[1][0] };
      // 用資料庫錯誤中止批次。若異動紀錄失敗，程式庫設定已在交易中寫過。
      return db.batch(stmts.map((stmt, i) => i === index ? ['SELECT * FROM missing_project_repo_write_table', []] : stmt));
    },
  };
  const call = appCaller(createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1' } }));
  const joined = await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' });
  assert.equal(joined.status, 201);
  const { token, participant } = joined.body;
  const create = body => call(token, '/api/projects', 'POST', body);
  const projects = async () => {
    const r = await call(token, '/api/projects');
    assert.equal(r.status, 200);
    return r.body.items;
  };
  const url = 'https://example.com/team/project';

  await t.test('201 與緊接的讀取都包含程式庫，並保留異動紀錄及既有編輯 API', async () => {
    const r = await create({ name: '程式庫專案', repo: { url: ` ${url} `, branch: ' release/v1 ' } });
    assert.equal(r.status, 201);
    const { id, items } = r.body;
    const repo = { url, branch: 'release/v1' };
    assert.deepEqual(items.find(p => p.id === id)?.repo, repo, '建立回應已包含程式庫');
    assert.deepEqual((await projects()).find(p => p.id === id)?.repo, repo, '可以立即讀取程式庫');
    const events = await call(token, `/api/projects/${id}/events`);
    assert.equal(events.status, 200);
    const repoEvents = events.body.items.filter(e => e.text.includes('設定程式庫'));
    assert.deepEqual(repoEvents.map(e => [e.actorId, e.text]), [[participant.participantId, `林志明 設定程式庫：${url}（分支 release/v1）`]]);

    const put = body => call(token, `/api/projects/${id}/repo`, 'PUT', body);
    const updated = await put({ url, branch: 'main' });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.items.find(p => p.id === id)?.repo, { url, branch: 'main' });
    for (const badUrl of ['https:example.com/team/project', url + '#auth=placeholder']) {
      const invalid = await put({ url: badUrl });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error?.code, 'INVALID_REQUEST');
    }
    assert.deepEqual((await projects()).find(p => p.id === id)?.repo, { url, branch: 'main' });
    const cleared = await put({ url: '', branch: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.items.find(p => p.id === id)?.repo, null);
  });

  await t.test('程式庫選填，省略分支代表沒有指定分支', async () => {
    const withUrl = await create({ name: '不指定分支', repo: { url } });
    assert.equal(withUrl.status, 201);
    assert.deepEqual(withUrl.body.items.find(p => p.id === withUrl.body.id)?.repo, { url, branch: '' });
    const withoutRepo = await create({ name: '不指定程式庫' });
    assert.equal(withoutRepo.status, 201);
    assert.equal(withoutRepo.body.items.find(p => p.id === withoutRepo.body.id)?.repo, null);
  });

  await t.test('程式庫欄位必須是字串，網址必須完整且不可帶憑證', async () => {
    const badRepos = [
      ['branch without URL', { branch: 'main' }], ['invalid branch', { url, branch: 'invalid branch' }],
      ['non-HTTP URL', { url: 'ssh://example.com/team/project' }], ['query token', { url: url + '?token=placeholder' }],
      ['string repo', url], ['array URL', { url: [url] }], ['null URL', { url: null }],
      ['numeric branch', { url, branch: 1 }], ['null branch', { url, branch: null }],
      ['missing slashes', { url: 'https:example.com/team/project' }], ['missing authority', { url: 'https:///example.com/team/project' }],
      ['fragment token', { url: url + '#access_token=placeholder' }], ['encoded fragment key', { url: url + '#access_to%6ben=placeholder' }],
    ];
    const results = [];
    for (const [i, [label, repo]] of badRepos.entries()) {
      const r = await create({ name: 'Invalid repo ' + i, repo });
      results.push([label, r.status, r.body.error?.code]);
    }
    assert.deepEqual(results, badRepos.map(([label]) => [label, 400, 'INVALID_REQUEST']));
    assert.ok(!(await projects()).some(p => p.name.startsWith('Invalid repo ')), '沒有留下專案');
  });

  await t.test('程式庫掃描失敗時，201 仍回傳剛提交的設定', async () => {
    const repo = { url: 'http://example.com/team/project#readme', branch: 'docs' };
    failRepoRead = true;
    const r = await create({ name: '程式庫掃描失敗', repo });
    assert.equal(r.status, 201);
    assert.equal(failRepoRead, false, '確實注入了讀取失敗');
    assert.deepEqual(r.body.items.find(p => p.id === r.body.id)?.repo, repo);
    assert.deepEqual((await projects()).find(p => p.id === r.body.id)?.repo, repo);
  });

  await t.test('程式庫設定或異動紀錄寫入失敗時整批回復，重送可用同一組識別碼', async () => {
    const spec = { name: '重送程式庫專案', slug: 'retry-repo', code: 'RREPO', repo: { url, branch: 'main' } };
    for (const step of ['setting', 'event']) {
      fault = { step };
      const failed = await create(spec);
      const batch = fault.batch;
      fault = null;
      assert.equal(failed.status, 500, '寫入失敗應回 500');
      assert.ok(batch, '確實注入資料庫寫入失敗');
      const { id, project, setting, event, eventProject } = batch;
      assert.ok(project >= 0 && project < setting && setting < event, '同一批依序寫入專案、程式庫設定與其異動紀錄');
      assert.equal(eventProject, id, '程式庫異動紀錄與設定屬於同一專案');
      assert.ok(!(await projects()).some(p => p.name === spec.name), '沒有留下專案');
      assert.equal(await db.get('SELECT key FROM app_settings WHERE key = ?', 'repo:' + id), null, '沒有留下程式庫設定');
      assert.deepEqual(await db.all('SELECT id FROM project_events WHERE project_id = ?', id), [], '沒有留下專案異動紀錄');
      const audit = await call(token, '/api/audit-log?action=project.create');
      assert.equal(audit.status, 200);
      assert.ok(!audit.body.items.some(e => e.scope.projectName === spec.name), '沒有留下建立專案稽核');
    }
    const retry = await create(spec);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body.items.find(p => p.id === retry.body.id)?.repo, spec.repo);
  });
});
