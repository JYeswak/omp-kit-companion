#!/bin/sh
# e2e-live.sh — G4: the managed rules inside the real omp binary, with no API key.
#
# For each scenario in tests/live/scenarios.json: a fresh git repo, a mock OpenAI-compatible
# model (tests/live/mock-model.mjs) that streams scripted prose and tool calls, and one
# `omp -p` run under an isolated HOME whose only rules are rules/*.md copied to
# $HOME/.agents/rules (the system-wide root). The verdict (tests/live/lib.mjs) reads the
# transcript omp sent back to the model and the side effects on disk: a tripwire names
# itself and its action does not run; a reminder names itself and its action runs; a
# near-miss runs and names nothing.
#
# Usage: sh scripts/e2e-live.sh            full suite; exit 0 iff every scenario is ok
#        sh scripts/e2e-live.sh --plant    baseline prefix-firing kit-close-needs-evidence;
#                                          exit 0 iff the streamed evidenced close goes RED
# Env:   OMP=/path/to/omp  TIMEOUT=120 (seconds per scenario)  KEEP=1 (keep the temp dir)
#        ONLY="id id ..." (run just these scenario ids)
set -u
MODE=full
case "${1:-}" in
  "") ;;
  --plant) MODE=plant ;;
  *) echo "usage: sh scripts/e2e-live.sh [--plant]" >&2; exit 2 ;;
esac

HERE=$(cd "$(dirname "$0")/.." && pwd)
LIB="$HERE/tests/live/lib.mjs"
MOCK="$HERE/tests/live/mock-model.mjs"
TIMEOUT="${TIMEOUT:-120}"
omp_candidate=${OMP:-$(command -v omp || true)}
case "$omp_candidate" in
  */*) ;;
  *) omp_candidate=$(command -v "$omp_candidate" || true) ;;
esac
case "$omp_candidate" in
  /*) ;;
  */*) ;;
  *) echo "omp launcher must resolve to an absolute path before scenario cwd changes" >&2; exit 2 ;;
esac
omp_dir=$(CDPATH='' cd -- "$(dirname "$omp_candidate")" && pwd -P) || { echo "cannot resolve omp launcher directory: $omp_candidate" >&2; exit 2; }
OMP="$omp_dir/$(basename "$omp_candidate")"
[ -x "$OMP" ] || { echo "omp not found or not executable: $OMP" >&2; exit 2; }
[ -z "${OMP_BIN:-}" ] || [ "$OMP_BIN" = "$OMP" ] || { echo "OMP_BIN conflicts with OMP launcher identity" >&2; exit 2; }
[ -z "${OMP_PATH:-}" ] || [ "$OMP_PATH" = "$OMP" ] || { echo "OMP_PATH conflicts with OMP launcher identity" >&2; exit 2; }
OMP_KIT_BUN="$HERE/scripts/runtime-adapter.sh"
[ -x "$OMP_KIT_BUN" ] || { echo "runtime adapter missing: $OMP_KIT_BUN" >&2; exit 2; }
command -v git >/dev/null || { echo "git not found"; exit 2; }

# An inherited profile makes omp read that profile's config and models instead of $HOME's.
unset OMP_PROFILE PI_PROFILE PI_CODING_AGENT_DIR

# Each OMP scenario gets a separate process group so a timed-out tool child cannot escape.
LIMIT="$HERE/scripts/limit-process-tree.sh"
[ -x "$LIMIT" ] || { echo "process-tree limiter missing: $LIMIT" >&2; exit 2; }

