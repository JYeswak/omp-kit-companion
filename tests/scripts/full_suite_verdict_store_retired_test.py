#!/usr/bin/env python3
"""RETIREDTESTS1: real Git history, retained reports, and one killed mutant per guard.

The measurement rows are comparison fixtures, not evidence of a native suite run.
Run: python3 -B tests/scripts/full_suite_verdict_store_retired_test.py
"""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import kitlib_tmp

spec = importlib.util.spec_from_file_location("verdict_store", ROOT / "scripts/full-suite-verdict-store.py")
store = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(store)
metrics = store.load_metrics(ROOT)
POLICY = {"max_count_drop": {"bun": 0, "shell": 0, "python": 0},
          "wall_floor_ms": 1, "wall_floor_percent": 25}
RUNTIME = "Darwin/arm64/bun-fixture/python-fixture"
RETIRED = "tests/cli/retired.test.sh"
KEEP = "tests/cli/keep.test.sh"
OTHER = "tests/cli/unlisted.test.sh"


def rows(paths: list[str], tree: str) -> list[dict]:
    return [{"path": path, "runner": "sh", "complete": True, "rc": 0,
             "elapsed_ms": 1, "cpu_user_ms": 0, "cpu_system_ms": 0,
             "wait_ms": 0, "setup_ms": 0, "run_ms": 1,
             "started_ms": 0, "finished_ms": 1, "phase_basis": "stage-queue+exec-marker",
             "command": ["sh", path], "judge": {"sha256": metrics.JUDGE_SHA256,
                                                       "python": sys.version.split()[0]},
             "output_sha256": hashlib.sha256(b"").hexdigest(),
             "closure": {"kind": "whole-source-tree", "tree": tree}} for path in paths]


class RetirementFixture:
    def __init__(self, root: Path) -> None:
        self.repo = root / "repo"
        self.repo.mkdir()
        self.cache = root / "cache"
        self.cache.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "RETIREDTESTS1")
        self.git("config", "user.email", "retired@example.invalid")
        self.git("config", "core.hooksPath", "/dev/null")
        for path in (RETIRED, KEEP, OTHER):
            file = self.repo / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.base = self.commit("reference suites")
        self.base_tree = self.git("rev-parse", "HEAD^{tree}")
        (self.repo / RETIRED).unlink()
        self.deletion = self.commit("reviewed retirement")
        self.tree = self.git("rev-parse", "HEAD^{tree}")
        self.entries = [{"path": RETIRED, "kind": "shell", "bead": "ompkit-1ra0d.45",
                         "commit": self.deletion}]
        self.files = root / "rows.json"
        self.reference(self.base_tree, [RETIRED, KEEP, OTHER])

    def git(self, *args: str) -> str:
        with patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": str(self.repo.parent)}):
            return store.text_output(store.checked_run(["git", "-C", str(self.repo), *args]), "fixture Git")

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def reference(self, tree: str, paths: list[str]) -> None:
        for path in self.cache.glob("*"):
            path.unlink()
        counts = {"bun": 0, "shell": len(paths), "python": 0}
        checks = "a" * 64
        path = self.cache / (store.record_key(tree, "main", checks, RUNTIME) + ".json")
        path.with_suffix(".log").write_bytes(b"")
        report = {"version": 1, "status": "PASS", "policy": POLICY, "baseline": None,
                  "counts": counts, "wall_ms": 1, "shortfalls": []}
        record = {"version": 3, "tree": tree, "judge_role": "main", "checks": checks,
                  "runtime": RUNTIME, "judge": {"role": "main", "checks_sha256": checks, "runtime": RUNTIME},
                  "verdict": "PASS", "exit_code": 0, "minimum_run": report,
                  "timing": {"started_ms": 0, "wall_ms": 1},
                  "evidence": {"complete": True, "files": rows(paths, tree), "declared_files": paths,
                               "bun_files": 0, "bun_ran": 0, "bun_fail": 0,
                               "shell_suites": len(paths), "shell_fail": 0, "py_suites": 0, "py_fail": 0,
                               "log_sha256": hashlib.sha256(b"").hexdigest()}}
        path.write_text(json.dumps(record), encoding="utf-8")
        valid, reason = store.validate_record(path, judge_root=ROOT, historical=True)
        assert valid is not None, reason

    def assess(self) -> tuple[dict, list[dict]]:
        ledger = self.repo / ".github/retired-tests.json"
        ledger.parent.mkdir(exist_ok=True)
        ledger.write_text(json.dumps({"version": 1, "entries": self.entries}), encoding="utf-8")
        commit = self.git("rev-parse", "HEAD")
        tree = self.git("rev-parse", "HEAD^{tree}")
        files = rows(sorted(store.declared_suite_files_from_git(self.repo, commit)), tree)
        self.files.write_text(json.dumps(files), encoding="utf-8")
        report = store.assess_minimum_run(ROOT, self.repo, self.cache, "main", RUNTIME, self.files, 1,
                                         repo=self.repo, commit=commit)
        store.validate_minimum_report(report, files, 1, "main", RUNTIME, repo=self.repo, commit=commit)
        return report, files


