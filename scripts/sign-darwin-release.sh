#!/usr/bin/env bash
# scripts/sign-darwin-release.sh: the DEVID-SIGN-V1 local signer (docs/release-signing.md).
#
# Run on the maintainer's Mac. It takes the CI-qualified darwin archive of a tagged cut, signs every
# Mach-O with the Developer ID identity in the login keychain (selected by SHA-1; the key is never
# exported), notarizes, verifies with the same scripts/devid_release.py checks CI repeats, executes the
# binary, repackages, uploads the archive to the draft release and dispatches the tag-ref signing run,
# which attests the final digests and lets the publisher finalize the draft. Any failure stops before
# the first remote write; --dry-run never writes remotely.
#
# Usage: scripts/sign-darwin-release.sh [--version X.Y.Z] [--dry-run]
#   Without --version: the newest successful qualification whose tag exists, whose source carries the
#   DEVID-SIGN-V1 marker, and that has no signing run yet (exits 0 when there is none).
#
# Environment:
#   TMPDIR                  an owned scratch directory (required); the run keeps its evidence there
#   OMP_KIT_DEVID_SHA1      codesigning identity SHA-1 (default: the unique identity named below)
#   OMP_KIT_NOTARY_PROFILE  notarytool keychain profile (default: zscast)
#   OMP_KIT_REPO            GitHub repository (default: JYeswak/omp-kit-companion)
#   OMP_KIT_DEVID_STATE     dispatch receipts and a blobless main mirror (default: ${XDG_STATE_HOME:-~/.local/state}/omp-kit/devid-sign)
#   OMP_KIT_SIGNING_KEYCHAIN           dedicated signing keychain (default: ~/Library/Keychains/uds-signing.keychain-db)
#   OMP_KIT_SIGNING_KEYCHAIN_PASSWORD  file holding its password, the uds lane's source (default: ~/.config/uds/signing-keychain.pw)
set -euo pipefail

REPO="${OMP_KIT_REPO:-JYeswak/omp-kit-companion}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM=darwin-arm64-none
AUTHORITY='Developer ID Application: Joshua Nowak (XGL9CXRCT5)'
NOTARY_PROFILE="${OMP_KIT_NOTARY_PROFILE:-zscast}"
STATE="${OMP_KIT_DEVID_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/omp-kit/devid-sign}"
KEYCHAIN="${OMP_KIT_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/uds-signing.keychain-db}"
KEYCHAIN_PASSWORD="${OMP_KIT_SIGNING_KEYCHAIN_PASSWORD:-$HOME/.config/uds/signing-keychain.pw}"
# The shared checkout may be shallow or carry foreign grafts; authority checks read a dedicated blobless mirror.
MIRROR="$STATE/mirror.git"

