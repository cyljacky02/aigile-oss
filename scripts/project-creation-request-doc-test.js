// 文件測試（規格 #39「API 參考文件寫上新端點、欄位上限與錯誤代碼」）：docs/api-reference.md 涵蓋建立專案申請的
// 每一個端點（從程式的路由表讀）、每一個錯誤代碼（從程式丟的 ApiError 與權限模組的拒絕讀）、欄位上限、即時事件與錯誤附帶的欄位。
// 用法：node scripts/project-creation-request-doc-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const doc = read('docs/api-reference.md');
const src = read('src/project-creation-requests.js');
const access = read('src/access.js');
const has = (s, label) => assert.ok(doc.includes(s), `API 參考文件缺少${label}：${s}`);

// 端點：申請模組的每一條路由；工作區設定與切換預覽
const routes = [...src.matchAll(/route\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)].map(m => [m[1], m[2]]);
assert.ok(routes.length >= 6, '讀到申請模組的路由：' + JSON.stringify(routes));
for (const [method, p] of routes) assert.ok(new RegExp(`${method}[^\\n]{0,40}\`?${p.replace(/[?]/g, '\\?')}`).test(doc), `API 參考文件缺少端點：${method} ${p}`);
has('GET /api/workspace/settings/create-projects-preview', '端點');
has('createProjects?: members|approval|admins', '政策的三個值');

// 錯誤代碼：申請模組丟的、權限模組對建立專案申請動作的拒絕、建立邏輯與部署防護
const codes = new Set([...src.matchAll(/ApiError\(\d+, '([A-Z_]+)'/g)].map(m => m[1]));
for (const m of access.matchAll(/(?:request_project_creation|create_project|project_creation_request\w*)[^\n]*?d\.err\(\d+, '([A-Z_]+)'/g)) codes.add(m[1]);
for (const m of access.matchAll(/d\.err\(\d+, '(PROJECT_CREATION_REQUIRES_APPROVAL|CAN_CREATE_DIRECTLY|NOT_REQUESTER|NOT_REVIEWER)'/g)) codes.add(m[1]);
for (const c of ['NAME_TAKEN', 'SLUG_TAKEN', 'CODE_TAKEN', 'IDENTITY_NOT_READY', 'RESTORING', 'AUDIT_NOT_READY', 'BACKUP_ROW_INVALID', 'RESTORE_UNFINISHED', 'INVALID_REQUEST']) codes.add(c);
assert.ok(codes.size >= 18, '讀到的錯誤代碼：' + [...codes].join(', '));
for (const c of codes) has(`\`${c}\``, '錯誤代碼');
// 503（可重試）的都要在「錯誤與重試」表格
const table = doc.slice(doc.indexOf('## 5. 錯誤與重試'));
for (const c of ['PROJECT_CREATION_REQUESTS_NOT_READY', 'AUDIT_NOT_READY', 'IDENTITY_NOT_READY', 'RESTORING']) assert.ok(table.includes(`\`${c}\``), `錯誤與重試表格缺少 ${c}`);

// 欄位上限與分頁
for (const s of ['`requestId` 1–128 字', '`reason` 去頭尾空白後 1–200 字', '1–20 字', '`limit` 預設 50、最多 100', '`nextCursor`', '`pendingTotal`']) has(s, '欄位上限或分頁');
// 錯誤附帶的欄位、即時事件、AI
for (const s of ['`error.field`', '`error.state`', '`error.cancelCode`', '`stale`', 'AI 一律不能申請', '`canRequestProjectCreation`', '`canReviewProjectCreationRequests`', '`cancelledProjectCreationRequests`']) has(s, '說明');
assert.ok(!/正式環境還不能選/.test(doc), '「成員申請」已開放正式環境，不能再寫還不能選');
console.log('project-creation-request-doc-test：全部通過');
