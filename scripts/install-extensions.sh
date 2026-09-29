#!/bin/sh
# install-extensions.sh [--dry-run]
#
# For each extension named in policy/extensions.json: copy extensions/<name> to
# ~/.omp/omp-extensions/<name> (a differing installed copy is backed up to
# ~/.local/state/omp-kit/backups/<UTC>-ext/ first), then add that installed path to the
# `extensions` list of every omp profile except policy skipProfiles, and read the list back.
# Idempotent: a matching copy and an already-listed path are left alone.
# skipProfiles: profiles intentionally left unmanaged by this installer.
set -u
unset PI_CODING_AGENT_DIR OMP_PROFILE PI_PROFILE
ROOT=$(cd "$(dirname "$0")/.." && pwd)
POLICY="$ROOT/policy/extensions.json"
DEST="$HOME/.omp/omp-extensions"
STATE="$HOME/.local/state/omp-kit"
dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  "") ;;
  *) echo "install-extensions: unknown argument: $1" >&2; exit 2 ;;
esac
cd /tmp || exit 1

run_omp() { p=$1; shift; if [ "$p" = default ]; then omp "$@" < /dev/null; else omp --profile "$p" "$@" < /dev/null; fi; }
profiles=default
for d in "$HOME"/.omp/profiles/*/agent; do
  [ -d "$d" ] && profiles="$profiles $(basename "$(dirname "$d")")"
done
skip=$(jq -r '.skipProfiles[]' "$POLICY" | tr '\n' ' ')

bad=0
for name in $(jq -r '.extensions[]' "$POLICY"); do
  src="$ROOT/extensions/$name"
  dst="$DEST/$name"
  if [ ! -f "$src" ]; then
    echo "install-extensions: $src is missing" >&2
    exit 2
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "$name: installed copy matches"
  elif [ "$dry" = 1 ]; then
    echo "[dry-run] $name: would install $dst"
  else
    mkdir -p "$DEST" || { echo "install-extensions: cannot create $DEST" >&2; exit 1; }
    if [ -f "$dst" ]; then
      b="$STATE/backups/$(date -u +%Y%m%dT%H%M%SZ)-ext"
      if ! mkdir -p "$b" || ! cp -p "$dst" "$b/$name"; then
        echo "install-extensions: cannot back up $dst" >&2; exit 1
      fi
      echo "$name: backed up the old copy to $b"
    fi
    if ! cp "$src" "$dst.tmp.$$" || ! mv "$dst.tmp.$$" "$dst"; then
      echo "install-extensions: cannot install $dst" >&2; exit 1
    fi
    echo "$name: installed $dst"
  fi
  for p in $profiles; do
    case " $skip " in *" $p "*) echo "$p: skipped (policy skipProfiles)"; continue ;; esac
    have=$(run_omp "$p" config get extensions --json 2>/dev/null | jq -c '.value // []')
    if [ -z "$have" ]; then
      echo "$p: cannot read its extensions list; not touched" >&2
      bad=1
      continue
    fi
    if printf '%s' "$have" | jq -e --arg d "$dst" 'index($d) != null' > /dev/null; then
      echo "$p: lists $dst"
      continue
    fi
    want=$(printf '%s' "$have" | jq -c --arg d "$dst" '. + [$d]')
    if [ "$dry" = 1 ]; then
      echo "[dry-run] $p: would append $dst ($(printf '%s' "$have" | jq length) listed now)"
      continue
    fi
    run_omp "$p" config set extensions "$want" > /dev/null
    now=$(run_omp "$p" config get extensions --json 2>/dev/null | jq -c '.value')
    if [ "$now" = "$want" ]; then
      echo "$p: added $dst"
    else
      echo "$p: set FAILED; reads back $now" >&2
      bad=1
    fi
  done
done
[ "$dry" = 1 ] && echo "install-extensions: dry run, nothing written"
[ "$bad" = 0 ]
