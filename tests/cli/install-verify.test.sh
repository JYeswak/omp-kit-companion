#!/bin/sh
# install-verify.test.sh — RT1 installer attestation contract (rz5.59.3).
# Builds one real archive via package-release.sh, then proves through
# install.sh --offline --dry-run: a tampered archive is refused (hash), a
# present bundle verified by stub gh passes, a failing stub gh refuses, and a
# missing bundle warns hash-only (offline installs keep working).
set -eu
: "${TMPDIR:?set a private test scratch directory}"
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
WORK=$(mktemp -d "$TMPDIR/omp-kit-install-verify-test.XXXXXXXX")
trap 'rm -rf -- "$WORK"' EXIT HUP INT TERM
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
# Stub gh: passes iff $GH_MODE is "ok".
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'EOF'
#!/bin/sh
[ "${GH_MODE:-}" = "ok" ] && exit 0
echo "stub gh: attestation INVALID" >&2
exit 1
EOF
chmod +x "$WORK/bin/gh"
export GH_BIN="$WORK/bin/gh"
# 1. tampered archive (one byte, correct filename) is refused by the hash check (planted)
mkdir -p "$WORK/t2"
TAMPERED="$WORK/t2/$(basename "$ARCHIVE")"
cp "$ARCHIVE" "$TAMPERED"
printf '\001' | dd of="$TAMPERED" bs=1 seek=100 conv=notrunc 2>/dev/null
expect_refuse tampered-refused env HOME="$WORK/home" "$INSTALL" --offline "$TAMPERED" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx1" --dry-run
# 2. valid archive, bundle present, stub gh ok: passes (planted)
printf '{"bundle":"stub"}' > "$ARCHIVE.sigstore.json"
expect_pass bundle-ok env GH_MODE=ok HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx2" --dry-run
rm -f "$ARCHIVE.sigstore.json"
# 3. valid archive, bundle present, stub gh fails: refused (planted)
printf '{"bundle":"stub"}' > "$ARCHIVE.sigstore.json"
expect_refuse bundle-bad-refused env GH_MODE=bad HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx3" --dry-run
rm -f "$ARCHIVE.sigstore.json"
# 4. no bundle, verifier absent: hash-only warning, passes (planted)
expect_pass no-bundle-warns env GH_BIN="$WORK/bin/absent-gh" HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/pfx4" --dry-run
grep -q "hash-only" "$WORK/err.log" || { fail=$((fail + 1)); printf 'FAIL no-bundle-warns: warning missing\n'; }
printf 'install-verify: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
