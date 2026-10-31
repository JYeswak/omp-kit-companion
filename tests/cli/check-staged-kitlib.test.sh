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
# Part 1 of 3: fixture isolation, sections 1-7 and the first real 9 replays.
# Parts 2 and 3: check-staged-kitlib-reversal.test.sh, check-staged-kitlib-replay.test.sh.
# shellcheck source=tests/cli/check-staged-kitlib.lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/check-staged-kitlib.lib.sh"

# A fixture's real commit hook must not resolve through the caller's tracker.
DB="$TMP/inherited-beads.db"
: > "$DB"
FIXTURE_HELPER=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh
out=$(BEADS_DB="$DB" FIXTURE_HELPER="$FIXTURE_HELPER" INSTALLER="$INSTALLER" R="$TMP/inherited-db-fixture" sh -c '
	set -eu
	. "$FIXTURE_HELPER"
	mkdir -p "$R"
	git -C "$R" init -q
	git -C "$R" config user.email "test@invalid.example"
	git -C "$R" config user.name "Test"
	git -C "$R" commit -q --allow-empty -m "[test] root"
	sh "$INSTALLER" "$R" >/dev/null
	printf "fixture\n" > "$R/probe.txt"
	git -C "$R" add probe.txt
	git -C "$R" commit -q -m "[test] isolated fixture commit"
	printf "fixture commit passed\n"
' 2>&1)
rc=$?
check "$rc" "0" "fixture-ignores-inherited-beads-db" "$out" "fixture commit passed"

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


replay_setup
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
# The prior .41 fixture change is this real X/P delta. Compare the complete
# P-side blob as history, without claiming .41 qualification.
prior41_path=tests/cli/pre-push-gate.test.sh
prior41_got=$(git -C "$R" rev-parse "HEAD:$prior41_path") || exit 1
prior41_want=$(git -C "$OBJSRC" rev-parse "$PREAL:$prior41_path") || exit 1
check "$prior41_got" "$prior41_want" "real-withdrawal-prior-41-hunk-preserved" "x" "x"

printf 'check-staged-kitlib: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
