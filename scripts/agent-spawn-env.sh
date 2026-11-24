#!/bin/sh
# Project an already-registered native caller into the br shim at pane startup.
# Registration belongs to the native owner; this helper never registers,
# adopts aliases, rewrites identities or changes leases.
#   projection=$(scripts/agent-spawn-env.sh --agent NAME) && eval "$projection"
# With FLEET_MAIL_BACKEND=board the projection also exports BOARD_URL (config
# key [board] url in the fleet overlay, default http://127.0.0.1:4178/api/board)
# and BOARD_PROFILE (the seat's Agent Mail name) for the Board CLI; unset or am
# leaves the projection unchanged. --board-env prints only those exports, with
# no pane proof: the seat's own name is still required.
# Only the supported AM v1 canonical verified-live binding qualifies. Native
# resolution runs in macOS's built-in read-only sandbox: AM 0.3.36's nominally
# read-only CLI otherwise adopts dead aliases. Without this boundary, refuse.
# The actual tmux socket/pane/process ancestry and project must agree before
# any shim is installed. Other carriers or weak evidence remain unsupported.
set -u

fail() {
	printf 'agent-spawn-env: %s\n' "$1" >&2
	exit 4
}

KIT_ROOT=""
AGENT=""
PROJECT=""
BOARD_ONLY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--agent|--kit-root|--project)
			[ $# -ge 2 ] || fail "an option value is required"
			case "$1" in
				--agent) AGENT=$2 ;;
				--kit-root) KIT_ROOT=$2 ;;
				--project) PROJECT=$2 ;;
			esac
			shift 2 ;;
		--board-env) BOARD_ONLY=1; shift ;;
		--) shift; break ;;
		*) fail "usage: agent-spawn-env.sh --agent NAME [--project REPO] [--kit-root DIR] [--board-env]" ;;
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
board_projection() {
	case "${FLEET_MAIL_BACKEND:-}" in
		""|am) return 0 ;;
		board) ;;
		*) fail "FLEET_MAIL_BACKEND must be am or board" ;;
	esac
	command -v python3 >/dev/null 2>&1 || fail "ACTOR_SOURCE_UNAVAILABLE python3 is required"
	python3 - "$AGENT" <<'PY'
from __future__ import annotations

import os
import re
import shlex
import sys

DEFAULT_URL = "http://127.0.0.1:4178/api/board"
agent = sys.argv[1]
# Board profile names: a letter, then up to 31 letters, digits or hyphens.
if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,31}", agent):
    print("agent-spawn-env: BOARD_PROFILE_INVALID: the Agent Mail name is not a valid Board profile", file=sys.stderr)
    sys.exit(4)
url = DEFAULT_URL
home = os.environ.get("HOME", "")
override = os.environ.get("OMP_KIT_FLEET_CONFIG", "")
xdg = os.environ.get("XDG_CONFIG_HOME", "")
config = override or os.path.join(xdg if xdg.startswith("/") else os.path.join(home, ".config"), "omp-kit", "fleet.toml")
try:
    with open(config, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
except FileNotFoundError:
    lines = []
except (OSError, UnicodeError):
    print("agent-spawn-env: BOARD_URL_CONFIG_UNREADABLE: fleet overlay is unreadable", file=sys.stderr)
    sys.exit(4)
# Only the one key is read: python3 here may predate tomllib.
in_board = False
for line in lines:
    text = line.strip()
    if text.startswith("["):
        in_board = text == "[board]"
    elif in_board:
        match = re.fullmatch(r'url\s*=\s*"([^"\\]*)"\s*(?:#.*)?', text)
        if match:
            url = match.group(1)
if not isinstance(url, str) or not re.fullmatch(r"https?://[^\s'\"]+", url):
    print("agent-spawn-env: BOARD_URL_INVALID: [board] url must be an http(s) URL", file=sys.stderr)
    sys.exit(4)
print(f"export BOARD_URL={shlex.quote(url)}")
print(f"export BOARD_PROFILE={shlex.quote(agent)}")
PY
}
if [ "$BOARD_ONLY" = 1 ]; then
	board_projection || exit 4
	exit 0
