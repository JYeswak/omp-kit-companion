#!/bin/sh
# check-staged-tempsafe.test.sh — TEMPGATE1 gate contract (ompkit-dhmzg).
# The pre-commit member is installed by install-commit-msg-bead.sh into fresh
# fixture repos and judged through real `git commit` runs: a staged new
# mkdtempSync / tempfile.mkdtemp / mktemp is refused naming kitlib; an
# untouched pre-existing site does not block; a reasoned "tempsafe:" pragma
# passes and a reasonless one is refused; the `--only` temporary index is
# judged; a missing checker copy refuses. The pre-push gate refuses a planted
# range that adds a raw site and passes the same step for a clean range.
# Every fixture lives in one kitlib-owned temp dir, removed by kitlib's traps.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
INSTALLER=$SCRIPTS/install-commit-msg-bead.sh
MEMBER=50-omp-kit-staged-tempsafe
# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPTS/kitlib-tmp.sh"
kitlib_tmp TMP staged-tempsafe-test || exit 1

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

TS_BAD='export const d = fs.mkdtempSync(os.tmpdir() + "/x");'
PY_BAD='import tempfile
d = tempfile.mkdtemp()'
# shellcheck disable=SC2016 # planted fixture text, never expanded here
SH_BAD='d=$(mktemp -d)'

# 1. a fresh installed repo refuses a staged new mkdtempSync, naming kitlib
R=$(new_repo planted)
printf '%s\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] planted ts")
check "$?" "1" "ts-planted-refused" "$out" "tool.ts:1:.*raw-temp: temp created outside kitlib (mkdtemp, tmpdir()); use ownedTmp(label) from src/kitlib/tmp.ts"
check "$(git -C "$R" rev-list --count HEAD)" "1" "ts-planted-head-unmoved" "$out" 'justify the line inline with "tempsafe: <reason>"'
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" rm -q --cached tool.ts
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] planted py")
check "$?" "1" "py-planted-refused" "$out" "tool.py:2:5: raw-temp: .*owned_tmp"

# 2. a reasonless pragma is refused; a reasoned one passes
git -C "$R" rm -q --cached tool.py
printf '%s // tempsafe:\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] reasonless pragma")
check "$?" "1" "reasonless-refused" "$out" "suppression-no-reason"
printf '%s // tempsafe: fixture dir, removed by the caller\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] reasoned pragma")
check "$?" "0" "reasoned-pass" "x" "x"

# 3. a pre-existing site in HEAD: an unrelated edit passes, a new site is refused
R=$(new_repo ratchet old.sh "#!/bin/sh
$SH_BAD")
printf '#!/bin/sh\n%s\necho unrelated\n' "$SH_BAD" > "$R/old.sh"
git -C "$R" add old.sh
out=$(commit "$R" -m "[test] unrelated edit")
check "$?" "0" "legacy-untouched-pass" "x" "x"
# shellcheck disable=SC2016 # planted fixture text, never expanded here
printf '#!/bin/sh\n%s\necho unrelated\nf=$(mktemp)\n' "$SH_BAD" > "$R/old.sh"
git -C "$R" add old.sh
out=$(commit "$R" -m "[test] new site")
check "$?" "1" "legacy-new-refused" "$out" "old.sh:4:5: raw-temp: .*kitlib_tmp VAR LABEL"

# 4. --only judges the temporary index; a missing checker refuses
R=$(new_repo only)
printf '%s\n' "$SH_BAD" > "$R/bad.sh"
printf 'echo ok\n' > "$R/good.sh"
git -C "$R" add bad.sh good.sh
out=$(commit "$R" --only good.sh -m "[test] good only")
check "$?" "0" "only-good-pass" "x" "x"
out=$(commit "$R" --only bad.sh -m "[test] bad only")
check "$?" "1" "only-bad-refused" "$out" "bad.sh:1:5: raw-temp"
hook="$R/.git/hooks/hooks.d/pre-commit"
mv "$hook/tempsafe_check.py" "$TMP/tempsafe_check.py.keep"
out=$(commit "$R" --only bad.sh -m "[test] checker missing")
check "$?" "1" "missing-checker-refused" "$out" "tempsafe_check.py is missing"
mv "$TMP/tempsafe_check.py.keep" "$hook/tempsafe_check.py"
printf 'notes\n' > "$R/notes.txt"
git -C "$R" reset -q -- bad.sh
git -C "$R" add notes.txt
mkdir -p "$TMP/nopython"
for tool in git grep dirname; do ln -sf "$(command -v "$tool")" "$TMP/nopython/$tool"; done
out=$(cd "$R" && PATH="$TMP/nopython" /bin/sh "$hook/$MEMBER" 2>&1)
check "$?" "0" "no-judged-files-skip" "x" "x"
git -C "$R" reset -q -- notes.txt

# 5. pre-push: the gate's range ratchet passes a clean pushed range and refuses
#    a range that adds a raw site
P="$TMP/push"
mkdir -p "$P/scripts" "$P/var/agent-tmp"
git -C "$P" init -q 2>/dev/null
git -C "$P" config user.email "test@invalid.example"
git -C "$P" config user.name "Test"
for helper in pysafe.py kitlib_ratchet_core.py tempsafe_check.py; do cp "$SCRIPTS/$helper" "$P/scripts/$helper"; done
printf 'var/\n' > "$P/.gitignore"
git -C "$P" add .
git -C "$P" commit -q -m "[test] base"
base=$(git -C "$P" rev-parse HEAD)
printf 'export const ok = 1;\n' > "$P/clean.ts"
git -C "$P" add clean.ts
git -C "$P" commit -q -m "[test] clean"
clean=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$clean" "$base" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "0" "0" "push-clean-step-green" "$out" "GREEN tempsafe-range"
printf '%s\n' "$TS_BAD" > "$P/leak.ts"
git -C "$P" add leak.ts
git -C "$P" commit -q -m "[test] leak"
bad=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$bad" "$clean" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "$?" "1" "push-planted-refused" "$out" "RED tempsafe-range producer_rc=1: the range creates temp dirs outside kitlib"
check "0" "0" "push-planted-named" "$out" "leak.ts:1:.*raw-temp"

printf 'check-staged-tempsafe: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
