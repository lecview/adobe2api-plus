import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { config } from "@/lib/config";

export type SessionPayload = JWTPayload & { sid: string; sub: string; username: string };

function signingKey(): Uint8Array {
  return new TextEncoder().encode(config.sessionSecret());
}

export async function issueSessionToken(sessionId: string, userId: string, username: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ sid: sessionId, sub: userId, username })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(signingKey());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const result = await jwtVerify(token, signingKey(), { algorithms: ["HS256"] });
    const payload = result.payload;
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string" || typeof payload.username !== "string") return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
