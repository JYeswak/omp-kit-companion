import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import type { ScratchRunner } from "../../src/index-lock.ts";
import { landGitDetail, reapStaleIndexLockForLand } from "../../src/land.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const AGE = 60_000;
// No lsof holder and no live index-writing process: the reaper's own seams, not the machine's processes.
const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });

function repoWithLock(ageMs: number, bytes: string) {
	const root = realpathSync(ownedTmp("land-index-lock").path);
	const env = { ...process.env, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const init = runFixture(["git", "init", "-q", root], { cwd: root, env });
	expect(init.rc).toBe(0);
	const lock = join(root, ".git", "index.lock");
	writeFileSync(lock, bytes);
	const back = new Date(Date.now() - ageMs);
	utimesSync(lock, back, back);
	writeFileSync(join(root, "new.txt"), "owned new file\n");
	const intentToAdd = () => runFixture(["git", "add", "--intent-to-add", "--", ":(literal)new.txt"], { cwd: root, env });
	return { root, lock, ledger: join(root, "ledger.jsonl"), intentToAdd };
}

test("LANDLOCKREAP1 control: a stale empty unheld index.lock is moved aside with a ledger row, then the owned path stages", () => {
	const f = repoWithLock(AGE + 1_000, "");
	try {
		expect(reapStaleIndexLockForLand(f.root, { run: clearRun, staleAfterMs: AGE, ledger: f.ledger })).toBe("REAPED");
		expect(existsSync(f.lock)).toBe(false);
		expect(readFileSync(f.ledger, "utf8")).toContain("index.lock");
		expect(f.intentToAdd().rc).toBe(0);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
}, fixtureDeadlineS() * 1000);

test("LANDLOCKREAP1 planted: a fresh or non-empty lock is left alone and git's own stderr names it", () => {
	for (const [age, bytes] of [[0, ""], [AGE + 1_000, "index bytes"]] as const) {
		const f = repoWithLock(age, bytes);
		try {
			expect(reapStaleIndexLockForLand(f.root, { run: clearRun, staleAfterMs: AGE, ledger: f.ledger })).not.toBe("REAPED");
			expect(existsSync(f.lock)).toBe(true);
			const add = f.intentToAdd();
			expect(add.rc).not.toBe(0);
			// The refusal text land now carries: git's first stderr line, not a bare LAND_PATH_UNAVAILABLE.
			const detail = landGitDetail({ code: add.rc ?? 1, out: "", err: Buffer.from(add.stderr).toString(), interrupted: false, timedOut: false });
			expect(detail).toContain("index.lock");
		} finally { rmSync(f.root, { recursive: true, force: true }); }
	}
}, fixtureDeadlineS() * 1000);

test("LANDLOCKREAP1: no lock reads NOT_FOUND and git without stderr still names its exit", () => {
	const f = repoWithLock(0, "");
	try {
		rmSync(f.lock);
		expect(reapStaleIndexLockForLand(f.root, { run: clearRun, staleAfterMs: AGE, ledger: f.ledger })).toBe("NOT_FOUND");
		expect(landGitDetail({ code: 128, out: "", err: "", interrupted: false, timedOut: false })).toBe("git exited 128 with no output");
	} finally { rmSync(f.root, { recursive: true, force: true }); }
}, fixtureDeadlineS() * 1000);

test("LANDLOCKREAP1: a token-shaped value crossing the 300-char bound never leaks its prefix", () => {
	// Synthetic gh-shaped value placed so the 300-char cut falls inside it; truncating first would leave a
	// shorter ghp_ prefix the shape matcher no longer recognises.
	const token = "ghp_" + "A".repeat(36);
	const err = "x".repeat(289) + " " + token + " trailing\n";
	const detail = landGitDetail({ code: 1, out: "", err, interrupted: false, timedOut: false });
	expect(detail).not.toContain("ghp_AAAA");
	expect(detail.length).toBeLessThanOrEqual(300);
});
