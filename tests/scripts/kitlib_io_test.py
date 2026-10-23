#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_io.py (ompkit-67i70, KL06).

Every case comes from tests/fixtures/kitlib-io/corpus.json, the same corpus
tests/cli/kitlib-io.test.ts runs against src/kitlib/io.ts, so the two languages
cannot drift. Faults go through the atomic_replace_bytes_with seam; each case
runs in its own dir inside one kitlib owned temp dir, removed at the end.
"""
from __future__ import annotations

import atexit
import errno
import importlib.util
import json
import os
import re
import signal
import sys
import threading
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "tests" / "fixtures" / "kitlib-io" / "corpus.json"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kitlib_io = _load("kitlib_io", ROOT / "scripts" / "kitlib_io.py")
kitlib_run = _load("kitlib_run", ROOT / "scripts" / "kitlib_run.py")
kitlib_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py")

CORPUS_DOC = json.loads(CORPUS.read_text(encoding="utf-8"))
if CORPUS_DOC.get("schema") != "kitlib-io-corpus.v1" or not CORPUS_DOC.get("cases"):
    raise SystemExit("tests/fixtures/kitlib-io/corpus.json is not a kitlib-io-corpus.v1 corpus")
BY_ID = {case["id"]: case for case in CORPUS_DOC["cases"]}

OWNED = kitlib_tmp.owned_tmp("kitlib-io-test", bead="ompkit-67i70")
OWNED_ROOT = os.path.realpath(OWNED.path)
_serial = [0]


def case_dir(case: dict) -> str:
    path = os.path.join(OWNED_ROOT, f"{_serial[0]:03d}-{case['id']}")
    _serial[0] += 1
    os.mkdir(path, 0o700)
    for entry in case["setup"]:
        if "file" in entry:
            fd = os.open(os.path.join(path, entry["file"]), os.O_CREAT | os.O_EXCL | os.O_WRONLY, entry.get("mode", 0o600))
            try:
                os.write(fd, entry.get("text", "").encode())
                os.fchmod(fd, entry.get("mode", 0o600))
            finally:
                os.close(fd)
        elif "dir" in entry:
            os.mkdir(os.path.join(path, entry["dir"]), 0o700)
        elif "symlink" in entry:
            os.symlink(os.path.join(path, entry["to"]), os.path.join(path, entry["symlink"]))
    return path


def injected(name: str) -> OSError:
    number = getattr(errno, name)
    return OSError(number, f"{name}: injected by the kitlib-io test seam")


def global_state() -> tuple:
    mask = os.umask(0o022)
    os.umask(mask)
    handlers = tuple(signal.getsignal(sig) for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM))
    return (mask, handlers, atexit._ncallbacks())


def call_kwargs(directory: str, case: dict) -> dict:
    call = case["call"]
    kwargs = {"mode": call["mode"], "durability": call["durability"]}
    if "stage_dir" in call:
        kwargs["stage_dir"] = os.path.join(directory, call["stage_dir"])
    if "public_root" in call:
        kwargs["public_root"] = os.path.join(directory, call["public_root"])
    return kwargs


class FaultOps(kitlib_io.IoOps):
    def __init__(self, directory: str, case: dict):
        self.fault = case.get("fault", {})
        self.directory = directory
        self.stage = os.path.join(directory, case["call"]["stage_dir"]) if "stage_dir" in case["call"] else None
        self.writes = 0

    def temp_name(self, base: str) -> str:
        return self.fault.get("temp_name") or super().temp_name(base)

    def open(self, path, flags, mode):
        fd = os.open(path, flags, mode)
        if "hardlink_temp" in self.fault:
            os.link(path, os.path.join(self.directory, self.fault["hardlink_temp"]))
        return fd

    def write(self, fd, data):
        fault = self.fault
        first = self.writes == 0
        self.writes += 1
        if "write_fail" in fault:
            if first:
                return os.write(fd, data[:fault["write_fail"]["after"]])
            raise injected(fault["write_fail"]["errno"])
        if "write_stall" in fault:
            return os.write(fd, data[:fault["write_stall"]["after"]]) if first else 0
        if fault.get("write_lie"):
            os.write(fd, data[:(len(data) + 1) // 2])
            return len(data)
        return os.write(fd, data)

    def fsync(self, fd):
        if "fsync_errno" in self.fault:
            raise injected(self.fault["fsync_errno"])
        os.fsync(fd)

    def rename(self, source, target):
        if "rename_errno" in self.fault:
            raise injected(self.fault["rename_errno"])
        os.replace(source, target)

    def fsync_directory(self, path):
        if "dir_fsync_errno" in self.fault:
            raise injected(self.fault["dir_fsync_errno"])
        kitlib_io.fsync_directory(path)

    def stat(self, path):
        info = os.stat(path)
        if self.fault.get("stage_other_device") and path == self.stage:
            return types.SimpleNamespace(st_dev=info.st_dev + 1, st_mode=info.st_mode)
        return info


def plain_call(directory: str, case: dict, bypass: frozenset) -> dict:
    call, fault = case["call"], case.get("fault", {})
    path = call.get("path_literal") or os.path.join(directory, call["path"])
    data = bytes.fromhex(call["hex"]) if "hex" in call else call.get("text", "").encode()
    cancel = threading.Event()
    at = fault.get("at")

    def on_boundary(boundary: str, temp: str) -> None:
        if not at or at["boundary"] != boundary:
            return
        if at["do"] == "cancel":
            cancel.set()
        else:
            os.unlink(temp)
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(fd, b"attacker")
            finally:
                os.close(fd)

    stage = os.path.join(directory, call["stage_dir"]) if "stage_dir" in call else os.path.dirname(path)
    validate = None
    if call.get("validate") == "refuse":
        def validate(temp: str) -> None:
            raise ValueError("the staged bytes are invalid")
    elif call.get("validate") == "accept-exact":
        def validate(temp: str) -> None:
            with open(temp, "rb") as handle:
                if handle.read(len(data) + 1) != data:
                    raise ValueError("validate saw incomplete bytes")
            if os.stat(temp).st_mode & 0o7777 != call["mode"]:
                raise ValueError("validate saw the wrong mode")
            if os.path.dirname(temp) != stage:
                raise ValueError("validate saw a temp outside the stage")
    prior = os.umask(call["umask"]) if "umask" in call else None
    try:
        result = kitlib_io.atomic_replace_bytes_with(FaultOps(directory, case), bypass, path, data, **call_kwargs(directory, case),
                                                     validate=validate, cancel=cancel, on_boundary=on_boundary)
        return {"result": result, "error": None}
    except Exception as error:  # judged below: anything but AtomicReplaceError is a failure
        return {"result": None, "error": error}
    finally:
        if prior is not None:
            os.umask(prior)


def concurrent_readers(directory: str, case: dict) -> dict:
    target, size = os.path.join(directory, case["call"]["path"]), case["size"]
    a, b = b"a" * size, b"b" * size
    kwargs = call_kwargs(directory, case)
    kitlib_io.atomic_replace_bytes(target, a, **kwargs)
    argv = [arg.replace("{DIR}", directory) for arg in case["reader_argv"]]
    box: dict = {}
    reader = threading.Thread(target=lambda: box.update(done=kitlib_run.run(argv, deadline_s=60)), daemon=True)
    reader.start()
    deadline = time.monotonic() + 30
    while not os.path.exists(os.path.join(directory, "ready")) and time.monotonic() < deadline:
        time.sleep(0.01)
    state_before = global_state()
    for n in range(case["writes"]):
        kitlib_io.atomic_replace_bytes(target, b if n % 2 == 0 else a, **kwargs)
    state_after = global_state()
    with open(os.path.join(directory, "stop"), "wb"):
        pass
    reader.join(timeout=90)
    done = box.get("done")
    match = re.search(rb"^reads=(\d+) torn=(\d+)$", done.stdout if done else b"", re.M)
    if not match:
        return {"result": None, "error": RuntimeError(f"reader failed: {done!r}"), "state": (state_before, state_after)}
    return {"result": None, "error": None, "reads": int(match.group(1)), "reader_torn": int(match.group(2)),
            "state": (state_before, state_after)}


def rmw_race(directory: str, case: dict) -> dict:
    counter = os.path.join(directory, case["call"]["path"])
    kwargs = call_kwargs(directory, case)
    interleaved = []

    def increment(on_boundary=None) -> None:
        with open(counter, "rb") as handle:
            value = int(handle.read(64)) + 1
        kitlib_io.atomic_replace_bytes(counter, str(value).encode(), **kwargs, on_boundary=on_boundary)

    def interleave(boundary: str, temp: str) -> None:
        if boundary == "temp-created" and not interleaved:
            interleaved.append(True)
            increment()

    increment(interleave)
    with open(counter, "rb") as handle:
        return {"result": None, "error": None, "final_counter": int(handle.read(64))}


def _read(path: str):
    try:
        with open(path, "rb") as handle:
            return handle.read(1 << 20)
    except OSError:
        return None


def judge(directory: str, case: dict, outcome: dict) -> list:
    want, failures = case["expect"], []
    result, raw = outcome["result"], outcome["error"]
    error = raw if isinstance(raw, kitlib_io.AtomicReplaceError) else None
    if raw is not None and error is None:
        failures.append(f"raised a non-AtomicReplaceError: {raw!r}")
    if "ok" in want and (result is not None) != want["ok"]:
        failures.append(f"ok: got {result is not None} ({raw})")
    if "code" in want and getattr(error, "code", None) != want["code"]:
        failures.append(f"code: got {getattr(error, 'code', None)}")
    published = result.published if result is not None else getattr(error, "published", None)
    if "published" in want and published != want["published"]:
        failures.append(f"published: got {published}")
    for key in ("file_synced", "directory_synced", "durable", "cancelled_after_publish"):
        if key in want and getattr(result, key, None) != want[key]:
            failures.append(f"{key}: got {getattr(result, key, None)}")
    if "errno" in want and getattr(error, "errno_name", None) != want["errno"]:
        failures.append(f"errno: got {getattr(error, 'errno_name', None)}")
    if "temp_left" in want and (getattr(error, "temp_left", None) is not None) != want["temp_left"]:
        failures.append(f"temp_left: got {getattr(error, 'temp_left', None)}")
    for name, text in want.get("files", {}).items():
        got = _read(os.path.join(directory, name))
        if got != text.encode():
            failures.append(f"file {name}: got {got!r}")
    for name, hexed in want.get("files_hex", {}).items():
        got = _read(os.path.join(directory, name))
        if got is None or got.hex() != hexed:
            failures.append(f"file {name}: got {got!r}")
    for name, to in want.get("symlinks", {}).items():
        try:
            got = os.readlink(os.path.join(directory, name))
        except OSError:
            got = None
        if got != os.path.join(directory, to):
            failures.append(f"symlink {name}: got {got}")
    for name, mode in want.get("modes", {}).items():
        got = os.lstat(os.path.join(directory, name)).st_mode & 0o7777
        if got != mode:
            failures.append(f"mode {name}: got {oct(got)}")
    for sub, names in want.get("entries", {}).items():
        got = sorted(os.listdir(os.path.join(directory, sub)))
        if got != names:
            failures.append(f"entries {sub}: got {got}")
    if "reader_torn" in want:
        if outcome.get("reader_torn") != want["reader_torn"]:
            failures.append(f"reader_torn: got {outcome.get('reader_torn')} ({raw})")
        if not outcome.get("reads", 0) > 0:
            failures.append("reader made no reads")
    if "final_counter" in want and outcome.get("final_counter") != want["final_counter"]:
        failures.append(f"final_counter: got {outcome.get('final_counter')}")
    return failures


def run_case(case: dict, bypass: frozenset = frozenset()) -> list:
    directory = case_dir(case)
    before = global_state()
    kind = case.get("kind")
    if kind == "concurrent-readers":
        outcome = concurrent_readers(directory, case)
    elif kind == "rmw-race":
        outcome = rmw_race(directory, case)
    else:
        outcome = plain_call(directory, case, bypass)
    failures = judge(directory, case, outcome)
    start, end = outcome.get("state", (before, global_state()))
    if start != end:
        failures.append(f"process umask or exit/signal handlers changed: {start} -> {end}")
    return failures


class Corpus(unittest.TestCase):
    def test_every_bypassed_detector_is_a_named_branch_in_both_languages(self) -> None:
        ts = (ROOT / "src" / "kitlib" / "io.ts").read_text(encoding="utf-8")
        py = (ROOT / "scripts" / "kitlib_io.py").read_text(encoding="utf-8")
        for name in {name for negative in CORPUS_DOC["planted_negatives"] for name in negative["bypass"]}:
            self.assertIn(f'bypass.has("{name}")', ts)
            self.assertTrue(f'"{name}" in bypass' in py or f'"{name}" not in bypass' in py, name)


def _install_cases() -> None:
    for case in CORPUS_DOC["cases"]:
        name = "test_" + case["id"].replace("-", "_")
        setattr(Corpus, name, lambda self, case=case: self.assertEqual(run_case(case), []))
    for negative in CORPUS_DOC["planted_negatives"]:
        def check(self, negative=negative) -> None:
            case, control = BY_ID[negative["case"]], BY_ID[negative["control"]]
            bypass = frozenset(negative["bypass"])
            self.assertEqual(run_case(case), [], "the named branch must refuse")
            self.assertNotEqual(run_case(case, bypass), [], f"bypassing {sorted(bypass)} must change {case['id']}")
            self.assertEqual(run_case(control, bypass), [], f"control {control['id']} must pass under the bypass")
        setattr(Corpus, "test_planted_negative_" + negative["id"].replace("-", "_"), check)


_install_cases()


class PythonSurface(unittest.TestCase):
    def test_str_refused_serialization_is_the_callers(self) -> None:
        directory = case_dir({"id": "str-refused", "setup": []})
        with self.assertRaises(kitlib_io.AtomicReplaceError) as caught:
            kitlib_io.atomic_replace_bytes(os.path.join(directory, "target"), "text", mode=0o600, durability="full")  # type: ignore[arg-type]
        self.assertEqual((caught.exception.code, caught.exception.published), ("INVALID_ARGUMENT", False))
        self.assertEqual(os.listdir(directory), [])

    def test_bool_mode_refused(self) -> None:
        directory = case_dir({"id": "bool-mode", "setup": []})
        with self.assertRaises(kitlib_io.AtomicReplaceError) as caught:
            kitlib_io.atomic_replace_bytes(os.path.join(directory, "target"), b"x", mode=True, durability="full")
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


def tearDownModule() -> None:
    OWNED.cleanup()


if __name__ == "__main__":
    unittest.main()
