import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

const SCRYPT_KEY_LENGTH = 64;

function deriveKey(secret: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(secret, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

function encryptionKey(): Buffer {
  const raw = config.encryptionKey();
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return decoded;
}

export async function hashSecret(secret: string): Promise<string> {
  if (!secret) throw new Error("Cannot hash an empty secret");
  const salt = randomBytes(16);
  const digest = await deriveKey(secret, salt, SCRYPT_KEY_LENGTH, { N: 16_384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const [, n, r, p, saltText, digestText] = encoded.split("$");
  if (!n || !r || !p || !saltText || !digestText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = await deriveKey(secret, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function signValue(value: string): string {
  return createHmac("sha256", config.sessionSecret()).update(value, "utf8").digest("base64url");
}

export function verifySignedValue(value: string, signature: string): boolean {
  const expected = signValue(value);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSecret(encoded: string): string {
  const [version, ivText, tagText, ciphertextText] = encoded.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Unsupported encrypted secret format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}
