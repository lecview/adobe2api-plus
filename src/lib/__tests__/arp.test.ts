import { describe, expect, it } from "vitest";
import { completeSherlockFromCookie, extractSherlockToken, parseSherlockToken } from "@/lib/adobe/arp";
import { AdobeClient } from "@/lib/adobe/client";
import { RecordingAdobeTransport } from "@/lib/adobe/transport";
import { resolveImageModel } from "@/lib/catalog";

const COMPLETE_SHERLOCK = Buffer.from(JSON.stringify({ sid: "sid", ark: "ark", bfp: "bfp", ftr: "ftr" })).toString("base64");

describe("Adobe Sherlock cookie parsing", () => {
  it("extracts sherlockToken from the start or middle of a Cookie", () => {
    expect(extractSherlockToken(`foo=bar; sherlockToken=${COMPLETE_SHERLOCK}; baz=qux`)).toBe(COMPLETE_SHERLOCK);
    expect(extractSherlockToken(`sherlockToken=${COMPLETE_SHERLOCK}`)).toBe(COMPLETE_SHERLOCK);
  });

  it("returns empty when sherlockToken is absent or empty", () => {
    expect(extractSherlockToken("foo=bar; baz=qux")).toBe("");
    expect(extractSherlockToken("sherlockToken=")).toBe("");
  });

  it("accepts only a complete four-field Sherlock payload", () => {
    const partial = Buffer.from(JSON.stringify({ sid: "sid", ark: "ark" })).toString("base64");
    expect(parseSherlockToken(COMPLETE_SHERLOCK)).toEqual({ sid: "sid", ark: "ark", bfp: "bfp", ftr: "ftr" });
    expect(parseSherlockToken(partial)).toBeNull();
    expect(parseSherlockToken("not-base64-json")).toBeNull();
    expect(completeSherlockFromCookie(`sherlockToken=${COMPLETE_SHERLOCK}`)).toBe(COMPLETE_SHERLOCK);
    expect(completeSherlockFromCookie(`sherlockToken=${partial}`)).toBe("");
  });
});

describe("AdobeClient arp injection", () => {
  it("sends the selected account's x-arp-session-id", async () => {
    const transport = new RecordingAdobeTransport({ status: 200, headers: { "x-override-status-link": "https://bks.example/v2/jobs/result/task-inject" }, data: { links: {} } });
    const client = new AdobeClient(transport);
    await client.submitImage({ token: "token", proxy: null, arpSessionId: COMPLETE_SHERLOCK }, { prompt: "p", model: resolveImageModel(), aspectRatio: "1:1", outputResolution: "2K" });
    expect((transport.calls[0]?.headers as Record<string, string>)["x-arp-session-id"]).toBe(COMPLETE_SHERLOCK);
  });

  it("fails before transport when no Sherlock is injected", async () => {
    const transport = new RecordingAdobeTransport({ status: 200, headers: { "x-override-status-link": "https://bks.example/v2/jobs/result/task-fallback" }, data: { links: {} } });
    const client = new AdobeClient(transport);
    await expect(client.submitImage({ token: "token", proxy: null }, { prompt: "p", model: resolveImageModel(), aspectRatio: "1:1", outputResolution: "2K" }))
      .rejects.toMatchObject({ code: "adobe_sherlock_unavailable", proxyEligible: false });
    expect(transport.calls).toHaveLength(0);
  });
});
