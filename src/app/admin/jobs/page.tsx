"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Eye, Info, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type JobStatus = "QUEUED" | "UPLOADING" | "SUBMITTING" | "POLLING" | "DOWNLOADING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "SUBMISSION_UNKNOWN";
type Attempt = {
  stage: string;
  attemptNumber: number;
  proxyId?: string | null;
  proxyHost?: string | null;
  status: string;
  errorCategory?: string | null;
  errorMessage?: string | null;
  upstreamStatus?: number | null;
  startedAt: string;
  finishedAt?: string | null;
};
type JobEvent = {
  type: string;
  createdAt: string;
  progress?: number | null;
  stage?: string | null;
  proxyId?: string | null;
  attemptIndex?: number | null;
  upstreamTaskId?: string | null;
};
type Media = { objectKey: string; mimeType: string; byteSize: string; previewPath: string };
type Job = {
  id: string;
  status: JobStatus;
  kind: string;
  apiPath: string;
  model?: string | null;
  account?: { id: string; displayName: string; email?: string | null } | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  durationSeconds: number;
  progress?: number | null;
  creditCost?: number | null;
  promptText?: string | null;
  promptPreview?: string | null;
  currentStage?: string | null;
  currentProxyId?: string | null;
  proxyHost?: string | null;
  upstreamStatus?: number | null;
  attemptCount: number;
  upstreamTaskId?: string | null;
  latestEvent?: JobEvent | null;
  attempts: Attempt[];
  events: JobEvent[];
  media: Media[];
};

const statusLabels: Record<JobStatus, string> = {
  QUEUED: "排队中",
  UPLOADING: "上传中",
  SUBMITTING: "提交中",
  POLLING: "生成中",
  DOWNLOADING: "下载中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  SUBMISSION_UNKNOWN: "待确认",
};

const stageLabels: Record<string, string> = {
  UPLOAD: "上传",
  SUBMIT: "提交",
  POLL: "轮询",
  DOWNLOAD: "下载",
  REFRESH: "刷新",
};

const eventLabels: Record<string, string> = {
  QUEUED: "进入队列",
  UPLOADING: "开始上传",
  SUBMITTING: "开始提交",
  POLLING: "等待 Adobe 结果",
  DOWNLOADING: "开始下载",
  SUCCEEDED: "任务完成",
  FAILED: "任务失败",
  CANCELLED: "任务取消",
  SUBMISSION_UNKNOWN: "提交结果待确认",
  PROXY_SWITCH: "切换代理",
  POLL_PROGRESS: "Adobe 生成进度",
};

/** 请求日志中的错误码 → 管理员可理解的中文说明。 */
const errorLabels: Record<string, string> = {
  adobe_upstream_rejected: "Adobe 拒绝了请求（多为代理 IP 被风控或请求参数问题）",
  adobe_upstream_temporary: "Adobe 上游暂时不可用",
  adobe_auth_failed: "Adobe 授权失败（Token 失效）",
  adobe_quota_exhausted: "Adobe 额度已耗尽",
  adobe_rate_limited: "Adobe 触发限流",
  adobe_generation_timeout: "Adobe 生成超时",
  adobe_account_concurrency_limit: "单账号并发已满（任务已回队）",
  proxy_exhausted: "所有代理节点均失败",
  proxy_pool_empty: "代理池为空",
  job_lease_lost: "任务租约丢失",
  submission_unknown: "提交结果待确认",
  media_missing: "生成结果缺失",
  invalid_model: "模型不支持",
  invalid_request_error: "请求参数错误",
};

function errorLabel(code: string): string {
  return errorLabels[code] ?? code;
}

const activeStatuses = new Set<JobStatus>(["QUEUED", "UPLOADING", "SUBMITTING", "POLLING", "DOWNLOADING"]);
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

function statusLabel(status: JobStatus) {
  return statusLabels[status] ?? status;
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "/");
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 1) return "<1 秒";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function shortId(value?: string | null) {
  const text = String(value ?? "");
  return text ? `${text.slice(0, 8)}…` : "直连";
}

