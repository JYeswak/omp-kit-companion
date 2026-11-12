#!/usr/bin/env bash
# scripts/release-local.sh: LOCAL-RELEASE-V1 (ompkit-v66l.27.11, J-2026-10-18-30), the dsr-style local release.
#
# Run on the signing Mac. It cuts one omp-kit release without the CI qualification pipeline:
#   1. prepare    NEXTVERSION1: origin/main already states the version; it is cut as is. Only when that version is
#                 already tagged (bootstrap): version metadata commit, publish main, then qualify its exact export.
#      preflight  --source resumes an exact origin/main commit; version must be unused (no tag/release/draft).
#                 Its exact tree must have a reusable main-role full-suite PASS before the signing keychain opens.
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
# Resume only the next-version advance of a published release: --advance-only --version X.Y.Z
# Resume a release stranded after its draft (tag and draft exist, attest failed):
#   --resume-from-draft --version X.Y.Z (adopts the tag and draft, re-dispatches attest, then verify/install/next-version)
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
ROOT="$(cd "$(/usr/bin/dirname "$0")/.." && pwd -P)"
# shellcheck source=scripts/fixed-env.sh
. "$ROOT/scripts/fixed-env.sh"
if [ -z "${BASH_VERSION:-}" ] || (set -o | grep -q '^posix[[:space:]]*on'); then
	echo "release-local: run it with bash (./scripts/release-local.sh), not sh" >&2
	exit 2
fi
set -euo pipefail

# RELSCRIPTCOPY1 (ompkit-1ra0d.187): a landing that edits this file while a release runs used to kill
# the running release with a bash syntax error, because bash reads this file incrementally. Copy this
# file into the caller's owned scratch and re-exec the copy exactly once (marker), preserving argv and
# exit status, so the running release never reads the checkout's file again.
if [ -z "${OMP_KIT_RELEASE_LOCAL_COPIED:-}" ]; then
	if [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR:-}" ]; then # tempsafe: reads only the caller's owned scratch path; the copy below creates no new temp root
		_rlc_dir="$TMPDIR/release-local-copy" # tempsafe: subdir of the caller's owned scratch, released with it
		/bin/mkdir -p "$_rlc_dir"
		_rlc_copy="$_rlc_dir/release-local.sh"
		/bin/cp -p "${BASH_SOURCE[0]}" "$_rlc_copy"
		OMP_KIT_RELEASE_LOCAL_COPIED=1 OMP_KIT_RELEASE_LOCAL_ROOT="$ROOT" exec /bin/bash "$_rlc_copy" ${1+"$@"}
	fi
elif [ -n "${OMP_KIT_RELEASE_LOCAL_ROOT:-}" ]; then
	ROOT="$OMP_KIT_RELEASE_LOCAL_ROOT"
fi
unset _rlc_dir _rlc_copy || true

REPO="${OMP_KIT_REPO:-JYeswak/omp-kit-companion}"
# Read-only probe exercises the same bootstrap as an actual cut, before any mutation.
if [ "${1:-}" = --check-env ]; then
	cd "$ROOT/scripts"
	exec python3 -B -m suite-metrics runtime-environment
fi
SHIP=(darwin-arm64-none linux-arm64-gnu linux-x64-gnu)
AUTHORITY='Developer ID Application: Joshua Nowak (XGL9CXRCT5)'
NOTARY_PROFILE="${OMP_KIT_NOTARY_PROFILE:-omp-kit-notary}"
KEYCHAIN="${OMP_KIT_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/uds-signing.keychain-db}"
KEYCHAIN_PASSWORD="${OMP_KIT_SIGNING_KEYCHAIN_PASSWORD:-$HOME/.config/uds/signing-keychain.pw}"
INSTALL_PREFIX="${OMP_KIT_INSTALL_PREFIX:-$HOME/.local/opt/omp-kit}"

# CHANGELOGCATCHUP1 (ompkit-fp72.120.16.231): once the public verify stage proves vVERSION published, the next-version
# advance needs only that tag. Before this, a refused install (0.2.88 and 0.2.89: PARTIAL) exited here and skipped it, so
# main kept stating the published version and the next cut needed a bootstrap prepare commit plus its own verdict. A
# refusal while ADVANCE_PENDING=1 (set after verify, cleared when the advance starts) still advances main, exactly as
# --no-install does, then exits 4 naming the install command. Its own refusal (dirty paths, refused hooks) names the
# advance-only retry command, and its die is a plain exit.
ADVANCE_PENDING=0
advance_after_refusal() {
	ADVANCE_PENDING=0
	echo "release-local: v$VERSION is published; advancing main to the next version before exiting" >&2
	advance_next_version
	echo "release-local: refused: v$VERSION is published and main states the next version, but it is not installed (refusal above); install it with: ${INSTALL_REMEDY:-$INSTALL_PREFIX/bin/omp-kit update --apply --yes --version $VERSION --index <abs release-index.json> --archive <abs $DARWIN>}" >&2
}
die() { echo "release-local: refused: $*" >&2; [ "${ADVANCE_PENDING:-0}" = 0 ] || advance_after_refusal; exit 4; }
say() { echo "== $*"; }

DRY_RUN=0
ADVANCE_ONLY=0
RESUME_FROM_DRAFT=0
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
		--advance-only) ADVANCE_ONLY=1; shift ;;
		--resume-from-draft) RESUME_FROM_DRAFT=1; shift ;;
		--version) VERSION="${2:-}"; shift 2 ;;
		--next) NEXT=1; shift ;;
		--source) SOURCE="${2:-}"; shift 2 ;;
		--install) INSTALL=1; shift ;;
		--no-install) INSTALL=0; shift ;;
		-h|--help) sed -n '2,39p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "release-local: unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ -z "$VERSION" ] || [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "release-local: --version must be X.Y.Z" >&2; exit 2; }
[ -z "$SOURCE" ] || [[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "release-local: --source must be a full commit SHA" >&2; exit 2; }
[ "$NEXT" = 0 ] || [ -z "$VERSION" ] || { echo "release-local: use --next or --version, not both" >&2; exit 2; }
[ "$NEXT" = 0 ] || [ -z "$SOURCE" ] || { echo "release-local: --next prepares HEAD; do not combine it with --source" >&2; exit 2; }
if [ "$ADVANCE_ONLY" = 1 ]; then
	{ [ -n "$VERSION" ] && [ "$NEXT" = 0 ] && [ -z "$SOURCE" ] && [ "$DRY_RUN" = 0 ]; } ||
		{ echo "release-local: use release-local --advance-only --version X.Y.Z without --next, --source or --dry-run" >&2; exit 2; }
fi
if [ "$RESUME_FROM_DRAFT" = 1 ]; then
	{ [ -n "$VERSION" ] && [ "$NEXT" = 0 ] && [ -z "$SOURCE" ] && [ "$DRY_RUN" = 0 ] && [ "$ADVANCE_ONLY" = 0 ]; } ||
		{ echo "release-local: use release-local --resume-from-draft --version X.Y.Z without --advance-only, --next, --source or --dry-run" >&2; exit 2; }
fi
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
	# Preserve the interrupted stage's timing too: a qualification refusal must not erase its wait.
	substep ''
	if declare -F verdict_queue_end >/dev/null; then verdict_queue_end; fi
	stage ''
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
	if [ -n "$SUBSTEP" ]; then say "substep $SUBSTEP took $((now - SUBSTEP_T0))s start=$SUBSTEP_T0 end=$now"; fi
	SUBSTEP=$1; SUBSTEP_T0=$now
	[ -z "$SUBSTEP" ] || say "substep $SUBSTEP start=$now"
}


