"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, Loader2, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type SherlockStatus = {
  token: string | null;
  tokenSet: boolean;
  source: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  remainingSeconds: number | null;
  nextRefreshSeconds: number | null;
  refreshMinutes: number | null;
};

/** 浏览器一行命令（管理员手动获取，已登录 firefly.adobe.com 控制台执行后粘贴） */
const BROWSER_COMMAND = `copy(document.cookie.match(/(?:^|;\\s*)sherlockToken=([^;]+)/)?.[1] ?? "")`;

function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return "00:00";
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function SherlockAdminPage() {
  const [status, setStatus] = useState<SherlockStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [inputToken, setInputToken] = useState("");
  // 倒计时（秒）：距下次拉取（sherlockRefreshMinutes 周期），每秒递减
  const [countdown, setCountdown] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/sherlock", { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SherlockStatus;
      setStatus(data);
      setCountdown(data.nextRefreshSeconds);
    } catch (error) {
      toast.error(`加载失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 倒计时每秒递减
  const hasCountdown = countdown !== null;
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (countdown === null) return;
    timerRef.current = setInterval(() => {
      setCountdown((current) => {
        if (current === null || current <= 0) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
        return current - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [hasCountdown, countdown]);

  // 首次加载需要把远端 DB 状态同步到页面；这是该页面唯一的外部数据订阅。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  /** 手动拉取：RoxyBrowser 铸造（6~90s），弹窗展示进度，完成后倒计时按刷新周期重置 */
  async function pullAll() {
    setPulling(true);
    try {
      const res = await fetch("/api/admin/sherlock", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-csrf-token": "same-origin" },
        body: JSON.stringify({ action: "pull" }),
      });
      const data = (await res.json()) as { error?: string; ok?: boolean; expiresAt?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(`拉取完成，倒计时已重置（${status?.refreshMinutes ?? 5} 分钟）${data.expiresAt ? `，过期 ${new Date(data.expiresAt).toLocaleTimeString("zh-CN")}` : ""}`);
      await load();
    } catch (error) {
      toast.error(`拉取失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPulling(false);
    }
  }

  async function submitManualInput() {
    if (!inputToken.trim()) return;
    try {
      const res = await fetch("/api/admin/sherlock", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-csrf-token": "same-origin" },
        body: JSON.stringify({ action: "input", token: inputToken.trim() }),
      });
      const data = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(`手动输入成功，倒计时已重置（${status?.refreshMinutes ?? 5} 分钟）`);
      setInputOpen(false);
      setInputToken("");
      await load();
    } catch (error) {
      toast.error(`输入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function showFull() {
    if (showToken) { setShowToken(false); return; }
    try {
      const res = await fetch("/api/admin/sherlock?full=1", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { token?: string | null };
      if (!data.token) { toast.error("尚未设置 token，请先拉取或输入"); return; }
      setStatus((current) => current ? { ...current, token: data.token ?? null } : current);
      setShowToken(true);
    } catch (error) {
      toast.error(`获取完整 token 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const fullToken = status?.token ?? "";
  const countdownTone = countdown !== null ? (countdown <= 300 ? "text-red-500" : countdown <= 600 ? "text-amber-500" : "text-emerald-500") : "";

  return (
    <div className="space-y-6 p-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>sherlockToken（x-arp-session-id）</CardTitle>
            <CardDescription>
              全局单例：浏览器会话级 token，所有账号共用，与账号无关。每 {status?.refreshMinutes ?? 5} 分钟自动拉取一次（每次全新随机环境，寿命 30 分钟）。
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={pulling} onClick={() => { setInputToken(""); setInputOpen(true); }}>
              <Upload className="mr-2 h-4 w-4" /> 手动输入
            </Button>
            <Button onClick={pullAll} disabled={pulling}>
              <RefreshCw className={`mr-2 h-4 w-4 ${pulling ? "animate-spin" : ""}`} />
              {pulling ? "拉取中..." : "手动拉取"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border p-3 text-xs">
            <div className="mb-1 font-medium text-muted-foreground">浏览器一行命令（登录 firefly.adobe.com 后 F12 控制台执行，自动复制 token 到剪贴板）：</div>
            <code className="block break-all rounded bg-muted p-2 font-mono">{BROWSER_COMMAND}</code>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中...
            </div>
          ) : (
            <div className="rounded-md border p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {status?.source && <Badge variant={status.source === "manual" ? "secondary" : "default"}>{status.source === "manual" ? "手动输入" : "自动拉取"}</Badge>}
                  {countdown !== null && (
                    <>
                      <div className={`text-2xl font-mono font-bold tabular-nums ${countdownTone}`}>{formatCountdown(countdown)}</div>
                      <div className="text-xs text-muted-foreground">距下次拉取倒计时（{status?.refreshMinutes ?? 5} 分钟）</div>
                    </>
                  )}
                </div>
                {status?.expiresAt && (
                  <div className="text-xs text-muted-foreground">过期时间：{new Date(status.expiresAt).toLocaleString("zh-CN", { hour12: false })}</div>
                )}
              </div>

              <div className="rounded-md bg-muted p-3">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>sherlockToken（x-arp-session-id 请求头值）</span>
                  <div className="flex items-center gap-2">
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => { void navigator.clipboard?.writeText(fullToken); toast.success("已复制到剪贴板"); }}
                      disabled={!fullToken}
                    >
                      <Copy className="h-3.5 w-3.5" /> 复制
                    </button>
                    {status?.tokenSet && (
                      <button className="flex items-center gap-1 hover:text-foreground" onClick={() => void showFull()}>
                        {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {showToken ? "隐藏" : "显示"}
                      </button>
                    )}
                  </div>
                </div>
                {status?.tokenSet ? (
                  <code className="block break-all font-mono text-xs">{showToken ? fullToken : `${fullToken.slice(0, 24)}...`}</code>
                ) : (
                  <div className="text-sm text-red-500">未设置 token —— 点右上角「手动拉取」或「手动输入」</div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 拉取进度弹窗 */}
      <Dialog open={pulling} onOpenChange={(open) => { if (!open && !pulling) setPulling(false); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在拉取 sherlockToken
            </DialogTitle>
            <DialogDescription>
              正在通过 RoxyBrowser 铸造（打开浏览器 → 注入 Sherlock SDK → 生成四字段 token）… 通常 6~90 秒，完成后自动关闭浏览器并重置倒计时。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">铸造中，请勿关闭页面</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPulling(false)} disabled={pulling}>后台执行</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 手动输入弹窗 */}
      <Dialog open={inputOpen} onOpenChange={setInputOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动输入 sherlockToken</DialogTitle>
            <DialogDescription>
              在浏览器控制台执行一行命令复制 token 后粘贴（含 sid/ftr/ark/bfp 四字段）。全局生效，所有账号共用。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="粘贴浏览器复制的 sherlockToken（base64，含 sid/ftr/ark/bfp 四字段）"
            value={inputToken}
            onChange={(e) => setInputToken(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setInputOpen(false)}>取消</Button>
            <Button onClick={submitManualInput} disabled={!inputToken.trim()}>保存并重置倒计时</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
