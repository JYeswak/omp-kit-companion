#!/bin/sh
# commit-imports.test.sh — FLY2-3 dangling-import gate contract
# (ompkit-uzgf). Fixture repos where HEAD imports a missing file must be
# refused naming sha+path; clean trees pass. Every verdict comes from the
# exit code plus the complete output.
set -u

CHECKER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-commit-imports.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/commit-imports-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

mkrepo() {
	name=$1
	repo="$TMP/$name"
	mkdir -p "$repo"
	git -C "$repo" init -q
	git -C "$repo" config user.email "test@example.invalid"
	git -C "$repo" config user.name "worker-1"
	mkdir -p "$repo/src"
	printf 'export const ok = 1;\n' > "$repo/src/ok.ts"
	printf 'import { ok } from "./ok.ts";\nconsole.log(ok);\n' > "$repo/src/main.ts"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] base clean tree"
	printf '%s' "$repo"
}

# 1. planted: HEAD imports a file missing from its tree; refused naming sha+path
repo=$(mkrepo dangling)
printf 'import { gone } from "./missing.ts";\nconsole.log(gone);\n' > "$repo/src/main.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm "[test] head with dangling import"
base=$(git -C "$repo" rev-parse HEAD~1)
head=$(git -C "$repo" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo" --base "$base" --tip "$head" 2>&1)
rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$head" && printf '%s' "$out" | grep -q "./missing.ts"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL dangling-refused: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

repo2=$(mkrepo clean)
printf 'export const ok = 2;\n' > "$repo2/src/ok.ts"
git -C "$repo2" add -A
git -C "$repo2" commit -qm "[test] clean second commit"
base2=$(git -C "$repo2" rev-parse HEAD~1)
head2=$(git -C "$repo2" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo2" --base "$base2" --tip "$head2" 2>&1)
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL clean-passes: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
# 3. minified long lines are skipped, not hung: a 60KB single-line file passes fast

repo3=$(mkrepo minified)
python3 -c "open('$repo3/src/big.ts','w').write('import { ok } from \"./ok.ts\"; // ' + 'x'*60000 + '\n')"
git -C "$repo3" add -A
git -C "$repo3" commit -qm "[test] minified line"
base3=$(git -C "$repo3" rev-parse HEAD~1)
head3=$(git -C "$repo3" rev-parse HEAD)
start=$(date +%s)
out=$(sh "$CHECKER" --repo "$repo3" --base "$base3" --tip "$head3" 2>&1)
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" = "0" ] && [ "$elapsed" -lt 30 ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL minified-fast: rc=%s elapsed=%s out<<<%s>>>\n' "$rc" "$elapsed" "$out"
fi

# 4. planted: valid ../../src import from tests/cli passes (multi-level ../)
repo4=$(mkrepo multilevel)
mkdir -p "$repo4/tests/cli"
printf 'export const deep = 1;\n' > "$repo4/src/deep.ts"
printf 'import { deep } from "../../src/deep.ts";\nconsole.log(deep);\n' > "$repo4/tests/cli/check.ts"
git -C "$repo4" add -A
git -C "$repo4" commit -qm "[test] valid multilevel relative import"
base4=$(git -C "$repo4" rev-parse HEAD~1)
head4=$(git -C "$repo4" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo4" --base "$base4" --tip "$head4" 2>&1)
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL multilevel-valid: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
# 5. planted: missing ../../src/nope.ts from tests/cli is still refused
repo5=$(mkrepo multilevel-dangling)
mkdir -p "$repo5/tests/cli"
printf 'import { nope } from "../../src/nope.ts";\nconsole.log(nope);\n' > "$repo5/tests/cli/check.ts"
git -C "$repo5" add -A
git -C "$repo5" commit -qm "[test] dangling multilevel import"
base5=$(git -C "$repo5" rev-parse HEAD~1)
head5=$(git -C "$repo5" rev-parse HEAD)
out=$(sh "$CHECKER" --repo "$repo5" --base "$base5" --tip "$head5" 2>&1)
rc=$?
if [ "$rc" = "4" ] && printf '%s' "$out" | grep -q "$head5" && printf '%s' "$out" | grep -q "nope.ts"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL multilevel-dangling: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

printf 'commit-imports: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
