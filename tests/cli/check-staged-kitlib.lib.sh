#!/bin/sh
# check-staged-kitlib.lib.sh — shared setup for the check-staged-kitlib*.test.sh
# parts (KITLIB-RATCHET gate contract, ompkit-qwqh1). Sourced, never run: it
# owns the kitlib temp dir, the check counter and the fixture helpers.
# shellcheck shell=sh disable=SC2034
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
INSTALLER=$SCRIPTS/install-commit-msg-bead.sh
MEMBER=51-omp-kit-staged-kitlib
# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPTS/kitlib-tmp.sh"
kitlib_tmp TMP staged-kitlib-test || exit 1
# Enclosing-checkout lookups are forbidden inside fixtures: the ceiling
# confines every git discovery to the owned temp tree (fixtures preserve it).
export GIT_CEILING_DIRECTORIES="$TMP"

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
# validate_inputs: full pre-replay identity of the declared 78-path set.
# Fails closed with PRECHECK-REFUSED before any fixture repo exists:
# the X diff set must equal the manifest set, and every path's mode and
# blob at X and at P must equal the manifest (ABSENT where missing).
validate_inputs() {
	: > "$TMP/.hydrate-bad"
	git -C "$OBJSRC" diff-tree --no-commit-id --name-only -r "$XREAL" 2>/dev/null | LC_ALL=C sort > "$TMP/.diffset" || return 1
	sed -n '/^## PATHS78/,$p' "$CAPSULE_MANIFEST" | grep -v '^#' | grep -v '^$' | cut -d' ' -f1 | LC_ALL=C sort > "$TMP/.manifestset" || return 1
	cmp -s "$TMP/.diffset" "$TMP/.manifestset" || { echo "PRECHECK-REFUSED X path set differs from manifest" >&2; return 1; }
	sed -n '/^## PATHS78/,$p' "$CAPSULE_MANIFEST" | grep -v '^#' | grep -v '^$' | while read -r _pp _mx _bx _mp _bp; do
		_gx=$(git -C "$OBJSRC" ls-tree "$XREAL" -- "$_pp" 2>/dev/null); _gxm=${_gx%% *}; _gxb=$(printf '%s' "$_gx" | cut -d' ' -f3 | cut -f1); [ -n "$_gx" ] || { _gxm=ABSENT; _gxb=ABSENT; }
		_gp=$(git -C "$OBJSRC" ls-tree "$PREAL" -- "$_pp" 2>/dev/null); _gpm=${_gp%% *}; _gpb=$(printf '%s' "$_gp" | cut -d' ' -f3 | cut -f1); [ -n "$_gp" ] || { _gpm=ABSENT; _gpb=ABSENT; }
		if [ "$_gxm" != "$_mx" ] || [ "$_gxb" != "$_bx" ] || [ "$_gpm" != "$_mp" ] || [ "$_gpb" != "$_bp" ]; then echo "MISMATCH-path:$_pp" >> "$TMP/.hydrate-bad"; fi
	done
	[ ! -s "$TMP/.hydrate-bad" ] || { echo "PRECHECK-REFUSED path identity mismatch"; cat "$TMP/.hydrate-bad"; return 1; } >&2
}
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
# replay_setup: hydrate the capsule, prove X/P identity and bind XPATHS;
# every replay part calls it before its first real_repo.
replay_setup() {
	OBJSRC=$(hydrate_capsule "$CAPSULE_PACK" "$CAPSULE_MANIFEST" "$TMP/ratchet-obj-src") || exit 1
	printf 'capsule sha256 %s\n' "$(manifest_field capsule_sha256)"
	printf 'input X=%s P=%s OLD=%s\n' "$XREAL" "$PREAL" "$OLDCONVERGE"
	[ "$(git -C "$OBJSRC" rev-list --parents -n 1 "$XREAL" | cut -d' ' -f2)" = "$PREAL" ] || { echo "HYDRATE-REFUSED X parent is not P" >&2; exit 1; }
	validate_inputs || exit 1
	XPATHS=$(git -C "$OBJSRC" diff-tree --no-commit-id --name-only -r "$XREAL") || exit 1
	XCOUNT=$(printf '%s\n' "$XPATHS" | wc -l)
}
