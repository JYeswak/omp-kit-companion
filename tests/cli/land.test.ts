// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { LAND_DEFAULT_TIMEOUT_MS, command, git, hunkSetup, patchHold, remoteHead, responseCode, type HunkSetup } from "./private-index-land.helpers.ts";

const LAND_RUN_FLOOR_MS = 60_000;
const HOOK_MARKER = "LANDPUSH1 pre-push hook started";
setDefaultTimeout(Math.max(LAND_DEFAULT_TIMEOUT_MS, Math.round(fixtureDeadlineS(90) * 1000)));

/** A pre-push hook that prints a marker, then sleeps a bounded time; its sleep holds no pipe of the land process. */
function sleepingPrePush(work: string, seconds: number): void {
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' '${HOOK_MARKER}'\nsleep ${seconds} </dev/null >/dev/null 2>&1\nexit 0\n`);
	chmodSync(hook, 0o755);
}

/** deadlineS null leaves OMP_KIT_LAND_PUSH_DEADLINE_S unset, so land uses its measured default. */
function landPatch(deadlineS: number | null, runFloorMs = LAND_RUN_FLOOR_MS) {
	const setup = hunkSetup("none");
	return { setup, run: (hookSeconds: number) => {
		sleepingPrePush(setup.work, hookSeconds);
		return command(setup.work, ["--patch", setup.patch, "--message", "feat(land): slow pre-push [test]", "--apply", "--yes"], patchHold(), {
			amDir: setup.fakeBin,
			timeoutMs: runFloorMs,
			gitEnv: {
				OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent,
				OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded,
				OMP_KIT_LAND_PUSH_DEADLINE_S: deadlineS === null ? undefined : String(deadlineS),
			},
		});
	} };
}

function expectPublished(setup: HunkSetup, result: { status: number; body: Record<string, unknown> }): void {
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	const data = result.body.data as { candidate_sha?: string; pushed_sha?: string };
	expect(typeof data.candidate_sha).toBe("string");
	expect(data.pushed_sha).toBe(data.candidate_sha);
	expect(remoteHead(setup.work)).toBe(data.candidate_sha!);
	expect(remoteHead(setup.work)).not.toBe(setup.base);
}

test("LANDPUSH1 a 45 s pre-push hook publishes under the default push deadline, past the old 30 s git bound", () => {
	const { setup, run } = landPatch(null, 180_000);
	expectPublished(setup, run(45));
}, Math.round(fixtureDeadlineS(300) * 1000));

test("LANDPUSH1 a pre-push hook slower than the general git bound still publishes within an overridden push deadline", () => {
	const { setup, run } = landPatch(Math.min(7200, Math.ceil(fixtureDeadlineS(20))));
	expectPublished(setup, run(3));
});

test("LANDPUSH1 a pre-push hook past the push deadline reports LAND_PUBLICATION_UNVERIFIED naming the deadline and the hook log", () => {
	// Under load git can take seconds to reach the hook, so the deadline scales (6..24 s) and the hook,
	// which kitlib reaps at the deadline, sleeps well past it.
	const deadlineS = Math.ceil(fixtureDeadlineS(6));
	const { setup, run } = landPatch(deadlineS);
	const result = run(deadlineS * 3);
	expect(result.status, JSON.stringify(result.body)).toBe(77);
	expect(responseCode(result.body)).toBe("LAND_PUBLICATION_UNVERIFIED");
	const message = String((result.body.errors as { message?: string }[])[0]?.message);
	expect(message).toContain(`pre-push hook was still running after ${deadlineS} s`);
	expect(message).toContain("OMP_KIT_LAND_PUSH_DEADLINE_S");
	const log = /hook log: (\S+\.log);/.exec(message)?.[1];
	expect(log, message).toBeDefined();
	expect(log!.startsWith(join(git(setup.work, ["rev-parse", "--absolute-git-dir"]).trim(), "omp-kit", "land-push"))).toBe(true);
	expect(existsSync(log!)).toBe(true);
	expect(readFileSync(log!, "utf8")).toContain(HOOK_MARKER);
	expect(git(setup.work, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]).toBe(setup.base);
});
