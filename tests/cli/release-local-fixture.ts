// Shared production-stage slices for the release-local suites.
// Both release-local.test.ts and release-local-install.test.ts execute these
// exact shell stages; they live here so the two files stay under budget.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

// Execute the production shell stages with real curl/checksums and only the
// GitHub transport redirected to a loopback server. No signing or remote writes.
const localScript = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
function releaseStage(start: string, end: string): string {
	const first = localScript.indexOf(start);
	const last = localScript.indexOf(end, first + start.length);
	if (first < 0 || last < 0) throw new Error(`release stage boundary missing: ${start} / ${end}`);
	return localScript.slice(first, last);
}
const helperScript = releaseStage("bounded() {", "# ---------------------------------------------------------------------------------------------- 1. preflight");
const downloadStage = releaseStage("stage verify\n", "substep verify.archive-chains");
const attestStage = releaseStage("stage attest\n", "# -------------------------------------------------------------------------------------------------- 8. verify");
const stagePrelude = `set -euo pipefail
die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
WORK=$1; DIST="$WORK/dist"; VERSION=0.0.0; REPO=fixture/release
DARWIN="omp-kit-v$VERSION-darwin-arm64-none.tar.gz"
STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"
${helperScript}`;

export { attestStage, downloadStage, helperScript, releaseStage, stagePrelude };
