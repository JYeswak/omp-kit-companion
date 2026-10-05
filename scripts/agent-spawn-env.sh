#!/bin/sh
# agent-spawn-env.sh — ID1 spawn identity wiring
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Called once when an agent pane spawns, with the pane's Agent Mail identity:
#   eval "$(scripts/agent-spawn-env.sh --agent NAME)"
# Installs the br identity shim into a pane-scoped bin dir (never the user's
# interactive PATH) and prints the exports that put it first with AGENT_NAME
# set, so every br invocation in the pane carries --actor NAME. Refuses
# anonymous or multi-line names. Real br must exist beyond the shim.
set -u

fail() {
	printf 'agent-spawn-env: %s\n' "$1" >&2
	exit 4
}

KIT_ROOT=""
AGENT=""
while [ $# -gt 0 ]; do
	case "$1" in
		--agent) AGENT=${2:-}; shift 2 ;;
		--kit-root) KIT_ROOT=${2:-}; shift 2 ;;
		--) shift; break ;;
		*) fail "usage: agent-spawn-env.sh --agent NAME [--kit-root DIR]" ;;
	esac
done
if [ -z "$AGENT" ]; then
	fail "a pane identity is required (--agent NAME from Agent Mail registration)"
fi
nl='
'
case "$AGENT" in
	*"$nl"*) fail "AGENT_NAME must be one line" ;;
esac
if [ -z "$KIT_ROOT" ]; then
	KIT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || fail "cannot resolve kit root"
fi
SHIM="$KIT_ROOT/scripts/br-shim.sh"
if [ ! -f "$SHIM" ]; then
	fail "br shim missing at $SHIM"
fi
BINDIR="${HOME:-}/.local/share/omp-kit/agent-bin"
if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
	fail "HOME is unset or root; refusing to install the pane shim"
fi
mkdir -p "$BINDIR" || fail "cannot create $BINDIR"
ln -sf "$SHIM" "$BINDIR/br" || fail "cannot link the br shim"
if [ ! -x "$BINDIR/br" ]; then
	fail "pane shim is not executable at $BINDIR/br"
fi
if ! PATH="$BINDIR:$PATH" command -v br >/dev/null 2>&1; then
	fail "shim not first on PATH after install"
fi
if [ "$(PATH="$BINDIR:$PATH" command -v br)" != "$BINDIR/br" ]; then
	fail "another br shadows the pane shim"
fi
REAL_BIN=$(PATH=$(printf '%s' "$PATH" | awk -v RS=: -v self="$BINDIR" '$0 != self' | paste -sd: -) command -v br) || REAL_BIN=""
if [ -z "$REAL_BIN" ]; then
	fail "no real br beyond the pane shim on PATH"
fi
escaped_name=$(printf '%s' "$AGENT" | sed -e "s/'/'\\\\''/g")
printf "export AGENT_NAME='%s'\n" "$escaped_name"
# shellcheck disable=SC2016
# $PATH stays literal here on purpose: it expands when the pane evals this line.
printf 'export PATH="%s:$PATH"\n' "$BINDIR"
printf '# pane identity ready: br resolves to the identity shim, real br at %s\n' "$REAL_BIN"
