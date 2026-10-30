#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-rerun.test.sh — FSRERUN1 (ompkit-t7cn7.4).
# --rerun-reason TEXT reruns a cached FAIL with a recorded reason instead of a hand file move:
# the old record is kept as <record>.superseded-<utc>.{json,log}, the suite runs again, and the
# new entry records the reason, the actor and the superseded entry's digest. Without the flag
# a cached FAIL is still reused (nothing runs). A cached PASS is never rerun by the flag.
set -u

KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# FULL_SUITE_VERDICT_UNDER_TEST lets a planted-negative run point at a scratch copy of the judge.
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-rerun-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }

# Fixture repo: one python suite that FAILs only when its out-of-tree control file says RED=1,
# printing the run marker so a rerun is distinguishable from a reuse in the cached log. The
# control is a file, not an environment variable: the judge runs suites in a scrubbed
# environment (HERMETIC1), and reads outside the archive stay allowed.
control="$TMP/fsrerun1-control"
repo="$TMP/repo"
rm -rf "$repo" "$repo.cache"
mkdir -p "$repo/scripts" "$repo/tests/cli" "$repo.cache"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
cat >"$repo/tests/cli/fixture_test.py" <<PYEOF
import sys
from pathlib import Path
red, run = Path("$control").read_text(encoding="utf-8").split()
print("FSRERUN1-RUN marker=" + run, flush=True)
sys.exit(1 if red == "1" else 0)
PYEOF
git -C "$repo" init -q
git -C "$repo" config user.name "FSRERUN1 test"
git -C "$repo" config user.email "fsrerun1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] FSRERUN1 fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
cache="$repo.cache"
# The judge keys records by tree, role, judging code and runtime; resolve the same record path.
judge_dir=$(CDPATH='' cd -- "$(dirname -- "$VERDICT")" && pwd -P) || exit 1
judge_root=$(CDPATH='' cd -- "$judge_dir/.." && pwd -P) || exit 1
checks=$(python3 "$judge_dir/suite-metrics.py" identity --root "$judge_root" --scope full) || exit 1
runtime=$(python3 "$judge_dir/suite-metrics.py" runtime) || exit 1
entry=$(python3 "$judge_dir/full-suite-verdict-store.py" path --repo "$repo" --tree "$tree" \
	--role base --checks "$checks" --runtime "$runtime" --judge-root "$judge_root" \
	--cache-dir "$cache") || { echo "test harness: cannot resolve the verdict record path"; exit 1; }
record=${entry%.json}
# fault RED RUN: the environment the next suite run observes (RED=1 makes it FAIL).
fault() { printf '%s %s\n' "$1" "$2" >"$control"; }

run_verdict() {
	out="$TMP/$1.out"
	shift
	# shellcheck disable=SC2086
	env $VERDICT_ENV KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 \
		sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$cache" "$@" >"$out" 2>&1
	rc=$?
}
VERDICT_ENV=""

# 1. Seed a cached FAIL: the suite runs and the verdict is recorded.
fault 1 first
run_verdict seed
if [ "$rc" -ne 0 ]; then ok "seed FAIL exits non-pass (rc=$rc)"; else not_ok "seed FAIL exited 0"; cat "$out"; fi
if grep -F '"verdict": "FAIL"' "$record.json" >/dev/null 2>&1; then ok "seed caches FAIL verdict"; else not_ok "seed cached no FAIL verdict"; cat "$out"; fi

# 2. Replay: without the flag the cached FAIL is reused and nothing runs, even though the
# environment fault is gone (the rerun would pass if it ran).
fault 0 second
run_verdict replay
if [ "$rc" -ne 0 ] && grep -F 'VERDICT REUSED FAIL' "$out" >/dev/null; then
	ok "replay without flag reuses FAIL (rc=$rc)"
else
	not_ok "replay without flag (rc=$rc)"; cat "$out"
