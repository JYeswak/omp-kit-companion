#!/bin/sh
# shellcheck disable=SC2317,SC2329 # step functions (build_fixture, kit_env, ...) run indirectly via step "$@" (0.9 says SC2317, 0.10+ SC2329).
# Real-HOME journey: the README path (install -> status -> doctor -> state-root repair -> test ->
# test --full -> update --apply -> audit) against a realistic HOME instead of a tiny synthetic one.
#
# Usage:
#   sh tests/e2e/real-home-journey.sh \
#     --candidate-archive ABS --candidate-index ABS \
#     --previous-archive ABS --previous-index ABS --work-dir ABS
# Post-sign mode (all five additional flags are required together):
#     --platform INDEX_ASSET_KEY --source-sha SIGNED_SOURCE_SHA --run-id SIGN_RUN_ID \
#     --run-attempt SIGN_RUN_ATTEMPT --receipt-out ABS/signed-consumer-PLATFORM-attempt-N/receipt.json
# Signed metadata env equivalents: JOURNEY_PLATFORM, JOURNEY_SOURCE_SHA, JOURNEY_RUN_ID,
# JOURNEY_RUN_ATTEMPT, JOURNEY_RECEIPT_OUT.
# Existing flags may instead come from the matching JOURNEY_* environment variables; every path is absolute.
# The archives/indexes use the installer index schema and their exact signed bytes; each archive must
# have its sibling .sigstore.json bundle. Versions come from the index files. In signed mode, the
# previous must be a published stable release; no receipt is emitted unless the public installer and
# compiled candidate update both pass. The work dir is created if absent; WORK/home must not exist yet.
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
background_writer|0|alive=yes ticks>=10
no_leaked_processes|0|leaked=none'

usage() {
  sed -n '/^# Usage:/,/^#$/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

CAND_ARCHIVE=${JOURNEY_CANDIDATE_ARCHIVE:-}
CAND_INDEX=${JOURNEY_CANDIDATE_INDEX:-}
PREV_ARCHIVE=${JOURNEY_PREVIOUS_ARCHIVE:-}
PREV_INDEX=${JOURNEY_PREVIOUS_INDEX:-}
WORK=${JOURNEY_WORK_DIR:-}
RECEIPT_OUT=${JOURNEY_RECEIPT_OUT:-}
PLATFORM=${JOURNEY_PLATFORM:-}
SOURCE_SHA=${JOURNEY_SOURCE_SHA:-}
RUN_ID=${JOURNEY_RUN_ID:-}
RUN_ATTEMPT=${JOURNEY_RUN_ATTEMPT:-}
SIGNED_MODE=0
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --candidate-archive) CAND_ARCHIVE=$2 ;;
    --candidate-index) CAND_INDEX=$2 ;;
    --previous-archive) PREV_ARCHIVE=$2 ;;
    --previous-index) PREV_INDEX=$2 ;;
    --work-dir) WORK=$2 ;;
    --receipt-out) RECEIPT_OUT=$2 ;;
    --platform) PLATFORM=$2 ;;
    --source-sha) SOURCE_SHA=$2 ;;
    --run-id) RUN_ID=$2 ;;
    --run-attempt) RUN_ATTEMPT=$2 ;;
    *) usage ;;
  esac
  shift 2
done
signed_fields=0
for value in "$RECEIPT_OUT" "$PLATFORM" "$SOURCE_SHA" "$RUN_ID" "$RUN_ATTEMPT"; do
  [ -z "$value" ] || signed_fields=$((signed_fields + 1))
done
if [ "$signed_fields" -ne 0 ]; then
  [ "$signed_fields" -eq 5 ] || usage
  SIGNED_MODE=1
