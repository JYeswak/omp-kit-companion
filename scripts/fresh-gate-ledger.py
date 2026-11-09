#!/usr/bin/env python3
"""Canonical fresh-gate version-2 observation writer (shared by declared repo gates)."""
import hashlib, json, math, os, time
from datetime import datetime, timezone
from pathlib import Path
rows_path = Path(os.environ["METRICS"]) if os.environ["METRICS"] else None
rows = json.loads(rows_path.read_text()) if rows_path and rows_path.is_file() else []
declared_path = Path(os.environ["DECLARED"]) if os.environ["DECLARED"] else None
declared = declared_path.read_text().splitlines() if declared_path and declared_path.is_file() else []
stages = {}
for runner in ("bun", "sh", "python3"):
    selected = [row for row in rows if row["runner"] == runner]
    def phase_total(field):
        values = [row.get(field) for row in selected]
        if not values:
            return 0
        if any(not isinstance(value, (int, float)) or isinstance(value, bool)
               or not math.isfinite(value) or value < 0 for value in values):
            return None
        return sum(values)
    stages[runner] = {
        "wall_ms": max(row["finished_ms"] for row in selected) - min(row["started_ms"] for row in selected) if selected else 0,
        "wait_ms": phase_total("wait_ms"),
        "setup_ms": phase_total("setup_ms"),
        "run_ms": phase_total("run_ms"),
        "file_count": len(selected),
        "phase_basis": "per-file-sum",
        "cpu_user_ms": sum(row["cpu_user_ms"] for row in selected),
        "cpu_system_ms": sum(row["cpu_system_ms"] for row in selected),
    }
phase_path = Path(os.environ["GATE_PHASES"])
if phase_path.is_file():
    for line in phase_path.read_text().splitlines():
        phase = json.loads(line)
        stages[phase["stage"]] = {key: phase[key] for key in
                                  ("wall_ms", "wait_ms", "setup_ms", "run_ms", "phase_basis", "rc")}
work_dir = Path(os.environ["WORKDIR"])
for phase_path in work_dir.glob("*.admission.json"):
    phase = json.loads(phase_path.read_text())
    stages[phase["stage"]] = {key: phase[key] for key in
                              ("wall_ms", "wait_ms", "setup_ms", "run_ms", "phase_basis", "rc")}
end = time.time_ns() // 1000000
start = int(os.environ["START_MS"])
entry = {"version": 2, "ts": datetime.now(timezone.utc).isoformat(),
         "commit": os.environ["RUN_COMMIT"], "base": os.environ["RUN_BASE"],
         "changed": len(os.environ["RUN_CHANGED"].splitlines()),
         "selected_files": int(os.environ["RUN_FILES"]), "tests_ran": int(os.environ["RUN_TESTS"]),
         "rc": int(os.environ["RUN_RC"]),
         "judge": {"sha256": os.environ["JUDGE_ID"] or hashlib.sha256(Path(os.environ["JUDGE"]).read_bytes()).hexdigest(),
                   "scope": "focused" if os.environ["JUDGE_ID"] else "standalone-fixture"},
         "timing": {"wall_ms": end - start if start else None, "started_ms": start or None,
                    "load_start": json.loads(os.environ["LOAD_START"]), "load_end": list(os.getloadavg()),
                    "workers": {"bun": int(os.environ["WORKER_COUNT"]), "scripts": int(any(row["runner"] != "bun" for row in rows))}, "stages": stages},
         "evidence": {"complete": bool(declared) and len(rows) == len(declared) and all(row["complete"] for row in rows),
                      "declared_files": declared, "files": rows}}
line = json.dumps(entry, allow_nan=False)
print("FRESH-GATE: measured-verdict " + line)
if os.environ["LEDGER"]:
    ledger = Path(os.environ["LEDGER"])
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a") as handle:
        handle.write(line + "\n")
