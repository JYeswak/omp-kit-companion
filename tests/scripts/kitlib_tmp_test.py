#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_tmp.py (ompkit-41l85, KITLIB-TMP v1).

Every case comes from tests/fixtures/kitlib-tmp/corpus.json, the same corpus
tests/cli/kitlib-tmp.test.ts runs against src/kitlib/tmp.ts and
scripts/kitlib-tmp.sh, so the three languages cannot drift. Each case runs a
real Python child in its own process group under a root this test owns (made
with owned_tmp itself) and removes at the end, so the test leaves nothing.
"""
from __future__ import annotations

import importlib.util
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "tests" / "fixtures" / "kitlib-tmp" / "corpus.json"
CHILD_DEADLINE_S = 20.0
NAME_SUFFIX = frozenset("abcdefghijklmnopqrstuvwxyz0123456789")


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pysafe = _load("pysafe", ROOT / "scripts" / "pysafe.py")
sys.path.insert(0, str(ROOT / "scripts"))
kitlib_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py")

PY_CHILD = r'''
import os, signal, sys, time
# Background suite jobs inherit ignored SIGINT; this child tests default cancellation.
signal.signal(signal.SIGINT, signal.SIG_DFL)
sys.path.insert(0, os.environ["KT_LIBDIR"])
import kitlib_tmp
root = os.environ["KT_ROOT"]
action = os.environ["KT_ACTION"]
auto = os.environ.get("KT_AUTO_CLEANUP") != "0"
a = kitlib_tmp.owned_tmp("kitlib-a", root=root, auto_cleanup=auto)
b = kitlib_tmp.owned_tmp("kitlib-b", root=root, bead="ompkit-41l85", auto_cleanup=auto)
os.write(1, (a.path + "\n" + b.path + "\n").encode())
sigs = {"sigterm": signal.SIGTERM, "sigint": signal.SIGINT, "sighup": signal.SIGHUP}
if action == "fail":
    raise RuntimeError("planned failure")
elif action in sigs:
    os.kill(os.getpid(), sigs[action])
    time.sleep(10)
elif action == "sigterm-unhooked":
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.kill(os.getpid(), signal.SIGTERM)
    time.sleep(10)
elif action == "wait":
    os.write(1, b"ready\n")
    time.sleep(60)
elif action == "cleanup-twice":
    a.cleanup(); a.cleanup(); b.cleanup(); b.cleanup()
    os.write(1, b"cleaned\n")
elif action == "bad-label":
    try:
        kitlib_tmp.owned_tmp(os.environ["KT_LABEL"], root=root)
        os.write(1, b"ACCEPTED\n")
    except ValueError as error:
        os.write(2, (str(error) + "\n").encode())
        os.write(1, b"REFUSED\n")
elif action == "readonly-tree":
    ro = os.path.join(a.path, "ro")
    os.makedirs(os.path.join(ro, "deep"))
    with open(os.path.join(ro, "deep", "file"), "w") as handle:
        handle.write("x")
    os.chmod(os.path.join(ro, "deep"), 0o555)
    os.chmod(ro, 0o555)
    os.symlink(os.environ["KT_OUTSIDE"], os.path.join(a.path, "link"))
else:
    if action != "exit0":
        raise SystemExit(f"unknown child action {action}")
'''

# Parses one owner file with the real reader (src/scratch.ts parseOwnerFile); prints its JSON or "null".
BUN_PARSE = 'import { parseOwnerFile } from "{scratch}"; console.log(JSON.stringify(parseOwnerFile(await Bun.file(process.argv[1]).text())));'


class Outcome:
    def __init__(self, rc, stdout: str, stderr: str, pid: int, timed_out: bool) -> None:
        self.rc, self.stdout, self.stderr, self.pid, self.timed_out = rc, stdout, stderr, pid, timed_out


def _env(action: str, root: str, case: dict) -> dict:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "TMPDIR": root, "KT_LIBDIR": str(ROOT / "scripts"),
           "KT_ROOT": root, "KT_ACTION": action, "KT_AUTO_CLEANUP": "0" if case.get("auto_cleanup") is False else "1"}
    if "label" in case:
        env["KT_LABEL"] = case["label"]
    if "outside_path" in case:
        env["KT_OUTSIDE"] = case["outside_path"]
    return env


def _killpg(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_child(action: str, root: str, case: dict) -> Outcome:
    argv = [sys.executable, "-c", PY_CHILD]
    if "kill" not in case:
        result = pysafe.run_bounded(argv, CHILD_DEADLINE_S, env=_env(action, root, case), grace=0.5)
        # run_bounded reports only the leader's status; its pid is the dirs' name segment, read from stdout.
        parts = os.path.basename(result.text().split("\n", 1)[0]).split(".")
        pid = int(parts[1]) if len(parts) == 3 and parts[1].isdigit() else -1
        return Outcome(result.returncode, result.text(), result.text("stderr"), pid, result.outcome != pysafe.OK)
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=_env(action, root, case), start_new_session=True)
    out = b""
    timed_out = False
    try:
        deadline = time.monotonic() + CHILD_DEADLINE_S
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while b"ready\n" not in out and time.monotonic() < deadline:
                if not selector.select(timeout=max(0.0, deadline - time.monotonic())):
                    continue
                chunk = os.read(proc.stdout.fileno(), 4096)
                if not chunk:
                    break
                out += chunk
        timed_out = b"ready\n" not in out
        os.killpg(proc.pid, getattr(signal, case["kill"]))
        proc.wait(timeout=CHILD_DEADLINE_S)
    finally:
        _killpg(proc.pid)
        if proc.returncode is None:
            proc.wait(timeout=CHILD_DEADLINE_S)
        proc.stdout.close()
    return Outcome(proc.returncode, out.decode("utf-8", "replace"), "", proc.pid, timed_out)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _owner_fields(text: str) -> dict:
    fields = {}
    for line in text.split("\n"):
        if line:
            key, _, value = line.partition("=")
            fields[key] = value
    return fields


def _parse_with_scratch(owner_path: str):
    """The real owner reader's verdict, or the string 'unavailable' without bun."""
    bun = shutil.which("bun")
    if bun is None:
        return "unavailable"
    code = BUN_PARSE.replace("{scratch}", str(ROOT / "src" / "scratch.ts"))
    result = pysafe.run_bounded([bun, "-e", code, owner_path], 30, cwd=str(ROOT))
    return json.loads(result.text()) if result.ok else f"bun failed: {result.text('stderr')}"