die() { echo "sign-darwin-release: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
# Only --dry-run continues past a remote-state refusal, so a published cut can still be rehearsed.
remote_refusal() { if [ "$DRY_RUN" = 1 ]; then echo "sign-darwin-release: dry-run would refuse: $*" >&2; else die "$*"; fi; }

DRY_RUN=0
VERSION=''
while [ "$#" -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--version) [ "$#" -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift ;;
		-h | --help) sed -n '2,24p' "$0"; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
	shift
done
[ -z "$VERSION" ] || [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "--version must be X.Y.Z"
if [ -z "${TMPDIR:-}" ] || [ ! -d "$TMPDIR" ]; then die "export TMPDIR to an owned scratch directory first"; fi
WORK="$(mktemp -d "$TMPDIR/sign-darwin-release.XXXXXXXX")"
say "work directory (kept as evidence): $WORK"

# 1. Preflight: tools, signing keychain, identity by SHA-1, certificate validity, notary credentials, GitHub auth.
[ "$(uname -s)" = Darwin ] || die "the signer runs on macOS"
for tool in codesign xcrun security spctl ditto plutil openssl unzip shasum gh git jq python3; do
	command -v "$tool" >/dev/null || die "missing tool: $tool"
done
[ -f "$KEYCHAIN" ] || die "signing keychain $KEYCHAIN not found (set OMP_KIT_SIGNING_KEYCHAIN)"
# The password is read in-process and never reaches argv, stdout or a log; the keychain re-locks on every exit.
relock() { security lock-keychain "$KEYCHAIN" || echo "sign-darwin-release: WARNING: could not re-lock $KEYCHAIN" >&2; }
trap relock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$ROOT/scripts/devid_release.py" keychain-unlock --keychain "$KEYCHAIN" --password-file "$KEYCHAIN_PASSWORD" >/dev/null ||
	die "could not unlock $KEYCHAIN"
identities="$(security find-identity -v -p codesigning "$KEYCHAIN")"
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
security find-certificate -a -Z -p -c "$AUTHORITY" "$KEYCHAIN" | awk -v want="$SHA1" '
	/^SHA-1 hash:/ { keep = ($3 == want); next }
	keep && /-----BEGIN CERTIFICATE-----/ { pem = 1 }
	pem { print }
	pem && /-----END CERTIFICATE-----/ { exit }' >"$WORK/identity.pem"
[ -s "$WORK/identity.pem" ] || die "certificate $SHA1 not found"
openssl x509 -noout -checkend 0 -in "$WORK/identity.pem" >/dev/null || die "'$AUTHORITY' ($SHA1) has expired"
if ! openssl x509 -noout -checkend $((30 * 24 * 60 * 60)) -in "$WORK/identity.pem" >/dev/null; then
	echo "sign-darwin-release: WARNING: the signing certificate expires within 30 days: $(openssl x509 -noout -enddate -in "$WORK/identity.pem")" >&2
fi
# Notary credentials are proven before anything is built or signed.
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN" --output-format json >"$WORK/notary-history.json" ||
	die "notarytool history failed for keychain profile '$NOTARY_PROFILE'"
gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not authenticated to github.com"
say "identity $SHA1 ($AUTHORITY); notary profile $NOTARY_PROFILE proven"

# 2. Select the cut.
mkdir -p "$STATE"
if [ ! -d "$MIRROR" ]; then git clone --quiet --bare --filter=blob:none "https://github.com/$REPO.git" "$MIRROR"; fi
git --git-dir "$MIRROR" fetch --quiet origin '+refs/heads/main:refs/heads/main' '+refs/tags/*:refs/tags/*'
mirror() { git --git-dir "$MIRROR" "$@"; }
gh run list --repo "$REPO" --workflow release.yml --event workflow_dispatch --limit 200 \
	--json databaseId,displayTitle,status,conclusion,headBranch >"$WORK/release-runs.json"
selected=''
while read -r run_id title; do
	read -r _ version sha train <<<"$title"
	[ -z "$VERSION" ] || [ "$version" = "$VERSION" ] || continue
	signs="$(jq -r --arg t "sign $version $sha $train" '[.[] | select(.displayTitle == $t)] | length' "$WORK/release-runs.json")"
	tagged="$(gh api "repos/$REPO/git/ref/tags/v$version" --jq 'select(.object.type == "commit") | .object.sha' 2>/dev/null || true)"
	mode="$(mirror show "$sha:scripts/release-signing.json" 2>/dev/null | jq -r 'select(.schema_version == 1) | .darwin_signing' 2>/dev/null || true)"
	marked=0
	if [ "$mode" = developer-id ]; then marked=1; fi
	if [ -z "$VERSION" ] && { [ "$signs" != 0 ] || [ "$tagged" != "$sha" ] || [ "$marked" != 1 ]; }; then continue; fi
	[ "$signs" = 0 ] || remote_refusal "v$version already has a tag-ref signing run; never sign a cut twice"
	[ "$tagged" = "$sha" ] || remote_refusal "tag v$version does not name the qualified source $sha (publisher has not tagged it)"
	[ "$marked" = 1 ] || remote_refusal "source $sha has darwin_signing=${mode:-adhoc} (scripts/release-signing.json); its publisher signs it ad hoc"
	selected="$run_id $version $sha ${train#train-}"
	break
done < <(jq -r '.[] | select(.status == "completed" and .conclusion == "success" and .headBranch == "main"
	and (.displayTitle | test("^qualify [0-9]+\\.[0-9]+\\.[0-9]+ [0-9a-f]{40} train-[0-9]+$"))) | "\(.databaseId) \(.displayTitle)"' "$WORK/release-runs.json")
if [ -z "$selected" ]; then
	[ -z "$VERSION" ] || die "no successful qualification of $VERSION in the latest 200 release runs"
	echo "SIGNER=idle REASON=no-unsigned-qualified-cut"
	exit 0
fi
read -r RUN_ID VERSION SOURCE TRAIN <<<"$selected"
FILENAME="omp-kit-v$VERSION-$PLATFORM.tar"
say "cut v$VERSION source $SOURCE qualification $RUN_ID train $TRAIN"

# 3. Fetch the qualified artifacts; each zip must hash to the digest GitHub recorded at upload.
gh api "repos/$REPO/actions/runs/$RUN_ID" >"$WORK/producer-run.json"
ATTEMPT="$(jq -er '.run_attempt | select(type == "number" and . >= 1)' "$WORK/producer-run.json")"
gh api --paginate --slurp "repos/$REPO/actions/runs/$RUN_ID/artifacts?per_page=100" |
	jq '{artifacts: [.[].artifacts[]]}' >"$WORK/producer-artifacts.json"
for name in "unpublished-candidate-index-attempt-$ATTEMPT" "release-selection-attempt-$ATTEMPT" "candidate-$PLATFORM-attempt-$ATTEMPT"; do
	row="$(jq -ec --arg n "$name" '[.artifacts[] | select(.name == $n and .expired == false)] | select(length == 1) | .[0]' "$WORK/producer-artifacts.json")" ||
		die "qualification artifact $name is missing, expired or ambiguous"
	gh api "repos/$REPO/actions/artifacts/$(jq -r .id <<<"$row")/zip" >"$WORK/$name.zip"
	[ "sha256:$(shasum -a 256 "$WORK/$name.zip" | awk '{print $1}')" = "$(jq -r .digest <<<"$row")" ] ||
		die "artifact $name does not hash to GitHub's recorded digest"
	unzip -q "$WORK/$name.zip" -d "$WORK/$name"
done
INDEX_DIR="$WORK/unpublished-candidate-index-attempt-$ATTEMPT"
SELECTION_DIR="$WORK/release-selection-attempt-$ATTEMPT"
CANDIDATE_DIR="$WORK/candidate-$PLATFORM-attempt-$ATTEMPT"
mirror merge-base --is-ancestor "$SOURCE" refs/heads/main || die "source $SOURCE is not on main"
mirror show "$SOURCE:scripts/omp-compat.json" >"$WORK/omp-config.json"
# The publisher's own pre-tag gate: native receipts bind this index to the authorized qualification.
(cd "$ROOT" && GIT_DIR="$MIRROR" python3 scripts/release_reuse.py verify-final --proof "$INDEX_DIR/candidate-proof.json" \
	--index "$INDEX_DIR/release-index.json" --omp-config "$WORK/omp-config.json" --source-sha "$SOURCE" \
	--version "$VERSION" --run "$WORK/producer-run.json" --artifacts "$WORK/producer-artifacts.json" \
	--binding "$SELECTION_DIR/selection.json" --notes "$SELECTION_DIR/release-notes.md" --repository "$REPO" \
	--train-id "$TRAIN" --run-id "$RUN_ID" --phase qualify) || die "the qualification does not verify"
python3 "$ROOT/scripts/release_reuse.py" verify-archive --index "$INDEX_DIR/release-index.json" \
	--platform "$PLATFORM" --archive-dir "$CANDIDATE_DIR" || die "the darwin candidate differs from the qualified index"

# 4-5. Extract and sign each Mach-O with the source's entitlements.
if ! mirror show "$SOURCE:packaging/macos/omp-kit.entitlements.plist" >"$WORK/entitlements.plist" 2>/dev/null; then
	remote_refusal "source $SOURCE has no packaging/macos/omp-kit.entitlements.plist"
	cp "$ROOT/packaging/macos/omp-kit.entitlements.plist" "$WORK/entitlements.plist"
fi
plutil -lint "$WORK/entitlements.plist" >/dev/null || die "the source's entitlements plist is invalid"
python3 "$ROOT/scripts/devid_release.py" prepare --archive "$CANDIDATE_DIR/$FILENAME" \
	--index "$INDEX_DIR/release-index.json" --version "$VERSION" --out "$WORK/signed" >"$WORK/prepare.json"
while read -r path identifier; do
	codesign --force --keychain "$KEYCHAIN" --sign "$SHA1" --options runtime --timestamp --identifier "$identifier" \
		--entitlements "$WORK/entitlements.plist" "$WORK/signed/$path"
	codesign --verify --strict "$WORK/signed/$path"
	say "signed $path as $identifier"
done < <(jq -r '.members[] | "\(.path) \(.identifier)"' "$WORK/prepare.json")
mkdir "$WORK/out"
python3 "$ROOT/scripts/devid_release.py" repack --archive "$CANDIDATE_DIR/$FILENAME" --index "$INDEX_DIR/release-index.json" \
	--version "$VERSION" --signed-dir "$WORK/signed" --out-archive "$WORK/out/$FILENAME" --out-index "$WORK/out/release-index.json" >"$WORK/repack.json"
# Signature, team, runtime, timestamp and entitlements before anything goes to Apple.
python3 "$ROOT/scripts/devid_release.py" verify --qualified-archive "$CANDIDATE_DIR/$FILENAME" \
	--qualified-index "$INDEX_DIR/release-index.json" --signed-archive "$WORK/out/$FILENAME" --version "$VERSION" \
	--entitlements "$WORK/entitlements.plist" --no-notarization >/dev/null || die "the signed archive does not verify"

# 6. Notarize the signed Mach-O set; a bare Mach-O cannot be stapled, Gatekeeper looks the ticket up online.
ditto -c -k --keepParent "$WORK/signed" "$WORK/notarize.zip"
xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN" --wait --timeout 30m \
	--output-format json >"$WORK/notary.json" || true
status="$(jq -r '.status // ""' "$WORK/notary.json" 2>/dev/null || true)"
if [ "$status" != Accepted ]; then
	submission="$(jq -r '.id // ""' "$WORK/notary.json" 2>/dev/null || true)"
	[ -z "$submission" ] || xcrun notarytool log "$submission" --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN" "$WORK/notary-log.json" || true
	die "notarization ended '${status:-no status}' (see $WORK/notary.json and notary-log.json)"
fi
say "notarized: submission $(jq -r .id "$WORK/notary.json")"

# 7-8. The full CI verification, plus execution of the signed binary from the installed layout.
python3 "$ROOT/scripts/devid_release.py" verify --qualified-archive "$CANDIDATE_DIR/$FILENAME" \
	--qualified-index "$INDEX_DIR/release-index.json" --signed-archive "$WORK/out/$FILENAME" --version "$VERSION" \
	--entitlements "$WORK/entitlements.plist" --execute --index-out "$WORK/out/release-index.verified.json" >"$WORK/verify.json" ||
	die "the notarized archive does not verify"
cmp -s "$WORK/out/release-index.json" "$WORK/out/release-index.verified.json" || die "repacked and verified indexes differ"
DARWIN_SHA256="$(jq -r .archive_sha256 "$WORK/verify.json")"
say "verified: $(jq -c '.signed' "$WORK/verify.json") archive $DARWIN_SHA256"

if [ "$DRY_RUN" = 1 ]; then
	echo "DRY_RUN=complete version=$VERSION archive_sha256=$DARWIN_SHA256 work=$WORK"
	echo "would: create draft v$VERSION if absent (notes: $SELECTION_DIR/release-notes.md), upload $WORK/out/$FILENAME, and dispatch"
	echo "would: release.yml@v$VERSION version=$VERSION sha=$SOURCE certified_run_id=$RUN_ID darwin_sha256=$DARWIN_SHA256"
	exit 0
fi

# 9. Draft: create it or require the existing one to be this cut's draft; upload without ever clobbering.
gh api --paginate --slurp "repos/$REPO/releases?per_page=100" |
	jq --arg tag "v$VERSION" '[.[][] | select(.tag_name == $tag)]' >"$WORK/releases.json"
case "$(jq length "$WORK/releases.json")" in
	0) gh release create "v$VERSION" --repo "$REPO" --verify-tag --draft --title "v$VERSION" \
		--notes-file "$SELECTION_DIR/release-notes.md" >/dev/null ;;
	1) jq -e '.[0].draft == true and .[0].prerelease == false' "$WORK/releases.json" >/dev/null ||
		die "v$VERSION already has a non-draft release"
	   python3 -c 'import json, sys; release = json.load(open(sys.argv[1]))[0]
