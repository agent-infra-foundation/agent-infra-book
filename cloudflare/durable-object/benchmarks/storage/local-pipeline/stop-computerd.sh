#!/usr/bin/env bash
set -euo pipefail

pid_file="$1"
mount_point="$2"
benchmark_root="$3"

case "$mount_point:$benchmark_root" in
  /tmp/cloudflare-computer-benchmark-*/workspace:/tmp/cloudflare-computer-benchmark-*) ;;
  *) echo "unsafe cleanup roots" >&2; exit 2 ;;
esac

if [[ -f "$pid_file" ]]; then
  pid=$(tr -d '\r\n' < "$pid_file")
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
fi

if mountpoint -q "$mount_point"; then
  fusermount3 -u "$mount_point" 2>/dev/null || true
fi

rm -rf "$benchmark_root"
