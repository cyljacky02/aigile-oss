// 專案範本只提供選取時的本機預設值；建立和核准只讀表單提交的內容。
import { isMissingTable } from './db-errors.js';
import { DEFAULT_WORKSPACE } from './membership.js';
import { readVisibility } from './project-create.js';
import { activeMemberCond, reviewerCond } from './project-creation-requests.js';
import { readStatusList } from './statuses.js';
import { ensureStmt } from './write-order.js';

export const TEMPLATE_TABLE = 'project_templates';
const nameOk = name => typeof name === 'string' && !!name.trim() && [...name].length <= 30 && !/[\r\n]/.test(name);
export function restoreTemplateProblem(row) {
  if (['workspace_id', 'id'].some(k => typeof row[k] !== 'string' || !row[k]) || !nameOk(row.name) || row.visibility == null)
    return '專案範本欄位不合法';
  try {
    const fail = msg => new Error(msg);
    readVisibility(row.visibility, fail);
    readStatusList(JSON.parse(row.statuses_json), fail);
  } catch { return '專案範本欄位不合法'; }
  return null;
}

export function registerProjectTemplates({ route, db, ApiError, invalid, readJson, requireHuman, access, randId, nowIso, writeInWorkspace }) {
  const base = '/api/workspace/project-templates', ws = DEFAULT_WORKSPACE;
  const active = 'workspace_id = ? AND retired_at IS NULL';
  const columns = 'id, name, visibility, statuses_json';
  const toPublic = ({ id, name, visibility, statuses_json }) => ({ id, name, visibility, statuses: JSON.parse(statuses_json) });
  const find = id => db.get(`SELECT ${columns} FROM ${TEMPLATE_TABLE} WHERE ${active} AND id = ?`, ws, id);
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到可用的專案範本');
  const notAdmin = () => new ApiError(403, 'NOT_ADMIN', '你已經沒有工作區管理權，這次沒有存。');
  const holds = ({ cond, args }) => db.get(`SELECT 1 AS x WHERE ${cond}`, ...args);
  const member = async me => {
    if (!(await holds(activeMemberCond(me.id, ws))) && !(await holds(reviewerCond(me.id, ws))))
      throw new ApiError(403, 'FORBIDDEN', '此操作僅限工作區成員');
  };
  const register = (method, suffix, fn) => route(method, base + suffix, async args => {
    requireHuman(args.me);
    try { return await fn(args); } catch (e) {
      if (isMissingTable(e)) throw new ApiError(503, 'PROJECT_TEMPLATES_NOT_READY', '專案範本還沒準備好（資料庫還沒升級），請稍後再試。', { retryAfter: 5 });
      throw e;
    }
  });
  register('GET', '', async ({ me }) => {
    await member(me);
    return { items: (await db.all(`SELECT ${columns} FROM ${TEMPLATE_TABLE} WHERE ${active} ORDER BY name, id`, ws)).map(toPublic) };
  });
  register('GET', '/:id', async ({ me, params }) => {
    await member(me);
    const row = await find(params.id);
    if (!row) throw notFound();
    return toPublic(row);
  });

  function readDefaults(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!nameOk(name)) throw invalid('範本名稱需為 1～30 字，不可換行');
    return { name, visibility: readVisibility(body.visibility, invalid), statuses: readStatusList(body.statuses, invalid) };
  }
  async function write(me, id, stmt) {
    const admin = reviewerCond(me.id, ws);
    const exists = ensureStmt(`EXISTS (SELECT 1 FROM ${TEMPLATE_TABLE} WHERE ${active} AND id = ?)`, [ws, id]);
    if (await writeInWorkspace([ensureStmt(admin.cond, admin.args), ...(id ? [exists] : []), stmt])) return;
    if (!(await holds(admin))) throw notAdmin();
    throw notFound();
  }
  const manage = (method, suffix, run) => register(method, suffix, async args => {
    await access.check(args.ctx, args.me, 'manage_workspace', 'workspace', { what: '管理專案範本' });
    return run(args);
  });
  manage('POST', '', async args => {
    const spec = readDefaults(await readJson(args.req)), id = randId('pt');
    await write(args.me, null, [`INSERT INTO ${TEMPLATE_TABLE} (workspace_id, id, name, visibility, statuses_json) VALUES (?,?,?,?,?)`,
      [ws, id, spec.name, spec.visibility, JSON.stringify(spec.statuses)]]);
    return { __status: 201, id, ...spec };
  });
  manage('PUT', '/:id', async args => {
    const { id } = args.params, spec = readDefaults(await readJson(args.req));
    await write(args.me, id, [`UPDATE ${TEMPLATE_TABLE} SET name = ?, visibility = ?, statuses_json = ? WHERE ${active} AND id = ?`,
      [spec.name, spec.visibility, JSON.stringify(spec.statuses), ws, id]]);
    return { id, ...spec };
  });
  manage('DELETE', '/:id', async args => {
    const { id } = args.params;
    await write(args.me, id, [`UPDATE ${TEMPLATE_TABLE} SET retired_at = ? WHERE ${active} AND id = ?`, [nowIso(), ws, id]]);
    return { ok: true };
  });
}
