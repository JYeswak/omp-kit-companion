#!/bin/sh
# install-block.test.sh — INSTALLVER1 gate contract (ompkit-fp72.135.1.11).
# The README install blocks must fail closed when the version lookup fails,
# name the gh-login prerequisite, and stay canonical across the two blocks.
# Every verdict comes from exit codes plus complete output.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
README="$ROOT/README.md"
REPO_TMP="$ROOT/var/agent-tmp"
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/install-block-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

# Extract ```sh blocks containing the releases/latest lookup.
awk '/^```sh$/ { buf=""; inblock=1; next }
     inblock { buf = buf $0 "\n"; if ($0 == "```") { if (buf ~ /releases\/latest/) printf "%s", buf; inblock=0 } }' \
  "$README" > "$TMP/blocks.txt"
nblocks=$(grep -c '^KIT_VERSION=' "$TMP/blocks.txt" 2>/dev/null || true)
[ "${nblocks:-0}" = "2" ] || { bad "expected 2 install blocks, found ${nblocks:-0}"; }

# Canonical: non-comment command lines identical across both blocks.
awk '/^KIT_VERSION=/{ n++ } { print > ("'"$TMP"'/blk" n ".txt") }' "$TMP/blocks.txt"
if [ -f "$TMP/blk1.txt" ] && [ -f "$TMP/blk2.txt" ]; then
  if [ "$(grep -v '^#' "$TMP/blk1.txt")" = "$(grep -v '^#' "$TMP/blk2.txt")" ]; then ok;
  else bad "install blocks differ in commands (not canonical)"; fi
else
  bad "could not split install blocks"
fi

# Guard markers present in the documented block.
for marker in 'if \[ -z "\$KIT_VERSION" \]' 'rate-limit' 'gh auth login' 'nothing was downloaded' 'mktemp -d "\${TMPDIR:-/tmp}'; do
  if grep -q "$marker" "$TMP/blocks.txt"; then ok; else bad "marker missing: $marker"; fi
done

# Take the version-resolution line plus guard from the first block.
awk '/^KIT_VERSION=/{ p=1 } p { print } p && /^fi$/{ exit }' "$TMP/blk1.txt" > "$TMP/guard.sh"
grep -q '^fi$' "$TMP/guard.sh" || { bad "could not extract guard from README block"; }

mkstub() {
  # $1 = dir; $2 = curl behavior script body
  mkdir -p "$1/bin"
  {
    printf '#!/bin/sh\nSTUB_LOG="${STUB_LOG:-%s/none}"\n' "$TMP"
    printf 'printf "%%s\\n" "$*" >> "$STUB_LOG"\n%s\n' "$2"
  } > "$1/bin/curl"
  chmod +x "$1/bin/curl"
}

# 1. planted: stubbed 403 (curl -f exit 22, empty stdout) -> non-zero exit
#    naming the rate limit, exactly one curl call (nothing downloaded).
mkstub "$TMP/planted" 'echo "curl: (22) The requested URL returned error: 403" >&2; exit 22'
{
  printf '#!/bin/sh\nset -u\nPATH="%s/bin:$PATH"\nexport PATH STUB_LOG\n' "$TMP/planted"
  printf 'STUB_LOG="%s/calls.log"\nexport STUB_LOG\n' "$TMP"
  cat "$TMP/guard.sh"
  printf 'echo "PROCEEDED:$KIT_VERSION"\n'
} > "$TMP/run-planted.sh"
: > "$TMP/calls.log"
if sh "$TMP/run-planted.sh" > "$TMP/planted.out" 2> "$TMP/planted.err"; then
  bad "planted 403: rc=0, block continued with empty version"
else
  rc=$?
  calls=$(grep -c . "$TMP/calls.log" 2>/dev/null || true)
  if [ "$rc" != "0" ] && grep -qi "rate-limit" "$TMP/planted.err" \
      && grep -q "nothing was downloaded" "$TMP/planted.err" \
      && ! grep -q "PROCEEDED" "$TMP/planted.out" \
      && [ "${calls:-0}" = "1" ]; then ok;
  else bad "planted 403: rc=$rc out<<$(cat "$TMP/planted.out")>> err<<$(cat "$TMP/planted.err")>> calls=${calls:-0}"; fi
fi

# 2. control: normal response proceeds past the guard.
mkstub "$TMP/control" 'printf "%s" "{\"tag_name\": \"v0.2.62\"}"; exit 0'
{
  printf '#!/bin/sh\nset -u\nPATH="%s/bin:$PATH"\nexport PATH STUB_LOG\n' "$TMP/control"
  printf 'STUB_LOG="%s/calls2.log"\nexport STUB_LOG\n' "$TMP"
  cat "$TMP/guard.sh"
  printf 'echo "PROCEEDED:$KIT_VERSION"\n'
} > "$TMP/run-control.sh"
: > "$TMP/calls2.log"
if sh "$TMP/run-control.sh" > "$TMP/control.out" 2> "$TMP/control.err"; then
  if grep -q "PROCEEDED:0.2.62" "$TMP/control.out"; then ok;
  else bad "control: no PROCEEDED:0.2.62, out<<$(cat "$TMP/control.out")>>"; fi
else
  bad "control: rc=$? err<<$(cat "$TMP/control.err")>>"
fi

# 3. planted: gh logged out -> installer names the login instruction, not a bare code.
mkdir -p "$TMP/ghstub/bin"
cat > "$TMP/ghstub/bin/gh" <<'EOF'
#!/bin/sh
echo "gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable." >&2
exit 4
EOF
chmod +x "$TMP/ghstub/bin/gh"
printf 'dummy-archive-bytes' > "$TMP/archive.tar"
if PATH="$TMP/ghstub/bin:$PATH" python3 "$ROOT/installer/install.py" bundle "$TMP/archive.tar" 0.2.62 darwin-arm64-none 2> "$TMP/gh.err"; then
  bad "gh logged out: bundle rc=0"
else
  if grep -q "KIT_ATTESTATION_BUNDLE_UNAVAILABLE" "$TMP/gh.err" \
      && grep -q "gh auth login" "$TMP/gh.err" \
      && grep -q "GH_TOKEN" "$TMP/gh.err"; then ok;
  else bad "gh logged out: err<<$(cat "$TMP/gh.err")>>"; fi
fi

printf 'install-block: pass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = "0" ]
