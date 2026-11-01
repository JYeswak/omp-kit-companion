#!/bin/sh
# autocut.test.sh -- AUTOCUT1 (ompkit-2uubn) contract for scripts/autocut.sh on an owned fixture repo.
# Each fixture commit carries a stub full-suite-verdict-store.py that answers PASS only for trees listed in
# $PASS_TREES, so verdicts are planted per tree; release and install are stub commands that record their args.
set -u
REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
AUTOCUT="${AUTOCUT_UNDER_TEST:-$REPO/scripts/autocut.sh}"
mkdir -p "$REPO/var/agent-tmp" || exit 1
. "$REPO/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT="$REPO/var/agent-tmp" kitlib_tmp TMP autocut-test || exit 1
pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

origin="$TMP/origin.git"
git init -q --bare "$origin"
repo="$TMP/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email t@example.invalid
git -C "$repo" config user.name t
mkdir -p "$repo/scripts"
cat > "$repo/scripts/full-suite-verdict-store.py" <<'PY'
import os, sys
tree = sys.argv[sys.argv.index("--tree") + 1]
listed = open(os.environ["PASS_TREES"]).read().split() if os.path.exists(os.environ.get("PASS_TREES", "")) else []
print("PASS" if tree in listed else "MISS")
sys.exit(0 if tree in listed else 1)
PY
# The verdict readback runs under the candidate's own scripts/pysafe.py, as in the real repo.
cp "$REPO/scripts/pysafe.py" "$repo/scripts/pysafe.py"
commit() { # VERSION MESSAGE -> prints the new sha
	printf '{"name":"fixture","version":"%s"}\n' "$1" > "$repo/package.json"
	printf '%s\n' "$2" > "$repo/note.txt"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "$2" --no-verify
	git -C "$repo" rev-parse HEAD
}
base=$(commit 0.1.0 base)
git -C "$repo" tag v0.1.0 "$base"
git -C "$repo" remote add origin "$origin"
git -C "$repo" push -q origin main --tags 2>/dev/null
commit 0.1.1 "prepare 0.1.1" >/dev/null
c2=$(commit 0.1.1 "work two")
c3=$(commit 0.1.1 "work three")
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
tree() { git -C "$repo" rev-parse "$1^{tree}"; }
export PASS_TREES="$TMP/pass-trees" AUTOCUT_NO_FETCH=1 TMPDIR="$TMP"
releases() { # PUBLISHED_AT for v0.1.0
	printf '[[{"tag_name":"v0.1.0","draft":false,"prerelease":false,"published_at":"%s"}]]\n' "$1" > "$TMP/releases.json"
}
releases "2026-01-01T00:00:00Z"
export AUTOCUT_RELEASES_JSON="$TMP/releases.json"
field() { printf '%s' "$1" | tail -n 1 | jq -r ".$2"; }

# 1. Newest commit FAIL/missing, previous PASS: the PASS one is picked (planted FAIL skips to the previous PASS).
tree "$c2" > "$PASS_TREES"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c2" ] && [ "$(field "$out" version)" = 0.1.1 ]; then ok; else bad "plan picks newest PASS: $out"; fi

# 2. No PASS anywhere: WAIT, naming each skipped commit.
: > "$PASS_TREES"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = WAIT ] && printf '%s' "$out" | grep -q 'no-pass'; then ok; else bad "no PASS waits: $out"; fi

# 3. The floor: a release published moments ago waits even with a PASS; --now cuts.
tree "$c3" > "$PASS_TREES"
releases "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = WAIT ] && printf '%s' "$out" | grep -q 'floor'; then ok; else bad "floor waits: $out"; fi
out=$(sh "$AUTOCUT" plan --repo "$repo" --now 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c3" ]; then ok; else bad "--now cuts: $out"; fi
releases "2026-01-01T00:00:00Z"

# 4. A version not newer than the release is never a candidate (no prepare commit yet).
c4=$(commit 0.1.0 "unprepared work")
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
tree "$c4" > "$PASS_TREES"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = WAIT ] && printf '%s' "$out" | grep -q 'version-0.1.0'; then ok; else bad "unprepared version waits: $out"; fi

# 5. run --dry-run: release-local gets the exact version, source and --dry-run; nothing installed.
tree "$c3" > "$PASS_TREES"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "%s/release-args"\n' "$TMP" > "$TMP/release-stub"
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-stub" AUTOCUT_INSTALL="false" sh "$AUTOCUT" run --repo "$repo" --dry-run 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(cat "$TMP/release-args")" = "--version 0.1.1 --source $c3 --dry-run" ]; then ok; else bad "dry run args: $out / $(cat "$TMP/release-args" 2>/dev/null)"; fi

# 6. A push landing mid-cut never changes what is released (no freeze needed).
cat > "$TMP/release-pushes" <<EOF
#!/bin/sh
printf '%s\n' "\$*" > "$TMP/release-args"
printf 'mid-cut\n' > "$repo/mid.txt"
git -C "$repo" add mid.txt && git -C "$repo" commit -q -m "landed mid-cut" --no-verify && git -C "$repo" push -q origin main 2>/dev/null
EOF
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-pushes" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c3" ] \
	&& [ "$(cat "$TMP/release-args")" = "--version 0.1.1 --source $c3" ] \
	&& [ "$(git -C "$origin" rev-parse main)" != "$c3" ]; then ok; else bad "mid-cut push: $out"; fi

# 7. An install that reads back another version fails the run (exit 4), never reports CUT.
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-stub" AUTOCUT_INSTALL="echo 0.0.9 #" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ]; then ok; else bad "wrong installed version: rc=$rc $out"; fi

# 8. A refused release-local fails the run and never installs.
out=$(AUTOCUT_RELEASE_LOCAL="false" AUTOCUT_INSTALL="echo 0.1.1 #" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ]; then ok; else bad "refused release: rc=$rc $out"; fi

# 9. Every decision is logged.
if [ "$(wc -l < "$repo/.git/omp-kit/autocut.log" | tr -d ' ')" -ge 9 ]; then ok; else bad "autocut.log has $(wc -l < "$repo/.git/omp-kit/autocut.log") lines"; fi

printf 'autocut: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
