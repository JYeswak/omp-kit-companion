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
	if [ $# -ge 3 ]; then
		mkdir -p "$dir/$(dirname "$2")"
		printf '%s\n' "$3" > "$dir/$2" && git -C "$dir" add "$2"
	fi
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
	git -C "$dir" init --bare -q "$dir/published.git" || return 1
	git -C "$dir" remote add origin "$dir/published.git" || return 1
	git -C "$dir" -c core.hooksPath=/dev/null push -q origin "$origin:refs/heads/main" || return 1
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

# An ordinary root/partial Revert has no published-origin admission. Its trailer
# must not force the full-X parent proof or bypass the unchanged ratchet.
R=$(new_repo ordinary-root-partial-revert pkg/f.txt "$(printf 'base line\nlanded line L')")
X=$(git -C "$R" rev-parse HEAD)
printf 'base line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
msg="$TMP/ordinary-root-partial-revert.msg"
printf '[test] ordinary root partial revert\n\nBead: ompkit-fp72.135.3.67\nRevert: %s\n' "$X" > "$msg"
member="$R/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
out=$(CDPATH='' cd -- "$R" && "$member" "$msg" 2>&1)
check "$?" "0" "ordinary-root-partial-revert-pass" "x" "x"

# The same path must still refuse an active ordinary ratchet finding.
R=$(new_repo ordinary-active-revert)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
msg="$TMP/ordinary-active-revert.msg"
printf '[test] active ordinary finding with Revert\n\nBead: ompkit-fp72.135.3.67\nRevert: %s\n' "$X" > "$msg"
member="$R/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
out=$(CDPATH='' cd -- "$R" && "$member" "$msg" 2>&1)
check "$?" "1" "ordinary-active-revert-still-refused" "$out" "native kitlib ratchet has staged findings"

# 8. Only an exact, named reversal of X may admit the incumbent raw-spawn
#    entry; commit-msg supplies native per-path proof and rejects fake intent.
R=$(origin_repo origin-equal)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] exact named reversal" -m "Revert: $X")
check "$?" "0" "origin-equal-named-reversal-pass" "$out" '"verdict":"PASS"'
check "0" "0" "origin-equal-per-path-verdict" "$out" '"path":"tool.py"'

R=$(origin_repo origin-missing-revert)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] missing reversal authority")
check "$?" "1" "origin-equal-without-revert-refused" "$out" 'missing Revert trailer'

R=$(origin_repo origin-wrong-x)
printf '%s\n' 'unrelated history' > "$R/unrelated.txt"
git -C "$R" add unrelated.txt
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] unrelated X"
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] false named reversal" -m "Revert: $X")
check "$?" "1" "origin-equal-wrong-x-refused" "$out" 'staged paths do not equal'

R=$(origin_repo origin-unrelated-staged)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf '%s\n' 'unrelated staged code' > "$R/extra.txt"
git -C "$R" add tool.py extra.txt
out=$(commit "$R" -m "[test] reversal with unrelated path" -m "Revert: $X")
check "$?" "1" "origin-equal-unrelated-staged-refused" "$out" 'staged paths do not equal'

# A Revert trailer whose staged entry differs from X's parent but uses no published-origin admission
# is an ordinary commit (RusticPine AM 70292, QuietBadger AM 70284): member 49 judges the declaration,
# and the full-X proof stays reserved for admissions (origin-equal-wrong-x, -unrelated-staged, -older,
# -near-match and -mixed below keep refusing those).
R=$(origin_repo ordinary-parent-mismatch)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n# post-parent edit' "$PY_GOOD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] parent mismatch without admission" -m "Revert: $X")
check "$?" "0" "ordinary-parent-mismatch-without-admission-passes" "x" "x"
# An admitted forward-withdrawal stages exactly X's paths: one path keeps X
# parent's bytes (so the origin admission binds) while a second path's bytes
# differ from X's parent. The parent-proof must refuse, naming the entry.
# The origin is published by local clone only; no push or fetch leaves the fixture.
R=$(new_repo origin-admitted-parent-proof tool.py "$PY_BAD_OLD")
printf 'VALUE = 1\n' > "$R/data.py"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add data.py tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] published origin"
origin=$(git -C "$R" rev-parse HEAD)
git clone --bare -q "$R" "$R/published.git"
git --git-dir="$R/published.git" update-ref refs/heads/main "$origin"
git -C "$R" remote add origin "$R/published.git"
git -C "$R" update-ref refs/remotes/origin/main "$origin"
printf '%s\n' "$PY_GOOD" > "$R/tool.py"
printf 'VALUE = 2\n' > "$R/data.py"
git -C "$R" add data.py tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] ratchet reduction"
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf 'VALUE = 3\n' > "$R/data.py"
git -C "$R" add data.py tool.py
out=$(commit "$R" -m "[test] admitted parent mismatch" -m "Revert: $X")
check "$?" "1" "origin-admitted-parent-mismatch-refused" "$out" 'does not match X parent'
# The same commit with that path's bytes equal to X's parent passes.
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf 'VALUE = 1\n' > "$R/data.py"
git -C "$R" add data.py tool.py
out=$(commit "$R" -m "[test] admitted parent exact" -m "Revert: $X")
check "$?" "0" "origin-admitted-parent-exact-pass" "$out" '"verdict":"PASS"'

