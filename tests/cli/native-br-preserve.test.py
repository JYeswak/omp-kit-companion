#!/usr/bin/env python3
"""Native BR/Git regressions for preservation-only admission; no SQLite or echo BR.

Run with TMPDIR pointing at owned repo scratch:
  nice -n 10 python3 tests/cli/native-br-preserve.test.py
Fixtures are left for the owned-scratch reaper, not recursively deleted.
"""
from __future__ import annotations

from contextlib import redirect_stdout, redirect_stderr
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
KIT = Path(__file__).resolve().parents[2]
GUARD = KIT / "scripts/native-br-preserve.py"
NATIVE = Path(shutil.which("br") or "/missing-native-br").resolve()
NATIVE_SHA = hashlib.sha256(NATIVE.read_bytes()).hexdigest() if NATIVE.is_file() else ""
spec = importlib.util.spec_from_file_location("native_br_preserve", GUARD)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
ENV = dict(os.environ)
for key in ("BEADS_DB", "BEADS_JSONL", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
    ENV.pop(key, None)
ENV["PYTHONDONTWRITEBYTECODE"] = "1"
PARENT = Path(os.environ["TMPDIR"])
ROOT = Path(tempfile.mkdtemp(prefix="native-preserve." + str(os.getpid()) + ".", dir=PARENT))
(ROOT / ".owner").write_text(json.dumps({"pid": os.getpid(), "label": "native-preserve", "repo": str(KIT)}))


def issue(ident: str, creator: str = "FixtureCreator", comment: bool = False, before: bool = False) -> dict:
    born = "2026-09-08T20:15:29Z" if before else "2026-09-08T20:15:31Z"
    row = {"id": ident, "title": "Preserve native data without creator authority",
           "description": "An owned native fixture, never production or a borrowed identity.",
           "acceptance_criteria": "Retain this original accepted condition and its evidence.",
           "status": "open", "priority": 2, "issue_type": "task", "created_by": creator,
           "created_at": born, "updated_at": born}
    if comment:
        row["comments"] = [{"id": 1, "issue_id": ident, "author": "LaterFixtureAgent",
                            "text": "A later comment cannot establish creator authority.",
                            "created_at": "2026-09-08T21:00:00Z"}]
    return row


class Fixture:
    serial = 0

    def __init__(self, data: list[dict] | None = None):
        Fixture.serial += 1
        self.root = ROOT / str(Fixture.serial)
        self.root.mkdir()
        (self.root / ".owner").write_text(json.dumps({"pid": os.getpid(), "label": "native-fixture", "repo": str(KIT)}))
        self.source = self.root / guard.TRACKER
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "GuardFixture")
        self.git("config", "user.email", "fixture@example.test")
        (self.root / "no-hooks").mkdir()
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        self.br("init", "--prefix", "fixture")
        self.write(data or [issue("fixture-aaa")])
        self.br("sync", "--import-only")
        self.export()
        self.git("add", "--", guard.TRACKER)
        self.git("commit", "--only", "-m", "fixture native baseline", "--", guard.TRACKER)

    def cmd(self, argv: list[str], env: dict | None = None, expected: int = 0) -> subprocess.CompletedProcess:
        p = subprocess.run(argv, cwd=self.root, env=env or ENV, capture_output=True, text=True,  # pysafe: leaf git/native-br fixture subprocess; timeout bounds the wait, DEVNULL stdin
                           timeout=30, stdin=subprocess.DEVNULL)
        with (self.root / "commands.jsonl").open("a") as out:
            out.write(json.dumps({"argv": argv, "rc": p.returncode, "stdout": p.stdout, "stderr": p.stderr}) + "\n")
        if p.returncode != expected:
            raise AssertionError(json.dumps({"argv": argv, "rc": p.returncode, "expected": expected,
                                             "stdout": p.stdout, "stderr": p.stderr}))
        return p

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return self.cmd(["git", "-c", "commit.gpgsign=false", "-C", str(self.root), *args])

    def br(self, *args: str) -> subprocess.CompletedProcess:
        return self.cmd([str(NATIVE), "--db", str(self.root / ".beads/beads.db"),
                         "--no-auto-import", "--no-auto-flush", "--actor", "GuardFixture", *args, "--json"])

    def write(self, data: list[dict]) -> None:
        self.source.write_text("".join(json.dumps(row) + "\n" for row in data))

    def exported(self) -> list[dict]:
        return [json.loads(line) for line in self.source.read_text().splitlines() if line.strip()]

    def export(self) -> None:
        self.br("sync", "--flush-only", "--error-policy", "strict")

    def stage(self) -> None:
        self.git("add", "--", guard.TRACKER)

    def progress(self) -> None:
        self.br("comments", "add", self.exported()[0]["id"], "Native progress, not creator authority")
        self.export()
        self.stage()

    def args(self) -> list[str]:
        return ["--repo", str(self.root), "--native-br", str(NATIVE), "--native-br-sha256", NATIVE_SHA]

    def cli(self, expected: int = 0, env: dict | None = None, extra: list[str] | None = None) -> dict:
        p = self.cmd([sys.executable, str(GUARD), *self.args(), *(extra or [])], env, expected)
        return json.loads(p.stdout if expected == 0 else p.stderr)


