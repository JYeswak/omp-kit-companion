#!/bin/sh
# storage-root-gate.test.sh — STORAGEROOTNFS1 (ompkit-1ra0d.250).
#
# The Agent Mail storage-root hook must never resolve a foreign project key:
# in 2026-11-13 a transient stall of the ovnfs checkout mount blocked the hook
# in os.path.realpath over all 407 archived project keys and every commit and
# push fleet-wide hung past the 10 s runner budget. The repaired hook
# (scripts/pre-commit-storage-root-gate.sh) corroborates each archived
# human_key against this repository's own spellings with pure string
# comparison, verifies an installer-recorded archive binding without touching
# any manifest-derived path, and refuses ambiguity instead of guessing.
#
# Fault model (read before "fixing" the negative): on a dead NFS mount the
# lstat(2) inside realpath(2) blocks, and no hermetic fixture can block
# lstat(2) without a hung filesystem — the control below proves even the
# verbatim pre-fix loop does not hang on a FIFO. The planted negative is
# therefore the pre-fix algorithm with its foreign touch spelled as open(2),
# the locally-blockable member of the same equivalence class ("touch a
# foreign key in the hot path"). The shipped fix is proven safe by
# conjunction: (a) it resolves the 407-archive FIFO fixture fast, (b) the
# negative is caught by that fixture (fixture sensitivity), and (c) the
# structural case asserts the shipped script contains no resolution call on
# a manifest-derived path at all, so neither the open nor the realpath
# spelling of the foreign touch can reappear.
#
# Owner-feedback coverage (Rose AM90694/AM90705): the sibling-alias-only
# positive (an archive keyed by an alias spelling still resolves), the
# canonical-plus-alias ambiguity negative (two corroborated archives refuse),
# proof that no foreign path is touched, the installer-authenticated archive
# binding with its operator-authorized legacy migration, and a full owned
# commit-hook replay (real `am guard install` chain runner plus the real
# upstream 50-agent-mail.py) proving no foreign I/O, exclusive ownership,
# and duplicate refusal. The bootstrap-only under-1s benchmark is case B;
# it is not the whole-chain evidence — that is case J.
#
# Residual scope note: the upstream 50-agent-mail.py keeps its own
# realpath-over-every-key fallback for archives the touch-free scan cannot
# corroborate. Hermetically that fallback is fast (local fixture), so the
# replay passes; on a real dead NFS mount it would still block. The 10- hook
# (this repository's owned member) now refuses before the chain can proceed
# whenever a second corroborated archive exists, which coerces the downstream
# guard onto the single verified archive for every visible case. Pinning the
# upstream guard to an exact archive without a scan is upstream work and is
# recorded as an open question, not claimed here.
#
# Every verdict comes from isolated fixtures under repo-local var/agent-tmp
# with an isolated HOME; live repositories, the live archive, and .beads
# are never touched. Exit 0 all pass, 1 any fail.
set -u

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
mkdir -p "$REPO/var/agent-tmp" || exit 1
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO/scripts/kitlib-tmp.sh"
# shellcheck source=scripts/kitlib-proc.sh
. "$REPO/scripts/kitlib-proc.sh"
KITLIB_TMP_ROOT="$REPO/var/agent-tmp" kitlib_tmp TMP storage-root-gate-test || exit 1
GATE="$REPO/scripts/pre-commit-storage-root-gate.sh"
INSTALL="$REPO/scripts/install-pre-commit-storage-root-gate.sh"
pass=0
fail=0
ok() { pass=$((pass + 1)); }
no() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

command -v git > /dev/null 2>&1 || { printf 'SKIP storage-root-gate: git not found\n'; exit 0; }
command -v timeout > /dev/null 2>&1 || { printf 'SKIP storage-root-gate: timeout not found\n'; exit 0; }
command -v mkfifo > /dev/null 2>&1 || { printf 'SKIP storage-root-gate: mkfifo not found\n'; exit 0; }
HAVE_AM=0
command -v am > /dev/null 2>&1 && HAVE_AM=1

# Fresh fixture workspace: its own HOME (so default-root scans stay inside
# the fixture), its own empty global gitconfig, and a ceiling so git never
# discovers the parent checkout.
new_world() {
	name=$1
	W="$TMP/$name"
	mkdir -p "$W/home" "$W/work"
	: > "$W/home/gitconfig"
	HOME_W="$W/home"
}

