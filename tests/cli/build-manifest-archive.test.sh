#!/bin/sh
# build-manifest-archive.test.sh — source-export manifest control and refusal contract.
# A clean source export has src/ but no .git or embedded bin/omp-kit. Its manifest
# producer must use the direct Bun path, while a stale manifest must still refuse.
set -eu
: "${TMPDIR:?set a private test scratch directory}"
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
WORK=$(mktemp -d "$TMPDIR/build-manifest-archive-test.XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

SOURCE="$WORK/logical-source"
PHYSICAL="$WORK/physical-source"
mkdir -m 700 "$PHYSICAL" "$WORK/home"
ln -s "$PHYSICAL" "$SOURCE"
mkdir "$PHYSICAL/src" "$PHYSICAL/scripts"
cp -R "$ROOT/rules" "$PHYSICAL/rules"
cp -R "$ROOT/rules-fleet" "$PHYSICAL/rules-fleet"
cp "$ROOT/scripts/build-manifest.sh" "$PHYSICAL/scripts/build-manifest.sh"
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
PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$WORK" sh "$SOURCE/scripts/build-manifest.sh" > "$WORK/generate.log" 2>&1

# Control: invoke through a symlinked /var-like path so logical pwd and physical
# pwd differ, exactly as a macOS clean git archive can differ from its adapter.
PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$WORK" sh "$SOURCE/scripts/build-manifest.sh" --check > "$WORK/control.log" 2>&1
HOME="$WORK/home" PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$WORK" \
  sh "$SOURCE/scripts/install.sh" --dry-run --target "$WORK/target" --state "$WORK/state" > "$WORK/install.log" 2>&1
[ ! -e "$WORK/target" ]
[ ! -e "$WORK/state" ]
grep -q 'install: dry run, nothing written' "$WORK/install.log"

# Planted negative: changed rule bytes with the old manifest must still refuse.
printf '\nplanted stale-manifest input\n' >> "$PHYSICAL/rules/control.md"
if PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$WORK" \
  sh "$SOURCE/scripts/build-manifest.sh" --check > "$WORK/negative.log" 2>&1; then
  echo 'stale source-export manifest was accepted' >&2
  exit 1
fi
grep -q 'build-manifest --check: FAIL' "$WORK/negative.log"
printf 'build-manifest-archive: control and planted negative pass\n'
