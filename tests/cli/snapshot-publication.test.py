#!/usr/bin/env python3
"""SNAPSHOTPUB1: native generated guards, local Git only, no runtime certification.

Run explicitly with python3.11 ./tests/cli/snapshot-publication.test.py.
AM_BIN selects the real generator being qualified; it is never mocked. All
repositories, reservations, hook mutations and remotes belong to this test.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]


class Fixture:
    def __init__(self, parent: Path, am: str, mutant: str | None) -> None:
        self.repo = parent / "repo"
        self.remote = parent / "origin.git"
        self.am = am
        self.mutant = mutant
        self.repo.mkdir()
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(parent), "TMPDIR": str(parent),
            "AGENT_NAME": "SnapshotPublisher",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "PYTHONDONTWRITEBYTECODE": "1",
        }
        self.run("git", "init", "-q", "-b", "main")
        self.run("git", "config", "user.name", "Snapshot Publisher")
        self.run("git", "config", "user.email", "snapshot@example.invalid")
        self.run("git", "config", "core.hooksPath", str(self.repo / ".git/hooks"))
        (self.repo / "leased.txt").write_text("base\n")
        self.commit("base")
        self.base = self.git("rev-parse", "HEAD")
        self.run("git", "init", "-q", "--bare", str(self.remote))
        self.run("git", "remote", "add", "origin", str(self.remote))
        self.run("git", "push", "origin", "main")
        (self.repo / "leased.txt").write_text("committed candidate\n")
        self.commit("snapshot")
        self.tip = self.git("rev-parse", "HEAD")
        self.install()
        leases = self.repo / "file_reservations"
        leases.mkdir()
        for name in ("leased.txt", "foreign-untracked.txt"):
            (leases / (name + ".json")).write_text(json.dumps({
                "path_pattern": name, "agent_name": "ForeignHolder",
                "exclusive": True, "expires_ts": "2099-01-01T00:00:00Z",
                "released_ts": None,
            }))
        (self.repo / "leased.txt").write_text("foreign staged bytes\n")
        self.run("git", "add", "--", "leased.txt")
        (self.repo / "leased.txt").write_text("foreign unstaged bytes\n")
        (self.repo / "foreign-untracked.txt").write_bytes(b"foreign\x00untracked\n")

    def run(self, *args: str, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(args, cwd=self.repo, env=self.env, text=True,  # pysafe: leaf git/agent-mail fixture subprocess; timeout bounds the wait, DEVNULL stdin
                                capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
        if result.returncode and not allow_failure:
            raise AssertionError(f"{args!r}: rc={result.returncode}\n{result.stdout}{result.stderr}")
        return result

    def git(self, *args: str) -> str:
        return self.run("git", *args).stdout.strip()

    def commit(self, message: str) -> None:
        self.run("git", "add", "--", "leased.txt")
        self.run("git", "commit", "-qm", message + " [test]")

    def install(self, mode: str = "fleet") -> None:
        # Agent Mail's own setup installs both chain runners and both plugins (its default is --prepush). The fleet
        # then keeps custody at pre-commit only, through the same am steps scripts/install-pre-push-gate.sh runs
        # (ompkit-v66l.14, J-2026-10-25-12): uninstall our plugins, reinstall --no-prepush. The pre-push chain runner
        # stays because the kit's own member below uses it.
        self.run(self.am, "guard", "install", str(self.repo), str(self.repo), "--prepush")
        hooks = self.repo / ".git/hooks/hooks.d"
        # The kit's existing history authority remains a real chain member.
        member = hooks / "pre-push/30-omp-kit-on-main"
        shutil.copyfile(ROOT / "scripts/check-pushed-on-main.sh", member)
        member.chmod(0o755)
        if mode == "fleet":
            self.run(self.am, "guard", "uninstall", str(self.repo))
            self.run(self.am, "guard", "install", str(self.repo), str(self.repo), "--no-prepush")
        if self.mutant == "mutation-custody":
            plugin = hooks / "pre-commit/50-agent-mail.py"
            tree = ast.parse(plugin.read_text())
            changed = 0
            for node in ast.walk(tree):
                if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
                        and isinstance(node.value.func, ast.Name)
                        and node.value.func.id == "check_conflicts"):
                    node.value = ast.List(elts=[], ctx=ast.Load())
                    changed += 1
            if changed != 1:
                raise AssertionError("mutation-custody injection requires exactly one native conflict decision")
            plugin.write_text("#!/usr/bin/env python3\n" + ast.unparse(ast.fix_missing_locations(tree)) + "\n")
        elif self.mutant == "publication-scope":
            # Restore the erroneous decision at the real chain boundary: apply
            # mutation custody to an immutable publication. The pre-commit
            # plugin is still the native generated implementation, not an echo.
            member = hooks / "pre-push/49-publication-scope-mutant"
            member.write_text('#!/bin/sh\nexec python3 .git/hooks/hooks.d/pre-commit/50-agent-mail.py\n')
            member.chmod(0o755)

    def peer_bytes(self, *, include_index: bool = True) -> dict[str, bytes]:
        paths = [self.repo / "leased.txt", self.repo / "foreign-untracked.txt",
                 *sorted((self.repo / "file_reservations").iterdir())]
        if include_index:
            paths.append(self.repo / ".git/index")
        return {str(path.relative_to(self.repo)): path.read_bytes() for path in paths}

    def remote_tip(self) -> str:
        return self.git("--git-dir=" + str(self.remote), "rev-parse", "refs/heads/main")


def publication(fixture: Fixture) -> None:
    before = fixture.peer_bytes()
    result = fixture.run("git", "push", "origin", "main", allow_failure=True)
    assert result.returncode == 0, f"publication: rc={result.returncode}\n{result.stdout}{result.stderr}"
    assert fixture.remote_tip() == fixture.tip, "publication: remote did not receive committed shared main"
    assert fixture.peer_bytes() == before, "publication: peer work, index or lease bytes changed"


def mutation_refused(fixture: Fixture) -> None:
    # Git commit may refresh index stat metadata before invoking its hook.
    # The staged path/mode/blob entries must remain unchanged; publication
    # above additionally requires the entire index file to stay byte-identical.
    before = fixture.peer_bytes(include_index=False)
    index_entries = fixture.git("ls-files", "--stage", "-z")
    head = fixture.git("rev-parse", "HEAD")
    result = fixture.run("git", "commit", "-m", "foreign mutation [test]", allow_failure=True)
    assert result.returncode != 0 and "reservation conflict" in result.stderr, (
        f"mutation-custody: foreign commit not refused for custody\n{result.stdout}{result.stderr}")
    assert fixture.git("rev-parse", "HEAD") == head, "mutation-custody: refused commit changed history"
    assert fixture.peer_bytes(include_index=False) == before, "mutation-custody: refusal modified peer bytes"
    assert fixture.git("ls-files", "--stage", "-z") == index_entries, "mutation-custody: staged entries changed"


def unadmitted_history_refused(fixture: Fixture) -> None:
    # Construct an object without moving or checking out any branch. It is not
    # published: the existing native shared-main member must reject it.
    tree = fixture.git("rev-parse", "HEAD^{tree}")
    result = subprocess.run(["git", "commit-tree", tree, "-p", fixture.base],  # pysafe(subprocess-orphan): `git commit-tree` is a single-process leaf with no descendants; input= already closes stdin and the timeout bounds it
                            input="unadmitted test object\n", cwd=fixture.repo,
                            env=fixture.env, text=True, capture_output=True, timeout=30, check=True)
    candidate = result.stdout.strip()
    before = fixture.peer_bytes()
    remote = fixture.remote_tip()
    refused = fixture.run("git", "push", "origin", candidate + ":refs/heads/main", allow_failure=True)
    assert refused.returncode != 0 and "not on this repo's shared main" in refused.stderr, (
        f"unadmitted-history: wrong refusal\n{refused.stdout}{refused.stderr}")
    assert fixture.remote_tip() == remote, "unadmitted-history: remote changed"
    assert fixture.peer_bytes() == before, "unadmitted-history: peer bytes changed"

def installer_regenerates_custody(fixture: Fixture) -> None:
    scripts = fixture.repo / "scripts"
    scripts.mkdir(exist_ok=True)
    for name in ("install-pre-push-gate.sh", "pre-push-gate.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    # A stale installed member must be replaced through the native installer,
    # not repaired by a test's own patch. Prove restoration by actual commit
    # behavior, not by comparing generated source text.
    plugin = fixture.repo / ".git/hooks/hooks.d/pre-commit/50-agent-mail.py"
    plugin.write_text("#!/usr/bin/env python3\nraise RuntimeError('STALE-GENERATED-GUARD')\n")
    fixture.run("sh", str(scripts / "install-pre-push-gate.sh"))
    mutation_refused(fixture)


def installer_migrates_prepush_install(fixture: Fixture) -> None:
    # Today's live repos carry Agent Mail's pre-push plugin. The supported installer must convert them: plugin gone,
    # pre-push chain runner and the kit's members kept, custody still refused at commit. (No push here: the installer
    # adds the real fresh gate as a pre-push member; publication without the plugin is the `publication` case.)
    scripts = fixture.repo / "scripts"
    scripts.mkdir(exist_ok=True)
    for name in ("install-pre-push-gate.sh", "pre-push-gate.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    fixture.install("agent-mail-default")
    hooks = fixture.repo / ".git/hooks"
    plugin = hooks / "hooks.d/pre-push/50-agent-mail.py"
    assert plugin.is_file(), "migration: the Agent Mail default install did not create the pre-push plugin"
    fixture.run("sh", str(scripts / "install-pre-push-gate.sh"))
    assert not plugin.exists(), "migration: the installer left Agent Mail's pre-push plugin installed"
    assert os.access(hooks / "pre-push", os.X_OK), "migration: the pre-push chain runner was removed"
    assert (hooks / "hooks.d/pre-push/30-omp-kit-on-main").is_file(), "migration: the kit's history member was removed"
    assert (hooks / "hooks.d/pre-commit/50-agent-mail.py").is_file(), "migration: pre-commit custody plugin missing"
    mutation_refused(fixture)


def nonchain_hook_preserved(fixture: Fixture, hook_name: str = "pre-push") -> None:
    scripts = fixture.repo / "scripts"
    scripts.mkdir(exist_ok=True)
    for name in ("install-pre-push-gate.sh", "pre-push-gate.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    hooks = fixture.repo / ".git/hooks"
    custom = hooks / hook_name
    custom.write_text("#!/bin/sh\nexit 23\n")
    before = {path: path.read_bytes() for path in hooks.rglob("*") if path.is_file()}
    result = fixture.run("sh", str(scripts / "install-pre-push-gate.sh"), allow_failure=True)
    assert result.returncode == 2 and "non-chain" in result.stderr, (
        f"nonchain-custody: wrong refusal\n{result.stdout}{result.stderr}")
    after = {path: path.read_bytes() for path in hooks.rglob("*") if path.is_file()}
    assert after == before, "nonchain-custody: refused installer changed existing hook bytes"



def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutant", choices=("mutation-custody", "publication-scope"))
    args = parser.parse_args()
    am = shutil.which(os.environ.get("AM_BIN", "am"))
    if am is None:
        parser.error("real native am is required (or AM_BIN=/absolute/path/to/am)")
    tmp = Path(os.environ.get("TMPDIR", ""))
    if not tmp.is_dir() or not (tmp / ".owner").is_file() or not tmp.is_relative_to(ROOT / "var/agent-tmp"):
        parser.error("TMPDIR must be an owned directory under this repo's var/agent-tmp")
    print("generator", am, "sha256", hashlib.sha256(Path(am).read_bytes()).hexdigest(), flush=True)
    failures = 0
    # Remove passing fixtures; keep failed fixtures and complete producer output for the scratch reaper.
    for name, check in (("publication", publication), ("mutation-custody", mutation_refused),
                        ("unadmitted-history", unadmitted_history_refused),
                        ("installer-regeneration", installer_regenerates_custody),
                        ("installer-migration", installer_migrates_prepush_install),
                        ("nonchain-custody", nonchain_hook_preserved),
                        ("nonchain-precommit-custody", lambda fixture: nonchain_hook_preserved(fixture, "pre-commit"))):
        for phase in ("installed", "regenerated"):
            # A fresh origin keeps publication a real ref update on both
            # trials; re-pushing an up-to-date ref would not exercise a hook.
            parent = tmp / f"snapshot-{name}-{phase}.{os.getpid()}"
            parent.mkdir(mode=0o700)
            fixture = Fixture(parent, am, args.mutant)
            if phase == "regenerated":
                fixture.install()
            try:
                check(fixture)
                print("PASS", name, phase, flush=True)
                shutil.rmtree(parent)
            except AssertionError as error:
                failures += 1
                print("FAIL", name, phase, error, "fixture", parent, flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
