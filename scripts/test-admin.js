// 測試用小幫手：管理員的「裝置登入」，給要呼叫管理端點（任免管理員、停用帳號…）的測試用
// 敏感管理操作要這台裝置剛再驗證過；登入碼 Token（POST /api/join 拿到的）沒有裝置，過不了再驗證。
// adminSession 先幫這個人設帳號密碼（已設過就沿用），用帳號密碼登入拿 dv_ 裝置 Token，再呼叫 POST /api/auth/reauth；
// 還沒有再驗證端點時那裡回 404，略過不算錯。所以測試從頭用這個 Token，再驗證功能上線前後都能過。
// call 是各測試自己的 call(token, 路徑, method, body) → { status, body }；joinToken 是這個人目前的登入 Token
// 用法：
//   const wang = (await call(null, '/api/join', 'POST', { name: '王小美', role: 'PO' })).body;
//   const boss = await adminSession(call, wang.token);   // boss.token 拿去呼叫管理端點
// 注意：用帳號密碼登入會留一則 password_login 帳號提醒；數帳號提醒的測試要照 kind 篩選
// 再驗證 10 分鐘後過期：測試裡改時間後要再呼叫一次 reauth(call, boss)
export async function adminSession(call, joinToken, { username, password = 'pass-word-1' } = {}) {
  const cred = await call(joinToken, '/api/me/password');
  if (cred.status !== 200) throw new Error(`adminSession：讀不到帳號密碼設定（${cred.status} ${JSON.stringify(cred.body)}）`);
  const user = cred.body.set ? cred.body.username : username || `adm-${Math.random().toString(36).slice(2, 10)}`;
  if (!cred.body.set) {
    const r = await call(joinToken, '/api/me/password', 'PUT', { username: user, newPassword: password, newPasswordAgain: password });
    if (r.status !== 200) throw new Error(`adminSession：設定帳號密碼失敗（${r.status} ${JSON.stringify(r.body)}）`);
  }
  const login = await call(null, '/api/auth/password', 'POST', { username: user, password });
  if (login.status !== 200) throw new Error(`adminSession：帳號密碼登入失敗（${login.status} ${JSON.stringify(login.body)}）`);
  const session = { token: login.body.token, username: user, password, participantId: login.body.participant?.participantId };
  await reauth(call, session);
  return session;
}
// 再驗證這台裝置；還沒有再驗證端點（404）時回 false
export async function reauth(call, { token, password }) {
  const r = await call(token, '/api/auth/reauth', 'POST', { password });
  if (r.status === 404) return false;
  if (r.status !== 200) throw new Error(`adminSession：再驗證失敗（${r.status} ${JSON.stringify(r.body)}）`);
  return true;
}
