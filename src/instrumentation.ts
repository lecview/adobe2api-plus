/**
 * Next.js instrumentation 钩子：server 启动时（next start）执行一次，
 * 确保数据库 schema 就绪（建表 / 补列 / Prisma 遗留哨兵）。
 *
 * web 与 worker 可能并发启动，ensureSchema 内部用 MySQL GET_LOCK 串行化，
 * 幂等，可安全重复调用。
 */
export async function register() {
  // 仅运行时 nodejs 阶段执行；跳过 next build（无 DATABASE_URL，且无需迁移）。
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE?.includes("build")) return;

  const { ensureSchema } = await import("./lib/schema");
  await ensureSchema().catch((error) => {
    console.error("schema migration failed", error instanceof Error ? error.message : error);
  });
}
