// PostgreSQL 會給唯一索引名稱，SQLite 只會列出欄位，D1 還會在訊息前後加上錯誤碼。
export function isUniqueConstraintViolation(error, { constraint, columns }) {
  if (error?.code === '23505') return error.constraint === constraint;
  const failedColumns = String(error?.message ?? '').match(/(?:^|: )UNIQUE constraint failed: ([^:\r\n]+)/i)?.[1];
  return failedColumns === columns.join(', ');
}
