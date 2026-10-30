#!/bin/sh
# Execute one measured suite with isolated environment and filesystem/network authority.
# The suite-metrics producer supplies an owned scratch directory and its exact archive root.
exec python3 - "$@" <<'PY'
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import sysconfig


def refuse(message: str) -> None:
    print("SUITE-HERMETIC: REFUSED " + message, file=sys.stderr)
    raise SystemExit(125)


for protected in ("GIT_DIR", "GIT_WORK_TREE", "BEADS_DB"):
    if protected in os.environ:
        refuse("caller " + protected + " is set")

try:
    separator = sys.argv.index("--", 1)
except ValueError:
    refuse("missing command separator")

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--archive", required=True)
parser.add_argument("--scratch", required=True)
parser.add_argument("--suite", required=True)
parser.add_argument("--loopback-port", type=int)
parser.add_argument("--allow-env", action="append", default=[])
try:
    options = parser.parse_args(sys.argv[1:separator])
except SystemExit:
    refuse("invalid helper arguments")
command = sys.argv[separator + 1:]
if not command:
    refuse("missing suite command")

reserved = {
    "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "HOME", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES", "GIT_TERMINAL_PROMPT",
    "BUN_INSTALL", "BUN_CONFIG_FILE", "KITLIB_TMP_ROOT", "KITROOT",
    "OMP_KIT_CASE_CWD", "OMP_KIT_TEST_WORK_ROOT", "OMP_KIT_OMP_SRC_FETCH",
    "OMP_KIT_DISK_OBSERVER", "KIT_TEST_LOOPBACK_PORT", "GIT_DIR", "GIT_WORK_TREE", "BEADS_DB",
}
for name in options.allow_env:
    if (not name or not name.isascii() or not (name[0].isalpha() or name[0] == "_")
            or any(not (char.isalnum() or char == "_") for char in name)):
        refuse("invalid allowlist name")
    if name in reserved:
        refuse("allowlist cannot override wrapper variable " + name)

archive_input = Path(options.archive)
scratch_input = Path(options.scratch)
if not archive_input.is_absolute() or not scratch_input.is_absolute():
    refuse("archive and scratch paths must be absolute")
if archive_input.is_symlink() or scratch_input.is_symlink():
    refuse("archive or scratch path is a symlink")
try:
    archive = archive_input.resolve(strict=True)
    scratch = scratch_input.resolve(strict=True)
except OSError as error:
    refuse("archive or scratch path is unavailable: " + str(error))
if not archive.is_dir() or not scratch.is_dir() or archive == Path("/") or scratch == Path("/"):
    refuse("archive and scratch must be non-root directories")
if "\n" in options.suite or "\r" in options.suite:
    refuse("suite identifier must be one line")

# The environment scrub and the write/network fence are opt-in (OMP_KIT_SUITE_HERMETIC_ENABLE=1) until
# ompkit-kup44.4's own control, "the full declared suite on one tree is GREEN" under them, passes. Measured
# 2026-10-30 on published 32ad93461e: the main-role full suite under the scrub failed 100 bun tests and 10 script
# or python suites. A scratch HOME hides the linked omp install and the flywheel probe, and the scratch git link
# makes git look for its templates and helpers in scratch. tests/cli/profile-rules.test.ts passes 14 of 14 run
# directly and fails 4 under this helper, and its 077 umask fails the mode-preserving audit, migrate, repair and
# operator-snapshot tests. Without the opt-in a suite runs with the caller's environment and umask, as in 0.2.80;
# full-suite-verdict-incomplete.test.sh enables the scrub and the fence and keeps proving both.
if os.environ.get("OMP_KIT_SUITE_HERMETIC_ENABLE") != "1":
    print("SUITE-HERMETIC suite=" + options.suite + " env=inherited fence=off-optin", flush=True)
    os.execvp(command[0], command)

os.umask(0o077)

home = scratch / "home"
xdg_config = home / ".config"
xdg_cache = home / ".cache"
xdg_data = home / ".local" / "share"
xdg_state = home / ".local" / "state"
bun_install = scratch / "bun-install"
git_config = home / ".gitconfig"
for directory in (home, xdg_config, xdg_cache, xdg_data, xdg_state, bun_install):
    if directory.is_symlink():
        refuse("suite home contains a symlink: " + str(directory))
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
    except OSError as error:
        refuse("cannot create suite home: " + str(error))
try:
    git_config.write_text(
        "[user]\n\tname = omp-kit tests\n\temail = omp-kit-tests@example.invalid\n"
        "[init]\n\tdefaultBranch = main\n",
        encoding="utf-8",
    )
    os.chmod(git_config, 0o600)
except OSError as error:
    refuse("cannot seed suite git config: " + str(error))

loopback_port_option = options.loopback_port
if loopback_port_option is None and os.environ.get("KIT_TEST_LOOPBACK_PORT"):
    try:
        loopback_port_option = int(os.environ["KIT_TEST_LOOPBACK_PORT"])
    except ValueError:
        refuse("invalid inherited suite loopback port")
if loopback_port_option is not None:
    if not 1024 <= loopback_port_option <= 65535 or loopback_port_option == 8765:
        refuse("invalid suite loopback port " + str(loopback_port_option))
    loopback_port = loopback_port_option
else:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            loopback_port = probe.getsockname()[1]
    except OSError as error:
        refuse("cannot allocate suite loopback port: " + str(error))

