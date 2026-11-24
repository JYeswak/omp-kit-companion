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
raw_top = repo_result.stdout.strip()
repo_root = os.path.realpath(raw_top)

common_result = git("-C", repo_root, "rev-parse", "--git-common-dir")
if common_result.returncode != 0:
    fail("could not identify the common Git directory")
raw_common = common_result.stdout.strip()
common_dir = Path(raw_common)
if not common_dir.is_absolute():
    common_dir = Path(repo_root) / common_dir
common_dir = Path(os.path.realpath(common_dir))
project_root = str(common_dir.parent) if common_dir.name == ".git" else repo_root


def normalize_key(value):
    expanded = os.path.expanduser(value.strip())
    if len(expanded) > 1:
        expanded = expanded.rstrip("/")
    return expanded


def local_spellings():
    # Every spelling this repository currently reports for itself, without
    # touching any other path. raw_top is the toplevel spelling git printed
    # for this invocation, project_root is the canonicalized project root,
    # and the raw common-dir parent covers invocations addressed through an
    # alias spelling (for example GIT_DIR=<alias>/.git, whose verbatim text
    # git echoes but whose realpath is still this repository). A manifest
    # human_key equal to one of these strings corroborates the archive's
    # claim with this repository's own self-report; anything else is either
    # foreign or stale and must never be resolved by probing it here.
    spellings = {normalize_key(raw_top), normalize_key(project_root)}
    common_text = normalize_key(raw_common)
    if os.path.isabs(common_text) and os.path.basename(common_text) == ".git":
        parent = os.path.dirname(common_text)
        if parent:
            spellings.add(parent)
    return {spelling for spelling in spellings if spelling}


def matching_archives(storage_root):
    # Hot-path matcher. Returns ([(slug, root)], None). Corroborates each
    # archive's manifest human_key against this repository's own spellings
    # with pure string comparison only. In particular this function never
    # calls realpath, stat, open, or readlink on a manifest-derived path, so
    # a stalled mount behind a foreign human_key cannot block a commit here.
    # STORAGEROOTNFS1 (ompkit-1ra0d.250): the previous version compared
    # os.path.realpath(human_key) for every one of the 407 archived project
    # keys, so one transient NFS stall blocked every commit and push
    # fleet-wide. An alias spelling this repository does not currently
    # report (stale or moved registration) matches nothing here on purpose:
    # record an installer-authenticated binding for it with
    # install-pre-commit-storage-root-gate.sh instead of probing it.
    root = Path(os.path.expanduser(storage_root))
    projects = root / "projects"
    if root.is_symlink() or projects.is_symlink() or not projects.is_dir():
        return [], None

    spellings = local_spellings()
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
            if not isinstance(human_key, str) or normalize_key(human_key) not in spellings:
                continue
            reservations = archive / "file_reservations"
            if reservations.is_symlink() or not reservations.is_dir():
                continue
            matches.append((archive.name, str(root.resolve())))
        except (OSError, ValueError):
            continue
    return matches, None


def authorized_matches(storage_root):
    # INSTALL-TIME ONLY (never called from a commit or push hook). The
    # operator-authorized full verification used to migrate a registration
    # whose human_key is an alias spelling this repository does not report:
    # resolves every archived key with realpath and names each key on stderr
    # first, so a stalled mount is visible to the operator instead of a
    # silent hang. Returns ([(slug, root)], error) like matching_archives.
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
            if not isinstance(human_key, str):
                continue
            expanded = os.path.expanduser(human_key.strip())
            print("omp-kit Agent Mail guard: verifying archived key " + expanded, file=sys.stderr)
            if os.path.realpath(expanded) != project_root:
                continue
            reservations = archive / "file_reservations"
            if reservations.is_symlink() or not reservations.is_dir():
                continue
            matches.append((archive.name, str(root.resolve())))
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


def configured_binding():
    # The installer-authenticated archive binding: the exact archive slug
    # plus the canonical project root recorded when the operator ran
    # install-pre-commit-storage-root-gate.sh. A half-written binding proves
    # nothing and is treated as absent (the scan below decides instead).
    slug_result = git("config", "--local", "--get", "omp-kit.agent-mail-archive")
    if slug_result.returncode == 1:
        return None
    if slug_result.returncode != 0:
        fail("could not read the repository's Agent Mail archive binding")
    canonical_result = git("config", "--local", "--get", "omp-kit.agent-mail-archive-canonical")
    if canonical_result.returncode != 0:
        return None
    slug = slug_result.stdout.strip()
    canonical = canonical_result.stdout.strip()
    if not slug or "/" in slug or "\\" in slug or not canonical:
        return None
    return slug, canonical


