#!/bin/sh
# Install the bead-id commit-msg hook, the reference-transaction ref guard and
# the pushed-beads pre-push member into a repo's hook chains.
# Usage: install-commit-msg-bead.sh [--check] [--no-pre-push] [REPO] (default: this kit checkout).
# --no-pre-push installs the forward-only pair (commit-msg + ref guard): new
# id-less commits are refused, existing history is not judged. A full install
# refuses (exit 5) when the unpublished range already holds id-less commits,
# because the pre-push member would then block every push of that repo.
# For each hook type the installer handles three states: absent (creates a
# chain runner), bespoke (moves the existing entry to hooks.d/<type>/10-<name>
# and creates a runner that calls it first, then ours), chain (adds our
# member). Moving a bespoke entry preserves it byte-for-byte; move it back to
# undo. A foreign REPO gets self-contained copies, never references into this
# checkout. Exits nonzero naming anything left inactive; every install ends
# with a live probe of the installed chain.
set -eu
UNDO_MOVES=""
UNDO_RM=""
UNDO_RESTORE=""
KITROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
MODE=install
PREPUSH=1
while [ $# -gt 0 ]; do
	case "$1" in
		--check) MODE=check; shift ;;
		--no-pre-push) PREPUSH=0; shift ;;
		*) break ;;
	esac
