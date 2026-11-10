#!/bin/sh
# RELFAST1 (ompkit-fp72.120.16.309): preserve CrimsonBluff's exact-tree reuse
# regression coverage independently of the retired VERDICTID1 consumer cases.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
# shellcheck source=scripts/kitlib-shimpath.sh
. "$KITREPO/scripts/kitlib-shimpath.sh"
kitlib_drop_agent_bin release-verdict-reuse-test
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
kitlib_tmp TMP release-verdict-reuse-test || exit 1
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

# Runner intervals are output contracts, not exact-duration goldens.
timings() {
	python3 - "$@" <<'PY'
import sys
from pathlib import Path
lines = Path(sys.argv[1]).read_text().splitlines()
for name in sys.argv[2:]:
    prefix = "== substep " + name + " "
    starts = [line[len(prefix):] for line in lines if line.startswith(prefix + "start=")]
    ends = [line[len(prefix):].split() for line in lines if line.startswith(prefix + "took ")]
    assert len(starts) == len(ends) == 1, (name, starts, ends)
    took, duration, start, end = ends[0]
    assert took == "took" and duration.endswith("s"), (name, ends)
    start_s, end_s = int(start.removeprefix("start=")), int(end.removeprefix("end="))
    assert starts == ["start=" + str(start_s)], (name, starts)
    assert end_s >= start_s > 0 and int(duration[:-1]) == end_s - start_s, (name, ends)
PY
}

# A real canonical store supplies PASS controls for RELFAST1's cache invalidations.
seed="$TMP/shared-seed"
origin="$TMP/shared-origin.git"
second="$TMP/release-second"
store="$TMP/shared-verdicts"
mkdir -p "$seed/scripts" "$seed/tests/cli" "$seed/.github/workflows" "$origin" "$TMP/fake-bin" "$TMP/home"
git -C "$seed" init -q --template= -b main
git -C "$seed" config user.email t@example.invalid
git -C "$seed" config user.name t
for path in $(PYTHONPATH="$KITREPO/scripts" python3 -B -m suite-metrics judging-files) \
	scripts/kitlib_io.py scripts/kitlib_jsonl.py; do
	mkdir -p "$seed/$(dirname -- "$path")"
	cp "$KITREPO/$path" "$seed/$path" || exit 1
done
for path in scripts/release-verdict.sh scripts/release-local.sh scripts/release-train.sh scripts/release-signing.json; do
	cp "$KITREPO/$path" "$seed/$path" || exit 1
done
cp "$KITREPO/scripts/gate-ci-only.tsv" "$seed/scripts/gate-ci-only.tsv"
cat >"$seed/scripts/fresh-gate.sh" <<'EOF'
#!/bin/sh
case "${1:-}" in --test-workers) printf "1\n" ;; *) exit 0 ;; esac
EOF
chmod +x "$seed/scripts/fresh-gate.sh"
printf '#!/bin/sh\nprintf "shared fixture suite ran\\n"\n' >"$seed/tests/cli/shared.test.sh"
printf '%s\n' 'package.json export-subst' >"$seed/.gitattributes"
cat >"$seed/package.json" <<'EOF'
{"version":"0.2.83","source_revision":"$Format:%H$","omp":{"version":"0.2.83"}}
EOF
printf '%s\n' "$(bun --version)" >"$seed/.bun-version"
printf '%s\n' '{"schema_version":1,"darwin_signing":"developer-id"}' >"$seed/scripts/release-signing.json"
printf '%s\n' 'name: fixture' 'jobs:' '  attest-local:' >"$seed/.github/workflows/release.yml"
mkdir -p "$seed/docs/releases"
cat >"$seed/docs/releases/v0.2.83.md" <<'EOF'
# Fixture release card (not live release evidence)
## 1. Gap lane
| Bead | State |
|---|---|
| fixture | landed |
## 2. Optimization lane
| # | Idea | Decision |
|---|---|---|
| 1 | fixture | applied: 2 -> 1 calls in this synthetic fixture |
## 3. Measures
| Metric | Before | After |
|---|---|---|
| Change lead time | 2 fixture calls | 1 fixture call |
## 4. Error budget
Synthetic fixture only; no production claim.
EOF
# Pin synthetic tools in the fixture's own policy so the caller cannot select them.
# shellcheck disable=SC2016 # expand PATH when the fixture policy is sourced
printf '\nPATH="%s:$PATH"\nexport PATH\n' "$TMP/fake-bin" >>"$seed/scripts/fixed-env.sh"
git -C "$seed" add -A
git -C "$seed" commit -qm '[test] VERDICTID1 checkout fixture'
source_sha=$(git -C "$seed" rev-parse HEAD)
source_tree=$(git -C "$seed" rev-parse 'HEAD^{tree}')
git -C "$seed" tag v0.2.82
git -C "$seed" init --bare -q --template= "$origin"
git -C "$seed" remote add origin "$origin"
git -C "$seed" push -q origin main --tags
git clone -q --no-hardlinks --branch main "$origin" "$second"
for tool in codesign xcrun security spctl ditto plutil openssl shasum; do
	printf '#!/bin/sh\nexit 0\n' >"$TMP/fake-bin/$tool"
	chmod +x "$TMP/fake-bin/$tool"
