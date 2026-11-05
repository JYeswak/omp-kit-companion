#!/usr/bin/env python3
"""VERDICTSIZE1: a verdict record larger than 1 MiB reads back; a record past the bound still refuses.

The 2026-11-02 main-role records reached 1,065,616 bytes, and json_value() refused every one of them at the old
1 MiB bound, so release-local read each full-suite PASS as MISS.
PHANTOMRED1 (ompkit-fp72.120.16.252): a failing verdict lists suite reds only from the runner's own status rows,
never a "RED script-suite" line a passing test's nested fixture printed into the combined log.
Run: python3 tests/scripts/full_suite_verdict_store_size_test.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import kitlib_run  # noqa: E402  (bounded spawn: deadline and process-group cancel)
import kitlib_tmp  # noqa: E402  (owned temp dirs, removed on exit)

spec = importlib.util.spec_from_file_location("verdict_store", ROOT / "scripts" / "full-suite-verdict-store.py")
store = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(store)


class RecordSize(unittest.TestCase):
    def test_measured_size_reads_back(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-size") as tmp:
            path = Path(tmp) / "record.json"
            path.write_text(json.dumps({"verdict": "PASS", "evidence": {"files": ["x" * 1_100_000]}}), encoding="utf-8")
            self.assertGreater(path.stat().st_size, 1 << 20)
            self.assertEqual(store.json_value(path)["verdict"], "PASS")

    def test_planted_negative_past_bound_refuses(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-size") as tmp:
            path = Path(tmp) / "record.json"
            path.write_text(json.dumps({"verdict": "PASS", "pad": "x" * (store.MAX_RECORD_BYTES + 1)}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "bounded regular file"):
                store.json_value(path)


# A passing test's nested preflight prints these into the combined log (the 2026-11-04 shape has no rc=).
PHANTOMS = ("RED script-suite long.test.sh", "RED script-suite tests/cli/fixture.sh rc=1")
REAL_RED = "RED script-suite tests/cli/real.test.sh rc=3"
LOG = "\n".join((
    "tests/cli/fixture-long-path.test.ts:", *PHANTOMS,
    "(pass) planted long-path failure is refused by the box's literal command",
    "GREEN script-suite tests/cli/ok.test.sh", "tests/cli/c.test.ts:", "(fail) c [1.00ms]", REAL_RED, "",
))
STATUS = f"GREEN script-suite tests/cli/ok.test.sh\n{REAL_RED}\nBUN rc=1\nBUN_RAN 2\nBUN_FAIL 1\n"


def seat_free_path() -> str:
    # The verdict refuses a seat PATH whose br is the agent-bin shim (FULL_SUITE_SHIM_PATH).
    return os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep) if not p.endswith("/agent-bin"))


class PhantomRed(unittest.TestCase):
    def test_planted_nested_red_is_not_listed_and_outer_red_is(self) -> None:
        listed = store.failing_tests(LOG, STATUS)
        self.assertEqual(listed, ["  tests/cli/c.test.ts: (fail) c [1.00ms]", "  " + REAL_RED])

    def test_control_outer_reds_without_bun_failures_still_list(self) -> None:
        status = f"{REAL_RED}\nRED python-suite tests/cli/p_test.py rc=2\nGREEN python-suite tests/cli/q_test.py\n"
        self.assertEqual(store.failing_tests("", status),
                         ["  " + REAL_RED, "  RED python-suite tests/cli/p_test.py rc=2"])

    def test_mutant_rows_read_from_the_combined_log_list_the_phantom(self) -> None:
        # The pre-fix wiring: suite reds grepped from the combined log instead of the runner's status rows.
        self.assertIn("  " + PHANTOMS[1], store.failing_tests(LOG, LOG))
        self.assertNotIn("  " + PHANTOMS[1], store.failing_tests(LOG, STATUS))

    def test_planted_full_verdict_lists_only_the_runner_red(self) -> None:
        # The real wiring: full-suite-verdict.sh on a fixture repo where a passing suite prints both phantoms.
        with kitlib_tmp.owned_tmp("phantom-red") as tmp:
            repo = Path(tmp) / "repo"
            (repo / "tests" / "cli").mkdir(parents=True)
            (repo / "tests" / "cli" / "nested.test.sh").write_text(
                "#!/bin/sh\n" + "".join(f"echo '{line}'\n" for line in PHANTOMS) + "exit 0\n", encoding="utf-8")
            (repo / "tests" / "cli" / "real.test.sh").write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
            # The suites source the kit's temp helper from the candidate tree, as in full-suite-complement.test.sh.
            (repo / "scripts").mkdir()
            (repo / "scripts" / "kitlib-tmp.sh").write_bytes((ROOT / "scripts" / "kitlib-tmp.sh").read_bytes())
            git = ["git", "-C", str(repo), "-c", "user.name=PHANTOMRED1", "-c", "user.email=phantomred1@example.invalid"]
            for args in (["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "[test] PHANTOMRED1 fixture"]):
                step = kitlib_run.run(git + args, deadline_s=60)
                self.assertEqual(step.rc, 0, step.stderr.decode("utf-8", "replace"))
            run = kitlib_run.run(
                ["sh", str(ROOT / "scripts" / "full-suite-verdict.sh"), "--repo", str(repo), "--commit", "HEAD",
                 "--cache-dir", str(repo) + ".cache"],
                env={**os.environ, "PATH": seat_free_path(), "KITROOT": str(ROOT), "OMP_KIT_OMP_SRC_FETCH": "0"},
                deadline_s=600)
            out = (run.stdout + run.stderr).decode("utf-8", "replace")
            self.assertNotEqual(run.rc, 0, out)
            if "shell_red=1" not in out:
                partial = out.rsplit("partial log: ", 1)[-1].strip()
                self.fail(out + (Path(partial).read_text(encoding="utf-8")[-3000:] if Path(partial).is_file() else ""))
            listing = out.split("FULL-SUITE: failing tests", 1)[1].splitlines()[1:]
            self.assertIn("  " + REAL_RED, listing, out)
            self.assertFalse([line for line in listing if "long.test.sh" in line or "fixture.sh" in line], out)
            # The plant is real: the phantoms sit at line start in the evidence log the old grep read.
            log = Path(out.split("(full log: ", 1)[1].split("):", 1)[0]).read_text(encoding="utf-8")
            self.assertTrue(all(line in log.splitlines() for line in PHANTOMS))


if __name__ == "__main__":
    unittest.main(verbosity=2)
