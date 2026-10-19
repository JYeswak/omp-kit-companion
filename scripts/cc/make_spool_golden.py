"""Generate the cross-language golden for the TS spool writer (bead ompkit-fp72.120.16.11.3).

Emits `tests/fixtures/cc-spool-golden.jsonl`: one JSON object per line,
`{"producer", "key", "type", "time_ms", "observed_ms", "data", "line"}` where `line` is
`canonical(Spool.envelope(...))` from omp-kit `scripts/cc/cclib.py`. The bun test rebuilds
each envelope in TS and asserts byte-identical output. `observed_ms` is fixed so the
comparison is deterministic.

Stdlib only. Run from the companion repo root:
  python3 scripts/cc/make_spool_golden.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

COMPANION = Path(__file__).resolve().parents[2]
OMP_KIT = COMPANION.parent / "omp-kit"
sys.path.insert(0, str(OMP_KIT / "scripts" / "cc"))

from cclib import Registry, Spool, canonical  # noqa: E402

FIXTURES = [
    # nested data, non-ASCII target, integer 0
    ("kit", "verb:doctor:0001", "action.attempt", 1_769_000_000_000,
     {"action_id": "doctor", "surface": "cli", "target": "café —  naïve zürich", "idempotency_key": None}),
    ("kit", "verb:doctor:0001", "action.result", 1_769_000_001_500,
     {"action_id": "doctor", "outcome": "ok", "code": None, "duration_ms": 0}),
    ("hooks", "hook:pre-commit:0042", "action.attempt", 1_769_000_002_000,
     {"action_id": "precommit", "surface": "hook", "target": None, "idempotency_key": "k42"}),
    ("hooks", "hook:pre-commit:0042", "action.result", 1_769_000_002_250,
     {"action_id": "precommit", "outcome": "refused", "code": "SECRET_SHAPE", "duration_ms": 17}),
    ("kit", "tick:2026-10-19:0007", "source.tick", 1_769_000_003_000,
     {"instance": "seat-7", "records_seen": 120, "records_emitted": 118, "records_ignored": 2,
      "records_quarantined": 0, "complete_through_ms": 1_769_000_003_000, "position": 7,
      "error_code": None, "skew_ms": None,
      "coverage": [{"record_type": "action.attempt", "runtime_version": "v1", "disposition": "emitted",
                    "count": 118, "reason": None}]}),

]
OBSERVED_MS = 1_769_000_010_000


def main() -> None:
    registry = Registry()
    out = COMPANION / "tests" / "fixtures" / "cc-spool-golden.jsonl"
    with out.open("w", encoding="utf-8") as fh:
        for producer, key, type_, time_ms, data in FIXTURES:
            spool = Spool(producer, state=Path("/tmp/cc-spool-golden-unused"), registry=registry)
            env = spool.envelope(type_, data, key=key, time_ms=time_ms, observed_ms=OBSERVED_MS)
            fh.write(json.dumps({"producer": producer, "key": key, "type": type_, "time_ms": time_ms,
                                 "observed_ms": OBSERVED_MS, "data": data, "line": canonical(env)},
                                sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"wrote {out} ({len(FIXTURES)} fixtures)")


if __name__ == "__main__":
    main()
