#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
exec python3 - "$ROOT" <<'PY'
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "scripts"))
from kitlib_run import run
from kitlib_tmp import owned_tmp


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> None:
    summary_pages = [
        [{"id": 41, "name": "non-immutable", "target": "tag", "enforcement": "active"}],
        [{"id": 42, "name": "immutable-v-tags", "target": "tag", "enforcement": "active"}],
    ]
    summary_flat = [item for page in summary_pages for item in page]
    earlier_invalid = {
        "id": 41, "target": "tag", "enforcement": "active",
        "conditions": {"ref_name": {"include": ["v*"], "exclude": []}},
        "rules": [{"type": "update"}],
    }
    valid = {
        "id": 42, "target": "tag", "enforcement": "active",
        "conditions": {"ref_name": {"include": ["v*"], "exclude": []}},
        "rules": [{"type": "deletion"}, {"type": "update"}],
    }
    cases = {
        "missing deletion": {
            **valid, "rules": [{"type": "update"}],
        },
        "missing update": {
            **valid, "rules": [{"type": "deletion"}],
        },
        "missing v* include": {
            **valid, "conditions": {"ref_name": {"include": ["release-*"], "exclude": []}},
        },
    }
    with owned_tmp("release-validate-tag") as work_s:
        work = Path(work_s)
        runner = work / "runner"
        runner.mkdir()
        validator = work / "validator.sh"
        source = (root / ".github/workflows/release.yml").read_text(encoding="utf-8")
        step = source.split("- name: Assert immutable v* tag ruleset\n", 1)[1]
        run_block = step.split("        run: |\n", 1)[1].split("\n      - ", 1)[0]
        validator.write_text(
            "\n".join(line[10:] for line in run_block.splitlines()) + "\n",
            encoding="utf-8",
        )
        gh = work / "gh"
        gh.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "args = sys.argv[1:]\n"
            "if args[-1].endswith('/rulesets?target=tag'):\n"
            "    print(json.dumps(json.load(open(os.environ['RULESET_PAGES'], encoding='utf-8'))))\n"
            "elif args[-1].endswith('/rulesets/41'):\n"
            "    print(json.dumps(json.load(open(os.environ['RULESET_DETAIL_41'], encoding='utf-8'))))\n"
            "elif args[-1].endswith('/rulesets/42'):\n"
            "    print(json.dumps(json.load(open(os.environ['RULESET_DETAIL_42'], encoding='utf-8'))))\n"
            "else:\n"
            "    print('unexpected gh api request: ' + repr(args), file=sys.stderr); sys.exit(90)\n",
            encoding="utf-8",
        )
        gh.chmod(0o755)
        pages_path = work / "pages.json"
        summary_path = work / "summary-flat.json"
        detail_41_path = work / "detail-41.json"
        detail_42_path = work / "detail-42.json"
        write_json(pages_path, summary_pages)
        write_json(summary_path, summary_flat)
        write_json(detail_41_path, earlier_invalid)
        write_json(detail_42_path, valid)
        env = {
            **os.environ,
            "PATH": f"{work}:{os.environ.get('PATH', '')}",
            "GITHUB_REPOSITORY": "example/project",
            "RUNNER_TEMP": str(runner),
            "RULESET_PAGES": str(pages_path),
            "RULESET_DETAIL_41": str(detail_41_path),
            "RULESET_DETAIL_42": str(detail_42_path),
        }

        def execute(script: Path, environment: dict[str, str]):
            result = run(["bash", str(script)], cwd=root, env=environment, deadline_s=30)
            if result.timed_out or result.truncated:
                raise AssertionError(f"validator run incomplete: timeout={result.timed_out} truncated={result.truncated}")
            return result

        positive = execute(validator, env)
        if positive.rc != 0:
            raise AssertionError(f"valid detail rejected: rc={positive.rc}; stderr={positive.stderr.decode(errors='replace')}")

        old_summary_filter = (
            "any(.[]?; .enforcement == \"active\" "
            "and (any(.rules[]?.type; . == \"deletion\")) "
            "and (any(.rules[]?.type; . == \"update\")) "
            "and any(.conditions.ref_name.include[]?; . == \"v*\" or . == \"refs/tags/v*\"))"
        )
        control = run(
            ["jq", "-e", old_summary_filter, str(summary_path)],
            cwd=root, env=env, deadline_s=30,
        )
        if (control.timed_out or control.truncated or control.rc != 1
                or control.stdout.strip() != b"false" or control.stderr):
            raise AssertionError(
                f"old summary-only control must return false (rc=1), not a type error: "
                f"rc={control.rc}; stdout={control.stdout!r}; stderr={control.stderr!r}"
            )

        expected_stderr = "active immutable v* tag ruleset is required"
        for label, detail in cases.items():
            write_json(detail_42_path, detail)
            rejected = execute(validator, env)
            stderr = rejected.stderr.decode(errors="replace")
            if rejected.rc != 4 or expected_stderr not in stderr:
                raise AssertionError(
                    f"{label}: expected rc=4 and {expected_stderr!r}; "
                    f"got rc={rejected.rc}, stderr={stderr!r}"
                )
    print(
        "PASS release tag ruleset validator: 1 valid detail, 1 old summary-only "
        "negative control, and 3 named rc=4 rejections (unit fixtures; not live GitHub proof)"
    )
    print(f"{len(cases) + 2} pass 0 fail")


main()
PY
