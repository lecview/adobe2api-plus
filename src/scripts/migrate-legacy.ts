import { migrateLegacy } from "@/lib/migration/legacy";
import { config } from "@/lib/config";

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function main() {
  config.validateRuntime();
  const sourceRoot = argument("--source", argument("--root", "./adobe2api"));
  const dryRun = process.argv.includes("--dry-run");
  const report = await migrateLegacy(sourceRoot, dryRun);
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error("legacy migration failed", error instanceof Error ? error.message : "legacy migration failed");
  process.exitCode = 1;
});
