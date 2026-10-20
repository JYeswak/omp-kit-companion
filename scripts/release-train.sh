#!/bin/sh
# release-train.sh — RELTRAIN1 (ompkit-v66l) train decision logic.
#
# Pure, testable helpers around the release train. Commands report through
# exit codes and stdout; next-version logs its selection basis on stderr.
# Refusals exit 4 (fail closed, same convention as check-commit-imports.sh).
#
#   decide --conclusion C --run-status S --sha SHA --qualified-sha QUALIFIED
#     Eligibility only: QUALIFIED is the ancestry-selected successful CI
#     frontier from release_reuse.py, NOT main head. This never authorizes a
#     tag; final exact-artifact certification and signing still gate promotion.
#   next-version [--changelog-ref SHA]
#     Reads tags on stdin and advances past both the newest tag and the
#     CHANGELOG.md section floor. A ref reads immutable admission-main metadata
#     rather than the controller checkout; --tags-only disables the section floor.
#   verify-candidate --proof PROOF --index INDEX --version V --sha SHA
#     Publish gate: the unpublished candidate index for exactly this version
#     and source SHA must carry the full certified ship set, and the asset
#     map must match it. Mirrors release.yml attest-platforms; fails closed.
#   publish-lag --version V --sha SHA --repo R [--gh-repo SLUG]
#     Q-001 pilot (ompkit-kdbz.2.9): exits 4 when tag vV names exactly SHA but
#     no GitHub release exists (certified tag stuck unpublished); tag mismatch
#     also exits 4, no tag exits 0. GH_BIN overrides the gh binary (test seam).
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
#     `## [V] - DATE`, set both package.json versions, stamp the generated
#     README release line to `Current release: vV` (scripts/stamp-release-line.sh),
#     and commit `chore: bump version to V` on the checked-out SHA. Nothing to
#     release (no Unreleased entries, no fragments) is a refusal: no commit, no
#     tag, never an empty release body.
#   evidence-sha --sha SHA [--repo DIR]
#     The SHA whose green CI a release at SHA may reuse: SHA itself, or the
#     parent of a release bump commit whose only changes are the CHANGELOG
#     promotion, removed changelog.d fragments, the two package.json version
#     fields, and the generated README release line restamped to the bump
#     version (anything more gets no inherited evidence).
#   version-match --version V --sha SHA [--repo DIR]
#     Tag gate (ompkit-fp72.135.1.14): package.json at SHA must state V in
#     both .version and .omp.version. Match prints VERSION_MATCH and exits 0;
#     mismatch refuses with exit 4, never a tag. Unparseable or missing
#     package.json fails closed (exit 4); bad usage exits 2, missing jq exits 3.

usage() { echo "usage: release-train.sh decide|next-version|verify-candidate|publish-lag|latest-flag|wait-release-idle|bump|evidence-sha|version-match ..." >&2; exit 2; }

cmd=${1:-}; [ -n "$cmd" ] || usage; shift

case "$cmd" in
decide)
	conclusion=""; status=""; sha=""; head=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--conclusion) conclusion=${2:-}; shift 2 ;;
			--run-status) status=${2:-}; shift 2 ;;
			--sha) sha=${2:-}; shift 2 ;;
			--qualified-sha) head=${2:-}; shift 2 ;;
			*) echo "decide: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$conclusion" ] && [ -n "$status" ] && [ -n "$sha" ] && [ -n "$head" ]; }; then echo "decide: --conclusion, --run-status, --sha and --qualified-sha are required" >&2; exit 2; fi
	case "$sha" in *[!0-9a-f]*|"" ) echo "decide: --sha must be a hex commit" >&2; exit 2 ;; esac
	case "$head" in *[!0-9a-f]*|"" ) echo "decide: --qualified-sha must be a hex commit" >&2; exit 2 ;; esac
	if [ "$conclusion" != "success" ]; then
		printf 'DECIDE=skip REASON=red-ci-never-tagged conclusion=%s\n' "$conclusion"; exit 4
	fi
	if [ "$status" != "completed" ]; then
		printf 'DECIDE=skip REASON=running-ci-never-tagged status=%s\n' "$status"; exit 4
	fi
	if [ "$sha" != "$head" ]; then
		printf 'DECIDE=skip REASON=superseded-by-newer-green sha=%s qualified=%s\n' "$sha" "$head"; exit 4
	fi
	printf 'DECIDE=qualify REASON=newest-qualified-source sha=%s\n' "$sha"; exit 0
	;;
