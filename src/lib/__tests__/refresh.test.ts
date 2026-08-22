import { AppError } from "@/lib/errors";
import { isRefreshProxyEligibleFailure } from "@/lib/adobe/refresh";

describe("Adobe refresh proxy failure classification", () => {
  it("honors an explicit non-eligible body failure", () => {
    expect(isRefreshProxyEligibleFailure(new AppError("adobe_transport_error", "body failed", 503, { kind: "body", proxyEligible: false }))).toBe(false);
  });

  it("keeps explicit proxy failures eligible", () => {
    expect(isRefreshProxyEligibleFailure(new AppError("adobe_transport_error", "proxy failed", 503, { kind: "proxy", proxyEligible: true }))).toBe(true);
  });
});
