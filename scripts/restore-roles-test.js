// 驗收測試：備份還原帶回備份自己的平台管理員與工作區管理員，一個不多、一個不少
// 備份裡平台管理員跟工作區管理員不是同一批人時，還原後誰有什麼權限跟備份一模一樣：
// 最早加入的工作區管理員不會因為還原變成平台管理員；匯入的人的登入改掛到備份裡的平台管理員（他本來就是平台管理員，沒多給權限）。
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/restore-roles-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rsroles-'));
const sites = [];
const site = async name => {
  const db = await openTestDb(path.join(dataDir, name + '.db'), { legacyProjects: false });
  sites.push(db);
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1', joinLimitPerHour: '100000' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { db, call };
};
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
async function exportAll(s, tok) {
  const info = ok(await s.call(tok, '/api/admin/backup?files=0'), '備份清單');
  const out = { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion, tables: {} };
  for (const t of info.tables) {
    out.tables[t.name] = [];
    for (let after = 0; ;) {
      const r = ok(await s.call(tok, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=0`), t.name);
      out.tables[t.name].push(...r.rows);
      if (r.next == null) break;
      after = r.next;
    }
  }
  return out;
}
async function importAll(s, tok, bk) {
  ok(await s.call(tok, '/api/admin/restore/begin', 'POST', { format: bk.format, formatVersion: bk.formatVersion, appVersion: bk.appVersion }), '開始匯入');
  for (const [t, rows] of Object.entries(bk.tables)) ok(await s.call(tok, '/api/admin/restore/rows', 'POST', { table: t, rows }), t);
  return s.call(tok, '/api/admin/restore/finish', 'POST', {});
}
// 每個人的 [名字, 工作區角色, 平台角色]（照名字排）
const roles = items => items.filter(p => p.memberType === 'human').map(p => [p.name, p.workspaceRole, p.platformRole]).sort((a, b) => a[0].localeCompare(b[0]));

try {
  // ---- 站 A：林志明（最早）、陳昭宇是工作區管理員；王小美是平台管理員（不是工作區管理員）----
  const A = await site('a');
  const join = async name => (await A.call(null, '/api/join', 'POST', { name, role: 'PG' })).body;
  const boss = await join('林志明'), chen = await join('陳昭宇'), wang = await join('王小美'), zhao = await join('趙小安');
  const Bo = boss.participant.participantId, Cn = chen.participant.participantId, Wg = wang.participant.participantId;
  ok(await A.call(boss.token, `/api/participants/${Cn}/workspace-role`, 'PUT', { role: 'admin' }), '陳昭宇升為工作區管理員');
  ok(await A.call(boss.token, `/api/participants/${Wg}/platform-role`, 'PUT', { role: 'admin' }), '王小美升為平台管理員');
  ok(await A.call(wang.token, `/api/participants/${Bo}/platform-role`, 'PUT', { role: 'none' }), '林志明降為一般帳號');
  const before = roles(ok(await A.call(wang.token, '/api/participants'), '名單').items);
  assert.deepEqual(before, [['林志明', 'admin', 'none'], ['王小美', 'member', 'admin'], ['趙小安', 'member', 'none'], ['陳昭宇', 'admin', 'none']].sort((a, b) => a[0].localeCompare(b[0])), '站 A 的角色');
  const backup = await exportAll(A, wang.token);

  // ---- 站 B：新站，匯入 ----
  const B = await site('b');
  const me = (await B.call(null, '/api/join', 'POST', { name: '匯入的人', role: 'PO' })).body;
  const fin = await importAll(B, me.token, backup);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.admin.participantId, Wg, '匯入的人的登入改掛到備份裡的平台管理員（不是最早加入的工作區管理員）');
  const mine = ok(await B.call(me.token, '/api/me'), '我是誰');
  assert.equal(mine.participantId, Wg);
  const after = roles(ok(await B.call(me.token, '/api/participants'), '名單').items);
  assert.deepEqual(after, before, '還原後每個人的工作區角色、平台角色跟備份一樣');
  // 權限也一樣：林志明不是平台管理員（不能升降平台管理員），王小美照舊不是工作區管理員但有平台管理權
  assert.equal(mine.workspaceRole, 'member', '王小美的明確工作區角色照舊是成員');
  assert.equal((await B.db.get("SELECT COUNT(*) AS n FROM accounts WHERE platform_role = 'admin'")).n, 1, '只有一位平台管理員');
  console.log('✓ 平台管理員與工作區管理員不同批：還原後角色一樣');

  console.log('restore-roles-test：全部通過');
} catch (e) {
  console.error('restore-roles-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const db of sites) await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
