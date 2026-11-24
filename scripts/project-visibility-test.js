// 驗收測試：專案可見度（開放／審核／私人；詞彙見 GLOSSARY「成員與權限」）
// 開放：工作區成員直接加入；審核：送加入申請、專案管理員核准；私人：只有專案成員與有隱含權限的人看得到，
// 其他人在專案清單、卡片代號、搜尋、訊息、MCP 工具都查不到它的存在。只有專案管理員（含隱含）能改可見度。
// 升級：舊站打開後所有專案都是審核、加入申請照常。SQLite 與 Postgres（設了 AIGILE_TEST_PG_URL）都跑。
// 用法：node scripts/project-visibility-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { addToProject, setProjectRole, listProjectMembers } from './test-members.js';
import { testToken } from './test-token.js';
import { toPrePhase1 } from './legacy-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pvis-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body.error?.code;
const A = '預設專案', B = '第二專案';
const setVisibility = (tok, pj, visibility) => call(tok, `/api/projects/${pj}/visibility`, 'PUT', { visibility });
const visibilityOf = async (tok, pj) => (await call(tok, '/api/projects')).body.items.find(p => p.id === pj)?.visibility;

try {
  const join = async (name, role = 'PG') => { const b = (await call(null, '/api/join', 'POST', { name, role })).body; return { token: b.token, id: b.participant.participantId, name }; };
  const boss = await join('林志明', 'PO'); // 第一位＝工作區管理員（在所有專案）
  const wang = await join('王小明');
  const chen = await join('陳昭宇');
  await call(boss.token, `/api/participants/${wang.id}/projects`, 'PUT', { projects: [A] });
  await call(boss.token, `/api/participants/${chen.id}/projects`, 'PUT', { projects: [A] });
  assert.equal((await setProjectRole(call, boss.token, A, wang.id, 'admin')).status, 200);
  const wangAi = (await call(wang.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '王的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;

  // 1) 既有專案、新專案都是「審核」；只有專案管理員（含工作區管理員的隱含權限）能改可見度
  assert.equal(await visibilityOf(boss.token, A), 'review', '既有專案是審核');
  const np = await call(boss.token, '/api/projects', 'POST', { name: '新專案' });
  assert.equal(np.status, 201, JSON.stringify(np.body));
  const N = np.body.id;
  assert.equal(await visibilityOf(boss.token, N), 'review', '新專案預設審核');
  let r = await setVisibility(wang.token, A, 'open');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await visibilityOf(wang.token, A), 'open', '專案管理員改成開放');
  r = await setVisibility(chen.token, A, 'private');
  assert.equal(r.status, 403, '專案成員不能改可見度');
  assert.equal(code(r), 'NOT_ADMIN');
  r = await setVisibility(wangAi.token, A, 'private');
  assert.equal(r.status, 403, 'AI 不能改可見度');
  assert.equal(code(await setVisibility(wang.token, A, 'secret')), 'INVALID_REQUEST', '只有三種可見度');
  r = await setVisibility(boss.token, A, 'review');
  assert.equal(r.status, 200, '工作區管理員也能改');
  assert.equal(await visibilityOf(boss.token, A), 'review');
  const log = (await call(boss.token, `/api/projects/${A}/events`)).body.items.map(e => e.text).join('\n');
  assert.match(log, /王小明 把專案可見度改成開放/, '異動紀錄寫誰改了可見度');
  console.log('✓ 預設審核；只有專案管理員能改可見度');

  // 2) 開放：工作區成員在專案清單看得到、直接加入成為專案成員
  const lin = await join('林美玲'); // 還沒有任何專案
  assert.equal((await setVisibility(boss.token, N, 'open')).status, 200);
  const joinable = async tok => (await call(tok, '/api/join/projects')).body.items;
  let it = (await joinable(lin.token)).find(p => p.id === N);
  assert.equal(it?.visibility, 'open', '開放專案列在可以加入的清單');
  r = await call(lin.token, `/api/projects/${N}/join`, 'POST');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.role, 'member');
  assert.ok((await call(lin.token, '/api/me')).body.projects.includes(N), '直接加入就是專案成員');
  assert.equal((await listProjectMembers(call, lin.token, N)).body.members.find(m => m.participantId === lin.id)?.role, 'member');
  assert.equal(code(await call(lin.token, `/api/projects/${N}/join`, 'POST')), 'ALREADY_MEMBER', '已經在專案裡');
  assert.ok(!(await joinable(lin.token)).some(p => p.id === N), '加入後不再列出');
  assert.equal((await call(wangAi.token, `/api/projects/${N}/join`, 'POST')).status, 403, 'AI 不能自己加入專案');
  assert.match((await call(boss.token, `/api/projects/${N}/events`)).body.items.map(e => e.text).join('\n'), /林美玲 加入專案/, '異動紀錄寫誰加入');
  console.log('✓ 開放專案可直接加入');

  // 3) 審核：看得到，直接加入被拒；送申請、專案管理員核准後才加入
  it = (await joinable(lin.token)).find(p => p.id === B);
  assert.equal(it?.visibility, 'review', '審核專案也列出');
  assert.equal(it.members, 0, '人數不算工作區管理員的隱含權限');
  r = await call(lin.token, `/api/projects/${B}/join`, 'POST');
  assert.equal(r.status, 403, '審核專案不能直接加入');
  assert.equal(code(r), 'JOIN_NEEDS_APPROVAL');
  assert.ok(!(await call(lin.token, '/api/me')).body.projects.includes(B));
  r = await call(lin.token, `/api/projects/${B}/join-requests`, 'POST', { note: '想幫忙' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call(boss.token, `/api/join-requests/${r.body.id}/approve`, 'POST', {})).status, 200);
  assert.ok((await call(lin.token, '/api/me')).body.projects.includes(B), '核准後加入');
  r = await call(chen.token, `/api/projects/${N}/join-requests`, 'POST', {});
  assert.equal(code(r), 'JOIN_DIRECTLY', '開放專案不用申請，直接加入');
  console.log('✓ 審核專案直接加入被拒、申請核准後加入');

  // 4) 私人：王小明自己建的專案（工作區管理員不是成員，靠隱含權限），非成員在各處都查不到它
  r = await call(wang.token, '/api/projects', 'POST', { name: '機密專案', code: 'SECR' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const P = r.body.id;
  assert.equal((await setVisibility(wang.token, P, 'private')).status, 200);
  const pc = await call(wang.token, '/api/cards', 'POST', { requestId: 'pv1', project: P, title: '機密卡片XYZ' });
  assert.equal(pc.status, 201, JSON.stringify(pc.body));
  const key = pc.body.key || pc.body.id;
  assert.match(key, /^SECR-1$/, `卡片代號 ${key}`);
  r = await call(wang.token, '/api/messages', 'POST', { requestId: 'pm1', project: P, text: '機密訊息XYZ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // 專案清單
  assert.ok(!(await call(chen.token, '/api/projects')).body.items.some(p => p.id === P), '私人專案不在非成員的專案清單');
  const lists = (await call(chen.token, '/api/projects')).body;
  for (const k of ['projectAdmins', 'archivedProjectAdmins', 'viewers', 'leaders', 'archivedLeaders', 'readOnly', 'join']) assert.ok(!(P in (lists[k] || {})), `${k} 不列私人專案`);
  assert.ok(!(await joinable(chen.token)).some(p => p.id === P), '私人專案不在可以加入的清單');
  assert.ok((await call(wang.token, '/api/projects')).body.items.some(p => p.id === P && p.visibility === 'private'), '成員看得到');
  // 跟「沒有這個專案」分不出來：同樣的狀態碼與錯誤（訊息裡的專案代號換掉再比）
  const same = async (label, req) => {
    const a = await req(P), b = await req('沒有這專案');
    const norm = x => JSON.stringify({ s: x.status, e: x.body.error }).split(P).join('#').split('沒有這專案').join('#');
    assert.equal(norm(a), norm(b), `${label}：私人專案跟不存在的專案一樣`);
    assert.ok(!JSON.stringify(a.body).includes('機密') && !JSON.stringify(a.body).includes(P), `${label}：不提到私人專案`);
    return a;
  };
  assert.equal((await same('直接加入', pj => call(chen.token, `/api/projects/${pj}/join`, 'POST'))).status, 404);
  assert.equal((await same('送申請', pj => call(chen.token, `/api/projects/${pj}/join-requests`, 'POST', {}))).status, 404);
  assert.equal((await same('專案成員清單', pj => listProjectMembers(call, chen.token, pj))).status, 404);
  await same('看板狀態', pj => call(chen.token, `/api/projects/${pj}/statuses`));
  await same('加入設定', pj => call(chen.token, `/api/projects/${pj}/join-settings`, 'PUT', { open: true }));
  await same('卡片篩專案', pj => call(chen.token, `/api/cards?project=${pj}`));
  await same('建卡', pj => call(chen.token, '/api/cards', 'POST', { requestId: 'x' + pj, project: pj, title: '試' }));
  await same('發訊息', pj => call(chen.token, '/api/messages', 'POST', { requestId: 'm' + pj, project: pj, text: '試' }));
  // 檔案、文件、知識庫、技能：帶專案的路由一律跟「沒有這個專案」一樣（404）
  const upload = (pj, extra = '') => app(new Request('http://localhost' + encodeURI(`/api/files?name=a.txt&declared=true&project=${pj}${extra}`), { method: 'POST', headers: { Authorization: `Bearer ${chen.token}`, 'Content-Type': 'application/octet-stream' }, body: '你好' }), 'http://localhost')
    .then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
  // AI 用的上傳照舊（跟改版前一樣）：沒有這個專案＝發文時 400；只存檔（post=false）照樣成功。看不到的私人專案跟它一模一樣
  const up = await same('上傳檔案', pj => upload(pj));
  assert.deepEqual([up.status, up.body.error?.code], [400, 'INVALID_REQUEST'], '沒有這個專案：400（跟改版前一樣）：' + JSON.stringify(up.body));
  assert.equal((await same('上傳檔案（不發文）', pj => upload(pj, '&post=false'))).status, 201, '只存檔照樣成功（跟改版前一樣）');
  const probes = [
    ['GET', '/docs'], ['POST', '/docs?name=a.txt&declared=true'], ['GET', '/docs/d_x'], ['PATCH', '/docs/d_x', { name: 'b.txt' }], ['DELETE', '/docs/d_x'],
    ['POST', '/doc-folders', { name: '資料夾' }], ['PATCH', '/doc-folders/f_x', { name: '資料夾' }], ['DELETE', '/doc-folders/f_x'],
    ['GET', '/kb/search?q=' + encodeURIComponent('機密')], ['GET', '/docs/d_x/text'], ['POST', '/kb/reindex'], ['POST', '/kb/docs', { docIds: ['d_x'] }],
    ['GET', '/kb/settings'], ['PUT', '/kb/settings', { aiId: null }], ['POST', '/kb/organize'], ['GET', '/kb/pages'], ['GET', '/kb/pages/index'], ['POST', '/kb/pages', { title: 'x', body: 'x' }],
    ['PATCH', '/kb/pages/k_x', { body: 'x' }], ['POST', '/kb/pages/k_x/return', { reason: 'x' }], ['POST', '/kb/pages/k_x/refresh'], ['DELETE', '/kb/pages/k_x'],
    ['GET', '/skills'], ['POST', '/skills', { files: [] }], ['POST', '/skills/x/remove'], ['PUT', '/skills/x/target', { roles: [] }],
  ];
  for (const [m, sub, body] of probes) assert.equal((await same(`${m} /api/projects/:id${sub}`, pj => call(chen.token, `/api/projects/${pj}${sub}`, m, body))).status, 404, `${m} ${sub} 回 404`);
  // 卡片代號
  const k404 = async (label, path) => { const a = await call(chen.token, path(key)), b = await call(chen.token, path('SECR-999'));
    assert.equal(JSON.stringify({ s: a.status, e: a.body.error }).replace(key, '#'), JSON.stringify({ s: b.status, e: b.body.error }).replace('SECR-999', '#'), `${label}：私人專案的卡跟沒有這張卡一樣`); return a; };
  assert.equal((await k404('卡片代號查詢', k => `/api/cards/${k}`)).status, 404);
  assert.equal((await k404('用 C-xxx 查', () => `/api/cards/C-${pc.body.seq + 100}`)).status, 404, 'C-xxx 也找不到');
  assert.equal((await call(chen.token, '/api/messages', 'POST', { requestId: 'mk', text: '掛卡', cardId: key })).status, 404, '發文掛私人專案的卡：找不到');
  // 搜尋、訊息
  let s = (await call(chen.token, '/api/search?q=' + encodeURIComponent('機密'))).body;
  assert.equal(s.cards.length + s.messages.length, 0, '搜尋找不到私人專案的卡與訊息');
  s = (await call(chen.token, '/api/search?q=' + key)).body;
  assert.equal(s.cards.length, 0, '用卡片代號搜尋也找不到');
  assert.ok(!JSON.stringify((await call(chen.token, '/api/messages?limit=200')).body).includes('機密'), '訊息列表沒有私人專案的訊息');
  r = await call(chen.token, '/api/messages', 'POST', { requestId: 'mh', project: A, text: '【機密專案】試試' });
  assert.ok(!JSON.stringify(r.body).includes(P), '開頭寫私人專案名稱不會揭露專案代號');
  // MCP 工具（AI 用自己的 Token）：卡片代號、篩專案、搜尋、發文都跟「沒有」一樣
  const chenAi = (await call(chen.token, '/api/my-ais', 'POST', { projects: [A], roleKey: 'PG', role: '程式開發', name: '陳的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  let rid = 0;
  const tool = async (name, args) => {
    const t = await call(chenAi.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(t.status, 200, `${name} HTTP ${t.status}`);
    return t.body.result;
  };
  const toolSame = async (label, name, args, hidden, missing) => {
    const a = await tool(name, args(hidden)), b = await tool(name, args(missing));
    assert.equal(a.content[0].text.split(hidden).join('#'), b.content[0].text.split(missing).join('#'), `MCP ${label}：私人專案跟不存在的一樣`);
    assert.ok(!a.content[0].text.includes('機密') && !a.content[0].text.includes(P), `MCP ${label}：不提到私人專案`);
    return a;
  };
  assert.ok((await toolSame('aigile_card_get', 'aigile_card_get', k => ({ cardId: k }), key, 'SECR-999')).isError, 'MCP 讀不到私人專案的卡');
  assert.ok((await toolSame('aigile_cards', 'aigile_cards', pj => ({ project: pj, owner: 'any' }), P, '沒有這專案')).isError);
  await toolSame('aigile_post', 'aigile_post', pj => ({ project: pj, text: '[進度] 試', requestId: 'r' + pj }), P, '沒有這專案');
  r = await tool('aigile_cards', { q: '機密', owner: 'any', status: 'all' });
  assert.deepEqual(JSON.parse(r.content[0].text).items, [], 'MCP 搜尋找不到私人專案的卡');
  assert.ok(!(await tool('aigile_team', {})).content[0].text.includes(P), 'MCP 團隊狀態不提到私人專案');
  r = JSON.stringify((await tool('aigile_history', { hours: 24 })).content);
  assert.ok(!r.includes('機密訊息XYZ'), 'MCP 歷史訊息沒有私人專案的訊息');
  // 成員、有隱含權限的人看得到
  assert.equal((await call(wang.token, `/api/cards/${key}`)).status, 200, '成員看得到卡');
  assert.equal((await listProjectMembers(call, boss.token, P)).status, 200, '工作區管理員不是成員也看得到私人專案');
  assert.equal((await setVisibility(boss.token, P, 'private')).status, 200, '工作區管理員能改私人專案的可見度');
  assert.equal((await addToProject(call, boss.token, P, chen.id)).status, 201, '專案管理員把人加進私人專案');
  assert.equal((await call(chen.token, `/api/cards/${key}`)).status, 200, '加入後看得到');
  console.log('✓ 私人專案對非成員不存在；成員與工作區管理員看得到');

  // 4b) 管理專案的路由回傳的專案清單、錯誤訊息也不提到看不到的私人專案（林美玲不在機密專案）
  {
    const leaks = body => JSON.stringify(body).includes(P) || JSON.stringify(body).includes('機密');
    const noLeak = (label, x, status = 200) => { assert.equal(x.status, status, `${label}：${JSON.stringify(x.body)}`); assert.ok(!leaks(x.body), `${label}：回傳不提到私人專案`); };
    r = await call(lin.token, '/api/projects', 'POST', { name: '林的專案' });
    noLeak('建立專案', r, 201);
    const L = r.body.id;
    noLeak('改名', await call(lin.token, `/api/projects/${L}`, 'PATCH', { name: '林的專案二' }));
    noLeak('程式庫', await call(lin.token, `/api/projects/${L}/repo`, 'PUT', { url: 'https://example.com/repo' }));
    noLeak('可見度', await setVisibility(lin.token, L, 'open'));
    noLeak('私訊開關', await call(lin.token, `/api/projects/${L}/dm`, 'PUT', { on: true }));
    noLeak('封存', await call(lin.token, `/api/projects/${L}/archive`, 'POST'));
    noLeak('還原', await call(lin.token, `/api/projects/${L}/unarchive`, 'POST'));
    noLeak('代號撞到私人專案', await call(lin.token, '/api/projects', 'POST', { name: '撞代號', code: 'SECR' }), 409);
    await same('設職稱', pj => call(lin.token, `/api/participants/${lin.id}/project-roles`, 'PUT', { roles: { [pj]: 'PG' } }));
    assert.equal((await same('AI 職務', pj => call(lin.token, `/api/projects/${pj}/roles/PG`, 'PUT', { role: '開發' }))).status, 404);
    // 在所有未封存專案的人：封存的私人專案照樣看不到（不因為「不受隔離」就全看得到）
    r = await call(wang.token, '/api/projects', 'POST', { name: '封存密案' });
    const Q = r.body.id;
    assert.equal((await setVisibility(wang.token, Q, 'private')).status, 200);
    assert.equal((await call(wang.token, '/api/messages', 'POST', { requestId: 'pq1', project: Q, text: '封存密案的訊息QQQ' })).status, 201);
    assert.equal((await call(wang.token, `/api/projects/${Q}/archive`, 'POST')).status, 200);
    const all = await join('全員');
    const active = (await call(boss.token, '/api/projects')).body.items.filter(p => !p.archived).map(p => p.id);
    assert.equal((await call(boss.token, `/api/participants/${all.id}/projects`, 'PUT', { projects: active })).status, 200);
    assert.deepEqual((await call(all.token, '/api/me')).body.projects.sort(), [...active].sort(), '全員在每個未封存專案');
    const seen = (await call(all.token, '/api/projects')).body;
    assert.ok(!JSON.stringify(seen).includes(Q), '封存的私人專案不在專案清單：' + JSON.stringify(seen.items.map(p => p.id)));
    assert.ok(!JSON.stringify((await call(all.token, '/api/messages?limit=200')).body).includes('QQQ'), '封存的私人專案的訊息看不到');
    assert.ok((await call(wang.token, '/api/projects')).body.items.some(p => p.id === Q), '專案管理員看得到自己封存的私人專案');
    console.log('✓ 管理專案的路由、錯誤訊息不提到私人專案；封存的私人專案對在所有專案的人也看不到');
  }

  // 5) 升級：舊站（008 之前，專案沒有可見度）打開後所有專案都是「審核」，加入申請流程照常
  {
    const file = path.join(dataDir, 'old', 'switch.db');
    fs.mkdirSync(path.dirname(file));
    const old = await openTestDb(file);
    await toPrePhase1(old);
    const person = (id, name, at, projects, extra = {}) => old.run('INSERT INTO participants (id, kind, name, role, code, token, created_at, updated_at, projects, is_admin) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, 'human', name, 'PG', id.slice(2, 6).toUpperCase(), 'h:old_' + id, at, at, projects, extra.admin ? 1 : 0);
    await person('p_boss', '舊管理員', '2026-01-01T00:00:00.000Z', `${A},${B}`, { admin: true });
    await person('p_mem', '舊成員', '2026-01-02T00:00:00.000Z', A);
    await old.close();
    const odb = await openTestDb(file);
    const oapp = createApp({ db: odb, storage: dbStorage(odb), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
    const ocall = async (token, p, method = 'GET', body) => {
      const res = await oapp(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const [ob, om] = [await testToken(odb, 'p_boss'), await testToken(odb, 'p_mem')];
    const items = (await ocall(ob, '/api/projects')).body.items;
    assert.ok(items.length >= 2 && items.every(p => p.visibility === 'review'), `升級後所有專案都是審核：${JSON.stringify(items.map(p => [p.id, p.visibility]))}`);
    assert.equal((await ocall(om, '/api/join/projects')).body.items.find(p => p.id === B)?.visibility, 'review', '舊成員看得到可以申請的專案');
    assert.equal(code(await ocall(om, `/api/projects/${B}/join`, 'POST')), 'JOIN_NEEDS_APPROVAL', '升級後不能直接加入');
    const req = await ocall(om, `/api/projects/${B}/join-requests`, 'POST', { note: '升級後申請' });
    assert.equal(req.status, 200, JSON.stringify(req.body));
    assert.equal((await ocall(ob, `/api/join-requests/${req.body.id}/approve`, 'POST', {})).status, 200);
    assert.ok((await ocall(om, '/api/me')).body.projects.includes(B), '升級後申請核准照常加入');
    await odb.close?.();
    console.log('✓ 升級後所有專案是審核，加入申請照常');
  }

  console.log('project-visibility-test：全部通過');
} catch (e) {
  console.error('project-visibility-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
