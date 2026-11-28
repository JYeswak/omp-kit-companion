import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { liveReadback, verifyBead } from "../../src/verify.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { brun, createBead, fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity, row, tracker as nativeTracker, trackerEnv } from "./verify-fixture.ts";

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

test("VERIFYXREPO1 CLI: --tracker decouples the tracker from the export repo and rejects an empty path", async () => {
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
});

test("READBACKTRACKER1: live readback runs fork code but changes only the explicitly bound real tracker", async () => {
	const code = await repo("readback-fork", {
		"readback.sh": "#!/bin/sh\nprintf 'fork readback observed\\n'\n",
	});
	const owner = await nativeTracker(base, "live-readback-owner");
	const acceptance = "- [ ] [a] [live] `sh scripts/readback.sh` -> prints fork readback observed";
	const fields = ["--assignee", "Author", "--acceptance", acceptance];
	const direct = await createBead(owner, "direct readback", fields);
	const parent = await createBead(owner, "original bead for bulk readback");
	const child = await createBead(owner, "retained live readback", [...fields, "--labels", "live-readback", "--deps", `related:${parent}`]);
	for (const id of [direct, parent, child]) {
		const tagged = await brun(["update", id, "--source-repo-path", owner.dir], owner.dir, trackerEnv(owner));
		expect(tagged.rc, tagged.out).toBe(0);
	}
	const copied = { dir: code.dir, db: join(code.dir, ".beads", "beads.db") };
	cpSync(join(owner.dir, ".beads"), join(code.dir, ".beads"), { recursive: true });
	const env = { ...process.env } as Record<string, string>;
	for (const key of ["BEADS_DB", "BEADS_DIR", "BEADS_JSONL", "BD_DB", "BD_DATABASE"]) delete env[key];
	const runCli = async (args: string[], bindings = env) => {
		const report = await run(["bun", "run", "--silent", cliPath, "verify", ...args, "--live-readback", "--project", code.dir,
			"--actor", "Peer", "--family", "fixture", "--json"], { cwd: code.dir, deadline_s: fixtureDeadlineS(45), env: bindings });
		return { rc: report.rc, data: JSON.parse(text(report.stdout)).data };
	};

	const implicit = await runCli([direct]);
	const canonicalAfterRefusal = await row(owner, direct);
	const copyAfterRefusal = await row(copied, direct);
	expect(implicit.rc, JSON.stringify({ verdict: implicit.data, canonical: canonicalAfterRefusal.status, copy: copyAfterRefusal.status })).toBe(2);
	expect(implicit.data).toMatchObject({ overall: "TRACKER_UNBOUND", replays: [], acts: [] });
	expect(canonicalAfterRefusal).toMatchObject({ status: "open", acceptance_criteria: acceptance });
	expect(copyAfterRefusal).toMatchObject({ status: "open", acceptance_criteria: acceptance });
	const conflict = { ...env, BEADS_DB: copied.db, BEADS_DIR: join(copied.dir, ".beads"), BEADS_JSONL: join(copied.dir, ".beads", "issues.jsonl") };
	const ambient = await runCli([direct], { ...env, BEADS_DB: copied.db });
	expect(ambient.rc).toBe(2);
	expect(ambient.data).toMatchObject({ overall: "TRACKER_UNBOUND", replays: [], acts: [] });
	const explicitCopy = await runCli([direct, "--tracker", code.dir]);
	expect(explicitCopy.rc).toBe(2);
	expect(explicitCopy.data).toMatchObject({ overall: "TRACKER_UNBOUND", replays: [], acts: [] });
	const decoy = new Database(copied.db);
	try { decoy.run("UPDATE issues SET source_repo_path = NULL WHERE id = ?", [direct]); }
	finally { decoy.close(); }
	const noOrigin = await runCli([direct, "--tracker", code.dir]);
	expect(noOrigin.rc).toBe(2);
	expect(noOrigin.data).toMatchObject({ overall: "TRACKER_UNBOUND", replays: [], acts: [] });

	const label = await run(["git", "config", "--local", "ovnfs.checkout", "readback-fork"], {
		cwd: code.dir, deadline_s: fixtureDeadlineS(5), env,
	});
	expect(label.rc).toBe(0);
	const refused = await runCli(["--all"]);
	expect(refused.rc).toBe(2);
	expect(refused.data).toMatchObject({ overall: "UNVERIFIED", visited: [], results: [] });
	expect(refused.data.log).toContain("TRACKER_UNBOUND");
	const unbound = join(owner.dir, "not-the-tracker");
	mkdirSync(unbound);
	const wrong = await runCli([direct, "--tracker", unbound], conflict);
	expect(wrong.rc).toBe(2);
	expect(wrong.data).toMatchObject({ overall: "TRACKER_UNBOUND", replays: [], acts: [] });

	// An ambient database pointing at the fork must not outrank the explicit flag.
	const passed = await runCli([direct, "--tracker", owner.dir, "--lesson", "readback from an explicit tracker"], conflict);
	expect(passed.rc, JSON.stringify(passed.data)).toBe(0);
	expect(passed.data).toMatchObject({ overall: "CLOSED", replays: [{ pass: true }] });
	const all = await runCli(["--all", "--tracker", owner.dir], conflict);
	expect(all.rc, JSON.stringify(all.data)).toBe(0);
	expect(all.data).toMatchObject({ overall: "OK", visited: [child], results: [{ bead: child, code: "CLOSED" }] });
	for (const id of [direct, child]) {
		expect(await row(owner, id)).toMatchObject({ status: "closed", acceptance_criteria: acceptance.replace("- [ ]", "- [x]") });
		expect(await row(copied, id)).toMatchObject({ status: "open", acceptance_criteria: acceptance });
	}
	expect(readFileSync(join(owner.dir, ".omp", "lessons.local.jsonl"), "utf8")).toContain("readback from an explicit tracker");
	expect(existsSync(join(code.dir, ".omp", "lessons.local.jsonl"))).toBe(false);
});

for (const [mode, command] of [
	["truncated", "sh scripts/noisy.sh"],
	["self-signalled", `printf 'readback observed\\n'; kill -TERM "$$"`],
] as const) {
	test(`READBACKTRACKER1: a matching prefix from ${mode} replay is not proof`, async () => {
		const code = await repo(`incomplete-${mode}`, { "noisy.sh": "#!/bin/sh\nprintf 'readback observed\\n'\npython3 -c 'print(\"x\" * 4194305)'\n" });
		const tracker = await nativeTracker(base, `incomplete-${mode}-owner`);
		const acceptance = `- [ ] [a] [live] \`${command}\` -> prints readback observed`;
		const bead = await createBead(tracker, "incomplete live output", ["--assignee", "Author", "--acceptance", acceptance]);
		const owner = await brun(["update", bead, "--source-repo-path", tracker.dir], tracker.dir, trackerEnv(tracker));
		expect(owner.rc, owner.out).toBe(0);
		const result = await liveReadback({ bead, repo: code.dir, trackerRepo: tracker.dir, actor: "Peer", lesson: "must not record a partial observation" });
		expect(result.code, result.log).toBe("ENVIRONMENT");
		expect(result.replays).toMatchObject([{ pass: null }]);
		if (mode === "self-signalled") expect(result.replays[0]?.rc).toBeLessThan(0);
		expect(result.acts).toEqual([]);
		expect(await row(tracker, bead)).toMatchObject({ status: "open", acceptance_criteria: acceptance });
		expect(existsSync(join(tracker.dir, ".omp", "lessons.local.jsonl"))).toBe(false);
	});
}
