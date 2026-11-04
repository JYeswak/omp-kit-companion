#!/bin/sh
# check-pushed-beads.test.sh — COMMIT1 pre-push bead check contract (ompkit-2w7h).
# A fixture repo with real git objects: good commits pass, a bad-message
# commit is refused naming its sha, including one made by commit-tree (no
# working tree involved). A stub `br` answers show <id>.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-pushed-beads.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
if ! printenv TMPDIR >/dev/null; then KITLIB_TMP_ROOT=$REPO_TMP; fi
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP check-pushed-beads-test || exit 1

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
HOST_PATH=$PATH
export PATH="$TMP/bin:/usr/bin:/bin"
export KNOWN_IDS="ompkit-2w7h rz5.128"

FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q 2>/dev/null
git -C "$FIXTURE" config user.email "test@invalid.example"
git -C "$FIXTURE" config user.name "Test"
git -C "$FIXTURE" commit -q --no-verify --allow-empty --message "root" 2>/dev/null
echo "file" > "$FIXTURE/file.txt"
git -C "$FIXTURE" add file.txt
git -C "$FIXTURE" commit -q --no-verify --message "wire the loop ompkit-2w7h" 2>/dev/null
GOOD=$(git -C "$FIXTURE" rev-parse HEAD)
ROOT=$(git -C "$FIXTURE" rev-parse "$GOOD^")
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$ROOT"
TREE=$(git -C "$FIXTURE" rev-parse "$GOOD^{tree}")
PLANTED=$(git -C "$FIXTURE" commit-tree "$TREE" -p "$GOOD" -m "quiet tweak with no id" 2>/dev/null)

