import { redact } from "@/lib/redaction";
import { safeObjectPath } from "@/lib/media";

describe("security boundaries", () => {
  beforeEach(() => {
    process.env.MEDIA_ROOT = "/tmp/adobe2api-plus-test-media";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  });

  it("redacts nested credentials and database URLs", () => {
    const output = redact({ token: "secret", nested: { database_url: "mysql://u:p@host/db" }, host: "safe" }) as Record<string, unknown>;
    expect(output.token).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).database_url).toBe("[REDACTED]");
    expect(output.host).toBe("safe");
  });

  it("rejects media path traversal", () => {
    expect(() => safeObjectPath("../../etc/passwd")).toThrow();
    expect(safeObjectPath("jobs/task/result.png")).toContain("adobe2api-plus-test-media");
  });
});

