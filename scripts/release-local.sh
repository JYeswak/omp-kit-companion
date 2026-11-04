#!/usr/bin/env bash
# scripts/release-local.sh: LOCAL-RELEASE-V1 (ompkit-v66l.27.11, J-2026-10-18-30), the dsr-style local release.
#
# Run on the signing Mac. It cuts one omp-kit release without the CI qualification pipeline:
#   1. prepare    NEXTVERSION1: origin/main already states the version; it is cut as is. Only when that version is
#                 already tagged (bootstrap): version metadata commit, publish main, then qualify its exact export.
#      preflight  --source resumes an exact origin/main commit; version must be unused (no tag/release/draft).
#                 Its exact tree must have a reusable main-role full-suite PASS before the signing keychain opens.
#                 It must also have the push-time ci-only PASS (every local gate-ci-only.tsv file: package-release,
#                 kit-update and their split live journeys, run by release-verdict.sh).
#   2. build      after the verdict readback and signing-identity preflight, build every ship-set platform
#                 (darwin-arm64-none, linux-arm64-gnu, linux-x64-gnu) from an exact-commit `git archive`
#                 export with scripts/package-release.sh, exactly as ci.yml build-candidates does (bun
#                 cross-compiles the linux targets); the unsigned release-index.json as native-candidate.py
#                 writes it. darwin-x64-none is not in the ship set and is never built.
#   3. sign       Developer ID sign (hardened runtime, timestamp, source entitlements) every darwin Mach-O,
#                 notarize, and prove with scripts/devid_release.py verify --execute, as sign-darwin-release.sh
#                 does; the final index changes only the darwin digests.
#   4. checksum   SHA256SUMS over release-index.json and the archives.
#   4b. rule-gate the postcheck's ttsr coverage gate (every rule needs fire+quiet
#                 fixtures) on the exact-commit source; refusal exits 4 before any release tag/draft.
#   --dry-run prepares a local commit but never pushes it or writes to GitHub; --source keeps the read-only cut preview.
#   5. tag        push the lightweight tag v<version> -> source (never forced, never re-tagged).
#   6. draft      create the draft release with the notes from release-notes.sh and require GitHub's recorded
#                 digest of every asset to equal the local bytes.
#   7. attest     dispatch release.yml (mode=local-attest) at --ref v<version>; it re-checks the draft against
#                 SHA256SUMS, attests SLSA provenance + SBOMs with GitHub OIDC (the consumers' pinned trust root),
#                 verifies with the consumer's verifier and publishes the draft.
#   8. verify     download every asset from the public release URL, check SHA256SUMS and the local bytes, fetch
#                 each archive's attestation bundle exactly as kit-update-job.ts does and run the embedded
#                 installer verifier exactly as kit-update.ts does, then check Gatekeeper on the darwin binary.
#   9. install    default for real cuts: updater, narrow browser-state reconcile, all-profile relink,
#                 real align and CLI version readback. --no-install explicitly stops at released.
#
# Usage: scripts/release-local.sh [--version X.Y.Z | --next] [--source SHA] [--dry-run] [--install | --no-install]
# Environment:
#   TMPDIR                             an owned scratch directory (required); the build tree is removed on exit
#   OMP_KIT_REPO                       GitHub repository (default: JYeswak/omp-kit-companion)
#   OMP_KIT_DEVID_SHA1                 codesigning identity SHA-1 (default: the unique Developer ID identity)
#   OMP_KIT_NOTARY_PROFILE             notarytool profile in the signing keychain (default: omp-kit-notary)
#   OMP_KIT_SIGNING_KEYCHAIN           signing keychain (default: ~/Library/Keychains/uds-signing.keychain-db)
#   OMP_KIT_SIGNING_KEYCHAIN_PASSWORD  file holding its password (default: ~/.config/uds/signing-keychain.pw)
#   OMP_KIT_INSTALL_PREFIX             installed kit prefix (default: ~/.local/opt/omp-kit)
# Exit: 0 installed/released (or dry run complete), 2 usage, 4 refused (a prepare may already be published).
# bash only, never `sh`: macOS /bin/sh is bash in POSIX mode, which runs the early stages, then aborts on the process
# substitution at the sign stage with no failing command, so the EXIT trap re-exited 0 (2026-10-22 lead run of 0.2.73).
if [ -z "${BASH_VERSION:-}" ] || (set -o | grep -q '^posix[[:space:]]*on'); then
	echo "release-local: run it with bash (./scripts/release-local.sh), not sh" >&2
	exit 2
fi
set -euo pipefail

REPO="${OMP_KIT_REPO:-JYeswak/omp-kit-companion}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SHIP=(darwin-arm64-none linux-arm64-gnu linux-x64-gnu)
AUTHORITY='Developer ID Application: Joshua Nowak (XGL9CXRCT5)'
NOTARY_PROFILE="${OMP_KIT_NOTARY_PROFILE:-omp-kit-notary}"
KEYCHAIN="${OMP_KIT_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/uds-signing.keychain-db}"
KEYCHAIN_PASSWORD="${OMP_KIT_SIGNING_KEYCHAIN_PASSWORD:-$HOME/.config/uds/signing-keychain.pw}"
INSTALL_PREFIX="${OMP_KIT_INSTALL_PREFIX:-$HOME/.local/opt/omp-kit}"

die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }

DRY_RUN=0
VERSION=''
SOURCE=''
NEXT=0
TAG_PUSH_SECONDS=''
PUSH_STARTED=''
INSTALL=1
INSTALLED=0
RELEASED_AT=''
while [ "$#" -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1; shift ;;
		--version) VERSION="${2:-}"; shift 2 ;;
		--next) NEXT=1; shift ;;
		--source) SOURCE="${2:-}"; shift 2 ;;
		--install) INSTALL=1; shift ;;
		--no-install) INSTALL=0; shift ;;
		-h|--help) sed -n '2,36p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "release-local: unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ -z "$VERSION" ] || [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "release-local: --version must be X.Y.Z" >&2; exit 2; }
