// 驗收測試：平台管理員預覽既有專案識別碼衝突，正常卡號與專案清單照舊。
import './test-home.mjs';
import assert from 'node:assert/strict';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ident-preview-'));
const db = await openTestDb(path.join(dir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', teamCacheMs: '0' } });
const api = async (token, url, method = 'GET', body) => {
  const res = await app(new Request('http://localhost' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), 'http://localhost');
  return [res.status, await res.json()];
};
const ok = ([status, body]) => { assert.ok(status < 400, `${status} ${JSON.stringify(body)}`); return body; };
const endpoint = '/api/admin/project-identity/preview';
try {
  const boss = ok(await api(null, '/api/join', 'POST', { name: '平台管理員', role: 'PO' })).token;
  const add = async (name, slug, code) => ok(await api(boss, '/api/projects', 'POST', { name, slug, code })).id;
  const card = async (project, title) => ok(await api(boss, '/api/cards', 'POST', { requestId: `${project}-${title}`, project, title }));
  const lookup = async value => ok(await api(boss, `/api/cards/${value}`));
  const diagnostics = async () => ok(await api(boss, '/api/admin/project-identity'));
  const projects = async () => ok(await api(boss, '/api/projects')).items;
  const preview = async (projectId, field, replacement, token = boss) => api(token, endpoint, 'POST', { projectId, field, replacement });
  const setting = (key, value) => db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  const a = await add('Legacy Alpha', 'legacy-a', 'TWIN');
  const b = await add('Legacy Beta', 'legacy-b', 'BETA');
  // 固定解析順序，避免兩個專案在同一毫秒建立時依隨機 id 排序。
  await db.run('UPDATE projects SET created_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', a);
  const ca = await card(a, 'Alpha card');
  const cb = await card(b, 'Beta card');
  await setting('pcode:' + b, 'TWIN');
  await projects();
  const before = await diagnostics();
  assert.equal((await lookup('TWIN-1')).legacyId, ca.legacyId);
  const plan = ok(await preview(a, 'code', ' newa '));
  assert.deepEqual([plan.projectId, plan.field, plan.current, plan.replacement], [a, 'code', 'TWIN', 'NEWA']);
  assert.deepEqual(plan.projects.map(p => p.id), [a, b]);
  const old = plan.cardReferences.find(r => r.code === 'TWIN');
  assert.deepEqual([old.before.projectId, old.after.projectId, old.ambiguous], [a, b, true]);
  const example = old.examples.find(e => e.reference === 'TWIN-1');
  assert.deepEqual(example.before, { projectId: a, cardId: 'TWIN-1', legacyId: ca.legacyId });
  assert.deepEqual(example.after, { projectId: b, cardId: 'TWIN-1', legacyId: cb.legacyId });
  const proposed = plan.cardReferences.find(r => r.code === 'NEWA');
  assert.deepEqual(proposed.examples[0].after, { projectId: a, cardId: 'NEWA-1', legacyId: ca.legacyId });
  assert.equal(plan.state, ok(await preview(a, 'code', 'NEWA')).state, '同樣的狀態與正規化值可得到同樣的預覽指紋');
  assert.deepEqual(await diagnostics(), before);
  assert.equal((await lookup('TWIN-1')).legacyId, ca.legacyId);
  assert.equal((await api(boss, '/api/cards/NEWA-1'))[0], 404);
  console.log('✓ 重複代號預覽顯示同號的兩張卡，識別碼照舊');

  const archived = await add('Archived owner', 'archived-owner', 'ARCH');
  const archivedCard = await card(archived, 'Archived card');
  const recoverable = await add('Recoverable owner', 'recoverable-owner', 'RCVR');
  const removedCard = await card(recoverable, 'Removed card');
  // 舊備份裡有封存和可復原期內的專案。
  await db.run('UPDATE projects SET archived = 1 WHERE id = ?', archived);
  await db.run('UPDATE projects SET deleted_at = ?, purge_at = ? WHERE id = ?', new Date().toISOString(), Date.now() + 86_400_000, recoverable);
  await setting('pcodeold:RCVR', a);
  await setting('pcodeold:OWN', a);
  await setting('cardmoved:' + a + ':5', String(Number(cb.legacyId.slice(2)) - 100));
  await projects();
  assert.equal((await api(boss, '/api/cards/RCVR-1'))[0], 404, '被刪專案的現行代號蓋住使用中的舊代號');
  const aliasPlan = ok(await preview(recoverable, 'code', 'REV'));
  assert.equal(aliasPlan.projects.find(p => p.id === recoverable).deleted, true);
  const alias = aliasPlan.cardReferences.find(r => r.code === 'RCVR');
  assert.deepEqual(alias.before, { projectId: recoverable, source: 'current', available: false });
  assert.deepEqual(alias.after, { projectId: a, source: 'historical', available: true });
  assert.equal(alias.examples.find(e => e.reference === 'RCVR-1').after.legacyId, ca.legacyId);
  assert.equal(alias.examples.find(e => e.reference === 'RCVR-5').after.legacyId, cb.legacyId, '舊代號也使用移卡別名');
  assert.equal(aliasPlan.cardReferences.find(r => r.code === 'REV').examples[0].after, null);
  assert.equal((await api(boss, `/api/cards/${removedCard.legacyId}`))[0], 404);
  await setting('pcodeold:TWIN', archived);
  await setting('pcode:' + b, 'BETA');
  await projects();
  const archivedAlias = ok(await preview(a, 'code', 'OWN')).cardReferences.find(r => r.code === 'TWIN');
  assert.equal(archivedAlias.after, null, '封存專案的舊代號不會變成使用中的前綴');
  assert.equal(ok(await preview(a, 'code', 'OWN')).cardReferences.find(r => r.code === 'OWN').before.source, 'historical', '可以使用自己的舊代號');
  assert.equal((await lookup('ARCH-1')).legacyId, archivedCard.legacyId, '封存專案的現行代號仍可查');
  const [codeStatus, codeTaken] = await preview(a, 'code', 'RCVR');
  assert.deepEqual([codeStatus, codeTaken.error.code, codeTaken.error.projects.map(p => p.id)], [409, 'CODE_TAKEN', [recoverable]]);
  console.log('✓ 可復原與封存專案、舊代號與移卡舊號依照正常解析');

  await setting('slug:' + b, 'legacy-a');
  await db.run('UPDATE projects SET name = ? WHERE id = ?', 'Legacy Alpha', b);
  const legacyRoutes = await projects();
  const routeOwner = (items, value) => (items.find(p => p.slug === value) || items.find(p => p.id === value) || items.find(p => p.name === value))?.id ?? null;
  const slugPlan = ok(await preview(a, 'slug', ' ALPHA-NEW '));
  assert.deepEqual(slugPlan.routes, [
    { path: '/p/legacy-a', before: { projectId: a, source: 'slug' }, after: { projectId: b, source: 'slug' }, claimants: [a, b], ambiguous: true },
    { path: '/p/alpha-new', before: null, after: { projectId: a, source: 'slug' }, claimants: [], ambiguous: false },
  ]);
  assert.equal(routeOwner(legacyRoutes, 'legacy-a'), a);
  const [slugStatus, slugTaken] = await preview(a, 'slug', 'recoverable-owner');
  assert.deepEqual([slugStatus, slugTaken.error.code, slugTaken.error.projects.map(p => p.id)], [409, 'SLUG_TAKEN', [recoverable]]);
  const namePlan = ok(await preview(a, 'name', 'Renamed project'));
  assert.equal(routeOwner(legacyRoutes, 'Legacy Alpha'), a);
  assert.deepEqual(namePlan.routes.map(r => [r.path, r.before?.projectId, r.after?.projectId, r.ambiguous]), [
    ['/p/Legacy%20Alpha', a, b, true], ['/p/Renamed%20project', undefined, a, false],
  ]);
  assert.deepEqual(namePlan.cardReferences, []);
  assert.deepEqual(await projects(), legacyRoutes, '預覽後正常專案清單和解析順序不變');
  const other = await add('Third project', 'name-route', 'THRD');
  const shadowedName = ok(await preview(a, 'name', 'name-route')).routes[1];
  assert.deepEqual([shadowedName.before.projectId, shadowedName.after.projectId, shadowedName.ambiguous], [other, other, true], '新名稱可和他案網址相同，但網址仍優先，兩種意思不能同時保留');
  assert.notEqual(ok(await preview(a, 'code', 'NEWA')).state, plan.state, '同一提案遇到識別碼狀態更新時指紋會改變');
  const member = ok(await api(null, '/api/join', 'POST', { name: '工作區成員', role: 'PG' }));
  assert.equal((await preview(a, 'slug', 'other-slug', null))[0], 401);
  assert.equal((await preview(a, 'slug', 'other-slug', member.token))[0], 403);
  const admin = await adminSession(async (...args) => { const [status, body] = await api(...args); return { status, body }; }, boss);
  ok(await api(admin.token, `/api/participants/${member.participant.participantId}/workspace-role`, 'PUT', { role: 'admin' }));
  assert.equal((await preview(a, 'slug', 'other-slug', member.token))[0], 403, '工作區管理員沒有平台權限');
  console.log('✓ 重複網址英文名和未封存專案同名的預覽依照正常網址解析');
  console.log('project-identity-preview-test：全部通過');
} finally {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
