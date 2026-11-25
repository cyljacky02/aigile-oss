// 救援腳本以平台管理員為對象：只有一位時直接用；多位時要用 --name 指定，沒指定就列出名單結束；
// 平台管理員換過人以後也救得到；救援登入端只放行平台管理員。
// 用法：node scripts/admin-rescue-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { adminSession, reauth } from './test-admin.js';
import { dbStorage } from '../src/storage-db.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin-rescue.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rescue-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const mk = () => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const app = mk(), other = mk(); // other＝同一個資料庫的另一個執行個體（例如另一個 Cloudflare isolate）
const call = async (token, p, method = 'GET', body, inst = app) => {
  const r = await inst(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 跑救援腳本（本機版，跟伺服器同一個資料夾；有設 AIGILE_TEST_PG_URL 時腳本照同一組設定連 Postgres）
const rescue = (...extra) => {
  const out = spawnSync(process.execPath, [SCRIPT, '--local', dataDir, '--base', 'http://localhost', ...extra], { encoding: 'utf8' });
  const m = out.stdout.match(/\/rescue\/(\S+)/);
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, token: m?.[1] };
};
const useLink = token => call(null, '/api/auth/rescue', 'POST', { token });
const setPlatform = (token, id, role) => call(token, `/api/participants/${id}/platform-role`, 'PUT', { role });

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位：平台管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  assert.equal((await call(null, '/api/join', 'POST', { name: '王小明', role: 'QA' })).status, 201); // 一般帳號
  const B = boss.participant.participantId, C = chen.participant.participantId;
  let bossTok = boss.token;

  // 1. 只有一位平台管理員：直接用他，不用給名字
  let out = rescue();
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.ok(out.token, '有救援連結：' + out.stdout);
  assert.match(out.stdout, /林志明/, '說救的是誰');
  let r = await useLink(out.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.participant.name, '林志明', '一位平台管理員：救的是他');
  bossTok = r.body.token;
  bossTok = (await adminSession(call, bossTok)).token; // 救援登入的帳號沒有密碼：設好密碼、再驗證，才能任免平台管理員
  console.log('✓ 一位平台管理員');

  // 2. 平台管理員換人：先升陳昭宇，林志明再降自己。最早建立的人（林志明）已不是平台管理員，救援仍要給到陳昭宇
  assert.equal((await setPlatform(bossTok, C, 'admin')).status, 200, '升陳昭宇');
  assert.equal((await setPlatform(bossTok, B, 'none')).status, 200, '林志明降自己');
  out = rescue();
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.ok(out.token, '有救援連結：' + out.stdout);
  assert.match(out.stdout, /陳昭宇/, '說救的是誰');
  r = await useLink(out.token);
  assert.equal(r.status, 200, '換人後救援連結可以登入：' + JSON.stringify(r.body));
  assert.equal(r.body.participant.name, '陳昭宇', '換人後救的是現在的平台管理員');
  let chenTok = r.body.token;
  chenTok = (await adminSession(call, chenTok)).token;
  console.log('✓ 平台管理員換人後');

  // 3. 多位平台管理員：沒指定名字就列出名單結束、不產生連結；用 --name 指定就救那位
  assert.equal((await setPlatform(chenTok, B, 'admin')).status, 200, '林志明再升回來');
  out = rescue();
  assert.notEqual(out.status, 0, '多位沒指定：結束且不算成功');
  assert.equal(out.token, undefined, '多位沒指定：不產生連結：' + out.stdout);
  const said = out.stdout + out.stderr;
  assert.match(said, /林志明/, '列出平台管理員：林志明');
  assert.match(said, /陳昭宇/, '列出平台管理員：陳昭宇');
  assert.doesNotMatch(said, /王小明/, '不是平台管理員的不列');
  assert.match(said, /--name/, '說怎麼指定');
  for (const name of ['林志明', '陳昭宇']) {
    out = rescue('--name', name);
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.ok(out.token, '指定名字有救援連結：' + out.stdout);
    r = await useLink(out.token);
    assert.equal(r.status, 200, `指定 ${name} 可以登入：` + JSON.stringify(r.body));
    assert.equal(r.body.participant.name, name, '救的是指定的人');
    if (name === '林志明') bossTok = r.body.token; else chenTok = r.body.token;
  }
  for (const token of [bossTok, chenTok]) await reauth(call, { token, password: 'pass-word-1' }); // 救援登入後也要再驗證才能任免平台管理員
  console.log('✓ 多位平台管理員');

  // 4. 非平台管理員拿不到救援連結：指定一般帳號，腳本不產生連結；
  //    已經產生的連結，對象在使用前被降為一般帳號，登入端拒絕
  out = rescue('--name', '王小明');
  assert.notEqual(out.status, 0, '指定一般帳號：結束且不算成功');
  assert.equal(out.token, undefined, '指定一般帳號：不產生連結：' + out.stdout);
  assert.match(out.stdout + out.stderr, /平台管理員/, '說明只救平台管理員');
  out = rescue('--name', '陳昭宇');
  assert.ok(out.token, out.stderr + out.stdout);
  assert.equal((await setPlatform(bossTok, B, 'admin')).status, 200, '登入端剛載入過平台管理員名單（同角色，不變）');
  // 在另一個執行個體降級：登入端不能用快取裡舊的平台管理員名單放行
  assert.equal((await call(bossTok, `/api/participants/${C}/platform-role`, 'PUT', { role: 'none' }, other)).status, 200, '陳昭宇降為一般帳號');
  r = await useLink(out.token);
  assert.equal(r.status, 400, '非平台管理員的救援連結被拒：' + JSON.stringify(r.body));
  assert.equal(r.body.error?.code, 'RESCUE_INVALID');
  assert.equal((await call(chenTok, '/api/me')).status, 200, '被拒的救援不會登出他其他裝置');
  console.log('✓ 非平台管理員的救援被拒');

  console.log('admin-rescue-test：全部通過');
} catch (e) {
  console.error('admin-rescue-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