# gate_env runs its arguments with the fixture HOME, an empty system/global
# git environment, no storage-root hand-off, and no leaked GIT_DIR, so each
# case starts from a known state. Extra VAR=val pairs come first.
gate_env() {
	env -u GIT_DIR -u GIT_WORK_TREE \
		HOME="$HOME_W" \
		XDG_DATA_HOME="$HOME_W/.local/share" \
		XDG_STATE_HOME="$HOME_W/.local/state" \
		GIT_CONFIG_GLOBAL="$HOME_W/gitconfig" \
		GIT_CONFIG_NOSYSTEM=1 \
		GIT_CEILING_DIRECTORIES="$TMP" \
		AGENT_MAIL_STORAGE_ROOT= \
		STORAGE_ROOT= \
		"$@"
}

mkrepo() {
	# Fixture git always runs under the isolated HOME: a plain `git init`
	# would copy the operator's real init.templateDir hooks (commit-msg
	# verification and the like) into the fixture and break hermeticity.
	fgit init --quiet "$1"
	fgit -C "$1" config user.email "storage-gate@example.invalid"
	fgit -C "$1" config user.name "storage-gate"
}

# fgit runs git with the fixture environment (see gate_env).
fgit() {
	gate_env git "$@"
}

# mkarchive ROOT SLUG HUMAN_KEY — one archive with a usable reservations dir.
mkarchive() {
	mkdir -p "$1/projects/$2/file_reservations"
	printf '{"slug":"%s","human_key":"%s"}' "$2" "$3" > "$1/projects/$2/project.json"
}

# ---------------------------------------------------------------- A. negative
# The planted negative: the pre-fix algorithm (realpath every archived key)
# with its foreign touch spelled as a blocking open, plus a pure-verbatim
# control proving the FIFO only catches the touch, not realpath itself.
new_world neg
mkrepo "$W/work/repo"
# FIFOs need local fifo-open semantics: on the ovnfs checkout mount, opening
# a fifo fails at once with EACCES instead of blocking (measured), which
# would neuter the stall stand-in. Keep the stall fixture on native local
# storage through a second kitlib-owned dir (same primitive, /tmp root).
KITLIB_TMP_ROOT=/tmp kitlib_tmp NATIVETMP storage-root-gate-native || exit 1
NATIVEROOT=$(CDPATH='' cd -- "$NATIVETMP" && pwd -P)/sroot || exit 1
NEG="$W/prefix-realpath-all.py"
cat > "$NEG" <<'EOF'
import json, os, sys
from pathlib import Path
project_root = os.path.realpath(sys.argv[1])
storage_root = sys.argv[2]
standin = sys.argv[3]
root = Path(os.path.expanduser(storage_root))
projects = root / "projects"
for archive in sorted(projects.iterdir(), key=lambda p: p.name):
    if archive.is_symlink() or not archive.is_dir():
        continue
    manifest = archive / "project.json"
    if manifest.is_symlink() or not manifest.is_file():
        continue
    if manifest.stat().st_size > 1024 * 1024:
        continue
    try:
        metadata = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    human_key = metadata.get("human_key") if isinstance(metadata, dict) else None
    if not isinstance(human_key, str):
        continue
    expanded = os.path.expanduser(human_key)
    if standin == "touch":
        try:
            with open(expanded, "rb") as handle:
                handle.read(1)
        except OSError:
            continue
    if os.path.realpath(expanded) == project_root:
        print(str(root.resolve()))
        break
else:
    sys.exit(2)
