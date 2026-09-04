"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Coins,
  Cookie,
  Download,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldOff,
  Trash2,
  Upload,
} from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type TokenRow = {
  id: string;
  accountId: string;
  accountName: string;
  accountEmail: string | null;
  status: string;
  source: string;
  fails: number;
  autoRefresh: boolean;
  autoRefreshEnabled: boolean;
  refreshProfileId: string | null;
  refreshProfileName: string | null;
  creditsTotal: number | null;
  creditsUsed: number | null;
  creditsAvailable: number | null;
  creditsAvailableUntil: string | null;
  creditsError: string | null;
  riskFlagged: boolean;
  riskFlaggedAt: string | null;
  riskFlaggedReason: string | null;
  expiresAtText: string | null;
  remainingSeconds: number | null;
  isExpired: boolean;
  createdAt: string;
  hasToken: boolean;
};

type TokenAction = "refresh-token" | "refresh-credits" | "toggle" | "delete" | "unmark-risk";

/** 批量刷新积分的单个账号任务状态：待处理 → 进行中 → 成功 / 失败 / 失效(401)。 */
type CreditsTaskStatus = "pending" | "running" | "ok" | "failed" | "unauthorized";

type CreditsTask = {
  id: string;
  name: string;
  status: CreditsTaskStatus;
  detail: string | null;
  elapsedMs: number | null;
};

type CreditsProgress = {
  total: number;
  done: number;
  ok: number;
  failed: number;
  unauthorized: number;
  concurrency: number;
  /** 每代理并发线程数与代理（IP）数量，弹窗按「线程 × IP = 总线程」展示。 */
  perProxy: number;
  proxyCount: number;
};

/** 后端批量刷新接口单账号结果。 */
type BatchRefreshResult = {
  id: string;
  status: "ok" | "failed" | "unauthorized";
  message: string | null;
  credits: { total: number | null; used: number | null; available: number | null; availableUntil: string | null } | null;
  proxy: { id: string; host: string } | null;
  elapsedMs: number;
};

const EMPTY_CREDITS_PROGRESS: CreditsProgress = { total: 0, done: 0, ok: 0, failed: 0, unauthorized: 0, concurrency: 1, perProxy: 0, proxyCount: 0 };

/** 批量导入（SSE 流式）的进度状态。 */
type ImportProgress = {
  total: number;
  done: number;
  ok: number;
  failed: number;
  duplicate: number;
  batch: number;
  batchSize: number;
  running: boolean;
  refreshPending: number;
};

const EMPTY_IMPORT_PROGRESS: ImportProgress = { total: 0, done: 0, ok: 0, failed: 0, duplicate: 0, batch: 0, batchSize: 10, running: false, refreshPending: 0 };

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatBeijingDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return BEIJING_DATE_FORMATTER.format(date).replace(/\//g, "-");
}

function statusText(status: string) {
  return ({ active: "生效", pending: "待刷新", disabled: "已禁用", exhausted: "额度耗尽", invalid: "无效", expired: "已过期", revoked: "已撤销" } as Record<string, string>)[status] ?? status;
}

function formatCredits(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-";
}

