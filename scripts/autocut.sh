#!/bin/sh
# autocut.sh -- AUTOCUT1 (ompkit-2uubn; J-2026-11-01-05 "saving and releases should be BORING").
#
# A release is a scheduled read of verdicts already produced (release-verdict.sh judges every published head):
#   plan  pick the newest first-parent origin/main commit since the latest published release whose package.json
#         version is newer than that release and untagged, and whose exact tree has a reusable main-role
#         full-suite PASS (read through that commit's own full-suite-verdict-store.py, as release-local does).
#         A FAIL or missing verdict is skipped, never waited on: the next older candidate is tried.
#   run   plan; when a candidate exists and the floor has passed (--floor-hours since the latest release, default
#         12, J-2026-10-29-13) or --now is given, cut it with release-local.sh --version V --source SHA, then
#         install it (gh release download + omp-kit update --apply) and read the version back. --dry-run passes
#         through to release-local and skips the install.
# The cut names an exact sha, so pushes landing during a cut never change what is released: nothing is frozen.
# Every decision is one JSON line on stdout and appended to <git-dir>/omp-kit/autocut.log.
#
# Usage: autocut.sh plan|run [--repo DIR] [--dry-run] [--now] [--floor-hours N] [--max-candidates N]
# Test seams: AUTOCUT_RELEASES_JSON (file with `gh api .../releases` output), AUTOCUT_RELEASE_LOCAL (release
# command), AUTOCUT_INSTALL (install command, called as: INSTALL VERSION), AUTOCUT_NO_FETCH=1.
# Exit: 0 decided (CUT done, WAIT, or dry-run done), 2 usage, 4 refused or failed (named on stderr).
set -u

die() { printf 'autocut: %s\n' "$1" >&2; exit "${2:-4}"; }
mode=${1:-}
case "$mode" in plan|run) shift ;; *) die "usage: autocut.sh plan|run [--repo DIR] [--dry-run] [--now] [--floor-hours N] [--max-candidates N]" 2 ;; esac
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
dry_run=0 now=0 floor_hours=12 max_candidates=20
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) ROOT=$(CDPATH='' cd -- "${2:?}" && pwd -P) || die "no repo ${2:-}" 2; shift 2 ;;
		--dry-run) dry_run=1; shift ;;
		--now) now=1; shift ;;
		--floor-hours) floor_hours=${2:?}; shift 2 ;;
		--max-candidates) max_candidates=${2:?}; shift 2 ;;
		*) die "unknown argument $1" 2 ;;
	esac
done
case "$floor_hours$max_candidates" in *[!0-9]*) die "--floor-hours and --max-candidates take whole numbers" 2 ;; esac
REPO_SLUG=${OMP_KIT_REPO:-JYeswak/omp-kit-companion}
git_dir=$(git -C "$ROOT" rev-parse --absolute-git-dir) || die "$ROOT is not a git repository"
log="$git_dir/omp-kit/autocut.log"
mkdir -p "${log%/*}" || die "cannot create ${log%/*}"
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/kitlib-tmp.sh"
kitlib_tmp WORK autocut || die "cannot create owned scratch"   # kitlib owns the EXIT/HUP/INT/TERM traps and removes it