next-version)
	use_changelog=1; changelog_ref=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--tags-only) use_changelog=0; shift ;;
			--changelog-ref) changelog_ref=${2:-}; shift 2 ;;
			*) echo "next-version: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
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
	changelog_major=""; changelog_minor=""; changelog_patch=""
	changelog=""
	if [ "$use_changelog" -eq 1 ]; then
		if [ -n "$changelog_ref" ]; then
			case "$changelog_ref" in *[!0-9a-f]* ) echo "next-version: changelog ref must be a full SHA" >&2; exit 2 ;; esac
			[ "${#changelog_ref}" -eq 40 ] || { echo "next-version: changelog ref must be a full SHA" >&2; exit 2; }
			changelog=$(git show "$changelog_ref:CHANGELOG.md") || { echo "next-version: source changelog is unavailable" >&2; exit 4; }
		elif [ -f CHANGELOG.md ]; then
			changelog=$(cat CHANGELOG.md)
		fi
		while IFS= read -r line; do
			case "$line" in
				'## ['*']'*) section=${line#'## ['}; section=${section%%]*} ;;
				*) continue ;;
			esac
			case "$section" in
				*[!0-9.]*|""|.*|*.|*..*) continue ;;
			esac
			case "$section" in *.*.*) ;; *) continue ;; esac
			major=${section%%.*}; rem=${section#*.}
			minor=${rem%%.*}; patch=${rem#*.}
			case "$patch" in *.*) continue ;; esac
			case "$major$minor$patch" in *[!0-9]*|"") continue ;; esac
			case "$major" in 0) ;; *) case "$major" in 0* ) continue ;; esac ;; esac
			case "$minor" in 0) ;; *) case "$minor" in 0* ) continue ;; esac ;; esac
			case "$patch" in 0) ;; *) case "$patch" in 0* ) continue ;; esac ;; esac
			if [ -z "$changelog_major" ] \
				|| [ "$major" -gt "$changelog_major" ] \
				|| { [ "$major" -eq "$changelog_major" ] && [ "$minor" -gt "$changelog_minor" ]; } \
				|| { [ "$major" -eq "$changelog_major" ] && [ "$minor" -eq "$changelog_minor" ] && [ "$patch" -gt "$changelog_patch" ]; }; then
				changelog_major=$major; changelog_minor=$minor; changelog_patch=$patch
			fi
		done <<NEXT_VERSION_CHANGELOG
