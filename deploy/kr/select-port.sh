#!/usr/bin/env sh
set -eu

first="${1:-8300}"
last="${2:-8399}"

port="$first"
while [ "$port" -le "$last" ]; do
  if ! ss -H -ltn "sport = :$port" | grep -q .; then
    printf '%s\n' "$port"
    exit 0
  fi
  port=$((port + 1))
done

echo "no free loopback port in ${first}-${last}" >&2
exit 1
