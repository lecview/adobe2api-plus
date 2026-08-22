import { issueSessionToken, verifySessionToken } from "@/lib/session-token";
import { safeReturnPath } from "@/lib/auth";
import { assertTrustedMutation } from "@/lib/admin-api";

describe("admin session boundaries", () => {
  beforeEach(() => { process.env.SESSION_SECRET = "s".repeat(40); });

  it("rejects external return paths", () => {
    expect(safeReturnPath("https://evil.example")).toBe("/admin");
    expect(safeReturnPath("//evil.example")).toBe("/admin");
    expect(safeReturnPath("/admin/jobs")).toBe("/admin/jobs");
  });

  it("verifies signed session tokens and rejects tampering", async () => {
    const token = await issueSessionToken("sid", "user", "admin", 60);
    expect((await verifySessionToken(token))?.sub).toBe("user");
    expect(await verifySessionToken(`${token}x`)).toBeNull();
  });

  it("requires same-origin proof for admin mutations", () => {
    const sameOrigin = new Request("https://admin.example.test/api/admin/settings", {
      method: "PATCH",
      headers: { origin: "https://admin.example.test" },
    });
    expect(() => assertTrustedMutation(sameOrigin)).not.toThrow();

    const crossOrigin = new Request("https://admin.example.test/api/admin/settings", {
      method: "PATCH",
      headers: { origin: "https://evil.example.test" },
    });
    expect(() => assertTrustedMutation(crossOrigin)).toThrow("Request origin is not trusted");

    const nonBrowser = new Request("https://admin.example.test/api/admin/settings", {
      method: "PATCH",
      headers: { "x-csrf-token": "same-origin" },
    });
    expect(() => assertTrustedMutation(nonBrowser)).not.toThrow();

    const forwardedHost = new Request("http://localhost:3111/api/admin/settings", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1:3111", host: "127.0.0.1:3111" },
    });
    expect(() => assertTrustedMutation(forwardedHost)).not.toThrow();
  });
});
