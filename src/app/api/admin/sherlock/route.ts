/**
 * sherlockToken（x-arp-session-id）管理 API —— 全局单例（与账号无关）。
 *
 * GET  /api/admin/sherlock            → 全局 token 状态（含倒计时）
 * GET  /api/admin/sherlock?full=1     → 完整 token 字符串
 * POST /api/admin/sherlock {action:"pull"}   → RoxyBrowser 拉取并保存全局
 * POST /api/admin/sherlock {action:"input", token} → 手动输入保存全局
 */
import { NextRequest, NextResponse } from "next/server";
import { getGlobalSherlockStatus, refreshGlobalSherlockToken, importGlobalSherlockToken } from "@/lib/adobe/sherlock";
import { AppError } from "@/lib/errors";
import { requireAdminRequest, handleAdminError } from "@/lib/admin-api";

export async function GET(req: NextRequest) {
  try {
    await requireAdminRequest(req);
  } catch (error) {
    return handleAdminError(error, req);
  }
  const status = await getGlobalSherlockStatus();
  const full = req.nextUrl.searchParams.get("full") === "1";
  return NextResponse.json({
    token: full ? status.token : status.token ? `${status.token.slice(0, 24)}...` : null,
    tokenSet: Boolean(status.token),
    source: status.source,
    expiresAt: status.expiresAt?.toISOString() ?? null,
    updatedAt: status.updatedAt?.toISOString() ?? null,
    remainingSeconds: status.remainingSeconds,
    nextRefreshSeconds: status.nextRefreshSeconds,
    refreshMinutes: status.refreshMinutes,
  });
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminRequest(req);
  } catch (error) {
    return handleAdminError(error, req);
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; token?: string };
    const action = body.action;
    if (!action) throw new AppError("invalid_request", "缺少 action（pull / input）", 400);

    if (action === "pull") {
      const { token, expiresAt } = await refreshGlobalSherlockToken();
      return NextResponse.json({ ok: true, token: `${token.slice(0, 24)}...`, expiresAt: expiresAt.toISOString() });
    }

    if (action === "input") {
      const token = body.token;
      if (!token) throw new AppError("invalid_request", "input 需要 token", 400);
      const { token: saved, expiresAt } = await importGlobalSherlockToken(token);
      return NextResponse.json({ ok: true, token: `${saved.slice(0, 24)}...`, expiresAt: expiresAt.toISOString() });
    }

    throw new AppError("invalid_request", `未知 action: ${action}`, 400);
  } catch (error) {
    console.error(`[sherlock] 操作失败:`, error instanceof Error ? error.stack ?? error.message : error);
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "sherlock 操作失败" }, { status: 500 });
  }
}
