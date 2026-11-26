// 專案範本只提供選取時的本機預設值；建立和核准只讀表單提交的內容。
import { ADMIN_NOTICE } from './admin-notify.js';
import { AUDIT_ACTION, AUDIT_SCOPE } from './audit.js';
import { isMissingTable } from './db-errors.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { readVisibility } from './project-create.js';
import { activeMemberCond, reviewerCond } from './project-creation-requests.js';
import { readStatusList } from './statuses.js';
import { ensureStmt } from './write-order.js';

export const TEMPLATE_TABLE = 'project_templates';
export const templateNotReady = ApiError => new ApiError(503, 'PROJECT_TEMPLATES_NOT_READY', '專案範本還沒準備好（資料庫還沒升級），請稍後再試。', { retryAfter: 5 });
const nameOk = name => typeof name === 'string' && !!name.trim() && [...name].length <= 30 && !/[\r\n]/.test(name);
export function restoreTemplateProblem(row) {
  if (['workspace_id', 'id'].some(k => typeof row[k] !== 'string' || !row[k]) || !nameOk(row.name) || row.visibility == null)
    return '專案範本欄位不合法';
  try {
    const fail = msg => new Error(msg);
    readVisibility(row.visibility, fail);
    if (typeof row.statuses_json !== 'string') return '專案範本欄位不合法';
    const statuses = JSON.parse(row.statuses_json);
    if (!Array.isArray(statuses) || statuses.some(s => typeof s?.name !== 'string' || typeof s.category !== 'string' || typeof s.color !== 'string' || !s.color))
      return '專案範本欄位不合法';
    readStatusList(statuses, fail);
  } catch { return '專案範本欄位不合法'; }
  return null;
}

