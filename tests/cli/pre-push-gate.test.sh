#!/bin/sh
# pre-push-gate.test.sh — GATE1 base-authoritative gate contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.88).
# Fixture git repos where HEAD rewrites the gate: the adapter must run the
# BASE archive's gate code, never HEAD's. Every verdict comes from the exit
# code plus the complete output.
set -u

ADAPTER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/pre-push-gate.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/pre-push-gate-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
create_checker_test_stubs() {
	repo=$1
	failing_test=${2:-}
	mkdir -p "$repo/tests/cli"
	for checker_test in publishability.test.sh doc-drift.test.sh derived-check.test.sh dispatch-check.test.sh br-shim.test.sh public-files.test.sh commit-msg-bead.test.sh check-pushed-beads.test.sh; do
		test_path="$repo/tests/cli/$checker_test"
		if [ "$checker_test" = "$failing_test" ]; then
			printf '#!/bin/sh\nprintf "CHECKER-FAIL: %s\\n" >&2\nexit 7\n' "$checker_test" > "$test_path"
		else
			printf '#!/bin/sh\nprintf "CHECKER-PASS: %s\\n"\n' "$checker_test" > "$test_path"
		fi
	done
}

mkrepo() {
	name=$1
	base_body=$2
	failing_test=${4:-}
	head_body=$3
	repo="$TMP/$name"
	rm -rf "$repo"
	mkdir -p "$repo/scripts" "$repo/var/agent-tmp"
	git -C "$repo" init -q
	git -C "$repo" config user.email "test@example.invalid"
	git -C "$repo" config user.name "worker-1"
	printf '#!/bin/sh\n%s\n' "$base_body" > "$repo/scripts/fresh-gate.sh"
	printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$repo/scripts/regexploit-gate.py"
	create_checker_test_stubs "$repo" "$failing_test"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] base gate"
	printf '#!/bin/sh\n%s\n' "$head_body" > "$repo/scripts/fresh-gate.sh"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] head gate"
	printf '%s' "$repo"
}