def _dir_name_ok(name: str, label: str, pid: int) -> bool:
    head, _, suffix = name.rpartition(".")
    return head == f"{label}.{pid}" and len(suffix) == 6 and set(suffix) <= NAME_SUFFIX


def judge(outcome: Outcome, want: dict, root: str) -> list:
    """Every way ``outcome`` breaks ``want``; empty when the case passes."""
    failures = []
    if outcome.timed_out:
        failures.append(f"child outlived {CHILD_DEADLINE_S} s")
    if "rc" in want:
        rc = want["rc"] if isinstance(want["rc"], int) else want["rc"]["py"]
        if outcome.rc != rc:
            failures.append(f"want exit {rc}, got {outcome.rc}")
    if "signal" in want and outcome.rc != -int(getattr(signal, want["signal"])):
        failures.append(f"want signal {want['signal']}, got {outcome.rc}")
    dirs = outcome.stdout.split("\n")[:2]
    if (len(dirs) != 2 or not all(d.startswith(root + "/") for d in dirs)
            or not _dir_name_ok(os.path.basename(dirs[0]), "kitlib-a", outcome.pid)
            or not _dir_name_ok(os.path.basename(dirs[1]), "kitlib-b", outcome.pid)):
        failures.append(f"stdout does not start with the two owned dir paths: {outcome.stdout!r}")
        return failures
    left = sorted(os.listdir(root))
    if want["dirs"] == "gone":
        failures.extend(f"dir survived: {d}" for d in dirs if os.path.exists(d))
        if left:
            failures.append(f"root not empty: {', '.join(left)}")
    else:
        names = sorted(os.path.basename(d) for d in dirs)
        if left != names:
            failures.append(f"want exactly {names} kept, root holds {left}")
        if _pid_alive(outcome.pid):
            failures.append(f"child pid {outcome.pid} is still alive")
        for index, d in enumerate(dirs):
            owner = os.path.join(d, ".owner")
            if not os.path.isdir(d):
                failures.append(f"dir removed: {d}")
                continue
            if not os.path.isfile(owner):
                failures.append(f"no .owner in {d}")
                continue
            if os.stat(d).st_mode & 0o777 != 0o700 or os.stat(owner).st_mode & 0o777 != 0o600:
                failures.append(f"modes are not 0700/0600: {d}")
            with open(owner, encoding="utf-8") as handle:
                fields = _owner_fields(handle.read(4096))
            want_keys = {"pid", "process_start", "label", "repo", "created_at", "argv0"} | ({"bead"} if index == 1 else set())
            if set(fields) != want_keys or fields.get("pid") != str(outcome.pid) or not fields.get("process_start"):
                failures.append(f".owner fields {fields} lack the process incarnation for pid {outcome.pid}")
            parsed = _parse_with_scratch(owner)
            if parsed != "unavailable" and (not isinstance(parsed, dict) or parsed.get("pid") != outcome.pid or not parsed.get("processStart")):
                failures.append(f"src/scratch.ts parseOwnerFile rejects {owner}: {parsed}")
    if "stdout_has" in want and want["stdout_has"] not in outcome.stdout:
        failures.append(f"stdout lacks {want['stdout_has']}: {outcome.stdout!r}")
    if "stderr_has" in want and want["stderr_has"] not in outcome.stderr:
        failures.append(f"stderr lacks {want['stderr_has']}: {outcome.stderr!r}")
    return failures


