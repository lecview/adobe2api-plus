import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json(
      { ok: true, service: "adobe2api-plus" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, service: "adobe2api-plus" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
