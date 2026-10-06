#!/bin/sh
# apply-policy.sh [--dry-run] [--profiles all|p1,p2] [--include-default] [--agent-dir DIR] [--target DIR]
#
# Sets every ttsr.<key> named in policy/ttsr.json (today: enabled, repeatMode, repeatGap,
# contextMode, disabledRules) in each omp profile to the policy value, then reads them back.
#   --profiles all|p1,p2  named profiles under ~/.omp/profiles/*/agent (default all);
#                         if there are none, all targets the default profile instead
#   --include-default     also the default profile when named profiles exist
#   --agent-dir DIR       only the agent dir DIR (PI_CODING_AGENT_DIR=DIR, no --profile);
#                         used to test against a temporary agent dir
#   --target DIR          rule root checked by the re-enable guard (default ~/.agents/rules)
#   --dry-run             report what would change, write nothing
#
# Install precondition (all profiles): every MANIFEST.tsv rule must be in TARGET with its
# manifest sha256 and no retired/*.md name may be in TARGET. Otherwise every profile is REFUSED
# and nothing is written: gap 0 on an out-of-date install re-fires stale rule bodies every turn.
#
# Re-enable guard (per profile): a name the profile disables and the policy does not is only
# cleared when TARGET/<name>.md is gone. Otherwise that profile is REFUSED and left untouched.
#
# omp runs from a fresh temp cwd so no project .omp/config.yml overlays the values read back.
# Exit 1 if any profile is refused or does not resolve to the policy after applying.
set -eu
LC_ALL=C
export LC_ALL
unset PI_CODING_AGENT_DIR OMP_PROFILE PI_PROFILE

ROOT=$(cd "$(dirname "$0")/.." && pwd)
POLICY="$ROOT/policy/ttsr.json"
# Every key in the policy file is enforced; adding a key to the policy cannot be silently skipped.
KEYS=$(jq -r 'keys_unsorted[]' "$POLICY")