R=$(origin_repo origin-stale)
X=$(git -C "$R" rev-parse HEAD)
git -C "$R" -c core.hooksPath=/dev/null push -q origin "$X:refs/heads/candidate"
git --git-dir="$R/published.git" update-ref refs/heads/main "$X"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] stale origin" -m "Revert: $X")
check "$?" "1" "origin-stale-binding-refused" "$out" 'origin/main tracking ref is stale'

R=$(origin_repo origin-unpublished-head)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] unpublished head"
UNPUBLISHED=$(git -C "$R" rev-parse HEAD)
git -C "$R" update-ref refs/remotes/origin/main "$UNPUBLISHED"
printf '%s\n' "$PY_GOOD" > "$R/tool.py"
git -C "$R" add tool.py
git -C "$R" -c core.hooksPath=/dev/null commit -q -m "[test] return to kitlib"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] falsely published head" -m "Revert: $X")
check "$?" "1" "origin-unpublished-head-refused" "$out" 'origin/main tracking ref is stale'

R=$(origin_repo origin-byte-near-match)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n# one byte differs' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] near match" -m "Revert: $X")
check "$?" "1" "origin-near-match-bytes-refused" "$out" "tool.py:.*raw-spawn"

R=$(origin_repo origin-mode-near-match)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
chmod +x "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] mode near match" -m "Revert: $X")
check "$?" "1" "origin-near-match-mode-refused" "$out" "tool.py:.*raw-spawn"

R=$(origin_repo origin-extra)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\nsubprocess.check_output(["extra"], timeout=5, stdin=subprocess.DEVNULL)  # pysafe: additional fixture spawn, judged by kitlib\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] withdrawal plus new spawn" -m "Revert: $X")
check "$?" "1" "origin-extra-spawn-refused" "$out" "tool.py:3:1: raw-spawn"

R=$(origin_repo origin-mixed)
X=$(git -C "$R" rev-parse HEAD)
printf '%s\n' "$PY_BAD" > "$R/tool.py"
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add tool.py new.py
out=$(commit "$R" -m "[test] exact origin plus new spawn" -m "Revert: $X")
check "$?" "1" "origin-mixed-new-spawn-refused" "$out" "new.py:2:1: raw-spawn"

R=$(origin_repo origin-older)
X=$(git -C "$R" rev-parse HEAD)
older=$(git -C "$R" rev-parse HEAD~2)
git -C "$R" show "$older:tool.py" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] restore older tree" -m "Revert: $X")
check "$?" "1" "origin-older-tree-refused" "$out" "tool.py:2:1: raw-spawn"

R=$(origin_repo origin-new)
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] ordinary new spawn")
check "$?" "1" "origin-new-spawn-refused" "$out" "new.py:2:1: raw-spawn"

R=$(origin_repo origin-missing-msg-member)
X=$(git -C "$R" rev-parse HEAD)
member="$R/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
mv "$member" "$TMP/reversal-member.keep"
printf '%s\n' "$PY_BAD" > "$R/tool.py"
git -C "$R" add tool.py
out=$(commit "$R" -m "[test] missing commit-msg verifier" -m "Revert: $X")
check "$?" "1" "origin-reversal-member-required" "$out" "commit-msg reversal validator is missing"
mv "$TMP/reversal-member.keep" "$member"
R=$(new_repo origin-no-reversal-member)
member="$R/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
mv "$member" "$TMP/reversal-member.ordinary.keep"
printf 'export const ordinary = 1;\n' > "$R/ordinary.ts"
git -C "$R" add ordinary.ts
out=$(commit "$R" -m "[test] ordinary change without origin admission")
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL ordinary-change-without-reversal-member: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi
mv "$TMP/reversal-member.ordinary.keep" "$member"

