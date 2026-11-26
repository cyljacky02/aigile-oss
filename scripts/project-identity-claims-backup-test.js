// 實際走 HTTP 匯出與還原，保留已從舊設定消失的爭議來源。
import './test-home.mjs';
import assert from 'node:assert/strict';
import { startKit } from './browser-kit.js';

const at = '2026-01-01T00:00:00.000Z';
const ok = ({ status, body }) => { assert.ok(status < 400, `${status} ${JSON.stringify(body)}`); return body; };
const diagnostic = '/api/admin/project-identity';
const projects = [
  { id: 'alfa', name: 'Alfa', created_at: at, visibility: 'open' },
  { id: 'bravo', name: 'Bravo', created_at: at, visibility: 'open' },
];
const legacy = { format: 'aigile-backup', formatVersion: 1, appVersion: '1.0.7', tables: {
  projects,
  app_settings: [
    { key: 'slug:alfa', value: 'shared-old' }, { key: 'slug:bravo', value: 'shared-old' },
    { key: 'pcode:alfa', value: 'ALFA' }, { key: 'pcode:bravo', value: 'BRAV' },
    { key: 'pcodeold:ABCD', value: 'alfa' },
  ],
} };
async function restore(site, token, { tables, ...header }) {
  ok(await site.call(token, '/api/admin/restore/begin', 'POST', header));
  for (const [table, rows] of Object.entries(tables)) {
    if (rows.length) ok(await site.call(token, '/api/admin/restore/rows', 'POST', { table, rows }));
  }
  ok(await site.call(token, '/api/admin/restore/finish', 'POST', {}));
}
async function backup(site, token) {
  const { tables, ...header } = ok(await site.call(token, '/api/admin/backup?files=0'));
  const contents = {};
  for (const { name } of tables) {
    contents[name] = [];
    for (let after = 0; after !== null;) {
      const page = ok(await site.call(token, `/api/admin/backup/rows?table=${name}&after=${after}&files=0`));
      contents[name].push(...page.rows);
      after = page.next;
    }
  }
  return { ...header, tables: contents };
}
const start = name => startKit(`claim-backup-${name}`);
const sites = [];
try {
  const from = await start('source'); sites.push(from);
  const token = ok(await from.call(null, '/api/join', 'POST', { name: 'BackupAdmin', role: 'PO' })).token;
  await restore(from, token, legacy);
  const dispute = { namespace: 'slug', value: 'shared-old', claimants: [
    { projectId: 'alfa', source: 'slug', rawValue: 'shared-old' },
    { projectId: 'bravo', source: 'slug', rawValue: 'shared-old' },
  ] };
  assert.deepEqual(ok(await from.call(token, diagnostic)).claims.disputes, [dispute]);
  ok(await from.call(token, '/api/projects/alfa/slug', 'PUT', { slug: 'alfa-now' }));
  ok(await from.call(token, '/api/projects/bravo/slug', 'PUT', { slug: 'bravo-now' }));
  ok(await from.call(token, '/api/projects/alfa/code', 'PUT', { code: 'ANEW' }));
  const card = ok(await from.call(token, '/api/cards', 'POST', { project: 'alfa', title: 'Preserved card', requestId: 'claims-backup-card' }));
  assert.equal(card.cardId, 'ANEW-1');
  assert.deepEqual(ok(await from.call(token, diagnostic)).claims, { status: 'stale', disputes: [dispute] });
  for (const [method, route, body] of [
    ['POST', '/api/projects', { name: 'Available', slug: 'shared-old' }],
    ['PUT', '/api/projects/bravo/slug', { slug: 'shared-old' }],
  ]) {
    const r = await from.call(token, route, method, body);
    assert.deepEqual([r.status, r.body.error?.code], [409, 'SLUG_TAKEN'], '舊寫入仍保留爭議網址英文名');
  }
  const modern = await backup(from, token);
  assert.equal(modern.tables.app_settings.some(r => r.value === 'shared-old'), false, '爭議值已不在舊設定');

  const to = await start('target'); sites.push(to);
  const restorer = ok(await to.call(null, '/api/join', 'POST', { name: 'RestoreAdmin', role: 'PO' })).token;
  // 目標站也有自己的爭議快照。匯入另一份備份時應清掉。
  await restore(to, restorer, { ...legacy, tables: { ...legacy.tables, app_settings: legacy.tables.app_settings.map(r => ({ ...r, value: r.value === 'shared-old' ? 'target-only' : r.value })) } });
  assert.equal(ok(await to.call(restorer, diagnostic)).claims.disputes[0].value, 'target-only');
  await restore(to, restorer, modern);
  const restored = ok(await to.call(restorer, diagnostic));
  assert.deepEqual(restored.claims.disputes, [dispute], '現代備份保留來源站已從舊設定消失的爭議來源');
  assert.deepEqual(restored.conflicts, [], '即時診斷沿用匯入的舊設定');
  assert.deepEqual(ok(await to.call(restorer, '/api/projects')).items.map(({ id, slug, code }) => [id, slug, code]), [
    ['alfa', 'alfa-now', 'ANEW'], ['bravo', 'bravo-now', 'BRAV'],
  ]);
  for (const key of ['ANEW-1', 'ABCD-1', 'ALFA-1']) {
    const { cardId, title } = ok(await to.call(restorer, `/api/cards/${key}`));
    assert.deepEqual([cardId, title], ['ANEW-1', 'Preserved card']);
  }
  const again = await backup(to, restorer);
  assert.ok(again.tables.project_identity_claimants.some(r => r.namespace === 'slug' && r.value === 'shared-old'));
  assert.ok(!again.tables.project_identity_claimants.some(r => r.value === 'target-only' || (r.value === 'ALFA' && r.source === 'current_code')), '丟掉目標站來源與已過時的單方宣稱');
  console.log('project-identity-claims-backup-test：全部通過');
} finally {
  await Promise.all(sites.map(s => s.stop()));
}
