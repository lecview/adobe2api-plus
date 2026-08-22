import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceApiKey } from "@/lib/db/schema";
import { createServiceApiKey } from "@/lib/service-auth";
import { requireAdminRequest, handleAdminError } from "@/lib/admin-api";
import { getRequestId } from "@/lib/errors";

export async function GET(request: Request) {
  try {
    await requireAdminRequest(request);
    const keys = await db
      .select({
        id: serviceApiKey.id,
        name: serviceApiKey.name,
        prefix: serviceApiKey.prefix,
        active: serviceApiKey.active,
        createdAt: serviceApiKey.createdAt,
        revokedAt: serviceApiKey.revokedAt,
        lastUsedAt: serviceApiKey.lastUsedAt,
      })
      .from(serviceApiKey)
      .orderBy(desc(serviceApiKey.createdAt));
    return Response.json({ keys, request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

export async function POST(request: Request) {
  try {
    await requireAdminRequest(request);
    const { name } = z.object({ name: z.string().trim().min(1).max(128) }).parse(await request.json());
    const created = await createServiceApiKey(name);
    return Response.json({ ...created, request_id: getRequestId(request) }, { status: 201 });
  } catch (error) { return handleAdminError(error, request); }
}

export async function DELETE(request: Request) {
  try {
    await requireAdminRequest(request);
    const { id } = z.object({ id: z.string() }).parse(await request.json());
    await db.update(serviceApiKey).set({ active: false, revokedAt: new Date() }).where(eq(serviceApiKey.id, id));
    const [key] = await db.select().from(serviceApiKey).where(eq(serviceApiKey.id, id)).limit(1);
    return Response.json({ revoked: true, id: key!.id, request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}
