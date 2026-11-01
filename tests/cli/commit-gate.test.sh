#!/bin/sh
# commit-gate.test.sh -- COMMITPARITY1 (ompkit-9d9fx) contract for scripts/check-commit-gate.sh.
# A fixture repo carries a stub pre-push fresh-gate member that records the ref line and its
# environment, and refuses when the candidate tree holds a file named BROKEN. The real push gate's
# own behavior is covered by pre-push-gate.test.sh; this suite pins how the commit member hands it
# the commit being made.
set -u

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
CHECK="${COMMIT_GATE_CHECK:-$REPO/scripts/check-commit-gate.sh}"
mkdir -p "$REPO/var/agent-tmp" || exit 1
TMP=$(mktemp -d "$REPO/var/agent-tmp/commit-gate-test.$$.XXXXXX") || exit 1 # tempsafe: owned test dir with .owner, removed on exit
printf 'pid=%s label=commit-gate-test repo=%s\n' "$$" "$REPO" > "$TMP/.owner"
trap 'chmod -R u+w "$TMP" 2>/dev/null; find "$TMP" -depth -delete 2>/dev/null' EXIT
pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
remote="$TMP/remote.git"
git init -q --bare "$remote"
repo="$TMP/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config user.name commit-gate-test
printf 'base\n' > "$repo/a.txt"
git -C "$repo" add a.txt
git -C "$repo" commit -qm base --no-verify
git -C "$repo" remote add origin "$remote"
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
hooks=$(git -C "$repo" rev-parse --git-path hooks)
case "$hooks" in /*) ;; *) hooks="$repo/$hooks" ;; esac
mkdir -p "$hooks/hooks.d/pre-push"
gate="$hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
cat > "$gate" <<'EOF'
#!/bin/sh
read -r lref lsha rref rsha
printf '%s %s %s %s|%s|%s\n' "$lref" "$lsha" "$rref" "$rsha" "${OMP_KIT_RELEASE_VERDICT:-unset}" "$1" > "$GATE_LOG"
if git ls-tree --name-only "$lsha" | grep -qx BROKEN; then echo "stub gate: RED BROKEN present" >&2; exit 7; fi
exit 0
EOF
chmod +x "$gate"
export GATE_LOG="$TMP/gate.log"
msg="$TMP/msg"
printf 'change\n\nBead: x-1\n' > "$msg"

# 1. GREEN: a staged harmless change is judged; the ref line names a commit whose tree is the staged
#    tree and whose parent is HEAD, against origin/main; the release verdict is opted out.
printf 'more\n' >> "$repo/a.txt"
git -C "$repo" add a.txt
if (cd "$repo" && sh "$CHECK" "$msg" > "$TMP/out" 2>&1); then ok; else bad "green: rc!=0 $(cat "$TMP/out")"; fi
set -- $(cut -d'|' -f1 "$GATE_LOG")
cand=$2
[ "$1" = refs/heads/main ] && [ "$3" = refs/heads/main ] && [ "$4" = "$(git -C "$repo" rev-parse origin/main)" ] && ok || bad "green: ref line $(cat "$GATE_LOG")"
[ "$(git -C "$repo" rev-parse "$cand^{tree}")" = "$(git -C "$repo" write-tree)" ] && ok || bad "green: candidate tree is not the staged tree"
[ "$(git -C "$repo" rev-parse "$cand^")" = "$(git -C "$repo" rev-parse HEAD)" ] && ok || bad "green: candidate parent is not HEAD"
[ "$(cut -d'|' -f2 "$GATE_LOG")" = 0 ] && ok || bad "green: release verdict not opted out"
[ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$repo" rev-parse origin/main)" ] && ok || bad "green: a ref moved"

# 2. RED: a staged file the push gate refuses makes the commit refuse with the gate's status.
printf 'x\n' > "$repo/BROKEN"
git -C "$repo" add BROKEN
if (cd "$repo" && sh "$CHECK" "$msg" > "$TMP/out" 2>&1); then bad "red: rc=0"; else
	rc=$?
	[ "$rc" = 7 ] && grep -q 'commit-gate: REFUSED' "$TMP/out" && ok || bad "red: rc=$rc $(cat "$TMP/out")"
fi

# 3. GIT_INDEX_FILE (commit --only) is honored: a private index without BROKEN is GREEN even though
#    the shared index stages it.
idx="$TMP/only.index"
GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD
if (cd "$repo" && GIT_INDEX_FILE="$idx" sh "$CHECK" "$msg" > "$TMP/out" 2>&1); then ok; else bad "only-index: rc!=0 $(cat "$TMP/out")"; fi

# 4. Nothing to mirror: no installed fresh-gate member, or a branch other than main -> admitted.
mv "$gate" "$gate.off"
if (cd "$repo" && sh "$CHECK" "$msg" > "$TMP/out" 2>&1); then ok; else bad "no-gate: rc!=0"; fi
mv "$gate.off" "$gate"
git -C "$repo" checkout -q -b side
if (cd "$repo" && sh "$CHECK" "$msg" > "$TMP/out" 2>&1); then ok; else bad "side-branch: rc!=0"; fi

printf 'commit-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
