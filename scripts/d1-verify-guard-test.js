// 本機 D1 驗證（npm run verify:d1）的防護：只能碰本機 D1，不能碰 Cloudflare 上的正式 D1。
// 不需要 wrangler、不連網路：只測防護的純函式，與 d1-verify.mjs 收到 --remote 時立刻拒絕（不建暫存資料夾、不找 wrangler）。
// 用法：node scripts/d1-verify-guard-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertLocalArgs, assertLocalConfig, localConfig, childEnv, LOCAL_DB_ID } from './d1-local.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tmpRoot = path.join(os.tmpdir(), 'aigile-d1-verify-guard');
const persist = path.join(tmpRoot, 'site', 'state'), config = path.join(tmpRoot, 'site', 'wrangler.toml');
const ctx = { tmpRoot, repoRoot };
const execArgs = extra => ['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--config', config, '--command', 'SELECT 1', ...extra];
const devArgs = extra => ['dev', '--local', '--persist-to', persist, '--config', config, ...extra];

try {
  // 合法：本機的 d1 execute 與 dev
  assert.ok(assertLocalArgs(execArgs([]), ctx));
  assert.ok(assertLocalArgs(devArgs(['--port', '8787']), ctx));
  // 任何會連到 Cloudflare 的參數都拒絕
  for (const flag of ['--remote', '-r', '--remote=true', '--tunnel', '--x-remote-bindings', '--experimental-remote-bindings'])
    for (const args of [execArgs([flag]), devArgs([flag])]) assert.throws(() => assertLocalArgs(args, ctx), /拒絕執行/, `${flag} 要拒絕`);
  // 沒有 --local、別的子指令、別的綁定都拒絕
  assert.throws(() => assertLocalArgs(execArgs([]).filter(a => a !== '--local'), ctx), /--local/);
  assert.throws(() => assertLocalArgs(devArgs([]).filter(a => a !== '--local'), ctx), /--local/);
  for (const args of [['deploy', '--local'], ['d1', 'migrations', 'apply', 'DB', '--local'], ['d1', 'export', 'DB', '--local'], ['secret', 'put', 'X']])
    assert.throws(() => assertLocalArgs(args, ctx), /拒絕執行/, `${args.join(' ')} 要拒絕`);
  assert.throws(() => assertLocalArgs(execArgs([]).map(a => (a === 'DB' ? 'aigile-switch' : a)), ctx), /綁定 DB/);
  // 資料一定放在這次的暫存資料夾、不在 repo 裡；設定檔一定是這次產生的
  const swap = (args, flag, v) => args.map((a, i) => (args[i - 1] === flag ? v : a));
  for (const p of [path.join(repoRoot, '.wrangler', 'state'), path.join(os.tmpdir(), 'elsewhere'), tmpRoot])
    assert.throws(() => assertLocalArgs(swap(execArgs([]), '--persist-to', p), ctx), /--persist-to/, `persist ${p} 要拒絕`);
  assert.throws(() => assertLocalArgs(execArgs([]).filter((a, i, all) => a !== '--persist-to' && all[i - 1] !== '--persist-to'), ctx), /--persist-to/);
  assert.throws(() => assertLocalArgs(swap(execArgs([]), '--config', path.join(repoRoot, 'wrangler.toml')), ctx), /--config/, 'repo 的 wrangler.toml（正式設定）要拒絕');
  assert.throws(() => assertLocalArgs(swap(execArgs([]), '--persist-to', path.join(repoRoot, 'x')), { tmpRoot: repoRoot, repoRoot }), /--persist-to/, '暫存資料夾在 repo 裡也拒絕');
  console.log('✓ wrangler 參數：只接受本機的 d1 execute／dev，拒絕 --remote 等參數、repo 裡的資料夾與正式設定檔');

  // 設定檔：本機假的 D1；正式的設定（repo 的 wrangler.toml）、remote、account_id 都拒絕
  const text = localConfig({ main: path.join(repoRoot, 'scripts', 'd1-verify-worker.mjs') });
  assert.ok(assertLocalConfig(text));
  assert.ok(text.includes(LOCAL_DB_ID) && !/aigile-switch"/.test(text) && !/r2_buckets|account_id|remote/.test(text));
  assert.throws(() => assertLocalConfig(fs.readFileSync(path.join(repoRoot, 'wrangler.toml'), 'utf8')), /拒絕執行/, 'repo 的 wrangler.toml 不能拿來驗證');
  assert.throws(() => assertLocalConfig(text + '\naccount_id = "abc"\n'), /拒絕執行/);
  assert.throws(() => assertLocalConfig(text.replace('[[d1_databases]]', '[[d1_databases]]\nremote = true')), /拒絕執行/);
  assert.throws(() => assertLocalConfig(text.replace(LOCAL_DB_ID, '11111111-2222-3333-4444-555555555555')), /拒絕執行/);
  console.log('✓ 設定檔：只綁本機驗證用的假 D1');

  // 子程序拿不到 Cloudflare 憑證，也看不到 wrangler login 存的 OAuth
  const env = childEnv({ PATH: 'x', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', CF_API_TOKEN: 'c', cloudflare_api_key: 'k', XDG_CONFIG_HOME: '/home/me/.config' }, tmpRoot);
  assert.deepEqual(Object.keys(env).filter(k => /cloudflare|^cf_/i.test(k)), [], '沒有 Cloudflare 憑證');
  assert.equal(env.XDG_CONFIG_HOME, path.join(tmpRoot, 'xdg'), 'wrangler 的設定資料夾換成暫存的');
  assert.equal(env.PATH, 'x');
  console.log('✓ 子程序環境：沒有 Cloudflare 憑證、wrangler 設定資料夾是暫存的');

  // 驗證腳本收到 --remote 立刻拒絕（退出碼 2＝沒有驗證），不建暫存資料夾、不找 wrangler；也不呼叫會碰正式 D1 的腳本
  const r = spawnSync(process.execPath, [path.join(here, 'd1-verify.mjs'), '--remote'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, D1_VERIFY_WRANGLER: path.join(tmpRoot, 'no-such-wrangler.js') } });
  assert.equal(r.status, 2, `--remote 要拒絕：${r.status} ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /拒絕執行/);
  for (const f of ['d1-verify.mjs', 'd1-local.mjs', 'd1-verify-worker.mjs']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/admin-rescue/.test(src), `${f} 不碰 admin-rescue.js`);
    assert.ok(!/spawn[^\n]*migrate\.js|['"]migrate\.js['"]/.test(src), `${f} 不執行 migrate.js（只 import 純函式 d1Steps）`);
  }
  console.log('✓ d1-verify.mjs 收到 --remote 立刻拒絕；不執行 migrate.js、admin-rescue.js');
  console.log('d1-verify-guard-test：全部通過');
} catch (e) {
  console.error('d1-verify-guard-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
