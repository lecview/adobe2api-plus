"use client";

import Link from "next/link";
import { ClipboardList, Network, Settings, UsersRound } from "lucide-react";

const overviewItems = [
  {
    href: "/admin/accounts",
    title: "Adobe 账号",
    description: "导入 Cookie、管理 Token 和刷新状态。",
    icon: UsersRound,
  },
  {
    href: "/admin/proxy-pool",
    title: "代理池",
    description: "配置 HTTP / SOCKS5 代理并按顺序分配。",
    icon: Network,
  },
  {
    href: "/admin/jobs",
    title: "任务记录",
    description: "查看生成任务进度、错误和生成媒体。",
    icon: ClipboardList,
  },
  {
    href: "/admin/settings",
    title: "系统设置",
    description: "调整运行时开关和服务基础设置。",
    icon: Settings,
  },
];

export default function AdminPage() {
  return (
    <div className="admin-page">
      <div className="admin-page-heading">
        <div>
          <h1>管理概览</h1>
          <p>从这里进入 Adobe API 的日常运维功能。</p>
        </div>
      </div>

      <div className="admin-card-grid">
        {overviewItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="admin-card admin-card-link">
              <Icon size={22} strokeWidth={1.9} color="var(--primary)" aria-hidden="true" />
              <h2 style={{ marginTop: 18 }}>{item.title}</h2>
              <p>{item.description}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
