import path from "node:path";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { config } from "@/lib/config";
import * as schema from "./db/schema";

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

/**
 * 幂等地确保数据库 schema 就绪（全新空库或旧库均可）：
 * 1. 用 drizzle migrator 执行 ./drizzle 下的迁移（建表 / 补列）。
 * 2. 补齐 Prisma 遗留的 `_prisma_migrations` 哨兵记录，让 Worker 启动检查通过。
 *
 * web 与 worker 会并发启动，因此用 MySQL 会话级命名锁 GET_LOCK 串行化；
 * 锁与迁移跑在同一条连接上，保证互斥生效。
 */
export async function ensureSchema(): Promise<void> {
  const conn = await mysql.createConnection({ uri: config.databaseUrl() });
  try {
    await conn.execute("SELECT GET_LOCK('adobe2api_schema_migrate', 120)");
    try {
      const db = drizzle(conn, { schema, mode: "default" });
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

      // Prisma → Drizzle 迁移遗留：`_prisma_migrations` 表非 drizzle 产物，
      // 需手动补建并写入哨兵迁移记录，否则 Worker 会因 "Required migration not applied" 退出。
      await conn.execute(
        [
          "CREATE TABLE IF NOT EXISTS `_prisma_migrations` (",
          "  `id` varchar(36) NOT NULL,",
          "  `checksum` varchar(64) NOT NULL,",
          "  `finished_at` datetime(3) NULL,",
          "  `migration_name` varchar(255) NOT NULL,",
          "  `logs` text NULL,",
          "  `rolled_back_at` datetime(3) NULL,",
          "  `started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
          "  `applied_steps_count` int unsigned NOT NULL DEFAULT 0,",
          "  PRIMARY KEY (`id`)",
          ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        ].join("\n"),
      );
      await conn.execute(
        [
          "INSERT IGNORE INTO `_prisma_migrations` (`id`, `checksum`, `finished_at`, `migration_name`, `rolled_back_at`, `applied_steps_count`)",
          "VALUES ('0007_expand_account_management', '0000000000000000000000000000000000000000000000000000000000000000', NOW(3), '0007_expand_account_management', NULL, 1)",
        ].join("\n"),
      );
    } finally {
      await conn.execute("SELECT RELEASE_LOCK('adobe2api_schema_migrate')");
    }
  } finally {
    await conn.end();
  }
}
