#!/bin/sh
# check-commit-notes.sh MSGFILE — commit-msg member (SHIFTLEFT1, ompkit-1wgy).
# The release train and the push notes gate refuse a direct commit that touches
# shipped paths unless it carries one `[no-changelog] <reason>` line or one
# `Bead: <id>` trailer whose changelog.d/<slug>.md or changelog.d/<id>.md
# fragment was added or modified since the last release tag. This member asks
# the same code (release-notes.ts `fragment-for --message`, KITLIB-FRAG
# ompkit-m21ru) about the staged tree, so the two gates cannot disagree: a
# fragment that merely exists because it shipped in the last release covers
# nothing. GIT_INDEX_FILE is respected, so `--only` is judged as committed. A
# fragment naming the commit hash cannot exist yet; that form stays a
# push-time remedy.
#
# The installer copies release-notes.ts and limit-process-tree.sh beside this
# member; in the kit checkout they are its siblings in scripts/. The resolver
# runs in its own session under a fixed deadline; on expiry the whole group is
# terminated and reaped, and the commit is refused (fail closed).
set -u
msg=${1:?usage: check-commit-notes.sh MSGFILE}
DEADLINE_SECONDS=60
# Only a repo that keeps changelog fragments runs the notes gates; elsewhere (jev,
# localbench, uds, zestroku, cfsios have no changelog.d) this member must never refuse.
git cat-file -e HEAD:changelog.d 2>/dev/null || exit 0

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
refuse() {
	printf 'commit-notes: REFUSED: %s; the push gate will refuse it\n' "$1" >&2
	exit 1
}
for helper in release-notes.ts limit-process-tree.sh; do
	[ -f "$here/$helper" ] || refuse "installed resolver $helper missing beside $(basename -- "$0"); rerun scripts/install-commit-msg-bead.sh"
done
command -v bun >/dev/null 2>&1 || refuse "bun is unavailable, so release-notes.ts cannot judge this commit"

# The verdict JSON (stdout) is not needed here; the refusal reason is on stderr,
# which the resolver bounds to one short message.
if out=$(sh "$here/limit-process-tree.sh" "$DEADLINE_SECONDS" \
	bun run --no-env-file --config=/dev/null "$here/release-notes.ts" fragment-for --message "$msg" \
	</dev/null 2>&1 >/dev/null); then
	exit 0
fi
refuse "$(printf '%s\n' "$out" | sed -e 's/^release-notes: REFUSED: //' -e 's/^release-notes: //')"
