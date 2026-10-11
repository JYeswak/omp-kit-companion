#!/bin/sh
# release-train.sh — RELTRAIN1 (ompkit-v66l) train decision logic.
#
# Pure, testable helpers around the release train. Every verdict comes from
# the exit code plus one machine-readable line on stdout; refusals exit 4
# (fail closed, same convention as check-commit-imports.sh).
#
#   decide --conclusion C --run-status S --sha SHA --head HEAD
#     Green CI on main's head may tag. Anything else skips with a reason:
#     red CI is never tagged, a still-running CI is never tagged, and a
#     superseded SHA (HEAD moved on) is left to the newer train (latest wins).
#   next-version
#     Reads `vX.Y.Z` tags on stdin (one per line, e.g. from
#     `git ls-remote --tags origin`), prints the next patch `X.Y.(Z+1)`.
#     Non-`vX.Y.Z` tags (e.g. legacy `omp-kit v0.2.3`) are ignored; no
#     parseable tag is a refusal, never a guess.
#   verify-candidate --proof PROOF --index INDEX --version V --sha SHA
#     Publish gate: the unpublished candidate index for exactly this version
#     and source SHA must carry the full certified ship set, and the asset
#     map must match it. Mirrors release.yml attest-platforms; fails closed.
#   latest-flag --version V --max-version M
#     Prints `--latest` when V is still the maximum tag (it takes the Latest
#     pointer) and `--latest=false` when a newer tag already exists, so a
#     stale train finishing late cannot steal Latest from a newer release.
#   wait-release-idle --repo R [--workflow release.yml] [--timeout SEC]
#     Blocks until no in_progress/queued release.yml run remains, so two
#     trains never dispatch overlapping releases. GH_BIN overrides the gh
#     binary (test seam).
#   bump --version V --date YYYY-MM-DD [--repo DIR]
#     The upstream oh-my-pi release commit (scripts/release.ts): fold
#     changelog.d/ into CHANGELOG.md [Unreleased], promote it to
#     `## [V] - DATE`, set both package.json versions, and commit
#     `chore: bump version to V` on the checked-out SHA. Nothing to release
#     (no Unreleased entries, no fragments) is a refusal: no commit, no tag,
#     never an empty release body.
#   evidence-sha --sha SHA [--repo DIR]
#     The SHA whose green CI a release at SHA may reuse: SHA itself, or the
#     parent of a release bump commit whose only changes are the CHANGELOG
#     promotion, removed changelog.d fragments and the two package.json
#     version fields (anything more gets no inherited evidence).
set -u

usage() { echo "usage: release-train.sh decide|next-version|verify-candidate|latest-flag|wait-release-idle|bump|evidence-sha ..." >&2; exit 2; }

cmd=${1:-}; [ -n "$cmd" ] || usage; shift

case "$cmd" in
decide)
	conclusion=""; status=""; sha=""; head=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--conclusion) conclusion=${2:-}; shift 2 ;;
			--run-status) status=${2:-}; shift 2 ;;
			--sha) sha=${2:-}; shift 2 ;;
			--head) head=${2:-}; shift 2 ;;
			*) echo "decide: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$conclusion" ] && [ -n "$status" ] && [ -n "$sha" ] && [ -n "$head" ]; }; then echo "decide: --conclusion, --run-status, --sha and --head are required" >&2; exit 2; fi
	case "$sha" in *[!0-9a-f]*|"" ) echo "decide: --sha must be a hex commit" >&2; exit 2 ;; esac
	case "$head" in *[!0-9a-f]*|"" ) echo "decide: --head must be a hex commit" >&2; exit 2 ;; esac
	if [ "$conclusion" != "success" ]; then
		printf 'DECIDE=skip REASON=red-ci-never-tagged conclusion=%s\n' "$conclusion"; exit 4
	fi
	if [ "$status" != "completed" ]; then
		printf 'DECIDE=skip REASON=running-ci-never-tagged status=%s\n' "$status"; exit 4
	fi
	if [ "$sha" != "$head" ]; then
		printf 'DECIDE=skip REASON=superseded-by-newer-green sha=%s head=%s\n' "$sha" "$head"; exit 4
	fi
	printf 'DECIDE=tag REASON=green-head sha=%s\n' "$sha"; exit 0
	;;
