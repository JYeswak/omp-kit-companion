#!/bin/sh
# ladder.sh — run every gate the pack must pass before install, in order, and stop at the first RED.
# G1-G3 harness gate, harness selftest (plants must go RED), checker selftests under /bin/sh,
# manifest check, G4 live suite, G4 plant (must go RED). Prints each complete producer log and rc.
set -u
run_stage() { # run_stage <label> <log> <cmd...>
  stage_label=$1; stage_log=$2; shift 2
  printf 'OMP_KIT_STAGE_START name=%s\n' "$stage_label"
  stage_pipe="$stage_log.pipe"
  mkfifo "$stage_pipe" || return 125
  tee "$stage_log" < "$stage_pipe" &
  stage_tee_pid=$!
  command time -p /bin/sh -c "exec \"\$@\" 2>&1" sh "$@" > "$stage_pipe" 2> "$stage_log.time"
  stage_rc=$?
  wait "$stage_tee_pid"
  stage_tee_rc=$?
  rm -f "$stage_pipe"
  if [ "$stage_rc" -eq 0 ] && [ "$stage_tee_rc" -ne 0 ]; then stage_rc=125; fi
  stage_duration_ms=$(LC_ALL=C awk '$1 == "real" { printf "%.0f", $2 * 1000; found=1; exit } END { if (!found) exit 1 }' "$stage_log.time") || {
    stage_duration_ms=0
    [ "$stage_rc" -ne 0 ] || stage_rc=125
  }
  if [ "$stage_rc" -eq 0 ]; then
    printf '\nGREEN %s producer_rc=%s duration_ms=%s\n' "$stage_label" "$stage_rc" "$stage_duration_ms"
  else
    printf '\nRED   %s producer_rc=%s duration_ms=%s\n' "$stage_label" "$stage_rc" "$stage_duration_ms"
  fi
  return "$stage_rc"
}
if [ "$#" -ge 2 ] && [ "$1" = "--selftest-timing" ]; then
  selftest_dir=$2
  shift 2
  if [ "$#" -eq 0 ]; then set -- /bin/sh -c 'sleep 0.12'; fi
  run_stage manifest "$selftest_dir/ladder-manifest.txt" "$@"
  exit $?
fi
REGEX_BUDGET_RUNS=1
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--regex-budget-runs" ]; then
    echo "ladder: usage: --regex-budget-runs 1|5" >&2
    exit 2
  fi
  case "$2" in
    1|5) REGEX_BUDGET_RUNS=$2 ;;
    *) echo "ladder: regex-budget run count must be 1 or 5" >&2; exit 2 ;;
  esac
fi
HERE=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
cd "$HERE" || exit 1
OMP_KIT_BUN="$HERE/scripts/runtime-adapter.sh"
[ -x "$OMP_KIT_BUN" ] || { echo "ladder: runtime adapter missing" >&2; exit 2; }
if [ -x "$HERE/bin/omp-kit" ]; then
  WORK=$("$OMP_KIT_BUN" --workdir) || exit 2
  PRIVATE_WORK=1
elif [ -e "$HERE/.git" ]; then
  mkdir -p "$HERE/reports" || exit 1
  WORK="$HERE/reports"
  PRIVATE_WORK=0
else
  echo "ladder: embedded omp-kit executable missing; source fallback is contributor-checkout-only" >&2
  exit 2
fi
KEEP_WORK=0
cleanup() {
  if [ "$PRIVATE_WORK" = 1 ]; then
    if [ "$KEEP_WORK" = 1 ]; then echo "private ladder logs retained: $WORK" >&2; else rm -rf "$WORK"; fi
  fi
}
trap cleanup EXIT
export OMP_KIT_WORK_DIR="$WORK"
step() { # step <label> <cmd...>
  step_label=$1; shift
  log="$WORK/ladder-$step_label.txt"
  if [ "$step_label" != "manifest" ]; then
    if [ -e "$HERE/.git" ]; then
      set -- bun run --no-env-file --config=/dev/null "$HERE/src/cli.ts" heavy --label "$step_label" -- "$@"
    else
      set -- "$HERE/bin/omp-kit" heavy --label "$step_label" -- "$@"
    fi
  fi
  run_stage "$step_label" "$log" "$@"
  step_rc=$?
  if [ "$step_rc" -ne 0 ]; then KEEP_WORK=1; exit 1; fi
}
if [ -e "$HERE/.git" ]; then
  step manifest /bin/sh scripts/build-manifest.sh
else
  step manifest /bin/sh scripts/build-manifest.sh --check
fi

step harness-gate "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --gate
step harness-selftest "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --selftest
# Agent Flywheel Guide invariants: every kernel invariant and anti-pattern maps to a shipped
# mechanism with fire and quiet proof (docs/flywheel-invariants.tsv). Prose is not a mechanism.
if [ -d "$HERE/src" ]; then
  step flywheel-invariants "$OMP_KIT_BUN" "$HERE/scripts/check-flywheel-invariants.ts" --root "$HERE"
elif [ -f "$HERE/docs/flywheel-invariants.tsv" ] && [ -f "$HERE/scripts/check-flywheel-invariants.ts" ]; then
  step flywheel-invariants "$OMP_KIT_BUN" "$HERE/scripts/check-flywheel-invariants.ts" --root "$HERE" --packaged
else
  echo "NOT_RUN flywheel-invariants: map/gate not in this package (ships with ompkit-n2s6 package list); source CI runs it"
fi
# Regex cost gate: every rule condition timed in Bun on near-miss shapes and a
# realistic live stream (RX1). Red names the rule, shape and encoding.
if [ "$REGEX_BUDGET_RUNS" = "5" ]; then
  set -- --runs 5
else
  set --
fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then set -- "$@" --judge-regardless-of-load; fi
step regex-budget "$OMP_KIT_BUN" "$HERE/scripts/regex-budget.ts" "$@"
step claim-selftest /bin/sh checkers/check-claim-discipline.sh --selftest
# The harness imports omp's matcher; after an omp upgrade this proves it still agrees with the CLI.
step cli-crosscheck "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --cli-crosscheck --jobs 8
# Metamorphic strict invariant: every relation break fails the ladder.
step metamorphic-ratchet "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --metamorphic-json
step readiness-selftest /bin/sh checkers/check-readiness.sh --selftest
step e2e-live /bin/sh "$HERE/scripts/e2e-live.sh"
step e2e-plant /bin/sh "$HERE/scripts/e2e-live.sh" --plant
echo "LADDER: GREEN"
