// 驗收測試：第一階段之前的 leader／唯讀設定升級後怎麼對應（docs/releases-notes.json 1.1.0、API 參考寫的升級對應）
// 1. 已經不在專案裡的人留著的 leader 設定：丟掉（不會變成專案成員或專案管理員）
// 2. 沒有職稱、但真的在專案裡的 leader：照舊是專案管理員
// 3. 同時是 leader 又是唯讀（衝突）：先當唯讀成員，並標記給工作區管理員確認：
//    名冊上標出來（upgradeReview），升為專案管理員或工作區管理員按「略過」後就不再標；一般成員看不到這個標記
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/upgrade-mapping-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { testToken } from './test-token.js';
import { toPrePhase1 } from './legacy-db.js';
import { setProjectRole, listProjectMembers } from './test-members.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-upmap-'));
const file = path.join(dir, 'switch.db');
const A = '預設專案', B = '第二專案';
{
  const old = await openTestDb(file);
  await toPrePhase1(old);
  const person = (id, name, d, projects, extra = {}) => {
    const row = { id, kind: 'human', name, role: 'PG', code: id.slice(2, 6).toUpperCase(), token: 'h:old_' + id, created_at: `2026-01-0${d}T00:00:00.000Z`, updated_at: `2026-01-0${d}T00:00:00.000Z`, projects, ...extra };
    const cols = Object.keys(row);
    return old.run(`INSERT INTO participants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map(c => row[c]));
  };
  await person('p_boss', '林老闆', 1, `${A},${B}`, { is_admin: 1 });
  await person('p_stale', '張舊帶', 2, A); // 第二專案的 leader 設定還在，但人已經不在第二專案
  await person('p_lead', '李帶頭', 3, A); // 預設專案的 leader、沒有職稱
  await person('p_both', '陳兩頭', 4, `${A},${B}`); // 預設、第二專案都同時是 leader 又是唯讀
  await person('p_mem', '王一般', 5, A);
  const set = (k, v) => old.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  await set('project_leaders', { [A]: ['p_lead', 'p_both'], [B]: ['p_stale', 'p_both'] });
  await set('read_only', { [A]: ['p_both'], [B]: ['p_both'] });
  await set('project_roles', { p_boss: { [A]: 'PO' } });
  await old.close();
}

const db = await openTestDb(file);
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
try {
  const tok = {};
  for (const id of ['p_boss', 'p_stale', 'p_lead', 'p_both', 'p_mem']) tok[id] = await testToken(db, id);
  const roleIn = async (pj, id) => ok(await listProjectMembers(call, tok.p_boss, pj), '專案成員').members.find(m => m.participantId === id)?.role ?? null;

  // 1) 不在專案裡的人留著的 leader 設定：丟掉
  assert.equal(await roleIn(B, 'p_stale'), null, '不在第二專案：不會因為舊的 leader 設定變成成員');
  const pr = ok(await call(tok.p_boss, '/api/projects'), '專案清單');
  assert.ok(!(pr.projectAdmins[B] || []).includes('p_stale'), '也不是第二專案的專案管理員');
  assert.deepEqual(ok(await call(tok.p_stale, '/api/me'), '我').projects, [A], '只在原本的專案');
  console.log('✓ 不在專案裡的人的舊 leader 設定丟掉');

  // 2) 沒有職稱、真的在專案裡的 leader：專案管理員
  assert.equal(await roleIn(A, 'p_lead'), 'admin', '沒有職稱的 leader 照舊是專案管理員');
  console.log('✓ 沒有職稱的 leader 是專案管理員');

  // 3) leader 又是唯讀：唯讀成員，標記給工作區管理員
  assert.equal(await roleIn(A, 'p_both'), 'viewer', '衝突時先當唯讀成員');
  assert.equal(await roleIn(B, 'p_both'), 'viewer');
  assert.equal((await call(tok.p_both, '/api/messages', 'POST', { requestId: 'x1', project: A, text: '寫寫看' })).body.error?.code, 'READ_ONLY', '唯讀成員不能寫');
  const review = async t => ok(await call(t, '/api/roster'), '名冊').members.find(m => m.participantId === 'p_both')?.upgradeReview;
  assert.deepEqual((await review(tok.p_boss)).map(x => x.project), [A, B], '工作區管理員在名冊上看到要確認的專案');
  assert.equal((await review(tok.p_boss))[0].projectName, A, '帶專案名稱');
  assert.equal(await review(tok.p_mem), undefined, '一般成員看不到這個標記');
  assert.equal(ok(await call(tok.p_boss, '/api/roster'), '名冊').members.find(m => m.participantId === 'p_lead').upgradeReview, undefined, '沒衝突的人沒有標記');
  //    升為專案管理員：那個專案不再標
  ok(await setProjectRole(call, tok.p_boss, A, 'p_both', 'admin'), '升為預設專案的專案管理員');
  assert.deepEqual((await review(tok.p_boss)).map(x => x.project), [B], '升了的專案不再標');
  ok(await setProjectRole(call, tok.p_boss, A, 'p_both', 'viewer'), '再降回唯讀成員');
  assert.deepEqual((await review(tok.p_boss)).map(x => x.project), [B], '已經處理過的專案不會再標回來');
  //    一般成員不能略過；工作區管理員略過：不再標
  assert.equal((await call(tok.p_mem, '/api/roster/p_both/upgrade-review', 'DELETE')).status, 403, '一般成員不能略過');
  ok(await call(tok.p_boss, '/api/roster/p_both/upgrade-review', 'DELETE'), '略過');
  assert.equal(await review(tok.p_boss), undefined, '略過後不再標');
  assert.equal(await roleIn(B, 'p_both'), 'viewer', '略過不改專案角色');
  console.log('✓ leader 又是唯讀：唯讀成員，名冊標記給工作區管理員，升級或略過後清掉');

  console.log('upgrade-mapping-test：全部通過');
} catch (e) {
  console.error('upgrade-mapping-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
