#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_artifact.py (ompkit-gvp4j, KL10).

Every case comes from tests/fixtures/kitlib-artifact/corpus.json, the same corpus
tests/cli/kitlib-artifact.test.ts runs against src/kitlib/artifact.ts, so the two
languages cannot drift. Each planted negative runs with its detector on and
bypassed through the test seam (its result flips); each control also runs with
every detector bypassed and still passes.

DepthAndReceipt is Python-only: the nesting bound must hold without the Python stack
(RecursionError), and scripts/receipt.py, its consumer, must refuse typed at sign and verify.
"""
from __future__ import annotations

import contextlib
import importlib.util
import inspect
import io
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

receipt = _load("receipt", ROOT / "scripts" / "receipt.py")


def nested(depth: int, kind: str = "[") -> str:
    if kind == "[":
        return "[" * depth + "]" * depth
    return '{"k":' * (depth - 1) + "{}" + "}" * (depth - 1)


def run_receipt(argv: list) -> dict:
    """Run receipt.py's CLI entry in-process; an escaping exception is what a user would see as a traceback."""
    out, err = io.StringIO(), io.StringIO()
    saved = sys.argv
    sys.argv = ["receipt.py"] + argv
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code, escaped = receipt.main(), None
    except SystemExit as exit_:
        code, escaped = exit_.code, None
    except BaseException as error:  # noqa: BLE001 - any escape is the defect under test
        code, escaped = None, f"{type(error).__name__}: {error}"
    finally:
        sys.argv = saved
    return {"code": code, "stdout": out.getvalue(), "stderr": err.getvalue(), "escaped": escaped}


def sign_argv(result_ref_json: str, out: Path) -> list:
    return ["sign", "--producer", "t", "--operation", "op", "--result-ref-json", result_ref_json, "--out", str(out)]


