#!/usr/bin/env python3
"""SNAPSHOTPUB1: real Git, installed kit hooks, and isolated Board custody.

The repository, bare origin, and Board endpoint are owned by this test.
Legacy hook files are inert migration inputs; no Agent Mail tool is needed.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.kitlib_run import run
from scripts.kitlib_tmp import owned_tmp

BOARD_MEMBER = "50-omp-kit-board-reservations"


def executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


@contextmanager
def board_fixture(parent: Path):
    seed = parent / "claimed-board-tasks.json"
    auth = parent / "xdg/board/local"
    auth.mkdir(parents=True)
    (auth / "t.json").write_text('{"token":"t"}')
    bun = shutil.which("bun")
    if bun is None:
        raise AssertionError("bun is required for the isolated Board fixture")
    launcher = parent / "fixture-omp-kit"
    executable(launcher, f'#!/bin/sh\nexec {shlex.quote(bun)} {shlex.quote(str(ROOT / "src/cli.ts"))} "$@"\n')
    class BoardTasks(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            request = urlsplit(self.path)
            if request.path != "/api/board/tasks":
                self.send_error(404)
                return
            claimed = parse_qs(request.query).get("state") == ["claimed"]
            payload = seed.read_bytes() if claimed and seed.is_file() else b'{"tasks":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), BoardTasks) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            yield {"BOARD_URL": f"http://127.0.0.1:{server.server_port}/api/board",
                   "XDG_CONFIG_HOME": str(parent / "xdg"), "OMP_KIT_BIN": str(launcher)}, seed
        finally:
            server.shutdown()


class Fixture:
    def __init__(self, parent: Path, runners: Path, board_env: dict[str, str],
                 seed: Path, mutant: str | None) -> None:
        self.repo = parent / "repo"
        self.remote = parent / "origin.git"
        self.seed = seed
        self.seed.unlink(missing_ok=True)
        self.mutant = mutant
        self.repo.mkdir()
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(parent), "TMPDIR": str(parent),
            "AGENT_NAME": "SnapshotPublisher",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "PYTHONDONTWRITEBYTECODE": "1",
            "FLEET_BOARD_RES_STATE": str(parent / "board-state"),
            **board_env,
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
        self.hooks = self.repo / ".git/hooks"
        for hook in ("pre-commit", "pre-push"):
            shutil.copy2(runners / hook, self.hooks / hook)
            (self.hooks / "hooks.d" / hook).mkdir(parents=True)
        member = self.hooks / "hooks.d/pre-push/30-omp-kit-on-main"
        shutil.copyfile(ROOT / "scripts/check-pushed-on-main.sh", member)
        member.chmod(0o755)
        self.install()
        self.seed.write_text(json.dumps({"tasks": [
            {"message": {
                "id": str(idx),
                "labels": {"path": path, "holder": "ForeignHolder", "exclusive": "1"},
                "task": {"state": "claimed", "claim": {"until": "2099-01-01T00:00:00Z"}},
            }}
            for idx, path in enumerate(("leased.txt", "foreign-untracked.txt"), 1)
        ]}))
        (self.repo / "leased.txt").write_text("foreign staged bytes\n")
        self.run("git", "add", "--", "leased.txt")
        (self.repo / "leased.txt").write_text("foreign unstaged bytes\n")
        (self.repo / "foreign-untracked.txt").write_bytes(b"foreign\x00untracked\n")

    def run(self, *args: str, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
        outcome = run(list(args), cwd=str(self.repo), env=self.env, deadline_s=30)
        if outcome.rc is None or outcome.timed_out or outcome.truncated:
            raise AssertionError(f"{args!r}: bounded fixture command failed to finish")
        result = subprocess.CompletedProcess(args, outcome.rc, outcome.stdout.decode(), outcome.stderr.decode())
        if result.returncode and not allow_failure:
            raise AssertionError(f"{args!r}: rc={result.returncode}\n{result.stdout}{result.stderr}")
        return result

    def git(self, *args: str) -> str:
        return self.run("git", *args).stdout.strip()

    def commit(self, message: str) -> None:
        self.run("git", "add", "--", "leased.txt")
        self.run("git", "commit", "-qm", message + " [test]")

    def install(self) -> None:
        scripts = self.repo / "scripts"
        scripts.mkdir(exist_ok=True)
        for name in ("install-pre-push-gate.sh", "pre-push-gate.sh", "check-staged-board-reservations.sh"):
            shutil.copyfile(ROOT / "scripts" / name, scripts / name)
        self.run("sh", str(scripts / "install-pre-push-gate.sh"))
        member = self.hooks / "hooks.d/pre-commit" / BOARD_MEMBER
        if self.mutant == "mutation-custody":
            executable(member, "#!/bin/sh\nexit 0\n")
        elif self.mutant == "publication-scope":
            # A real Board reservation must not veto publication of committed main.
            shutil.copy2(member, self.hooks / "hooks.d/pre-push/49-publication-scope-mutant")

    def isolate_publication_gate(self) -> None:
        # This small Git repo has no release inputs. Judge history here; the
        # fresh-gate suite separately exercises the full source/CI checks.
        (self.hooks / "hooks.d/pre-push/40-omp-kit-fresh-gate").unlink()

    def peer_bytes(self, *, include_index: bool = True) -> dict[str, bytes]:
        paths = [self.repo / "leased.txt", self.repo / "foreign-untracked.txt", self.seed]
        if include_index:
            paths.append(self.repo / ".git/index")
        return {str(path): path.read_bytes() for path in paths}

    def remote_tip(self) -> str:
        return self.git("--git-dir=" + str(self.remote), "rev-parse", "refs/heads/main")


def publication(fixture: Fixture) -> None:
    fixture.isolate_publication_gate()
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
    assert (result.returncode != 0 and "RESERVED_BY_OTHER" in result.stderr
            and "leased.txt held by ForeignHolder" in result.stderr), (
        f"mutation-custody: foreign commit not refused for custody\n{result.stdout}{result.stderr}")
    assert fixture.git("rev-parse", "HEAD") == head, "mutation-custody: refused commit changed history"
    assert fixture.peer_bytes(include_index=False) == before, "mutation-custody: refusal modified peer bytes"
    assert fixture.git("ls-files", "--stage", "-z") == index_entries, "mutation-custody: staged entries changed"


def unadmitted_history_refused(fixture: Fixture) -> None:
    fixture.isolate_publication_gate()
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
    plugin = fixture.hooks / "hooks.d/pre-commit" / BOARD_MEMBER
    executable(plugin, "#!/bin/sh\nexit 0\n")
    fixture.install()
    mutation_refused(fixture)


def installer_migrates_prepush_install(fixture: Fixture) -> None:
    # Plant the known old filenames without running the retired generator.
    legacy = [fixture.hooks / "hooks.d" / kind / "50-agent-mail.py"
              for kind in ("pre-commit", "pre-push")]
    for plugin in legacy:
        executable(plugin, "#!/bin/sh\nexit 73\n")
    fixture.install()
    assert not any(plugin.exists() for plugin in legacy), "migration: retired member still active"
    assert os.access(fixture.hooks / "pre-push", os.X_OK), "migration: pre-push runner removed"
    assert (fixture.hooks / "hooks.d/pre-push/30-omp-kit-on-main").is_file(), "migration: history member removed"
    mutation_refused(fixture)


def nonchain_hook_preserved(fixture: Fixture, hook_name: str = "pre-push") -> None:
    custom = fixture.hooks / hook_name
    custom.write_text("#!/bin/sh\nexit 23\n")
    before = {path: path.read_bytes() for path in fixture.hooks.rglob("*") if path.is_file()}
    installer = fixture.repo / "scripts/install-pre-push-gate.sh"
    result = fixture.run("sh", str(installer), allow_failure=True)
    assert result.returncode == 2 and "non-chain" in result.stderr, (
        f"nonchain-custody: wrong refusal\n{result.stdout}{result.stderr}")
    after = {path: path.read_bytes() for path in fixture.hooks.rglob("*") if path.is_file()}
    assert after == before, "nonchain-custody: refused installer changed existing hook bytes"



def exercise(tmp: Path, board_env: dict[str, str], seed: Path, mutant: str | None) -> int:
    template = tmp / "hook-template"
    template.mkdir()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp),
           "TMPDIR": str(tmp), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "OMP_KIT_GATE_EVENTS_SKIP": "1"}
    actions = [
        ["git", "init", "-q", "--template="],
        ["sh", str(ROOT / "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", str(template)],
    ]
    for argv in actions:
        outcome = run(argv, cwd=str(template), env=env, deadline_s=30)
        assert outcome.rc == 0, (argv, outcome.stdout.decode(), outcome.stderr.decode())
    runners = template / ".git/hooks"
    failures = 0
    for name, check in (("publication", publication), ("mutation-custody", mutation_refused),
                        ("unadmitted-history", unadmitted_history_refused),
                        ("installer-regeneration", installer_regenerates_custody),
                        ("installer-migration", installer_migrates_prepush_install),
                        ("nonchain-custody", nonchain_hook_preserved),
                        ("nonchain-precommit-custody", lambda fixture: nonchain_hook_preserved(fixture, "pre-commit"))):
        for phase in ("installed", "regenerated"):
            parent = tmp / f"snapshot-{name}-{phase}"
            parent.mkdir(mode=0o700)
            try:
                fixture = Fixture(parent, runners, board_env, seed, mutant)
                if phase == "regenerated":
                    fixture.install()
                check(fixture)
                print("PASS", name, phase, flush=True)
            except AssertionError as error:
                failures += 1
                print("FAIL", name, phase, error, "fixture", parent, flush=True)
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutant", choices=("mutation-custody", "publication-scope"))
    args = parser.parse_args()
    work = ROOT / "var/agent-tmp"
    work.mkdir(parents=True, exist_ok=True)
    # The retry's inherited TMPDIR can name a different worker export.
    with owned_tmp("snapshot-publication", root=str(work)) as scratch:
        tmp = Path(scratch)
        with board_fixture(tmp) as (board_env, seed):
            return exercise(tmp, board_env, seed, args.mutant)


if __name__ == "__main__":
    raise SystemExit(main())