$changelog
NEXT_VERSION_CHANGELOG
	fi
	if [ -z "$max_major" ] && [ -z "$changelog_major" ]; then
		echo "next-version: no parseable vX.Y.Z tag or CHANGELOG.md release section" >&2
		exit 4
	fi
	selected_major=$max_major; selected_minor=$max_minor; selected_patch=$max_patch
	basis=tags
	if [ -z "$max_major" ] \
		|| { [ -n "$changelog_major" ] && [ "$changelog_major" -gt "$max_major" ]; } \
		|| { [ -n "$changelog_major" ] && [ "$changelog_major" -eq "$max_major" ] && [ "$changelog_minor" -gt "$max_minor" ]; } \
		|| { [ -n "$changelog_major" ] && [ "$changelog_major" -eq "$max_major" ] && [ "$changelog_minor" -eq "$max_minor" ] && [ "$changelog_patch" -gt "$max_patch" ]; }; then
		selected_major=$changelog_major; selected_minor=$changelog_minor; selected_patch=$changelog_patch
		basis='changelog-section'
	elif [ -n "$changelog_major" ] && [ "$changelog_major" -eq "$max_major" ] \
		&& [ "$changelog_minor" -eq "$max_minor" ] && [ "$changelog_patch" -eq "$max_patch" ]; then
		basis='tag-and-changelog'
	fi
	tag_version=none; changelog_version=none
	[ -z "$max_major" ] || tag_version="$max_major.$max_minor.$max_patch"
	[ -z "$changelog_major" ] || changelog_version="$changelog_major.$changelog_minor.$changelog_patch"
	printf 'VERSION-DECISION version=%s.%s.%s basis=%s max_tag=%s max_changelog=%s\n' \
		"$selected_major" "$selected_minor" "$((selected_patch + 1))" "$basis" "$tag_version" "$changelog_version" >&2
	printf '%s.%s.%s\n' "$selected_major" "$selected_minor" "$((selected_patch + 1))"
	exit 0
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
publish-lag)
	version=""; sha=""; repo=""; ghrepo=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--version) version=${2:-}; shift 2 ;;
			--sha) sha=${2:-}; shift 2 ;;
			--repo) repo=${2:-}; shift 2 ;;
			--gh-repo) ghrepo=${2:-}; shift 2 ;;
			*) echo "publish-lag: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$version" ] && [ -n "$sha" ] && [ -n "$repo" ]; }; then echo "publish-lag: --version, --sha and --repo are required" >&2; exit 2; fi
	case "$sha" in *[!0-9a-f]*|"" ) echo "publish-lag: --sha must be a hex commit" >&2; exit 2 ;; esac
	tagline=$(git ls-remote "$repo" "refs/tags/v$version" 2>/dev/null) || { echo "publish-lag: tag lookup failed" >&2; exit 3; }
	tagsha=$(printf '%s' "$tagline" | cut -f1)
	if [ -z "$tagsha" ]; then printf 'PUBLISH_LAG=no-tag version=%s\n' "$version"; exit 0; fi
	if [ "$tagsha" != "$sha" ]; then printf 'PUBLISH_LAG=tag-mismatch version=%s tag=%s want=%s\n' "$version" "$tagsha" "$sha" >&2; exit 4; fi
	relout=$("${GH_BIN:-gh}" release view "v$version" --repo "${ghrepo:-$repo}" --json tagName 2>&1) && {
		printf 'PUBLISH_LAG=published version=%s sha=%s\n' "$version" "$sha"; exit 0; }
	case "$relout" in *"not found"*|*"Not Found"*|*" 404 "*|*" Could not resolve"*)
		printf 'PUBLISH_LAG=certified-tag-without-release version=%s sha=%s\n' "$version" "$sha" >&2; exit 4 ;; esac
	echo "publish-lag: release lookup failed" >&2; exit 3
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
		in_progress=$("$GH_BIN" run list --repo "$repo" --workflow "$workflow" --status in_progress --json databaseId --jq 'length') \
			|| { echo "wait-release-idle: gh run list failed" >&2; exit 1; }
		queued=$("$GH_BIN" run list --repo "$repo" --workflow "$workflow" --status queued --json databaseId --jq 'length') \
			|| { echo "wait-release-idle: gh run list failed" >&2; exit 1; }
		case "$in_progress" in ''|*[!0-9]* ) echo "wait-release-idle: unparseable gh output" >&2; exit 1 ;; esac
		case "$queued" in ''|*[!0-9]* ) echo "wait-release-idle: unparseable gh output" >&2; exit 1 ;; esac
		busy=$((in_progress + queued))
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
	stamped=$(cd "$repo" && sh "$SCRIPT_DIR/stamp-release-line.sh" --version "$version" 2>&1) || { echo "bump: stamp failed: $stamped" >&2; exit 1; }
	printf '%s\n' "$stamped"
	# The tree was clean, and promote+stamp only rewrite tracked files, so -u stages exactly their result.
	git -C "$repo" add -u -- .
	git -C "$repo" commit -q -m "chore: bump version to $version" \
		-m "Release train: changelog.d/ folded into CHANGELOG.md, [Unreleased] promoted to $version, package.json version set, README release line stamped." \
		-m "Bead: ompkit-v66l" \
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
		bad_paths=$(printf '%s\n' "$changes" | grep -Ev '^(M	CHANGELOG\.md|M	package\.json|M	README\.md|D	changelog\.d/[a-z0-9.-]+\.md)$' || true)
		[ -z "$bad_paths" ] || shape=bad
		now=$(git -C "$repo" show "$sha:package.json" | jq -S 'del(.version, .omp.version)' 2>/dev/null) || shape=bad
		before=$(git -C "$repo" show "$parent:package.json" | jq -S 'del(.version, .omp.version)' 2>/dev/null) || shape=bad
		[ "$now" = "$before" ] || shape=bad
		git -C "$repo" show "$sha:package.json" | jq -e --arg v "$version" '.version == $v and .omp.version == $v' >/dev/null 2>&1 || shape=bad
		# A README.md change is admissible only when it is exactly the generated
		# release line restamped to the bump version (no hand prose may ride along).
		if git -C "$repo" diff-tree --no-commit-id --no-renames --name-only -r "$sha" | grep -qx 'README.md'; then
			stamped=$(git -C "$repo" show "$sha:README.md" | awk '/<!-- kit-release:start -->/{flag=1;next}/<!-- kit-release:end -->/{flag=0}flag' | grep -v '^[[:space:]]*$' || true)
			[ "$stamped" = "Current release: v$version" ] || shape=bad
			stray=$(git -C "$repo" diff "$parent" "$sha" -- README.md | grep -E '^[+-]' | grep -vE '^[+-]{3}' | grep -vF "Current release: v" || true)
			[ -z "$stray" ] || shape=bad
		fi
	fi
	if [ "$shape" = ok ]; then printf 'EVIDENCE_SHA=%s REASON=release-bump-parent bump=%s\n' "$parent" "$sha"; exit 0; fi
	printf 'EVIDENCE_SHA=%s REASON=bump-shape-mismatch\n' "$sha"; exit 0
	;;
