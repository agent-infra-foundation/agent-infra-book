#!/usr/bin/env bash
set -euo pipefail

worker_base="$1"
object_name="$2"
mount_point="$3"
native_root="$4"

case "$mount_point:$native_root" in
  /tmp/cloudflare-computer-benchmark-*/workspace:/tmp/cloudflare-computer-benchmark-*/native) ;;
  *) echo "unsafe benchmark roots" >&2; exit 2 ;;
esac

workspace_file="$mount_point/smoke.bin"
remote_file="$workspace_file"
native_file="$native_root/smoke.bin"
verify_url="$worker_base/c/$object_name/verify"
pull_url="$worker_base/c/$object_name/pull"
storage_url="$worker_base/c/$object_name/storage"

rm -rf "$native_root"
mkdir -p "$native_root"
rm -f "$workspace_file"

ms() { awk -v us="$1" 'BEGIN { printf "%.3f", us / 1000 }'; }

pull_and_verify() {
  local path="$1" key="$2" value="$3"
  local attempt pull_started pull_finished verify_started verify_finished pull_ok verify_ok
  LAST_SYNC_US=0
  LAST_VERIFY_US=0
  LAST_SYNC_ATTEMPTS=0
  for ((attempt = 1; attempt <= 150; attempt++)); do
    LAST_SYNC_ATTEMPTS=$attempt
    pull_started=${EPOCHREALTIME/./}
    if curl -fsS --max-time 5 -X POST "$pull_url" >/dev/null 2>&1; then
      pull_ok=1
    else
      pull_ok=0
    fi
    pull_finished=${EPOCHREALTIME/./}
    LAST_SYNC_US=$((LAST_SYNC_US + pull_finished - pull_started))

    if [[ "$pull_ok" -eq 1 ]]; then
      verify_started=${EPOCHREALTIME/./}
      if curl -fsS --max-time 2 --get \
      --data-urlencode "path=$path" \
      --data-urlencode "$key=$value" \
      "$verify_url" >/dev/null 2>&1; then
        verify_ok=1
      else
        verify_ok=0
      fi
      verify_finished=${EPOCHREALTIME/./}
      LAST_VERIFY_US=$((LAST_VERIFY_US + verify_finished - verify_started))
      if [[ "$verify_ok" -eq 1 ]]; then
        return 0
      fi
    fi
    sleep 0.1
  done
  echo "authoritative Durable Object did not verify $path ($key=$value)" >&2
  return 1
}

t0=${EPOCHREALTIME/./}
dd if=/dev/zero of="$native_file" bs=1M count=1 conv=fsync status=none
t1=${EPOCHREALTIME/./}
native_write_ms=$(ms $((t1 - t0)))

t0=${EPOCHREALTIME/./}
dd if=/dev/zero of="$workspace_file" bs=1M count=1 conv=fsync status=none
t_operation=${EPOCHREALTIME/./}
pull_and_verify "$remote_file" size 1048576
t1=${EPOCHREALTIME/./}
computer_write_operation_ms=$(ms $((t_operation - t0)))
computer_write_sync_ms=$(ms "$LAST_SYNC_US")
computer_write_verify_ms=$(ms "$LAST_VERIFY_US")
computer_write_total_ms=$(ms $((t1 - t0)))
computer_write_overhead_ms=$(ms $((t1 - t_operation - LAST_SYNC_US - LAST_VERIFY_US)))
computer_write_attempts=$LAST_SYNC_ATTEMPTS

t0=${EPOCHREALTIME/./}
cat "$native_file" >/dev/null
t1=${EPOCHREALTIME/./}
native_read_ms=$(ms $((t1 - t0)))

t0=${EPOCHREALTIME/./}
cat "$workspace_file" >/dev/null
t1=${EPOCHREALTIME/./}
computer_read_ms=$(ms $((t1 - t0)))

