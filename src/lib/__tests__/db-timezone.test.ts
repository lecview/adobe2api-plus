import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(() => ({ kind: "pool" })),
  drizzle: vi.fn(() => ({ kind: "database" })),
}));

vi.mock("mysql2/promise", () => ({
  default: { createPool: mocks.createPool },
}));

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: mocks.drizzle,
}));

vi.mock("@/lib/config", () => ({
  config: {
    databaseUrl: () => "mysql://user:password@mysql:3306/app",
    databasePoolConnectionLimit: () => 5,
  },
}));

import { getDb } from "@/lib/db";

describe("database timezone", () => {
  it("parses and writes DATETIME values as UTC", () => {
    expect(getDb()).toEqual({ kind: "database" });
    expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Z" }));
  });
});

