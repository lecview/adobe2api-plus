#!/usr/bin/env bash
# 一键停止：docker compose 容器组
# 用法：./stop.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 停止 docker 容器"
docker compose down

echo "✅ 已停止"
