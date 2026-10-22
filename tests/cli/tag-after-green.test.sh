#!/bin/sh
# tag-after-green.test.sh — fp72.49 stage-2 match/tag contract (ompkit-fp72.49).
# Stub `git`/`gh` serve canned refs and jobs; every verdict comes from the
# script's exit code plus its stdout and the recorded push/dispatch lines.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/tag-after-green.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP tag-after-green-test || exit 1

SHA_BUMP="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_OTHER="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

stub_tools() {
	mkdir -p "$TMP/bin"
	cat > "$TMP/bin/git" <<EOF
#!/bin/sh
if [ "\$1" = "ls-remote" ] && [ "\$2" = "origin" ] && [ "\$3" = "refs/train/pending-v*" ]; then
	printf '%s' '$GIT_REFS'
elif [ "\$1" = "ls-remote" ] && [ "\$2" = "--tags" ]; then
	printf '%s' '$GIT_TAGS'
elif [ "\$1" = "push" ] && [ "\$2" = "--atomic" ]; then
	printf '%s\n' "\$*" >> "$TMP/pushes"
else
	exit 9
fi
EOF
	cat > "$TMP/bin/gh" <<EOF
#!/bin/sh
if [ "\$1" = "api" ]; then
	printf '%s' '$GH_JOBS'
elif [ "\$1" = "workflow" ] && [ "\$2" = "run" ]; then
	printf '%s\n' "\$*" >> "$TMP/dispatches"
else
	exit 9
fi
EOF
	chmod +x "$TMP/bin/git" "$TMP/bin/gh"
	export PATH="$TMP/bin:/usr/bin:/bin"
	: > "$TMP/pushes"
	: > "$TMP/dispatches"
}

pass=0
fail=0
run_case() {
	name=$1
	want_rc=$2
	: > "$TMP/pushes"
	: > "$TMP/dispatches"
	out="$(sh "$CHECK" --repo o/r --run-id 1 --head-sha "$3" 2>&1)"
	got_rc=$?
	ok=1
	[ "$got_rc" = "$want_rc" ] || ok=0
	shift 3
	for want in "$@"; do
		case "$want" in
			PUSH:*) printf '%s\n' "$(cat "$TMP/pushes")" | grep -qF "${want#PUSH:}" || ok=0 ;;
			NOPUSH) [ -s "$TMP/pushes" ] && ok=0 ;;
			DISPATCH:*) printf '%s\n' "$(cat "$TMP/dispatches")" | grep -qF "${want#DISPATCH:}" || ok=0 ;;
			NODISPATCH) [ -s "$TMP/dispatches" ] && ok=0 ;;
			OUT:*) printf '%s\n' "$out" | grep -qF "${want#OUT:}" || ok=0 ;;
		esac
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>> pushes<<<%s>>> dispatches<<<%s>>>\n' "$name" "$got_rc" "$out" "$(cat "$TMP/pushes")" "$(cat "$TMP/dispatches")"; fi
}

GREEN_JOBS="native-certification (darwin-arm64-none, certified, 18.8.6)	success
native-certification (darwin-arm64-none, minimum, 18.4.2)	success
native-certification (linux-arm64-gnu, certified, 18.8.6)	success
native-certification (linux-arm64-gnu, minimum, 18.4.2)	success
native-certification (linux-x64-gnu, certified, 18.8.6)	success
native-certification (linux-x64-gnu, minimum, 18.4.2)	success"
RED_JOBS="native-certification (darwin-arm64-none, certified, 18.8.6)	failure
native-certification (darwin-arm64-none, minimum, 18.4.2)	success
native-certification (linux-arm64-gnu, certified, 18.8.6)	success
native-certification (linux-arm64-gnu, minimum, 18.4.2)	success
native-certification (linux-x64-gnu, certified, 18.8.6)	success
native-certification (linux-x64-gnu, minimum, 18.4.2)	success"
RUNNING_JOBS="native-certification (darwin-arm64-none, certified, 18.8.6)	null
native-certification (darwin-arm64-none, minimum, 18.4.2)	success
native-certification (linux-arm64-gnu, certified, 18.8.6)	success
native-certification (linux-arm64-gnu, minimum, 18.4.2)	success
native-certification (linux-x64-gnu, certified, 18.8.6)	success
native-certification (linux-x64-gnu, minimum, 18.4.2)	success"

# 1. recorded bump + green cert tags, retires the ref, dispatches the candidate
GIT_REFS="$SHA_BUMP	refs/train/pending-v0.2.33"
GIT_TAGS=""
GH_JOBS="$GREEN_JOBS"
stub_tools
run_case match-green 0 "$SHA_BUMP" "OUT:tagged v0.2.33 on $SHA_BUMP" "PUSH:$SHA_BUMP:refs/tags/v0.2.33" "PUSH::refs/train/pending-v0.2.33" "DISPATCH:release.yml"

# 2. planted: green run for a different SHA creates no tag
GIT_REFS="$SHA_BUMP	refs/train/pending-v0.2.33"
GIT_TAGS=""
GH_JOBS="$GREEN_JOBS"
stub_tools
run_case green-other-sha 0 "$SHA_OTHER" "OUT:not a recorded train bump" NOPUSH NODISPATCH

# 3. planted: red cert on the bump SHA creates no tag
GIT_REFS="$SHA_BUMP	refs/train/pending-v0.2.33"
GIT_TAGS=""
GH_JOBS="$RED_JOBS"
stub_tools
run_case red-cert 0 "$SHA_BUMP" "OUT:not green for darwin-arm64-none" NOPUSH NODISPATCH
GIT_REFS="$SHA_BUMP	refs/train/pending-v0.2.33"
GIT_TAGS=""
GH_JOBS="$RUNNING_JOBS"
stub_tools
run_case running-cert 0 "$SHA_BUMP" "OUT:not green for darwin-arm64-none" NOPUSH NODISPATCH

# 5. planted: already-tagged version creates no second tag
GIT_REFS="$SHA_BUMP	refs/train/pending-v0.2.33"
GIT_TAGS="$SHA_BUMP	refs/tags/v0.2.33"
GH_JOBS="$GREEN_JOBS"
stub_tools
run_case tag-exists 0 "$SHA_BUMP" "OUT:already tagged" NOPUSH NODISPATCH

# 6. planted: missing platform legs create no tag
GIT_REFS="$SHA_BUMP	refs/train/pending-v0.2.33"
GIT_TAGS=""
GH_JOBS="native-certification (darwin-arm64-none, certified, 18.8.6)	success"
stub_tools
run_case missing-legs 0 "$SHA_BUMP" "OUT:no native-certification legs for linux-arm64-gnu" NOPUSH NODISPATCH

# 7. planted: malformed recorded version fails loud, never tags
GIT_REFS="$SHA_BUMP	refs/train/pending-v9.9"
GIT_TAGS=""
GH_JOBS="$GREEN_JOBS"
stub_tools
run_case bad-version 2 "$SHA_BUMP" "OUT:recorded version is malformed" NOPUSH NODISPATCH

# 8. bad usage fails loud
out="$(sh "$CHECK" --repo o/r --run-id 1 --head-sha xyz 2>&1)"
if [ "$?" = "2" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL bad-usage: rc=%s out<<<%s>>>\n' "$?" "$out"; fi

printf 'tag-after-green: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