def bound_archive(storage_root, slug, canonical):
    # Verify the bound archive with local I/O only: the bound manifest must
    # be readable, must back a usable file_reservations directory, and the
    # recorded canonical root must equal this repository's current project
    # root (both purely local strings). No manifest-derived path is resolved
    # here: the key was verified when the binding was recorded.
    root = Path(os.path.expanduser(storage_root))
    archive = root / "projects" / slug
    manifest = archive / "project.json"
    remedy = "Re-run scripts/install-pre-commit-storage-root-gate.sh in this repository"
    try:
        if manifest.is_symlink() or not manifest.is_file():
            return None, ("the recorded Agent Mail archive binding names archive '" + slug
                          + "', which has no readable project manifest under " + str(root) + ". " + remedy)
        if manifest.stat().st_size > 1024 * 1024:
            return None, ("the recorded Agent Mail archive binding names archive '" + slug
                          + "', whose project manifest is oversized. " + remedy)
        metadata = json.loads(manifest.read_text(encoding="utf-8"))
    except OSError as error:
        return None, ("could not inspect the recorded Agent Mail archive binding '" + slug
                        + "': " + str(error) + ". " + remedy)
    except ValueError:
        return None, ("the recorded Agent Mail archive binding names archive '" + slug
                        + "', whose project manifest is not valid JSON. " + remedy)
    if not isinstance(metadata, dict):
        return None, ("the recorded Agent Mail archive binding names archive '" + slug
                        + "', whose project manifest is not a JSON object. " + remedy)
    reservations = archive / "file_reservations"
    try:
        if reservations.is_symlink() or not reservations.is_dir():
            return None, ("the recorded Agent Mail archive binding names archive '" + slug
                            + "', which has no usable file_reservations directory. " + remedy)
    except OSError as error:
        return None, ("could not inspect the recorded Agent Mail archive binding '" + slug
                        + "': " + str(error) + ". " + remedy)
    if canonical != project_root:
        return None, ("the recorded Agent Mail archive binding (archive '" + slug + "', canonical root '"
                        + canonical + "') does not match this repository (project root '" + project_root
                        + "'); the repository moved or the archive was re-registered. " + remedy)
    return (slug, str(root.resolve())), None


def resolve_configured(storage_root, authorize):
    binding = configured_binding()
    if binding is not None:
        match, error = bound_archive(storage_root, binding[0], binding[1])
        if error:
            fail(error)
        # A second archive corroborating this repository would send the
        # downstream guard to whichever entry sorts first, so the bound
        # archive's reservations could be silently skipped. Refuse instead.
        scan = authorized_matches if authorize else matching_archives
        others, scan_error = scan(storage_root)
        if scan_error:
            fail("could not inspect the configured Agent Mail project archive: " + scan_error)
        if any(slug != match[0] for slug, _ in others):
            fail("multiple Agent Mail archives match this Git project")
        return [match]
    scan = authorized_matches if authorize else matching_archives
    matches, error = scan(storage_root)
    if error:
        fail("could not inspect the configured Agent Mail project archive: " + error)
    if len(matches) != 1:
        fail("no Agent Mail archive matches this Git project" if not matches else
             "multiple Agent Mail archives match this Git project")
    return matches


storage_root = configured_root()
authorize = len(sys.argv) == 2 and sys.argv[1] == "--authorize-binding"
if storage_root:
    matches = resolve_configured(storage_root, authorize)
    resolved_slug, resolved_root = matches[0]
else:
    scan = authorized_matches if authorize else matching_archives
    matches = []
    errors = []
    for candidate in default_roots():
        candidate_matches, error = scan(candidate)
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
    resolved_slug, resolved_root = matches[0]

if len(sys.argv) == 2 and sys.argv[1] == "--resolve-root":
    print(resolved_root)
elif len(sys.argv) == 2 and sys.argv[1] in ("--resolve-binding", "--authorize-binding"):
    # Install-time only (never called from a commit or push hook):
    # --resolve-binding reports the touch-free match, while
    # --authorize-binding additionally permits the operator-authorized full
    # key verification above. The installer records the printed slug and
    # canonical root as this repository's archive binding. Three lines
    # (root, slug, canonical) so the installer parses them with plain shell.
    print(resolved_root)
    print(resolved_slug)
    print(project_root)
elif len(sys.argv) != 1:
    fail("usage: pre-commit-storage-root-gate.sh [--resolve-root | --resolve-binding | --authorize-binding]")
else:
    # Chain run (GUARDROOT1, ompkit-2ayxn): the Agent Mail guard after this hook reads STORAGE_ROOT, then
    # AGENT_MAIL_STORAGE_ROOT, then its own default. Unless the runner's omp-kit bootstrap handed both the resolved
    # root, the guard can match no archive and allow every commit, so a lost hand-off refuses here instead.
    for name in ("STORAGE_ROOT", "AGENT_MAIL_STORAGE_ROOT"):
        handed = os.environ.get(name, "").strip()
        if not handed:
            fail("the Agent Mail chain runner did not hand the resolved archive root to its guard ("
                 + name + " is unset), so reservations would not be checked; an Agent Mail hook reinstall "
                 "rewrites the runner. Re-run scripts/install-pre-commit-storage-root-gate.sh in this repository")
        if os.path.realpath(os.path.expanduser(handed)) != resolved_root:
            fail(name + " names " + handed + " but this repository's archive is under " + resolved_root
                 + "; the guard would check the wrong archive")
PY
