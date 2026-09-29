#!/bin/sh
# Standalone installer: Python 3 stdlib verifies all bytes before executing the candidate.
set -eu
usage() {
  cat <<'USAGE'
Usage: install.sh --version X.Y.Z --index FILE_OR_URL [--offline ARCHIVE] [--prefix ABSOLUTE_DIR] [--dry-run] [--no-color] [--help]
The index supplies integrity hashes, not publisher authentication. No OMP, Bun, profile, or shell startup file is installed or modified.
An online index must use HTTPS (or loopback HTTP for a local fixture); no network request occurs without --index.
Python 3 and, for online installs, curl are required.
USAGE
}
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
version='' index='' archive='' prefix='' dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --dry-run) dry_run=1; shift ;;
    --no-color) shift ;;
    --version|--index|--offline|--prefix)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --version) version=$2 ;; --index) index=$2 ;; --offline) archive=$2 ;; --prefix) prefix=$2 ;;
      esac
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [ -z "$version" ] || [ -z "$index" ]; then
  usage >&2; exit 2
fi
if [ -z "$prefix" ]; then
  [ -n "${HOME:-}" ] || { echo 'installer: HOME is required without --prefix' >&2; exit 2; }
  prefix="$HOME/.local/opt/omp-kit"
fi
command -v python3 >/dev/null 2>&1 || { echo 'installer: Python 3 is required' >&2; exit 2; }
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) platform=darwin-arm64-none ;; Darwin/x86_64) platform=darwin-x64-none ;;
  Linux/aarch64) platform=linux-arm64-gnu ;; Linux/x86_64) platform=linux-x64-gnu ;;
  *) echo 'installer: unsupported platform' >&2; exit 2 ;;
esac
case "$platform" in
  linux-*) if ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo 'installer: GNU libc not detected; refusing a GNU build' >&2; exit 2; fi ;;
esac
case "$prefix" in /*) ;; *) echo 'installer: --prefix must be absolute' >&2; exit 2 ;; esac
work=
cleanup() { [ -z "$work" ] || rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM
case "$index" in
  https://*|http://127.0.0.1:*/*|http://localhost:*/*|http://\[::1\]:*/*)
    command -v curl >/dev/null 2>&1 || { echo 'installer: curl is required for online install' >&2; exit 2; }
    work=$(mktemp -d "${TMPDIR:-/tmp}/omp-kit-installer.XXXXXXXX")
    chmod 700 "$work"
    curl --fail --location --silent --show-error --proto '=https,http' --proto-redir '=https,http' \
      --connect-timeout 10 --max-time 120 --max-filesize 1048576 --output "$work/index.json" "$index"
    source_url=$index; index="$work/index.json" ;;
  http://*) echo 'installer: non-loopback HTTP index refused' >&2; exit 2 ;;
  /*) source_url= ;;
  *) echo 'installer: --index must be an absolute path or HTTPS URL' >&2; exit 2 ;;
esac
if [ -z "$archive" ]; then
  [ -n "$work" ] || { echo 'installer: --offline ARCHIVE is required with a local index' >&2; exit 2; }
  filename=$(PYTHONDONTWRITEBYTECODE=1 python3 "$SCRIPT_DIR/install.py" inspect "$index" "$version" "$platform")
  url=${source_url%/*}/$filename
  work=${work:?}
  archive="$work/$filename"
  curl --fail --location --silent --show-error --proto '=https,http' --proto-redir '=https,http' \
    --connect-timeout 10 --max-time 600 --max-filesize 268435456 --output "$archive" "$url"
fi
PYTHONDONTWRITEBYTECODE=1 python3 "$SCRIPT_DIR/install.py" install "$index" "$version" "$platform" "$archive" "$prefix" "$dry_run"
