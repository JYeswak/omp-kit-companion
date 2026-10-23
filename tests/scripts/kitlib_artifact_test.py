#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_artifact.py (ompkit-gvp4j, KL10).

Every case comes from tests/fixtures/kitlib-artifact/corpus.json, the same corpus
tests/cli/kitlib-artifact.test.ts runs against src/kitlib/artifact.ts, so the two
languages cannot drift. Each planted negative runs with its detector on and
bypassed through the test seam (its result flips); each control also runs with
every detector bypassed and still passes.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = ROOT / "tests" / "fixtures" / "kitlib-artifact" / "corpus.json"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kitlib_artifact = _load("kitlib_artifact", ROOT / "scripts" / "kitlib_artifact.py")
owned_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py").owned_tmp
CORPUS = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
_TOKEN = re.compile(r"\{[A-Z_]+\}")


def substitute(value, variables: dict):
    if isinstance(value, str):
        return _TOKEN.sub(lambda match: variables.get(match.group(0)[1:-1], match.group(0)), value)
    if isinstance(value, list):
        return [substitute(item, variables) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, variables) for key, item in value.items()}
    return value


def owner_validator(spec):
    """The owner's validator, built from the corpus: unknown fields through the helper, then required fields."""
    if spec is None:
        return None

    def validate(row):
        found = kitlib_artifact.reject_unknown_fields(row, spec["allowed"]) if "allowed" in spec else []
        return found + [f"missing field {json.dumps(key)}" for key in spec.get("required", [])
                        if not isinstance(row, dict) or key not in row]
    return validate


def input_bytes(step: dict, artifact) -> bytes:
    if step.get("source") == "artifact":
        return artifact["bytes"]
    return bytes.fromhex(step["hex"]) if "hex" in step else step["text"].encode("utf-8")


def subset(got: dict, want: dict) -> dict:
    return {key: got.get(key) for key in want}