run_adapter() {
	repo=$1
	base=$(git -C "$repo" rev-parse HEAD~1)
	head=$(git -C "$repo" rev-parse HEAD)
	printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | (cd -- "$repo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
	printf '%s' "$?"
}

# 1. planted: HEAD deletes the gate step; the BASE gate still judges
repo=$(mkrepo weakened 'echo BASE-GATE' 'echo HEAD-GATE; exit 1')
rc=$(run_adapter "$repo")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "BASE-GATE" && ! printf '%s' "$out" | grep -q "HEAD-GATE"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL base-authoritative: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# 2. a failing BASE gate refuses even when HEAD passes
repo=$(mkrepo strictbase 'echo BASE-GATE-FAIL; exit 1' 'echo HEAD-GATE')
rc=$(run_adapter "$repo")
out=$(cat "$TMP/out")
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "BASE-GATE-FAIL"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL base-failure-refuses: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# 3. planted: a commit built on base B that deletes lines added at B+1 is
# refused, naming the commit that added them
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
stalerepo="$TMP/stale"
rm -rf "$stalerepo"
mkdir -p "$stalerepo/scripts" "$stalerepo/src" "$stalerepo/var/agent-tmp"
git -C "$stalerepo" init -q
git -C "$stalerepo" config user.email "test@example.invalid"
git -C "$stalerepo" config user.name "worker-1"
cp "$KITREPO/src/land-guard.ts" "$stalerepo/src/land-guard.ts"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$stalerepo/scripts/regexploit-gate.py"
printf '#!/bin/sh\nexit 0\n' > "$stalerepo/scripts/fresh-gate.sh"
chmod +x "$stalerepo/scripts/fresh-gate.sh"
printf 'one\n' > "$stalerepo/f.ts"
create_checker_test_stubs "$stalerepo"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] base B"
base=$(git -C "$stalerepo" rev-parse HEAD)
printf 'one\ntwo added at B+1\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] B+1 adds line two"
tip=$(git -C "$stalerepo" rev-parse HEAD)
git -C "$stalerepo" checkout -q "$base"
printf 'one\nmine without line two\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] stale candidate"
candidate=$(git -C "$stalerepo" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$candidate" "$tip" | (cd -- "$stalerepo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" != "0" ] && grep -q "stale deletion from $tip" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL stale-refused: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 4. control: the same candidate rebased onto the tip passes
git -C "$stalerepo" checkout -q "$tip"
printf 'one\ntwo added at B+1\nmine on top\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] fresh candidate"
fresh=$(git -C "$stalerepo" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$fresh" "$tip" | (cd -- "$stalerepo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL fresh-passes: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 5. every checker contract is invoked from the base archive and blocks on failure
for checker_test in publishability.test.sh doc-drift.test.sh derived-check.test.sh dispatch-check.test.sh br-shim.test.sh public-files.test.sh; do
	repo=$(mkrepo "checker-$checker_test" 'echo BASE-GATE' 'echo HEAD-GATE' "$checker_test")
	rc=$(run_adapter "$repo")
	out=$(cat "$TMP/out")
	if [ "$rc" = "7" ] && printf '%s' "$out" | grep -q "CHECKER-FAIL: $checker_test"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL checker-contract-%s: rc=%s out<<<%s>>>\n' "$checker_test" "$rc" "$out"
	fi
done

# 8. GATE2 row A: base-red contract plus a candidate fix is accepted with BASE-RED named
g2="$TMP/g2base"
rm -rf "$g2"
mkdir -p "$g2/scripts" "$g2/var/agent-tmp"
git -C "$g2" init -q
git -C "$g2" config user.email "test@example.invalid"
git -C "$g2" config user.name "worker-1"
printf '#!/bin/sh\nexit 0\n' > "$g2/scripts/fresh-gate.sh"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$g2/scripts/regexploit-gate.py"
create_checker_test_stubs "$g2" "br-shim.test.sh"
git -C "$g2" add -A
git -C "$g2" commit -qm "[test] base with red br-shim contract"
printf '#!/bin/sh\nprintf "CHECKER-PASS: br-shim.test.sh\\n"\n' > "$g2/tests/cli/br-shim.test.sh"
git -C "$g2" add -A
git -C "$g2" commit -qm "[test] head fixes br-shim contract"
g2base=$(git -C "$g2" rev-parse HEAD~1)
g2head=$(git -C "$g2" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$g2head" "$g2base" | (cd -- "$g2" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" = "0" ] && grep -q "BASE-RED checker-contract br-shim.test.sh" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL base-red-accepts-fix: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 9. GATE2 row B: base-red contract plus a still-red candidate is refused, never accepted
printf '#!/bin/sh\nexit 0\n' > "$g2/scripts/fresh-gate.sh"
printf '#!/bin/sh\nprintf "CHECKER-FAIL: br-shim.test.sh\\n" >&2\nexit 7\n' > "$g2/tests/cli/br-shim.test.sh"
git -C "$g2" add -A
git -C "$g2" commit -qm "[test] head still red"
g2head2=$(git -C "$g2" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$g2head2" "$g2base" | (cd -- "$g2" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" != "0" ] && grep -q "RED checker-contract br-shim.test.sh" "$TMP/out" && ! grep -q "candidate green" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL base-red-refuses-still-red: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 10. GATE2 row C: green base plus a candidate that adds a vulnerable regex is refused by the base gate scripts judging the candidate tree
g3="$TMP/g3base"
rm -rf "$g3"
mkdir -p "$g3/scripts" "$g3/var/agent-tmp"
git -C "$g3" init -q
git -C "$g3" config user.email "test@example.invalid"
git -C "$g3" config user.name "worker-1"
printf '#!/bin/sh\nexit 0\n' > "$g3/scripts/fresh-gate.sh"
cat > "$g3/scripts/regexploit-gate.py" <<'PYEOF'
#!/usr/bin/env python3
import subprocess, sys
args = sys.argv[1:]
head = args[args.index("--head") + 1] if "--head" in args else "HEAD"
base = args[args.index("--base") + 1] if "--base" in args else None
changed = subprocess.run(["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", base, head] if base else ["git", "ls-tree", "-r", "--name-only", head], capture_output=True, text=True).stdout.split()
bad = [p for p in changed if p.endswith(".ts") and "(a+)+b" in subprocess.run(["git", "show", f"{head}:{p}"], capture_output=True, text=True).stdout]
print("vulnerable: " + ", ".join(bad) if bad else "clean")
sys.exit(1 if bad else 0)
PYEOF
create_checker_test_stubs "$g3"
git -C "$g3" add -A
git -C "$g3" commit -qm "[test] green base"
printf 'const ok = /(a+)+b/.test(source);\n' > "$g3/evil.ts"
git -C "$g3" add -A
git -C "$g3" commit -qm "[test] head adds vulnerable regex"
g3base=$(git -C "$g3" rev-parse HEAD~1)
g3head=$(git -C "$g3" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$g3head" "$g3base" | (cd -- "$g3" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" != "0" ] && grep -q "vulnerable: evil.ts" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL green-base-refuses-break: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 5. planted: a scratch remote ref exports the budget skip; a main ref does not.
# The stub gate echoes the skip value so routing is proven without timing.
run_adapter_ref() {
	repo=$1
	remote=$2
	base=$(git -C "$repo" rev-parse HEAD~1)
	head=$(git -C "$repo" rev-parse HEAD)
	printf 'refs/heads/perf %s %s %s\n' "$head" "$remote" "$base" | (cd -- "$repo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
	printf '%s' "$?"
}
s4="$TMP/skiproute"
rm -rf "$s4"
mkdir -p "$s4/scripts" "$s4/var/agent-tmp"
git -C "$s4" init -q
git -C "$s4" config user.email "test@example.invalid"
git -C "$s4" config user.name "worker-1"
printf '#!/bin/sh\nprintf "SKIPVAL=%%s\\n" "$FRESH_GATE_SKIP_REGEX"\n' > "$s4/scripts/fresh-gate.sh"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$s4/scripts/regexploit-gate.py"
create_checker_test_stubs "$s4"
git -C "$s4" add -A
git -C "$s4" commit -qm "[test] skip routing base"
git -C "$s4" commit -qm "[test] skip routing head" --allow-empty
rc=$(run_adapter_ref "$s4" "refs/heads/scratch/x")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "SKIPVAL=scratch measurement ref; main pushes still judged"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scratch-exports-skip: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
rc=$(run_adapter_ref "$s4" "refs/heads/main")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "SKIPVAL=$" && ! printf '%s' "$out" | grep -q "scratch measurement ref"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL main-no-skip: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
printf 'pre-push-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