# 9. Real 3cbef260b5 withdrawal replay: owned fixture, read-only exact-source export.
#    The reversal stages all 78 X paths at P bytes; the native checker admits each
#    incumbent entry against freshly bound published origin and the commit-msg
#    member emits a per-path verdict. send.ts keeps its 75849fa67d bytes and the
#    full 78-path equality preserves every hunk as history (no .41 qualification
#    is claimed). The source repo is read with show/ls-tree/rev-parse only; every
#    fixture repo is generated under $TMP. Revert names the fixture X, whose tree
#    carries the real X bytes path for path.
XREAL=3cbef260b55aa4d5d0dda0f7beae20723bb7cd85
PREAL=75849fa67db466f11a222b7979133f69e482b5d5
OLDCONVERGE=1c57cd8efdbb53dd514e82036bf527758e32eb78
# History-free inputs: no Git object is read from the enclosing checkout.
# A committed hash-bound capsule hydrates an owned isolated fixture repo;
# every read below goes through $OBJSRC only. Fixture identity is validated
# against the committed manifest before any native replay.
CAPSULE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../fixtures/ratchet-real-withdrawal" && pwd -P)"
CAPSULE_PACK="$CAPSULE_DIR/history-inputs.pack"
CAPSULE_MANIFEST="$CAPSULE_DIR/MANIFEST.txt"
if command -v sha256sum >/dev/null 2>&1; then _capsum() { sha256sum "$1" | cut -d' ' -f1; }; else _capsum() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi
manifest_field() { grep "^$1: " "$CAPSULE_MANIFEST" | head -n 1 | cut -d' ' -f2; }
# hydrate_capsule PACK MANIFEST DEST prints DEST on success; anything else
# fails closed with a HYDRATE-REFUSED marker before any fixture repo exists.
hydrate_capsule() {
	_hp="$1"; _hm="$2"; _hd="$3"
	if [ ! -f "$_hp" ] || [ ! -f "$_hm" ]; then echo "HYDRATE-REFUSED missing capsule or manifest" >&2; return 1; fi
	[ "$(_capsum "$_hp")" = "$(manifest_field capsule_sha256)" ] || { echo "HYDRATE-REFUSED capsule sha256 mismatch" >&2; return 1; }
	mkdir -p "$_hd" || return 1
	git -C "$_hd" init -q 2>/dev/null || return 1
	git -C "$_hd" unpack-objects < "$_hp" || { echo "HYDRATE-REFUSED unpack failed" >&2; return 1; }
	sed -n '/^## OBJECTS/,/^## PATHS/p' "$_hm" | grep -v '^#' | grep -v '^$' | cut -d' ' -f1 > "$TMP/.hydrate-objs"
	while read -r _oh; do
		git -C "$_hd" cat-file -e "$_oh" 2>/dev/null || { echo "HYDRATE-REFUSED missing object $_oh" >&2; return 1; }
	done < "$TMP/.hydrate-objs"
	printf '%s\n' "$_hd"
}
OBJSRC=$(hydrate_capsule "$CAPSULE_PACK" "$CAPSULE_MANIFEST" "$TMP/ratchet-obj-src") || exit 1
printf 'capsule sha256 %s\n' "$(manifest_field capsule_sha256)"
printf 'input X=%s P=%s OLD=%s\n' "$XREAL" "$PREAL" "$OLDCONVERGE"
[ "$(git -C "$OBJSRC" rev-list --parents -n 1 "$XREAL" | cut -d' ' -f2)" = "$PREAL" ] || { echo "HYDRATE-REFUSED X parent is not P" >&2; exit 1; }
: > "$TMP/.hydrate-bad"
sed -n '/^## PATHS/,$p' "$CAPSULE_MANIFEST" | grep -v '^#' | grep -v '^$' | while read -r _pp _mx _mp; do
	_gx=$(git -C "$OBJSRC" ls-tree "$XREAL" -- "$_pp" 2>/dev/null | cut -d' ' -f1); [ -n "$_gx" ] || _gx=ABSENT
	_gp=$(git -C "$OBJSRC" ls-tree "$PREAL" -- "$_pp" 2>/dev/null | cut -d' ' -f1); [ -n "$_gp" ] || _gp=ABSENT
	[ "$_gx" = "$_mx" ] && [ "$_gp" = "$_mp" ] || echo "MISMATCH-path:$_pp" >> "$TMP/.hydrate-bad"
