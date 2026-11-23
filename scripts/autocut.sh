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
# command), AUTOCUT_INSTALL (install command, called as: INSTALL VERSION), AUTOCUT_NO_FETCH=1, AUTOCUT_ADVANCE (the advance-only
# command, default release-local.sh from a fresh clone of origin) and AUTOCUT_ADVANCE_PAUSE_S (seconds between advance attempts, default 5).
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
	# AUTOCUTENV1 (ompkit-2uubn): read the store under the pinned tool order the verdict was judged under (scripts/fixed-env.sh).
	# The store validates a record's local rows against the READING interpreter's version; the launchd job's PATH puts Homebrew
	# python 3.15 first where the verdict ran under /usr/bin python 3.9.6, so every PASS read back MISS ("local file evidence is
	# incomplete or mixes producers") although the same read from a seat shell said PASS (2026-11-23 16:53Z, 09085f2671).
	pinned_path=$PATH
	if [ -f "$export_dir/scripts/fixed-env.sh" ]; then
		pinned_path=$(HOME="$HOME" sh -c '. "$1" && printf %s "$PATH"' autocut "$export_dir/scripts/fixed-env.sh") || pinned_path=$PATH
	fi
	verdict=$(cd "$export_dir" && env PATH="$pinned_path" python3 -B scripts/pysafe.py run --timeout 30 -- python3 -B scripts/full-suite-verdict-store.py require-pass \
		--repo "$ROOT" --tree "$tree" --role main --judge-root "$export_dir" --suite-root "$export_dir" 2>"$WORK/verdict.err") || verdict=''
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
# AUTOCUTCLONE1 (ompkit-hbt6q): the cut runs from an owned clone of origin switched to the source commit, never from $ROOT. The
# shared working tree lags main (2026-11-23: its local main shared no history with origin/main), and release-local's
# next-version advance needs HEAD to contain the cut source, so a cut from that tree could never land its own next-version
# commit. The clone also runs the release scripts of the very commit being released. A test seam command keeps its own path.
release_cmd=${AUTOCUT_RELEASE_LOCAL:-}
if [ -z "$release_cmd" ]; then
	cut_root="$WORK/cut"
	origin_url=$(git -C "$ROOT" config --get remote.origin.url) || die "no remote.origin.url in $ROOT"
	git clone -q --no-hardlinks "$origin_url" "$cut_root" || die "cannot clone $origin_url for the cut"
	git -C "$cut_root" fetch -q --tags origin || die "cannot fetch tags into the cut clone"
	git -C "$cut_root" switch -q -C main "$source_sha" || die "cannot check out $source_sha in the cut clone"
	release_cmd="bash $cut_root/scripts/release-local.sh"
fi
set -- --version "$version" --source "$source_sha"
# release-local installs by default; autocut installs below from the public assets exactly as an operator does.
if [ "$dry_run" = 1 ]; then set -- "$@" --dry-run; else set -- "$@" --no-install; fi
# The stderr of the cut is kept: a transient attest failure leaves the tag and the draft, which is resumable.
release_err="$WORK/release.err"
# shellcheck disable=SC2086  # the release command may carry its interpreter
if TMPDIR="$WORK" $release_cmd "$@" >&2 2>"$release_err"; then cut_ok=1; else cut_ok=0; fi
cat "$release_err" >&2
if [ "$cut_ok" = 0 ] && [ "$dry_run" = 0 ] && grep -q "draft v$version kept" "$release_err"; then
	# RELRESUME1: adopt the kept tag and draft, re-dispatch attest, verify. Once; a second failure is a real refusal.
	decide RESUMING "release-local kept draft v$version; resuming it once" "$source_sha" "$version" >/dev/null
	# shellcheck disable=SC2086
	if TMPDIR="$WORK" $release_cmd --resume-from-draft --version "$version" --no-install >&2 2>"$release_err"; then cut_ok=1; fi
	cat "$release_err" >&2
fi
# AUTOCUTADVANCE1 (ompkit-2uubn): v$version is public when release-local says its next-version commit did not land and names
# `release-local --advance-only` as the retry (2026-11-23: a landing after the source touched a shipped changelog fragment, the
# cut clone's next-version commit conflicted with origin, and the job stopped with the release published and nothing installed).
# The advance reads published state only, so it runs from a fresh clone of origin/main, which already holds the landing.
# Up to three attempts: another landing can move origin between the clone and the push.
if [ "$cut_ok" = 0 ] && [ "$dry_run" = 0 ] && grep -q -F "release-local --advance-only --version $version" "$release_err"; then
	attempt=0
	while [ "$cut_ok" = 0 ] && [ "$attempt" -lt 3 ]; do
		attempt=$((attempt + 1))
		decide ADVANCING "v$version is published but its next-version commit did not land; advance-only from a fresh clone of origin/main (attempt $attempt of 3)" "$source_sha" "$version" >/dev/null
		advance_cmd=${AUTOCUT_ADVANCE:-}
		if [ -z "$advance_cmd" ]; then
			advance_root="$WORK/advance.$attempt"
			advance_origin=$(git -C "$ROOT" config --get remote.origin.url) || die "no remote.origin.url in $ROOT"
			if git clone -q --no-hardlinks "$advance_origin" "$advance_root" && git -C "$advance_root" fetch -q --tags origin; then
				advance_cmd="bash $advance_root/scripts/release-local.sh"
			else
				printf 'autocut: cannot clone %s for the advance (attempt %s)\n' "$advance_origin" "$attempt" >&2
				sleep "${AUTOCUT_ADVANCE_PAUSE_S:-5}"
				continue
			fi
		fi
		# shellcheck disable=SC2086
		if TMPDIR="$WORK" $advance_cmd --advance-only --version "$version" >&2 2>"$release_err"; then cut_ok=1; fi
		cat "$release_err" >&2
		[ "$cut_ok" = 1 ] || sleep "${AUTOCUT_ADVANCE_PAUSE_S:-5}"
	done
