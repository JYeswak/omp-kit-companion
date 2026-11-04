#!/bin/sh
# HOOKREFRESH1 (ompkit-v66l.22.3): installer-owned hook members are deployment artifacts. In a repo whose hooks dir
# lies inside the work tree (core.hooksPath=.githooks), scripts/install-commit-msg-bead.sh lists every path it wrote
# in one marked info/exclude block, so `git add -A` never stages kit bytes and no staged gate judges them, while a
# tracked repo-owned member or adaptation is still judged. INSTALLER_UNDER_TEST swaps in another installer.
# Production literals for affected-tests.ts: scripts/install-commit-msg-bead.sh scripts/check-staged-tempsafe.sh
# scripts/check-staged-kitlib.sh scripts/check-stale-worktree.sh
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
INSTALLER=${INSTALLER_UNDER_TEST:-$KITREPO/scripts/install-commit-msg-bead.sh}
REPO_TMP="$KITREPO/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP install-hook-exclude-test || exit 1
TMP=$(CDPATH='' cd -- "$TMP" && pwd -P) || exit 1
export TMPDIR="$TMP"
# No tracker resolves in a fixture: the bead-id member passes an id it cannot look up.
BEADS_DB="$TMP/absent.db"
export BEADS_DB
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

# A repo-owned chain runner, as clutterfreespaces.ios tracks its own: it names hooks.d, so the installer keeps it.
repo_runner() {
	cat <<'EOF'
#!/bin/sh
# repo-owned chain runner (fixture): every executable NN- member of hooks.d/<kind>; the first refusal wins.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
kind=$(basename -- "$0")
for member in "$here/hooks.d/$kind"/[0-9][0-9]-*; do
	[ -x "$member" ] || continue
	"$member" "$@" || exit $?
done
EOF
}

# in_tree_repo NAME: core.hooksPath=.githooks with tracked repo-owned runners and one repo-owned member.
in_tree_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir/.githooks/hooks.d/pre-commit" "$dir/.githooks/hooks.d/commit-msg" || return 1
	git -C "$dir" init -q -b main || return 1
	git -C "$dir" config user.email t@example.invalid
	git -C "$dir" config user.name t
	git -C "$dir" config core.hooksPath .githooks
	for kind in pre-commit commit-msg; do
		repo_runner > "$dir/.githooks/$kind"
		chmod +x "$dir/.githooks/$kind"
	done
	printf '#!/bin/sh\nexit 0\n' > "$dir/.githooks/hooks.d/pre-commit/10-repo-owned"
	chmod +x "$dir/.githooks/hooks.d/pre-commit/10-repo-owned"
	printf 'seed\n' > "$dir/README.txt"
	git -C "$dir" add -A
	git -C "$dir" commit -q -m "[test] seed fixture-1" -m "Bead: fixture-1" || return 1
	printf '%s' "$dir"
}
exclude_of() { printf '%s/.git/info/exclude' "$1"; }
block_lines() { sed -n '/^# BEGIN omp-kit installer-owned hook members/,/^# END omp-kit installer-owned hook members/p' "$(exclude_of "$1")"; }
commit_msg() { printf '%s\n\nBead: fixture-1\n' "$1" > "$TMP/msg"; }

# (a) An install leaves no kit path for `git add -A`; an unrelated commit runs the whole installed chain and passes.
A=$(in_tree_repo a) || exit 1
mkdir -p "$A/.git/info"
printf 'keep-me\n' >> "$(exclude_of "$A")"
sh "$INSTALLER" "$A" > "$TMP/install-a.out" 2>&1
ok $? "(a) install rc: $(tail -3 "$TMP/install-a.out")"
dirt=$(git -C "$A" status --porcelain --untracked-files=all)
if [ -z "$dirt" ]; then ok 0 "(a) clean"; else ok 1 "(a) install left no git-visible path: $dirt"; fi
grep -qx '/.githooks/hooks.d/pre-commit/kitlib_tmp.py' "$(exclude_of "$A")"; ok $? "(a) block lists a copied helper"
grep -qx '/.githooks/pre-push' "$(exclude_of "$A")"; ok $? "(a) block lists the kit runner it created"
if grep -qx '/.githooks/pre-commit' "$(exclude_of "$A")"; then ok 1 "(a) a repo-owned runner must not be listed"; else ok 0 "(a) repo-owned runner unlisted"; fi
grep -qx 'keep-me' "$(exclude_of "$A")"; ok $? "(a) other exclude lines kept"
cp "$(exclude_of "$A")" "$TMP/exclude-a.first"
printf 'notes\n' > "$A/notes.txt"
git -C "$A" add -A
staged=$(git -C "$A" diff --cached --name-only)
if [ "$staged" = notes.txt ]; then ok 0 "(a) staged"; else ok 1 "(a) git add -A staged only the unrelated change: $staged"; fi
commit_msg "[test] add notes fixture-1"
(CDPATH='' cd -- "$A" && git commit -q -F "$TMP/msg") > "$TMP/commit-a.out" 2>&1
ok $? "(a) unrelated commit through the installed chain: $(tail -5 "$TMP/commit-a.out")"

