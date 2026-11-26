// Cloudflare D1 轉接：包成 core.js 需要的介面。
// D1 的 BLOB 參數要用 ArrayBuffer；Uint8Array（含 subarray 視圖）在此轉成剛好大小的 ArrayBuffer。
// D1 的 SQLite 限制（比一般的 SQLite 嚴；超過時 D1 回錯、整句不執行）。在本機 D1（wrangler 4.168.0 --local）實測（scripts/d1-verify.mjs、docs/d1-verification.md），
// 與 https://developers.cloudflare.com/d1/platform/limits/ 寫的一致的部分：每句 100 個綁定參數、每句 SQL 100,000 位元組、100 欄。
// 寫 SQL 時都要在這些限制內：例如一個複合 SELECT（UNION／UNION ALL…）最多 5 段（多列常值改用 VALUES）、LIKE 樣式最長 50 位元組。
// 鍵名是 node:sqlite 的 limits 選項：scripts/d1-sqlite-limits-test.js 用它開一個「套上 D1 限制」的 SQLite 跑主要流程
export const D1_SQLITE_LIMITS = Object.freeze({ compoundSelect: 5, variableNumber: 100, likePatternLength: 50, functionArg: 127, column: 100, sqlLength: 100_000 });

const toD1 = v => (ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);

export function wrapD1(d1) {
  const prep = (sql, args) => d1.prepare(sql).bind(...args.map(toD1));
  return {
    async get(sql, ...args) { return (await prep(sql, args).first()) ?? null; },
    async all(sql, ...args) { return (await prep(sql, args).all()).results; },
    async run(sql, ...args) { return { changes: (await prep(sql, args).run()).meta.changes }; },
    async batch(stmts) { await d1.batch(stmts.map(([sql, args]) => prep(sql, args))); }, // D1 batch 為交易
  };
}
