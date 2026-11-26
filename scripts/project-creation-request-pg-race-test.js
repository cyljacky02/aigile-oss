// 驗收測試（Postgres，#46、ADR 0005）：建立專案申請與政策切換、移出、停用「兩個交易真的同時開著」時，結果仍一致
// SQLite、D1 一次只做一個寫入交易，不會這樣交錯；Postgres 會，所以只在設了 AIGILE_TEST_PG_URL 時跑。
// 做法（同 project-statuses-pg-race-test）：先開始的請求做到某一句之後停住（交易開著、工作區列鎖拿著：那句後面插一句等測試手上的 advisory lock），
// 再送另一個請求（連線池裡的另一條連線），等它被工作區列鎖擋住，測試才放行第一個。每段檢查：每份申請只有一個結局、數字以交易內實際為準。
// 1. 送出申請 vs 政策切換（政策先）：送出在交易內看到政策已不是 approval → 403，不留申請
// 2. 政策切換 vs 送出申請（送出先）：政策切換取消的包含剛送出的那份（實際數，不是交易前讀到的）
// 3. 移出申請人 vs 政策切換：先完成的取消（workspace_member_removed），政策切換只取消剩下的
// 4. 申請人撤回 vs 停用申請人：撤回先完成 → 停用取消 0 份（已撤回的不變）
// 5. 停用申請人 vs 政策切換：停用先完成（account_disabled），政策切換只取消剩下的
// 6. 核准 vs 政策切換：TODO(#48) —— 核准在 #45；見下面的 approveVsPolicyChange
// 用法：AIGILE_TEST_PG_URL=postgres://…@127.0.0.1/… node scripts/project-creation-request-pg-race-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

if (!TEST_PG_URL) { console.log('project-creation-request-pg-race-test：略過（只有 Postgres 會有兩個寫入交易同時進行）'); process.exit(0); }
const { default: pg } = await import('pg');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pcrrace-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const ctl = new pg.Client({ connectionString: TEST_PG_URL }); // 測試自己的連線：拿 advisory lock、看誰在等鎖
await ctl.connect();

// 下一個含有符合 re 那句的交易，做完那句就停住，等測試放行（只作用一次）
let pause = null;
const appDb = { ...db, batch: stmts => {
  const p = pause && stmts.some(([sql]) => pause.re.test(sql)) ? pause : null;
  if (p) pause = null;
  return db.batch(p ? stmts.flatMap(st => (p.re.test(st[0]) ? [st, [`SELECT pg_advisory_xact_lock(${p.key})`, []]] : [st])) : stmts);
} };
const config = { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000', unreleasedProjectCreationRequests: '1' }; // 暫時的啟用控制（#48 移除）
const call = appCaller(createApp({ db: appDb, storage: dbStorage(db), docText: '', config }));
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('等太久：' + label); await new Promise(r => setTimeout(r, 25)); } };
const lockWait = like => ctl.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]).then(r => r.rows[0].n > 0);

// first 做到 re 那句停住 → second 開始，等它被工作區列鎖擋住 → 放行 first；回傳兩邊的回應
let lockKey = 4_236_946_000;
async function race({ re, first, second }) {
  const key = ++lockKey;
  await ctl.query('SELECT pg_advisory_lock($1)', [key]);
  pause = { re, key };
  const p1 = first();
  await until(() => lockWait(`%pg_advisory_xact_lock(${key})%`), 10000, '第一個請求停在交易中');
  let done2 = false;
  const p2 = second().finally(() => { done2 = true; });
  await until(async () => done2 || await lockWait('%UPDATE workspaces SET name = name%'), 10000, '第二個請求被鎖住或做完');
  const blocked = !done2;
  await ctl.query('SELECT pg_advisory_unlock($1)', [key]);
  const r1 = await p1, r2 = await p2;
  assert.equal(pause, null, '真的停在指定的那句');
  assert.ok(blocked, '第二個請求要等第一個做完（同一把工作區列鎖）');
  return { r1, r2 };
}