next-version)
	max_major=""; max_minor=""; max_patch=""
	while IFS= read -r line; do
		tag=$line
		case "$tag" in
		*refs/tags/v*[!0-9.]*) tag=${tag##*refs/tags/}; tag=${tag%%^*} ;;
			*refs/tags/*) tag=${tag##*refs/tags/}; tag=${tag%%^*} ;;
		esac
		case "$tag" in
			v*) rest=${tag#v} ;;
			*) continue ;;
		esac
		case "$rest" in
			*[!0-9.]* ) continue ;;
			*.*.*.* ) continue ;;
		esac
		major=${rest%%.*}; rem=${rest#*.}
		minor=${rem%%.*}; patch=${rem#*.}
		case "$major$minor$patch" in *[!0-9]*|"") continue ;; esac
		case "$major" in 0) ;; *) case "$major" in 0* ) continue ;; esac ;; esac
		case "$minor" in 0) ;; *) case "$minor" in 0* ) continue ;; esac ;; esac
		case "$patch" in 0) ;; *) case "$patch" in 0* ) continue ;; esac ;; esac
		if [ -z "$max_major" ] \
			|| [ "$major" -gt "$max_major" ] \
			|| { [ "$major" -eq "$max_major" ] && [ "$minor" -gt "$max_minor" ]; } \
			|| { [ "$major" -eq "$max_major" ] && [ "$minor" -eq "$max_minor" ] && [ "$patch" -gt "$max_patch" ]; }; then
			max_major=$major; max_minor=$minor; max_patch=$patch
		fi
	done
	[ -n "$max_major" ] || { echo "next-version: no parseable vX.Y.Z tag on stdin" >&2; exit 4; }
	printf '%s.%s.%s\n' "$max_major" "$max_minor" "$((max_patch + 1))"; exit 0
	;;
verify-candidate)
	proof=""; index=""; version=""; sha=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--proof) proof=${2:-}; shift 2 ;;
			--index) index=${2:-}; shift 2 ;;
			--version) version=${2:-}; shift 2 ;;
			--sha) sha=${2:-}; shift 2 ;;
			*) echo "verify-candidate: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$proof" ] && [ -n "$index" ] && [ -n "$version" ] && [ -n "$sha" ]; }; then echo "verify-candidate: --proof, --index, --version and --sha are required" >&2; exit 2; fi
	command -v jq >/dev/null 2>&1 || { echo "verify-candidate: jq is required" >&2; exit 3; }
	if ! { [ -f "$proof" ] && [ -f "$index" ]; }; then echo "verify-candidate: proof or index file is missing" >&2; exit 4; fi
	probe=$(jq -e --arg v "$version" --arg sha "$sha" '
		(.source_sha == $sha) and (.version == $v)
		and ((.certified_platforms | sort) == ["darwin-arm64-none","linux-arm64-gnu","linux-x64-gnu"])
	' "$proof" 2>/dev/null) || probe=""
	if ! [ "$probe" = "true" ]; then echo "verify-candidate: proof binds a different sha, version, or ship set" >&2; exit 4; fi
	check=$(jq -e --arg v "$version" --arg tag "v$version" '
		(.source_tag == $tag) and ((.assets | keys | sort) == ["darwin-arm64-none","linux-arm64-gnu","linux-x64-gnu"])
	' "$index" 2>/dev/null) || check=""
	if ! [ "$check" = "true" ]; then echo "verify-candidate: index tag or asset map does not match the ship set" >&2; exit 4; fi
	printf 'CANDIDATE=verified version=%s sha=%s\n' "$version" "$sha"; exit 0
	;;
latest-flag)
	version=""; max=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--version) version=${2:-}; shift 2 ;;
			--max-version) max=${2:-}; shift 2 ;;
			*) echo "latest-flag: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$version" ] && [ -n "$max" ]; }; then echo "latest-flag: --version and --max-version are required" >&2; exit 2; fi
	if [ "$version" = "$max" ]; then printf '%s\n' "--latest"; else printf '%s\n' "--latest=false"; fi
	exit 0
	;;
wait-release-idle)
	repo=""; workflow="release.yml"; timeout="600"; poll="15"
	while [ $# -gt 0 ]; do
		case "$1" in
			--repo) repo=${2:-}; shift 2 ;;
			--workflow) workflow=${2:-}; shift 2 ;;
			--timeout) timeout=${2:-}; shift 2 ;;
			--poll) poll=${2:-}; shift 2 ;;
			*) echo "wait-release-idle: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	[ -n "$repo" ] || { echo "wait-release-idle: --repo is required" >&2; exit 2; }
	GH_BIN=${GH_BIN:-gh}
	deadline=$(($(date +%s) + timeout))
	while :; do
		busy=$("$GH_BIN" run list --repo "$repo" --workflow "$workflow" --status in_progress --status queued --json databaseId --jq 'length' 2>/dev/null) \
			|| { echo "wait-release-idle: gh run list failed" >&2; exit 1; }
		case "$busy" in ''|*[!0-9]* ) echo "wait-release-idle: unparseable gh output" >&2; exit 1 ;; esac
		if [ "$busy" -eq 0 ]; then printf 'RELEASE=idle\n'; exit 0; fi
		[ "$(date +%s)" -ge "$deadline" ] && { echo "wait-release-idle: timed out with $busy release run(s) still active" >&2; exit 4; }
		sleep "$poll"
	done
	;;
bump)
	version=""; date=""; repo="."
	while [ $# -gt 0 ]; do
		case "$1" in
			--version) version=${2:-}; shift 2 ;;
			--date) date=${2:-}; shift 2 ;;
			--repo) repo=${2:-}; shift 2 ;;
			*) echo "bump: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$version" ] && [ -n "$date" ]; }; then echo "bump: --version and --date are required" >&2; exit 2; fi
	SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
	if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then echo "bump: tracked files are modified" >&2; exit 1; fi
	promoted=$(cd "$repo" && sh "$SCRIPT_DIR/release-notes.sh" promote --version "$version" --date "$date" --write 2>&1)
	rc=$?
	printf '%s\n' "$promoted"
	if [ "$rc" -eq 4 ]; then printf 'BUMP=skip REASON=nothing-to-release version=%s\n' "$version"; exit 4; fi
	[ "$rc" -eq 0 ] || { echo "bump: promote failed (rc=$rc)" >&2; exit 1; }
	# The tree was clean, and promote only rewrites/removes tracked files, so -u stages exactly its result.
	git -C "$repo" add -u -- .
	git -C "$repo" commit -q -m "chore: bump version to $version" \
		-m "Release train: changelog.d/ folded into CHANGELOG.md, [Unreleased] promoted to $version, package.json version set." \
		-m "[no-changelog] release bump commit; its notes are the promoted CHANGELOG section" || { echo "bump: commit failed" >&2; exit 1; }
	printf 'BUMP=committed version=%s sha=%s\n' "$version" "$(git -C "$repo" rev-parse HEAD)"; exit 0
	;;
evidence-sha)
	sha=""; repo="."
	while [ $# -gt 0 ]; do
		case "$1" in
			--sha) sha=${2:-}; shift 2 ;;
			--repo) repo=${2:-}; shift 2 ;;
			*) echo "evidence-sha: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	case "$sha" in *[!0-9a-f]*|"" ) echo "evidence-sha: --sha must be a hex commit" >&2; exit 2 ;; esac
	command -v jq >/dev/null 2>&1 || { echo "evidence-sha: jq is required" >&2; exit 3; }
	subject=$(git -C "$repo" log -1 --format=%s "$sha" 2>/dev/null) || { echo "evidence-sha: unknown commit $sha" >&2; exit 2; }
	version=${subject#chore: bump version to }
	if [ "$version" = "$subject" ]; then printf 'EVIDENCE_SHA=%s REASON=exact\n' "$sha"; exit 0; fi
	shape=ok
	case "$version" in *[!0-9.]*|""|.*|*.|*..*) shape=bad ;; esac
	parents=$(git -C "$repo" rev-list --parents -n 1 "$sha" | wc -w | tr -d '[:space:]')
	[ "$parents" -eq 2 ] || shape=bad
	if [ "$shape" = ok ]; then
		parent=$(git -C "$repo" rev-parse "$sha^")
		changes=$(git -C "$repo" diff-tree --no-commit-id --no-renames --name-status -r "$sha")
		bad_paths=$(printf '%s\n' "$changes" | grep -Ev '^(M	CHANGELOG\.md|M	package\.json|D	changelog\.d/[a-z0-9.-]+\.md)$' || true)
		[ -z "$bad_paths" ] || shape=bad
		now=$(git -C "$repo" show "$sha:package.json" | jq -S 'del(.version, .omp.version)' 2>/dev/null) || shape=bad
		before=$(git -C "$repo" show "$parent:package.json" | jq -S 'del(.version, .omp.version)' 2>/dev/null) || shape=bad
		[ "$now" = "$before" ] || shape=bad
		git -C "$repo" show "$sha:package.json" | jq -e --arg v "$version" '.version == $v and .omp.version == $v' >/dev/null 2>&1 || shape=bad
	fi
	if [ "$shape" = ok ]; then printf 'EVIDENCE_SHA=%s REASON=release-bump-parent bump=%s\n' "$parent" "$sha"; exit 0; fi
	printf 'EVIDENCE_SHA=%s REASON=bump-shape-mismatch\n' "$sha"; exit 0
	;;
*) usage ;;
esac
