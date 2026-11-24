// npm test 同時跑多支時，每支測試各有一組自己的暫存家目錄（AIGILE_HOME、CODEX_HOME、Gemini、Copilot），彼此看不到對方寫的檔；
// 外面已經設了 AIGILE_HOME 也一樣（每支在它底下各開一個子資料夾，跑完刪掉，原本的檔案不動）。
// 做法：在暫存資料夾放幾支假測試，用 AIGILE_TEST_RUN_DIR 讓 run-all 改跑那裡，TEST_JOBS 等於支數讓它們同時跑；
// 每支在四個家目錄各寫一個檔，等所有兄弟都寫完才列出家目錄內容，回報給這支測試檢查。
// 用法：node scripts/run-all-isolation-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./run-all.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEYS = ['AIGILE_HOME', 'CODEX_HOME', 'AIGILE_GEMINI_HOME', 'COPILOT_HOME'];
const N = 3;

// 假測試：四個家目錄各寫自己的檔名，等 N 支都寫完（確定同時在跑）再看每個家目錄裡有誰的檔
const FAKE = `import fs from 'node:fs';
import path from 'node:path';
const me = path.basename(process.argv[1]);
const report = process.env.AIGILE_TEST_ISO_REPORT;
const homes = Object.fromEntries(${JSON.stringify(KEYS)}.map(k => [k, process.env[k]]));
for (const d of Object.values(homes)) fs.writeFileSync(path.join(d, me), me);
fs.writeFileSync(path.join(report, me + '.ready'), '');
while (fs.readdirSync(report).filter(f => f.endsWith('.ready')).length < ${N}) await new Promise(r => setTimeout(r, 50));
const seen = Object.fromEntries(Object.entries(homes).map(([k, d]) => [k, fs.readdirSync(d)]));
fs.writeFileSync(path.join(report, me + '.json'), JSON.stringify({ homes, seen }));
console.log(me + '：全部通過');
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-runiso-'));
const runRunner = env => new Promise(resolve => {
  const p = spawn(process.execPath, [RUNNER, 'iso-fake'], { cwd: ROOT, env });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => resolve({ code, out }));
});

async function runCase(label, inherited) {
  const testDir = path.join(tmp, label, 'tests');
  const report = path.join(tmp, label, 'report');
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(report, { recursive: true });
  const names = Array.from({ length: N }, (_, i) => `iso-fake-${i}-test.js`);
  for (const f of names) fs.writeFileSync(path.join(testDir, f), FAKE);
  const env = { ...process.env, AIGILE_TEST_RUN_DIR: testDir, AIGILE_TEST_ISO_REPORT: report, TEST_JOBS: String(N), TEST_TIMEOUT_SEC: '60', AIGILE_TEST_PG_URL: '' };
  delete env.AIGILE_HOME;
  if (inherited) env.AIGILE_HOME = inherited;
  const r = await runRunner(env);
  assert.equal(r.code, 0, `${label}：run-all 沒過\n${r.out}`);
  assert.match(r.out, new RegExp(`${N}/${N} 通過`), `${label}：要跑到 ${N} 支假測試\n${r.out}`);

  const reports = names.map(f => ({ f, ...JSON.parse(fs.readFileSync(path.join(report, f + '.json'), 'utf8')) }));
  const all = reports.flatMap(x => KEYS.map(k => path.resolve(x.homes[k])));
  assert.equal(new Set(all.map(d => d.toLowerCase())).size, all.length, `${label}：每支測試的四個家目錄都要不同\n${JSON.stringify(reports, null, 1)}`);
  for (const x of reports) for (const k of KEYS) {
    assert.deepEqual(x.seen[k], [x.f], `${label}：${x.f} 的 ${k} 只能有自己寫的檔，看到 ${x.seen[k].join('、')}`);
    assert.ok(!fs.existsSync(x.homes[k]), `${label}：${x.f} 的 ${k} 跑完要刪掉`);
  }
  return reports;
}

try {
  await runCase('fresh', null);
  console.log('✓ 沒設 AIGILE_HOME：每支各自一組家目錄');

  const inherited = path.join(tmp, 'inherited-home');
  fs.mkdirSync(inherited);
  fs.writeFileSync(path.join(inherited, 'keep.txt'), 'x');
  const reports = await runCase('inherited', inherited);
  for (const x of reports) {
    const rel = path.relative(inherited, x.homes.AIGILE_HOME);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `外面設的 AIGILE_HOME 底下各開子資料夾，${x.f} 拿到 ${x.homes.AIGILE_HOME}`);
  }
  assert.deepEqual(fs.readdirSync(inherited), ['keep.txt'], '外面的 AIGILE_HOME 原本的檔案留著、子資料夾跑完刪掉');
  console.log('✓ 有設 AIGILE_HOME：每支在它底下各自一個子資料夾');

  console.log('run-all-isolation-test：全部通過');
} catch (e) {
  console.error('run-all-isolation-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
