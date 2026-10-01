#!/bin/sh
# Refresh the generated verification footer in docs/native-omp.md.
# The version and date below are generated, never hand-typed: the docs check
# (tests/cli/docs.test.ts) fails if a version literal appears outside this block.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
DOC="$ROOT/docs/native-omp.md"
command -v omp >/dev/null 2>&1 || { echo 'docs-footer: omp is not on PATH' >&2; exit 3; }
OMP_VERSION=$(omp --version | sed 's#^omp/##')
STAMP_DATE=$(date -u +%F)
FOOTER="<!-- verified-ttsr-docs:start -->
Last verified against OMP $OMP_VERSION on $STAMP_DATE by \`bun test
tests/cli/docs.test.ts\`. Refresh with \`sh scripts/docs-footer.sh\`; the
scheduled compatibility workflow re-runs the same check against the
latest OMP every 3 hours.
<!-- verified-ttsr-docs:end -->"
python3 - "$DOC" "$FOOTER" <<'EOF'
import sys
path, footer = sys.argv[1], sys.argv[2]
start = "<!-- verified-ttsr-docs:start -->"
end = "<!-- verified-ttsr-docs:end -->"
text = open(path).read()
before, sep, rest = text.partition(start)
if not sep:
    raise SystemExit("docs-footer: start marker missing")
_, sep2, after = rest.partition(end)
if not sep2:
    raise SystemExit("docs-footer: end marker missing")
open(path, "w").write(before + footer + after)
EOF
echo "docs-footer: stamped $OMP_VERSION $STAMP_DATE in docs/native-omp.md"
