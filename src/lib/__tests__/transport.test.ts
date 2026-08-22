import { RecordingAdobeTransport } from "@/lib/adobe/transport";

describe("AdobeTransport boundary", () => {
  it("records upload and download options for a replaceable test double", async () => {
    const transport = new RecordingAdobeTransport();
    await transport.upload("/upload", new Uint8Array([1, 2]), { token: "secret", timeoutMs: 500 });
    await transport.download("https://example.com/result.png");
    expect(transport.calls.map((call) => call.path)).toEqual(["/upload", "https://example.com/result.png"]);
    expect(transport.calls[0].timeoutMs).toBe(500);
  });
});