t0=${EPOCHREALTIME/./}
printf '0123456789' | dd of="$native_file" bs=1 seek=1024 conv=notrunc,fsync status=none
t1=${EPOCHREALTIME/./}
native_edit_ms=$(ms $((t1 - t0)))
expected_edit_hash=$(sha256sum "$native_file" | cut -d ' ' -f 1)

t0=${EPOCHREALTIME/./}
printf '0123456789' | dd of="$workspace_file" bs=1 seek=1024 conv=notrunc,fsync status=none
t_operation=${EPOCHREALTIME/./}
pull_and_verify "$remote_file" sha256 "$expected_edit_hash"
t1=${EPOCHREALTIME/./}
computer_edit_operation_ms=$(ms $((t_operation - t0)))
computer_edit_sync_ms=$(ms "$LAST_SYNC_US")
computer_edit_verify_ms=$(ms "$LAST_VERIFY_US")
computer_edit_total_ms=$(ms $((t1 - t0)))
computer_edit_overhead_ms=$(ms $((t1 - t_operation - LAST_SYNC_US - LAST_VERIFY_US)))
computer_edit_attempts=$LAST_SYNC_ATTEMPTS

storage_after_edit=$(curl -fsS --max-time 5 "$storage_url")

t0=${EPOCHREALTIME/./}
rm "$native_file"
sync -f "$native_root"
t1=${EPOCHREALTIME/./}
native_delete_ms=$(ms $((t1 - t0)))

t0=${EPOCHREALTIME/./}
rm "$workspace_file"
t_operation=${EPOCHREALTIME/./}
pull_and_verify "$remote_file" missing 1
t1=${EPOCHREALTIME/./}
computer_delete_operation_ms=$(ms $((t_operation - t0)))
computer_delete_sync_ms=$(ms "$LAST_SYNC_US")
computer_delete_verify_ms=$(ms "$LAST_VERIFY_US")
computer_delete_total_ms=$(ms $((t1 - t0)))
computer_delete_overhead_ms=$(ms $((t1 - t_operation - LAST_SYNC_US - LAST_VERIFY_US)))
computer_delete_attempts=$LAST_SYNC_ATTEMPTS

storage_after_delete=$(curl -fsS --max-time 5 "$storage_url")

printf '{"profile":"direct-fuse-storage-path","native":{"writeMs":%s,"readMs":%s,"editMs":%s,"deleteMs":%s},"computer":{"write":{"fuseOperationMs":%s,"syncMs":%s,"verificationMs":%s,"harnessOverheadMs":%s,"durableTotalMs":%s,"syncAttempts":%s},"read":{"fuseOperationMs":%s},"edit":{"fuseOperationMs":%s,"syncMs":%s,"verificationMs":%s,"harnessOverheadMs":%s,"durableTotalMs":%s,"syncAttempts":%s},"delete":{"fuseOperationMs":%s,"syncMs":%s,"verificationMs":%s,"harnessOverheadMs":%s,"durableTotalMs":%s,"syncAttempts":%s}},"storageAfterEdit":%s,"storageAfterDelete":%s}\n' \
  "$native_write_ms" "$native_read_ms" "$native_edit_ms" "$native_delete_ms" \
  "$computer_write_operation_ms" "$computer_write_sync_ms" "$computer_write_verify_ms" "$computer_write_overhead_ms" "$computer_write_total_ms" "$computer_write_attempts" \
  "$computer_read_ms" \
  "$computer_edit_operation_ms" "$computer_edit_sync_ms" "$computer_edit_verify_ms" "$computer_edit_overhead_ms" "$computer_edit_total_ms" "$computer_edit_attempts" \
  "$computer_delete_operation_ms" "$computer_delete_sync_ms" "$computer_delete_verify_ms" "$computer_delete_overhead_ms" "$computer_delete_total_ms" "$computer_delete_attempts" \
  "$storage_after_edit" "$storage_after_delete"