# Attribute only version lines this release actually rewrote, not each file's
# latest commit (which may own unrelated work). The stale-worktree member
# consumes these SHAs; its normal checks still judge all other attribution.
release_version_supersedes() {
	bounded 60 python3 -c '
import re, subprocess, sys
from pathlib import Path
root, bead, *fragments = sys.argv[1:]
def git(*args):
    return subprocess.check_output(["git", "-C", root, *args], text=True)
head = git("rev-parse", "HEAD").strip()
rewrites = {}
for path, pattern in (
    ("package.json", r"\"version\"[ \t]*:[ \t]*\"[^\"\n]*\""),
    ("README.md", r"^Current release: v[0-9]+\.[0-9]+\.[0-9]+$"),
):
    before = git("show", f"{head}:{path}").splitlines()
    after = set((Path(root) / path).read_text().splitlines())
    lines = [n for n, old in enumerate(before, 1)
             if old not in after and re.search(pattern, old)]
    if not lines:
        continue
    ranges = [arg for n in lines for arg in ("-L", f"{n},{n}")]
    blame = git("blame", "--line-porcelain", *ranges, head, "--", path)
    for record in blame.splitlines():
        fields = record.split()
        if len(fields) >= 3 and re.fullmatch(r"[0-9a-f]{40}", fields[0]):
            paths = rewrites.setdefault(fields[0], [])
            if path not in paths:
                paths.append(path)
# Only fully deleted shipped fragments need whole-file supersession. Version
# attribution above remains restricted to the rewritten version lines.
for path in fragments:
    if (Path(root) / path).exists():
        continue
    for record in git("blame", "--line-porcelain", head, "--", path).splitlines():
        fields = record.split()
        if len(fields) >= 3 and re.fullmatch(r"[0-9a-f]{40}", fields[0]):
            paths = rewrites.setdefault(fields[0], [])
            if path not in paths:
                paths.append(path)
for sha, paths in rewrites.items():
    scope = ", ".join(paths)
    print(f"Supersedes: {sha} by {bead}: release metadata ({scope})")
' "$ROOT" "$@"
}

# Only the installed admission member needs an out-of-lock prepared record.
# Other commit members continue to judge inline in repositories without it.
release_commit_preflight() {
	local message=$1 hooks
	shift
	hooks="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path hooks)" || return
	[ -x "$hooks/hooks.d/commit-msg/55-omp-kit-commit-gate" ] || return 0
	(cd "$ROOT" && bounded 900 sh scripts/commit-preflight.sh --message "$message" --files "$@")
}