EOF
SROOT="$NATIVEROOT"
mkarchive "$SROOT" "zz-local" "$W/work/repo"
mkdir -p "$SROOT/projects/00-stalled/file_reservations"
mkfifo "$SROOT/projects/00-stalled/fifo-block"
mkarchive "$SROOT" "00-stalled" "$SROOT/projects/00-stalled/fifo-block"
# The stalled archive sorts before the local one, exactly the production
# shape (foreign keys iterated before the match is reached).
[ -f "$NEG" ] || { no "negative-fixture: reference program missing at $NEG"; }
[ -f "$SROOT/projects/zz-local/project.json" ] || { no "negative-fixture: local manifest missing"; }
[ -f "$SROOT/projects/00-stalled/project.json" ] || { no "negative-fixture: stalled manifest missing"; }
[ -p "$SROOT/projects/00-stalled/fifo-block" ] || { no "negative-fixture: stall fifo missing at $SROOT/projects/00-stalled/fifo-block"; }
# The touch variant runs in the background: still alive after 4 s proves it
# blocked on the stalled foreign key (the pre-fix hang), so the run kills it;
# a reference that finished instead would fail this case.
gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" python3 "$NEG" "$W/work/repo" "$SROOT" touch > "$W/neg-touch.log" 2>&1 &
negpid=$!
sleep 4
if kitlib_signal 0 "$negpid" 2>/dev/null; then
	ok
	kitlib_signal TERM "$negpid" 2>/dev/null
else
	wait "$negpid"; jobrc=$?
	no "negative-touch: pre-fix reference finished instead of hanging (job rc=$jobrc): $(cat "$W/neg-touch.log")"
