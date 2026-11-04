#!/bin/sh
# CIONLY1 (J-2026-11-03-34): release-verdict.sh judges all six ci-only files on an exact-commit export prepared as
# release-local prepares it, and records PASS/FAIL for the exact tree and judge identity; require-ci-only-pass reads
# PASS back only for a matching, untampered record. Planted negatives: another tree, a forged record, another judge,
# other test-file bytes. CIO_STORE_UNDER_TEST runs the cases against a mutant store.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITREPO/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
# shellcheck source=tests/cli/ci-only-verdict-fixtures.sh
. "$KITREPO/tests/cli/ci-only-verdict-fixtures.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP ci-only-verdict-test || exit 1
TMP=$(cd "$TMP" && pwd -P)
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

repo="$TMP/repo"
cio_fixture "$repo" || exit 1
cio_stub_bin "$TMP/bin" || exit 1
store="$TMP/store"
export CIO_LOG="$TMP/bun.log" PATH="$TMP/bin:$PATH" TMPDIR="$TMP" FULL_SUITE_VERDICT_CACHE_DIR="$store"
c1=$(git -C "$repo" rev-parse HEAD)
t1=$(git -C "$repo" rev-parse 'HEAD^{tree}')
# export_of SHA DIR: the exact commit's tree, as release-local's source stage extracts it.
export_of() { mkdir -p "$2" && git -C "$repo" archive "$1" | tar -xf - -C "$2"; }
# require TREE ROOT [STORE]: the release-local lookup; prints its stdout, status in $req_rc.
require() {
	req_rc=0
	req_out=$(PYTHONDONTWRITEBYTECODE=1 "$2/scripts/full-suite-verdict-store.py" require-ci-only-pass --repo "$repo" --tree "$1" --judge-root "$2" --suite-root "$2" --cache-dir "${3:-$store}" </dev/null 2>"$TMP/require.err") || req_rc=$?
}

# 1. The push-time verdict runs all six files on a git-initialized export and records every path and bound.
: >"$CIO_LOG"
rc=0
sh "$repo/scripts/release-verdict.sh" --commit "$c1" --no-fetch >"$TMP/o1" 2>&1 || rc=$?
runs=$(grep -c . "$CIO_LOG")
pkg=$(grep '^test --timeout=120000 tests/cli/package-release.test.ts|' "$CIO_LOG")
upd=$(grep '^test --timeout=120000 tests/cli/kit-update.test.ts|' "$CIO_LOG")
nplus=$(grep '^test --timeout=120000 tests/cli/kit-update-nplus-two.test.ts|' "$CIO_LOG")
compiled=$(grep '^test --timeout=120000 tests/cli/kit-update-compiled.test.ts|' "$CIO_LOG")
relink=$(grep '^test --timeout=120000 tests/cli/kit-update-relink.test.ts|' "$CIO_LOG")
live=$(grep '^test --timeout=120000 tests/cli/package-release-live.test.ts|' "$CIO_LOG")
case_ok=1
for line in "$pkg" "$upd" "$nplus" "$compiled" "$relink" "$live"; do
	cwd=$(printf '%s' "$line" | cut -d'|' -f2)
	[ -n "$line" ] && [ "$(printf '%s' "$line" | cut -d'|' -f3)" = "$cwd" ] \
		&& [ "$(printf '%s' "$line" | cut -d'|' -f4)" = 180 ] && [ "$(printf '%s' "$line" | cut -d'|' -f5)" = "$c1" ] || case_ok=0
done
set -- "$store"/ci-only/"$t1".ci-only.*.json
[ "$rc" = 0 ] && [ "$runs" = 6 ] && [ "$case_ok" = 1 ] && [ -f "$1" ] \
	&& grep -Fq "CI-ONLY: VERDICT PASS tree=$t1" "$TMP/o1" && grep -Fq "release-verdict: $c1 ci_only_rc=0" "$TMP/o1" \
	&& python3 -c 'import json,sys; e=json.load(open(sys.argv[1])); expected=[("tests/cli/package-release.test.ts",0,900),("tests/cli/kit-update.test.ts",0,2400),("tests/cli/kit-update-nplus-two.test.ts",0,900),("tests/cli/kit-update-compiled.test.ts",0,900),("tests/cli/kit-update-relink.test.ts",0,900),("tests/cli/package-release-live.test.ts",0,900)]; sys.exit(not (e["verdict"] == "PASS" and [(f["path"],f["rc"],f["timeout_s"]) for f in e["files"]] == expected and all(isinstance(f["duration_ms"],int) for f in e["files"])))' "$1"
