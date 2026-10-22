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

printf 'ref-txn-bead: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
