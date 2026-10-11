#!/bin/sh
# release-train.test.sh — RELTRAIN1 (ompkit-v66l) train decision contract.
# Every verdict comes from the exit code plus the complete output. Planted
# negatives: red CI, running CI and superseded SHAs must never tag; a
# candidate bound to another SHA/version/ship set must never verify; a
# superseded version must never take Latest.
set -u

TRAIN=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/release-train.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/release-train-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

check() { # name expected_rc actual_rc output [pattern...]
	name=$1; want=$2; got=$3; out=$4; shift 4
	ok=1
	[ "$got" = "$want" ] || ok=0
	for pattern in "$@"; do
		printf '%s' "$out" | grep -q -- "$pattern" || ok=0
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1)); printf 'ok %s\n' "$name";
	else fail=$((fail + 1)); printf 'FAIL %s (rc=%s want=%s out=%s)\n' "$name" "$got" "$want" "$out"; fi
}

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
HEAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# 1. green head tags
out=$(sh "$TRAIN" decide --conclusion success --run-status completed --sha "$HEAD" --head "$HEAD" 2>&1); rc=$?
check "decide: green head tags" 0 "$rc" "$out" "DECIDE=tag" "$HEAD"

# 2. planted: red CI is never tagged
out=$(sh "$TRAIN" decide --conclusion failure --run-status completed --sha "$HEAD" --head "$HEAD" 2>&1); rc=$?
check "decide: red CI never tagged" 4 "$rc" "$out" "DECIDE=skip" "red-ci-never-tagged"

# 3. planted: cancelled CI is never tagged
out=$(sh "$TRAIN" decide --conclusion cancelled --run-status completed --sha "$HEAD" --head "$HEAD" 2>&1); rc=$?
check "decide: cancelled CI never tagged" 4 "$rc" "$out" "DECIDE=skip" "red-ci-never-tagged"

# 4. planted: a still-running CI is never tagged
out=$(sh "$TRAIN" decide --conclusion success --run-status in_progress --sha "$HEAD" --head "$HEAD" 2>&1); rc=$?
check "decide: running CI never tagged" 4 "$rc" "$out" "DECIDE=skip" "running-ci-never-tagged"

# 5. planted: a superseded SHA is left to the newer train
out=$(sh "$TRAIN" decide --conclusion success --run-status completed --sha "$SHA" --head "$HEAD" 2>&1); rc=$?
check "decide: superseded SHA skipped" 4 "$rc" "$out" "DECIDE=skip" "superseded-by-newer-green"

# 6. next patch after the max tag
out=$(printf 'v0.2.18\nv0.2.20\nv0.2.19\n' | sh "$TRAIN" next-version 2>&1); rc=$?
check "next-version: max plus one" 0 "$rc" "$out" "0.2.21"

# 7. legacy non-semver tags are ignored, not parsed
out=$(printf 'omp-kit v0.2.3\nv0.2.5\nv0.2.15\n' | sh "$TRAIN" next-version 2>&1); rc=$?
check "next-version: legacy tags ignored" 0 "$rc" "$out" "0.2.16"

# 8. planted: ls-remote full ref lines are accepted
out=$(printf 'abc123\trefs/tags/v0.2.20\ndef456\trefs/tags/v0.2.20^{}\n' | sh "$TRAIN" next-version 2>&1); rc=$?
check "next-version: ls-remote ref lines" 0 "$rc" "$out" "0.2.21"

# 9. planted: no parseable tag refuses instead of guessing
out=$(printf 'omp-kit v0.2.3\n' | sh "$TRAIN" next-version 2>&1); rc=$?
check "next-version: no tag refuses" 4 "$rc" "$out" "no parseable"

# 10. candidate proof plus index verify for the exact version and SHA
cat > "$TMP/proof.json" <<'JSON'
{"source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "version": "0.2.21",
 "certified_platforms": ["linux-x64-gnu", "darwin-arm64-none", "linux-arm64-gnu"]}
JSON
cat > "$TMP/index.json" <<'JSON'
{"source_tag": "v0.2.21",
 "assets": {"darwin-arm64-none": {}, "linux-arm64-gnu": {}, "linux-x64-gnu": {}}}
JSON
out=$(sh "$TRAIN" verify-candidate --proof "$TMP/proof.json" --index "$TMP/index.json" --version 0.2.21 --sha "$SHA" 2>&1); rc=$?
check "verify-candidate: exact match verifies" 0 "$rc" "$out" "CANDIDATE=verified"

# 11. planted: proof bound to another SHA never verifies
out=$(sh "$TRAIN" verify-candidate --proof "$TMP/proof.json" --index "$TMP/index.json" --version 0.2.21 --sha "$HEAD" 2>&1); rc=$?
check "verify-candidate: wrong SHA refused" 4 "$rc" "$out" "different sha"

# 12. planted: intel-probe-only ship set never verifies
cat > "$TMP/proof-intel.json" <<'JSON'
{"source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "version": "0.2.21",
 "certified_platforms": ["darwin-arm64-none", "darwin-x64-none", "linux-x64-gnu"]}
JSON
out=$(sh "$TRAIN" verify-candidate --proof "$TMP/proof-intel.json" --index "$TMP/index.json" --version 0.2.21 --sha "$SHA" 2>&1); rc=$?
check "verify-candidate: wrong ship set refused" 4 "$rc" "$out" "ship set"

# 13. planted: asset map missing a platform never verifies
cat > "$TMP/index-short.json" <<'JSON'
{"source_tag": "v0.2.21", "assets": {"darwin-arm64-none": {}, "linux-x64-gnu": {}}}
JSON
out=$(sh "$TRAIN" verify-candidate --proof "$TMP/proof.json" --index "$TMP/index-short.json" --version 0.2.21 --sha "$SHA" 2>&1); rc=$?
check "verify-candidate: short asset map refused" 4 "$rc" "$out" "asset map"

# 14. newest version takes Latest
out=$(sh "$TRAIN" latest-flag --version 0.2.21 --max-version 0.2.21 2>&1); rc=$?
check "latest-flag: newest takes Latest" 0 "$rc" "$out" "--latest"

# 15. planted: superseded version must not steal Latest
out=$(sh "$TRAIN" latest-flag --version 0.2.21 --max-version 0.2.22 2>&1); rc=$?
check "latest-flag: superseded keeps Latest" 0 "$rc" "$out" "--latest=false"

# 16. idle release lane proceeds
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho 0\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
out=$(GH_BIN="$TMP/bin/gh" sh "$TRAIN" wait-release-idle --repo R --poll 1 --timeout 5 2>&1); rc=$?
check "wait-release-idle: idle proceeds" 0 "$rc" "$out" "RELEASE=idle"

# 17. planted: busy release lane blocks the train
printf '#!/bin/sh\necho 2\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
out=$(GH_BIN="$TMP/bin/gh" sh "$TRAIN" wait-release-idle --repo R --poll 1 --timeout 2 2>&1); rc=$?
check "wait-release-idle: busy blocks" 4 "$rc" "$out" "timed out"

printf '%s pass, %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
