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
PY_BAD_OLD='import subprocess
subprocess.run(["older"], timeout=5, stdin=subprocess.DEVNULL)  # pysafe: older fixture spawn, judged by kitlib member'
PY_GOOD='import kitlib_run
kitlib_run.run(["x"], deadline_s=5)'
TS_BAD='export const p = Bun.spawn(["x"]);'
TS_GOOD='import { run } from "./src/kitlib/run";
export const p = run(["x"], { deadline_s: 5 });'
SH_BAD='timeout 5 git fetch'
origin_repo() {
	dir=$(new_repo "$1" tool.py "$PY_BAD_OLD") || return 1
	printf '%s\n' "$PY_BAD" > "$dir/tool.py"
	git -C "$dir" add tool.py
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] published origin"
	origin=$(git -C "$dir" rev-parse HEAD) || return 1
	git -C "$dir" update-ref refs/remotes/origin/main "$origin" || return 1
	printf '%s\n' "$PY_GOOD" > "$dir/tool.py"
	git -C "$dir" add tool.py
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] ratchet reduction"
	printf '%s\n' "$dir"
}


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

# 6. a repo with the committed allowlist (scripts/kitlib-ratchet-baseline.json):
#    a planted new spawn is refused naming kitlib_run.run and the kitlib
#    control passes; a planted count increase or entry addition is refused;
#    a new pragma'd site is refused (the pragma documents an allowlisted
#    site, it admits no new one) while a pragma on an allowlisted site
#    passes; deleting the allowlist is refused with sites remaining and with
#    none; a planted entry removal with its site gone (the empty-counts
#    allowlist --write-baseline writes) passes; after it a new pragma'd site
#    is refused while the kitlib control passes
ALLOW=scripts/kitlib-ratchet-baseline.json
R=$(new_repo allow old.ts "$TS_BAD")
mkdir -p "$R/scripts"
python3 -B "$SCRIPTS/kitlib_ratchet.py" --write-baseline --repo "$R" < /dev/null
check "$?" "0" "allow-written" "x" "x"
check "0" "0" "allow-counts" "$(cat "$R/$ALLOW")" '"old.ts": 1'
git -C "$R" add "$ALLOW"
out=$(commit "$R" -m "[test] allowlist")
check "$?" "0" "allow-seed-pass" "x" "x"
printf 'import subprocess\nsubprocess.run(["x"])\n' > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] planted new file")
check "$?" "1" "allow-planted-refused" "$out" "new.py:2:1: raw-spawn: .*(subprocess.run); use kitlib_run.run"
printf '%s\n' "$PY_GOOD" > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] kitlib control")
check "$?" "0" "allow-kitlib-control-pass" "x" "x"
printf '{"schema": 1, "totals": {"raw-spawn": 2}, "counts": {"raw-spawn": {"old.ts": 2}}}\n' > "$R/$ALLOW"
git -C "$R" add "$ALLOW"
out=$(commit "$R" -m "[test] raise allowlist")
check "$?" "1" "allow-increase-refused" "$out" "allowlist-raised: .*: raw-spawn old.ts: 1 -> 2"
printf '{"schema": 1, "totals": {"raw-spawn": 2}, "counts": {"raw-spawn": {"old.ts": 1, "x.py": 1}}}\n' > "$R/$ALLOW"
git -C "$R" add "$ALLOW"
out=$(commit "$R" -m "[test] add allowlist entry")
check "$?" "1" "allow-addition-refused" "$out" "allowlist-raised: .*: raw-spawn x.py: 0 -> 1"
git -C "$R" checkout -q HEAD -- "$ALLOW"
printf '%s // kitlib: legacy probe, migrating to run()\n' "$TS_BAD" > "$R/old.ts"
git -C "$R" add old.ts
out=$(commit "$R" -m "[test] pragma on an allowlisted site")
check "$?" "0" "allow-pragma-documents-pass" "x" "x"
printf '%s // kitlib: fixture spawn, the point of this file\n' "$TS_BAD" > "$R/tool.ts"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] new pragma'd site")
check "$?" "1" "allow-new-pragma-refused" "$out" "tool.ts:1:.*raw-spawn: .*pragma documents an allowlisted site and admits no new one"
git -C "$R" rm -q --cached tool.ts
git -C "$R" rm -q --cached "$ALLOW"
out=$(commit "$R" -m "[test] delete the allowlist, site kept")
check "$?" "1" "allow-deleted-site-kept-refused" "$out" "old.ts:1:.*raw-spawn: .*(1 sites, 0 allowlisted"
printf 'export const ok = 1;\n' > "$R/old.ts"
git -C "$R" add old.ts
python3 -B "$SCRIPTS/kitlib_ratchet.py" --write-baseline --repo "$R" < /dev/null
check "$?" "0" "allow-empty-written" "x" "x"
check "0" "0" "allow-empty-counts" "$(cat "$R/$ALLOW")" '"raw-spawn": {}'
git -C "$R" add "$ALLOW"
out=$(commit "$R" -m "[test] remove allowlist entry, empty counts")
check "$?" "0" "allow-removal-empty-pass" "x" "x"
git -C "$R" rm -q --cached "$ALLOW"
out=$(commit "$R" -m "[test] delete the empty allowlist")
check "$?" "1" "allow-deleted-zero-sites-refused" "$out" "allowlist-deleted"
git -C "$R" add "$ALLOW"
git -C "$R" add tool.ts
out=$(commit "$R" -m "[test] new pragma'd site after an empty allowlist")
check "$?" "1" "allow-empty-new-pragma-refused" "$out" "tool.ts:1:.*raw-spawn: .*(1 sites, 0 allowlisted.*admits no new one"
git -C "$R" rm -q --cached tool.ts
printf '%s\n' "$PY_GOOD" > "$R/good.py"
git -C "$R" add good.py
out=$(commit "$R" -m "[test] kitlib control after an empty allowlist")
check "$?" "0" "allow-empty-kitlib-control-pass" "x" "x"

