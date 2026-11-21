#!/bin/sh
# get.sh: the one documented command for a newcomer (OUTSIDERONE1, J-2026-11-20-15):
#   curl -fsSL https://raw.githubusercontent.com/JYeswak/omp-kit-companion/main/installer/get.sh | sh
# This file is the only thing a pipe-to-shell trusts on `main`, so it is deliberately dumb. It resolves the newest published
# release tag, fetches THAT TAG's installer (install.sh and install.py, never main's) and runs it. It verifies, extracts and
# writes nothing itself: install.py checks the index, archive and manifest hashes, USTAR safety and the Sigstore/SLSA
# attestation (`gh attestation verify`: issuer, workflow, and the tag's authoritative source commit) before anything is
# installed, and fails closed (KIT_ATTESTATION_*). It takes no arguments.
# Overrides, for a local fixture or a prefix of your own (HTTPS, or loopback HTTP for a fixture):
#   KIT_RELEASES_URL  default https://github.com/JYeswak/omp-kit-companion/releases
#   KIT_RAW_URL       default https://raw.githubusercontent.com/JYeswak/omp-kit-companion
#   KIT_PREFIX        default $HOME/.local/opt/omp-kit (an absolute path)
set -eu
say() { printf 'install: %s\n' "$1" >&2; }
die() { say "$1"; say 'nothing was installed.'; exit 1; }
[ "$#" -eq 0 ] || { say 'get.sh takes no arguments; to choose a version, use the manual recipe in docs/setup.md.'; exit 2; }
command -v curl >/dev/null 2>&1 || die 'curl is required.'
releases=${KIT_RELEASES_URL:-https://github.com/JYeswak/omp-kit-companion/releases}
raw=${KIT_RAW_URL:-https://raw.githubusercontent.com/JYeswak/omp-kit-companion}
prefix=${KIT_PREFIX:-}
if [ -z "$prefix" ]; then
  [ -n "${HOME:-}" ] || die 'HOME is not set; export KIT_PREFIX=/absolute/dir and run it again.'
  prefix=$HOME/.local/opt/omp-kit
fi
proto='=https' redir='=https'
for url in "$releases" "$raw"; do
  case $url in
    https://*) ;;
    http://127.0.0.1:*|http://localhost:*) proto='=https,http' redir='=https,http' ;;
    *) die "refusing an override that is neither HTTPS nor loopback: $url" ;;
  esac
done
final=$(curl -fsSLI --proto "$proto" --proto-redir "$redir" --connect-timeout 10 --max-time 30 -o /dev/null -w '%{url_effective}' "$releases/latest") ||
  die 'could not resolve the latest omp-kit release (is github.com reachable?).'
tag=${final##*/}
badtag() { die "the latest release tag is not a plain vX.Y.Z version: $tag"; }
case $tag in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) badtag ;;
esac
case ${tag#v} in
  *[!0-9.]*|*..*|*.*.*.*|*.) badtag ;;
esac
work=$(mktemp -d "${TMPDIR:-/tmp}/omp-kit-get.XXXXXXXX") || die 'cannot create a temporary directory.' # tempsafe: standalone curl|sh fetcher, scripts/kitlib-tmp.sh is not shipped beside it; the 0700 directory is removed on every exit
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
chmod 700 "$work"
for name in install.sh install.py; do
  curl -fsSL --proto "$proto" --proto-redir "$redir" --connect-timeout 10 --max-time 60 --max-filesize 1048576 -o "$work/$name" "$raw/$tag/installer/$name" ||
    die "could not fetch $name at $tag."
done
say "installing omp-kit ${tag#v}; every release byte is verified before anything is written."
sh "$work/install.sh" --version "${tag#v}" --index "$releases/download/$tag/release-index.json" --prefix "$prefix"
say "installed. Add it to your PATH: export PATH=\"$prefix/bin:\$PATH\""
