#!/usr/bin/env python3
"""Test scripts/ci-shard-coverage.py against real `bun test --shard` junit reports, with planted negatives."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from kitlib_tmp import owned_tmp  # noqa: E402  (kitlib owned temp dirs: removed on exit and on HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)
_spec = importlib.util.spec_from_file_location("ci_shard_coverage", ROOT / "scripts" / "ci-shard-coverage.py")
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/ci-shard-coverage.py")
coverage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coverage)

SHARDS = 3
FILES = ["tests/cli/a.test.ts", "tests/cli/b.test.ts", "tests/cli/nested/c.test.ts", "tests/cli/d_test.ts",
         "tests/guard/e.test.ts", "tests/cli/release.test.ts"]
ROOTS = ["tests/cli", "tests/guard"]
IGNORES = ["**/release.test.ts"]


class ShardCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("bun") is None:
            raise RuntimeError("ci-shard-coverage tests need bun on PATH; refusing to skip silently")
        cls.tmp = owned_tmp("ci-shard-coverage-test")
        cls.repo = Path(cls.tmp.path) / "repo"
        for name in FILES:
            path = cls.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f'import {{ expect, test }} from "bun:test";\ntest("{name}", () => expect(1).toBe(1));\n')
        (cls.repo / "bunfig.toml").write_text("")
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
        subprocess.run(["git", "init", "-q", str(cls.repo)], check=True, env=env,  # pysafe: leaf git fixture in a temp repo; timeout bounds the wait, DEVNULL stdin
                       timeout=60, stdin=subprocess.DEVNULL)
        subprocess.run(["git", "add", "-A"], cwd=cls.repo, check=True, env=env,  # pysafe: leaf git fixture in a temp repo; timeout bounds the wait, DEVNULL stdin
                       timeout=60, stdin=subprocess.DEVNULL)
        cls.reports = Path(cls.tmp.path) / "reports"
        cls.reports.mkdir()
        for index in range(1, SHARDS + 1):
            out = cls.reports / f"junit-{index}.attempt-1.xml"
            run = run_bounded(["bun", "test", *ROOTS, *[f"--path-ignore-patterns={glob}" for glob in IGNORES],
                               f"--shard={index}/{SHARDS}", "--reporter=junit", f"--reporter-outfile={out}"],
                              cwd=cls.repo, timeout=300)
            if run.outcome != "OK":
                raise RuntimeError(f"bun shard {index} timed out after 300s; process group killed")
            if run.returncode != 0 or not out.is_file():
                raise RuntimeError(f"bun shard {index} failed: {run.text('stdout')}{run.text('stderr')}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def run_check(self, junit_dir: Path, shards: int = SHARDS, ignores: list[str] = IGNORES) -> tuple[int, str]:
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = coverage.main(["--shards", str(shards), "--junit-dir", str(junit_dir), "--repo", str(self.repo),
                                  *[arg for root in ROOTS for arg in ("--root", root)],
                                  *[arg for glob in ignores for arg in ("--ignore", glob)]])
        return code, out.getvalue() + err.getvalue()

    def copy_reports(self) -> Path:
        target = Path(self.tmp.path) / f"reports-copy-{len(list(Path(self.tmp.path).glob('reports-copy-*')))}"
        target.mkdir()
        for path in self.reports.iterdir():
            shutil.copy(path, target / path.name)
        return target

    def test_real_bun_shards_cover_every_file_once(self) -> None:
        code, output = self.run_check(self.reports)
        self.assertEqual(code, 0, output)
        self.assertIn("CORE_SHARD_COVERAGE=ok shards=3 files=5", output)

    def test_dropped_shard_leg_fails(self) -> None:
        reports = self.copy_reports()
        dropped = reports / f"junit-{SHARDS}.attempt-1.xml"
        lost = coverage.report_files(dropped)
        dropped.unlink()
        code, output = self.run_check(reports)
        self.assertEqual(code, 1, output)
        self.assertIn(f"MISSING_SHARD_REPORT shard={SHARDS}/{SHARDS}", output)
        for name in lost:
            self.assertIn(f"NOT_RUN {name}", output)

    def test_shard_count_disagreeing_with_legs_fails(self) -> None:
        code, output = self.run_check(self.reports, shards=2)
        self.assertEqual(code, 1, output)
        self.assertIn("UNEXPECTED_SHARD_REPORT shard=3", output)

    def test_file_run_twice_fails(self) -> None:
        reports = self.copy_reports()
        first = (reports / "junit-1.attempt-1.xml").read_text()
        (reports / "junit-2.attempt-1.xml").write_text(first)
        code, output = self.run_check(reports)
        self.assertEqual(code, 1, output)
        self.assertIn("DUPLICATE_FILE", output)

    def test_ignore_drift_between_bun_and_checker_fails(self) -> None:
        code, output = self.run_check(self.reports, ignores=[])
        self.assertEqual(code, 1, output)
        self.assertIn("NOT_RUN tests/cli/release.test.ts", output)

    def test_newest_attempt_of_a_rerun_shard_counts(self) -> None:
        reports = self.copy_reports()
        (reports / "junit-2.attempt-2.xml").write_text((reports / "junit-2.attempt-1.xml").read_text())
        (reports / "junit-2.attempt-1.xml").write_text('<?xml version="1.0"?><testsuites></testsuites>')
        code, output = self.run_check(reports)
        self.assertEqual(code, 0, output)

    def test_unrecognized_report_name_fails_closed(self) -> None:
        reports = self.copy_reports()
        (reports / "junit-x.xml").write_text("<testsuites/>")
        code, output = self.run_check(reports)
        self.assertEqual(code, 1, output)
        self.assertIn("UNREADABLE_REPORT", output)


if __name__ == "__main__":
    unittest.main()
