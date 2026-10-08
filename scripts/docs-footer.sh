#!/bin/sh
# Refresh the generated OMP compatibility footer in README.md and docs/native-omp.md.
# The minimum comes from scripts/omp-compat.json; the docs test guards both blocks.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
COMPAT="$ROOT/scripts/omp-compat.json"
README="$ROOT/README.md"
DOC="$ROOT/docs/native-omp.md"
command -v omp >/dev/null 2>&1 || { echo 'docs-footer: omp is not on PATH' >&2; exit 3; }
OMP_VERSION=$(omp --version | sed 's#^omp/##')
STAMP_DATE=$(date -u +%F)
python3 - "$COMPAT" "$README" "$DOC" "$OMP_VERSION" "$STAMP_DATE" <<'PY'
import json
import re
import sys

compat_path, readme_path, doc_path, omp_version, stamp_date = sys.argv[1:]
with open(compat_path, encoding="utf-8") as handle:
    compat = json.load(handle)
minimum = compat.get("minimum")
if not isinstance(minimum, str) or not re.fullmatch(r"\d+\.\d+\.\d+", minimum):
    raise SystemExit(f"docs-footer: invalid minimum OMP version in {compat_path}")

start = "<!-- verified-ttsr-docs:start -->"
end = "<!-- verified-ttsr-docs:end -->"
footer = (
    f"{start}\n"
    f"Minimum supported OMP: {minimum}.\n"
    f"Last verified against OMP {omp_version} on {stamp_date} by `bun test\n"
    "tests/cli/docs.test.ts`. Refresh with `sh scripts/docs-footer.sh`; the\n"
    "OMP certification workflow re-runs the same check against each new OMP\n"
    "release before it becomes the certified version.\n"
    f"{end}"
)
updates = []
for path in (readme_path, doc_path):
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    before, separator, rest = text.partition(start)
    if not separator:
        raise SystemExit(f"docs-footer: start marker missing in {path}")
    _, separator, after = rest.partition(end)
    if not separator:
        raise SystemExit(f"docs-footer: end marker missing in {path}")
    updates.append((path, before + footer + after))
for path, text in updates:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
PY
echo "docs-footer: stamped $OMP_VERSION $STAMP_DATE in README.md and docs/native-omp.md"
