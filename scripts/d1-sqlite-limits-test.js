// D1 的 SQLite 限制（本機 D1 驗證找到的）：D1 的 SQLite 比一般的嚴（例：一個複合 SELECT 最多 5 段、LIKE 樣式最長 50 位元組），
// 超過時在 D1 上是 500，在 SQLite 與 Postgres 上卻照常——所以一般的測試抓不到。這支用 node:sqlite 開一個「套上 D1 限制」的資料庫
// （src/db-d1.js 的 D1_SQLITE_LIMITS，數字是在本機 D1 實測的），跑建立專案與建立專案申請的主要流程，任何一句超過限制就失敗。
// 回歸：沒指定看板狀態的新專案第一次被讀到時，補預設狀態組那一句是 6 段 UNION ALL → D1「too many terms in compound SELECT」，
//       直接建立或核准建立後讀專案清單就 500。
// 只有 SQLite（限制是 node:sqlite 的開檔選項）；Node 不支援 limits 選項時印「略過」。用法：node scripts/d1-sqlite-limits-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openNodeDb } from '../src/db-node.js';
import { D1_SQLITE_LIMITS } from '../src/db-d1.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

const supported = (() => {
  try { new DatabaseSync(':memory:', { limits: { compoundSelect: 5 } }).prepare('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6').all(); return false; } catch { return true; }
})();
if (!supported) { console.log('d1-sqlite-limits-test：略過（這版 Node 的 node:sqlite 不支援 limits 選項）'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-d1lim-'));
let db;
try {
  db = openNodeDb(path.join(dir, 'switch.db'), { legacyProjects: false, limits: D1_SQLITE_LIMITS });
  await assert.rejects(db.all('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6'), /too many terms in compound SELECT/, '資料庫真的套上了 D1 的限制');
  const call = appCaller(createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } }));
  const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
  const join = async name => { const b = ok(await call(null, '/api/join', 'POST', { name, role: 'PG' }), name); return { token: b.token, id: b.participant.participantId }; };
  const boss = await join('林志明');
  boss.token = (await adminSession(call, boss.token)).token;
  const chen = await join('陳大文');

  // 直接建立（沒指定看板狀態）→ 讀專案清單會補預設狀態組
  const p = ok(await call(boss.token, '/api/projects', 'POST', { name: 'D1 限制' }), '直接建立');
  const list = ok(await call(boss.token, '/api/projects'), '讀專案清單（補預設狀態組）');
  assert.ok(list.items.some(x => x.id === p.id), '新專案在清單裡');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM project_statuses WHERE project = ?', p.id)).n), 6, '補上預設的 6 個狀態');
  console.log('✓ 沒指定看板狀態的新專案：補預設狀態組那一句在 D1 的限制內');

  // 建立專案申請：送出、核准（沒指定狀態）、拒絕、撤回、政策切換取消
  ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'approval' }), '政策 approval');
  let seq = 0;
  const submit = async (body = {}) => ok(await call(chen.token, '/api/project-creation-requests', 'POST', { requestId: `lim-${++seq}`, name: `限制 ${seq}`, reason: '驗證', ...body }), '送出');
  const q1 = await submit();
  const ap = ok(await call(boss.token, `/api/project-creation-requests/${q1.id}/approve`, 'POST', {}), '核准');
  ok(await call(chen.token, '/api/projects'), '申請人讀專案清單');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM project_statuses WHERE project = ?', ap.project.id)).n), 6, '核准建立的專案也補上預設狀態');
  ok(await call(boss.token, `/api/project-creation-requests/${(await submit()).id}/reject`, 'POST', { reason: '不要' }), '拒絕');
  ok(await call(chen.token, `/api/project-creation-requests/${(await submit()).id}/withdraw`, 'POST', {}), '撤回');
  await submit(); await submit();
  ok(await call(boss.token, '/api/project-creation-requests?scope=review&limit=100'), '審核清單');
  ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }), '政策切走（取消待審）');
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'")).n), 0);
  ok(await call(chen.token, '/api/me/notices'), '通知');
  ok(await call(boss.token, '/api/audit-log?limit=100'), '稽核');
  console.log('✓ 建立專案申請的送出、核准、拒絕、撤回、政策切換取消都在 D1 的限制內');
  console.log('d1-sqlite-limits-test：全部通過');
} catch (e) {
  console.error('d1-sqlite-limits-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  db?.close?.();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
