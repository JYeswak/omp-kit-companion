#!/bin/sh
# check-claim-discipline.sh: every enforce=yes claim must be backed by proof.
#
# Adapted from the MIT-licensed franken-research starter-kit
# (starter-kit/scripts/check-claim-discipline.sh), with fail-closed fixes.
# Claims file, README, and root are explicit arguments; no private repo is required.
#
# Defects in the zip checker that this port closes (measured 2026-09-23):
# - Column split. The zip translates tabs to \001 and runs `IFS=$SOH read`.
#   Under macOS /bin/sh (bash 3.2.57) that read does not split: the whole row
#   lands in `label`, `enforce` is empty, every enforce=yes row is skipped and
#   the gate reports "0 enforced". This port splits on tab with awk -F '\t',
#   which keeps empty middle columns in place under every shell.
# - A missing claims file exited 0 ("nothing to check"). It exits 1 here.
# - An enforce=yes row whose readme_pattern is absent from the README only
#   warned. It is a FAIL here, and the FAIL names the row label.
# - Relative paths were resolved against the caller cwd / git toplevel. Here a
#   relative claims file, README or proof path is resolved against <root>.
#
# claims.tsv columns (tab-separated, optional header row starting "label"):
#   label  readme_pattern  capability_key  expected_substr  proof_path  enforce  notes
#
# Usage: check-claim-discipline.sh <claims.tsv> <README> <root>
#        check-claim-discipline.sh --parse <claims.tsv> [root]
#            print each data row as label|pattern|capkey|substr|proof|enforce|notes
#            using the same split the gate uses
#        check-claim-discipline.sh --selftest
# Exit 0: every enforced row passed.
# Exit 1: any enforced row failed, the claims file is missing, or the README
#         is non-empty while nothing is enforced.
# Exit 2: usage error.
set -u

