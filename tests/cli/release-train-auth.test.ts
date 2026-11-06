import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

const train = join(import.meta.dir, "../../scripts/release-train.sh");

// Only GitHub authentication/run inventory is simulated; the wait command is real.
for (const credential of ["missing", "GH_TOKEN", "GITHUB_TOKEN", "stored"] as const) {
	test(`wait-release-idle: ${credential} credentials`, () => {
		const scratch = ownedTmp("release-train-auth");
		try {
			const gh = join(scratch.path, "gh");
			const calls = join(scratch.path, "calls");
			writeFileSync(calls, "");
			writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$*" >> "$AUTH_CALLS"
case "$1 $2" in
"auth status") test "$STORED_AUTH" = true ;;
"run list") printf '0\\n' ;;
*) exit 99 ;;
esac
`, { mode: 0o700 });
			const result = runFixture(["sh", train, "wait-release-idle", "--repo", "fixture/release"], {
				cwd: scratch.path,
				env: { ...process.env, GH_BIN: gh, GH_TOKEN: credential === "GH_TOKEN" ? "fixture-only" : "",
					GITHUB_TOKEN: credential === "GITHUB_TOKEN" ? "fixture-only" : "",
					STORED_AUTH: String(credential === "stored"), AUTH_CALLS: calls },
			});
			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);
			if (credential === "missing") {
				expect(result.rc).toBe(4);
				expect(stderr).toContain("REFUSED: missing-github-token");
				expect(stdout).not.toContain("RELEASE=idle");
				expect(readFileSync(calls, "utf8")).not.toContain("run list");
			} else {
				expect(result.rc, stderr).toBe(0);
				expect(stdout).toBe("RELEASE=idle\n");
				expect(readFileSync(calls, "utf8")).toContain("--status in_progress");
				expect(readFileSync(calls, "utf8")).toContain("--status queued");
			}
		} finally {
			scratch.cleanup();
		}
	});
}
