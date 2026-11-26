// 直接建立表單：程式庫跟專案一起送出；分支驗證失敗可以修正後重送，不會留下部分建立的專案。
import assert from 'node:assert/strict';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('project-create-repo-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
// 故意讓子程序有可繼承的 DATABASE_URL。若覆寫失效，這個無效值只會讓啟動失敗。
process.env.DATABASE_URL = 'invalid-test-database-url';
const kit = await startKit('pcrepoui', { env: { DATABASE_URL: '' } });
try {
  const joined = await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' });
  assert.equal(joined.status, 201);
  const { token } = joined.body;
  const { js, login, cdp, on } = await kit.browser(1280, 860);
  await cdp('Network.setBlockedURLs', { urls: ['https://*'] });
  await login(token);
  const entry = '.hub-join[data-hub-newproj]';
  await until(() => js(`!!document.querySelector('${entry}')`), 10000, '總覽的新增專案入口');
  await js(`document.querySelector('${entry}').click(); true`);
  await until(() => js("!!document.querySelector('#np-form')"), 5000, '新增專案表單');

  const writes = [];
  on(({ method, params }) => {
    if (method !== 'Network.requestWillBeSent') return;
    const { method: verb, url, postData } = params.request;
    const path = url.slice(kit.BASE.length);
    if (url.startsWith(kit.BASE) && (verb === 'POST' && path === '/api/projects' || verb === 'PUT' && /^\/api\/projects\/[^/]+\/repo$/.test(path))) {
      writes.push({ verb, path, body: JSON.parse(postData) });
    }
  });
  const name = '程式庫專案';
  const url = 'https://example.com/team/project';
  const findProject = async (projectName = name) => {
    const result = await kit.call(token, '/api/projects');
    assert.equal(result.status, 200);
    return result.body.items.find(p => p.name === projectName);
  };
  await js(`(() => {
    const form = document.querySelector('#np-form');
    form.name.value = ${JSON.stringify(name)};
    form.url.value = ${JSON.stringify(url)};
    form.branch.value = 'invalid branch';
    form.requestSubmit();
  })()`);
  await until(() => js("!document.querySelector('#np-form') || !!document.querySelector('#np-err')?.textContent"), 8000, '送出後顯示結果');
  assert.equal((await findProject())?.name, undefined, '分支驗證失敗後沒有留下專案');
  assert.match(await js("document.querySelector('#np-err')?.textContent"), /分支只能用/, '在表單內顯示分支錯誤');

  await js(`(() => {
    const form = document.querySelector('#np-form');
    form.branch.value = 'release/v1';
    form.requestSubmit();
  })()`);
  await until(() => js("!document.querySelector('#np-form') && document.querySelector('#toast')?.textContent.includes('目前只有你')"), 8000, '修正分支後確認建立成功');
  assert.deepEqual(writes.map(({ verb, path, body }) => [verb, path, body.repo]), [
    ['POST', '/api/projects', { url, branch: 'invalid branch' }],
    ['POST', '/api/projects', { url, branch: 'release/v1' }],
  ], '每次送出只用一個 POST');
  assert.deepEqual((await findProject())?.repo, { url, branch: 'release/v1' });

  // 模擬舊伺服器忽略 repo 欄位，仍讓本機 API 完成建立並回傳真實的 201。
  const legacyName = '舊版伺服器專案';
  await js(`(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (path, opts) => {
      if (path === '/api/projects' && opts?.method === 'POST') {
        const { repo, ...body } = JSON.parse(opts.body);
        if (body.name === ${JSON.stringify(legacyName)}) opts = { ...opts, body: JSON.stringify(body) };
      }
      return fetchOriginal(path, opts);
    };
  })()`);
  await js(`document.querySelector('${entry}').click(); true`);
  await until(() => js("!!document.querySelector('#np-form')"), 5000, '再開新增專案表單');
  await js(`(() => {
    const form = document.querySelector('#np-form');
    form.name.value = ${JSON.stringify(legacyName)};
    form.url.value = ${JSON.stringify(url)};
    form.branch.value = 'main';
    form.requestSubmit();
  })()`);
  await until(() => js("!document.querySelector('#np-form') && document.querySelector('#toast')?.textContent.includes('舊版伺服器專案')"), 8000, '舊版伺服器回應後顯示結果');
  assert.match(await js("document.querySelector('#toast').textContent"), /已新增專案.*未確認程式庫設定/);
  assert.deepEqual(writes.slice(2).map(({ verb, path }) => [verb, path]), [['POST', '/api/projects']], '收到 201 後只提示，不重送或用 PUT 補救');
  assert.equal((await findProject(legacyName))?.repo, null, '舊版伺服器已建立專案，沒有程式庫');
  console.log('project-create-repo-ui-test：全部通過');
} finally {
  await kit.stop();
}