def mutant(function: object, guard: str) -> object:
    """Remove just the named guard in memory; never alter the product on disk."""
    tree = ast.parse(inspect.getsource(function))
    changed = False
    for node in ast.walk(tree):
        if guard == "count" and isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "retired" for target in node.targets):
            node.value = ast.Constant(0)
            changed = True
        elif (guard == "shortfall" and isinstance(node, ast.If)
              and isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Subscript)
              and isinstance(node.test.left.value, ast.Name) and node.test.left.value.id == "counts"):
            node.test = ast.Constant(False)
            changed = True
        elif guard == "reference" and isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "present" for target in node.targets):
            node.value = ast.Compare(ast.Name("baseline", ast.Load()), [ast.IsNot()], [ast.Constant(None)])
            changed = True
        elif guard == "ancestor" and isinstance(node, ast.Try):
            node.body = [ast.Pass()]
            changed = True
        elif isinstance(node, ast.If) and any(
                isinstance(child, ast.Constant) and isinstance(child.value, str)
                and child.value.startswith("RETIRED_TEST_" + guard)
                for child in ast.walk(node)):
            node.test = ast.Constant(False)
            changed = True
    assert changed, guard
    namespace = dict(function.__globals__)
    exec(compile(ast.fix_missing_locations(tree), "<retirement-mutant>", "exec"), namespace)
    return namespace[function.__name__]


class RetiredTests(unittest.TestCase):
    def check_case(self, case: str) -> None:
        with kitlib_tmp.owned_tmp("retired-tests") as tmp:
            fixture = RetirementFixture(Path(tmp))
            if case == "present":
                (fixture.repo / RETIRED).write_text("exit 0\n", encoding="utf-8")
                fixture.commit("reintroduced retired suite")
            elif case == "wrong-delete":
                fixture.entries[0]["commit"] = fixture.base
            elif case == "ancestor":
                fixture.entries[0]["commit"] = fixture.git(
                    "commit-tree", fixture.tree, "-p", fixture.base, "-m", "sibling retirement")
            elif case == "unlisted":
                (fixture.repo / OTHER).unlink()
                fixture.commit("unreviewed deletion")
            elif case in ("reference", "invalid-with-absent-reference"):
                fixture.reference(fixture.tree, [KEEP, OTHER])
                if case == "invalid-with-absent-reference":
                    fixture.entries.append({**fixture.entries[0], "path": OTHER})
            elif case == "no-reference":
                for path in fixture.cache.glob("*"):
                    path.unlink()
            reasons = {"present": "STILL_PRESENT", "wrong-delete": "NOT_DELETED", "ancestor": "NOT_ANCESTOR",
                       "invalid-with-absent-reference": "STILL_PRESENT"}
            if case in reasons:
                with self.assertRaisesRegex(ValueError, "RETIRED_TEST_" + reasons[case]):
                    fixture.assess()
                return
            report, files = fixture.assess()
            self.assertEqual(report["status"], "FAIL" if case == "unlisted" else "PASS")
            applied = case not in ("reference", "no-reference")
            self.assertEqual(report["retired_tests"], [{**fixture.entries[0], "applied": applied,
                             "reason": "reference-present" if applied else
                                       "no-reference" if case == "no-reference" else "absent-from-reference"}])
            if case == "unlisted":
                self.assertEqual(report["shortfalls"], [{"measure": "shell", "observed": 1, "minimum": 2}])
            if case != "no-reference":
                self.assertIsNotNone(report["baseline"])
            # Retained qualification is not allowed to claim a different subtraction.
            report["retired_tests"][0]["applied"] = not applied
            with self.assertRaises(ValueError):
                store.validate_minimum_report(report, files, 1, "main", RUNTIME)

    def test_listed_deletion_qualifies(self) -> None:
        self.check_case("listed")

    def test_unlisted_deletion_still_fails(self) -> None:
        self.check_case("unlisted")

    def test_listed_file_still_present_refuses(self) -> None:
        self.check_case("present")

    def test_commit_not_deleting_path_refuses(self) -> None:
        self.check_case("wrong-delete")

    def test_nonancestor_deleting_commit_refuses(self) -> None:
        self.check_case("ancestor")

    def test_reference_already_without_path_does_not_subtract(self) -> None:
        self.check_case("reference")

    def test_invalid_entry_still_refuses_when_reference_already_without_path(self) -> None:
        self.check_case("invalid-with-absent-reference")

    def test_no_reference_validates_without_subtracting(self) -> None:
        self.check_case("no-reference")

    def test_historical_version_one_reports_still_validate(self) -> None:
        files = rows([KEEP], "a" * 40)
        report = {"version": 1, "status": "PASS", "policy": POLICY, "baseline": None,
                  "counts": {"bun": 0, "shell": 1, "python": 0}, "wall_ms": 1, "shortfalls": []}
        self.assertEqual(store.validate_minimum_report(report, files, 1, "main", RUNTIME), [])

    def test_malformed_or_duplicate_ledger_refuses(self) -> None:
        entry = {"path": RETIRED, "kind": "shell", "bead": "ompkit-1ra0d.45", "commit": "a" * 40}
        for value in ({"version": 1, "entries": [entry, entry]},
                      {"version": 1, "entries": [{**entry, "kind": "python"}]},
                      {"version": 1, "entries": [{**entry, "commit": "abc"}]},
                      {"version": 1, "entries": [{**entry, "path": "tests/../retired.test.sh"}]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                store.retirement_entries(value)

    def test_each_guard_mutant_is_killed(self) -> None:
        cases = (("minimum_shortfalls", "count", "listed"),
                 ("minimum_shortfalls", "shortfall", "unlisted"),
                 ("assess_retirements", "STILL_PRESENT", "present"),
                 ("assess_retirements", "NOT_DELETED", "wrong-delete"),
                 ("assess_retirements", "ancestor", "ancestor"),
                 ("assess_retirements", "reference", "reference"))
        for function, guard, case in cases:
            with self.subTest(guard=guard, case=case):
                replacement = mutant(getattr(store, function), guard)
                with patch.object(store, function, replacement), self.assertRaises(AssertionError):
                    self.check_case(case)


if __name__ == "__main__":
    unittest.main(verbosity=2)
