// 本機 D1（wrangler --local／Miniflare）的工具：給 scripts/d1-verify.mjs 用（#49）。只碰本機，絕不碰 Cloudflare 上的 D1。
//
// 防護（多層，任何一層不過就丟錯、不執行）：
//   1. assertLocalArgs：只允許 `d1 execute` 與 `dev` 兩個子指令；一定要有 --local、--persist-to（在這次的暫存資料夾裡、不在 repo 裡）、
//      --config（這次產生的設定檔）；看到 --remote、-r、--tunnel 等任何會連到 Cloudflare 的參數就拒絕。
//   2. localConfig／assertLocalConfig：設定檔是這次在暫存資料夾產生的，D1 名稱與 ID 是假的（不是正式的 aigile-switch），
//      沒有 account_id、沒有 remote、沒有 R2／routes；就算有人改成連遠端也找不到正式的資料庫。
//   3. childEnv：子程序拿不到 Cloudflare 的憑證：刪掉 CLOUDFLARE_*／CF_* 環境變數，XDG_CONFIG_HOME 指到暫存資料夾（看不到 wrangler login 存的 OAuth）。
//   4. 不呼叫 scripts/migrate.js（它預設 --remote）與 scripts/admin-rescue.js（永遠 --remote）；只 import 純函式 d1Steps。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

export const LOCAL_DB_NAME = 'aigile-d1-verify-local';
export const LOCAL_DB_ID = '00000000-0000-4000-8000-0000000000d1'; // 假的：正式的 D1 不會有這個 ID
const REMOTE_FLAGS = ['--remote', '-r', '--tunnel', '--tunnel-name', '--x-remote-bindings', '--experimental-remote-bindings', '--x-provision', '--experimental-provision'];
const CRED_ENV = /^(CLOUDFLARE_|CF_)/i;

const inside = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const valueOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(flag + '='))?.slice(flag.length + 1); };

// 防護 1：wrangler 的參數一定是本機
export function assertLocalArgs(args, { tmpRoot, repoRoot }) {
  const bad = args.find(a => REMOTE_FLAGS.includes(a) || REMOTE_FLAGS.some(f => a.startsWith(f + '=')) || /^--remote/i.test(a));
  if (bad) throw new Error(`拒絕執行：wrangler 參數 ${bad} 會連到 Cloudflare（D1 驗證只能用本機）`);
  const isExec = args[0] === 'd1' && args[1] === 'execute', isDev = args[0] === 'dev';
  if (!isExec && !isDev) throw new Error(`拒絕執行：D1 驗證只用 wrangler d1 execute 與 wrangler dev（收到 ${args.slice(0, 2).join(' ')}）`);
  if (!args.includes('--local')) throw new Error('拒絕執行：wrangler 指令缺少 --local');
  const persist = valueOf(args, '--persist-to'), config = valueOf(args, '--config');
  if (!persist || !inside(persist, tmpRoot) || inside(persist, repoRoot)) throw new Error(`拒絕執行：--persist-to 一定要在這次的暫存資料夾（${tmpRoot}）裡、不在 repo 裡（收到 ${persist}）`);
  if (!config || !inside(config, tmpRoot)) throw new Error(`拒絕執行：--config 一定要是這次在暫存資料夾產生的設定檔（收到 ${config}）`);
  if (isExec && args[2] !== 'DB') throw new Error('拒絕執行：只對綁定 DB 執行');
  return true;
}
// 防護 2：設定檔只綁本機的假 D1
export function localConfig({ main }) {
  return [
    `name = "${LOCAL_DB_NAME}"`,
    `main = ${JSON.stringify(main.replace(/\\/g, '/'))}`,
    'compatibility_date = "2026-09-01"', // 跟 wrangler.toml 一樣
    '[[rules]]', 'type = "Text"', 'globs = ["**/*.md"]', 'fallthrough = true',
    '[[d1_databases]]', 'binding = "DB"', `database_name = "${LOCAL_DB_NAME}"`, `database_id = "${LOCAL_DB_ID}"`, '',
  ].join('\n');
}
export function assertLocalConfig(text) {
  if (/\bremote\b|account_id|\broutes?\b|r2_buckets|aigile-switch"/i.test(text)) throw new Error('拒絕執行：設定檔含有可能連到 Cloudflare 的設定');
  if (!text.includes(`database_id = "${LOCAL_DB_ID}"`)) throw new Error('拒絕執行：設定檔的 D1 不是本機驗證用的假資料庫');
  return true;
}
// 防護 3：子程序沒有 Cloudflare 憑證
export function childEnv(base, tmpRoot) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !CRED_ENV.test(k)));
  return { ...env, XDG_CONFIG_HOME: path.join(tmpRoot, 'xdg'), WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
}

