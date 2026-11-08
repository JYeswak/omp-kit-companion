#!/usr/bin/env python3
"""Verify public release archives with three independent, bounded consumer chains."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import sys
import threading
import time

from kitlib_run import run
import pysafe


def verify_archive(public: Path, platform: str, version: str, repo: str,
                   installer: str, cancelled: threading.Event) -> tuple[bool, str, str]:
    archive = public / f"omp-kit-v{version}-{platform}.tar.gz"
    output: list[str] = []
    errors: list[str] = []

    def step(name: str, argv: list[str], deadline: int, cap: int):
        started = time.monotonic()
        result = run(argv, deadline_s=deadline, max_output_bytes=cap)
        output.append(f"== substep verify.{name}.{platform} took {time.monotonic() - started:.3f}s\n")
        errors.append(result.stderr.decode(errors="replace"))
        return result

    try:
        digest = hashlib.sha256()
        with archive.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        sha256 = digest.hexdigest()
        if cancelled.is_set():
            return False, "", "archive verification cancelled\n"
        fetched = step("attestation-fetch", ["gh", "api", "--hostname", "github.com",
                       f"repos/{repo}/attestations/sha256:{sha256}", "--jq",
                       ".attestations[].bundle | tojson"], 120, 16 * 1024 * 1024)
        if fetched.rc != 0 or fetched.timed_out or fetched.truncated or not fetched.stdout.strip():
            errors.append(f"no attestation bundle for {platform} ({sha256})\n")
            return False, "".join(output), "".join(errors)
        Path(str(archive) + ".sigstore.json").write_bytes(fetched.stdout)
        if cancelled.is_set():
            return False, "".join(output), "archive verification cancelled\n"
        verified = step("installer-verifier", [sys.executable, "-I", "-c", installer,
                        "attestation", str(archive), version, "unused"], 180, 1024 * 1024)
        output.append(verified.stdout.decode(errors="replace"))
        if verified.rc != 0 or verified.timed_out or verified.truncated:
            errors.append(f"the consumer verifier refuses {platform}\n")
            return False, "".join(output), "".join(errors)
        output.append(f"CONSUMER_VERIFY=ok platform={platform} sha256={sha256}\n")
        return True, "".join(output), "".join(errors)
    except (OSError, ValueError) as exc:
        errors.append(f"public verification failed for {platform}: {exc}\n")
        return False, "".join(output), "".join(errors)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("platforms", nargs="+")
    args = parser.parse_args()
    installer = (args.source / "installer/install.py").read_text()
    cancelled = threading.Event()
    # One chain per archive/bundle. Joining in ship order keeps logs deterministic;
    # every result is consumed and any nonzero exit, timeout or truncation refuses.
    with ThreadPoolExecutor(max_workers=3) as pool:
        with pysafe.cancel_on_signals():
            futures = [pool.submit(verify_archive, args.public, platform, args.version,
                                   args.repo, installer, cancelled) for platform in args.platforms]
            try:
                results = [future.result(timeout=310) for future in futures]
            except BaseException:
                cancelled.set()
                for future in futures:
                    future.cancel()
                pysafe.kill_live_groups()
                raise
    for _, output, errors in results:
        sys.stdout.write(output)
        sys.stderr.write(errors)
    return 0 if all(ok for ok, _, _ in results) else 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except pysafe.Cancelled as exc:
        sys.exit(128 + exc.signum)