run_case() {
	name=$1
	want_rc=$2
	shift 2
	got_rc=0
	sh "$CHECK" "$@" > "$TMP/stdout" 2> "$TMP/stderr" || got_rc=$?
	if [ "$got_rc" = "$want_rc" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s err<<<%s>>>\n' "$name" "$got_rc" "$want_rc" "$(cat "$TMP/stderr")"; fi
}

DB="$TMP/beads.db"
: > "$DB"
export BEADS_DB="$DB"
export BR_BIN="$TMP/bin/br"

# 1. range with only good commits passes
run_case good-range 0 --repo "$FIXTURE" --base "$ROOT" --tip "$GOOD" --db "$DB" --br "$TMP/bin/br"
# 2. planted commit-tree commit with no id is refused naming its sha
out=$(sh "$CHECK" --repo "$FIXTURE" --base "$GOOD" --tip "$PLANTED" --db "$DB" --br "$TMP/bin/br" 2>&1); rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$PLANTED"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL planted-tree: rc=%s out<<<%s>>>\n' "$rc" "$out"; fi
# 3. missing args refused
run_case missing-args 2 --repo "$FIXTURE"
# 4. unknown tip refused
run_case bad-tip 2 --repo "$FIXTURE" --base "$ROOT" --tip deadbeef --db "$DB" --br "$TMP/bin/br"

# 5. an origin/main commit without a bead is outside the pushed set
ORIGIN_FIXTURE="$TMP/origin-range"
mkdir -p "$ORIGIN_FIXTURE"
git -C "$ORIGIN_FIXTURE" init -q 2>/dev/null
git -C "$ORIGIN_FIXTURE" config user.email "test@invalid.example"
git -C "$ORIGIN_FIXTURE" config user.name "Test"
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --allow-empty --message "root without bead" 2>/dev/null
ORIGIN_BASE=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
echo "main baseline" > "$ORIGIN_FIXTURE/file.txt"
git -C "$ORIGIN_FIXTURE" add file.txt
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --message "origin main baseline without bead" 2>/dev/null
ORIGIN_MAIN=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
git -C "$ORIGIN_FIXTURE" update-ref refs/remotes/origin/main "$ORIGIN_MAIN"
echo "valid candidate" > "$ORIGIN_FIXTURE/file.txt"
git -C "$ORIGIN_FIXTURE" add file.txt
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --message "candidate ompkit-2w7h" 2>/dev/null
ORIGIN_TIP=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
run_case origin-main-without-bead 0 --repo "$ORIGIN_FIXTURE" --base "$ORIGIN_BASE" --tip "$ORIGIN_TIP" --db "$DB" --br "$TMP/bin/br"
# 6. a new bead-less commit remains refused and is identified
echo "bad candidate" > "$ORIGIN_FIXTURE/file.txt"
git -C "$ORIGIN_FIXTURE" add file.txt
git -C "$ORIGIN_FIXTURE" commit -q --no-verify --message "new commit with no bead" 2>/dev/null
NEW_BAD=$(git -C "$ORIGIN_FIXTURE" rev-parse HEAD)
out=$(sh "$CHECK" --repo "$ORIGIN_FIXTURE" --base "$ORIGIN_BASE" --tip "$NEW_BAD" --db "$DB" --br "$TMP/bin/br" 2>&1); rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$NEW_BAD"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL new-idless: rc=%s out<<<%s>>>\n' "$rc" "$out"; fi
# 7. run from outside the repo with no --db: the repo's own tracker still
#    judges the range (planted: before the fix the cwd held no tracker and the
#    id-less commit passed)
mkdir -p "$FIXTURE/.beads"
: > "$FIXTURE/.beads/beads.db"
out=$(CDPATH='' cd -- "$TMP" && env -u BEADS_DB sh "$CHECK" --repo "$FIXTURE" --base "$GOOD" --tip "$PLANTED" --br "$TMP/bin/br" 2>&1); rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$PLANTED"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL outside-cwd-repo-tracker: rc=%s out<<<%s>>>\n' "$rc" "$out"; fi

# 8. PUSHADMIT1 (ompkit-fp72.120.16.221): the reviewed history rewrite push.
#    Real-Git fixture (HISTADMIT1's driver): a bare origin already holding
#    id-less, level-less legacy commits, the full install, one new identified
#    commit, an independent review, and the apply through the installed ref
#    guard. Members 40 and 41 are the installed copies, fed real push lines.
CLI_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALLER=$(CDPATH='' cd -- "$CLI_DIR/../../scripts" && pwd)/install-commit-msg-bead.sh
fx() { (CDPATH='' cd -- "$CLI_DIR" && python3 -B ref-txn-witness-fixtures.py "$@"); }
ok() { # ok <got> <want> <name>
	if [ "$1" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@invalid.example GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@invalid.example
BUILD=$(fx build "$TMP") || { printf 'FAIL history fixture build\n'; exit 1; }
field() { printf '%s\n' "$BUILD" | sed -n "s/^$1 //p"; }
H=$(field repo)
L1=$(field l1)
L2=$(field l2)
git -C "$H" push -q origin "$L2:refs/heads/main" && git -C "$H" fetch -q origin
ok "$?" "0" "legacy-published-before-install"
mkdir -p "$H/.beads"
: > "$H/.beads/beads.db"
# The full installer needs host Node/TypeScript (its import parser); the stub br stays first.
PATH="$TMP/bin:$HOST_PATH" sh "$INSTALLER" "$H" > "$TMP/install.out" 2>&1 || { cat "$TMP/install.out"; false; }
ok "$?" "0" "full-install-rc"
PP="$H/.git/hooks/hooks.d/pre-push"
if [ -x "$PP/40-omp-kit-pushed-beads" ] && [ -x "$PP/41-omp-kit-pushed-vlevel" ] && [ -f "$H/.git/hooks/hooks.d/reference-transaction/ref-txn-witness.py" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "members-and-witness-installed"
N=$(printf '[test] new work ompkit-2w7h\n' | git -C "$H" commit-tree "$L2^{tree}" -p "$L2")
git -C "$H" update-ref refs/heads/main "$N" "$L2"
ok "$?" "0" "new-identified-commit-on-main"
export AGENT_NAME=applier
m40() { # m40 <line>: the installed member 40, as git runs it
	printf '%s\n' "$1" | (CDPATH='' cd -- "$H" && sh "$PP/40-omp-kit-pushed-beads" origin "$ORIGIN_URL") 2> "$TMP/m40.err"
}
m41() {
	printf '%s\n' "$1" | (CDPATH='' cd -- "$H" && sh "$PP/41-omp-kit-pushed-vlevel" origin "$ORIGIN_URL") 2> "$TMP/m41.err"
}
ORIGIN_URL=$(field origin)
# Ordinary pushes are unchanged: no reviewed plan exists, no witness runs.
m40 "refs/heads/main $N refs/heads/main $L2"
ok "$?" "0" "ordinary-identified-push-40"
ok "$(cat "$TMP/m40.err")" "" "ordinary-push-40-silent"
m41 "refs/heads/main $N refs/heads/main $L2"
ok "$?" "0" "ordinary-identified-push-41"

fx rewrite "$H" "$H/.git/scrub.map.json" --l1 "$L1" --l2 "$L2" "$N" > /dev/null
read -r SHA NEW <<EOF
$(fx plan "$H" "$H/.git/scrub.map.json" "$H/.git/scrub.plan.json" --old "$N" --public "$L2" --authority J-TEST-scrub)
EOF
RTX="$H/.git/hooks/hooks.d/reference-transaction"
W="$RTX/ref-txn-witness.py"
(CDPATH='' cd -- "$H" && AGENT_NAME=independent-reviewer python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' "$W" review --plan "$H/.git/scrub.plan.json" --reviewer independent-reviewer) > /dev/null
ok "$?" "0" "independent-review-rc"
REC="$H/.git/omp-kit/history-review/$SHA.json"
if [ -f "$H/.git/omp-kit/history-review/$SHA.plan.json" ] && [ ! -w "$H/.git/omp-kit/history-review/$SHA.plan.json" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "reviewed-plan-copy-read-only"
ok "$(fx drive "$H" "$H/.git/scrub.plan.json" 2> "$TMP/apply.err")" "COMMITTED" "reviewed-apply-through-ref-guard"
ok "$(git -C "$H" rev-parse refs/heads/main)" "$NEW" "local-main-is-new-root"

# The unchanged pre-push chain would refuse the rewrite if judged as new history.
REWRITE_LINE="refs/heads/main $NEW refs/heads/main $L2"
E=$(printf '[test] extra on the rewrite ompkit-2w7h\n' | git -C "$H" commit-tree "$NEW^{tree}" -p "$NEW")
CLONE="$TMP/elsewhere"
git clone -q "$ORIGIN_URL" "$CLONE" 2> /dev/null
S=$(printf '[test] origin moved ompkit-2w7h\n' | git -C "$CLONE" commit-tree "$L2^{tree}" -p "$L2")

# neg <mode> <name> <reason>: both members refuse (normal) or both admit (mutant)
neg() {
	mode=$1 name=$2 reason=$3 line=$4
	for member in m40 m41; do
		"$member" "$line"
		got=$?
		if [ "$mode" = normal ]; then
			ok "$got" "4" "$mode-$name-$member-refused"
			grep -qF -- "$reason" "$TMP/$member.err"
			ok "$?" "0" "$mode-$name-$member-reason"
		else
			ok "$got" "0" "$mode-$name-$member-admitted-without-verification"
		fi
	done
}
negatives() {
	m=$1
	neg "$m" unmapped-extra "REFUSED PUSH_TIP_NOT_REVIEWED_NEW_ROOT" "refs/heads/main $E refs/heads/main $L2"
	mv "$REC" "$TMP/rec.saved"
	neg "$m" review-absent "REFUSED REVIEW_ABSENT" "$REWRITE_LINE"
	mv "$TMP/rec.saved" "$REC"
	chmod u+w "$REC"
	sed 's/"reviewer":"independent-reviewer"/"reviewer":"someone-else"/' "$TMP/rec.orig" > "$REC"
	chmod 0400 "$REC"
	if cmp -s "$REC" "$TMP/rec.orig"; then rc=1; else rc=0; fi
	ok "$rc" "0" "$m-tamper-applied"
	neg "$m" review-tampered "REFUSED REVIEW_DIGEST_MISMATCH" "$REWRITE_LINE"
	chmod u+w "$REC"
	cat "$TMP/rec.orig" > "$REC"
	chmod 0400 "$REC"
	AGENT_NAME=independent-reviewer
	neg "$m" reviewer-is-pusher "REFUSED REVIEWER_IS_APPLIER" "$REWRITE_LINE"
	AGENT_NAME=
	neg "$m" pusher-unnamed "REFUSED APPLIER_NAME_ABSENT" "$REWRITE_LINE"
	AGENT_NAME=applier
	git -C "$CLONE" push -q --no-verify origin "$S:refs/heads/main" && git -C "$H" fetch -q origin
	ok "$?" "0" "$m-origin-moved"
	neg "$m" stale-lease "REFUSED STALE_LEASE" "refs/heads/main $NEW refs/heads/main $S"
	git -C "$CLONE" push -q --no-verify --force origin "$L2:refs/heads/main" && git -C "$H" fetch -q --force origin "+refs/heads/main:refs/remotes/origin/main"
	ok "$?" "0" "$m-origin-restored"
}
cp "$REC" "$TMP/rec.orig"
negatives normal
# A real push of an unmapped extra commit is refused and origin stays put.
git -C "$H" push -q --force-with-lease="refs/heads/main:$L2" origin "$E:refs/heads/main" 2> /dev/null
ok "$?" "1" "real-push-unmapped-extra-refused"
ok "$(git --git-dir="$ORIGIN_URL" rev-parse refs/heads/main)" "$L2" "real-push-refused-origin-unchanged"

# Mutant: the installed witness with its push verification removed; every
# negative is then admitted, so the verification is what refuses them.
cp -p "$W" "$TMP/witness.shipped"
chmod u+w "$W"
sed 's/^\(    summary = \)verify_push(.*# PUSH-VALIDATION$/\1"PUSH-VALIDATION-REMOVED"/' "$TMP/witness.shipped" > "$W"
if cmp -s "$W" "$TMP/witness.shipped"; then rc=1; else rc=0; fi
ok "$rc" "0" "mutant-differs"
negatives mutant
cat "$TMP/witness.shipped" > "$W"
cmp -s "$W" "$(dirname -- "$INSTALLER")/ref-txn-witness.py"
ok "$?" "0" "mutant-restored"

# The paired admitted control: the exact reviewed rewrite, by both members and by a real lease push.
m40 "$REWRITE_LINE"
ok "$?" "0" "reviewed-rewrite-admitted-40"
grep -qF "ref-txn-witness: ADMITTED reviewed rewrite push plan=$SHA" "$TMP/m40.err"
ok "$?" "0" "reviewed-rewrite-provenance-40"
m41 "$REWRITE_LINE"
ok "$?" "0" "reviewed-rewrite-admitted-41"
git -C "$H" push -q --force-with-lease="refs/heads/main:$L2" origin main:refs/heads/main 2> "$TMP/push.err"
ok "$?" "0" "real-reviewed-push-rc"
ok "$(git --git-dir="$ORIGIN_URL" rev-parse refs/heads/main)" "$NEW" "origin-is-new-root"

printf 'check-pushed-beads: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