function formatElapsed(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRemaining(seconds: number | null, expired: boolean) {
  if (expired) return "已过期";
  if (seconds === null) return "-";
  if (seconds <= 0) return "已过期";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `剩余 ${days} 天` : `剩余 ${hours} 小时`;
}

function downloadJson(name: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function AccountsPage() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [summary, setSummary] = useState({ total: 0, active: 0, creditsAvailableTotal: 0 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [autoRefreshFilter, setAutoRefreshFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyTokenActions, setBusyTokenActions] = useState<Record<string, TokenAction>>({});
  const [tokenModal, setTokenModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TokenRow | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [refreshModalOpen, setRefreshModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTasks, setRefreshTasks] = useState<CreditsTask[]>([]);
  const [refreshProgress, setRefreshProgress] = useState<CreditsProgress>(EMPTY_CREDITS_PROGRESS);
  const [batchImportOpen, setBatchImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importCount, setImportCount] = useState(0);
  const [importProgress, setImportProgress] = useState<ImportProgress>(EMPTY_IMPORT_PROGRESS);
  const [tokenImportOpen, setTokenImportOpen] = useState(false);
  const [tokenImportInput, setTokenImportInput] = useState("");
  const [tokenImportName, setTokenImportName] = useState("");
  const [cookieImportOpen, setCookieImportOpen] = useState(false);
  const [cookieImportInput, setCookieImportInput] = useState("");
  const [cookieImportName, setCookieImportName] = useState("");

  const filteredTokens = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tokens.filter((token) => {
      const matchesQuery = !normalizedQuery || [token.accountName, token.accountEmail ?? "", token.accountId]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
      const matchesStatus = statusFilter === "all" || token.status === statusFilter;
      const matchesAutoRefresh = autoRefreshFilter === "all"
        || (autoRefreshFilter === "enabled" && token.refreshProfileId && token.autoRefreshEnabled)
        || (autoRefreshFilter === "disabled" && token.refreshProfileId && !token.autoRefreshEnabled)
        || (autoRefreshFilter === "manual" && !token.refreshProfileId);
      const matchesSource = sourceFilter === "all" || token.source === sourceFilter;
      const matchesRisk = riskFilter === "all"
        || (riskFilter === "flagged" && token.riskFlagged)
        || (riskFilter === "clean" && !token.riskFlagged);
      return matchesQuery && matchesStatus && matchesAutoRefresh && matchesSource && matchesRisk;
    });
  }, [autoRefreshFilter, query, riskFilter, sourceFilter, statusFilter, tokens]);
  const pageCount = Math.max(1, Math.ceil(filteredTokens.length / pageSize));
  const visibleTokens = useMemo(() => filteredTokens.slice((page - 1) * pageSize, page * pageSize), [filteredTokens, page, pageSize]);
  // Pending Cookie rows do not have a token id. Never include their synthetic
  // `pending:*` ids in token batch operations.
  const visibleIds = visibleTokens.filter((token) => token.hasToken).map((token) => token.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/accounts", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "账号列表加载失败");
      const tokenRows = (data.tokens ?? []).map((token: Record<string, unknown>) => ({
        ...token,
        hasToken: true,
        riskFlagged: Boolean(token.riskFlagged),
        riskFlaggedAt: typeof token.riskFlaggedAt === "string" ? token.riskFlaggedAt : null,
        riskFlaggedReason: typeof token.riskFlaggedReason === "string" ? token.riskFlaggedReason : null,
      }) as TokenRow);
      const tokenAccountIds = new Set(tokenRows.map((token: TokenRow) => token.accountId));
      const pendingRows = (Array.isArray(data.accounts) ? data.accounts : [])
        .filter((account: Record<string, unknown>) => {
          const profiles = Array.isArray(account.refreshProfileDetails) ? account.refreshProfileDetails : [];
          return !tokenAccountIds.has(String(account.id ?? "")) && profiles.length > 0;
        })
        .map((account: Record<string, unknown>) => {
          const profiles = Array.isArray(account.refreshProfileDetails) ? account.refreshProfileDetails as Array<Record<string, unknown>> : [];
          const profile = profiles[0];
          return {
            id: `pending:${String(account.id ?? "")}`,
            accountId: String(account.id ?? ""),
            accountName: String(account.displayName ?? "Cookie 账号"),
            accountEmail: typeof account.email === "string" ? account.email : null,
            status: profile ? "pending" : String(account.status ?? "unavailable").toLowerCase(),
            source: profile ? "auto_refresh" : "manual",
            fails: Number(profile?.consecutiveFailures ?? 0),
            autoRefresh: Boolean(profile?.enabled),
            autoRefreshEnabled: Boolean(profile?.enabled),
            refreshProfileId: typeof profile?.id === "string" ? profile.id : null,
            refreshProfileName: typeof profile?.name === "string" ? profile.name : null,
            creditsTotal: null,
            creditsUsed: null,
            creditsAvailable: null,
            creditsAvailableUntil: null,
            creditsError: typeof profile?.lastError === "string" ? profile.lastError : null,
            riskFlagged: false,
            riskFlaggedAt: null,
            riskFlaggedReason: null,
            expiresAtText: null,
            remainingSeconds: null,
            isExpired: false,
            createdAt: "",
            hasToken: false,
          } as TokenRow;
        });
      const displayRows = [...tokenRows, ...pendingRows];
      setTokens(displayRows);
      setSummary(data.summary ?? { total: 0, active: 0, creditsAvailableTotal: 0 });
      setSelected((current) => new Set([...current].filter((id) => displayRows.some((token: TokenRow) => token.id === id && token.hasToken))));
      setPage((current) => Math.min(current, Math.max(1, Math.ceil(displayRows.length / pageSize))));
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "账号列表加载失败");
    } finally { setLoading(false); }
  }, [pageSize]);

  // 首次加载需要把远端 MySQL 状态同步到页面；这是该页面唯一的外部数据订阅。
  useEffect(() => { void load(); }, [load]);

  async function request(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>, tokenId?: string, tokenAction?: TokenAction) {
    if (tokenId) setBusyTokenActions((current) => ({ ...current, [tokenId]: tokenAction ?? "refresh-credits" }));
    else setBusy(true);
    try {
      const response = await fetch("/api/admin/accounts", { method, headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "操作失败");
      return data;
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "操作失败");
      return null;
    } finally {
      if (tokenId) setBusyTokenActions((current) => { const next = { ...current }; delete next[tokenId]; return next; });
      else setBusy(false);
    }
  }

  async function importAccounts() {
    const rawInput = tokenInput.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    if (!rawInput) { toast.warning("请先粘贴账号 JSON"); return; }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      toast.error("账号 JSON 格式不正确");
      return;
    }

    const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const inheritedEmail = typeof root?.email === "string" ? root.email : undefined;
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(root?.accounts)
        ? root.accounts
        : [parsed];
    const accounts = values
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
      .map((value) => inheritedEmail && value.email === undefined ? { ...value, email: inheritedEmail } : value)
      .filter((value) => typeof value.token === "string" || typeof value.cookie === "string" || typeof value.ims_sid === "string");
    if (!accounts.length) { toast.warning("未找到账号凭据，请检查 token、cookie 或 ims_sid 字段"); return; }

    const data = await request("POST", { accounts });
    if (data) {
      const pending = Number(data.refresh_pending_count ?? 0);
      toast.success(pending > 0
        ? `账号导入完成：${data.account_count ?? accounts.length} 个，刷新已转后台执行`
        : `账号导入完成：${data.account_count ?? accounts.length} 个`);
      setTokenInput("");
      setTokenModal(false);
      await load();
    }
  }

  // 单个 access token 直接导入（参考 adobe2api 的 Token 导入）：后端按 email/externalId
  // 去重并覆盖更新，无 cookie 时仅落库 token，不触发刷新。
  async function importSingleToken() {
    const value = tokenImportInput.trim();
    if (!value) { toast.warning("请先粘贴 access token"); return; }
    const body: Record<string, unknown> = { token: value };
    const name = tokenImportName.trim();
    if (name) body.name = name;
    const data = await request("POST", body);
    if (!data) return;
    const results: Array<Record<string, unknown>> = Array.isArray(data.token_results) ? data.token_results : [];
    const duplicate = results.some((item) => Boolean(item.duplicate));
    toast.success(duplicate ? "Token 已存在，已覆盖更新" : "Token 导入成功");
    setTokenImportInput("");
    setTokenImportName("");
    setTokenImportOpen(false);
    await load();
  }

  // 单个 cookie 直接导入（参考 adobe2api 的 Cookie 导入）：后端落库 refreshProfile 并
  // 自动触发一次 Adobe 刷新换取 access token（queueRefresh）。
  async function importSingleCookie() {
    const raw = cookieImportInput.trim();
    const value = raw.toLowerCase().startsWith("cookie:") ? raw.slice(7).trim() : raw;
    if (!value) { toast.warning("请先粘贴 cookie 内容"); return; }
    const body: Record<string, unknown> = { cookie: value };
    const name = cookieImportName.trim();
    if (name) body.name = name;
    const data = await request("POST", body);
    if (!data) return;
    const pending = Number(data.refresh_pending_count ?? 0);
    const results: Array<Record<string, unknown>> = Array.isArray(data.cookie_results) ? data.cookie_results : [];
    const duplicate = results.some((item) => Boolean(item.duplicate));
    toast.success(duplicate ? "Cookie 已存在，已覆盖更新" : (pending > 0 ? "Cookie 导入成功，已触发自动刷新换取 Token" : "Cookie 导入成功"));
    setCookieImportInput("");
    setCookieImportName("");
    setCookieImportOpen(false);
    await load();
  }

  /** 解析导入文件：兼容 {users:[...]} / {accounts:[...]} / 顶层数组 三种结构。 */
  function parseImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setImportFile(file);
      try {
        const parsed = JSON.parse(String(reader.result ?? ""));
        const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        const values = Array.isArray(parsed)
          ? parsed
          : Array.isArray(root?.users)
            ? root.users
            : Array.isArray(root?.accounts)
              ? root.accounts
              : [];
        const accounts = values.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
        setImportCount(accounts.length);
        if (!accounts.length) toast.warning("文件中未找到账号数据（支持 users / accounts 数组）");
      } catch {
        setImportCount(0);
        setImportFile(null);
        toast.error("JSON 文件解析失败");
      }
    };
    reader.readAsText(file);
  }

  /**
   * 批量导入：SSE 流式接收后端进度，每批 10 个账号推送一次。
   * 后端只负责落库（token/cookie/额度），不自动触发 Adobe 刷新 —— 导入完成后
   * 如有新增 Cookie 资料，用「刷新积分」功能按需批量执行。
   */
  async function startBatchImport() {
    if (!importFile || importCount <= 0 || importProgress.running) return;
    const file = importFile;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast.error("JSON 文件解析失败");
      return;
    }
    const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(root?.users)
        ? root.users
        : Array.isArray(root?.accounts)
          ? root.accounts
          : [];
    const accounts = values.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
    if (!accounts.length) { toast.warning("文件中未找到账号数据"); return; }

    setImportProgress({ total: accounts.length, done: 0, ok: 0, failed: 0, duplicate: 0, batch: 0, batchSize: 10, running: true, refreshPending: 0 });
    let finalOk = 0;
    let finalFailed = 0;
    let finalDuplicate = 0;
    let refreshPending = 0;
    try {
      const response = await fetch("/api/admin/accounts", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify({ action: "import-stream", accounts }) });
      if (!response.ok || !response.body) throw new Error(response.ok ? "SSE 连接失败" : "批量导入失败");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (event.type === "progress") {
            finalOk = typeof event.ok === "number" ? event.ok : finalOk;
            finalFailed = typeof event.failed === "number" ? event.failed : finalFailed;
            finalDuplicate = typeof event.duplicate === "number" ? event.duplicate : finalDuplicate;
            setImportProgress({
              total: typeof event.total === "number" ? event.total : accounts.length,
              done: typeof event.done === "number" ? event.done : 0,
              ok: finalOk,
              failed: finalFailed,
              duplicate: finalDuplicate,
              batch: typeof event.batch === "number" ? event.batch : 0,
              batchSize: typeof event.batchSize === "number" ? event.batchSize : 10,
              running: true,
              refreshPending,
            });
          } else if (event.type === "done") {
            refreshPending = typeof event.refreshPending === "number" ? event.refreshPending : 0;
            setImportProgress((current) => ({ ...current, done: current.total, running: false, refreshPending }));
          } else if (event.type === "error") {
            throw new Error(String(event.message ?? "批量导入失败"));
          }
        }
      }
      await load();
      toast.success(refreshPending > 0
        ? `批量导入完成：新增 ${finalOk}，重复 ${finalDuplicate}，失败 ${finalFailed}；${refreshPending} 个新 Cookie 资料待刷新，建议用「刷新积分」批量执行`
        : `批量导入完成：新增 ${finalOk}，重复 ${finalDuplicate}，失败 ${finalFailed}`);
    } catch (error) {
      setImportProgress((current) => ({ ...current, running: false }));
      toast.error(error instanceof Error ? error.message : "批量导入失败");
    }
  }

  async function runAction(body: Record<string, unknown>, success: string) {
    const tokenId = body.action === "refresh-credits" && typeof body.tokenId === "string" ? body.tokenId : undefined;
    const data = await request("POST", body, tokenId, tokenId ? "refresh-credits" : undefined);
    if (data) {
      if (body.action === "export-tokens") downloadJson(`adobe-tokens-${Date.now()}.json`, data.tokens ?? []);
      if (body.action === "export-cookies") downloadJson(`adobe-cookies-${Date.now()}.json`, data.items ?? []);
      if (body.action === "refresh-credits" && typeof data.tokenId === "string") {
        const previous = tokens.find((token) => token.id === data.tokenId)?.creditsAvailable ?? 0;
        const updatedToken = data.token && typeof data.token === "object" ? data.token as Partial<TokenRow> : null;
        const next = data.credits && typeof data.credits === "object"
          ? (typeof data.credits.available === "number" && Number.isFinite(data.credits.available) ? data.credits.available : null)
          : (typeof updatedToken?.creditsAvailable === "number" && Number.isFinite(updatedToken.creditsAvailable) ? updatedToken.creditsAvailable : null);
        const nextError = data.status === "ok" ? null : (typeof updatedToken?.creditsError === "string" ? updatedToken.creditsError : data.error?.message ?? "积分刷新失败");
        setTokens((current) => current.map((token) => token.id === data.tokenId ? {
          ...token,
          ...(updatedToken ?? {}),
          ...(data.credits && typeof data.credits === "object" ? {
            creditsTotal: typeof data.credits.total === "number" ? data.credits.total : null,
            creditsUsed: typeof data.credits.used === "number" ? data.credits.used : null,
            creditsAvailable: next,
            creditsAvailableUntil: typeof data.credits.availableUntil === "string" ? data.credits.availableUntil : null,
            creditsError: nextError,
          } : {}),
        } : token));
        setSummary((current) => ({ ...current, creditsAvailableTotal: current.creditsAvailableTotal - previous + (next ?? 0) }));
        if (data.status === "ok") toast.success(success);
        else toast.error(data.error?.message ?? "积分刷新失败");
        return;
      }
      toast.success(success);
      await load();
    }
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  }

  async function toggleAutoRefresh(token: TokenRow) {
    if (!token.refreshProfileId) return;
    const data = await request("PATCH", { ...(token.hasToken ? { tokenId: token.id } : {}), profileId: token.refreshProfileId, autoRefreshEnabled: !token.autoRefreshEnabled }, token.id, "toggle");
    if (data) {
      const updatedToken = data.token && typeof data.token === "object" ? data.token as Partial<TokenRow> : { autoRefreshEnabled: !token.autoRefreshEnabled, autoRefresh: !token.autoRefreshEnabled };
      setTokens((current) => current.map((item) => item.id === token.id ? { ...item, ...updatedToken } : item));
      toast.success(token.autoRefreshEnabled ? "自动刷新已关闭" : "自动刷新已开启");
    }
  }

  /** 解除风控标记（账号将重新进入选号池）。 */
  async function unmarkRisk(token: TokenRow) {
    const data = await request("POST", { action: "unmark-risk", accountId: token.accountId }, token.id, "unmark-risk");
    if (data) {
      setTokens((current) => current.map((item) => item.id === token.id ? { ...item, riskFlagged: false, riskFlaggedAt: null, riskFlaggedReason: null } : item));
      toast.success("已解除风控，该账号将重新参与选号");
    }
  }

  /** 导出单个账号为导入格式 JSON（下载文件）。 */
  async function exportAccount(token: TokenRow) {
    try {
      const response = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "same-origin" },
        body: JSON.stringify({ action: "export", accountId: token.accountId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `account-${token.accountName || token.accountId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("账号已导出（导入格式）");
    } catch (error) {
      toast.error(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function deleteToken() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const data = await request(
      "DELETE",
      target.hasToken ? { tokenId: target.id } : { id: target.accountId },
      target.id,
      "delete",
    );
    if (data) {
      setDeleteTarget(null);
      await load();
      toast.success("账号及关联数据已从数据库删除");
    }
  }

  async function deleteSelectedTokens() {
    const ids = [...selected];
    if (!ids.length) { setBatchDeleteOpen(false); return; }
    const data = await request("DELETE", { ids });
    if (data) {
      const deletedIds = new Set(Array.isArray(data.deletedIds) ? data.deletedIds.filter((id: unknown): id is string => typeof id === "string") : ids);
      const removedTokens = tokens.filter((token) => deletedIds.has(token.id));
      setTokens((current) => current.filter((token) => !deletedIds.has(token.id)));
      setSelected((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      setSummary((current) => ({
        total: Math.max(0, current.total - removedTokens.length),
        active: Math.max(0, current.active - removedTokens.filter((token) => token.status === "active").length),
        creditsAvailableTotal: current.creditsAvailableTotal - removedTokens.reduce((total, token) => total + (token.creditsAvailable ?? 0), 0),
      }));
      setPage((current) => Math.min(current, Math.max(1, Math.ceil(Math.max(0, filteredTokens.length - removedTokens.length) / pageSize))));
      setBatchDeleteOpen(false);
      toast.success(`已批量删除 ${removedTokens.length} 个 Token`);
    } else setBatchDeleteOpen(false);
  }

  /**
   * 批量刷新积分：通过 SSE 流接收后端实时进度。
   * 后端以「每代理并发 × 启用代理数」的并发池并行刷新，每完成一个账号立即推送一条
   * progress 事件，前端弹窗实时更新；列表展示每个账号的耗时与所用代理。
   * 401 账号若绑定了 Cookie 会先由后端自动刷新 Token，刷新成功则计入成功；
   * 刷新失败才标记为不生效（token DISABLED / account UNAVAILABLE），此处仅做进度展示。
   */
  async function startCreditsRefresh() {
    if (refreshing || !tokens.length) return;
    const targets = tokens.map((token) => ({ id: token.id, name: token.accountName || "手动 Token" }));
    setRefreshTasks(targets.map((target) => ({ ...target, status: "pending" as const, detail: null, elapsedMs: null })));
    setRefreshModalOpen(true);
    setRefreshing(true);

    const total = targets.length;
    let concurrency = 1;
    let perProxy = 0;
    let proxyCount = 0;
    const updateTask = (id: string, patch: Partial<CreditsTask>) => setRefreshTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
    // 弹窗先展示真实总数；账号保持「等待中」，直到收到后端 running 事件才切「刷新中」，
    // 因此只有并发池内真正在处理的账号显示刷新中，排队的仍是等待中。
    setRefreshProgress({ total, done: 0, ok: 0, failed: 0, unauthorized: 0, concurrency: 1, perProxy: 0, proxyCount: 0 });

    const applyResult = (result: BatchRefreshResult) => {
      if (result.status === "ok") {
        const available = result.credits && typeof result.credits.available === "number" ? `可用 ${formatCredits(result.credits.available)}` : "刷新成功";
        const proxy = result.proxy?.host ? ` · 代理 ${result.proxy.host}` : "";
        const elapsed = formatElapsed(result.elapsedMs);
        updateTask(result.id, { status: "ok", detail: `${available}${proxy}${elapsed ? ` · 用时 ${elapsed}` : ""}` });
      } else if (result.status === "unauthorized") {
        const proxy = result.proxy?.host ? `（代理 ${result.proxy.host}）` : "";
        const elapsed = formatElapsed(result.elapsedMs);
        updateTask(result.id, { status: "unauthorized", detail: `401：Token 失效且自动刷新失败，账号已标记为不生效${proxy}${elapsed ? ` · 用时 ${elapsed}` : ""}` });
      } else {
        const elapsed = formatElapsed(result.elapsedMs);
        updateTask(result.id, { status: "failed", detail: `${result.message ?? "刷新失败"}${elapsed ? ` · 用时 ${elapsed}` : ""}` });
      }
    };

    let streamError: unknown = null;
    let finalOk = 0;
    let finalFailed = 0;
    let finalUnauthorized = 0;
    try {
      const response = await fetch("/api/admin/accounts", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify({ action: "refresh-credits-stream", ids: targets.map((target) => target.id) }) });
      if (!response.ok || !response.body) throw new Error(response.ok ? "SSE 连接失败" : "批量刷新失败");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (event.type === "start") {
            concurrency = typeof event.concurrency === "number" && event.concurrency > 0 ? event.concurrency : 1;
            perProxy = typeof event.perProxy === "number" && event.perProxy > 0 ? event.perProxy : 0;
            proxyCount = typeof event.proxyCount === "number" && event.proxyCount > 0 ? event.proxyCount : 0;
            setRefreshProgress({ total, done: 0, ok: 0, failed: 0, unauthorized: 0, concurrency, perProxy, proxyCount });
          } else if (event.type === "running") {
            const runningId = typeof event.id === "string" ? event.id : "";
            if (runningId) updateTask(runningId, { status: "running", detail: null });
          } else if (event.type === "progress") {
            const result = event as unknown as BatchRefreshResult & { done?: number; ok?: number; failed?: number; unauthorized?: number };
            applyResult(result);
            setRefreshProgress({ total, done: result.done ?? 0, ok: result.ok ?? 0, failed: result.failed ?? 0, unauthorized: result.unauthorized ?? 0, concurrency, perProxy, proxyCount });
          } else if (event.type === "done") {
            const summary = event as { ok?: number; failed?: number; unauthorized?: number };
            finalOk = summary.ok ?? 0;
            finalFailed = summary.failed ?? 0;
            finalUnauthorized = summary.unauthorized ?? 0;
            setRefreshProgress({ total, done: total, ok: finalOk, failed: finalFailed, unauthorized: finalUnauthorized, concurrency, perProxy, proxyCount });
          } else if (event.type === "error") {
            throw new Error(String(event.message ?? "批量刷新失败"));
          }
        }
      }
    } catch (error) {
      streamError = error;
      // 流中断/出错：未完成的账号标记为失败，已完成的保持原状态。
      setRefreshTasks((current) => current.map((task) => task.status === "pending" || task.status === "running"
        ? { ...task, status: "failed" as const, detail: error instanceof Error ? error.message : "批量刷新中断" }
        : task));
    }

    setRefreshing(false);
    await load();
    if (streamError) {
      toast.error(streamError instanceof Error ? streamError.message : "批量刷新失败");
    } else {
      toast.success(finalUnauthorized > 0
        ? `积分刷新完成：成功 ${finalOk}，失败 ${finalFailed}，失效 ${finalUnauthorized}（已删除账号）`
        : `积分刷新完成：成功 ${finalOk}，失败 ${finalFailed}`);
    }
  }

  function refreshToken(token: TokenRow) {
    if (!token.refreshProfileId) {
      toast.warning("该 Token 未绑定自动刷新资料，无法刷新 Token");
      return;
    }
    void (async () => {
      const data = await request("POST", { action: "refresh-token", ...(token.hasToken ? { tokenId: token.id } : {}), profileId: token.refreshProfileId }, token.id, "refresh-token");
      if (!data) return;
      if (data.status !== "ok" && data.status !== "pending") {
        toast.error("Token 刷新失败");
        return;
      }
      if (data.token && typeof data.token === "object") {
        setTokens((current) => current.map((item) => item.id === token.id ? { ...item, ...data.token } : item));
      }
      toast.success(data.status === "pending" ? "Token 刷新已加入 Worker 队列" : "Token 刷新完成");
      if (data.status === "pending") window.setTimeout(() => void load(), 1500);
    })();
  }

  return (
    <div className="admin-page account-page">
      <section className="admin-card account-overview-card admin-management-overview">
        <div className="account-overview-actions">
          <button type="button" className="admin-button admin-button-icon-text" onClick={() => void startCreditsRefresh()} disabled={loading || busy || refreshing || !tokens.length}>{refreshing ? <Loader2 className="account-action-spinner" size={15} aria-hidden="true" /> : <Coins size={15} aria-hidden="true" />}刷新积分</button>
          <button type="button" className="admin-button admin-button-icon-text" onClick={() => setBatchImportOpen(true)} disabled={busy || refreshing}><Upload size={15} aria-hidden="true" />批量导入</button>
          <button type="button" className="admin-button admin-button-icon-text" onClick={() => setTokenImportOpen(true)} disabled={busy || refreshing}><Key size={15} aria-hidden="true" />Token 导入</button>
          <button type="button" className="admin-button admin-button-icon-text" onClick={() => setCookieImportOpen(true)} disabled={busy || refreshing}><Cookie size={15} aria-hidden="true" />Cookie 导入</button>
          <button type="button" className="admin-button admin-button-primary admin-button-icon-text" onClick={() => setTokenModal(true)}><Plus size={15} aria-hidden="true" />新增账号</button>
        </div>
        <div className="account-summary-grid">
          <div className="admin-card"><span>Token 总数</span><strong>{summary.total}</strong></div>
          <div className="admin-card"><span>当前生效</span><strong>{summary.active}</strong></div>
          <div className="admin-card"><span>可用积分总量</span><strong>{formatCredits(summary.creditsAvailableTotal)}</strong></div>
        </div>
      </section>

      <section className="admin-card account-list-card admin-management-list">
        <div className="account-list-filters">
          {selected.size > 0 ? <button type="button" className="admin-button admin-button-danger admin-button-icon-text account-batch-delete-button" onClick={() => setBatchDeleteOpen(true)} disabled={busy}><Trash2 size={15} aria-hidden="true" />批量删除 ({selected.size})</button> : null}
          <label className="account-search"><Search size={16} aria-hidden="true" /><span className="sr-only">搜索账号</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索账号名 / 邮箱" /></label>
          <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPage(1); }}>
            <SelectTrigger className="account-filter-select" aria-label="按状态筛选"><SelectValue placeholder="全部状态" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="active">生效</SelectItem><SelectItem value="disabled">已禁用</SelectItem><SelectItem value="invalid">无效</SelectItem><SelectItem value="exhausted">额度耗尽</SelectItem><SelectItem value="expired">已过期</SelectItem><SelectItem value="revoked">已撤销</SelectItem></SelectContent>
          </Select>
          <Select value={autoRefreshFilter} onValueChange={(value) => { setAutoRefreshFilter(value); setPage(1); }}>
            <SelectTrigger className="account-filter-select" aria-label="按自动刷新筛选"><SelectValue placeholder="全部自动刷新" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部自动刷新</SelectItem><SelectItem value="enabled">已开启</SelectItem><SelectItem value="disabled">已关闭</SelectItem><SelectItem value="manual">手动 Token</SelectItem></SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={(value) => { setSourceFilter(value); setPage(1); }}>
            <SelectTrigger className="account-filter-select" aria-label="按来源筛选"><SelectValue placeholder="全部来源" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部来源</SelectItem><SelectItem value="manual">手动导入</SelectItem><SelectItem value="auto_refresh">Cookie 自动刷新</SelectItem></SelectContent>
          </Select>
          <Select value={riskFilter} onValueChange={(value) => { setRiskFilter(value); setPage(1); }}>
            <SelectTrigger className="account-filter-select" aria-label="按风控状态筛选"><SelectValue placeholder="全部风控状态" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部风控状态</SelectItem><SelectItem value="flagged">已风控</SelectItem><SelectItem value="clean">未风控</SelectItem></SelectContent>
          </Select>
          <button type="button" className="admin-button admin-button-icon-text account-search-button" onClick={() => setPage(1)}><Search size={15} aria-hidden="true" />搜索</button>
        </div>
        {loading ? <p className="admin-empty account-table-loading">加载中...</p> : (
          <Table className="admin-table account-token-table">
            <TableHeader>
              <TableRow>
                <TableHead className="account-table-checkbox-head"><input type="checkbox" aria-label="全选当前页" checked={allVisibleSelected} onChange={(event) => { const checked = event.target.checked; setSelected((current) => { const next = new Set(current); visibleIds.forEach((id) => checked ? next.add(id) : next.delete(id)); return next; }); }} /></TableHead>
                <TableHead>账号名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>风控</TableHead>
                <TableHead>自动刷新</TableHead>
                <TableHead>积分</TableHead>
                <TableHead>失败次数</TableHead>
                <TableHead>有效期</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleTokens.length ? visibleTokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="account-table-checkbox-cell"><input type="checkbox" aria-label={`选择 ${token.accountName}`} disabled={!token.hasToken} checked={selected.has(token.id)} onChange={(event) => toggleSelected(token.id, event.target.checked)} /></TableCell>
                  <TableCell><strong>{token.accountName || "手动 Token"}</strong><small>{token.accountEmail || token.accountId}</small></TableCell>
                  <TableCell><span className={`admin-status admin-status-${token.status}`}>{statusText(token.status)}</span></TableCell>
                  <TableCell>{token.riskFlagged ? <div className="account-risk-cell"><Tooltip><TooltipTrigger asChild><span className="admin-status admin-status-failed" style={{ cursor: "help" }}>已风控</span></TooltipTrigger><TooltipContent>{token.riskFlaggedReason ?? "3p 提交 408 风控"}（{formatBeijingDate(token.riskFlaggedAt) ?? ""}）</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button" aria-label="解除风控" disabled={busy || Boolean(busyTokenActions[token.id])} onClick={() => void unmarkRisk(token)}>{busyTokenActions[token.id] === "unmark-risk" ? <Loader2 className="account-action-spinner" size={13} aria-hidden="true" /> : <ShieldOff size={13} aria-hidden="true" />}</button></TooltipTrigger><TooltipContent>解除风控</TooltipContent></Tooltip></div> : <span className="admin-muted">—</span>}</TableCell>
                  <TableCell>{token.refreshProfileId ? <button type="button" className={`admin-switch${token.autoRefreshEnabled ? " is-on" : ""}`} disabled={busy || Boolean(busyTokenActions[token.id])} onClick={() => void toggleAutoRefresh(token)}>{busyTokenActions[token.id] === "toggle" ? <Loader2 className="account-action-spinner" size={13} aria-hidden="true" /> : token.autoRefreshEnabled ? "开启" : "关闭"}</button> : <span className="admin-muted">手动</span>}</TableCell>
                  <TableCell><strong>{typeof token.creditsAvailable === "number" && typeof token.creditsTotal === "number" ? `${formatCredits(token.creditsAvailable)} / ${formatCredits(token.creditsTotal)}` : formatCredits(token.creditsAvailable)}</strong><small>{token.creditsError ? "刷新失败" : formatBeijingDate(token.creditsAvailableUntil) ? `重置 ${formatBeijingDate(token.creditsAvailableUntil)}` : "未查询"}</small></TableCell>
                  <TableCell>{token.fails}</TableCell>
                  <TableCell><span className={token.isExpired ? "account-expired" : ""}>{formatRemaining(token.remainingSeconds, token.isExpired)}</span><small>{formatBeijingDate(token.expiresAtText) ?? "无过期时间"}</small></TableCell>
                  <TableCell><div className="admin-table-actions">
                    {token.refreshProfileId ? <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button" aria-label="刷新 Token" disabled={busy || Boolean(busyTokenActions[token.id])} onClick={() => refreshToken(token)}>{busyTokenActions[token.id] === "refresh-token" ? <Loader2 className="account-action-spinner" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}</button></TooltipTrigger><TooltipContent>刷新 Token</TooltipContent></Tooltip> : null}
                    <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button" aria-label="刷新积分" disabled={!token.hasToken || busy || Boolean(busyTokenActions[token.id])} onClick={() => void runAction({ action: "refresh-credits", tokenId: token.id }, "积分刷新完成")}>{busyTokenActions[token.id] === "refresh-credits" ? <Loader2 className="account-action-spinner" size={16} aria-hidden="true" /> : <Coins size={16} aria-hidden="true" />}</button></TooltipTrigger><TooltipContent>刷新积分</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button" aria-label="导出账号" disabled={!token.hasToken || busy || Boolean(busyTokenActions[token.id])} onClick={() => void exportAccount(token)}><Download size={16} aria-hidden="true" /></button></TooltipTrigger><TooltipContent>导出账号（导入格式 JSON）</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button admin-icon-button-danger" aria-label="删除账号" onClick={() => setDeleteTarget(token)} disabled={busy || Boolean(busyTokenActions[token.id])}><Trash2 size={16} aria-hidden="true" /></button></TooltipTrigger><TooltipContent>从数据库删除账号</TooltipContent></Tooltip>
                  </div></TableCell>
                </TableRow>
              )) : <TableRow><TableCell colSpan={9} className="account-table-empty">暂无账号，请点击上方“新增账号”。</TableCell></TableRow>}
            </TableBody>
          </Table>
        )}
        <div className="account-pagination"><div className="account-pagination-info"><span>第 {page} / {pageCount} 页，共 {filteredTokens.length} 条</span><div className="account-pagination-size"><span>每页</span><Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger className="account-page-size-select" aria-label="每页显示数量"><SelectValue /></SelectTrigger><SelectContent>{PAGE_SIZE_OPTIONS.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent></Select><span>条</span></div></div><div className="account-pagination-actions"><button type="button" className="admin-button admin-button-small account-pagination-button" aria-label="上一页" title="上一页" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={16} aria-hidden="true" /></button><button type="button" className="admin-button admin-button-small account-pagination-button" aria-label="下一页" title="下一页" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}><ChevronRight size={16} aria-hidden="true" /></button></div></div>
      </section>

    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !busy && !(deleteTarget && busyTokenActions[deleteTarget.id] === "delete")) setDeleteTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除账号？</AlertDialogTitle>
          <AlertDialogDescription>确定从数据库删除「{deleteTarget?.accountName ?? "当前账号"}」及其 Token、Cookie 刷新配置吗？任务历史会保留账号快照，删除操作无法恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy || Boolean(deleteTarget && busyTokenActions[deleteTarget.id] === "delete")}>取消</AlertDialogCancel>
          <AlertDialogAction disabled={busy || Boolean(deleteTarget && busyTokenActions[deleteTarget.id] === "delete")} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(event) => { event.preventDefault(); void deleteToken(); }}>{deleteTarget && busyTokenActions[deleteTarget.id] === "delete" ? <Loader2 className="account-action-spinner" size={15} aria-hidden="true" /> : null}删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={batchDeleteOpen} onOpenChange={(open) => { if (!open && !busy) setBatchDeleteOpen(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认批量删除？</AlertDialogTitle>
          <AlertDialogDescription>确定删除选中的 {selected.size} 个 Token 吗？删除后无法恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(event) => { event.preventDefault(); void deleteSelectedTokens(); }}>{busy ? <Loader2 className="account-action-spinner" size={15} aria-hidden="true" /> : null}删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog open={tokenModal} onOpenChange={setTokenModal}>
      <DialogContent className="account-add-dialog">
        <DialogHeader>
          <DialogTitle>新增 Adobe 账号</DialogTitle>
          <DialogDescription>粘贴账号 JSON，支持单个账号对象、JSON 数组或 accounts 数组；不需要上传文件。</DialogDescription>
        </DialogHeader>
        <div className="account-add-dialog-body">
          <label className="account-add-field" htmlFor="token-input">
            <span>账号 JSON</span>
            <Textarea
              id="token-input"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              rows={14}
              className="account-add-textarea"
              placeholder={'{\n  "email": "name@example.com",\n  "display_name": "Adobe 账号",\n  "account_id": null,\n  "source_host": "proxy.example.com:80",\n  "credits_total": 50000,\n  "credits_available": 50000,\n  "credits_available_until": "2026-09-14T21:14:25Z",\n  "token": "eyJ...",\n  "cookie": "relay=...; ims_sid=...; aux_sid=...",\n  "ims_sid": "...",\n  "password": null\n}'}
            />
            <small>支持 token、cookie、ims_sid、display_name、account_id、email 和额度字段；source_host/password 仅兼容读取，代理请在代理池配置；敏感内容仅加密保存。</small>
          </label>
        </div>
        <DialogFooter className="account-add-dialog-footer">
          <Button type="button" variant="outline" onClick={() => setTokenModal(false)}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void importAccounts()}>{busy ? "保存中…" : "确认添加"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={tokenImportOpen} onOpenChange={(open) => { if (!open && !busy) { setTokenImportOpen(false); setTokenImportInput(""); setTokenImportName(""); } }}>
      <DialogContent className="account-add-dialog">
        <DialogHeader>
          <DialogTitle>Token 导入</DialogTitle>
          <DialogDescription>粘贴单个 Adobe access token（JWT），直接加入账号池，无需上传文件。</DialogDescription>
        </DialogHeader>
        <div className="account-add-dialog-body">
          <label className="account-add-field" htmlFor="single-token-input">
            <span>Access Token</span>
            <Textarea
              id="single-token-input"
              value={tokenImportInput}
              onChange={(event) => setTokenImportInput(event.target.value)}
              rows={8}
              className="account-add-textarea"
              placeholder="eyJhbGciOiJSUzI1NiIs..."
            />
            <small>支持带 Bearer 前缀（自动去除）；按 email / 账号 ID 去重，重复则覆盖更新 token。</small>
          </label>
          <label className="account-add-field" htmlFor="single-token-name">
            <span>账号名（可选）</span>
            <input id="single-token-name" className="admin-input" value={tokenImportName} onChange={(event) => setTokenImportName(event.target.value)} placeholder="例如 my-account" />
          </label>
        </div>
        <DialogFooter className="account-add-dialog-footer">
          <Button type="button" variant="outline" onClick={() => { setTokenImportOpen(false); setTokenImportInput(""); setTokenImportName(""); }}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void importSingleToken()}>{busy ? "导入中…" : "导入 Token"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={cookieImportOpen} onOpenChange={(open) => { if (!open && !busy) { setCookieImportOpen(false); setCookieImportInput(""); setCookieImportName(""); } }}>
      <DialogContent className="account-add-dialog">
        <DialogHeader>
          <DialogTitle>Cookie 导入</DialogTitle>
          <DialogDescription>粘贴 Adobe 登录 Cookie（含 ims_sid / relay 等），导入后自动刷新换取 access token。</DialogDescription>
        </DialogHeader>
        <div className="account-add-dialog-body">
          <label className="account-add-field" htmlFor="single-cookie-input">
            <span>Cookie</span>
            <Textarea
              id="single-cookie-input"
              value={cookieImportInput}
              onChange={(event) => setCookieImportInput(event.target.value)}
              rows={8}
              className="account-add-textarea"
              placeholder="relay=...; ims_sid=...; aux_sid=...; s_ecid=..."
            />
            <small>可粘贴整段 cookie 字符串（含 Cookie: 前缀会自动去除），导入后自动触发一次刷新。</small>
          </label>
          <label className="account-add-field" htmlFor="single-cookie-name">
            <span>名称（可选）</span>
            <input id="single-cookie-name" className="admin-input" value={cookieImportName} onChange={(event) => setCookieImportName(event.target.value)} placeholder="例如 adobe-account-01" />
          </label>
        </div>
        <DialogFooter className="account-add-dialog-footer">
          <Button type="button" variant="outline" onClick={() => { setCookieImportOpen(false); setCookieImportInput(""); setCookieImportName(""); }}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void importSingleCookie()}>{busy ? "导入中…" : "导入 Cookie"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={batchImportOpen} onOpenChange={(open) => { if (!open && !importProgress.running) { setBatchImportOpen(false); setImportFile(null); setImportCount(0); setImportProgress(EMPTY_IMPORT_PROGRESS); } }}>
      <DialogContent className="account-refresh-dialog">
        <DialogHeader>
          <DialogTitle>批量导入账号</DialogTitle>
          <DialogDescription>{importCount > 0 ? `已解析 ${importCount} 个账号，每批导入 10 个` : "选择 JSON 文件（支持 {users:[...]}、{accounts:[...]} 或数组结构）"}</DialogDescription>
        </DialogHeader>
        {!importCount && !importProgress.running ? (
          <label className="account-import-file">
            <Upload size={20} aria-hidden="true" />
            <span>选择 JSON 文件</span>
            <input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) parseImportFile(file); }} />
          </label>
        ) : null}
        {importCount > 0 ? (
          <div className="account-import-ready">
            <p><strong>{importCount}</strong> 个账号待导入</p>
            {importProgress.running || importProgress.done > 0 ? (
              <>
                <div className="account-refresh-progress" role="progressbar" aria-valuenow={importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
                  <div className="account-refresh-progress-bar" style={{ width: `${importProgress.total > 0 ? (importProgress.done / importProgress.total) * 100 : 0}%` }} />
                </div>
                <div className="account-import-stats">
                  <span>批次 <strong>{importProgress.batch}</strong> / {Math.ceil(importProgress.total / importProgress.batchSize)}</span>
                  <span>进度 <strong>{importProgress.done}</strong> / {importProgress.total}</span>
                  <span>✅ 新增 <strong>{importProgress.ok}</strong></span>
                  <span>♻️ 重复 <strong>{importProgress.duplicate}</strong></span>
                  <span>❌ 失败 <strong>{importProgress.failed}</strong></span>
                </div>
                {!importProgress.running && importProgress.done >= importProgress.total && importProgress.total > 0 ? (
                  <p className="account-import-done">{importProgress.refreshPending > 0 ? `完成！${importProgress.refreshPending} 个新 Cookie 资料待刷新，建议用「刷新积分」批量执行` : "导入完成"}</p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        <DialogFooter className="account-refresh-dialog-footer">
          <Button type="button" variant="outline" disabled={importProgress.running} onClick={() => { setBatchImportOpen(false); setImportFile(null); setImportCount(0); setImportProgress(EMPTY_IMPORT_PROGRESS); }}>{importProgress.running ? "导入中…" : "关闭"}</Button>
          {importCount > 0 && !importProgress.running ? (
            <Button type="button" disabled={importProgress.done >= importProgress.total && importProgress.total > 0} onClick={() => void startBatchImport()}>{importProgress.done > 0 ? "重新导入" : "开始导入"}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={refreshModalOpen} onOpenChange={setRefreshModalOpen}>
      <DialogContent className="account-refresh-dialog">
        <DialogHeader>
          <DialogTitle>刷新积分</DialogTitle>
          <DialogDescription>{refreshProgress.perProxy > 0 && refreshProgress.proxyCount > 0 ? `线程 ${refreshProgress.perProxy} × IP ${refreshProgress.proxyCount} = ${refreshProgress.concurrency} 总线程` : `并发 ${refreshProgress.concurrency} 线程`} · 已完成 {refreshProgress.done} / {refreshProgress.total}{refreshProgress.done >= refreshProgress.total && refreshProgress.total > 0 ? " · 全部完成" : ""}</DialogDescription>
        </DialogHeader>
        <div className="account-refresh-progress" role="progressbar" aria-valuenow={refreshProgress.total > 0 ? Math.round((refreshProgress.done / refreshProgress.total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
          <div className="account-refresh-progress-bar" style={{ width: `${refreshProgress.total > 0 ? (refreshProgress.done / refreshProgress.total) * 100 : 0}%` }} />
        </div>
        <div className="account-refresh-stats">
          <span>✅ 成功 <strong>{refreshProgress.ok}</strong></span>
          <span>❌ 失败 <strong>{refreshProgress.failed}</strong></span>
          <span>⚠️ 失效 <strong>{refreshProgress.unauthorized}</strong></span>
        </div>
        <div className="account-refresh-tasks">
          {refreshTasks.map((task) => (
            <div key={task.id} className={`account-refresh-task account-refresh-task-${task.status}`}>
              <span className="account-refresh-task-name">{task.name}</span>
              <span className="account-refresh-task-status">
                {task.status === "running" ? <><Loader2 className="account-action-spinner" size={13} aria-hidden="true" />刷新中</> : null}
                {task.status === "pending" ? "等待中" : null}
                {task.status === "ok" ? (task.detail ?? "成功") : null}
                {task.status === "failed" ? (task.detail ?? "失败") : null}
                {task.status === "unauthorized" ? (task.detail ?? "401 已失效") : null}
              </span>
            </div>
          ))}
        </div>
        <DialogFooter className="account-refresh-dialog-footer">
          <Button type="button" variant="outline" onClick={() => setRefreshModalOpen(false)}>{refreshing ? "后台继续" : "关闭"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  );
}

