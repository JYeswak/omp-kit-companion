#!/bin/sh
# candidate-failure.test.sh — fp72.49 post-cert failure contract (ompkit-fp72.49).
# Stub `git`/`gh` serve canned tags, jobs and issue creation; every verdict
# comes from the script's exit code plus its stdout and the recorded issue.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/candidate-failure.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/candidate-failure-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

SHA_BUMP="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_OTHER="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

stub_tools() {
	mkdir -p "$TMP/bin"
	cat > "$TMP/bin/git" <<EOF
#!/bin/sh
if [ "\$1" = "rev-parse" ]; then
	printf '%s' '$GIT_TAG_SHA'
elif [ "\$1" = "diff" ]; then
	printf '%s' '$GIT_DIFFSTAT'
else
	exit 9
fi
EOF
	cat > "$TMP/bin/gh" <<EOF
#!/bin/sh
if [ "\$1" = "api" ]; then
	printf '%s' '$GH_JOBS'
elif [ "\$1" = "issue" ] && [ "\$2" = "create" ]; then
	printf '%s\n' "\$*" >> "$TMP/issues"
	cp "\$8" "$TMP/body" 2>/dev/null || cp "\$7" "$TMP/body"
else
	exit 9
fi
EOF
	chmod +x "$TMP/bin/git" "$TMP/bin/gh"
	export PATH="$TMP/bin:/usr/bin:/bin"
	: > "$TMP/issues"
	: > "$TMP/body"
}

pass=0
fail=0
run_case() {
	name=$1
	want_rc=$2
	: > "$TMP/issues"
	: > "$TMP/body"
	out="$(sh "$CHECK" --repo o/r --version "$3" --sha "$4" --run-id 7 2>&1)"
	got_rc=$?
	ok=1
	[ "$got_rc" = "$want_rc" ] || ok=0
	shift 4
	for want in "$@"; do
		case "$want" in
			ISSUE:*) [ -s "$TMP/issues" ] || ok=0; printf '%s\n' "$(cat "$TMP/issues")" | grep -qF "${want#ISSUE:}" || ok=0 ;;
			NOISSUE) [ -s "$TMP/issues" ] && ok=0 ;;
			BODY:*) printf '%s\n' "$(cat "$TMP/body")" | grep -qF "${want#BODY:}" || ok=0 ;;
			OUT:*) printf '%s\n' "$out" | grep -qF "${want#OUT:}" || ok=0 ;;
		esac
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>> issues<<<%s>>> body<<<%s>>>\n' "$name" "$got_rc" "$out" "$(cat "$TMP/issues")" "$(cat "$TMP/body")"; fi
}

FAIL_JOBS="native-certification (darwin-arm64-none, certified, 18.8.6)	failure"

# 1. post-cert failure opens a P0 issue carrying version, sha, run and jobs
GIT_TAG_SHA="$SHA_BUMP"
GIT_DIFFSTAT=" CHANGELOG.md | 10 +++++-----"
GH_JOBS="$FAIL_JOBS"
stub_tools
run_case post-cert-failure 0 "0.2.33" "$SHA_BUMP" "ISSUE:[P0] candidate failed after green-certified bump v0.2.33" "BODY:https://github.com/o/r/actions/runs/7" "BODY:$SHA_BUMP" "BODY:native-certification (darwin-arm64-none, certified, 18.8.6)" "OUT:opened P0 issue"

# 2. planted: tag mismatch opens nothing (not a post-cert run)
GIT_TAG_SHA="$SHA_OTHER"
GIT_DIFFSTAT=" CHANGELOG.md | 10 +++++-----"
GH_JOBS="$FAIL_JOBS"
stub_tools
run_case tag-mismatch 0 "0.2.33" "$SHA_BUMP" NOISSUE "OUT:does not name"

# 3. rehearsal-shaped versions never reach this job: strict X.Y.Z refuses them loud, never issues
GIT_TAG_SHA="$SHA_BUMP"
GIT_DIFFSTAT=" CHANGELOG.md | 10 +++++-----"
GH_JOBS="$FAIL_JOBS"
stub_tools
run_case rehearsal-shaped 2 "0.2.33-rehearsal.7.1" "$SHA_BUMP" NOISSUE "OUT:version must be X.Y.Z"

# 4. planted: no failed jobs opens nothing
GIT_TAG_SHA="$SHA_BUMP"
GIT_DIFFSTAT=" CHANGELOG.md | 10 +++++-----"
GH_JOBS=""
stub_tools
run_case no-failed-jobs 0 "0.2.33" "$SHA_BUMP" NOISSUE "OUT:no failed jobs"

# 5. bad sha fails loud
GIT_TAG_SHA="$SHA_BUMP"
GIT_DIFFSTAT=""
GH_JOBS="$FAIL_JOBS"
stub_tools
run_case bad-sha 2 "0.2.33" "xyz" NOISSUE

printf 'candidate-failure: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
