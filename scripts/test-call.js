// 測試用小幫手：在同一個程式裡呼叫 createApp 回傳的 app（不開伺服器）
// call(token, 路徑, method, body, raw) → { status, body（JSON，不是 JSON 時 null）, text }
// raw＝true：body 原樣送出（上傳檔案），不加 Content-Type: application/json
// 用法：const call = appCaller(app);
export function appCaller(app) {
  return async (token, p, method = 'GET', body, raw = false) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 下載是檔案內容 */ }
    return { status: r.status, body: json, text };
  };
}
