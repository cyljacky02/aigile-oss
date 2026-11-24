// 驗收測試：AI 看到的範圍跟所屬人類一致（GLOSSARY「成員與權限」；AI 的權限不超過所屬人類）
// 1. 專案清單：AI 只看得到「自己的專案成員資格 ∩ 所屬人類看得到的專案」；留著的舊成員資格不會露出所屬人類看不到的私人專案
// 2. 成員名單：別人的 projects、projectRoles 跟所屬人類看到的一樣（不多也不少），回應的形狀不變
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/ai-scope-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { addToProject } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-aiscope-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const A = '預設專案', B = '第二專案';
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const join = async name => (await call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
const keys = o => Object.keys(o || {}).sort();

try {
  const boss = await join('林志明');
  const chen = await join('陳昭宇'), wang = await join('王小美');
  const Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  ok(await addToProject(call, boss.token, A, [Cn, Wg]), '加入預設專案');
  ok(await addToProject(call, boss.token, B, Wg), '王小美加入第二專案');
  const C = ok(await call(boss.token, '/api/projects', 'POST', { name: '第三專案' }), '建第三專案').id;
  ok(await addToProject(call, boss.token, C, [Cn, Wg]), '加入第三專案');
  ok(await call(chen.token, `/api/participants/${Cn}/project-roles`, 'PUT', { roles: { [A]: 'PG', [C]: 'PG' } }), '陳昭宇的職稱');
  ok(await call(wang.token, `/api/participants/${Wg}/project-roles`, 'PUT', { roles: { [A]: 'QA', [B]: 'QA', [C]: 'QA' } }), '王小美的職稱');
  const ai = ok(await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', ...S }), '建 AI');
  ok(await call(boss.token, `/api/projects/${B}/visibility`, 'PUT', { visibility: 'private' }), '第二專案設成私人');

  // 1) AI 留著一筆第二專案（私人、所屬人類不在）的舊成員資格
  await db.run("INSERT INTO project_members (project_id, participant_id, role) VALUES (?, ?, 'member')", B, ai.participantId);
  const aiProjects = ok(await call(ai.token, '/api/projects'), 'AI 的專案清單');
  assert.deepEqual(aiProjects.items.map(p => p.id), [A], 'AI 只看得到自己的成員資格 ∩ 所屬人類看得到的專案');
  for (const k of ['projectAdmins', 'viewers', 'leaders', 'readOnly', 'join']) assert.ok(!keys(aiProjects[k]).includes(B), `${k} 不露出私人專案`);
  const chenProjects = ok(await call(chen.token, '/api/projects'), '所屬人類的專案清單');
  assert.ok(!chenProjects.items.some(p => p.id === B), '所屬人類本來就看不到第二專案');
  console.log('✓ AI 的專案清單不超出所屬人類');

  // 2) 成員名單：AI 看到王小美的專案、職稱跟陳昭宇看到的一樣（陳昭宇在預設、第三專案；AI 只在預設專案）
  const of = async tok => ok(await call(tok, '/api/participants'), '成員名單').items.find(p => p.participantId === Wg);
  const byOwner = await of(chen.token), byAi = await of(ai.token);
  assert.deepEqual(byOwner.projects, [A, C], '所屬人類看到兩人共同的專案');
  assert.deepEqual(byAi.projects, byOwner.projects, 'AI 看到的 projects 跟所屬人類一樣（不少）');
  assert.deepEqual(byAi.projectRoles, byOwner.projectRoles, 'AI 看到的 projectRoles 跟所屬人類一樣');
  assert.ok(!byAi.projects.includes(B), '所屬人類看不到的私人專案 AI 也看不到（不多）');
  assert.deepEqual(Object.keys(byAi).sort(), Object.keys(byOwner).sort(), '回應的形狀不變');
  console.log('✓ AI 在成員名單看到的範圍跟所屬人類一致');

  console.log('ai-scope-test：全部通過');
} catch (e) {
  console.error('ai-scope-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
