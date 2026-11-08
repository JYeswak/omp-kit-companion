#!/bin/sh
# e2e-live.sh — G4: the managed rules inside the real omp binary, with no API key.
#
# For each scenario in tests/live/scenarios.json: a fresh git repo, a mock OpenAI-compatible
# model (tests/live/mock-model.mjs) that streams scripted prose and tool calls, and one
# `omp -p` run under an isolated HOME. It loads the candidate's opt-in native
# guards explicitly and copies rules/*.md to $HOME/.agents/rules. The verdict reads the
# transcript omp sent back to the model and the side effects on disk: a tripwire names
# itself and its action does not run; a reminder names itself and its action runs; a
# near-miss runs and names nothing.
#
# Usage: sh scripts/e2e-live.sh            full suite; exit 0 iff every scenario is ok
#        sh scripts/e2e-live.sh --plant    baseline prefix-firing kit-close-needs-evidence;
#                                          exit 0 iff the streamed evidenced close goes RED
# Env:   OMP=/path/to/omp  TIMEOUT=120 (seconds per scenario)  KEEP=1 (keep the temp dir)
#        ONLY="id id ..." (run just these scenario ids)
#        OMP_KIT_TEST_WORK_ROOT=/repo/var/agent-tmp/<dir> (optional; requires .owner)
#        OMP_KIT_CASE_CWD=/caller/repo (workspace owning the supplied scratch root)
#        OMP_KIT_E2E_EVIDENCE_DIR=/abs/dir keeps failing scenarios' transcripts in an e2e-live.<pid> child
#        OMP_KIT_PLUGIN_SOURCE=/abs/dir  link that package (needs package.json with an omp
#        field) instead of building a temp one; plant mode refuses this to protect the checkout
#        OMP_KIT_PLUGIN_DISABLE_AFTER_LINK=name  disable that plugin right after linking
#        (planted-negative runs: the live scenario must then NOT block)
#        OMP_KIT_DEFAULT_TTSR=1 runs omp under its own default TTSR settings instead of
#        installing the kit policy, so a second run reports policy-sensitive differences.
#        OMP_KIT_TEST_NO_PROVIDER_PIN=1 skips the disabledProviders isolation so a test
#        can prove OMP would otherwise probe OLLAMA_HOST (test-only).
#        OMP_KIT_TEST_NO_COVERAGE=1 skips the unrelated rule-coverage preflight for
#        provider-contract tests only; scenario verdicts still run.
set -u
MODE=full
case "${1:-}" in
  "") ;;
  --plant) MODE=plant ;;
  *) echo "usage: sh scripts/e2e-live.sh [--plant]" >&2; exit 2 ;;
esac

HERE=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/kitlib-proc.sh
. "$HERE/scripts/kitlib-proc.sh"
# Reporting is optional for standalone copies; never synthesize complete records.
report_test_case() { :; }
start_case_report() { :; }
finish_case_report() { :; }
if [ -f "$HERE/scripts/test-case-report.sh" ]; then
  . "$HERE/scripts/test-case-report.sh"
fi
start_case_report
LIB="$HERE/tests/live/lib.mjs"
MOCK="$HERE/tests/live/mock-model.mjs"
TIMEOUT="${TIMEOUT:-120}"
# Same loaded-host window: native-seeded widths 1/4/8 took 582.62/133.64/122.80 s
# (width 1 exposed a real auto-background flake; widths 4/8 kept all 157 verdicts).
# Reserve three quarters of the cores for the other files in the global pool.
ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 1)
case "$ncpu" in ''|*[!0-9]*) ncpu=1 ;; esac
default_jobs=$((ncpu / 4))
[ "$default_jobs" -ge 1 ] || default_jobs=1
[ "$default_jobs" -le 8 ] || default_jobs=8
JOBS=${OMP_KIT_E2E_JOBS:-$default_jobs}
case "$JOBS" in ''|*[!0-9]*|0) echo "OMP_KIT_E2E_JOBS must be 1..16" >&2; exit 2 ;; esac
[ "$JOBS" -le 16 ] || { echo "OMP_KIT_E2E_JOBS must be 1..16" >&2; exit 2; }
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

# Policy-constrained contributors can provide an existing marked scratch root.
# Otherwise runtime-adapter creates a private system-temp root.
: "${OMP_KIT_CASE_CWD:=$(pwd -P)}"
export OMP_KIT_CASE_CWD
if [ "${OMP_KIT_TEST_WORK_ROOT+x}" = x ]; then
  OMP_KIT_TEST_WORK_ROOT=$("$OMP_KIT_BUN" --validate-work-root) || exit 2
  export OMP_KIT_TEST_WORK_ROOT