function stageLabel(value?: string | null) {
  return value ? stageLabels[value] ?? value : "等待 Worker";
}

function attemptStatusLabel(value: string) {
  switch (value) {
    case "SUCCEEDED": return "成功";
    case "FAILED": return "失败";
    case "RUNNING": return "进行中";
    case "SKIPPED": return "已跳过";
    default: return value;
  }
}

function isActive(job: Job) {
  return activeStatuses.has(job.status);
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [preview, setPreview] = useState<{ url: string; mimeType: string } | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const loadingRef = useRef(false);

  const loadJobs = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) setRefreshing(true);
    try {
      const response = await fetch("/api/admin/jobs", { cache: "no-store" });
      if (!response.ok) throw new Error("加载请求日志失败");
      const data = await response.json() as { jobs?: Job[] };
      const nextJobs = Array.isArray(data.jobs) ? data.jobs : [];
      setJobs(nextJobs);
      setSelectedJob((current) => current ? nextJobs.find((job) => job.id === current.id) ?? current : null);
    } catch {
      if (!silent) setJobs([]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadJobs(), 0);
    const timer = window.setInterval(() => void loadJobs(true), 2500);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [loadJobs]);

  const stats = useMemo(() => ({
    total: jobs.length,
    running: jobs.filter(isActive).length,
    failed: jobs.filter((job) => job.status === "FAILED" || job.status === "SUBMISSION_UNKNOWN").length,
    completed: jobs.filter((job) => job.status === "SUCCEEDED").length,
  }), [jobs]);
  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesQuery = !normalizedQuery || [
        job.account?.displayName ?? "",
        job.account?.email ?? "",
        job.model ?? "",
        job.promptText ?? job.promptPreview ?? "",
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "running" && isActive(job))
        || (statusFilter === "completed" && job.status === "SUCCEEDED")
        || (statusFilter === "failed" && (job.status === "FAILED" || job.status === "SUBMISSION_UNKNOWN"));
      const matchesKind = kindFilter === "all" || job.kind === kindFilter;
      return matchesQuery && matchesStatus && matchesKind;
    });
  }, [jobs, kindFilter, query, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  const visibleJobs = useMemo(
    () => filteredJobs.slice((page - 1) * pageSize, page * pageSize),
    [filteredJobs, page, pageSize],
  );
  const visibleIds = useMemo(() => visibleJobs.map((job) => job.id), [visibleJobs]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  function toggleSelectJob(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  async function deleteSelectedJobs() {
    if (selectedIds.size === 0) { toast.warning("请先勾选要删除的请求日志"); return; }
    if (!window.confirm(`确定删除选中的 ${selectedIds.size} 条请求日志？此操作不可恢复。`)) return;
    setDeleting(true);
    try {
      const response = await fetch("/api/admin/jobs", {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-csrf-token": "same-origin" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "批量删除失败");
      toast.success(`已删除 ${selectedIds.size} 条请求日志`);
      setSelectedIds(new Set());
      await loadJobs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量删除失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="admin-page account-page jobs-page">
        <section className="admin-card account-overview-card admin-management-overview">
          <div className="account-overview-actions">
            <button type="button" className="admin-button admin-button-icon-text" onClick={() => void loadJobs()} disabled={refreshing}>
              <RefreshCw size={15} className={refreshing ? "jobs-refresh-spin" : undefined} aria-hidden="true" />
              刷新列表
            </button>
          </div>
          <div className="account-summary-grid jobs-summary-grid" aria-label="请求统计">
            <div className="admin-card"><span>请求总数</span><strong>{stats.total}</strong></div>
            <div className="admin-card"><span>进行中</span><strong>{stats.running}</strong></div>
            <div className="admin-card"><span>已完成</span><strong>{stats.completed}</strong></div>
            <div className="admin-card"><span>失败</span><strong>{stats.failed}</strong></div>
          </div>
        </section>

        <section className="admin-card account-list-card admin-management-list">
          <div className="account-list-filters">
            <label className="account-search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">搜索请求</span>
              <input
                value={query}
                onChange={(event) => { setQuery(event.target.value); setPage(1); }}
                placeholder="搜索账号 / 模型 / 提示词"
              />
            </label>
            <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPage(1); }}>
              <SelectTrigger className="account-filter-select" aria-label="按状态筛选"><SelectValue placeholder="全部状态" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="running">进行中</SelectItem>
                <SelectItem value="completed">已完成</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kindFilter} onValueChange={(value) => { setKindFilter(value); setPage(1); }}>
              <SelectTrigger className="account-filter-select" aria-label="按类型筛选"><SelectValue placeholder="全部类型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="GENERATION">生成请求</SelectItem>
                <SelectItem value="ENTITY_CREATE">实体创建</SelectItem>
                <SelectItem value="ENTITY_SYNC">实体同步</SelectItem>
                <SelectItem value="ENTITY_DELETE">实体删除</SelectItem>
                <SelectItem value="REFRESH">刷新任务</SelectItem>
              </SelectContent>
            </Select>
            <button type="button" className="admin-button admin-button-icon-text account-search-button" onClick={() => setPage(1)}>
              <Search size={15} aria-hidden="true" />搜索
            </button>
            <button
              type="button"
              className="admin-button admin-button-icon-text"
              onClick={() => void deleteSelectedJobs()}
              disabled={selectedIds.size === 0 || deleting}
            >
              <Trash2 size={15} aria-hidden="true" />批量删除{selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}
            </button>
          </div>
          {loading && jobs.length === 0 ? <p className="admin-empty account-table-loading">加载中...</p> : null}
          {!loading || jobs.length > 0 ? (
            <Table className="admin-table account-token-table jobs-table">
              <colgroup>
                <col className="jobs-col-select" />
                <col className="jobs-col-time" />
                <col className="jobs-col-status" />
                <col className="jobs-col-duration" />
                <col className="jobs-col-progress" />
                <col className="jobs-col-duration" />
                <col className="jobs-col-account" />
                <col className="jobs-col-model" />
                <col className="jobs-col-prompt" />
                <col className="jobs-col-actions" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="jobs-sticky jobs-sticky-select">
                    <input type="checkbox" aria-label="全选本页" checked={allVisibleSelected} onChange={toggleSelectVisible} disabled={visibleIds.length === 0} />
                  </TableHead>
                  <TableHead className="jobs-sticky jobs-sticky-time">时间</TableHead>
                  <TableHead className="jobs-sticky jobs-sticky-status">状态</TableHead>
                  <TableHead className="jobs-sticky jobs-sticky-duration">耗时</TableHead>
                  <TableHead>进度</TableHead>
                  <TableHead>消耗积分</TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>提示词</TableHead>
                  <TableHead className="jobs-sticky jobs-sticky-actions">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleJobs.length ? visibleJobs.map((job) => {
                  const media = job.media[0];
                  const accountText = job.account?.email || job.account?.displayName || "—";
                  const percent = job.progress === null || job.progress === undefined ? null : Math.round(job.progress);
                  return (
                    <TableRow key={job.id}>
                      <TableCell className="jobs-sticky jobs-sticky-select">
                        <input type="checkbox" aria-label={`选择 ${job.id}`} checked={selectedIds.has(job.id)} onChange={() => toggleSelectJob(job.id)} />
                      </TableCell>
                      <TableCell className="jobs-time-cell jobs-sticky jobs-sticky-time"><span>{formatDate(job.createdAt).slice(0, 10)}</span><small>{formatDate(job.createdAt).slice(12)}</small></TableCell>
                      <TableCell className="jobs-sticky jobs-sticky-status">
                        <span className={`admin-status admin-status-${job.status.toLowerCase()}`}>{statusLabel(job.status)}</span>
                        <small className="jobs-stage-text" title={job.errorCode ? `${job.errorCode}: ${errorLabel(job.errorCode)}` : undefined}>{stageLabel(job.currentStage)} · {job.proxyHost ?? "直连"}{job.upstreamStatus ? ` · HTTP ${job.upstreamStatus}` : ""}{job.errorCode ? ` · ${job.errorCode}` : ""}</small>
                      </TableCell>
                      <TableCell className="jobs-nowrap jobs-sticky jobs-sticky-duration">{formatDuration(job.durationSeconds)}</TableCell>
                      <TableCell className="jobs-progress-cell">
                        {percent === null ? "—" : <><div className="jobs-progress-track"><span style={{ width: `${percent}%` }} /></div><small>{percent}%</small></>}
                      </TableCell>
                      <TableCell className="jobs-nowrap">{typeof job.creditCost === "number" ? <>{job.creditCost.toLocaleString("zh-CN")}<small className="jobs-credit-cost"> 积分</small></> : "—"}</TableCell>
                      <TableCell className="jobs-account-cell" title={job.account?.displayName ?? undefined}>{accountText}</TableCell>
                      <TableCell className="jobs-model-cell" title={job.model ?? undefined}>{job.model ?? "—"}</TableCell>
                      <TableCell className="jobs-prompt-cell" title={job.promptText ?? job.promptPreview ?? undefined}><div className="jobs-prompt-cell-scroll">{job.promptText ?? job.promptPreview ?? "—"}</div></TableCell>
                      <TableCell className="jobs-sticky jobs-sticky-actions">
                        <div className="admin-table-actions">
                          {media ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button type="button" className="admin-icon-button" aria-label="查看生成结果" onClick={() => setPreview({ url: media.previewPath, mimeType: media.mimeType })}>
                                  <Eye size={16} />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>查看生成结果</TooltipContent>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button type="button" className="admin-icon-button" aria-label="查看请求详情" onClick={() => setSelectedJob(job)}>
                                <Info size={16} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>查看请求详情</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }) : <TableRow><TableCell colSpan={10} className="account-table-empty">暂无请求日志</TableCell></TableRow>}
              </TableBody>
            </Table>
          ) : null}
          <div className="account-pagination">
            <div className="account-pagination-info">
              <span>第 {page} / {pageCount} 页，共 {filteredJobs.length} 条</span>
              <div className="account-pagination-size">
                <span>每页</span>
                <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
                  <SelectTrigger className="account-page-size-select" aria-label="每页显示数量"><SelectValue /></SelectTrigger>
                  <SelectContent>{PAGE_SIZE_OPTIONS.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
                </Select>
                <span>条</span>
              </div>
            </div>
            <div className="account-pagination-actions">
              <button type="button" className="admin-button admin-button-small account-pagination-button" aria-label="上一页" title="上一页" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button type="button" className="admin-button admin-button-small account-pagination-button" aria-label="下一页" title="下一页" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      </div>

      <Dialog open={Boolean(selectedJob)} onOpenChange={(open) => { if (!open) setSelectedJob(null); }}>
        <DialogContent className="jobs-detail-dialog">
          {selectedJob ? (
            <div className="jobs-detail-content">
              <DialogHeader className="jobs-detail-header">
                <DialogTitle>请求详情</DialogTitle>
                <DialogDescription className="jobs-detail-id">{selectedJob.id}</DialogDescription>
              </DialogHeader>
              <div className="jobs-detail-summary">
                <div className="jobs-detail-field"><span>状态</span><strong><span className={`admin-status admin-status-${selectedJob.status.toLowerCase()}`}>{statusLabel(selectedJob.status)}</span></strong></div>
                <div className="jobs-detail-field"><span>耗时</span><strong>{formatDuration(selectedJob.durationSeconds)}</strong></div>
                <div className="jobs-detail-field"><span>创建时间</span><strong>{formatDate(selectedJob.createdAt)}</strong></div>
                <div className="jobs-detail-field"><span>接口</span><strong className="jobs-detail-code">{selectedJob.apiPath}</strong></div>
                <div className="jobs-detail-field"><span>模型</span><strong>{selectedJob.model ?? "—"}</strong></div>
                <div className="jobs-detail-field"><span>账号</span><strong className="jobs-detail-break">{selectedJob.account?.email || selectedJob.account?.displayName || "—"}</strong></div>
                <div className="jobs-detail-field"><span>上游任务</span><strong className="jobs-detail-break">{selectedJob.upstreamTaskId ?? "—"}</strong></div>
                <div className="jobs-detail-field"><span>尝试次数</span><strong>{selectedJob.attemptCount}</strong></div>
                <div className="jobs-detail-field"><span>当前代理</span><strong className="jobs-detail-break">{selectedJob.proxyHost ?? "—"}</strong></div>
              </div>
              <section className="jobs-detail-section jobs-detail-prompt-section">
                <div className="jobs-detail-section-header"><div><h3>提示词</h3><span>{selectedJob.promptText ? `${selectedJob.promptText.length} 字符` : "暂无内容"}</span></div></div>
                <div className="jobs-prompt-box">{selectedJob.promptText ?? selectedJob.promptPreview ?? "—"}</div>
              </section>
              {selectedJob.errorCode ? <section className="jobs-detail-error"><div><strong>{errorLabel(selectedJob.errorCode)}</strong><span>{selectedJob.upstreamStatus ? `上游 HTTP ${selectedJob.upstreamStatus} · ` : ""}{selectedJob.errorMessage ?? "请求失败"}</span></div></section> : null}
              <section className="jobs-detail-section">
                <div className="jobs-detail-section-header"><div><h3>阶段尝试</h3><span>按执行顺序记录</span></div><b>{selectedJob.attempts.length}</b></div>
                <div className="jobs-attempt-list">{selectedJob.attempts.length ? selectedJob.attempts.map((attempt) => <div key={`${attempt.stage}-${attempt.attemptNumber}`} className="jobs-attempt"><div className="jobs-attempt-main"><strong>{stageLabel(attempt.stage)} <em>#{attempt.attemptNumber}</em></strong><span className={`jobs-attempt-status jobs-attempt-status-${attempt.status.toLowerCase()}`}>{attemptStatusLabel(attempt.status)}</span></div><div className="jobs-attempt-meta"><span>{attempt.proxyHost ? `代理 ${attempt.proxyHost}` : attempt.proxyId ? `代理 ${shortId(attempt.proxyId)}` : "直连"}</span>{attempt.upstreamStatus ? <span>HTTP {attempt.upstreamStatus}</span> : null}<time>{formatDate(attempt.startedAt)}</time></div>{attempt.errorCategory ? <small>{attempt.errorCategory}</small> : null}{attempt.errorMessage ? <small className="jobs-attempt-error">{attempt.errorMessage}</small> : null}</div>) : <span className="jobs-empty-detail">尚未开始阶段尝试</span>}</div>
              </section>
              <section className="jobs-detail-section">
                <div className="jobs-detail-section-header"><div><h3>事件时间线</h3><span>任务执行过程</span></div><b>{selectedJob.events.length}</b></div>
                <div className="jobs-event-list">{selectedJob.events.length ? selectedJob.events.slice().reverse().map((event, index) => <div key={`${event.type}-${event.createdAt}-${index}`} className="jobs-event"><i aria-hidden="true" /><div><strong>{eventLabels[event.type] ?? event.type}</strong><time>{formatDate(event.createdAt)}</time></div>{event.progress !== null && event.progress !== undefined ? <small>{Math.round(event.progress)}%</small> : null}</div>) : <span className="jobs-empty-detail">暂无事件</span>}</div>
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="jobs-preview-dialog">
          <DialogHeader><DialogTitle>生成结果</DialogTitle></DialogHeader>
          {preview?.mimeType.startsWith("video/") ? <video src={preview.url} controls playsInline className="jobs-preview-media" /> : preview ? <Image src={preview.url} alt="生成结果" width={1200} height={1200} unoptimized className="jobs-preview-media" /> : null}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
