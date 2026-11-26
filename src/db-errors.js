// PostgreSQL 會給唯一索引名稱，SQLite 只會列出欄位，D1 還會在訊息前後加上錯誤碼。
export function isUniqueConstraintViolation(error, { constraint, columns }) {
  if (error?.code === '23505') return error.constraint === constraint;
  const failedColumns = String(error?.message ?? '').match(/(?:^|: )UNIQUE constraint failed: ([^:\r\n]+)/i)?.[1];
  return failedColumns === columns.join(', ');
}
// 資料表不存在（還沒跑資料庫升級）。PostgreSQL 42P01；SQLite、D1「no such table」
export function isMissingTable(error) {
  return error?.code === '42P01' || /no such table/i.test(String(error?.message ?? ''));
}
// 違反資料表的約束（唯一、CHECK、NOT NULL 任一）。PostgreSQL 23505／23514／23502；SQLite、D1「XXX constraint failed」
export function isConstraintViolation(error) {
  if (['23505', '23514', '23502'].includes(error?.code)) return true;
  return /(UNIQUE|CHECK|NOT NULL) constraint failed/i.test(String(error?.message ?? ''));
}
// 違反 NOT NULL（table：哪張表）。PostgreSQL 給錯誤碼與表名；SQLite、D1 只在訊息裡寫「表.欄位」
export function isNotNullViolation(error, table) {
  if (error?.code === '23502') return !table || error.table === table;
  const t = String(error?.message ?? '').match(/NOT NULL constraint failed: ([^.\s]+)\./i)?.[1];
  return !!t && (!table || t === table);
}
