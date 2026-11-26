// 技能審核競態：透過 review API 交錯兩個審核，從技能與私訊 API 確認只有勝出的決定生效。
// 預設 SQLite。可用 AIGILE_TEST_PG_URL 跑 PostgreSQL，或設 AIGILE_TEST_MINIFLARE 為本機 Miniflare 入口檔跑本機 D1。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/core.js';
import { wrapD1 } from '../src/db-d1.js';
import { cleanSql } from './migrate.js';
import { openTestDb } from './test-db.js';
import { addToProject, setProjectRole } from './test-members.js';

async function openReviewDb(file) {
  const entry = process.env.AIGILE_TEST_MINIFLARE;
  if (!entry) return openTestDb(file);
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(entry).href);
  const options = {
    name: 'skill-review', cf: false, modules: true, d1Databases: ['DB'],
    script: 'export default { fetch() { return new Response() } }',
  };
  const mf = new Miniflare(convertV4MiniflareOptions
    ? { ...convertV4MiniflareOptions(options), telemetry: { enabled: false }, enableDevRegistry: false }
    : options);
  try {
    const db = wrapD1(await mf.getD1Database('DB', options.name));
    const sql = cleanSql(fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
    await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => [s, []]));
    await db.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', project, project, '2026-01-01T00:00:00.000Z');
    return { ...db, close: () => mf.dispose() };
  } catch (e) {
    await mf.dispose();
    throw e;
  }
}

const project = '預設專案';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-skill-review-race-'));
const db = await openReviewDb(path.join(dir, 'switch.db'));
let beforeRemovalBatch;
const app = createApp({
  db: { ...db, async batch(stmts) {
    if (beforeRemovalBatch && stmts.some(([sql]) => sql.startsWith("UPDATE skills SET status = 'removed'"))) {
      const run = beforeRemovalBatch;
      beforeRemovalBatch = null;
      await run();
    }
    return db.batch(stmts);
  } },
  docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' },
});
const library = `/api/projects/${encodeURIComponent(project)}/skills`;
const detail = id => `/api/skills/${id}`;
const review = id => `${detail(id)}/review`;

async function call(token, p, method = 'GET', body) {
  const stream = body instanceof ReadableStream;
  const res = await app(new Request('http://localhost' + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: stream ? body : JSON.stringify(body) } : {}), ...(stream ? { duplex: 'half' } : {}),
  }), 'http://localhost');
  return { status: res.status, body: await res.json() };
}
function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: got ${res.status}${res.body.error ? ` ${res.body.error.code}` : ` (${res.body.status})`}`);
  return res.body;
}
async function upload(token, name, version, needsReview = false, roles = []) {
  const files = [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: Review fixture\n---\nSample text ${version}\n` }];
  if (needsReview) files.push({ path: 'scripts/sample.txt', text: 'An inert review fixture.\n' });
  return expectStatus(await call(token, library, 'POST', { files, roles }), 201, 'upload');
}

// Pause the first request at its body read, after it has reached the review decision.
// A zero high water mark keeps pull() from running until the app actually reads.
async function interleaveReview(token, skillId, decision, decideFirst) {
  const { promise: reading, resolve: markReading } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const body = new ReadableStream({ async pull(controller) {
    markReading();
    await released;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(decision)));
    controller.close();
  } }, { highWaterMark: 0 });
  const response = call(token, review(skillId), 'POST', body);
  let winner, loser;
  try {
    await Promise.race([reading, response.then(res => assert.fail(`review returned before reading body: ${res.status}`))]);
    winner = await decideFirst();
  } finally {
    release();
    loser = await response;
  }
  return { winner, loser };
}

function expectNotPending(res, label) {
  assert.equal(expectStatus(res, 409, label).error.code, 'NOT_PENDING');
}

function expectReview(skill, status, reviewer, note) {
  assert.equal(skill.status, status);
  assert.equal(skill.reviewedBy.participantId, reviewer);
  assert.equal(skill.reviewNote, note);
  assert.ok(skill.reviewedAt);
}

function expectNoReview(skill, status) {
  assert.equal(skill.status, status);
  for (const key of ['reviewedBy', 'reviewedAt', 'reviewNote']) assert.equal(key in skill, false, `${status} must not have ${key}`);
}