# No --source means prepare from this checkout. Never adopt foreign metadata edits,
# even when their version happens to match. --only keeps unrelated staged work out.
prepare_release() {
	stage prepare
	[ "$(git -C "$ROOT" symbolic-ref --short HEAD)" = main ] || die "prepare requires main"
	local paths=(package.json README.md changelog.d/774u.md)
	local dirty fragment_absent=0
	dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${paths[@]}")" ||
		die "cannot inspect release metadata custody"
	[ -z "$dirty" ] || die "foreign changes on release prepare paths: $dirty"
	# A completed next-version advance (or the CHANGELOGCATCHUP1 catch-up) folds and deletes changelog.d/774u.md; the
	# next prepare starts it again, and must stage the new file for its --only commit.
	[ -e "$ROOT/changelog.d/774u.md" ] || fragment_absent=1
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
notes = fragment.read_text() if fragment.exists() else "### Changed\n"
entry = (f"- Set CLI and OMP plugin version metadata to {version}. "
         "The release is qualified on this prepare commit's exact exported tree before signing.\n")
# Validate every input before changing any of them.
package.write_text(updated)
readme.write_text(stamp)
# git keeps no empty directory: an advance that folded every fragment leaves no changelog.d/.
fragment.parent.mkdir(exist_ok=True)
fragment.write_text(notes.rstrip() + "\n" + entry)
PY
	[ "$fragment_absent" = 0 ] || git -C "$ROOT" add -- changelog.d/774u.md || die "cannot stage the new changelog.d/774u.md"
	local agent="${AGENT_NAME:-$(git -C "$ROOT" config user.name)}" supersedes
	supersedes="$(release_version_supersedes ompkit-774u)" || die "cannot attribute release prepare version lines"
	local message="$WORK/prepare-commit-message"
	printf '%s\n\n%s\n\n%s\n\n%s\n' \
		"chore(release): prepare $VERSION ompkit-774u [test]" \
		"Release metadata only; release-local requires a fresh main-role PASS on this exact exported tree before signing." \
		"$supersedes" \
		"Gap-Bead: none (release metadata)
Bead: ompkit-774u
Agent: $agent" >"$message"
	if ! release_commit_preflight "$message" "${paths[@]}" ||
		! bounded 900 git -C "$ROOT" commit --only -F "$message" -- "${paths[@]}"; then
		die "release prepare commit failed; metadata left for inspection"
	fi
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

# Reconcile only the updater's narrowly classified false PARTIALs: live-browser state, or the kit's own live writers.
# Genuine failed tests or foreign operator writes remain blocking failures.
#
# RELREMEDY1 (ompkit-fp72.120.16.246): 0.2.90, 0.2.91 and 0.2.92 ended PARTIAL only because the postcheck watches the
# kit state root while the kit's own services write it: extensions/gate-events.ts appends gate-events.jsonl (rotating
# to .1) and extensions/kit-inbox-wake.ts writes inbox-wake/<agent>.<id>.json. The root itself reads incomplete when
# it exceeds the snapshot budget (operator-snapshot.ts MAX_ENTRIES_PER_ROOT 20000 / MAX_BYTES_PER_ROOT 512 MiB; the
# 2026-11-05 root held 323k files, 28 GB). Only those writer paths and that root-budget overflow form the class; any
# other changed or unreadable operator file still refuses. Every refusal names the receipt id and runnable commands.
# RELDIAG1 (ompkit-1ra0d.210): 0.2.125 ended PARTIAL the same way, but through the kit's own diagnostics handler:
# cli.ts persistHandlerDiagnostic writes diagnostics/handler-<hex16>.json (randomBytes(16).toString("hex")) when a
# handler fails during the isolated test, so those paths join the class. Anything else still refuses.
RELREMEDY_LIVE_WRITER='^(gate-events\.jsonl(\.1)?|inbox-wake/[A-Za-z0-9._-]+\.json|diagnostics/handler-[0-9a-f]{32}\.json)$'
# jq prelude: $root is the absolute kit state root, $home expands the updater's ~/ display form.
# shellcheck disable=SC2016 # jq variables, not shell expansions
RELREMEDY_JQ='
	def abs: if startswith("~/") then $home + .[1:] else . end;
	def writer: abs | startswith($root + "/") and (.[($root | length) + 1:] | test($rx));
	def failure_ok($changed):
		(capture("^Operator file changed during isolated test: (?<p>.+)$").p as $p | ($changed | index($p)) != null and ($p | writer))
		// (capture("^Operator file could not be read completely: (?<p>.+)$").p | abs == $root)
		// false;'
install_class_jq() {
	jq "$@" --arg v "$VERSION" --arg home "$HOME" --arg root "$kit_state_root" --arg rx "$RELREMEDY_LIVE_WRITER" \
		"$RELREMEDY_JQ $class_filter" "$WORK/install-update.json"
}
# Why the postcheck could not read the state root completely, or which kit writer raced it.
install_postcheck_cause() {
	# shellcheck disable=SC2016 # jq program
	class_filter='.data.postcheck_detail as $p |
		(($p.failures // [])[] | select(startswith("Operator file could not be read completely: ")) | .[44:] as $q |
			if ($q | abs) == $root then "\($q): exceeds the postcheck snapshot budget (20000 entries or 512 MiB per root): size, not a race"
			else "\($q): unreadable mid-read, a live-writer race" end),
		(($p.changed_operator_paths // [])[] | if writer then "\(.): written by a kit service during the isolated test (live-writer race)"
			else "\(.): changed outside the kit live-writer class (gate-events.jsonl, inbox-wake/*.json, diagnostics/handler-*.json)" end)'
	install_class_jq -r 2>/dev/null | sed 's/^/release-local: postcheck: /' >&2 || true
}
# Keep the verified sources past $WORK cleanup, so the printed apply command stays runnable after exit.
install_remedy() {
	local keep id
	id="$(jq -r '.data.receipt_id // empty | select(type == "string" and test("^[a-f0-9-]{1,128}$"))' "$WORK/install-update.json" 2>/dev/null)" || id=''
	KITLIB_TMP_AUTO_CLEANUP=0 kitlib_tmp keep release-install-source
	keep="$(cd "$keep" && pwd -P)" && cp "$PUB/release-index.json" "$PUB/$DARWIN" "$keep/" || keep="$PUB"
	INSTALL_REMEDY="$kit update --apply --yes --version $VERSION --index $keep/release-index.json --archive $keep/$DARWIN"
	install_postcheck_cause
	[ -z "$id" ] || echo "release-local: receipt $id; when its postimages verify, reconcile it with: $kit update --reconcile $id --yes" >&2
	echo "release-local: otherwise re-apply with: $INSTALL_REMEDY" >&2
}
# RELFAST1: reconcile's relink already validates the apply receipt. Reuse it only
# while that durable receipt covers the complete current profile set and every
# live link still targets the verified release. Missing/old evidence means apply,
# not a release refusal; the final align and version readbacks remain mandatory.
reconcile_plugins_current() {
	bounded 30 python3 -c '
import json, sys
from pathlib import Path
def require(condition):
    if not condition:
        raise ValueError("reconcile plugin proof is incomplete")
try:
    result, state, store, home, version = sys.argv[1:]
    envelope = json.loads(Path(result).read_text())
    data = envelope["data"]
    verified = data["verified"]
    require(envelope["ok"] is True and data["action"] == "RECONCILED")
    require(data["active_version"] == version and data["plugin_relink"] == "APPLIED")
    require(verified["version"] == version and verified["binary"] == str(Path(store) / "bin/omp-kit"))
    receipt_id = data["plugin_receipt_id"]
    require(isinstance(receipt_id, str) and 0 < len(receipt_id) <= 128)
    require(all(c in "abcdef0123456789-" for c in receipt_id))
    receipt = json.loads((Path(state) / ("plugin-" + receipt_id + ".json")).read_text())
    require(receipt["schema_version"] == 1 and receipt["id"] == receipt_id and receipt["store"] == store)
    roots = {"default": Path(home) / ".omp"}
    profiles = Path(home) / ".omp/profiles"
    if profiles.exists():
        for profile in profiles.iterdir():
            require(profile.is_dir() and not profile.is_symlink() and profile.name != "default")
            roots[profile.name] = profile
    rows = receipt["rows"]
    require(len(rows) == len(roots) and {row["profile"] for row in rows} == set(roots))
    for row in rows:
        require(row["status"] in ("APPLIED", "UNCHANGED") and isinstance(row["before"], dict))
        after = row["after"]
        link = roots[row["profile"]] / "plugins/node_modules/omp-kit-companion"
        require(after["link_kind"] == "SYMLINK" and after["target"] == store and after["link_path"] == str(link))
        require(link.is_symlink() and str(link.resolve(strict=True)) == store)
except (OSError, ValueError, KeyError, TypeError, RuntimeError):
    sys.exit(1)
' "$WORK/install-reconcile.json" "$kit_state_root" "$store" "$HOME" "$VERSION"
}
install_plugin_relink() {
	substep install.plugin-relink
	bounded 300 "$kit" apply plugin --apply --yes --store "$store" --profiles all --include-default --json \
		>"$WORK/install-plugin.json" || die "profile plugin relink failed"
	cat "$WORK/install-plugin.json"
	jq -e '.ok == true' "$WORK/install-plugin.json" >/dev/null || die "profile plugin relink was not successful"
}
install_align_readback() {
	substep install.align-readback
	bounded 60 python3 "$store/skills/fleet-restart/scripts/fleet_restart.py" align \
		--home "$HOME" --releases "$INSTALL_PREFIX/releases" --version "$VERSION" >"$WORK/install-align.json" ||
		die "installed profile alignment is stale"
	cat "$WORK/install-align.json"
	jq -e --arg v "$VERSION" '.ok == true and .version == $v and .stale == [] and
		(.links | length > 0) and all(.links[]; .ok == true)' "$WORK/install-align.json" >/dev/null ||
		die "align readback did not prove every profile link"
}
install_release() {
	stage install
	local kit="$INSTALL_PREFIX/bin/omp-kit" store="$INSTALL_PREFIX/releases/$VERSION"
	local update_rc=0 reconcile_id kit_state_root class_filter reconcile_class=live-browser reused_relink=0
	local pending_id=''
	kit_state_root="${XDG_STATE_HOME-$HOME/.local/state}/omp-kit"
	# RELINSTALLPATH1 (ompkit-fp72.120.16.155): `omp-kit update --apply` refuses a source that is not its own realpath
	# (UNSAFE_KIT_SOURCE, kit-update.ts assertRegular), and $WORK under macOS TMPDIR sits below the /var -> /private/var
	# symlink, so 0.2.75 published and then never installed. Hand the updater the physical path (same directory).
	PUB="$(cd "$PUB" && pwd -P)" || die "cannot resolve the public download directory $PUB"
	substep install.update
	bounded 3600 "$kit" update --apply --yes --version "$VERSION" \
		--index "$PUB/release-index.json" --archive "$PUB/$DARWIN" --json >"$WORK/install-update.json" || update_rc=$?
	cat "$WORK/install-update.json"
	if [ "$update_rc" -ne 0 ]; then
		# RELPENDING1 (ompkit-1ra0d.210): a deferred-live PARTIAL keeps the new version active with its
		# live check pending (KITLIVEDEFER1): the updater returns before its own relink, and reconcile
		# alone never blesses the deferred path, so the install finishes the relink and readbacks now
		# and names the receipt for the later `update --reconcile`. Only an UNDONE (or a missing
		# version) stays a refusal: the filter requires the new version active and a matcher PASS.
		if jq -er --arg v "$VERSION" '
			.data as $d | $d.receipt_id as $id |
			select($d.action == "PARTIAL" and $d.active_version == $v and
				$d.matcher == "PASS" and
				($d.postcheck == "DEFERRED" or $d.reason == "KIT_POSTCHECK_DEFERRED") and
				($id | type == "string" and test("^[a-f0-9-]+$")) and
				(($d.postcheck_detail.failed_stages // []) == [])) | $id
		' "$WORK/install-update.json" >"$WORK/install-reconcile-id"; then
			IFS= read -r pending_id <"$WORK/install-reconcile-id"
			reconcile_class='deferred-live'
			say "installed $VERSION; live check pending (receipt $pending_id; the kit-update job finishes it with: $kit update --reconcile $pending_id --yes)"
		else
			if ! jq -er --arg v "$VERSION" '
				.data as $d | $d.receipt_id as $id |
				select($d.action == "PARTIAL" and $d.active_version == $v and
					$d.matcher == "PASS" and $d.live == "PASS" and $d.postcheck == "FAIL" and
					($id | type == "string" and test("^[a-f0-9-]+$")) and
					$d.postcheck_detail.changed_operator_paths == [] and
					$d.postcheck_detail.failures == [] and $d.postcheck_detail.cause == null and
					($d.postcheck_detail.live_state_paths | length > 0) and
					(.commands | index("omp-kit update --reconcile " + $id + " --yes") != null)) | $id
			' "$WORK/install-update.json" >"$WORK/install-reconcile-id"; then
				# RELREMEDY2 (ompkit-fp72.120.16.274): the receipt comes from .data.receipt_id; the real updater lists only
				# `omp-kit undo <id> --yes` in .commands, so a reconcile-command condition never matched production output.
				# shellcheck disable=SC2016 # jq program
				class_filter='.data as $d | $d.receipt_id as $id | ($d.postcheck_detail // {}) as $p |
					select($d.action == "PARTIAL" and $d.active_version == $v and
						$d.matcher == "PASS" and $d.live == "PASS" and $d.postcheck == "FAIL" and
						($id | type == "string" and test("^[a-f0-9-]+$")) and
						(($p.failed_stages // []) == []) and
						($p.cause == null or $p.cause.cause_message == "KIT_POSTCHECK_FAILED") and
						(($p.changed_operator_paths // []) | all(writer)) and
						(($p.failures // []) | length > 0 and all(failure_ok($p.changed_operator_paths // [])))) | $id'
				install_class_jq -er >"$WORK/install-reconcile-id" || {
					install_remedy
					die "install update failed (rc $update_rc); not the known live-browser, kit live-writer or deferred-live PARTIAL, refusing reconciliation"
				}
				install_postcheck_cause
				reconcile_class='kit-live-writer'
			fi
			IFS= read -r reconcile_id <"$WORK/install-reconcile-id"
			substep "install.reconcile-$reconcile_class-state"
			bounded 300 "$kit" update --reconcile "$reconcile_id" --yes --json >"$WORK/install-reconcile.json" ||
				{ install_remedy; die "$reconcile_class-state reconcile refused; installation remains unverified"; }
			cat "$WORK/install-reconcile.json"
			jq -e --arg v "$VERSION" '.ok == true and .data.action == "RECONCILED" and .data.active_version == $v' \
				"$WORK/install-reconcile.json" >/dev/null || die "reconcile did not confirm the installed version"
		fi
	else
		jq -e --arg v "$VERSION" '.ok == true and .data.active_version == $v and
			(.data.action == "UPDATED" or .data.action == "CURRENT")' "$WORK/install-update.json" >/dev/null ||
			die "updater did not confirm the target version"
	fi
	substep install.plugin-relink
	if [ "$update_rc" -ne 0 ] && reconcile_plugins_current; then
		reused_relink=1
		say "reusing reconcile plugin receipt; every current profile already targets $store"
	else
		install_plugin_relink
	fi
	stage readback
	install_align_readback
	if [ "$reused_relink" = 1 ] && ! reconcile_plugins_current; then
		# A newly discovered profile can be absent from a link-only align report.
		# Repair once with the normal full-scope apply, then repeat real alignment.
		say "profile coverage changed during readback; applying the full profile relink"
		install_plugin_relink
		install_align_readback
	fi
	substep install.version-readback
	[ "$(bounded 30 "$kit" --version)" = "omp-kit $VERSION" ] || die "installed CLI version readback differs from $VERSION"
	substep ''
	INSTALLED=1
	say "installed $VERSION; every profile link aligned"
}

# ---------------------------------------------------------------------------------------------- 1. preflight
# Advance-only bypasses all prepare/build/sign/publish/verify/install stages.
if [ "$ADVANCE_ONLY" = 0 ]; then
# RELRESUME1 (ompkit-1ra0d.191): a resume adopts the existing tag and draft below and rejoins at attest,
# so it skips this whole prepare-to-rule-gate run. receipt() stays outside the skip so the end-of-release
# receipt works on every path. The :- default keeps extracted stage slices working under their set -u.
if [ "${RESUME_FROM_DRAFT:-0}" = 0 ]; then
stage preflight
[ "$(uname -s)" = Darwin ] || die "the local release runs on macOS (it signs and notarizes the darwin archive)"
for tool in git gh jq python3 bun shasum codesign xcrun security spctl ditto plutil openssl curl tar timeout; do
	command -v "$tool" >/dev/null || die "missing tool: $tool"
done
if [ "$DRY_RUN" = 0 ] && [ "$INSTALL" = 1 ]; then
	[ -x "$INSTALL_PREFIX/bin/omp-kit" ] || die "install requires the existing kit at $INSTALL_PREFIX/bin/omp-kit (or --no-install)"
	[ -f "$ROOT/skills/fleet-restart/scripts/fleet_restart.py" ] || die "fleet align readback helper is missing"
	# RELPENDINGLOOP1 (ompkit-1ra0d.183): every 0.2.11x release left a PENDING kit-update receipt after a
	# successful activation (rel119: post-activation extensions/hooks failure; rel120: refused revalidation
	# while the job installed the version; rel121: false KIT_LIVE_TEST_FAILED postcheck on seat-omp runtime
	# writes outside the two auto-reconciled classes), so the next preflight refused RELPENDING1 until a
	# manual `update --reconcile` re-proved the postimages. The seat cannot be quiesced mid-release and
	# allowlisting all seat state would gut the postcheck, so the preflight reuses the updater's own proof
	# instead: `update --reconcile` re-verifies the recorded postimage (symlink target plus binary bytes)
	# and only then clears the receipt. The release proceeds solely on its RECONCILED verdict; anything
	# else keeps the existing RELPENDING1 refusal, with no new refusal code. The path below mirrors the
	# updater's own: cli.ts receiptStateRoot (XDG_STATE_HOME, or HOME/.local/state when unset, both
	# absolute) + /omp-kit, and mutations.ts updatePendingPath.
	kit_state_home="${XDG_STATE_HOME-${HOME:-}/.local/state}"
	[[ "${HOME:-}" == /* && "$kit_state_home" == /* ]] ||
		die "install requires an absolute HOME and XDG_STATE_HOME (or XDG_STATE_HOME unset), as omp-kit update does"
	kit_pending="$kit_state_home/omp-kit/kit-update.pending.json"
	if [ -e "$kit_pending" ] || [ -L "$kit_pending" ]; then
		pending_id="$(jq -er '.id | select(type == "string" and test("^[a-f0-9-]{1,128}$"))' "$kit_pending" 2>/dev/null)" || pending_id=''
		pending_warning="reconcile only a false PARTIAL whose postimages verify; nothing was built and nothing was changed"
		[ -n "$pending_id" ] || die "RELPENDING1: pending kit update receipt $kit_pending is unreadable (no valid id), so the install stage would refuse PENDING_RECOVERY after publishing; inspect it, then run omp-kit update --reconcile <id> --yes ($pending_warning)"
		if bounded 300 "$INSTALL_PREFIX/bin/omp-kit" update --reconcile "$pending_id" --yes --json >"$WORK/pending-reconcile.json" &&
			jq -e --arg id "$pending_id" '.ok == true and .data.action == "RECONCILED" and .data.receipt_id == $id' "$WORK/pending-reconcile.json" >/dev/null; then
			cat "$WORK/pending-reconcile.json"
			say "reconciled pending kit update receipt $pending_id; its postimages verify"
		else
			die "RELPENDING1: a previous kit update left pending recovery receipt $pending_id ($kit_pending), so the install stage would refuse PENDING_RECOVERY after publishing; first run: omp-kit update --reconcile $pending_id --yes ($pending_warning)"
		fi
	fi
fi
# Probe the newly used curl features locally, before a tag or draft can exist.
curl_capability="$(bounded 10 curl -fsS --parallel -o /dev/null --write-out '%{exitcode}' file:///dev/null)" ||
	die "curl 7.75+ with parallel transfers and write-out exitcode is required"
[ "$curl_capability" = 0 ] || die "curl 7.75+ with write-out exitcode is required"
bounded 60 gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not authenticated to github.com"
# RELFAILFAST1: probe heavy admission before packaged qualification work queues.
# The qualification runner uses statfs and keeps heavy's physical 10 GiB floor.
if command -v omp-kit >/dev/null; then
	admit_rc=0
	admit_out="$(OMP_KIT_DISK_OBSERVER=statfs bounded 60 omp-kit heavy --no-wait --label release-preflight -- true 2>&1)" || admit_rc=$?
	[ "$admit_rc" -ne 75 ] || die "heavy work cannot be admitted now, so qualification would time out queued; fix this first: $(printf '%s' "$admit_out" | tail -n 3)"
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
		VERSION="$(bounded 30 sh "$ROOT/scripts/release-preflight.sh" next_version "$main_version" "$remote_tags")" ||
			die "cannot derive next patch version"
	else
		VERSION="$(printf '%s\n' "$remote_tags" | (cd "$ROOT" && sh scripts/release-train.sh next-version --changelog-ref "$SOURCE"))" ||
			die "release-train.sh next-version failed"
	fi
fi
grep -q "refs/tags/v$VERSION\$" <<<"$remote_tags" && die "tag v$VERSION already exists on origin; never re-tag a version"
bounded 120 gh api --paginate --slurp "repos/$REPO/releases?per_page=100" >"$WORK/releases.json" || die "listing releases failed"
BASE_TAG="$(bounded 30 sh "$ROOT/scripts/release-preflight.sh" releases "$VERSION" "$WORK/releases.json")" ||
	die "release availability preflight failed"
# NEXTVERSION1: when origin/main already states this unpublished version, tag it as is; no prepare commit.
if [ "$PREPARE" = 1 ] && git -C "$ROOT" show "$MAIN:package.json" | jq -e --arg v "$VERSION" '.version == $v' >/dev/null; then
	PREPARE=0; SOURCE="$MAIN"
	say "origin/main $MAIN already states $VERSION; tagging it with no prepare commit"
fi
if [ "$PREPARE" = 1 ]; then
	prepare_release
fi
# Explicit --source remains the immutable resume/preview path.
sh "$ROOT/scripts/release-preflight.sh" version "$ROOT" "$SOURCE" "$VERSION" "$ROOT" ||
	die "package.json version does not match v$VERSION at $SOURCE"
MODE="$(bounded 30 sh "$ROOT/scripts/release-preflight.sh" signing "$ROOT" "$SOURCE" "$VERSION" "$ROOT" "$DRY_RUN")" ||
	die "source has no valid local release signing mode"
bounded 30 sh "$ROOT/scripts/release-preflight.sh" attestation "$ROOT" "$SOURCE" "$VERSION" "$ROOT" ||
	die "source release.yml has no attest-local job (LOCAL-RELEASE-V1)"
say "source $SOURCE (origin/main $MAIN) version $VERSION base $BASE_TAG mode $MODE"

stage source
SRC="$WORK/src"
mkdir -p "$SRC" "$WORK/tmp" "$WORK/build"
# Check the exact main tree's PASS before unlocking the signing keychain.
substep source.archive
git -C "$ROOT" archive --format=tar "$SOURCE" >"$WORK/source.tar"
tar -xf "$WORK/source.tar" -C "$SRC"
rm -f "$WORK/source.tar"
substep ''
bounded 30 sh "$ROOT/scripts/release-preflight.sh" export "$SRC" "$SOURCE" ||
	die "source export preflight failed"
substep source.spawn-smoke
bounded 180 bun "$SRC/scripts/spawn-smoke.ts" || die "fresh non-kit native build spawn smoke failed"
substep ''
source_tree="$(git -C "$ROOT" rev-parse "$SOURCE^{tree}")" || die "cannot resolve exact source tree"
# The verdict producer may return 0 when a different run holds its lock. Never
# confuse that queue acknowledgement with PASS: wait on the exact-tree main record.
stage verdict
# A runtime mismatch is not a missing qualification; refuse without starting another run.
substep verdict.store-lookup
main_result="$(bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" 2>/dev/null)" || true
verdict_mismatch() {
	case "$1" in RUNTIME_MISMATCH*) die "$1 (main verdict of prepare $SOURCE; requalify with the pinned kit environment)" ;; esac
}
verdict_mismatch "$main_result"
substep ''
if [ "$main_result" != PASS ]; then
	substep verdict.producer
	bounded 7200 sh "$ROOT/scripts/release-verdict.sh" --commit "$SOURCE" --no-fetch ||
		die "release verdict failed for prepare $SOURCE"
	substep verdict.polling
	# VERDICTSTARVE1 (ompkit-fp72.120.16.198): while another run holds its lock, release-verdict.sh writes SOURCE to its
	# one-slot queue (release-verdict.wanted, latest wins) and returns 0. A push before the holder reaches SOURCE
	# overwrites the slot and the holder never judges SOURCE (0.2.88: 13.6 min of polling until killed). Each poll reads
	# the slot, then the commit the holder's full-suite runner judges (--commit),
	# then the verdict, so a verdict recorded before the holder moved on is always seen. SOURCE is starved once the
	# holder is gone, or judges another commit while the slot no longer holds SOURCE: it then judges only the slot.
	# Bound: the next poll after that state appears stops the stage; the 7200 s deadline still applies.
	rv_state="$(git -C "$ROOT" rev-parse --absolute-git-dir)/omp-kit" || die "cannot resolve the release-verdict state of $ROOT"
	verdict_fix="produce it with: sh scripts/release-verdict.sh --commit $SOURCE --no-fetch (it queues $SOURCE while another run holds the lock), then resume: scripts/release-local.sh --source $SOURCE --version $VERSION"
	verdict_deadline=$(( $(date +%s) + 7200 ))
	verdict_seen=''
	verdict_queue_t0=''
	verdict_queue_end() {
		[ -n "$verdict_queue_t0" ] || return 0
		local now; now=$(date +%s)
		say "substep verdict.per-repo-holder took $((now - verdict_queue_t0))s start=$verdict_queue_t0 end=$now"
		verdict_queue_t0=''
	}
	# The first --commit of a direct child of the holder that is its full-suite runner.
	# shellcheck disable=SC2016 # an awk program, not shell expansions
	rv_children_awk='$1 == holder && !found && index($0, "full-suite-verdict.sh ") { for (i = 2; i < NF; i++) { j = i + 1; if ($i == "--commit" && $j ~ /^[0-9a-f]+$/) { print $j; found = 1; break } } }'
	while :; do
		rv_wanted="$(cat "$rv_state/release-verdict.wanted" 2>/dev/null)" || rv_wanted=''
		rv_holder="$(cat "$rv_state/release-verdict.lock/pid" 2>/dev/null)" || rv_holder=''
		[[ "$rv_holder" =~ ^[1-9][0-9]*$ ]] && kill -0 "$rv_holder" 2>/dev/null || rv_holder=''
		rv_judging=''
		if [ -n "$rv_holder" ]; then
			rv_judging="$(bounded 10 ps -A -o ppid= -o command= | awk -v holder="$rv_holder" "$rv_children_awk")" || rv_judging=''
		fi
		if [ -n "$rv_holder" ] && [ "$rv_judging" != "$SOURCE" ] && [ "$rv_wanted" = "$SOURCE" ] && [ -z "$verdict_queue_t0" ]; then
			verdict_queue_t0=$(date +%s)
			say "substep verdict.per-repo-holder start=$verdict_queue_t0"
		fi
		main_result="$(bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
			--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC")" || true
		if [ "$rv_judging" = "$SOURCE" ] || [ -z "$rv_holder" ] || [ "$rv_wanted" != "$SOURCE" ] ||
			[ "$main_result" = FAIL ] || [ "$main_result" = PASS ]; then
			verdict_queue_end
		fi
		if [ "$main_result" = FAIL ]; then die "release verdict FAIL for exact prepare $SOURCE"; fi
		[ "$main_result" != PASS ] || break
		verdict_now="release-verdict run ${rv_holder:-none} judges ${rv_judging:-unknown}; queued next ${rv_wanted:-none}"
		[ "$verdict_now" = "$verdict_seen" ] || { say "verdict wait for $SOURCE: $verdict_now"; verdict_seen=$verdict_now; }
		if [ -z "$rv_holder" ]; then
			verdict_mismatch "$main_result"
			die "VERDICT_STARVED: no release-verdict run holds the lock and prepare $SOURCE has no verdict (main ${main_result:-none}); $verdict_fix"
		fi
		if [ -n "$rv_judging" ] && [ "$rv_judging" != "$SOURCE" ] && [ "$rv_wanted" != "$SOURCE" ]; then
			verdict_mismatch "$main_result"
			die "VERDICT_STARVED: release-verdict run $rv_holder judges $rv_judging and queues ${rv_wanted:-nothing} next, so it skips prepare $SOURCE; $verdict_fix"
		fi
		[ "$(date +%s)" -lt "$verdict_deadline" ] || die "timed out waiting for exact prepare verdict $SOURCE"
		sleep 3
	done
	verdict_queue_end
fi
substep verdict.readback
if ! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" \
	>"$WORK/full-suite-verdict.out"; then
	verdict_result="$(cat "$WORK/full-suite-verdict.out")"
	die "source tree $source_tree has no reusable main-role full-suite PASS ($verdict_result)"
fi
[ "$(cat "$WORK/full-suite-verdict.out")" = PASS ] || die "source tree $source_tree full-suite readback is not PASS"
say "full-suite verdict $source_tree: PASS (main role)"
bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" flakes \
	--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" \
	>"$WORK/full-suite-flakes.out" || die "cannot read flake evidence for $source_tree"
while IFS= read -r flake; do
	say "full-suite flake: $flake (passed on single rerun)"
done <"$WORK/full-suite-flakes.out"
substep verdict.signing-preflight

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
substep ''

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
DARWIN="omp-kit-v$VERSION-darwin-arm64-none.tar.gz"
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
for platform in linux-arm64-gnu linux-x64-gnu; do cp "$WORK/build/$platform/omp-kit-v$VERSION-$platform.tar.gz" "$DIST/"; done
for platform in "${SHIP[@]}"; do
	python3 -I "$SRC/installer/install.py" inspect "$DIST/release-index.json" "$VERSION" "$platform" >/dev/null || die "final index refuses $platform"
	python3 "$SRC/scripts/release_reuse.py" verify-archive --index "$DIST/release-index.json" --platform "$platform" --archive-dir "$DIST" >/dev/null ||
		die "final $platform archive differs from the final index"
done
(cd "$DIST" && shasum -a 256 release-index.json omp-kit-v"$VERSION"-*.tar.gz >SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || die "SHA256SUMS failed"
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
# End the resume skip: receipt() and the dry run below run on every path.
fi

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
fi # normal release preparation

# NEXTVERSION1 (ompkit-d8qic; Maven release:prepare "prepare for next development iteration"): after vVERSION is
# public, shared main moves to the next patch in one commit that also promotes the vVERSION CHANGELOG section and
# stamps README's release line to vVERSION (the latest published release), so the next cut tags an already-green
# origin commit with no bump commit. Only fragments present at the tagged source are folded; later fragments stay
# in changelog.d/ for the next release. A full run reaches it after public verification and install;
# --advance-only admits an already-published tag without repeating either stage. Both routes use
# the installed commit hooks unchanged and preserve their actual refusal diagnostics.
# The commit is made on the shared main in the canonical checkout (AGENTS.md: no branches, no worktrees) with
# `git commit --only`, exactly like the prepare stage. The new bytes are computed in an owned scratch export of HEAD,
# because release-notes.sh promote folds every fragment it finds and the checkout may hold peers' fragments. ADVANCEREF1
# (ompkit-fp72.120.16.235): the folded fragments are exported from SOURCE, so [VERSION] holds exactly the notes that
# shipped; a fragment HEAD changed after the cut keeps its heading and only the entries SOURCE's copy lacks (exact
# whole-entry match, release-notes.sh residual), and only a fragment HEAD holds unchanged is deleted. Every
# written path must be clean first (NEXT_VERSION_PATHS_DIRTY). Publication is a plain push when it fast-forwards
# origin, else git_converge.py --push (OMP_KIT_GIT_CONVERGE overrides its path).
advance_next_version() {
	stage next-version
	ADVANCE_PENDING=0
	# Every file whose bytes return to $ROOT (package.json, README.md, CHANGELOG.md, the fragments) is read as its raw
	# blob, never through `git archive`: .gitattributes marks package.json export-subst, so an archive expands
	# "source_revision": "$Format:%H$" to a literal sha, and 1a24cb94af committed b55c98c0dc there (main RED until
	# e1aec02f60). Only the scripts the advance runs come from an archive. Defined here so this function stays one block.
	next_version_blobs() {
		local ref=$1 dest=$2 blob
		shift 2
		for blob do
			mkdir -p "$(dirname "$dest/$blob")" || return 1
			git -C "$ROOT" cat-file blob "$ref:$blob" >"$dest/$blob" || return 1
		done
	}
	local next agent export="$WORK/next" date promote_rc path dirty supersedes
	local resume="release-local --advance-only --version $VERSION"
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
			die "v$VERSION is published; NEXT_VERSION_CONVERGE_FAILED: shared main lacks $SOURCE (see above); retry: $resume"
	fi
	# The exact advance marker also covers a historical retry after newer releases.
	NEXT_SHA="$(git -C "$ROOT" log -1 --format=%H --fixed-strings \
		--grep="NEXTVERSION1: v$VERSION is published from $SOURCE;" "$SOURCE..HEAD")" ||
		die "cannot inspect the next-version history; retry: $resume"
	if [ -n "$NEXT_SHA" ] && git -C "$ROOT" merge-base --is-ancestor "$NEXT_SHA" refs/remotes/origin/main; then
		say "ADVANCE_ALREADY_DONE: v$VERSION advanced in $NEXT_SHA"
		return 0
	fi
	if [ -z "$NEXT_SHA" ]; then
	# Fold exactly the fragments the tagged source shipped that main still holds.
	while IFS= read -r path; do
		git -C "$ROOT" cat-file -e "HEAD:$path" 2>/dev/null && fragments+=("$path")
	done < <(git -C "$ROOT" ls-tree --name-only "$SOURCE" -- changelog.d/)
	paths+=(${fragments[@]+"${fragments[@]}"})
	dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${paths[@]}")" || die "v$VERSION is published; cannot inspect the next-version paths"
	[ -z "$dirty" ] || die "v$VERSION is published; NEXT_VERSION_PATHS_DIRTY: ${dirty//$'\n'/; }; nothing was written. Once those paths are clean, retry: $resume"
	rm -rf "$export" "$WORK/next-head" "$WORK/next-residual"; mkdir -p "$export" "$WORK/next-head" "$WORK/next-residual"
	git -C "$ROOT" archive HEAD -- scripts/release-notes.sh scripts/release-notes.ts scripts/stamp-release-line.sh \
		scripts/kitlib-tmp.sh | tar -xf - -C "$export" || die "v$VERSION is published; cannot export the next-version scripts"
	next_version_blobs HEAD "$export" package.json README.md CHANGELOG.md ||
		die "v$VERSION is published; cannot export the next-version inputs"
	# Shipped bytes, not HEAD's: every fragment here is present at $SOURCE.
	local -a changed=()
	if [ "${#fragments[@]}" -gt 0 ]; then
		next_version_blobs "$SOURCE" "$export" "${fragments[@]}" ||
			die "v$VERSION is published; cannot export the shipped fragments from $SOURCE"
		for path in "${fragments[@]}"; do
			[ "$(git -C "$ROOT" rev-parse "$SOURCE:$path")" = "$(git -C "$ROOT" rev-parse "HEAD:$path")" ] || changed+=("$path")
		done
	fi
	if [ "${#changed[@]}" -gt 0 ]; then
		next_version_blobs HEAD "$WORK/next-head" "${changed[@]}" ||
			die "v$VERSION is published; cannot export the fragments changed after $SOURCE"
	fi
	# release-notes.sh resolves its root through git; the export is a private scratch repository, never a worktree.
	git -C "$export" init -q || die "v$VERSION is published; cannot prepare the next-version export"
	# Before promote deletes the export's fragments: what each changed one gained after the cut.
	for path in ${changed[@]+"${changed[@]}"}; do
		mkdir -p "$(dirname "$WORK/next-residual/$path")"
		(cd "$export" && bounded 60 sh scripts/release-notes.sh residual --released "$export/$path" --current "$WORK/next-head/$path") \
			>"$WORK/next-residual/$path" || die "v$VERSION is published; release-notes.sh residual failed for $path"
	done
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
	for path in ${fragments[@]+"${fragments[@]}"}; do
		if [ -s "$WORK/next-residual/$path" ]; then cp "$WORK/next-residual/$path" "$ROOT/$path"; else rm -f "$ROOT/$path"; fi
	done
	rm -rf "$export" "$WORK/next-head" "$WORK/next-residual"
	supersedes="$(release_version_supersedes ompkit-d8qic ${fragments[@]+"${fragments[@]}"})" || die "v$VERSION is published; cannot attribute next-version rewrites; retry: $resume"
	local message="$WORK/next-version-commit-message"
	printf '%s\n\n%s\n\n%s\n\n%s\n\n%s\n' \
		"chore(release): next version $next after v$VERSION ompkit-d8qic [pending]" \
		"NEXTVERSION1: v$VERSION is published from $SOURCE; main now states $next so the next cut tags a green origin commit with no bump commit. CHANGELOG [$VERSION] holds the notes folded from the fragments present at $SOURCE; README states v$VERSION, the latest published release." \
		"[no-changelog] release next-version commit; its notes are the promoted CHANGELOG section" \
		"$supersedes" \
		"Gap-Bead: none (release metadata)
Bead: ompkit-d8qic
Agent: $agent" >"$message"
	if ! release_commit_preflight "$message" "${paths[@]}" ||
		! bounded 900 git -C "$ROOT" commit -q --only -F "$message" -- "${paths[@]}"; then
		# Only this step's own bytes are put back: every path was clean before it wrote them.
		git -C "$ROOT" checkout HEAD -- "${paths[@]}" || echo "release-local: WARNING: could not restore ${paths[*]} in $ROOT" >&2
		die "v$VERSION is published; NEXT_VERSION_COMMIT_REFUSED: the commit member's diagnostic is above; once fixed, retry: $resume"
	fi
	NEXT_SHA="$(git -C "$ROOT" rev-parse HEAD)"
	fi
	bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || die "next-version commit $NEXT_SHA made; fetch before publishing failed"
	if git -C "$ROOT" merge-base --is-ancestor refs/remotes/origin/main HEAD; then
		bounded 900 git -C "$ROOT" -c push.followTags=false push --porcelain origin main ||
			die "next-version commit $NEXT_SHA is on local main; NEXT_VERSION_PUSH_FAILED; retry: $resume"
	else
		[ -f "$converge" ] || die "next-version commit $NEXT_SHA is on local main and origin moved; NEXT_VERSION_CONVERGE_MISSING: $converge; retry: $resume"
		bounded 1800 python3 "$converge" --repo "$ROOT" --push --expect-head "$NEXT_SHA" ||
			die "next-version commit $NEXT_SHA is on local main and origin moved; NEXT_VERSION_CONVERGE_FAILED (see above); retry: $resume"
	fi
	bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || die "next-version readback fetch failed"
	git -C "$ROOT" merge-base --is-ancestor "$NEXT_SHA" refs/remotes/origin/main || die "next-version commit $NEXT_SHA is not on origin/main"
	say "next version $next committed to main: $NEXT_SHA"
}

# ADVANCEONLY1: publication admission is read-only until every required asset and
# archive attestation is present. The normal release's consumer verification is
# deliberately not repeated here; this entrypoint changes only next-version metadata.
if [ "${ADVANCE_ONLY:-0}" = 1 ]; then
	stage advance-only
	resume="release-local --advance-only --version $VERSION"
	for tool in git gh jq python3 bun tar timeout; do
		command -v "$tool" >/dev/null || die "missing tool: $tool; retry: $resume"
	done
	remote_tags="$(bounded 120 git -C "$ROOT" ls-remote --tags origin "refs/tags/v$VERSION" "refs/tags/v$VERSION^{}")" ||
		die "ADVANCE_ONLY_NOT_PUBLISHED: origin tag lookup failed; retry: $resume"
	tag_source=''; peeled_source=''
	while read -r sha ref; do
		case "$ref" in
			"refs/tags/v$VERSION") tag_source=$sha ;;
			"refs/tags/v$VERSION^{}") peeled_source=$sha ;;
		esac
	done <<<"$remote_tags"
	[ -n "$tag_source" ] || die "ADVANCE_ONLY_NOT_PUBLISHED: origin has no v$VERSION; retry: $resume"
	bounded 120 gh release view "v$VERSION" --repo "$REPO" --json tagName,isDraft,isPrerelease,assets >"$WORK/published.json" ||
		die "ADVANCE_ONLY_NOT_PUBLISHED: release v$VERSION is unavailable; retry: $resume"
	# GitHub's asset digests identify the archive attestations exactly as in the
	# public verifier. Checksums/index must exist; only archives carry attestations.
	bounded 30 python3 -c '
import json, re, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
version = sys.argv[2]
required = ["SHA256SUMS", "release-index.json"] + [
    f"omp-kit-v{version}-{platform}.tar.gz"
    for platform in ("darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu")]
if doc.get("tagName") != "v" + version or doc.get("isDraft") is not False or doc.get("isPrerelease") is not False:
    raise SystemExit("release is not public and stable")
assets = doc.get("assets", [])
for name in required:
    matches = [asset for asset in assets if asset.get("name") == name]
    if len(matches) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", matches[0].get("digest", "")):
        raise SystemExit(f"missing or ambiguous published asset digest: {name}")
    if name.endswith(".tar.gz"):
        print(matches[0]["digest"])
' "$WORK/published.json" "$VERSION" >"$WORK/published-digests" ||
		die "ADVANCE_ONLY_NOT_PUBLISHED: incomplete release assets; retry: $resume"
	while IFS= read -r digest; do
		bounded 120 gh api --hostname github.com "repos/$REPO/attestations/$digest" >"$WORK/published-attestation.json" ||
			die "ADVANCE_ONLY_NOT_PUBLISHED: no attestation for $digest; retry: $resume"
		jq -e '.attestations | type == "array" and length > 0 and any(.[]; (.bundle | type == "object" and length > 0))' \
			"$WORK/published-attestation.json" >/dev/null ||
			die "ADVANCE_ONLY_NOT_PUBLISHED: no attestation bundle for $digest; retry: $resume"
	done <"$WORK/published-digests"
	# Only now may the local tag ref change; never replace a conflicting local tag.
	bounded 300 git -C "$ROOT" fetch --quiet origin "refs/tags/v$VERSION:refs/tags/v$VERSION" ||
		die "ADVANCE_ONLY_NOT_PUBLISHED: cannot fetch the published tag; retry: $resume"
	SOURCE="$(git -C "$ROOT" rev-parse "v$VERSION^{commit}")" ||
		die "ADVANCE_ONLY_NOT_PUBLISHED: tag is not a commit; retry: $resume"
	[ "$SOURCE" = "${peeled_source:-$tag_source}" ] ||
		die "ADVANCE_ONLY_NOT_PUBLISHED: origin tag changed during admission; retry: $resume"
	advance_next_version
	exit 0
fi
# RELRESUME1 (ompkit-1ra0d.191): the tag and draft already exist, so the tag and draft stages below are
# skipped and this adoption proves them instead: the remote tag must name a commit whose package.json
# states VERSION (the same version-match gate as a fresh tag), and every draft asset is downloaded and
# must equal the signed bytes (SHA256SUMS over the draft plus the checksum-stage index/archive checks).
# Attest is then re-dispatched by the unchanged stage below, followed by verify, install and next-version.
# ----------------------------------------------------------------- resume-from-draft adoption
# The :- default keeps this extracted stage slice working under the fixtures' set -u, where the flag is unset.
if [ "${RESUME_FROM_DRAFT:-0}" = 1 ]; then
stage resume
resume="release-local --resume-from-draft --version $VERSION"
[ "$(uname -s)" = Darwin ] || die "the local release runs on macOS (it verifies the darwin archive); retry: $resume"
for tool in git gh jq python3 bun curl shasum codesign spctl tar timeout; do
	command -v "$tool" >/dev/null || die "missing tool: $tool; retry: $resume"
done
bounded 60 gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not authenticated to github.com; retry: $resume"
remote_tags="$(bounded 120 git -C "$ROOT" ls-remote --tags origin "refs/tags/v$VERSION")" || die "tag lookup failed; retry: $resume"
[ -n "$remote_tags" ] || die "origin has no tag v$VERSION, nothing to resume; retry: $resume"
bounded 300 git -C "$ROOT" fetch --quiet origin "refs/tags/v$VERSION:refs/tags/v$VERSION" ||
	die "cannot fetch the published tag v$VERSION; retry: $resume"
SOURCE="$(git -C "$ROOT" rev-parse "v$VERSION^{commit}")" || die "tag v$VERSION is not a commit; retry: $resume"
sh "$ROOT/scripts/release-train.sh" version-match --version "$VERSION" --sha "$SOURCE" --repo "$ROOT" ||
	die "remote v$VERSION does not name a commit stating $VERSION; retry: $resume"
# Same read-only release listing the normal path uses for its base tag, minus the refusal: the draft for
# vVERSION exists by design, so only the latest published stable release feeds the receipt.
bounded 120 gh api --paginate --slurp "repos/$REPO/releases?per_page=100" >"$WORK/releases.json" || die "listing releases failed; retry: $resume"
BASE_TAG="$(jq -er '[.[][] | select(.draft == false and .prerelease == false) | .tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last' "$WORK/releases.json")" ||
	die "no published base release; retry: $resume"
SRC="$WORK/src"
mkdir -p "$SRC"
git -C "$ROOT" archive --format=tar "$SOURCE" >"$WORK/source.tar" || die "cannot archive the adopted source $SOURCE; retry: $resume"
tar -xf "$WORK/source.tar" -C "$SRC" || die "cannot export the adopted source $SOURCE; retry: $resume"
rm -f "$WORK/source.tar"
bounded 30 sh "$ROOT/scripts/release-preflight.sh" export "$SRC" "$SOURCE" ||
	die "source export preflight failed; retry: $resume"
bounded 120 gh release view "v$VERSION" --repo "$REPO" --json tagName,isDraft,assets >"$WORK/draft.json" || die "draft readback failed; retry: $resume"
# The gate below is a local python check through a heredoc, exactly like receipt(). The refusal stays off
# the heredoc's own command line: pysafe requires single-segment heredoc command ownership, and bounded
# would reattach the step's stdin to /dev/null and starve the heredoc into a vacuous pass.
if python3 - "$WORK/draft.json" "$VERSION" <<'PY'
import json, re, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
version = sys.argv[2]
required = ["SHA256SUMS", "release-index.json"] + [
    f"omp-kit-v{version}-{platform}.tar.gz"
    for platform in ("darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu")]
if doc.get("tagName") != "v" + version or doc.get("isDraft") is not True:
    raise SystemExit("draft tag or state differs")
assets = doc.get("assets", [])
for name in required:
    matches = [asset for asset in assets if asset.get("name") == name]
    if len(matches) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", matches[0].get("digest", "")):
        raise SystemExit(f"missing or ambiguous draft asset digest: {name}")
PY
then
	:
else
	die "v$VERSION is not a resumable draft (it must stay a draft whose tag and five assets match); retry: $resume"
fi
DIST="$WORK/dist"
mkdir -p "$DIST"
bounded 600 gh release download "v$VERSION" --repo "$REPO" --dir "$DIST" || die "draft download failed; retry: $resume"
for name in SHA256SUMS release-index.json "omp-kit-v$VERSION-darwin-arm64-none.tar.gz" "omp-kit-v$VERSION-linux-arm64-gnu.tar.gz" "omp-kit-v$VERSION-linux-x64-gnu.tar.gz"; do
	[ -f "$DIST/$name" ] || die "draft download is missing $name; retry: $resume"
done
(cd "$DIST" && shasum -a 256 -c SHA256SUMS >/dev/null) || die "draft SHA256SUMS check failed: the draft is not the signed bytes; retry: $resume"
[ "$(jq -er --arg v "$VERSION" 'select(.schema_version == 1 and .version == $v and .source_tag == ("v" + $v)) | .version' "$DIST/release-index.json")" = "$VERSION" ] ||
	die "draft release-index.json does not state $VERSION; retry: $resume"
for platform in darwin-arm64-none linux-arm64-gnu linux-x64-gnu; do
	bounded 120 python3 "$SRC/installer/install.py" inspect "$DIST/release-index.json" "$VERSION" "$platform" >/dev/null ||
		die "draft index refuses $platform; retry: $resume"
	bounded 120 python3 "$SRC/scripts/release_reuse.py" verify-archive --index "$DIST/release-index.json" \
		--platform "$platform" --archive-dir "$DIST" >/dev/null ||
		die "draft $platform archive differs from the draft index; retry: $resume"
done
DARWIN="omp-kit-v$VERSION-darwin-arm64-none.tar.gz"
NOTARY_ID=''
say "resumed v$VERSION from its draft: tag -> $SOURCE, draft assets verify as the signed bytes"
fi

# VERSIONSRC1 (ompkit-fp72.135.1.14): the tagged source must state the
# release version in package.json; a mismatch refuses the tag, never a
# silent mislabel.
sh "$ROOT/scripts/release-train.sh" version-match --version "$VERSION" --sha "$SOURCE" --repo "$ROOT" || die "package.json version does not match v$VERSION at $SOURCE; refusing tag"
# A resume adopts the existing tag and draft above and rejoins at attest; never re-tag.
if [ "${RESUME_FROM_DRAFT:-0}" = 0 ]; then
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
fi
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
for name in SHA256SUMS release-index.json "$DARWIN" "omp-kit-v$VERSION-linux-arm64-gnu.tar.gz" "omp-kit-v$VERSION-linux-x64-gnu.tar.gz"; do
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
substep verify.archive-chains
# The three fetch -> embedded consumer-verifier chains share no mutable files.
# The helper owns bounded process groups, joins every result, and fails closed
# on any chain failure. Checksums above and Gatekeeper below remain serial fences.
bounded 330 python3 "$ROOT/scripts/release-public-verify.py" --public "$PUB" --source "$SRC" \
	--version "$VERSION" --repo "$REPO" "${SHIP[@]}" || die "public archive verification failed"
substep verify.gatekeeper
mkdir "$PUB/x"
tar -xf "$PUB/$DARWIN" -C "$PUB/x" bin/omp-kit
codesign --verify --strict "$PUB/x/bin/omp-kit" || die "public darwin binary signature does not verify"
# A bare Mach-O is not an app to `--type execute`; this is devid_release.py check_signature's assessment.
spctl --assess --type open --context context:primary-signature -vv "$PUB/x/bin/omp-kit" 2>&1 | tee "$WORK/spctl.txt"
grep -q 'source=Notarized Developer ID' "$WORK/spctl.txt" || die "Gatekeeper does not report Notarized Developer ID"
substep ''
RELEASED_AT=$(date +%s)
ADVANCE_PENDING=1
if [ "$INSTALL" = 1 ]; then install_release; fi
advance_next_version
if [ "$INSTALLED" = 1 ]; then receipt installed "$URL" "$RUN_ID"
else receipt released "$URL" "$RUN_ID"; fi
