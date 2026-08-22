/**
 * 应用启动所需的最后一条 Prisma migration。
 * 新增 migration 时必须同步更新这个常量，避免旧 schema 被误报为 ready。
 */
export const REQUIRED_MIGRATION = "0007_expand_account_management";

export type MigrationStatusRow = {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
};

export function schemaIsReady(rows: MigrationStatusRow[], requiredMigration = REQUIRED_MIGRATION): boolean {
  const row = rows.find((item) => item.migration_name === requiredMigration);
  return Boolean(row?.finished_at && !row.rolled_back_at);
}
