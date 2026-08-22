import { buildReconciliation } from "@/lib/migration/reconciliation";

describe("legacy migration reconciliation", () => {
  it("distinguishes a dry-run prediction from the unchanged target", () => {
    const result = buildReconciliation({
      dryRun: true,
      resources: { entities: { created: 2, updated: 0, skipped: 1, rejected: 1 } },
      targetBefore: { entities: 4 },
      targetAfter: { entities: 4 },
      relations: { entities_without_account: 0 },
    });
    expect(result.source.entities).toBe(4);
    expect(result.expectedDelta.entities).toBe(0);
    expect(result.actualDelta.entities).toBe(0);
    expect(result.mismatches).toHaveLength(0);
  });

  it("reports a broken write delta and preserves relation findings", () => {
    const result = buildReconciliation({
      dryRun: false,
      resources: { media_assets: { created: 2, updated: 0, skipped: 0, rejected: 1 } },
      targetBefore: { media_assets: 5 },
      targetAfter: { media_assets: 6 },
      relations: { media_without_job: 1 },
    });
    expect(result.mismatches).toEqual([{ resource: "media_assets", expected: 2, actual: 1 }]);
    expect(result.relations.media_without_job).toBe(1);
  });
});
