// 畫面測試：工作區管理員在「管理員設定 › 邀請」發邀請時，每個勾的專案選專案角色（專案成員／唯讀成員／專案管理員）與職稱；
// 邀請清單寫出專案角色；被邀請的人打開連結看得到要加入的專案與專案角色；登入頁的欄位叫「房間碼」
// 本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/workspace-invite-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('workspace-invite-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('wsinvui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 平台管理員兼工作區管理員
  const { js, login, goto, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const q = s => JSON.stringify(s);
  await size(1280, 860);

  // 發邀請：預設專案＝唯讀成員、第二專案＝專案管理員
  await login(boss.token, '/admin/invites');
  await until(() => js("!!document.querySelector('[data-pm-invite]')"), 10000, '邀請頁');
  await click('[data-pm-invite]');
  await until(() => js("!!document.querySelector('#inv-new')"), 8000, '邀請視窗');
  assert.ok(await js(`document.querySelector('[data-inv-prole=${q('預設專案')}]').disabled`), '沒勾專案時不能選專案角色');
  assert.deepEqual(await js(`[...document.querySelector('[data-inv-prole=${q('預設專案')}]').options].map(o => o.textContent)`), ['專案管理員', '專案成員', '唯讀成員'], '三種專案角色');
  await js(`(() => {
    const f = document.querySelector('#inv-new');
    f.querySelector('input[name="name"]').value = '李新人';
    for (const [pj, role] of [['預設專案', 'viewer'], ['第二專案', 'admin']]) {
      const cb = f.querySelector('input[name="projects"][value="' + pj + '"]'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const s = f.querySelector('[data-inv-prole="' + pj + '"]'); s.value = role; s.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
  assert.equal(await js(`document.querySelector('[data-inv-prole=${q('預設專案')}]').disabled`), false, '勾了專案就能選專案角色');
  await js("document.querySelector('#inv-new').requestSubmit()");
  const inv = await until(async () => (await kit.call(boss.token, '/api/invites?status=pending')).body.items?.find(i => i.name === '李新人'), 8000, '邀請建好');
  assert.deepEqual(inv.presets.map(x => [x.project, x.role]), [['預設專案', 'viewer'], ['第二專案', 'admin']], '送出的預設專案角色');
  await click('[data-close]');
  await until(() => js("/李新人/.test(document.querySelector('.pm-itable')?.textContent || '')"), 8000, '邀請清單有這筆');
  const row = await js("[...document.querySelectorAll('.pm-irow')].find(r => r.textContent.includes('李新人')).querySelector('.c-proj').textContent");
  assert.match(row, /預設專案 · 唯讀成員/, '清單寫出專案角色：' + row);
  assert.match(row, /第二專案 · 專案管理員/, '清單寫出專案角色：' + row);

  // 被邀請的人打開連結：看得到專案與專案角色
  const out = (await kit.call(boss.token, '/api/invites', 'POST', { name: '王小明', projects: [{ project: '預設專案', role: 'admin' }] })).body;
  await js("localStorage.clear()");
  await goto(out.url.replace(/^https?:\/\/[^/]+/, kit.BASE), '邀請連結');
  await until(() => js("!!document.querySelector('#inv-form')"), 10000, '被邀請的畫面');
  assert.match(await js("document.querySelector('.inv-meta').textContent"), /預設專案（專案管理員）/, '寫出要加入的專案與專案角色');

  // 已移出的人被邀請回來：連結頁要先用原本的帳號登入（不是設新的帳號密碼），登入後回到工作區
  const old = (await kit.call(null, '/api/join', 'POST', { name: '趙前同事', role: 'PG' })).body;
  assert.equal((await kit.call(boss.token, `/api/participants/${old.participant.participantId}/remove`, 'POST')).status, 200);
  const back = (await kit.call(boss.token, '/api/invites', 'POST', { name: '趙前同事' })).body;
  await js("localStorage.clear()");
  await goto(back.url.replace(/^https?:\/\/[^/]+/, kit.BASE), '重新加入的連結');
  await until(() => js("!!document.querySelector('#inv-form .inv-login')"), 10000, '要先用原本的帳號登入');
  assert.ok(await js("!document.querySelector('#inv-form [name=passwordAgain]')"), '不是設新的帳號密碼');
  await js("document.querySelector('#inv-form').requestSubmit(), true");
  await until(() => js("/帳號密碼，或貼上登入碼/.test(document.querySelector('#inv-error').textContent)"), 8000, '沒填就提醒要登入');
  await js(`(() => { document.querySelector('#iv-login-code').value = ${q(old.token)}; document.querySelector('#inv-form').requestSubmit(); return true; })()`);
  // .av-btn 一直在頁面上：要等邀請頁收起、頭像畫好（接受的請求做完）才算進到工作區（Postgres 比較慢，不等就先查名冊了）
  await until(() => js("document.querySelector('#invite').hidden && !!document.querySelector('.av-btn')?.textContent.trim()"), 10000, '登入後進到工作區');
  assert.ok((await kit.call(boss.token, '/api/roster')).body.members.some(p => p.participantId === old.participant.participantId), '回到成員名冊');
  await goto(kit.BASE + '/', '登出前的頁面');
  await js("localStorage.clear(), sessionStorage.clear(), true");

  // 登入頁設了房間碼：欄位叫房間碼
  await kit.call(boss.token, '/api/workspace/settings', 'PUT', { roomCode: 'abc123' });
  await goto(kit.BASE + '/', '登入頁');
  await until(() => js("!!document.querySelector('#self-join')"), 10000, '登入頁');
  await click('#self-join');
  await until(() => js("!document.querySelector('#room-code-field').hidden"), 8000, '房間碼欄位');
  assert.match(await js("document.querySelector('#room-code-field').textContent"), /房間碼/, '欄位叫房間碼');

  // 375：邀請視窗不橫向捲動
  await size(375, 812);
  await login(boss.token, '/admin/invites');
  await until(() => js("!!document.querySelector('[data-pm-invite]')"), 10000, '手機邀請頁');
  await click('[data-pm-invite]');
  await until(() => js("!!document.querySelector('#inv-new')"), 8000, '手機邀請視窗');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 不橫向捲動');
  console.log('workspace-invite-ui-test：全部通過');
} catch (e) {
  console.error('workspace-invite-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
