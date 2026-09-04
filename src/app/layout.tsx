import type { Metadata } from "next";
import "./globals.css";
import { AppProviders } from "@/components/app-providers";

export const metadata: Metadata = {
  title: "Adobe API 管理后台",
  description: "Adobe API 账号、任务与代理池管理控制台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning：浏览器扩展（如沉浸式翻译）会在 <html> 上添加
  // data-* 属性，导致无害的水合警告；官方推荐在根元素上抑制该类属性差异。
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body><AppProviders>{children}</AppProviders></body>
    </html>
  );
}
