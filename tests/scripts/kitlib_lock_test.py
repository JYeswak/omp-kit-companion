#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_lock.py (ompkit-lsn3a, KL08).

Every case comes from tests/fixtures/kitlib-lock/corpus.json, the same corpus
tests/cli/kitlib-lock.test.ts runs against src/kitlib/lock.ts, so the two
languages cannot drift. Holders are real processes in either language, so a
TypeScript holder blocks this Python waiter on the same inode.
"""
from __future__ import annotations

import errno
import importlib.util
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = ROOT / "tests" / "fixtures" / "kitlib-lock" / "corpus.json"
MODULE_TS = str(ROOT / "src" / "kitlib" / "lock.ts")
SCRIPTS_DIR = str(ROOT / "scripts")
CHILD_DEADLINE_S = 30.0


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


def replace_lockfile(lockfile: str) -> None:
    os.rename(lockfile, lockfile + ".replaced")
    fd = os.open(lockfile, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.fchmod(fd, 0o600)
    os.close(fd)


def first_line(proc: subprocess.Popen, budget: float = CHILD_DEADLINE_S) -> str:
    out = b""
    deadline = time.monotonic() + budget
    with selectors.DefaultSelector() as selector:
        selector.register(proc.stdout, selectors.EVENT_READ)
        while b"\n" not in out and time.monotonic() < deadline:
            if not selector.select(timeout=max(0.0, deadline - time.monotonic())):
                continue
            chunk = os.read(proc.stdout.fileno(), 4096)
            if not chunk:
                break
            out += chunk
    if b"\n" not in out:
        raise AssertionError(f"no holder line within {budget} s: {out!r}")
    return out.split(b"\n", 1)[0].decode("utf-8")


def descriptors_on(path: str) -> list:
    """Descriptors of this process open on the inode at ``path`` (the kernel's view, through /dev/fd)."""
    target = os.stat(path)
    found = []
    for name in os.listdir("/dev/fd"):
        try:
            info = os.fstat(int(name))
        except OSError:
            continue
        if (info.st_dev, info.st_ino) == (target.st_dev, target.st_ino):
            found.append(int(name))
    return found


def reset_seam() -> None:
    kitlib_lock._TESTING.update({"disabled": set(), "expect_uid": None, "skip_inherit": False, "after_lock": None})


class CaseRun:
    def __init__(self, case: dict, variables: dict, bypassed: bool, test: unittest.TestCase) -> None:
        self.case, self.vars, self.bypassed, self.t = case, variables, bypassed, test
        self.locks: dict = {}
        self.holders: dict = {}
        self.inheritors: dict = {}
        self.inodes: dict = {}

    def resource(self, step: dict) -> dict:
        return substitute(step.get("resource", self.case["resource"]), self.vars)

    def step(self, raw: dict) -> None:
        if raw.get("when") == "normal" and self.bypassed or raw.get("when") == "bypassed" and not self.bypassed:
            return
        # The case resource may name an alias planted by an earlier step, so its lock path resolves now.
        resolved = kitlib_lock.resolve_lock(substitute(self.case["resource"], self.vars), self.vars["STATE"])
        self.vars["LOCKDIR"], self.vars["LOCKFILE"] = resolved["dir"], resolved["path"]
        step = substitute(raw, self.vars)
        where = f"{self.case['id']} step {json.dumps(raw)}"
        op, path = step["op"], step.get("path")
        if op == "mkdir":
            os.mkdir(path)
            os.chmod(path, int(step["mode"], 8))
        elif op == "write":
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(step["text"])
        elif op == "symlink":
            os.symlink(step["target"], path)
        elif op == "hardlink":
            os.link(step["target"], path)
        elif op == "chmod":
            os.chmod(path, int(step["mode"], 8))
        elif op == "utime-epoch":
            os.utime(path, (0, 0))
        elif op == "replace-lockfile":
            replace_lockfile(self.vars["LOCKFILE"])
        elif op == "record-inode":
            self.inodes[step["as"]] = os.lstat(path).st_ino
        elif op == "expect-inode":
            info = os.lstat(path)
            self.t.assertTrue(stat.S_ISREG(info.st_mode), where)
            if "same_as" in step:
                self.t.assertEqual(info.st_ino, self.inodes[step["same_as"]], where)
            if step.get("mtime_epoch"):
                self.t.assertEqual(info.st_mtime, 0, where)
            if "text" in step:
                self.t.assertEqual(Path(path).read_text(encoding="utf-8"), step["text"], where)
        elif op == "keys-equal":
            resolved_all = [kitlib_lock.resolve_lock(item, self.vars["STATE"]) for item in step["resources"]]
            for item in resolved_all:
                self.t.assertEqual((item["key"], item["path"]), (resolved_all[0]["key"], resolved_all[0]["path"]), where)
        elif op == "hook":
            if step.get("expect_uid") == "other":
                kitlib_lock._TESTING["expect_uid"] = os.getuid() + 1
            if step.get("skip_inherit"):
                kitlib_lock._TESTING["skip_inherit"] = True
            if step.get("after_lock") == "replace-lockfile":
                kitlib_lock._TESTING["after_lock"] = replace_lockfile
        elif op == "holder":
            self.holder(step, where)
        elif op == "end-holder":
            proc, _ = self.holders.pop(step["as"])
            if step["how"] == "kill":
                proc.kill()
            proc.stdin.close()
            proc.wait(timeout=CHILD_DEADLINE_S)
            proc.stdout.close()
        elif op == "expect-zombie":
            pid = self.holders[step["as"]][1]
            state = ""
            for _attempt in range(100):
                state = pysafe.run_bounded(["ps", "-o", "stat=", "-p", str(pid)], 10).text().strip()
                if state.startswith("Z"):
                    break
                time.sleep(0.05)  # real-clock poll for another process's exit
            self.t.assertTrue(state.startswith("Z"), f"{where}: holder {pid} state {state!r}")
        elif op == "acquire":
            self.acquire(step, raw, where)
        elif op == "release":
            want = step["expect_bypassed"] if self.bypassed and "expect_bypassed" in raw else step["expect"]
            self.t.assertIn(step["as"], self.locks, where)
            self.t.assertEqual(self.locks[step["as"]].release(), want, where)
        elif op == "inheritor":
            self.inheritor(step)
        elif op == "end-inheritor":
            self.end_inheritor(step["as"])
        else:
            raise AssertionError(f"unknown corpus op {op}")

    def acquire(self, step: dict, raw: dict, where: str) -> None:
        want = step["expect_bypassed"] if self.bypassed and "expect_bypassed" in raw else step["expect"]
        options = {"state_dir": self.vars["STATE"], **step["options"]}
        try:
            outcome = kitlib_lock.private_lock(self.resource(step), **options)
        except (kitlib_lock.PrivateLockError, TypeError, ValueError) as error:
            outcome = error
        if want.get("acquired"):
            if isinstance(outcome, Exception):
                raise AssertionError(f"{where}: expected acquired, got {outcome!r} {getattr(outcome, 'evidence', {})}")
            # A bypassed run acquires through the planted state on purpose; only a clean run must show the private shape.
            if not self.bypassed:
                info = os.stat(outcome.path)
                self.t.assertEqual((info.st_ino, stat.S_IMODE(info.st_mode), stat.S_IMODE(os.stat(self.vars["LOCKDIR"]).st_mode)),
                                   (outcome.ino, 0o600, 0o700), where)
            self.locks[step.get("as", "lock")] = outcome
            return
        if not isinstance(outcome, Exception):
            outcome.release()
            raise AssertionError(f"{where}: expected refusal {want}, but the lock was acquired")
        if want.get("throws") == "type":
            self.t.assertIsInstance(outcome, TypeError, where)
            return
        self.t.assertIsInstance(outcome, kitlib_lock.PrivateLockError, where)
        self.t.assertEqual(outcome.code, want["code"], f"{where}: {outcome.evidence}")
        self.t.assertEqual(outcome.evidence["code"], outcome.code, where)
        for key, value in want.get("evidence", {}).items():
            self.t.assertEqual(outcome.evidence.get(key), value, f"{where}: evidence {key} in {outcome.evidence}")
        if "min_waited_s" in want:
            self.t.assertGreaterEqual(outcome.evidence["waited_s"], want["min_waited_s"], where)

    def holder(self, step: dict, where: str) -> None:
        zombie = step["mode"] == "zombie"
        argv = substitute(CORPUS["holders"][step["lang"]], {
            "BUN": BUN, "PYTHON": sys.executable, "MODULE_TS": MODULE_TS, "SCRIPTS_DIR": SCRIPTS_DIR,
            "STATE": self.vars["STATE"], "RESOURCE_JSON": json.dumps(self.resource(step)),
            "MODE": "exit" if zombie else step["mode"],
        })
        proc = subprocess.Popen(CORPUS["zombie_wrapper"] + argv if zombie else argv,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.holders[step["as"]] = (proc, proc.pid)
        line = json.loads(first_line(proc))
        self.t.assertEqual(line["status"], "ACQUIRED", f"{where}: {line}")
        self.holders[step["as"]] = (proc, line["pid"])

    def inheritor(self, step: dict) -> None:
        fifo = os.path.join(self.vars["TMP"], f"fifo-{step['as']}")
        os.mkfifo(fifo, 0o600)
        argv = substitute(CORPUS["inheritor_argv"], {"FIFO": fifo})
        # close_fds=False: the ordinary exec path that keeps every descriptor not marked close-on-exec.
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, close_fds=False)
        self.inheritors[step["as"]] = (proc, fifo)

    def end_inheritor(self, name: str) -> None:
        if name not in self.inheritors:
            return
        proc, fifo = self.inheritors.pop(name)
        # Opening the write end without blocking succeeds once the child's cat has the read end; closing it is EOF.
        deadline = time.monotonic() + 10
        while True:
            try:
                os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
                break
            except OSError as error:
                if error.errno != errno.ENXIO or time.monotonic() > deadline:
                    raise
                time.sleep(0.01)
        proc.wait(timeout=CHILD_DEADLINE_S)

    def cleanup(self) -> None:
        for lock in self.locks.values():
            lock.release()
        for name in list(self.inheritors):
            self.end_inheritor(name)
        for proc, _pid in self.holders.values():
            proc.kill()
            proc.stdin.close()
            proc.wait(timeout=CHILD_DEADLINE_S)
            proc.stdout.close()


class Corpus(unittest.TestCase):
    def test_corpus_shape_and_bun_present(self) -> None:
        self.assertEqual(CORPUS.get("schema"), "kitlib-lock-corpus.v1")
        self.assertTrue(CORPUS.get("cases"))
        self.assertIsNotNone(BUN, "bun is required for the TypeScript holders")

    def _run_case(self, case: dict, disabled: list) -> None:
        with owned_tmp("kitlib-lock") as scratch:
            tmp = os.path.realpath(scratch)
            variables = {"TMP": tmp, "STATE": os.path.join(tmp, "state")}
            run = CaseRun(case, variables, case.get("detector") in disabled, self)
            reset_seam()
            kitlib_lock._TESTING["disabled"] = set(disabled)
            try:
                for step in case["steps"]:
                    run.step(step)
            finally:
                reset_seam()
                run.cleanup()


def _install_cases() -> None:
    if CORPUS.get("schema") != "kitlib-lock-corpus.v1" or not CORPUS.get("cases"):
        raise AssertionError("tests/fixtures/kitlib-lock/corpus.json is not a kitlib-lock-corpus.v1 corpus")
    for index, case in enumerate(CORPUS["cases"]):
        name = f"test_{index:02d}_{case['id'].replace('-', '_')}"
        setattr(Corpus, name, lambda self, case=case: self._run_case(case, []))
        if "detector" in case:
            setattr(Corpus, f"{name}__bypassed_{case['detector']}_flips",
                    lambda self, case=case: self._run_case(case, [case["detector"]]))
        if case.get("control"):
            setattr(Corpus, f"{name}__all_bypassed_control_passes",
                    lambda self, case=case: self._run_case(case, list(CORPUS["detectors"])))


_install_cases()


class _Cancel(Exception):
    pass


# Python-only surface (TypeScript cancellation is an AbortSignal, tested in kitlib-lock.test.ts).
class Surface(unittest.TestCase):
    def _holder(self, state: str, resource: dict) -> subprocess.Popen:
        argv = substitute(CORPUS["holders"]["py"], {"PYTHON": sys.executable, "SCRIPTS_DIR": SCRIPTS_DIR, "STATE": state,
                                                    "RESOURCE_JSON": json.dumps(resource), "MODE": "stdin"})
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.assertEqual(json.loads(first_line(proc))["status"], "ACQUIRED")
        return proc

    def test_cancel_while_waiting_closes_the_owner_descriptor(self) -> None:
        resource = {"namespace": "kl08", "name": "cancel-wait"}
        with owned_tmp("kitlib-lock") as scratch:
            state = os.path.join(os.path.realpath(scratch), "state")
            holder = self._holder(state, resource)
            lock_path = kitlib_lock.resolve_lock(resource, state)["path"]
            seen = []

            def cancel(signum, frame):
                seen.append(descriptors_on(lock_path))
                raise _Cancel()

            previous = signal.signal(signal.SIGALRM, cancel)
            signal.setitimer(signal.ITIMER_REAL, 0.3)
            try:
                with self.assertRaises(_Cancel):
                    kitlib_lock.private_lock(resource, deadline_s=30, state_dir=state)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, previous)
                holder.kill()
                holder.stdin.close()
                holder.wait(timeout=CHILD_DEADLINE_S)
                holder.stdout.close()
            self.assertEqual(len(seen[0]), 1, "the waiter held one descriptor while waiting")
            self.assertEqual(descriptors_on(lock_path), [])

    def test_context_manager_releases(self) -> None:
        resource = {"namespace": "kl08", "name": "context"}
        with owned_tmp("kitlib-lock") as scratch:
            state = os.path.join(os.path.realpath(scratch), "state")
            with kitlib_lock.private_lock(resource, deadline_s=0, state_dir=state) as lock:
                self.assertEqual(len(descriptors_on(lock.path)), 1)
            self.assertEqual(descriptors_on(lock.path), [])
            self.assertEqual(lock.release(), "ALREADY_RELEASED")

    def test_unsupported_platform_refuses(self) -> None:
        with owned_tmp("kitlib-lock") as scratch:
            state = os.path.join(os.path.realpath(scratch), "state")
            script = ("import sys\nsys.path.insert(0, sys.argv[1])\nimport kitlib_lock\nsys.platform = 'win32'\n"
                      "try:\n    kitlib_lock.private_lock({'namespace': 'kl08', 'name': 'x'}, deadline_s=0, state_dir=sys.argv[2])\n"
                      "    print('ACQUIRED')\nexcept kitlib_lock.PrivateLockError as error:\n    print(error.code)\n")
            result = pysafe.run_bounded([sys.executable, "-c", script, SCRIPTS_DIR, state], 30)
            self.assertEqual(result.text().strip(), "UNSUPPORTED_PLATFORM", result.text("stderr"))
            self.assertFalse(os.path.lexists(state))

    def test_deadline_must_be_finite_non_negative(self) -> None:
        for bad in (-1, float("inf"), float("nan"), True, "1"):
            with self.assertRaises(TypeError):
                kitlib_lock.private_lock({"namespace": "kl08", "name": "x"}, deadline_s=bad, state_dir="/nonexistent")


if __name__ == "__main__":
    unittest.main()