try {
  async function join(name, role) {
    const res = await call(null, '/api/join', 'POST', { name, role });
    assert.ok(res.body.token, `join ${name}: ${res.status} ${res.body.error?.message ?? ''}`);
    return res.body;
  }
  const boss = await join('林志明', 'PO');
  const reviewer = await join('王小明', 'PG');
  const uploader = await join('陳大文', 'PG');
  const id = p => p.participant.participantId;
  expectStatus(await addToProject(call, boss.token, project, id(reviewer), 'admin'), 201, 'add reviewer');
  expectStatus(await addToProject(call, boss.token, project, id(uploader)), 201, 'add uploader');
  const ai = expectStatus(await call(uploader.token, '/api/my-ais', 'POST', { projects: [project], roleKey: 'PG', role: 'PG', name: '技能審核測試', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }), 201, 'create AI');
  const dms = async name => expectStatus(await call(uploader.token, `/api/dm?aiId=${ai.participantId}`), 200, 'owner DMs').items.filter(dm => dm.text.includes(`「${name}」`));
  const get = async skillId => expectStatus(await call(boss.token, detail(skillId)), 200, 'skill detail');
  const published = async name => expectStatus(await call(reviewer.token, library), 200, 'skill library').items.filter(it => it.name === name && it.status === 'published').map(it => it.skillId);

  const decide = (token, skillId, action, note) => call(token, review(skillId), 'POST', { action, note });

  const name = 'review-race';
  const incumbent = await upload(uploader.token, name, 1);
  expectNoReview(incumbent, 'published'); // simple skills still publish automatically
  assert.deepEqual(await published(name), [incumbent.skillId]);
  assert.equal((await dms(name)).length, 1, 'published fixture sent its owner DM');
  const candidate = await upload(uploader.token, name, 2, true);
  expectNoReview(candidate, 'pending');

  const rejection = await interleaveReview(boss.token, candidate.skillId, { action: 'approve', note: 'Losing approval' },
    () => decide(reviewer.token, candidate.skillId, 'reject', 'Winning rejection'));
  const rejected = expectStatus(rejection.winner, 200, 'winning rejection');
  expectReview(rejected, 'rejected', id(reviewer), 'Winning rejection');
  expectNotPending(rejection.loser, 'approval after concurrent rejection');
  const final = await get(candidate.skillId);
  expectReview(final, 'rejected', id(reviewer), 'Winning rejection');
  assert.equal(final.reviewedAt, rejected.reviewedAt);
  assert.deepEqual(await published(name), [incumbent.skillId], 'losing approval leaves the published version alone');
  assert.equal((await dms(name)).length, 1, 'losing approval sends no owner DM');

  for (const action of ['reject', 'approve']) {
    const next = await upload(uploader.token, name, `winner-${action}`, true);
    const beforeDms = (await dms(name)).length;
    const approval = await interleaveReview(reviewer.token, next.skillId, { action, note: 'Losing decision' },
      () => decide(boss.token, next.skillId, 'approve', 'Winning approval'));
    const approved = expectStatus(approval.winner, 200, 'winning approval');
    expectReview(approved, 'published', id(boss), 'Winning approval');
    expectNotPending(approval.loser, `${action} after concurrent approval`);
    const final = await get(next.skillId);
    expectReview(final, 'published', id(boss), 'Winning approval');
    assert.equal(final.reviewedAt, approved.reviewedAt);
    assert.deepEqual(await published(name), [next.skillId]);
    assert.equal((await dms(name)).length, beforeDms + 1, 'only the winning approval sends an owner DM');
  }

  const withdrawn = await upload(uploader.token, name, 'remove', true);
  const beforeRemoval = (await dms(name)).length;
  const removal = await interleaveReview(boss.token, withdrawn.skillId, { action: 'approve', note: 'Losing approval' },
    () => call(reviewer.token, `${library}/${name}/remove`, 'POST'));
  assert.equal(expectStatus(removal.winner, 200, 'winning removal').removed, 2);
  expectNotPending(removal.loser, 'approval after concurrent removal');
  expectNoReview(await get(withdrawn.skillId), 'removed');
  assert.deepEqual(await published(name), []);
  const removalDms = (await dms(name)).slice(beforeRemoval);
  assert.equal(removalDms.length, 1);
  assert.match(removalDms[0].text, /下架/);

  const retargeted = 'removal-audience';
  await upload(uploader.token, retargeted, 1, false, ['UX']);
  assert.deepEqual(await dms(retargeted), [], 'the owner is outside the initial audience');
  // Retarget after the removal has read its audience, before the write reaches the database.
  beforeRemovalBatch = async () => {
    expectStatus(await call(boss.token, `${library}/${retargeted}/target`, 'PUT', { roles: ['PG'] }), 200, 'retarget');
  };
  const retargetRemoval = await call(boss.token, `${library}/${retargeted}/remove`, 'POST');
  assert.equal(beforeRemovalBatch, null, 'retarget ran during removal');
  assert.equal(expectStatus(retargetRemoval, 200, 'remove after retarget').removed, 1);
  assert.equal((await dms(retargeted)).filter(dm => dm.text.includes('下架')).length, 1, 'the owner added by retargeting receives the removal DM');

  const older = await upload(uploader.token, name, 'older', true);
  let newer;
  const replacement = await interleaveReview(boss.token, older.skillId, { action: 'approve', note: 'Losing older approval' }, async () => {
    newer = await upload(uploader.token, name, 'newer', true);
    return decide(reviewer.token, newer.skillId, 'approve', 'Winning newer approval');
  });
  expectReview(expectStatus(replacement.winner, 200, 'newer approval'), 'published', id(reviewer), 'Winning newer approval');
  expectNotPending(replacement.loser, 'approval of older version after newer approval');
  expectNoReview(await get(older.skillId), 'superseded');
  assert.deepEqual(await published(name), [newer.skillId]);
  const replacementDms = (await dms(name)).slice(beforeRemoval + 1);
  assert.equal(replacementDms.length, 1);
  assert.match(replacementDms[0].text, new RegExp(`第 ${newer.version} 版`));

  const simultaneous = await upload(uploader.token, name, 'simultaneous', true);
  const beforeSimultaneous = (await dms(name)).length;
  const both = await Promise.all([
    decide(boss.token, simultaneous.skillId, 'approve', 'Workspace review'),
    decide(reviewer.token, simultaneous.skillId, 'approve', 'Project review'),
  ]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
  expectNotPending(both.find(r => r.status === 409), 'competing approval');
  const winner = both.find(r => r.status === 200).body;
  expectReview(await get(simultaneous.skillId), 'published', winner.reviewedBy.participantId, winner.reviewNote);
  assert.deepEqual(await published(name), [simultaneous.skillId]);
  assert.equal((await dms(name)).length, beforeSimultaneous + 1);

  const guarded = await upload(uploader.token, name, 'permission-guard', true);
  const beforeGuards = (await dms(name)).length;
  const demotion = await interleaveReview(reviewer.token, guarded.skillId, { action: 'approve', note: 'Stale permission' },
    () => setProjectRole(call, boss.token, project, id(reviewer), 'viewer'));
  expectStatus(demotion.winner, 200, 'demote reviewer');
  assert.equal(expectStatus(demotion.loser, 403, 'review after demotion').error.code, 'NOT_LEADER');
  expectNoReview(await get(guarded.skillId), 'pending');

  // Set only the restore fixture. The public skill API reports the blocked write.
  await db.run("INSERT INTO app_settings (key, value) VALUES ('restore_state', '{}')");
  try {
    const blocked = await decide(boss.token, guarded.skillId, 'approve', 'During restore');
    assert.equal(expectStatus(blocked, 503, 'review during restore').error.code, 'RESTORING');
    expectNoReview(await get(guarded.skillId), 'pending');
    assert.deepEqual(await published(name), [simultaneous.skillId]);
    assert.equal((await dms(name)).length, beforeGuards);
  } finally {
    await db.run("DELETE FROM app_settings WHERE key = 'restore_state'");
  }

  const own = await upload(uploader.token, 'self-review', 1, true);
  expectStatus(await setProjectRole(call, boss.token, project, id(uploader), 'admin'), 200, 'promote uploader');
  const self = expectStatus(await decide(uploader.token, own.skillId, 'approve', 'Self approval'), 403, 'self-review');
  assert.equal(self.error.code, 'SELF_REVIEW');
  expectNoReview(await get(own.skillId), 'pending');
  console.log('skills-review-race-test: passed');
} finally {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
