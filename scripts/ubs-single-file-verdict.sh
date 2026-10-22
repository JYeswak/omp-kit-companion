#!/bin/sh
# Run the installed UBS JS scanner against exactly one source file.
# A timeout is a typed non-verdict: partial/empty scanner output never passes.
set -eu
file=
repo=.
timeout_secs=${UBS_SINGLE_FILE_TIMEOUT_SECS:-120}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) file=${2-}; shift 2 ;;
    --repo) repo=${2-}; shift 2 ;;
    --timeout) timeout_secs=${2-}; shift 2 ;;
    *) echo '{"status":"invalid","verdict":"UNKNOWN","reason":"unknown argument"}' ; exit 2 ;;
  esac
done
case "$timeout_secs" in ''|*[!0-9]*|0) echo '{"status":"invalid","verdict":"UNKNOWN","reason":"timeout must be positive"}' ; exit 2 ;; esac
[ -n "$file" ] || { echo '{"status":"invalid","verdict":"UNKNOWN","reason":"--file is required"}'; exit 2; }
[ -f "$file" ] || { echo '{"status":"invalid","verdict":"UNKNOWN","reason":"input file is absent"}'; exit 2; }
command -v ubs >/dev/null 2>&1 || { echo '{"status":"environment","verdict":"UNKNOWN","reason":"ubs is absent"}'; exit 2; }
input_hash=$(shasum -a 256 "$file" | cut -d' ' -f1)
# shellcheck source=scripts/kitlib-tmp.sh
. "$(dirname -- "$0")/kitlib-tmp.sh"
work='' # assigned by kitlib_tmp via eval
kitlib_tmp work ubs-single-file
output=$work/output
pid=
# shellcheck disable=SC2317,SC2329 # invoked via kitlib_tmp_atexit
cleanup() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi; }
kitlib_tmp_atexit cleanup
(
  cd "$repo"
  UBS_MODULE_TIMEOUT="$timeout_secs" ubs --no-auto-update --only=js --format=json --files="$file" "$repo"
) >"$output" 2>&1 &
pid=$!
elapsed=0
while kill -0 "$pid" 2>/dev/null; do
  [ "$elapsed" -lt "$timeout_secs" ] || {
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    printf '{"status":"timeout","verdict":"UNKNOWN","reason":"scanner timeout","input_sha256":"%s","timeout_seconds":%s}\n' "$input_hash" "$timeout_secs"
    exit 2
  }
  sleep 1
  elapsed=$((elapsed + 1))
done
rc=0
wait "$pid" 2>/dev/null || rc=$?
# Require a complete JSON result; scanner's own exit code remains authoritative.
if ! grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "$output"; then
  printf '{"status":"incomplete","verdict":"UNKNOWN","reason":"scanner did not produce a complete result","input_sha256":"%s","exit_code":%s}\n' "$input_hash" "$rc"
  exit 2
fi
cat "$output"
exit "$rc"
