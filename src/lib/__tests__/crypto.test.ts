import { decryptSecret, encryptSecret, hashSecret, hashToken, verifySecret } from "@/lib/crypto";

describe("crypto helpers", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.SESSION_SECRET = "s".repeat(40);
  });

  it("round trips encrypted values without storing plaintext", () => {
    const encrypted = encryptSecret("cookie-value");
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("cookie-value");
    expect(decryptSecret(encrypted)).toBe("cookie-value");
  });

  it("verifies password hashes", async () => {
    const hash = await hashSecret("correct horse battery staple");
    expect(await verifySecret("correct horse battery staple", hash)).toBe(true);
    expect(await verifySecret("wrong", hash)).toBe(false);
  });

  it("hashes API/session tokens deterministically without exposing the token", () => {
    const token = "api-key-secret";
    const digest = hashToken(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(hashToken(token));
    expect(digest).not.toContain(token);
  });
});
