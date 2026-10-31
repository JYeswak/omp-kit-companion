#!/bin/sh
# check-staged-kitlib-replay.test.sh — KITLIB-RATCHET gate contract part 3
# (ompkit-qwqh1): section 9, real 3cbef260b5 withdrawal replay (definitions
# in check-staged-kitlib.lib.sh; real-pass runs in check-staged-kitlib.test.sh).
# shellcheck source=tests/cli/check-staged-kitlib.lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/check-staged-kitlib.lib.sh"

replay_setup
# 9a. Planted negative: a missing or corrupted capsule fails closed before replay.
out=$(hydrate_capsule "$TMP/does-not-exist.pack" "$CAPSULE_MANIFEST" "$TMP/nope-missing" 2>&1); rc=$?
check "$rc" "1" "hydrate-missing-refused" "$out" "HYDRATE-REFUSED"
head -c 1000 "$CAPSULE_PACK" > "$TMP/truncated.pack"
out=$(hydrate_capsule "$TMP/truncated.pack" "$CAPSULE_MANIFEST" "$TMP/nope-truncated" 2>&1); rc=$?
check "$rc" "1" "hydrate-truncated-refused" "$out" "HYDRATE-REFUSED"
# 9b. Planted negative: a corrupted blob or a dropped path fails the
# pre-replay identity check before any replay runs (no real-* fixture dir).
cp "$CAPSULE_MANIFEST" "$TMP/bad-blob.manifest"
awk '$1 == "tests/cli/converge.test.ts" { $3 = "0000000000000000000000000000000000000000" } 1' "$TMP/bad-blob.manifest" > "$TMP/bad-blob.manifest.new" && mv "$TMP/bad-blob.manifest.new" "$TMP/bad-blob.manifest"
out=$(CAPSULE_MANIFEST="$TMP/bad-blob.manifest" validate_inputs 2>&1); rc=$?
check "$rc" "1" "precheck-corrupt-blob-refused" "$out" "MISMATCH-path:tests/cli/converge.test.ts"
nogore=$(find "$TMP" -maxdepth 1 -name 'real-*' | wc -l | tr -d '[:space:]')
check "$nogore" "0" "precheck-corrupt-blob-no-replay" "x" "x"
grep -v "^tests/cli/converge.test.ts " "$CAPSULE_MANIFEST" > "$TMP/bad-drop.manifest"
out=$(CAPSULE_MANIFEST="$TMP/bad-drop.manifest" validate_inputs 2>&1); rc=$?
check "$rc" "1" "precheck-dropped-path-refused" "$out" "PRECHECK-REFUSED"
nogore=$(find "$TMP" -maxdepth 1 -name 'real-*' | wc -l | tr -d '[:space:]')
check "$nogore" "0" "precheck-dropped-path-no-replay" "x" "x"
prior41_path=tests/cli/pre-push-gate.test.sh
# Reusing X's hunk-less blob plus a marker keeps this path staged; parent
# proof must reject the missing P-side .41 fixture history.
R=$(real_repo real-prior-41-hunk-missing) || exit 1
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL" || exit 1
git -C "$OBJSRC" show "$XREAL:$prior41_path" > "$R/$prior41_path" || exit 1
printf '\n# planted marker: .41 fixture history is missing\n' >> "$R/$prior41_path"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real withdrawal drops .41 fixture hunk" -m "Revert: $X")
rc=$?
check "$rc" "1" "real-withdrawal-prior-41-hunk-refused" "$out" "does not match X parent"
printf '%s' "$out" | grep -Fq "$prior41_path"
check "$?" "0" "real-withdrawal-prior-41-hunk-refusal-names-path" "x" "x"

# A mixed new spawn beside the exact reversal refuses naming the new file.
R=$(real_repo real-mixed)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
printf '%s\n' "$PY_BAD" > "$R/new.py"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
git -C "$R" add new.py
out=$(commit "$R" -m "[test] real withdrawal plus new spawn" -m "Revert: $X")
check "$?" "1" "real-mixed-new-refused" "$out" "new.py:2:1: raw-spawn"
# A one-byte difference in one path refuses naming that path.
R=$(real_repo real-near-match)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
printf '%s\n# one byte differs\n' "$(git -C "$OBJSRC" show "$PREAL:tests/cli/converge.test.ts")" > "$R/tests/cli/converge.test.ts"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real near match" -m "Revert: $X")
check "$?" "1" "real-near-match-refused" "$out" "converge.test.ts:.*raw-spawn"
# A mode-only difference refuses naming that path.
R=$(real_repo real-mode)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
chmod +x "$R/tests/cli/scratch.test.ts"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real mode near match" -m "Revert: $X")
check "$?" "1" "real-near-match-mode-refused" "$out" "scratch.test.ts:.*raw-spawn"
# An older-tree entry refuses naming that path.
R=$(real_repo real-older)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
git -C "$OBJSRC" show "$OLDCONVERGE:tests/cli/converge.test.ts" > "$R/tests/cli/converge.test.ts"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real older tree" -m "Revert: $X")
check "$?" "1" "real-older-tree-refused" "$out" "converge.test.ts:.*raw-spawn"
# A stale published binding refuses before any per-path proof.
R=$(real_repo real-stale)
XSTALE=$(git -C "$R" rev-parse HEAD)
X=$(git -C "$R" rev-parse HEAD) || exit 1
git -C "$R" -c core.hooksPath=/dev/null push -q origin "$XSTALE:refs/heads/candidate"
git --git-dir="$R/published.git" update-ref refs/heads/main "$XSTALE"
sync_tree "$R" "$PREAL"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real stale origin" -m "Revert: $X")
check "$?" "1" "real-stale-binding-refused" "$out" "origin/main tracking ref is stale"
# An ordinary new spawn with no reversal refuses as today.
R=$(real_repo real-control)
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] ordinary new spawn")
check "$?" "1" "real-ordinary-new-refused" "$out" "new.py:2:1: raw-spawn"

printf 'check-staged-kitlib: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
