#!/usr/bin/env bash
set -euo pipefail

mount_point="$1"
port="$2"
computerd_entry="$3"
pid_file="$4"

case "$mount_point" in
  /tmp/cloudflare-computer-c3-*/workspace) ;;
  /tmp/cloudflare-computer-branch-baseline-*/workspace) ;;
  /tmp/cloudflare-computer-branch-c3-*/workspace) ;;
  *) echo "unsafe mount point: $mount_point" >&2; exit 2 ;;
esac

mkdir -p "$mount_point"
printf '%s\n' "$$" > "$pid_file"

exec env \
  FUSE_MOUNT=fuse \
  MOUNT_POINT="$mount_point" \
  PORT="$port" \
  node "$computerd_entry"
