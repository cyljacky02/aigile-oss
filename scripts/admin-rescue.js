// 主機救援：產生一次性平台管理員登入連結（15 分鐘、用一次就失效）。網頁沒有按鈕、也沒有 API 可以叫，
// 只有拿著主機部署權限的人能跑（正式環境要 wrangler 已登入那個 Cloudflare 帳號）。只救平台管理員；其他人忘記密碼請工作區管理員「重設登入」。
// 只有一位平台管理員時直接用他；有多位時要用 --name 指定名字，沒指定就列出平台管理員名單後結束（不產生連結）。
// 用法：
//   npm run admin-rescue [-- --name 名字]                              正式環境（Cloudflare D1）
//   npm run admin-rescue -- --local [資料夾] [--base 網址] [--name 名字]   本機 node server.js（預設 ./data、http://localhost:3000）
//     本機版用 Postgres 時（有設 DATABASE_URL）照同一組設定連 Postgres，資料夾參數不用給
// 每次產生都記在 rescue_links（誰＝主機使用者@主機名稱、何時），並在被救的平台管理員的收件匣發一則安全通知。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_URL = process.env.APP_URL || ''; // 正式環境的網址：APP_URL 或 --base
const TTL_MS = 15 * 60_000;
const args = process.argv.slice(2);
const local = args.includes('--local');
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt('--base') || (local ? 'http://localhost:' + (process.env.PORT || 3000) : PROD_URL)).replace(/\/+$/, '');
if (!base) { console.error('正式環境要給平台網址：APP_URL=https://你的網址 npm run admin-rescue，或加 --base https://你的網址'); process.exit(2); }

const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randId = (prefix, n = 16) => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(n)), b => B62[b % 62]).join('')}`;
const sha256 = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const who = `${os.userInfo().username}@${os.hostname()}`.replace(/[^\w.@-]/g, '_').slice(0, 80);
// 平台管理員：跟 src/membership.js 的 PLATFORM_SQL 同一個條件（帳號是平台管理員且啟用），再加上人是啟用中的
// （登入端也只放行這些人）。已移出工作區的平台管理員一樣救得到。
// 不把名字拼進 SQL：先取整份名單、再在這裡挑（D1 版只能用字串下指令）。
const PLATFORM_ADMINS_SQL = "SELECT p.id, p.name FROM participants p JOIN accounts a ON a.id = p.account_id WHERE a.platform_role = 'admin' AND a.status = 'active' AND p.kind = 'human' AND p.status = 'active' ORDER BY p.created_at, p.id";
const wantName = args.includes('--name') ? (opt('--name') || '').trim() : null;
if (wantName === '' || wantName?.startsWith('--')) { console.error('--name 後面要接平台管理員的名字，例如：npm run admin-rescue -- --name 林志明'); process.exit(2); }

// 挑要救的平台管理員；挑不出來（沒有、多位沒指定、指定的不是）就說明原因並回傳 null
function choose(admins) {
  const list = () => admins.map(a => `  ${a.name}`).join('\n');
  if (!admins.length) { console.error('平台還沒有平台管理員（或平台管理員的帳號都停用了），沒有人可以救。'); return null; }
  if (wantName !== null) {
    const hit = admins.find(a => a.name === wantName);
    if (!hit) console.error(`「${wantName}」不是啟用中的平台管理員。救援連結只給平台管理員，現在的平台管理員：\n${list()}`);
    return hit || null;
  }
  if (admins.length === 1) return admins[0];
  console.error(`有 ${admins.length} 位平台管理員，請用 --name 指定要救誰（例如 npm run admin-rescue -- --name ${admins[0].name}）：\n${list()}`);
  return null;
}

// 正式環境：透過 wrangler 對 D1 下指令（跟 scripts/migrate.js 一樣用 --command）
function d1(sql) {
  const win = process.platform === 'win32';
  const arg = win ? `"${sql.replace(/"/g, '\\"')}"` : sql;
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'aigile-switch', '--remote', '--json', '--command', arg], { cwd: ROOT, shell: win, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); throw new Error('wrangler 執行失敗：要有這個 Cloudflare 帳號的部署權限（npx wrangler login）'); }
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  return out.flatMap(x => x.results || []);
}

const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
const now = Date.now();
const hash = await sha256(token);
const linkId = randId('rsc'), noticeId = randId('ntc');
let admin;
const dataDir = path.resolve(opt('--local') && !opt('--local').startsWith('--') ? opt('--local') : path.join(ROOT, 'data'));
if (local && (process.env.DATABASE_URL || process.env.AIGILE_TEST_PG_URL)) { // 本機版用 Postgres（DATABASE_URL，跟 server.js 同一組設定）
  const { openPgDb, pgTarget } = await import('../src/db-pg.js');
  const pg = pgTarget(process.env, dataDir);
  const db = await openPgDb(pg.url, { legacyProjects: false, schema: pg.schema, max: 1 });
  try {
    admin = choose(await db.all(PLATFORM_ADMINS_SQL));
    if (admin) await db.batch([
      ['INSERT INTO rescue_links (id, token_hash, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)', [linkId, hash, admin.id, who, now, now + TTL_MS]],
      ["INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,'rescue_link',?,?)", [noticeId, admin.id, who, now]],
    ]);
  } finally { await db.close(); }
} else if (local) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(dataDir, 'switch.db');
  if (!fs.existsSync(file)) throw new Error('找不到資料庫：' + file);
  const db = new DatabaseSync(file);
  try {
    admin = choose(db.prepare(PLATFORM_ADMINS_SQL).all());
    if (admin) {
      db.prepare('INSERT INTO rescue_links (id, token_hash, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(linkId, hash, admin.id, who, now, now + TTL_MS);
      db.prepare("INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,'rescue_link',?,?)").run(noticeId, admin.id, who, now);
    }
  } finally { db.close(); }
} else {
  admin = choose(d1(PLATFORM_ADMINS_SQL));
  // 值都是這支程式產生的（id、雜湊、時間、已過濾的主機名稱）或從資料庫讀來的 id，沒有外部輸入
  if (admin) d1(`INSERT INTO rescue_links (id, token_hash, participant_id, created_by, created_at, expires_at) VALUES ('${linkId}', '${hash}', '${admin.id}', '${who}', ${now}, ${now + TTL_MS}); `
    + `INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES ('${noticeId}', '${admin.id}', 'rescue_link', '${who}', ${now});`);
}
if (!admin) process.exit(2); // 沒有產生連結（原因上面印過了）
console.log(`一次性平台管理員登入連結（15 分鐘有效，用一次就失效）：\n${base}/rescue/${token}\n`);
console.log(`平台管理員：${admin.name}。已記錄（${who}，${new Date(now).toLocaleString('zh-TW')}），並在他的收件匣發安全通知。`);
