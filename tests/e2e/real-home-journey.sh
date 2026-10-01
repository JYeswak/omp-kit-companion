#!/bin/sh
# shellcheck disable=SC2317,SC2329 # step functions (build_fixture, kit_env, ...) run indirectly via step "$@" (0.9 says SC2317, 0.10+ SC2329).
# Real-HOME journey: the README path (install -> status -> doctor -> state-root repair -> test ->
# test --full -> update --apply -> audit) against a realistic HOME instead of a tiny synthetic one.
#
# Usage:
#   sh tests/e2e/real-home-journey.sh \
#     --candidate-archive ABS --candidate-index ABS \
#     --previous-archive ABS --previous-index ABS --work-dir ABS
# Each flag may instead come from the environment: JOURNEY_CANDIDATE_ARCHIVE, JOURNEY_CANDIDATE_INDEX,
# JOURNEY_PREVIOUS_ARCHIVE, JOURNEY_PREVIOUS_INDEX, JOURNEY_WORK_DIR. All paths must be absolute.
# The archives/indexes are local release candidates (installer index format, schema_version 1); the
# version of each comes from its index's "version". The previous one is installed first and then
# updated to the candidate. The work dir is created if absent; WORK/home must not exist yet.
#
# Environment for every kit step: HOME=WORK/home (the fixture), XDG_STATE_HOME/XDG_CONFIG_HOME/
# XDG_CACHE_HOME/XDG_DATA_HOME unset (the kit state root is therefore the legacy ~/.local/state/omp-kit),
# TMPDIR=WORK/tmp, cwd=HOME. OMP is whatever `omp` the PATH provides (CI pins it with npm).
#
# Fixture: >= 50,000 files including a Library/-like tree; ~/.agents/rules holding the previous
# release's rules, 12 byte-identical and 6 locally edited; a legacy ~/.local/state/omp-kit with mode
# 0755 holding installed.tsv and backups/. A background writer appends to an UNWATCHED file
# (~/Library/Caches/com.example.journey-writer/heartbeat.log) every second for the whole run; a trap
# stops it on exit.
#
# Output (under WORK/log): steps.jsonl has one line per step
#   {step, argv, rc, seconds, verdict, artifact, expected_rc, expected_verdict, match}
# and NN-STEP.out / NN-STEP.err keep each producer's complete stdout/stderr (artifact = the .out path).
# Every verdict is derived from the step's output and compared with EXPECTED below; each mismatch
# prints the step with expected vs observed rc and verdict. All steps run even after a mismatch,
# except: a failed fixture or install_previous aborts the run, because without a fixture or an
# installed kit every later step is meaningless.
#
# Exit: 0 every step matched; 1 at least one mismatch (or an abort); 2 usage error.

# step|expected rc|expected verdict.  @PREV@ / @CAND@ are the previous / candidate index versions.
EXPECTED='fixture|0|files>=50000 rules_identical=12 rules_edited=6 state_mode=0755 installed_tsv=yes backups=yes
install_previous|0|installed=@PREV@
version|0|omp-kit @PREV@
status|0|ok=true state_root=DEGRADED:0755 installed_rules=DEGRADED
doctor|0|ok=true state_root=DEGRADED mode=0755 path=~/.local/state/omp-kit
repair_state_plan|0|action=PLAN scope=state previous_mode=0755 changes=1
repair_state_apply|0|action=APPLIED scope=state previous_mode=0755 changes=1
legacy_state_after_repair|0|mode=0700 installed_tsv=unchanged backups=present
doctor_after_repair|0|ok=true state_root=OK
test|0|ok=true status=PASS exit=0 failures=[]
test_full|0|ok=true status=PASS exit=0 failures=[] home=unchanged,complete
update_apply|0|ok=true action=UPDATED postcheck=PASS active=@CAND@ reason=null
version_after_update|0|omp-kit @CAND@
audit|0|ok=true latest_update_receipt=RECONCILED
background_writer|0|alive=yes ticks>=10'