def run_case(case: dict, action: str) -> list:
    with kitlib_tmp.owned_tmp("kitlib-tmp-test") as owned:
        root = os.path.join(owned, "root")
        os.mkdir(root, 0o700)
        outside = None
        if case.get("outside"):
            outside = os.path.join(owned, "outside")
            os.mkdir(outside, 0o700)
            with open(os.path.join(outside, "keep"), "w", encoding="utf-8") as handle:
                handle.write("keep\n")
            os.chmod(outside, 0o555)
            case = dict(case, outside_path=outside)
        failures = judge(run_child(action, root, case), case["expect"], root)
        if case["expect"].get("outside_intact") and outside is not None:
            if os.stat(outside).st_mode & 0o777 != 0o555:
                failures.append(f"OUTSIDE mode changed: {oct(os.stat(outside).st_mode & 0o777)}")
            if not os.path.isfile(os.path.join(outside, "keep")):
                failures.append("OUTSIDE lost its file keep")
        return failures  # the with-exit removes the 0555 OUTSIDE too: the fix dogfooded on the test's own root


class Corpus(unittest.TestCase):
    pass


def _install_cases() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    if corpus.get("schema") != "kitlib-tmp-corpus.v1" or not corpus.get("cases"):
        raise AssertionError("tests/fixtures/kitlib-tmp/corpus.json is not a kitlib-tmp-corpus.v1 corpus")
    by_id = {case["id"]: case for case in corpus["cases"]}
    for index, case in enumerate(corpus["cases"]):
        name = f"test_{index:02d}_{case['id'].replace('-', '_')}"
        setattr(Corpus, name, lambda self, case=case: self.assertEqual(run_case(case, case["action"]), []))
    # Planted negatives: a test-only child variant (a dropped signal hook, or the default where the case asks for
    # auto_cleanup=False). The library has no switch for this; the point is that the corpus judgement notices.
    for negative in corpus["planted_negatives"]:
        name = f"test_planted_negative_{negative['id'].replace('-', '_')}"

        def check(self, negative=negative):
            case = by_id[negative["case"]]
            if "auto_cleanup" in negative:
                case = dict(case, auto_cleanup=negative["auto_cleanup"])
            failures = run_case(case, negative["action"])
            self.assertTrue(any(f.startswith(negative["caught_by"]) for f in failures), failures)

        setattr(Corpus, name, check)


