import { describe, expect, it } from "vitest";
import { assembleFtr, forterDeviceIdFromCookie, solvePow } from "@/lib/adobe/forter-mint";

describe("Forter PoW solver", () => {
  // 真实样本：num 为 md5(challenge + num) 末尾 3 位 "000" 的最小解（与浏览器/抓包逐一对齐）
  const vectors: Array<[string, number]> = [
    ["z26fHgFYcUI=", 2997], // 抓包 cdn123 + 审计 ftr -2997
    ["ECL7M0ED7vg=", 4910], // 审计 ftr -4910（抓包 3）
    ["YlT2C7CAUNA=", 2007], // 本次 guest 浏览器实测
    ["hhQbycaOKTU=", 1178], // 本次登录态浏览器重铸
  ];

  it("reproduces the exact nonce for every captured challenge", () => {
    for (const [challenge, expected] of vectors) {
      expect(solvePow(challenge, 3)).toBe(expected);
    }
  });

  it("solves higher difficulty (4 zeros) too", () => {
    expect(solvePow("z26fHgFYcUI=", 4).toString(16).length).toBeGreaterThan(0); // 只验证可解
  });
});

describe("Forter ftr assembly", () => {
  it("matches the captured real ftr shape byte-for-byte", () => {
    const ftr = assembleFtr("c6075547a01b45d8a937fc9f4bbd1e7e", "ECL7M0ED7vg=", 4910, {
      ts: 1786959838119,
      ex: "UDF43-m4",
      siteId: "31",
    });
    expect(ftr).toBe("c6075547a01b45d8a937fc9f4bbd1e7e_1786959838119__UDF43-m4_31ck_ECL7M0ED7vg=-4910-v2_tt");
  });

  it("uses stable defaults (site 31, ex UDF43-m4, _tt suffix)", () => {
    const ftr = assembleFtr("0123456789abcdef0123456789abcdef", "AAAA", 7);
    expect(ftr).toMatch(/^0123456789abcdef0123456789abcdef_\d+__UDF43-m4_31ck_AAAA-7-v2_tt$/);
  });
});

describe("forter device id extraction", () => {
  it("reads the device id from a forterToken cookie in the 6-segment ftr form", () => {
    const cookie = "foo=bar; forterToken=c6075547a01b45d8a937fc9f4bbd1e7e_1786959838119__UDF43-m4_31ck_X=-1-v2_tt; baz=1";
    expect(forterDeviceIdFromCookie(cookie)).toBe("c6075547a01b45d8a937fc9f4bbd1e7e");
  });

  it("reads the device id from the id,timestamp localStorage form", () => {
    expect(forterDeviceIdFromCookie("forterToken=c6075547a01b45d8a937fc9f4bbd1e7e,1786959838119")).toBe("c6075547a01b45d8a937fc9f4bbd1e7e");
  });

  it("returns empty when absent", () => {
    expect(forterDeviceIdFromCookie("foo=bar")).toBe("");
  });
});
