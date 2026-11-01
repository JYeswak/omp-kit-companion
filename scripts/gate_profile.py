#!/usr/bin/env python3
"""GATESPEED1: rank retained gate costs; unrecorded phase durations remain UNKNOWN.

This is an opt-in measurement command, not a gate, cache writer or optimization.
It reuses the canonical verdict store and bounded JSONL reader. Runner envelopes
and their parent stages overlap: their durations must never be added as serial work.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
import runpy
from pathlib import Path
from statistics import median
import sys
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ac_phase
from kitlib_jsonl import JsonlError, read_jsonl

ROOT = Path(__file__).resolve().parents[1]
PHASES = ("wait_s", "setup_s", "run_s")


VERDICT_STORE = SimpleNamespace(**runpy.run_path(str(ROOT / "scripts/full-suite-verdict-store.py")))
SUITE_METRICS = VERDICT_STORE.load_metrics(ROOT)


def seconds(value: Any) -> float | None:
    return round(value / 1000, 6) if SUITE_METRICS.nonnegative(value) else None


def spans(value: dict) -> dict:
    return {
        "wall_s": seconds(value.get("wall_ms", value.get("elapsed_ms"))),
        "wait_s": seconds(value.get("wait_ms")),
        "setup_s": seconds(value.get("setup_ms")),
        "run_s": seconds(value.get("run_ms")),
    }


def ranked(groups: dict, label: str) -> list[dict]:
    result = []
    for (kind, role, name), samples in groups.items():
        row = {"kind": kind, "judge_role": role, label: name, "samples": len(samples)}
        for field in ("wall_s", *PHASES, "native_file_s"):
            values = [sample[field] for sample in samples if sample.get(field) is not None]
            row[field] = median(values) if values else None
            row[field + "_samples"] = len(values)
        row["run_ids"] = sorted({sample["run_id"] for sample in samples})
        row["incomplete_samples"] = sum(sample.get("complete") is False for sample in samples)
        result.append(row)
    return sorted(result, key=lambda row: (-(row["wall_s"] or 0), row["kind"], row[label]))


def summarize(observations: list[dict], runs: int, issues: list[dict] | None = None) -> dict:
    if runs < 1:
        raise ValueError("--runs must be positive")
    issues = list(issues or [])
    selected = []
    for kind in ("push", "full"):
        candidates = []
        for observation in observations:
            if observation["kind"] != kind:
                continue
            raw = observation["record"]
            at = raw.get("ts" if kind == "push" else "recorded_at")
            stamp = ac_phase.parse_ts(at)
            if stamp is None:
                issues.append({"source": observation["source"], "code": "RUN_TIMESTAMP_UNAVAILABLE"})
                continue
            candidates.append((stamp, observation["source"], observation))
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        selected.extend(item[2] for item in candidates[:runs])
    stage_groups, file_groups = defaultdict(list), defaultdict(list)
    rows = []
    phase_complete = not issues
    for run_index, observation in enumerate(selected):
        raw = observation["record"]
        timing = raw.get("timing") if isinstance(raw.get("timing"), dict) else {}
        evidence = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
        role = (raw.get("judge") or {}).get("role") if isinstance(raw.get("judge"), dict) else None
        kind, source = observation["kind"], observation["source"]
        run_id = f"{kind}:{run_index + 1}"
        row = {"id": run_id, "kind": kind, "source": source, "judge_role": role,
               "at": raw.get("ts" if kind == "push" else "recorded_at"),
               "commit": raw.get("commit"), "tree": raw.get("tree"), "rc": raw.get("rc"),
               "verdict": raw.get("verdict"), "integrity": observation["integrity"],
               "complete": evidence.get("complete"), **spans(timing), "stages": []}
        trusted = observation["integrity"] == "VALID"
        phase_complete &= trusted and evidence.get("complete") is True and all(row[key] is not None for key in ("wall_s", *PHASES))
        stages = timing.get("stages")
        if stages is not None and not isinstance(stages, dict):
            issues.append({"source": source, "code": "STAGE_TIMING_INVALID"})
            phase_complete = False
            stages = {}
        for name, value in (stages or {}).items():
            if not isinstance(value, dict):
                issues.append({"source": source, "code": "STAGE_TIMING_INVALID", "stage": name})
                phase_complete = False
                continue
            stage = {"name": name, **spans(value)}
            row["stages"].append(stage)
            phase_complete &= all(stage[key] is not None for key in ("wall_s", *PHASES))
            if trusted:
                stage_groups[kind, role, name].append({**stage, "run_id": run_id})
        files = evidence.get("files")
        row["file_count"] = len(files) if isinstance(files, list) else None
        phase_complete &= isinstance(files, list)
        for value in files if isinstance(files, list) else []:
            if not isinstance(value, dict) or not isinstance(value.get("path"), str):
                issues.append({"source": source, "code": "FILE_TIMING_INVALID"})
                phase_complete = False
                continue
            sample = {**spans(value), "run_id": run_id, "complete": value.get("complete"),
                      "native_file_s": seconds(value.get("native_timing_ms"))}
            phase_complete &= sample["complete"] is True and all(sample[key] is not None for key in ("wall_s", *PHASES))
            if trusted:
                file_groups[kind, role, value["path"]].append(sample)
        rows.append(row)
    counts = {kind: sum(row["kind"] == kind for row in rows) for kind in ("push", "full")}
    complete = phase_complete and all(value == runs for value in counts.values())
    return {
        "schema_version": 1, "advisory": True, "status": "COMPLETE" if complete else "PARTIAL",
        "requested_per_kind": runs, "selected": counts, "issues": issues,
        "runs": rows, "stage_hotspots": ranked(stage_groups, "name"), "file_hotspots": ranked(file_groups, "path"),
        "limitations": [
            "Push rows describe fresh-gate, not unrecorded publisher lock/queue time or the entire push pipeline.",
            "wait_s/setup_s/run_s require explicit producer measurements; missing is UNKNOWN, never zero or inferred from elapsed time.",
            "Bun native file timing includes fixture work and is not pure test execution or setup.",
            "Parent stages and runner envelopes overlap; do not sum them as serial wall time.",
            "These historical runs have different inputs, loads and judges; rankings are not a causal speedup or comparable benchmark.",
            "Cache-hit invocations and incomplete executions without retained records are not reconstructed.",
        ],
    }


def collect(repo: Path, runs: int) -> dict:
    store = VERDICT_STORE
    repo = store.repository_root(str(repo))
    git_dir = Path(store.text_output(store.checked_run(["git", "-C", str(repo), "rev-parse", "--absolute-git-dir"]), "git directory"))
    ledger = git_dir / "omp-kit/fresh-gate-runs.jsonl"
    window = read_jsonl(str(ledger), max_bytes=64 * 1024 * 1024)
    issues = [{"source": str(ledger), "code": error["reason"], "line": error["line"]} for error in window["errors"]]
    if window["missing"]:
        issues.append({"source": str(ledger), "code": "PUSH_HISTORY_MISSING"})
    if window["more"] or window["pending_tail_bytes"]:
        issues.append({"source": str(ledger), "code": "PUSH_HISTORY_INCOMPLETE", "pending_tail_bytes": window["pending_tail_bytes"]})
    observations = []
    # A bounded prefix is not the last N observations; refuse that selection rather than mislabel it.
    for index, raw in enumerate(window["rows"] if not window["more"] else []):
        if not isinstance(raw, dict):
            issues.append({"source": str(ledger), "code": "PUSH_RECORD_INVALID", "observation_index": index})
            continue
        observations.append({"kind": "push", "source": f"{ledger}#observation={index + 1}",
                             "integrity": "VALID", "record": raw})
    directory = store.cache_directory(repo, None)
    inventory = store.records(repo, directory, ROOT, None)
    for item in inventory["records"]:
        path = directory / item["record"]
        try:
            raw = store.json_file(path)
        except (OSError, UnicodeError, ValueError) as error:
            issues.append({"source": str(path), "code": "FULL_RECORD_UNREADABLE", "reason": str(error)})
            continue
        observations.append({"kind": "full", "source": str(path), "record": raw,
                             "integrity": item["integrity"]})
    report = summarize(observations, runs, issues)
    report["repo"] = str(repo)
    report["sources"] = {"push_ledger": str(ledger), "full_suite_store": str(directory)}
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--json", action="store_true", help="emit the complete structured profile")
    args = parser.parse_args()
    try:
        report = collect(args.repo, args.runs)
    except (OSError, UnicodeError, ValueError, JsonlError) as error:
        report = {"schema_version": 1, "status": "UNAVAILABLE", "issues": [{"code": "PROFILE_INPUT_UNAVAILABLE", "reason": str(error)}]}
    if args.json:
        print(json.dumps(report, sort_keys=True, allow_nan=False))
    else:
        print("Gate profile: " + report["status"])
        for row in report.get("file_hotspots", [])[:10]:
            phases = " ".join(key + "=" + (str(row[key]) if row[key] is not None else "UNKNOWN") for key in PHASES)
            print(f"{row['kind']} {row['path']} wall_s={row['wall_s']} {phases}")
        for issue in report["issues"]:
            print(json.dumps(issue, sort_keys=True))
    return 0 if report["status"] == "COMPLETE" else 3


if __name__ == "__main__":
    raise SystemExit(main())
