#!/bin/sh
# check-staged-embed.sh — pre-commit member (EMBEDDEP1, ompkit-fp72.120.16.197).
#
# installer/install.py embeds the exact bytes of scripts/pysafe.py and
# scripts/kitlib_run.py. 2b7a914010 changed pysafe.py without regenerating the
# installer; every release preflight then refused the stale payload
# (INSTALLER_BOOTSTRAP_STALE_OR_UNAVAILABLE) until c52e0a58f9 regenerated it.
# This member makes the author pay at commit time: when the staged paths touch
# the producer installer/embed-bootstrap.py or any output or input its EMBEDS
# map declares, it copies the producer and every declared path from the INDEX
# (never the worktree) into an owned dir and runs the staged producer's own
# --check there. A stale output is refused, naming the regenerate command.
# A repo with no producer in its index or in HEAD has no embed obligation. A
# staged producer that declares no `EMBEDS = {` map, or an index that drops the
# producer HEAD has, is refused: either would disable this check silently.
# The producer runs under pysafe.py (beside this file, as for the staged-pysafe
# member) with a STAGED_EMBED_TIMEOUT deadline (whole seconds, default 10).
# Exit 0 pass (or nothing declared is staged), 1 refuse.
set -u
producer=installer/embed-bootstrap.py
budget=${STAGED_EMBED_TIMEOUT:-10}
case "$budget" in
	'' | *[!0-9]* | 0) printf 'staged-embed: REFUSED: STAGED_EMBED_TIMEOUT must be a positive whole number of seconds\n' >&2; exit 1 ;;
esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
git rev-parse --show-toplevel >/dev/null || { printf 'staged-embed: not inside a work tree\n' >&2; exit 1; }
if ! git cat-file -e ":$producer" 2>/dev/null; then
	git cat-file -e "HEAD:$producer" 2>/dev/null || exit 0
	printf 'staged-embed: REFUSED: the commit removes %s, which declares the generated embeds; restore it (removing it needs the 56-omp-kit-staged-embed member retired first)\n' "$producer" >&2
	exit 1
fi
if ! git show ":$producer" | grep -q '^EMBEDS = {$'; then
	printf 'staged-embed: REFUSED: the staged %s declares no EMBEDS map (no "%s" line), so its generated files cannot be judged\n' "$producer" 'EMBEDS = {' >&2
	exit 1
fi
# GIT_INDEX_FILE is respected, so `git commit --only` temporary indexes are judged.
staged=$(git diff --cached --name-only) || { printf 'staged-embed: cannot read the staged paths\n' >&2; exit 1; }
[ -n "$staged" ] || exit 0
py=$(command -v python3) || { printf 'staged-embed: REFUSED: %s is staged and python3 is absent\n' "$producer" >&2; exit 1; }
for helper in pysafe.py kitlib-tmp.sh; do
	[ -f "$here/$helper" ] || { printf 'staged-embed: REFUSED: %s is missing beside %s; rerun scripts/install-commit-msg-bead.sh\n' "$helper" "$0" >&2; exit 1; }
done
# shellcheck source=scripts/kitlib-tmp.sh
. "$here/kitlib-tmp.sh"
tmp='' # assigned by kitlib_tmp via eval
kitlib_tmp tmp staged-embed || { printf 'staged-embed: cannot create the owned staging dir\n' >&2; exit 1; }
stage() {
	case "/$1/" in
		//* | */../* | */./*) printf 'staged-embed: REFUSED: %s declares a path outside the repo: %s\n' "$producer" "$1" >&2; return 1 ;;
	esac
	mkdir -p "$tmp/$(dirname -- "$1")" && git show ":$1" >"$tmp/$1"
}
stage "$producer" || { printf 'staged-embed: cannot read the staged %s\n' "$producer" >&2; exit 1; }
run_producer() {
	"$py" -B "$here/pysafe.py" run --timeout "$budget" -- "$py" -I "$tmp/$producer" "$@" </dev/null
}
declared=$(run_producer --list) || { printf 'staged-embed: REFUSED: the staged %s cannot list its EMBEDS\n' "$producer" >&2; exit 1; }
triggered=0
while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "
$producer
$declared
" in
		*"
$path
"*) triggered=1; break ;;
	esac
done <<EOF
$staged
EOF
[ "$triggered" = 1 ] || exit 0
while IFS= read -r path; do
	[ -n "$path" ] || continue
	stage "$path" || { printf 'staged-embed: REFUSED: %s is declared by %s but absent from the staged tree\n' "$path" "$producer" >&2; exit 1; }
done <<EOF
$declared
EOF
if out=$(run_producer --check 2>&1); then
	exit 0
fi
printf 'staged-embed: REFUSED: the staged generated files do not match their staged inputs (worktree ignored)\n%s\nRegenerate with python3 -I %s, then git add the outputs it rewrites.\n' "$out" "$producer" >&2
exit 1