fi
# LIVEEVAL1 (ompkit-fp72.120.16.248): failing full-mode scenarios' evidence outlives scratch in this caller dir.
EVIDENCE_DIR=${OMP_KIT_E2E_EVIDENCE_DIR:-}; EVIDENCE_RUN=""
case "$EVIDENCE_DIR" in ''|/*) ;; *) echo "OMP_KIT_E2E_EVIDENCE_DIR must be absolute: $EVIDENCE_DIR" >&2; exit 2 ;; esac
if [ -n "$EVIDENCE_DIR" ] && { [ -L "$EVIDENCE_DIR" ] || [ ! -d "$EVIDENCE_DIR" ]; }; then
  echo "OMP_KIT_E2E_EVIDENCE_DIR is not an existing directory: $EVIDENCE_DIR" >&2; exit 2
fi
# Mock data always lives in a private mode-700 child, even if caller scratch is 755.
WORK_ROOT=$("$OMP_KIT_BUN" --workdir) || exit 2
OWN_WORK_ROOT=1
OMP_KIT_WORK_DIR="$WORK_ROOT"
export OMP_KIT_WORK_DIR
KEEP_WORK=0
# WORK_ROOT is a fresh private dir that runtime-adapter made for this shell (its .owner names our pid) and that
# cleanup below removes, so T is a plain child of it, not a second temp root.
T="$WORK_ROOT/e2e-live"
mkdir -m 0700 "$T" || { echo "cannot create e2e-live work directory under $WORK_ROOT" >&2; exit 2; }
H="$T/home"
MP=""
OP=""
MOCK_PIDS=""
DEFIANT_MOCK_SCENARIOS=""
WORKER_PIDS=""
cleanup() {
  [ -n "$MP" ] && kill "$MP" 2>/dev/null
  if [ "$OWN_WORK_ROOT" = 1 ] && [ "$KEEP_WORK" != 1 ]; then rm -rf "$WORK_ROOT"; fi
}
# The trap below only uses shell builtins (kill, wait) plus sleep, and only
# signals pids tracked in shell variables: fork pressure cannot wedge it the
# way process discovery could. OP is the limit wrapper, which forwards the
# signal to the omp session group; MP is the current mock.
# L2: a TERM/INT that lands mid-scenario must stop the run. The old EXIT-only
# trap let the loop spawn the next scenario after the signal (pid 93914 kept
# going until SIGKILL). Kill both children, reap bounded with KILL escalation,
# then exit with the signal code. Never launches another scenario.
on_signal() {
  code=$1
  # OP is the subshell around the limit wrapper, not the wrapper itself: the
  # OMP session group outlives the subshell, so signal the group by the pgid
  # the wrapper published, then fall through to the OP/MP reaping below.
  if [ -n "${LIMIT_PGID_FILE:-}" ] && [ -s "$LIMIT_PGID_FILE" ]; then
    pgid=$(cat "$LIMIT_PGID_FILE" 2>/dev/null) || pgid=""
    if pgid=$(kitlib_safe_pid "$pgid"); then
      kitlib_signal TERM "$pgid" group 2>/dev/null; sleep 0.5; kitlib_signal KILL "$pgid" group 2>/dev/null
    fi
  fi
  [ -n "$OP" ] && kill -TERM "$OP" 2>/dev/null
  [ -n "$MP" ] && kill -TERM "$MP" 2>/dev/null
  for worker in $WORKER_PIDS; do kill -TERM "$worker" 2>/dev/null; done
  w=0
  while [ "$w" -lt 50 ]; do
    op_alive=0
    mock_alive=0
    [ -n "$OP" ] && kill -0 "$OP" 2>/dev/null && op_alive=1
    [ -n "$MP" ] && kill -0 "$MP" 2>/dev/null && mock_alive=1
    workers_alive=0
    for worker in $WORKER_PIDS; do kill -0 "$worker" 2>/dev/null && workers_alive=1; done
    [ "$op_alive" = 0 ] && [ "$mock_alive" = 0 ] && [ "$workers_alive" = 0 ] && break
    sleep 0.1; w=$((w+1))
  done
  [ -n "$OP" ] && kill -0 "$OP" 2>/dev/null && kill -KILL "$OP" 2>/dev/null
  [ -n "$MP" ] && kill -0 "$MP" 2>/dev/null && kill -KILL "$MP" 2>/dev/null
  for worker in $WORKER_PIDS; do kill -KILL "$worker" 2>/dev/null; done
  wait 2>/dev/null
  OP=""; MP=""
  echo "e2e-live: stopped on signal, exit $code" >&2
  exit "$code"
}
trap cleanup EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
mkdir -p "$H/.agents/rules" "$H/.omp/agent" "$H/.config" "$H/.cache" "$H/.local/share" "$H/.local/state" "$H/.bun" "$T/bin" "$T/tmp"
# Launchd-domain isolation: an isolated HOME does not isolate the per-uid launchd domain,
# so the suite snapshots the production watcher's identity and fails if it moves.
isolation_snapshot() {
  if command -v launchctl >/dev/null 2>&1; then
    out=$(launchctl print "gui/$(id -u)/com.omp-kit.omp-watch" 2>&1); rc=$?
    printf 'rc=%s\n' "$rc"
    printf '%s\n' "$out" | grep -a "[[:space:]]path = " || true
  else
    echo "launchctl-absent"
  fi
}
ISOLATION_BEFORE="$T/isolation-before.txt"
isolation_snapshot >"$ISOLATION_BEFORE" 2>&1
KIT_PATH=
if [ "$MODE" = full ]; then
  if [ -x "$HERE/bin/omp-kit" ]; then
    # G4 tests the selected archive, including private pre-publication staging.
    # Signed public install/upgrade separately proves stable-link activation.
    KIT_EXECUTABLE="$HERE/bin/omp-kit"
  else
    case "$(/usr/bin/uname -s)-$(/usr/bin/uname -m)" in
      Darwin-arm64) KIT_PLATFORM=darwin-arm64-none ;;
      Darwin-x86_64) KIT_PLATFORM=darwin-x64-none ;;
      Linux-aarch64) KIT_PLATFORM=linux-arm64-gnu ;;
      Linux-x86_64) KIT_PLATFORM=linux-x64-gnu ;;
      *) KEEP_WORK=1; echo "no native omp-kit candidate for this host" >&2; exit 2 ;;
    esac
    KIT_VERSION=0.0.0-live-local
    KIT_PREFIX="$WORK_ROOT/kit-prefix"
    KIT_RELEASE="$KIT_PREFIX/releases/v$KIT_VERSION"
    mkdir -p "$KIT_RELEASE" "$KIT_PREFIX/bin"
    sh "$HERE/scripts/package-release.sh" --version "$KIT_VERSION" --platform "$KIT_PLATFORM" --out "$WORK_ROOT" || { package_rc=$?; KEEP_WORK=1; echo "live candidate package producer_rc=$package_rc" >&2; exit "$package_rc"; }
    tar -xf "$WORK_ROOT/omp-kit-v$KIT_VERSION-$KIT_PLATFORM.tar" -C "$KIT_RELEASE" || { tar_rc=$?; KEEP_WORK=1; echo "live candidate extract producer_rc=$tar_rc" >&2; exit "$tar_rc"; }
    ln -s "../releases/v$KIT_VERSION/bin/omp-kit" "$KIT_PREFIX/bin/omp-kit"
    KIT_EXECUTABLE="$KIT_PREFIX/bin/omp-kit"
  fi
  KIT_PATH="$(dirname "$KIT_EXECUTABLE"):"
fi
case "${OMP_KIT_RULES_VIA:-agents}" in
  agents) RULES_DIR="$H/.agents/rules"; PLUGIN_SOURCE="" ;;
  plugin)
    PLUGIN_SOURCE="${OMP_KIT_PLUGIN_SOURCE:-}"
    if [ -n "$PLUGIN_SOURCE" ]; then
      case "$PLUGIN_SOURCE" in /*) ;; *) KEEP_WORK=1; echo "OMP_KIT_PLUGIN_SOURCE must be an absolute directory" >&2; exit 2 ;; esac
      [ -f "$PLUGIN_SOURCE/package.json" ] || { KEEP_WORK=1; echo "OMP_KIT_PLUGIN_SOURCE has no package.json: $PLUGIN_SOURCE" >&2; exit 2; }
      RULES_DIR="$PLUGIN_SOURCE/rules"
    else
      RULES_DIR="$T/kit-plugin/rules"
      mkdir -p "$RULES_DIR"
      printf '{"name":"omp-kit-rules","version":"0.0.0","omp":{"name":"omp-kit-rules","version":"0.0.0"}}\n' >"$T/kit-plugin/package.json"
    fi ;;
  *) KEEP_WORK=1; echo "OMP_KIT_RULES_VIA must be agents or plugin" >&2; exit 2 ;;
esac
# The fleet pack (rules-fleet/) is opt-in for users, but its scenarios share this inventory: install both packs
# so every scenario's rule is live, and coverage judges both.
if [ -z "${PLUGIN_SOURCE:-}" ]; then cp "$HERE"/rules/*.md "$HERE"/rules-fleet/*.md "$RULES_DIR/"; fi
if [ "$MODE" = plant ] && [ -n "${PLUGIN_SOURCE:-}" ]; then
  KEEP_WORK=1; echo "plant mode refuses a repo plugin source: it would mutate checked-out rules" >&2; exit 2
fi
if [ "$MODE" = plant ]; then
  "$OMP_KIT_BUN" "$LIB" plant "$RULES_DIR/kit-close-needs-evidence.md" || { plant_rc=$?; KEEP_WORK=1; echo "plant producer_rc=$plant_rc" >&2; exit "$plant_rc"; }
  echo "plant: kit-close-needs-evidence condition ->"
  grep '^condition:' "$RULES_DIR/kit-close-needs-evidence.md"
else
  if [ -z "${OMP_KIT_TEST_NO_COVERAGE:-}" ]; then "$OMP_KIT_BUN" "$LIB" coverage "$HERE/rules" "$HERE/rules-fleet" || { coverage_rc=$?; KEEP_WORK=1; echo "coverage producer_rc=$coverage_rc" >&2; exit "$coverage_rc"; }; else echo "coverage skipped by OMP_KIT_TEST_NO_COVERAGE (test-only)" >&2; fi
fi
if [ -z "${OMP_KIT_DEFAULT_TTSR:-}" ]; then
  "$OMP_KIT_BUN" "$LIB" config "$HERE/policy/ttsr.json" "$H/.omp/agent/config.yml" || { config_rc=$?; KEEP_WORK=1; echo "config producer_rc=$config_rc" >&2; exit "$config_rc"; }
else
  echo "default TTSR: kit policy not installed; omp runs under its own defaults"
fi
# L2: test runs must never reach real local model providers. On 2026-10-02 a
# release-check omp child held this machine's real Ollama :11434 and blocked
# localbench for an hour: an isolated HOME isolates config, but OMP still
# discovers implicit socket providers (ollama/llama.cpp/lm-studio). Disable
# them in the isolated config; the per-scenario mock provider is configured
# explicitly in models.yml and is unaffected, as is on-device Apple FM.
# OMP_KIT_TEST_NO_PROVIDER_PIN=1 skips the append so tests can prove OMP would
# otherwise probe OLLAMA_HOST (test-only; production runs never set it).
if [ -z "${OMP_KIT_TEST_NO_PROVIDER_PIN:-}" ]; then
  printf 'disabledProviders:\n- ollama\n- "llama.cpp"\n- lm-studio\n' >>"$H/.omp/agent/config.yml" || { config_rc=$?; KEEP_WORK=1; echo "provider isolation producer_rc=$config_rc" >&2; exit "$config_rc"; }
else
  echo "provider isolation skipped by OMP_KIT_TEST_NO_PROVIDER_PIN (test-only)" >&2
fi
printf '[user]\n\temail = e2e@example.invalid\n\tname = e2e\n[init]\n\tdefaultBranch = main\n' >"$H/.gitconfig"
# br/bd/ntm/lldb stubs: a scenario command that gets past the rules must not touch a real beads database,
# send to a live pane, or attach a debugger.
for b in br bd ntm lldb; do printf '#!/bin/sh\nexit 0\n' >"$T/bin/$b"; chmod +x "$T/bin/$b"; done

# Everything that omp and git see runs with this environment. Call it inside a subshell.
isolate() {
  export HOME="$H" \
    XDG_CONFIG_HOME="$H/.config" \
    XDG_CACHE_HOME="$H/.cache" \
    XDG_DATA_HOME="$H/.local/share" \
    XDG_STATE_HOME="$H/.local/state" \
    TMPDIR="$T/tmp" BUN_INSTALL="$H/.bun" GIT_CONFIG_NOSYSTEM=1 PATH="$T/bin:$KIT_PATH$PATH"
}

OMP_VERSION=$(isolate && "$OMP" --version) || exit 2
OMP_BINARY_SHA=$(shasum -a 256 "$OMP" | cut -d' ' -f1) || exit 2
OMP_NATIVE_SEED_ID=$(printf '%s\n%s\n' "$OMP_VERSION" "$OMP_BINARY_SHA" | shasum -a 256 | cut -d' ' -f1) || exit 2
echo "omp: $OMP_VERSION ($OMP; native seed $OMP_NATIVE_SEED_ID)"
# LIVEEVAL1: OMP probes PATH pythons under one 10 s budget; the macOS /usr/bin/python3 xcrun shim took up to
# 9.9 s cold (its interpreter 0.03 s), so loaded py eval cells never ran ("Python backend is unavailable").
# Pin the interpreter python3 launches, resolved once; with no python3, OMP discovery decides.
if (isolate && command -v python3 >/dev/null); then
  PY_INTERPRETER=$(isolate && "$LIMIT" 60 python3 -c 'import sys; print(sys.executable)' </dev/null) || { py_rc=$?; KEEP_WORK=1; echo "python3 resolve producer_rc=$py_rc" >&2; exit 2; }
  py_ok=0
  case "$PY_INTERPRETER" in
    *'"'*|*\\*) ;;
    /*) [ ! -x "$PY_INTERPRETER" ] || py_ok=1 ;;
  esac
  [ "$py_ok" = 1 ] || { KEEP_WORK=1; echo "python3 reported no usable interpreter path: '$PY_INTERPRETER'" >&2; exit 2; }
  printf 'python:\n  interpreter: "%s"\n' "$PY_INTERPRETER" >>"$H/.omp/agent/config.yml" || { KEEP_WORK=1; echo "python pin failed" >&2; exit 2; }
  echo "python: $PY_INTERPRETER (python.interpreter)"
fi
if [ "${OMP_KIT_RULES_VIA:-agents}" = plugin ]; then
  (isolate && "$OMP" plugin link "${PLUGIN_SOURCE:-$T/kit-plugin}" >/dev/null) || { link_rc=$?; KEEP_WORK=1; echo "plugin link producer_rc=$link_rc" >&2; exit "$link_rc"; }
  if [ -n "${OMP_KIT_PLUGIN_DISABLE_AFTER_LINK:-}" ]; then
    (isolate && "$OMP" plugin disable "$OMP_KIT_PLUGIN_DISABLE_AFTER_LINK" >/dev/null) || { disable_rc=$?; KEEP_WORK=1; echo "plugin disable producer_rc=$disable_rc" >&2; exit "$disable_rc"; }
  fi
fi
echo "rules root: $RULES_DIR ($(find "$RULES_DIR" -type f -name '*.md' | wc -l | tr -d ' ') files; isolated .agents/rules has $(find "$H/.agents/rules" -type f -name '*.md' | wc -l | tr -d ' '))"
pass=0; fail=0; selected=0
scenario_ids=$("$OMP_KIT_BUN" "$LIB" select "$MODE")
select_rc=$?
[ "$select_rc" -eq 0 ] || { KEEP_WORK=1; echo "scenario select producer_rc=$select_rc" >&2; exit "$select_rc"; }
[ -n "$scenario_ids" ] || { KEEP_WORK=1; echo "scenario select returned no scenarios" >&2; exit 2; }
printf 'scenario ids: %s\n' "$scenario_ids"
# Profiling only: Time::HiRes ships with the Perl already used by the process
# limiter. The no-op control exposes clock-process startup cost.
profile_step() {
  profile_label=$1; shift
  if [ "${OMP_KIT_E2E_PROFILE:-0}" != 1 ]; then "$@"; return $?; fi
  profile_started=$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%.6f", time')
  "$@"
  profile_rc=$?
  /usr/bin/perl -MTime::HiRes=time -e '
    my ($scenario, $step, $start) = @ARGV; my $end = time;
    printf STDERR "E2E_PROFILE scenario=%s step=%s started_s=%.6f ended_s=%.6f duration_ms=%.3f\n",
      $scenario, $step, $start, $end, ($end-$start)*1000;
  ' "${name:-suite}" "$profile_label" "$profile_started"
  return "$profile_rc"
}
profile_step noop :
# Bounded mock reap: TERM, short grace, then KILL and reap. A mock that ignores
# SIGTERM is recorded by scenario; the exit check below fails loudly on it, so a
# defiant mock can never hang the suite on `wait`.
reap_mock() {
  kill "$MP" 2>/dev/null
  w=0
  while kill -0 "$MP" 2>/dev/null && [ "$w" -lt 50 ]; do sleep 0.1; w=$((w+1)); done
  if kill -0 "$MP" 2>/dev/null; then
    kill -9 "$MP" 2>/dev/null
    wait "$MP" 2>/dev/null
    mock_cleanup_rc=137
    DEFIANT_MOCK_SCENARIOS="$DEFIANT_MOCK_SCENARIOS $name"
    echo "mock server ignored SIGTERM, killed -9: scenario=$name" >&2
  else
    wait "$MP" 2>/dev/null
    mock_cleanup_rc=$?
  fi
  # Remove the reaped PID before a later scenario can reuse it.
  still_tracked=""
  for entry in $MOCK_PIDS; do
    [ "${entry%%:*}" = "$MP" ] || still_tracked="$still_tracked $entry"
  done
  MOCK_PIDS=$still_tracked
  MP=""
}
# Normal-path group reap: the limit wrapper's waitpid returns when the omp
# session leader exits, but group orphans (helpers, daemons) survive it and
# keep writing under $T. A later tree removal (cleanup rm -rf, or a caller's
# rmtree) then races live writers: native certification saw Errno 66 mask a
# 900 s full-ladder timeout. Reap the published group the same way the
# signal path does before reporting the scenario.
reap_group() {
  [ -n "${LIMIT_PGID_FILE:-}" ] && [ -s "$LIMIT_PGID_FILE" ] || return 0
  pgid=$(cat "$LIMIT_PGID_FILE" 2>/dev/null) || pgid=""
  pgid=$(kitlib_safe_pid "$pgid") || return 0
  kitlib_signal TERM "$pgid" group 2>/dev/null
  w=0
  while kill -0 "-$pgid" 2>/dev/null && [ "$w" -lt 20 ]; do sleep 0.1; w=$((w+1)); done
  kitlib_signal KILL "$pgid" group 2>/dev/null
}
BASE_HOME=$H
NATIVE_SEED="$T/native-seed/$OMP_NATIVE_SEED_ID"
BUN_SEED="$T/bun-cache-seed/$OMP_NATIVE_SEED_ID"
native_seeded=0
# A compiled OMP extracts a large immutable binding on its first real turn.
# Reuse only those verified bytes, not another scenario's configs or databases.
seed_runtime_cache() {
  for binding in "$T/home-$1/.omp/natives"/*/*.node; do
    if [ ! -f "$binding" ] || [ -L "$binding" ]; then continue; fi
    version_dir=${binding%/*}; version_dir=${version_dir##*/}
    binding_name=${binding##*/}
    mkdir -p "$NATIVE_SEED/$version_dir" || return 2
    cp "$binding" "$NATIVE_SEED/$version_dir/$binding_name" || return 2
    cmp -s "$binding" "$NATIVE_SEED/$version_dir/$binding_name" || return 2
    chmod 444 "$NATIVE_SEED/$version_dir/$binding_name" || return 2
  done
  # Bun's .pile files are content-addressed transpilation output. Each home
  # receives a private copy; never copy extension DBs, credentials or models.
  for compiled in "$T/home-$1/.cache/bun"/*/*.pile; do
    [ "${OMP_KIT_E2E_BUN_CACHE:-1}" = 1 ] || break
    if [ ! -f "$compiled" ] || [ -L "$compiled" ]; then continue; fi
    cache_dir=${compiled%/*}; cache_dir=${cache_dir##*/}
    mkdir -p "$BUN_SEED/$cache_dir" || return 2
    cp "$compiled" "$BUN_SEED/$cache_dir/${compiled##*/}" || return 2
    cmp -s "$compiled" "$BUN_SEED/$cache_dir/${compiled##*/}" || return 2
    chmod 444 "$BUN_SEED/$cache_dir/${compiled##*/}" || return 2
  done
  native_seeded=1
}
run_scenario() {
  i=$1
  WORKER_PIDS=""
  # Worker traps own only their mock and OMP group, never the parent's root.
  trap '[ -z "$OP$MP" ] || on_signal 143' EXIT
  trap 'on_signal 143' TERM
  trap 'on_signal 130' INT
  name=$(profile_step name "$OMP_KIT_BUN" "$LIB" name "$i")
  name_rc=$?
  if [ "$name_rc" -ne 0 ] || [ -z "$name" ]; then
    KEEP_WORK=1; echo "scenario name producer_rc=$name_rc id=$i" >&2; exit 2
  fi
  case " ${ONLY:-$name} " in *" $name "*) ;; *) return 0 ;; esac
  printf '%s\n' "$name" >"$T/result-$i.name"
  H="$T/home-$i"
  cp -R "$BASE_HOME" "$H" || return 2
  for compiled in "$BUN_SEED"/*/*.pile; do
    [ "${OMP_KIT_E2E_BUN_CACHE:-1}" = 1 ] || break
    [ -f "$compiled" ] || continue
    cache_dir=${compiled%/*}; cache_dir=${cache_dir##*/}
    mkdir -p "$H/.cache/bun/$cache_dir" || return 2
    cp "$compiled" "$H/.cache/bun/$cache_dir/${compiled##*/}" || return 2
    chmod 600 "$H/.cache/bun/$cache_dir/${compiled##*/}" || return 2
  done
  for binding in "$NATIVE_SEED"/*/*.node; do
    [ -f "$binding" ] || continue
    version_dir=${binding%/*}; version_dir=${version_dir##*/}
    mkdir -p "$H/.omp/natives/$version_dir" || return 2
    ln "$binding" "$H/.omp/natives/$version_dir/${binding##*/}" || return 2
  done
  P="$T/proj-$name"; LOG="$T/log-$name.jsonl"; SC="$T/scen-$name.json"; PF="$T/port-$name"
  mkdir -p "$P"
  (cd "$P" && isolate && git init -q && git commit -q --allow-empty -m init) || { git_rc=$?; KEEP_WORK=1; echo "git init producer_rc=$git_rc scenario=$name" >&2; exit "$git_rc"; }
  profile_step prep "$OMP_KIT_BUN" "$LIB" prep "$i" "$SC" "$P" || { prep_rc=$?; KEEP_WORK=1; echo "scenario prep producer_rc=$prep_rc id=$i" >&2; exit "$prep_rc"; }
  "$OMP_KIT_BUN" --work-dir "$WORK_ROOT" --scenario "$SC" --log "$LOG" --port-file "$PF" "$MOCK" >"$T/mock-$name.txt" 2>&1 &
  MP=$!
  MOCK_PIDS="$MOCK_PIDS $MP:$name"
  w=0; while [ ! -s "$PF" ] && [ "$w" -lt 100 ]; do sleep 0.1; w=$((w+1)); done
  if [ ! -s "$PF" ]; then
    kill "$MP" 2>/dev/null; wait "$MP" 2>/dev/null; mock_rc=$?; MP=""
    echo "mock startup producer_rc=$mock_rc log=$T/mock-$name.txt" >&2
    cat "$T/mock-$name.txt" >&2
    KEEP_WORK=1; exit 2
  fi
  profile_step models "$OMP_KIT_BUN" "$LIB" models "$(cat "$PF")" "$H/.omp/agent/models.yml" || { models_rc=$?; KEEP_WORK=1; echo "models producer_rc=$models_rc scenario=$name" >&2; exit "$models_rc"; }
  LIMIT_PGID_FILE="$T/pgid-$name"; rm -f "$LIMIT_PGID_FILE"; export LIMIT_PGID_FILE
  (cd "$P" && isolate && profile_step omp "$LIMIT" "$TIMEOUT" "$OMP" --extension "$HERE/tests/live/admission-extension.mjs" -p --no-session --model mock/mock --approval-mode yolo "go" </dev/null) >"$T/out-$name.txt" 2>&1 & OP=$!
  echo "e2e-live: started scenario=$name omp_pid=$OP mock_pid=$MP" >&3
  wait "$OP"; rc=$?; OP=""
  profile_step mock-reap reap_mock
  profile_step group-reap reap_group
  rm -f "$LIMIT_PGID_FILE"; unset LIMIT_PGID_FILE
  echo "mock server cleanup_rc=$mock_cleanup_rc log=$T/mock-$name.txt"
  cat "$T/mock-$name.txt"
  echo "OMP producer_rc=$rc output_log=$T/out-$name.txt transcript=$LOG"
  cat "$T/out-$name.txt"
  verdict=$(profile_step verdict "$OMP_KIT_BUN" "$LIB" verdict "$i" "$LOG" "$P" "$rc")
  verdict_rc=$?
  if [ "$verdict_rc" -ne 0 ] || [ -z "$verdict" ]; then
    [ "$verdict_rc" -ne 0 ] || verdict_rc=2
    KEEP_WORK=1; echo "verdict producer_rc=$verdict_rc scenario=$name" >&2; exit "$verdict_rc"
  fi
  if [ "$name" = omp-late-interrupt-probe ]; then
    # Report-only OMP race probe: prints PROBE omp-late-interrupt: continued|aborted and
    # never counts toward pass/fail, so the gate does not depend on OMP's continuation race.
    "$OMP_KIT_BUN" "$LIB" probe "$i" "$LOG"
    printf 'probe\n' >"$T/result-$i.verdict"
    return 0
  fi
  printf '%s\n' "$verdict" >"$T/result-$i.verdict"
  printf '%s\n' "$rc" >"$T/result-$i.omp-rc"
  printf '%s\n' "$DEFIANT_MOCK_SCENARIOS" >"$T/result-$i.defiant"
}
keep_failure_evidence() { # LIVEEVAL1: this run's own EVIDENCE_DIR child, made at its first failure
  if [ -z "$EVIDENCE_RUN" ]; then
    evidence_n=0; EVIDENCE_RUN="$EVIDENCE_DIR/e2e-live.$$"
    while [ -e "$EVIDENCE_RUN" ] || [ -L "$EVIDENCE_RUN" ]; do evidence_n=$((evidence_n+1)); EVIDENCE_RUN="$EVIDENCE_DIR/e2e-live.$$.$evidence_n"; done
    mkdir -m 0700 "$EVIDENCE_RUN" || { echo "cannot create $EVIDENCE_RUN" >&2; EVIDENCE_RUN=""; return 2; }
  fi
  for evidence_file in "log-$1.jsonl" "out-$1.txt" "mock-$1.txt"; do
    [ ! -f "$T/$evidence_file" ] || cp "$T/$evidence_file" "$EVIDENCE_RUN/$evidence_file" || { echo "cannot keep $T/$evidence_file" >&2; return 2; }
  done
}
# A bounded work-conserving pool: a slow scenario never holds every other slot
# idle. Only the parent reports cases, preserving order and the end counter.
finish_batch() {
  for entry in $batch; do
    worker=${entry%%:*}; case_id=${entry#*:}
    if [ ! -f "$T/result-$case_id.worker-rc" ]; then
      wait "$worker"; worker_rc=$?
      printf '%s\n' "$worker_rc" >"$T/result-$case_id.worker-rc"
    fi
  done
  WORKER_PIDS=""
  for entry in $batch; do
    case_id=${entry#*:}
    cat "$T/worker-$case_id.stdout"
    cat "$T/worker-$case_id.stderr" >&2
    IFS= read -r worker_rc <"$T/result-$case_id.worker-rc"
    if [ "$worker_rc" -ne 0 ]; then KEEP_WORK=1; return "$worker_rc"; fi
    [ -f "$T/result-$case_id.name" ] || continue
    IFS= read -r name <"$T/result-$case_id.name"
    selected=$((selected+1))
    if [ "$native_seeded" = 0 ]; then seed_runtime_cache "$case_id" || { KEEP_WORK=1; return 2; }; fi
    IFS= read -r verdict <"$T/result-$case_id.verdict" || { KEEP_WORK=1; return 2; }
    [ "$verdict" != probe ] || continue
    IFS= read -r rc <"$T/result-$case_id.omp-rc" || { KEEP_WORK=1; return 2; }
    IFS= read -r defiant <"$T/result-$case_id.defiant" || defiant=""
    DEFIANT_MOCK_SCENARIOS="$DEFIANT_MOCK_SCENARIOS$defiant"
    if [ "$verdict" = ok ]; then
      pass=$((pass+1)); echo "ok    $name"
      if [ "$MODE" = full ]; then report_test_case "$name" PASS; fi
    else
      transcript="$T/log-$name.jsonl"
      if [ "$MODE" = full ] && [ -n "$EVIDENCE_DIR" ]; then
        keep_failure_evidence "$name" || { KEEP_WORK=1; return 2; }
        transcript="$EVIDENCE_RUN/log-$name.jsonl"
      fi
      fail=$((fail+1)); echo "FAIL  $name :: $verdict (omp exit $rc; transcript: $transcript)"
      # These captures contain only the isolated mock conversation, never env.
      # Put OMP last so its error survives even an outer stage's stderr tail.
      "$OMP_KIT_BUN" "$LIB" failure-tail "$T/log-$name.jsonl" "$T/out-$name.txt"
      if [ "$MODE" = full ]; then report_test_case "$name" FAIL; fi
    fi
  done
  batch=""; active=""; running=0
}
reap_finished() {
  while :; do
    pending=""; pending_pids=""
    for entry in $active; do
      worker=${entry%%:*}; case_id=${entry#*:}
      if kill -0 "$worker" 2>/dev/null; then
        pending="$pending $entry"; pending_pids="$pending_pids $worker"
      else
        wait "$worker"; worker_rc=$?
        printf '%s\n' "$worker_rc" >"$T/result-$case_id.worker-rc"
        running=$((running-1))
      fi
    done
    active=$pending; WORKER_PIDS=$pending_pids
    [ "$running" -lt "$JOBS" ] && return 0
    sleep 0.02
  done
}
batch=""; active=""; running=0
for i in $scenario_ids; do
  (run_scenario "$i") 3>&2 >"$T/worker-$i.stdout" 2>"$T/worker-$i.stderr" &
  worker=$!
  WORKER_PIDS="$WORKER_PIDS $worker"
  batch="$batch $worker:$i"
  active="$active $worker:$i"
  running=$((running+1))
  if [ "$native_seeded" = 0 ]; then
    finish_batch || exit $?
  elif [ "$running" -ge "$JOBS" ]; then
    reap_finished
  fi
done
[ -z "$batch" ] || finish_batch || exit $?
ISOLATION_AFTER="$T/isolation-after.txt"
isolation_snapshot >"$ISOLATION_AFTER" 2>&1
if ! cmp -s "$ISOLATION_BEFORE" "$ISOLATION_AFTER"; then
  echo "launchd isolation broken: com.omp-kit.omp-watch changed during the suite" >&2
  diff "$ISOLATION_BEFORE" "$ISOLATION_AFTER" >&2 || true
  fail=$((fail+1))
  report_test_case launchd-isolation FAIL
else
  report_test_case launchd-isolation PASS
fi
if [ "$selected" -eq 0 ]; then
  KEEP_WORK=1
  echo "e2e-live ($MODE): no scenarios matched ONLY='${ONLY:-<unset>}'" >&2
  echo "private diagnostics retained: $T (work root $WORK_ROOT)" >&2
  exit 2
fi
# Exit check: no mock server started by this run may survive it. Report survivors
# by scenario id (tracked pids plus any that defied SIGTERM) and fail.
mock_leaked=""
for entry in $MOCK_PIDS; do
  pid=${entry%%:*}; scenario=${entry#*:}
  if kill -0 "$pid" 2>/dev/null; then mock_leaked="$mock_leaked $scenario(pid=$pid)"; fi
done
if [ -n "$DEFIANT_MOCK_SCENARIOS" ] || [ -n "$mock_leaked" ]; then
  echo "leaked mock servers: defiant scenarios:$DEFIANT_MOCK_SCENARIOS still-alive:$mock_leaked" >&2
  fail=$((fail+1))
  report_test_case mock-server-cleanup FAIL
else
  report_test_case mock-server-cleanup PASS
fi
echo "e2e-live ($MODE): $pass passed, $fail failed"
[ -z "$EVIDENCE_RUN" ] || echo "failure evidence kept: $EVIDENCE_RUN"
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
    report_test_case planted-control-kit-close-needs-evidence PASS
    finish_case_report
    exit 0
  fi
  echo "plant NOT caught: the suite passed a baseline rule that fires on an evidenced close"
  report_test_case planted-control-kit-close-needs-evidence FAIL
  finish_case_report
  exit 1
fi
finish_case_report
[ "$fail" -eq 0 ]