version-match)
	version=""; sha=""; repo="."
	while [ $# -gt 0 ]; do
		case "$1" in
			--version) version=${2:-}; shift 2 ;;
			--sha) sha=${2:-}; shift 2 ;;
			--repo) repo=${2:-}; shift 2 ;;
			*) echo "version-match: unknown argument: $1" >&2; exit 2 ;;
		esac
	done
	if ! { [ -n "$version" ] && [ -n "$sha" ]; }; then echo "version-match: --version and --sha are required" >&2; exit 2; fi
	case "$sha" in *[!0-9a-f]*|"" ) echo "version-match: --sha must be a hex commit" >&2; exit 2 ;; esac
	case "$version" in *[!0-9.]*|""|.*|*.|*..* ) echo "version-match: --version must be X.Y.Z" >&2; exit 2 ;; esac
	command -v jq >/dev/null 2>&1 || { echo "version-match: jq is required" >&2; exit 3; }
	pkg=$(git -C "$repo" show "$sha:package.json" 2>/dev/null) || { echo "version-match: package.json is missing at $sha; refusing tag v$version" >&2; exit 4; }
	printf '%s' "$pkg" | jq -e --arg v "$version" '.version == $v and ((has("omp") | not) or .omp.version == $v)' >/dev/null 2>&1 ||
		{ top=$(printf '%s' "$pkg" | jq -r '.version // "unparseable"' 2>/dev/null); sub=$(printf '%s' "$pkg" | jq -r '.omp.version // "absent"' 2>/dev/null);
			echo "version-match: package.json states ${top} / omp ${sub}, not v$version at $sha; refusing tag" >&2; exit 4; }
	printf 'VERSION_MATCH=exact version=%s sha=%s\n' "$version" "$sha"; exit 0
	;;
*) usage ;;
esac