done
cat >"$TMP/fake-bin/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) printf "Darwin\n" ;; -m) printf "arm64\n" ;; *) printf "Darwin\n" ;; esac
EOF
printf '#!/bin/sh\nshift\nexec "$@"\n' >"$TMP/fake-bin/timeout"
cat >"$TMP/fake-bin/gh" <<'EOF'
#!/bin/sh
case "${1:-}" in auth) exit 0 ;; api) printf '[[{"tag_name":"v0.2.82","draft":false,"prerelease":false}]]\n' ;; *) exit 2 ;; esac
EOF
chmod +x "$TMP/fake-bin/uname" "$TMP/fake-bin/timeout" "$TMP/fake-bin/gh"

if env PATH="$TMP/fake-bin:$PATH" HOME="$TMP/home" TMPDIR="$TMP" \
	FULL_SUITE_TIMEOUT_SECS=120 FULL_SUITE_SHELL_JOBS=1 FULL_SUITE_VERDICT_CACHE_DIR="$store" \
	sh "$second/scripts/release-verdict.sh" --commit "$source_sha" --no-fetch >"$TMP/watchdog.out" 2>&1; then
	watchdog_rc=0
else
	watchdog_rc=$?
fi
if [ "$watchdog_rc" = 0 ] && grep -Fq "FULL-SUITE: VERDICT PASS tree=$source_tree role=main" "$TMP/watchdog.out"; then
	ok 0 "watchdog-second-checkout-produces-main-pass"
else
	ok 1 "watchdog-second-checkout: rc=$watchdog_rc output=$(cat "$TMP/watchdog.out")"
fi
timings "$TMP/watchdog.out" verdict.archive-export verdict.store-lookup verdict.suite-lease-wait verdict.main-judge
ok $? "cold-run-emits-each-runner-interval"

# RELFAST1: a fully qualified exact tree must not queue behind an unrelated suite.
# Only the checkout's lease is refused; the committed judge and records stay unchanged.
cp "$second/scripts/suite-lease.sh" "$TMP/original-lease.sh"
cat >"$second/scripts/suite-lease.sh" <<'EOF'
suite_lease_take() { printf 'fixture lease refused\n'; return 75; }
suite_lease_release() { :; }
EOF
if env PATH="$TMP/fake-bin:$PATH" HOME="$TMP/home" TMPDIR="$TMP" \
	FULL_SUITE_TIMEOUT_SECS=120 FULL_SUITE_SHELL_JOBS=1 FULL_SUITE_VERDICT_CACHE_DIR="$store" \
	sh "$second/scripts/release-verdict.sh" --commit "$source_sha" --no-fetch >"$TMP/warm.out" 2>&1; then
	warm_rc=0
else
	warm_rc=$?
fi
[ "$warm_rc" = 0 ] && ! grep -Fq 'fixture lease refused' "$TMP/warm.out"
ok $? "qualified-tree-bypasses-suite-lease: rc=$warm_rc output=$(cat "$TMP/warm.out")"
timings "$TMP/warm.out" verdict.archive-export verdict.store-lookup
ok $? "warm-run-emits-export-and-store-intervals"
! grep -Fq '== substep verdict.suite-lease-wait ' "$TMP/warm.out" \
	&& ! grep -Fq '== substep verdict.main-judge ' "$TMP/warm.out"
