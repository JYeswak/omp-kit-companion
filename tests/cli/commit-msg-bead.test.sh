#!/bin/sh
# commit-msg-bead.test.sh — COMMIT1 hook contract (ompkit-2w7h).
# A stub `br` answers show <id> with rc 0 for known ids, rc 3 otherwise.
# Every verdict comes from the hook's exit code; the real tracker is untouched.
set -u

HOOK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/commit-msg-bead-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
mkdir -p "$TMP/bin"
cat > "$TMP/bin/br" <<EOF
#!/bin/sh
id=""
for arg in "\$@"; do id="\$arg"; done
case " \$KNOWN_IDS " in
	*" \$id "*) exit 0 ;;
	*) exit 3 ;;
esac
EOF
chmod +x "$TMP/bin/br"
export PATH="$TMP/bin:/usr/bin:/bin"
export BR_BIN="$TMP/bin/br"
export BEADS_DB="$TMP/beads.db"
: > "$BEADS_DB"
export KNOWN_IDS="ompkit-2w7h rz5.128"

run_case() {
	name=$1
	want_rc=$2
	printf '%s\n' "$3" > "$TMP/msg"
	got_rc=0
	if [ $# -ge 4 ]; then
		sh "$HOOK" "$TMP/msg" "$4" > "$TMP/stdout" 2> "$TMP/stderr" || got_rc=$?
	else
		sh "$HOOK" "$TMP/msg" > "$TMP/stdout" 2> "$TMP/stderr" || got_rc=$?
	fi
	if [ "$got_rc" = "$want_rc" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s err<<<%s>>>\n' "$name" "$got_rc" "$want_rc" "$(cat "$TMP/stderr")"; fi
}

# 1. full bead id passes
run_case full-id 0 "fix widgets ompkit-2w7h"
# 2. nickname only is refused (planted)
run_case nickname-only 4 "fix widgets ID1"
# 3. unknown id is refused (planted)
run_case unknown-id 4 "fix widgets ompkit-nope9"
# 4. short rz form passes when the tracker knows it
run_case short-id 0 "wire the loop rz5.128"
# 5. merge source is exempt
run_case merge-exempt 0 "Merge branch main into x" "merge"
# 6. missing message file skips
if sh "$HOOK" "$TMP/absent" > /dev/null 2>&1; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL missing-file\n'; fi
# 7. no tracker skips without blocking
printf '%s\n' "fix widgets ompkit-2w7h" > "$TMP/msg"
if BEADS_DB="$TMP/absent.db" sh "$HOOK" "$TMP/msg" > /dev/null 2>&1; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL no-tracker\n'; fi

printf 'commit-msg-bead: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
