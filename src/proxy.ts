import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { verifySessionToken } from "@/lib/session-token";

// 浏览器直连对外 API 的跨域（CORS）支持。
// OPTIONS 预检在此直接放行；对外路由的实际响应统一附加 CORS 头。
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-account-id, x-nonce, x-request-id, x-task-status",
  "Access-Control-Max-Age": "86400",
};

function isPublicPath(pathname: string): boolean {
  return pathname.startsWith("/api/auth/") || pathname.startsWith("/v1/") || pathname.startsWith("/api/v1/") || pathname.startsWith("/kling/") || pathname.startsWith("/v1beta/") || pathname.startsWith("/generated/");
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) {
    // 跨域预检（浏览器对带自定义头/非简单 Content-Type 的请求先发 OPTIONS）
    if (request.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
    }
    return NextResponse.next({ headers: CORS_HEADERS });
  }
  if (pathname === "/") return NextResponse.redirect(new URL("/admin", request.url));

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token);
  const authenticated = Boolean(payload?.sub);

  if (pathname === "/login") {
    // 登录页永远放行：middleware 只验证 JWT，无法确认 DB 会话仍有效；
    // 若此处依据 JWT 跳回 /admin，而 AdminLayout 查库判定会话已失效跳 /login，
    // 两者判断不一致会造成无限重定向。已登录用户访问 /login 也允许（重新登录覆盖）。
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/admin/") && !authenticated) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  }
  if (pathname.startsWith("/admin") && !authenticated) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/admin/:path*", "/api/admin/:path*", "/api/auth/:path*", "/v1/:path*", "/api/v1/:path*", "/kling/:path*", "/v1beta/:path*", "/generated/:path*"],
};
