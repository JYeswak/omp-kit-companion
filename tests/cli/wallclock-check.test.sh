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
for helper in wallclock_check.py kitlib_ratchet_core.py pysafe.py kitlib_run.py kitlib_tmp.py; do cp "$REPO/scripts/$helper" "$members/$helper"; done
cp "$REPO/scripts/check-staged-wallclock.sh" "$members/55-omp-kit-staged-wallclock"
member="$members/55-omp-kit-staged-wallclock"
repo="$TMP/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email t@example.invalid
git -C "$repo" config user.name t
mkdir -p "$repo/tests/cli" "$repo/src"
# Fixture lines are built with printf arguments, so this file's own source never holds the shapes it plants.
printf 'const legacy = run(["x"], { deadline_s: %s });\n' 3 > "$repo/tests/cli/legacy.test.ts"
git -C "$repo" add -A
git -C "$repo" commit -q -m base --no-verify
check() { (cd "$repo" && sh "$member") > "$TMP/out" 2>&1; }

# 1. planted: a new test line with a 2 s child deadline is refused, naming file, line and rule
printf 'test("x", async () => { await run(["sh", "-c", "true"], { deadline_s: %s }); });\n' 2 > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then bad "small deadline admitted"; else
	if grep -q 'tests/cli/new.test.ts:1: small-deadline' "$TMP/out"; then ok; else bad "refusal text: $(cat "$TMP/out")"; fi
fi
# 2. control: the same fixture uses its existing floor through the load-aware helper
printf 'test("x", async () => { await run(["sh", "-c", "true"], { deadline_s: fixtureDeadlineS(30) }); });\n' > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then ok; else bad "load-scaled bound refused: $(cat "$TMP/out")"; fi
# 3. an annotated small bound passes
printf 'const killed = run(["sleep", "30"], { deadline_s: 1 }); // product-deadline: asserts the real child kill; wallclock: p99=0.02s headroom=50x\n' > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then ok; else bad "annotated line refused: $(cat "$TMP/out")"; fi
# 4. an untouched legacy offender never blocks an unrelated edit of its file
printf 'const legacy = run(["x"], { deadline_s: %s });\nconst more = 1;\n' 3 > "$repo/tests/cli/legacy.test.ts"
git -C "$repo" add tests/cli/legacy.test.ts
if check; then ok; else bad "legacy offender blocked: $(cat "$TMP/out")"; fi
# 5. a non-test path is out of scope; an elapsed assertion is flagged
printf 'export const t = spawnSync("x", { timeout: %s });\n' 2000 > "$repo/src/tool.ts"
git -C "$repo" add src/tool.ts
if check; then ok; else bad "non-test path judged: $(cat "$TMP/out")"; fi
printf 'expect(elapsedMs).%s(500);\n' toBeLessThan > "$repo/tests/cli/elapsed.test.ts"
git -C "$repo" add tests/cli/elapsed.test.ts
if check; then bad "elapsed assertion admitted"; else
	if grep -q 'elapsed.test.ts:1: elapsed-assert' "$TMP/out"; then ok; else bad "elapsed refusal text: $(cat "$TMP/out")"; fi
fi
git -C "$repo" rm -q --cached tests/cli/elapsed.test.ts
# 7. an incomplete annotation is no annotation: no headroom, an empty p99 and a headroom under 2x are each refused
for tail in '// wallclock: p99=0.02s' '// wallclock: p99=' '// wallclock: p99=0.02s headroom=1x'; do
	printf 'test("x", async () => { await run(["sh", "-c", "true"], { deadline_s: %s }); }); %s\n' 2 "$tail" > "$repo/tests/cli/new.test.ts"
	git -C "$repo" add tests/cli/new.test.ts
	if check; then bad "incomplete annotation admitted: $tail"; else
		if grep -q 'tests/cli/new.test.ts:1: small-deadline' "$TMP/out"; then ok; else bad "incomplete annotation refusal text: $(cat "$TMP/out")"; fi
	fi
done
# 8. line length never exempts: the same short deadline padded past 4000 bytes is refused
pad=$(printf '%4100s' '')
printf 'test("x", async () => { await run(["sh", "-c", "true"], { deadline_s: %s }); });%s\n' 2 "$pad" > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then bad "long unannotated line admitted"; else
	if grep -q 'tests/cli/new.test.ts:1: small-deadline' "$TMP/out"; then ok; else bad "long-line refusal text: $(cat "$TMP/out")"; fi
fi
git -C "$repo" rm -q --cached tests/cli/new.test.ts
# 6. GIT_INDEX_FILE is honored: a private index without the offender passes while the shared one stages it
printf 'const t = Bun.spawnSync(["x"], { timeout: %s });\n' 3000 > "$repo/tests/cli/spawn.test.ts"
git -C "$repo" add tests/cli/spawn.test.ts
idx="$TMP/only.index"
GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD
if (cd "$repo" && GIT_INDEX_FILE="$idx" sh "$member") > "$TMP/out" 2>&1; then ok; else bad "private index judged the shared index: $(cat "$TMP/out")"; fi
if check; then bad "small spawn timeout admitted"; else ok; fi

# FIXTUREDEADLINE1: the formerly admitted 30/60/120-second sites now refuse.
git -C "$repo" rm -q --cached tests/cli/spawn.test.ts
for shape in 'run(cmd, { deadline_s: 30 })' 'test("slow", () => { nested(a, b); }, 60_000)' 'test("trailing", () => {}, 60_000,)' 'beforeAll(() => { setup(); }, 120_000)' 'setDefaultTimeout(60_000)' 'test("multiline", () => {\n nested(a, b);\n}, 60_000)'; do
	printf '%b;\n' "$shape" > "$repo/tests/cli/new.test.ts"
	git -C "$repo" add tests/cli/new.test.ts
	if check; then bad "literal fixture bound admitted: $shape"; else
		if grep -q 'literal-fixture-deadline' "$TMP/out"; then ok; else bad "literal refusal text: $(cat "$TMP/out")"; fi
	fi
done
for shape in 'test("slow", () => { nested(a, b); }, fixtureDeadlineS(60) * 1000)' 'runFixture(cmd, { floor_s: 120 })' 'const docs = "test(x, fn, 60000)"; // timeout: 120000' 'test("product", () => { checkKill(); }, 60_000); // product-deadline: asserts a real product latency ceiling'; do
	printf '%s;\n' "$shape" > "$repo/tests/cli/new.test.ts"
	git -C "$repo" add tests/cli/new.test.ts
	if check; then ok; else bad "literal quiet control refused: $(cat "$TMP/out")"; fi
done
# A measured annotation alone must not launder an ordinary fixture deadline.
printf 'test("slow", () => {}, 60000); // wallclock: p99=1s headroom=60x\n' > "$repo/tests/cli/new.test.ts"
git -C "$repo" add tests/cli/new.test.ts
if check; then bad "measurement laundered fixture bound"; else ok; fi
# Grandfathering is shrink-only: duplicating the pre-existing literal refuses.
git -C "$repo" rm -q --cached tests/cli/new.test.ts
printf 'const legacy = run(["x"], { deadline_s: %s });\nconst legacy = run(["x"], { deadline_s: %s });\n' 3 3 > "$repo/tests/cli/legacy.test.ts"
git -C "$repo" add tests/cli/legacy.test.ts
if check; then bad "duplicated legacy literal admitted"; else ok; fi

printf 'wallclock-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
