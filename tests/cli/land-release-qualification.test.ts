// Coverage: src/land.ts.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleReleaseQualification } from "../../src/land.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

// AUTOCUTVERDICT1 (ompkit-hbt6q): a land publishes from a private checkout that has no hook chain, so it schedules the
// release qualification itself. The starter is a stub that records its argv, so no suite and no waiting is involved.
afterAll(cleanupAllOwnedTmp);

function fixtureRepo(withScripts: boolean): { repo: string; marker: string; log: string } {
	const repo = ownedTmp("land-release-qualification").path;
	const git = runSync(["git", "-C", repo, "init", "-q"], { deadline_s: fixtureDeadlineS(10) });
	expect(git.rc).toBe(0);
	const marker = join(repo, "starter-argv.txt");
	if (withScripts) {
		mkdirSync(join(repo, "scripts"), { recursive: true });
		writeFileSync(join(repo, "scripts/release-verdict.sh"), "#!/bin/sh\nexit 0\n");
		writeFileSync(join(repo, "scripts/release-verdict-start.py"), `#!/usr/bin/env python3\nimport sys\nopen(${JSON.stringify(marker)}, "w").write("\\n".join(sys.argv[1:]))\nprint("starter ran for " + sys.argv[2], flush=True)\n`, { mode: 0o755 });
	}
	return { repo, marker, log: join(repo, ".git/omp-kit/release-verdict.log") };
}

test("AUTOCUTVERDICT1: a published land schedules the qualification child for the pushed sha and logs to the release-verdict log", () => {
	const { repo, marker, log } = fixtureRepo(true);
	const sha = "0123456789abcdef0123456789abcdef01234567";
	expect(scheduleReleaseQualification(repo, sha, {})).toBe("SCHEDULED");
	expect(readFileSync(marker, "utf8")).toBe(`${repo}\n${sha}`);
	expect(readFileSync(log, "utf8")).toContain(`starter ran for ${sha}`);
});

test("AUTOCUTVERDICT1 planted: OMP_KIT_RELEASE_VERDICT=0 schedules nothing and creates no log", () => {
	const { repo, marker, log } = fixtureRepo(true);
	expect(scheduleReleaseQualification(repo, "0123456789abcdef0123456789abcdef01234567", { OMP_KIT_RELEASE_VERDICT: "0" })).toBe("OPTED_OUT");
	expect(existsSync(marker)).toBe(false);
	expect(existsSync(log)).toBe(false);
});

test("AUTOCUTVERDICT1 planted: a repository without the starter or the verdict script reports UNAVAILABLE and never throws", () => {
	const { repo, marker } = fixtureRepo(false);
	expect(scheduleReleaseQualification(repo, "0123456789abcdef0123456789abcdef01234567", {})).toBe("UNAVAILABLE");
	expect(existsSync(marker)).toBe(false);
	expect(scheduleReleaseQualification(join(repo, "no-such-dir"), "0123456789abcdef0123456789abcdef01234567", {})).toBe("UNAVAILABLE");
});

test("AUTOCUTVERDICT1: a working tree that lags main and lacks the starter uses the one the kit release ships; without it, UNAVAILABLE", () => {
	const { repo, marker, log } = fixtureRepo(true);
	rmSync(join(repo, "scripts/release-verdict-start.py"));
	const sha = "0123456789abcdef0123456789abcdef01234567";
	const release = realpathSync(ownedTmp("land-release-layout").path);
	mkdirSync(join(release, "bin"), { recursive: true });
	mkdirSync(join(release, "scripts"), { recursive: true });
	const bin = join(release, "bin/omp-kit");
	writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	expect(scheduleReleaseQualification(repo, sha, {}, bin)).toBe("UNAVAILABLE");
	writeFileSync(join(release, "scripts/release-verdict-start.py"), `#!/usr/bin/env python3\nimport sys\nopen(${JSON.stringify(marker)}, "w").write("\\n".join(sys.argv[1:]))\nprint("release starter ran for " + sys.argv[2], flush=True)\n`, { mode: 0o755 });
	expect(scheduleReleaseQualification(repo, sha, {}, bin)).toBe("SCHEDULED");
	expect(readFileSync(marker, "utf8")).toBe(`${repo}\n${sha}`);
	expect(readFileSync(log, "utf8")).toContain(`release starter ran for ${sha}`);
});
