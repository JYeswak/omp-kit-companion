#!/bin/sh
# check-staged-kitlib-reversal.test.sh — KITLIB-RATCHET gate contract part 2
# (ompkit-qwqh1): section 8, exact named reversal of the ratchet introduction.
# shellcheck source=tests/cli/check-staged-kitlib.lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/check-staged-kitlib.lib.sh"

# 8. Only an exact, named reversal of X may admit the incumbent raw-spawn
#    entry; commit-msg supplies native per-path proof and rejects fake intent.
R=$(origin_repo origin-equal)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] exact named reversal" -m "Revert: $X")
check "$?" "0" "origin-equal-named-reversal-pass" "$out" '"verdict":"PASS"'
check "0" "0" "origin-equal-per-path-verdict" "$out" '"path":"tool.py"'

R=$(origin_repo origin-missing-revert)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] missing reversal authority")
check "$?" "1" "origin-equal-without-revert-refused" "$out" 'missing Revert trailer'

R=$(origin_repo origin-wrong-x)
printf '%s\n' 'unrelated history' > "$R/unrelated.txt"
git -C "$R" add unrelated.txt
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] unrelated X"
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] false named reversal" -m "Revert: $X")
check "$?" "1" "origin-equal-wrong-x-refused" "$out" 'staged paths do not equal'

R=$(origin_repo origin-unrelated-staged)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf '%s\n' 'unrelated staged code' > "$R/extra.txt"
git -C "$R" add tool.py extra.txt
out=$(commit "$R" -m "[test] reversal with unrelated path" -m "Revert: $X")
check "$?" "1" "origin-equal-unrelated-staged-refused" "$out" 'staged paths do not equal'

# A Revert trailer whose staged entry differs from X's parent but uses no published-origin admission
# is an ordinary commit (RusticPine AM 70292, QuietBadger AM 70284): member 49 judges the declaration,
# and the full-X proof stays reserved for admissions (origin-equal-wrong-x, -unrelated-staged, -older,
# -near-match and -mixed below keep refusing those).
R=$(origin_repo ordinary-parent-mismatch)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n# post-parent edit' "$PY_GOOD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] parent mismatch without admission" -m "Revert: $X")
check "$?" "0" "ordinary-parent-mismatch-without-admission-passes" "x" "x"
# An admitted forward-withdrawal stages exactly X's paths: one path keeps X
# parent's bytes (so the origin admission binds) while a second path's bytes
# differ from X's parent. The parent-proof must refuse, naming the entry.
# The origin is published by local clone only; no push or fetch leaves the fixture.
R=$(new_repo origin-admitted-parent-proof tool.py "$PY_BAD_OLD")
printf 'VALUE = 1\n' > "$R/data.py"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add data.py tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] published origin"
origin=$(git -C "$R" rev-parse HEAD)
git clone --bare -q "$R" "$R/published.git"
git --git-dir="$R/published.git" update-ref refs/heads/main "$origin"
git -C "$R" remote add origin "$R/published.git"
git -C "$R" update-ref refs/remotes/origin/main "$origin"
printf '%s\n' "$PY_GOOD" > "$R/tool.py"
printf 'VALUE = 2\n' > "$R/data.py"
git -C "$R" add data.py tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] ratchet reduction"
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf 'VALUE = 3\n' > "$R/data.py"
git -C "$R" add data.py tool.py
out=$(commit "$R" -m "[test] admitted parent mismatch" -m "Revert: $X")
check "$?" "1" "origin-admitted-parent-mismatch-refused" "$out" 'does not match X parent'
# The same commit with that path's bytes equal to X's parent passes.
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf 'VALUE = 1\n' > "$R/data.py"
git -C "$R" add data.py tool.py
out=$(commit "$R" -m "[test] admitted parent exact" -m "Revert: $X")
check "$?" "0" "origin-admitted-parent-exact-pass" "$out" '"verdict":"PASS"'

R=$(origin_repo origin-stale)
X=$(git -C "$R" rev-parse HEAD)
git -C "$R" -c core.hooksPath=/dev/null push -q origin "$X:refs/heads/candidate"
git --git-dir="$R/published.git" update-ref refs/heads/main "$X"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] stale origin" -m "Revert: $X")
check "$?" "1" "origin-stale-binding-refused" "$out" 'origin/main tracking ref is stale'

