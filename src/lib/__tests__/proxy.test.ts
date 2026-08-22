import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { issueSessionToken } from "@/lib/session-token";

function request(path: string, init: { headers?: HeadersInit } = {}) {
  return new NextRequest(`http://127.0.0.1:3111${path}`, init);
}

function redirectPath(response: Response) {
  return response.headers.get("location") ? new URL(response.headers.get("location")!).pathname + new URL(response.headers.get("location")!).search : null;
}

describe("Next.js proxy access boundaries", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "p".repeat(40);
  });

  it("redirects the root and unauthenticated admin pages", async () => {
    const root = await proxy(request("/"));
    expect(root.status).toBe(307);
    expect(redirectPath(root)).toBe("/admin");

    const admin = await proxy(request("/admin/jobs?tab=failed"));
    expect(admin.status).toBe(307);
    expect(redirectPath(admin)).toBe("/login?next=%2Fadmin%2Fjobs%3Ftab%3Dfailed");
  });

  it("returns JSON 401 for unauthenticated admin APIs", async () => {
    const response = await proxy(request("/api/admin/accounts"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
  });

  it("leaves the login route available regardless of JWT state", async () => {
    expect((await proxy(request("/login"))).status).toBe(200);

    const token = await issueSessionToken("session", "admin-id", "admin", 60);
    const response = await proxy(request("/login", { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } }));
    expect(response.status).toBe(200);
  });
});
