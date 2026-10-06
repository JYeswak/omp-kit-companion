#!/bin/sh
# doctor.sh [--target DIR] [--dev-root DIR]
#
# Does not write rules or config directly. omp CLI reads used here may migrate settings;
# back up profiles before running on an existing HOME. Exit 1 if any check is RED.
#   1 manifest     target rule root equals MANIFEST.tsv by sha256 (and MANIFEST matches rules/)
#   2 retired      no retired/*.md name is present in the target
#   3 unmanaged    no unmanaged *.md in the target
#   4 policy       each profile resolves every ttsr.<key> in policy/ttsr.json to the policy value
#   5 loaded       each profile's `omp ttsr list` (neutral cwd) includes every managed rule with a condition
#   6 shadows      ~/Developer/*/.omp/rules/<managed>.md matches the managed copy (WARN on drift)
#   7 router       jsm knows rust-unsafe-code-exorcist and rust-undefined-behavior-exorcist, and `jsm search miri` returns both
#   8 checkers     checkers/*.sh --selftest passes under /bin/sh
#   9 extensions   each extension in policy/extensions.json is installed in ~/.omp/omp-extensions/ as an
#                  exact copy of extensions/<name> and is in every profile's `extensions` list except
#                  policy skipProfiles
#   --target DIR    rule root (default ~/.agents/rules)
#   --dev-root DIR  where project shadows are looked for (default ~/Developer)
set -u
LC_ALL=C
export LC_ALL
unset PI_CODING_AGENT_DIR OMP_PROFILE PI_PROFILE

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$ROOT/MANIFEST.tsv"
POLICY="$ROOT/policy/ttsr.json"
OMP_KIT_BUN="$ROOT/scripts/runtime-adapter.sh"
[ -x "$OMP_KIT_BUN" ] || { echo "doctor: runtime adapter missing" >&2; exit 2; }
target="$HOME/.agents/rules"
devroot="$HOME/Developer"
ROUTER_SKILLS='rust-unsafe-code-exorcist rust-undefined-behavior-exorcist'

while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || { echo "doctor: --target needs a value" >&2; exit 2; }; target=$2; shift ;;
    --dev-root) [ $# -ge 2 ] || { echo "doctor: --dev-root needs a value" >&2; exit 2; }; devroot=$2; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "doctor: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

reds=0 warns=0
report() { # status check evidence
  printf '%-5s %-10s %s\n' "$1" "$2" "$3"
  case "$1" in RED) reds=$((reds + 1)) ;; WARN) warns=$((warns + 1)) ;; esac
}
detail() { printf '      %s\n' "$*"; }
sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
words() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'; }

WORK_ROOT=$("$OMP_KIT_BUN" --workdir) || { work_rc=$?; echo "doctor: private workdir producer_rc=$work_rc" >&2; exit "$work_rc"; }
neutral="$WORK_ROOT/neutral"
cleanup() { rm -rf "$WORK_ROOT"; }
trap cleanup EXIT
mkdir "$neutral" || { echo "doctor: cannot create private work directory" >&2; exit 1; }
/bin/chmod 700 "$neutral" || { echo "doctor: cannot restrict private work directory" >&2; exit 1; }
cd "$neutral" || exit 1

echo "omp-kit doctor  $(date -u +%Y-%m-%dT%H:%M:%SZ)  $(omp --version 2>/dev/null || echo 'omp: not found')"
echo "kit $ROOT  target $target  cwd $neutral"

if [ ! -f "$MANIFEST" ]; then
  report RED manifest "MANIFEST.tsv missing; run scripts/build-manifest.sh"
  exit 1
fi
managed=$(awk -F'\t' 'NR > 1 { print $1 "\t" $2 "\t" $3 }' "$MANIFEST")
names=$(printf '%s\n' "$managed" | cut -f1)
total=$(printf '%s\n' "$names" | grep -c .)

# ---- 1 manifest ----
missing='' differ='' ok=0
for n in $names; do
  want=$(printf '%s\n' "$managed" | awk -F'\t' -v n="$n" '$1 == n { print $2 }')
  if [ ! -f "$target/$n.md" ]; then missing="$missing $n"
  elif [ "$(sha256 "$target/$n.md")" != "$want" ]; then differ="$differ $n"
  else ok=$((ok + 1)); fi
done
src=$(sh "$ROOT/scripts/build-manifest.sh" --check 2>&1); src_rc=$?
if [ "$ok" = "$total" ] && [ "$src_rc" = 0 ]; then
  report GREEN manifest "$ok/$total managed rules in target match MANIFEST.tsv sha256; MANIFEST matches rules/"
