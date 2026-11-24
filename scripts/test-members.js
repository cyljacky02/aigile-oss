// 測試用小幫手：專案成員端點（取代舊的 PUT /api/members/matrix 的 leaderOf／readOnlyIn）
// call 是各測試自己的 call(token, 路徑, method, body)；路徑不先編碼（各測試的 call 自己處理中文）
// 專案角色：admin＝專案管理員、member＝專案成員、viewer＝唯讀成員
export const membersPath = (pj, id) => `/api/projects/${pj}/members${id ? '/' + id : ''}`;
// 加入專案（可一次多位）；role 預設專案成員
export const addToProject = (call, token, pj, ids, role = 'member') => call(token, membersPath(pj), 'POST', { participantIds: [].concat(ids), role });
// 設定已在專案裡的人的專案角色
export const setProjectRole = (call, token, pj, id, role, extra = {}) => call(token, membersPath(pj, id), 'PUT', { role, ...extra });
// 移出專案（dryRun：只看會退回哪些卡）
export const removeFromProject = (call, token, pj, id, extra) => call(token, membersPath(pj, id), 'DELETE', extra);
export const listProjectMembers = (call, token, pj) => call(token, membersPath(pj));
// 舊測試的「指定 leader」：已在專案的人設成專案管理員；回第一個不是 200 的回應（都成功回最後一個）
export async function makeProjectAdmin(call, token, id, projects) {
  let last;
  for (const pj of [].concat(projects)) { last = await setProjectRole(call, token, pj, id, 'admin'); if (last.status !== 200) return last; }
  return last;
}
