#!/bin/sh
# check-staged-pysafe.test.sh — PYSAFE1 pre-commit gate contract (ompkit-xa5s.34).
# The member is installed by the installer into fixture repos and judged
# through real `git commit` runs: a staged .py that adds a hang-prone call is
# refused; an inline reasoned suppression passes; a reasonless one is refused;
# pre-existing findings in HEAD do not block an unrelated edit; the `--only`
# temporary index is judged; a hung checker is killed at the deadline and the
# commit refused.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
if ! printenv TMPDIR >/dev/null; then KITLIB_TMP_ROOT=$REPO_TMP; fi
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP staged-pysafe-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	git -C "$dir" commit -q --allow-empty --message "[test] root"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/49-omp-kit-staged-pysafe" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && git commit -q "$@" 2>&1)
}

BAD="import subprocess
subprocess.run(['true'], stdin=subprocess.DEVNULL)"

# 1. a new .py with a subprocess call lacking a timeout: refused, naming it
R=$(new_repo planted)
printf '%s\n' "$BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] planted violation")
check "$?" "1" "planted-refused" "$out" "tool.py:2:1: subprocess-no-timeout"
check "$(git -C "$R" rev-list --count HEAD)" "1" "planted-head-unmoved" "$out" "staged-pysafe: REFUSED"

# 2. a reasonless suppression is refused; a reasoned one passes
printf '%s  # pysafe:\n' "$BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] reasonless suppression")
check "$?" "1" "reasonless-refused" "$out" "suppression-no-reason"
printf '%s  # pysafe: fixture wrapper, the caller bounds it\n' "$BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] reasoned suppression")
check "$?" "0" "reasoned-pass" "x" "x"

# 3. pre-existing finding in HEAD: an unrelated edit passes, a new one is refused
R=$(new_repo ratchet)
printf '%s\n' "$BAD" > "$R/old.py"
git -C "$R" add old.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] legacy finding"
printf '%s\nVERSION = 2\n' "$BAD" > "$R/old.py"
git -C "$R" add old.py
out=$(commit "$R" -m "[test] unrelated edit")
check "$?" "0" "legacy-untouched-pass" "x" "x"
printf '%s\nVERSION = 2\ndef wait_all(t):\n    t.join()\n' "$BAD" > "$R/old.py"
git -C "$R" add old.py
out=$(commit "$R" -m "[test] new wait")
check "$?" "1" "legacy-new-refused" "$out" "old.py:5:5: wait-no-timeout"

# 4. --only judges the temporary index: bad.py staged in the full index does
#    not block a commit of good.py alone; committing bad.py alone is refused
R=$(new_repo only)
printf '%s\n' "$BAD" > "$R/bad.py"
printf 'VALUE = 1\n' > "$R/good.py"
git -C "$R" add bad.py good.py
out=$(commit "$R" --only good.py -m "[test] good only")
check "$?" "0" "only-good-pass" "x" "x"
out=$(commit "$R" --only bad.py -m "[test] bad only")
check "$?" "1" "only-bad-refused" "$out" "bad.py:2:1: subprocess-no-timeout"

# 5. no staged .py: the member passes without starting python (none on PATH)
printf 'notes\n' > "$R/notes.txt"
git -C "$R" reset -q -- bad.py
git -C "$R" add notes.txt
mkdir -p "$TMP/nopython"
for tool in git grep dirname; do ln -sf "$(command -v "$tool")" "$TMP/nopython/$tool"; done
out=$(cd "$R" && PATH="$TMP/nopython" /bin/sh .git/hooks/hooks.d/pre-commit/49-omp-kit-staged-pysafe 2>&1)
check "$?" "0" "no-python-files-skip" "x" "x"
git -C "$R" add bad.py
out=$(cd "$R" && PATH="$TMP/nopython" /bin/sh .git/hooks/hooks.d/pre-commit/49-omp-kit-staged-pysafe 2>&1)
check "$?" "1" "python-absent-refused" "$out" "python3 is absent"
git -C "$R" reset -q -- notes.txt bad.py

# 6. cancel-safety: a hung checker (holding a grandchild on the pipe) is killed
#    at the deadline and the commit refused within the budget plus grace
R=$(new_repo hung)
printf 'VALUE = 1\n' > "$R/ok.py"
git -C "$R" add ok.py
hook="$R/.git/hooks/hooks.d/pre-commit"
cp "$hook/pysafe_check.py" "$TMP/pysafe_check.py.keep"
printf 'import subprocess, sys, time\np = subprocess.Popen(["sleep", "60"], stdin=subprocess.DEVNULL)  # pysafe: planted hang\nopen(sys.argv[0] + ".pid", "w").write(str(p.pid))\ntime.sleep(60)\n' > "$hook/pysafe_check.py"
start=$(date +%s)
out=$(cd "$R" && PYSAFE_GATE_TIMEOUT=2 git commit -q -m "[test] hung checker" 2>&1)
rc=$?
elapsed=$(( $(date +%s) - start ))
check "$rc" "1" "hung-checker-refused" "$out" "exceeded 2 s and was killed"
bounded=1
[ "$elapsed" -le 10 ] && bounded=0
check "$bounded" "0" "hung-checker-bounded" "elapsed=$elapsed" "elapsed"
hung_pid=$(cat "$hook/pysafe_check.py.pid")
sleep 1
kill -0 "$hung_pid" 2>/dev/null
check "$?" "1" "hung-grandchild-killed" "pid=$hung_pid" "pid"
rm -f "$hook/pysafe_check.py.pid"
cp "$TMP/pysafe_check.py.keep" "$hook/pysafe_check.py"

# 7. a missing checker copy refuses instead of passing unjudged
rm -f "$hook/pysafe_check.py"
out=$(commit "$R" -m "[test] checker missing")
check "$?" "1" "missing-checker-refused" "$out" "pysafe_check.py is missing"
cp "$TMP/pysafe_check.py.keep" "$hook/pysafe_check.py"
out=$(commit "$R" -m "[test] checker restored")
check "$?" "0" "restored-checker-pass" "x" "x"

printf 'check-staged-pysafe: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
