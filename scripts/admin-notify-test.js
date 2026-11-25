// 驗收測試：管理員異動通知（帳號提醒；詞彙見 GLOSSARY「成員與權限」）
// 1. 任免平台管理員：所有平台管理員收到通知，包括被降級的人；操作者本人不收
// 2. 停用或恢復帳號：所有平台管理員收到通知；操作者本人不收
// 3. 任免工作區管理員：該工作區所有工作區管理員收到通知，包括被降級的人；操作者本人不收
// 4. 通知寫明誰（操作者）、對誰（對象）、做了什麼（kind）、什麼時候（createdAt）
// 5. 沒有真的改到東西（已經是管理員、已經停用）不通知；一般成員收不到這些通知
// 收件人一律從帳號提醒的讀取端點（GET /api/me/notices）看；只看 admin_ 開頭的（帳號密碼登入另外會留 password_login）
// SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。用法：node scripts/admin-notify-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { dbStorage } from '../src/storage-db.js';
import { openTestDb } from './test-db.js';
import { adminSession } from './test-admin.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-adminnotify-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', joinLimitPerHour: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
const setPlat = (tok, id, role) => call(tok, `/api/participants/${id}/platform-role`, 'PUT', { role });
const setWs = (tok, id, role) => call(tok, `/api/participants/${id}/workspace-role`, 'PUT', { role });
const ok = (r, what) => assert.equal(r.status, 200, `${what}：${r.status} ${JSON.stringify(r.body)}`);

// 這個人新收到的管理員異動通知（讀完標成已讀，下一步只看新的）
async function fresh(person) {
  const r = await call(person.token, '/api/me/notices');
  assert.equal(r.status, 200, `${person.name} 讀帳號提醒：${r.status} ${JSON.stringify(r.body)}`);
  const items = r.body.items.filter(n => /^admin_/.test(n.kind));
  if (items.length) ok(await call(person.token, '/api/me/notices/read', 'POST', { ids: items.map(n => n.id) }), `${person.name} 標成已讀`);
  return items;
}
// 一步操作之後：每個人收到的通知 kind（沒收到＝空陣列）
async function inbox(people) {
  const out = {};
  for (const p of people) out[p.name] = (await fresh(p)).map(n => n.kind);
  return out;
}

