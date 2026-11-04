#!/bin/sh
# ref-txn-bead.test.sh — COMMIT1 plumbing backstop (ompkit-2w7h).
# Real git dispatches the installed reference-transaction chain: plumbing
# (commit-tree + update-ref) and --no-verify must not put an id-less commit
# on main, while ordinary work, merges, other refs and commits already on
# origin flow. A stub br answers `show <id>` from KNOWN_IDS (real tracker
# untouched); every verdict is git's own exit code plus the resulting ref.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO_TMP/../../scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP ref-txn-bead-test || exit 1

pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}
refused() { # refused <rc> <name>: git must have refused (any nonzero exit)
	if [ "$1" -ne 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s: git accepted (rc 0)\n' "$2"; fi
}

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
export BR_BIN="$TMP/bin/br"
export BEADS_DB="$TMP/beads.db"
: > "$BEADS_DB"
export KNOWN_IDS="ompkit-2w7h"
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@invalid.example GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@invalid.example

git init -q --bare "$TMP/origin.git"
R="$TMP/repo"
git init -q -b main "$R"
rm -f "$R/.git/hooks/commit-msg" "$R/.git/hooks/commit-msg-"*
git -C "$R" remote add origin "$TMP/origin.git"
git -C "$R" commit -q --allow-empty -m "root ompkit-2w7h"
git -C "$R" push -q origin main
# An id-less commit already on main before the guard exists (legacy history).
git -C "$R" commit -q --allow-empty -m "legacy commit with no identity"
LEGACY=$(git -C "$R" rev-parse HEAD)
sh "$INSTALLER" "$R" > "$TMP/install.out" 2>&1
ok "$?" "0" "install-rc"
if [ -x "$R/.git/hooks/reference-transaction" ] && [ -x "$R/.git/hooks/hooks.d/reference-transaction/40-omp-kit-ref-txn-bead" ] && [ ! -x "$R/.git/hooks/hooks.d/reference-transaction/commit-msg-bead.sh" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "member-installed-helper-inert"

plant() { # plant <message>: id-less or id'd commit object on main's tip, no ref moved
	printf '%s\n' "$1" | git -C "$R" commit-tree "$(git -C "$R" rev-parse 'HEAD^{tree}')" -p "$(git -C "$R" rev-parse HEAD)"
}

# 1. plumbing: id-less commit-tree + CAS update-ref of main is refused; main unmoved (planted)
BEFORE=$(git -C "$R" rev-parse HEAD)
P=$(plant "plumbing commit with no identity")
git -C "$R" update-ref refs/heads/main "$P" "$BEFORE" 2> "$TMP/err1"; refused "$?" "plumbing-idless-refused"
ok "$(git -C "$R" rev-parse HEAD)" "$BEFORE" "plumbing-idless-main-unmoved"
grep -q "ref-txn-bead: refusing refs/heads/main update: commit $P" "$TMP/err1"
ok "$?" "0" "plumbing-idless-names-commit"

# 2. plumbing with a real bead id moves main
P2=$(plant "plumbing fix ompkit-2w7h")
git -C "$R" update-ref refs/heads/main "$P2" "$BEFORE" 2> /dev/null
ok "$?" "0" "plumbing-with-id-rc"
ok "$(git -C "$R" rev-parse HEAD)" "$P2" "plumbing-with-id-moved"

# 3. ordinary commit naming a bead passes both commit-msg and the ref guard
git -C "$R" commit -q --allow-empty -m "[test] fix widgets ompkit-2w7h" 2> /dev/null
ok "$?" "0" "normal-commit-with-id"

# 4. --no-verify skips commit-msg, but the ref guard still refuses (planted)
BEFORE=$(git -C "$R" rev-parse HEAD)
git -C "$R" commit -q --no-verify --allow-empty -m "sneak past with no identity" 2> /dev/null; refused "$?" "no-verify-idless-refused"
ok "$(git -C "$R" rev-parse HEAD)" "$BEFORE" "no-verify-idless-main-unmoved"

# 5. any ref other than main is not the guard's business
P5=$(plant "side work with no identity")
git -C "$R" update-ref refs/heads/side "$P5" 2> /dev/null
ok "$?" "0" "other-ref-flows"

# 6. only new commits are judged: legacy id-less history below main does not
#    block a new, identified commit, even with no old value given
git -C "$R" merge-base --is-ancestor "$LEGACY" HEAD
ok "$?" "0" "legacy-still-below-main"
P6=$(plant "next fix ompkit-2w7h")
git -C "$R" update-ref refs/heads/main "$P6" 2> /dev/null
ok "$?" "0" "no-old-value-judges-only-new"

# 7. no old value and an id-less commit: still refused (planted)
BEFORE=$(git -C "$R" rev-parse HEAD)
P7=$(plant "unconditional update with no identity")
git -C "$R" update-ref refs/heads/main "$P7" 2> /dev/null; refused "$?" "no-old-value-idless-refused"
ok "$(git -C "$R" rev-parse HEAD)" "$BEFORE" "no-old-value-main-unmoved"

# 8. a merge commit is exempt (its parents are judged, not its message)
git -C "$R" update-ref refs/heads/topic "$(plant "topic fix ompkit-2w7h")"
git -C "$R" merge -q --no-ff --no-verify -m "merge topic" topic 2> /dev/null
ok "$?" "0" "merge-flows"
ok "$(git -C "$R" rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" "3" "merge-really-merged"

# 9. commits already on origin are not judged (published history)
C="$TMP/clone"
git clone -q "$TMP/origin.git" "$C"
# --no-verify: the clone inherits any global hook template; a peer without
# the kit hooks publishes id-less work this way.
git -C "$C" commit -q --no-verify --allow-empty -m "published elsewhere with no identity"
git -C "$C" push -q origin HEAD:refs/heads/main
git -C "$R" fetch -q origin
ok "$?" "0" "fetch-flows"
PUB=$(git -C "$R" rev-parse origin/main)
ok "$(git -C "$R" log -1 --format=%s "$PUB")" "published elsewhere with no identity" "published-commit-on-origin"
git -C "$R" merge -q --no-ff --no-verify -m "merge published" "$PUB" 2> /dev/null
ok "$?" "0" "published-idless-not-judged"
git -C "$R" merge-base --is-ancestor "$PUB" HEAD
ok "$?" "0" "published-commit-merged"

# 10. a repo with no tracker is never blocked
BEFORE=$(git -C "$R" rev-parse HEAD)
P10=$(plant "untracked repo work with no identity")
env -u BEADS_DB git -C "$R" update-ref refs/heads/main "$P10" "$BEFORE" 2> /dev/null
ok "$?" "0" "no-tracker-flows"

# 11. HISTADMIT1 (ompkit-2w7h.3): a reviewed history transform. A disposable
#     fixture (its repo and origin inside this test's owned tmp) holds id-less
#     legacy history on main; the transform removes raw.bin, keeps every
#     message and drops the rewritten commit's signature. The fixture emulates
#     the history helper's HISTPREP1 owner lock and journal around a live
#     `git update-ref --stdin`, so Git runs the installed chain itself.
CLI_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
WITNESS_SRC="$(dirname -- "$INSTALLER")/ref-txn-witness.py"
# Fixture paths are absolute, so the driver runs from its own directory.
fx() { (CDPATH='' cd -- "$CLI_DIR" && python3 -B ref-txn-witness-fixtures.py "$@"); }
witness() { # witness <repo> <args...>: the product reader, run from the repository like the guard runs it
	wrepo=$1
	shift
	(CDPATH='' cd -- "$wrepo" && python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' "$WITNESS_SRC" "$@")
}
BUILD=$(fx build "$TMP") || { printf 'FAIL history fixture build\n'; exit 1; }
field() { printf '%s\n' "$BUILD" | sed -n "s/^$1 //p"; }
H=$(field repo)
ROOT=$(field root)
L1=$(field l1)
L2=$(field l2)
sh "$INSTALLER" "$H" > "$TMP/hist-install.out" 2>&1
ok "$?" "0" "history-install-rc"
RTX="$H/.git/hooks/hooks.d/reference-transaction"
if [ -f "$RTX/ref-txn-witness.py" ] && [ ! -x "$RTX/ref-txn-witness.py" ] && [ -f "$RTX/pysafe.py" ] && [ ! -x "$RTX/pysafe.py" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "witness-reader-installed-inert"
cmp -s "$RTX/ref-txn-witness.py" "$WITNESS_SRC"
ok "$?" "0" "witness-reader-byte-equal"

refs_now() { git -C "$H" for-each-ref --format='%(refname) %(objectname)'; git -C "$H" symbolic-ref HEAD; }
mkmap() { # mkmap <name> [rewrite variant flags]: old->new map over main and the published root
	name=$1
	shift
	fx rewrite "$H" "$H/.git/$name.map.json" --l1 "$L1" --l2 "$L2" "$@" "$L2" "$ROOT"
}
mkplan() { # mkplan <name> <map> [plan flags]: prints "<plan_sha256> <new_tip>"
	name=$1
	map=$2
	shift 2
	fx plan "$H" "$H/.git/$map.map.json" "$H/.git/$name.plan.json" --old "$L2" --public "$ROOT" --authority "J-TEST-$name" "$@"
}
forge() { # forge <plan> <reviewer> [forge flags]: a review record in the reader's own format
	plan=$1
	reviewer=$2
	shift 2
	fx forge-review "$H" "$H/.git/$plan.plan.json" --reviewer "$reviewer" "$@" > /dev/null
}
for variant in good conflict:--wrong-parent tree:--drop-extra retained:--keep-path metadata:--alter-message signature:--keep-signature; do
	case "$variant" in
		*:*) mkmap "${variant%%:*}" "${variant#*:}" ;;
		*) mkmap "$variant" ;;
	esac
done
read -r SHA_P NEW <<EOF
$(mkplan reviewed good)
EOF
PLAN_P="$H/.git/reviewed.plan.json"
for name in noreview altered writable applier othertip wrongref; do mkplan "$name" good > /dev/null; done
mkplan wrongrepo good --repo-override "$TMP/elsewhere" > /dev/null
mkplan incomplete good --drop-key "$ROOT" > /dev/null
SIDE=$(printf 'side work ompkit-2w7h\n' | git -C "$H" commit-tree "$ROOT^{tree}" -p "$ROOT")
mkplan extra good --add-key "$SIDE" > /dev/null
for name in conflict tree retained metadata signature; do mkplan "$name" "$name" > /dev/null; done

# The product reviewer refuses an unreviewable transform and records nothing.
witness "$H" review --plan "$H/.git/tree.plan.json" --reviewer independent-reviewer > /dev/null 2> "$TMP/review-bad.err"
ok "$?" "4" "review-refuses-unapproved-tree"
grep -q 'REFUSED UNAPPROVED_TREE_CHANGE' "$TMP/review-bad.err"
ok "$?" "0" "review-refusal-reason"
TREE_SHA=$(sed -n 's/.*"plan_sha256": "\([0-9a-f]*\)".*/\1/p' "$H/.git/tree.plan.json")
if [ -n "$TREE_SHA" ] && [ ! -e "$H/.git/omp-kit/history-review/$TREE_SHA.json" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "review-refusal-records-nothing"
# The independent reviewer records the exact transform once, read-only.
witness "$H" review --plan "$PLAN_P" --reviewer independent-reviewer > "$TMP/review.out"
ok "$?" "0" "review-rc"
REC_P="$H/.git/omp-kit/history-review/$SHA_P.json"
if [ -r "$REC_P" ] && [ ! -w "$REC_P" ] && grep -q '"status": "REVIEWED"' "$TMP/review.out"; then rc=0; else rc=1; fi
ok "$rc" "0" "review-recorded-read-only"
witness "$H" review --plan "$PLAN_P" --reviewer another-reviewer > /dev/null 2> "$TMP/review-again.err"
ok "$?" "4" "review-once-only"
forge altered reviewer --alter-after-digest
forge writable reviewer --writable
forge applier applier
forge othertip reviewer --set "new_tip=\"$L1\""
forge wrongref reviewer --set 'ref="refs/heads/dev"'
for name in wrongrepo incomplete extra conflict tree retained metadata signature; do forge "$name" reviewer; done

PRE="refs/preserve/history-scrub/$L2"
txn() { # txn <main new> <main old> [extra command]: the helper transaction as a JSON list
	printf '["create %s/main %s", "create %s/public/heads/main %s", "update refs/heads/main %s %s"%s]' "$PRE" "$L2" "$PRE" "$ROOT" "$1" "$2" "${3:+, \"$3\"}"
}
REVIEWED_TX=$(txn "$NEW" "$L2")
EXTRA_TX=$(txn "$NEW" "$L2" "create refs/heads/extra $ROOT")
D=$(printf 'descendant with no identity\n' | git -C "$H" commit-tree "$NEW^{tree}" -p "$NEW")
DESC_TX=$(txn "$D" "$L2")
C=$(printf 'forward fix ompkit-2w7h\n' | git -C "$H" commit-tree "$L2^{tree}" -p "$L2")
STALE_TX=$(txn "$NEW" "$C")

# case_ <mode> <name> <reason> <admit | reason without validation> <drive command...>
# normal: Git must refuse at prepare, for the named reason, with refs unchanged.
# mutant (witness validation removed): "admit" cases must prepare (then abort, refs unchanged);
# the rest must still be refused, for the reason given.
case_() {
	mode=$1
	name=$2
	want=$3
	under=$4
	shift 4
	before=$(refs_now)
	if [ "$mode" = mutant ]; then out=$("$@" --prepare-only 2> "$TMP/case.err"); else out=$("$@" 2> "$TMP/case.err"); fi
	crc=$?
	ok "$(refs_now)" "$before" "$mode-$name-refs-unchanged"
	if [ "$mode" = mutant ] && [ "$under" = admit ]; then
		ok "$out" "PREPARED_OK" "$mode-$name-admitted-without-validation"
		return
	fi
	[ "$mode" = normal ] || want=$under
	refused "$crc" "$mode-$name-refused"
	ok "$out" "PREPARE_REFUSED" "$mode-$name-prepare-refused"
	if grep -qF -- "$want" "$TMP/case.err"; then
		pass=$((pass + 1))
		printf '  %s %-22s %s\n' "$mode" "$name" "$(grep -m 1 -o -e 'REFUSED [A-Z_]*[ a-z_]*' -e 'names no existing bead id' -e 'witness reader is missing' "$TMP/case.err")"
	else
		fail=$((fail + 1))
		printf 'FAIL %s-%s: reason %s not given; stderr:\n' "$mode" "$name" "$want"
		cat "$TMP/case.err"
	fi
}
drive() { fx drive "$H" "$@"; }
caller_env_drive() { # the plan and review named only by the caller's environment, with no operation context
	(
		OMP_KIT_HISTORY_PLAN=$PLAN_P OMP_KIT_HISTORY_REVIEW=$REC_P
		export OMP_KIT_HISTORY_PLAN OMP_KIT_HISTORY_REVIEW
		fx drive "$H" "$PLAN_P" --no-lock "$@"
	)
}
negatives() { # negatives <normal|mutant>
	m=$1
	case_ "$m" caller-env-only "names no existing bead id" "names no existing bead id" caller_env_drive
	case_ "$m" review-absent "REFUSED REVIEW_ABSENT" admit drive "$H/.git/noreview.plan.json"
	case_ "$m" review-altered "REFUSED REVIEW_DIGEST_MISMATCH" admit drive "$H/.git/altered.plan.json"
	case_ "$m" review-writable "REFUSED REVIEW_NOT_IMMUTABLE" admit drive "$H/.git/writable.plan.json"
	case_ "$m" reviewer-is-applier "REFUSED REVIEWER_IS_APPLIER" admit drive "$H/.git/applier.plan.json"
	case_ "$m" review-other-tip "REFUSED REVIEW_BINDING_MISMATCH new_tip" admit drive "$H/.git/othertip.plan.json"
	case_ "$m" review-wrong-ref "REFUSED REVIEW_BINDING_MISMATCH ref" admit drive "$H/.git/wrongref.plan.json"
	case_ "$m" wrong-repo "REFUSED PLAN_REPOSITORY_MISMATCH" admit drive "$H/.git/wrongrepo.plan.json"
	git -C "$H" update-ref refs/heads/main "$C" "$L2"
	ok "$?" "0" "$m-stale-setup-forward"
	case_ "$m" stale-tip "REFUSED INTENT_TRANSACTION_MISMATCH" admit drive "$PLAN_P" --commands "$STALE_TX"
	git -C "$H" update-ref refs/heads/main "$L2" "$C"
	ok "$?" "0" "$m-stale-setup-rewind"
	case_ "$m" map-incomplete "REFUSED MAP_INCOMPLETE" admit drive "$H/.git/incomplete.plan.json"
	case_ "$m" map-extra "REFUSED MAP_EXTRA_ENTRY" admit drive "$H/.git/extra.plan.json"
	case_ "$m" map-conflict "REFUSED MAP_CONFLICT_PARENTS" admit drive "$H/.git/conflict.plan.json"
	case_ "$m" tree-change "REFUSED UNAPPROVED_TREE_CHANGE" admit drive "$H/.git/tree.plan.json"
	case_ "$m" path-retained "REFUSED ALLOWED_PATH_RETAINED" admit drive "$H/.git/retained.plan.json"
	case_ "$m" metadata-change "REFUSED UNAPPROVED_METADATA_CHANGE" admit drive "$H/.git/metadata.plan.json"
	case_ "$m" borrowed-signature "REFUSED BORROWED_SIGNATURE" admit drive "$H/.git/signature.plan.json"
	case_ "$m" extra-update "REFUSED INTENT_TRANSACTION_MISMATCH" admit drive "$PLAN_P" --commands "$EXTRA_TX"
	case_ "$m" extra-update-unjournaled "REFUSED TRANSACTION_MISMATCH" admit drive "$PLAN_P" --commands "$EXTRA_TX" --intent-commands "$REVIEWED_TX"
	case_ "$m" idless-descendant "REFUSED INTENT_TRANSACTION_MISMATCH" "names no existing bead id" drive "$PLAN_P" --commands "$DESC_TX"
	case_ "$m" foreign-git-child "REFUSED GIT_CHILD_NOT_THIS_TRANSACTION" admit drive "$PLAN_P" --foreign-child
	case_ "$m" tampered-owner-lock "REFUSED OWNER_LOCK_DIGEST_MISMATCH" admit drive "$PLAN_P" --tamper-lock
}
printf 'history transform negatives (reader as shipped):\n'
negatives normal

# Mutation: the installed reader with its witness validation removed. Every
# witness negative must then prepare; the caller-only environment and the
# id-less descendant stay refused by the unchanged ordinary check.
cp "$RTX/ref-txn-witness.py" "$TMP/witness.shipped"
sed 's/^\(    summary = \)verify_witness(.*# WITNESS-VALIDATION$/\1"WITNESS-VALIDATION-REMOVED"/' "$TMP/witness.shipped" > "$RTX/ref-txn-witness.py"
if cmp -s "$TMP/witness.shipped" "$RTX/ref-txn-witness.py"; then rc=1; else rc=0; fi
ok "$rc" "0" "mutant-differs"
printf 'history transform negatives (witness validation removed):\n'
negatives mutant
cp "$TMP/witness.shipped" "$RTX/ref-txn-witness.py"
cmp -s "$RTX/ref-txn-witness.py" "$WITNESS_SRC"
ok "$?" "0" "mutant-restored"

# A missing reader refuses that history operation only; ordinary updates keep working.
mv "$RTX/ref-txn-witness.py" "$TMP/witness.moved"
case_ normal reader-missing "witness reader is missing" admit drive "$PLAN_P"
X=$(printf 'ordinary fix ompkit-2w7h\n' | git -C "$H" commit-tree "$L2^{tree}" -p "$L2")
git -C "$H" update-ref refs/heads/main "$X" "$L2" 2> /dev/null
ok "$?" "0" "reader-missing-ordinary-update-flows"
Y=$(printf 'ordinary work with no identity\n' | git -C "$H" commit-tree "$X^{tree}" -p "$X")
git -C "$H" update-ref refs/heads/main "$Y" "$X" 2> /dev/null
refused "$?" "reader-missing-ordinary-idless-refused"
git -C "$H" update-ref refs/heads/main "$L2" "$X"
ok "$?" "0" "reader-missing-rewind"
mv "$TMP/witness.moved" "$RTX/ref-txn-witness.py"

# The paired admitted control: the exact independently reviewed transform.
out=$(drive "$PLAN_P" 2> "$TMP/admit.err")
ok "$out" "COMMITTED" "reviewed-transform-committed"
ok "$(git -C "$H" rev-parse refs/heads/main)" "$NEW" "reviewed-transform-main-is-new-tip"
ok "$(git -C "$H" rev-parse "$PRE/main")" "$L2" "reviewed-transform-old-main-preserved"
ok "$(git -C "$H" rev-parse "$PRE/public/heads/main")" "$ROOT" "reviewed-transform-public-root-preserved"
grep -qF "ref-txn-witness: ADMITTED reviewed history transform plan=$SHA_P ref=refs/heads/main old=$L2 new=$NEW mapped=3 review=$REC_P reviewer=independent-reviewer" "$TMP/admit.err"
ok "$?" "0" "reviewed-transform-provenance"
grep -m 1 'ADMITTED' "$TMP/admit.err"
ok "$(git -C "$H" log -1 --format=%B "$NEW")" "legacy edit with no identity" "reviewed-transform-message-unchanged"
# After the transform, ordinary enforcement is unchanged on the new main.
Z=$(printf 'after the scrub with no identity\n' | git -C "$H" commit-tree "$NEW^{tree}" -p "$NEW")
git -C "$H" update-ref refs/heads/main "$Z" "$NEW" 2> /dev/null
refused "$?" "post-transform-idless-refused"
ok "$(git -C "$H" rev-parse refs/heads/main)" "$NEW" "post-transform-main-unmoved"

# The pinned HISTPREP1 record contracts match the real helper, when its source is named.
if [ -n "${OMP_KIT_HISTORY_HELPER:-}" ]; then
	ok "$(fx helper-format "$OMP_KIT_HISTORY_HELPER")" "HELPER_FORMAT_MATCH" "helper-format-match"
	sed 's/"nonce": secrets.token_hex(16), //' "$OMP_KIT_HISTORY_HELPER" > "$TMP/helper-drift.py"
	fx helper-format "$TMP/helper-drift.py" > /dev/null
	ok "$?" "1" "helper-format-drift-detected"
else
	printf 'skip helper-format conformance: OMP_KIT_HISTORY_HELPER is unset\n'
fi

printf 'ref-txn-bead: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
