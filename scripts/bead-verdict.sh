#!/bin/sh
# bead-verdict.sh — HOOKDEDUP1 (ompkit-1ra0d.60) commit-time verdict records.
# The commit-msg member records its PASS verdict so the pre-push and
# reference-transaction members can reuse it instead of re-running `br` per
# commit. Records live under <git-common-dir>/omp-kit/bead-verdicts/:
#   pending-<msghash>  written by the commit-msg member on PASS, keyed by the
#                      normalized message hash (the commit sha does not exist yet)
#   <commit-sha>       written by the post-commit recorder, keyed by the exact
#                      commit sha, copied from the matching pending record
# A record line is `PASS <bead-id> <msghash>`. Readers verify the hash against
# the commit's own message, so a record never admits a different message; a
# bead deleted after commit time still admits until the record is gone (same
# staleness as any commit-time evidence: the writer saw `br` pass).
# Every function is best-effort: record I/O never changes a verdict. A missing
# or unreadable record falls back to today's live `br` check. Test seam:
# BEAD_VERDICT_DIR overrides the record directory.
# shellcheck disable=SC3043  # `local` is universal in the fleet's sh

# bead_verdict_dir [REPO]: print the record directory.
bead_verdict_dir() {
	if [ -n "${BEAD_VERDICT_DIR:-}" ]; then printf '%s\n' "$BEAD_VERDICT_DIR"; return 0; fi
	_repo=${1:-}
	_common=""
	if [ -n "$_repo" ]; then
		_common=$(git -C "$_repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
	else
		_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
	fi
	[ -n "$_common" ] || return 1
	printf '%s/omp-kit/bead-verdicts\n' "$_common"
}

# bead_msghash: sha256 of the normalized message on stdin. `#` lines are dropped (an
# editor-flow COMMIT_EDITMSG carries them; the stored body does not) and command
# substitution strips trailing newlines, so both ends hash identically.
bead_msghash() {
	_msg=$(grep -v '^#') || [ "$?" = 1 ] || return 1
	if command -v sha256sum >/dev/null 2>&1; then
		printf '%s' "$_msg" | sha256sum | cut -d' ' -f1
	else
		printf '%s' "$_msg" | shasum -a 256 | cut -d' ' -f1
	fi
}

# bead_verdict_store DIR KEY LINE: best-effort record write.
bead_verdict_store() {
	_dir=$1 _key=$2 _line=$3
	[ -n "$_dir" ] && [ -n "$_key" ] && [ -n "$_line" ] || return 1
	case "$_key" in *[!A-Za-z0-9_.-]*) return 1 ;; esac
	mkdir -p "$_dir" 2>/dev/null || return 1
	printf '%s\n' "$_line" > "$_dir/$_key" 2>/dev/null || return 1
}

# bead_verdict_lookup REPO SHA: exit 0 iff a commit-time PASS record admits SHA.
# Only a record keyed by the exact sha counts: a message-keyed pending record would
# admit a commit-tree or --no-verify commit that reuses an earlier message.
bead_verdict_lookup() {
	_repo=$1 _sha=$2
	[ -n "$_repo" ] && [ -n "$_sha" ] || return 1
	_dir=$(bead_verdict_dir "$_repo") || return 1
	_rec="$_dir/$_sha"
	[ -f "$_rec" ] || return 1
	_line=$(cat -- "$_rec" 2>/dev/null) || return 1
	# shellcheck disable=SC2086
	set -- $_line
	[ "$#" = "3" ] && [ "$1" = "PASS" ] || return 1
	_got=$(git -C "$_repo" log --format=%B -n 1 "$_sha" 2>/dev/null | bead_msghash) || return 1
	[ "$_got" = "$3" ] || return 1
	return 0
}

# bead_verdict_note REPO SHA: best-effort cache of a live PASS for later pushes.
bead_verdict_note() {
	_repo=$1 _sha=$2
	[ -n "$_repo" ] && [ -n "$_sha" ] || return 1
	_dir=$(bead_verdict_dir "$_repo") || return 1
	_nmsg=$(git -C "$_repo" log --format=%B -n 1 "$_sha" 2>/dev/null) || return 1
	_nh=$(printf '%s' "$_nmsg" | bead_msghash) || return 1
	bead_verdict_store "$_dir" "$_sha" "PASS push $_nh"
}
