#!/bin/sh
# build-manifest.sh [--check|--stdout]
#
# Writes MANIFEST.tsv from rules/*.md: name, sha256, class, pack.
#   class  from omp's own parse of each rule (scripts/rule-class.ts, README contract):
#            canary   zz-canary-scope-probe
#            router   rs-unsafe-added-router
#            always   alwaysApply true and no condition, astCondition or question
#            reminder interruptMode never
#            tripwire everything else (interruptMode always, tool-only, prose-only, unset)
#   pack   short git SHA of HEAD when a commit exists, else uncommitted-<UTC date>.
#
# --check  exit 1 unless MANIFEST.tsv matches rules/ on name, sha256 and class.
#          The pack column is ignored because it describes provenance, not rule identity.
# --stdout write the generated TSV to stdout without touching MANIFEST.tsv (packaging).
set -eu
LC_ALL=C
export LC_ALL

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$ROOT/MANIFEST.tsv"

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

work_dir=$("$OMP_KIT_BUN" --workdir) || { work_rc=$?; echo "build-manifest: private workdir producer_rc=$work_rc" >&2; exit "$work_rc"; }
[ -n "$work_dir" ] || { echo "build-manifest: empty private workdir" >&2; exit 2; }
tmp="$work_dir/manifest.tsv"
cleanup() {
  rm -f "$tmp" "$tmp.have" "$tmp.want"
  rmdir "$work_dir" 2>/dev/null || true
}
trap cleanup EXIT

printf 'name\tsha256\tclass\tpack\n' > "$tmp"
found=0
for f in "$ROOT"/rules/*.md; do if [ -f "$f" ]; then found=1; fi; done
[ "$found" = 1 ] || { echo "build-manifest: no rules in $ROOT/rules" >&2; exit 1; }
# One process for every rule: name TAB class, from the rule object omp itself builds.
classify_rules() {
  if [ "$stdout" = 1 ]; then
    command -v bun >/dev/null 2>&1 || { echo "build-manifest --stdout: Bun is required" >&2; return 127; }
    bun run --no-env-file --config=/dev/null "$ROOT/scripts/rule-class.ts" "$@"
  else
    "$OMP_KIT_BUN" "$ROOT/scripts/rule-class.ts" "$@"
  fi
}

if classes=$(classify_rules "$ROOT"/rules/*.md); then
  :
else
  class_rc=$?
  echo "build-manifest: scripts/rule-class.ts producer_rc=$class_rc" >&2
  exit "$class_rc"
fi
for f in "$ROOT"/rules/*.md; do
  name=$(basename "$f" .md)
  class=$(printf '%s\n' "$classes" | awk -F '\t' -v n="$name" '$1 == n { print $2 }')
  case "$class" in
    always|tripwire|reminder|canary|router) ;;
    *) echo "build-manifest: no class for $name (got '$class')" >&2; exit 1 ;;
  esac
  printf '%s\t%s\t%s\t%s\n' "$name" "$(sha256 "$f")" "$class" "$pack" >> "$tmp"
done

if [ "$check" = 1 ]; then
  if [ ! -f "$MANIFEST" ]; then
    echo "build-manifest --check: FAIL: $MANIFEST missing" >&2; exit 1
  fi
  want=$(cut -f1-3 "$tmp")
  have=$(cut -f1-3 "$MANIFEST")
  if [ "$want" = "$have" ]; then
    echo "build-manifest --check: OK ($(($(wc -l < "$tmp") - 1)) rules, pack $(sed -n '2p' "$MANIFEST" | cut -f4))"
    exit 0
  fi
  echo "build-manifest --check: FAIL: MANIFEST.tsv does not match rules/ (< manifest, > rules/)" >&2
  printf '%s\n' "$have" > "$tmp.have"
  printf '%s\n' "$want" > "$tmp.want"
  diff "$tmp.have" "$tmp.want" >&2 || true
  rm -f "$tmp.have" "$tmp.want"
  exit 1
fi

if [ "$stdout" = 1 ]; then
  cat "$tmp"
else
  cp "$tmp" "$MANIFEST.tmp.$$"
  mv -f "$MANIFEST.tmp.$$" "$MANIFEST"
  echo "build-manifest: wrote $MANIFEST ($(($(wc -l < "$MANIFEST") - 1)) rules, pack $pack)"
fi
