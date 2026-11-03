#!/bin/sh
# build-manifest-archive.test.sh — source-export manifest control and refusal contract.
# A clean source export has src/ but no .git or embedded bin/omp-kit. Its manifest
# producer must use the direct Bun path, while a stale manifest must still refuse.
set -eu
printenv TMPDIR >/dev/null || { printf 'TMPDIR: set a private test scratch directory\n' >&2; exit 1; }
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp work build-manifest-archive-test || exit 1

SOURCE="$work/logical-source"
PHYSICAL="$work/physical-source"
mkdir -m 700 "$PHYSICAL" "$work/home"
ln -s "$PHYSICAL" "$SOURCE"
mkdir "$PHYSICAL/src" "$PHYSICAL/scripts"
cp -R "$ROOT/rules" "$PHYSICAL/rules"
cp -R "$ROOT/rules-fleet" "$PHYSICAL/rules-fleet"
cp "$ROOT/scripts/build-manifest.sh" "$PHYSICAL/scripts/build-manifest.sh"
cp "$ROOT/scripts/kitlib-tmp.sh" "$PHYSICAL/scripts/kitlib-tmp.sh"
cp "$ROOT/scripts/runtime-adapter.sh" "$PHYSICAL/scripts/runtime-adapter.sh"
cp "$ROOT/scripts/rule-class.ts" "$PHYSICAL/scripts/rule-class.ts"
cp "$ROOT/scripts/install.sh" "$PHYSICAL/scripts/install.sh"
chmod 755 "$PHYSICAL/scripts/build-manifest.sh" "$PHYSICAL/scripts/runtime-adapter.sh" "$PHYSICAL/scripts/install.sh" "$PHYSICAL/scripts/rule-class.ts"
printf 'fixture source\n' | tee "$PHYSICAL/src/marker.ts" >/dev/null
if [ -z "${OMP_SRC:-}" ]; then
  OMP_SRC=$(bun --no-env-file --config=/dev/null -e 'const p = await import("./src/paths.ts"); console.log(p.resolveOmpIdentity().source)')
fi
export OMP_SRC

# Generate and then check with the real rule-class.ts producer. The source
# export has no .git or compiled launcher, so this exercises the same direct
# Bun path as a clean exact-commit archive, not a classifier mock.
PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$work" sh "$SOURCE/scripts/build-manifest.sh" > "$work/generate.log" 2>&1

# Control: invoke through a symlinked /var-like path so logical pwd and physical
# pwd differ, exactly as a macOS clean git archive can differ from its adapter.
PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$work" sh "$SOURCE/scripts/build-manifest.sh" --check > "$work/control.log" 2>&1
HOME="$work/home" PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$work" \
  sh "$SOURCE/scripts/install.sh" --dry-run --target "$work/target" --state "$work/state" > "$work/install.log" 2>&1
[ ! -e "$work/target" ]
[ ! -e "$work/state" ]
grep -q 'install: dry run, nothing written' "$work/install.log"

# Exact TSV contracts for an added rule and a name that must remain one argv
# operand through the batched hasher (spaces, brackets, quotes and a hash).
pack=$(awk -F '\t' 'NR == 2 { print $4 }' "$PHYSICAL/MANIFEST.tsv")
added_name=zzz-added-rule
printf '%s\n' '---' 'alwaysApply: true' '---' 'Added manifest rule.' > "$PHYSICAL/rules/$added_name.md"
added_sha=$(shasum -a 256 "$PHYSICAL/rules/$added_name.md" | cut -d ' ' -f 1)
cp "$PHYSICAL/MANIFEST.tsv" "$work/added.want"
printf '%s\t%s\talways\t%s\n' "$added_name" "$added_sha" "$pack" >> "$work/added.want"
TMPDIR="$work" sh "$SOURCE/scripts/build-manifest.sh" --stdout > "$work/added.have"
diff -u "$work/added.want" "$work/added.have"

odd_name="zzzz odd [x] 'quote' #hash"
printf '%s\n' '---' 'interruptMode: never' '---' 'Odd filename manifest rule.' > "$PHYSICAL/rules/$odd_name.md"
odd_sha=$(shasum -a 256 "$PHYSICAL/rules/$odd_name.md" | cut -d ' ' -f 1)
cp "$work/added.want" "$work/odd.want"
printf '%s\t%s\treminder\t%s\n' "$odd_name" "$odd_sha" "$pack" >> "$work/odd.want"
TMPDIR="$work" sh "$SOURCE/scripts/build-manifest.sh" --stdout > "$work/odd.have"
diff -u "$work/odd.want" "$work/odd.have"
TMPDIR="$work" sh "$SOURCE/scripts/build-manifest.sh" > "$work/added-regenerated.log" 2>&1

# Planted negative: changed rule bytes with the old manifest must still refuse.
printf '\nplanted stale-manifest input\n' >> "$PHYSICAL/rules/control.md"
if PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$work" \
  sh "$SOURCE/scripts/build-manifest.sh" --check > "$work/negative.log" 2>&1; then
  echo 'stale source-export manifest was accepted' >&2
  exit 1
fi
grep -q 'build-manifest --check: FAIL' "$work/negative.log"
PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$work" sh "$SOURCE/scripts/build-manifest.sh" > "$work/regenerated.log" 2>&1
# Normal-checkout path: runtime-adapter owns the private workdir; the parent removes it on exit.
mkdir "$PHYSICAL/.git"
if OMP_KIT_TEST_WORK_ROOT="$work" OMP_KIT_CASE_CWD="$ROOT" PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$work" \
  sh "$SOURCE/scripts/build-manifest.sh" --check > "$work/adapter-check.log" 2>&1; then
  :
else
  cat "$work/adapter-check.log" >&2
  exit 1
fi
for work in "$work"/omp-kit-work.*; do
  [ ! -e "$work" ] || { echo "build-manifest leaked runtime workdir: $work" >&2; exit 1; }
done
printf 'build-manifest-archive: control and planted negative pass\n'