R=$(origin_repo origin-unpublished-head)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] unpublished head"
UNPUBLISHED=$(git -C "$R" rev-parse HEAD)
git -C "$R" update-ref refs/remotes/origin/main "$UNPUBLISHED"
printf '%s\n' "$PY_GOOD" > "$R/tool.py"
git -C "$R" add tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] return to kitlib"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] falsely published head" -m "Revert: $X")
check "$?" "1" "origin-unpublished-head-refused" "$out" 'origin/main tracking ref is stale'
# A legitimately published entry can also be the current HEAD entry. Use an
# older explicit base so the staged raw-spawn entry is judged while HEAD and
# origin/main both name the published commit.
R=$(origin_repo origin-published-head) || exit 1
origin=$(git -C "$R" rev-parse refs/remotes/origin/main) || exit 1
git -C "$R" checkout -q "$origin" || exit 1
head=$(git -C "$R" rev-parse HEAD) || exit 1
parent=$(git -C "$R" rev-parse "$head^") || exit 1
head_entry=$(git -C "$R" rev-parse "HEAD:tool.py") || exit 1
index_entry=$(git -C "$R" rev-parse :tool.py) || exit 1
published_entry=$(git -C "$R" rev-parse "$origin:tool.py") || exit 1
if [ "$origin" = "$head" ] && [ "$index_entry" = "$head_entry" ] && [ "$index_entry" = "$published_entry" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL origin-published-head-fixture: origin=%s HEAD=%s index=%s published=%s\n' "$origin" "$head" "$index_entry" "$published_entry"
fi
out=$(python3 -B "$SCRIPTS/kitlib_ratchet.py" --staged --base "$parent" --repo "$R" 2>&1)
check "$?" "0" "origin-published-head-entry-admitted" "$out" "ADMITTED incumbent raw-spawn entry matches exact staged path at origin/main@"

# The same HEAD/index entry is refused once origin/main publishes different bytes.
R=$(origin_repo origin-head-not-published) || exit 1
origin=$(git -C "$R" rev-parse refs/remotes/origin/main) || exit 1
published=$(git -C "$R" rev-parse HEAD) || exit 1
git -C "$R" -c core.hooksPath=/dev/null push -q origin "$published:refs/heads/main" || exit 1
git -C "$R" update-ref refs/remotes/origin/main "$published" || exit 1
git -C "$R" checkout -q "$origin" || exit 1
head=$(git -C "$R" rev-parse HEAD) || exit 1
parent=$(git -C "$R" rev-parse "$head^") || exit 1
head_entry=$(git -C "$R" rev-parse "HEAD:tool.py") || exit 1
index_entry=$(git -C "$R" rev-parse :tool.py) || exit 1
published_entry=$(git -C "$R" rev-parse refs/remotes/origin/main:tool.py) || exit 1
if [ "$head" = "$origin" ] && [ "$index_entry" = "$head_entry" ] && [ "$index_entry" != "$published_entry" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL origin-not-published-head-fixture: HEAD=%s index=%s published=%s\n' "$head" "$index_entry" "$published_entry"
fi
out=$(python3 -B "$SCRIPTS/kitlib_ratchet.py" --staged --base "$parent" --repo "$R" 2>&1)
rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -Fq "raw-spawn" && ! printf '%s' "$out" | grep -Fq "ADMITTED incumbent raw-spawn"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL origin-head-entry-not-published-refused: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

R=$(origin_repo origin-byte-near-match)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n# one byte differs' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] near match" -m "Revert: $X")
check "$?" "1" "origin-near-match-bytes-refused" "$out" "tool.py:.*raw-spawn"

R=$(origin_repo origin-mode-near-match)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
chmod +x "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] mode near match" -m "Revert: $X")
check "$?" "1" "origin-near-match-mode-refused" "$out" "tool.py:.*raw-spawn"

R=$(origin_repo origin-extra)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\nsubprocess.check_output(["extra"], timeout=5, stdin=subprocess.DEVNULL)  # pysafe: additional fixture spawn, judged by kitlib\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] withdrawal plus new spawn" -m "Revert: $X")
check "$?" "1" "origin-extra-spawn-refused" "$out" "tool.py:3:1: raw-spawn"

R=$(origin_repo origin-mixed)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add tool.py new.py
out=$(commit "$R" -m "[test] exact origin plus new spawn" -m "Revert: $X")
check "$?" "1" "origin-mixed-new-spawn-refused" "$out" "new.py:2:1: raw-spawn"

R=$(origin_repo origin-older)
X=$(git -C "$R" rev-parse HEAD)
older=$(git -C "$R" rev-parse HEAD~2)
git -C "$R" show "$older:tool.py" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] restore older tree" -m "Revert: $X")
check "$?" "1" "origin-older-tree-refused" "$out" "tool.py:2:1: raw-spawn"

R=$(origin_repo origin-new)
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] ordinary new spawn")
check "$?" "1" "origin-new-spawn-refused" "$out" "new.py:2:1: raw-spawn"

R=$(origin_repo origin-missing-msg-member)
X=$(git -C "$R" rev-parse HEAD)
member="$R/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
mv "$member" "$TMP/reversal-member.keep"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] missing commit-msg verifier" -m "Revert: $X")
check "$?" "1" "origin-reversal-member-required" "$out" "commit-msg reversal validator is missing"
mv "$TMP/reversal-member.keep" "$member"
R=$(new_repo origin-no-reversal-member)
member="$R/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
mv "$member" "$TMP/reversal-member.ordinary.keep"
printf 'export const ordinary = 1;\n' > "$R/ordinary.ts"
git -C "$R" add ordinary.ts
out=$(commit "$R" -m "[test] ordinary change without origin admission")
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL ordinary-change-without-reversal-member: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
mv "$TMP/reversal-member.ordinary.keep" "$member"


printf 'check-staged-kitlib: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
