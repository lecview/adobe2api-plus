import { REQUIRED_MIGRATION, schemaIsReady } from "@/lib/schema";

describe("schema readiness", () => {
  it("requires the expected completed migration", () => {
    expect(schemaIsReady([{ migration_name: REQUIRED_MIGRATION, finished_at: new Date(), rolled_back_at: null }])).toBe(true);
    expect(schemaIsReady([{ migration_name: "0000_old", finished_at: new Date(), rolled_back_at: null }])).toBe(false);
    expect(schemaIsReady([{ migration_name: REQUIRED_MIGRATION, finished_at: null, rolled_back_at: null }])).toBe(false);
    expect(schemaIsReady([{ migration_name: REQUIRED_MIGRATION, finished_at: new Date(), rolled_back_at: new Date() }])).toBe(false);
  });
});
