import models from "@/lib/contracts/fixtures/models.response.json";
import error from "@/lib/contracts/fixtures/error.response.json";

describe("public contract fixtures", () => {
  it("keeps the model and OpenAI error envelopes machine-readable", () => {
    expect(models.object).toBe("list");
    expect(models.data[0]?.object).toBe("model");
    expect(models.data[0]?.owned_by).toBe("adobe2api");
    expect(error.error.type).toBe("invalid_request_error");
    expect(error.error.request_id).toBeTruthy();
  });
});