ok $? "push-time-records-pass: rc=$rc runs=$runs case_ok=$case_ok record=$* out=$(cat "$TMP/o1") log=$(cat "$CIO_LOG")"
record1=$1

# 2. The release-local lookup on an export of the exact commit reads PASS.
export_of "$c1" "$TMP/x1"
require "$t1" "$TMP/x1"
st=1; [ "$req_rc" = 0 ] && [ "$req_out" = PASS ] && st=0
ok "$st" "lookup-exact-tree-pass: rc=$req_rc out=$req_out err=$(cat "$TMP/require.err")"

# 3. A second verdict for the same tree reuses the record; neither file runs again.
: >"$CIO_LOG"
rc=0
sh "$repo/scripts/release-verdict.sh" --commit "$c1" --no-fetch >"$TMP/o3" 2>&1 || rc=$?
[ "$rc" = 0 ] && [ ! -s "$CIO_LOG" ] && grep -Fq "CI-ONLY: VERDICT PASS tree=$t1 (already recorded" "$TMP/o3"
ok $? "recorded-pass-not-rerun: rc=$rc log=$(cat "$CIO_LOG") out=$(cat "$TMP/o3")"

# 4. Planted: another tree (one more commit) has no PASS, though the judge and test files are identical.
printf 'changed\n' >"$repo/README.md"
git -C "$repo" add README.md && git -C "$repo" commit -qm "[test] another tree"
c2=$(git -C "$repo" rev-parse HEAD)
t2=$(git -C "$repo" rev-parse 'HEAD^{tree}')
export_of "$c2" "$TMP/x2"
require "$t2" "$TMP/x2"
st=1; [ "$req_rc" = 1 ] && [ "$req_out" = MISS ] && st=0
ok "$st" "planted-other-tree-miss: rc=$req_rc out=$req_out"

# 5. Planted: a judge whose identity differs (suite-metrics.py bytes), and a suite whose test file differs.
export_of "$c1" "$TMP/x1-judge"
printf '# another judge\n' >>"$TMP/x1-judge/scripts/suite-metrics.py"
require "$t1" "$TMP/x1-judge"
judge_rc=$req_rc judge_out=$req_out
export_of "$c1" "$TMP/x1-test"
printf '// edited\n' >>"$TMP/x1-test/tests/cli/kit-update.test.ts"
require "$t1" "$TMP/x1-test"
st=1; [ "$judge_rc" = 1 ] && [ "$judge_out" = MISS ] && [ "$req_rc" = 1 ] && [ "$req_out" = MISS ] && st=0
ok "$st" "planted-other-judge-miss: judge=$judge_rc/$judge_out test-bytes=$req_rc/$req_out"

# 6. A failing file: FAIL is recorded and status 1, with both files' failing output printed in the one run.
printf 'fail\n' >"$repo/FAILING"
git -C "$repo" add FAILING && git -C "$repo" commit -qm "[test] failing tree"
c3=$(git -C "$repo" rev-parse HEAD)
t3=$(git -C "$repo" rev-parse 'HEAD^{tree}')
rc=0
CIO_FAIL="package-release.test.ts kit-update.test.ts" sh "$repo/scripts/release-verdict.sh" --commit "$c3" --no-fetch \
	>"$TMP/o6" 2>&1 || rc=$?
export_of "$c3" "$TMP/x3"
require "$t3" "$TMP/x3"
[ "$rc" = 1 ] && grep -Fq "CI-ONLY: VERDICT FAIL tree=$t3" "$TMP/o6" \
	&& grep -Fq "boom-stderr tests/cli/package-release.test.ts" "$TMP/o6" && grep -Fq "boom-stdout tests/cli/package-release.test.ts" "$TMP/o6" \
	&& grep -Fq "boom-stderr tests/cli/kit-update.test.ts" "$TMP/o6" && grep -Fq "boom-stdout tests/cli/kit-update.test.ts" "$TMP/o6" \
	&& grep -Fq "release-verdict: $c3 ci_only_rc=1" "$TMP/o6" && [ "$req_rc" = 1 ] && [ "$req_out" = FAIL ]
ok $? "fail-recorded-with-both-outputs: rc=$rc require=$req_rc/$req_out out=$(cat "$TMP/o6")"

