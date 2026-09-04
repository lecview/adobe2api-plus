import { config } from "@/lib/config";
import { ensureSchema } from "@/lib/schema";

async function main() {
  config.validateRuntime();
  await ensureSchema();
  console.log("database schema is ready");
}

main().catch((error) => {
  console.error("database migration failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