WORK_ROOT=$("$HERE/scripts/runtime-adapter.sh" --workdir) || exit 2
OMP_KIT_WORK_DIR="$WORK_ROOT"
export OMP_KIT_WORK_DIR
OWN_WORK_ROOT=1
KEEP_WORK=0
T=$(mktemp -d "$WORK_ROOT/e2e-live.XXXXXX") || { rm -rf "$WORK_ROOT"; exit 2; }
H="$T/home"
MP=""
cleanup() {
  [ -n "$MP" ] && kill "$MP" 2>/dev/null
  if [ "$OWN_WORK_ROOT" = 1 ] && [ "$KEEP_WORK" != 1 ]; then rm -rf "$WORK_ROOT"; fi
}
trap cleanup EXIT INT TERM
mkdir -p "$H/.agents/rules" "$H/.omp/agent" "$H/.config" "$H/.cache" "$H/.local/share" "$H/.local/state" "$H/.bun" "$T/bin" "$T/tmp"
cp "$HERE"/rules/*.md "$H/.agents/rules/"
if [ "$MODE" = plant ]; then
  "$OMP_KIT_BUN" "$LIB" plant "$H/.agents/rules/kit-close-needs-evidence.md" || { plant_rc=$?; KEEP_WORK=1; echo "plant producer_rc=$plant_rc" >&2; exit "$plant_rc"; }
  echo "plant: kit-close-needs-evidence condition ->"
  grep '^condition:' "$H/.agents/rules/kit-close-needs-evidence.md"
else
  "$OMP_KIT_BUN" "$LIB" coverage "$HERE/rules" || { coverage_rc=$?; KEEP_WORK=1; echo "coverage producer_rc=$coverage_rc" >&2; exit "$coverage_rc"; }
fi
"$OMP_KIT_BUN" "$LIB" config "$HERE/policy/ttsr.json" "$H/.omp/agent/config.yml" || { config_rc=$?; KEEP_WORK=1; echo "config producer_rc=$config_rc" >&2; exit "$config_rc"; }
printf '[user]\n\temail = e2e@example.invalid\n\tname = e2e\n[init]\n\tdefaultBranch = main\n' >"$H/.gitconfig"
# br/bd stubs: a close that gets past the rules must not touch any real beads database.
for b in br bd; do printf '#!/bin/sh\nexit 0\n' >"$T/bin/$b"; chmod +x "$T/bin/$b"; done

# Everything that omp and git see runs with this environment. Call it inside a subshell.
isolate() {
  export HOME="$H" \
    XDG_CONFIG_HOME="$H/.config" \
    XDG_CACHE_HOME="$H/.cache" \
    XDG_DATA_HOME="$H/.local/share" \
    XDG_STATE_HOME="$H/.local/state" \
    TMPDIR="$T/tmp" BUN_INSTALL="$H/.bun" GIT_CONFIG_NOSYSTEM=1 PATH="$T/bin:$PATH"
}

echo "omp: $(isolate && "$OMP" --version 2>/dev/null) ($OMP)"
echo "rules root: $H/.agents/rules ($(find "$H/.agents/rules" -type f -name '*.md' | wc -l | tr -d ' ') files)"
pass=0; fail=0; selected=0
scenario_ids=$("$OMP_KIT_BUN" "$LIB" select "$MODE")
select_rc=$?
[ "$select_rc" -eq 0 ] || { KEEP_WORK=1; echo "scenario select producer_rc=$select_rc" >&2; exit "$select_rc"; }
[ -n "$scenario_ids" ] || { KEEP_WORK=1; echo "scenario select returned no scenarios" >&2; exit 2; }
printf 'scenario ids: %s\n' "$scenario_ids"
for i in $scenario_ids; do
  name=$("$OMP_KIT_BUN" "$LIB" name "$i")
  name_rc=$?
  if [ "$name_rc" -ne 0 ] || [ -z "$name" ]; then
    KEEP_WORK=1; echo "scenario name producer_rc=$name_rc id=$i" >&2; exit 2
  fi
  case " ${ONLY:-$name} " in *" $name "*) selected=$((selected+1)) ;; *) continue ;; esac
  P="$T/proj-$name"; LOG="$T/log-$name.jsonl"; SC="$T/scen-$name.json"; PF="$T/port-$name"
  mkdir -p "$P"
  (cd "$P" && isolate && git init -q && git commit -q --allow-empty -m init) || { git_rc=$?; KEEP_WORK=1; echo "git init producer_rc=$git_rc scenario=$name" >&2; exit "$git_rc"; }
  "$OMP_KIT_BUN" "$LIB" prep "$i" "$SC" || { prep_rc=$?; KEEP_WORK=1; echo "scenario prep producer_rc=$prep_rc id=$i" >&2; exit "$prep_rc"; }
  "$OMP_KIT_BUN" --work-dir "$WORK_ROOT" --scenario "$SC" --log "$LOG" --port-file "$PF" "$MOCK" >"$T/mock-$name.txt" 2>&1 &
  MP=$!
  w=0; while [ ! -s "$PF" ] && [ "$w" -lt 100 ]; do sleep 0.1; w=$((w+1)); done
  if [ ! -s "$PF" ]; then
    kill "$MP" 2>/dev/null; wait "$MP" 2>/dev/null; mock_rc=$?; MP=""
    echo "mock startup producer_rc=$mock_rc log=$T/mock-$name.txt" >&2
    cat "$T/mock-$name.txt" >&2
    KEEP_WORK=1; exit 2
  fi
  "$OMP_KIT_BUN" "$LIB" models "$(cat "$PF")" "$H/.omp/agent/models.yml" || { models_rc=$?; KEEP_WORK=1; echo "models producer_rc=$models_rc scenario=$name" >&2; exit "$models_rc"; }
  (cd "$P" && isolate && "$LIMIT" "$TIMEOUT" "$OMP" -p --no-session --model mock/mock --approval-mode yolo "go" </dev/null) >"$T/out-$name.txt" 2>&1
  rc=$?
  kill "$MP" 2>/dev/null; wait "$MP" 2>/dev/null; mock_cleanup_rc=$?; MP=""
  echo "mock server cleanup_rc=$mock_cleanup_rc log=$T/mock-$name.txt"
  cat "$T/mock-$name.txt"
  echo "OMP producer_rc=$rc output_log=$T/out-$name.txt transcript=$LOG"
  cat "$T/out-$name.txt"
  verdict=$("$OMP_KIT_BUN" "$LIB" verdict "$i" "$LOG" "$P" "$rc")
  verdict_rc=$?
  if [ "$verdict_rc" -ne 0 ] || [ -z "$verdict" ]; then
    [ "$verdict_rc" -ne 0 ] || verdict_rc=2
    KEEP_WORK=1; echo "verdict producer_rc=$verdict_rc scenario=$name" >&2; exit "$verdict_rc"
  fi
  if [ "$verdict" = ok ]; then
    pass=$((pass+1)); echo "ok    $name"
  else
    fail=$((fail+1)); echo "FAIL  $name :: $verdict (omp exit $rc; transcript: $LOG)"
  fi
done
if [ "$selected" -eq 0 ]; then
  KEEP_WORK=1
  echo "e2e-live ($MODE): no scenarios matched ONLY='${ONLY:-<unset>}'" >&2
  echo "private diagnostics retained: $T (work root $WORK_ROOT)" >&2
  exit 2
fi
echo "e2e-live ($MODE): $pass passed, $fail failed"
plant_caught=0
if [ "$MODE" = plant ] && [ "$fail" -gt 0 ] && [ "$pass" -eq 0 ]; then
  case "$verdict" in *"unexpected rule kit-close-needs-evidence"*) plant_caught=1 ;; esac
fi
if [ "${KEEP:-0}" = 1 ] || { [ "$MODE" = full ] && [ "$fail" -ne 0 ]; } || { [ "$MODE" = plant ] && [ "$plant_caught" -eq 0 ]; }; then
  KEEP_WORK=1
  echo "kept private e2e output: $T (work root $WORK_ROOT)"
else
  rm -rf "$T"
fi

if [ "$MODE" = plant ]; then
  # The plant is caught only if the evidenced close went RED and named this rule.
  if [ "$plant_caught" -eq 1 ]; then
    echo "plant RED as required: baseline kit-close-needs-evidence fires on the streamed prefix of an evidenced close"
    exit 0
  fi
  echo "plant NOT caught: the suite passed a baseline rule that fires on an evidenced close"
  exit 1
fi
[ "$fail" -eq 0 ]