export function registerProjectTemplates({ route, db, ApiError, invalid, readJson, requireHuman, access, randId, nowIso, writeInWorkspace, auditLog, adminNotify }) {
  const base = '/api/workspace/project-templates', ws = DEFAULT_WORKSPACE;
  const active = 'workspace_id = ? AND retired_at IS NULL';
  const find = id => db.get(`SELECT id, name, visibility, statuses_json, retired_at FROM ${TEMPLATE_TABLE} WHERE workspace_id = ? AND id = ?`, ws, id);
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到可用的專案範本');
  const changed = () => new ApiError(409, 'TEMPLATE_CHANGED', '專案範本已變更或停用；請重新讀取後再試。');
  const toPublic = ({ id, name, visibility, statuses_json }) => ({ id, name, visibility, statuses: readStatusList(JSON.parse(statuses_json), msg => new Error(msg)) });
  const notAdmin = () => new ApiError(403, 'NOT_ADMIN', '你已經沒有工作區管理權，這次沒有存。');
  const holds = ({ cond, args }) => db.get(`SELECT 1 AS x WHERE ${cond}`, ...args);
  async function read(me, id) {
    const member = activeMemberCond(me.id, ws), admin = reviewerCond(me.id, ws);
    // 沒有符合的範本（含空清單）也回權限判斷；同一句查詢不會跨兩個資料庫快照。
    const rows = await db.all(`SELECT a.allowed, t.id, t.name, t.visibility, t.statuses_json
      FROM (SELECT CASE WHEN ${member.cond} OR ${admin.cond} THEN 1 ELSE 0 END AS allowed) a
      LEFT JOIN ${TEMPLATE_TABLE} t ON a.allowed = 1 AND t.workspace_id = ? AND t.retired_at IS NULL${id === undefined ? '' : ' AND t.id = ?'}
      ORDER BY t.name, t.id`, ...member.args, ...admin.args, ws, ...(id === undefined ? [] : [id]));
    if (!Number(rows[0].allowed)) throw new ApiError(403, 'FORBIDDEN', '此操作僅限工作區成員');
    return rows.filter(r => r.id !== null).map(toPublic);
  }
  const register = (method, suffix, fn) => route(method, base + suffix, async args => {
    requireHuman(args.me);
    try { return await fn(args); } catch (e) {
      if (isMissingTable(e)) throw templateNotReady(ApiError);
      throw e;
    }
  });
  register('GET', '', async ({ me }) => ({ items: await read(me) }));
  register('GET', '/:id', async ({ me, params }) => {
    const [template] = await read(me, params.id);
    if (!template) throw notFound();
    return template;
  });

  function readDefaults(body) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!nameOk(name)) throw invalid('範本名稱需為 1～30 字，不可換行');
    return { name, visibility: readVisibility(body.visibility, invalid), statuses: readStatusList(body.statuses, invalid) };
  }
  const sameDefaults = (a, b) => a.name === b.name && a.visibility === b.visibility && JSON.stringify(a.statuses) === JSON.stringify(b.statuses);
  async function snapshot(id, body) {
    const row = await find(id);
    if (!row) throw notFound();
    const expected = body?.expected;
    if (typeof expected?.name !== 'string' || typeof expected.visibility !== 'string' || !Array.isArray(expected.statuses))
      throw invalid('expected 須包含編輯前的範本名稱、可見度及看板狀態');
    // 比較讀取到的值；交易內再比對實際儲存的字串，防止在兩次讀寫之間被改動。
    const original = { ...readDefaults(expected), name: expected.name };
    if (row.retired_at !== null || !sameDefaults(original, toPublic(row))) throw changed();
    return row;
  }
  async function write(me, operation, { id, name }, stmt, original = null) {
    const admin = reviewerCond(me.id, ws);
    const list = [ensureStmt(admin.cond, admin.args)];
    if (original) list.push(ensureStmt(`EXISTS (SELECT 1 FROM ${TEMPLATE_TABLE} WHERE ${active} AND id = ? AND name = ? AND visibility = ? AND statuses_json = ?)`,
      [ws, id, original.name, original.visibility, original.statuses_json]));
    if (stmt) {
      const event = `PROJECT_TEMPLATE_${operation}`;
      const audit = auditLog.stmt({ actor: me, action: AUDIT_ACTION[event], scope: AUDIT_SCOPE.WORKSPACE, workspaceId: ws,
        target: { kind: 'project_template', id, name } });
      if (!audit) throw new ApiError(503, 'AUDIT_NOT_READY', '稽核紀錄還沒準備好（資料庫還沒升級），這次沒有處理；請稍後再試。', { retryAfter: 5 });
      list.push(stmt, audit, adminNotify.workspaceStmt({ workspaceId: ws, except: me.id, kind: ADMIN_NOTICE[event], detail: { a: me.name, t: name } }));
    }
    if (await writeInWorkspace(list)) return;
    if (!(await holds(admin))) throw notAdmin();
    if (original && await find(id)) throw changed();
    throw notFound();
  }
  const manage = (method, suffix, run) => register(method, suffix, async args => {
    await access.check(args.ctx, args.me, 'manage_workspace', 'workspace', { what: '管理專案範本' });
    return run(args);
  });
  manage('POST', '', async args => {
    const spec = readDefaults(await readJson(args.req)), id = randId('pt');
    await write(args.me, 'CREATE', { id, name: spec.name }, [`INSERT INTO ${TEMPLATE_TABLE} (workspace_id, id, name, visibility, statuses_json) VALUES (?,?,?,?,?)`,
      [ws, id, spec.name, spec.visibility, JSON.stringify(spec.statuses)]]);
    return { __status: 201, id, ...spec };
  });
  manage('PUT', '/:id', async args => {
    const { id } = args.params, body = await readJson(args.req);
    const row = await snapshot(id, body), spec = readDefaults(body);
    const stmt = sameDefaults(spec, toPublic(row)) ? null : [`UPDATE ${TEMPLATE_TABLE} SET name = ?, visibility = ?, statuses_json = ? WHERE ${active} AND id = ?`,
      [spec.name, spec.visibility, JSON.stringify(spec.statuses), ws, id]];
    await write(args.me, 'EDIT', { id, name: spec.name }, stmt, row);
    return { id, ...spec };
  });
  manage('DELETE', '/:id', async args => {
    const row = await snapshot(args.params.id, await readJson(args.req));
    await write(args.me, 'RETIRE', row, [`UPDATE ${TEMPLATE_TABLE} SET retired_at = ? WHERE ${active} AND id = ?`, [nowIso(), ws, row.id]], row);
    return { ok: true };
  });
}
