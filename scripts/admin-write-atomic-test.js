// 管理與刪除操作的資料、稽核紀錄、管理員通知一起寫入（docs/adr/0003）：寫稽核紀錄失敗時整個操作都沒做，重試照常成功、只記一筆
// 涵蓋：刪除與復原單則訊息、升降平台管理員、升降工作區管理員、停用與恢復帳號、移出工作區、刪除與復原專案、清空專案訊息與整批復原
// 修正前：資料先寫、稽核紀錄另外寫；稽核那次失敗時資料已經改了，重試看到「已刪除」「已經是管理員」就不再記，稽核紀錄永遠少一筆
// 模擬寫入失敗：包一層資料庫，指定的那一次寫入（含 INSERT INTO audit_log 的那一句或那一批）丟錯，資料庫照交易規則整批不寫
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres。本機暫存資料庫，不連任何站。用法：node scripts/admin-write-atomic-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { appCaller } from './test-call.js';

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-atomic-'));
let db;
try {
  db = await openTestDb(path.join(dataDir, 'switch.db'));
  // 下一次寫稽核紀錄失敗（那一句或含那一句的整批都不寫）
  let failAudit = false;
  const writesAudit = sql => /INSERT INTO audit_log/i.test(sql);
  const trip = sqls => { if (failAudit && sqls.some(writesAudit)) { failAudit = false; throw new Error('模擬的資料庫寫入失敗'); } };
  const flaky = { ...db,
    run: (sql, ...a) => { trip([sql]); return db.run(sql, ...a); },
    batch: stmts => { trip(stmts.map(s => s[0])); return db.batch(stmts); } };
  const app = createApp({ db: flaky, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
  const call = appCaller(app);
  const ok = r => r.status >= 200 && r.status < 300;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const owner = await join('王小美', 'PO'); // 第一位人類＝平台管理員＋工作區管理員
  const boss = await adminSession(call, owner.token);
  const other = await join('陳大文', 'PG');
  const OTHER = other.participant.participantId;
  const victim = await join('林志明', 'UX');
  const VICTIM = victim.participant.participantId;
  await adminSession(call, other.token); // 平台管理員要有帳號
  for (const p of [OTHER, VICTIM]) assert.equal((await call(boss.token, `/api/participants/${p}/projects`, 'PUT', { projects: [PJ] })).status, 200);
  const auditCount = async action => (await call(boss.token, `/api/audit-log?action=${action}&limit=200`)).body.items.length;
  const notices = async (token, kind) => (await call(token, '/api/me/notices')).body.items.filter(x => x.kind === kind).length;

  // 第一次寫稽核紀錄失敗：回錯誤、資料沒改；重試成功、稽核紀錄剛好多一筆
  async function atomic(label, action, send, after = async () => {}) {
    const before = await auditCount(action);
    failAudit = true;
    const first = await send();
    assert.ok(!ok(first), `${label}：寫稽核紀錄失敗時回錯誤：${first.status} ${JSON.stringify(first.body)}`);
    assert.equal(failAudit, false, `${label}：有寫稽核紀錄`);
    const retry = await send();
    assert.ok(ok(retry), `${label}：重試成功：${retry.status} ${JSON.stringify(retry.body)}`);
    assert.equal(await auditCount(action), before + 1, `${label}：稽核紀錄剛好一筆`);
    await after(retry);
    return retry;
  }

  // 單則訊息
  const m = (await call(victim.token, '/api/messages', 'POST', { project: PJ, text: '要刪的訊息', requestId: 'rq1' })).body;
  await atomic('刪除訊息', 'message.delete', () => call(victim.token, `/api/messages/${m.messageId}`, 'DELETE'));
  await atomic('復原訊息', 'message.restore', () => call(victim.token, `/api/messages/${m.messageId}/restore`, 'POST'));
  // 升降平台管理員：通知也跟著一起寫（被升的人收到一則）
  await atomic('升為平台管理員', 'platform_admin.grant', () => call(boss.token, `/api/participants/${OTHER}/platform-role`, 'PUT', { role: 'admin' }),
    async () => assert.equal(await notices(other.token, 'admin_platform_grant'), 1, '升為平台管理員：通知一則'));
  await atomic('降為一般帳號', 'platform_admin.revoke', () => call(boss.token, `/api/participants/${OTHER}/platform-role`, 'PUT', { role: 'none' }),
    async () => assert.equal(await notices(other.token, 'admin_platform_revoke'), 1, '降為一般帳號：通知一則'));
  // 升降工作區管理員
  await atomic('升為工作區管理員', 'workspace_admin.grant', () => call(boss.token, `/api/participants/${OTHER}/workspace-role`, 'PUT', { role: 'admin' }),
    async () => assert.equal(await notices(other.token, 'admin_workspace_grant'), 1, '升為工作區管理員：通知一則'));
  await atomic('降為成員', 'workspace_admin.revoke', () => call(boss.token, `/api/participants/${OTHER}/workspace-role`, 'PUT', { role: 'member' }));
  // 停用與恢復帳號
  await atomic('停用帳號', 'account.disable', () => call(boss.token, `/api/participants/${VICTIM}/disable`, 'POST'));
  await atomic('恢復帳號', 'account.enable', () => call(boss.token, `/api/participants/${VICTIM}/enable`, 'POST'));
  // 清空專案訊息與整批復原
  const cleared = await atomic('清空專案訊息', 'project_messages.clear', () => call(boss.token, `/api/projects/${encodeURIComponent(PJ)}/messages/clear`, 'POST', { confirmName: PJ }));
  await atomic('整批復原', 'project_messages.restore', () => call(boss.token, `/api/message-clears/${cleared.body.clear.clearId}/restore`, 'POST'));
  // 刪除與復原專案
  const pid = (await call(boss.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL' })).body.items.find(p => p.name === '要刪的專案').id;
  assert.equal((await call(boss.token, `/api/projects/${encodeURIComponent(pid)}/archive`, 'POST')).status, 200, '封存');
  await atomic('刪除專案', 'project.delete', () => call(boss.token, `/api/projects/${encodeURIComponent(pid)}/delete`, 'POST', { confirmName: '要刪的專案' }));
  await atomic('復原專案', 'project.restore', () => call(boss.token, `/api/projects/${encodeURIComponent(pid)}/restore`, 'POST'));
  // 移出工作區
  await atomic('移出工作區', 'member.remove', () => call(boss.token, `/api/participants/${VICTIM}/remove`, 'POST'));

  // 另一份程式剛啟動時確認稽核紀錄表在不在，那次讀取剛好失敗（連線中斷）：表其實在，之後的管理操作照樣要記
  // 修正前：當成「還沒有表」，那個請求的管理操作不寫稽核紀錄
  let probeFails = true;
  const blip = { ...db, get: (sql, ...a) => {
    if (probeFails && /FROM audit_log LIMIT 1/i.test(sql)) { probeFails = false; return Promise.reject(new Error('Connection terminated unexpectedly')); }
    return db.get(sql, ...a);
  } };
  const call2 = appCaller(createApp({ db: blip, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } }));
  const before = await auditCount('workspace_admin.grant');
  assert.equal((await call2(boss.token, `/api/participants/${OTHER}/workspace-role`, 'PUT', { role: 'admin' })).status, 200, '另一份程式：升為工作區管理員');
  assert.equal(probeFails, false, '有確認稽核紀錄表');
  assert.equal(await auditCount('workspace_admin.grant'), before + 1, '確認表的那次讀取失敗，稽核紀錄照樣寫');
  console.log('admin-write-atomic-test：全部通過');
} catch (e) {
  console.error('admin-write-atomic-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await db?.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
