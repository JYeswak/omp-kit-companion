#!/usr/bin/env python3
"""receipt.py — content-addressed evidence receipts (omp-kit Layer 0).

Contract: canonical JSON receipts whose verifier re-applies the signing-time
value-domain constraints.

A receipt binds {operation, params, result-ref, confidence, authority,
limitations[]} into a canonical JSON record whose id is
`ev_ + sha256(canonical semantic projection)`. Verify recomputes the id
AND re-applies the sign-time domain predicate — a hand-forged
out-of-domain record with a self-consistent id is REFUSED.

CLI:
  receipt.py sign   --producer ID --operation NAME [--param k=v]...
                     (--result-sha256 HEX --result-bytes N | --result-ref-json JSON)
                     [--confidence observed|derived|inferred]
                     [--authority test|selftest|live|pending]
                     [--limitation TEXT]... [--out PATH]
  receipt.py verify <receipt.json>     # exit 0 valid; exit 1 + named field on drift
  receipt.py selftest                  # R1-R7; exit 0 iff every negative fired

Canonical form: json.dumps(sort_keys=True, separators=(',',':'),
ensure_ascii=False).encode('utf-8'). Receipts are domain-restricted (see
check_domain): floats must repr as plain decimals, ints within ±(2^53-1),
object keys BMP-only, no lone surrogates.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

CONFIDENCES = ("observed", "derived", "inferred")
AUTHORITIES = ("test", "selftest", "live", "pending")
MAX_INT = 2**53 - 1
HEX64 = re.compile(r"^[0-9a-f]{64}$")
MAX_RECEIPT_BYTES = 1 << 20

# Float spellings outside the canonical plain-decimal form.
PLAIN_FLOAT = re.compile(r"^-?(0|[1-9]\d*)(\.\d*[1-9])?$")


class DomainError(ValueError):
    """A value outside the receipt domain (sign refuses; verify refuses)."""


def _check_key(key: str, path: str) -> None:
    if not isinstance(key, str):
        raise DomainError(f"{path}: non-string key")
    if any(ord(ch) > 0xFFFF for ch in key):
        raise DomainError(f"{path}: astral-plane key (EM-P1: ordering diverges cross-runtime)")
    for ch in key:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            raise DomainError(f"{path}: lone surrogate in key (EM-P1: unencodable)")


def _check_value(value, path: str) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, int):
        if abs(value) > MAX_INT:
            raise DomainError(f"{path}: |int| >= 2^53 (EM-P4: serializers diverge)")
        return
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise DomainError(f"{path}: NaN/Inf not serializable")
        text = repr(value)
        if not PLAIN_FLOAT.match(text):
            raise DomainError(
                f"{path}: float {text!r} is not JCS-plain (EM-P4: '1.0'/'-0.0'/'1e-07' diverge)"
            )
        return
    if isinstance(value, str):
        for ch in value:
            if 0xD800 <= ord(ch) <= 0xDFFF:
                raise DomainError(f"{path}: lone surrogate in string (EM-P1: unencodable)")
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            _check_value(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            _check_key(k, path)
            _check_value(v, f"{path}.{k}")
        return
    raise DomainError(f"{path}: unsupported type {type(value).__name__}")


def check_domain(obj) -> None:
    """Apply the receipt domain at sign and verify time."""
    _check_value(obj, "$")


def canonical_bytes(record: dict) -> bytes:
    return json.dumps(
        record, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def compute_id(record: dict) -> str:
    projection = {k: v for k, v in record.items() if k != "evidence_id"}
    return "ev_" + hashlib.sha256(canonical_bytes(projection)).hexdigest()


def _artifact():
    # kitlib_artifact ships beside this file. A bare json.loads accepts NaN and keeps the LAST of duplicate keys, so a
    # receipt could show one confidence to a reader and hash another; strict_json refuses both (KL10, ompkit-gvp4j).
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import kitlib_artifact
    return kitlib_artifact


def sign(args) -> int:
    kitlib_artifact = _artifact()
    params = {}
    for kv in args.param or []:
        if "=" not in kv:
            print(f"sign refused: --param {kv!r} is not k=v", file=sys.stderr)
            return 2
        k, _, v = kv.partition("=")
        params[k] = v
    if args.result_sha256 or args.result_bytes:
        if not (args.result_sha256 and args.result_bytes):
            print("sign refused: --result-sha256 and --result-bytes go together", file=sys.stderr)
            return 2
        if not HEX64.match(args.result_sha256):
            print("sign refused: --result-sha256 must be 64 lowercase hex", file=sys.stderr)
            return 2
        result_ref = {"sha256": args.result_sha256, "bytes": args.result_bytes}
    elif args.result_ref_json:
        try:
            result_ref = kitlib_artifact.strict_json(args.result_ref_json.encode("utf-8", "surrogatepass"),
                                                     path="--result-ref-json")
        except kitlib_artifact.ArtifactError as exc:
            print(f"sign refused: --result-ref-json is not strict JSON ({exc})", file=sys.stderr)
            return 2
    else:
        print("sign refused: --result-sha256/--result-bytes or --result-ref-json required", file=sys.stderr)
        return 2

    record = {
        "producer": args.producer,
        "operation": args.operation,
        "parameters": params,
        "result_ref": result_ref,
        "confidence": args.confidence,
        "authority": args.authority,
        "limitations": list(args.limitation or []),
    }
    try:
        check_domain(record)
    except DomainError as exc:
        print(f"sign refused: {exc}", file=sys.stderr)
        return 2
    record["evidence_id"] = compute_id(record)
    text = json.dumps(record, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    # Refuse, before writing anything, a receipt verify would refuse: verify reads at most MAX_RECEIPT_BYTES and
    # parses strictly (nesting depth included), so check those exact bytes the same way.
    data = text.encode("utf-8")
    if len(data) > MAX_RECEIPT_BYTES:
        print(f"sign refused: receipt is {len(data)} bytes; verify reads at most {MAX_RECEIPT_BYTES}", file=sys.stderr)
        return 2
    try:
        kitlib_artifact.strict_json(data, path=args.out or "<stdout>")
    except kitlib_artifact.ArtifactError as exc:
        print(f"sign refused: verify could not read this receipt ({exc})", file=sys.stderr)
        return 2
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


def verify(path: str) -> int:
    kitlib_artifact = _artifact()
    try:
        real = os.path.realpath(path)
        art = kitlib_artifact.read_local_artifact(real, allowed_root=os.path.dirname(real), max_bytes=MAX_RECEIPT_BYTES,
                                                  file_policy={"symlinks": "refuse", "hardlinks": "allow"})
        record = kitlib_artifact.strict_json(art["bytes"], path=path)
    except kitlib_artifact.ArtifactError as exc:
        print(f"verify REFUSE: unreadable receipt ({exc})", file=sys.stderr)
        return 1
    if not isinstance(record, dict) or "evidence_id" not in record:
        print("verify REFUSE: $.evidence_id missing", file=sys.stderr)
        return 1
    try:
        check_domain(record)
    except DomainError as exc:
        print(f"verify REFUSE: $ domain — {exc}", file=sys.stderr)
        return 1
    actual = compute_id(record)
    if actual != record["evidence_id"]:
        print(
            f"verify REFUSE: $.evidence_id — semantic identifier does not match "
            f"its record (computed {actual[:16]}…, stored {record['evidence_id'][:16]}…)",
            file=sys.stderr,
        )
        return 1
    print(f"verify OK {record['evidence_id']}")
    return 0


def _write_receipt(path, **fields) -> None:
    record = {
        "producer": fields.get("producer", "selftest"),
        "operation": fields.get("operation", "test.op"),
        "parameters": fields.get("parameters", {}),
        "result_ref": fields.get(
            "result_ref", {"sha256": "a" * 64, "bytes": 10}
        ),
        "confidence": fields.get("confidence", "observed"),
        "authority": fields.get("authority", "test"),
        "limitations": fields.get("limitations", []),
    }
    record["evidence_id"] = compute_id(record)
    Path(path).write_text(
        json.dumps(record, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def selftest() -> int:
    failures = []
    # kitlib_tmp ships beside this file; only the selftest needs a temp dir, so sign/verify never import it.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from kitlib_tmp import owned_tmp

    with owned_tmp("receipt-selftest") as tmp:
        tmp = Path(tmp)
        good = tmp / "good.receipt.json"

        # R1 determinism: same input -> byte-identical receipt, twice.
        _write_receipt(good)
        first = good.read_bytes()
        _write_receipt(good)
        if good.read_bytes() != first:
            failures.append("R1: same input produced different receipt bytes")

        # R2 content flip -> verify fails, field named.
        _write_receipt(good)
        rec = json.loads(good.read_text())
        rec["result_ref"]["sha256"] = ("b" if rec["result_ref"]["sha256"][0] != "b" else "c") * 63 + "1"
        good.write_text(json.dumps(rec, indent=1, sort_keys=True))
        if _verify_quiet(str(good)) != 1:
            failures.append("R2: tampered result_ref verified OK")

        # R3 limitations strip -> verify fails (honest-gaps envelope).
        _write_receipt(good, limitations=["measured on 3 cases"])
        rec = json.loads(good.read_text())
        rec["limitations"] = []
        good.write_text(json.dumps(rec, indent=1, sort_keys=True))
        if _verify_quiet(str(good)) != 1:
            failures.append("R3: stripped limitations verified OK")

        # R4 confidence flip -> verify fails.
        _write_receipt(good)
        rec = json.loads(good.read_text())
        rec["confidence"] = "inferred"
        good.write_text(json.dumps(rec, indent=1, sort_keys=True))
        if _verify_quiet(str(good)) != 1:
            failures.append("R4: confidence flip verified OK")

        # R5 enum refusal at sign time.
        if _sign_quiet(["--producer", "t", "--operation", "op",
                        "--result-ref-json", '{"sha256": "' + "a"*64 + '", "bytes": 1}',
                        "--confidence", "bogus"]) != 2:
            failures.append("R5: bogus confidence accepted at sign")

        # R6 (composition): reaching here with no failure IS the R6 pass.

        # R7 domain check: out-of-domain records refuse at verify even with
        # a forged self-consistent id.
        bad_float = tmp / "bad-float.json"
        bad = {
            "producer": "t", "operation": "op",
            "parameters": {"score": 1.0},
            "result_ref": {"sha256": "a" * 64, "bytes": 1},
            "confidence": "observed", "authority": "test",
            "limitations": [],
        }
        bad["evidence_id"] = compute_id(bad)
        bad_float.write_text(json.dumps(bad, indent=1, sort_keys=True))
        if _verify_quiet(str(bad_float)) != 1:
            failures.append("R7a: out-of-domain float with forged id verified OK (V2Adv-4 hole)")

        big_int = tmp / "bad-int.json"
        _write_receipt(big_int, parameters={"n": 2**53})
        if _verify_quiet(str(big_int)) != 1:
            failures.append("R7b: 2^53 parameter verified OK")

        astral = tmp / "bad-key.json"
        _write_receipt(astral, parameters={"\U00010000key": 1})
        if _verify_quiet(str(astral)) != 1:
            failures.append("R7c: astral-plane key verified OK")

        # Clean in-domain payload passes end-to-end.
        _write_receipt(good, parameters={"timeout_ms": 30, "ratio": "0.5"}, limitations=["3-case sample"])
        if _verify_quiet(str(good)) != 0:
            failures.append("R7d: clean in-domain payload failed verify")

        # R8 duplicate key: the file shows confidence "observed" first, the parsed (last-wins) record says "inferred"
        # and carries a self-consistent id. A reader and the verifier would disagree, so verify must refuse.
        dup = tmp / "dup-key.json"
        rec = {"producer": "t", "operation": "op", "parameters": {}, "result_ref": {"sha256": "a" * 64, "bytes": 1},
               "confidence": "inferred", "authority": "test", "limitations": []}
        rec["evidence_id"] = compute_id(rec)
        body = json.dumps(rec, indent=1, sort_keys=True)
        dup.write_text(body.replace('"confidence": "inferred"', '"confidence": "observed",\n "confidence": "inferred"', 1))
        if _verify_quiet(str(dup)) != 1:
            failures.append("R8: a duplicate-key receipt (shown and hashed values differ) verified OK")

        # R9 non-finite number: NaN is not JSON; a receipt carrying it is refused at read, not coerced.
        nan = tmp / "nan.json"
        nan.write_text(good.read_text().replace('"timeout_ms": 30', '"timeout_ms": NaN', 1))
        if _verify_quiet(str(nan)) != 1:
            failures.append("R9: a NaN receipt verified OK")

    if failures:
        for f in failures:
            print(f"selftest FAIL: {f}", file=sys.stderr)
        return 1
    print("selftest PASS: R1-R9 all green (negatives fired, determinism held)")
    return 0


def _verify_quiet(path: str) -> int:
    import io, contextlib
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            return verify(path)
    except Exception:
        return 1


def _sign_quiet(argv: list[str]) -> int:
    import io, contextlib
    ap = _build_parser()
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            args = ap.parse_args(["sign"] + argv)
            return sign(args)
    except (Exception, SystemExit):
        return 2


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="receipt.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sign")
    s.add_argument("--producer", required=True)
    s.add_argument("--operation", required=True)
    s.add_argument("--param", action="append")
    s.add_argument("--result-sha256")
    s.add_argument("--result-bytes", type=int)
    s.add_argument("--result-ref-json")
    s.add_argument("--confidence", default="observed", choices=CONFIDENCES)
    s.add_argument("--authority", default="test", choices=AUTHORITIES)
    s.add_argument("--limitation", action="append")
    s.add_argument("--out")
    s.set_defaults(func=sign)

    v = sub.add_parser("verify")
    v.add_argument("receipt")
    v.set_defaults(func=lambda a: verify(a.receipt))

    t = sub.add_parser("selftest")
    t.set_defaults(func=lambda a: selftest())
    return ap


def main() -> int:
    args = _build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
