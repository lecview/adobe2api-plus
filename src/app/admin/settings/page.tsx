"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Loader2, Save, Trash2 } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ApiKey = { id: string; name: string; prefix: string; active: boolean; createdAt: string; revokedAt: string | null; lastUsedAt: string | null };
type SettingCategory = "account" | "network" | "retry" | "storage";
type FormState = {
  proxyEnabled: boolean;
  publicBaseUrl: string;
  generateTimeoutSeconds: number;
  videoGenerateTimeoutSeconds: number;
  refreshIntervalHours: number;
  /** sherlockToken 定时刷新周期（分钟），默认 5 */
  sherlockRefreshMinutes: number;
  minCreditsThreshold: number;
  returnOriginalUrl: boolean;
  workerConcurrency: number;
  /** 是否启用 sherlockToken 定时自动刷新 */
  sherlockAutoRefreshEnabled: boolean;
  retryEnabled: boolean;
  retryMaxAttempts: number;
  retryBackoffSeconds: number;
  retryOnStatusCodes: string;
  retryOnErrorTypes: string;
  tokenRotationStrategy: "round_robin" | "random";
  batchConcurrency: number;
  creditsRefreshConcurrency: number;
  accountMaxConcurrency: number;
  generatedMaxSizeMb: number;
  generatedPruneSizeMb: number;
  adminUsername: string;
};

type SettingsResponse = {
  [key: string]: unknown;
  admin?: { username?: unknown };
  apiKeys?: unknown;
};

const defaults: FormState = {
  proxyEnabled: false, publicBaseUrl: "",
  generateTimeoutSeconds: 300, videoGenerateTimeoutSeconds: 600, refreshIntervalHours: 15, sherlockRefreshMinutes: 5, sherlockAutoRefreshEnabled: true, minCreditsThreshold: 100, returnOriginalUrl: false, workerConcurrency: 5, retryEnabled: true, retryMaxAttempts: 3, retryBackoffSeconds: 1,
  retryOnStatusCodes: "429,451,500,502,503,504", retryOnErrorTypes: "timeout,connection,proxy", tokenRotationStrategy: "round_robin",
  batchConcurrency: 5, creditsRefreshConcurrency: 1, accountMaxConcurrency: 3, generatedMaxSizeMb: 1024, generatedPruneSizeMb: 200, adminUsername: "admin",
};