fi
if [ "$cut_ok" = 0 ]; then
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
		--pattern release-index.json --pattern SHA256SUMS --pattern "omp-kit-v$version-darwin-arm64-none.tar.gz" >&2 || die "downloading v$version assets failed"
	(cd "$assets" && shasum -a 256 -c SHA256SUMS --ignore-missing >&2) || die "v$version assets do not match SHA256SUMS"
	# AUTOCUTINSTALL1 (ompkit-2uubn): the envelope is captured, not sent to stderr. omp-kit update exits 1 with ok:false when its
	# manifest section has findings (a service that needs operator config, a RULE_COLLISION on an edited managed rule, hooks of
	# one repo) even though the release is installed and every judge passed: the 0.2.146 install did exactly that. That is an
	# installed release with findings, never a refused install, so the run does not die on the exit code alone.
	update_json="$WORK/update.json"
	update_rc=0
	omp-kit update --apply --yes --version "$version" --index "$assets/release-index.json" \
		--archive "$assets/omp-kit-v$version-darwin-arm64-none.tar.gz" --json >"$update_json" 2>"$WORK/update.err" || update_rc=$?
	cat "$WORK/update.err" >&2
	# AUTOCUTEVIDENCE1 (ompkit-2uubn): the 0.2.148 install ended exit 1 with an envelope neither accepted branch below recognized, the run died, and the
	# envelope went with its scratch, so the cause of the refusal could not be read afterwards. Keep both beside the decision log.
	cp "$update_json" "$git_dir/omp-kit/autocut-update-$version.json" || printf 'autocut: could not keep the update envelope\n' >&2
	cp "$WORK/update.err" "$git_dir/omp-kit/autocut-update-$version.err" || printf 'autocut: could not keep the update stderr\n' >&2
	installed=$(omp-kit --version | awk '{print $2}')
	if [ "$update_rc" != 0 ]; then
		if [ "$installed" = "$version" ] && jq -e --arg v "$version" \
			'.data.action == "UPDATED" and .data.active_version == $v and .data.matcher == "PASS" and .data.live == "PASS" and .data.postcheck == "PASS"' "$update_json" >/dev/null 2>&1; then
			findings=$(jq -r '[.errors[]? | (.code + " " + (.message | .[0:90]))] | .[0:6] | join("; ")' "$update_json" 2>/dev/null) || findings=
			decide INSTALLED_WITH_FINDINGS "omp-kit update exited $update_rc with v$version active and matcher, live and postcheck PASS; manifest findings: ${findings:-unreadable}" "$source_sha" "$version"
		elif [ "$installed" = "$version" ] && jq -e --arg v "$version" '
			.data.action == "PARTIAL" and .data.active_version == $v and .data.matcher == "PASS" and .data.live == "PASS"
			and ((.data.receipt_id // "") | test("^[0-9a-f-]{36}$"))
			and ((.data.postcheck_detail.failed_stages // []) | length) == 0
			and ((.data.postcheck_detail.failures // []) | length) > 0
			and all(.data.postcheck_detail.failures[]; (type == "string") and startswith("Operator file changed during isolated test: ~/.local/state/omp-kit/"))' "$update_json" >/dev/null 2>&1; then
			# AUTOCUTRECONCILE1 (ompkit-2uubn, ompkit-3isy): the 0.2.147 install ended PARTIAL with matcher and live PASS, no failed stage,
			# and three failures that were all fleet processes writing their own state under the kit state root during the 217 s
			# postcheck. The files installed are the release's; reconcile verifies the postimages, links the plugin and marks the
			# receipt RECONCILED. Any other failure (a failed stage, a path outside the state root, a missing receipt) still dies.
			receipt=$(jq -r '.data.receipt_id' "$update_json")
			decide RECONCILING "omp-kit update left receipt $receipt PARTIAL: every postcheck failure is a fleet write under the kit state root; reconciling it" "$source_sha" "$version" >/dev/null
			reconcile_rc=0
			omp-kit update --reconcile "$receipt" --yes --json >"$WORK/reconcile.json" 2>"$WORK/reconcile.err" || reconcile_rc=$?
			cat "$WORK/reconcile.err" >&2
			[ "$reconcile_rc" = 0 ] || die "omp-kit update --reconcile $receipt refused (exit $reconcile_rc)"
			installed=$(omp-kit --version | awk '{print $2}')
			decide INSTALLED_RECONCILED "v$version installed; receipt $receipt reconciled after fleet-write postcheck findings" "$source_sha" "$version"
		else
			refused=$(jq -r '"action=\(.data.action // "?") overall=\(.data.overall // "?") postcheck=\(.data.postcheck // "?") failures=\((.data.postcheck_detail.failures // []) | .[0:3] | join(" | ")) errors=\([.errors[]?.code] | join(","))"' "$update_json" 2>/dev/null) || refused="envelope unreadable"
			decide FAILED "omp-kit update --apply refused v$version (exit $update_rc; installed reads '$installed'; $refused); envelope kept in autocut-update-$version.json" "$source_sha" "$version" >/dev/null
			die "omp-kit update --apply refused v$version (exit $update_rc; installed reads '$installed'; $refused)"
		fi
	fi
else
	# shellcheck disable=SC2086
	installed=$($install_cmd "$version") || die "install command failed for v$version"
fi
if [ "$installed" != "$version" ]; then
	decide FAILED "installed version reads '$installed', not $version" "$source_sha" "$version"
	exit 4
fi
decide CUT "released and installed v$version from $source_sha" "$source_sha" "$version"
