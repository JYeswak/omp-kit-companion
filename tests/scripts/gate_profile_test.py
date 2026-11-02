#!/usr/bin/env python3
"""GATESPEED1: measured spans stay distinct from unrecorded wait/setup/run time."""
from __future__ import annotations

from pathlib import Path
import json
import os
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
PROFILE_SCRIPT = str(ROOT / "scripts/gate_profile.py")
sys.path.insert(0, str(ROOT / "scripts"))
import gate_profile
from kitlib_jsonl import append_jsonl
from kitlib_run import run
from kitlib_tmp import owned_tmp


def observation(kind: str, number: int, wall: int = 1000, **changes) -> dict:
    record = {
        "ts": f"2026-11-01T00:00:{number:02d}Z",
        "recorded_at": f"2026-11-01T00:00:{number:02d}Z",
        "rc": 0,
        "verdict": "PASS",
        "timing": {"wall_ms": wall},
        "evidence": {"complete": True, "files": []},
    }
    record.update(changes)
    return {"kind": kind, "source": f"{kind}-{number}", "integrity": "VALID", "record": record}


class GateProfileTests(unittest.TestCase):
    def test_latest_selection_keeps_red_and_never_selects_only_green(self):
        records = [observation("push", i) for i in range(1, 5)]
        records[-1]["record"]["rc"] = 1
        report = gate_profile.summarize(records, 2)
        self.assertEqual([row["source"] for row in report["runs"]], ["push-4", "push-3"])
        self.assertEqual(report["runs"][0]["rc"], 1)

    def test_unrecorded_phases_remain_unknown_not_zero_or_elapsed(self):
        report = gate_profile.summarize([observation("push", 1)], 1)
        run = report["runs"][0]
        self.assertEqual(run["wall_s"], 1)
        self.assertIsNone(run["wait_s"])
        self.assertIsNone(run["setup_s"])
        self.assertIsNone(run["run_s"])
        self.assertEqual(report["status"], "PARTIAL")

    def test_zero_file_count_does_not_hide_missing_stage_phases(self):
        for file_count in (0, False, "0"):
            with self.subTest(file_count=file_count):
                records = [
                    observation("push", 1, timing={"wall_ms": 1500, "stages": {
                        "shell": {"wall_ms": 1000, "file_count": file_count,
                                  "phase_basis": "per-file-sum"},
                    }}, evidence={"complete": True, "files": [
                        {"path": "tests/a.sh", "complete": True, "wall_ms": 1000,
                         "wait_ms": 0, "setup_ms": 200, "run_ms": 800,
                         "phase_basis": "stage-queue+exec-marker"},
                    ]}),
                    observation("full", 1, timing={"wall_ms": 1500, "stages": {
                        "shell": {"wall_ms": 1000, "file_count": file_count,
                                  "phase_basis": "per-file-sum"},
                    }}, evidence={"complete": True, "files": [
                        {"path": "tests/a.sh", "complete": True, "wall_ms": 1000,
                         "wait_ms": 0, "setup_ms": 200, "run_ms": 800,
                         "phase_basis": "stage-queue+exec-marker"},
                    ]}),
                ]
                report = gate_profile.summarize(records, 1)
                self.assertEqual(report["status"], "PARTIAL")


    def test_empty_file_rows_keep_profile_partial(self):
        phase = {"wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800,
                 "phase_basis": "per-file-sum"}
        records = [
            observation(kind, 1, timing={"wall_ms": 1500, "stages": {"shell": phase}},
                        evidence={"complete": True, "files": []})
            for kind in ("push", "full")
        ]
        self.assertEqual(gate_profile.summarize(records, 1)["status"], "PARTIAL")

    def test_missing_phase_basis_is_unknown_without_issue(self):
        phase = {"wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800}
        records = [
            observation(kind, 1, timing={"wall_ms": 1500, "stages": {"shell": phase}},
                        evidence={"complete": True, "files": [
                            {"path": "tests/a.sh", "complete": True, **phase},
                        ]})
            for kind in ("push", "full")
        ]
        report = gate_profile.summarize(records, 1)
        self.assertEqual(report["status"], "PARTIAL")
        self.assertEqual(report["issues"], [])


    def test_inferred_stage_basis_keeps_profile_partial(self):
        phase = {"wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800}
        records = [
            observation(kind, 1, timing={"wall_ms": 1500, "stages": {
                "shell": {**phase, "phase_basis": "elapsed-minus-inferred"},
            }}, evidence={"complete": True, "files": [
                {"path": "tests/a.sh", "complete": True, **phase,
                 "phase_basis": "stage-queue+exec-marker"},
            ]})
            for kind in ("push", "full")
        ]
        report = gate_profile.summarize(records, 1)
        self.assertEqual(report["status"], "PARTIAL")
        self.assertIn("STAGE_PHASE_BASIS_INVALID", {issue["code"] for issue in report["issues"]})

    def test_inferred_file_basis_keeps_profile_partial(self):
        phase = {"wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800}
        records = [
            observation(kind, 1, timing={"wall_ms": 1500, "stages": {
                "shell": {**phase, "phase_basis": "per-file-sum"},
            }}, evidence={"complete": True, "files": [
                {"path": "tests/a.sh", "complete": True, **phase,
                 "phase_basis": "elapsed-minus-inferred"},
            ]})
            for kind in ("push", "full")
        ]
        report = gate_profile.summarize(records, 1)
        self.assertEqual(report["status"], "PARTIAL")
        self.assertIn("FILE_PHASE_BASIS_INVALID", {issue["code"] for issue in report["issues"]})


    def test_explicit_stage_and_file_phases_complete_without_top_level_phase_claims(self):
        phase = {"wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800}
        stage = {**phase, "phase_basis": "per-file-sum"}
        file = {**phase, "phase_basis": "stage-queue+exec-marker"}
        records = [
            observation("push", 1, timing={"wall_ms": 1500, "stages": {"shell": stage}},
                        evidence={"complete": True, "files": [
                            {"path": "tests/a.sh", "complete": True, **file},
                        ]}),
            observation("full", 1, timing={"wall_ms": 1500, "stages": {"shell": stage}},
                        evidence={"complete": True, "files": [
                            {"path": "tests/a.sh", "complete": True, **file},
                        ]}),
        ]
        report = gate_profile.summarize(records, 1)
        self.assertEqual(report["status"], "COMPLETE")
        self.assertEqual(report["phase_scope"], "stages-and-files")
        for run in report["runs"]:
            self.assertEqual((run["wait_s"], run["setup_s"], run["run_s"]), (None, None, None))
            self.assertEqual((run["stages"][0]["wait_s"], run["stages"][0]["setup_s"],
                              run["stages"][0]["run_s"]), (0, .2, .8))
        file = report["file_hotspots"][0]
        self.assertEqual((file["wait_s"], file["setup_s"], file["run_s"]), (0, .2, .8))

    def test_overlapping_stage_envelopes_are_not_summed_as_wall(self):
        timing = {"wall_ms": 10000, "stages": {
            "focused": {"wall_ms": 8000}, "bun": {"wall_ms": 7000}, "sh": {"wall_ms": 6000},
        }}
        report = gate_profile.summarize([observation("push", 1, timing=timing)], 1)
        self.assertEqual(report["runs"][0]["wall_s"], 10)
        self.assertEqual({x["name"]: x["wall_s"] for x in report["runs"][0]["stages"]},
                         {"focused": 8, "bun": 7, "sh": 6})

    def test_file_hotspots_use_median_and_keep_push_and_full_separate(self):
        records = []
        for kind, times in (("push", (100, 900, 200)), ("full", (8000, 6000, 7000))):
            for number, elapsed in enumerate(times, 1):
                records.append(observation(kind, number, evidence={"complete": True, "files": [
                    {"path": "tests/slow.test.sh", "runner": "sh", "elapsed_ms": elapsed},
                    {"path": "tests/fast.test.sh", "runner": "sh", "elapsed_ms": 10},
                ]}))
        report = gate_profile.summarize(records, 3)
        slow = {x["kind"]: x for x in report["file_hotspots"] if x["path"] == "tests/slow.test.sh"}
        self.assertEqual(slow["push"]["wall_s"], .2)
        self.assertEqual(slow["full"]["wall_s"], 7)
        self.assertEqual(slow["push"]["samples"], 3)
        self.assertIsNone(slow["push"]["setup_s"])

    def test_native_bun_file_timing_is_not_pure_test_execution(self):
        report = gate_profile.summarize([observation("push", 1, evidence={"complete": True, "files": [
            {"path": "tests/a.test.ts", "runner": "bun", "elapsed_ms": 1200, "native_timing_ms": 1000},
        ]})], 1)
        row = report["file_hotspots"][0]
        self.assertEqual(row["native_file_s"], 1)
        self.assertIsNone(row["run_s"])
        self.assertIsNone(row["setup_s"])

    def test_invalid_integrity_is_visible_but_never_ranked_as_a_hotspot(self):
        bad = observation("full", 2, evidence={"files": [{"path": "bad", "elapsed_ms": 999999}]})
        bad["integrity"] = "INVALID"
        report = gate_profile.summarize([observation("full", 1), bad], 2)
        self.assertEqual(report["runs"][0]["integrity"], "INVALID")
        self.assertEqual(report["file_hotspots"], [])
        self.assertEqual(report["status"], "PARTIAL")

    def test_reports_never_emit_recorded_commands_or_native_output(self):
        record = observation("push", 1, evidence={"complete": True, "files": [
            {"path": "tests/a", "elapsed_ms": 10, "command": ["secret-canary"]},
        ]}, native_output="secret-canary")
        self.assertNotIn("secret-canary", str(gate_profile.summarize([record], 1)))

    def test_missing_wall_cannot_make_explicit_phases_complete(self):
        timing = {"wait_ms": 0, "setup_ms": 200, "run_ms": 800}
        report = gate_profile.summarize([
            observation("push", 1, timing=timing), observation("full", 1, timing=timing),
        ], 1)
        self.assertEqual(report["status"], "PARTIAL")

    def test_incomplete_file_remains_a_partial_profile(self):
        timing = {"wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800}
        files = [{**timing, "path": "tests/a", "complete": False}]
        report = gate_profile.summarize([
            observation("push", 1, timing=timing, evidence={"complete": True, "files": files}),
            observation("full", 1, timing=timing),
        ], 1)
        self.assertEqual(report["status"], "PARTIAL")
        self.assertEqual(report["file_hotspots"][0]["incomplete_samples"], 1)

    def test_malformed_stage_container_is_visible_not_a_traceback(self):
        report = gate_profile.summarize([
            observation("push", 1, timing={"wall_ms": 1000, "stages": ["invalid"]}),
        ], 1)
        self.assertEqual(report["status"], "PARTIAL")
        self.assertIn("STAGE_TIMING_INVALID", [x["code"] for x in report["issues"]])

    def test_cli_uses_explicit_data_repo_and_keeps_missing_full_history_partial(self):
        with owned_tmp("gate-profile-cli") as directory:
            base = Path(directory)
            repo = base / "data"
            repo.mkdir()
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": directory,
                   "TMPDIR": directory, "XDG_STATE_HOME": str(base / "state"),
                   "FULL_SUITE_VERDICT_CACHE_DIR": str(base / "empty-store"),
                   "PYTHONDONTWRITEBYTECODE": "1"}
            init = run(["git", "init", "-q", "--template=", str(repo)],
                       cwd=ROOT, env=env, deadline_s=15)
            self.assertEqual(init.rc, 0, init.stderr.decode())
            ledger = repo / ".git/omp-kit/fresh-gate-runs.jsonl"
            ledger.parent.mkdir()
            value = observation("push", 1, timing={
                "wall_ms": 1000, "wait_ms": 0, "setup_ms": 200, "run_ms": 800,
            })["record"]
            append_jsonl(str(ledger), lambda _: value, deadline_s=5, state_dir=str(base / "locks"))
            cache = base / "empty-store"
            cache.mkdir()
            (cache / "inflight.running.123.log.files.123.json").write_text("{", encoding="utf-8")
            result = run([sys.executable, PROFILE_SCRIPT, "--repo", str(repo), "--runs", "1", "--json"],
                         cwd=ROOT, env=env, deadline_s=30)
            self.assertFalse(result.timed_out or result.truncated)
            self.assertEqual(result.rc, 3, result.stderr.decode())
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "PARTIAL")
            self.assertEqual(report["selected"], {"push": 1, "full": 0})
            self.assertEqual((report["runs"][0]["wait_s"], report["runs"][0]["setup_s"]), (0, .2))
            self.assertNotIn("FULL_RECORD_UNREADABLE", {issue["code"] for issue in report["issues"]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
