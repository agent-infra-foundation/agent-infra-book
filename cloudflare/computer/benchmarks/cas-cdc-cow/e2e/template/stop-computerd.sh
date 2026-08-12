#!/usr/bin/env bash
set -euo pipefail

pid_file="$1"
mount_point="$2"
root="$3"

case "$mount_point:$root" in
  /tmp/cloudflare-computer-c3-*/workspace:/tmp/cloudflare-computer-c3-*) ;;
  /tmp/cloudflare-computer-branch-baseline-*/workspace:/tmp/cloudflare-computer-branch-baseline-*) ;;
  /tmp/cloudflare-computer-branch-c3-*/workspace:/tmp/cloudflare-computer-branch-c3-*) ;;
  *) echo "unsafe cleanup target" >&2; exit 2 ;;
esac

if [[ -f "$pid_file" ]]; then
  pid="$(cat "$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then kill "$pid" 2>/dev/null || true; fi
fi
fusermount3 -u "$mount_point" 2>/dev/null || fusermount -u "$mount_point" 2>/dev/null || true
rm -rf -- "$root"
