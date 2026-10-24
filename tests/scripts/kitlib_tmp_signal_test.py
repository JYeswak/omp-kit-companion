#!/usr/bin/env python3
"""Literal top-level EOF signal regression for the POSIX temp helper (774u.29/31).

A compound case statement or a command after kill can process Bash's deferred signal and hide this bug.
Use the real bounded runner, one owned temp, and kill as the final top-level simple command.
"""
from __future__ import annotations

import os
import shlex
import signal
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import kitlib_run  # noqa: E402
import kitlib_tmp  # noqa: E402

PREAMBLE = "import os,signal,sys; [signal.signal(s,signal.SIG_DFL) for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP,signal.SIGPIPE)]; os.execvp(sys.argv[1],sys.argv[1:])"
SHELLS = [path for path in ("/bin/sh", "/bin/bash", "/bin/dash") if Path(path).is_file()]


class NativeShellSignal(unittest.TestCase):
    def invoke(self, shell: str, root: str, ending: str, *, readonly: bool = False, auto: bool = True, mutant: bool = False) -> tuple[kitlib_run.RunResult, Path]:
        script = '. ' + shlex.quote(str(ROOT / "scripts/kitlib-tmp.sh")) + '; kitlib_tmp work staged-readme-signal; printf "%s\\n" "$work"; '
        if readonly:
            script += 'mkdir -p "$work/ro/deep"; printf x >"$work/ro/deep/file"; chmod 0555 "$work/ro/deep" "$work/ro"; ln -s "$KT_FOREIGN" "$work/link"; '
        if mutant:
            script += "trap 'kitlib__tmp_run_registry; exit 0' TERM; "
        script += ending
        result = kitlib_run.run([sys.executable, "-c", PREAMBLE, shell, "-c", script], deadline_s=20, grace_s=2, stdin=b"",
                                env={**os.environ, "TMPDIR": root, "KITLIB_TMP_ROOT": root,
                                     "KITLIB_TMP_AUTO_CLEANUP": "1" if auto else "0", "KT_FOREIGN": str(Path(root) / "foreign")})
        self.assertFalse(result.timed_out, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stderr, b"")
        path = Path(result.stdout.decode().strip())
        self.assertEqual(path.parent, Path(root))
        return result, path

    def test_signal_at_top_level_eof_preserves_termination_and_ownership(self) -> None:
        for shell in SHELLS:
            for name in ("TERM", "INT", "HUP"):
                for readonly in (False, True):
                    with self.subTest(shell=shell, signal=name, readonly=readonly), kitlib_tmp.owned_tmp("native-shell-signal") as root:
                        foreign = Path(root) / "foreign"
                        foreign.mkdir()
                        (foreign / "keep").write_text("foreign control")
                        foreign.chmod(0o555)
                        result, path = self.invoke(shell, root, "kill -s " + name + " $$", readonly=readonly)
                        self.assertEqual(result.rc, -int(getattr(signal, "SIG" + name)))
                        self.assertFalse(path.exists())
                        self.assertEqual((foreign / "keep").read_text(), "foreign control")
                        self.assertEqual(foreign.stat().st_mode & 0o777, 0o555)

    def test_normal_exit_and_failure_statuses_are_preserved(self) -> None:
        for shell in SHELLS:
            for code in (0, 7):
                with self.subTest(shell=shell, code=code), kitlib_tmp.owned_tmp("native-shell-status") as root:
                    result, path = self.invoke(shell, root, "exit " + str(code))
                    self.assertEqual(result.rc, code)
                    self.assertFalse(path.exists())

    def test_exit_zero_and_missing_cleanup_mutants_fail_their_assertions(self) -> None:
        for shell in SHELLS:
            with self.subTest(shell=shell), kitlib_tmp.owned_tmp("native-shell-mutant") as root:
                result, path = self.invoke(shell, root, "kill -TERM $$", mutant=True)
                self.assertEqual(result.rc, 0)
                self.assertFalse(path.exists())
                with self.assertRaises(AssertionError):
                    self.assertEqual(result.rc, -signal.SIGTERM)
                result, path = self.invoke(shell, root, "kill -TERM $$", auto=False)
                self.assertEqual(result.rc, -signal.SIGTERM)
                with self.assertRaises(AssertionError):
                    self.assertFalse(path.exists())
                self.assertTrue(path.is_dir())


class NativeShellPipeAllocation(unittest.TestCase):
    def test_allocation_preserves_inherited_pipe_policy(self) -> None:
        for shell in SHELLS:
            for ignored in (False, True):
                with self.subTest(shell=shell, ignored=ignored), kitlib_tmp.owned_tmp("native-shell-pipe") as root:
                    script = "trap '' PIPE; " if ignored else ""
                    script += 'printf "probe-pid=%s\\n" "$$"; . ' + shlex.quote(str(ROOT / "scripts/kitlib-tmp.sh"))
                    script += '; kitlib_tmp work pipe-inherit-probe || exit 90; printf "%s\\n" "$work"; cat "$work/.owner"; '
                    script += '{ /bin/sh -c \'kill -s PIPE $$; :\'; } 2>/dev/null; printf "pipe-status=%s\\n" "$?"'
                    result = kitlib_run.run(
                        [sys.executable, "-c", PREAMBLE, shell, "-c", script], deadline_s=3, grace_s=2, stdin=b"",
                        cwd=str(ROOT), env={**os.environ, "TMPDIR": root, "KITLIB_TMP_ROOT": root,
                                           "KITLIB_TMP_AUTO_CLEANUP": "1", "KITLIB_TMP_BEAD": ""},
                    )
                    lines = result.stdout.decode().splitlines()
                    marker, pid_text = lines[0].split("=", 1)
                    self.assertEqual(marker, "probe-pid")
                    pid = int(pid_text)
                    try:
                        self.assertFalse(result.timed_out, f"allocation timed out with ignored PIPE={ignored}")
                        self.assertEqual(result.rc, 0, result.stderr.decode(errors="replace"))
                        self.assertEqual(result.stderr, b"")
                        path = Path(lines[1])
                        owner = dict(line.split("=", 1) for line in lines[2:-1])
                        self.assertEqual(set(owner), {"pid", "label", "repo", "created"})
                        self.assertEqual(owner["pid"], pid_text)
                        self.assertEqual(owner["label"], "pipe-inherit-probe")
                        self.assertEqual(owner["repo"], str(ROOT))
                        suffix = path.name.rsplit(".", 1)[1]
                        self.assertEqual(len(suffix), 6)
                        self.assertTrue(all(c in "abcdefghijklmnopqrstuvwxyz0123456789" for c in suffix))
                        self.assertEqual(path.name, f"pipe-inherit-probe.{pid}.{suffix}")
                        self.assertEqual(path.parent, Path(root))
                        self.assertFalse(path.exists())
                        self.assertEqual(lines[-1], f"pipe-status={0 if ignored else 128 + signal.SIGPIPE}")
                        with self.assertRaises(ProcessLookupError):
                            os.killpg(pid, 0)
                    finally:
                        # This PID came from our just-started group; also reap a failing-before counterfactual.
                        try:
                            os.killpg(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass


if __name__ == "__main__":
    unittest.main()
