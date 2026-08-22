"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Eye, EyeOff, Globe, Pencil, Plus, Search, TestTube2, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ProxyNode = {
  id: string;
  protocol: "HTTP" | "SOCKS5";
  host: string;
  port: number;
  enabled: boolean;
  username: string | null;
  password: string | null;
  version: number;
};

type ProxyTestResult = { id: string; host: string; port: number; ok: boolean; status: number; latencyMs: number; error?: string };

type ProxyPoolResponse = {
  nodes: ProxyNode[];
};

type ProxyBatchError = {
  error?: {
    message?: string;
    details?: { errors?: Array<{ line: number; message: string }> };
  };
};

async function readResponse(response: Response) {
  return response.json().catch(() => ({})) as Promise<ProxyBatchError>;
}

// 批量校验失败时把具体行号拼进提示，避免只显示笼统的 "invalid"。
function batchErrorMessage(data: ProxyBatchError, fallback: string): string {
  const errors = data.error?.details?.errors;
  if (errors?.length) {
    return `有 ${errors.length} 条代理格式无效：\n` + errors.map((e) => `第 ${e.line} 行: ${e.message}`).join("\n");
  }
  return data.error?.message ?? fallback;
}

function proxyUrlOf(node: ProxyNode): string {
  const encodedUser = node.username ? encodeURIComponent(node.username) : "";
  const encodedPass = node.password ? encodeURIComponent(node.password) : "";
  const auth = encodedUser ? `${encodedUser}${encodedPass ? `:${encodedPass}` : ""}@` : "";
  return `${node.protocol === "SOCKS5" ? "socks5" : "http"}://${auth}${node.host}:${node.port}`;
}

function shortLatency(ms: number): string {
  return `${ms}ms`;
}