const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const POLICY = /^UPDATE workspaces SET create_projects/, SUBMIT = /^INSERT INTO project_creation_requests\b/, REMOVE = /SET workspace_status = 'removed'/,
  DISABLE = /SET status = 'disabled'/, WITHDRAW = /^UPDATE project_creation_requests SET state = \?/;
let seq = 0;
const rid = () => `race-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const states = async () => Object.fromEntries((await db.all('SELECT name, state, cancel_code FROM project_creation_requests')).map(r => [r.name, `${r.state}${r.cancel_code ? ':' + r.cancel_code : ''}`]));
const pendingCount = async () => Number((await db.get("SELECT COUNT(*) AS n FROM project_creation_requests WHERE state = 'pending'")).n);

// TODO(#48)：核准 vs 政策切換（核准在 #45）。兩個順序都要測：
//   - 核准先完成（停在核准那一批），政策切換被擋住 → 放行後：申請 approved、專案存在；政策切換的 cancelledProjectCreationRequests 不含它
//   - 政策切換先完成（停在 POLICY），核准被擋住 → 放行後：核准 409（政策已改變），申請 cancelled:policy_changed、沒有專案
// 也要補：核准 vs 停用申請人、核准 vs 移出申請人（申請人不符資格 → 409；先核准的不受影響）。用上面的 race() 就行
async function approveVsPolicyChange() {
  console.log('… 核准 vs 政策切換：TODO(#48)（核准在 #45，整合時補上）');
}

try {
  const join = async name => { const b = ok(await call(null, '/api/join', 'POST', { name, role: 'PG' }), name); return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明'); // 平台管理員＋工作區管理員
  boss.token = (await adminSession(call, boss.token)).token; // 停用帳號是敏感操作
  const chen = await join('陳大文'), wang = await join('王小美'), dan = await join('丹尼'), eve = await join('伊芙'), fay = await join('菲菲');
  const policy = value => call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: value });
  const submit = (who, name) => call(who.token, '/api/project-creation-requests', 'POST', { requestId: rid(), name, reason: '要做新功能' });
  const submitted = async (who, name) => ok(await submit(who, name), `${name} 送出`);
  ok(await policy('approval'), '政策設成 approval');

  // 1) 政策切換先開始（停在改政策那句），送出申請被擋住 → 送出在交易內看到政策已變 → 403，不留申請
  {
    await submitted(wang, '王的舊申請');
    const { r1, r2 } = await race({ re: POLICY, first: () => policy('admins'), second: () => submit(chen, '交錯送出') });
    assert.equal(ok(r1, '政策切換').cancelledProjectCreationRequests, 1, '政策切換取消交易內實際待審的那一份');
    assert.equal(r2.status, 403, '送出：' + JSON.stringify(r2.body));
    assert.equal(code(r2), 'PROJECT_CREATION_REQUESTS_CLOSED');
    const s = await states();
    assert.equal(s['交錯送出'], undefined, '沒有留下申請');
    assert.equal(s['王的舊申請'], 'cancelled:policy_changed');
    assert.equal(await pendingCount(), 0);
    console.log('✓ 送出 vs 政策切換（政策先）：送出 403、不留申請');
  }

  // 2) 送出先開始（停在寫申請那句），政策切換被擋住 → 政策切換取消的包含剛送出的那份
  {
    ok(await policy('approval'), '政策切回 approval');
    await submitted(wang, '王的申請二');
    const pv = ok(await call(boss.token, '/api/workspace/settings/create-projects-preview'), '預覽');
    assert.equal(pv.pendingProjectCreationRequests, 1, '預覽時只有一份');
    const { r1, r2 } = await race({ re: SUBMIT, first: () => submit(chen, '搶先送出'), second: () => policy('members') });
    assert.equal(r1.status, 201, '送出先完成：' + JSON.stringify(r1.body));
    assert.equal(ok(r2, '政策切換').cancelledProjectCreationRequests, 2, '實際取消 2 份（預覽是 1）');
    const s = await states();
    assert.deepEqual([s['搶先送出'], s['王的申請二']], ['cancelled:policy_changed', 'cancelled:policy_changed']);
    const a = await db.get("SELECT count FROM audit_log WHERE action = 'workspace_policy.update' ORDER BY seq DESC LIMIT 1");
    assert.equal(Number(a.count), 2, '稽核記實際數');
    const n = await db.all("SELECT participant_id FROM account_notices WHERE kind = 'project_creation_request_cancelled' AND created_at >= ?", Date.now() - 60_000);
    assert.ok([chen.id, wang.id].every(id => n.some(x => x.participant_id === id)), '兩位申請人都收到通知');
    console.log('✓ 政策切換 vs 送出（送出先）：取消數以交易內實際為準');
  }

  // 3) 移出申請人先開始（停在移出那句），政策切換被擋住 → 他的申請 workspace_member_removed；政策切換只取消別人的
  {
    ok(await policy('approval'), '政策切回 approval');
    await submitted(dan, '丹尼的申請');
    await submitted(wang, '王的申請三');
    const { r1, r2 } = await race({ re: REMOVE, first: () => call(boss.token, `/api/participants/${dan.id}/remove`, 'POST'), second: () => policy('admins') });
    assert.equal(ok(r1, '移出').cancelledProjectCreationRequests, 1);
    assert.equal(ok(r2, '政策切換').cancelledProjectCreationRequests, 1, '政策切換只取消剩下的那份');
    const s = await states();
    assert.deepEqual([s['丹尼的申請'], s['王的申請三']], ['cancelled:workspace_member_removed', 'cancelled:policy_changed'], '每份只有一個結局');
    console.log('✓ 移出申請人 vs 政策切換：先完成的取消，另一個只取消剩下的');
  }

  // 4) 申請人撤回先開始（停在改狀態那句），停用申請人被擋住 → 撤回成功，停用取消 0 份
  {
    ok(await policy('approval'), '政策切回 approval');
    const mine = await submitted(eve, '伊芙的申請');
    const { r1, r2 } = await race({ re: WITHDRAW, first: () => call(eve.token, `/api/project-creation-requests/${mine.id}/withdraw`, 'POST'), second: () => call(boss.token, `/api/participants/${eve.id}/disable`, 'POST') });
    assert.equal(ok(r1, '撤回').state, 'withdrawn');
    assert.equal(ok(r2, '停用').cancelledProjectCreationRequests, 0, '已撤回的不再取消');
    assert.equal((await states())['伊芙的申請'], 'withdrawn');
    console.log('✓ 撤回 vs 停用申請人：撤回先完成，停用取消 0 份');
  }

  // 5) 停用申請人先開始（停在停用那句），政策切換被擋住 → 他的申請 account_disabled；政策切換只取消別人的
  {
    await submitted(fay, '菲菲的申請');
    await submitted(chen, '陳的申請');
    const { r1, r2 } = await race({ re: DISABLE, first: () => call(boss.token, `/api/participants/${fay.id}/disable`, 'POST'), second: () => policy('members') });
    assert.equal(ok(r1, '停用').cancelledProjectCreationRequests, 1);
    assert.equal(ok(r2, '政策切換').cancelledProjectCreationRequests, 1);
    const s = await states();
    assert.deepEqual([s['菲菲的申請'], s['陳的申請']], ['cancelled:account_disabled', 'cancelled:policy_changed'], '每份只有一個結局');
    console.log('✓ 停用申請人 vs 政策切換：先完成的取消，另一個只取消剩下的');
  }

  // 6) 核准 vs 政策切換：TODO(#48)
  await approveVsPolicyChange();

  console.log('project-creation-request-pg-race-test：全部通過');
} catch (e) {
  console.error('project-creation-request-pg-race-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await ctl.end().catch(() => {});
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
