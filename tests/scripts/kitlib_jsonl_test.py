#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_jsonl.py (ompkit-ibgvg, KL11).

Every case comes from tests/fixtures/kitlib-jsonl/corpus.json, the same corpus
tests/cli/kitlib-jsonl.test.ts runs against src/kitlib/jsonl.ts, so the two
languages cannot drift. Concurrent writers are real processes in both languages
appending to one file under the shared KL08 lock.
"""
from __future__ import annotations

import errno
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = ROOT / "tests" / "fixtures" / "kitlib-jsonl" / "corpus.json"
MODULE_TS = str(ROOT / "src" / "kitlib" / "jsonl.ts")
SCRIPTS_DIR = str(ROOT / "scripts")
CHILD_DEADLINE_S = 300.0


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pysafe = _load("pysafe", ROOT / "scripts" / "pysafe.py")
kitlib_lock = _load("kitlib_lock", ROOT / "scripts" / "kitlib_lock.py")
kitlib_jsonl = _load("kitlib_jsonl", ROOT / "scripts" / "kitlib_jsonl.py")
owned_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py").owned_tmp
CORPUS = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
BUN = shutil.which("bun")
_TOKEN = re.compile(r"\{[A-Z_]+\}")


def substitute(value, variables: dict):
    if isinstance(value, str):
        return _TOKEN.sub(lambda match: variables.get(match.group(0)[1:-1], match.group(0)), value)
    if isinstance(value, list):
        return [substitute(item, variables) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, variables) for key, item in value.items()}
    return value


def reset_seam() -> None:
    kitlib_jsonl._TESTING.update({"disabled": set(), "write": None, "fsync": None, "before_write": None})
    kitlib_lock._TESTING["disabled"] = set()


def _planted_fsync_failure(fd: int) -> None:
    raise OSError(errno.EIO, "planted fsync failure")


def _replace_target(target: str) -> None:
    os.rename(target, target + ".old")
    with open(target, "w", encoding="utf-8"):
        pass


class CaseRun:
    def __init__(self, case: dict, variables: dict, bypassed: bool, test: unittest.TestCase) -> None:
        self.case, self.vars, self.bypassed, self.t = case, variables, bypassed, test
        self.cursors: dict = {}
        self.held = None
        self.fsyncs = 0

    def child_vars(self) -> dict:
        return {**self.vars, "BUN": BUN, "PYTHON": sys.executable, "MODULE_TS": MODULE_TS, "SCRIPTS_DIR": SCRIPTS_DIR}

    def build(self, step: dict):
        mode = step["build"]
        if mode == "record":
            return lambda state: step["record"]
        if mode == "throw":
            def refuse(state):
                raise ValueError("domain validation refused")
            return refuse
        if mode == "state":
            return lambda state: {"size": state["size"], "created": state["created"], "torn": state["torn"]}
        if mode == "probe-lock":
            def probe(state):
                locked = False
                try:
                    kitlib_lock.private_lock({"namespace": "kitlib-jsonl", "path": self.vars["FILE"]}, deadline_s=0,
                                             state_dir=self.vars["STATE"]).release()
                except kitlib_lock.PrivateLockError as error:
                    locked = error.code == "DEADLINE"
                return {"locked": locked, "size": state["size"], "torn": state["torn"]}
            return probe
        raise AssertionError(f"unknown build {mode}")

    def append(self, step: dict, raw: dict, where: str) -> None:
        want = step["expect_bypassed"] if self.bypassed and "expect_bypassed" in raw else step["expect"]
        options = step["options"]
        kwargs = {"deadline_s": options["deadline_s"], "state_dir": self.vars["STATE"]}
        if "torn_tail" in options:
            kwargs["torn_tail"] = options["torn_tail"]
        if "durable" in options:
            kwargs["durable"] = options["durable"]
        try:
            outcome = kitlib_jsonl.append_jsonl(step.get("path", self.vars["FILE"]), self.build(step), **kwargs)
        except (kitlib_jsonl.JsonlError, kitlib_lock.PrivateLockError) as error:
            outcome = error
        if want.get("ok"):
            if isinstance(outcome, Exception):
                raise AssertionError(f"{where}: expected ok, got {outcome!r} {getattr(outcome, 'evidence', {})}")
            for key, value in want.get("result", {}).items():
                self.t.assertEqual(outcome[key], value, f"{where}: result {key} in {outcome}")
            return
        if not isinstance(outcome, Exception):
            raise AssertionError(f"{where}: expected refusal {want}, got {outcome}")
        self.t.assertEqual(outcome.code, want["code"], f"{where}: {outcome.evidence}")
        self.t.assertEqual(outcome.evidence["code"], outcome.code, where)
        for key, value in want.get("evidence", {}).items():
            self.t.assertEqual(outcome.evidence.get(key), value, f"{where}: evidence {key} in {outcome.evidence}")

    def read(self, step: dict, where: str) -> None:
        options = step.get("options", {})
        kwargs = {}
        if "max_bytes" in options:
            kwargs["max_bytes"] = options["max_bytes"]
        if "cursor" in options:
            kwargs["from_cursor"] = self.cursors[options["cursor"]]
        result = kitlib_jsonl.read_jsonl(self.vars["FILE"], **kwargs)
        if "save" in step:
            self.cursors[step["save"]] = result["cursor"]
        for key, value in step["expect"].items():
            if key == "errors":
                got = [{k: error.get(k) for k in (value[index] if index < len(value) else {"line": 0, "reason": 0})}
                       for index, error in enumerate(result["errors"])]
                self.t.assertEqual(got, value, f"{where}: errors {result['errors']}")
            elif key == "cursor":
                for ckey, cvalue in value.items():
                    self.t.assertEqual(result["cursor"][ckey], cvalue, f"{where}: cursor {result['cursor']}")
            else:
                self.t.assertEqual(result[key], value, f"{where}: {key}")

    def step(self, raw: dict) -> None:
        if raw.get("when") == "normal" and self.bypassed or raw.get("when") == "bypassed" and not self.bypassed:
            return
        step = substitute(raw, self.vars)
        where = f"{self.case['id']} step {json.dumps(raw)}"
        op, path = step["op"], step.get("path")
        if op == "write":
            data = bytes.fromhex(step["hex"]) if "hex" in step else step["text"].encode("utf-8")
            with open(path, "wb") as handle:
                handle.write(data)
        elif op == "append-raw":
            with open(path, "ab") as handle:
                handle.write(step["text"].encode("utf-8"))
        elif op == "rename":
            os.rename(path, step["target"])
        elif op == "symlink":
            os.symlink(step["target"], path)
        elif op == "hook":
            if step.get("write") == "max3":
                kitlib_jsonl._TESTING["write"] = lambda fd, data: os.write(fd, data[:3])
            if step.get("write") == "zero":
                kitlib_jsonl._TESTING["write"] = lambda fd, data: 0
            if step.get("fsync") == "fail":
                kitlib_jsonl._TESTING["fsync"] = _planted_fsync_failure
            if step.get("fsync") == "count":
                def counted(fd: int) -> None:
                    self.fsyncs += 1
                    os.fsync(fd)
                kitlib_jsonl._TESTING["fsync"] = counted
            if step.get("before_write") == "replace-target":
                kitlib_jsonl._TESTING["before_write"] = _replace_target
        elif op == "hold-lock":
            self.held = kitlib_lock.private_lock({"namespace": "kitlib-jsonl", "path": self.vars["FILE"]}, deadline_s=5,
                                                 state_dir=self.vars["STATE"])
        elif op == "release-lock":
            if self.held is not None:
                self.held.release()
                self.held = None
        elif op == "append":
            self.append(step, raw, where)
        elif op == "read":
            self.read(step, where)
        elif op == "expect-file":
            if step.get("absent"):
                self.t.assertFalse(os.path.lexists(path), where)
                return
            if "text" in step:
                self.t.assertEqual(Path(path).read_text(encoding="utf-8"), step["text"], where)
            if "mode" in step:
                self.t.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), int(step["mode"], 8), where)
        elif op == "expect-fsyncs":
            self.t.assertEqual(self.fsyncs, step["count"], where)
        elif op == "reader-child":
            # Reopen in a fresh process of the other language.
            result = pysafe.run_bounded(substitute(CORPUS["readers"]["ts"], self.child_vars()), 60)
            self.t.assertEqual(result.returncode, 0, result.text("stderr"))
            self.t.assertEqual(json.loads(result.text()), step["expect_rows"], where)
        elif op == "writers":
            self.writers(step, where)
        else:
            raise AssertionError(f"unknown corpus op {op}")

    def writers(self, step: dict, where: str) -> None:
        count, pad = step["count"], step["pad"]
        procs = []
        for writer in step["writers"]:
            argv = substitute(CORPUS["writers"][writer["lang"]],
                              {**self.child_vars(), "ID": writer["id"], "COUNT": str(count), "PAD": str(pad)})
            procs.append(subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE))
        try:
            for proc in procs:
                _, stderr = proc.communicate(timeout=CHILD_DEADLINE_S)
                self.t.assertEqual(proc.returncode, 0, f"{where}: {stderr.decode('utf-8', 'replace')}")
        finally:
            for proc in procs:
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate(timeout=30)
        result = kitlib_jsonl.read_jsonl(self.vars["FILE"], max_bytes=64 * 1024 * 1024)
        self.t.assertEqual(result["errors"], [], where)
        self.t.assertEqual((len(result["rows"]), result["pending_tail_bytes"], result["more"]),
                           (len(step["writers"]) * count, 0, False), where)
        for writer in step["writers"]:
            mine = [row for row in result["rows"] if row["w"] == writer["id"]]
            self.t.assertEqual([row["i"] for row in mine], list(range(count)), f"{where}: {writer['id']} order")
            self.t.assertTrue(all(len(row["pad"]) == pad for row in mine), where)

    def cleanup(self) -> None:
        if self.held is not None:
            self.held.release()


class Corpus(unittest.TestCase):
    def test_corpus_shape_and_bun_present(self) -> None:
        self.assertEqual(CORPUS.get("schema"), "kitlib-jsonl-corpus.v1")
        self.assertTrue(CORPUS.get("cases"))
        self.assertIsNotNone(BUN, "bun is required for the TypeScript writers")

    def _run_case(self, case: dict, disabled: list) -> None:
        with owned_tmp("kitlib-jsonl") as scratch:
            tmp = os.path.realpath(scratch)
            variables = {"TMP": tmp, "STATE": os.path.join(tmp, "state"), "FILE": os.path.join(tmp, "ledger.jsonl")}
            run = CaseRun(case, variables, case.get("detector") in disabled, self)
            reset_seam()
            kitlib_jsonl._TESTING["disabled"] = set(disabled)
            kitlib_lock._TESTING["disabled"] = {CORPUS["lock_detectors"][name] for name in disabled
                                                if name in CORPUS["lock_detectors"]}
            try:
                for step in case["steps"]:
                    run.step(step)
            finally:
                reset_seam()
                run.cleanup()


def _install_cases() -> None:
    if CORPUS.get("schema") != "kitlib-jsonl-corpus.v1" or not CORPUS.get("cases"):
        raise AssertionError("tests/fixtures/kitlib-jsonl/corpus.json is not a kitlib-jsonl-corpus.v1 corpus")
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
