// D1 驗證專用的 Worker 入口：只給 scripts/d1-verify.mjs 在本機 `wrangler dev --local` 跑，絕不部署（wrangler.toml 的 main 是 worker.js）。
// - 一般請求原樣交給正式的 worker.js（同一套 createApp、wrapD1(env.DB)）；只是把 env.DB 換成「量測＋注入失敗」的包裝：
//   每個請求記下呼叫 D1 幾次（get/all/run 各一次、batch 整批算一次，跟 D1 的「每次 Worker 執行的查詢數」同一個算法）、
//   單句最多綁幾個參數、單句 SQL 最長幾個位元組、一批最多幾句，放在回應標頭 x-d1-verify-stats（JSON）。
// - /__d1verify/* 控制端點（要帶這次執行的隨機 token，token 由 --var 傳入）：
//     POST /__d1verify/query  { sql, args }          → { rows }（直接用 env.DB，給 HTTP 表達不了的檢查與事後核對）
//     POST /__d1verify/batch  { stmts: [[sql,args]] } → { ok } 或 { ok:false, error, kind }（走 wrapD1 的 batch＝正式程式的交易語意）
//     POST /__d1verify/fault  { re, mode, times, sql?, args? } → 之後含符合 re 那一句的批次：mode=json＝在那一句後面插 SELECT json('{')（執行到才失敗）；
//                                                          dup＝再送一次同一句（INSERT 只有在第一次真的寫入後才會撞唯一，證明前面的句子執行過）；
//                                                          before＝這批送出前先另外提交 sql（模擬別人剛好先改）。作用 times 次；{ re:null } 解除
//     POST /__d1verify/fault-status                   → { hits, left }
import worker from '../worker.js';
import { wrapD1 } from '../src/db-d1.js';
import { isNotNullViolation, isConstraintViolation } from '../src/db-errors.js';

let current = null; // 目前這個請求的量測（驗證腳本量測的請求一次只送一個）
let fault = null; // { re: RegExp, mode, sql, args, left, hits }
const BOUND = new WeakMap(); // 包裝過的語句 → { real（D1 的語句）, sql, args }
const bytes = s => new TextEncoder().encode(s).length;

function metered(d1) {
  const note = (sql, args) => {
    if (!current) return;
    current.calls++;
    current.maxParams = Math.max(current.maxParams, args.length);
    current.maxSqlBytes = Math.max(current.maxSqlBytes, bytes(sql));
  };
  // wrapD1 只用 prepare(sql).bind(...).first/all/run 與 batch([...])
  const stmt = (real, sql, args) => {
    const s = {
      bind: (...a) => stmt(real.bind(...a), sql, a),
      first: (...a) => { note(sql, args); return real.first(...a); },
      all: (...a) => { note(sql, args); return real.all(...a); },
      run: (...a) => { note(sql, args); return real.run(...a); },
      raw: (...a) => { note(sql, args); return real.raw(...a); },
    };
    BOUND.set(s, { real, sql, args });
    return s;
  };
  return {
    prepare: sql => stmt(d1.prepare(sql), sql, []),
    async batch(stmts) {
      const items = stmts.map(s => BOUND.get(s) ?? { real: s, sql: '', args: [] });
      if (current) {
        current.calls++; current.batches++; current.maxBatch = Math.max(current.maxBatch, items.length);
        for (const { sql, args } of items) { current.maxParams = Math.max(current.maxParams, args.length); current.maxSqlBytes = Math.max(current.maxSqlBytes, bytes(sql)); }
      }
      let list = items.map(x => x.real);
      if (fault && fault.left > 0) {
        const i = items.findIndex(x => fault.re.test(x.sql));
        if (i >= 0) {
          fault.hits++; fault.left--;
          if (fault.mode === 'before') await d1.prepare(fault.sql).bind(...fault.args).run(); // 交易前先提交另一個寫入（模擬別人剛好先改）
          else {
            const { sql, args } = items[i];
            const extra = fault.mode === 'dup' ? d1.prepare(sql).bind(...args) : d1.prepare("SELECT json('{') AS broken");
            list = [...list.slice(0, i + 1), extra, ...list.slice(i + 1)];
          }
        }
      }
      return d1.batch(list);
    },
  };
}

let meteredDb = null; // worker.js 只在第一次建立 app 時讀 env.DB：一定要給同一個物件
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// 錯誤分類只是方便閱讀；驗證腳本拿 error 原文用 src/db-errors.js 的同一套判斷再核對一次
const kindOf = e => (isNotNullViolation(e, 'app_settings') ? 'assertion' : !isConstraintViolation(e) ? 'other'
  : /CHECK constraint failed/i.test(String(e?.message)) ? 'check' : /UNIQUE constraint failed/i.test(String(e?.message)) ? 'unique' : 'not_null');

async function control(req, env, path) {
  if (!env.D1_VERIFY_TOKEN || req.headers.get('x-d1-verify-token') !== env.D1_VERIFY_TOKEN) return json({ error: 'forbidden' }, 403);
  const body = await req.json().catch(() => ({}));
  const db = wrapD1(env.DB);
  try {
    if (path === 'query') return json({ rows: await db.all(body.sql, ...(body.args || [])) });
    if (path === 'batch') {
      try { await db.batch(body.stmts || []); return json({ ok: true }); } catch (e) { return json({ ok: false, error: String(e?.message ?? e), kind: kindOf(e) }); }
    }
    if (path === 'fault') {
      const hits = fault?.hits ?? 0;
      fault = body.re ? { re: new RegExp(body.re), mode: ['dup', 'before'].includes(body.mode) ? body.mode : 'json', sql: body.sql, args: body.args || [], left: Number(body.times) || 1, hits: 0 } : null;
      return json({ ok: true, previousHits: hits });
    }
    if (path === 'fault-status') return json({ hits: fault?.hits ?? 0, left: fault?.left ?? 0 });
  } catch (e) { return json({ error: String(e?.message ?? e) }, 500); }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__d1verify/')) return control(request, env, url.pathname.slice('/__d1verify/'.length));
    meteredDb ??= metered(env.DB);
    const stats = { calls: 0, batches: 0, maxBatch: 0, maxParams: 0, maxSqlBytes: 0 };
    current = stats;
    const res = await worker.fetch(request, { ...env, DB: meteredDb }, ctx);
    if (current === stats) current = null;
    const out = new Response(res.body, res);
    out.headers.set('x-d1-verify-stats', JSON.stringify(stats));
    return out;
  },
};
