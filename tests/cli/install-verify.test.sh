#!/bin/sh
# install-verify.test.sh — RT1 installer attestation contract (rz5.59.3).
# Builds one real archive via package-release.sh. The shared gh subprocess double
# tests installer authority-policy orchestration, not real cryptography.
# Public release signature controls are a separate real-gh smoke.
set -eu
: "${TMPDIR:?set a private test scratch directory}" # tempsafe: guard requires private scratch root, creates nothing
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp WORK omp-kit-install-verify-test
mkdir -m 700 "$WORK/assets" "$WORK/home"
PLATFORM="$(/usr/bin/uname -s | tr '[:upper:]' '[:lower:]')-$(/usr/bin/uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')-$(if [ "$(/usr/bin/uname -s)" = Darwin ]; then printf none; else printf gnu; fi)"
ASSET=$(TMPDIR="$WORK" "$ROOT/scripts/package-release.sh" --version 1.2.3 --platform "$PLATFORM" --out "$WORK/assets")
printf '%s\n' "$ASSET" > "$WORK/asset.json"
python3 - "$WORK/asset.json" "$WORK/assets/release-index.json" <<'PY'
import json,sys
asset=json.load(open(sys.argv[1]))
key='-'.join(asset[k] for k in ('os','arch','libc'))
with open(sys.argv[2],'w') as out: json.dump({'schema_version':1,'version':'1.2.3','source_tag':'v1.2.3','assets':{key:asset}},out)
PY
ARCHIVE=$(python3 - "$WORK/asset.json" "$WORK/assets" <<'PY'
import json,os,sys
print(os.path.join(sys.argv[2],json.load(open(sys.argv[1]))['filename']))
PY
)
INSTALL="$ROOT/installer/install.sh"
pass=0
fail=0
expect_pass() {
	name=$1; shift
	if "$@" > "$WORK/out.log" 2> "$WORK/err.log"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc!=0 err<<<%s>>>\n' "$name" "$(cat "$WORK/err.log")"; fi
}
expect_refuse() {
	name=$1; shift
	if "$@" > "$WORK/out.log" 2> "$WORK/err.log"; then fail=$((fail + 1)); printf 'FAIL %s: passed, want refusal\n' "$name";
	else pass=$((pass + 1)); fi
}
# Shared policy-enforcing test double: never claim this as live signature proof.
export PATH="$ROOT/tests/fixtures/kit-release:$PATH"
# 1. tampered archive (one byte, correct filename) is refused by the hash check (planted)
mkdir -p "$WORK/t2"
TAMPERED="$WORK/t2/$(basename "$ARCHIVE")"
cp "$ARCHIVE" "$TAMPERED"
printf '\001' | dd of="$TAMPERED" bs=1 seek=100 conv=notrunc 2>/dev/null
printf '{"fixture":true}' > "$TAMPERED.sigstore.json"
expect_refuse tampered-refused env HOME="$WORK/home" "$INSTALL" --offline "$TAMPERED" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx1" --dry-run
# 2. valid archive plus synthetic accepted bundle reaches the installer dry-run.
printf '{"fixture":true}' > "$ARCHIVE.sigstore.json"
expect_pass bundle-policy-control env HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx2" --dry-run
# 3. checksum-correct archive, nonverifying bundle: refuse.
printf '{"fixture":false}' > "$ARCHIVE.sigstore.json"
expect_refuse bundle-bad-refused env HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx3" --dry-run
grep -q 'KIT_ATTESTATION_UNVERIFIED' "$WORK/err.log" || { cat "$WORK/err.log" >&2; exit 1; }
rm -f "$ARCHIVE.sigstore.json"
# 4. missing bundle must refuse, even if historical weakening variables are set.
expect_refuse no-bundle-refused env OMP_KIT_ATTEST_OWNER=attacker GH_BIN=/usr/bin/true HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx4" --dry-run
grep -q 'KIT_ATTESTATION_BUNDLE_MISSING' "$WORK/err.log" || { cat "$WORK/err.log" >&2; exit 1; }
# 5. no verifier must refuse an otherwise accepted bundle.
printf '{"fixture":true}' > "$ARCHIVE.sigstore.json"
mkdir -m 700 "$WORK/no-verifier-bin"
for utility in python3 dirname uname getconf; do
  ln -s "$(command -v "$utility")" "$WORK/no-verifier-bin/$utility"
done
expect_refuse absent-verifier-refused env PATH="$WORK/no-verifier-bin" HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx5" --dry-run
grep -q 'KIT_ATTESTATION_VERIFIER_UNAVAILABLE' "$WORK/err.log" || { cat "$WORK/err.log" >&2; exit 1; }
printf 'install-verify: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
