import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(__dirname) },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["mysql2", "mariadb"],
  // 图片编辑上传大图二进制（2K/4K PNG 常超 10MB），放大 multipart 请求体限制（Next 16 为 proxyClientMaxBodySize）。
  experimental: {
    proxyClientMaxBodySize: "100mb",
  },
  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