case "$0" in
  /*) SELF=$0 ;;
  *)  SELF=$(pwd)/$0 ;;
esac

# The shell running this script. Selftest sub-runs use the same shell, so a
# selftest under /bin/sh never silently exercises bash 5 through the shebang.
self_sh() {
  if [ -n "${KIT_SH:-}" ]; then printf '%s\n' "$KIT_SH"; return; fi
  if [ -n "${BASH:-}" ]; then printf '%s\n' "$BASH"; return; fi
  c=$(ps -p $$ -o comm= 2>/dev/null | sed 's/^-//')
  if [ -n "$c" ] && p=$(command -v "$c" 2>/dev/null) && [ -n "$p" ]; then
    printf '%s\n' "$p"
    return
  fi
  printf '%s\n' /bin/sh
}

resolve() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *)  printf '%s\n' "$2/$1" ;;
  esac
}

# One awk program for both the gate and --parse, so the parse the selftest
# inspects is the parse the gate uses.
run_awk() {
  mode=$1 claims=$2 readme=$3 root=$4 nonempty=$5
  awk -v mode="$mode" -v readme="$readme" -v root="$root" -v nonempty="$nonempty" -F '\t' '
function slurp(path,   line, text, n) {
  text = ""
  n = 0
  while ((getline line < path) > 0) {
    text = (n++ ? text "\n" : "") line
  }
  close(path)
  return text
}
function nonempty_file(path,   line, r) {
  r = (getline line < path)
  close(path)
  return r > 0
}
BEGIN {
  if (mode == "check" && readme != "") body = slurp(readme)
}
{ if (sub(/\r$/, "")) $0 = $0 }
$0 ~ /^#/ || $0 ~ /^[[:space:]]*$/ { next }
$1 == "label" { next }
{
  label = $1; pattern = $2; capkey = $3; needle = $4; proof = $5; enforce = $6; notes = $7
  if (mode == "parse") {
    printf "%s|%s|%s|%s|%s|%s|%s\n", label, pattern, capkey, needle, proof, enforce, notes
    next
  }
  if (label == "") next
  if (enforce != "yes") { skipped++; next }
  enforced++
  if (pattern != "" && index(body, pattern) == 0) {
    printf "FAIL  %s: enforce=yes but readme_pattern was not found in %s: %s\n", label, readme, pattern
    fail++
    next
  }
  if (proof == "") {
    printf "FAIL  %s: proof_path is empty\n", label
    fail++
    next
  }
  p = proof
  if (substr(proof, 1, 1) != "/") p = root "/" proof
  if (!nonempty_file(p)) {
    printf "FAIL  %s: proof artifact missing or empty: %s\n", label, p
    fail++
    next
  }
  if (needle != "" && index(slurp(p), needle) == 0) {
    printf "FAIL  %s: proof %s lacks expected text: %s\n", label, p, needle
    fail++
    next
  }
  printf "PASS  %s -> %s\n", label, p
  pass++
}
END {
  if (mode == "parse") exit 0
  if (enforced == 0 && nonempty == 1) {
    printf "FAIL: no enforce=yes claims while %s is non-empty\n", readme
    fail++
  }
  printf "check-claim-discipline: %d passed, %d failed, %d skipped (%d enforced)\n", pass+0, fail+0, skipped+0, enforced+0
  exit (fail > 0 ? 1 : 0)
}
' "$claims"
}

check() {
  root=$3
  claims=$(resolve "$1" "$root")
  readme=$(resolve "$2" "$root")
  if [ ! -f "$claims" ]; then
    echo "FAIL: claims file not found: $claims"
    return 1
  fi
  if [ -s "$readme" ]; then nonempty=1; else nonempty=0; fi
  run_awk check "$claims" "$readme" "$root" "$nonempty"
}

parse() {
  claims=$(resolve "$1" "${2:-$(pwd)}")
  if [ ! -f "$claims" ]; then
    echo "FAIL: claims file not found: $claims"
    return 1
  fi
  run_awk parse "$claims" "" "" 0
}

# The zip checker's split, verbatim: tabs -> \001, then IFS=$SOH read.
# Prints the enforce field it yields for one TSV line.
zip_parse_enforce() {
  SOH=$(printf '\001')
  # The other columns are deliberately parsed but unused: this tests the zip's split.
  # shellcheck disable=SC2034
  IFS="$SOH" read -r label pattern capkey substr proof enforce notes <<EOF
$(printf '%s' "$1" | tr '\t' '\001')
EOF
  printf '%s\n' "$enforce"
}

selftest() {
  sh_bin=$(self_sh)
  d=$(mktemp -d "${TMPDIR:-/tmp}/kit-claim-selftest.XXXXXX") || {
    echo "SELFTEST_FAIL: cannot make temp dir"
    exit 1
  }
  trap 'rm -rf "$d"' EXIT INT TERM
  run() { "$sh_bin" "$SELF" "$@"; }
  bash_v=${BASH_VERSION:-none}
  echo "selftest shell: $sh_bin (BASH_VERSION=$bash_v)"

  header='label\treadme_pattern\tcapability_key\texpected_substr\tproof_path\tenforce\tnotes\n'
  printf 'hello\n' > "$d/readme.md"
  printf 'new TypeSafeClient\n' > "$d/proof.txt"

  # Arm 1: enforce=yes, readme_pattern absent from README -> RED naming the label.
  printf '%b' "$header" > "$d/bad.tsv"
  printf 'planted-miss\tTHIS PATTERN IS NOT IN THE README\tcap\tnew TypeSafeClient\tproof.txt\tyes\tplant\n' >> "$d/bad.tsv"
  if out=$(run bad.tsv readme.md "$d" 2>&1); then
    echo "SELFTEST_FAIL: planted unmatched enforce=yes row was accepted"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"FAIL  planted-miss"*) ;;
    *) echo "SELFTEST_FAIL: RED did not name planted-miss"; printf '%s\n' "$out"; exit 1 ;;
  esac
  case "$out" in
    *"(0 enforced)"*) echo "SELFTEST_FAIL: blind to the enforce=yes row"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM unmatched-pattern: RED, names planted-miss: $(printf '%s\n' "$out" | grep 'planted-miss')"

  # Arm 2: matching row with an existing proof -> PASS.
  printf '%b' "$header" > "$d/good.tsv"
  printf 'planted-hit\thello\tcap\tnew TypeSafeClient\tproof.txt\tyes\tok\n' >> "$d/good.tsv"
  if ! out=$(run good.tsv readme.md "$d" 2>&1); then
    echo "SELFTEST_FAIL: a matching enforce=yes row did not pass"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"PASS  planted-hit"*"(1 enforced)"*) ;;
    *) echo "SELFTEST_FAIL: matching row not reported as PASS"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM matching-row: PASS: $(printf '%s\n' "$out" | grep 'planted-hit')"

  # Arm 2b: matching row whose proof is missing -> RED naming the label.
  printf '%b' "$header" > "$d/noproof.tsv"
  printf 'planted-noproof\thello\tcap\t\tno-such-proof.txt\tyes\t\n' >> "$d/noproof.tsv"
  if out=$(run noproof.tsv readme.md "$d" 2>&1); then
    echo "SELFTEST_FAIL: enforce=yes row with a missing proof was accepted"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"FAIL  planted-noproof"*"no-such-proof.txt"*) ;;
    *) echo "SELFTEST_FAIL: missing-proof RED did not name the row and path"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM missing-proof: RED, names planted-noproof"

  # Arm 3: missing claims file -> RED, not exit 0, names the resolved path.
  if out=$(run no-such.tsv readme.md "$d" 2>&1); then
    echo "SELFTEST_FAIL: missing claims file exited 0"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"$d/no-such.tsv"*) ;;
    *) echo "SELFTEST_FAIL: missing-file RED did not name the resolved path"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM missing-claims-file: RED: $out"

  # Arm 4: empty middle columns stay in their own fields.
  row=$(printf 'planted-sparse\t\t\t\tproof.txt\tyes\t')
  printf '%b' "$header" > "$d/sparse.tsv"
  printf '%s\n' "$row" >> "$d/sparse.tsv"
  parsed=$(run --parse sparse.tsv "$d" 2>&1)
  if [ "$parsed" != "planted-sparse||||proof.txt|yes|" ]; then
    echo "SELFTEST_FAIL: empty middle columns misparsed: [$parsed]"
    exit 1
  fi
  if ! out=$(run sparse.tsv readme.md "$d" 2>&1); then
    echo "SELFTEST_FAIL: sparse enforce=yes row did not pass"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"PASS  planted-sparse"*"(1 enforced)"*) ;;
    *) echo "SELFTEST_FAIL: sparse row not enforced"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM empty-middle-columns: parsed [$parsed], enforced and PASS"

  # Arm 5: regression. The zip split on the same row, under this shell.
  old=$(zip_parse_enforce "$row")
  new=$(printf '%s\n' "$parsed" | cut -d'|' -f6)
  case "$bash_v" in
    3.*)
      if [ -n "$old" ]; then
        echo "SELFTEST_FAIL: expected the zip split to lose enforce under bash $bash_v, got [$old]"
        exit 1
      fi
      echo "ARM zip-split-regression (required, bash $bash_v): zip logic read enforce=[$old] (empty); this port read enforce=[$new]"
      ;;
    *)
      echo "ARM zip-split-regression (informational, BASH_VERSION=$bash_v): zip logic read enforce=[$old]; this port read enforce=[$new]"
      ;;
  esac

  echo "SELFTEST_PASS: unmatched enforce=yes refused and named, matching row passed, missing proof refused, missing claims file refused, empty middle columns parsed, zip-split regression arm ran"
  exit 0
}

case "${1:-}" in
  --selftest) selftest ;;
  --parse)
    [ $# -ge 2 ] || { echo "usage: $0 --parse <claims.tsv> [root]" >&2; exit 2; }
    shift
    parse "$@"
    exit $?
    ;;
esac

if [ $# -ne 3 ]; then
  echo "usage: $0 <claims.tsv> <README> <root> | --parse <claims.tsv> [root] | --selftest" >&2
  exit 2
fi
check "$1" "$2" "$3"
