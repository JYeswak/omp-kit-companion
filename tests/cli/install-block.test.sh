#!/bin/sh
# install-block.test.sh — README install contract (INSTALLVER1 ompkit-fp72.135.1.11, OUTSIDERONE1 ompkit-fp72.135.1.17).
# The README documents ONE command (curl ... installer/get.sh | sh) in both places it shows an install block, identical in
# both, pointing at a get.sh that exists, with no gh-login step; get.sh's own behavior is tests/cli/get-sh.test.ts, and
# the installer's logged-out network refusal is case 3 below. Every verdict comes from exit codes plus complete output.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
README="$ROOT/README.md"
REPO_TMP="$ROOT/var/agent-tmp"
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT=${TMPDIR:-$REPO_TMP} # tempsafe: selects the kitlib_tmp root, keeps repo-tmp fallback
kitlib_tmp TMP install-block-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

ONE='curl -fsSL https://raw.githubusercontent.com/JYeswak/omp-kit-companion/main/installer/get.sh | sh'

# 1. Extract the ```sh blocks that run get.sh: there are two, and each is exactly the one documented command.
awk '/^```sh$/ { buf=""; inblock=1; next }
     inblock { buf = buf $0 "\n"; if ($0 == "```") { if (buf ~ /installer\/get\.sh/) printf "%s", buf; inblock=0 } }' \
  "$README" > "$TMP/blocks.txt"
nblocks=$(grep -c '^curl ' "$TMP/blocks.txt" || true)
if [ "${nblocks:-0}" = "2" ]; then ok; else bad "expected 2 install blocks, found ${nblocks:-0}"; fi
distinct=$(grep '^curl ' "$TMP/blocks.txt" | sort -u)
others=$(grep -v '^curl ' "$TMP/blocks.txt" | grep -v '^```$' | grep -vc '^$' || true)
if [ "$distinct" = "$ONE" ] && [ "${others:-1}" = "0" ]; then ok;
else bad "install blocks are not exactly the one documented command: <<$(cat "$TMP/blocks.txt")>>"; fi

# 2. The command points at a get.sh that exists, and the docs name no gh-login step or removed one-liner.
if [ -f "$ROOT/installer/get.sh" ] && [ -x "$ROOT/installer/get.sh" ]; then ok; else bad "installer/get.sh is missing or not executable"; fi
# shellcheck disable=SC2016 # intentional literal $: README text to look for, not an expansion
for stale in 'gh auth token' 'GH_TOKEN="$(' 'str.removeprefix' 'releases/latest | python3'; do
  if grep -qF -- "$stale" "$README"; then bad "README still documents the removed install step: $stale"; else ok; fi
done
if grep -q 'installed, not logged in\|installed but not logged in' "$README"; then ok; else bad "README does not say gh must be installed but not logged in"; fi
if grep -q '^## Manual install$' "$ROOT/docs/setup.md"; then ok; else bad "docs/setup.md lost the Manual install section the README links to"; fi

# 3. planted: the public API is unreachable while gh is logged out -> the installer never consults gh for the bundle and
# names the network remedy (no login is needed), not a bare code and not `gh auth login`.
mkdir -p "$TMP/ghstub/bin"
cat > "$TMP/ghstub/bin/gh" <<EOF
#!/bin/sh
echo called > "$TMP/gh.called"
echo "gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable." >&2
exit 4
EOF
chmod +x "$TMP/ghstub/bin/gh"
printf 'dummy-archive-bytes' > "$TMP/archive.tar"
OMP_KIT_GITHUB_API=http://127.0.0.1:1
export OMP_KIT_GITHUB_API
if PATH="$TMP/ghstub/bin:$PATH" python3 "$ROOT/installer/install.py" bundle "$TMP/archive.tar" 0.2.62 darwin-arm64-none 2> "$TMP/gh.err"; then
  bad "API unreachable: bundle rc=0"
else
  if grep -q "KIT_ATTESTATION_BUNDLE_UNAVAILABLE" "$TMP/gh.err" \
      && grep -q "no \`gh auth login\` is needed" "$TMP/gh.err" \
      && grep -q "GH_TOKEN" "$TMP/gh.err" \
      && [ ! -e "$TMP/gh.called" ]; then ok;
  else bad "API unreachable: err<<$(cat "$TMP/gh.err")>> gh-called=$([ -e "$TMP/gh.called" ] && echo yes || echo no)"; fi
fi

printf 'install-block: pass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = "0" ]
