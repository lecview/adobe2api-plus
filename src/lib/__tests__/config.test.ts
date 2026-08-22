import { config } from "@/lib/config";

describe("database configuration", () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it("rejects a missing DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    expect(() => config.databaseUrl()).toThrow("DATABASE_URL");
  });

  it("rejects a non-mysql scheme", () => {
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/adobe";
    expect(() => config.databaseUrl()).toThrow("mysql");
  });

  it("rejects a URL without a database name", () => {
    process.env.DATABASE_URL = "mysql://u:p@127.0.0.1:3306";
    expect(() => config.databaseUrl()).toThrow("database name");
  });

  it("accepts a valid MySQL URL", () => {
    process.env.DATABASE_URL = "mysql://u:p@203.0.113.10:3306/adobe";
    expect(config.databaseUrl()).toContain("203.0.113.10");
  });

  it("validates deployment configuration before the process listens", () => {
    process.env.DATABASE_URL = "mysql://u:p@127.0.0.1:3306/adobe";
    process.env.SESSION_SECRET = "s".repeat(32);
    process.env.ENCRYPTION_KEY = "e".repeat(16);
    expect(() => config.validateRuntime()).not.toThrow();
  });
});