sys.exit(0 if (release.get("body") or "").strip() == open(sys.argv[2], encoding="utf-8").read().strip() else 1)' \
		"$WORK/releases.json" "$SELECTION_DIR/release-notes.md" || die "the existing draft's notes are not this cut's notes" ;;
	*) die "v$VERSION has several releases" ;;
esac
asset_digest() {
	gh api --paginate --slurp "repos/$REPO/releases?per_page=100" | jq -r --arg tag "v$VERSION" --arg name "$FILENAME" \
		'[.[][] | select(.tag_name == $tag) | .assets[] | select(.name == $name) | .digest] | if length == 1 then .[0] elif length == 0 then "" else error("ambiguous") end'
}
existing="$(asset_digest)"
if [ -z "$existing" ]; then
	gh release upload "v$VERSION" "$WORK/out/$FILENAME" --repo "$REPO"
	existing="$(asset_digest)"
fi
[ "$existing" = "sha256:$DARWIN_SHA256" ] || die "draft asset $FILENAME is $existing, not the verified sha256:$DARWIN_SHA256; never clobbered"
say "draft v$VERSION holds $FILENAME sha256:$DARWIN_SHA256"

# 10. Dispatch the tag-ref signing run exactly once (crash-recovery receipt under $STATE).
mkdir -p "$STATE"
(cd "$ROOT" && GIT_DIR="$MIRROR" python3 scripts/release_reuse.py dispatch-devid-sign --repository "$REPO" \
	--selection "$SELECTION_DIR/selection.json" --notes "$SELECTION_DIR/release-notes.md" \
	--darwin-sha256 "$DARWIN_SHA256" --receipt-dir "$STATE")
