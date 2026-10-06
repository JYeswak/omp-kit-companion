#!/bin/sh
# Install the bead-id commit-msg hook and the pushed-beads pre-push member
# into a repo's hook chains.
# Usage: install-commit-msg-bead.sh [REPO] (default: this kit checkout).
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
KITROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TARGET=${1:-$KITROOT}
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P) || { echo "install-commit-msg-bead: cannot enter ${1:-$KITROOT}" >&2; exit 2; }
HOOKS=$(git -C "$TARGET" rev-parse --git-path hooks) || { echo "install-commit-msg-bead: $TARGET is not a git repo" >&2; exit 2; }
case "$HOOKS" in
	/*) ;;
	*) HOOKS="$TARGET/$HOOKS" ;;
esac

chain_dir() {
	printf '%s/hooks.d/%s' "$HOOKS" "$1"
}

write_runner() {
	path=$1
	cat > "$path" <<'EOF'
#!/bin/sh
# chain runner: run every executable NN-<name> member in hooks.d/<type> in
# sort order. Only numeric-prefixed entries run: helper libraries shipped
# beside members (no NN- prefix) are never executed arg-less.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
kind=$(basename -- "$0")
rc=0
for hook in "$here/hooks.d/$kind"/[0-9][0-9]-*; do
	[ -e "$hook" ] || continue
	[ -x "$hook" ] || continue
	sh "$hook" "$@" || rc=$?
done
exit $rc
EOF
	chmod +x "$path"
	UNDO_RM="$UNDO_RM $path"
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
		printf 'chain runner already present: %s\n' "$entry"
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
	UNDO_RM="$UNDO_RM $entry"
	printf 'moved bespoke %s to %s/10-%s and created chain runner\n' "$type" "$dir" "$type"
}

# rollback: undo every recorded mutation, then exit 1 with the reason.
# Only paths this installer created or moved are touched.
rollback() {
	printf 'install-commit-msg-bead: ROLLBACK: %s\n' "$1" >&2
	# shellcheck disable=SC2086
	for pair in $UNDO_RM; do rm -f "$pair"; done
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
	cp "$KITROOT/scripts/commit-msg-bead.sh" "$dest"
	chmod +x "$dest"
	UNDO_RM="$UNDO_RM $dest"
	printf 'installed bead-id hook: %s\n' "$dest"
}

# install_pre_push: checker libs beside a member wrapper that speaks the
# pre-push hook protocol on stdin. Helper copies stay non-executable: the
# chain runner executes every executable member file, so an executable helper
# would run arg-less and fail pushes (2026-10-06 incident).
install_pre_push() {
	dir=$(chain_dir pre-push)
	member="$dir/40-omp-kit-pushed-beads"
	cp "$KITROOT/scripts/check-pushed-beads.sh" "$dir/check-pushed-beads.sh"
	cp "$KITROOT/scripts/commit-msg-bead.sh" "$dir/commit-msg-bead.sh"
	chmod -x "$dir/check-pushed-beads.sh" "$dir/commit-msg-bead.sh" 2>/dev/null || true
	cat > "$member" <<'EOF'
#!/bin/sh
# pre-push member: refuse pushed ranges with id-less commits.
set -u
exec sh "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/check-pushed-beads.sh" --pre-push
EOF
	chmod +x "$member"
	UNDO_RM="$UNDO_RM $member $dir/check-pushed-beads.sh $dir/commit-msg-bead.sh"
	printf 'installed pushed-beads member: %s\n' "$member"
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

ensure_chain commit-msg
install_commit_msg
ensure_chain pre-push
install_pre_push

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
# Leg 3: the pre-push member must pass an empty range (valid pushes flow).
if HEAD_SHA=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null); then
	if ! printf 'refs/heads/main %s refs/heads/main %s\n' "$HEAD_SHA" "$HEAD_SHA" | (CDPATH='' cd -- "$TARGET" && sh "$HOOKS/hooks.d/pre-push/40-omp-kit-pushed-beads") >/dev/null 2>&1; then
		rollback "pre-push member rejects an empty range in $TARGET"
	fi
else
	printf 'install-commit-msg-bead: WARN: %s has no HEAD commit; pre-push probe skipped\n' "$TARGET" >&2
fi
printf 'verified active in %s\n' "$TARGET"
