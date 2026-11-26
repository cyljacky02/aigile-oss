// 驗收測試：Docker 與 docker compose 一行啟動、發佈映像、CI 三平台（檔案內容檢查；測試不跑 Docker、不連 GitHub）
// 實際 build 與啟動在開發時驗過：docker compose up 後 admin 登入、非 root、資料在 volume、重啟資料還在、ADMIN_PASSWORD、健康檢查
// 1. Dockerfile：Node 22 官方映像、非 root 執行、資料在 /data volume、啟動 server.js、有健康檢查；只裝選用的 pg（npm ci 照 package-lock）
// 2. docker-compose.yml：3000 埠、volume、ADMIN_PASSWORD 等環境變數有設才帶；docker-compose.postgres.yml 連 Postgres 一起起來（PLAT-369）
// 3. .dockerignore 排除 data、.aigile、node_modules、密鑰檔
// 4. README 的快速開始是 Docker，本機第二、Cloudflare 放後面
// 5. 打 v* 標籤自動建 amd64／arm64 映像推到 ghcr.io，標版本號與 latest；README 中英文都有「不用 clone 直接用映像」（docker run 與 compose，資料掛 volume）
// 6. CI 在 ubuntu、windows、macos 跑全部測試（Node 22），檢查 checkout 是 LF、找得到瀏覽器；另外跑 Postgres 全套與本機 D1 驗證
// 7. CI 不在每次 push／PR 跑（平常靠本機 npm test）：只在發版（打 v* 標籤）時先跑完全套、通過才發佈映像，或手動觸發
// 用法：node scripts/docker-files-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
try {
  const df = read('Dockerfile');
  assert.match(df, /^FROM node:22(-alpine|-slim)?\s*$/m, 'Node 22 官方映像');
  assert.match(df, /^USER node\s*$/m, '非 root 執行');
  assert.ok(df.indexOf('USER node') > df.indexOf('chown node:node /data'), '先把 /data 給 node 使用者再切換');
  assert.match(df, /DATA_DIR=\/data/, '資料放 /data');
  assert.match(df, /VOLUME \["\/data"\]/, '/data 是 volume');
  assert.match(df, /EXPOSE 3000/);
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/health/, '健康檢查');
  assert.match(df, /CMD \["node", "server\.js"\]/);
  // 唯一的套件是 Postgres 連線（pg，選用）：照 package-lock 固定版本裝，不裝開發用的；先複製 package*.json 再 npm ci（改程式不用重裝）
  const installs = df.split(/\r?\n/).filter(l => !l.trim().startsWith('#') && /npm (install|ci)/.test(l));
  assert.equal(installs.length, 1, '只有一行安裝');
  assert.match(installs[0], /npm ci --omit=dev/, '用 npm ci 照 package-lock 裝，不裝開發用的');
  assert.ok(df.indexOf('COPY package.json package-lock.json') < df.indexOf('npm ci'), '先複製 package*.json 再安裝');
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], '沒有必裝的套件（SQLite 版零相依）');
  assert.deepEqual(Object.keys(pkg.optionalDependencies || {}), ['pg'], '選用套件只有 pg');
  assert.match(pkg.optionalDependencies.pg, /^\d+\.\d+\.\d+$/, 'pg 版本固定');
  assert.ok(JSON.parse(read('package-lock.json')).packages['node_modules/pg'], 'package-lock 有 pg');

  // docker-compose.postgres.yml：一行連 Postgres 一起起來；資料庫埠不對外、密碼不寫死、等資料庫好了才啟動
  const dcp = read('docker-compose.postgres.yml');
  assert.match(dcp, /DATABASE_URL=postgres:\/\/aigile:\$\{POSTGRES_PASSWORD:-aigile\}@postgres:5432\/aigile/, 'DATABASE_URL 指到 postgres 服務');
  assert.match(dcp, /condition: service_healthy/, '等資料庫健康才啟動');
  assert.ok(!/^\s+ports:/m.test(dcp), '資料庫埠不對外開');
  assert.match(dcp, /aigile-pg:\/var\/lib\/postgresql\/data/, '資料庫資料放 volume');

  const dc = read('docker-compose.yml');
  assert.match(dc, /"\$\{HOST_PORT:-3000\}:3000"/, '3000 埠（可換）');
  assert.match(dc, /aigile-data:\/data/, '資料放 volume');
  assert.match(dc, /^volumes:\s*\n\s+aigile-data:/m, '宣告 volume');
  for (const v of ['ADMIN_PASSWORD', 'ROOM_CODE', 'OPEN_JOIN', 'UPDATE_CHECK', 'DATABASE_URL', 'DATABASE_SCHEMA']) assert.match(dc, new RegExp(`^\\s+- ${v}\\s*$`, 'm'), `${v} 有設才帶進容器`);
  assert.ok(!dc.split(/\r?\n/).some(l => !l.trim().startsWith('#') && /ADMIN_PASSWORD\s*[:=]\s*\S/.test(l)), 'compose 裡不寫死密碼');

  const di = read('.dockerignore').split(/\r?\n/).map(l => l.trim());
  for (const x of ['data/', '.aigile/', 'node_modules/', '.git/', '.env', '.dev.vars']) assert.ok(di.includes(x), '.dockerignore 排除 ' + x);

  const readme = read('README.md');
  assert.match(readme, /## 快速開始（Docker）[\s\S]*docker compose up -d[\s\S]*## 本機啟動[\s\S]*## 進階：部署到 Cloudflare/, 'README：Docker 第一、本機第二、Cloudflare 放後面');
  const rel = read('.github/workflows/release.yml');
  assert.match(rel, /^on:\s*\n\s+push:\s*\n\s+tags: \['v\*'\]/m, '發佈：打 v* 標籤觸發');
  assert.match(rel, /^\s+packages: write\s*$/m, '發佈：GITHUB_TOKEN 可寫 packages');
  for (const a of ['docker/login-action@', 'docker/metadata-action@', 'docker/build-push-action@', 'docker/setup-qemu-action@', 'docker/setup-buildx-action@']) assert.ok(rel.includes('uses: ' + a), '發佈用 ' + a);
  assert.match(rel, /registry: ghcr\.io/, '發佈：登入 ghcr.io');
  assert.match(rel, /images: ghcr\.io\/\$\{\{ github\.repository \}\}/, '發佈：映像名 ghcr.io/<owner>/<repo>');
  assert.match(rel, /type=semver,pattern=\{\{version\}\}/, '發佈：標版本號（v1.0.3 → 1.0.3）');
  assert.match(rel, /latest=auto/, '發佈：標 latest');
  assert.match(rel, /platforms: linux\/amd64,linux\/arm64/, '發佈：amd64 與 arm64');
  assert.ok(rel.indexOf('/api/health') > 0 && rel.indexOf('/api/health') < rel.indexOf('push: true'), '發佈：推之前先啟動檢查健康');
  assert.match(rel, /GITHUB_REF_NAME#v[\s\S]*package\.json|package\.json[\s\S]*GITHUB_REF_NAME#v/, '發佈：標籤要等於 package.json 版本');
  for (const [f, title, compose] of [['README.md', '不用 clone', '用 compose'], ['README.en.md', 'Without cloning', 'With compose']]) {
    const r = read(f), i = r.indexOf(title);
    assert.ok(i > 0, f + '：有「不用 clone 直接用映像」');
    const sec = r.slice(i, r.indexOf('</details>', i));
    assert.match(sec, /docker run -d[^\n]*-v aigile-data:\/data[\s\S]*?ghcr\.io\/alansid\/aigile-oss:latest/, f + '：docker run 掛 volume、用 ghcr 映像');
    assert.ok(sec.includes(compose), f + '：有 compose 寫法');
    assert.match(sec, /image: ghcr\.io\/alansid\/aigile-oss:latest[\s\S]*- aigile-data:\/data[\s\S]*^volumes:\s*\n\s+aigile-data:/m, f + '：compose 用 ghcr 映像、資料掛 volume');
  }

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/, 'CI：三個平台');
  assert.match(ci, /runs-on: \$\{\{ matrix\.os \}\}/, 'CI：照 matrix 跑');
  assert.match(ci, /fail-fast: false/, 'CI：一個平台失敗其他照跑');
  assert.match(ci, /node-version: 22/, 'CI：Node 22');
  assert.match(ci, /git ls-files --eol[\s\S]*w\/crlf/, 'CI：檢查 checkout 是 LF');
  assert.match(ci, /findBrowser/, 'CI：找不到瀏覽器就失敗，不默默略過畫面測試');
  assert.match(ci, /npm test/);
  assert.match(ci, /test-postgres:[\s\S]*image: postgres:[\s\S]*npm ci[\s\S]*AIGILE_TEST_PG_URL: postgres:\/\/postgres:test@localhost:5432\//, 'CI：另外在 Postgres 服務跑全套（只連 CI 本機的服務）');
  const d1Job = ci.split(/^ {2}(?=\S)/m).find(job => job.startsWith('test-d1:'));
  assert.ok(d1Job, 'CI：有獨立的本機 D1 驗證工作');
  assert.match(d1Job, /^    runs-on: ubuntu-latest$/m, 'CI D1：在 Linux 跑');
  assert.match(d1Job, /^ +node-version: 24$/m, 'CI D1：使用 Node 24');
  assert.match(d1Job, /^    timeout-minutes: [1-9]\d*$/m, 'CI D1：設定執行時限');
  assert.match(d1Job, /^ +run: npm install --prefix "\$RUNNER_TEMP\/aigile-d1" .*\bwrangler@\d+\.\d+\.\d+$/m, 'CI D1：在 runner 的暫存區裝固定版本的 Wrangler');
  assert.doesNotMatch(d1Job, /^ {4,8}(?:-[ \t]+)?["']?(?:continue-on-error|if)["']?[ \t]*:/m, 'CI D1：必須執行，出錯就失敗');
  const d1Steps = d1Job.split(/^ {6}- /m).slice(1);
  const checkout = d1Steps.find(step => /^(?: {8})?uses: actions\/checkout@/m.test(step));
  assert.match(checkout ?? '', /^ {10}persist-credentials: false$/m, 'CI D1：checkout 不保留 GitHub 憑證');
  const verify = d1Steps.find(step => /^(?: {8})?run: npm run verify:d1$/m.test(step));
  assert.ok(verify, 'CI D1：執行本機驗證');
  assert.match(verify, /^ {10}D1_VERIFY_WRANGLER: \$\{\{ runner\.temp \}\}\/aigile-d1\/node_modules\/wrangler\/bin\/wrangler\.js$/m, 'CI D1：使用指定的 Wrangler');
  assert.match(verify, /^ {10}NODE_ENV: test$/m, 'CI D1：Miniflare 使用本機 Request.cf 預設值');
  assert.doesNotMatch(d1Job, /\bsecrets\.|\b(?:CLOUDFLARE|CF)_[A-Z_]+|\bcloudflare\/|\bwrangler\.toml\b|--remote\b/i, 'CI D1：只用本機驗證，不帶 Cloudflare 憑證或部署設定');
  assert.match(ci, /docker compose -f docker-compose\.yml -f docker-compose\.postgres\.yml up -d --build/, 'CI：compose 連 Postgres 一起起來並檢查');
  assert.ok(!/^\s+run: npm (ci|install)\s*$/m.test(ci.split('test-postgres:')[0]), 'CI：SQLite 那組不裝套件（零相依照樣能跑）');
  const ciOn = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:'));
  assert.ok(!/^\s+(push|pull_request):/m.test(ciOn), 'CI：不在每次 push／PR 跑');
  assert.match(ciOn, /^\s+workflow_dispatch:/m, 'CI：可以手動觸發');
  assert.match(ciOn, /^\s+workflow_call:/m, 'CI：發版流程可以呼叫');
  assert.match(rel, /^\s+ci:\s*\n\s+uses: \.\/\.github\/workflows\/ci\.yml/m, '發版：先跑全套 CI');
  assert.match(rel, /^\s+image:\s*\n\s+needs: ci/m, '發版：CI 通過才建映像、發佈');
  console.log('docker-files-test：全部通過');
} catch (e) {
  console.error('docker-files-test 失敗：', e.message);
  process.exitCode = 1;
}
