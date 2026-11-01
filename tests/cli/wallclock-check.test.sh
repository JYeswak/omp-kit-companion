#!/bin/sh
# wallclock-check.test.sh -- WALLCLOCK1 (ompkit-qf9fk) contract for scripts/check-staged-wallclock.sh and
# scripts/wallclock_check.py, laid out as the installer places them (member + helpers in one directory).
set -u
REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
mkdir -p "$REPO/var/agent-tmp" || exit 1
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT="$REPO/var/agent-tmp" kitlib_tmp TMP wallclock-test || exit 1
pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

members="$TMP/members"
mkdir -p "$members"
for helper in wallclock_check.py pysafe.py kitlib_run.py kitlib_tmp.py; do cp "$REPO/scripts/$helper" "$members/$helper"; done
cp "$REPO/scripts/check-staged-wallclock.sh" "$members/55-omp-kit-staged-wallclock"
member="$members/55-omp-kit-staged-wallclock"
repo="$TMP/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email t@example.invalid
git -C "$repo" config user.name t
mkdir -p "$repo/tests/cli" "$repo/src"
printf 'const legacy = run(["x"], { deadline_s: 3 });\n' > "$repo/tests/cli/legacy.test.ts" # wallclock: p99=n/a, planted fixture text the member must refuse
git -C "$repo" add -A
git -C "$repo" commit -q -m base --no-verify
check() { (cd "$repo" && sh "$member") > "$TMP/out" 2>&1; }

# 1. planted: a new test line with a 2 s child deadline is refused, naming file, line and rule
printf 'test("x", async () => { await run(["sh", "-c", "true"], { deadline_s: 2 }); });\n' > "$repo/tests/cli/new.test.ts" # wallclock: p99=n/a, planted fixture text the member must refuse
git -C "$repo" add tests/cli/new.test.ts
if check; then bad "small deadline admitted"; else
	if grep -q 'tests/cli/new.test.ts:1: small-deadline' "$TMP/out"; then ok; else bad "refusal text: $(cat "$TMP/out")"; fi
fi
# 2. control: the same line with a load-safe 30 s bound passes
printf 'test("x", async () => { await run(["sh", "-c", "true"], { deadline_s: 30 }); });\n' > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then ok; else bad "load-safe bound refused: $(cat "$TMP/out")"; fi
# 3. an annotated small bound passes
printf 'const killed = run(["sleep", "30"], { deadline_s: 1 }); // wallclock: p99=0.02s headroom=50x (asserts the kill)\n' > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then ok; else bad "annotated line refused: $(cat "$TMP/out")"; fi
# 4. an untouched legacy offender never blocks an unrelated edit of its file
printf 'const legacy = run(["x"], { deadline_s: 3 });\nconst more = 1;\n' > "$repo/tests/cli/legacy.test.ts" # wallclock: p99=n/a, planted fixture text the member must refuse
git -C "$repo" add tests/cli/legacy.test.ts
if check; then ok; else bad "legacy offender blocked: $(cat "$TMP/out")"; fi
# 5. a non-test path is out of scope; an elapsed assertion is flagged
printf 'export const t = spawnSync("x", { timeout: 2000 });\n' > "$repo/src/tool.ts" # wallclock: p99=n/a, planted fixture text the member must refuse
git -C "$repo" add src/tool.ts
if check; then ok; else bad "non-test path judged: $(cat "$TMP/out")"; fi
printf 'expect(elapsedMs).toBeLessThan(500);\n' > "$repo/tests/cli/elapsed.test.ts" # wallclock: p99=n/a, planted fixture text the member must refuse
git -C "$repo" add tests/cli/elapsed.test.ts
if check; then bad "elapsed assertion admitted"; else
	if grep -q 'elapsed.test.ts:1: elapsed-assert' "$TMP/out"; then ok; else bad "elapsed refusal text: $(cat "$TMP/out")"; fi
fi
git -C "$repo" rm -q --cached tests/cli/elapsed.test.ts
# 6. GIT_INDEX_FILE is honored: a private index without the offender passes while the shared one stages it
printf 'const t = Bun.spawnSync(["x"], { timeout: 3000 });\n' > "$repo/tests/cli/spawn.test.ts" # wallclock: p99=n/a, planted fixture text the member must refuse
git -C "$repo" add tests/cli/spawn.test.ts
idx="$TMP/only.index"
GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD
if (cd "$repo" && GIT_INDEX_FILE="$idx" sh "$member") > "$TMP/out" 2>&1; then ok; else bad "private index judged the shared index: $(cat "$TMP/out")"; fi
if check; then bad "small spawn timeout admitted"; else ok; fi

printf 'wallclock-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