done
[ ! -s "$TMP/.hydrate-bad" ] || { echo "HYDRATE-REFUSED path identity mismatch"; cat "$TMP/.hydrate-bad"; exit 1; } >&2
XPATHS=$(git -C "$OBJSRC" diff-tree --no-commit-id --name-only -r "$XREAL") || exit 1
XCOUNT=$(printf '%s\n' "$XPATHS" | wc -l)
# 9a. Planted negative: a missing or corrupted capsule fails closed before replay.
out=$(hydrate_capsule "$TMP/does-not-exist.pack" "$CAPSULE_MANIFEST" "$TMP/nope-missing" 2>&1); rc=$?
check "$rc" "1" "hydrate-missing-refused" "$out" "HYDRATE-REFUSED"
head -c 1000 "$CAPSULE_PACK" > "$TMP/truncated.pack"
out=$(hydrate_capsule "$TMP/truncated.pack" "$CAPSULE_MANIFEST" "$TMP/nope-truncated" 2>&1); rc=$?
check "$rc" "1" "hydrate-truncated-refused" "$out" "HYDRATE-REFUSED"
# sync_tree DIR REV: check out exactly the 78 X paths at REV bytes and mode;
# paths absent at REV (the two X-added files) are removed for the reversal.
sync_tree() {
	for p in $XPATHS; do
		mkdir -p "$1/$(dirname "$p")"
		if git -C "$OBJSRC" show "$2:$p" > "$1/$p" 2>/dev/null; then
			if git -C "$OBJSRC" ls-tree --full-tree "$2" -- "$p" | grep -q "100755"; then
				chmod +x "$1/$p"
			else
				chmod -x "$1/$p"
			fi
		else
			rm -f "$1/$p"
		fi
	done
}
# real_repo NAME: root, P-tree published as a local origin, X-tree on top.
real_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	git -C "$dir" commit -q --allow-empty --message "[test] root"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; return 1; }
	# The replay judges the kitlib ratchet alone: the 78 real files trip sibling
	# members (staged-imports, staged-regexploit) that the synthetic fixtures never
	# touch, so only the staged-kitlib and reversal members stay installed. Helper
	# files (pysafe, the ratchet engine) stay: the members refuse without them.
	for member in "$dir/.git/hooks/hooks.d/pre-commit/"* "$dir/.git/hooks/hooks.d/commit-msg/"*; do
		case "$(basename "$member")" in
		51-omp-kit-staged-kitlib|50-omp-kit-staged-kitlib-reversal|*.*) ;;
		*) rm -f "$member" ;;
		esac
	done
	sync_tree "$dir" "$PREAL" || return 1
	for p in $XPATHS; do [ -e "$dir/$p" ] && git -C "$dir" add -- "$p"; done
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] published origin"
	origin=$(git -C "$dir" rev-parse HEAD) || return 1
	git -C "$dir" init --bare -q "$dir/published.git" || return 1
	git -C "$dir" remote add origin "$dir/published.git" || return 1
	git -C "$dir" -c core.hooksPath=/dev/null push -q origin "$origin:refs/heads/main" || return 1
	git -C "$dir" update-ref refs/remotes/origin/main "$origin" || return 1
	sync_tree "$dir" "$XREAL" || return 1
	for p in $XPATHS; do git -C "$dir" add -- "$p"; done
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] ratchet introduction"
	X=$(git -C "$dir" rev-parse HEAD) || return 1
	printf '%s' "$dir"
}
# The exact 78-path reversal of the real X passes with a per-path verdict each.
R=$(real_repo real-pass)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real withdrawal" -m "Revert: $X")
check "$?" "0" "real-withdrawal-pass" "$out" '"verdict":"PASS"'
check "$(printf '%s' "$out" | grep -o '"x_parent_entry":"PASS"' | wc -l)" "$XCOUNT" "real-withdrawal-parent-entries" "x" "x"
printf '%s' "$out" | grep -q '"path":"tests/cli/converge.test.ts","raw_spawn_admitted":true'
check "$?" "0" "real-withdrawal-converge-admitted" "x" "x"
printf '%s' "$out" | grep -q '"path":"tests/cli/scratch-release-now.test.ts","raw_spawn_admitted":true'
check "$?" "0" "real-withdrawal-release-now-admitted" "x" "x"
printf '%s' "$out" | grep -q '"path":"tests/cli/scratch.test.ts","raw_spawn_admitted":true'
check "$?" "0" "real-withdrawal-scratch-admitted" "x" "x"
send_got=$(git -C "$R" rev-parse "HEAD:src/send.ts")
send_want=$(git -C "$OBJSRC" rev-parse "$PREAL:src/send.ts")
check "$send_got" "$send_want" "real-withdrawal-send-kept" "x" "x"
alleq=0
for p in $XPATHS; do
	if git -C "$R" rev-parse --verify --quiet "HEAD:$p" >/dev/null 2>&1; then in_head=1; else in_head=0; fi
	if git -C "$OBJSRC" rev-parse --verify --quiet "$PREAL:$p" >/dev/null 2>&1; then in_p=1; else in_p=0; fi
	if [ "$in_head" != "$in_p" ]; then echo "MISMATCH-PRESENCE:$p head=$in_head p=$in_p"; alleq=1
	elif [ "$in_head" = 1 ]; then
		got=$(git -C "$R" rev-parse "HEAD:$p")
		want=$(git -C "$OBJSRC" rev-parse "$PREAL:$p")
		gotmode=$(git -C "$R" ls-files -s -- "$p" | cut -d' ' -f1)
		wantmode=$(git -C "$OBJSRC" ls-tree --full-tree "$PREAL" -- "$p" | cut -d' ' -f1)
		if [ "$got" != "$want" ] || [ "$gotmode" != "$wantmode" ]; then echo "MISMATCH:$p"; alleq=1; fi
	fi
