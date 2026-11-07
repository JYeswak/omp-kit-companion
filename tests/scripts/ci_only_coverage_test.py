#!/usr/bin/env python3
"""Manifest exclusions run in the one main qualification, never a second judgment."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from kitlib_tmp import owned_tmp
from kitlib_run import run

spec = importlib.util.spec_from_file_location("folded_store", ROOT / "scripts/full-suite-verdict-store.py")
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class FoldedCoverage(unittest.TestCase):
    def test_main_runs_every_manifest_row_and_base_keeps_its_exclusions(self) -> None:
        with owned_tmp("folded-qualification") as tmp:
            source = Path(tmp) / "source"
            (source / "scripts").mkdir(parents=True)
            shutil.copy2(ROOT / "scripts/kitlib-tmp.sh", source / "scripts/kitlib-tmp.sh")
            shutil.copy2(ROOT / "scripts/gate-ci-only.tsv", source / "scripts/gate-ci-only.tsv")
            excluded = store.excluded_paths(source)
            self.assertTrue(excluded)
            for path in excluded | {"tests/cli/local.test.ts"}:
                target = source / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('import { expect, test } from "bun:test";\n'
                                  'test("declared suite executes", () => expect(2 + 2).toBe(4));\n')
            env = store.load_metrics(ROOT).suite_environment()
            env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                        "GIT_CEILING_DIRECTORIES": tmp, "TMPDIR": tmp,
                        "GIT_AUTHOR_NAME": "ReleaseDiet", "GIT_AUTHOR_EMAIL": "diet@example.invalid",
                        "GIT_COMMITTER_NAME": "ReleaseDiet", "GIT_COMMITTER_EMAIL": "diet@example.invalid"})

            def git(*args: str) -> str:
                result = run(["git", "-C", str(source), *args], env=env, deadline_s=30)
                self.assertEqual(result.rc, 0, result.stderr.decode())
                return result.stdout.decode().strip()

            git("init", "-q", "-b", "main")
            git("add", "scripts", "tests")
            git("commit", "-qm", "folded qualification fixture")
            self.assertEqual(store.declared_suite_files(source, "main"), excluded | {"tests/cli/local.test.ts"})
            self.assertEqual(store.declared_suite_files(source, "base"), {"tests/cli/local.test.ts"})
            self.assertEqual(store.declared_suite_files_from_git(source, "HEAD", "main"), excluded | {"tests/cli/local.test.ts"})
            self.assertEqual(store.declared_suite_files_from_git(source, "HEAD", "base"), {"tests/cli/local.test.ts"})

            def judge(role: str, label: str, expected_rc: int) -> dict:
                cache = Path(tmp) / label
                result = run(["sh", str(ROOT / "scripts/full-suite-verdict.sh"), "--repo", str(source),
                              "--commit", "HEAD", "--judge-role", role, "--cache-dir", str(cache)],
                             cwd=source, env=env, deadline_s=120)
                output = (result.stdout + result.stderr).decode()
                self.assertFalse(result.timed_out, output)
                self.assertEqual(result.rc, expected_rc, output)
                records = list(cache.glob("*.json"))
                self.assertEqual(len(records), 1, output)
                self.assertFalse((cache / "ci-only").exists())
                record = json.loads(records[0].read_text())
                valid, reason = store.validate_record(records[0], judge_root=ROOT, repo=source, commit="HEAD")
                self.assertIsNotNone(valid, reason)
                return record

            main = judge("main", "main-pass", 0)
            self.assertEqual(set(main["evidence"]["declared_files"]), excluded | {"tests/cli/local.test.ts"})
            self.assertEqual({row["path"] for row in main["evidence"]["files"]}, excluded | {"tests/cli/local.test.ts"})
            base = judge("base", "base-pass", 0)
            self.assertEqual(base["evidence"]["declared_files"], ["tests/cli/local.test.ts"])
            planted = sorted(excluded)[0]
            (source / planted).write_text('import { expect, test } from "bun:test";\n'
                                          'test("planted excluded failure", () => expect(2 + 2).toBe(5));\n')
            git("add", "tests")
            git("commit", "-qm", "plant failure in formerly deferred suite")
            failed = judge("main", "main-fail", 1)
            self.assertEqual(failed["verdict"], "FAIL")
            self.assertTrue(any(row["path"] == planted and row["rc"] != 0 for row in failed["evidence"]["files"]))
            self.assertEqual(judge("base", "base-after-failure", 0)["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
