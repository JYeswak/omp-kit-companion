#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# pre-push-gate.test.sh — GATE1 base-authoritative gate contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.88).
# Fixture git repos where HEAD rewrites the gate: the adapter must run the
# BASE archive's gate code, never HEAD's. Every verdict comes from the exit
# code plus the complete output.
set -u

ADAPTER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/pre-push-gate.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)/var/agent-tmp
mkdir -p "$REPO_TMP"
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/pre-push-gate-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
create_checker_test_stubs() {
	repo=$1
	failing_test=${2:-}
	mkdir -p "$repo/tests/cli"
	for checker_test in publishability.test.sh doc-drift.test.sh derived-check.test.sh dispatch-check.test.sh br-shim.test.sh public-files.test.sh commit-msg-bead.test.sh check-pushed-beads.test.sh release-train.test.sh; do
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
	printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | (cd -- "$repo" && GIT_DIR="$repo/.git" GIT_WORK_TREE="$repo" sh "$ADAPTER" > "$TMP/out" 2>&1)
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
 # 1a. the installed archive gate binds its run ledger to the pushing checkout,
 # not the temporary exact-commit export (which has no .git directory).
 # shellcheck disable=SC2016
repo=$(mkrepo ledger-bound 'mkdir -p "$(dirname "$FRESH_GATE_LEDGER")"; printf "%s\n" "$FRESH_GATE_LEDGER" > "$FRESH_GATE_LEDGER.probe"' 'echo HEAD-GATE')
rc=$(run_adapter "$repo")
ledger_probe="$repo/.git/omp-kit/fresh-gate-runs.jsonl.probe"
if [ "$rc" = "0" ] && [ -s "$ledger_probe" ] && [ "$(cat "$ledger_probe")" = "$repo/.git/omp-kit/fresh-gate-runs.jsonl" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL ledger-binding: rc=%s probe=%s out<<<%s>>>\n' "$rc" "$(cat "$ledger_probe" 2>/dev/null || true)" "$(cat "$TMP/out")"
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

# 2a. fixture identity writes from the gate must not reach the hook repository.
fixture="$TMP/git-env-fixture"
mkdir -p "$fixture"
git -C "$fixture" init -q
git -C "$fixture" config user.name "Sentinel"
repo=$(mkrepo scrub-git-env "git -C $fixture config user.name 'Fixture Identity'" "echo HEAD-GATE")
rc=$(run_adapter "$repo")
hook_name=$(git -C "$repo" config --local user.name)
fixture_name=$(git -C "$fixture" config --local user.name)
if [ "$rc" = "0" ] && [ "$hook_name" = "worker-1" ] && [ "$fixture_name" = "Fixture Identity" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scrub-git-env: rc=%s hook=%s fixture=%s out<<<%s>>>\n' "$rc" "$hook_name" "$fixture_name" "$(cat "$TMP/out")"
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
for checker_test in publishability.test.sh doc-drift.test.sh derived-check.test.sh dispatch-check.test.sh br-shim.test.sh public-files.test.sh commit-msg-bead.test.sh check-pushed-beads.test.sh; do
	repo=$(mkrepo "checker-$checker_test" 'echo BASE-GATE' 'echo HEAD-GATE' "$checker_test")
	rc=$(run_adapter "$repo")
	out=$(cat "$TMP/out")
	if [ "$rc" = "7" ] && printf '%s' "$out" | grep -q "CHECKER-FAIL: $checker_test"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL checker-contract-%s: rc=%s out<<<%s>>>\n' "$checker_test" "$rc" "$out"
	fi
done

# 6. planted: base archive carrying a failing doc-drift checker refuses, naming the surface
driftrepo="$TMP/drift"
rm -rf "$driftrepo"
mkdir -p "$driftrepo/scripts" "$driftrepo/var/agent-tmp"
git -C "$driftrepo" init -q
git -C "$driftrepo" config user.email "test@example.invalid"
git -C "$driftrepo" config user.name "worker-1"
printf '#!/bin/sh\nexit 0\n' > "$driftrepo/scripts/fresh-gate.sh"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$driftrepo/scripts/regexploit-gate.py"
create_checker_test_stubs "$driftrepo"
printf '#!/bin/sh\nprintf "doc-drift: serve|flag:--port\\n" >&2\nexit 1\n' > "$driftrepo/scripts/doc-drift-check.sh"
git -C "$driftrepo" add -A
git -C "$driftrepo" commit -qm "[test] base with failing drift checker"
printf '#!/bin/sh\n# head gate\nexit 0\n' > "$driftrepo/scripts/fresh-gate.sh"
git -C "$driftrepo" add -A
git -C "$driftrepo" commit -qm "[test] head"
driftbase=$(git -C "$driftrepo" rev-parse HEAD~1)
drifthead=$(git -C "$driftrepo" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$drifthead" "$driftbase" | (cd -- "$driftrepo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" != "0" ] && grep -q "RED doc-drift" "$TMP/out" && grep -q "serve|flag:--port" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL drift-wired-refuses: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 7. control: a base archive with a passing doc-drift checker lets the push through
printf '#!/bin/sh\nexit 0\n' > "$driftrepo/scripts/doc-drift-check.sh"
git -C "$driftrepo" add -A
git -C "$driftrepo" commit -qm "[test] base with passing drift checker"
printf '#!/bin/sh\nexit 0\n' > "$driftrepo/scripts/fresh-gate.sh"
git -C "$driftrepo" add -A
git -C "$driftrepo" commit -qm "[test] head over passing drift base"
driftbase2=$(git -C "$driftrepo" rev-parse HEAD~1)
drifthead2=$(git -C "$driftrepo" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$drifthead2" "$driftbase2" | (cd -- "$driftrepo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" = "0" ] && grep -q "GREEN doc-drift" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL drift-wired-passes: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

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
printf "#!/bin/sh\nprintf \"SKIPVAL=%%s\\\\n\" \"\$FRESH_GATE_SKIP_REGEX\"\n" > "$s4/scripts/fresh-gate.sh"
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

# ompkit-fp72.40: the gate removes its archive extracts on green; on red it keeps exactly one dir
# holding .owner and gate.log (the failing output), and keeps its exit code. An `exec` into the
# last step replaced the shell owning the EXIT trap, so every push leaked its extract.
leftover() { find "$1/var/agent-tmp" -maxdepth 1 -name 'pre-push-gate*' | wc -l | tr -d ' '; }
repo=$(mkrepo cleangreen 'echo BASE-GATE' 'echo HEAD-GATE')
rc=$(run_adapter "$repo")
if [ "$rc" = "0" ] && [ "$(leftover "$repo")" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL green-leaves-no-extract: rc=%s leftover=%s\n' "$rc" "$(leftover "$repo")"
fi
repo=$(mkrepo cleanred 'echo BASE-GATE-FAIL; exit 5' 'echo HEAD-GATE')
rc=$(run_adapter "$repo")
kept=$(find "$repo/var/agent-tmp" -maxdepth 1 -name 'pre-push-gate.*' ! -name 'pre-push-gate-base.*')
files=$( [ -n "$kept" ] && (cd "$kept" && find . ! -type d | sort | tr '\n' ' ') )
if [ "$rc" = "5" ] && [ "$(leftover "$repo")" = "1" ] && [ "$files" = "./.owner ./gate.log " ] && grep -q 'BASE-GATE-FAIL' "$kept/gate.log"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL red-keeps-only-log-and-rc: rc=%s leftover=%s files=<%s>\n' "$rc" "$(leftover "$repo")" "$files"
fi
# ompkit-fp72.40: a red before fresh-gate (an early checker) also keeps exactly its log and its
# exit code, and fresh-gate never runs after it.
repo=$(mkrepo earlyred 'echo FRESH-GATE-RAN' 'echo HEAD-GATE' publishability.test.sh)
rc=$(run_adapter "$repo")
kept=$(find "$repo/var/agent-tmp" -maxdepth 1 -name 'pre-push-gate.*' ! -name 'pre-push-gate-base.*')
files=$( [ -n "$kept" ] && (cd "$kept" && find . ! -type d | sort | tr '\n' ' ') )
if [ "$rc" = "7" ] && [ "$(leftover "$repo")" = "1" ] && [ "$files" = "./.owner ./gate.log " ] \
	&& grep -q 'RED checker-contract publishability.test.sh' "$kept/gate.log" && ! grep -q 'FRESH-GATE-RAN' "$kept/gate.log"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL early-red-keeps-log-and-rc: rc=%s leftover=%s files=<%s>\n' "$rc" "$(leftover "$repo")" "$files"
fi
# ompkit-fp72.40: a step that fails without an explicit exit (the regexploit gate) still stops the
# push: set -e must hold inside the logged body (POSIX drops it inside an AND-OR list).
printf '#!/usr/bin/env python3\nimport sys\nprint("REGEXPLOIT-RED")\nsys.exit(3)\n' > "$TMP/regexploit-red.py"
repo=$(mkrepo setered 'echo FRESH-GATE-RAN' 'echo HEAD-GATE')
git -C "$repo" checkout -q HEAD~1
cp "$TMP/regexploit-red.py" "$repo/scripts/regexploit-gate.py"
git -C "$repo" commit -qam "[test] base regexploit red"
git -C "$repo" commit -q --allow-empty -m "[test] head"
rc=$(run_adapter "$repo")
out=$(cat "$TMP/out")
if [ "$rc" = "3" ] && printf '%s' "$out" | grep -q 'REGEXPLOIT-RED' && ! printf '%s' "$out" | grep -q 'FRESH-GATE-RAN'; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL set-e-holds-in-logged-body: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# ompkit-fp72.40: a symlink inside the extract (a kit-update test fixture's prefix/bin/omp-kit link)
# kept its parent dirs non-empty, so cleanup that deleted only regular files left the whole tree.
repo=$(mkrepo cleansymlink "a=\$2; mkdir -p \"\$a/var/agent-tmp/kit-update-x/prefix/bin\"; ln -s ../releases/0.2.3/bin/omp-kit \"\$a/var/agent-tmp/kit-update-x/prefix/bin/omp-kit\"; echo BASE-GATE" 'echo HEAD-GATE')
rc=$(run_adapter "$repo")
if [ "$rc" = "0" ] && [ "$(leftover "$repo")" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL symlink-tree-leaves-no-extract: rc=%s leftover=%s\n' "$rc" "$(leftover "$repo")"
fi

# ompkit-fp72.40 planted negative: SIGKILL skips the trap, so the extract survives; it must carry an
# .owner naming the dead gate pid in a pid-named dir, and the real scratch reaper must judge it REAP.
repo=$(mkrepo killed "echo \$\$ > \"\$GATE_PIDFILE\"; exec sleep 30" 'echo HEAD-GATE')
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$repo" rev-parse HEAD~1)" > "$TMP/killed.in"
rm -f "$TMP/gate.pid"
( cd -- "$repo" && GATE_PIDFILE="$TMP/gate.pid" exec sh "$ADAPTER" ) < "$TMP/killed.in" > "$TMP/killed.out" 2>&1 &
apid=$!
i=0
while [ ! -s "$TMP/gate.pid" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
kill -9 "$apid" 2>/dev/null
[ -s "$TMP/gate.pid" ] && kill -9 "$(cat "$TMP/gate.pid")" 2>/dev/null
wait "$apid" 2>/dev/null
verdicts=""
for owned in "$repo"/var/agent-tmp/pre-push-gate."$apid".* "$repo"/var/agent-tmp/pre-push-gate-base."$apid".*; do
	[ -d "$owned" ] || { verdicts="$verdicts missing"; continue; }
	grep -qx "pid=$apid" "$owned/.owner" || { verdicts="$verdicts no-owner-pid"; continue; }
	v=$(OMP_KIT_SCRATCH_ROOTS="$repo/var/agent-tmp" bun "$KITREPO/src/cli.ts" scratch plan --json 2>>"$TMP/plan.err" | jq -r --arg d "$owned" '[.. | objects | select(.dir? == $d) | .action] | first // "absent"')
	verdicts="$verdicts $v"
done
if [ -s "$TMP/gate.pid" ] && [ "$verdicts" = " REAP REAP" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL killed-gate-extract-reapable: verdicts=%s plan-stderr<<<%s>>> out<<<%s>>>\n' "$verdicts" "$(cat "$TMP/plan.err" 2>/dev/null)" "$(cat "$TMP/killed.out" 2>/dev/null)"
fi
# ompkit-fp72.40: SIGTERM interrupts the gate mid-run. The trap marks the run red BEFORE
# cleanup, so the extract tree is removed (AC2) while the failed parent keeps exactly .owner
# + gate.log naming the dead gate pid (AC3). Never SIGKILL here: that skips the trap and
# tests a different path (see killed-gate-extract-reapable above).
repo=$(mkrepo termred "echo \$\$ > \"\$GATE_PIDFILE\"; exec sleep 30" 'echo HEAD-GATE')
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$repo" rev-parse HEAD~1)" > "$TMP/term.in"
rm -f "$TMP/term.pid"
( cd -- "$repo" && GATE_PIDFILE="$TMP/term.pid" exec sh "$ADAPTER" ) < "$TMP/term.in" > "$TMP/term.out" 2>&1 &
tapid=$!
ti=0
while [ ! -s "$TMP/term.pid" ] && [ "$ti" -lt 300 ]; do sleep 0.1; ti=$((ti + 1)); done
kill -TERM "$tapid" 2>/dev/null
wait "$tapid" 2>/dev/null
trc=$?
tkept=$(find "$repo/var/agent-tmp" -maxdepth 1 -name 'pre-push-gate.*' ! -name 'pre-push-gate-base.*')
tfiles=$( [ -n "$tkept" ] && (cd "$tkept" && find . ! -type d | sort | tr '\n' ' ') )
tdead=0; kill -0 "$tapid" 2>/dev/null || tdead=1
tbase=$(find "$repo/var/agent-tmp" -maxdepth 1 -name 'pre-push-gate-base.*')
if [ "$trc" = "143" ] && [ -n "$tkept" ] && [ "$tfiles" = "./.owner ./gate.log " ] \
	&& [ ! -d "$tkept/tree" ] && grep -qx "pid=$tapid" "$tkept/.owner" && [ "$tdead" = "1" ] \
	&& [ -z "$tbase" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL term-interrupt-keeps-log-not-tree: rc=%s kept=%s files=<%s> base=<%s>\n' "$trc" "$tkept" "$tfiles" "$tbase"
fi
# RX5: a real local Git push must run the archive gate and refuse a planted vulnerable regex.
realrepo="$TMP/real-regexploit-push"
remote="$TMP/real-regexploit-origin.git"
mkdir -p "$realrepo/scripts" "$realrepo/src" "$realrepo/var/agent-tmp"
git -C "$realrepo" init -q --initial-branch=main
git -C "$realrepo" config user.email "test@example.invalid"
git -C "$realrepo" config user.name "worker-1"
git -C "$realrepo" config core.hooksPath "$realrepo/.git/hooks"
cp "$ADAPTER" "$realrepo/scripts/pre-push-gate.sh"
cp "$KITREPO/scripts/regexploit-gate.py" "$realrepo/scripts/regexploit-gate.py"
cp "$KITREPO/scripts/pysafe.py" "$realrepo/scripts/pysafe.py"
git -C "$realrepo" add -- scripts/pre-push-gate.sh scripts/regexploit-gate.py scripts/pysafe.py
git -C "$realrepo" commit -qm "[test] ompkit-xade baseline"
git init -q --bare "$remote"
git -C "$realrepo" remote add origin "$remote"
git -C "$realrepo" push -q origin main >"$TMP/real-regexploit-baseline.out" 2>&1
base_push_rc=$?
base=$(git -C "$realrepo" rev-parse HEAD)
printf 'export const vulnerable = /(a+)+b/;\n' > "$realrepo/src/xade-vuln.ts"
git -C "$realrepo" add -- src/xade-vuln.ts
git -C "$realrepo" commit -qm "[test] ompkit-xade planted regex"
head=$(git -C "$realrepo" rev-parse HEAD)
origin_before=$(git --git-dir="$remote" rev-parse refs/heads/main)
printf '#!/bin/sh\nexec sh "%s/scripts/pre-push-gate.sh"\n' "$realrepo" > "$realrepo/.git/hooks/pre-push"
chmod +x "$realrepo/.git/hooks/pre-push"
git -C "$realrepo" push origin main >"$TMP/real-regexploit-push.out" 2>&1
push_rc=$?
origin_after=$(git --git-dir="$remote" rev-parse refs/heads/main)
out=$(cat "$TMP/real-regexploit-push.out")
if [ "$base_push_rc" = "0" ] && [ "$head" != "$base" ] && [ "$push_rc" = "1" ] \
	&& [ "$origin_before" = "$base" ] && [ "$origin_after" = "$base" ] \
	&& printf '%s' "$out" | grep -Fq 'src/xade-vuln.ts:1: regexploit found a vulnerable regular expression'; then
	pass=$((pass + 1))
	printf 'PASS real-git-regexploit-refused: push exit 1; origin main unchanged at %s\n' "$origin_after"
else
	fail=$((fail + 1)); printf 'FAIL real-git-regexploit-refused: base_push_rc=%s push_rc=%s before=%s after=%s out<<<%s>>>\n' "$base_push_rc" "$push_rc" "$origin_before" "$origin_after" "$out"
fi

# GATESCR1 (ompkit-fp72.40): every per-push extract is removed on every exit path, now, not later.
# An extract is a gate dir holding anything besides .owner and gate.log (the red record a refused or
# interrupted push keeps). Each case below names the mutant it fails on.
extracts() {
	n=0
	for d in "$1"/var/agent-tmp/pre-push-gate.* "$1"/var/agent-tmp/pre-push-gate-base.* "$1"/var/agent-tmp/fresh-gate.*; do
		[ -d "$d" ] || continue
		find "$d" -mindepth 1 -maxdepth 1 ! -name .owner ! -name gate.log | grep -q . && n=$((n + 1))
	done
	printf '%s' "$n"
}
alive() { s=$(ps -o stat= -p "$1" 2>/dev/null) || return 1; case "$s" in *Z*|'') return 1 ;; esac; }
# wait_gone PID TICKS: status 0 once PID has exited, polling every 0.1 s for at most TICKS polls.
wait_gone() { i=0; while alive "$1" && [ "$i" -lt "$2" ]; do sleep 0.1; i=$((i + 1)); done; ! alive "$1"; }
wait_files() { i=0; for f; do while [ ! -s "$f" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done; done; }
reap() { for f; do [ -s "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done; return 0; }
# The hanging base gate: a plain child, plus a child that leads its own process group and leaves an
# orphan in that group (reparented to init, so only the process-group stop reaches it).
cat > "$TMP/orphan.py" <<'PYEOF'
import os, sys, time
os.setpgid(0, 0)
if os.fork() == 0:
    if os.fork() == 0:
        open(sys.argv[1] + ".tmp", "w").write(str(os.getpid()))
        os.rename(sys.argv[1] + ".tmp", sys.argv[1])
        time.sleep(300)
    os._exit(0)
time.sleep(300)
PYEOF
HANG="echo \$\$ > \"\$GATE_PIDFILE\"; python3 '$TMP/orphan.py' \"\$ORPHAN_PIDFILE\" & echo \$! > \"\$ORPHAN_PIDFILE.leader\"; sleep 300 & echo \$! > \"\$SLEEP_PIDFILE\"; wait"
# start_hanging NAME [setsid]: run the adapter on a fresh hanging repo in the background; sets repo,
# hpid (the adapter) and the pidfiles under $TMP/NAME.*. A background job of this shell inherits an
# ignored SIGINT, which a shell cannot trap, so the launcher restores the default disposition a
# terminal push has; setsid gives the adapter its own process group, as git_converge spawns git.
start_hanging() {
	repo=$(mkrepo "$1" "$HANG" 'echo HEAD-GATE')
	printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$repo" rev-parse HEAD~1)" > "$TMP/$1.in"
	rm -f "$TMP/$1.gate" "$TMP/$1.orphan" "$TMP/$1.orphan.leader" "$TMP/$1.sleep"
	( cd -- "$repo" && GATE_PIDFILE="$TMP/$1.gate" ORPHAN_PIDFILE="$TMP/$1.orphan" SLEEP_PIDFILE="$TMP/$1.sleep" SETSID="${2:-}" \
		exec python3 -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
if os.environ.pop("SETSID") == "setsid":
    os.setsid()
os.execvp("sh", ["sh"] + sys.argv[1:])' "$ADAPTER" ) < "$TMP/$1.in" > "$TMP/$1.out" 2>&1 &
	hpid=$!
	wait_files "$TMP/$1.gate" "$TMP/$1.orphan" "$TMP/$1.orphan.leader" "$TMP/$1.sleep"
	sleep 0.3
}
# judge_signalled NAME RC [PROCS]: the adapter exited within 15 s with RC, every listed gate process
# is gone (default: the stub, its plain child, the group leader and its orphan), and no extract is left.
judge_signalled() {
	prompt=1; wait_gone "$hpid" 150 || prompt=0
	[ "$prompt" = 1 ] || kill -9 "$hpid" 2>/dev/null
	wait "$hpid" 2>/dev/null
	src=$?
	survivors=""
	for f in ${3:-gate sleep orphan.leader orphan}; do alive "$(cat "$TMP/$1.$f" 2>/dev/null || echo 0)" && survivors="$survivors $f"; done
	reap "$TMP/$1.gate" "$TMP/$1.orphan" "$TMP/$1.orphan.leader" "$TMP/$1.sleep"
	left=$(extracts "$repo")
	if [ "$prompt" = 1 ] && [ "$src" = "$2" ] && [ -z "$survivors" ] && [ "$left" = "0" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL %s: prompt=%s rc=%s (want %s) survivors=<%s> extracts=%s out<<<%s>>>\n' "$1" "$prompt" "$src" "$2" "$survivors" "$left" "$(cat "$TMP/$1.out")"
	fi
}
# Mutants: the pre-fix foreground body (trap deferred: not prompt), no stop_descendants (children
# survive), no process-group stop (the orphan survives), no trap for the signal (extracts stay).
start_hanging scr-term; kill -s TERM "$hpid"; judge_signalled scr-term 143
start_hanging scr-hup; kill -s HUP "$hpid"; judge_signalled scr-hup 129
# Ctrl-C reaches the hook shell; the backgrounded body ignores SIGINT, so the handler must stop it.
start_hanging scr-int; kill -s INT "$hpid"; judge_signalled scr-int 130
# A timeout (timeout(1), a harness deadline) TERMs the whole process group at once. The orphan's
# group is not judged here: its leader's parent (the stub shell) dies on that same signal before the
# handler snapshots the tree, so nothing left in the tree names that group (a residual of
# group-wide signals that no handler can close).
start_hanging scr-timeout setsid; kill -s TERM -- "-$hpid"; judge_signalled scr-timeout 143 "gate sleep"

# Success and failure leave 0 extracts (a red keeps only its .owner + gate.log record).
repo=$(mkrepo scr-green 'echo BASE-GATE' 'echo HEAD-GATE')
grc=$(run_adapter "$repo"); gleft=$(extracts "$repo")
repo=$(mkrepo scr-red 'echo BASE-GATE-FAIL; exit 5' 'echo HEAD-GATE')
rrc=$(run_adapter "$repo"); rleft=$(extracts "$repo")
if [ "$grc" = "0" ] && [ "$gleft" = "0" ] && [ "$rrc" = "5" ] && [ "$rleft" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scr-green-red-zero-extracts: green rc=%s extracts=%s red rc=%s extracts=%s\n' "$grc" "$gleft" "$rrc" "$rleft"
fi

# SIGKILL skips every trap, so the extracts stay; while a process still holds one the next run's
# sweep keeps it (mutant: held() always false), and once nothing holds it the sweep removes it
# (mutant: no sweep call). The kept red record (.owner + gate.log) is not an extract.
start_hanging scr-kill
kill -9 "$hpid" 2>/dev/null; reap "$TMP/scr-kill.gate" "$TMP/scr-kill.orphan" "$TMP/scr-kill.orphan.leader" "$TMP/scr-kill.sleep"
wait "$hpid" 2>/dev/null
i=0; while [ "$(extracts "$repo")" = "0" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
sleep 0.5
kleft=$(extracts "$repo")
ktree=$(find "$repo/var/agent-tmp" -maxdepth 1 -name "pre-push-gate.$hpid.*")
# The holder keeps an open descriptor on a file inside the extract, as a still-running test would.
# shellcheck disable=SC2217
sleep 60 < "$ktree/tree/scripts/fresh-gate.sh" &
holder=$!
printf '#!/bin/sh\necho BASE-GATE\n' > "$repo/scripts/fresh-gate.sh"
git -C "$repo" commit -qam "[test] green base"
git -C "$repo" commit -q --allow-empty -m "[test] green head"
hrc=$(run_adapter "$repo"); hout=$(cat "$TMP/out"); hleft=$(extracts "$repo")
htree=0; [ -d "$ktree/tree" ] && htree=1
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
src=$(run_adapter "$repo"); sout=$(cat "$TMP/out"); sleft=$(extracts "$repo")
if [ "$kleft" -ge 1 ] && [ -n "$ktree" ] && [ "$hrc" = "0" ] && [ "$hleft" -ge 1 ] && [ "$htree" = 1 ] \
	&& printf '%s' "$hout" | grep -q "gate-sweep: kept $ktree" \
	&& [ "$src" = "0" ] && [ "$sleft" = "0" ] && printf '%s' "$sout" | grep -q "gate-sweep: removed extract $ktree" \
	&& [ -f "$ktree/.owner" ] && [ -f "$ktree/gate.log" ] && [ ! -d "$ktree/tree" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scr-kill-held-then-swept: killed=%s tree=%s kept=<%s> held rc=%s left=%s swept rc=%s left=%s held<<<%s>>> swept<<<%s>>>\n' "$kleft" "$ktree" "$( [ -d "$ktree" ] && (cd "$ktree" && find . | sort | tr '\n' ' '))" "$hrc" "$hleft" "$src" "$sleft" "$hout" "$sout"
fi

# A live gate's extract is never swept, even with nothing holding it (mutant: owner_running always
# false); a recorded pid that now names a different process (process_start differs: pid reuse) is
# not that gate, so its extract goes (mutant: owner_running ignores process_start).
repo=$(mkrepo scr-live 'echo BASE-GATE' 'echo HEAD-GATE')
sleep 120 &
livepid=$!
livestart=$(ps -p "$livepid" -o lstart= | sed 's/^ *//;s/ *$//')
mkdir -p "$repo/var/agent-tmp/pre-push-gate.$livepid.LIVE01/tree" "$repo/var/agent-tmp/pre-push-gate-base.$livepid.REUSE1/tree"
printf 'x\n' > "$repo/var/agent-tmp/pre-push-gate.$livepid.LIVE01/tree/f"
printf 'x\n' > "$repo/var/agent-tmp/pre-push-gate-base.$livepid.REUSE1/tree/f"
printf 'pid=%s\nprocess_start=%s\nlabel=pre-push-gate\n' "$livepid" "$livestart" > "$repo/var/agent-tmp/pre-push-gate.$livepid.LIVE01/.owner"
printf 'pid=%s\nprocess_start=Thu Jan  1 00:00:00 1970\nlabel=pre-push-gate-base\n' "$livepid" > "$repo/var/agent-tmp/pre-push-gate-base.$livepid.REUSE1/.owner"
lrc=$(run_adapter "$repo"); lout=$(cat "$TMP/out")
kill "$livepid" 2>/dev/null; wait "$livepid" 2>/dev/null
if [ "$lrc" = "0" ] && [ -f "$repo/var/agent-tmp/pre-push-gate.$livepid.LIVE01/tree/f" ] \
	&& [ ! -e "$repo/var/agent-tmp/pre-push-gate-base.$livepid.REUSE1" ] \
	&& ! printf '%s' "$lout" | grep -q "LIVE01"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scr-live-kept-reused-swept: rc=%s out<<<%s>>>\n' "$lrc" "$lout"
fi

# stdin: a base gate that reads stdin to EOF (omp -p's readPipedInput shape). Fed through a pipe
# whose writer stays open (a harness with pty off), the pre-fix gate blocks until the writer goes;
# with stdin closed it finishes at once. Mutant: the pre-fix body (foreground, inheriting stdin).
# Control: a writerless pipe (the writer already closed, as git's chain runner leaves it) reads EOF
# and finishes either way, so it is not what wedged a push.
repo=$(mkrepo scr-stdin 'cat >/dev/null; echo STDIN-EOF' 'echo HEAD-GATE')
line=$(printf 'refs/heads/main %s refs/heads/main %s' "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$repo" rev-parse HEAD~1)")
kill_tree() {
	for p in $(ps -A -o pid= -o ppid= | awk -v r="$1" '{ p[$1] = $2 } END { m[r] = 1; g = 1; while (g) { g = 0; for (x in p) if (!(x in m) && (p[x] in m)) { m[x] = 1; g = 1 } } for (x in m) print x }'); do
		kill -9 "$p" 2>/dev/null
	done
	return 0
}
rm -f "$TMP/stdin.pid"
# shellcheck disable=SC2016
( { printf '%s\n' "$line"; sleep 20; } | sh -c 'echo $$ > "$1"; cd -- "$2" && exec sh "$3"' sh "$TMP/stdin.pid" "$repo" "$ADAPTER" > "$TMP/stdin-open.out" 2>&1 ) &
spid=$!
wait_files "$TMP/stdin.pid"
sdone=1; wait_gone "$(cat "$TMP/stdin.pid")" 100 || sdone=0
kill_tree "$spid"
wait "$spid" 2>/dev/null
printf '%s\n' "$line" | (cd -- "$repo" && exec sh "$ADAPTER") > "$TMP/stdin-closed.out" 2>&1
crc=$?
if [ "$sdone" = 1 ] && grep -q STDIN-EOF "$TMP/stdin-open.out" && [ "$crc" = "0" ] && grep -q STDIN-EOF "$TMP/stdin-closed.out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scr-stdin-open-writer: finished=%s writerless rc=%s open<<<%s>>>\n' "$sdone" "$crc" "$(cat "$TMP/stdin-open.out")"
fi

# fresh-gate.sh itself: its WORK dir is pid-named with .owner, traps are set before it exists, a
# TERM mid-run stops its tree promptly and removes WORK (mutants: foreground steps, trap after
# mktemp); a SIGKILLed fresh-gate leaves WORK, which the next push's sweep removes.
repo=$(mkrepo scr-fresh 'echo BASE-GATE' 'echo HEAD-GATE')
mkdir -p "$repo/tools" "$TMP/fg-archive/scripts" "$TMP/fg-archive/.git"
cp "$KITREPO/scripts/fresh-gate.sh" "$repo/tools/fresh-gate.sh"
# shellcheck disable=SC2016
printf '#!/bin/sh\necho $$ > "$FG_PIDFILE"\nsleep 300 &\necho $! > "$FG_SLEEPFILE"\nwait\n' > "$TMP/fg-archive/scripts/build-manifest.sh"
: > "$TMP/fg-archive/scripts/ttsr-harness.ts"
fg_run() {
	rm -f "$TMP/fg.pid" "$TMP/fg.sleep"
	( cd -- "$repo" && FG_PIDFILE="$TMP/fg.pid" FG_SLEEPFILE="$TMP/fg.sleep" FRESH_GATE_LEDGER='' \
		exec sh "$repo/tools/fresh-gate.sh" --archive-dir "$TMP/fg-archive" --changed-file README.md ) > "$TMP/fg.out" 2>&1 &
	fgpid=$!
	wait_files "$TMP/fg.pid" "$TMP/fg.sleep"
	sleep 0.3
}
fg_run
fgwork=$(find "$repo/var/agent-tmp" -maxdepth 1 -name "fresh-gate.$fgpid.*")
fgowner=$(grep -c "^pid=$fgpid\$" "$fgwork/.owner" 2>/dev/null)
kill -s TERM "$fgpid"
fprompt=1; wait_gone "$fgpid" 150 || fprompt=0
[ "$fprompt" = 1 ] || kill -9 "$fgpid" 2>/dev/null
wait "$fgpid" 2>/dev/null
frc=$?
fsleep=0; alive "$(cat "$TMP/fg.sleep")" && fsleep=1
reap "$TMP/fg.pid" "$TMP/fg.sleep"
fleft=$(extracts "$repo")
fg_run
kill -9 "$fgpid"; reap "$TMP/fg.pid" "$TMP/fg.sleep"; wait "$fgpid" 2>/dev/null
sleep 0.3
kwork=$(find "$repo/var/agent-tmp" -maxdepth 1 -name "fresh-gate.$fgpid.*")
wrc=$(run_adapter "$repo"); wout=$(cat "$TMP/out")
if [ -n "$fgwork" ] && [ "$fgowner" = "1" ] && [ "$fprompt" = 1 ] && [ "$frc" = "143" ] && [ "$fsleep" = 0 ] && [ "$fleft" = "0" ] \
	&& [ -n "$kwork" ] && [ "$wrc" = "0" ] && [ ! -e "$kwork" ] && printf '%s' "$wout" | grep -q "gate-sweep: removed extract $kwork"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scr-fresh-gate-work: work=%s owner=%s prompt=%s rc=%s sleep_alive=%s left=%s killed_work=%s sweep rc=%s out<<<%s>>> sweep<<<%s>>>\n' "$fgwork" "$fgowner" "$fprompt" "$frc" "$fsleep" "$fleft" "$kwork" "$wrc" "$(cat "$TMP/fg.out")" "$wout"
fi

# LAND1 (ompkit-rhy9.12): the full-suite verdict for the exact candidate tree. The fixture base
# archive carries the REAL scripts/full-suite-verdict.sh beside a stub fresh-gate, so every case
# below runs the real judging code against a tiny real suite. Case B is the enforcement specimen:
# removing the verdict step from the adapter lets the red tree through, so the case fails.
mkverdictrepo() {
	name=$1
	repo="$TMP/$name"
	rm -rf "$repo"
	mkdir -p "$repo/scripts" "$repo/tests/cli" "$repo/var/agent-tmp"
	git -C "$repo" init -q
	git -C "$repo" config user.email "test@example.invalid"
	git -C "$repo" config user.name "worker-1"
	cp "$KITREPO/scripts/full-suite-verdict.sh" "$repo/scripts/full-suite-verdict.sh"
	printf '#!/bin/sh\necho VERDICT-STUB-GATE\n' > "$repo/scripts/fresh-gate.sh"
	printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$repo/scripts/regexploit-gate.py"
	create_checker_test_stubs "$repo"
	printf 'import { test, expect } from "bun:test";\ntest("green", () => { expect(1 + 1).toBe(2); });\n' > "$repo/tests/cli/green.test.ts"
	printf '#!/bin/sh\necho shell-suite-ok\n' > "$repo/tests/cli/green.test.sh"
	printf 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\nif __name__ == "__main__":\n    unittest.main()\n' > "$repo/tests/cli/green_test.py"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] verdict base"
	printf '#!/bin/sh\necho shell-suite-ok\nprintf "extra-ok\\n"\n' > "$repo/tests/cli/extra.test.sh"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] verdict head"
	printf '%s' "$repo"
}
verdictcache() {
	repo=$1
	tree=$(git -C "$repo" rev-parse "HEAD^{tree}")
	printf '%s' "$repo/.git/omp-kit/full-suite-verdicts/$tree.json"
}

# LAND1-A control: a green tree passes and records a complete PASS verdict for its exact tree.
vrepro=$(mkverdictrepo land1a)
rc=$(run_adapter "$vrepro")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "GREEN full-suite-verdict" && [ -f "$(verdictcache "$vrepro")" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1a-control: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# LAND1-B planted: a tree failing an otherwise-unselected shell suite is refused. fresh-gate is a
# passing stub, so only the full-suite verdict can refuse this tree.
vrepro=$(mkverdictrepo land1b)
printf '#!/bin/sh\necho unselected-suite-runs\nexit 3\n' > "$vrepro/tests/cli/unselected.test.sh"
git -C "$vrepro" add -A
git -C "$vrepro" commit -qm "[test] verdict red head"
rc=$(run_adapter "$vrepro")
out=$(cat "$TMP/out")
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "RED full-suite-verdict"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1b-refuse-unselected: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# LAND1-C: retrying the same red tree reuses the cached RED without rerunning.
rc=$(run_adapter "$vrepro")
out=$(cat "$TMP/out")
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "VERDICT REUSED FAIL" && ! printf '%s' "$out" | grep -q "running the complete suite"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1c-reuse-red: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# LAND1-D: a changed tree cannot reuse the old verdict; it reruns the complete suite.
printf '#!/bin/sh\necho another-green-suite\n' > "$vrepro/tests/cli/another.test.sh"
git -C "$vrepro" add -A
git -C "$vrepro" commit -qm "[test] verdict changed tree"
rc=$(run_adapter "$vrepro")
out=$(cat "$TMP/out")
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "running the complete suite" && ! printf '%s' "$out" | grep -q "VERDICT REUSED"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1d-changed-tree-reruns: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# LAND1-E: the same tree under changed check bytes cannot reuse the old verdict. base2 carries a
# comment-only change to the judging script; head2 re-commits head1's exact content under base2,
# so the candidate tree is byte-identical while the checks identity moved.
erepro="$TMP/land1e"
rm -rf "$erepro"
mkdir -p "$erepro/scripts" "$erepro/tests/cli" "$erepro/var/agent-tmp"
git -C "$erepro" init -q
git -C "$erepro" config user.email "test@example.invalid"
git -C "$erepro" config user.name "worker-1"
cp "$KITREPO/scripts/full-suite-verdict.sh" "$erepro/scripts/full-suite-verdict.sh"
printf '#!/bin/sh\necho VERDICT-STUB-GATE\n' > "$erepro/scripts/fresh-gate.sh"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$erepro/scripts/regexploit-gate.py"
create_checker_test_stubs "$erepro"
printf 'import { test, expect } from "bun:test";\ntest("green", () => { expect(1 + 1).toBe(2); });\n' > "$erepro/tests/cli/green.test.ts"
git -C "$erepro" add -A
git -C "$erepro" commit -qm "[test] e base1"
printf '#!/bin/sh\necho shell-suite-ok\n' > "$erepro/tests/cli/extra.test.sh"
git -C "$erepro" add -A
git -C "$erepro" commit -qm "[test] e head1"
head1=$(git -C "$erepro" rev-parse HEAD)
rc=$(run_adapter "$erepro")
out1=$(cat "$TMP/out")
git -C "$erepro" checkout -q HEAD~1
printf '# judging-script comment change only\n' >> "$erepro/scripts/full-suite-verdict.sh"
git -C "$erepro" add -A
git -C "$erepro" commit -qm "[test] e base2 judge change"
git -C "$erepro" checkout -q "$head1" -- scripts tests
git -C "$erepro" commit -qm "[test] e head2 same tree"
tree1=$(git -C "$erepro" rev-parse "$head1^{tree}")
tree2=$(git -C "$erepro" rev-parse "HEAD^{tree}")
rc=$(run_adapter "$erepro")
out=$(cat "$TMP/out")
if [ "$tree1" = "$tree2" ] && [ "$rc" = "0" ] && printf '%s' "$out1" | grep -q "GREEN full-suite-verdict" \
	&& printf '%s' "$out" | grep -q "running the complete suite" && ! printf '%s' "$out" | grep -q "VERDICT REUSED"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1e-changed-checks-rerun: tree1=%s tree2=%s rc=%s out<<<%s>>>\n' "$tree1" "$tree2" "$rc" "$out"
fi

# LAND1-F: the same tree under a changed runtime identity cannot reuse the old verdict.
frepro=$(mkverdictrepo land1f)
rc=$(run_adapter "$frepro")
rc2=$(FULL_SUITE_RUNTIME_ID=legB run_adapter "$frepro")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && [ "$rc2" = "0" ] && printf '%s' "$out" | grep -q "running the complete suite" && ! printf '%s' "$out" | grep -q "VERDICT REUSED"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1f-changed-runtime-reruns: rc=%s rc2=%s out<<<%s>>>\n' "$rc" "$rc2" "$out"
fi

# LAND1-G: a corrupt cache entry is a miss, never a pass; the suite reruns and passes.
grepro=$(mkverdictrepo land1g)
rc=$(run_adapter "$grepro")
printf 'corrupt{{{' > "$(verdictcache "$grepro")"
rc=$(run_adapter "$grepro")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "running the complete suite" && printf '%s' "$out" | grep -q "GREEN full-suite-verdict"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1g-corrupt-reruns: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# LAND1-H: a timed-out suite is non-pass and caches nothing, so a retry would rerun.
hrepro="$TMP/land1h"
rm -rf "$hrepro"
mkdir -p "$hrepro/scripts" "$hrepro/tests/cli" "$hrepro/var/agent-tmp"
git -C "$hrepro" init -q
git -C "$hrepro" config user.email "test@example.invalid"
git -C "$hrepro" config user.name "worker-1"
cp "$KITREPO/scripts/full-suite-verdict.sh" "$hrepro/scripts/full-suite-verdict.sh"
printf '#!/bin/sh\necho VERDICT-STUB-GATE\n' > "$hrepro/scripts/fresh-gate.sh"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$hrepro/scripts/regexploit-gate.py"
create_checker_test_stubs "$hrepro"
printf '#!/bin/sh\necho hanging-suite-start\nsleep 120\necho hanging-suite-end\n' > "$hrepro/tests/cli/hang.test.sh"
git -C "$hrepro" add -A
git -C "$hrepro" commit -qm "[test] h base"
git -C "$hrepro" commit -q --allow-empty -m "[test] h head"
htree=$(git -C "$hrepro" rev-parse "HEAD^{tree}")
rc=$(FULL_SUITE_TIMEOUT_SECS=10 run_adapter "$hrepro")
out=$(cat "$TMP/out")
hentry="$hrepro/.git/omp-kit/full-suite-verdicts/$htree.json"
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "timed out" && [ ! -f "$hentry" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1h-timeout-nocache: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# LAND1-I: a base archive predating the checker skips with a named SKIP and passes the stub gate.
irepro=$(mkrepo skipverdict 'echo BASE-GATE' 'echo HEAD-GATE')
rc=$(run_adapter "$irepro")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "SKIP full-suite-verdict: checker absent from base archive"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL land1i-bootstrap-skip: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

printf 'pre-push-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
