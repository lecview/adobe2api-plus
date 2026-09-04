"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import pkg from "../../package.json";
import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  KeyRound,
  LogOut,
  Moon,
  Network,
  Settings,
  Sun,
  SlidersHorizontal,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const navItems: NavItem[] = [
  { href: "/admin/accounts", label: "Adobe 管理", icon: Boxes },
  { href: "/admin/sherlock", label: "sherlockToken", icon: KeyRound },
  { href: "/admin/proxy-pool", label: "代理池", icon: Network },
  { href: "/admin/jobs", label: "请求日志", icon: ClipboardList },
  { href: "/admin/settings", label: "系统设置", icon: SlidersHorizontal },
];

type AdminShellProps = {
  children: React.ReactNode;
  onLogout?: () => void | Promise<void>;
};

// 部署提交 SHA（deploy.yml 构建时注入 NEXT_PUBLIC_BUILD_SHA）；本地开发/CI 构建无此值
const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA && process.env.NEXT_PUBLIC_BUILD_SHA !== "dev" ? process.env.NEXT_PUBLIC_BUILD_SHA : "";

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({ children, onLogout }: AdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    window.localStorage.setItem("adobe2api-plus-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const currentTitle = useMemo(
    () => navItems.find((item) => isActivePath(pathname, item.href))?.label ?? "管理概览",
    [pathname],
  );

  async function handleLogout() {
    if (onLogout) return onLogout();
    await fetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": "same-origin" } });
    router.push("/login");
    router.refresh();
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="admin-shell">
      <aside className={`admin-sidebar${collapsed ? " is-collapsed" : ""}`}>
        <div className="admin-brand">
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="admin-sidebar-toggle" aria-label="展开侧边栏" onClick={() => setCollapsed(false)}>
                  <ChevronRight size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">展开侧边栏</TooltipContent>
            </Tooltip>
          ) : (
            <>
              <div className="admin-brand-mark" aria-hidden="true">
                <Settings size={16} strokeWidth={2.3} />
              </div>
              <div className="admin-brand-copy">
                <span className="admin-brand-title">Adobe Admin Plus</span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="admin-sidebar-toggle" aria-label="收起侧边栏" onClick={() => setCollapsed(true)}>
                    <ChevronLeft size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">收起侧边栏</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        <div className="admin-nav-scroll">
          <nav className="admin-nav" aria-label="管理后台导航">
            {navItems.map((item) => {
              const active = isActivePath(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`admin-nav-link${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon size={17} strokeWidth={2} aria-hidden="true" />
                  <span className="admin-nav-label">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="admin-version">v{pkg.version}{buildSha ? ` · ${buildSha}` : ""}</div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-title">{currentTitle}</div>
          <div className="admin-topbar-actions">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="admin-icon-button" aria-label={darkMode ? "切换到浅色模式" : "切换到深色模式"} onClick={() => setDarkMode((value) => !value)}>
                  {darkMode ? <Moon size={16} /> : <Sun size={16} />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{darkMode ? "切换到浅色模式" : "切换到深色模式"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="admin-icon-button" aria-label="退出登录" onClick={() => void handleLogout()}>
                  <LogOut size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>退出登录</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <nav className="admin-mobile-nav" aria-label="移动端管理后台导航">
          {navItems.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`admin-nav-link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <main className="admin-content">{children}</main>
      </div>
    </div>
    </TooltipProvider>
  );
}
