import fs from 'node:fs';

// 遷移測試共用：1.0.0～1.0.2 的 src/schema.sql 原檔（固定一份在 scripts/fixtures，不從現在的 schema.sql 拿掉新欄位回推，
// 之後再加升級檔也不用改這裡）。那時附的升級檔只有 001：用它建表、標 001 已套，就是 1.0.x 的資料庫
export const schema10 = () => fs.readFileSync(new URL('./fixtures/schema-1.0.sql', import.meta.url), 'utf8');
// 001 之前的結構：1.0 的原檔拿掉 001 加的 is_admin
export const schemaPre001 = () => schema10().replace(/\n\s*is_admin INTEGER[^\n]*/, '');

// 遷移測試共用：把剛建好的最新資料庫改回「成員與權限」第一階段之前的樣子（docs/adr/0002）。
// 舊結構：participants.is_admin（單一管理員）、participants.projects（逗號字串的專案歸屬），
// app_settings 的 project_leaders／read_only／cross_roles 由各測試自己寫。沒有帳號、工作區、專案成員表，
// 008、009 都還沒套：之後用 openTestDb 重開會照順序套上（SQLite 與 Postgres 都可以）。
// 之後的升級在 workspaces 加的欄位（014 誰可以刪除自己的訊息）跟著表一起拿掉，也標成還沒套
export const PHASE1_MIGRATIONS = ['008_members_access.sql', '009_drop_legacy_members.sql'];
const WORKSPACE_MIGRATIONS = ['014_workspace_delete_policy.sql'];

export async function toPrePhase1(db) {
  for (const sql of ['DROP TABLE project_members', 'DROP TABLE accounts', 'DROP TABLE workspaces', 'DROP TABLE legacy_members',
    'ALTER TABLE participants DROP COLUMN account_id', 'ALTER TABLE participants DROP COLUMN workspace_id',
    'ALTER TABLE participants DROP COLUMN workspace_role', 'ALTER TABLE participants DROP COLUMN workspace_status',
    'ALTER TABLE projects DROP COLUMN workspace_id', 'ALTER TABLE projects DROP COLUMN visibility',
    'ALTER TABLE participants ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE participants ADD COLUMN projects TEXT NOT NULL DEFAULT ''",
    `DELETE FROM schema_migrations WHERE name IN (${[...PHASE1_MIGRATIONS, ...WORKSPACE_MIGRATIONS].map(n => `'${n}'`).join(', ')})`]) await db.run(sql);
}