# (d) --check reads the block; a repeat install writes the same bytes.
sh "$INSTALLER" --check "$A" > "$TMP/check-a.out" 2>&1
ok $? "(d) --check fresh in-tree: $(cat "$TMP/check-a.out")"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok $? "(d) repeat install rc"
cmp -s "$TMP/exclude-a.first" "$(exclude_of "$A")"; ok $? "(d) repeat install keeps identical exclude bytes"
grep -v '^/.githooks/' "$(exclude_of "$A")" > "$TMP/exclude-a.cut"
cp "$TMP/exclude-a.cut" "$(exclude_of "$A")"
sh "$INSTALLER" --check "$A" > "$TMP/check-a2.out" 2>&1
rc=$?
[ "$rc" = 3 ] && grep -q 'STALE installer-owned block' "$TMP/check-a2.out"; ok $? "(d) --check names a gutted block (rc=$rc)"
cp "$TMP/exclude-a.first" "$(exclude_of "$A")"

# (b) Negatives: ignore never hides judged bytes. A force-added released copy and an edited tracked kit-member path
# (an adaptation) are both staged and judged; the tracked edit stays visible to git status.
git -C "$A" add -f .githooks/hooks.d/pre-commit/kitlib_tmp.py
(CDPATH='' cd -- "$A" && sh .githooks/pre-commit) > "$TMP/forced.out" 2>&1
rc=$?
[ "$rc" != 0 ] && grep -q 'kitlib_tmp.py' "$TMP/forced.out"; ok $? "(b) force-added kit copy is judged and refused (rc=$rc)"
git -C "$A" rm -q --cached .githooks/hooks.d/pre-commit/kitlib_tmp.py
B=$(in_tree_repo b) || exit 1
member=.githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree
cp "$KITREPO/scripts/check-stale-worktree.sh" "$B/$member"
printf '# repo adaptation\n' >> "$B/$member"
# Tracked without +x: the repo runner runs only executable members, and the kit helpers it sources arrive with the install.
chmod a-x "$B/$member"
git -C "$B" add "$member"
commit_msg "[test] adapt the stale-worktree member fixture-1"
git -C "$B" commit -q -F "$TMP/msg" > "$TMP/adapt-b.out" 2>&1 || { cat "$TMP/adapt-b.out"; exit 1; }
sh "$INSTALLER" "$B" > "$TMP/install-b.out" 2>&1
ok $? "(b) install over a tracked adaptation: $(tail -3 "$TMP/install-b.out")"
git -C "$B" status --porcelain | grep -q " M $member"; ok $? "(b) tracked kit-member path stays visible to git status"
git -C "$B" show "HEAD:$member" > "$B/$member"
# shellcheck disable=SC2016 # the planted line is literal shell for the gate to judge
printf 'scratch=$(mktemp)\n' >> "$B/$member" # tempsafe: planted fixture text the gate under test must refuse; never run here
git -C "$B" add "$member"
(CDPATH='' cd -- "$B" && sh .githooks/pre-commit) > "$TMP/edited.out" 2>&1
rc=$?
[ "$rc" != 0 ] && grep -q '49-omp-kit-stale-worktree' "$TMP/edited.out"; ok $? "(b) edited tracked kit-member path is judged and refused (rc=$rc)"

# (c) Mutant: the installer without its exclude write leaves the copies for `git add -A`, and the staged gates refuse.
if [ -z "${INSTALLER_UNDER_TEST:-}" ]; then
	mutkit="$TMP/mutkit"
	mkdir -p "$mutkit/scripts"
	for path in "$KITREPO"/scripts/*; do ln -s "$path" "$mutkit/scripts/${path##*/}"; done
	ln -s "$KITREPO/src" "$mutkit/src"
	rm "$mutkit/scripts/install-commit-msg-bead.sh"
	grep -v '^write_exclude_block || rollback' "$INSTALLER" > "$mutkit/scripts/install-commit-msg-bead.sh"
	if cmp -s "$mutkit/scripts/install-commit-msg-bead.sh" "$INSTALLER"; then
		ok 1 "(c) mutant differs from the installer (call site present)"
	else
		C=$(in_tree_repo c) || exit 1
		sh "$mutkit/scripts/install-commit-msg-bead.sh" "$C" > "$TMP/install-c.out" 2>&1
		ok $? "(c) mutant install rc: $(tail -3 "$TMP/install-c.out")"
		git -C "$C" add -A
		git -C "$C" diff --cached --name-only | grep -q '^.githooks/hooks.d/pre-commit/kitlib_tmp.py$'
		ok $? "(c) mutant: git add -A stages kit copies"
		(CDPATH='' cd -- "$C" && sh .githooks/pre-commit) > "$TMP/mutant.out" 2>&1
		rc=$?
		# The repo runner stops at the first refusing staged gate (pysafe, tempsafe or kitlib, by order).
		[ "$rc" != 0 ] && grep -Eq 'staged-[a-z-]+: REFUSED' "$TMP/mutant.out" && grep -q '\.githooks/hooks\.d/' "$TMP/mutant.out"
		ok $? "(c) mutant: a staged gate refuses the kit copies (rc=$rc): $(grep -E 'REFUSED' "$TMP/mutant.out" | head -3)"
	fi