done
TARGET=${1:-$KITROOT}
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P) || { echo "install-commit-msg-bead: cannot enter ${1:-$KITROOT}" >&2; exit 2; }
HOOKS=$(git -C "$TARGET" rev-parse --git-path hooks) || { echo "install-commit-msg-bead: $TARGET is not a git repo" >&2; exit 2; }
case "$HOOKS" in
	/*) ;;
	*) HOOKS="$TARGET/$HOOKS" ;;
esac

# --check names installed members that differ from this checkout (a stale
# installed hook runs old rules after the source moves on). Exit 0 when every
# member matches, 3 naming each missing or stale member.
if [ "$MODE" = "check" ]; then
	stale=0
	for pair in "hooks.d/commit-msg/40-omp-kit-commit-msg-bead scripts/commit-msg-bead.sh" \
		"hooks.d/pre-push/check-pushed-beads.sh scripts/check-pushed-beads.sh" \
		"hooks.d/pre-push/commit-msg-bead.sh scripts/commit-msg-bead.sh" \
		"hooks.d/reference-transaction/40-omp-kit-ref-txn-bead scripts/ref-txn-bead.sh" \
		"hooks.d/reference-transaction/commit-msg-bead.sh scripts/commit-msg-bead.sh"; do
		# shellcheck disable=SC2086
		set -- $pair
		case "$1" in hooks.d/pre-push/*) [ "$PREPUSH" = 1 ] || continue ;; esac
		dest="$HOOKS/$1"
		src="$KITROOT/$2"
		if [ ! -f "$dest" ]; then
			printf 'install-commit-msg-bead: MISSING installed member: %s\n' "$dest" >&2
			stale=1
		elif ! cmp -s "$dest" "$src"; then
			printf 'install-commit-msg-bead: STALE installed member: %s differs from %s; rerun %s\n' "$dest" "$src" "$0" >&2
			stale=1
		fi
	done
	if [ "$stale" = 0 ]; then printf 'install-commit-msg-bead: hooks fresh in %s\n' "$TARGET"; exit 0; fi
	exit 3
fi

chain_dir() {
	printf '%s/hooks.d/%s' "$HOOKS" "$1"
}

# backup <path>: keep a pre-existing file so rollback restores it, never
# deletes it. The dot prefix keeps the copy out of the runner's NN-* glob.
backup() {
	cp -p "$1" "$(dirname -- "$1")/.undo.$$.$(basename -- "$1")"
	UNDO_RESTORE="$UNDO_RESTORE $1"
}

# place <src> <dest> <mode>: install a file, recording how to undo it.
place() {
	if [ -e "$2" ]; then backup "$2"; else UNDO_RM="$UNDO_RM $2"; fi
	cp "$1" "$2"
	chmod "$3" "$2"
}

# write_runner <path>: the chain runner. Hook types fed on stdin (pre-push,
# reference-transaction) replay one buffered copy to every member, so a
# member that reads stdin cannot starve the ones after it.
write_runner() {
	path=$1
	if [ -e "$path" ]; then backup "$path"; else UNDO_RM="$UNDO_RM $path"; fi
	cat > "$path" <<'EOF'
#!/bin/sh
# chain runner: run every executable NN-<name> member in hooks.d/<type> in
# sort order. Only numeric-prefixed entries run: helper libraries shipped
# beside members (no NN- prefix) are never executed arg-less. Stdin-fed hook
# types replay one buffered copy of the input to each member.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
kind=$(basename -- "$0")
input=""
case "$kind" in
	pre-push | reference-transaction | post-rewrite)
		input=$(mktemp "${TMPDIR:-/tmp}/hook-input.XXXXXX") || exit 1
		cat > "$input"
		;;
esac
rc=0
for hook in "$here/hooks.d/$kind"/[0-9][0-9]-*; do
	[ -e "$hook" ] || continue
	[ -x "$hook" ] || continue
	if [ -n "$input" ]; then sh "$hook" "$@" < "$input" || rc=$?; else sh "$hook" "$@" || rc=$?; fi
done
[ -z "$input" ] || rm -f "$input"
exit $rc
EOF
	chmod +x "$path"
}

# ensure_chain <type>: make $HOOKS/<type> a chain runner, preserving any
# bespoke entry by moving it to 10-<type>. Prints what it did.
ensure_chain() {
	type=$1
	entry="$HOOKS/$type"
	dir=$(chain_dir "$type")
	mkdir -p "$dir"
	if [ ! -e "$entry" ]; then
		write_runner "$entry"
		printf 'created chain runner: %s\n' "$entry"
		return 0
	fi
	if [ -x "$entry" ] && grep -q 'hooks\.d' "$entry" 2>/dev/null; then
		if grep -q 'chain runner: run every executable' "$entry" && ! grep -q 'replay one buffered copy' "$entry"; then
			write_runner "$entry"
			printf 'upgraded chain runner (stdin replay): %s\n' "$entry"
		else
			printf 'chain runner already present: %s\n' "$entry"
		fi
		return 0
	fi
	# Record every mutation for rollback (globals: appended across both hook
	# types, consumed only when a probe fails below).
	if [ -e "$dir/10-$type" ]; then
		printf 'install-commit-msg-bead: %s already staged in chain: %s/10-%s\n' "$type" "$dir" "$type" >&2
		return 0
	fi
	mv "$entry" "$dir/10-$type"
	UNDO_MOVES="$UNDO_MOVES $entry:$dir/10-$type"
	# Sibling impls resolve by dirname of the moved entry (fail-closed
	# wrappers); move "<type>-*" siblings alongside so they keep resolving.
	for sibling in "$HOOKS/$type"-*; do
		[ -e "$sibling" ] || continue
		UNDO_MOVES="$UNDO_MOVES $sibling:$dir/$(basename -- "$sibling")"
		mv -- "$sibling" "$dir/"
	done
	write_runner "$entry"
	printf 'moved bespoke %s to %s/10-%s and created chain runner\n' "$type" "$dir" "$type"
}

# rollback: undo every recorded mutation, then exit 1 with the reason.
# Only paths this installer created or moved are touched.
rollback() {
	printf 'install-commit-msg-bead: ROLLBACK: %s\n' "$1" >&2
	# shellcheck disable=SC2086
	for pair in $UNDO_RM; do rm -f "$pair"; done
	# shellcheck disable=SC2086
	for path in $UNDO_RESTORE; do mv -f -- "$(dirname -- "$path")/.undo.$$.$(basename -- "$path")" "$path" 2>/dev/null || true; done
	# shellcheck disable=SC2086
	for pair in $UNDO_MOVES; do
		src=${pair%%:*}; dst=${pair#*:}
		mv -- "$dst" "$src" 2>/dev/null || true
	done
	exit 1
}

# install_commit_msg: ours runs after any bespoke entry (sort order).
install_commit_msg() {
	dest=$(chain_dir commit-msg)/40-omp-kit-commit-msg-bead
	place "$KITROOT/scripts/commit-msg-bead.sh" "$dest" +x
	printf 'installed bead-id hook: %s\n' "$dest"
}

# install_pre_push: checker libs beside a member wrapper that speaks the
# pre-push hook protocol on stdin. Helper copies stay non-executable: the
# chain runner executes every executable member file, so an executable helper
# would run arg-less and fail pushes (2026-10-06 incident).
install_pre_push() {
	dir=$(chain_dir pre-push)
	member="$dir/40-omp-kit-pushed-beads"
	place "$KITROOT/scripts/check-pushed-beads.sh" "$dir/check-pushed-beads.sh" -x
	place "$KITROOT/scripts/commit-msg-bead.sh" "$dir/commit-msg-bead.sh" -x
	wrapper=$(mktemp "${TMPDIR:-/tmp}/pushed-beads-member.XXXXXX") || exit 2
	cat > "$wrapper" <<'EOF'
#!/bin/sh
# pre-push member: refuse pushed ranges with id-less commits.
set -u
exec sh "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/check-pushed-beads.sh" --pre-push
EOF
	place "$wrapper" "$member" +x
	rm -f "$wrapper"
	printf 'installed pushed-beads member: %s\n' "$member"
}

# install_ref_txn: the plumbing backstop. commit-tree + update-ref and
# --no-verify never run commit-msg; git runs reference-transaction for every
# ref update. The judge sits beside the member, non-executable (see above).
install_ref_txn() {
	dir=$(chain_dir reference-transaction)
	member="$dir/40-omp-kit-ref-txn-bead"
	place "$KITROOT/scripts/ref-txn-bead.sh" "$member" +x
	place "$KITROOT/scripts/commit-msg-bead.sh" "$dir/commit-msg-bead.sh" -x
	printf 'installed ref-update bead guard: %s\n' "$member"
}

PROBE=$(mktemp "${TMPDIR:-/tmp}/bead-probe.XXXXXX") || exit 2
PROBE_DB=$(mktemp "${TMPDIR:-/tmp}/bead-probe-db.XXXXXX") || exit 2
trap 'rm -f "$PROBE" "$PROBE_DB"' EXIT INT TERM
printf '[test] fix widgets probe baseline\n' > "$PROBE"

# Pre-flight: record how any bespoke entry treats a well-formed message
# BEFORE moving anything. An already-refusing bespoke is preserved as-is;
# one that passes must still pass after the move.
PREFLIGHT_RC=""
if [ -e "$HOOKS/commit-msg" ]; then
	if [ ! -x "$HOOKS/commit-msg" ] || ! grep -q 'hooks\.d' "$HOOKS/commit-msg" 2>/dev/null; then
		if sh "$HOOKS/commit-msg" "$PROBE" >/dev/null 2>&1; then PREFLIGHT_RC=0; else PREFLIGHT_RC=$?; fi
	fi
fi

# A pushed-range member installed over unpublished id-less commits would
# refuse every later push of this repo (2026-10-16: five held fourteen). Refuse
# before any mutation and name the remedies.
if [ "$PREPUSH" = 1 ] && git -C "$TARGET" rev-parse -q --verify HEAD > /dev/null; then
	if ! RANGE_OUT=$(CDPATH='' cd -- "$TARGET" && sh "$KITROOT/scripts/check-pushed-beads.sh" --repo "$TARGET" --base HEAD --tip HEAD 2>&1); then
		printf 'install-commit-msg-bead: REFUSED: %s already holds unpublished id-less commits (%s); a pre-push member would block every push. Name their bead ids first, or rerun with --no-pre-push for the forward-only guard.\n' \
			"$TARGET" "$(printf '%s' "$RANGE_OUT" | head -1)" >&2
		exit 5
	fi
fi

ensure_chain commit-msg
install_commit_msg
if [ "$PREPUSH" = 1 ]; then
	ensure_chain pre-push
	install_pre_push
fi
ensure_chain reference-transaction
install_ref_txn

# Verify the whole installed chain (any failure rolls every mutation back):
# Leg 1: the moved bespoke must behave exactly as pre-flight. A pass that
# turns refusal means the move broke it (sibling impl left behind).
if [ -n "$PREFLIGHT_RC" ]; then
	if sh "$HOOKS/hooks.d/commit-msg/10-commit-msg" "$PROBE" >/dev/null 2>&1; then POST_RC=0; else POST_RC=$?; fi
	if [ "$POST_RC" != "$PREFLIGHT_RC" ]; then
		rollback "bespoke behaved rc=$PREFLIGHT_RC before the move but rc=$POST_RC after (sibling impl left behind?)"
	fi
fi
# Leg 2: a well-formed message naming an unresolvable bead id must be refused
# BY OUR member (exit 4 naming commit-msg-bead). BEADS_DB points at an empty
# file so no tracker resolves, in any repo, without touching real state.
printf '[test] fix widgets ompkit-zzzz-1\n' > "$PROBE"
if PROBE_OUT=$(BEADS_DB="$PROBE_DB" sh "$HOOKS/commit-msg" "$PROBE" 2>&1); then
	rollback "chain accepted an id-less message in $TARGET"
fi
case "$PROBE_OUT" in
	*commit-msg-bead*) ;;
	*) rollback "refusal did not come from the bead-id member: $(printf '%s' "$PROBE_OUT" | head -1)" ;;
esac
# Leg 3: the pre-push member must pass the current range (valid pushes flow).
# Leg 4: the ref guard must refuse moving main to a planted id-less commit
# and must pass the same update of any other ref. The guard member is fed the
# update line directly, so no bespoke hook in the chain sees a synthetic
# update; nothing is moved and the probe commit is a dangling object.
if HEAD_SHA=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null); then
	if [ "$PREPUSH" = 1 ] && ! printf 'refs/heads/main %s refs/heads/main %s\n' "$HEAD_SHA" "$HEAD_SHA" | (CDPATH='' cd -- "$TARGET" && sh "$HOOKS/hooks.d/pre-push/40-omp-kit-pushed-beads") >/dev/null 2>&1; then
		rollback "pre-push member rejects the current range in $TARGET"
	fi
	GUARD="$HOOKS/hooks.d/reference-transaction/40-omp-kit-ref-txn-bead"
	PLANT=$(printf 'probe: id-less ref-guard plant\n' | GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@invalid \
		git -C "$TARGET" commit-tree "$HEAD_SHA^{tree}" -p "$HEAD_SHA") || rollback "cannot write the ref-guard probe commit in $TARGET"
	if REF_OUT=$(printf '%s %s refs/heads/main\n' "$HEAD_SHA" "$PLANT" | (CDPATH='' cd -- "$TARGET" && BEADS_DB="$PROBE_DB" sh "$GUARD" prepared) 2>&1); then
		rollback "ref guard let main move to an id-less commit in $TARGET"
	fi
	case "$REF_OUT" in
		*ref-txn-bead*) ;;
		*) rollback "ref refusal did not come from the bead guard: $(printf '%s' "$REF_OUT" | head -1)" ;;
	esac
	if ! printf '%s %s refs/heads/probe-other\n' "$HEAD_SHA" "$PLANT" | (CDPATH='' cd -- "$TARGET" && BEADS_DB="$PROBE_DB" sh "$GUARD" prepared) >/dev/null 2>&1; then
		rollback "ref guard refused an update of a ref other than main in $TARGET"
	fi
else
	printf 'install-commit-msg-bead: WARN: %s has no HEAD commit; pre-push and ref-guard probes skipped\n' "$TARGET" >&2
fi
# shellcheck disable=SC2086
for path in $UNDO_RESTORE; do rm -f -- "$(dirname -- "$path")/.undo.$$.$(basename -- "$path")"; done
printf 'verified active in %s\n' "$TARGET"