usage() {
  sed -n '/^# Usage:/,/^#$/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

CAND_ARCHIVE=${JOURNEY_CANDIDATE_ARCHIVE:-}
CAND_INDEX=${JOURNEY_CANDIDATE_INDEX:-}
PREV_ARCHIVE=${JOURNEY_PREVIOUS_ARCHIVE:-}
PREV_INDEX=${JOURNEY_PREVIOUS_INDEX:-}
WORK=${JOURNEY_WORK_DIR:-}
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --candidate-archive) CAND_ARCHIVE=$2 ;;
    --candidate-index) CAND_INDEX=$2 ;;
    --previous-archive) PREV_ARCHIVE=$2 ;;
    --previous-index) PREV_INDEX=$2 ;;
    --work-dir) WORK=$2 ;;
    *) usage ;;
  esac
  shift 2
done
for path in "$CAND_ARCHIVE" "$CAND_INDEX" "$PREV_ARCHIVE" "$PREV_INDEX" "$WORK"; do
  case "$path" in /*) ;; *) echo "journey: every path must be given and absolute: '$path'" >&2; usage ;; esac
done
for path in "$CAND_ARCHIVE" "$CAND_INDEX" "$PREV_ARCHIVE" "$PREV_INDEX"; do
  [ -f "$path" ] || { echo "journey: not a file: $path" >&2; exit 2; }
done
for tool in jq awk find tar python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "journey: $tool is required" >&2; exit 2; }
done
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P) || exit 2
INSTALLER="$ROOT/installer/install.sh"
PREV=$(jq -er .version "$PREV_INDEX") || { echo "journey: no .version in $PREV_INDEX" >&2; exit 2; }
CAND=$(jq -er .version "$CAND_INDEX") || { echo "journey: no .version in $CAND_INDEX" >&2; exit 2; }
FIXTURE_HOME="$WORK/home"
[ ! -e "$FIXTURE_HOME" ] || { echo "journey: $FIXTURE_HOME already exists; use a fresh work dir" >&2; exit 2; }
LOG="$WORK/log"
JSONL="$LOG/steps.jsonl"
mkdir -p "$LOG" "$WORK/tmp" "$WORK/release" || exit 2
: > "$JSONL" || exit 2
EXPECTED=$(printf '%s\n' "$EXPECTED" | sed -e "s/@PREV@/$PREV/g" -e "s/@CAND@/$CAND/g")
PREFIX="$FIXTURE_HOME/.local/opt/omp-kit"
KIT="$PREFIX/bin/omp-kit"
STATE_ROOT="$FIXTURE_HOME/.local/state/omp-kit"
WRITER_DIR="$FIXTURE_HOME/Library/Caches/com.example.journey-writer"
WRITER_FILE="$WRITER_DIR/heartbeat.log"
WRITER_PID=''
STEP_NO=0
MISMATCHES=0

stop_writer() {
  if [ -n "$WRITER_PID" ]; then
    kill "$WRITER_PID" 2>/dev/null
    wait "$WRITER_PID" 2>/dev/null
    WRITER_PID=''
  fi
}
trap 'stop_writer' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# make_tree DIR PREFIX COUNT_A COUNT_B FILES: DIR/PREFIX<a>/d<b>/f<n>.dat, one awk process for all files.
make_tree() {
  mkdir -p "$1" || return 1
  (
    cd "$1" || exit 1
    awk -v p="$2" -v na="$3" -v nb="$4" 'BEGIN { for (a = 0; a < na; a++) for (b = 0; b < nb; b++) printf "%s%03d/d%02d\n", p, a, b }' |
      xargs mkdir -p || exit 1
    awk -v p="$2" -v na="$3" -v nb="$4" -v nf="$5" 'BEGIN {
      for (a = 0; a < na; a++) for (b = 0; b < nb; b++) for (f = 0; f < nf; f++) {
        path = sprintf("%s%03d/d%02d/f%03d.dat", p, a, b, f)
        printf "fixture %s %d\n", path, a * b + f > path
        close(path)
      }
    }'
  )
}

build_fixture() {
  h=$FIXTURE_HOME
  make_tree "$h/Library/Caches" com.example.app 40 10 50 || return 1
  make_tree "$h/Library/Application Support" App 30 10 40 || return 1
  make_tree "$h/Library/Containers" com.example.sandbox 20 10 30 || return 1
  make_tree "$h/Developer/projects" repo 20 20 30 || return 1
  make_tree "$h/.cache" tool 10 10 20 || return 1
  mkdir -p "$h/Library/Preferences" "$h/Documents" "$h/Downloads" "$h/.config" "$WRITER_DIR" || return 1
  printf '# fixture login profile\numask 022\n' > "$h/.profile"
  printf '{"fixture": true}\n' > "$h/Library/Preferences/com.example.app.plist"
  # The previous release's own rules: the first 12 (sorted) byte-identical, the other 6 edited locally.
  tar -xf "$PREV_ARCHIVE" -C "$WORK/release" MANIFEST.tsv rules || return 1
  mkdir -p "$h/.agents/rules" || return 1
  i=0
  for rule in "$WORK"/release/rules/*.md; do
    i=$((i + 1))
    [ "$i" -le 18 ] || break
    cp "$rule" "$h/.agents/rules/" || return 1
    if [ "$i" -gt 12 ]; then
      printf '\n<!-- local operator edit %s -->\n' "$i" >> "$h/.agents/rules/$(basename "$rule")" || return 1
    fi
  done
  # Legacy state root as a pre-0700 kit left it: mode 0755, installed.tsv, backups/.
  mkdir -p "$STATE_ROOT/backups/20260924T020733Z/rules" || return 1
  awk -F '\t' 'NR == 1 { print "name\tsha256\tpack\tinstalled_utc"; next } { print $1 "\t" $2 "\t" $4 "\t2026-09-25T02:07:33Z" }' \
    "$WORK/release/MANIFEST.tsv" > "$STATE_ROOT/installed.tsv" || return 1
  cp "$WORK"/release/rules/*.md "$STATE_ROOT/backups/20260924T020733Z/rules/" || return 1
  chmod 0755 "$STATE_ROOT" || return 1
  cksum < "$STATE_ROOT/installed.tsv" > "$WORK/installed.tsv.cksum" || return 1

  files=$(find "$h" -type f | wc -l | tr -d ' ')
  identical=0 edited=0
  for rule in "$h"/.agents/rules/*.md; do
    if cmp -s "$rule" "$WORK/release/rules/$(basename "$rule")"; then identical=$((identical + 1)); else edited=$((edited + 1)); fi
  done
  files_verdict="files<50000($files)"
  [ "$files" -lt 50000 ] || files_verdict='files>=50000'
  mode=0755
  [ -n "$(find "$STATE_ROOT" -prune -perm 0755)" ] || mode=not-0755
  tsv=no backups=no
  [ -s "$STATE_ROOT/installed.tsv" ] && tsv=yes
  [ -d "$STATE_ROOT/backups" ] && backups=yes
  echo "fixture_files=$files"
  echo "$files_verdict rules_identical=$identical rules_edited=$edited state_mode=$mode installed_tsv=$tsv backups=$backups" > "$WORK/fixture.verdict"
}

check_legacy_state() {
  mode=not-0700
  [ -n "$(find "$STATE_ROOT" -prune -perm 0700)" ] && mode=0700
  tsv=changed
  cksum < "$STATE_ROOT/installed.tsv" | cmp -s - "$WORK/installed.tsv.cksum" && tsv=unchanged
  backups=missing
  [ -d "$STATE_ROOT/backups/20260924T020733Z/rules" ] && backups=present
  echo "mode=$mode installed_tsv=$tsv backups=$backups"
}

check_writer() {
  alive=no
  [ -n "$WRITER_PID" ] && kill -0 "$WRITER_PID" 2>/dev/null && alive=yes
  ticks=0
  [ -f "$WRITER_FILE" ] && ticks=$(wc -l < "$WRITER_FILE" | tr -d ' ')
  echo "alive=$alive ticks=$ticks"
}

# kit_env CMD...: the kit's environment for every journey step.
kit_env() {
  (
    cd "$FIXTURE_HOME" || exit 125
    unset XDG_STATE_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME
    HOME=$FIXTURE_HOME TMPDIR=$WORK/tmp
    export HOME TMPDIR
    exec "$@"
  )
}

# envelope_verdict FILE JQ: the error code when the envelope reports one, else the step's JQ verdict.
envelope_verdict() {
  jq -e . "$1" >/dev/null 2>&1 || { echo "unparseable-json"; return; }
  jq -r --arg home "$FIXTURE_HOME" "if ((.errors // []) | length) > 0 then \"ok=\\(.ok) error=\\(.errors[0].code)\" else ($2) end" "$1" 2>/dev/null ||
    echo "verdict-filter-failed"
}

# shellcheck disable=SC2016 # $home is a jq variable (envelope_verdict passes --arg home).
DOCTOR_FILTER='"ok=\(.ok) " + ([.data.findings[]? | select(.component == "state_root") | "state_root=\(.status) mode=\(.evidence.mode) path=\(.evidence.path | if startswith($home + "/") then "~" + ltrimstr($home) else . end)"][0] // "state_root=absent")'

verdict() {
  out=$1
  case "$2" in
    fixture) cat "$WORK/fixture.verdict" 2>/dev/null || echo "fixture-incomplete" ;;
    install_previous) v=$(sed -n 's/^installed: version=\([^ ]*\).*/\1/p' "$out")
      [ -x "$KIT" ] && [ -n "$v" ] && echo "installed=$v" || echo "not-installed" ;;
    version|version_after_update) head -n 1 "$out" ;;
    status) envelope_verdict "$out" '"ok=\(.ok) " + ([.data.findings[]? | select(.component == "state_root") | "state_root=\(.status):\(.evidence.mode)"][0] // "state_root=absent") + " " + ([.data.findings[]? | select(.component == "installed_rules") | "installed_rules=\(.status)"][0] // "installed_rules=absent")' ;;
    doctor) envelope_verdict "$out" "$DOCTOR_FILTER" ;;
    doctor_after_repair) envelope_verdict "$out" '"ok=\(.ok) " + ([.data.findings[]? | select(.component == "state_root") | "state_root=\(.status)"][0] // "state_root=absent")' ;;
    repair_state_plan|repair_state_apply) envelope_verdict "$out" '"action=\(.data.action) scope=\(.data.scope) previous_mode=\(.data.previous_mode) changes=\(.data.changes)"' ;;
    legacy_state_after_repair|background_writer) head -n 1 "$out" ;;
    test) envelope_verdict "$out" '"ok=\(.ok) status=\(.data.test.status) exit=\(.data.test.exitCode) failures=[\(.data.test.failures // [] | join("; "))]"' ;;
    test_full) envelope_verdict "$out" '"ok=\(.ok) status=\(.data.test.status) exit=\(.data.test.exitCode) failures=[\(.data.test.failures // [] | join("; "))] home=\(if .data.test.snapshots.home.unchanged then "unchanged" else "changed" end),\(if .data.test.snapshots.home.complete then "complete" else "incomplete" end)"' ;;
    update_apply) envelope_verdict "$out" '"ok=\(.ok) action=\(.data.action) postcheck=\(.data.postcheck) active=\(.data.active_version) reason=\(.data.reason)"' ;;
    audit) envelope_verdict "$out" '"ok=\(.ok) latest_update_receipt=\([.data.receipts[]? | select(.kind == "update")] | if length > 0 then (sort_by(.recordedAt) | last | .status) else "none" end)"' ;;
    *) echo "no-verdict-rule" ;;
  esac
}