export default function ProxyPoolPage() {
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [query, setQuery] = useState("");
  const [protocolFilter, setProtocolFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 新增弹窗
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");

  // 编辑弹窗（参考目标站点：协议/主机/端口/用户名/密码留空保持/状态）
  const [editTarget, setEditTarget] = useState<ProxyNode | null>(null);
  const [editProtocol, setEditProtocol] = useState<"HTTP" | "SOCKS5">("HTTP");
  const [editHost, setEditHost] = useState("");
  const [editPort, setEditPort] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<ProxyNode | null>(null);

  // 测试：正在测试的 id 集合 + 每节点最近结果
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, ProxyTestResult>>({});
  // 密码明文显隐
  const [revealPasswords, setRevealPasswords] = useState<Set<string>>(new Set());

  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return nodes.filter((node) => {
      const matchesQuery = !normalized ||
        node.host.toLowerCase().includes(normalized) ||
        String(node.port).includes(normalized) ||
        (node.username ?? "").toLowerCase().includes(normalized);
      const matchesProtocol = protocolFilter === "all" || node.protocol === protocolFilter;
      const matchesStatus = statusFilter === "all" || (statusFilter === "enabled" ? node.enabled : !node.enabled);
      return matchesQuery && matchesProtocol && matchesStatus;
    });
  }, [nodes, query, protocolFilter, statusFilter]);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/proxy-pool", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as ProxyPoolResponse;
      if (!response.ok) throw new Error("代理池加载失败");
      setNodes(data.nodes ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "代理池加载失败");
    } finally {
      setLoading(false);
    }
  }

  // 首次加载把 MySQL 中的代理配置同步到页面。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  async function request(method: "POST" | "PATCH" | "DELETE", url: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify(body) });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error?.message ?? "操作失败");
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // 新增：多行粘贴，一行一条。
  async function addNodes() {
    const raw = addInput.trim();
    if (!raw) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/proxy-pool", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "same-origin" },
        body: JSON.stringify({ raw }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(batchErrorMessage(data, "代理保存失败"));
      toast.success("代理已加入代理池");
      setAddInput("");
      setAddOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "代理保存失败");
    } finally {
      setBusy(false);
    }
  }

  function openEdit(node: ProxyNode) {
    setEditTarget(node);
    setEditProtocol(node.protocol);
    setEditHost(node.host);
    setEditPort(String(node.port));
    setEditUsername(node.username ?? "");
    setEditPassword("");
    setEditEnabled(node.enabled);
  }

  // 编辑：分字段提交；密码留空表示保持不变。
  async function saveEdit() {
    if (!editTarget) return;
    const port = Number(editPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("端口必须是 1-65535 的整数");
      return;
    }
    if (!editHost.trim()) {
      toast.error("主机不能为空");
      return;
    }
    const body: Record<string, unknown> = {
      id: editTarget.id,
      protocol: editProtocol,
      host: editHost.trim(),
      port,
      username: editUsername.trim() ? editUsername.trim() : null,
      enabled: editEnabled,
    };
    if (editPassword) body.password = editPassword;
    const data = await request("PATCH", "/api/admin/proxy-pool", body);
    if (data) {
      toast.success("代理已更新");
      setEditTarget(null);
      await load();
    }
  }

  async function deleteNode() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const data = await request("DELETE", "/api/admin/proxy-pool", { id: target.id });
    if (data) {
      setDeleteTarget(null);
      toast.success("代理已删除");
      await load();
    }
  }

  // 单个/批量测试连通性，结果更新到行内。
  async function runTest(ids: string[]) {
    const targets = ids.filter((id) => !testingIds.has(id));
    if (!targets.length) return;
    setTestingIds((current) => new Set([...current, ...targets]));
    try {
      const response = await fetch("/api/admin/proxy-pool/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "same-origin" },
        body: JSON.stringify({ ids: targets }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error?.message ?? "测试失败");
      const results = (data as { results?: ProxyTestResult[] }).results ?? [];
      setTestResults((current) => {
        const next = { ...current };
        for (const result of results) next[result.id] = result;
        return next;
      });
      const okCount = results.filter((item) => item.ok).length;
      toast.success(`测试完成：${okCount}/${results.length} 个代理可用`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试失败");
    } finally {
      setTestingIds((current) => {
        const next = new Set(current);
        for (const id of targets) next.delete(id);
        return next;
      });
    }
  }

  async function copyProxyUrl(node: ProxyNode) {
    try {
      await navigator.clipboard.writeText(proxyUrlOf(node));
      toast.success("代理 URL 已复制");
    } catch {
      toast.error("复制失败");
    }
  }

  function toggleReveal(id: string) {
    setRevealPasswords((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="admin-page proxy-pool-page">
      <section className="admin-card proxy-pool-overview-card">
        <div className="account-overview-actions">
          <button type="button" className="admin-button admin-button-icon-text" onClick={() => void runTest(nodes.filter((node) => node.enabled).map((node) => node.id))} disabled={busy || !nodes.length}><TestTube2 size={15} aria-hidden="true" />测试连接</button>
          <button type="button" className="admin-button admin-button-primary admin-button-icon-text" onClick={() => setAddOpen(true)}><Plus size={15} aria-hidden="true" />新增代理</button>
        </div>
      </section>

      <section className="admin-card proxy-pool-list-card">
        <div className="account-list-filters proxy-pool-list-toolbar">
          <label className="account-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">搜索代理</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索代理..." />
          </label>
          <Select value={protocolFilter} onValueChange={(value) => setProtocolFilter(value)}>
            <SelectTrigger className="account-filter-select" aria-label="按协议筛选"><SelectValue placeholder="全部协议" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部协议</SelectItem>
              <SelectItem value="HTTP">HTTP</SelectItem>
              <SelectItem value="SOCKS5">SOCKS5</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value)}>
            <SelectTrigger className="account-filter-select" aria-label="按状态筛选"><SelectValue placeholder="全部状态" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="enabled">已启用</SelectItem>
              <SelectItem value="disabled">已禁用</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {loading ? <p className="admin-empty proxy-pool-loading">正在加载代理池…</p> : (
          <div className="admin-table-wrap">
            <Table className="admin-table proxy-pool-table">
              <TableHeader>
                <TableRow>
                  <TableHead>协议</TableHead>
                  <TableHead>地址</TableHead>
                  <TableHead>认证</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredNodes.length ? filteredNodes.map((node) => {
                  const testing = testingIds.has(node.id);
                  const result = testResults[node.id];
                  return (
                    <TableRow key={node.id}>
                      <TableCell>
                        <span className="admin-status proxy-pool-protocol">
                          <Globe size={12} aria-hidden="true" />{node.protocol}
                        </span>
                      </TableCell>
                      <TableCell>
                        <strong className="proxy-pool-address">{node.host}:{node.port}</strong>
                      </TableCell>
                      <TableCell>
                        <div className="proxy-pool-auth">
                          <span className="proxy-pool-auth-user">{node.username ?? <span className="admin-muted">无</span>}</span>
                          {node.password ? (
                            <span className="proxy-pool-auth-pass">
                              {revealPasswords.has(node.id) ? node.password : "••••••"}
                              <button type="button" className="proxy-pool-auth-eye" aria-label={revealPasswords.has(node.id) ? "隐藏密码" : "显示密码"} onClick={() => toggleReveal(node.id)}>
                                {revealPasswords.has(node.id) ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                              </button>
                            </span>
                          ) : <span className="admin-muted">无密码</span>}
                          <Tooltip><TooltipTrigger asChild><button type="button" className="proxy-pool-copy" aria-label="复制代理 URL" onClick={() => void copyProxyUrl(node)}><Copy size={13} aria-hidden="true" /></button></TooltipTrigger><TooltipContent>复制代理 URL</TooltipContent></Tooltip>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="proxy-pool-status">
                          <span className={`admin-status${node.enabled ? " admin-status-healthy" : ""}`}>{node.enabled ? "已启用" : "已禁用"}</span>
                          {/* 结果区始终渲染，三种状态共用固定宽度，避免测试时列宽抖动 */}
                          <span className={`proxy-pool-latency${testing ? " is-testing" : result ? (result.ok ? " is-ok" : " is-bad") : " is-idle"}`}>
                            {testing ? "测试中…" : result ? (
                              <>
                                {result.ok ? <CheckCircle2 size={12} aria-hidden="true" /> : <XCircle size={12} aria-hidden="true" />}
                                {result.ok ? `${shortLatency(result.latencyMs)} · ${result.status}` : "不可达"}
                              </>
                            ) : "—"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="admin-table-actions">
                          <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button" aria-label="测试连接" disabled={testing || busy} onClick={() => void runTest([node.id])}><TestTube2 size={16} aria-hidden="true" /></button></TooltipTrigger><TooltipContent>测试连接</TooltipContent></Tooltip>
                          <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button" aria-label="编辑代理" disabled={busy} onClick={() => openEdit(node)}><Pencil size={16} aria-hidden="true" /></button></TooltipTrigger><TooltipContent>编辑代理</TooltipContent></Tooltip>
                          <Tooltip><TooltipTrigger asChild><button type="button" className="admin-icon-button admin-icon-button-danger" aria-label="删除代理" disabled={busy} onClick={() => setDeleteTarget(node)}><Trash2 size={16} aria-hidden="true" /></button></TooltipTrigger><TooltipContent>删除代理</TooltipContent></Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }) : (
                  <TableRow><TableCell colSpan={5} className="proxy-pool-table-empty">{nodes.length ? "没有匹配的代理" : "暂无代理，请点击上方「添加代理」。"}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除代理？</AlertDialogTitle>
            <AlertDialogDescription>将永久删除「{deleteTarget?.host}:{deleteTarget?.port}」，此操作不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(event) => { event.preventDefault(); void deleteNode(); }}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="proxy-pool-add-dialog">
          <DialogHeader>
            <DialogTitle>添加代理</DialogTitle>
            <DialogDescription>多行粘贴，一行一条。支持标准格式与 host:port:user:pass 顺序。</DialogDescription>
          </DialogHeader>
          <div className="proxy-pool-dialog-body">
            <label className="account-add-field" htmlFor="proxy-add-input">
              <span>代理列表</span>
              <Textarea
                id="proxy-add-input"
                value={addInput}
                onChange={(event) => setAddInput(event.target.value)}
                rows={12}
                className="proxy-pool-add-textarea font-mono text-sm"
                placeholder={["http://user:password@host:port", "socks5://host:port", "host:port:user:pass"].join("\n")}
              />
              <small>凭据只在服务端加密保存；{`{session}`} 等占位符会原样传给代理服务商处理。</small>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button type="button" disabled={busy || !addInput.trim()} onClick={() => void addNodes()}>{busy ? "保存中…" : "确认添加"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => { if (!open && !busy) setEditTarget(null); }}>
        <DialogContent className="proxy-pool-edit-dialog">
          <DialogHeader>
            <DialogTitle>编辑代理</DialogTitle>
            <DialogDescription>「{editTarget?.host}:{editTarget?.port}」；密码留空表示保持不变。</DialogDescription>
          </DialogHeader>
          <div className="proxy-pool-dialog-body proxy-pool-edit-fields">
            <label className="account-add-field">
              <span>协议</span>
              <Select value={editProtocol} onValueChange={(value) => setEditProtocol(value as "HTTP" | "SOCKS5")}>
                <SelectTrigger aria-label="协议"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="HTTP">HTTP</SelectItem>
                  <SelectItem value="SOCKS5">SOCKS5</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="account-add-field" htmlFor="proxy-edit-host">
              <span>主机</span>
              <Input id="proxy-edit-host" value={editHost} onChange={(event) => setEditHost(event.target.value)} className="font-mono text-sm" />
            </label>
            <label className="account-add-field" htmlFor="proxy-edit-port">
              <span>端口</span>
              <Input id="proxy-edit-port" type="number" min={1} max={65535} step={1} value={editPort} onChange={(event) => setEditPort(event.target.value)} />
            </label>
            <label className="account-add-field" htmlFor="proxy-edit-username">
              <span>用户名（可选）</span>
              <Input id="proxy-edit-username" value={editUsername} onChange={(event) => setEditUsername(event.target.value)} className="font-mono text-sm" />
            </label>
            <label className="account-add-field" htmlFor="proxy-edit-password">
              <span>密码（可选）</span>
              <Input id="proxy-edit-password" type="password" value={editPassword} onChange={(event) => setEditPassword(event.target.value)} placeholder="留空保持不变" className="font-mono text-sm" />
            </label>
            <label className="account-add-field">
              <span>状态</span>
              <button type="button" className={`admin-switch${editEnabled ? " is-on" : ""}`} onClick={() => setEditEnabled((current) => !current)}>{editEnabled ? "已启用" : "已禁用"}</button>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>取消</Button>
            <Button type="button" disabled={busy} onClick={() => void saveEdit()}>{busy ? "保存中…" : "更新"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
