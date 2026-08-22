export type ResourceStats = { created: number; updated: number; skipped: number; rejected: number };

export type ReconciliationReport = {
  source: Record<string, number>;
  targetBefore: Record<string, number>;
  targetAfter: Record<string, number>;
  expectedDelta: Record<string, number>;
  actualDelta: Record<string, number>;
  mismatches: Array<{ resource: string; expected: number; actual: number }>;
  relations: Record<string, number>;
};

export function buildReconciliation(input: {
  dryRun: boolean;
  resources: Record<string, ResourceStats>;
  targetBefore: Record<string, number>;
  targetAfter: Record<string, number>;
  relations: Record<string, number>;
}): ReconciliationReport {
  const resourceNames = new Set([...Object.keys(input.resources), ...Object.keys(input.targetBefore), ...Object.keys(input.targetAfter)]);
  const source: Record<string, number> = {};
  const expectedDelta: Record<string, number> = {};
  const actualDelta: Record<string, number> = {};
  const mismatches: ReconciliationReport["mismatches"] = [];

  for (const resource of resourceNames) {
    const stats = input.resources[resource] ?? { created: 0, updated: 0, skipped: 0, rejected: 0 };
    source[resource] = stats.created + stats.updated + stats.skipped + stats.rejected;
    expectedDelta[resource] = input.dryRun ? 0 : stats.created;
    actualDelta[resource] = (input.targetAfter[resource] ?? 0) - (input.targetBefore[resource] ?? 0);
    if (actualDelta[resource] !== expectedDelta[resource]) mismatches.push({ resource, expected: expectedDelta[resource], actual: actualDelta[resource] });
  }

  return { source, targetBefore: input.targetBefore, targetAfter: input.targetAfter, expectedDelta, actualDelta, mismatches, relations: input.relations };
}