class DepthAndReceipt(unittest.TestCase):
    def depth_error(self, text: str, max_depth: int = kitlib_artifact.DEFAULT_MAX_DEPTH) -> dict:
        try:
            kitlib_artifact.strict_json(text.encode("utf-8"), path="<depth>", max_depth=max_depth)
        except kitlib_artifact.ArtifactError as error:
            return error.evidence
        self.fail("expected an ArtifactError")

    def test_depth_511_and_512_parse(self) -> None:
        for depth in (511, 512):
            for kind in "[{":
                text = nested(depth, kind)
                self.assertEqual(kitlib_artifact.strict_json(text.encode(), path="<depth>"), json.loads(text),
                                 f"{kind} depth {depth}")

    def test_depth_513_refused_typed(self) -> None:
        for kind, width in (("[", 1), ("{", 5)):
            evidence = self.depth_error(nested(513, kind))
            self.assertEqual((evidence["code"], evidence["reason"], evidence["offset"]), ("CORRUPT", "DEPTH", 512 * width),
                             kind)

    def test_depth_bound_is_exact_for_any_max_depth(self) -> None:
        for max_depth in (1, 2, 40, 2000):
            kitlib_artifact.strict_json(nested(max_depth).encode(), path="<depth>", max_depth=max_depth)
            self.assertEqual(self.depth_error(nested(max_depth + 1), max_depth)["reason"], "DEPTH", max_depth)

    def test_depth_2000_refused_typed_even_from_a_deep_caller(self) -> None:
        self.assertEqual(self.depth_error(nested(2000))["reason"], "DEPTH")
        # The guard must not depend on the caller's free stack: parse from within ~100 frames of the recursion limit.

        def at_depth(frames: int):
            return at_depth(frames - 1) if frames > 0 else self.depth_error(nested(2000))

        self.assertEqual(at_depth(sys.getrecursionlimit() - 100 - len(inspect.stack()))["reason"], "DEPTH")

    def test_receipt_verify_2000_deep_refuses_typed(self) -> None:
        with owned_tmp("kitlib-artifact-depth") as tmp:
            path = Path(tmp) / "deep.receipt.json"
            path.write_text('{"evidence_id": "ev_x", "result_ref": ' + nested(2000) + "}\n", encoding="utf-8")
            got = run_receipt(["verify", str(path)])
        self.assertIsNone(got["escaped"], got["escaped"])
        self.assertEqual(got["code"], 1)
        self.assertIn("verify REFUSE: unreadable receipt", got["stderr"])
        self.assertIn("(DEPTH)", got["stderr"])
        self.assertNotIn("Traceback", got["stderr"])

    def test_receipt_deepest_signable_receipt_verifies(self) -> None:
        # Control: result_ref 511 deep makes a 512-deep receipt, the deepest verify reads; it signs and verifies.
        with owned_tmp("kitlib-artifact-depth") as tmp:
            out = Path(tmp) / "deep.receipt.json"
            signed = run_receipt(sign_argv(nested(511), out))
            verified = run_receipt(["verify", str(out)])
        self.assertEqual((signed["escaped"], signed["code"]), (None, 0), signed)
        self.assertEqual((verified["escaped"], verified["code"]), (None, 0), verified["escaped"] or verified["stderr"])
        self.assertTrue(verified["stdout"].startswith("verify OK ev_"), verified)

    def test_receipt_sign_refuses_what_verify_would_refuse_on_depth(self) -> None:
        for depth in (512, 2000):  # 512 makes a 513-deep receipt; 2000 broke json.loads itself
            with owned_tmp("kitlib-artifact-depth") as tmp:
                out = Path(tmp) / "deep.receipt.json"
                got = run_receipt(sign_argv(nested(depth), out))
                written = out.exists()
            self.assertIsNone(got["escaped"], f"{depth}: {got['escaped']}")
            self.assertEqual(got["code"], 2, depth)
            self.assertIn("sign refused:", got["stderr"], depth)
            self.assertIn("(DEPTH)", got["stderr"], depth)
            self.assertFalse(written, f"{depth}: sign wrote a receipt verify refuses")

    def test_receipt_sign_refuses_oversized_before_writing(self) -> None:
        big = json.dumps({"sha256": "a" * 64, "bytes": 1, "pad": "x" * 1_100_000})
        with owned_tmp("kitlib-artifact-size") as tmp:
            out = Path(tmp) / "big.receipt.json"
            got = run_receipt(sign_argv(big, out))
            written = out.exists()
        self.assertIsNone(got["escaped"], got["escaped"])
        self.assertEqual(got["code"], 2, got["stderr"])
        self.assertIn(f"verify reads at most {receipt.MAX_RECEIPT_BYTES}", got["stderr"])
        self.assertFalse(written, "sign wrote a receipt verify refuses as TOO_LARGE")

    def test_receipt_small_sign_then_verify_ok(self) -> None:
        with owned_tmp("kitlib-artifact-size") as tmp:
            out = Path(tmp) / "small.receipt.json"
            signed = run_receipt(sign_argv(json.dumps({"sha256": "a" * 64, "bytes": 1}), out))
            verified = run_receipt(["verify", str(out)])
        self.assertEqual((signed["escaped"], signed["code"]), (None, 0), signed)
        self.assertEqual((verified["escaped"], verified["code"]), (None, 0), verified)
        self.assertTrue(verified["stdout"].startswith("verify OK ev_"), verified)

    def test_receipt_sign_refuses_duplicate_key_and_nan(self) -> None:
        for bad in ('{"sha256": "' + "a" * 64 + '", "bytes": 1, "bytes": 2}', '{"sha256": "' + "a" * 64 + '", "bytes": NaN}'):
            with owned_tmp("kitlib-artifact-strict") as tmp:
                out = Path(tmp) / "bad.receipt.json"
                got = run_receipt(sign_argv(bad, out))
                written = out.exists()
            self.assertEqual((got["escaped"], got["code"], written), (None, 2, False), got)
            self.assertIn("is not strict JSON", got["stderr"])



if __name__ == "__main__":
    unittest.main()