fi
wait "$negpid" 2>/dev/null
out=$(gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" timeout 5 python3 "$NEG" "$W/work/repo" "$SROOT" plain 2>&1); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "negative-control: verbatim realpath does not hang (rc=$rc out=$out)"; fi

# ------------------------------------------------- B. 407 archives under 1 s
# Production mirror: exactly 407 archives, one canonical match, one
# FIFO-blocked foreign key, one unreadable-parent foreign key, one missing
# path, plus junk the matcher must ignore (empty key, corrupt JSON, archive
# without reservations). The timed run must finish under the 1 s bead bound.
# wallclock: p99=0.25s headroom=4x (measured steady-state on this host; the
# first untimed run warms the page cache so the bound judges the gate, cold
# filesystem excluded).
new_world big
mkrepo "$W/work/repo"
SROOT="$W/sroot"
mkarchive "$SROOT" "zz-local" "$W/work/repo"
mkdir -p "$SROOT/projects/00-stalled/file_reservations"
mkfifo "$SROOT/projects/00-stalled/fifo-block"
mkarchive "$SROOT" "00-stalled" "$SROOT/projects/00-stalled/fifo-block"
mkdir -p "$W/dark/inner" "$SROOT/projects/01-dark/file_reservations"
mkarchive "$SROOT" "01-dark" "$W/dark/inner"
chmod 000 "$W/dark"
mkarchive "$SROOT" "02-gone" "$W/no-such-path"
mkarchive "$SROOT" "03-empty" ""
mkdir -p "$SROOT/projects/04-bad/file_reservations"
printf '{not json' > "$SROOT/projects/04-bad/project.json"
mkdir -p "$SROOT/projects/05-nores"
printf '{"slug":"05-nores","human_key":"%s"}' "$W/work/repo" > "$SROOT/projects/05-nores/project.json"
i=0
while [ "$i" -lt 400 ]; do
	n=$(printf 'f%03d' "$i")
	mkarchive "$SROOT" "$n" "/elsewhere/foreign-repo-$n"
	i=$((i + 1))
done
n=$(find "$SROOT/projects" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
if [ "$n" = "407" ]; then ok; else no "407-count: expected 407 archives, found $n"; fi
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "407-warmup: rc=$rc out=$out"; fi
# The bound itself: timeout kills the run at exactly 1 s, so rc 0 proves the
# gate resolved the local project without touching the stalled mount.
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" timeout 1 sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "407-under-1s: rc=$rc out=$out"; fi
chmod 755 "$W/dark"

# --------------------------------------- C. no foreign path is ever touched
# Structural tripwire: the only path-resolution calls in the shipped hook
# are the allowlisted ones below, every one of them over a locally derived
# path (own toplevel, own common dir, local XDG candidates, configured
# roots, or the install-time-only authorized key check). Any new
# realpath/resolve call site fails this case on purpose.
code=$(grep -F -e 'realpath(' -e '.resolve()' "$GATE" | grep -v '#'); rc=$?
if [ "$rc" != "0" ] && [ "$rc" != "1" ]; then no "structural: grep failed rc=$rc"; fi
expect_n=0
check_site() {
	# $1 = expected occurrences, $2 = exact allowlisted code text (matched
	# as a substring: shipped lines carry indentation).
	expect_n=$((expect_n + $1))
	c=$(printf '%s\n' "$code" | grep -F -c -- "$2")
	if [ "$c" = "$1" ]; then ok; else no "structural: expected allowlisted site $1x, found $c: $2"; fi
}
check_site 1 'repo_root = os.path.realpath(raw_top)'
check_site 1 'common_dir = Path(os.path.realpath(common_dir))'
check_site 2 'matches.append((archive.name, str(root.resolve())))'
check_site 1 'if os.path.realpath(expanded) != project_root:'
check_site 1 'normalized = os.path.realpath(os.path.expanduser(str(root)))'
check_site 1 'return (slug, str(root.resolve())), None'
check_site 1 'if os.path.realpath(os.path.expanduser(handed)) != resolved_root:'
total=$(printf '%s\n' "$code" | grep -c .)
if [ "$total" = "$expect_n" ]; then ok; else no "structural: $total resolution sites, $expect_n allowlisted"; fi
c=$(grep -F -c 'open(' "$GATE")
if [ "$c" = "0" ]; then ok; else no "structural: $c open( calls in the hook"; fi
# authorized_matches exists only as the definition plus the three
# `if authorize` selections (bound-competing, configured, default scan):
# nothing in the commit path can reach it.
bad=$(grep -F 'authorized_matches' "$GATE" | grep -v -e 'def authorized_matches' -e 'if authorize' | grep -c '')
if [ "$bad" = "0" ]; then ok; else no "structural: authorized_matches reachable outside authorize selections"; fi

# -------------------------------------------- D. sibling-alias-only positive
# The repository addressed through a symlink alias (GIT_DIR carries the alias
# spelling verbatim while its realpath is still this repository): the
# alias-keyed archive resolves.
new_world alias
mkrepo "$W/work/repo"
ln -s "$W/work/repo" "$W/aliaslink"
SROOT="$W/sroot"
mkarchive "$SROOT" "alias-proj" "$W/aliaslink"
out=$(gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" GIT_DIR="$W/aliaslink/.git" GIT_WORK_TREE="$W/aliaslink" sh "$GATE" --resolve-root 2>&1); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "alias-only: rc=$rc out=$out"; fi

# ----------------------------------- E. canonical-plus-alias ambiguity refusal
# The canonical spelling and a live alias spelling both corroborate: two
# archives match, so the gate refuses instead of looking unique.
mkarchive "$SROOT" "canon-proj" "$W/work/repo"
out=$(gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" GIT_DIR="$W/aliaslink/.git" GIT_WORK_TREE="$W/aliaslink" sh "$GATE" --resolve-root 2>&1); rc=$?
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "multiple Agent Mail archives match"; then ok; else no "ambiguity: rc=$rc out=$out"; fi

# --------------------------------- F. worktree sibling positive and refusal
# A linked worktree beside the main checkout: its own path is a live second
# spelling of the project (raw toplevel), the main root the canonical one.
new_world wt
mkrepo "$W/work/main"
fgit -C "$W/work/main" commit --allow-empty --quiet -m "wt base"
fgit -C "$W/work/main" worktree add --quiet --detach "$W/work/wt" HEAD
SROOT="$W/sroot"
mkarchive "$SROOT" "wt-alias" "$W/work/wt"
# From the main checkout neither key corroborates (the worktree path is not
# the main root), so the gate refuses with no match.
out=$( (CDPATH='' cd -- "$W/work/main" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "no Agent Mail archive matches"; then ok; else no "worktree-main-nomatch: rc=$rc out=$out"; fi
# From the worktree the alias spelling corroborates, so the alias archive
# resolves.
out=$( (CDPATH='' cd -- "$W/work/wt" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "worktree-alias: rc=$rc out=$out"; fi
# With both spellings archived the gate refuses instead of picking one.
mkarchive "$SROOT" "main-proj" "$W/work/main"
out=$( (CDPATH='' cd -- "$W/work/wt" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "multiple Agent Mail archives match"; then ok; else no "worktree-ambiguity: rc=$rc out=$out"; fi

# --------------------------------------- G. install records the binding
# A fake chain runner carries the exact upstream markers the installer
# validates; the real installer then records slug plus canonical root.
new_world bind
mkrepo "$W/work/repo"
# First-install layout: the archive lives at the default XDG location, so the
# touch-free default scan finds it with no configured root and no hand-off.
SROOT="$HOME_W/.local/share/mcp-agent-mail/git_mailbox_repo"
mkarchive "$SROOT" "bound-proj" "$W/work/repo"
for phase in pre-commit pre-push; do
	mkdir -p "$W/work/repo/.git/hooks/hooks.d/$phase"
	cat > "$W/work/repo/.git/hooks/$phase" <<EOF
#!/usr/bin/env python3
# mcp-agent-mail chain-runner ($phase)
import os
import subprocess
import sys
from pathlib import Path
HOOK_DIR = Path(__file__).resolve().parent
ORIG = HOOK_DIR / '$phase.orig'
RUN_DIR = HOOK_DIR / 'hooks.d' / '$phase'
sys.exit(0)
EOF
	chmod +x "$W/work/repo/.git/hooks/$phase"
	printf 'x\n' > "$W/work/repo/.git/hooks/hooks.d/$phase/.keep"
done
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env sh "$INSTALL" 2>&1) ); rc=$?
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "archive binding: bound-proj"; then ok; else no "install-binding: rc=$rc out=$out"; fi
slug=$(fgit -C "$W/work/repo" config --local --get omp-kit.agent-mail-archive)
canon=$(fgit -C "$W/work/repo" config --local --get omp-kit.agent-mail-archive-canonical)
if [ "$slug" = "bound-proj" ] && [ "$canon" = "$W/work/repo" ]; then ok; else no "install-binding-config: slug=$slug canonical=$canon"; fi
# Bound mode resolves with no storage environment at all (repo config only).
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "bound-resolve: rc=$rc out=$out"; fi

# --------------------------------- H. operator-authorized alias migration
# A registration under an alias spelling the scan cannot corroborate: the
# touch-free lookup finds nothing, and the installer migrates it with the
# authorized full verification (naming each probed key), recording the
# canonical binding. Later commits verify touch-free.
new_world migrate
mkrepo "$W/work/repo"
ln -s "$W/work/repo" "$W/aliaslink"
# Same first-install layout as case G: default XDG location.
SROOT="$HOME_W/.local/share/mcp-agent-mail/git_mailbox_repo"
mkarchive "$SROOT" "alias-proj" "$W/aliaslink"
for phase in pre-commit pre-push; do
	mkdir -p "$W/work/repo/.git/hooks/hooks.d/$phase"
	cat > "$W/work/repo/.git/hooks/$phase" <<EOF
#!/usr/bin/env python3
# mcp-agent-mail chain-runner ($phase)
import os
import subprocess
import sys
from pathlib import Path
HOOK_DIR = Path(__file__).resolve().parent
ORIG = HOOK_DIR / '$phase.orig'
RUN_DIR = HOOK_DIR / 'hooks.d' / '$phase'
sys.exit(0)
EOF
	chmod +x "$W/work/repo/.git/hooks/$phase"
done
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "no Agent Mail archive matches"; then ok; else no "migration-unbound: rc=$rc out=$out"; fi
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" sh "$INSTALL" 2>&1) ); rc=$?
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "archive binding: alias-proj"; then ok; else no "migration-install: rc=$rc out=$out"; fi
if printf '%s' "$out" | grep -q "verifying archived key $W/aliaslink"; then ok; else no "migration-progress: operator-visible probe missing"; fi
canon=$(fgit -C "$W/work/repo" config --local --get omp-kit.agent-mail-archive-canonical)
if [ "$canon" = "$W/work/repo" ]; then ok; else no "migration-canonical: $canon"; fi
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env AGENT_MAIL_STORAGE_ROOT="$SROOT" timeout 1 sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" = "0" ] && [ "$out" = "$SROOT" ]; then ok; else no "migration-resolve: rc=$rc out=$out"; fi

# ------------------------------------------------ I. stale bindings refuse
# A binding whose canonical root moved, or whose archive is gone, refuses
# with the binding remedy instead of resolving or guessing.
new_world stale
mkrepo "$W/work/repo"
SROOT="$W/sroot"
mkarchive "$SROOT" "stale-proj" "$W/work/repo"
fgit -C "$W/work/repo" config --local --replace-all omp-kit.agent-mail-storage-root "$SROOT"
fgit -C "$W/work/repo" config --local --replace-all omp-kit.agent-mail-archive "stale-proj"
fgit -C "$W/work/repo" config --local --replace-all omp-kit.agent-mail-archive-canonical "$W/moved-elsewhere"
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "recorded Agent Mail archive binding"; then ok; else no "stale-canonical: rc=$rc out=$out"; fi
fgit -C "$W/work/repo" config --local --replace-all omp-kit.agent-mail-archive-canonical "$W/work/repo"
fgit -C "$W/work/repo" config --local --replace-all omp-kit.agent-mail-archive "gone-proj"
out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env sh "$GATE" --resolve-root 2>&1) ); rc=$?
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "recorded Agent Mail archive binding"; then ok; else no "stale-missing: rc=$rc out=$out"; fi

# ----------------------------------------- J. full owned commit-hook replay
# Real `am guard install` chain runners plus the real upstream
# 50-agent-mail.py, the repaired 10- hook installed by the real installer,
# and real `git commit` invocations: a clean commit passes with a
# FIFO-blocked foreign archive present; an exclusive foreign reservation
# refuses; the holder is allowed through; a duplicate matching archive
# refuses before the downstream guard can pick the wrong archive.
if [ "$HAVE_AM" = "1" ]; then
	new_world replay
	mkrepo "$W/work/repo"
	if ! gate_env env am guard install "$W/work/repo" "$W/work/repo" > "$W/guard-install.log" 2>&1; then
		no "replay-guard-install: $(cat "$W/guard-install.log")"
	else
		ok
		SROOT="$HOME_W/.local/share/mcp-agent-mail/git_mailbox_repo"
		mkarchive "$SROOT" "replay-proj" "$W/work/repo"
		mkdir -p "$SROOT/projects/00-stalled/file_reservations"
		mkfifo "$SROOT/projects/00-stalled/fifo-block"
		mkarchive "$SROOT" "00-stalled" "$SROOT/projects/00-stalled/fifo-block"
		if ! out=$( (CDPATH='' cd -- "$W/work/repo" && gate_env env sh "$INSTALL" 2>&1) ); then
			no "replay-install: $out"
		else
			ok
			do_commit() {
				# $1 = agent, $2 = message, $3... = files (already staged by caller)
				(CDPATH='' cd -- "$W/work/repo" && gate_env env AGENT_NAME="$1" timeout 30 git commit -m "$2 [test]" > "$W/commit.log" 2>&1)
			}
			printf 'clean\n' > "$W/work/repo/a.txt"
			fgit -C "$W/work/repo" add a.txt
			if do_commit replay-agent "replay clean"; then ok; else no "replay-clean: $(cat "$W/commit.log")"; fi
			printf '{"path_pattern":"guarded.txt","agent_name":"res-holder","exclusive":true,"expires_ts":4102444800000000}' \
				> "$SROOT/projects/replay-proj/file_reservations/id-7.json"
			printf 'guarded\n' > "$W/work/repo/guarded.txt"
			fgit -C "$W/work/repo" add guarded.txt
			if do_commit replay-agent "replay conflict"; then
				no "replay-conflict: foreign exclusive reservation was not enforced"
			else
				if grep -q "reservation conflict" "$W/commit.log"; then ok; else no "replay-conflict: wrong refusal: $(cat "$W/commit.log")"; fi
			fi
			if do_commit res-holder "replay holder"; then ok; else no "replay-holder: $(cat "$W/commit.log")"; fi
			mkarchive "$SROOT" "aaa-dup" "$W/work/repo"
			printf 'dup\n' > "$W/work/repo/b.txt"
			fgit -C "$W/work/repo" add b.txt
			if do_commit replay-agent "replay duplicate"; then
				no "replay-duplicate: second matching archive was not refused"
			else
				if grep -q "multiple Agent Mail archives match" "$W/commit.log"; then ok; else no "replay-duplicate: wrong refusal: $(cat "$W/commit.log")"; fi
			fi
		fi
	fi
else
	printf 'SKIP replay: am not found, hook-chain cases above still ran\n'
fi

printf 'storage-root-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