done
check "$alleq" "0" "real-withdrawal-all-bytes" "x" "x"
# A mixed new spawn beside the exact reversal refuses naming the new file.
R=$(real_repo real-mixed)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
printf '%s\n' "$PY_BAD" > "$R/new.py"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
git -C "$R" add new.py
out=$(commit "$R" -m "[test] real withdrawal plus new spawn" -m "Revert: $X")
check "$?" "1" "real-mixed-new-refused" "$out" "new.py:2:1: raw-spawn"
# A one-byte difference in one path refuses naming that path.
R=$(real_repo real-near-match)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
printf '%s\n# one byte differs\n' "$(git -C "$OBJSRC" show "$PREAL:tests/cli/converge.test.ts")" > "$R/tests/cli/converge.test.ts"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real near match" -m "Revert: $X")
check "$?" "1" "real-near-match-refused" "$out" "converge.test.ts:.*raw-spawn"
# A mode-only difference refuses naming that path.
R=$(real_repo real-mode)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
chmod +x "$R/tests/cli/scratch.test.ts"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real mode near match" -m "Revert: $X")
check "$?" "1" "real-near-match-mode-refused" "$out" "scratch.test.ts:.*raw-spawn"
# An older-tree entry refuses naming that path.
R=$(real_repo real-older)
X=$(git -C "$R" rev-parse HEAD) || exit 1
sync_tree "$R" "$PREAL"
git -C "$OBJSRC" show "$OLDCONVERGE:tests/cli/converge.test.ts" > "$R/tests/cli/converge.test.ts"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real older tree" -m "Revert: $X")
check "$?" "1" "real-older-tree-refused" "$out" "converge.test.ts:.*raw-spawn"
# A stale published binding refuses before any per-path proof.
R=$(real_repo real-stale)
XSTALE=$(git -C "$R" rev-parse HEAD)
X=$(git -C "$R" rev-parse HEAD) || exit 1
git -C "$R" -c core.hooksPath=/dev/null push -q origin "$XSTALE:refs/heads/candidate"
git --git-dir="$R/published.git" update-ref refs/heads/main "$XSTALE"
sync_tree "$R" "$PREAL"
for p in $XPATHS; do git -C "$R" add -- "$p"; done
out=$(commit "$R" -m "[test] real stale origin" -m "Revert: $X")
check "$?" "1" "real-stale-binding-refused" "$out" "origin/main tracking ref is stale"
# An ordinary new spawn with no reversal refuses as today.
R=$(real_repo real-control)
printf '%s\n' "$PY_BAD" > "$R/new.py"
git -C "$R" add new.py
out=$(commit "$R" -m "[test] ordinary new spawn")
check "$?" "1" "real-ordinary-new-refused" "$out" "new.py:2:1: raw-spawn"

printf 'check-staged-kitlib: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