[ -z "$SOURCE" ] || [[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "release-local: --source must be a full commit SHA" >&2; exit 2; }
[ "$NEXT" = 0 ] || [ -z "$VERSION" ] || { echo "release-local: use --next or --version, not both" >&2; exit 2; }
[ "$NEXT" = 0 ] || [ -z "$SOURCE" ] || { echo "release-local: --next prepares HEAD; do not combine it with --source" >&2; exit 2; }
if [ -z "${TMPDIR:-}" ] || [ ! -d "$TMPDIR" ]; then die "export TMPDIR to an owned scratch directory first"; fi # tempsafe: requires the caller's owned scratch, creates nothing

# Cancel safety: every external step runs bounded, with stdin from /dev/null, as a waited background child that
# the exit work kills; the keychain re-locks and the build tree is removed on every exit path. kitlib owns the
# EXIT/HUP/INT/TERM traps: the build tree is its owned dir and cleanup runs first, as kitlib atexit work.
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp WORK release-local
CHILD=''
UNLOCKED=0
STARTED=$(date +%s)
STAGE_LOG="$WORK/stages"
: >"$STAGE_LOG"
cleanup() {
	if [ -n "$CHILD" ]; then kill -TERM "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null || true; fi
	if [ "$UNLOCKED" = 1 ]; then security lock-keychain "$KEYCHAIN" </dev/null || echo "release-local: WARNING: could not re-lock $KEYCHAIN" >&2; fi
}
kitlib_tmp_atexit cleanup
# bounded SECONDS CMD...: run CMD with a deadline and no terminal stdin, interruptible by the trap.
bounded() {
	local seconds=$1; shift
	timeout "$seconds" "$@" </dev/null &
	CHILD=$!
	local rc=0
	wait "$CHILD" || rc=$?
	CHILD=''
	return "$rc"
}
STAGE=''; STAGE_T0=0
stage() {
	local now; now=$(date +%s)
	if [ -n "$STAGE" ]; then printf '%s %s\n' "$STAGE" "$((now - STAGE_T0))" >>"$STAGE_LOG"; say "stage $STAGE took $((now - STAGE_T0))s"; fi
	STAGE=$1; STAGE_T0=$now
	[ -z "$STAGE" ] || say "stage $STAGE"
}
sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
# Keep local network/verification work separable from GitHub's runner timings.
SUBSTEP=''; SUBSTEP_T0=0
substep() {
	local now; now=$(date +%s)
	if [ -n "$SUBSTEP" ]; then say "substep $SUBSTEP took $((now - SUBSTEP_T0))s"; fi
	SUBSTEP=$1; SUBSTEP_T0=$now
}

# No --source means prepare from this checkout. Never adopt foreign metadata edits,
# even when their version happens to match. --only keeps unrelated staged work out.
prepare_release() {
	stage prepare
	[ "$(git -C "$ROOT" symbolic-ref --short HEAD)" = main ] || die "prepare requires main"
	local paths=(package.json README.md changelog.d/774u.md)
	local dirty
	dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${paths[@]}")" ||
		die "cannot inspect release metadata custody"
	[ -z "$dirty" ] || die "foreign changes on release prepare paths: $dirty"
	python3 - "$ROOT" "$VERSION" <<'PY'
import json, re, sys
from pathlib import Path
root, version = Path(sys.argv[1]), sys.argv[2]
package = root / "package.json"
text = package.read_text()
doc = json.loads(text)
old = doc["version"]
if doc["omp"]["version"] != old:
    raise SystemExit("release-local: package and plugin versions disagree")
if tuple(map(int, version.split("."))) <= tuple(map(int, old.split("."))):
    raise SystemExit("release-local: prepare version must increase; use --source for an existing prepare")
# Keep all non-version bytes, including the export-subst revision token.
updated, count = re.subn(r'("version"\s*:\s*)"' + re.escape(old) + '"',
                         lambda m: m[1] + json.dumps(version), text)
if count != 2:
    raise SystemExit("release-local: expected exactly two version fields")
readme = root / "README.md"
stamp, count = re.subn(r"(?m)^Current release: v[0-9]+\.[0-9]+\.[0-9]+$",
                      "Current release: v" + version, readme.read_text())
if count != 1:
    raise SystemExit("release-local: expected exactly one README release stamp")
fragment = root / "changelog.d/774u.md"
notes = fragment.read_text()
entry = (f"- Set CLI and OMP plugin version metadata to {version}. "
         "The release is qualified on this prepare commit's exact exported tree before signing.\n")
# Validate every input before changing any of them.
package.write_text(updated)
readme.write_text(stamp)
fragment.write_text(notes.rstrip() + "\n" + entry)
PY
	local agent="${AGENT_NAME:-$(git -C "$ROOT" config user.name)}"
	bounded 900 git -C "$ROOT" commit --only \
		-m "chore(release): prepare $VERSION ompkit-774u [test]" \
		-m "Release metadata only; release-local requires fresh main and CI-only PASS verdicts on this exact exported tree before signing." \
		-m "Gap-Bead: none (release metadata)
Bead: ompkit-774u
Agent: $agent" -- "${paths[@]}" || die "release prepare commit failed; metadata left for inspection"
	SOURCE="$(git -C "$ROOT" rev-parse HEAD)"
	if [ "$DRY_RUN" = 1 ]; then
		say "dry run prepare: committed $SOURCE locally; no push"
	else
		stage push
		PUSH_STARTED=$(date +%s)
		bounded 900 git -C "$ROOT" -c push.followTags=false push origin main ||
			die "prepare push failed; retry with --source $SOURCE after publishing through the normal convergence route"
		bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' ||
			die "prepare push readback failed"
		MAIN="$(git -C "$ROOT" rev-parse refs/remotes/origin/main)"
		git -C "$ROOT" merge-base --is-ancestor "$SOURCE" "$MAIN" || die "prepare commit is not published"
	fi
}

# Reconcile only the updater's narrowly classified live-browser false PARTIAL.
# Genuine failed tests or foreign operator writes remain blocking failures.
install_release() {
	stage install
	local kit="$INSTALL_PREFIX/bin/omp-kit" store="$INSTALL_PREFIX/releases/$VERSION"
	local update_rc=0 reconcile_id
	# RELINSTALLPATH1 (ompkit-fp72.120.16.155): `omp-kit update --apply` refuses a source that is not its own realpath
	# (UNSAFE_KIT_SOURCE, kit-update.ts assertRegular), and $WORK under macOS TMPDIR sits below the /var -> /private/var
	# symlink, so 0.2.75 published and then never installed. Hand the updater the physical path (same directory).
	PUB="$(cd "$PUB" && pwd -P)" || die "cannot resolve the public download directory $PUB"
	substep install.update
	bounded 3600 "$kit" update --apply --yes --version "$VERSION" \
		--index "$PUB/release-index.json" --archive "$PUB/$DARWIN" --json >"$WORK/install-update.json" || update_rc=$?
	cat "$WORK/install-update.json"
	if [ "$update_rc" -ne 0 ]; then
		jq -er --arg v "$VERSION" '
			.data as $d | $d.receipt_id as $id |
			select($d.action == "PARTIAL" and $d.active_version == $v and
				$d.matcher == "PASS" and $d.live == "PASS" and $d.postcheck == "FAIL" and
				($id | type == "string" and test("^[a-f0-9-]+$")) and
				$d.postcheck_detail.changed_operator_paths == [] and
				$d.postcheck_detail.failures == [] and $d.postcheck_detail.cause == null and
				($d.postcheck_detail.live_state_paths | length > 0) and
				(.commands | index("omp-kit update --reconcile " + $id + " --yes") != null)) | $id
		' "$WORK/install-update.json" >"$WORK/install-reconcile-id" ||
			die "install update failed (rc $update_rc); not the known live-browser-only PARTIAL, refusing reconciliation"
		IFS= read -r reconcile_id <"$WORK/install-reconcile-id"
		substep install.reconcile-live-browser-state
		bounded 300 "$kit" update --reconcile "$reconcile_id" --yes --json >"$WORK/install-reconcile.json" ||
			die "live-browser-state reconcile refused; installation remains unverified"
		cat "$WORK/install-reconcile.json"
		jq -e --arg v "$VERSION" '.ok == true and .data.action == "RECONCILED" and .data.active_version == $v' \
			"$WORK/install-reconcile.json" >/dev/null || die "reconcile did not confirm the installed version"
	else
		jq -e --arg v "$VERSION" '.ok == true and .data.active_version == $v and
			(.data.action == "UPDATED" or .data.action == "CURRENT")' "$WORK/install-update.json" >/dev/null ||
			die "updater did not confirm the target version"
	fi
	substep install.plugin-relink
	bounded 300 "$kit" apply plugin --apply --yes --store "$store" --profiles all --include-default --json \
		>"$WORK/install-plugin.json" || die "profile plugin relink failed"
	cat "$WORK/install-plugin.json"
	jq -e '.ok == true' "$WORK/install-plugin.json" >/dev/null || die "profile plugin relink was not successful"
	substep install.align-readback
	bounded 60 python3 "$store/skills/fleet-restart/scripts/fleet_restart.py" align \
		--home "$HOME" --releases "$INSTALL_PREFIX/releases" --version "$VERSION" >"$WORK/install-align.json" ||
		die "installed profile alignment is stale"
	cat "$WORK/install-align.json"
	jq -e --arg v "$VERSION" '.ok == true and .version == $v and .stale == [] and
		(.links | length > 0) and all(.links[]; .ok == true)' "$WORK/install-align.json" >/dev/null ||
		die "align readback did not prove every profile link"
	substep install.version-readback
	[ "$(bounded 30 "$kit" --version)" = "omp-kit $VERSION" ] || die "installed CLI version readback differs from $VERSION"
	substep ''
	INSTALLED=1
	say "installed $VERSION; every profile link aligned"
}

# ---------------------------------------------------------------------------------------------- 1. preflight
stage preflight
[ "$(uname -s)" = Darwin ] || die "the local release runs on macOS (it signs and notarizes the darwin archive)"
for tool in git gh jq python3 bun shasum codesign xcrun security spctl ditto plutil openssl curl tar timeout; do
	command -v "$tool" >/dev/null || die "missing tool: $tool"
done
if [ "$DRY_RUN" = 0 ] && [ "$INSTALL" = 1 ]; then
	[ -x "$INSTALL_PREFIX/bin/omp-kit" ] || die "install requires the existing kit at $INSTALL_PREFIX/bin/omp-kit (or --no-install)"
	[ -f "$ROOT/skills/fleet-restart/scripts/fleet_restart.py" ] || die "fleet align readback helper is missing"
	# RELPENDING1 (ompkit-fp72.120.16.227): an unreconciled receipt from a previous install makes the install stage's
	# `omp-kit update --apply` refuse PENDING_RECOVERY only after build, sign and publish (0.2.89: 34 min, published but
	# never installed). Read the file the updater reads: cli.ts receiptStateRoot (XDG_STATE_HOME, or HOME/.local/state
	# when unset, both absolute) + /omp-kit, and mutations.ts updatePendingPath. Read only: never reconcile from here.
	kit_state_home="${XDG_STATE_HOME-${HOME:-}/.local/state}"
	[[ "${HOME:-}" == /* && "$kit_state_home" == /* ]] ||
		die "install requires an absolute HOME and XDG_STATE_HOME (or XDG_STATE_HOME unset), as omp-kit update does"
	kit_pending="$kit_state_home/omp-kit/kit-update.pending.json"
	if [ -e "$kit_pending" ] || [ -L "$kit_pending" ]; then
		pending_id="$(jq -er '.id | select(type == "string" and test("^[a-f0-9-]{1,128}$"))' "$kit_pending" 2>/dev/null)" || pending_id=''
		pending_warning="reconcile only a false PARTIAL whose postimages verify; nothing was built and nothing was changed"
		[ -n "$pending_id" ] || die "RELPENDING1: pending kit update receipt $kit_pending is unreadable (no valid id), so the install stage would refuse PENDING_RECOVERY after publishing; inspect it, then run omp-kit update --reconcile <id> --yes ($pending_warning)"
		die "RELPENDING1: a previous kit update left pending recovery receipt $pending_id ($kit_pending), so the install stage would refuse PENDING_RECOVERY after publishing; first run: omp-kit update --reconcile $pending_id --yes ($pending_warning)"
	fi
fi
# Probe the newly used curl features locally, before a tag or draft can exist.
curl_capability="$(bounded 10 curl -fsS --parallel -o /dev/null --write-out '%{exitcode}' file:///dev/null)" ||
	die "curl 7.75+ with parallel transfers and write-out exitcode is required"
[ "$curl_capability" = 0 ] || die "curl 7.75+ with write-out exitcode is required"
bounded 60 gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not authenticated to github.com"
# RELFAILFAST1 (ompkit-fp72.120.16.104, Joshua J-2026-11-03-34: fail fast on big gates). The ci-only stage runs the
# packaged ladder through `omp-kit heavy`; when heavy work cannot be admitted (disk, load, slots) it waits queued
# until package-release.test.ts hits its 900 s budget (0.2.86 dry run, 2026-11-03). Ask the same gate now, in seconds.
# The probe uses the observer that stage uses (statfs, keeping heavy's 10 GiB floor; ompkit-fp72.120.16.154/.155): an
# sbh pressure reading the ci-only stage never consults must not refuse a release that stage would admit.
if command -v omp-kit >/dev/null; then
	admit_rc=0
	admit_out="$(OMP_KIT_DISK_OBSERVER=statfs bounded 60 omp-kit heavy --no-wait --label release-preflight -- true 2>&1)" || admit_rc=$?
	[ "$admit_rc" -ne 75 ] || die "heavy work cannot be admitted now, so the ci-only stage would time out queued; fix this first: $(printf '%s' "$admit_out" | tail -n 3)"
	[ "$admit_rc" -eq 0 ] || die "heavy admission probe failed (rc $admit_rc): $(printf '%s' "$admit_out" | tail -n 3)"
else
	echo "release-local: no omp-kit on PATH; heavy admission probe skipped" >&2
fi
bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || die "git fetch origin main failed"
MAIN="$(git -C "$ROOT" rev-parse refs/remotes/origin/main)"
PREPARE=0
if [ -z "$SOURCE" ]; then PREPARE=1
else
	git -C "$ROOT" cat-file -e "$SOURCE^{commit}" 2>/dev/null || die "source $SOURCE is not a known commit"
	git -C "$ROOT" merge-base --is-ancestor "$SOURCE" "$MAIN" || die "source $SOURCE is not on origin/main"
fi
remote_tags="$(bounded 120 git -C "$ROOT" ls-remote --tags origin)" || die "git ls-remote --tags failed"
if [ -z "$VERSION" ]; then
	if [ "$PREPARE" = 1 ] || [ "$NEXT" = 1 ]; then
		# NEXTVERSION1: origin/main states the version it ships as; add one only when that version is already
		# tagged (the bootstrap from the bump-before-tag order, which then needs its own prepare commit).
		main_version="$(git -C "$ROOT" show "$MAIN:package.json" | jq -er .version)" || die "cannot read origin/main package.json version"
		if grep -q "refs/tags/v$main_version\$" <<<"$remote_tags"; then
			VERSION="$(python3 -c 'import sys; a, b, c = map(int, sys.argv[1].split(".")); print(f"{a}.{b}.{c + 1}")' "$main_version")" ||
				die "cannot derive next patch version"
		else VERSION="$main_version"; fi
	else
		VERSION="$(printf '%s\n' "$remote_tags" | (cd "$ROOT" && sh scripts/release-train.sh next-version --changelog-ref "$SOURCE"))" ||
			die "release-train.sh next-version failed"
	fi
fi
grep -q "refs/tags/v$VERSION\$" <<<"$remote_tags" && die "tag v$VERSION already exists on origin; never re-tag a version"
bounded 120 gh api --paginate --slurp "repos/$REPO/releases?per_page=100" >"$WORK/releases.json" || die "listing releases failed"
[ "$(jq --arg t "v$VERSION" '[.[][] | select(.tag_name == $t)] | length' "$WORK/releases.json")" = 0 ] ||
	die "a release or draft for v$VERSION already exists"
BASE_TAG="$(jq -r '[.[][] | select(.draft == false and .prerelease == false) | .tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))]
	| sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last // ""' "$WORK/releases.json")"
[ -n "$BASE_TAG" ] || die "no published base release"
python3 -c 'import sys; a, b = (tuple(map(int, v.split("."))) for v in sys.argv[1:]); sys.exit(0 if a > b else 1)' "$VERSION" "${BASE_TAG#v}" ||
	die "v$VERSION is not newer than the latest published $BASE_TAG"
# NEXTVERSION1: when origin/main already states this unpublished version, tag it as is; no prepare commit.
if [ "$PREPARE" = 1 ] && git -C "$ROOT" show "$MAIN:package.json" | jq -e --arg v "$VERSION" '.version == $v' >/dev/null; then
	PREPARE=0; SOURCE="$MAIN"
	say "origin/main $MAIN already states $VERSION; tagging it with no prepare commit"
fi
if [ "$PREPARE" = 1 ]; then prepare_release; fi
# Explicit --source remains the immutable resume/preview path.
sh "$ROOT/scripts/release-train.sh" version-match --version "$VERSION" --sha "$SOURCE" --repo "$ROOT" ||
	die "package.json version does not match v$VERSION at $SOURCE"
MODE="$(git -C "$ROOT" show "$SOURCE:scripts/release-signing.json" | jq -er 'select(.schema_version == 1) | .darwin_signing')" ||
	die "source has no valid scripts/release-signing.json"
if [ "$MODE" != developer-id ]; then
	[ "$DRY_RUN" = 1 ] || die "source darwin_signing is '$MODE'; a local release requires developer-id"
	echo "release-local: dry-run continues although source darwin_signing is '$MODE'" >&2
fi
git -C "$ROOT" show "$SOURCE:.github/workflows/release.yml" | grep -q '^  attest-local:$' ||
	die "source release.yml has no attest-local job (LOCAL-RELEASE-V1)"
say "source $SOURCE (origin/main $MAIN) version $VERSION base $BASE_TAG mode $MODE"

stage source
SRC="$WORK/src"
mkdir -p "$SRC" "$WORK/tmp" "$WORK/build"
# Check the exact main tree's PASS before unlocking the signing keychain.
git -C "$ROOT" archive --format=tar "$SOURCE" >"$WORK/source.tar"
tar -xf "$WORK/source.tar" -C "$SRC"
rm -f "$WORK/source.tar"
[ "$(jq -r .source_revision "$SRC/package.json")" = "$SOURCE" ] || die "export did not stamp source_revision"
[ "$(bun --version)" = "$(tr -d '[:space:]' <"$SRC/.bun-version")" ] || die "bun $(bun --version) differs from the source's pinned .bun-version"
source_tree="$(git -C "$ROOT" rev-parse "$SOURCE^{tree}")" || die "cannot resolve exact source tree"
# The verdict producer may return 0 when a different run holds its lock. Never
# confuse that queue acknowledgement with PASS: wait on both exact-tree records.
stage verdict
if ! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" >/dev/null 2>&1 ||
	! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-ci-only-pass \
	--repo "$ROOT" --tree "$source_tree" --judge-root "$SRC" --suite-root "$SRC" >/dev/null 2>&1; then
	bounded 7200 sh "$ROOT/scripts/release-verdict.sh" --commit "$SOURCE" --no-fetch ||
		die "release verdict failed for prepare $SOURCE"
	# VERDICTSTARVE1 (ompkit-fp72.120.16.198): while another run holds its lock, release-verdict.sh writes SOURCE to its
	# one-slot queue (release-verdict.wanted, latest wins) and returns 0. A push before the holder reaches SOURCE
	# overwrites the slot and the holder never judges SOURCE (0.2.88: 13.6 min of polling until killed). Each poll reads
	# the slot, then the commit the holder's runner children judge (--commit of full-suite-verdict.sh / run-ci-only),
	# then the verdicts, so a verdict recorded before the holder moved on is always seen. SOURCE is starved once the
	# holder is gone, or judges another commit while the slot no longer holds SOURCE: it then judges only the slot.
	# Bound: the next poll after that state appears stops the stage, i.e. within slot/pid reads + ps (10 s) + two
	# verdict reads (30 s each) + sleep 3 <= 73 s; while SOURCE is queued or judged the 7200 s deadline still applies.
	rv_state="$(git -C "$ROOT" rev-parse --absolute-git-dir)/omp-kit" || die "cannot resolve the release-verdict state of $ROOT"
	verdict_fix="produce it with: sh scripts/release-verdict.sh --commit $SOURCE --no-fetch (it queues $SOURCE while another run holds the lock), then resume: scripts/release-local.sh --source $SOURCE --version $VERSION"
	verdict_deadline=$(( $(date +%s) + 7200 ))
	verdict_seen=''
	# The first --commit of a direct child of the holder that is its full-suite runner or its ci-only judge.
	# shellcheck disable=SC2016 # an awk program, not shell expansions
	rv_children_awk='$1 == holder && !found && /full-suite-verdict\.sh |full-suite-verdict-store\.py run-ci-only / { for (i = 2; i < NF; i++) { j = i + 1; if ($i == "--commit" && $j ~ /^[0-9a-f]+$/) { print $j; found = 1; break } } }'
	while :; do
		rv_wanted="$(cat "$rv_state/release-verdict.wanted" 2>/dev/null)" || rv_wanted=''
		rv_holder="$(cat "$rv_state/release-verdict.lock/pid" 2>/dev/null)" || rv_holder=''
		[[ "$rv_holder" =~ ^[1-9][0-9]*$ ]] && kill -0 "$rv_holder" 2>/dev/null || rv_holder=''
		rv_judging=''
		if [ -n "$rv_holder" ]; then
			rv_judging="$(bounded 10 ps -A -o ppid= -o command= | awk -v holder="$rv_holder" "$rv_children_awk")" || rv_judging=''
		fi
		main_result="$(bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
			--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC")" || true
		ci_result="$(bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-ci-only-pass \
			--repo "$ROOT" --tree "$source_tree" --judge-root "$SRC" --suite-root "$SRC")" || true
		if [ "$main_result" = FAIL ] || [ "$ci_result" = FAIL ]; then die "release verdict FAIL for exact prepare $SOURCE"; fi
		[ "$main_result" != PASS ] || [ "$ci_result" != PASS ] || break
		verdict_now="release-verdict run ${rv_holder:-none} judges ${rv_judging:-unknown}; queued next ${rv_wanted:-none}"
		[ "$verdict_now" = "$verdict_seen" ] || { say "verdict wait for $SOURCE: $verdict_now"; verdict_seen=$verdict_now; }
		[ -n "$rv_holder" ] ||
			die "VERDICT_STARVED: no release-verdict run holds the lock and prepare $SOURCE has no verdict (main ${main_result:-none}, ci-only ${ci_result:-none}); $verdict_fix"
		if [ -n "$rv_judging" ] && [ "$rv_judging" != "$SOURCE" ] && [ "$rv_wanted" != "$SOURCE" ]; then
			die "VERDICT_STARVED: release-verdict run $rv_holder judges $rv_judging and queues ${rv_wanted:-nothing} next, so it skips prepare $SOURCE; $verdict_fix"
		fi
		[ "$(date +%s)" -lt "$verdict_deadline" ] || die "timed out waiting for exact prepare verdict $SOURCE"
		sleep 3
	done
fi
if ! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" \
	>"$WORK/full-suite-verdict.out"; then
	verdict_result="$(cat "$WORK/full-suite-verdict.out")"
	die "source tree $source_tree has no reusable main-role full-suite PASS ($verdict_result)"
fi
[ "$(cat "$WORK/full-suite-verdict.out")" = PASS ] || die "source tree $source_tree full-suite readback is not PASS"
say "full-suite verdict $source_tree: PASS (main role)"
# CIONLY1 (Joshua J-2026-11-03-34/35: a full release in under 4 minutes, failing fast). The local gate-ci-only.tsv
# files (package-release, kit-update and their split live journeys; full-suite-verdict-store.py CI_ONLY_FILES) are
# kept out of the full suite and run by release-verdict.sh at push time, on a git-initialized export of the exact
# commit, and recorded for its tree. The cut never runs them: it requires that recorded PASS here, in seconds,
# before build, sign and notarize, and refuses with the producer command.
ci_only_status=0
bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-ci-only-pass \
	--repo "$ROOT" --tree "$source_tree" --judge-root "$SRC" --suite-root "$SRC" \
	>"$WORK/ci-only-verdict.out" 2>"$WORK/ci-only-verdict.err" || ci_only_status=$?
if [ "$ci_only_status" != 0 ] || [ "$(cat "$WORK/ci-only-verdict.out")" != PASS ]; then
	die "source tree $source_tree has no push-time ci-only PASS ($(head -n 1 "$WORK/ci-only-verdict.out") $(head -n 1 "$WORK/ci-only-verdict.err")); produce it with: sh scripts/release-verdict.sh --commit $SOURCE"
fi
say "ci-only verdict $source_tree: PASS (push time)"

[ -f "$KEYCHAIN" ] || die "signing keychain $KEYCHAIN not found"
# The password is read in-process by devid_release.py and never reaches argv, stdout or a log.
bounded 60 python3 "$ROOT/scripts/devid_release.py" keychain-unlock --keychain "$KEYCHAIN" --password-file "$KEYCHAIN_PASSWORD" >/dev/null ||
	die "could not unlock $KEYCHAIN"
UNLOCKED=1
identities="$(bounded 60 security find-identity -v -p codesigning "$KEYCHAIN")"
if [ -n "${OMP_KIT_DEVID_SHA1:-}" ]; then
	SHA1="$OMP_KIT_DEVID_SHA1"
	[[ "$SHA1" =~ ^[0-9A-F]{40}$ ]] || die "OMP_KIT_DEVID_SHA1 must be 40 upper-case hex digits"
	grep -Fq "$SHA1 \"$AUTHORITY\"" <<<"$identities" || die "identity $SHA1 is not a valid '$AUTHORITY'"
else
	matches="$(grep -F "\"$AUTHORITY\"" <<<"$identities" | awk '{print $2}' | sort -u)"
	[ -n "$matches" ] || die "no valid '$AUTHORITY' codesigning identity in $KEYCHAIN"
	[ "$(wc -l <<<"$matches" | tr -d ' ')" = 1 ] || die "several '$AUTHORITY' identities; select one with OMP_KIT_DEVID_SHA1"
	SHA1="$matches"
fi
bounded 60 security find-certificate -a -Z -p -c "$AUTHORITY" "$KEYCHAIN" | awk -v want="$SHA1" '
	/^SHA-1 hash:/ { keep = ($3 == want); next }
	keep && /-----BEGIN CERTIFICATE-----/ { pem = 1 }
	pem { print }
	pem && /-----END CERTIFICATE-----/ { exit }' >"$WORK/identity.pem"
[ -s "$WORK/identity.pem" ] || die "certificate $SHA1 not found"
openssl x509 -noout -checkend 0 -in "$WORK/identity.pem" >/dev/null || die "'$AUTHORITY' ($SHA1) has expired"
openssl x509 -noout -checkend $((30 * 24 * 60 * 60)) -in "$WORK/identity.pem" >/dev/null ||
	echo "release-local: WARNING: the signing certificate expires within 30 days" >&2
bounded 120 xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN" --output-format json >"$WORK/notary-history.json" ||
	die "notarytool history failed for keychain profile '$NOTARY_PROFILE'"
say "identity $SHA1 ($AUTHORITY); notary profile $NOTARY_PROFILE proven"

# -------------------------------------------------------------------------------------------------- 2. build
stage build
for platform in "${SHIP[@]}"; do
	mkdir -p "$WORK/build/$platform"
	TMPDIR="$WORK/tmp" bounded 900 sh "$SRC/scripts/package-release.sh" --version "$VERSION" --platform "$platform" \
		--out "$WORK/build/$platform" >"$WORK/build/$platform/asset.json" || die "package-release failed for $platform"
	say "built $platform $(jq -r '.filename + " sha256:" + .sha256' "$WORK/build/$platform/asset.json")"
done
mkdir -p "$WORK/unsigned"
python3 - "$WORK" "$VERSION" "${SHIP[@]}" <<'PY'
import json, sys
from pathlib import Path
work, version, platforms = Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
assets = {p: json.loads((work / "build" / p / "asset.json").read_text()) for p in platforms}
# devid_release.py canonical_json (the published index's exact form): sorted keys, compact separators, one newline.
with open(work / "unsigned" / "release-index.json", "x", encoding="utf-8") as out:
    out.write(json.dumps({"schema_version": 1, "version": version, "source_tag": "v" + version, "assets": assets},
                         sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
PY
for platform in "${SHIP[@]}"; do
	python3 -I "$SRC/installer/install.py" inspect "$WORK/unsigned/release-index.json" "$VERSION" "$platform" >/dev/null ||
		die "installer parser refuses the unsigned $platform index entry"
	python3 "$SRC/scripts/release_reuse.py" verify-archive --index "$WORK/unsigned/release-index.json" \
		--platform "$platform" --archive-dir "$WORK/build/$platform" >/dev/null || die "$platform archive differs from its index entry"
done

# --------------------------------------------------------------------------------------------------- 3. sign
stage sign
DARWIN="omp-kit-v$VERSION-darwin-arm64-none.tar"
UNSIGNED_DARWIN="$WORK/build/darwin-arm64-none/$DARWIN"
ENTITLEMENTS="$SRC/packaging/macos/omp-kit.entitlements.plist"
plutil -lint "$ENTITLEMENTS" >/dev/null || die "the source's entitlements plist is invalid"
bounded 300 python3 "$SRC/scripts/devid_release.py" prepare --archive "$UNSIGNED_DARWIN" \
	--index "$WORK/unsigned/release-index.json" --version "$VERSION" --out "$WORK/signed" >"$WORK/prepare.json" || die "devid prepare failed"
while read -r path identifier; do
	bounded 300 codesign --force --keychain "$KEYCHAIN" --sign "$SHA1" --options runtime --timestamp --identifier "$identifier" \
		--entitlements "$ENTITLEMENTS" "$WORK/signed/$path" || die "codesign failed for $path"
	bounded 120 codesign --verify --strict "$WORK/signed/$path" || die "codesign --verify failed for $path"
	say "signed $path as $identifier"
done < <(jq -r '.members[] | "\(.path) \(.identifier)"' "$WORK/prepare.json")
mkdir "$WORK/out"
bounded 300 python3 "$SRC/scripts/devid_release.py" repack --archive "$UNSIGNED_DARWIN" --index "$WORK/unsigned/release-index.json" \
	--version "$VERSION" --signed-dir "$WORK/signed" --out-archive "$WORK/out/$DARWIN" --out-index "$WORK/out/release-index.json" >"$WORK/repack.json" ||
	die "devid repack failed"
bounded 300 python3 "$SRC/scripts/devid_release.py" verify --qualified-archive "$UNSIGNED_DARWIN" \
	--qualified-index "$WORK/unsigned/release-index.json" --signed-archive "$WORK/out/$DARWIN" --version "$VERSION" \
	--entitlements "$ENTITLEMENTS" --no-notarization >/dev/null || die "the signed archive does not verify"
ditto -c -k --keepParent "$WORK/signed" "$WORK/notarize.zip"
bounded 2100 xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN" --wait --timeout 30m \
	--output-format json >"$WORK/notary.json" || true
NOTARY_ID="$(jq -r '.id // ""' "$WORK/notary.json" 2>/dev/null || true)"
NOTARY_STATUS="$(jq -r '.status // ""' "$WORK/notary.json" 2>/dev/null || true)"
if [ "$NOTARY_STATUS" != Accepted ]; then
	[ -z "$NOTARY_ID" ] || bounded 300 xcrun notarytool log "$NOTARY_ID" --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN" >&2 || true
	die "notarization ended '${NOTARY_STATUS:-no status}' (submission ${NOTARY_ID:-none})"
fi
say "notarized: submission $NOTARY_ID"
bounded 600 python3 "$SRC/scripts/devid_release.py" verify --qualified-archive "$UNSIGNED_DARWIN" \
	--qualified-index "$WORK/unsigned/release-index.json" --signed-archive "$WORK/out/$DARWIN" --version "$VERSION" \
	--entitlements "$ENTITLEMENTS" --execute --index-out "$WORK/out/release-index.verified.json" >"$WORK/verify.json" ||
	die "the notarized archive does not verify"
cmp -s "$WORK/out/release-index.json" "$WORK/out/release-index.verified.json" || die "repacked and verified indexes differ"
say "verified: $(jq -c '.signed' "$WORK/verify.json")"
security lock-keychain "$KEYCHAIN" </dev/null || echo "release-local: WARNING: could not re-lock $KEYCHAIN" >&2
UNLOCKED=0

# ----------------------------------------------------------------------------------------------- 4. checksum
stage checksum
DIST="$WORK/dist"
mkdir "$DIST"
cp "$WORK/out/release-index.json" "$DIST/release-index.json"
cp "$WORK/out/$DARWIN" "$DIST/$DARWIN"
for platform in linux-arm64-gnu linux-x64-gnu; do cp "$WORK/build/$platform/omp-kit-v$VERSION-$platform.tar" "$DIST/"; done
for platform in "${SHIP[@]}"; do
	python3 -I "$SRC/installer/install.py" inspect "$DIST/release-index.json" "$VERSION" "$platform" >/dev/null || die "final index refuses $platform"
	python3 "$SRC/scripts/release_reuse.py" verify-archive --index "$DIST/release-index.json" --platform "$platform" --archive-dir "$DIST" >/dev/null ||
		die "final $platform archive differs from the final index"
done
(cd "$DIST" && shasum -a 256 release-index.json omp-kit-v"$VERSION"-*.tar >SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || die "SHA256SUMS failed"
cat "$DIST/SHA256SUMS"
(cd "$ROOT" && bounded 300 sh "$SRC/scripts/release-notes.sh" source --base-tag "$BASE_TAG" --head "$SOURCE" --version "$VERSION" \
	--output "$WORK/release-notes.md") || die "release-notes.sh source failed"

# ----------------------------------------------------------------- 4b. rule gate
# The kit-update postcheck runs this same ttsr coverage gate and bundled selftest
# against the installed pack. Refuse here, before the tag, in both dry-run and
# real runs, so a release cannot pass while its postcheck would fail.
stage rule-gate
bounded 600 bun "$SRC/scripts/ttsr-harness.ts" --gate-json --rules "$SRC/rules" \
	--cases "$SRC/cases/cases.tsv" >"$WORK/rule-gate.json" 2>"$WORK/rule-gate.stderr" ||
	die "ttsr-harness --gate-json failed on the release source; refusing release (see $WORK/rule-gate.stderr)"
[ "$(jq -er '.status' "$WORK/rule-gate.json")" = PASS ] ||
	die "ttsr coverage gate FAIL on the release source: $(jq -c '.failures' "$WORK/rule-gate.json")"
say "rule gate PASS: $(jq -c '.counts' "$WORK/rule-gate.json")"

bounded 600 bun "$SRC/scripts/ttsr-harness.ts" --selftest >"$WORK/rule-selftest.stdout" 2>"$WORK/rule-selftest.stderr" ||
	die "ttsr-harness --selftest failed on the release source; refusing release (see $WORK/rule-selftest.stderr)"
say "rule selftest PASS"


receipt() {
	local phase=$1 url=${2:-} run_id=${3:-}
	stage ''
	KITLIB_TMP_AUTO_CLEANUP=0 kitlib_tmp RECEIPT_DIR release-receipt
	say "receipt $RECEIPT_DIR/release-local-v$VERSION-$phase.json"
	python3 - "$STAGE_LOG" "$DIST/SHA256SUMS" "$phase" "$VERSION" "$SOURCE" "$BASE_TAG" "$NOTARY_ID" "$url" "$run_id" \
		"$(( $(date +%s) - STARTED ))" "$RECEIPT_DIR/release-local-v$VERSION-$phase.json" "$TAG_PUSH_SECONDS" \
		"${PUSH_STARTED:+$(( ${RELEASED_AT:-$(date +%s)} - ${PUSH_STARTED:-0} ))}" \
		"$INSTALLED" "${PUSH_STARTED:+$(( $(date +%s) - ${PUSH_STARTED:-0} ))}" <<'PY'
import json, sys
stages, sums, phase, version, source, base, notary, url, run_id, total, out, tag_push_seconds, push_to_released, installed, push_to_endpoint = sys.argv[1:]
doc = {"schema_version": 1, "phase": phase, "version": version, "source_sha": source, "base_tag": base,
       "notarization_submission": notary, "release_url": url or None, "attest_run_id": run_id or None,
       "sha256": {name: digest for digest, name in (line.split("  ", 1) for line in open(sums).read().splitlines())},
       "stage_seconds": {name: int(secs) for name, secs in (line.split() for line in open(stages).read().splitlines())},
       "total_seconds": int(total),
       "tag_push_seconds": int(tag_push_seconds) if tag_push_seconds else None,
       "push_to_released_seconds": int(push_to_released) if push_to_released else None,
       "installed": installed == "1",
       "push_to_installed_seconds": int(push_to_endpoint) if installed == "1" and push_to_endpoint else None}
text = json.dumps(doc, indent=2, sort_keys=True) + "\n"
open(out, "w", encoding="utf-8").write(text)
print(text, end="")
PY
}

if [ "$DRY_RUN" = 1 ]; then
	# shellcheck disable=SC2012 # display-only listing of dist filenames
	say "dry run: would tag v$VERSION -> $SOURCE, draft with $(ls "$DIST" | tr '\n' ' '), dispatch release.yml mode=local-attest at v$VERSION"
	receipt dry-run
	exit 0
fi

# NEXTVERSION1 (ompkit-d8qic; Maven release:prepare "prepare for next development iteration"): after vVERSION is
# public, shared main moves to the next patch in one commit that also promotes the vVERSION CHANGELOG section and
# stamps README's release line to vVERSION (the latest published release), so the next cut tags an already-green
# origin commit with no bump commit. Only fragments present at the tagged source are folded; later fragments stay
# in changelog.d/ for the next release. It runs only after the public verify stage, so a run that fails earlier
# (build, sign, tag, draft, attest, verify) commits nothing, and after the install stage, so the commit is judged by
# the hooks of the kit it just installed: the previously installed readme-check would refuse README vVERSION beside
# package.json NEXT. Hooks are never bypassed; with --no-install the commit is still attempted, and a refusal names
# the install that unblocks it.
# The commit is made on the shared main in the canonical checkout (AGENTS.md: no branches, no worktrees) with
# `git commit --only`, exactly like the prepare stage. The new bytes are computed in an owned scratch export of HEAD,
# because release-notes.sh promote folds every fragment it finds and the checkout may hold peers' fragments. Every
# written path must be clean first (NEXT_VERSION_PATHS_DIRTY). Publication is a plain push when it fast-forwards
# origin, else git_converge.py --push (OMP_KIT_GIT_CONVERGE overrides its path).
advance_next_version() {
	stage next-version
	local next agent export="$WORK/next" date promote_rc path dirty manual
	local converge="${OMP_KIT_GIT_CONVERGE:-$HOME/Developer/omp-kit/scripts/git_converge.py}"
	local -a fragments=() paths=(package.json README.md CHANGELOG.md)
	next="$(python3 -c 'import sys; a, b, c = map(int, sys.argv[1].split(".")); print(f"{a}.{b}.{c + 1}")' "$VERSION")"
	date="$(date -u +%Y-%m-%d)"
	agent="${AGENT_NAME:-$(git -C "$ROOT" config user.name)}"
	[ "$(git -C "$ROOT" symbolic-ref --short HEAD)" = main ] || die "v$VERSION is published; NEXT_VERSION_NOT_MAIN: $ROOT is not on main"
	bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' ||
		die "v$VERSION is published; next-version fetch failed"
	if ! git -C "$ROOT" merge-base --is-ancestor "$SOURCE" HEAD; then
		# The cut source is on origin but not yet in the shared main (a no-prepare cut of origin/main): integrate first.
		bounded 900 python3 "$converge" --repo "$ROOT" --apply ||
			die "v$VERSION is published; NEXT_VERSION_CONVERGE_FAILED: shared main lacks $SOURCE and $converge --repo $ROOT --apply refused"
	fi
	# Fold exactly the fragments the tagged source shipped that main still holds.
	while IFS= read -r path; do
		git -C "$ROOT" cat-file -e "HEAD:$path" 2>/dev/null && fragments+=("$path")
	done < <(git -C "$ROOT" ls-tree --name-only "$SOURCE" -- changelog.d/)
	paths+=(${fragments[@]+"${fragments[@]}"})
	manual="make the commit by hand on main: in an owned scratch copy of HEAD's package.json, README.md, CHANGELOG.md, scripts/ and only these fragments [${fragments[*]:-none}], run sh scripts/release-notes.sh promote --version $VERSION --date $date --write, set package.json .version and .omp.version to $next, run sh scripts/stamp-release-line.sh --version $VERSION; copy the three files into $ROOT, delete the folded fragments there, then git commit --only -- ${paths[*]} and git push origin main (python3 $converge --repo $ROOT --push when origin moved)"
	dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${paths[@]}")" || die "v$VERSION is published; cannot inspect the next-version paths"
	[ -z "$dirty" ] || die "v$VERSION is published; NEXT_VERSION_PATHS_DIRTY: ${dirty//$'\n'/; }; nothing was written. Once those paths are clean, $manual"
	rm -rf "$export"; mkdir -p "$export"
	git -C "$ROOT" archive HEAD -- package.json README.md CHANGELOG.md scripts/release-notes.sh scripts/release-notes.ts \
		scripts/stamp-release-line.sh scripts/kitlib-tmp.sh ${fragments[@]+"${fragments[@]}"} | tar -xf - -C "$export" ||
		die "v$VERSION is published; cannot export the next-version inputs"
	# release-notes.sh resolves its root through git; the export is a private scratch repository, never a worktree.
	git -C "$export" init -q || die "v$VERSION is published; cannot prepare the next-version export"
	promote_rc=0
	(cd "$export" && bounded 300 sh scripts/release-notes.sh promote --version "$VERSION" --date "$date" --write) || promote_rc=$?
	[ "$promote_rc" = 0 ] || [ "$promote_rc" = 4 ] || die "v$VERSION is published; CHANGELOG promote failed (rc $promote_rc)"
	python3 - "$export/package.json" "$next" <<'PY'
import json, re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
updated, count = re.subn(r'(?m)^([ \t]*"version"\s*:\s*)"[^"\n]*"', lambda m: m[1] + json.dumps(version), text)
doc = json.loads(updated)
if count != 2 or doc["version"] != version or doc["omp"]["version"] != version:
    raise SystemExit("release-local: package.json must carry exactly .version and .omp.version")
open(path, "w", encoding="utf-8").write(updated)
PY
	# README states the latest published release (vVERSION); readme-check accepts it beside package.json's next patch
	# only while tag vVERSION exists, which the tag stage of this run created.
	bounded 60 sh "$export/scripts/stamp-release-line.sh" --version "$VERSION" --readme "$export/README.md" >/dev/null ||
		die "v$VERSION is published; cannot stamp the README release line"
	for path in package.json README.md CHANGELOG.md; do cp "$export/$path" "$ROOT/$path"; done
	for path in ${fragments[@]+"${fragments[@]}"}; do [ -e "$export/$path" ] || rm -f "$ROOT/$path"; done
	rm -rf "$export"
	if ! bounded 900 git -C "$ROOT" commit -q --only \
		-m "chore(release): next version $next after v$VERSION ompkit-d8qic" \
		-m "NEXTVERSION1: v$VERSION is published from $SOURCE; main now states $next so the next cut tags a green origin commit with no bump commit. CHANGELOG [$VERSION] holds the notes folded from the fragments present at $SOURCE; README states v$VERSION, the latest published release." \
		-m "[no-changelog] release next-version commit; its notes are the promoted CHANGELOG section" \
		-m "Gap-Bead: none (release metadata)
Bead: ompkit-d8qic
Agent: $agent" -- "${paths[@]}"; then
		# Only this step's own bytes are put back: every path was clean before it wrote them.
		git -C "$ROOT" checkout HEAD -- "${paths[@]}" || echo "release-local: WARNING: could not restore ${paths[*]} in $ROOT" >&2
		if [ "$INSTALLED" = 1 ]; then die "v$VERSION is published; the next-version commit for $next was refused by the installed v$VERSION commit hooks (see above); once fixed, $manual"
		else die "v$VERSION is published but not installed (--no-install); the previously installed commit hooks refused the next-version commit for $next (an older readme-check refuses README v$VERSION beside package.json $next). Install it with: $INSTALL_PREFIX/bin/omp-kit update --apply --yes --version $VERSION, then $manual"; fi
	fi
	NEXT_SHA="$(git -C "$ROOT" rev-parse HEAD)"
	bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || die "next-version commit $NEXT_SHA made; fetch before publishing failed"
	if git -C "$ROOT" merge-base --is-ancestor refs/remotes/origin/main HEAD; then
		bounded 900 git -C "$ROOT" -c push.followTags=false push --porcelain origin main ||
			die "next-version commit $NEXT_SHA is on local main; NEXT_VERSION_PUSH_FAILED: publish it with git push origin main"
	else
		[ -f "$converge" ] || die "next-version commit $NEXT_SHA is on local main and origin moved; NEXT_VERSION_CONVERGE_MISSING: $converge (set OMP_KIT_GIT_CONVERGE)"
		bounded 1800 python3 "$converge" --repo "$ROOT" --push --expect-head "$NEXT_SHA" ||
			die "next-version commit $NEXT_SHA is on local main and origin moved; NEXT_VERSION_CONVERGE_FAILED: publish it with python3 $converge --repo $ROOT --push"
	fi
	bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || die "next-version readback fetch failed"
	git -C "$ROOT" merge-base --is-ancestor "$NEXT_SHA" refs/remotes/origin/main || die "next-version commit $NEXT_SHA is not on origin/main"
	say "next version $next committed to main: $NEXT_SHA"
}

# VERSIONSRC1 (ompkit-fp72.135.1.14): the tagged source must state the
# release version in package.json; a mismatch refuses the tag, never a
# silent mislabel.
sh "$ROOT/scripts/release-train.sh" version-match --version "$VERSION" --sha "$SOURCE" --repo "$ROOT" || die "package.json version does not match v$VERSION at $SOURCE; refusing tag"
# ----------------------------------------------------------------------------------------------------- 5. tag
stage tag
remote_tags="$(bounded 120 git -C "$ROOT" ls-remote --tags origin "refs/tags/v$VERSION")" || die "tag lookup failed"
[ -z "$remote_tags" ] || die "tag v$VERSION appeared during the build; never re-tagged"
# This transport includes every unchanged local pre-push hook, not just the network.
# 360s focused selection + 180s machinery + 180s checker contracts + 60s cached
# full-verdict readback + 120s margin = 900s. The selected pre-push fixture alone
# took 119s, so the old 120s transport cap could not contain the mandatory work.
tag_push_started=$(date +%s)
bounded 900 git -C "$ROOT" -c push.followTags=false push --porcelain origin "$SOURCE:refs/tags/v$VERSION" || die "tag push failed"
TAG_PUSH_SECONDS=$(( $(date +%s) - tag_push_started ))
bounded 60 gh api "repos/$REPO/git/ref/tags/v$VERSION" >"$WORK/tag.json" || die "tag readback failed"
{ [ "$(jq -r .object.type "$WORK/tag.json")" = commit ] && [ "$(jq -r .object.sha "$WORK/tag.json")" = "$SOURCE" ]; } ||
	die "remote v$VERSION does not name $SOURCE"
bounded 300 git -C "$ROOT" fetch --quiet origin "tag" "v$VERSION" ||
	die "tag published but local launch-check tag fetch failed"
say "tagged v$VERSION -> $SOURCE"

# --------------------------------------------------------------------------------------------------- 6. draft
stage draft
substep draft.create-and-upload
bounded 1800 gh release create "v$VERSION" --repo "$REPO" --verify-tag --draft --title "v$VERSION" \
	--notes-file "$WORK/release-notes.md" "$DIST"/* || die "draft creation failed (tag v$VERSION exists; resume from the draft, never re-tag)"
substep draft.digest-readback
bounded 120 gh release view "v$VERSION" --repo "$REPO" --json isDraft,assets >"$WORK/draft.json" || die "draft readback failed"
[ "$(jq -r .isDraft "$WORK/draft.json")" = true ] || die "v$VERSION is not a draft"
for file in "$DIST"/*; do
	name="$(basename "$file")"
	[ "$(jq -r --arg n "$name" '.assets[] | select(.name == $n) | .digest' "$WORK/draft.json")" = "sha256:$(sha_of "$file")" ] ||
		die "draft asset $name is not the local bytes"
done
say "draft v$VERSION holds $(jq -r '[.assets[].name] | join(" ")' "$WORK/draft.json")"
substep ''

# -------------------------------------------------------------------------------------------------- 7. attest
stage attest
dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
substep attest.dispatch
bounded 120 gh workflow run release.yml --repo "$REPO" --ref "v$VERSION" -f version="$VERSION" -f mode=local-attest ||
	die "dispatching release.yml (mode=local-attest) failed; is the workflow enabled?"
substep attest.run-discovery
RUN_ID=''
for _ in $(seq 1 30); do
	RUN_ID="$(bounded 60 gh run list --repo "$REPO" --workflow release.yml --event workflow_dispatch --limit 20 \
		--json databaseId,displayTitle,createdAt --jq "[.[] | select(.createdAt >= \"$dispatched_at\" and (.displayTitle | startswith(\"attest-local $VERSION \")))] | .[0].databaseId // \"\"")" || RUN_ID=''
	[ -z "$RUN_ID" ] || break
	sleep 5
done
[ -n "$RUN_ID" ] || die "the attest-local run did not appear"
say "attest-local run https://github.com/$REPO/actions/runs/$RUN_ID"
substep attest.run-completion
deadline=$(( $(date +%s) + 1800 ))
while :; do
	state="$(bounded 60 gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion --jq '.status + " " + .conclusion')" || state='unknown '
	case "$state" in
		"completed success") break ;;
		completed*) bounded 120 gh run view "$RUN_ID" --repo "$REPO" --log-failed >&2 || true
			die "attest-local run $RUN_ID ended: $state (draft v$VERSION kept; fix and redispatch, never re-tag)" ;;
	esac
	[ "$(date +%s)" -lt "$deadline" ] || die "attest-local run $RUN_ID still '$state' after 30 min"
	sleep 3
done
substep attest.log-download
bounded 120 gh run view "$RUN_ID" --repo "$REPO" --log >"$WORK/attest.log" || true
grep -E 'CONSUMER_VERIFY=|PUBLISHED ' "$WORK/attest.log" | sed 's/^.*\(CONSUMER_VERIFY=\|PUBLISHED \)/\1/' || true
substep ''

# -------------------------------------------------------------------------------------------------- 8. verify
stage verify
PUB="$WORK/public"
mkdir "$PUB"
URL="https://github.com/$REPO/releases/tag/v$VERSION"
# One bounded curl owns every transfer, so cancellation still kills the whole
# download set. --fail-early prevents a later success from masking an HTTP or
# transport failure; per-operation write-out identifies the failing asset.
substep verify.public-downloads
download_args=(--parallel --parallel-max 5 --fail-early)
for name in SHA256SUMS release-index.json "$DARWIN" "omp-kit-v$VERSION-linux-arm64-gnu.tar" "omp-kit-v$VERSION-linux-x64-gnu.tar"; do
	[ "${#download_args[@]}" -eq 4 ] || download_args+=(--next)
	download_args+=(-fsSL --retry 3 -o "$PUB/$name" --write-out "$name"$'\t''%{time_total}'$'\t''%{exitcode}\n'
		"https://github.com/$REPO/releases/download/v$VERSION/$name")
done
download_rc=0
bounded 600 curl "${download_args[@]}" >"$WORK/public-downloads.tsv" || download_rc=$?
while IFS=$'\t' read -r name seconds result; do
	say "public download $name took ${seconds}s (curl $result)"
	[ "$result" = 0 ] || die "public download of $name failed (curl $result)"
done <"$WORK/public-downloads.tsv"
[ "$download_rc" -eq 0 ] || die "public downloads failed (curl $download_rc; see per-asset results above)"
substep verify.public-bytes-and-checksums
for file in "$DIST"/*; do
	name="$(basename "$file")"
	cmp -s "$PUB/$name" "$file" || die "public $name differs from the locally signed bytes"
done
(cd "$PUB" && shasum -a 256 -c SHA256SUMS) || die "public SHA256SUMS check failed"
for platform in "${SHIP[@]}"; do
	archive="$PUB/omp-kit-v$VERSION-$platform.tar"
	digest="$(sha_of "$archive")"
	substep "verify.attestation-fetch.$platform"
	# Exactly kit-update-job.ts pollPublishedRelease's fetch, then kit-update.ts authenticateUpdateArchive's verifier.
	bounded 120 gh api --hostname github.com "repos/$REPO/attestations/sha256:$digest" --jq '.attestations[].bundle | tojson' \
		>"$archive.sigstore.json" || die "no attestation bundle for $platform ($digest)"
	substep "verify.installer-verifier.$platform"
	bounded 180 python3 -I -c "$(cat "$SRC/installer/install.py")" attestation "$archive" "$VERSION" unused ||
		die "the consumer verifier refuses $platform"
	echo "CONSUMER_VERIFY=ok platform=$platform sha256=$digest"
done
substep verify.gatekeeper
mkdir "$PUB/x"
tar -xf "$PUB/$DARWIN" -C "$PUB/x" bin/omp-kit
codesign --verify --strict "$PUB/x/bin/omp-kit" || die "public darwin binary signature does not verify"
# A bare Mach-O is not an app to `--type execute`; this is devid_release.py check_signature's assessment.
spctl --assess --type open --context context:primary-signature -vv "$PUB/x/bin/omp-kit" 2>&1 | tee "$WORK/spctl.txt"
grep -q 'source=Notarized Developer ID' "$WORK/spctl.txt" || die "Gatekeeper does not report Notarized Developer ID"
substep ''
RELEASED_AT=$(date +%s)
if [ "$INSTALL" = 1 ]; then install_release; fi
advance_next_version
if [ "$INSTALLED" = 1 ]; then receipt installed "$URL" "$RUN_ID"
else receipt released "$URL" "$RUN_ID"; fi
