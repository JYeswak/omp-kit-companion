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
# keep_kitlib_hooks DIR: leave the members exercised by this contract and their
# support files; unrelated numbered hooks only add fixture commit cost.
keep_kitlib_hooks() {
	_repo=$1
	for _member in "$_repo"/.git/hooks/hooks.d/*/*; do
		[ -e "$_member" ] || continue
		case "$(basename "$_member")" in
		51-omp-kit-staged-kitlib|50-omp-kit-staged-kitlib-reversal|*.*) ;;
		*) rm -f "$_member" ;;
		esac
	done
	rm -f "$_repo/.git/hooks/pre-push" "$_repo/.git/hooks/reference-transaction"
	git -C "$_repo" config maintenance.auto false
}

# Install once; content-specific root commits below still precede their hooks.
installed_hooks() {
	installed="$TMP/.installed-kitlib"
	if [ ! -x "$installed/.git/hooks/hooks.d/pre-commit/$MEMBER" ]; then
		mkdir -p "$installed"
		if [ -n "${KITLIB_INSTALLED_FIXTURE:-}" ]; then
			cp -Rp "$KITLIB_INSTALLED_FIXTURE/." "$installed/" || return 1
		else
			git -C "$installed" init -q 2>/dev/null
			git -C "$installed" config user.email "test@invalid.example"
			git -C "$installed" config user.name "Test"
			git -C "$installed" -c core.hooksPath=/dev/null commit -q --allow-empty -m "[test] root"
			out=$(sh "$INSTALLER" "$installed" 2>&1) || { printf 'FAIL install template: %s\n' "$out" >&2; return 1; }
		fi
		keep_kitlib_hooks "$installed"
		if [ "${KITLIB_TEST_MEMBER51_FAIL_OPEN:-0}" = "1" ]; then
			printf '%s\n' '#!/bin/sh' 'exit 0' > "$installed/.git/hooks/hooks.d/pre-commit/$MEMBER"
		fi
	fi
	printf '%s' "$installed/.git/hooks"
}

# Immutable cases share the actual installed hook inodes: a new executable
# copy otherwise pays macOS first-exec scanning again. Mutation cases request
# private copies before deleting or editing any member/helper.
fixture_hooks() {
	hooks=$(installed_hooks) || return 1
	python3 - "$hooks" "$1/.git/hooks" "${2:-link}" <<'PY'
import os, pathlib, shutil, sys
source, target, mode = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
if mode == "private":
    for path in target.rglob("*"):
        if path.is_file() and path.stat().st_nlink > 1:
            private = path.with_name(path.name + ".private")
            shutil.copy2(path, private)
            os.replace(private, path)
else:
    for path in source.rglob("*"):
        if path.is_file():
            dest = target / path.relative_to(source)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.unlink(missing_ok=True)
            os.link(path, dest)
PY
}


# new_repo NAME [FILE CONTENT]: a fresh repo whose root commit (made before
# any hook exists) optionally holds FILE, then the installer's chains.
new_repo() {
	dir="$TMP/$1"
	if [ $# -ge 3 ]; then
		template_key=$(printf '%s\n%s' "$2" "$3" | git hash-object --stdin) || return 1
	else
		template_key=empty
	fi
	template="$TMP/.kitlib-templates/$template_key"
	if [ ! -x "$template/.git/hooks/hooks.d/pre-commit/$MEMBER" ]; then
		mkdir -p "$template"
		git -C "$template" init -q 2>/dev/null
		git -C "$template" config user.email "test@invalid.example"
		git -C "$template" config user.name "Test"
		rm -f "$template/.git/hooks/commit-msg" "$template/.git/hooks/commit-msg-"* "$template/.git/hooks/pre-commit"
		if [ $# -ge 3 ]; then
			mkdir -p "$template/$(dirname "$2")"
			printf '%s\n' "$3" > "$template/$2" && git -C "$template" add "$2"
		fi
		git -C "$template" -c core.hooksPath=/dev/null commit -q --allow-empty --message "[test] root"
		hooks=$(installed_hooks) || exit 1
		cp -Rp "$hooks/." "$template/.git/hooks/" || exit 1
		keep_kitlib_hooks "$template"
		[ -x "$template/.git/hooks/hooks.d/pre-commit/$MEMBER" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	fi
	mkdir -p "$dir"
	cp -Rp "$template/." "$dir/" || { printf 'FAIL copy %s from template\n' "$1" >&2; exit 1; }
	fixture_hooks "$dir" || exit 1
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/$MEMBER" ] || { printf 'FAIL copy %s: member absent\n' "$1" >&2; exit 1; }
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
	template="$TMP/.origin-template"
	if [ -d "$template" ]; then
		dir="$TMP/$1"
		mkdir -p "$dir"
		cp -Rp "$template/." "$dir/" || return 1
		fixture_hooks "$dir" || return 1
		git -C "$dir" remote set-url origin "$dir/published.git" || return 1
		printf '%s\n' "$dir"
		return
	fi
	dir=$(new_repo "$1" tool.py "$PY_BAD_OLD") || return 1
	printf '%s\n' "$PY_BAD" > "$dir/tool.py"
	git -C "$dir" add tool.py
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] published origin"
	origin=$(git -C "$dir" rev-parse HEAD) || return 1
	git -C "$dir" -c init.templateDir= init --bare -q "$dir/published.git" || return 1
	git -C "$dir" remote add origin "$dir/published.git" || return 1
	git -C "$dir" -c core.hooksPath=/dev/null push -q origin "$origin:refs/heads/main" || return 1
	git -C "$dir" update-ref refs/remotes/origin/main "$origin" || return 1
	printf '%s\n' "$PY_GOOD" > "$dir/tool.py"
	git -C "$dir" add tool.py
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] ratchet reduction"
	mkdir -p "$template"
	cp -Rp "$dir/." "$template/" || return 1
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
	git -C "$OBJSRC" diff-tree --no-commit-id --name-only -r "$XREAL" 2>/dev/null | LC_ALL=C sort > "$TMP/.diffset" || return 1
	sed -n '/^## PATHS78/,$p' "$CAPSULE_MANIFEST" | grep -v '^#' | grep -v '^$' | cut -d' ' -f1 | LC_ALL=C sort > "$TMP/.manifestset" || return 1
	cmp -s "$TMP/.diffset" "$TMP/.manifestset" || { echo "PRECHECK-REFUSED X path set differs from manifest" >&2; return 1; }
	git -C "$OBJSRC" ls-tree -r "$XREAL" > "$TMP/.x-tree" || return 1
	git -C "$OBJSRC" ls-tree -r "$PREAL" > "$TMP/.p-tree" || return 1
	python3 - "$CAPSULE_MANIFEST" "$TMP/.x-tree" "$TMP/.p-tree" <<'PY'
import pathlib, sys
def entries(filename):
    result = {}
    for line in pathlib.Path(filename).read_text().splitlines():
        metadata, path = line.split("\t", 1)
        mode, _, blob = metadata.split()
        result[path] = (mode, blob)
    return result
x, p = entries(sys.argv[2]), entries(sys.argv[3])
rows = pathlib.Path(sys.argv[1]).read_text().split("## PATHS78", 1)[1]
bad = []
for line in rows.splitlines()[1:]:
    if not line.strip() or line.startswith("#"):
        continue
    path, mx, bx, mp, bp = line.split()
    if x.get(path, ("ABSENT", "ABSENT")) != (mx, bx) or p.get(path, ("ABSENT", "ABSENT")) != (mp, bp):
        bad.append(path)
if bad:
    print("PRECHECK-REFUSED path identity mismatch", file=sys.stderr)
    for path in bad:
        print("MISMATCH-path:" + path, file=sys.stderr)
    sys.exit(1)
PY
}
# sync_tree DIR REV: check out exactly the 78 X paths at REV bytes and mode;
# paths absent at REV (the two X-added files) are removed for the reversal.
sync_tree() {
	# Remove selected entries first: archive omits paths absent at the target.
	for p in $XPATHS; do rm -f "$1/$p"; done
	# shellcheck disable=SC2086 # intended split: a whitespace-separated list of literal repo paths, no globs
	paths=$(git -C "$OBJSRC" ls-tree -r --name-only "$2" -- $XPATHS) || return 1
	# The capsule intentionally omits unrelated blobs. Its empty worktree has
	# no export attributes; do not hydrate an index for the incomplete full tree.
	# shellcheck disable=SC2086 # intended split: a whitespace-separated list of literal repo paths, no globs
	git -C "$OBJSRC" archive --worktree-attributes "$2" -- $paths | tar -x -C "$1"
}
# real_repo NAME: root, P-tree published as a local origin, X-tree on top.
real_repo() {
	dir="$TMP/$1"
	template="$TMP/.real-template"
	if [ -d "$template" ]; then
		mkdir -p "$dir"
		cp -Rp "$template/." "$dir/" || return 1
		fixture_hooks "$dir" || return 1
		git -C "$dir" remote set-url origin "$dir/published.git" || return 1
		printf '%s' "$dir"
		return
	fi
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	git -C "$dir" -c core.hooksPath=/dev/null commit -q --allow-empty --message "[test] root"
	hooks=$(installed_hooks) || return 1
	cp -Rp "$hooks/." "$dir/.git/hooks/" || return 1
	keep_kitlib_hooks "$dir"
	fixture_hooks "$dir" || return 1
	sync_tree "$dir" "$PREAL" || return 1
	for p in $XPATHS; do [ -e "$dir/$p" ] && git -C "$dir" add -- "$p"; done
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] published origin"
	origin=$(git -C "$dir" rev-parse HEAD) || return 1
	git -C "$dir" -c init.templateDir= init --bare -q "$dir/published.git" || return 1
	git -C "$dir" remote add origin "$dir/published.git" || return 1
	git -C "$dir" -c core.hooksPath=/dev/null push -q origin "$origin:refs/heads/main" || return 1
	git -C "$dir" update-ref refs/remotes/origin/main "$origin" || return 1
	sync_tree "$dir" "$XREAL" || return 1
	for p in $XPATHS; do git -C "$dir" add -- "$p"; done
	git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "[test] ratchet introduction"
	X=$(git -C "$dir" rev-parse HEAD) || return 1
	mkdir -p "$template"
	cp -Rp "$dir/." "$template/" || return 1
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
