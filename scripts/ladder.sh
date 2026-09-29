#!/bin/sh
# ladder.sh — run every gate the pack must pass before install, in order, and stop at the first RED.
# G1-G3 harness gate, harness selftest (plants must go RED), checker selftests under /bin/sh,
# manifest check, G4 live suite, G4 plant (must go RED). Prints each complete producer log and rc.
set -u
HERE=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
cd "$HERE" || exit 1
OMP_KIT_BUN="$HERE/scripts/runtime-adapter.sh"
[ -x "$OMP_KIT_BUN" ] || { echo "ladder: runtime adapter missing" >&2; exit 2; }
if [ -x "$HERE/bin/omp-kit" ]; then
  WORK=$("$OMP_KIT_BUN" --workdir) || exit 2
  PRIVATE_WORK=1
elif [ -e "$HERE/.git" ]; then
  mkdir -p "$HERE/reports" || exit 1
  WORK="$HERE/reports"
  PRIVATE_WORK=0
else
  echo "ladder: embedded omp-kit executable missing; source fallback is contributor-checkout-only" >&2
  exit 2
fi
KEEP_WORK=0
cleanup() {
  if [ "$PRIVATE_WORK" = 1 ]; then
    if [ "$KEEP_WORK" = 1 ]; then echo "private ladder logs retained: $WORK" >&2; else rm -rf "$WORK"; fi
  fi
}
trap cleanup EXIT
export OMP_KIT_WORK_DIR="$WORK"
step() { # step <label> <cmd...>
  label=$1; shift
  log="$WORK/ladder-$label.txt"
  "$@" > "$log" 2>&1
  rc=$?
  cat "$log"
  if [ "$rc" -eq 0 ]; then echo "GREEN $label producer_rc=$rc"; else echo "RED   $label producer_rc=$rc (private log $log)"; KEEP_WORK=1; exit 1; fi
}
step manifest /bin/sh scripts/build-manifest.sh --check
step harness-gate "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --gate
step harness-selftest "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --selftest
step claim-selftest /bin/sh checkers/check-claim-discipline.sh --selftest
# The harness imports omp's matcher; after an omp upgrade this proves it still agrees with the CLI.
step cli-crosscheck "$OMP_KIT_BUN" "$HERE/scripts/ttsr-harness.ts" --cli-crosscheck --jobs 8
step readiness-selftest /bin/sh checkers/check-readiness.sh --selftest
step e2e-live /bin/sh "$HERE/scripts/e2e-live.sh"
step e2e-plant /bin/sh "$HERE/scripts/e2e-live.sh" --plant
echo "LADDER: GREEN"
