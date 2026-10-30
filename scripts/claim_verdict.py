#!/usr/bin/env python3
"""Decode the real native claim authority's bounded verdict for br-shim."""
from __future__ import annotations

import json
import sys

from pysafe import OK, read_stdin, run_main


def main() -> int:
    outcome, raw, truncated = read_stdin(timeout=5.0, cap_bytes=4 * 1024 * 1024)
    if outcome != OK or truncated:
        raise ValueError("claim authority exceeded its input bounds")
    doc = json.loads(raw.decode("utf-8"))
    data = doc.get("data", doc) if isinstance(doc, dict) else None
    if not isinstance(data, dict) or data.get("act") != "claim" or data.get("target") != sys.argv[1]:
        raise ValueError("claim authority returned the wrong target")
    findings = data.get("findings")
    if not isinstance(findings, list) or not all(isinstance(f, dict) and isinstance(f.get("code"), str) and isinstance(f.get("blocking"), bool) and isinstance(f.get("detail"), str) and isinstance(f.get("remedy"), str) for f in findings):
        raise ValueError("claim authority returned incomplete findings")
    cut_codes = {"CLAIM_CUT_ADMITTED", "CLAIM_OUT_OF_CUT", "CLAIM_CUT_UNKNOWN"}
    cut = [f for f in findings if f["code"] in cut_codes]
    if len(cut) != 1 or cut[0]["blocking"] != (cut[0]["code"] != "CLAIM_CUT_ADMITTED"):
        raise ValueError("claim authority did not return one consistent cut adjudication")
    blocked = [f for f in findings if f["blocking"]]
    if blocked:
        for f in blocked:
            code = "BR_SHIM_NEEDS_DIRECTOR" if f["code"] == "NEEDS_DIRECTOR" else f["code"]
            print(code + ": " + f["detail"] + "; remedy: " + f["remedy"])
    elif int(sys.argv[2]) != 0 or doc.get("ok") is not True:
        raise ValueError("claim authority failed without a refusal")
    else:
        print("PASS")
    return 0


if __name__ == "__main__":
    run_main(main)
