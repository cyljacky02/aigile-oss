// 驗收測試（ADR 0004、0005）：共用的建立專案邏輯
// - 直接建立可以指定可見度（預設審核）；私人專案從寫入的那一刻起就是私人的，不會先以別的可見度出現
// - 建立者只新增新專案的一筆成員資格：同時進行的其他成員資格變更不會被整份清單覆寫掉
// - 每次建立寫一筆 project.create 稽核：直接建立的執行者＝建立者（method direct）；新站預設專案是系統、示範資料是操作的人
// - 注入寫入失敗：沒有部分專案、成員資格、識別碼或稽核；重試照常成功、只記一筆
// - 程式先部署、稽核表還沒建立的空窗期：直接建立照常（不寫稽核）
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。用法：node scripts/project-create-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { addToProject } from './test-members.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcreate-'));
const CONFIG = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' };
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const dbs = [];
// hooks：before＝下一個含符合 re 那句的寫入送出前先執行 run()；afterCommit＝那一批提交後馬上執行 run()；fail＝那一批丟錯（都只作用一次）
function harness(db) {
  const hooks = { before: null, afterCommit: null, fail: null };
  const hit = (slot, stmts) => (hooks[slot] && stmts.some(([sql]) => hooks[slot].re.test(sql)) ? hooks[slot] : null);
  const wrapped = { ...db, batch: async stmts => {
    const b = hit('before', stmts); if (b) { hooks.before = null; await b.run(); }
    const f = hit('fail', stmts); if (f) { hooks.fail = null; throw new Error('模擬的資料庫寫入失敗'); }
    const a = hit('afterCommit', stmts); if (a) hooks.afterCommit = null;
    const out = await db.batch(stmts);
    if (a) await a.run();
    return out;
  } };
  const app = createApp({ db: wrapped, storage: dbStorage(db), docText: '', config: CONFIG });
  return { hooks, call: appCaller(app) };
}
const audits = async (call, token, extra = '') => ok(await call(token, `/api/audit-log?action=project.create${extra}`), '讀 project.create 稽核').items;