_install_cases()


class Surface(unittest.TestCase):
    def test_invalid_labels_refused_naming_the_label(self) -> None:
        for label in ["", "-a", "A", "a_b", "a.b", "a/b", "a" * 49, "kitlib\n"]:
            with self.assertRaises(ValueError) as caught:
                kitlib_tmp.owned_tmp(label)
            self.assertIn(repr(label), str(caught.exception))
        longest = kitlib_tmp.owned_tmp("a" * 48)
        self.assertIn(f"{'a' * 48}.{os.getpid()}.", longest.path)
        longest.cleanup()

    def test_default_root_context_manager_and_idempotent_cleanup(self) -> None:
        with kitlib_tmp.owned_tmp("kitlib-default") as path:
            self.assertEqual(os.path.dirname(path), kitlib_tmp.tempfile.gettempdir())
            self.assertTrue(os.path.isfile(os.path.join(path, ".owner")))
        self.assertFalse(os.path.exists(path))
        owned = kitlib_tmp.owned_tmp("kitlib-default")
        owned.cleanup()
        owned.cleanup()
        self.assertFalse(os.path.exists(owned.path))

    def test_cleanup_all_and_missing_root_and_bad_bead(self) -> None:
        with kitlib_tmp.owned_tmp("kitlib-root") as base:
            first = kitlib_tmp.owned_tmp("kitlib-x", root=base)
            second = kitlib_tmp.owned_tmp("kitlib-x", root=base)
            self.assertNotEqual(first.path, second.path)
            with self.assertRaises(NotADirectoryError):
                kitlib_tmp.owned_tmp("kitlib-x", root=os.path.join(base, "absent"))
            with self.assertRaises(ValueError):
                kitlib_tmp.owned_tmp("kitlib-x", root=base, bead="bad bead")
            kitlib_tmp.cleanup_all_owned_tmp()
            self.assertFalse(os.path.exists(first.path) or os.path.exists(second.path))

    def test_forked_child_never_removes_parent_dirs(self) -> None:
        with kitlib_tmp.owned_tmp("kitlib-fork") as path:
            pid = os.fork()
            if pid == 0:
                kitlib_tmp.cleanup_all_owned_tmp()
                os._exit(0)
            deadline = time.monotonic() + CHILD_DEADLINE_S
            status = None
            while status is None and time.monotonic() < deadline:
                done, raw = os.waitpid(pid, os.WNOHANG)
                status = raw if done else None
                if status is None:
                    time.sleep(0.02)
            if status is None:
                os.kill(pid, signal.SIGKILL)
            self.assertEqual(status, 0)
            self.assertTrue(os.path.isdir(path))

    def test_cleanup_and_cleanup_all_remove_a_tree_holding_0555_dirs(self) -> None:
        for remove in ("cleanup", "all"):
            owned = kitlib_tmp.owned_tmp("kitlib-readonly")
            release = os.path.join(owned.path, "releases", "0.0.1")
            os.makedirs(release)
            with open(os.path.join(release, "bin"), "w", encoding="utf-8") as handle:
                handle.write("x")
            os.chmod(release, 0o555)
            os.chmod(os.path.dirname(release), 0o555)
            if remove == "cleanup":
                owned.cleanup()
            else:
                kitlib_tmp.cleanup_all_owned_tmp()
            self.assertFalse(os.path.exists(owned.path), remove)
            owned.cleanup()

    def test_dir_made_from_a_thread_is_registered(self) -> None:
        box = {}
        worker = threading.Thread(target=lambda: box.setdefault("dir", kitlib_tmp.owned_tmp("kitlib-thread")))
        worker.start()
        worker.join(timeout=CHILD_DEADLINE_S)
        self.assertIn(box["dir"].path, kitlib_tmp._live)
        kitlib_tmp.cleanup_all_owned_tmp()
        self.assertFalse(os.path.exists(box["dir"].path))


if __name__ == "__main__":
    unittest.main()
