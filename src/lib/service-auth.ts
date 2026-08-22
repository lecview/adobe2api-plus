import { db } from "@/lib/db";
import { serviceApiKey } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { hashToken } from "@/lib/crypto";
import { AppError } from "@/lib/errors";

export async function requireServiceApiKey(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const supplied = bearer || request.headers.get("x-api-key")?.trim();
  if (!supplied) throw new AppError("unauthorized", "Invalid API key", 401);

  const [key] = await db
    .select()
    .from(serviceApiKey)
    .where(and(eq(serviceApiKey.keyHash, hashToken(supplied)), eq(serviceApiKey.active, true), isNull(serviceApiKey.revokedAt)))
    .limit(1);
  if (!key) throw new AppError("unauthorized", "Invalid API key", 401);
  await db.update(serviceApiKey).set({ lastUsedAt: new Date() }).where(eq(serviceApiKey.id, key.id));
  return key;
}

export async function createServiceApiKey(name: string) {
  const { createOpaqueToken, hashToken } = await import("@/lib/crypto");
  const raw = `adobe_${createOpaqueToken(24)}`;
  const keyHash = hashToken(raw);
  // MySQL 不支持 INSERT ... RETURNING，插入后按 keyHash 回查完整记录。
  await db.insert(serviceApiKey).values({ name, keyHash, prefix: raw.slice(0, 12) });
  const [record] = await db.select().from(serviceApiKey).where(eq(serviceApiKey.keyHash, keyHash)).limit(1);
  return { id: record.id, name: record.name, key: raw, prefix: record.prefix };
}
