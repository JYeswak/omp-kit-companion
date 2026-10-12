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

# 14. planted: proof bound to another version never verifies
cat > "$TMP/proof-version.json" <<'JSON'
{"source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "version": "0.2.20",
 "certified_platforms": ["linux-x64-gnu", "darwin-arm64-none", "linux-arm64-gnu"]}
JSON
out=$(sh "$TRAIN" verify-candidate --proof "$TMP/proof-version.json" --index "$TMP/index.json" --version 0.2.21 --sha "$SHA" 2>&1); rc=$?
check "verify-candidate: wrong version refused" 4 "$rc" "$out" "different sha, version"

# 15. newest version takes Latest
out=$(sh "$TRAIN" latest-flag --version 0.2.21 --max-version 0.2.21 2>&1); rc=$?
check "latest-flag: newest takes Latest" 0 "$rc" "$out" "--latest"

# 16. planted: superseded version must not steal Latest
out=$(sh "$TRAIN" latest-flag --version 0.2.21 --max-version 0.2.22 2>&1); rc=$?
check "latest-flag: superseded keeps Latest" 0 "$rc" "$out" "--latest=false"

# 17. idle release lane proceeds
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho 0\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
out=$(GH_BIN="$TMP/bin/gh" sh "$TRAIN" wait-release-idle --repo R --poll 1 --timeout 5 2>&1); rc=$?
check "wait-release-idle: idle proceeds" 0 "$rc" "$out" "RELEASE=idle"

# 17. planted: busy release lane blocks the train
printf '#!/bin/sh\necho 2\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
out=$(GH_BIN="$TMP/bin/gh" sh "$TRAIN" wait-release-idle --repo R --poll 1 --timeout 2 2>&1); rc=$?
check "wait-release-idle: busy blocks" 4 "$rc" "$out" "timed out"

# Release bump fixture: CHANGELOG [Unreleased] + one fragment + package.json at the old version.
R="$TMP/bump-repo"
mkdir -p "$R/changelog.d" "$R/src"
git -C "$R" init -q
git -C "$R" config user.email "train@example.invalid"
# The train commits on a CI runner; this machine's global commit-msg hooks do not apply to it.
git -C "$R" config core.hooksPath /dev/null
git -C "$R" config user.name "release-train-test"
printf '# Changelog\n\n## [Unreleased]\n\n## [0.2.20] - 2026-10-10\n\n### Fixed\n\n- Old fix.\n' > "$R/CHANGELOG.md"
printf '{\n\t"name": "omp-kit-companion",\n\t"version": "0.2.15",\n\t"omp": {\n\t\t"name": "omp-kit-companion",\n\t\t"version": "0.2.15"\n\t}\n}\n' > "$R/package.json"
printf '### Added\n- A shipped feature.\n' > "$R/changelog.d/feat.md"
printf 'code\n' > "$R/src/a.ts"
git -C "$R" add -A && git -C "$R" commit -q -m "feat: a [test]"
green=$(git -C "$R" rev-parse HEAD)

# 18. bump folds, promotes, sets package.json and commits on the green SHA
out=$(sh "$TRAIN" bump --version 0.2.21 --date 2026-10-12 --repo "$R" 2>&1); rc=$?
check "bump: commits the release" 0 "$rc" "$out" "BUMP=committed version=0.2.21" "PROMOTED version=0.2.21"
bump=$(git -C "$R" rev-parse HEAD)
meta="$(git -C "$R" log -1 --format=%s "$bump") parent=$(git -C "$R" rev-parse "$bump^") $(jq -r '.version + "/" + .omp.version' "$R/package.json") $(grep -c '^## \[0.2.21\] - 2026-10-12$' "$R/CHANGELOG.md") $(find "$R/changelog.d" -type f | wc -l | tr -d ' ')"
check "bump: subject, parent, versions, section, drained inbox" 0 0 "$meta" "chore: bump version to 0.2.21" "parent=$green" "0.2.21/0.2.21" " 1 0"
check "bump: notes are the promoted section" 0 0 "$(cd "$R" && sh "$(dirname "$TRAIN")/release-notes.sh" notes --version 0.2.21 2>&1)" "### Added" "- A shipped feature."
out=$(cd "$R" && sh "$(dirname "$TRAIN")/release-notes.sh" notes --version 0.2.22 2>&1); rc=$?
check "notes: planted missing section refused" 4 "$rc" "$out" "REFUSED: CHANGELOG.md has no ## \[0.2.22\] section"
# 19. a pure bump commit inherits its parent's CI evidence
out=$(sh "$TRAIN" evidence-sha --sha "$bump" --repo "$R" 2>&1); rc=$?
check "evidence-sha: bump inherits parent" 0 "$rc" "$out" "EVIDENCE_SHA=$green REASON=release-bump-parent"
# 20. an ordinary commit uses its own evidence
out=$(sh "$TRAIN" evidence-sha --sha "$green" --repo "$R" 2>&1); rc=$?
check "evidence-sha: ordinary commit exact" 0 "$rc" "$out" "EVIDENCE_SHA=$green REASON=exact"
# 21. planted: a bump-shaped commit (CHANGELOG + both versions) that also changes source inherits nothing
jq --tab '.version = "0.2.22" | .omp.version = "0.2.22"' "$R/package.json" > "$TMP/pkg" && cp "$TMP/pkg" "$R/package.json"
printf '\n## [0.2.22] - 2026-10-13\n\n### Fixed\n\n- Sneak.\n' >> "$R/CHANGELOG.md"
printf 'sneaked\n' > "$R/src/a.ts"
git -C "$R" commit -q -am "chore: bump version to 0.2.22"
sneak=$(git -C "$R" rev-parse HEAD)
out=$(sh "$TRAIN" evidence-sha --sha "$sneak" --repo "$R" 2>&1); rc=$?
check "evidence-sha: planted source change refused inheritance" 0 "$rc" "$out" "EVIDENCE_SHA=$sneak REASON=bump-shape-mismatch"
# 21b. planted: a bump that changes package.json beyond the two version fields inherits nothing
jq --tab '.version = "0.2.23" | .omp.version = "0.2.23" | .description = "sneaked"' "$R/package.json" > "$TMP/pkg" && cp "$TMP/pkg" "$R/package.json"
git -C "$R" commit -q -am "chore: bump version to 0.2.23"
out=$(sh "$TRAIN" evidence-sha --sha "$(git -C "$R" rev-parse HEAD)" --repo "$R" 2>&1); rc=$?
check "evidence-sha: planted extra package.json field refused inheritance" 0 "$rc" "$out" "REASON=bump-shape-mismatch"
# 22. planted: nothing to release -> refused, no commit, no tag
before=$(git -C "$R" rev-parse HEAD)
out=$(sh "$TRAIN" bump --version 0.2.24 --date 2026-10-12 --repo "$R" 2>&1); rc=$?
check "bump: planted nothing-to-release refused" 4 "$rc" "$out" "BUMP=skip REASON=nothing-to-release" "REFUSED: nothing to release"
check "bump: refusal left HEAD and package.json alone" 0 0 "$(git -C "$R" rev-parse HEAD) $(jq -r .version "$R/package.json")" "$before 0.2.23"

printf '%s pass, %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
