// 驗收測試（ADR 0004、0005）：共同不變量的寫入在交易內重新確認前提，交易前讀到的資料不算數
// 做法：攔下第一個請求的寫入（db.batch），先讓別的操作整個做完、或直接改資料，再放行第一個（SQLite、D1 一次只做一個交易，這就是會發生的交錯）。
// - 直接建立：交易前有權建立，寫入前政策剛改成「成員申請」或執行者剛被降級 → 不建立
// SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres（交錯一樣是先後執行）。用法：node scripts/workspace-write-guards-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { appCaller } from './test-call.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wguard-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
// before：下一個含有符合 re 那句的寫入送出前，先執行 run()（只作用一次）
let before = null;
const appDb = { ...db, batch: async stmts => {
  if (before && stmts.some(([sql]) => before.re.test(sql))) { const b = before; before = null; await b.run(stmts); }
  return db.batch(stmts);
} };
const app = createApp({ db: appDb, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = appCaller(app);
const code = r => r.body?.error?.code;
const ok = (r, label) => { assert.ok(r.status < 400, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, errCode, label) => { assert.equal(r.status, status, `${label}：${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); if (errCode) assert.equal(code(r), errCode, label); return r.body; };
// 讓 meanwhile() 在 first() 那批寫入前整個做完
async function interleave(re, first, meanwhile) {
  let r2 = null;
  before = { re, run: async stmts => { r2 = await meanwhile(stmts); } };
  const r1 = await first();
  assert.equal(before, null, '真的有交錯（中間的操作在第一個寫入前做完）');
  return { r1, r2 };
}
const n = async (sql, ...a) => Number((await db.get(sql, ...a)).n);
const named = name => n('SELECT COUNT(*) AS n FROM projects WHERE name = ?', name);
const CREATE = /^INSERT INTO projects \(/;

try {
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { ...b, id: b.participant.participantId }; };
  const boss = await join('林志明', 'PO'); // 平台管理員＋工作區管理員
  const ann = await join('安娜'); // 工作區管理員
  const chen = await join('陳大文'); // 一般成員
  boss.token = (await adminSession(call, boss.token)).token; // 升降管理員是敏感操作
  ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升為工作區管理員');
  ok(await call(boss.token, `/api/participants/${chen.id}/projects`, 'PUT', { projects: ['預設專案'] }), '陳加入預設專案');
  const setPolicy = v => call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: v });

  // 1) 直接建立：交易前政策是「所有成員」，寫入前剛改成「成員申請」→ 403 PROJECT_CREATION_REQUIRES_APPROVAL，沒有建立
  {
    ok(await setPolicy('members'), '政策：所有成員');
    const { r1, r2 } = await interleave(CREATE, () => call(chen.token, '/api/projects', 'POST', { name: '政策剛改' }), () => setPolicy('approval'));
    ok(r2, '中間改政策');
    is(r1, 403, 'PROJECT_CREATION_REQUIRES_APPROVAL', '寫入前政策剛改');
    assert.equal(await named('政策剛改'), 0, '沒有建立專案');
    console.log('✓ 直接建立：寫入前政策剛改成成員申請 → 不建立');
  }
  // 2) 直接建立：交易前是工作區管理員，寫入前剛被降級（政策是只有管理員）→ 403，沒有建立
  {
    ok(await setPolicy('admins'), '政策：只有管理員');
    const { r1, r2 } = await interleave(CREATE, () => call(ann.token, '/api/projects', 'POST', { name: '剛被降級' }),
      () => call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'member' }));
    ok(r2, '中間降級安娜');
    is(r1, 403, null, '寫入前剛被降級');
    assert.equal(await named('剛被降級'), 0, '沒有建立專案');
    ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升回工作區管理員');
    console.log('✓ 直接建立：寫入前執行者剛被降級 → 不建立');
  }

  // 3) 改「誰可以建立專案」：寫入前操作者剛被降級 → 403，政策沒改
  {
    const before0 = (await db.get('SELECT create_projects AS v FROM workspaces')).v;
    const { r1, r2 } = await interleave(/^UPDATE workspaces SET create_projects/, () => call(ann.token, '/api/workspace/settings', 'PUT', { createProjects: before0 === 'members' ? 'admins' : 'members' }),
      () => call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'member' }));
    ok(r2, '中間降級安娜');
    is(r1, 403, 'NOT_ADMIN', '寫入前剛被降級');
    assert.equal((await db.get('SELECT create_projects AS v FROM workspaces')).v, before0, '政策沒改');
    ok(await call(boss.token, `/api/participants/${ann.id}/workspace-role`, 'PUT', { role: 'admin' }), '安娜升回工作區管理員');
    console.log('✓ 改建立專案政策：寫入前操作者剛被降級 → 不存');
  }
  // 4) 只有「誰可以建立專案」真的改變才拿工作區列鎖、才檢查還原中：還原中改開放註冊照常存；改政策 503 RESTORING
  {
    const LOCK = /^UPDATE workspaces SET name = name WHERE id = \?$/;
    let firstSql = null;
    before = { re: /./, run: stmts => { firstSql = stmts[0][0]; } };
    ok(await call(boss.token, '/api/workspace/settings', 'PUT', { openJoin: false }), '關閉開放註冊');
    assert.ok(firstSql && !LOCK.test(firstSql.trim()), '只改開放註冊：不拿工作區列鎖');
    const cur = (await db.get('SELECT create_projects AS v FROM workspaces')).v;
    await db.run("INSERT INTO app_settings (key, value) VALUES ('restore_state', ?)", JSON.stringify({ by: 'nobody', at: new Date().toISOString() }));
    try {
      ok(await call(boss.token, '/api/workspace/settings', 'PUT', { openJoin: true, deleteOwnMessages: 'admins' }), '還原中改開放註冊與刪除訊息政策');
      ok(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: cur }), '還原中送一樣的建立專案政策（沒有改變）');
      is(await call(boss.token, '/api/workspace/settings', 'PUT', { createProjects: cur === 'members' ? 'admins' : 'members' }), 503, 'RESTORING', '還原中改建立專案政策');
      assert.equal((await db.get('SELECT create_projects AS v FROM workspaces')).v, cur, '政策沒改');
    } finally { await db.run("DELETE FROM app_settings WHERE key = 'restore_state'"); }
    console.log('✓ 只有建立專案政策改變才加鎖、才受還原中阻擋');
  }

  const create = async name => ok(await call(boss.token, '/api/projects', 'POST', { name }), `建立${name}`).id;
  const archive = id => call(boss.token, `/api/projects/${id}/archive`, 'POST');
  const unarchive = id => call(boss.token, `/api/projects/${id}/unarchive`, 'POST');
  const del = (id, name) => call(boss.token, `/api/projects/${id}/delete`, 'POST', { confirmName: name });
  const row = id => db.get('SELECT * FROM projects WHERE id = ?', id);
  const activeNamed = name => n('SELECT COUNT(*) AS n FROM projects WHERE name = ? AND archived = 0 AND deleted_at IS NULL', name);

  // 5) 刪除：交易前是封存的，寫入前剛被取消封存 → 409 NOT_ARCHIVED，沒有刪除（不會留下「已刪除卻未封存」的專案）
  {
    const id = await create('甲案');
    ok(await archive(id), '封存甲案');
    const { r1, r2 } = await interleave(/^UPDATE projects SET deleted_at = \?/, () => del(id, '甲案'), () => unarchive(id));
    ok(r2, '中間取消封存');
    is(r1, 409, 'NOT_ARCHIVED', '寫入前剛被取消封存');
    const r = await row(id);
    assert.equal(r.deleted_at, null, '沒有刪除');
    assert.equal(Number(r.archived), 0, '維持未封存');
    console.log('✓ 刪除：寫入前剛被取消封存 → 不刪');
  }
  // 6) 復原：在交易內用現況檢查名稱。已刪除的專案是未封存的（舊的競態留下的）、名稱剛被新專案用掉 → 409 NAME_TAKEN，維持已刪除
  {
    const id = await create('乙案');
    ok(await archive(id), '封存乙案');
    ok(await del(id, '乙案'), '刪除乙案');
    const { r1 } = await interleave(/^UPDATE projects SET deleted_at = NULL/, () => call(boss.token, `/api/projects/${id}/restore`, 'POST'), async () => {
      await db.run('UPDATE projects SET archived = 0 WHERE id = ?', id);
      return create('乙案');
    });
    is(r1, 409, 'NAME_TAKEN', '復原會讓兩個未封存專案同名');
    assert.ok((await row(id)).deleted_at, '維持已刪除');
    assert.equal(await activeNamed('乙案'), 1, '只有一個叫「乙案」的未封存專案');
    console.log('✓ 復原：交易內檢查名稱，不會重新啟用已被使用的名稱');
  }
  // 7) 封存：寫入前專案剛被封存並刪除 → 404，不對已刪除的專案記「封存專案」
  {
    const id = await create('丙案');
    const { r1 } = await interleave(/^UPDATE projects SET archived = 1/, () => archive(id), async () => { ok(await archive(id), '中間封存'); return del(id, '丙案'); });
    is(r1, 404, 'NOT_FOUND', '寫入前剛被刪除');
    assert.equal(await n("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND text LIKE '%封存專案'", id), 1, '只有一筆封存紀錄');
    console.log('✓ 封存：寫入前剛被刪除 → 404，不記事件');
  }
  // 8) 示範資料清除：清專案前剛好有人在示範專案發了真訊息 → 保留專案（識別碼也留著）
  {
    const demo = ok(await call(boss.token, '/api/admin/demo', 'POST'), '載入示範資料');
    const { r1 } = await interleave(/^DELETE FROM projects WHERE id = \?/, () => call(boss.token, '/api/admin/demo', 'DELETE'),
      () => call(boss.token, '/api/messages', 'POST', { requestId: 'real-1', project: demo.projectId, text: '剛發的真訊息' }));
    const out = ok(r1, '清除示範資料');
    assert.equal(out.keptProject, true, '有真訊息：保留專案');
    assert.ok(await row(demo.projectId), '專案還在');
    assert.equal(await n('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?', 'pcode:' + demo.projectId), 1, '代號還在');
    console.log('✓ 示範資料清除：交易內確認示範專案沒有別人的資料才刪專案');
  }
  // 9) 釋出識別碼的寫入（刪除、永久清除、示範資料清除）第一句是工作區列鎖
  {
    const LOCK = /^UPDATE workspaces SET name = name WHERE id = \?$/;
    const firstOf = async (re, fn) => {
      let first = null;
      const orig = appDb.batch;
      appDb.batch = async stmts => { if (stmts.some(([sql]) => re.test(sql))) first = first || stmts[0][0]; return orig(stmts); };
      try { ok(await fn(), String(re)); } finally { appDb.batch = orig; }
      assert.ok(first, `有送出含 ${re} 的批次`);
      assert.match(first.trim(), LOCK, `${re} 那批的第一句要是工作區列鎖`);
    };
    const id = await create('丁案');
    ok(await archive(id), '封存丁案');
    await firstOf(/^UPDATE projects SET deleted_at = \?/, () => del(id, '丁案'));
    ok(await call(boss.token, `/api/projects/${id}/restore`, 'POST'), '復原丁案');
    ok(await call(boss.token, '/api/recovery-window', 'PUT', { days: 0 }), '可復原期 0 天（刪除當下就永久清除）');
    await firstOf(/^DELETE FROM projects WHERE id = \?/, () => del(id, '丁案'));
    assert.equal(await row(id), undefined, '已永久清除');
    ok(await call(boss.token, '/api/recovery-window', 'PUT', { days: null }), '可復原期跟平台預設');
    ok(await call(boss.token, '/api/admin/demo', 'POST'), '再載入示範資料');
    await firstOf(/^DELETE FROM projects WHERE id = \?/, () => call(boss.token, '/api/admin/demo', 'DELETE'));
    console.log('✓ 刪除、永久清除、示範資料清除：第一句都是工作區列鎖');
  }
  // 11) 改網址英文名時要先存下現在顯示的代號（代號還沒存的專案）：那個代號已經是別的專案的舊代號 → 409 IDENTITY_CONFLICT，什麼都不寫
  {
    const id = ok(await call(boss.token, '/api/projects', 'POST', { name: '己案', slug: 'alpha-x' }), '建立己案').id;
    const shown = (await db.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + id)).value;
    await db.run('DELETE FROM app_settings WHERE key = ?', 'pcode:' + id); // 代號沒存：照網址英文名推導（一樣是 shown）
    await db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', 'pcodeold:' + shown, '預設專案'); // 別的專案的舊代號
    is(await call(boss.token, `/api/projects/${id}/slug`, 'PUT', { slug: 'beta-x' }), 409, 'IDENTITY_CONFLICT', '存下的代號會跟別的專案衝突');
    assert.equal((await db.get('SELECT value FROM app_settings WHERE key = ?', 'slug:' + id)).value, 'alpha-x', '網址英文名沒改');
    assert.equal(await n('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?', 'pcode:' + id), 0, '沒有存下衝突的代號');
    await db.run('DELETE FROM app_settings WHERE key = ?', 'pcodeold:' + shown);
    ok(await call(boss.token, `/api/projects/${id}/slug`, 'PUT', { slug: 'beta-x' }), '沒有衝突就能改');
    assert.equal((await db.get('SELECT value FROM app_settings WHERE key = ?', 'pcode:' + id)).value, shown, '代號照舊（存下來了）');
    console.log('✓ 改網址英文名：要存下的代號先在交易內確認沒被用掉');
  }
  // 10) 同時封存最後兩個未封存的專案：後寫入的 409 LAST_PROJECT，至少留一個
  {
    const active = (await db.all('SELECT id FROM projects WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at, id')).map(r => r.id);
    for (const id of active.slice(2)) ok(await archive(id), `封存 ${id}`);
    const [x, y] = active;
    const { r1, r2 } = await interleave(/^UPDATE projects SET archived = 1/, () => archive(x), () => archive(y));
    ok(r2, '中間封存另一個');
    is(r1, 409, 'LAST_PROJECT', '寫入前剩下它是唯一未封存的');
    assert.equal(await n('SELECT COUNT(*) AS n FROM projects WHERE archived = 0 AND deleted_at IS NULL'), 1, '留一個未封存的專案');
    console.log('✓ 同時封存最後兩個專案：至少留一個');
  }

  console.log('workspace-write-guards-test：全部通過');
} catch (e) {
  console.error('workspace-write-guards-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
