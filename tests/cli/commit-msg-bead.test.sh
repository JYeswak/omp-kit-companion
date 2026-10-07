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
export KNOWN_IDS="ompkit-2w7h ompkit-2w7h.1 rz5.128 cfs-twenty-app-portfolio-hgub5.2.5 uds-6z2r ompkit-kxdy ompkit-rc-epic-land-fix-release-dogfood-rz5.121.1"

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
# 5. cfsios-shaped id passes when the tracker knows it (planted)
run_case cfs-id 0 "port the app cfs-twenty-app-portfolio-hgub5.2.5"
# 6. uds-shaped id passes when the tracker knows it (planted)
run_case uds-id 0 "fix the lane uds-6z2r"
# 6b. digit-less real id passes: existence comes from br, not token shape (planted)
run_case digitless-id 0 "polish the copy ompkit-kxdy"
# 6c. digit-less made-up id is refused by br, not by shape (planted)
run_case digitless-unknown 4 "polish the copy ompkit-zzqy"
# 6d. a resolvable bead after 36 earlier lexical tokens survives the 20-candidate cap
LONG_PREFIX="a000 a001 a002 a003 a004 a005 a006 a007 a008 a009 a010 a011 a012 a013 a014 a015 a016 a017 a018 a019 a020 a021 a022 a023 a024 a025 a026 a027 a028 a029 a030 a031 a032 a033 a034 a035"
LC_ALL=C run_case long-valid-id 0 "$LONG_PREFIX ompkit-rc-epic-land-fix-release-dogfood-rz5.121.1"
# A bead-shaped but unknown id is still refused after prioritization.
LC_ALL=C run_case long-unknown-id 4 "$LONG_PREFIX ompkit-nope9"
# 7. a bare version number is not a bead id (planted)
run_case version-only 4 "upgrade bun 1.4.2"
# 8. merge source is exempt
run_case merge-exempt 0 "Merge branch main into x" "merge"
# 9. missing message file skips
if sh "$HOOK" "$TMP/absent" > /dev/null 2>&1; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL missing-file\n'; fi
# 10. no tracker skips without blocking
printf '%s\n' "fix widgets ompkit-2w7h" > "$TMP/msg"
if BEADS_DB="$TMP/absent.db" sh "$HOOK" "$TMP/msg" > /dev/null 2>&1; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL no-tracker\n'; fi

printf 'commit-msg-bead: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