class Corpus(unittest.TestCase):
    def test_corpus_shape(self) -> None:
        self.assertEqual(CORPUS["schema"], "kitlib-artifact-corpus.v1")
        self.assertTrue(any(case.get("control") for case in CORPUS["cases"]))
        self.assertEqual({case["detector"] for case in CORPUS["cases"] if "detector" in case}, set(CORPUS["detectors"]))

    def _run_case(self, case: dict, disabled: list) -> None:
        with owned_tmp("kitlib-artifact") as scratch:
            tmp = os.path.realpath(scratch)
            variables = {"TMP": tmp, "ROOT": os.path.join(tmp, "root"), "OUT": os.path.join(tmp, "outside")}
            os.mkdir(variables["ROOT"])
            os.mkdir(variables["OUT"])
            bypassed = case.get("detector") in disabled
            kitlib_artifact._TESTING["disabled"] = set(disabled)
            artifact = None
            try:
                for raw in case["steps"]:
                    step = substitute(raw, variables)
                    where = f"{case['id']} step {json.dumps(raw)}"
                    want = step["expect_bypassed"] if bypassed and "expect_bypassed" in step else step.get("expect", {})
                    options = step.get("options", {})
                    artifact = self._step(step, want, options, where, variables, artifact)
            finally:
                kitlib_artifact._TESTING["disabled"] = set()

    def _step(self, step, want, options, where, variables, artifact):
        op = step["op"]
        if op == "write":
            Path(step["path"]).write_text(step["text"], encoding="utf-8")
        elif op == "mkdir":
            os.mkdir(step["path"])
        elif op == "symlink":
            os.symlink(step["target"], step["path"])
        elif op == "hardlink":
            os.link(step["target"], step["path"])
        elif op == "read":
            try:
                outcome = kitlib_artifact.read_local_artifact(
                    step["path"], allowed_root=variables["ROOT"], max_bytes=options["max_bytes"],
                    file_policy={key: options[key] for key in ("symlinks", "hardlinks") if key in options},
                    distinct_from=options.get("distinct_from", ()))
            except kitlib_artifact.ArtifactError as error:
                self.assertFalse(want.get("ok"), f"{where}: expected ok, got {error} {error.evidence}")
                self.assertEqual(error.code, want["code"], f"{where}: {error.evidence}")
                self.assertEqual(error.evidence["code"], error.code, where)
                if "evidence" in want:
                    self.assertEqual(subset(error.evidence, want["evidence"]), want["evidence"], where)
                return artifact
            self.assertTrue(want.get("ok"), f"{where}: expected {want.get('code')}, got ok")
            got = {"path": outcome["path"], "realpath": outcome["realpath"], "size": outcome["size"],
                   "sha256": outcome["sha256"], "text": outcome["bytes"].decode("utf-8")}
            result = want.get("result", {})
            self.assertEqual(subset(got, result), result, where)
            self.assertEqual(len(outcome["bytes"]), outcome["size"], where)
            if step.get("provenance"):
                seen = os.stat(outcome["realpath"])
                self.assertEqual((outcome["dev"], outcome["ino"]), (seen.st_dev, seen.st_ino), where)
                self.assertEqual(outcome["bytes"], Path(outcome["realpath"]).read_bytes(), where)
            return outcome
        elif op == "json":
            path = step.get("path", "<inline>")
            try:
                value = kitlib_artifact.strict_json(input_bytes(step, artifact), path=path,
                                                    max_depth=options.get("max_depth", kitlib_artifact.DEFAULT_MAX_DEPTH))
            except kitlib_artifact.ArtifactError as error:
                self.assertFalse(want.get("ok"), f"{where}: expected ok, got {error} {error.evidence}")
                self.assertEqual(error.code, want["code"], f"{where}: {error.evidence}")
                expected = {"path": path, **want.get("evidence", {})}
                self.assertEqual(subset(error.evidence, expected), expected, where)
                return artifact
            self.assertTrue(want.get("ok"), f"{where}: expected {want.get('code')}, got {value!r}")
            if "value" in want:
                self.assertEqual(value, want["value"], where)
        elif op == "jsonl":
            result = kitlib_artifact.strict_jsonl(
                input_bytes(step, artifact), path=step.get("path", "<inline>"), max_rows=options.get("max_rows"),
                max_row_bytes=options.get("max_row_bytes"), validate=owner_validator(options.get("validator")))
            if "rows" in want:
                self.assertEqual(result["rows"], want["rows"], where)
            if "row_count" in want:
                self.assertEqual(len(result["rows"]), want["row_count"], where)
            expected = want["errors"]
            got = [subset(error, expected[index] if index < len(expected) else {"line": 0, "reason": 0})
                   for index, error in enumerate(result["errors"])]
            self.assertEqual(got, expected, f"{where}: errors {result['errors']}")
        else:
            raise AssertionError(f"unknown corpus op {op}")
        return artifact


def _install_cases() -> None:
    if CORPUS.get("schema") != "kitlib-artifact-corpus.v1" or not CORPUS.get("cases"):
        raise AssertionError("tests/fixtures/kitlib-artifact/corpus.json is not a kitlib-artifact-corpus.v1 corpus")
    for index, case in enumerate(CORPUS["cases"]):
        name = f"test_{index:02d}_{case['id'].replace('-', '_')}"
        setattr(Corpus, name, lambda self, case=case: self._run_case(case, []))
        if "detector" in case:
            setattr(Corpus, f"{name}__bypassed_{case['detector'].replace('-', '_')}_flips",
                    lambda self, case=case: self._run_case(case, [case["detector"]]))
        if case.get("control"):
            setattr(Corpus, f"{name}__all_bypassed_control_passes",
                    lambda self, case=case: self._run_case(case, list(CORPUS["detectors"])))


_install_cases()


if __name__ == "__main__":
    unittest.main()
