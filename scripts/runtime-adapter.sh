#!/bin/sh
# runtime-adapter.sh [private-stage-options] <allowlisted-script> [args...]
# runtime-adapter.sh --workdir
# runtime-adapter.sh --validate-work-root
# Packaged scripts never discover or execute a host bun from PATH.
set -u

HERE=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P) || exit 2
ROOT=$(CDPATH='' cd -- "$HERE/.." && pwd -P) || exit 2

die() {
  echo "runtime-adapter: $*" >&2
  exit 2
}

system_tmp_root() {
  case "$(/usr/bin/uname -s)" in
    Darwin) base=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null) || return 1 ;;
    Linux) base=/tmp ;;
    *) return 1 ;;
  esac
  [ -n "$base" ] && [ -d "$base" ] || return 1
  CDPATH='' cd -- "$base" && pwd -P
}

private_temp_contains() {
  candidate=$1
  if [ -n "${OMP_KIT_TEST_WORK_ROOT:-}" ]; then
    case "$candidate" in "$caller_work_root"/*) return 0 ;; esac
    return 1
  fi
  primary=$(system_tmp_root) || return 1
  case "$candidate" in "$primary"/*) return 0 ;; esac
  if [ "$(/usr/bin/uname -s)" = Darwin ] && [ -d /private/tmp ]; then
    shared_tmp=$(CDPATH='' cd -- /private/tmp && pwd -P) || return 1
    case "$candidate" in "$shared_tmp"/*) return 0 ;; esac
  fi
  return 1
}

private_owner_mode() {
  directory=$1
  if [ "$(/usr/bin/uname -s)" = Darwin ]; then
    owner=$(/usr/bin/stat -f '%u' "$directory" 2>/dev/null) || return 1
    mode=$(/usr/bin/stat -f '%Lp' "$directory" 2>/dev/null) || return 1
  else
    owner=$(/usr/bin/stat -c '%u' "$directory" 2>/dev/null) || return 1
    mode=$(/usr/bin/stat -c '%a' "$directory" 2>/dev/null) || return 1
  fi
  [ "$owner" = "$(/usr/bin/id -u)" ] && [ "$mode" = 700 ]
}

same_uid() {
  if [ "$(/usr/bin/uname -s)" = Darwin ]; then
    file_uid=$(/usr/bin/stat -f '%u' "$1" 2>/dev/null) || return 1
  else
    file_uid=$(/usr/bin/stat -c '%u' "$1" 2>/dev/null) || return 1
  fi
  [ "$file_uid" = "$(/usr/bin/id -u)" ]
}

validate_work_root() {
  case "${OMP_KIT_TEST_WORK_ROOT:-}" in /*) ;; *) die "OMP_KIT_TEST_WORK_ROOT must be absolute" ;; esac
  case "${OMP_KIT_CASE_CWD:-}" in /*) ;; *) die "OMP_KIT_CASE_CWD must be an absolute caller workspace" ;; esac
  caller_repo=$(CDPATH='' cd -- "$OMP_KIT_CASE_CWD" 2>/dev/null && pwd -P) || die "caller workspace is unavailable"
  checked_path=$OMP_KIT_TEST_WORK_ROOT
  while [ "$checked_path" != / ]; do
    [ ! -L "$checked_path" ] || die "OMP_KIT_TEST_WORK_ROOT must not contain symlinks"
    checked_path=$(dirname "$checked_path")
  done
  caller_work_root=$(CDPATH='' cd -- "$OMP_KIT_TEST_WORK_ROOT" 2>/dev/null && pwd -P) || die "OMP_KIT_TEST_WORK_ROOT is unavailable"
  case "$caller_work_root" in "$caller_repo/var/agent-tmp"/*) ;; *) die "OMP_KIT_TEST_WORK_ROOT must resolve under $caller_repo/var/agent-tmp" ;; esac
  same_uid "$caller_work_root" || die "OMP_KIT_TEST_WORK_ROOT must be owned by this user"
  marker="$caller_work_root/.owner"
  if [ ! -f "$marker" ] || [ -L "$marker" ]; then
    die "OMP_KIT_TEST_WORK_ROOT needs a regular nonsymlink .owner marker"
  fi
  same_uid "$marker" || die "OMP_KIT_TEST_WORK_ROOT .owner must be owned by this user"
  marker_repo=; repo_count=0
  while IFS= read -r owner_line || [ -n "$owner_line" ]; do
    case "$owner_line" in repo=*) marker_repo=${owner_line#repo=}; repo_count=$((repo_count + 1)) ;; esac
  done < "$marker"
  if [ "$repo_count" != 1 ] || [ "$marker_repo" != "$caller_repo" ]; then
    die "OMP_KIT_TEST_WORK_ROOT .owner repo must match the caller workspace"
  fi
}

caller_work_root=; caller_repo=
if [ "${OMP_KIT_TEST_WORK_ROOT+x}" = x ]; then
  validate_work_root
fi
if [ "${1:-}" = --validate-work-root ]; then
  [ "$#" -eq 1 ] || die "--validate-work-root takes no arguments"
  [ -n "$caller_work_root" ] || die "OMP_KIT_TEST_WORK_ROOT is required"
  printf '%s\n' "$caller_work_root"
  exit 0
fi

new_workdir() {
	# Explicit caller scratch never falls back to system temp. Default off-fleet
	# behavior still honors TMPDIR outside the release tree.
	if [ -n "$caller_work_root" ]; then
		base=$caller_work_root
	else
		base="${TMPDIR:-/tmp}"
		base_real=$(CDPATH='' cd -- "$base" 2>/dev/null && pwd -P) || base_real=""
		root_real=$(CDPATH='' cd -- "$ROOT" && pwd -P) || die "cannot resolve release root"
		case "$base_real" in
		"$root_real"|"$root_real"/*)
			echo "runtime-adapter: TMPDIR ($base) is inside the release tree; falling back to /tmp" >&2
			base=/tmp ;;
		esac
		if [ -z "$base" ] || [ ! -d "$base" ]; then
			die "no usable temporary root (TMPDIR=${TMPDIR:-<unset>})"
		fi
	fi
	umask 077
	work=$(/usr/bin/mktemp -d "$base/omp-kit-work.XXXXXXXX") || die "cannot create private work directory under $base"
	/bin/chmod 700 "$work" || die "cannot restrict private work directory $work"
	work=$(CDPATH='' cd -- "$work" && pwd -P) || die "cannot resolve private work directory"
	owner_pid="${OMP_KIT_WORK_OWNER_PID:-$PPID}"
	process_start=$(/usr/bin/ps -p "$owner_pid" -o lstart= 2>/dev/null || true)
	argv0=$(/usr/bin/ps -p "$owner_pid" -o comm= 2>/dev/null || true)
	if [ -n "$process_start" ] && [ -n "$argv0" ]; then
		printf 'pid=%s\nprocess_start=%s\nlabel=omp-kit-work\nrepo=%s\ncreated_at=%s\nargv0=%s\n' \
			"$owner_pid" "$process_start" "${caller_repo:-$ROOT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$argv0" >"$work/.owner"
	else
		printf 'pid=%s\nlabel=omp-kit-work\nrepo=%s\ncreated=%s\n' \
			"$owner_pid" "${caller_repo:-$ROOT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$work/.owner"
	fi
	printf '%s\n' "$work"
}

if [ "${1:-}" = --workdir ]; then
	[ "$#" -eq 1 ] || die "--workdir takes no arguments"
	new_workdir
	exit $?
fi

work_set=0; scenario_set=0; log_set=0; port_set=0
work_dir=; scenario=; log_file=; port_file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --work-dir|--scenario|--log|--port-file)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      option=$1; value=$2; shift 2
      case "$option" in
        --work-dir) work_dir=$value; work_set=1 ;;
        --scenario) scenario=$value; scenario_set=1 ;;
        --log) log_file=$value; log_set=1 ;;
        --port-file) port_file=$value; port_set=1 ;;
      esac
      ;;
    *) script=$1; shift; break ;;
  esac
done
[ "${script:-}" ] || die "expected an allowlisted script path"
case "$script" in
  "$ROOT/scripts/rule-class.ts"|\
  "$ROOT/scripts/ttsr-harness.ts"|\
  "$ROOT/scripts/regex-budget.ts"|\
  "$ROOT/scripts/check-flywheel-invariants.ts"|\
  "$ROOT/tests/live/lib.mjs"|\
  "$ROOT/tests/live/mock-model.mjs") ;;
  *) die "refusing unlisted packaged script: $script" ;;
esac
if [ ! -f "$script" ] || [ -L "$script" ]; then
  die "packaged script is absent or symlinked: $script"
fi

if [ "$work_set" = 1 ] || [ "$scenario_set" = 1 ] || [ "$log_set" = 1 ] || [ "$port_set" = 1 ]; then
  [ "$script" = "$ROOT/tests/live/mock-model.mjs" ] || die "live scenario options are only valid for mock-model.mjs"
fi

if [ -x "$ROOT/bin/omp-kit" ]; then
  executable="$ROOT/bin/omp-kit"
  if [ -z "${OMP:-}" ] || [ "$OMP" != "${OMP_BIN:-}" ] || [ "$OMP" != "${OMP_PATH:-}" ] || [ ! -x "$OMP" ]; then
    die "OMP launcher identity is missing or inconsistent"
  fi
  case "${OMP_SRC:-}" in /*) [ -d "$OMP_SRC" ] || die "validated OMP source is unavailable" ;; *) die "validated OMP_SRC must be absolute" ;; esac
  case "${HOME:-}" in */home) sandbox=${HOME%/home} ;; *) die "isolated HOME is required" ;; esac
  if [ "$HOME" != "$sandbox/home" ] || [ "${TMPDIR:-}" != "$sandbox/tmp" ] || \
    [ "${XDG_CONFIG_HOME:-}" != "$sandbox/xdg-config" ] || \
    [ "${XDG_CACHE_HOME:-}" != "$sandbox/xdg-cache" ] || \
    [ "${XDG_DATA_HOME:-}" != "$sandbox/xdg-data" ] || \
    [ "${XDG_STATE_HOME:-}" != "$sandbox/xdg-state" ] || \
    [ "${BUN_INSTALL:-}" != "$sandbox/bun-install" ]; then
    die "child HOME/XDG/TMPDIR/Bun prefix are not one isolated sandbox"
  fi
  if [ ! -d "$sandbox" ] || [ -L "$sandbox" ]; then
    die "isolated sandbox root is absent or symlinked"
  fi
  sandbox_real=$(CDPATH='' cd -- "$sandbox" && pwd -P) || die "cannot resolve isolated sandbox"