fi

# (d) A hooks dir inside the git dir (jev, the companion: .git/hooks) gets no block and --check stays rc 0.
D="$TMP/d"
mkdir -p "$D"
git -C "$D" init -q -b main
git -C "$D" config user.email t@example.invalid
git -C "$D" config user.name t
git -C "$D" commit -q --allow-empty -m "[test] seed fixture-1"
sh "$INSTALLER" "$D" > "$TMP/install-d.out" 2>&1
ok $? "(d) .git/hooks install rc: $(tail -3 "$TMP/install-d.out")"
sh "$INSTALLER" --check "$D" > "$TMP/check-d.out" 2>&1
ok $? "(d) .git/hooks --check rc 0: $(cat "$TMP/check-d.out")"
if grep -q 'omp-kit installer-owned' "$(exclude_of "$D")" 2>/dev/null; then ok 1 "(d) .git/hooks layout got a block"; else ok 0 "(d) .git/hooks layout has no block"; fi

# (e) The owner's untrack step for tracked plain kit copies (clutterfreespaces.ios table A): `git rm --cached` the
# released bytes, after which the block ignores them. The commit runs the installed chain; record what it needs.
E=$(in_tree_repo e) || exit 1
for pair in commit-msg/40-omp-kit-commit-msg-bead:scripts/commit-msg-bead.sh pre-commit/check-commit-imports.sh:scripts/check-commit-imports.sh; do
	cp "$KITREPO/${pair#*:}" "$E/.githooks/hooks.d/${pair%%:*}"
done
git -C "$E" add -A
commit_msg "[test] track kit copies fixture-1"
git -C "$E" commit -q -F "$TMP/msg" || exit 1
sh "$INSTALLER" "$E" > "$TMP/install-e.out" 2>&1
ok $? "(e) install rc: $(tail -3 "$TMP/install-e.out")"
git -C "$E" rm -q --cached .githooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead .githooks/hooks.d/pre-commit/check-commit-imports.sh
commit_msg "[test] untrack installer-owned kit copies fixture-1"
(CDPATH='' cd -- "$E" && git commit -q -F "$TMP/msg") > "$TMP/untrack-bare.out" 2>&1
printf 'untrack-bare rc=%s\n' "$?" > "$TMP/recipe"
cat "$TMP/untrack-bare.out" >> "$TMP/recipe"
untracked_head=$(git -C "$E" rev-parse HEAD)
if git -C "$E" ls-files --error-unmatch .githooks/hooks.d/pre-commit/check-commit-imports.sh >/dev/null 2>&1; then
	printf '%s\n' "${E_TRAILERS:-}" > "$TMP/trailers"
	{ printf '[test] untrack installer-owned kit copies fixture-1\n\n'; cat "$TMP/trailers"; printf 'Bead: fixture-1\n'; } > "$TMP/msg"
	(CDPATH='' cd -- "$E" && git commit -q -F "$TMP/msg") > "$TMP/untrack-trailers.out" 2>&1
	printf 'untrack-with-trailers rc=%s\n' "$?" >> "$TMP/recipe"
	cat "$TMP/untrack-trailers.out" >> "$TMP/recipe"
fi
if git -C "$E" ls-files --error-unmatch .githooks/hooks.d/pre-commit/check-commit-imports.sh >/dev/null 2>&1; then
	ok 1 "(e) untrack commit landed: $(cat "$TMP/recipe")"
else
	ok 0 "(e) untrack commit landed"
fi
dirt=$(git -C "$E" status --porcelain --untracked-files=all)
if [ -z "$dirt" ]; then ok 0 "(e) clean"; else ok 1 "(e) untracked copies are ignored afterwards: $dirt"; fi
[ -z "${E_RECIPE_OUT:-}" ] || { cp "$TMP/recipe" "$E_RECIPE_OUT"; printf 'head=%s\n' "$untracked_head" >> "$E_RECIPE_OUT"; }

printf 'install-hook-exclude: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
