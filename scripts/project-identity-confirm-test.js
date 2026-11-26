// 驗收測試：從公開 API 預覽和確認識別碼修復，再用正常查詢確認變更與稽核。
import './test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import { seedClaimsStmts } from '../src/project-identity-claims.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ident-confirm-'));
const db = await openTestDb(path.join(dir, 'switch.db'));
// Pause once just before the DB adapter receives the write, after confirmation has read both tokens.
let beforeBatch;
const adapter = {
  ...db,
  async batch(stmts) {
    if (beforeBatch) {
      const intervene = beforeBatch;
      beforeBatch = null;
      await intervene();
    }
    assert.ok(stmts.every(([, args]) => args.every(v => typeof v !== 'string' || Buffer.byteLength(v) <= 512 * 1024)), '確認資料逐頁綁定');
    return db.batch(stmts);
  },
};
const app = createApp({ db: adapter, storage: dbStorage(adapter), docText: '', config: { openJoin: '1', teamCacheMs: '0' } });
const api = async (token, url, method = 'GET', body) => {
  const res = await app(new Request('http://localhost' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), 'http://localhost');
  return { status: res.status, body: await res.json() };
};
const ok = ({ status, body }) => { assert.ok(status < 400, `${status} ${JSON.stringify(body)}`); return body; };
const origin = '/api/admin/project-identity';
try {
  const boss = ok(await api(null, '/api/join', 'POST', { name: '平台管理員', role: 'PO' }));
  const admin = (...args) => api(boss.token, ...args);
  const add = async (name, slug, code) => ok(await admin('/api/projects', 'POST', { name, slug, code })).id;
  const card = async (project, title) => ok(await admin('/api/cards', 'POST', { requestId: title, project, title }));
  const find = async id => ok(await admin(`/api/cards/${id}`));
  const logs = async () => ok(await admin('/api/audit-log?scope=platform&action=project_identity.repair')).items;
  const preview = async proposal => ok(await admin(`${origin}/preview`, 'POST', proposal));
  const confirm = (proposal, plan, extra = {}) => admin(`${origin}/confirm`, 'POST', {
    ...proposal, state: plan.state, resolutionState: plan.resolutionState, acknowledged: true, ...extra,
  });
  const setting = (key, value) => db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  const a = await add('Legacy Alpha', 'legacy-a', 'TWIN');
  const b = await add('Legacy Beta', 'legacy-b', 'BETA');
  await db.run('UPDATE projects SET created_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', a);
  const ca = await card(a, 'Alpha card');
  const cb = await card(b, 'Beta card');
  await setting(`pcode:${b}`, 'TWIN');
  await setting('pcodeold:OLD', a);
  await db.batch(seedClaimsStmts({ keepDisputes: false }));
  const proposal = { projectId: a, field: 'code', replacement: ' newa ', reference: ' twin-01 ' };
  const plan = await preview(proposal);
  assert.equal((await find('TWIN-1')).legacyId, ca.legacyId);
  const confirmAs = (token, proposal, plan) => api(token, `${origin}/confirm`, 'POST', {
    ...proposal, state: plan.state, resolutionState: plan.resolutionState, acknowledged: true,
  });
  const stale = response => assert.deepEqual([response.status, response.body.error?.code], [409, 'IDENTITY_PREVIEW_STALE']);
  assert.equal((await confirm(proposal, plan, { acknowledged: false })).status, 400, '須明確確認已看過參照與顯示代號影響');
  for (const token of ['state', 'resolutionState']) {
    assert.equal((await confirm(proposal, plan, { [token]: undefined })).status, 400);
    stale(await confirm(proposal, plan, { [token]: '0'.repeat(64) }));
  }
  stale(await confirm({ ...proposal, reference: 'TWIN-2' }, plan));
  stale(await confirm({ ...proposal, replacement: 'NEWT' }, plan));
  assert.deepEqual(await logs(), []);
  beforeBatch = () => db.batch([
    ["INSERT INTO project_identity_claims (namespace, value) VALUES ('code', 'NEWA')", []],
    ...[a, b].map(id => ["INSERT INTO project_identity_claimants (namespace, value, project_id, source, raw_value) VALUES ('code', 'NEWA', ?, 'current_code', 'NEWA')", [id]]),
  ]);
  stale(await confirm(proposal, plan));
  assert.equal(beforeBatch, null);
  assert.deepEqual(await logs(), []);
  assert.deepEqual([(await admin(`${origin}/preview`, 'POST', proposal)).body.error?.code, (await find('TWIN-1')).legacyId], ['CODE_TAKEN', ca.legacyId]);
  await db.batch([
    ["DELETE FROM project_identity_claimants WHERE namespace = 'code' AND value = 'NEWA'", []],
    ["DELETE FROM project_identity_claims WHERE namespace = 'code' AND value = 'NEWA'", []],
  ]);
  ok(await confirm(proposal, plan));
  assert.equal((await find('TWIN-1')).legacyId, cb.legacyId);
  assert.equal((await find('NEWA-1')).legacyId, ca.legacyId);
  assert.equal((await find('OLD-1')).legacyId, ca.legacyId);
  assert.equal((await find(ca.legacyId)).cardId, 'NEWA-1');
  assert.equal(ok(await admin(origin)).conflicts.length, 0);
  assert.deepEqual(ok(await admin(origin)).claims, { status: 'current', disputes: [] });
  assert.equal(ok(await admin('/api/projects')).items.find(p => p.id === a).code, 'NEWA');
  const audit = await logs();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor.id, boss.participant.participantId);
  assert.deepEqual([audit[0].target.id, audit[0].detail.field, audit[0].detail.from, audit[0].detail.to], [a, 'code', 'TWIN', 'NEWA']);
  stale(await confirm(proposal, plan));
  assert.deepEqual(await logs(), audit, '重送過期預覽不會新增一筆稽核紀錄');
  console.log('✓ 確認重複代號修復：驗證兩個指紋與明確同意，正常卡號、舊代號、診斷與稽核');

  await setting('pcodeold:TWIN', a);
  await db.batch(seedClaimsStmts({ keepDisputes: false }));
  assert.equal((await admin(`${origin}/preview`, 'POST', { projectId: a, field: 'code', replacement: 'TWIN', retireAlias: true })).status, 409);
  const keep = { projectId: b, field: 'code', replacement: 'TWIN', retireAlias: true };
  const keepPlan = await preview(keep);
  assert.deepEqual(keepPlan.retiredAlias, { code: 'TWIN', projectId: a });
  await setting(`pcode:${b}`, 'NEXT');
  await setting('pcodeold:NEXT', a);
  stale(await confirm(keep, keepPlan));
  await setting(`pcode:${b}`, 'TWIN');
  await db.run('DELETE FROM app_settings WHERE key = ?', 'pcodeold:NEXT');
  stale(await confirm({ ...keep, retireAlias: false }, keepPlan));
  assert.equal((await confirm(keep, keepPlan, { acknowledged: false })).status, 400);
  const outcomes = await Promise.all([confirm(keep, keepPlan), confirm(keep, keepPlan)]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409], '同時確認只能成功一次');
  assert.equal((await find('TWIN-1')).legacyId, cb.legacyId, '停用被蓋住的舊代號不改現行解析');
  assert.equal((await find('OLD-1')).legacyId, ca.legacyId, '其他舊代號不動');
  assert.deepEqual((await logs())[0].detail.retiredAlias, { code: 'TWIN', projectId: a });
  assert.deepEqual(ok(await admin(origin)).claims, { status: 'current', disputes: [] });
  console.log('✓ 同時確認停用舊代號只提交一次，保留現行與其他舊代號');

  // Recoverable current code shadows another project's alias. The old number used to be a moved card.
  const gone = await add('Recoverable project', 'recoverable-project', 'GONE');
  const moved = await card(a, 'Moved to beta');
  ok(await admin(`/api/cards/${moved.legacyId}`, 'PATCH', { project: b }));
  await db.run('UPDATE projects SET archived = 1, deleted_at = ?, purge_at = ? WHERE id = ?', new Date().toISOString(), Date.now() + 86400000, gone);
  await setting('pcodeold:GONE', a);
  const recover = { projectId: gone, field: 'code', replacement: 'REST', reference: 'GONE-2' };
  const recoverPlan = await preview(recover);
  const ref = recoverPlan.cardReferences.find(r => r.code === 'GONE').examples[0];
  assert.deepEqual([ref.before, ref.after.legacyId, ref.after.projectId], [null, moved.legacyId, b]);
  assert.equal((await admin('/api/cards/GONE-2')).status, 404);
  const beforeRace = await logs();
  beforeBatch = async () => { ok(await admin(`/api/cards/${moved.legacyId}`, 'PATCH', { project: a })); };
  stale(await confirm(recover, recoverPlan));
  assert.equal(beforeBatch, null, '卡片移動發生在確認預檢之後');
  assert.deepEqual(await logs(), beforeRace, '交易尾端的參照斷言失敗也回復已執行的稽核 INSERT');
  assert.equal((await admin('/api/cards/GONE-2')).status, 404);
  stale(await confirm(recover, recoverPlan));
  const nextPlan = await preview(recover);
  assert.equal(recoverPlan.state, nextPlan.state);
  assert.notEqual(recoverPlan.resolutionState, nextPlan.resolutionState);
  ok(await confirm(recover, nextPlan));
  assert.equal((await find('GONE-2')).legacyId, moved.legacyId, '舊代號露出原本的移卡參照');
  assert.equal((await find('GONE-2')).cardId, (await find(moved.legacyId)).cardId);
  assert.equal(ok(await admin(origin)).conflicts.length, 0);
  assert.equal(ok(await admin('/api/deleted-projects')).items.find(item => item.projectId === gone).code, 'REST');
  console.log('✓ 可復原專案、舊代號露出移卡參照；交易內偵測移卡並回復變更和稽核');

  const slug = { projectId: a, field: 'slug', replacement: 'alpha-new' };
  await setting(`slug:${b}`, 'legacy-a');
  await db.run('DELETE FROM app_settings WHERE key = ?', `pcode:${a}`);
  assert.equal(ok(await admin('/api/projects')).items.find(p => p.id === a).code, 'LEGA', '舊備份沒儲存卡片代號');
  const slugPlan = await preview(slug);
  const beforeSlug = await logs();
  // Claim the replacement only after confirmation has read the snapshot.
  beforeBatch = async () => { await add('Concurrent claimant', 'alpha-new', 'RACE'); };
  stale(await confirm(slug, slugPlan));
  stale(await confirm(slug, slugPlan));
  assert.deepEqual(await logs(), beforeSlug);
  assert.equal(ok(await admin('/api/projects')).items.find(p => p.id === a).slug, 'legacy-a');
  const adjustedSlug = { ...slug, replacement: 'other-alpha' };
  const adjustedPlan = await preview(adjustedSlug);
  // An actual storage error when appending the audit record must not commit the preceding identity write.
  await db.run('ALTER TABLE audit_log RENAME TO repair_audit_fixture');
  try { assert.equal((await confirm(adjustedSlug, adjustedPlan)).status, 500); }
  finally { await db.run('ALTER TABLE repair_audit_fixture RENAME TO audit_log'); }
  assert.deepEqual(await logs(), beforeSlug);
  assert.equal(ok(await admin('/api/projects')).items.find(p => p.id === a).slug, 'legacy-a');
  ok(await confirm(adjustedSlug, adjustedPlan));
  const routeOwner = (items, value) => (items.find(p => p.slug === value) || items.find(p => p.id === value) || items.find(p => p.name === value))?.id;
  const items = ok(await admin('/api/projects')).items;
  assert.deepEqual([routeOwner(items, 'legacy-a'), routeOwner(items, 'other-alpha')], [b, a]);
  assert.equal((await find('LEGA-1')).legacyId, ca.legacyId, '修復網址不改原本推導的卡片代號');
  console.log('✓ 替換值在預檢後被占用回 409；稽核寫入錯誤回 500 並整批回復；網址解析依預覽且卡片代號不變');

  const mate = ok(await api(null, '/api/join', 'POST', { name: '工作區管理員', role: 'PG' }));
  const session = await adminSession(api, boss.token);
  const role = `/api/participants/${mate.participant.participantId}`;
  ok(await api(session.token, role + '/workspace-role', 'PUT', { role: 'admin' }));
  const name = { projectId: a, field: 'name', replacement: 'New Alpha' };
  await db.run('UPDATE projects SET name = ? WHERE id = ?', 'Legacy Alpha', b);
  const namePlan = await preview(name);
  assert.equal((await confirmAs(null, name, namePlan)).status, 401);
  assert.equal((await confirmAs(mate.token, name, namePlan)).status, 403);
  const platformRole = role + '/platform-role';
  ok(await api(session.token, platformRole, 'PUT', { role: 'admin' }));
  const matePlan = ok(await api(mate.token, `${origin}/preview`, 'POST', name));
  const beforeRevoke = await logs();
  beforeBatch = async () => { ok(await api(session.token, platformRole, 'PUT', { role: 'none' })); };
  const denied = await confirmAs(mate.token, name, matePlan);
  assert.deepEqual([denied.status, denied.body.error?.code], [403, 'NOT_ADMIN']);
  assert.equal(beforeBatch, null, '撤銷平台管理權發生在確認預檢後');
  assert.deepEqual(await logs(), beforeRevoke);
  assert.equal(routeOwner(ok(await admin('/api/projects')).items, 'Legacy Alpha'), a);
  ok(await confirm(name, namePlan));
  const renamed = ok(await admin('/api/projects')).items;
  assert.deepEqual([routeOwner(renamed, 'Legacy Alpha'), routeOwner(renamed, 'New Alpha')], [b, a]);
  assert.equal(ok(await admin(origin)).conflicts.length, 0);
  console.log('✓ 沒登入與工作區管理員不能確認；交易內重查平台權限；改名保留舊網址解析規則');
  // A code repair keeps the collateral derived code and accepts a single incoming moved-card number.
  const source = await add('Move source', 'move-source', 'SRC');
  const dest = await add('Move destination', 'move-dest', 'DEST');
  const derived = await add('Derived', 'dest-other', 'DERV');
  const collateral = await card(derived, 'Collateral card');
  const incoming = await card(source, 'Incoming card');
  ok(await admin(`/api/cards/${incoming.legacyId}`, 'PATCH', { project: dest }));
  await setting('pcodeold:DEST', source);
  await db.run('DELETE FROM app_settings WHERE key = ?', `pcode:${derived}`);
  await setting('pcode:legacy-orphan-a', '界'.repeat(100_000));
  await setting('pcode:legacy-orphan-b', '界'.repeat(100_000));
  const incomingProposal = { projectId: dest, field: 'code', replacement: 'FINAL', reference: incoming.cardId };
  const incomingPlan = await preview(incomingProposal);
  const example = incomingPlan.cardReferences.find(r => r.exampleCoverage === 'requested').examples[0];
  assert.deepEqual([example.before.legacyId, example.after.legacyId, example.outcome], [incoming.legacyId, incoming.legacyId, 'same_card']);
  assert.equal((await admin(`${origin}/preview`, 'POST', { ...incomingProposal, reference: 'SRC-99' })).status, 400);
  assert.deepEqual(incomingPlan.pinnedCodes, [{ projectId: derived, code: 'DESTA' }]);
  ok(await confirm(incomingProposal, incomingPlan));
  assert.equal((await find(incoming.cardId)).cardId, example.after.cardId);
  assert.equal((await find('DESTA-1')).legacyId, collateral.legacyId);
  assert.equal((await db.get('SELECT value FROM app_settings WHERE key = ?', `pcode:${derived}`)).value, 'DESTA');
  console.log('✓ 移卡舊號依預覽解析，保留不受衝突的推導代號，大型快照逐頁驗證');
  console.log('project-identity-confirm-test：全部通過');
} finally {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