# 7. Planted: the FAIL record forged into a PASS (verdict and exit codes rewritten, paired log untouched) is a MISS,
# and so is the PASS record with one byte appended to its paired log.
set -- "$store"/ci-only/"$t3".ci-only.*.json
forged="$TMP/forged"
mkdir -p "$forged/ci-only"
cp "$1" "${1%.json}.log" "$forged/ci-only/"
python3 - "$forged/ci-only/${1##*/}" <<'PY'
import json, sys
path = sys.argv[1]
entry = json.load(open(path))
entry["verdict"] = "PASS"
for row in entry["files"]:
    row["rc"] = 0
open(path, "w").write(json.dumps(entry, sort_keys=True, indent=1) + "\n")
PY
require "$t3" "$TMP/x3" "$forged"
forged_rc=$req_rc forged_out=$req_out
tampered="$TMP/tampered"
mkdir -p "$tampered/ci-only"
cp "$record1" "${record1%.json}.log" "$tampered/ci-only/"
printf 'x' >>"$tampered/ci-only/$(basename "${record1%.json}").log"
require "$t1" "$TMP/x1" "$tampered"
st=1; [ "$forged_rc" = 1 ] && [ "$forged_out" = MISS ] && [ "$req_rc" = 1 ] && [ "$req_out" = MISS ] && st=0
ok "$st" "planted-tampered-record-miss: forged=$forged_rc/$forged_out log-edit=$req_rc/$req_out err=$(cat "$TMP/require.err")"

# 8. A record past MAX_RECORD_BYTES is never read as PASS.
huge="$TMP/huge"
mkdir -p "$huge/ci-only"
cp "$record1" "${record1%.json}.log" "$huge/ci-only/"
python3 - "$huge/ci-only/$(basename "$record1")" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read().rstrip()
open(path, "w").write(text + " " * ((8 << 20) + 1) + "\n")
PY
require "$t1" "$TMP/x1" "$huge"
st=1; [ "$req_rc" = 1 ] && [ "$req_out" = MISS ] && st=0
ok "$st" "oversized-record-miss: rc=$req_rc out=$req_out"

# 9. A commit missing a required CI-only file records nothing and does not fail the verdict.
git -C "$repo" rm -q tests/cli/kit-update.test.ts && git -C "$repo" commit -qm "[test] no ci-only file"
c4=$(git -C "$repo" rev-parse HEAD)
t4=$(git -C "$repo" rev-parse 'HEAD^{tree}')
: >"$CIO_LOG"
rc=0
sh "$repo/scripts/release-verdict.sh" --commit "$c4" --no-fetch >"$TMP/o9" 2>&1 || rc=$?
set -- "$store"/ci-only/"$t4".ci-only.*.json
[ "$rc" = 0 ] && [ ! -s "$CIO_LOG" ] && [ ! -e "$1" ] && grep -Fq "CI-ONLY: SKIP tree=$t4" "$TMP/o9"
ok $? "absent-file-skips: rc=$rc out=$(cat "$TMP/o9")"

# 10. STOREDEADLINE1 (ompkit-fp72.120.16.184): checked_run scales its deadline by fixtureLoad()'s factor, injected via
# OMP_KIT_HEAVY_FAKE_LOAD1 at factor 3. Planted: a 16 s subcommand outlives the old fixed 15 s default and completes.
# Control: a hung subcommand is still killed at its scaled deadline (1 s floor -> 3 s) and the refusal names TIMEOUT.
fake_load1=$(python3 -c 'import os; print((os.cpu_count() or 1) * 3 / 4)')
store_py="${CIO_STORE_UNDER_TEST:-$KITREPO/scripts/full-suite-verdict-store.py}"
checked() {
	OMP_KIT_HEAVY_FAKE_LOAD1=$fake_load1 PYTHONDONTWRITEBYTECODE=1 python3 - "$store_py" "$@" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("store", sys.argv[1])
store = importlib.util.module_from_spec(spec)
sys.path.insert(0, sys.argv[1].rsplit("/", 1)[0])
spec.loader.exec_module(store)
argv = [sys.executable, "-c", f"import time; time.sleep({sys.argv[2]})"]
try:
    store.checked_run(argv, **({"deadline_s": float(sys.argv[3])} if len(sys.argv) > 3 else {}))
    print("COMPLETED")
except ValueError as exc:
    print(exc)
PY
}
out=$(checked 16 2>&1)
[ "$out" = COMPLETED ]
ok $? "deadline-scales-with-load: out=$out"
out=$(checked 600 1 2>&1)
case $out in *": TIMEOUT after 3s (load "*) st=0 ;; *) st=1 ;; esac
ok "$st" "hung-subcommand-timeout-named: out=$out"

printf 'ci-only-verdict: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
