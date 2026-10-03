#!/bin/sh
# Resolve the archive for this repository before Agent Mail hook children run.
set -eu

python3 - "$@" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path


def fail(message):
    print("omp-kit Agent Mail guard: " + message, file=sys.stderr)
    raise SystemExit(2)


def git(*args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    )


repo_result = git("rev-parse", "--show-toplevel")
if repo_result.returncode != 0:
    fail("run inside an Agent Mail-enabled Git repository")
repo_root = os.path.realpath(repo_result.stdout.strip())

common_result = git("-C", repo_root, "rev-parse", "--git-common-dir")
if common_result.returncode != 0:
    fail("could not identify the common Git directory")
common_dir = Path(common_result.stdout.strip())
if not common_dir.is_absolute():
    common_dir = Path(repo_root) / common_dir
common_dir = Path(os.path.realpath(common_dir))
project_root = str(common_dir.parent) if common_dir.name == ".git" else repo_root


def matching_archives(storage_root):
    root = Path(os.path.expanduser(storage_root))
    projects = root / "projects"
    if root.is_symlink() or projects.is_symlink() or not projects.is_dir():
        return [], None

    matches = []
    try:
        entries = sorted(projects.iterdir(), key=lambda path: path.name)
    except OSError as error:
        return [], str(error)

    for archive in entries:
        try:
            if archive.is_symlink() or not archive.is_dir():
                continue
            manifest = archive / "project.json"
            if manifest.is_symlink() or not manifest.is_file():
                continue
            if manifest.stat().st_size > 1024 * 1024:
                continue
            metadata = json.loads(manifest.read_text(encoding="utf-8"))
            human_key = metadata.get("human_key") if isinstance(metadata, dict) else None
            if not isinstance(human_key, str) or os.path.realpath(os.path.expanduser(human_key)) != project_root:
                continue
            reservations = archive / "file_reservations"
            if reservations.is_symlink() or not reservations.is_dir():
                continue
            matches.append(str(root.resolve()))
        except (OSError, ValueError):
            continue
    return matches, None


def default_roots():
    home = Path.home()
    data_homes = {
        Path(os.environ.get("XDG_DATA_HOME", str(home / ".local" / "share"))),
        home / ".local" / "share",
    }
    state_homes = {
        Path(os.environ.get("XDG_STATE_HOME", str(home / ".local" / "state"))),
        home / ".local" / "state",
    }
    roots = [home / ".mcp_agent_mail_git_mailbox_repo"]
    for base in sorted(data_homes | state_homes, key=str):
        roots.extend([
            base / "mcp-agent-mail" / "git_mailbox_repo",
            base / "mcp-agent-mail",
            base / "mcp_agent_mail" / "git_mailbox_repo",
            base / "mcp_agent_mail",
        ])
        try:
            roots.extend(
                child for child in base.iterdir()
                if child.name.startswith(("mcp-agent-mail", "mcp_agent_mail"))
            )
        except FileNotFoundError:
            pass
        except OSError:
            continue
    seen = set()
    for root in roots:
        normalized = os.path.realpath(os.path.expanduser(str(root)))
        if normalized not in seen:
            seen.add(normalized)
            yield normalized


def configured_root():
    root = os.environ.get("AGENT_MAIL_STORAGE_ROOT", "").strip()
    if not root:
        root = os.environ.get("STORAGE_ROOT", "").strip()
    if not root:
        result = git("config", "--local", "--get", "omp-kit.agent-mail-storage-root")
        if result.returncode == 0:
            root = result.stdout.strip()
        elif result.returncode != 1:
            fail("could not read the repository's Agent Mail storage root")
    return root


storage_root = configured_root()
if storage_root:
    matches, error = matching_archives(storage_root)
    if error:
        fail("could not inspect the configured Agent Mail project archive: " + error)
    if len(matches) != 1:
        fail("no Agent Mail archive matches this Git project" if not matches else
             "multiple Agent Mail archives match this Git project")
    resolved_root = matches[0]
else:
    matches = []
    errors = []
    for candidate in default_roots():
        candidate_matches, error = matching_archives(candidate)
        if error:
            errors.append(candidate + ": " + error)
        matches.extend(candidate_matches)
    matches = sorted(set(matches))
    if len(matches) != 1:
        if matches:
            fail("multiple Agent Mail storage roots match this Git project; configure omp-kit.agent-mail-storage-root")
        if errors:
            fail("could not inspect Agent Mail storage roots: " + "; ".join(errors[:3]))
        fail("no Agent Mail archive matches this Git project")
    resolved_root = matches[0]

if len(sys.argv) == 2 and sys.argv[1] == "--resolve-root":
    print(resolved_root)
elif len(sys.argv) != 1:
    fail("usage: pre-commit-storage-root-gate.sh [--resolve-root]")
PY
