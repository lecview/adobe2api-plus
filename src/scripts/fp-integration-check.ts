import { refreshGlobalSherlockToken, getGlobalSherlockStatus } from "@/lib/adobe/sherlock";
async function main() {
  const { token } = await refreshGlobalSherlockToken();
  console.log("minted token:", token.slice(0, 40) + `...(${token.length} chars)`);
  const status = await getGlobalSherlockStatus();
  console.log("status:", JSON.stringify({ source: status.source, remainingSeconds: status.remainingSeconds, updatedAt: status.updatedAt?.toISOString() }));
  process.exit(0);
}
void main();
