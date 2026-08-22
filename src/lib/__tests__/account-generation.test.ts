import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  decryptSecret: vi.fn(),
  getSystemSettings: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mocks.select,
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));
vi.mock("@/lib/crypto", () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettings: mocks.getSystemSettings }));
// 全局 sherlock 单例在测试环境不可用（db mock 无 systemSetting 表），
// selectAdobeGenerationAccount 应回退到 cookie 提取；此处 mock 返回空状态。
vi.mock("@/lib/adobe/sherlock", () => ({
  getGlobalSherlockStatus: vi.fn().mockResolvedValue({
    token: null,
    expiresAt: null,
    source: null,
    updatedAt: null,
    remainingSeconds: null,
    nextRefreshSeconds: null,
  }),
}));

import { selectAdobeGenerationAccount } from "@/lib/adobe/account";

type CandidateRow = {
  accountId: string;
  tokenId: string;
  encryptedAccessToken: string;
  refreshProfileId: string;
  profileAccountId: string;
  encryptedCookie: string;
};

function sherlock(label: string): string {
  return Buffer.from(JSON.stringify({ sid: `sid-${label}`, ark: `ark-${label}`, bfp: `bfp-${label}`, ftr: `ftr-${label}` })).toString("base64");
}

function accessToken(label: string, scopes = ["firefly_api"]): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: label, scope: scopes.join(",") })).toString("base64url");
  return `${header}.${payload}.fixture`;
}

function candidate(accountId: string, cookie = `cookie-${accountId}`): CandidateRow {
  return {
    accountId,
    tokenId: `token-id-${accountId}`,
    encryptedAccessToken: `token-secret-${accountId}`,
    refreshProfileId: `profile-${accountId}`,
    profileAccountId: accountId,
    encryptedCookie: cookie,
  };
}

function runningCountsQuery(rows: Array<{ accountId: string; count: number }> = []) {
  const where = vi.fn<(condition: unknown) => { groupBy: ReturnType<typeof vi.fn> }>(() => ({ groupBy: vi.fn().mockResolvedValue(rows) }));
  return {
    query: { from: vi.fn(() => ({ where })) },
    where,
  };
}

function generationCandidatesQuery(rows: CandidateRow[]) {
  return {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    })),
  };
}

function prepare(rows: CandidateRow[], running: Array<{ accountId: string; count: number }> = []) {
  const runningQuery = runningCountsQuery(running);
  mocks.select.mockReturnValueOnce(runningQuery.query).mockReturnValueOnce(generationCandidatesQuery(rows));
  return runningQuery.where;
}

function containsValue(input: unknown, expected: string, seen = new Set<object>()): boolean {
  if (input === expected) return true;
  if (!input || typeof input !== "object" || seen.has(input)) return false;
  seen.add(input);
  return Object.values(input).some((value) => containsValue(value, expected, seen));
}

