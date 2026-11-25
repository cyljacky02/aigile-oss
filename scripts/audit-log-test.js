// 驗收測試：稽核紀錄（GLOSSARY「刪除與稽核」；docs/adr/0003）
// A. 管理操作寫稽核紀錄：任免平台管理員、任免工作區管理員、停用／恢復帳號、移出工作區（含自己離開）、修改「誰可以建立專案」、
//    刪除專案（記成 project.purge）、備份還原；沒有真的改到東西（no-op）不寫
// B. 每筆有時間、操作者（id、名字快照；系統操作記為「系統」）、動作、範圍（平台／工作區／專案）、對象（id、名字快照）、摘要數字、細節
// C. 讀取 GET /api/audit-log：平台管理員看全部；工作區管理員只看自己工作區的事件（平台層事件不給）；其他人類、AI 一律 403、沒登入 401
// D. 篩選：動作、操作者、時間區間；分頁（新的在前，before 游標）；不認得的參數、不認得的動作 400
// E. 只能新增：沒有修改或刪除的 API
// F. 稽核紀錄在備份裡；還原後紀錄回來，並多一筆 backup.restore
// 管理端點用 adminSession 的裝置 Token（敏感操作要再驗證）；SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres
// 本機暫存資料庫，不連任何站。用法：node scripts/audit-log-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';
import { adminSession } from './test-admin.js';

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-auditlog-'));
const dbs = [];
async function site(name) {
  const db = await openTestDb(path.join(dataDir, name + '.db'));
  dbs.push(db);
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json().catch(() => null) : null };
  };
  return { db, app, call };
}
const ok = (r, what) => { assert.ok(r.status >= 200 && r.status < 300, `${what}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

try {
  const A = await site('a');
  const { call } = A;
  const log = async (token, q = '') => ok(await call(token, '/api/audit-log' + (q ? '?' + q : '')), '讀稽核紀錄 ' + q);

  const wangJ = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body; // 第一位人類＝平台管理員＋工作區管理員
  const boss = await adminSession(call, wangJ.token);
  const WANG = wangJ.participant.participantId;
  const lin = (await call(null, '/api/join', 'POST', { name: '林工作', role: 'SM' })).body;
  const LIN = lin.participant.participantId;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;

  // ---------- A／B 任免工作區管理員 ----------
  ok(await call(boss.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: 'admin' }), '林工作升為工作區管理員');
  let r = await log(boss.token);
  let e = r.items[0];
  assert.equal(e.action, 'workspace_admin.grant', 'A 升工作區管理員有紀錄：' + JSON.stringify(e));
  assert.deepEqual(e.actor, { id: WANG, name: '王小美', kind: 'human' }, 'B 操作者 id、名字');
  assert.deepEqual(e.target, { kind: 'participant', id: LIN, name: '林工作' }, 'B 對象 id、名字');
  assert.equal(e.scope.kind, 'workspace', 'B 範圍是工作區');
  assert.equal(e.scope.workspaceId, 'default');
  assert.ok(typeof e.id === 'string' && !Number.isNaN(Date.parse(e.at)), 'B 有 id 與時間');
  const latest = async () => (await log(boss.token)).items[0];
  const count = async () => (await log(boss.token, 'limit=200')).items.length;

  // no-op 不寫：已經是工作區管理員再升一次
  let n0 = await count();
  ok(await call(boss.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: 'admin' }), '再升一次');
  assert.equal(await count(), n0, 'A 沒改到東西不寫');
  ok(await call(boss.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: 'member' }), '林工作降回成員');
  assert.equal((await latest()).action, 'workspace_admin.revoke', 'A 降工作區管理員');

  // ---------- 任免平台管理員（平台層） ----------
  ok(await call(boss.token, `/api/participants/${CHEN}/platform-role`, 'PUT', { role: 'admin' }), '陳大文升平台管理員');
  e = await latest();
  assert.deepEqual([e.action, e.scope.kind, e.scope.workspaceId, e.target.name], ['platform_admin.grant', 'platform', null, '陳大文'], 'A 升平台管理員是平台層：' + JSON.stringify(e));
  ok(await call(boss.token, `/api/participants/${CHEN}/platform-role`, 'PUT', { role: 'none' }), '陳大文降回');
  assert.equal((await latest()).action, 'platform_admin.revoke', 'A 降平台管理員');

  // ---------- 停用／恢復帳號 ----------
  ok(await call(boss.token, `/api/participants/${CHEN}/disable`, 'POST'), '停用陳大文');
  e = await latest();
  assert.deepEqual([e.action, e.scope.kind, e.target.id, e.detail], ['account.disable', 'platform', CHEN, { revokedAiTokens: 0 }], 'A 停用帳號：' + JSON.stringify(e));
  n0 = await count();
  ok(await call(boss.token, `/api/participants/${CHEN}/disable`, 'POST'), '再停用一次');
  assert.equal(await count(), n0, 'A 已停用再停用不寫');
  ok(await call(boss.token, `/api/participants/${CHEN}/enable`, 'POST'), '恢復陳大文');
  assert.equal((await latest()).action, 'account.enable', 'A 恢復帳號');

  // ---------- 修改「誰可以建立專案」 ----------
  ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'admins' }), '只有管理員能建專案');
  e = await latest();
  assert.deepEqual([e.action, e.scope.kind, e.detail], ['workspace_policy.update', 'workspace', { field: 'createProjects', from: 'members', to: 'admins' }], 'A 修改工作區政策：' + JSON.stringify(e));

  // ---------- 移出工作區、自己離開 ----------
  const zhao = (await call(null, '/api/join', 'POST', { name: '趙小強', role: 'QA' })).body;
  ok(await call(boss.token, `/api/participants/${zhao.participant.participantId}/remove`, 'POST'), '移出趙小強');
  e = await latest();
  assert.deepEqual([e.action, e.scope.kind, e.target.name], ['member.remove', 'workspace', '趙小強'], 'A 移出工作區：' + JSON.stringify(e));
  const qian = (await call(null, '/api/join', 'POST', { name: '錢多多', role: 'QA' })).body;
  ok(await call(qian.token, '/api/leave', 'POST'), '錢多多自己離開');
  e = await latest();
  assert.deepEqual([e.action, e.actor.name, e.target.name], ['member.leave', '錢多多', '錢多多'], 'A 自己離開：' + JSON.stringify(e));

  // ---------- 刪除專案（專案層；專案清掉之後名字還在） ----------
  const np = ok(await call(boss.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL' }), '建專案');
  const PID = np.items.find(p => p.name === '要刪的專案').id;
  ok(await call(boss.token, `/api/messages`, 'POST', { project: PID, text: '不該進稽核的原文', requestId: 'm1' }), '發一則訊息');
  ok(await call(boss.token, `/api/projects/${encodeURIComponent(PID)}/archive`, 'POST'), '封存');
  ok(await call(boss.token, `/api/projects/${encodeURIComponent(PID)}/delete`, 'POST', { confirmName: '要刪的專案' }), '刪除專案');
  e = await latest();
  assert.deepEqual([e.action, e.scope.kind, e.scope.workspaceId, e.scope.projectId, e.scope.projectName, e.target], ['project.purge', 'project', 'default', PID, '要刪的專案', { kind: 'project', id: PID, name: '要刪的專案' }], 'A 刪除專案：' + JSON.stringify(e));
  assert.equal(e.detail.code, 'DEL'); assert.equal(e.detail.counts.messages, 1, 'B 細節有數量');
  assert.ok(!JSON.stringify(await log(boss.token, 'limit=200')).includes('不該進稽核的原文'), 'B 不存訊息原文');
  r = ok(await call(boss.token, '/api/project-deletions'), '專案刪除清單');
  assert.deepEqual([r.items[0].name, r.items[0].byName, r.items[0].code], ['要刪的專案', '王小美', 'DEL'], '舊的專案刪除清單從稽核紀錄讀');

  // ---------- C 可見範圍 ----------
  ok(await call(boss.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: 'admin' }), '林工作再升為工作區管理員（不是平台管理員）');
  const all = (await log(boss.token, 'limit=200')).items;
  assert.ok(all.some(x => x.scope.kind === 'platform') && all.some(x => x.scope.kind !== 'platform'), 'C 平台管理員看全部（平台層與工作區）');
  r = await log(lin.token, 'limit=200');
  assert.ok(r.items.length && r.items.every(x => x.scope.kind !== 'platform' && x.scope.workspaceId === 'default'), 'C 工作區管理員只看工作區的事件：' + JSON.stringify(r.items.map(x => x.action)));
  assert.equal(r.items.length, all.filter(x => x.scope.kind !== 'platform').length, 'C 工作區的事件都看得到');
  assert.equal(r.includesPlatform, false);
  assert.equal((await call(lin.token, '/api/audit-log?scope=platform')).status, 403, 'C 工作區管理員要平台層事件：403');
  assert.ok(!(await log(lin.token, 'action=account.disable')).items.length, 'C 工作區管理員篩平台層動作也拿不到');
  assert.ok((await log(boss.token, 'scope=platform')).items.every(x => x.scope.kind === 'platform'), 'C scope=platform 只有平台層');
  assert.ok((await log(boss.token, 'scope=workspace')).items.every(x => x.scope.kind !== 'platform'), 'C scope=workspace 沒有平台層');
  const sun = (await call(null, '/api/join', 'POST', { name: '孫一般', role: 'PG' })).body; // 陳大文停用過，舊的登入碼已作廢
  assert.equal((await call(sun.token, '/api/audit-log')).status, 403, 'C 一般成員 403');
  assert.equal((await call(null, '/api/audit-log')).status, 401, 'C 沒登入 401');
  ok(await call(boss.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] }), '陳大文加進預設專案');
  const ai = ok(await call(wangJ.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '王小美的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }), '建 AI');
  const aiToken = await testToken(A.db, ai.participantId);
  assert.equal((await call(aiToken, '/api/audit-log')).status, 403, 'C 平台管理員的 AI 也 403');

  // ---------- D 篩選、分頁 ----------
  r = await log(boss.token, 'action=account.disable');
  assert.deepEqual(r.items.map(x => x.action), ['account.disable'], 'D 依動作');
  r = await log(boss.token, `actor=${encodeURIComponent(LIN)}`);
  assert.ok(!r.items.length, 'D 林工作沒做過管理操作');
  r = await log(boss.token, 'actor=' + qian.participant.participantId);
  assert.deepEqual(r.items.map(x => x.action), ['member.leave'], 'D 依操作者');
  assert.ok((await log(boss.token)).actors.some(a => a.id === WANG && a.name === '王小美'), 'D 回傳篩選用的操作者清單');
  const mid = all[Math.floor(all.length / 2)].at;
  const newer = (await log(boss.token, 'limit=200&from=' + encodeURIComponent(mid))).items, older = (await log(boss.token, 'limit=200&to=' + encodeURIComponent(mid))).items;
  assert.ok(newer.every(x => x.at >= mid) && older.every(x => x.at < mid), 'D 時間區間：from 含、to 不含');
  assert.equal(newer.length + older.length, all.length, 'D 兩邊加起來是全部');
  assert.ok(!(await log(boss.token, 'from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z')).items.length, 'D 區間外沒有');
  const pages = [];
  for (let cur = null, i = 0; i < 50; i++) {
    const p = await log(boss.token, 'limit=3' + (cur ? '&before=' + encodeURIComponent(cur) : ''));
    pages.push(...p.items);
    assert.ok(p.items.length <= 3, 'D 一頁最多 limit 筆');
    if (!p.next) break;
    cur = p.next;
  }
  assert.deepEqual(pages.map(x => x.id), all.map(x => x.id), 'D 一頁一頁翻完跟一次拿一樣（新的在前）');
  assert.ok(all.every((x, i) => !i || all[i - 1].at >= x.at), 'D 新的在前');
  for (const q of ['action=nope', 'limit=0', 'limit=500', 'from=不是時間', 'before=abc', 'scope=x', 'cursor=1'])
    assert.equal((await call(boss.token, '/api/audit-log?' + q)).status, 400, 'D 不對的參數 400：' + q);

  // ---------- E 只能新增 ----------
  const one = all[0].id;
  for (const [m, p] of [['PUT', '/api/audit-log'], ['PATCH', '/api/audit-log'], ['DELETE', '/api/audit-log'], ['POST', '/api/audit-log'], ['DELETE', `/api/audit-log/${one}`], ['PUT', `/api/audit-log/${one}`], ['PATCH', `/api/audit-log/${one}`], ['POST', `/api/audit-log/${one}/delete`]])
    assert.equal((await call(boss.token, p, m, {})).status, 404, `E 沒有 ${m} ${p}`);
  assert.deepEqual((await log(boss.token, 'limit=200')).items.map(x => x.id).slice(-all.length), all.map(x => x.id), 'E 紀錄都還在、沒被改');

  // ---------- F 備份與還原 ----------
  const info = ok(await call(boss.token, '/api/admin/backup?files=0'), '備份清單');
  assert.ok(info.tables.some(t => t.name === 'audit_log'), 'F 備份有稽核紀錄：' + JSON.stringify(info.tables.map(t => t.name)));
  const tables = {};
  for (const t of info.tables) {
    tables[t.name] = [];
    for (let after = 0; ;) {
      const p = ok(await call(boss.token, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=0`), '匯出 ' + t.name);
      tables[t.name].push(...p.rows);
      if (p.next == null) break;
      after = p.next;
    }
  }
  const before = (await log(boss.token, 'limit=200')).items;
  assert.equal(tables.audit_log.length, before.length, 'F 備份裡的稽核紀錄筆數一樣');
  const B = await site('b');
  const me = (await B.call(null, '/api/join', 'POST', { name: '匯入的人', role: 'PO' })).body;
  ok(await B.call(me.token, '/api/admin/restore/begin', 'POST', { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion }), '開始匯入');
  for (const [t, rows] of Object.entries(tables)) for (let i = 0; i < rows.length; i += 200) ok(await B.call(me.token, '/api/admin/restore/rows', 'POST', { table: t, rows: rows.slice(i, i + 200) }), '匯入 ' + t);
  ok(await B.call(me.token, '/api/admin/restore/finish', 'POST', {}), '結束匯入');
  const after = (await B.call(me.token, '/api/audit-log?limit=200')).body.items;
  assert.equal(after[0].action, 'backup.restore', 'F 還原後多一筆 backup.restore：' + JSON.stringify(after[0]));
  assert.deepEqual([after[0].actor.name, after[0].scope.kind, after[0].detail.appVersion], ['王小美', 'platform', info.appVersion], 'F 操作者是登入改掛過去的平台管理員');
  assert.deepEqual(after.slice(1).map(x => x.id), before.map(x => x.id), 'F 還原後稽核紀錄回來了');
  ok(await B.call(me.token, `/api/participants/${LIN}/workspace-role`, 'PUT', { role: 'member' }), '還原後照常寫（流水號接得上）');
  assert.equal((await B.call(me.token, '/api/audit-log')).body.items[0].action, 'workspace_admin.revoke', 'F 還原後新增的紀錄在最前面');

  console.log('audit-log-test：全部通過');
} finally {
  for (const db of dbs) { try { await db.close?.(); } catch {} }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
