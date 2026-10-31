#!/usr/bin/env bash
# scripts/release-local.sh: LOCAL-RELEASE-V1 (ompkit-v66l.27.11, J-2026-10-18-30), the dsr-style local release.
#
# Run on the signing Mac. It cuts one omp-kit release without the CI qualification pipeline:
#   1. preflight  source = an exact commit on origin/main (default: its head); version unused (no tag, no release,
#                 no draft); the source is a developer-id release whose release.yml carries attest-local.
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
#                 fixtures) on the exact-commit source; refusal exits 4, nothing remote written.
#   4c. ci-only-local
#                 package-release.test.ts and kit-update.test.ts against the
#                 exact-commit export (gate-ci-only.tsv calls them "ci-only",
#                 but CI is disabled); refusal exits 4, nothing remote written.
#                 external-live.test.ts stays out: it needs the host's live OMP
#                 launcher, so it is not hermetic.
#   --dry-run stops here: no tag, no draft, no dispatch, no remote write.
#   5. tag        push the lightweight tag v<version> -> source (never forced, never re-tagged).
#   6. draft      create the draft release with the notes from release-notes.sh and require GitHub's recorded
#                 digest of every asset to equal the local bytes.
#   7. attest     dispatch release.yml (mode=local-attest) at --ref v<version>; it re-checks the draft against
#                 SHA256SUMS, attests SLSA provenance + SBOMs with GitHub OIDC (the consumers' pinned trust root),
#                 verifies with the consumer's verifier and publishes the draft.
#   8. verify     download every asset from the public release URL, check SHA256SUMS and the local bytes, fetch
#                 each archive's attestation bundle exactly as kit-update-job.ts does and run the embedded
#                 installer verifier exactly as kit-update.ts does, then check Gatekeeper on the darwin binary.
#
# Usage: scripts/release-local.sh [--version X.Y.Z] [--source SHA] [--dry-run]
# Environment:
#   TMPDIR                             an owned scratch directory (required); the build tree is removed on exit
#   OMP_KIT_REPO                       GitHub repository (default: JYeswak/omp-kit-companion)
#   OMP_KIT_DEVID_SHA1                 codesigning identity SHA-1 (default: the unique Developer ID identity)
#   OMP_KIT_NOTARY_PROFILE             notarytool profile in the signing keychain (default: omp-kit-notary)
#   OMP_KIT_SIGNING_KEYCHAIN           signing keychain (default: ~/Library/Keychains/uds-signing.keychain-db)
#   OMP_KIT_SIGNING_KEYCHAIN_PASSWORD  file holding its password (default: ~/.config/uds/signing-keychain.pw)
# Exit: 0 released (or dry run complete), 2 usage, 4 refused (nothing remote written before the tag step).
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

die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }

DRY_RUN=0
VERSION=''
SOURCE=''
TAG_PUSH_SECONDS=''
while [ "$#" -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1; shift ;;
		--version) VERSION="${2:-}"; shift 2 ;;
		--source) SOURCE="${2:-}"; shift 2 ;;
		-h|--help) sed -n '2,36p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "release-local: unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ -z "$VERSION" ] || [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "release-local: --version must be X.Y.Z" >&2; exit 2; }