ok $? "warm-run-does-not-invent-skipped-intervals"

cp "$TMP/original-lease.sh" "$second/scripts/suite-lease.sh"

# Planted invalidations cannot turn stored evidence into a PASS for different inputs.
for plant in checks fail runtime tree; do
	planted_store="$TMP/plant-$plant"
	mkdir -p "$planted_store"
	cp "$store/"*.json "$store/"*.log "$planted_store/"
	python3 - "$planted_store" "$plant" <<'PY'
import json, sys
from pathlib import Path
for path in Path(sys.argv[1]).glob("*.json"):
    entry = json.loads(path.read_text())
    if sys.argv[2] == "checks":
        entry["checks"] = entry["judge"]["checks_sha256"] = "0" * 64
    elif sys.argv[2] == "fail":
        entry["verdict"] = "FAIL"
    elif sys.argv[2] == "runtime":
        entry["runtime"] = entry["judge"]["runtime"] = "another-runtime"
    else:
        entry["tree"] = "0" * 40
    path.write_text(json.dumps(entry))
PY
	if env PATH="$TMP/fake-bin:$PATH" HOME="$TMP/home" TMPDIR="$TMP" \
		FULL_SUITE_TIMEOUT_SECS=120 FULL_SUITE_SHELL_JOBS=1 FULL_SUITE_VERDICT_CACHE_DIR="$planted_store" \
		sh "$second/scripts/release-verdict.sh" --commit "$source_sha" --no-fetch >"$TMP/plant-$plant.out" 2>&1; then
		plant_rc=0
	else
		plant_rc=$?
	fi
	[ "$plant_rc" = 0 ] && grep -Fq "cache miss for tree $source_tree role=main" "$TMP/plant-$plant.out" \
		&& grep -Fq "FULL-SUITE: VERDICT PASS tree=$source_tree role=main" "$TMP/plant-$plant.out"
	ok $? "$plant-record-runs-suite: rc=$plant_rc output=$(cat "$TMP/plant-$plant.out")"
done

# A real different tree cannot inherit PASS. A genuine cached FAIL must
# retain the runner's refusal rather than being promoted to the warm PASS path.
printf '#!/bin/sh\nexit 1\n' >"$second/tests/cli/shared.test.sh"
git -C "$second" add -- tests/cli/shared.test.sh
git -C "$second" -c user.email=t@example.invalid -c user.name=t commit -qm '[test] planted failing candidate'
failed_sha=$(git -C "$second" rev-parse HEAD)
failed_tree=$(git -C "$second" rev-parse 'HEAD^{tree}')
for attempt in fresh cached; do
	if env PATH="$TMP/fake-bin:$PATH" HOME="$TMP/home" TMPDIR="$TMP" \
		FULL_SUITE_TIMEOUT_SECS=120 FULL_SUITE_SHELL_JOBS=1 FULL_SUITE_VERDICT_CACHE_DIR="$store" \
		sh "$second/scripts/release-verdict.sh" --commit "$failed_sha" --no-fetch >"$TMP/fail-$attempt.out" 2>&1; then
		failed_rc=0
	else
		failed_rc=$?
	fi
	[ "$failed_rc" != 0 ] && ! grep -Fq 'reusing exact-tree main PASS' "$TMP/fail-$attempt.out" \
		&& grep -Fq "VERDICT" "$TMP/fail-$attempt.out"
	ok $? "valid-fail-$attempt-refuses: rc=$failed_rc output=$(cat "$TMP/fail-$attempt.out")"
	if [ "$attempt" = fresh ]; then
		timings "$TMP/fail-$attempt.out" verdict.main-judge
		ok $? "failed-main-fresh-emits-completed-judge-interval"
	else
		grep -Fq 'reusing exact-tree main FAIL' "$TMP/fail-$attempt.out" &&
			! grep -Fq '== substep verdict.main-judge ' "$TMP/fail-$attempt.out" &&
			! grep -Fq '== substep verdict.suite-lease-wait ' "$TMP/fail-$attempt.out"
		ok $? "cached-fail-is-noop-without-suite-lease"
	fi
done
grep -Fq "cache miss for tree $failed_tree role=main" "$TMP/fail-fresh.out"
ok $? "different-candidate-tree-runs-suite"

printf 'release-verdict-reuse: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