dry=0 profiles=all include_default=0 agent_dir='' target="$HOME/.agents/rules"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --profiles) [ $# -ge 2 ] || { echo "apply-policy: --profiles needs a value" >&2; exit 2; }; profiles=$2; shift ;;
    --include-default) include_default=1 ;;
    --agent-dir) [ $# -ge 2 ] || { echo "apply-policy: --agent-dir needs a value" >&2; exit 2; }; agent_dir=$2; shift ;;
    --target) [ $# -ge 2 ] || { echo "apply-policy: --target needs a value" >&2; exit 2; }; target=$2; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "apply-policy: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null || { echo "apply-policy: jq not found" >&2; exit 2; }
command -v omp >/dev/null || { echo "apply-policy: omp not found" >&2; exit 2; }
jq -e 'type == "object"' "$POLICY" >/dev/null || { echo "apply-policy: bad $POLICY" >&2; exit 2; }

neutral=$(mktemp -d "${TMPDIR:-/tmp}/omp-kit-policy.XXXXXX")
trap 'rm -rf "$neutral"' EXIT
cd "$neutral"

# Targets: "default", "profile:<name>" or "dir:<path>"
targets=
if [ -n "$agent_dir" ]; then
  targets="dir:$agent_dir"
else
  [ "$include_default" = 1 ] && targets="default"
  if [ "$profiles" = all ]; then
    for d in "$HOME"/.omp/profiles/*/agent; do
      [ -d "$d" ] || continue
      targets="$targets profile:$(basename "$(dirname "$d")")"
    done
    # Preserve named-profile-only behavior where named profiles exist; stock omp has only default.
    [ -n "$targets" ] || targets=default
  else
    for p in $(printf '%s' "$profiles" | tr ',' ' '); do
      [ -d "$HOME/.omp/profiles/$p/agent" ] || { echo "apply-policy: no profile $p (~/.omp/profiles/$p/agent)" >&2; exit 2; }
      targets="$targets profile:$p"
    done
  fi
fi
[ -n "$targets" ] || { echo "apply-policy: no targets" >&2; exit 2; }

# Install precondition, checked before any profile is read or written.
MANIFEST="$ROOT/MANIFEST.tsv"
[ -f "$MANIFEST" ] || { echo "REFUSED: $MANIFEST missing; run scripts/build-manifest.sh" >&2; exit 1; }
drifted=0 retired_present=0
# Manifest names and SHA-256 values cannot contain whitespace; word splitting is intentional.
# shellcheck disable=SC2013
for row in $(awk -F'\t' 'NR > 1 { print $1 "|" $2 }' "$MANIFEST"); do
  n=${row%%|*} want=${row#*|}
  have=$(shasum -a 256 "$target/$n.md" 2>/dev/null | cut -d' ' -f1)
  if [ "$have" != "$want" ]; then
    drifted=$((drifted + 1))
    echo "  drifted: $n.md (${have:-missing})" >&2
  fi
done
for f in "$ROOT"/retired/*.md; do
  [ -f "$f" ] || continue
  if [ -e "$target/$(basename "$f")" ]; then
    retired_present=$((retired_present + 1))
    echo "  retired present: $(basename "$f")" >&2
  fi
done
if [ "$drifted" != 0 ] || [ "$retired_present" != 0 ]; then
  echo "REFUSED: target $target does not match MANIFEST.tsv ($drifted drifted, $retired_present retired present); run install.sh first" >&2
  exit 1
fi
echo "precondition: target $target matches MANIFEST.tsv ($(awk 'NR > 1' "$MANIFEST" | grep -c .) rules), no retired rules present"

run_omp() { # target args...
  t=$1; shift
  case "$t" in
    default) omp "$@" ;;
    profile:*) omp --profile "${t#profile:}" "$@" ;;
    dir:*) PI_CODING_AGENT_DIR="${t#dir:}" omp "$@" ;;
  esac
}
get() { run_omp "$1" config get "ttsr.$2" --json | jq -c '.value'; }

bad=0
for t in $targets; do
  # Re-enable guard: every name leaving disabledRules must have no rule file in the target.
  # Fails closed: an unreadable disabledRules refuses the profile rather than clearing blind.
  have_dis=$(get "$t" disabledRules 2>/dev/null || true)
  refused=0
  if ! printf '%s' "$have_dis" | jq -e 'type == "array" or . == null' >/dev/null 2>&1; then
    echo "REFUSED: $t: cannot read ttsr.disabledRules (got '$have_dis')" >&2
    refused=1
    leaving=
  else
    leaving=$(jq -rn --argjson have "$have_dis" --slurpfile pol "$POLICY" \
      '($have // []) - ($pol[0].disabledRules // []) | .[]')
  fi
  for n in $leaving; do
    if [ -e "$target/$n.md" ]; then
      echo "REFUSED: $t would re-enable $n: $target/$n.md still present; run install.sh first" >&2
      refused=1
    fi
  done
  if [ "$refused" = 1 ]; then
    bad=1
    echo "$t: refused, nothing changed for this profile" >&2
    continue
  fi
  for k in $KEYS; do
    want=$(jq -c --arg k "$k" '.[$k]' "$POLICY")
    have=$(get "$t" "$k" 2>/dev/null || echo '<error>')
    if [ "$have" = "$want" ]; then
      echo "$t ttsr.$k = $have (ok)"
      continue
    fi
    if [ "$dry" = 1 ]; then
      echo "[dry-run] $t ttsr.$k: $have -> $want"
      continue
    fi
    # Strings go bare (enum); numbers, booleans and arrays go as their JSON text.
    val=$(jq -r --arg k "$k" '.[$k] | if type == "string" then . else tojson end' "$POLICY")
    run_omp "$t" config set "ttsr.$k" "$val" >/dev/null
    now=$(get "$t" "$k" 2>/dev/null || echo '<error>')
    if [ "$now" = "$want" ]; then
      echo "$t ttsr.$k: $have -> $now (set)"
    else
      echo "$t ttsr.$k: FAILED: set $want, reads back $now" >&2
      bad=1
    fi
  done
done
[ "$dry" = 1 ] && echo "apply-policy: dry run, nothing written"
exit "$bad"