[ -z "$SOURCE" ] || [[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "release-local: --source must be a full commit SHA" >&2; exit 2; }
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

# ---------------------------------------------------------------------------------------------- 1. preflight
stage preflight
[ "$(uname -s)" = Darwin ] || die "the local release runs on macOS (it signs and notarizes the darwin archive)"
for tool in git gh jq python3 bun shasum codesign xcrun security spctl ditto plutil openssl curl tar timeout; do
	command -v "$tool" >/dev/null || die "missing tool: $tool"
done
bounded 60 gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not authenticated to github.com"
bounded 300 git -C "$ROOT" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || die "git fetch origin main failed"
MAIN="$(git -C "$ROOT" rev-parse refs/remotes/origin/main)"
if [ -z "$SOURCE" ]; then SOURCE="$MAIN"; fi
git -C "$ROOT" cat-file -e "$SOURCE^{commit}" 2>/dev/null || die "source $SOURCE is not a known commit"
git -C "$ROOT" merge-base --is-ancestor "$SOURCE" "$MAIN" || die "source $SOURCE is not on origin/main"
remote_tags="$(bounded 120 git -C "$ROOT" ls-remote --tags origin)" || die "git ls-remote --tags failed"
if [ -z "$VERSION" ]; then
	VERSION="$(printf '%s\n' "$remote_tags" | (cd "$ROOT" && sh scripts/release-train.sh next-version --changelog-ref "$SOURCE"))" ||
		die "release-train.sh next-version failed"
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
if ! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" \
	>"$WORK/full-suite-verdict.out"; then
	verdict_result="$(cat "$WORK/full-suite-verdict.out")"
	die "source tree $source_tree has no reusable main-role full-suite PASS ($verdict_result)"
fi
[ "$(cat "$WORK/full-suite-verdict.out")" = PASS ] || die "source tree $source_tree full-suite readback is not PASS"
say "full-suite verdict $source_tree: PASS (main role)"

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

# ----------------------------------------------------------------- 4c. ci-only-local
# gate-ci-only.tsv lists package-release.test.ts and kit-update.test.ts as
# "ci-only", but CI is disabled, so without this stage they run nowhere. Run
# both files with cwd set to the exact-commit export: kit-update builds its
# N+2 candidate from that tree (its MANIFEST.tsv is regenerated inside the
# fixture), and package-release archives the exact commit and asserts the
# export carries no MANIFEST.tsv. Refuse here, before the tag, in both
# dry-run and real runs.
# The export is made a throwaway git root first (a local --depth 1 fetch of
# $SOURCE): the test's `git -C` archive only yields the full tree from a
# repository root, and the runtime work-root check requires OMP_KIT_CASE_CWD
# to be that same root.
# Wall time on this Mac (2026-10-27, exact 0021cef export, load ~16 on 32 cores):
# package-release.test.ts 353 s (18 pass, 0 fail), kit-update.test.ts 300 s
# (24 tests: 20 pass; the other 4 are UpdateBundleIsolation's uncommitted-hunk
# tests, which need their uncommitted src). Bounds below (900/2400) hold
# 2.5x/8x margin over both.
# tests/cli/external-live.test.ts stays out: it executes the host's real OMP
# launcher (ambient OMP/OMP_BIN/OMP_PATH must all name the same absolute
# binary, or the run fails closed BLOCKED/NATIVE_IDENTITY_UNAVAILABLE)
# and binds a localhost mock-model server, so it is not hermetic.
stage ci-only-local
git -C "$SRC" -c init.defaultBranch=main init -q ||
	die "ci-only-local git init failed; refusing release"
bounded 120 git -C "$SRC" fetch -q --depth 1 "$ROOT" "$SOURCE" ||
	die "ci-only-local fetch of $SOURCE failed; refusing release"
SRC_REAL="$(cd "$SRC" && pwd -P)" || die "ci-only-local cannot resolve $SRC; refusing release"
# ci_only_refuse NAME: $WORK is removed on exit, so the refusal must carry the failure itself. On
# 2026-10-31 the 0.2.81 refusal pointed at a deleted stderr file and cost a full reproduction run.
ci_only_refuse() {
	echo "release-local: $1 output (last 60 lines of stderr, then stdout):" >&2
	tail -n 60 "$WORK/ci-only-$1.stderr" >&2 || true
	tail -n 20 "$WORK/ci-only-$1.stdout" >&2 || true
	die "$1.test.ts FAIL on the release source; refusing release"
}
(cd "$SRC_REAL" && OMP_KIT_CASE_CWD="$SRC_REAL" bounded 900 bun test tests/cli/package-release.test.ts \
	>"$WORK/ci-only-package-release.stdout" 2>"$WORK/ci-only-package-release.stderr") ||
	ci_only_refuse package-release
(cd "$SRC_REAL" && OMP_KIT_CASE_CWD="$SRC_REAL" bounded 2400 bun test tests/cli/kit-update.test.ts \
	>"$WORK/ci-only-kit-update.stdout" 2>"$WORK/ci-only-kit-update.stderr") ||
	ci_only_refuse kit-update
say "ci-only-local PASS"

receipt() {
	local phase=$1 url=${2:-} run_id=${3:-}
	stage ''
	python3 - "$STAGE_LOG" "$DIST/SHA256SUMS" "$phase" "$VERSION" "$SOURCE" "$BASE_TAG" "$NOTARY_ID" "$url" "$run_id" \
		"$(( $(date +%s) - STARTED ))" "$TMPDIR/release-local-v$VERSION-$phase.json" "$TAG_PUSH_SECONDS" <<'PY' # tempsafe: receipt into the caller-owned scratch, kept past exit by contract
import json, sys
stages, sums, phase, version, source, base, notary, url, run_id, total, out, tag_push_seconds = sys.argv[1:]
doc = {"schema_version": 1, "phase": phase, "version": version, "source_sha": source, "base_tag": base,
       "notarization_submission": notary, "release_url": url or None, "attest_run_id": run_id or None,
       "sha256": {name: digest for digest, name in (line.split("  ", 1) for line in open(sums).read().splitlines())},
       "stage_seconds": {name: int(secs) for name, secs in (line.split() for line in open(stages).read().splitlines())},
       "total_seconds": int(total),
       "tag_push_seconds": int(tag_push_seconds) if tag_push_seconds else None}
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
say "tagged v$VERSION -> $SOURCE"

# --------------------------------------------------------------------------------------------------- 6. draft
stage draft
bounded 1800 gh release create "v$VERSION" --repo "$REPO" --verify-tag --draft --title "v$VERSION" \
	--notes-file "$WORK/release-notes.md" "$DIST"/* || die "draft creation failed (tag v$VERSION exists; resume from the draft, never re-tag)"
bounded 120 gh release view "v$VERSION" --repo "$REPO" --json isDraft,assets >"$WORK/draft.json" || die "draft readback failed"
[ "$(jq -r .isDraft "$WORK/draft.json")" = true ] || die "v$VERSION is not a draft"
for file in "$DIST"/*; do
	name="$(basename "$file")"
	[ "$(jq -r --arg n "$name" '.assets[] | select(.name == $n) | .digest' "$WORK/draft.json")" = "sha256:$(sha_of "$file")" ] ||
		die "draft asset $name is not the local bytes"
done
say "draft v$VERSION holds $(jq -r '[.assets[].name] | join(" ")' "$WORK/draft.json")"

# -------------------------------------------------------------------------------------------------- 7. attest
stage attest
dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bounded 120 gh workflow run release.yml --repo "$REPO" --ref "v$VERSION" -f version="$VERSION" -f mode=local-attest ||
	die "dispatching release.yml (mode=local-attest) failed; is the workflow enabled?"
RUN_ID=''
for _ in $(seq 1 30); do
	RUN_ID="$(bounded 60 gh run list --repo "$REPO" --workflow release.yml --event workflow_dispatch --limit 20 \
		--json databaseId,displayTitle,createdAt --jq "[.[] | select(.createdAt >= \"$dispatched_at\" and (.displayTitle | startswith(\"attest-local $VERSION \")))] | .[0].databaseId // \"\"")" || RUN_ID=''
	[ -z "$RUN_ID" ] || break
	sleep 5
done
[ -n "$RUN_ID" ] || die "the attest-local run did not appear"
say "attest-local run https://github.com/$REPO/actions/runs/$RUN_ID"
deadline=$(( $(date +%s) + 1800 ))
while :; do
	state="$(bounded 60 gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion --jq '.status + " " + .conclusion')" || state='unknown '
	case "$state" in
		"completed success") break ;;
		completed*) bounded 120 gh run view "$RUN_ID" --repo "$REPO" --log-failed >&2 || true
			die "attest-local run $RUN_ID ended: $state (draft v$VERSION kept; fix and redispatch, never re-tag)" ;;
	esac
	[ "$(date +%s)" -lt "$deadline" ] || die "attest-local run $RUN_ID still '$state' after 30 min"
	sleep 20
done
bounded 120 gh run view "$RUN_ID" --repo "$REPO" --log >"$WORK/attest.log" || true
grep -E 'CONSUMER_VERIFY=|PUBLISHED ' "$WORK/attest.log" | sed 's/^.*\(CONSUMER_VERIFY=\|PUBLISHED \)/\1/' || true

# -------------------------------------------------------------------------------------------------- 8. verify
stage verify
PUB="$WORK/public"
mkdir "$PUB"
URL="https://github.com/$REPO/releases/tag/v$VERSION"
for name in SHA256SUMS release-index.json "$DARWIN" "omp-kit-v$VERSION-linux-arm64-gnu.tar" "omp-kit-v$VERSION-linux-x64-gnu.tar"; do
	bounded 600 curl -fsSL --retry 3 -o "$PUB/$name" "https://github.com/$REPO/releases/download/v$VERSION/$name" || die "public download of $name failed"
	cmp -s "$PUB/$name" "$DIST/$name" || die "public $name differs from the locally signed bytes"
done
(cd "$PUB" && shasum -a 256 -c SHA256SUMS) || die "public SHA256SUMS check failed"
for platform in "${SHIP[@]}"; do
	archive="$PUB/omp-kit-v$VERSION-$platform.tar"
	digest="$(sha_of "$archive")"
	# Exactly kit-update-job.ts pollPublishedRelease's fetch, then kit-update.ts authenticateUpdateArchive's verifier.
	bounded 120 gh api --hostname github.com "repos/$REPO/attestations/sha256:$digest" --jq '.attestations[].bundle | tojson' \
		>"$archive.sigstore.json" || die "no attestation bundle for $platform ($digest)"
	bounded 180 python3 -I -c "$(cat "$SRC/installer/install.py")" attestation "$archive" "$VERSION" unused ||
		die "the consumer verifier refuses $platform"
	echo "CONSUMER_VERIFY=ok platform=$platform sha256=$digest"
done
mkdir "$PUB/x"
tar -xf "$PUB/$DARWIN" -C "$PUB/x" bin/omp-kit
codesign --verify --strict "$PUB/x/bin/omp-kit" || die "public darwin binary signature does not verify"
# A bare Mach-O is not an app to `--type execute`; this is devid_release.py check_signature's assessment.
spctl --assess --type open --context context:primary-signature -vv "$PUB/x/bin/omp-kit" 2>&1 | tee "$WORK/spctl.txt"
grep -q 'source=Notarized Developer ID' "$WORK/spctl.txt" || die "Gatekeeper does not report Notarized Developer ID"
receipt released "$URL" "$RUN_ID"
