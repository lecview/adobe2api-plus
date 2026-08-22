"use client";

import { useState } from "react";
import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";

export type LoginValues = {
  username: string;
  password: string;
};

type LoginFormProps = {
  onSubmit?: (values: LoginValues) => void | Promise<void>;
};

export function LoginForm({ onSubmit }: LoginFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) return;

    setSubmitting(true);
    setError(null);
    try {
      if (onSubmit) {
        await onSubmit({ username: username.trim(), password });
      } else {
        const next = new URLSearchParams(window.location.search).get("next") ?? undefined;
        const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: username.trim(), password, next }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message ?? "登录失败");
        window.location.assign(typeof payload.next === "string" ? payload.next : "/admin");
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-card">
      <div className="login-card-header">
        <div className="login-card-icon" aria-hidden="true">
          <KeyRound size={21} strokeWidth={2.1} />
        </div>
        <h1>Adobe Admin</h1>
        <p>管理员登录</p>
      </div>

      <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="login-field">
          <label htmlFor="login-username">账号</label>
          <input
            id="login-username"
            className="login-input"
            name="username"
            type="text"
            autoComplete="username"
            placeholder="请输入管理员账号"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>

        <div className="login-field">
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            className="login-input"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="请输入密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <button className="login-submit" type="submit" disabled={submitting}>
          {submitting ? <LoaderCircle size={17} className="login-spinner" /> : <ArrowRight size={17} />}
          {submitting ? "登录中…" : "登录管理后台"}
        </button>
      </form>

      <p className="login-hint">会话信息仅用于当前管理后台，不会展示敏感凭据。</p>
    </div>
  );
}
