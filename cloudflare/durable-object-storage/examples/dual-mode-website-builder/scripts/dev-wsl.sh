#!/usr/bin/env bash
set -euo pipefail

port="${1:-8793}"
exec npm run dev -- --port "$port"
