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
if (cd "$repo" && sh "$CHECK" --prepare "$msg" > "$TMP/out" 2>&1); then ok; else bad "green: rc!=0 $(cat "$TMP/out")"; fi
same() { if [ "$1" = "$2" ]; then ok; else bad "$3: got '$1' want '$2'"; fi; }
refs=$(cut -d'|' -f1 "$GATE_LOG")
IFS=' ' read -r lref cand rref rsha <<EOF
$refs
EOF
same "$lref $rref $rsha" "refs/heads/main refs/heads/main $(git -C "$repo" rev-parse origin/main)" "green: ref line"
same "$(git -C "$repo" rev-parse "$cand^{tree}")" "$(git -C "$repo" write-tree)" "green: candidate tree is the staged tree"
same "$(git -C "$repo" rev-parse "$cand^")" "$(git -C "$repo" rev-parse HEAD)" "green: candidate parent is HEAD"
same "$(cut -d'|' -f2 "$GATE_LOG")" 0 "green: release verdict opted out"
same "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$repo" rev-parse origin/main)" "green: no ref moved"

# 2. RED: a staged file the push gate refuses makes the commit refuse with the gate's status.
printf 'x\n' > "$repo/BROKEN"
git -C "$repo" add BROKEN
if (cd "$repo" && sh "$CHECK" --prepare "$msg" > "$TMP/out" 2>&1); then bad "red: rc=0"; else
	rc=$?
	if [ "$rc" = 7 ] && grep -q 'commit-gate: REFUSED' "$TMP/out"; then ok; else bad "red: rc=$rc $(cat "$TMP/out")"; fi
fi

# 3. GIT_INDEX_FILE (commit --only) is honored: a private index without BROKEN is GREEN even though
#    the shared index stages it.
idx="$TMP/only.index"
GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD
if (cd "$repo" && GIT_INDEX_FILE="$idx" sh "$CHECK" --prepare "$msg" > "$TMP/out" 2>&1); then ok; else bad "only-index: rc!=0 $(cat "$TMP/out")"; fi

# 4. Nothing to mirror: no installed fresh-gate member, or a branch other than main -> admitted.
mv "$gate" "$gate.off"
if (cd "$repo" && sh "$CHECK" --prepare "$msg" > "$TMP/out" 2>&1); then ok; else bad "no-gate: rc!=0"; fi
mv "$gate.off" "$gate"
git -C "$repo" checkout -q -b side
if (cd "$repo" && sh "$CHECK" --prepare "$msg" > "$TMP/out" 2>&1); then ok; else bad "side-branch: rc!=0"; fi


# COMMITONCE1: exercise the real phase dispatcher, not a second selection table.
# Phase bodies are bounded fixture checks here; staged-candidate smoke runs cover
# the actual compiler/harness. An unrelated broken compiler must not block docs,
# while a changed compiler input must still refuse with its original status.
fresh_source=${FRESH_GATE_SOURCE:-$REPO/scripts/fresh-gate.sh}
python3 - "$fresh_source" "$TMP/dispatch-functions.sh" <<'PY'
import sys
from pathlib import Path
source = Path(sys.argv[1]).read_text()
functions = []
for name in ("phase_needed", "run_step", "judge_budget", "run_gate"):
    start = source.find("\n" + name + "() {")
    if start < 0:
        if name == "phase_needed":
            continue  # Incumbent dispatcher has no selector; docs must fail below.
        raise SystemExit("missing gate function: " + name)
    end = source.index("\n}\n", start)
    functions.append(source[start + 1:end + 3])
Path(sys.argv[2]).write_text("".join(functions))
PY
cat > "$TMP/dispatch.sh" <<'EOF'
set -eu
. "$1"
SCRIPT_DIR=$2
WORK=$3
CHANGED=$4
COMMIT=fixture
BASE=fixture-base
disk_pressure_flag() { :; }
record_run() { :; }
gate_manifest() { echo manifest >>"$WORK/calls"; }
gate_file_budget_policy() { echo file-budget-policy >>"$WORK/calls"; }
gate_cli_compile() {
	echo cli-compile >>"$WORK/calls"
	[ ! -f "$WORK/BROKEN" ] || return 7
}
gate_cli_boot() { echo cli-boot >>"$WORK/calls"; }
gate_harness() { echo harness-gate >>"$WORK/calls"; }
gate_notes() { echo notes >>"$WORK/calls"; }
gate_readme() { echo readme >>"$WORK/calls"; }
gate_focused() { echo focused >>"$WORK/calls"; }
run_gate
EOF
dispatch() {
	mkdir -p "$TMP/dispatch-work"
	: >"$TMP/dispatch-work/calls"
	if sh "$TMP/dispatch.sh" "$TMP/dispatch-functions.sh" "$REPO/scripts" "$TMP/dispatch-work" "$1" >"$TMP/dispatch.out" 2>&1; then
		dispatch_rc=0
	else
		dispatch_rc=$?
	fi
}
all_phases='manifest file-budget-policy cli-compile cli-boot harness-gate notes readme focused'
dispatch 'src/cli.ts'
same "$dispatch_rc" 0 "code: passing control"
same "$(paste -sd ' ' "$TMP/dispatch-work/calls")" "$all_phases" "code: ordered phases"
printf 'broken compiler input\n' >"$TMP/dispatch-work/BROKEN"
for path in docs/guide.md changelog.d/x-1.md; do
	dispatch "$path"
	same "$dispatch_rc" 0 "$path: unrelated broken compiler skipped"
	same "$(paste -sd ' ' "$TMP/dispatch-work/calls")" 'notes focused' "$path: no broad runtime phases"
done
dispatch 'src/cli.ts'
same "$dispatch_rc" 7 "code: planted broken read input refuses"
same "$(paste -sd ' ' "$TMP/dispatch-work/calls")" 'manifest file-budget-policy cli-compile' "code: stop at first red"
rm "$TMP/dispatch-work/BROKEN"
for path in README.md rules/example.md cases/cases.tsv .github/test-budget.json tests/cli/example.test.ts; do
	case "$path" in
		README.md) expected='notes readme focused' ;;
		rules/*) expected='manifest harness-gate notes readme focused' ;;
		cases/*) expected='harness-gate notes focused' ;;
		.github/test-budget.json) expected='file-budget-policy notes focused' ;;
		tests/*) expected='notes focused' ;;
	esac
	dispatch "$path"
	same "$dispatch_rc" 0 "$path: passing control"
	same "$(paste -sd ' ' "$TMP/dispatch-work/calls")" "$expected" "$path: input-scoped phases"
done
# A mixed diff must take the union, not let its first docs path hide code.
dispatch 'docs/guide.md
src/cli.ts'
same "$(paste -sd ' ' "$TMP/dispatch-work/calls")" "$all_phases" "mixed diff: code still judged"
printf 'commit-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
