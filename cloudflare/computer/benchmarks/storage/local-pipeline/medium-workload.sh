#!/usr/bin/env bash
set -euo pipefail

phase="$1"
root="$2"
step="${3:-}"
batch_start="${4:-}"
batch_count="${5:-}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ "$root" == "." ]]; then
  resolved_root=$(pwd -P)
else
  resolved_root=$(realpath -m -- "$root")
fi

case "$resolved_root" in
  /tmp/cloudflare-computer-benchmark-????????????/workspace|/tmp/cloudflare-computer-benchmark-????????????/native) ;;
  *) echo "unsafe benchmark root: $resolved_root" >&2; exit 2 ;;
esac

tree="$resolved_root/medium"
copy="$resolved_root/medium-copy"

sync_root() {
  sync -f "$resolved_root"
}

started=${EPOCHREALTIME/./}
case "$phase" in
  initialize)
    rm -rf -- "$tree" "$copy"
    node "$script_dir/generate-medium-corpus.mjs" "$tree" >/dev/null
    sync_root
    ;;
  initialize-reset)
    rm -rf -- "$tree" "$copy"
    mkdir -p -- "$tree"
    sync_root
    ;;
  initialize-batch)
    if [[ ! "$step" =~ ^(small|medium|artifacts|large|boundary)$ ]] ||
       [[ ! "$batch_start" =~ ^[0-9]+$ ]] ||
       [[ ! "$batch_count" =~ ^[1-9][0-9]*$ ]]; then
      echo "initialize-batch requires class, start, and count" >&2
      exit 2
    fi
    node "$script_dir/generate-medium-corpus.mjs" "$tree" "$step" "$batch_start" "$batch_count" >/dev/null
    sync_root
    ;;
  inspect)
    :
    ;;
  list)
    LC_ALL=C ls -lR --time-style=+%s "$tree" >/dev/null
    ;;
  read)
    find "$tree" -type f -print0 | LC_ALL=C sort -z | xargs -0 cat >/dev/null
    ;;
  duplicate)
    rm -rf -- "$copy"
    cp -a --reflink=never -- "$tree" "$copy"
    sync_root
    ;;
  duplicate-reset)
    rm -rf -- "$copy"
    mkdir -p -- "$copy"
    sync_root
    ;;
  duplicate-batch)
    if [[ ! "$step" =~ ^(small|medium|artifacts|large|boundary)$ ]] ||
       [[ ! "$batch_start" =~ ^[0-9]+$ ]] ||
       [[ ! "$batch_count" =~ ^[1-9][0-9]*$ ]]; then
      echo "duplicate-batch requires class, start, and count" >&2
      exit 2
    fi
    node "$script_dir/copy-medium-batch.mjs" "$tree" "$copy" "$step" "$batch_start" "$batch_count" >/dev/null
    sync_root
    ;;
  edit-one)
    printf 'EDIT-ONE10' | dd of="$tree/large/large-000000.bin" bs=1 seek=1024 conv=notrunc status=none
    sync_root
    ;;
  edit-separate)
    if [[ ! "$step" =~ ^[1-5]$ ]]; then
      echo "edit-separate requires a step from 1 through 5" >&2
      exit 2
    fi
    printf -v stamp 'S%09d' "$step"
    printf '%s' "$stamp" | dd of="$tree/large/large-000001.bin" bs=1 seek=1024 conv=notrunc status=none
    sync_root
    ;;
  edit-five-bracket)
    for edit_step in 1 2 3 4 5; do
      printf -v stamp 'B%09d' "$edit_step"
      printf '%s' "$stamp" | dd of="$tree/large/large-000002.bin" bs=1 seek=1024 conv=notrunc status=none
    done
    sync_root
    ;;
  append)
    printf 'APPEND-010' >> "$tree/large/large-000003.bin"
    sync_root
    ;;
  prepend)
    temp="$tree/boundary/shift.prepend.tmp"
    rm -f -- "$temp"
    { printf 'PREPEND010'; cat "$tree/boundary/shift.bin"; } > "$temp"
    mv -- "$temp" "$tree/boundary/shift.bin"
    sync_root
    ;;
  delete-copy)
    rm -rf -- "$copy"
    sync_root
    ;;
  delete-all)
    rm -rf -- "$tree" "$copy"
    sync_root
    ;;
  *)
    echo "unknown medium benchmark phase: $phase" >&2
    exit 2
    ;;
esac
finished=${EPOCHREALTIME/./}

if [[ "${BENCHMARK_EMIT_STATS:-0}" != "1" ||
      "$phase" == "initialize-reset" || "$phase" == "initialize-batch" ||
      "$phase" == "duplicate-reset" || "$phase" == "duplicate-batch" ]]; then
  file_count=-1
  logical_bytes=-1
  allocated_blocks=0
  namespace_sha256=""
elif [[ -d "$tree" || -d "$copy" ]]; then
  roots=()
  [[ -d "$tree" ]] && roots+=("$tree")
  [[ -d "$copy" ]] && roots+=("$copy")
  read -r file_count logical_bytes allocated_blocks < <(
    find "${roots[@]}" -xdev -type f -printf '%s %b\n' |
      awk '{files += 1; logical += $1; blocks += $2} END {printf "%d %d %d\n", files, logical, blocks}'
  )
  namespace_sha256=$(
    find "${roots[@]}" -xdev -type f -printf '%P\0' |
      LC_ALL=C sort -z |
      sha256sum |
      cut -d ' ' -f 1
  )
else
  file_count=0
  logical_bytes=0
  allocated_blocks=0
  namespace_sha256=$(printf '' | sha256sum | cut -d ' ' -f 1)
fi

awk \
  -v phase="$phase" \
  -v elapsed_us="$((finished - started))" \
  -v files="$file_count" \
  -v logical="$logical_bytes" \
  -v allocated="$((allocated_blocks * 512))" \
  -v digest="$namespace_sha256" \
  'BEGIN {
    printf "{\"phase\":\"%s\",\"commandMs\":%.3f,\"fileCount\":%d,\"logicalBytes\":%d,\"allocatedBytes\":%d,\"namespaceSha256\":\"%s\"}\n", phase, elapsed_us / 1000, files, logical, allocated, digest
  }'