original_path = os.environ.get("PATH") or "/usr/bin:/bin:/usr/sbin:/sbin"
path_prefix = ""
if sys.platform == "darwin":
    bindir = sysconfig.get_config_var("BINDIR")
    version = sysconfig.get_config_var("VERSION")
    python_executable = Path(bindir or "") / ("python" + str(version or ""))
    if not python_executable.is_file() or not os.access(python_executable, os.X_OK):
        python_executable = Path(sys.executable).resolve()
    if not python_executable.is_file() or not os.access(python_executable, os.X_OK):
        refuse("cannot locate the active Python executable for the suite PATH")
    python_tools = scratch / "bin"
    if python_tools.is_symlink():
        refuse("suite scratch bin directory is a symlink")
    python_tools.mkdir(mode=0o700, exist_ok=True)
    python_link = python_tools / "python3"
    if python_link.is_symlink():
        if python_link.resolve() != python_executable.resolve():
            refuse("suite scratch python3 link points elsewhere")
    elif python_link.exists():
        refuse("suite scratch python3 path is not a symlink")
    else:
        python_link.symlink_to(python_executable.resolve())

    inherited_git = shutil.which("git", path=original_path)
    if inherited_git and Path(inherited_git).resolve() == Path("/usr/bin/git"):
        developer_dirs = []
        xcode_select = Path("/usr/bin/xcode-select")
        if xcode_select.is_file():
            try:
                selected = subprocess.run(
                    [str(xcode_select), "-p"], check=True, capture_output=True,
                    text=True, timeout=5, env={"PATH": "/usr/bin:/bin"},
                ).stdout.strip()
                if selected:
                    developer_dirs.append(Path(selected))
            except (OSError, subprocess.SubprocessError):
                pass
        developer_dirs.extend((
            Path("/Applications/Xcode.app/Contents/Developer"),
            Path("/Library/Developer/CommandLineTools"),
        ))
        developer_git = None
        for developer_dir in developer_dirs:
            candidate = developer_dir / "usr" / "bin" / "git"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                developer_git = candidate.resolve()
                break
        if developer_git is None:
            refuse("system git is an xcrun shim and no developer Git executable was found")
        git_link = python_tools / "git"
        if git_link.is_symlink():
            if git_link.resolve() != developer_git:
                refuse("suite scratch git link points elsewhere")
        elif git_link.exists():
            refuse("suite scratch git path is not a symlink")
        else:
            git_link.symlink_to(developer_git)
    path_prefix = str(python_tools) + os.pathsep

path_value = path_prefix + original_path
lang_value = os.environ.get("LANG") or "C"
env = {
    "PATH": path_value,
    "TMPDIR": str(scratch),
    "TMP": str(scratch),
    "TEMP": str(scratch),
    "LANG": lang_value,
    "HOME": str(home),
    "XDG_CONFIG_HOME": str(xdg_config),
    "XDG_CACHE_HOME": str(xdg_cache),
    "XDG_DATA_HOME": str(xdg_data),
    "XDG_STATE_HOME": str(xdg_state),
    "GIT_CONFIG_GLOBAL": str(git_config),
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CEILING_DIRECTORIES": str(archive.parent),
    "GIT_TERMINAL_PROMPT": "0",
    "BUN_INSTALL": str(bun_install),
    "KITLIB_TMP_ROOT": str(scratch),
    "KITROOT": str(archive),
    "OMP_KIT_CASE_CWD": str(archive),
    "OMP_KIT_TEST_WORK_ROOT": str(scratch),
    "OMP_KIT_OMP_SRC_FETCH": "0",
    "OMP_KIT_DISK_OBSERVER": "statfs",
    "KIT_TEST_LOOPBACK_PORT": str(loopback_port),
}
bun_config = archive / "bunfig.toml"
if bun_config.is_file():
    env["BUN_CONFIG_FILE"] = str(bun_config)
for name in options.allow_env:
    if name in os.environ:
        env[name] = os.environ[name]

allow_names = sorted(env)
policy = "\n".join((
    "(version 1)",
    "(allow default)",
    "(allow file-write* (subpath " + json.dumps(str(scratch)) + "))",
    "(allow file-write* (subpath " + json.dumps(str(archive)) + "))",
    '(allow file-write-data (literal "/dev/null"))',
    '(allow network-bind (local tcp "localhost:' + str(loopback_port) + '"))',
    '(allow network-inbound (local tcp "localhost:' + str(loopback_port) + '"))',
    '(allow network-outbound (remote tcp "localhost:' + str(loopback_port) + '"))',
    "(deny file-write*)",
    "(deny network*)",
))
policy_digest = hashlib.sha256(policy.encode("utf-8")).hexdigest()
# With the scrub enabled, the macOS write/network fence is a second opt-in (OMP_KIT_SUITE_FENCE_ENABLE=1).
# Measured 2026-10-30 in exact exports: a fenced suite cannot exec setuid /bin/ps, a nested sandbox-exec fails
# rc 71, and loopback/unix-socket binds, test-runner.test.ts and kitlib_ratchet_test.py break under it.
# full-suite-verdict-incomplete.test.sh enables both and keeps proving the fence's write and network denials.
if sys.platform == "darwin" and os.environ.get("OMP_KIT_SUITE_FENCE_ENABLE") == "1":
    sandbox = "/usr/bin/sandbox-exec"
    if not Path(sandbox).is_file():
        refuse("macOS sandbox-exec is unavailable")
    executable = [sandbox, "-p", policy, *command]
    fence = "darwin-write-network"
else:
    executable = command
    fence = "darwin-off-optin" if sys.platform == "darwin" else "platform-default"

print("SUITE-HERMETIC suite=" + options.suite
      + " allow=" + ",".join(allow_names)
      + " home=" + json.dumps(str(home))
      + " fence=" + fence
      + " policy_sha256=" + policy_digest
      + " loopback_port=" + str(loopback_port), flush=True)
os.execvpe(executable[0], executable, env)
PY