fi

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
if [ "$SIGNED_MODE" -eq 1 ]; then
  case "$RECEIPT_OUT" in /*) ;; *) echo "journey: --receipt-out must be absolute" >&2; usage ;; esac
  [ "$(basename "$RECEIPT_OUT")" = receipt.json ] || { echo "journey: --receipt-out must end in receipt.json" >&2; usage; }
  case "$PLATFORM" in ''|*[!A-Za-z0-9._-]*) echo "journey: --platform must be an index asset key" >&2; usage ;; esac
  expected_receipt_dir="signed-consumer-$PLATFORM-attempt-$RUN_ATTEMPT"
  [ "$(basename "$(dirname "$RECEIPT_OUT")")" = "$expected_receipt_dir" ] || {
    echo "journey: signed receipt directory must be $expected_receipt_dir" >&2; usage;
  }
  [ ! -e "$RECEIPT_OUT" ] && [ ! -L "$RECEIPT_OUT" ] || { echo "journey: receipt path already exists" >&2; exit 2; }
  case "$SOURCE_SHA" in *[!0123456789abcdef]*) echo "journey: --source-sha must be lowercase hexadecimal" >&2; usage ;; esac
  case "${#SOURCE_SHA}" in 40|64) ;; *) echo "journey: --source-sha must be a Git object hash" >&2; usage ;; esac
  case "$RUN_ATTEMPT" in ''|*[!0123456789]*) echo "journey: --run-attempt must be a positive integer" >&2; usage ;; esac
  [ "$RUN_ATTEMPT" -gt 0 ] || { echo "journey: --run-attempt must be a positive integer" >&2; usage; }
  for index in "$PREV_INDEX" "$CAND_INDEX"; do
    [ -f "$index" ] && [ ! -L "$index" ] || { echo "journey: signed index must be a regular file: $index" >&2; exit 2; }
  done
  command -v gh >/dev/null 2>&1 || { echo "journey: gh is required for signed consumer verification" >&2; exit 2; }
  command -v shasum >/dev/null 2>&1 || { echo "journey: shasum is required for signed consumer receipts" >&2; exit 2; }
  for archive in "$PREV_ARCHIVE" "$CAND_ARCHIVE"; do
    [ -f "$archive" ] && [ ! -L "$archive" ] || { echo "journey: signed archive must be a regular file: $archive" >&2; exit 2; }
    bundle="$archive.sigstore.json"
    [ -f "$bundle" ] && [ ! -L "$bundle" ] || { echo "journey: signed archive bundle is missing or unsafe: $bundle" >&2; exit 2; }
  done
  jq -e --arg platform "$PLATFORM" '.assets | has($platform)' "$PREV_INDEX" >/dev/null ||
    { echo "journey: previous index has no asset for platform $PLATFORM" >&2; exit 2; }
  jq -e --arg platform "$PLATFORM" '.assets | has($platform)' "$CAND_INDEX" >/dev/null ||
    { echo "journey: candidate index has no asset for platform $PLATFORM" >&2; exit 2; }
fi

FIXTURE_HOME="$WORK/home"
[ ! -e "$FIXTURE_HOME" ] || { echo "journey: $FIXTURE_HOME already exists; use a fresh work dir" >&2; exit 2; }
LOG="$WORK/log"
JSONL="$LOG/steps.jsonl"
mkdir -p "$LOG" "$WORK/tmp" "$WORK/release" || exit 2
: > "$JSONL" || exit 2
EXPECTED=$(printf '%s\n' "$EXPECTED" | sed -e "s/@PREV@/$PREV/g" -e "s/@CAND@/$CAND/g")
PREFIX="$FIXTURE_HOME/.local/opt/omp-kit"
KIT="$PREFIX/bin/omp-kit"
CAND_PREFIX="$FIXTURE_HOME/.local/opt/omp-kit-candidate"
CAND_KIT="$CAND_PREFIX/bin/omp-kit"
if [ "$SIGNED_MODE" -eq 1 ]; then
  EXPECTED=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' "$EXPECTED" \
    "signed_inputs|0|inputs=valid" \
    "previous_release|0|published=true stable=true version=$PREV" \
    "verify_previous_signature|0|verified dry-run: version=$PREV platform=$PLATFORM prefix=$PREFIX" \
    "install_candidate_public|0|installed=$CAND" \
    "candidate_public_version|0|omp-kit $CAND" \
    "candidate_source|0|source_sha=$SOURCE_SHA" \
    "signed_receipt|0|receipt=written platform=$PLATFORM version=$CAND previous=$PREV")
fi
STATE_ROOT="$FIXTURE_HOME/.local/state/omp-kit"
WRITER_DIR="$FIXTURE_HOME/Library/Caches/com.example.journey-writer"
WRITER_FILE="$WRITER_DIR/heartbeat.log"
WRITER_PID=''
STEP_NO=0
MISMATCHES=0
SIGNED_INPUTS_OK=0
PREVIOUS_RELEASE_OK=0
PREVIOUS_SIGNATURE_OK=0
CANDIDATE_SOURCE_OK=0
PUBLIC_INSTALLER_OK=0
PREVIOUS_PUBLIC_INSTALL_OK=0
COMPILED_UPGRADE_OK=0

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
check_leaked_processes() {
  # Snapshot first, analyze the file: a concurrent pipeline would list our own analyzer.
  ps -axo pid=,ppid=,etime=,command= > "$WORK/leaked.ps" 2>/dev/null || { echo "leaked=unknown-ps-failed"; return; }
  hit=$(awk -v r="$WORK/" 'index($0, r) { print }' "$WORK/leaked.ps")
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -d cwd -F pn > "$WORK/leaked.lsof" 2>/dev/null
    pid=""
    while IFS= read -r line; do
      case "$line" in p*) pid=${line#p} ;; n"$WORK"/*) hit=$(printf '%s\n%s' "$hit" "$(ps -o pid=,ppid=,etime=,command= -p "$pid" 2>/dev/null)") ;; esac
    done < "$WORK/leaked.lsof"
  fi
  hit=$(printf '%s\n' "$hit" | awk 'NF' | sort -u)
  if [ -z "$hit" ]; then echo "leaked=none"; else printf 'leaked=found\n%s\n' "$hit"; fi
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

sha256_file() {
  checksum_output=$(shasum -a 256 "$1") || return 1
  printf '%s\n' "$checksum_output" | awk 'NR == 1 { print $1 }'
}

capture_signed_inputs() {
  PREV_ARCHIVE_SHA=$(sha256_file "$PREV_ARCHIVE") || return 1
  PREV_INDEX_SHA=$(sha256_file "$PREV_INDEX") || return 1
  PREV_BUNDLE_SHA=$(sha256_file "$PREV_ARCHIVE.sigstore.json") || return 1
  CAND_ARCHIVE_SHA=$(sha256_file "$CAND_ARCHIVE") || return 1
  CAND_INDEX_SHA=$(sha256_file "$CAND_INDEX") || return 1
  CAND_BUNDLE_SHA=$(sha256_file "$CAND_ARCHIVE.sigstore.json") || return 1
  candidate_invocation="https://github.com/JYeswak/omp-kit-companion/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT"
  if ! jq -es --arg invocation "$candidate_invocation" \
    'any(.[]; (.dsseEnvelope.payload | @base64d | fromjson | .predicate.runDetails.metadata.invocationId) == $invocation)' \
    "$CAND_ARCHIVE.sigstore.json" >/dev/null; then
    echo "inputs=candidate-signing-run-mismatch"
    return 1
  fi
  SIGNED_INPUTS_OK=1
  echo "inputs=valid"
}

same_sha256() {
  actual_sha=$(sha256_file "$1") || return 1
  [ "$actual_sha" = "$2" ]
}

write_signed_receipt() {
  [ "$SIGNED_MODE" -eq 1 ] && [ "$SIGNED_INPUTS_OK" -eq 1 ] &&
    [ "$PREVIOUS_RELEASE_OK" -eq 1 ] && [ "$PREVIOUS_SIGNATURE_OK" -eq 1 ] &&
    [ "$CANDIDATE_SOURCE_OK" -eq 1 ] && [ "$PUBLIC_INSTALLER_OK" -eq 1 ] &&
    [ "$COMPILED_UPGRADE_OK" -eq 1 ] || { echo "receipt=precondition-failed"; return 1; }
  if ! same_sha256 "$PREV_ARCHIVE" "$PREV_ARCHIVE_SHA" ||
    ! same_sha256 "$PREV_INDEX" "$PREV_INDEX_SHA" ||
    ! same_sha256 "$PREV_ARCHIVE.sigstore.json" "$PREV_BUNDLE_SHA" ||
    ! same_sha256 "$CAND_ARCHIVE" "$CAND_ARCHIVE_SHA" ||
    ! same_sha256 "$CAND_INDEX" "$CAND_INDEX_SHA" ||
    ! same_sha256 "$CAND_ARCHIVE.sigstore.json" "$CAND_BUNDLE_SHA"; then
    echo "receipt=input-mutated"
    return 1
  fi
  receipt_dir=$(dirname "$RECEIPT_OUT")
  mkdir -p "$receipt_dir" || return 1
  [ ! -e "$RECEIPT_OUT" ] && [ ! -L "$RECEIPT_OUT" ] || { echo "receipt=already-exists"; return 1; }
  receipt_tmp="$receipt_dir/.receipt.json.$$"
  [ ! -e "$receipt_tmp" ] && [ ! -L "$receipt_tmp" ] || { echo "receipt=temp-exists"; return 1; }
  jq -n --arg platform "$PLATFORM" --arg version "$CAND" --arg source_sha "$SOURCE_SHA" \
    --arg archive_sha256 "$CAND_ARCHIVE_SHA" --arg index_sha256 "$CAND_INDEX_SHA" \
    --arg run_id "$RUN_ID" --argjson run_attempt "$RUN_ATTEMPT" --arg previous_version "$PREV" \
    '{schema_version:1, kind:"signed-native-consumer", platform:$platform, version:$version,
      source_sha:$source_sha, archive_sha256:$archive_sha256, index_sha256:$index_sha256,
      run_id:$run_id, run_attempt:$run_attempt, previous_version:$previous_version,
      installed_version:$version, checks:{public_installer:true, compiled_upgrade:true}}' > "$receipt_tmp" || {
      rm -f "$receipt_tmp"
      return 1
    }
  chmod 600 "$receipt_tmp" || { rm -f "$receipt_tmp"; return 1; }
  ln "$receipt_tmp" "$RECEIPT_OUT" || { rm -f "$receipt_tmp"; return 1; }
  rm "$receipt_tmp" || return 1
  echo "receipt=written platform=$PLATFORM version=$CAND previous=$PREV"
}

previous_release_verdict() {
  if jq -e --arg tag "v$PREV" \
    '.tagName == $tag and .isDraft == false and .isPrerelease == false' "$1" >/dev/null 2>&1; then
    echo "published=true stable=true version=$PREV"
  else
    echo "published=false stable=false"
  fi
}

verdict() {
  out=$1
  case "$2" in
    fixture) cat "$WORK/fixture.verdict" 2>/dev/null || echo "fixture-incomplete" ;;
    signed_inputs) head -n 1 "$out" ;;
    previous_release) previous_release_verdict "$out" ;;
    verify_previous_signature) head -n 1 "$out" ;;
    candidate_source)
      source_sha_value=$(head -n 1 "$out")
      [ "$source_sha_value" = "$SOURCE_SHA" ] && echo "source_sha=$source_sha_value" || echo "source_sha=mismatch" ;;
    signed_receipt)
      jq -e --arg platform "$PLATFORM" --arg version "$CAND" --arg source_sha "$SOURCE_SHA" \
        --arg archive_sha "$CAND_ARCHIVE_SHA" --arg index_sha "$CAND_INDEX_SHA" \
        --arg run_id "$RUN_ID" --argjson run_attempt "$RUN_ATTEMPT" --arg previous "$PREV" \
        '.schema_version == 1 and .kind == "signed-native-consumer" and .platform == $platform and
         .version == $version and .source_sha == $source_sha and .archive_sha256 == $archive_sha and
         .index_sha256 == $index_sha and .run_id == $run_id and .run_attempt == $run_attempt and
         .previous_version == $previous and .installed_version == $version and
         .checks.public_installer == true and .checks.compiled_upgrade == true' "$RECEIPT_OUT" >/dev/null 2>&1 &&
        head -n 1 "$out" || echo "receipt=invalid" ;;
    install_previous|install_candidate_public)
      v=$(sed -n 's/^installed: version=\([^ ]*\).*/\1/p' "$out")
      install_binary=$KIT
      [ "$2" != install_candidate_public ] || install_binary=$CAND_KIT
      [ -x "$install_binary" ] && [ -n "$v" ] && echo "installed=$v" || echo "not-installed" ;;
    version|version_after_update|candidate_public_version) head -n 1 "$out" ;;
    status) envelope_verdict "$out" '"ok=\(.ok) " + ([.data.findings[]? | select(.component == "state_root") | "state_root=\(.status):\(.evidence.mode)"][0] // "state_root=absent") + " " + ([.data.findings[]? | select(.component == "installed_rules") | "installed_rules=\(.status)"][0] // "installed_rules=absent")' ;;
    doctor) envelope_verdict "$out" "$DOCTOR_FILTER" ;;
    doctor_after_repair) envelope_verdict "$out" '"ok=\(.ok) " + ([.data.findings[]? | select(.component == "state_root") | "state_root=\(.status)"][0] // "state_root=absent")' ;;
    repair_state_plan|repair_state_apply) envelope_verdict "$out" '"action=\(.data.action) scope=\(.data.scope) previous_mode=\(.data.previous_mode) changes=\(.data.changes)"' ;;
    legacy_state_after_repair|background_writer|no_leaked_processes) head -n 1 "$out" ;;
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
  if [ "$SIGNED_MODE" -eq 1 ] && [ "$MISMATCHES" -eq 0 ] && [ "${1:-}" != abort ]; then
    step signed_receipt write_signed_receipt || :
  fi
  steps=$(wc -l < "$JSONL" | tr -d ' ')
  echo "journey: $steps steps, $MISMATCHES mismatch(es); log $JSONL"
  [ "$MISMATCHES" -eq 0 ] && [ "${1:-}" != abort ] && exit 0
  exit 1
}

