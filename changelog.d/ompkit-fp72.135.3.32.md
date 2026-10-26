### Added

- `python3 -B scripts/bead_lint.py --bead ID --repo DIR [--json]` lints one bead from the live tracker before a claim. It reads with `br show` and `br list` (no flush, no tracker write), runs the same checks as the create and update gates, prints PASS or FAIL with the failing check names (or UNVERIFIED with the reason), and exits 0, 1, or 3 when the tracker cannot be read; `--json` prints the verdict as JSON instead. Dependency records in `br show` shape are normalized, so a bead that mentions another bead and holds an edge to it passes. (ompkit-fp72.135.3.32)