decide() { # ACTION REASON [SOURCE VERSION]: one JSON line to stdout and the log
	line=$(jq -cn --arg action "$1" --arg reason "$2" --arg source "${3:-}" --arg version "${4:-}" \
		--arg base "${base_tag:-}" --arg mode "$mode" --argjson dry "$dry_run" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{at:$at, mode:$mode, action:$action, reason:$reason, source:$source, version:$version, base:$base, dry_run:($dry==1)} | with_entries(select(.value != ""))')
	printf '%s\n' "$line" | tee -a "$log"
}

[ "${AUTOCUT_NO_FETCH:-0}" = 1 ] || git -C "$ROOT" fetch -q origin '+refs/heads/main:refs/remotes/origin/main' || die "git fetch origin main failed"
main=$(git -C "$ROOT" rev-parse -q --verify 'refs/remotes/origin/main^{commit}') || die "no refs/remotes/origin/main"

if [ -n "${AUTOCUT_RELEASES_JSON:-}" ]; then
	cp "$AUTOCUT_RELEASES_JSON" "$WORK/releases.json" || die "cannot read AUTOCUT_RELEASES_JSON"
else
	gh api --paginate --slurp "repos/$REPO_SLUG/releases?per_page=100" > "$WORK/releases.json" || die "listing releases failed"
fi
BASE_FILTER='[.[][] | select(.draft == false and .prerelease == false and (.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")))] | sort_by(.tag_name | ltrimstr("v") | split(".") | map(tonumber)) | last // empty'
base=$(jq -c "$BASE_FILTER" "$WORK/releases.json") || die "unreadable releases list"
[ -n "$base" ] || die "no published base release"
base_tag=$(printf '%s' "$base" | jq -r .tag_name)
base_at=$(printf '%s' "$base" | jq -r '.published_at // .created_at')
base_epoch=$(jq -rn --arg t "$base_at" '$t | fromdateiso8601') || die "unreadable release date $base_at"
base_sha=$(git -C "$ROOT" rev-parse -q --verify "refs/tags/$base_tag^{commit}" 2>/dev/null) || base_sha=

newer() { # A B: status 0 when version A > B
	[ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ] && [ "$1" != "$2" ]
}

source_sha='' version='' skipped=''
for sha in $(git -C "$ROOT" rev-list --first-parent --max-count="$max_candidates" "$main"); do
	[ -n "$base_sha" ] && [ "$sha" = "$base_sha" ] && break
	candidate_version=$(git -C "$ROOT" show "$sha:package.json" | jq -r .version) || { skipped="$skipped ${sha%"${sha#??????????}"}:no-package"; continue; }
	if ! newer "$candidate_version" "${base_tag#v}"; then skipped="$skipped ${sha%"${sha#??????????}"}:version-$candidate_version"; continue; fi
	if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$candidate_version" >/dev/null; then skipped="$skipped ${sha%"${sha#??????????}"}:tagged"; continue; fi
	export_dir="$WORK/export.$sha"
	mkdir -p "$export_dir"
	git -C "$ROOT" archive "$sha" | tar -xf - -C "$export_dir" || { skipped="$skipped ${sha%"${sha#??????????}"}:no-export"; continue; }
	tree=$(git -C "$ROOT" rev-parse "$sha^{tree}")
	verdict=$(cd "$export_dir" && python3 -B scripts/pysafe.py run --timeout 30 -- python3 -B scripts/full-suite-verdict-store.py require-pass \
		--repo "$ROOT" --tree "$tree" --role main --judge-root "$export_dir" --suite-root "$export_dir" 2>/dev/null) || verdict=''
	if [ "$verdict" = PASS ]; then source_sha=$sha version=$candidate_version; break; fi
	skipped="$skipped ${sha%"${sha#??????????}"}:no-pass"
done

if [ -z "$source_sha" ]; then
	decide WAIT "no origin/main commit since $base_tag has a newer untagged version with a main-role PASS;${skipped:- no candidates}"
	exit 0
fi
age_h=$(( ($(date +%s) - base_epoch) / 3600 ))
if [ "$now" = 0 ] && [ "$age_h" -lt "$floor_hours" ]; then
	decide WAIT "candidate ready but $base_tag is ${age_h}h old (< ${floor_hours}h floor; --now cuts anyway)" "$source_sha" "$version"
	exit 0
fi
if [ "$mode" = plan ]; then
	decide CUT "planned: newest main-role PASS with an untagged newer version" "$source_sha" "$version"
	exit 0
fi

decide CUTTING "release-local.sh --version $version --source $source_sha" "$source_sha" "$version" >/dev/null
release_cmd=${AUTOCUT_RELEASE_LOCAL:-"bash $ROOT/scripts/release-local.sh"}
set -- --version "$version" --source "$source_sha"
[ "$dry_run" = 1 ] && set -- "$@" --dry-run
# shellcheck disable=SC2086  # the release command may carry its interpreter
if ! TMPDIR="$WORK" $release_cmd "$@" >&2; then
	decide FAILED "release-local refused or failed for $version at $source_sha (its stderr above)" "$source_sha" "$version"
	exit 4
fi
if [ "$dry_run" = 1 ]; then
	decide CUT "dry run complete; nothing tagged or installed" "$source_sha" "$version"
	exit 0
fi
install_cmd=${AUTOCUT_INSTALL:-}
if [ -z "$install_cmd" ]; then
	assets="$HOME/.local/opt/omp-kit/update-assets/$version"
	mkdir -p "$assets" || die "cannot create $assets"
	gh release download "v$version" --repo "$REPO_SLUG" --dir "$assets" --clobber \
		--pattern release-index.json --pattern "omp-kit-v$version-darwin-arm64-none.tar.gz" >&2 || die "downloading v$version assets failed"
	omp-kit update --apply --yes --version "$version" --index "$assets/release-index.json" \
		--archive "$assets/omp-kit-v$version-darwin-arm64-none.tar.gz" --json >&2 || die "omp-kit update --apply refused v$version"
	installed=$(omp-kit --version | awk '{print $2}')
else
	# shellcheck disable=SC2086
	installed=$($install_cmd "$version") || die "install command failed for v$version"
fi
if [ "$installed" != "$version" ]; then
	decide FAILED "installed version reads '$installed', not $version" "$source_sha" "$version"
	exit 4
fi
decide CUT "released and installed v$version from $source_sha" "$source_sha" "$version"
