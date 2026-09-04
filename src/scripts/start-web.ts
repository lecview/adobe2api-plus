import { spawn } from "node:child_process";
import { config } from "@/lib/config";

async function main() {
  // 先校验运行配置，再把控制权交给 Next。错误发生时不会监听端口，
  // 同时避免把数据库 URL（尤其是密码）写入日志。
  config.validateRuntime();
  // 在监听端口前完成幂等迁移；迁移失败时进程直接退出，避免健康检查
  // 只验证到数据库连通性却把不完整 schema 误判为可用。
  const { ensureSchema } = await import("@/lib/schema");
  await ensureSchema();
  const nextBin = require.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => { child.kill(signal); });
  }
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
  });
  child.on("error", (error) => {
    console.error("web process failed to start", error.message);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error("web configuration validation failed", error instanceof Error ? error.message : "invalid configuration");
  process.exitCode = 1;
});
