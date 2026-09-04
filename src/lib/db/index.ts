import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { config } from "@/lib/config";
import * as schema from "./schema";

type Database = MySql2Database<typeof schema>;

const globalForDb = globalThis as unknown as {
  pool?: mysql.Pool;
};

let instance: Database | undefined;

export function getDb(): Database {
  if (instance) return instance;

  // 连接池只在第一次真正访问数据库时创建。这样 vitest、Next build 和
  // 纯配置模块可以安全导入数据库依赖，而不必在导入阶段提供部署环境变量。
  const pool =
    globalForDb.pool ??
    mysql.createPool({
      uri: config.databaseUrl(),
      connectionLimit: config.databasePoolConnectionLimit(),
      // DATETIME 列统一按 UTC 读写。应用容器保留 Asia/Shanghai 仅用于日志；
      // 若使用 mysql2 默认的 local 解析，已按 UTC 写入的无时区 DATETIME 会被错读 8 小时。
      timezone: "Z",
      enableKeepAlive: true,
      // 公网 MySQL 连接可能被中间设备静默断开：空闲连接超过 60s 主动关闭，
      // 下次使用时重建，避免拿到的连接已失效（"Failed query: rollback" 即因此产生）。
      idleTimeout: 60_000,
      connectTimeout: 10_000,
    });

  if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;
  instance = drizzle(pool, { schema, mode: "default" });
  return instance;
}

// 与 Prisma 旧入口保持同样的懒加载边界；方法调用时再绑定真实 Drizzle 实例。
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const value = Reflect.get(getDb(), property);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});

