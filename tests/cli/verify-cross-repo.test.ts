import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { verifyBead } from "../../src/verify.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";

jest.setTimeout(fixtureDeadlineS(15) * 1_000);
const scratch = ownedTmp("verify-cross-repo-test", process.env.GRADE_WAVE_SCRATCH === undefined
	? {} : { root: process.env.GRADE_WAVE_SCRATCH });
// macOS TMPDIR is a /var symlink to /private/var; child $PWD reports the canonical
// path, so canonicalize once: every trackerDir derived from base must match $PWD textually.
const base = realpathSync(scratch.path);
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
const callerStateHome = process.env.XDG_STATE_HOME;
beforeAll(() => {
	installFixtureIdentity();
	process.env.XDG_STATE_HOME = join(base, "state");
});
afterAll(() => {
	restoreFixtureIdentity();
	if (callerStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = callerStateHome;
	scratch.cleanup();
});

const ACCEPTANCE = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A `br` dispatcher that routes by caller cwd: invocations with cwd under `trackerDir`
 * reach the tracker-A fixture, everything else reaches the export-side fixture. Every
 * invocation appends its PWD to the calls log, so a test proves tracker reads and acts
 * never ran under the export repo. The export repo is the only git repo in play, so a
 * passing replay proves git/export resolution used it, never the tracker dir. */
let routeCount = 0;
function routedTrackerEnv(trackerDir: string, tracker: { env: Record<string, string> }, other: { env: Record<string, string> }): { env: Record<string, string>; calls: () => string[] } {
	const home = join(base, `route-${++routeCount}`);
	mkdirSync(home, { recursive: true });
	const calls = join(home, "calls.log");
	writeFileSync(calls, "");
	const trackerBin = tracker.env.PATH!.split(delimiter)[0]!;
	const otherBin = other.env.PATH!.split(delimiter)[0]!;
	const disp = join(home, "bin");
	mkdirSync(disp, { recursive: true });
	writeFileSync(join(disp, "br"), [
		"#!/bin/sh",
		`CALLS=${JSON.stringify(calls)}`,
		`TRACKER=${JSON.stringify(trackerDir)}`,
		`TRACKER_BIN=${JSON.stringify(trackerBin)}`,
		`OTHER_BIN=${JSON.stringify(otherBin)}`,
		'printf \'%s :: br %s\\n\' "$PWD" "$*" >> "$CALLS"',
		'case "$PWD" in',
		'  "$TRACKER"*) exec "$TRACKER_BIN/br" "$@" ;;',
		'  *) exec "$OTHER_BIN/br" "$@" ;;',
		"esac",
		"",
	].join("\n"));
	chmodSync(join(disp, "br"), 0o755);
	return { env: { PATH: `${disp}${delimiter}${process.env.PATH ?? ""}` }, calls: () => text(readFileSync(calls)).split("\n").filter(line => line.includes(" :: br ")) };
}

function trackerPwdOnly(calls: string[], trackerDir: string): void {
	expect(calls.length).toBeGreaterThan(0);
	for (const line of calls) {
		const pwd = line.split(" :: br ")[0]!;
		expect(pwd === trackerDir || pwd.startsWith(`${trackerDir}/`)).toBe(true);
	}
}

test("VERIFYXREPO1 happy path: a bead in tracker A closes against an export commit from repo B", async () => {
	const trackerDir = join(base, "xrepo-tracker-a");
	mkdirSync(trackerDir, { recursive: true }); // NOT a git repo: any git op against it fails
	const code = await repo("xrepo-export-b");
	const tracker = fakeBr(inReview(ACCEPTANCE));
	const other = fakeBr({ ...inReview(ACCEPTANCE), id: "kit-9" });
	const routed = routedTrackerEnv(trackerDir, tracker, other);
	const res = await verifyBead({ bead: "kit-1", exportSha: code.sha, repo: code.dir, trackerRepo: trackerDir, actor: "Peer", env: routed.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => r.pass)).toEqual([true]);
	expect(tracker.state("kit-1").status).toBe("closed");
	expect(tracker.acts().some(a => a.startsWith("close kit-1"))).toBe(true);
	// No cross-contamination: every br invocation ran under the tracker dir; the
	// export-side fixture recorded no act and kept its own bead; neither side grew
	// the other's state (no .beads in B, no .git in A).
	trackerPwdOnly(routed.calls(), trackerDir);
	expect(other.acts()).toEqual([]);
	expect(other.state("kit-9").status).toBe("in_review");
	expect(existsSync(join(code.dir, ".beads"))).toBe(false);
	expect(existsSync(join(trackerDir, ".git"))).toBe(false);
});

test("VERIFYXREPO1 planted: an export SHA absent from repo B is refused UNKNOWN with no tracker act", async () => {
	const trackerDir = join(base, "xrepo-tracker-a2");
	mkdirSync(trackerDir, { recursive: true });
	const code = await repo("xrepo-export-b");
	const foreign = await repo("xrepo-export-foreign", { "foreign.sh": "#!/bin/sh\necho foreign\n" });
	expect(foreign.sha).not.toBe(code.sha);
	const tracker = fakeBr(inReview(ACCEPTANCE));
	const other = fakeBr({ ...inReview(ACCEPTANCE), id: "kit-9" });
	const routed = routedTrackerEnv(trackerDir, tracker, other);
	const res = await verifyBead({ bead: "kit-1", exportSha: foreign.sha, repo: code.dir, trackerRepo: trackerDir, actor: "Peer", env: routed.env });
	expect(res.code).toBe("UNKNOWN");
	expect(res.log).toContain("does not resolve");
	expect(res.replays).toEqual([]);
	expect(res.acts).toEqual([]);
	expect(tracker.acts()).toEqual([]);
	expect(other.acts()).toEqual([]);
});

test("VERIFYXREPO1 mutant: swapped tracker/export refs fail; each side resolves only its own ref", async () => {
	const trackerDir = join(base, "xrepo-tracker-a3");
	mkdirSync(trackerDir, { recursive: true });
	const code = await repo("xrepo-export-b");
	const tracker = fakeBr(inReview(ACCEPTANCE));
	const other = fakeBr({ ...inReview(ACCEPTANCE), id: "kit-9" });
	const routed = routedTrackerEnv(trackerDir, tracker, other);
	// Tracker ref swapped onto the export repo: kit-1 is not in B's tracker.
	const swappedTracker = await verifyBead({ bead: "kit-1", exportSha: code.sha, repo: code.dir, trackerRepo: code.dir, actor: "Peer", env: routed.env });
	expect(swappedTracker.code).toBe("NOT_IN_REVIEW");
	// Export ref swapped onto the tracker dir: no git repo there resolves the SHA.
	const swappedExport = await verifyBead({ bead: "kit-1", exportSha: code.sha, repo: trackerDir, trackerRepo: trackerDir, actor: "Peer", env: routed.env });
	expect(swappedExport.code).toBe("UNKNOWN");
	expect(tracker.state("kit-1").status).toBe("in_review");
});

test("VERIFYXREPO1 CLI: --tracker decouples the tracker from the export repo; empty and live-readback uses are refused", async () => {
	const trackerDir = join(base, "xrepo-tracker-cli");
	mkdirSync(trackerDir, { recursive: true });
	const code = await repo("xrepo-export-b");
	const tracker = fakeBr(inReview(ACCEPTANCE));
	const other = fakeBr({ ...inReview(ACCEPTANCE), id: "kit-9" });
	const routed = routedTrackerEnv(trackerDir, tracker, other);
	const runCli = (args: string[]) => run(["bun", "run", "--silent", cliPath, ...args], {
		cwd: code.dir, deadline_s: fixtureDeadlineS(60), env: { ...process.env, ...routed.env } as Record<string, string>,
	});
	// Dry run through the CLI: replays on the B export, prints the A-tracker acts, writes nothing.
	const ok = await runCli(["verify", "kit-1", "--export", code.sha, "--project", code.dir, "--tracker", trackerDir, "--actor", "Peer", "--dry-run", "--json"]);
	expect(ok.rc).toBe(0);
	expect(JSON.parse(text(ok.stdout)).data.overall).toBe("DRY_RUN");
	expect(tracker.acts()).toEqual([]);
	trackerPwdOnly(routed.calls(), trackerDir);
	// An empty --tracker is refused before anything runs.
	const empty = await runCli(["verify", "kit-1", "--export", code.sha, "--project", code.dir, "--tracker", " ", "--actor", "Peer", "--json"]);
	expect(empty.rc).not.toBe(0);
	expect(JSON.parse(text(empty.stdout)).errors[0].code).toBe("INVALID_FLAG");
	// --tracker with --live-readback is refused: readback runs on the installed kit, no export.
	const live = await runCli(["verify", "kit-1", "--live-readback", "--tracker", trackerDir, "--actor", "Peer", "--json"]);
	expect(JSON.parse(text(live.stdout)).errors[0].code).toBe("INVALID_FLAG");
});