try {
  const t0 = Date.now();
  const wangJ = await join('王小美', 'PO'); // 第一位＝平台管理員＋工作區管理員
  const lin = await join('林志明', 'PG'), zhao = await join('趙敏', 'QA'), liu = await join('劉備', 'SM'), chen = await join('陳昭宇', 'PG'), qian = await join('錢多多', 'PG');
  const P = { wang: { ...wangJ, name: '王小美' }, lin: { ...lin, name: '林志明' }, zhao: { ...zhao, name: '趙敏' }, liu: { ...liu, name: '劉備' }, chen: { ...chen, name: '陳昭宇' } };
  const id = k => P[k].participant.participantId;
  const everyone = Object.values(P);
  const boss = await adminSession(call, wangJ.token); // 管理端點都用裝置登入、剛再驗證過的 Token
  await inbox(everyone); // 先清掉之前的

  // ---------- 1 任免平台管理員 ----------
  ok(await setPlat(boss.token, id('lin'), 'admin'), '王小美把林志明升為平台管理員');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: ['admin_platform_grant'], 趙敏: [], 劉備: [], 陳昭宇: [] },
    '1 升平台管理員：被升的人收到（他現在是平台管理員）；操作者、非平台管理員都不收');
  ok(await setPlat(boss.token, id('zhao'), 'admin'), '王小美把趙敏升為平台管理員');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: ['admin_platform_grant'], 趙敏: ['admin_platform_grant'], 劉備: [], 陳昭宇: [] },
    '1 升平台管理員：其他平台管理員都收到');

  const linS = await adminSession(call, P.lin.token);
  const before = Date.now();
  ok(await setPlat(linS.token, id('zhao'), 'none'), '林志明把趙敏降為一般帳號');
  const after = Date.now();
  const wangGot = await fresh(P.wang), zhaoGot = await fresh(P.zhao);
  assert.deepEqual([wangGot.map(n => n.kind), zhaoGot.map(n => n.kind), (await fresh(P.lin)).map(n => n.kind)], [['admin_platform_revoke'], ['admin_platform_revoke'], []],
    '1 降平台管理員：其他平台管理員、被降級的人都收到；操作者不收');
  // ---------- 4 內容：誰、對誰、做了什麼、什麼時候 ----------
  for (const n of [...wangGot, ...zhaoGot]) {
    assert.deepEqual(JSON.parse(n.detail), { a: '林志明', t: '趙敏' }, '4 寫明誰（操作者）對誰（對象）：' + n.detail);
    const at = Date.parse(n.createdAt);
    assert.ok(at >= before - 1000 && at <= after + 1000, '4 createdAt 是操作的時間：' + n.createdAt);
  }
  assert.ok(Date.parse(wangGot[0].createdAt) >= t0 - 1000, '4 時間不早於測試開始');

  // ---------- 5 沒改到東西不通知 ----------
  ok(await setPlat(boss.token, id('lin'), 'admin'), '已經是平台管理員再升一次');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: [] }, '5 沒變就不通知');

  // ---------- 2 停用、恢復帳號 ----------
  const QIAN = qian.participant.participantId;
  ok(await call(boss.token, `/api/participants/${QIAN}/disable`, 'POST'), '王小美停用錢多多');
  let got = await fresh(P.lin);
  assert.deepEqual(got.map(n => n.kind), ['admin_account_disable'], '2 停用帳號：其他平台管理員收到');
  assert.deepEqual(JSON.parse(got[0].detail), { a: '王小美', t: '錢多多' }, '4 停用通知寫明誰對誰');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: [] }, '2 停用帳號：操作者、已經不是平台管理員的人、一般成員都不收');
  ok(await call(boss.token, `/api/participants/${QIAN}/disable`, 'POST'), '已經停用再停用一次');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: [] }, '5 已經停用再停用不通知');
  ok(await call(linS.token, `/api/participants/${QIAN}/enable`, 'POST'), '林志明恢復錢多多');
  got = await fresh(P.wang);
  assert.deepEqual(got.map(n => n.kind), ['admin_account_enable'], '2 恢復帳號：其他平台管理員收到');
  assert.deepEqual(JSON.parse(got[0].detail), { a: '林志明', t: '錢多多' }, '4 恢復通知寫明誰對誰');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: [] }, '2 恢復帳號：操作者不收');

  // ---------- 3 任免工作區管理員 ----------
  ok(await setWs(boss.token, id('liu'), 'admin'), '王小美把劉備升為工作區管理員');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: ['admin_workspace_grant'], 陳昭宇: [] },
    '3 升工作區管理員：被升的人收到；操作者、只是平台管理員（不是工作區管理員）、一般成員都不收');
  const liuS = await adminSession(call, P.liu.token);
  ok(await setWs(liuS.token, id('chen'), 'admin'), '劉備把陳昭宇升為工作區管理員');
  assert.deepEqual(await inbox(everyone), { 王小美: ['admin_workspace_grant'], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: ['admin_workspace_grant'] },
    '3 升工作區管理員：其他工作區管理員都收到，操作者不收');
  ok(await setWs(boss.token, id('liu'), 'member'), '王小美把劉備降為成員');
  got = await fresh(P.liu);
  assert.deepEqual(got.map(n => n.kind), ['admin_workspace_revoke'], '3 降工作區管理員：被降級的人收到');
  assert.deepEqual(JSON.parse(got[0].detail), { a: '王小美', t: '劉備' }, '4 降級通知寫明誰對誰');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: ['admin_workspace_revoke'] },
    '3 降工作區管理員：其他工作區管理員收到，操作者不收');
  ok(await setWs(boss.token, id('chen'), 'admin'), '已經是工作區管理員再升一次');
  assert.deepEqual(await inbox(everyone), { 王小美: [], 林志明: [], 趙敏: [], 劉備: [], 陳昭宇: [] }, '5 沒變就不通知');

  console.log('admin-notify-test：全部通過（任免平台管理員、停用與恢復帳號通知所有平台管理員；任免工作區管理員通知工作區管理員；包含被降級的人、不含操作者；寫明誰對誰、什麼時候；沒改到不通知）');
} catch (err) {
  console.error('admin-notify-test 失敗：', err.stack || err.message);
  process.exitCode = 1;
} finally {
  try { await db.close?.(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
