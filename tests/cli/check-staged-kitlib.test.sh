#!/bin/sh
# check-staged-kitlib.test.sh — KITLIB-RATCHET gate contract (ompkit-qwqh1).
# The pre-commit member is installed by install-commit-msg-bead.sh into fresh
# fixture repos and judged through real `git commit` runs: a staged new bare
# subprocess.run (py), Bun.spawn (ts) or call-site `timeout N` (sh) is refused
# naming kitlib; the same call through kitlib passes; an untouched
# pre-existing site does not block and a new one beside it is refused; a
# reasoned "kitlib:" pragma passes and a reasonless one is refused; the
# `--only` temporary index is judged; a missing ratchet or engine copy
# refuses. The pre-push gate refuses a planted range that adds a raw spawn and
# passes the same step for a clean range.
# Every fixture lives in one kitlib-owned temp dir, removed by kitlib's traps.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
INSTALLER=$SCRIPTS/install-commit-msg-bead.sh
MEMBER=51-omp-kit-staged-kitlib
# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPTS/kitlib-tmp.sh"
kitlib_tmp TMP staged-kitlib-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

# new_repo NAME [FILE CONTENT]: a fresh repo whose root commit (made before
# any hook exists) optionally holds FILE, then the installer's chains.
new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	if [ $# -ge 3 ]; then printf '%s\n' "$3" > "$dir/$2" && git -C "$dir" add "$2"; fi
	git -C "$dir" commit -q --allow-empty --message "[test] root"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/$MEMBER" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && git commit -q "$@" 2>&1)
}

# PY_BAD carries a reasoned pysafe pragma (pysafe refuses every bare
# subprocess call): only the kitlib member judges it.
PY_BAD='import subprocess
subprocess.run(["x"], timeout=5, stdin=subprocess.DEVNULL)  # pysafe: fixture spawn, judged by the kitlib member'
PY_GOOD='import kitlib_run
kitlib_run.run(["x"], deadline_s=5)'
TS_BAD='export const p = Bun.spawn(["x"]);'
TS_GOOD='import { run } from "./src/kitlib/run";
export const p = run(["x"], { deadline_s: 5 });'
SH_BAD='timeout 5 git fetch'

# 1. a fresh installed repo refuses a staged new raw spawn, naming kitlib;
#    the same call through kitlib passes
R=$(new_repo planted)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] planted py")
check "$?" "1" "py-planted-refused" "$out" "tool.py:2:1: raw-spawn: process spawned outside kitlib (subprocess.run); use kitlib_run.run"
check "$(git -C "$R" rev-list --count HEAD)" "1" "py-planted-head-unmoved" "$out" 'staged-kitlib: REFUSED: staged files hand-roll a kitlib primitive'
printf '%s' "$out" | grep -q "staged-pysafe"
check "$?" "1" "py-planted-not-pysafe" "x" "x"
printf '%s\n' "$PY_GOOD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] py through kitlib")
check "$?" "0" "py-kitlib-pass" "x" "x"
printf '%s\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] planted ts")
check "$?" "1" "ts-planted-refused" "$out" "tool.ts:1:.*raw-spawn: .*(Bun.spawn); use run(argv, { deadline_s }) from src/kitlib/run.ts"
mkdir -p "$R/src/kitlib"
cp "$SCRIPTS/../src/kitlib/run.ts" "$R/src/kitlib/run.ts"
printf '%s\n' "$TS_GOOD" > "$R/tool.ts"
git -C "$R" add tool.ts src/kitlib/run.ts
out=$(commit "$R" -m "[test] ts through kitlib")
check "$?" "0" "ts-kitlib-pass" "x" "x"
printf '#!/bin/sh\n%s\n' "$SH_BAD" > "$R/fetch.sh"
git -C "$R" add fetch.sh
out=$(commit "$R" -m "[test] planted sh")
check "$?" "1" "sh-planted-refused" "$out" "fetch.sh:2:1: raw-spawn: .*(timeout N); bound the command with python3 -B scripts/pysafe.py run"
git -C "$R" rm -q --cached fetch.sh