# The P01 runtime creates each sandbox with this mkdtemp prefix; caller-shaped XDG trees refuse.
  case "${sandbox_real##*/}" in omp-kit-runtime-*) ;; *) die "sandbox was not created by embedded runtime" ;; esac
  private_temp_contains "$sandbox_real" || die "isolated sandbox is outside the permitted temporary root"
  case "$sandbox_real" in "$ROOT"|"$ROOT"/*|"$HOME"|"$HOME"/*) die "isolated sandbox overlaps the release or HOME" ;; esac
  private_owner_mode "$sandbox_real" || die "sandbox must be owned by this user and mode 700"
  for directory in home tmp xdg-config xdg-cache xdg-data xdg-state bun-install; do
    if [ ! -d "$sandbox/$directory" ] || [ -L "$sandbox/$directory" ]; then
      die "sandbox directory is missing or symlinked: $directory"
    fi
  done

  work_real=
  if [ "$work_set" = 1 ]; then
    case "$work_dir" in /*) ;; *) die "--work-dir must be absolute" ;; esac
    if [ ! -d "$work_dir" ] || [ -L "$work_dir" ]; then
      die "--work-dir is absent or symlinked"
    fi
    work_real=$(CDPATH='' cd -- "$work_dir" && pwd -P) || die "cannot resolve --work-dir"
    private_temp_contains "$work_real" || die "--work-dir is outside the permitted temporary root"
    case "$work_real" in "$ROOT"|"$ROOT"/*|"$HOME"|"$HOME"/*) die "--work-dir overlaps the release or HOME" ;; esac
    private_owner_mode "$work_real" || die "--work-dir must be owned by this user and mode 700"
  fi

  for data_path in "$scenario" "$log_file" "$port_file"; do
    [ -n "$data_path" ] || continue
    [ "$work_set" = 1 ] || die "live scenario data requires --work-dir"
    case "$data_path" in "$work_real"/*) ;; *) die "live scenario data escaped --work-dir" ;; esac
  done
  if [ -n "$caller_work_root" ]; then
    set -- "OMP_KIT_TEST_WORK_ROOT=$caller_work_root" BUN_BE_BUN=1 "$executable" "$script" "$@"
  else
    set -- BUN_BE_BUN=1 "$executable" "$script" "$@"
  fi
  if [ "$script" = "$ROOT/scripts/ttsr-harness.ts" ] && \
    { [ "${OMP_KIT_TEST_CASE_REPORT+x}" = x ] || [ "${OMP_KIT_TEST_CASE_SCOPE+x}" = x ]; }; then
    case "${OMP_KIT_TEST_CASE_SCOPE:-}" in
      harness-gate|harness-selftest|cli-crosscheck|metamorphic-ratchet) ;;
      *) die "invalid native harness case-report scope" ;;
    esac
    [ "${OMP_KIT_TEST_CASE_REPORT:-}" = "$sandbox_real/case-reports/$OMP_KIT_TEST_CASE_SCOPE.jsonl" ] || \
      die "native case report escaped its owned sandbox"
    set -- "OMP_KIT_TEST_CASE_REPORT=$OMP_KIT_TEST_CASE_REPORT" "OMP_KIT_TEST_CASE_SCOPE=$OMP_KIT_TEST_CASE_SCOPE" "$@"
  fi
  exec /usr/bin/env -i \
    PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
    HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
    LANG="${LANG:-}" LC_ALL="${LC_ALL:-}" CI="${CI:-}" GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" NO_COLOR="${NO_COLOR:-}" SHELL="${SHELL:-}" \
    TMPDIR="$TMPDIR" TMP="$TMPDIR" TEMP="$TMPDIR" \
    XDG_CONFIG_HOME="$XDG_CONFIG_HOME" XDG_CACHE_HOME="$XDG_CACHE_HOME" \
    XDG_DATA_HOME="$XDG_DATA_HOME" XDG_STATE_HOME="$XDG_STATE_HOME" \
    BUN_INSTALL="$BUN_INSTALL" \
    OMP="$OMP" OMP_BIN="$OMP" OMP_PATH="$OMP" OMP_SRC="$OMP_SRC" \
    OMP_KIT_CASE_CWD="${OMP_KIT_CASE_CWD:-}" \
    OMP_KIT_WORK_DIR="$work_real" \
    SCEN="$scenario" LOG="$log_file" PORTFILE="$port_file" \
    "$@"
fi

# A checkout is the only place where a separately installed Bun is an allowed fallback.
[ -e "$ROOT/.git" ] || die "embedded omp-kit executable missing; Bun fallback is source-checkout-only"
command -v bun >/dev/null 2>&1 || die "bun not found in contributor source checkout"
unset OMP_PROFILE OMP_KIT_WORK_DIR SCEN LOG PORTFILE BUN_BE_BUN
[ "$work_set" = 0 ] || { OMP_KIT_WORK_DIR=$work_dir; export OMP_KIT_WORK_DIR; }
[ "$scenario_set" = 0 ] || { SCEN=$scenario; export SCEN; }
[ "$log_set" = 0 ] || { LOG=$log_file; export LOG; }
[ "$port_set" = 0 ] || { PORTFILE=$port_file; export PORTFILE; }
exec bun run --no-env-file --config=/dev/null "$script" "$@"