fi
if grep -F 'marker=first' "$record.log" >/dev/null && ! grep -F 'marker=second' "$record.log" >/dev/null; then
	ok "replay without flag executed nothing (log still shows the first run)"
else
	not_ok "replay without flag ran the suite"; grep -F 'FSRERUN1-RUN' "$record.log"
fi

# 3. Rerun: with the flag the suite runs again, the old entry is kept as superseded, and the
# new entry records reason, actor and the old digest.
old_digest=$(shasum -a 256 "$record.json" | cut -d' ' -f1)
fault 0 second
VERDICT_ENV="AGENT_NAME=FSRERUN1-probe"
run_verdict rerun --rerun-reason 'env fault'
VERDICT_ENV=""
if [ "$rc" -eq 0 ] && grep -F 'VERDICT PASS' "$out" >/dev/null; then
	ok "rerun with reason runs the suite again (rc=$rc)"
else
	not_ok "rerun with reason (rc=$rc)"; cat "$out"
fi
sup_json=$(find "$cache" -maxdepth 1 -name "${record##*/}.superseded-*.json" | sort | head -n 1)
sup_log=$sup_json
case "$sup_json" in *.json) sup_log=${sup_json%.json}.log ;; esac
if [ -n "$sup_json" ] && [ -f "$sup_json" ] && [ -f "$sup_log" ]; then
	ok "rerun keeps the old entry as superseded json+log"
else
	not_ok "rerun kept no superseded pair"; ls "$cache"
fi
if [ -n "$sup_json" ] && [ "$(shasum -a 256 "$sup_json" | cut -d' ' -f1)" = "$old_digest" ]; then
	ok "superseded entry matches the planted FAIL digest"
else
	not_ok "superseded entry digest mismatch"
fi
if grep -F 'marker=second' "$record.log" >/dev/null; then
	ok "rerun log shows the second run"
else
	not_ok "rerun log shows no second run"; grep -F 'FSRERUN1-RUN' "$record.log"
fi
if python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))
r = e.get("rerun")
assert isinstance(r, dict), e.keys()
assert r.get("reason") == "env fault", r
assert r.get("actor") == "FSRERUN1-probe", r
assert r.get("superseded_digest") == sys.argv[2], r
assert r.get("superseded_entry", "").endswith(".json"), r
assert e.get("verdict") == "PASS", e.get("verdict")
' "$record.json" "$old_digest"; then
	ok "new entry records reason, actor and old digest"
else
	not_ok "new entry rerun block"; cat "$record.json"
fi

# 4. Planted negative: an empty reason is refused and the cache is untouched.
before=$(find "$cache" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | shasum -a 256 | cut -d' ' -f1)
fault 0 third
run_verdict empty --rerun-reason ''
if [ "$rc" -ne 0 ] && grep -Fq 'non-empty reason' "$out"; then
	ok "empty reason is refused (rc=$rc)"
else
	not_ok "empty reason (rc=$rc)"; cat "$out"
fi
after=$(find "$cache" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | shasum -a 256 | cut -d' ' -f1)
if [ "$before" = "$after" ] && ! grep -F 'marker=third' "$record.log" >/dev/null; then
	ok "refused rerun touches nothing cached"
else
	not_ok "refused rerun changed the cache"; ls "$cache"
fi

# 5. Paired control: a cached PASS with the flag is reused, not rerun, even though the
# suite would now FAIL if it ran.
fault 1 third
run_verdict passflag --rerun-reason 'env fault'
if [ "$rc" -eq 0 ] && grep -F 'VERDICT REUSED PASS' "$out" >/dev/null; then
	ok "cached PASS with flag is reused (rc=$rc)"
else
	not_ok "cached PASS with flag (rc=$rc)"; cat "$out"
fi
if ! grep -F 'marker=third' "$record.log" >/dev/null; then
	ok "reused PASS executed nothing"
else
	not_ok "flag reran a cached PASS"; grep -F 'FSRERUN1-RUN' "$record.log"
fi

echo "full-suite-verdict-rerun: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
