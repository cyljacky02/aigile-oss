// 工作區寫入排序與交易內斷言（ADR 0005）：共同維護同一個不變量的寫入，靠同一把工作區列鎖排隊，在交易內確認前提。
// 資料庫介面只有一次送出的批次交易（db.batch），沒有互動式交易、拿不到每句改了幾列；只有語句拋錯才會整批回復。
//
// 使用規則：
// 1. 只有共享不變量的寫入要加鎖（例：「未封存專案不同名」「最後一位管理員」「識別碼不重複」）。聊天、卡片等高頻寫入不加，免得變成全域瓶頸。
// 2. lockWorkspaceStmt 一定是同一批的第一句：之後的斷言與寫入都在拿著鎖的情況下做（PostgreSQL 的 READ COMMITTED 每句重新取快照，看得到前一個交易提交的結果）。
// 3. 加鎖順序固定：工作區 → 專案 → 其他資源。同一批要鎖多樣東西時一律照這個順序，避免死結。
// 4. 前提用 ensureStmt 在交易內斷言；交易前讀到的資料只用來準備候選值與錯誤訊息，不用來保證一致性。
// 5. 持久的東西（資料、事件、稽核、通知）同一批提交；即時事件與快取更新在提交成功之後才做。
// 6. 還原備份收尾完之前（restore_state 在）不得介入：writeOrdered 帶 restoring 時，工作區列鎖全部拿到後斷言不在還原中。
import { isNotNullViolation } from './db-errors.js';

// 工作區列鎖：對工作區這一列做一次沒有變化的 UPDATE。PostgreSQL 拿到列鎖直到交易結束；SQLite、D1 本來就一次只做一個寫入交易
export const lockWorkspaceStmt = workspaceId => ['UPDATE workspaces SET name = name WHERE id = ?', [workspaceId]];

// 交易內斷言：條件不成立時這句違反 app_settings 的 NOT NULL，整批回復；成立時什麼都不寫。放在要檢查的那句之後（或鎖之後、寫入之前）。
// 條件不得是 SQL NULL：NOT (NULL) 是 NULL，既不插入也不失敗，斷言等於沒做。條件一律寫成 EXISTS／NOT EXISTS，
// 或在比較會遇到 NULL 的欄位時明確寫 IS NULL／IS NOT NULL（例：x IS NOT NULL AND x <= ?）
export const ensureStmt = (cond, args = []) => [`INSERT INTO app_settings (key, value) SELECT NULL, NULL WHERE NOT (${cond})`, args];
// 這個錯誤是不是 ensureStmt 的斷言失敗（前提不成立、整批已回復）
export const isAssertionFailure = e => isNotNullViolation(e, 'app_settings');

// 還原備份中：app_settings 有 restore_state 這一列，從開始匯入到還原收尾全部做完才刪（src/backup.js）。
// 這段期間資料還沒修整完，會動到共同不變量的寫入（建立專案、改名、政策更新…）不得介入：鎖之後先斷言「不在還原中」
export const RESTORE_STATE_KEY = 'restore_state';
export const notRestoringStmt = () => ensureStmt(`NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '${RESTORE_STATE_KEY}')`);
// 現在是不是還原中（斷言失敗後用新鮮資料判斷原因；讀不到當作不是）
export const isRestoring = async db => !!(await db.get(`SELECT 1 AS x FROM app_settings WHERE key = '${RESTORE_STATE_KEY}'`).catch(() => null));

// 可以整批重試的交易錯誤：SQLite／D1 忙碌（別的程序正在寫，SQLITE_BUSY／SQLITE_LOCKED）、PostgreSQL 序列化失敗（40001）與死結（40P01）。
// 這些錯誤發生時整批已回復，重送同一批是安全的
export function isRetryableTxError(e) {
  if (e?.code === '40001' || e?.code === '40P01' || e?.code === '55P03') return true; // 55P03: a NOWAIT lock could not be acquired
  const primary = Number(e?.errcode) & 0xff; // node:sqlite 的 errcode 可能是延伸碼（例：517 SQLITE_BUSY_SNAPSHOT）
  if (primary === 5 || primary === 6) return true;
  return /\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b|database is locked|database table is locked/i.test(String(e?.message ?? ''));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const RETRY_WAITS_MS = [20, 60, 150]; // 重試前等多久（次數有限：全部用完還是忙碌就交給呼叫端回可重試的錯誤）

// 送出一批共同不變量的寫入：可重試的交易錯誤整批重試（次數有限）；斷言失敗回 false（什麼都沒寫）；其他錯誤照丟。
// 重試用完仍忙碌：丟 busy()（呼叫端給的可重試錯誤）。每次重試都是同一批語句，所以每個前提都會重新斷言。
// restoring（呼叫端給的可重試錯誤）：鎖之後加一句「不在還原中」的斷言；斷言失敗時重讀，正在還原就丟 restoring()
export async function writeOrdered(db, list, { busy, restoring, waits = RETRY_WAITS_MS } = {}) {
  let stmts = list.filter(Boolean); // 稽核等沒有要寫的回 null
  if (!stmts.length) return true;
  const lockSql = lockWorkspaceStmt('')[0];
  if (stmts[0][0] !== lockSql) throw new Error('共同不變量的寫入：第一句要是 lockWorkspaceStmt');
  if (restoring) {
    const firstNonLock = stmts.findIndex(([sql]) => sql !== lockSql);
    stmts.splice(firstNonLock < 0 ? stmts.length : firstNonLock, 0, notRestoringStmt());
  }
  for (let attempt = 0; ; attempt++) {
    try { await db.batch(stmts); return true; } catch (e) {
      if (isAssertionFailure(e)) { if (restoring && await isRestoring(db)) throw restoring(); return false; }
      if (!isRetryableTxError(e)) throw e;
      if (attempt >= waits.length) throw busy ? busy(e) : e;
      await sleep(waits[attempt]);
    }
  }
}
