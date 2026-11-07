#!/usr/bin/env python3
"""Read-only release profile alignment. Seat lifecycle belongs to Tern and OMP."""
import argparse
import glob
import json
import os


def align_check(home, releases_root, version):
    expected = os.path.realpath(os.path.join(releases_root, version))
    links = [os.path.join(home, ".omp", "plugins", "node_modules", "omp-kit-companion")]
    links += sorted(glob.glob(os.path.join(home, ".omp", "profiles", "*", "plugins", "node_modules", "omp-kit-companion")))
    rows = [{"link": link, "target": os.readlink(link), "ok": os.path.realpath(link) == expected}
            for link in links if os.path.islink(link)]
    stale = [row for row in rows if not row["ok"]]
    return {"ok": bool(rows) and not stale and os.path.isdir(expected), "version": version,
            "expected": expected, "links": rows, "stale": stale,
            "why": "" if rows else "no plugin links found"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    align = sub.add_parser("align", help="read installed profile links; never restart a seat")
    align.add_argument("--home", default=os.path.expanduser("~"))
    align.add_argument("--releases", default=os.path.expanduser("~/.local/opt/omp-kit/releases"))
    align.add_argument("--version", required=True)
    args = parser.parse_args()
    report = align_check(args.home, args.releases, args.version)
    print(json.dumps(report))
    return 0 if report["ok"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
