#!/bin/sh
# build-manifest.sh [--check|--stdout]
#
# Writes MANIFEST.tsv from rules/*.md (default pack) and MANIFEST.fleet.tsv from
# rules-fleet/*.md (opt-in fleet pack): name, sha256, class, pack.
#   class  from omp's own parse of each rule (scripts/rule-class.ts, README contract):
#            canary   zz-canary-scope-probe
#            router   rs-unsafe-added-router
#            always   alwaysApply true and no condition, astCondition or question
#            reminder interruptMode never
#            tripwire everything else (interruptMode always, tool-only, prose-only, unset)
#   pack   short git SHA of HEAD when a commit exists, else uncommitted-<UTC date>.
#
# --check  exit 1 unless each manifest matches its rules dir on name, sha256 and class.
#          The pack column is ignored because it describes provenance, not rule identity.
# --stdout write the default-pack TSV to stdout without touching MANIFEST.tsv (packaging).
set -eu
LC_ALL=C
export LC_ALL

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)

check=0
stdout=0
[ "$#" -le 1 ] || { echo "build-manifest: accepts at most one option" >&2; exit 2; }
case "${1:-}" in
  --check) check=1 ;;
  --stdout) stdout=1 ;;
  '') ;;
  -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
  *) echo "build-manifest: unknown argument: $1" >&2; exit 2 ;;
esac

sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

OMP_KIT_BUN="$ROOT/scripts/runtime-adapter.sh"
[ -x "$OMP_KIT_BUN" ] || { echo "build-manifest: runtime adapter missing: $OMP_KIT_BUN" >&2; exit 2; }
pack=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)
[ -n "$pack" ] || pack="uncommitted-$(date -u +%Y-%m-%d)"

# A source export has src/ but deliberately no .git or compiled bin/omp-kit. It
# is the gate's portable source input, not a release tree: use private local
# scratch and the direct Bun producer instead of asking the packaged runtime
# adapter to find an embedded launcher that the export cannot contain.
source_export=0
if [ ! -e "$ROOT/.git" ] && [ -d "$ROOT/src" ] && [ ! -x "$ROOT/bin/omp-kit" ]; then
  source_export=1
fi
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
if [ "$source_export" = 1 ]; then
  umask 077
  kitlib_tmp work_dir omp-kit-manifest ||
    { echo "build-manifest: cannot create private source-export workdir" >&2; exit 2; }
else
  work_dir=$(OMP_KIT_WORK_OWNER_PID=$$ "$OMP_KIT_BUN" --workdir) ||
    { work_rc=$?; echo "build-manifest: private workdir producer_rc=$work_rc" >&2; exit "$work_rc"; }
fi
[ -n "$work_dir" ] || { echo "build-manifest: empty private workdir" >&2; exit 2; }
tmp="$work_dir/manifest.tsv"
cleanup() {
  rm -f "$tmp" "$tmp.have" "$tmp.want" "$work_dir/.owner"
  rmdir "$work_dir" 2>/dev/null || true
}
kitlib_tmp_atexit cleanup


# One process for every rule: name TAB class, from the rule object omp itself builds.
classify_rules() {
  if [ "$stdout" = 1 ] || [ "$source_export" = 1 ]; then
    command -v bun >/dev/null 2>&1 || { echo "build-manifest: Bun is required for a source export" >&2; return 127; }
    bun run --no-env-file --config=/dev/null "$ROOT/scripts/rule-class.ts" "$@"
  else
    "$OMP_KIT_BUN" "$ROOT/scripts/rule-class.ts" "$@"
  fi
}

build_one() { # build_one <rulesdir>: write candidate manifest to $tmp
  rulesdir=$1
  printf 'name\tsha256\tclass\tpack\n' > "$tmp"
  found=0
  for f in "$rulesdir"/*.md; do if [ -f "$f" ]; then found=1; fi; done
  [ "$found" = 1 ] || { echo "build-manifest: no rules in $rulesdir" >&2; exit 1; }
  # One process for every rule: name TAB class, from the rule object omp itself builds.
  if classes=$(classify_rules "$rulesdir"/*.md); then
    :
  else
    class_rc=$?
    echo "build-manifest: scripts/rule-class.ts producer_rc=$class_rc" >&2
    exit "$class_rc"
  fi
  for f in "$rulesdir"/*.md; do
    name=$(basename "$f" .md)
    class=$(printf '%s\n' "$classes" | awk -F '\t' -v n="$name" '$1 == n { print $2 }')
    case "$class" in
      always|tripwire|reminder|canary|router) ;;
      *) echo "build-manifest: no class for $name (got '$class')" >&2; exit 1 ;;
    esac
    printf '%s\t%s\t%s\t%s\n' "$name" "$(sha256 "$f")" "$class" "$pack" >> "$tmp"
  done
}

check_one() { # check_one <rulesdir> <manifestfile>
  rulesdir=$1; manifestfile=$2
  build_one "$rulesdir"
  if [ ! -f "$manifestfile" ]; then
    echo "build-manifest --check: FAIL: $manifestfile missing" >&2; exit 1
  fi
  want=$(cut -f1-3 "$tmp")
  have=$(cut -f1-3 "$manifestfile")
  if [ "$want" = "$have" ]; then
    echo "build-manifest --check: OK $manifestfile ($(($(wc -l < "$tmp") - 1)) rules, pack $(sed -n '2p' "$manifestfile" | cut -f4))"
    return 0
  fi
  echo "build-manifest --check: FAIL: $manifestfile does not match $rulesdir (< manifest, > rules dir)" >&2
  printf '%s\n' "$have" > "$tmp.have"
  printf '%s\n' "$want" > "$tmp.want"
  diff "$tmp.have" "$tmp.want" >&2 || true
  rm -f "$tmp.have" "$tmp.want"
  exit 1
}

write_one() { # write_one <rulesdir> <manifestfile>
  rulesdir=$1; manifestfile=$2
  build_one "$rulesdir"
  cp "$tmp" "$manifestfile.tmp.$$"
  mv -f "$manifestfile.tmp.$$" "$manifestfile"
  echo "build-manifest: wrote $manifestfile ($(($(wc -l < "$manifestfile") - 1)) rules, pack $pack)"
}

if [ "$check" = 1 ]; then
  check_one "$ROOT/rules" "$ROOT/MANIFEST.tsv"
  check_one "$ROOT/rules-fleet" "$ROOT/MANIFEST.fleet.tsv"
  exit 0
fi

if [ "$stdout" = 1 ]; then
  build_one "$ROOT/rules"
  cat "$tmp"
else
  write_one "$ROOT/rules" "$ROOT/MANIFEST.tsv"
  write_one "$ROOT/rules-fleet" "$ROOT/MANIFEST.fleet.tsv"
fi