else
  report RED manifest "$ok/$total match; missing:${missing:- none}; sha256 differs:${differ:- none}"
  [ "$src_rc" = 0 ] || detail "MANIFEST.tsv is stale against rules/ (build-manifest.sh --check failed)"
fi

# ---- 2 retired ----
present=
for f in "$ROOT"/retired/*.md; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  [ -e "$target/$b" ] && present="$present $b"
done
nret=0
for f in "$ROOT"/retired/*.md; do [ -f "$f" ] && nret=$((nret + 1)); done
if [ -z "$present" ]; then
  report GREEN retired "none of $nret retired rules present in target"
else
  report RED retired "retired rules still in target:$present"
fi

# ---- 3 unmanaged ----
stray=
if [ -d "$target" ]; then
  for f in "$target"/*.md "$target"/.[!.]*.md; do
    [ -e "$f" ] || continue
    b=$(basename "$f"); n=${b%.md}
    printf '%s\n' "$names" | grep -qxF "$n" && continue
    [ -f "$ROOT/retired/$b" ] && continue   # reported by check 2
    stray="$stray $b"
  done
fi
if [ -z "$stray" ]; then
  report GREEN unmanaged "no unmanaged *.md in target"
else
  report RED unmanaged "unmanaged *.md in target (loaded as rules):$stray"
fi

# ---- profiles ----
# `omp --profile X` (and omp's settings loader) creates ~/.omp/profiles/X when it is missing, so a
# read-only doctor re-lists profiles per check and never calls omp for one that is gone: a profile
# removed mid-run is skipped, not recreated (measured 2026-09-24: a doctor run rebuilt a trashed one).
live_profiles() {
  printf 'default'
  for d in "$HOME"/.omp/profiles/*/agent; do
    [ -d "$d" ] && printf ' %s' "$(basename "$(dirname "$d")")"
  done
}
profile_exists() { [ "$1" = default ] || [ -d "$HOME/.omp/profiles/$1/agent" ]; }
run_omp() { p=$1; shift; profile_exists "$p" || return 1; if [ "$p" = default ]; then omp "$@"; else omp --profile "$p" "$@"; fi; }

# ---- 4 policy ----
for p in $(live_profiles); do
  drift='' dis=''
  for k in $(jq -r 'keys_unsorted[]' "$POLICY"); do
    want=$(jq -c --arg k "$k" '.[$k]' "$POLICY")
    have=$(run_omp "$p" config get "ttsr.$k" --json 2>/dev/null | jq -c '.value' 2>/dev/null)
    [ -n "$have" ] || have='<error>'
    [ "$have" = "$want" ] || drift="$drift $k=$have(want $want)"
    [ "$k" = disabledRules ] && dis=$have
  done
  if [ -z "$drift" ]; then
    report GREEN policy "$p: ttsr resolves to policy $(jq -c . "$POLICY")"
  else
    report RED policy "$p:$drift"
  fi
  # Hints for names the profile disables beyond the policy (apply-policy.sh's re-enable guard).
  extra=$(jq -rn --argjson have "$dis" --slurpfile pol "$POLICY" \
    '($have // []) - ($pol[0].disabledRules // []) | .[]' 2>/dev/null || true)
  for n in $extra; do
    if [ -e "$target/$n.md" ]; then
      detail "$p: disables $n and $target/$n.md is present: clearing re-enables it; run install.sh first"
    else
      detail "$p: disables $n and $target/$n.md is gone: stale disable, safe to clear"
    fi
  done
done

# ---- 5 loaded ----
expect=$(printf '%s\n' "$managed" | awk -F'\t' '$3 != "always" { print $1 }')
nexp=$(printf '%s\n' "$expect" | grep -c .)
for p in $(live_profiles); do
  listed=$(run_omp "$p" ttsr list --json 2>/dev/null | jq -r '.[] | "\(.name)\t\(.provider)"' 2>/dev/null)
  if [ -z "$listed" ]; then
    report RED loaded "$p: omp ttsr list --json returned nothing"
    continue
  fi
  miss='' foreign=''
  for n in $expect; do
    prov=$(printf '%s\n' "$listed" | awk -F'\t' -v n="$n" '$1 == n { print $2; exit }')
    if [ -z "$prov" ]; then miss="$miss $n"
    elif [ "$prov" != agents ]; then foreign="$foreign ${n}[$prov]"; fi
  done
  if [ -n "$miss" ]; then
    report RED loaded "$p: $((nexp - $(printf '%s\n' "$miss" | wc -w))) of $nexp conditioned managed rules listed; missing:$miss"
  elif [ -n "$foreign" ]; then
    report WARN loaded "$p: all $nexp listed, some from another provider:$foreign"
  else
    report GREEN loaded "$p: all $nexp conditioned managed rules listed (provider agents)"
  fi