describe("generation account selection", () => {
  beforeEach(() => {
    mocks.getSystemSettings.mockResolvedValue({ accountMaxConcurrency: 1 });
    mocks.decryptSecret.mockImplementation((value: string) => {
      if (value.startsWith("token-secret-")) return accessToken(value.slice("token-secret-".length));
      if (value.startsWith("cookie-")) return `sherlockToken=${sherlock(value.slice("cookie-".length))}`;
      throw new Error("unreadable secret");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("filters out accounts whose own Cookie has no complete Sherlock", async () => {
    prepare([candidate("invalid", "bad-cookie"), candidate("valid")]);
    mocks.decryptSecret.mockImplementation((value: string) => {
      if (value === "bad-cookie") return "foo=bar";
      if (value === "cookie-valid") return `sherlockToken=${sherlock("valid")}`;
      if (value === "token-secret-valid") return accessToken("valid");
      throw new Error("unreadable secret");
    });

    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({
      accountId: "valid",
      tokenId: "token-id-valid",
      refreshProfileId: "profile-valid",
      token: accessToken("valid"),
      arpSessionId: sherlock("valid"),
    });
  });

  it("randomizes after filtering and performs a fresh selection for every task", async () => {
    const rows = [candidate("a"), candidate("b")];
    prepare(rows);
    prepare(rows);
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999999);

    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({ accountId: "a", arpSessionId: sherlock("a") });
    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({ accountId: "b", arpSessionId: sherlock("b") });

    expect(random).toHaveBeenCalledTimes(2);
    expect(mocks.select).toHaveBeenCalledTimes(4);
  });

  it("reads the selected account Cookie again on the next task instead of using memory", async () => {
    prepare([candidate("a", "cookie-old")]);
    prepare([candidate("a", "cookie-new")]);
    mocks.decryptSecret.mockImplementation((value: string) => {
      if (value === "cookie-old") return `sherlockToken=${sherlock("old")}`;
      if (value === "cookie-new") return `sherlockToken=${sherlock("new")}`;
      if (value === "token-secret-a") return accessToken("a");
      throw new Error("unreadable secret");
    });

    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({ arpSessionId: sherlock("old") });
    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({ arpSessionId: sherlock("new") });
    expect(mocks.decryptSecret).toHaveBeenCalledWith("cookie-old");
    expect(mocks.decryptSecret).toHaveBeenCalledWith("cookie-new");
  });

  it("never falls back to another account when an explicit account is ineligible", async () => {
    prepare([candidate("a", "bad-cookie"), candidate("b")]);
    mocks.decryptSecret.mockImplementation((value: string) => {
      if (value === "bad-cookie") return "foo=bar";
      if (value === "cookie-b") return `sherlockToken=${sherlock("b")}`;
      if (value === "token-secret-b") return accessToken("b");
      throw new Error("unreadable secret");
    });

    await expect(selectAdobeGenerationAccount("a")).rejects.toMatchObject({ code: "adobe_account_unavailable" });
  });

  it("rejects a profile that is not owned by the token account", async () => {
    const mismatched = { ...candidate("a"), profileAccountId: "b" };
    prepare([mismatched]);
    await expect(selectAdobeGenerationAccount()).rejects.toMatchObject({ code: "adobe_account_unavailable" });
  });

  it("does not require tk_platform when Token and complete Sherlock belong to the account", async () => {
    prepare([candidate("without-tk-platform")]);
    mocks.decryptSecret.mockImplementation((value: string) => {
      if (value === "token-secret-without-tk-platform") return accessToken("without-tk-platform", ["firefly_api"]);
      if (value.startsWith("cookie-")) return `sherlockToken=${sherlock(value.slice("cookie-".length))}`;
      throw new Error("unreadable secret");
    });

    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({ accountId: "without-tk-platform" });
  });

  it("excludes accounts already attempted by the current task", async () => {
    prepare([candidate("a"), candidate("b")]);
    await expect(selectAdobeGenerationAccount(null, "job-current", new Set(["a"]))).resolves.toMatchObject({ accountId: "b" });
  });

  it("keeps accounts at their concurrency limit out of the random pool", async () => {
    prepare([candidate("a"), candidate("b")], [{ accountId: "a", count: 1 }]);
    await expect(selectAdobeGenerationAccount()).resolves.toMatchObject({ accountId: "b" });
  });

  it("requeues when every credential-eligible account is busy", async () => {
    prepare([candidate("a")], [{ accountId: "a", count: 1 }]);
    await expect(selectAdobeGenerationAccount()).rejects.toMatchObject({ code: "adobe_account_concurrency_limit" });
  });

  it("excludes the current job from account concurrency accounting", async () => {
    const where = prepare([candidate("a")]);
    await expect(selectAdobeGenerationAccount("a", "job-current")).resolves.toMatchObject({ accountId: "a" });
    expect(containsValue(where.mock.calls[0]?.[0], "job-current")).toBe(true);
  });
});