# 7. pre-push with the allowlist: a range raising it is refused, a range
#    removing an entry (its site gone) passes, a range deleting it is refused
python3 -B "$SCRIPTS/kitlib_ratchet.py" --write-baseline --repo "$P" < /dev/null
git -C "$P" add "$ALLOW"
git -C "$P" commit -q -m "[test] allowlist"
seed=$(git -C "$P" rev-parse HEAD)
printf '{"schema": 1, "totals": {"raw-spawn": 3}, "counts": {"raw-spawn": {"spawn.py": 3}}}\n' > "$P/$ALLOW"
git -C "$P" commit -qam "[test] raise"
raised=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$raised" "$seed" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "$?" "1" "push-allow-increase-refused" "$out" "allowlist-raised: .*: raw-spawn spawn.py: 1 -> 3"
git -C "$P" checkout -q "$seed" 2>/dev/null
git -C "$P" rm -q spawn.py
printf '{"schema": 1, "totals": {"raw-spawn": 0}, "counts": {"raw-spawn": {}}}\n' > "$P/$ALLOW"
git -C "$P" commit -qam "[test] remove"
removed=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$removed" "$seed" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "0" "0" "push-allow-removal-green" "$out" "GREEN kitlib-range"
git -C "$P" rm -q "$ALLOW"
git -C "$P" commit -q -m "[test] delete allowlist"
deleted=$(git -C "$P" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$deleted" "$removed" | (cd "$P" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
check "$?" "1" "push-allow-deleted-refused" "$out" "allowlist-deleted"

# 8. a withdrawal to origin/main is admitted only for exact staged equality
R=$(origin_repo origin-equal)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] withdraw to origin")
check "$?" "0" "origin-equal-withdrawal-pass" "$out" "ADMITTED staged path byte-identical to origin/main@"
check "0" "0" "origin-equal-withdrawal-names-path" "$out" "tool.py"
check "$(printf '%s\n' "$out" | grep -c 'ADMITTED staged path byte-identical')" "1" "origin-equal-one-admission" "$out" "ADMITTED staged path byte-identical"

R=$(origin_repo origin-extra)
printf '%s\nsubprocess.check_output(["extra"], timeout=5, stdin=subprocess.DEVNULL)  # pysafe: additional fixture spawn, judged by kitlib\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] withdrawal plus new spawn")
check "$?" "1" "origin-extra-spawn-refused" "$out" "tool.py:3:1: raw-spawn"
if printf '%s\n' "$out" | grep -q "ADMITTED staged path byte-identical to origin/main@"; then
	fail=$((fail + 1)); printf 'FAIL origin-extra-spawn-not-admitted\n'
else
	pass=$((pass + 1))
fi

R=$(origin_repo origin-older)
older=$(git -C "$R" rev-parse HEAD~2)
git -C "$R" show "$older:tool.py" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] restore older tree")
check "$?" "1" "origin-older-tree-refused" "$out" "tool.py:2:1: raw-spawn"

R=$(origin_repo origin-new)
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] ordinary new spawn with origin")
check "$?" "1" "origin-new-spawn-refused" "$out" "new.py:2:1: raw-spawn"

printf 'check-staged-kitlib: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