fi
BOARD_EXPORTS=$(board_projection) || exit 4
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
command -v python3 >/dev/null 2>&1 || fail "ACTOR_SOURCE_UNAVAILABLE python3 is required"
projection=$(python3 - "$AGENT" "$PROJECT" "$BINDIR" <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys


def refuse(code: str) -> None:
    print(f"agent-spawn-env: {code}; no actor projected", file=sys.stderr)
    sys.exit(4)


def native(args: list[str]) -> str:
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        refuse("ACTOR_SOURCE_UNAVAILABLE")
    if result.returncode != 0:
        refuse("ACTOR_SOURCE_UNAVAILABLE")
    return result.stdout


agent, project_arg, bindir = sys.argv[1:]
if os.environ.get("TERN_PANE") or os.environ.get("HERDR_PANE_ID"):
    refuse("ACTOR_SOURCE_UNSUPPORTED")
pane = os.environ.get("TMUX_PANE", "")
tmux = os.environ.get("TMUX", "").rsplit(",", 2)
if not (pane.startswith("%") and pane[1:].isascii() and pane[1:].isdecimal()
        and len(tmux) == 3 and Path(tmux[0]).is_absolute()):
    refuse("ACTOR_SOURCE_UNAVAILABLE")
socket = str(Path(tmux[0]).resolve())
try:
    if not stat.S_ISSOCK(os.stat(socket).st_mode):
        refuse("ACTOR_SOURCE_UNAVAILABLE")
    project = Path(project_arg or native(
        ["git", "rev-parse", "--show-toplevel"]).strip()).resolve(strict=True)
    cwd = Path.cwd().resolve()
except (OSError, RuntimeError, ValueError):
    refuse("ACTOR_PROJECT_MISMATCH")
if not project.is_dir() or not cwd.is_relative_to(project):
    refuse("ACTOR_PROJECT_MISMATCH")


def frame() -> tuple[str, ...]:
    fields = native([
        "tmux", "-S", socket, "display-message", "-t", pane, "-p",
        "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t"
        "#{pane_pid}\t#{socket_path}\t#{pane_current_path}",
    ]).rstrip("\n").split("\t")
    if (len(fields) != 7 or fields[3] != pane or not fields[4].isdecimal()
            or str(Path(fields[5]).resolve()) != socket):
        refuse("ACTOR_CALLER_MISMATCH")
    if not Path(fields[6]).resolve().is_relative_to(project):
        refuse("ACTOR_PROJECT_MISMATCH")
    return tuple(fields)


def own_ancestor(root_pid: int) -> bool:
    pid = os.getpid()
    for _ in range(64):
        if pid == root_pid:
            return True
        if pid <= 1:
            return False
        parent = native(["ps", "-p", str(pid), "-o", "ppid="]).strip()
        if not parent.isdecimal():
            return False
        pid = int(parent)
    return False


before = frame()
root_pid = int(before[4])
if not own_ancestor(root_pid):
    refuse("ACTOR_CALLER_MISMATCH")
process = native(["ps", "-p", str(root_pid), "-o", "uid=,lstart="]).strip()
uid_start = process.split(maxsplit=1)
if len(uid_start) != 2 or uid_start[0] != str(os.geteuid()):
    refuse("ACTOR_CALLER_MISMATCH")
# The native resolver may adopt a dead record before returning adopted-dead.
# Denying writes in the child is essential: checking its tag afterwards is
# too late, and a second unrestricted read would report the adopted alias live.
if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").is_file():
    refuse("ACTOR_READ_BOUNDARY_UNSUPPORTED")
read_policy = (
    '(version 1)(allow default)(deny file-write*)(deny network*)'
    # Native tmux probes use Stdio::null for stderr. The discard device is
    # not persistent state; identity/tracker writes remain denied.
    '(allow file-write-data (literal "/dev/null"))'
    '(allow network-outbound (remote unix-socket (literal (param "TMUX_SOCKET"))))'
)
try:
    proof = json.loads(native([
        "/usr/bin/sandbox-exec", "-D", "TMUX_SOCKET=" + socket, "-p", read_policy,
        "am", "agents", "resolve-pane", "--project", str(project), "--json",
    ]))
except (ValueError, TypeError):
    refuse("ACTOR_SOURCE_UNAVAILABLE")
if not isinstance(proof, dict):
    refuse("ACTOR_SOURCE_UNAVAILABLE")
if (proof.get("schema_version") != "am.agents.resolve-pane.v1"
        or proof.get("source") != "canonical"
        or proof.get("binding") != "verified-live"):
    refuse("ACTOR_SOURCE_UNSUPPORTED")
if proof.get("agent_name") != agent:
    refuse("ACTOR_MISMATCH")
if proof.get("project_key") != str(project):
    refuse("ACTOR_PROJECT_MISMATCH")
if proof.get("pane_id") != f"{before[0]}:{before[1]}:{before[2]}":
    refuse("ACTOR_CALLER_MISMATCH")
after = frame()
if (before != after or not own_ancestor(root_pid)
        or process != native(["ps", "-p", str(root_pid), "-o", "uid=,lstart="]).strip()):
    refuse("ACTOR_CALLER_REBOUND")
provenance = {
    "schema_version": proof["schema_version"], "source": proof["source"],
    "binding": proof["binding"], "project": str(project),
    "pane": pane, "socket": socket, "pane_pid": root_pid,
    "process_start": uid_start[1], "process_start_source": "ps-lstart-seconds",
    "resolution_boundary": "darwin-sandbox-exec-read-only",
}
# Preserve native evidence strength: the seconds marker is not a claim of
# microsecond PID-reuse protection or of an authenticated alias transition.
print(f"export AGENT_NAME={shlex.quote(agent)}")
print(f'export PATH={shlex.quote(bindir)}:"$PATH"')
print("# native actor source: " + json.dumps(provenance, ensure_ascii=True, sort_keys=True))
PY
) || exit 4
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
printf '%s\n' "$projection"
[ -z "$BOARD_EXPORTS" ] || printf '%s\n' "$BOARD_EXPORTS"