done

# ---- 6 shadows ----
nshadow=0 ndrift=0
shadow_lines=
for f in "$devroot"/*/.omp/rules/*.md; do
  [ -f "$f" ] || continue
  n=$(basename "$f" .md)
  printf '%s\n' "$names" | grep -qxF "$n" || continue
  nshadow=$((nshadow + 1))
  want=$(printf '%s\n' "$managed" | awk -F'\t' -v n="$n" '$1 == n { print $2 }')
  if [ "$(sha256 "$f")" = "$want" ]; then
    shadow_lines="${shadow_lines}match  $f
"
  else
    ndrift=$((ndrift + 1))
    shadow_lines="${shadow_lines}DRIFT  $f (project copy wins in its repo)
"
  fi
done
if [ "$nshadow" = 0 ]; then
  report GREEN shadows "no project .omp/rules/ copy of a managed rule under $devroot"
elif [ "$ndrift" = 0 ]; then
  report GREEN shadows "$nshadow project copies of managed rules, all identical"
else
  report WARN shadows "$ndrift of $nshadow project copies of managed rules drift from the managed copy"
fi
printf '%s' "$shadow_lines" | while IFS= read -r l; do detail "$l"; done

# ---- 7 router ----
if ! command -v jsm >/dev/null; then
  report RED router "jsm not found"
else
  inst=$(jsm list --json 2>/dev/null | jq -r '.skills[]?.name' 2>/dev/null)
  found=$(jsm search miri --json 2>/dev/null | jq -r '.skills[]?.name' 2>/dev/null)
  notinst='' notfound=''
  for s in $ROUTER_SKILLS; do
    printf '%s\n' "$inst" | grep -qxF "$s" || notinst="$notinst $s"
    printf '%s\n' "$found" | grep -qxF "$s" || notfound="$notfound $s"
  done
  if [ -z "$notinst$notfound" ]; then
    report GREEN router "jsm list has both router skills; jsm search miri returns both ($(words "$found" | cut -c1-120))"
  else
    report RED router "not in jsm list:${notinst:- none}; not returned by jsm search miri:${notfound:- none}"
  fi
fi

# ---- 8 checkers ----
ran=0
for c in check-claim-discipline.sh check-readiness.sh; do
  f="$ROOT/checkers/$c"
  [ -f "$f" ] || { detail "$c: absent"; continue; }
  ran=$((ran + 1))
  out=$(/bin/sh "$f" --selftest 2>&1); rc=$?
  last=$(printf '%s\n' "$out" | grep . | tail -n 1)
  if [ "$rc" = 0 ]; then
    report GREEN checkers "$c --selftest under /bin/sh exit 0: $last"
  else
    report RED checkers "$c --selftest under /bin/sh exit $rc: $last"
  fi
done
[ "$ran" = 0 ] && report WARN checkers "no checkers present in $ROOT/checkers; skipped"

# ---- 9 extensions ----
EXTPOL="$ROOT/policy/extensions.json"
skip=$(jq -r '.skipProfiles[]' "$EXTPOL" 2>/dev/null | tr '\n' ' ')
for name in $(jq -r '.extensions[]' "$EXTPOL" 2>/dev/null); do
  src="$ROOT/extensions/$name"
  dst="$HOME/.omp/omp-extensions/$name"
  if [ ! -f "$dst" ]; then
    report RED extensions "$name: not installed at $dst; run scripts/install-extensions.sh"
    continue
  fi
  if ! cmp -s "$src" "$dst"; then
    report RED extensions "$name: $dst differs from $src; run scripts/install-extensions.sh"
    continue
  fi
  missing=
  for p in $(live_profiles); do
    case " $skip " in *" $p "*) continue ;; esac
    run_omp "$p" config get extensions --json < /dev/null 2>/dev/null \
      | jq -e --arg d "$dst" '(.value // []) | index($d) != null' > /dev/null || missing="$missing $p"
  done
  if [ -z "$missing" ]; then
    report GREEN extensions "$name: installed copy matches the kit; listed by every profile${skip:+ except$(printf ' %s' "$skip")}"
  else
    report RED extensions "$name: missing from the extensions list of:$missing; run scripts/install-extensions.sh"
  fi
done

echo "doctor: $reds RED, $warns WARN"
[ "$reds" = 0 ]
