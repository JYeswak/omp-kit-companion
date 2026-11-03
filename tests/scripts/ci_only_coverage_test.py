#!/usr/bin/env python3
"""CI-only exclusions cannot lose their execution owner or reuse a two-file PASS."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from kitlib_tmp import owned_tmp  # noqa: E402

spec = importlib.util.spec_from_file_location("ci_only_store", ROOT / "scripts/full-suite-verdict-store.py")
if spec is None or spec.loader is None:
    raise ImportError("cannot load full-suite-verdict-store.py")
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)

SPLIT_FILES = (
    "tests/cli/kit-update-nplus-two.test.ts",
    "tests/cli/kit-update-compiled.test.ts",
    "tests/cli/kit-update-relink.test.ts",
    "tests/cli/package-release-live.test.ts",
)
LEGACY_FILES = (("tests/cli/package-release.test.ts", 900), ("tests/cli/kit-update.test.ts", 2400))


class CiOnlyCoverage(unittest.TestCase):
    def test_every_excluded_ci_only_file_has_an_execution_owner(self) -> None:
        local = {path for path, _limit in store.CI_ONLY_FILES}
        github = store.CI_ONLY_GITHUB_ONLY
        self.assertEqual(set(github), {
            "tests/cli/external-live.test.ts", "tests/fleet-guard/reservations.live.test.ts",
        })
        self.assertTrue(all(reason.strip() for reason in github.values()))
        self.assertFalse(local & set(github))
        self.assertTrue(set(SPLIT_FILES) <= local, f"missing split execution owner: {sorted(set(SPLIT_FILES) - local)}")
        rows = (ROOT / "scripts/gate-ci-only.tsv").read_text().splitlines()[1:]
        excluded = {parts[0] for line in rows if (parts := line.split("\t"))[1] == "ci-only"}
        self.assertEqual(excluded, local | set(github))
        store.validate_ci_only_coverage(ROOT)

    def test_planted_missing_split_refuses_before_cache_lookup(self) -> None:
        for missing in SPLIT_FILES:
            with self.subTest(missing=missing):
                planted = tuple(row for row in store.CI_ONLY_FILES if row[0] != missing)
                with patch.object(store, "CI_ONLY_FILES", planted):
                    with self.assertRaises(ValueError) as caught:
                        store.ci_only_checks(ROOT, ROOT)
                self.assertIn("missing execution owner", str(caught.exception))
                self.assertIn(missing, str(caught.exception))

    def test_selection_changes_spec_checks_and_record_key(self) -> None:
        with owned_tmp("ci-only-selection") as tmp:
            suite = Path(tmp)
            manifest = suite / "scripts/gate-ci-only.tsv"
            manifest.parent.mkdir()
            lines = (ROOT / "scripts/gate-ci-only.tsv").read_text().splitlines()
            manifest.write_text("\n".join(lines) + "\n")
            for name, _limit in store.CI_ONLY_FILES:
                target = suite / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            current_spec = store.ci_only_spec()
            current_checks = store.ci_only_checks(ROOT, suite)
            legacy_paths = {name for name, _limit in LEGACY_FILES} | set(store.CI_ONLY_GITHUB_ONLY)
            manifest.write_text("\n".join([lines[0], *[
                line for line in lines[1:] if line.split("\t", 1)[0] in legacy_paths
            ]]) + "\n")
            with patch.object(store, "CI_ONLY_FILES", LEGACY_FILES):
                legacy_spec = store.ci_only_spec()
                legacy_checks = store.ci_only_checks(ROOT, suite)
            self.assertNotEqual(current_spec, legacy_spec)
            self.assertNotEqual(current_checks, legacy_checks)
            self.assertNotEqual(store.ci_only_key("a" * 40, current_checks, "fixture/runtime"),
                                store.ci_only_key("a" * 40, legacy_checks, "fixture/runtime"))
            print(f"CI_ONLY_CHECKS current={current_checks} legacy_selection={legacy_checks}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