# 2. a reasonless pragma is refused; a reasoned one passes
printf '%s // kitlib:\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] reasonless pragma")
check "$?" "1" "reasonless-refused" "$out" "suppression-no-reason"
printf '%s // kitlib: fixture spawn, the point of this file\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] reasoned pragma")
check "$?" "0" "reasoned-pass" "x" "x"

# 3. a pre-existing site in HEAD: an unrelated edit passes, a new site is refused
R=$(new_repo ratchet old.py "$PY_BAD")
printf '%s\nprint("unrelated")\n' "$PY_BAD" > "$R/old.py"
git -C "$R" add old.py
out=$(commit "$R" -m "[test] unrelated edit")
check "$?" "0" "legacy-untouched-pass" "x" "x"
printf '%s\nprint("unrelated")\nsubprocess.check_output(["y"], timeout=5, stdin=subprocess.DEVNULL)  # pysafe: fixture spawn, judged by kitlib\n' "$PY_BAD" > "$R/old.py"
git -C "$R" add old.py
out=$(commit "$R" -m "[test] new site")
check "$?" "1" "legacy-new-refused" "$out" "old.py:4:1: raw-spawn: .*subprocess.check_output"

# 4. --only judges the temporary index; a missing ratchet or engine refuses
R=$(new_repo only)
printf '%s\n' "$TS_BAD" > "$R/bad.ts"
printf 'export const ok = 1;\n' > "$R/good.ts"
git -C "$R" add bad.ts good.ts
out=$(commit "$R" --only good.ts -m "[test] good only")
check "$?" "0" "only-good-pass" "x" "x"
out=$(commit "$R" --only bad.ts -m "[test] bad only")
check "$?" "1" "only-bad-refused" "$out" "bad.ts:1:.*raw-spawn"
hook="$R/.git/hooks/hooks.d/pre-commit"
for helper in kitlib_ratchet.py kitlib_ratchet_core.py; do
	mv "$hook/$helper" "$TMP/$helper.keep"
	out=$(commit "$R" --only bad.ts -m "[test] helper missing")
	check "$?" "1" "missing-$helper-refused" "$out" "staged-kitlib: REFUSED: $helper is missing"
	mv "$TMP/$helper.keep" "$hook/$helper"
done

# 5. pre-push: the gate's range ratchet passes a clean pushed range and refuses
#    a range that adds a raw spawn
P="$TMP/push"
mkdir -p "$P/scripts" "$P/var/agent-tmp"
git -C "$P" init -q 2>/dev/null
git -C "$P" config user.email "test@invalid.example"
git -C "$P" config user.name "Test"
for helper in pysafe.py kitlib_ratchet_core.py kitlib_ratchet.py; do cp "$SCRIPTS/$helper" "$P/scripts/$helper"; done
printf 'var/\n' > "$P/.gitignore"
git -C "$P" add .
git -C "$P" commit -q -m "[test] base"
base=$(git -C "$P" rev-parse HEAD)
printf 'export const ok = 1;\n' > "$P/clean.ts"
git -C "$P" add clean.ts
git -C "$P" commit -q -m "[test] clean"
clean=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$clean" "$base" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "0" "0" "push-clean-step-green" "$out" "GREEN kitlib-range"
printf '%s\n' "$PY_BAD" > "$P/spawn.py"
git -C "$P" add spawn.py
git -C "$P" commit -q -m "[test] spawn"
bad=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$bad" "$clean" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "$?" "1" "push-planted-refused" "$out" "RED kitlib-range producer_rc=1: the range hand-rolls a kitlib primitive"
check "0" "0" "push-planted-named" "$out" "spawn.py:2:1: raw-spawn"

printf 'check-staged-kitlib: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
