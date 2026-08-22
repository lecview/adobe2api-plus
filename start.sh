#!/usr/bin/env bash
# 一键部署：docker compose 容器组（mysql + web + worker）
# 用法：./start.sh
#
# sherlockToken 自动铸造说明（可选）：
#   若 .env 配了 ROXYBROWSER_API_TOKEN，脚本会自动检测宿主机局域网 IP 并注入
#   ROXYBROWSER_CDP_HOST，让容器内的 puppeteer 直连宿主机 Roxy 的 Chrome CDP
#   （铸造窗口已用 --remote-debugging-address=0.0.0.0 监听所有网卡）。
#   不配 Roxy 则走后台手动输入 token，不影响其它功能。
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 检查 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    已从 .env.example 生成 .env（管理员默认 admin/admin），生产环境请按需修改。"
fi

# 读取 web 对外端口（默认 3000）
# shellcheck disable=SC1091
set -a; . ./.env; set +a
WEB_PORT="${WEB_PORT:-3000}"

# 若配置了 Roxy 自动铸造，自动探测宿主机局域网 IP 并注入 CDP_HOST
if [ -n "${ROXYBROWSER_API_TOKEN:-}" ]; then
  HOST_IP="${ROXYBROWSER_CDP_HOST:-}"
  if [ -z "$HOST_IP" ] || [ "$HOST_IP" = "host.docker.internal" ]; then
    # 依次尝试常见网卡，取第一个非空 IP（macOS ipconfig / Linux hostname -I）
    for iface in en0 en1 en2 en3 eth0 wlan0; do
      HOST_IP="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [ -n "$HOST_IP" ] && break
    done
    [ -z "$HOST_IP" ] && HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [ -n "$HOST_IP" ]; then
    export ROXYBROWSER_CDP_HOST="$HOST_IP"
    echo "==> 宿主机 IP=$HOST_IP 已注入 ROXYBROWSER_CDP_HOST（sherlock 自动铸造用）"
  else
    echo "⚠  未探测到宿主机局域网 IP，请手动在 .env 设置 ROXYBROWSER_CDP_HOST=本机IP"
  fi
fi

echo "==> 构建并启动容器（mysql + web + worker）"
docker compose up -d --build

echo ""
echo "✅ 部署完成"
echo "   管理后台:  http://127.0.0.1:${WEB_PORT}/login"
echo "   账号/密码: admin / admin"
[ -z "${ROXYBROWSER_API_TOKEN:-}" ] && echo "   （未配置 Roxy，sherlockToken 请在后台「sherlock」页手动输入）"