# ticks_ok VERDICT: background_writer's expected "ticks>=10" is a threshold, not a literal.
normalize() {
  case "$1" in
    background_writer) printf '%s\n' "$2" | awk '{ split($2, t, "="); if (t[2] + 0 >= 10) $2 = "ticks>=10"; print }' ;;
    *) printf '%s\n' "$2" ;;
  esac
}

# step NAME CMD...: run, capture, derive verdict, compare, append the JSONL line. Returns 1 on mismatch.
step() {
  name=$1
  shift
  STEP_NO=$((STEP_NO + 1))
  base=$(printf '%s/%02d-%s' "$LOG" "$STEP_NO" "$name")
  t0=$(date +%s)
  "$@" > "$base.out" 2> "$base.err"
  rc=$?
  seconds=$(( $(date +%s) - t0 ))
  observed=$(verdict "$base.out" "$name")
  row=$(printf '%s\n' "$EXPECTED" | awk -F '|' -v s="$name" '$1 == s { print; exit }')
  want_rc=$(printf '%s' "$row" | cut -d '|' -f 2)
  want=$(printf '%s' "$row" | cut -d '|' -f 3-)
  match=false
  if [ -n "$row" ] && [ "$rc" = "$want_rc" ] && [ "$(normalize "$name" "$observed")" = "$want" ]; then match=true; fi
  # argv as a JSON array without jq --args (argv itself carries options such as --json); kit_env is elided.
  [ "$1" = kit_env ] && shift
  argv=$(for arg in "$@"; do jq -n --arg a "$arg" '$a'; done | jq -cs .)
  jq -cn --arg step "$name" --argjson argv "$argv" --argjson rc "$rc" --argjson seconds "$seconds" --arg verdict "$observed" \
    --arg artifact "$base.out" --arg want_rc "$want_rc" --arg want "$want" --argjson match "$match" \
    '{step: $step, argv: $argv, rc: $rc, seconds: $seconds, verdict: $verdict, artifact: $artifact,
      expected_rc: ($want_rc | tonumber? // null), expected_verdict: $want, match: $match}' >> "$JSONL"
  if [ "$match" = true ]; then
    echo "ok       $name rc=$rc ${seconds}s :: $observed"
    return 0
  fi
  MISMATCHES=$((MISMATCHES + 1))
  {
    echo "MISMATCH $name (${seconds}s; stdout $base.out, stderr $base.err)"
    echo "  expected: rc=$want_rc verdict=$want"
    echo "  observed: rc=$rc verdict=$observed"
  } >&2
  return 1
}

finish() {
  steps=$(wc -l < "$JSONL" | tr -d ' ')
  echo "journey: $steps steps, $MISMATCHES mismatch(es); log $JSONL"
  [ "$MISMATCHES" -eq 0 ] && [ "${1:-}" != abort ] && exit 0
  exit 1
}

echo "journey: previous=$PREV candidate=$CAND home=$FIXTURE_HOME"
step fixture build_fixture || { echo "journey: ABORT: fixture failed; nothing below can run" >&2; finish abort; }
( while :; do date +%s >> "$WRITER_FILE"; sleep 1; done ) &
WRITER_PID=$!
step install_previous kit_env sh "$INSTALLER" --version "$PREV" --index "$PREV_INDEX" --offline "$PREV_ARCHIVE" --prefix "$PREFIX" ||
  { echo "journey: ABORT: previous kit is not installed; nothing below can run" >&2; finish abort; }
step version kit_env "$KIT" --version
step status kit_env "$KIT" status --json
step doctor kit_env "$KIT" doctor --json
step repair_state_plan kit_env "$KIT" repair --scope state --plan --json
step repair_state_apply kit_env "$KIT" repair --scope state --apply --yes --json
step legacy_state_after_repair check_legacy_state
step doctor_after_repair kit_env "$KIT" doctor --json
step test kit_env "$KIT" test --json
step test_full kit_env "$KIT" test --full --json
step update_apply kit_env "$KIT" update --apply --yes --version "$CAND" --index "$CAND_INDEX" --archive "$CAND_ARCHIVE" --json
step version_after_update kit_env "$KIT" --version
step audit kit_env "$KIT" audit --json
step background_writer check_writer
stop_writer
finish