try {
  // ---------- 1) 一般站：可見度、成員資格、稽核、注入失敗 ----------
  {
    const db = await openTestDb(path.join(dataDir, 'main', 'switch.db'));
    dbs.push(db);
    const { hooks, call } = harness(db);
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員＋工作區管理員
    const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body; // 一般成員
    const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'UX' })).body; // 一般成員（不在新專案）
    const Cn = chen.participant.participantId;
    ok(await call(boss.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['預設專案'] }), '陳加入預設專案');
    ok(await call(boss.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] }), '王加入預設專案');
    ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: 'members' }), '所有成員都能建立專案');

    // 1a) 沒指定可見度：維持審核
    const plain = ok(await call(chen.token, '/api/projects', 'POST', { name: '一般專案' }), '直接建立');
    assert.equal(plain.items.find(p => p.id === plain.id)?.visibility, 'review', '沒指定可見度＝審核');

    // 1b) 不認得的可見度：400，什麼都沒建
    const bad = await call(chen.token, '/api/projects', 'POST', { name: '壞可見度', visibility: 'secret' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(code(bad), 'INVALID_REQUEST');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM projects WHERE name = ?', '壞可見度')).n * 1, 0, '沒有建出專案');

    // 1c) 指定私人：寫入的那一批提交的當下就已經是私人；其他成員看不到；建立過程沒有另外改可見度
    let seenAtCommit = null, othersAtCommit = null;
    hooks.afterCommit = { re: /^INSERT INTO projects\b/, run: async () => {
      seenAtCommit = (await db.get('SELECT visibility FROM projects WHERE name = ?', '私人專案'))?.visibility;
      othersAtCommit = (await call(wang.token, '/api/projects')).body.items.map(p => p.name);
    } };
    const sec = await call(chen.token, '/api/projects', 'POST', { name: '私人專案', visibility: 'private' });
    assert.equal(sec.status, 201, JSON.stringify(sec.body));
    assert.equal(seenAtCommit, 'private', '提交的當下就是私人');
    assert.ok(Array.isArray(othersAtCommit) && !othersAtCommit.includes('私人專案'), '提交的當下其他成員就看不到');
    assert.equal(sec.body.items.find(p => p.id === sec.body.id)?.visibility, 'private', '建立者看到私人');
    assert.ok(!(await call(wang.token, '/api/projects')).body.items.some(p => p.id === sec.body.id), '其他成員看不到私人專案');
    const evs = await db.all('SELECT text FROM project_events WHERE project_id = ?', sec.body.id);
    assert.ok(!evs.some(e => /可見度/.test(e.text)), '沒有另外改可見度：' + JSON.stringify(evs));

    // 1d) 同時有別人把建立者加進第二專案：建立只新增新專案那一筆，不覆寫掉剛加的
    hooks.before = { re: /^INSERT INTO projects\b/, run: async () => { ok(await addToProject(call, boss.token, '第二專案', Cn), '同時加進第二專案'); } };
    const mine = await call(chen.token, '/api/projects', 'POST', { name: '同時專案' });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal(hooks.before, null, '真的有交錯');
    const rows = await db.all('SELECT project_id, role FROM project_members WHERE participant_id = ? ORDER BY project_id', Cn);
    const roleIn = Object.fromEntries(rows.map(r => [r.project_id, r.role]));
    assert.equal(roleIn['第二專案'], 'member', '同時加進第二專案的成員資格還在：' + JSON.stringify(rows));
    assert.equal(roleIn['預設專案'], 'member', '原本的成員資格還在');
    assert.equal(roleIn[mine.body.id], 'admin', '建立者是新專案的專案管理員');
    assert.deepEqual((await db.all('SELECT participant_id, role FROM project_members WHERE project_id = ?', mine.body.id)).map(r => [r.participant_id, r.role]), [[Cn, 'admin']], '新專案只有建立者一個（唯一的初始專案管理員）');

    // 1e) project.create 稽核：每次建立一筆，執行者＝建立者、method direct
    const list = await audits(call, boss.token);
    const byProject = id => list.filter(e => e.scope.projectId === id);
    for (const p of [plain, sec.body, mine.body]) assert.equal(byProject(p.id).length, 1, '每次建立剛好一筆 project.create');
    const e = byProject(sec.body.id)[0];
    assert.equal(e.actor.id, Cn, '執行者是建立者');
    assert.equal(e.actor.kind, 'human');
    assert.equal(e.scope.kind, 'project');
    assert.equal(e.scope.projectName, '私人專案');
    assert.deepEqual(e.target, { kind: 'project', id: sec.body.id, name: '私人專案' });
    assert.equal(e.detail.method, 'direct', '建立方式 direct');
    assert.equal(e.detail.visibility, 'private');
    assert.ok(e.detail.code && e.detail.slug, '記下代號與網址英文名：' + JSON.stringify(e.detail));
    assert.equal(e.detail.requestId, undefined, '直接建立沒有申請編號');

    // 1f) 寫稽核失敗：整批沒寫（沒有專案、成員資格、識別碼、看板狀態、稽核）；重試成功、只記一筆
    const settingsBefore = (await db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'slug:%' OR key LIKE 'pcode:%'")).n * 1;
    const membersBefore = (await db.get('SELECT COUNT(*) AS n FROM project_members')).n * 1;
    const statusesBefore = (await db.get('SELECT COUNT(*) AS n FROM project_statuses')).n * 1;
    const auditsBefore = (await db.get('SELECT COUNT(*) AS n FROM audit_log')).n * 1;
    hooks.fail = { re: /^INSERT INTO audit_log\b/ };
    const STATUSES = [{ name: '待辦', category: '待處理' }, { name: '做', category: '進行中' }, { name: '好', category: '已完成' }];
    const failed = await call(chen.token, '/api/projects', 'POST', { name: '失敗專案', visibility: 'open', statuses: STATUSES });
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(hooks.fail, null, '真的注入了失敗');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM projects WHERE name = ?', '失敗專案')).n * 1, 0, '沒有部分建立的專案');
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'slug:%' OR key LIKE 'pcode:%'")).n * 1, settingsBefore, '沒有留下識別碼');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM project_members')).n * 1, membersBefore, '沒有留下成員資格');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM project_statuses')).n * 1, statusesBefore, '沒有留下看板狀態');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM audit_log')).n * 1, auditsBefore, '沒有留下稽核');
    const again = await call(chen.token, '/api/projects', 'POST', { name: '失敗專案', visibility: 'open', statuses: STATUSES });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.items.find(p => p.id === again.body.id)?.visibility, 'open');
    assert.equal((await audits(call, boss.token)).filter(x => x.scope.projectId === again.body.id).length, 1, '重試後只記一筆');

    // 1g) 工作區管理員直接建立也一樣記（執行者＝管理員；管理員成為唯一的初始專案管理員）
    const own = ok(await call(boss.token, '/api/projects', 'POST', { name: '管理員專案', visibility: 'private' }), '管理員直接建立');
    const ae = (await audits(call, boss.token)).find(x => x.scope.projectId === own.id);
    assert.equal(ae?.actor.id, boss.participant.participantId);
    assert.equal(ae?.detail.method, 'direct');
    assert.deepEqual((await db.all('SELECT participant_id, role FROM project_members WHERE project_id = ?', own.id)).map(r => [r.participant_id, r.role]), [[boss.participant.participantId, 'admin']]);
  }

  // ---------- 2) 新站第一次啟動的預設專案（系統）、示範資料（操作的人） ----------
  {
    const db = await openTestDb(path.join(dataDir, 'fresh', 'switch.db'), { legacyProjects: false });
    dbs.push(db);
    const { call } = harness(db);
    const boss = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
    const first = await audits(call, boss.token);
    assert.equal(first.length, 1, '新站只有預設專案那一筆：' + JSON.stringify(first));
    assert.equal(first[0].actor.kind, 'system', '預設專案的執行者是系統');
    assert.equal(first[0].actor.id, 'system');
    assert.equal(first[0].scope.projectName, '預設專案');
    assert.equal(first[0].detail.method, 'first_run');
    const projects = (await call(boss.token, '/api/projects')).body.items;
    assert.equal(projects.length, 1, '只建一個預設專案');
    assert.equal(projects[0].visibility, 'review');

    const demo = ok(await call(boss.token, '/api/admin/demo', 'POST'), '載入示範資料');
    const de = (await audits(call, boss.token)).find(x => x.scope.projectId === demo.projectId);
    assert.ok(de, '示範專案有 project.create');
    assert.equal(de.actor.id, boss.participant.participantId, '示範資料的執行者是操作的人');
    assert.equal(de.detail.method, 'demo');
  }

  // ---------- 3) 程式先部署、稽核表還沒建立：直接建立照常 ----------
  {
    const file = path.join(dataDir, 'noaudit', 'switch.db');
    const db = await openTestDb(file);
    dbs.push(db);
    const { call } = harness(db);
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    await db.run('DROP TABLE audit_log');
    const { call: call2 } = harness(db); // 新的一份程式：第一個請求發現沒有稽核表
    const r = await call2(boss.token, '/api/projects', 'POST', { name: '空窗期專案', visibility: 'private' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await db.get('SELECT visibility FROM projects WHERE id = ?', r.body.id))?.visibility, 'private');
  }
  console.log('建立專案（共用建立邏輯）測試通過');
} finally {
  for (const db of dbs) await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