echo "journey: previous=$PREV candidate=$CAND home=$FIXTURE_HOME"
if [ "$SIGNED_MODE" -eq 1 ]; then
  if step signed_inputs capture_signed_inputs; then SIGNED_INPUTS_OK=1; fi
  if step previous_release gh release view "v$PREV" --repo JYeswak/omp-kit-companion --json tagName,isDraft,isPrerelease; then
    PREVIOUS_RELEASE_OK=1
  fi
  if step verify_previous_signature sh "$INSTALLER" --version "$PREV" --index "$PREV_INDEX" \
    --offline "$PREV_ARCHIVE" --prefix "$PREFIX" --dry-run; then
    PREVIOUS_SIGNATURE_OK=1
  fi
fi
step fixture build_fixture || { echo "journey: ABORT: fixture failed; nothing below can run" >&2; finish abort; }
( while :; do date +%s >> "$WRITER_FILE"; sleep 1; done ) &
WRITER_PID=$!
step install_previous kit_env sh "$INSTALLER" --version "$PREV" --index "$PREV_INDEX" --offline "$PREV_ARCHIVE" --prefix "$PREFIX" ||
  { echo "journey: ABORT: previous kit is not installed; nothing below can run" >&2; finish abort; }
PREVIOUS_PUBLIC_INSTALL_OK=1
if [ "$SIGNED_MODE" -eq 1 ]; then
  candidate_public_steps_ok=1
  step install_candidate_public kit_env sh "$INSTALLER" --version "$CAND" --index "$CAND_INDEX" \
    --offline "$CAND_ARCHIVE" --prefix "$CAND_PREFIX" || candidate_public_steps_ok=0
  step candidate_public_version kit_env "$CAND_KIT" --version || candidate_public_steps_ok=0
  if [ "$PREVIOUS_PUBLIC_INSTALL_OK" -eq 1 ] && [ "$candidate_public_steps_ok" -eq 1 ]; then
    PUBLIC_INSTALLER_OK=1
  fi
fi
step version kit_env "$KIT" --version
step status kit_env "$KIT" status --json
step doctor kit_env "$KIT" doctor --json
step repair_state_plan kit_env "$KIT" repair --scope state --plan --json
step repair_state_apply kit_env "$KIT" repair --scope state --apply --yes --json
step legacy_state_after_repair check_legacy_state
step doctor_after_repair kit_env "$KIT" doctor --json
step test kit_env "$KIT" test --json
step test_full kit_env "$KIT" test --full --json
upgrade_steps_ok=1
step update_apply kit_env "$KIT" update --apply --yes --version "$CAND" --index "$CAND_INDEX" --archive "$CAND_ARCHIVE" --json ||
  upgrade_steps_ok=0
step version_after_update kit_env "$KIT" --version || upgrade_steps_ok=0
step audit kit_env "$KIT" audit --json || upgrade_steps_ok=0
[ "$upgrade_steps_ok" -eq 1 ] && COMPILED_UPGRADE_OK=1
  if step candidate_source gh api "repos/JYeswak/omp-kit-companion/commits/v$CAND" --jq .sha; then
    CANDIDATE_SOURCE_OK=1
  fi
step background_writer check_writer
stop_writer
step no_leaked_processes check_leaked_processes
finish
