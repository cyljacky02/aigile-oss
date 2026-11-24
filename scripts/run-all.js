// npm test 一次跑完全部測試（scripts/*-test.js 與冒煙測試 smoke.js），最後列出沒過的。
// 預設一次跑一支；TEST_JOBS=N（或 --jobs N）同時跑 N 支，結果照跑完的順序印。
// 並行時：固定埠的舊測試（FIXED_PORT）彼此輪流跑；會起 watcher 子程序、怕被拖慢的測試（SERIAL）等其他都跑完再一支一支單獨跑。
// 每支測試各有一組暫存的家目錄（AIGILE_HOME、CODEX_HOME、Gemini、Copilot），同時跑也不會互相寫到。
// 用法：
//   npm test                 全部
//   npm test -- c341 s4      只跑檔名含這些字的
//   TEST_JOBS=8 npm test     同時跑 8 支（16 核心的機器約 4 分鐘，一支一支跑約 14 分鐘）
//   npm test -- --jobs 8 kb  同上，只跑檔名含 kb 的
// 環境變數 TEST_TIMEOUT_SEC：單一測試最多跑幾秒，預設 300；逾時算失敗
// 環境變數 AIGILE_TEST_PG_URL：改在 Postgres 跑同一套（要先 npm install；只准本機或 CI 的 postgres 服務），
//   例：AIGILE_TEST_PG_URL=postgres://postgres:test@127.0.0.1:5432/aigile_test npm test
//   每個測試資料夾一個 t_ 開頭的 schema，開始前與跑完都會清掉
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// 這些測試寫死同一段埠（3990–3999，有的兩支共用一個埠），並行時排同一條線、一次只跑一支，其他測試照樣同時跑
const FIXED_PORT = ['cards-test.js', 'files-test.js', 'login-test.js', 'notes-test.js', 'password-test.js', 'projects-test.js', 'roles-test.js', 'setup-test.js', 'smoke.js', 'state-test.js', 'suggestions-test.js', 'team-test.js', 'wait-test.js'];
// 這些測試在別的測試同時跑時會逾時或判斷錯（起 watcher／等待腳本子程序、照實際經過的秒數判斷），並行時留到最後單獨跑
//   wait-test：起等待腳本後只睡 1.2 秒就改門鈴檔，機器忙時腳本還沒讀到原本的 seq，門鈴響了也不醒
//   boot-retry-ui-test：攔截 /api/me 讓它失敗一次、看重試，機器忙時攔不到或 Token 被清掉（同時跑 6 支幾乎都失敗，單獨跑都過）
//   message-view-ui-test：第一次載入後才設「上次看到」再重新整理，機器忙時舊頁面會蓋掉它，紅線等不到
const SERIAL = ['boot-retry-ui-test.js', 'message-view-ui-test.js', 'wait-test.js'];

const dir = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const filters = [];
let jobsArg;
for (let i = 0; i < args.length; i++) {
  const m = /^(?:--jobs=|-j)(.+)$/.exec(args[i]);
  if (args[i] === '--jobs' || args[i] === '-j') jobsArg = args[++i];
  else if (m) jobsArg = m[1];
  else if (!args[i].startsWith('-')) filters.push(args[i]);
}
const jobsRaw = jobsArg ?? process.env.TEST_JOBS ?? '1';
const JOBS = Number(jobsRaw);
if (!Number.isInteger(JOBS) || JOBS < 1) { console.error(`TEST_JOBS／--jobs 要是正整數，收到「${jobsRaw}」`); process.exit(1); }
const TIMEOUT_MS = (Number(process.env.TEST_TIMEOUT_SEC) || 300) * 1000;
const files = fs.readdirSync(dir).filter(f => /-test\.js$/.test(f) || f === 'smoke.js').sort()
  .filter(f => !filters.length || filters.some(k => f.includes(k)));
if (!files.length) { console.error(`沒有符合「${filters.join(' ')}」的測試`); process.exit(1); }