class PreservationTests(unittest.TestCase):
    def test_native_A_D_and_pre_cutoff_are_preserved_without_creator_or_grader_grants(self):
        cases = [("A", "josh", False, False), ("B", "josh", True, False),
                 ("C", "FixtureCreator", True, False), ("D", "FixtureCreator", False, False),
                 ("pre-cutoff", "josh", False, True)]
        for label, creator, has_comment, before in cases:
            with self.subTest(label=label):
                f = Fixture([issue("fixture-aaa", creator, has_comment, before)])
                f.progress()
                result = f.cli()
                self.assertEqual(result["status"], "PRESERVED")
                self.assertEqual(result["creation_authority"], "NOT_ESTABLISHED")
                self.assertEqual(result["grading_authority"], "NOT_ESTABLISHED")
                self.assertEqual(result["attribution"], "UNKNOWN")
                self.assertEqual(f.exported()[0]["created_by"], creator)

    def test_A_D_direct_source_additions_do_not_become_native_creation_authority(self):
        for creator, has_comment in (("josh", False), ("josh", True),
                                     ("FixtureCreator", True), ("FixtureCreator", False)):
            with self.subTest(creator=creator, comment=has_comment):
                f = Fixture()
                extra = issue("fixture-bbb", creator, has_comment)
                f.write(f.exported() + [extra])
                f.stage()
                result = f.cli(4)
                self.assertEqual(result["status"], "REFUSED")

    def test_forged_creator_assignee_or_authority_is_rejected(self):
        for field in ("created_by", "assignee", "creation_authority"):
            with self.subTest(field=field):
                f = Fixture()
                values = f.exported()
                values[0][field] = "ForgedAuthority"
                f.write(values)
                f.stage()
                self.assertEqual(f.cli(4)["status"], "REFUSED")

    def test_duplicate_ids_and_duplicate_json_keys_refuse(self):
        f = Fixture()
        values = f.exported()
        f.write(values + values)
        f.stage()
        self.assertEqual(f.cli(4)["reason"], "DUPLICATE_ISSUE_ID")
        raw = json.dumps(values[0])
        f.source.write_text('{"id":"discarded-id",' + raw[1:] + "\n")
        f.stage()
        self.assertEqual(f.cli(4)["reason"], "DUPLICATE_JSON_KEY")

    def test_corrupt_source_and_missing_working_export_refuse(self):
        f = Fixture()
        f.source.write_text('{"id":\n')
        f.stage()
        self.assertEqual(f.cli(4)["reason"], "INVALID_JSON")
        f.source.unlink()
        self.assertEqual(f.cli(4)["status"], "REFUSED")

    def test_original_record_acceptance_and_comment_cannot_disappear(self):
        for field in ("record", "acceptance_criteria", "comments"):
            with self.subTest(field=field):
                f = Fixture([issue("fixture-aaa", comment=True)])
                values = f.exported()
                if field == "record":
                    values = []
                else:
                    values[0].pop(field, None)
                f.write(values)
                f.stage()
                expected = {"record": "ORIGINAL_RECORD_OR_TOMBSTONE_MISSING",
                            "acceptance_criteria": "ORIGINAL_ACCEPTANCE_LOST",
                            "comments": "ORIGINAL_COMMENT_LOST_OR_CHANGED"}[field]
                self.assertEqual(f.cli(4)["reason"], expected)

    def test_staged_snapshot_must_equal_working_export(self):
        f = Fixture()
        f.progress()
        f.source.write_text(f.source.read_text() + "\n")
        self.assertEqual(f.cli(4)["reason"], "WORKING_EXPORT_DIFFERS_FROM_INDEX")

    def test_foreign_environment_cannot_select_another_database_or_export(self):
        f, foreign = Fixture(), Fixture([issue("fixture-bbb")])
        f.progress()
        env = {**ENV, "BEADS_DB": str(foreign.root / ".beads/beads.db"), "BEADS_JSONL": str(foreign.source)}
        self.assertEqual(f.cli(env=env)["status"], "PRESERVED")

    def test_symlinked_database_or_workspace_is_not_native_authority(self):
        for component in ("database", "workspace"):
            with self.subTest(component=component):
                f = Fixture()
                f.progress()
                path = f.root / (".beads/beads.db" if component == "database" else ".beads")
                saved = path.with_name(path.name + ".retained")
                path.rename(saved)
                path.symlink_to(saved, target_is_directory=component == "workspace")
                self.assertEqual(f.cli(4)["reason"], "NONCANONICAL_NATIVE_PATH")

    def test_changed_native_after_first_plan_refuses_without_exporting_or_losing_the_write(self):
        f = Fixture()
        f.progress()
        original = guard.run
        plans = []
        before = f.source.read_bytes()

        def observed(argv, repo, env):
            output = original(argv, repo, env)
            if "--reconcile-additive" in argv:
                plans.append(output)
                if len(plans) == 1:
                    f.br("comments", "add", "fixture-aaa", "Arbitrary native change after the first plan")
            return output

        with patch.object(guard, "run", observed), patch.dict(os.environ, ENV, clear=True):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = guard.main(f.args())
        self.assertEqual(result, 4)
        self.assertEqual(f.source.read_bytes(), before)
        rows_now = json.loads(f.br("comments", "list", "fixture-aaa").stdout)
        records = rows_now if isinstance(rows_now, list) else rows_now.get("comments", [])
        self.assertTrue(any(c["text"] == "Arbitrary native change after the first plan" for c in records))

    def test_incomplete_relation_witness_is_not_full_state_equality(self):
        f = Fixture()
        f.progress()
        plan = json.loads(f.br("sync", "--reconcile-additive", "--dry-run").stdout)
        candidate = guard.rows(f.source.read_bytes())
        for field in ("comment_payload_sha256", "dependency_payload_sha256", "event_payload_sha256"):
            malformed = copy.deepcopy(plan)
            malformed["target_before"].pop(field)
            malformed["expected_target_after"].pop(field)
            with self.subTest(field=field), self.assertRaises(guard.Refusal):
                guard.plan_matches(malformed, f.root, candidate, guard.sha(f.source.read_bytes()))

    def test_native_binary_pin_cannot_be_overridden_by_path_or_env(self):
        f = Fixture()
        f.progress()
        p = f.cmd([sys.executable, str(GUARD), *f.args()[:-1], "0" * 64], expected=4)
        self.assertEqual(json.loads(p.stderr)["reason"], "NATIVE_EXECUTABLE_CHANGED")

    def test_unrelated_source_change_does_not_require_native_authority(self):
        f = Fixture()
        (f.root / "owned.txt").write_text("unrelated source work\n")
        f.git("add", "--", "owned.txt")
        self.assertEqual(f.cli()["status"], "SKIPPED")

    def install_args(self, fixture: Fixture) -> list[str]:
        return ["sh", str(KIT / "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads",
                "--native-preservation", "--native-br", str(NATIVE),
                "--native-br-sha256", NATIVE_SHA, "--native-guard-sha256",
                hashlib.sha256(GUARD.read_bytes()).hexdigest(), str(fixture.root)]

    def test_actual_installed_normal_commit_preserves_peer_index_and_worktree(self):
        f = Fixture()
        f.progress()
        (f.root / "peer.txt").write_text("peer staged bytes\n")
        (f.root / "peer-untracked.txt").write_text("peer untracked bytes\n")
        f.git("add", "--", "peer.txt")
        peer_entry = f.git("ls-files", "--stage", "--", "peer.txt").stdout
        peer_bytes = (f.root / "peer.txt").read_bytes()
        candidate = f.source.read_bytes()
        f.cmd(self.install_args(f))
        check = self.install_args(f)
        check.insert(2, "--check")
        f.cmd(check)
        f.git("commit", "--only", "-m", "fixture native preservation [test]",
              "-m", "Bead: fixture-aaa", "--", guard.TRACKER)
        self.assertEqual(f.git("show", "HEAD:" + guard.TRACKER).stdout.encode(), candidate)
        self.assertEqual(f.git("ls-files", "--stage", "--", "peer.txt").stdout, peer_entry)
        self.assertEqual((f.root / "peer.txt").read_bytes(), peer_bytes)
        self.assertEqual((f.root / "peer-untracked.txt").read_text(), "peer untracked bytes\n")

    def test_tampered_installed_runtime_cannot_allow_a_normal_commit(self):
        f = Fixture()
        f.progress()
        f.cmd(self.install_args(f))
        hooks = Path(f.git("rev-parse", "--git-path", "hooks").stdout.strip())
        if not hooks.is_absolute():
            hooks = f.root / hooks
        # Tamper only the owned installed runtime artifact, never a source copy
        # used for development. Its permissive exit must not be executed.
        (hooks / "hooks.d/pre-commit/native-br-preserve.py").write_text("raise SystemExit(0)\n")
        before = f.git("rev-parse", "HEAD").stdout
        p = f.cmd(["sh", str(hooks / "hooks.d/pre-commit/40-omp-kit-native-preserve")], expected=4)
        self.assertEqual(json.loads(p.stderr)["reason"], "INSTALLED_GUARD_CHANGED")
        f.cmd(["git", "-c", "commit.gpgsign=false", "-C", str(f.root), "commit", "--only",
               "-m", "fixture refusal [test]", "-m", "Bead: fixture-aaa", "--", guard.TRACKER], expected=1)
        self.assertEqual(f.git("rev-parse", "HEAD").stdout, before)

    def test_installer_refuses_an_unreviewed_guard_digest_before_any_hook_effect(self):
        f = Fixture()
        f.progress()
        args = self.install_args(f)
        args[args.index("--native-guard-sha256") + 1] = "0" * 64
        f.cmd(args, expected=1)
        self.assertEqual(list((f.root / "no-hooks").iterdir()), [])


if __name__ == "__main__":
    print("native fixture root=" + str(ROOT), flush=True)
    unittest.main(verbosity=2)