function csvValues(value: string): string[] { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
function numberCsv(value: string): number[] { return [...new Set(csvValues(value).map(Number).filter((item) => Number.isInteger(item)))]; }
function responseValue(data: SettingsResponse, keys: string[], fallback: unknown): unknown {
  for (const key of keys) if (data[key] !== undefined) return data[key];
  return fallback;
}
function settingNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function settingBoolean(value: unknown, fallback: boolean): boolean { return typeof value === "boolean" ? value : fallback; }
function settingString(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function formFromResponse(data: SettingsResponse, fallback: FormState): FormState {
  const admin = data.admin && typeof data.admin === "object" ? data.admin : undefined;
  const retryStatusCodes = responseValue(data, ["retryOnStatusCodes", "retry_on_status_codes"], fallback.retryOnStatusCodes);
  const retryErrorTypes = responseValue(data, ["retryOnErrorTypes", "retry_on_error_types"], fallback.retryOnErrorTypes);
  const strategy = responseValue(data, ["tokenRotationStrategy", "token_rotation_strategy"], fallback.tokenRotationStrategy);
  return {
    proxyEnabled: settingBoolean(responseValue(data, ["proxyEnabled", "use_proxy"], fallback.proxyEnabled), fallback.proxyEnabled),
    publicBaseUrl: settingString(responseValue(data, ["publicBaseUrl", "public_base_url"], fallback.publicBaseUrl), fallback.publicBaseUrl),
    generateTimeoutSeconds: settingNumber(responseValue(data, ["generateTimeoutSeconds", "generate_timeout"], fallback.generateTimeoutSeconds), fallback.generateTimeoutSeconds),
    videoGenerateTimeoutSeconds: settingNumber(responseValue(data, ["videoGenerateTimeoutSeconds", "video_generate_timeout"], fallback.videoGenerateTimeoutSeconds), fallback.videoGenerateTimeoutSeconds),
    refreshIntervalHours: settingNumber(responseValue(data, ["refreshIntervalHours", "refresh_interval_hours"], fallback.refreshIntervalHours), fallback.refreshIntervalHours),
    sherlockRefreshMinutes: settingNumber(responseValue(data, ["sherlockRefreshMinutes", "sherlock_refresh_minutes"], fallback.sherlockRefreshMinutes), fallback.sherlockRefreshMinutes),
    sherlockAutoRefreshEnabled: settingBoolean(responseValue(data, ["sherlockAutoRefreshEnabled", "sherlock_auto_refresh_enabled"], fallback.sherlockAutoRefreshEnabled), fallback.sherlockAutoRefreshEnabled),
    minCreditsThreshold: settingNumber(responseValue(data, ["minCreditsThreshold", "min_credits_threshold"], fallback.minCreditsThreshold), fallback.minCreditsThreshold),
    returnOriginalUrl: settingBoolean(responseValue(data, ["returnOriginalUrl", "return_original_url"], fallback.returnOriginalUrl), fallback.returnOriginalUrl),
    workerConcurrency: settingNumber(responseValue(data, ["workerConcurrency", "worker_concurrency"], fallback.workerConcurrency), fallback.workerConcurrency),
    retryEnabled: settingBoolean(responseValue(data, ["retryEnabled", "retry_enabled"], fallback.retryEnabled), fallback.retryEnabled),
    retryMaxAttempts: settingNumber(responseValue(data, ["retryMaxAttempts", "retry_max_attempts"], fallback.retryMaxAttempts), fallback.retryMaxAttempts),
    retryBackoffSeconds: settingNumber(responseValue(data, ["retryBackoffSeconds", "retry_backoff_seconds"], fallback.retryBackoffSeconds), fallback.retryBackoffSeconds),
    retryOnStatusCodes: Array.isArray(retryStatusCodes) ? retryStatusCodes.join(",") : fallback.retryOnStatusCodes,
    retryOnErrorTypes: Array.isArray(retryErrorTypes) ? retryErrorTypes.join(",") : fallback.retryOnErrorTypes,
    tokenRotationStrategy: strategy === "random" ? "random" : "round_robin",
    batchConcurrency: settingNumber(responseValue(data, ["batchConcurrency", "batch_concurrency"], fallback.batchConcurrency), fallback.batchConcurrency),
    creditsRefreshConcurrency: settingNumber(responseValue(data, ["creditsRefreshConcurrency", "credits_refresh_concurrency"], fallback.creditsRefreshConcurrency), fallback.creditsRefreshConcurrency),
    accountMaxConcurrency: settingNumber(responseValue(data, ["accountMaxConcurrency", "account_max_concurrency"], fallback.accountMaxConcurrency), fallback.accountMaxConcurrency),
    generatedMaxSizeMb: settingNumber(responseValue(data, ["generatedMaxSizeMb", "generated_max_size_mb"], fallback.generatedMaxSizeMb), fallback.generatedMaxSizeMb),
    generatedPruneSizeMb: settingNumber(responseValue(data, ["generatedPruneSizeMb", "generated_prune_size_mb"], fallback.generatedPruneSizeMb), fallback.generatedPruneSizeMb),
    adminUsername: settingString(admin?.username, fallback.adminUsername),
  };
}

export default function SettingsPage() {
  const [form, setForm] = useState<FormState>(defaults);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [oneTimeKey, setOneTimeKey] = useState("");
  const [category, setCategory] = useState<SettingCategory>("account");

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function load(options: { showLoading?: boolean } = {}) {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    const response = await fetch("/api/admin/settings", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      setForm(formFromResponse(data as SettingsResponse, defaults));
      setApiKeys(data.apiKeys ?? []);
    } else setMessage(data?.error?.message ?? "加载设置失败");
    if (showLoading) setLoading(false);
  }

  // 首次加载需要把服务端设置同步到表单状态；load 内部的更新发生在 fetch 回调中。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true); setMessage("");
    const payload = {
      proxyEnabled: form.proxyEnabled, publicBaseUrl: form.publicBaseUrl, generateTimeoutSeconds: form.generateTimeoutSeconds, videoGenerateTimeoutSeconds: form.videoGenerateTimeoutSeconds, refreshIntervalHours: form.refreshIntervalHours, sherlockRefreshMinutes: form.sherlockRefreshMinutes, sherlockAutoRefreshEnabled: form.sherlockAutoRefreshEnabled, minCreditsThreshold: form.minCreditsThreshold, returnOriginalUrl: form.returnOriginalUrl, workerConcurrency: form.workerConcurrency,
      retryEnabled: form.retryEnabled, retryMaxAttempts: form.retryMaxAttempts, retryBackoffSeconds: form.retryBackoffSeconds, retryOnStatusCodes: numberCsv(form.retryOnStatusCodes), retryOnErrorTypes: csvValues(form.retryOnErrorTypes), tokenRotationStrategy: form.tokenRotationStrategy,
      batchConcurrency: form.batchConcurrency, creditsRefreshConcurrency: form.creditsRefreshConcurrency, accountMaxConcurrency: form.accountMaxConcurrency, generatedMaxSizeMb: form.generatedMaxSizeMb, generatedPruneSizeMb: form.generatedPruneSizeMb,
      adminUsername: form.adminUsername, ...(newPassword ? { newAdminPassword: newPassword } : {}),
    };
    try {
      const response = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      setMessage(response.ok ? "设置已保存，Web/Worker 下一轮读取后生效" : data?.error?.message ?? "保存失败");
      if (response.ok) {
        setNewPassword("");
        setForm((current) => formFromResponse(data as SettingsResponse, current));
        if (Array.isArray(data.apiKeys)) setApiKeys(data.apiKeys);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function createApiKey() {
    if (!newKeyName.trim()) { setMessage("请填写 API Key 名称"); return; }
    const response = await fetch("/api/admin/api-keys", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify({ name: newKeyName.trim() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(data?.error?.message ?? "API Key 创建失败"); return; }
    setOneTimeKey(data.key ?? ""); setNewKeyName(""); setMessage("API Key 已创建；密钥只显示这一次，请立即复制保存"); await load({ showLoading: false });
  }

  async function revokeApiKey(id: string) {
    const response = await fetch("/api/admin/api-keys", { method: "DELETE", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" }, body: JSON.stringify({ id }) });
    const data = await response.json().catch(() => ({})); setMessage(response.ok ? "API Key 已撤销" : data?.error?.message ?? "API Key 撤销失败"); if (response.ok) await load({ showLoading: false });
  }

  const activeKeys = useMemo(() => apiKeys.filter((key) => key.active), [apiKeys]);
  const categories: Array<{ id: SettingCategory; label: string }> = [{ id: "account", label: "账户与安全" }, { id: "network", label: "代理与网络" }, { id: "retry", label: "重试与容错" }, { id: "storage", label: "刷新与存储" }];
  if (loading) return <div className="admin-settings-loading" role="status" aria-label="正在加载系统设置"><Loader2 className="admin-settings-loading-icon" size={24} aria-hidden="true" /><span className="sr-only">正在加载系统设置</span></div>;

  return <div className="admin-page">
    <div className="admin-page-heading admin-settings-actions"><button type="button" className="admin-button admin-button-primary admin-button-icon-text admin-button-saving" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="admin-button-spinner" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}<span>保存设置</span></button></div>
    <section className="admin-card admin-settings-card"><div className="admin-settings-tabs-scroll"><div className="admin-settings-tabs" role="tablist" aria-label="系统设置分类">{categories.map((item) => <button key={item.id} type="button" role="tab" aria-selected={category === item.id} className={`admin-settings-tab${category === item.id ? " is-active" : ""}`} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div></div>
      {category === "account" ? <div className="admin-settings-pane"><h2>账户与安全</h2><div className="admin-settings-grid"><Field label="管理员账号"><input className="admin-input" value={form.adminUsername} onChange={(event) => update("adminUsername", event.target.value)} /></Field><Field label="新管理员密码"><input className="admin-input" type="password" minLength={12} placeholder="留空则不修改（至少 12 位）" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field></div><h3 className="admin-settings-subtitle">服务 API Key</h3><div className="admin-form-row"><input className="admin-input" placeholder="例如 production-client" value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} /><button type="button" className="admin-button admin-button-primary admin-button-icon-text" onClick={() => void createApiKey()}><KeyRound size={15} aria-hidden="true" />创建 Key</button></div>{oneTimeKey ? <div className="admin-one-time-secret"><code>{oneTimeKey}</code><button type="button" className="admin-button admin-button-icon-text" onClick={() => void navigator.clipboard?.writeText(oneTimeKey)}><Copy size={15} aria-hidden="true" />复制</button></div> : null}<KeyTable keys={activeKeys} onRevoke={(id) => void revokeApiKey(id)} /></div> : null}
      {category === "network" ? <div className="admin-settings-pane"><h2>代理与网络</h2><Toggle label="启用代理池" checked={form.proxyEnabled} onChange={(value) => update("proxyEnabled", value)} /><div className="admin-settings-grid"><NumberField label="图片生成超时（秒）" value={form.generateTimeoutSeconds} min={1} max={3600} onChange={(value) => update("generateTimeoutSeconds", value)} /><NumberField label="视频生成超时（秒）" value={form.videoGenerateTimeoutSeconds} min={1} max={3600} onChange={(value) => update("videoGenerateTimeoutSeconds", value)} /></div></div> : null}
      {category === "retry" ? <div className="admin-settings-pane"><h2>重试与容错</h2><Toggle label="sherlockToken 定时自动刷新" checked={form.sherlockAutoRefreshEnabled} onChange={(value) => update("sherlockAutoRefreshEnabled", value)} /><Toggle label="启用自动重试" checked={form.retryEnabled} onChange={(value) => update("retryEnabled", value)} /><div className="admin-settings-grid"><NumberField label="Token 自动刷新间隔（小时）" value={form.refreshIntervalHours} min={1} max={24} onChange={(value) => update("refreshIntervalHours", value)} /><NumberField label="sherlockToken 刷新间隔（分钟）" value={form.sherlockRefreshMinutes} min={1} max={60} onChange={(value) => update("sherlockRefreshMinutes", value)} /><NumberField label="最大尝试次数" value={form.retryMaxAttempts} min={1} max={10} onChange={(value) => update("retryMaxAttempts", value)} /><NumberField label="退避基数（秒）" value={form.retryBackoffSeconds} min={0} max={30} step={0.1} onChange={(value) => update("retryBackoffSeconds", value)} /><Field label="可重试状态码"><input className="admin-input" value={form.retryOnStatusCodes} onChange={(event) => update("retryOnStatusCodes", event.target.value)} /></Field><Field label="可重试错误类型"><input className="admin-input" value={form.retryOnErrorTypes} onChange={(event) => update("retryOnErrorTypes", event.target.value)} /></Field><Field label="Token/账号轮换策略"><Select value={form.tokenRotationStrategy} onValueChange={(value) => update("tokenRotationStrategy", value as FormState["tokenRotationStrategy"])}><SelectTrigger className="admin-settings-select" aria-label="Token/账号轮换策略"><SelectValue /></SelectTrigger><SelectContent className="admin-settings-select-content"><SelectItem value="round_robin">round_robin（顺序）</SelectItem><SelectItem value="random">random（随机）</SelectItem></SelectContent></Select></Field></div></div> : null}
      {category === "storage" ? <div className="admin-settings-pane"><h2>刷新与存储</h2><Toggle label="直接返回 Adobe 原地址（不下载到本地，省时）" checked={form.returnOriginalUrl} onChange={(value) => update("returnOriginalUrl", value)} /><div className="admin-settings-grid"><NumberField label="积分低于此值自动删除账号（0=不启用）" value={form.minCreditsThreshold} min={0} max={10000} onChange={(value) => update("minCreditsThreshold", value)} /><NumberField label="worker 并发生图任务数" value={form.workerConcurrency} min={1} max={100} onChange={(value) => update("workerConcurrency", value)} /><NumberField label="刷新并发数" value={form.batchConcurrency} min={1} max={100} onChange={(value) => update("batchConcurrency", value)} /><NumberField label="每代理积分刷新并发数" value={form.creditsRefreshConcurrency} min={1} max={100} onChange={(value) => update("creditsRefreshConcurrency", value)} /><NumberField label="单账号最高并发" value={form.accountMaxConcurrency} min={1} max={50} onChange={(value) => update("accountMaxConcurrency", value)} /><NumberField label="生成文件空间上限（MB）" value={form.generatedMaxSizeMb} min={100} max={102400} onChange={(value) => update("generatedMaxSizeMb", value)} /><NumberField label="超限后清理量（MB）" value={form.generatedPruneSizeMb} min={10} max={10240} onChange={(value) => update("generatedPruneSizeMb", value)} /></div></div> : null}
      {message ? <p className="admin-message" role="status">{message}</p> : null}
    </section>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="admin-field"><span>{label}</span>{children}</label>; }
function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) { return <Field label={label}><input className="admin-input" type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></Field>; }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="admin-setting-toggle"><span>{label}</span><button type="button" role="switch" aria-checked={checked} aria-label={label} className={`admin-setting-switch${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button></div>; }
function KeyTable({ keys, onRevoke }: { keys: ApiKey[]; onRevoke: (id: string) => void }) { return <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>名称</th><th>前缀</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{keys.map((key) => <tr key={key.id}><td>{key.name}</td><td><code>{key.prefix}…</code></td><td><span className="admin-status admin-status-active">启用</span></td><td>{new Date(key.createdAt).toLocaleString("zh-CN")}</td><td><button type="button" className="admin-icon-button" title="撤销 API Key" aria-label="撤销 API Key" onClick={() => onRevoke(key.id)}><Trash2 size={16} aria-hidden="true" /></button></td></tr>)}</tbody></table>{keys.length === 0 ? <p className="admin-empty">暂无启用的 API Key</p> : null}</div>; }