// 接入檢查會寫 ~/.aigile/、Codex 版會改 ~/.codex/config.toml、Antigravity CLI 寫 ~/.gemini、Copilot CLI 寫 ~/.copilot/mcp-config.json：
// 每支測試開自己的暫存家目錄，跑完刪掉（有設 AIGILE_HOME 就照用）
const tempHome = kind => fs.mkdtempSync(path.join(os.tmpdir(), `aigile-${kind}-`));
const run = f => new Promise(resolve => {
  const started = Date.now();
  const homes = { home: tempHome('home'), codex: tempHome('codexhome'), gemini: tempHome('geminihome'), copilot: tempHome('copilothome') };
  let out = '', timedOut = false;
  const p = spawn(process.execPath, [f], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, FORCE_COLOR: '0', AIGILE_HOME: process.env.AIGILE_HOME || homes.home, AIGILE_TEST_CODEX_HOME: homes.codex, CODEX_HOME: homes.codex, COPILOT_HOME: homes.copilot, AIGILE_TEST_COPILOT_HOME: homes.copilot, AIGILE_TEST_GEMINI_HOME: homes.gemini, AIGILE_GEMINI_HOME: homes.gemini, AIGILE_CODEX_BIN: fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), AIGILE_ANTIGRAVITY_BIN: fileURLToPath(new URL('./fake-antigravity.mjs', import.meta.url)) } });
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, TIMEOUT_MS);
  p.on('close', code => {
    clearTimeout(timer);
    for (const d of Object.values(homes)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
    resolve({ f, ok: code === 0 && !timedOut, code, timedOut, sec: ((Date.now() - started) / 1000).toFixed(1), out });
  });
});

// Postgres 模式：清掉上次留下的測試 schema（只動 t_ 加 20 碼的）
const PG_URL = process.env.AIGILE_TEST_PG_URL;
async function dropTestSchemas() {
  const { assertTestPgUrl } = await import('../src/db-pg.js');
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: assertTestPgUrl(PG_URL) });
  await c.connect();
  try {
    const { rows } = await c.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^t_[0-9a-f]{20}$'");
    for (const r of rows) await c.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  } finally { await c.end(); }
}
if (PG_URL) { await dropTestSchemas(); console.log('資料庫：Postgres（AIGILE_TEST_PG_URL）\n'); }

const failed = [];
const t0 = Date.now();
const runOne = async f => {
  const r = await run('scripts/' + f);
  const last = r.out.trim().split('\n').pop() || '';
  // 整段一次印出，並行時別支測試的行不會插進來
  let text = `${r.ok ? '✓' : '✗'} ${f.padEnd(28)} ${r.sec.padStart(6)}s  ${r.ok ? last.slice(0, 80) : r.timedOut ? `逾時（${TIMEOUT_MS / 1000} 秒）` : `exit ${r.code}`}`;
  if (!r.ok) { failed.push(f); text += '\n' + r.out.trim().split('\n').slice(-20).map(l => '    ' + l).join('\n'); }
  console.log(text);
};
const inOrder = async list => { for (const f of list) await runOne(f); };

if (JOBS === 1) await inOrder(files);
else {
  const serial = files.filter(f => SERIAL.includes(f));
  const portLane = files.filter(f => FIXED_PORT.includes(f) && !SERIAL.includes(f));
  // 固定埠那條線當成一個工作、排最前面，先佔一個位子慢慢跑完；接著先跑會起子程序的（伺服器、瀏覽器、watcher，一支幾秒到一分鐘），
  // 程序內的測試多半不到一秒，留到後面補空檔，最後才開始的慢測試不會拖長總時間
  const rest = files.filter(f => !serial.includes(f) && !portLane.includes(f));
  const slow = new Set(rest.filter(f => /\b(spawn|spawnSync|execFile|execFileSync|startKit|startServer)\(/.test(fs.readFileSync(path.join(dir, f), 'utf8'))));
  const queue = [...(portLane.length ? [() => inOrder(portLane)] : []), ...[...rest.filter(f => slow.has(f)), ...rest.filter(f => !slow.has(f))].map(f => () => runOne(f))];
  console.log(`同時跑 ${JOBS} 支${serial.length ? `；${serial.length} 支最後單獨跑：${serial.join('、')}` : ''}\n`);
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => { while (queue.length) await queue.shift()(); }));
  await inOrder(serial);
}
failed.sort();
console.log(`\n${files.length - failed.length}/${files.length} 通過，共 ${((Date.now() - t0) / 1000).toFixed(0)} 秒${failed.length ? `；沒過：${failed.join('、')}` : ''}`);
if (PG_URL) await dropTestSchemas();
process.exitCode = failed.length ? 1 : 0;