// 找 wrangler：D1_VERIFY_WRANGLER（wrangler/bin/wrangler.js 的路徑）優先；否則用 npx 取得 wrangler@4（第一次需要網路）
export function findWrangler() {
  const given = process.env.D1_VERIFY_WRANGLER;
  if (given) { if (!fs.existsSync(given)) throw new Error(`D1_VERIFY_WRANGLER 指的檔案不存在：${given}`); return given; }
  const r = spawnSync('npx --yes -p wrangler@4 node -e "process.stdout.write(process.env.PATH || process.env.Path || \'\')"', { shell: true, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`npx 取得 wrangler@4 失敗（可能沒有網路）：${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
  for (const dir of r.stdout.split(path.delimiter)) {
    const js = path.join(dir, '..', 'wrangler', 'bin', 'wrangler.js');
    if (/node_modules[\\/]\.bin$/.test(dir) && fs.existsSync(js)) return path.resolve(js);
  }
  throw new Error('找不到 npx 下載的 wrangler（wrangler/bin/wrangler.js）');
}

export async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

// 一個本機 D1（一個 persist 資料夾）。exec：wrangler d1 execute --local；dev：wrangler dev --local 跑 Worker
export function localD1({ wrangler, tmpRoot, repoRoot, name, main }) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(dir, 'wrangler.toml');
  const text = localConfig({ main });
  assertLocalConfig(text);
  fs.writeFileSync(config, text);
  const persist = path.join(dir, 'state');
  const env = childEnv(process.env, tmpRoot);
  const guarded = args => { assertLocalArgs(args, { tmpRoot, repoRoot }); return [wrangler, ...args]; };
  // 送一段 SQL（可多句）；回每句的結果列（--json）。SQL 寫成檔案（--file），不受命令列長度與引號影響
  function exec(sql, { label = 'sql' } = {}) {
    const file = path.join(dir, `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
    fs.writeFileSync(file, sql);
    const args = guarded(['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--config', config, '--file', file, '--json', '--yes']);
    const r = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', timeout: 180_000 });
    fs.rmSync(file, { force: true });
    if (r.status !== 0) {
      let msg = (r.stdout || '') + (r.stderr || '');
      try { const j = JSON.parse(r.stdout); msg = j.error?.text || j.error?.message || msg; } catch {}
      const e = new Error(`wrangler d1 execute --local（${label}）失敗：${msg.trim().slice(0, 800)}`); e.output = msg; throw e;
    }
    const out = JSON.parse(r.stdout);
    return (Array.isArray(out) ? out : [out]).map(x => x.results || []);
  }
  const query = sql => exec(sql).at(-1) ?? [];
  // 啟動 Worker：回 { base, stop, log }
  async function dev({ vars = {} } = {}) {
    const port = await freePort(), inspector = await freePort();
    const logFile = path.join(dir, 'wrangler-dev.log');
    const args = guarded(['dev', '--local', '--persist-to', persist, '--config', config, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
      '--show-interactive-dev-session=false', '--log-level', 'warn', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])]);
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const log = fs.createWriteStream(logFile);
    child.stdout.pipe(log); child.stderr.pipe(log);
    let exited = null;
    child.on('exit', code => { exited = code; });
    const base = `http://127.0.0.1:${port}`;
    const stop = async () => { killTree(child); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100); };
    const until = Date.now() + 180_000;
    for (;;) {
      if (exited !== null) throw new Error(`wrangler dev 結束了（${exited}），紀錄：${logFile}\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-1500) : ''}`);
      try { const r = await fetch(base + '/__d1verify/ping'); await r.text(); break; } catch {} // 有任何回應＝Worker 起來了（不碰資料庫）
      if (Date.now() > until) { await stop(); throw new Error(`等不到 wrangler dev 啟動，紀錄：${logFile}`); }
      await sleep(500);
    }
    return { base, stop, logFile };
  }
  return { dir, persist, config, exec, query, dev };
}

export function makeTmpRoot(repoRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-d1-verify-'));
  if (inside(root, repoRoot)) throw new Error('拒絕執行：暫存資料夾在 repo 裡');
  return fs.realpathSync.native ? root : root;
}
export async function removeDir(dir) {
  for (let i = 0; i < 20; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { await sleep(300); } }
  return false;
}
