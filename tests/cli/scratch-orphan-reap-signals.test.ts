// Runtime coverage: src/scratch.ts, src/kitlib/proc.ts, src/kitlib/lock.ts, src/kitlib/run.ts, src/kitlib/tmp.ts
import { expect, test } from "bun:test";
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyScratch, killOrphan } from "../../src/scratch.ts";
import { isDead, probeIncarnationSync } from "../../src/kitlib/proc.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
import { eligible, repo, runtimeFixture, scratchModule, supported } from "./scratch-orphan-reap.helpers.ts";

test.skipIf(!supported)("ownership metadata changed after real TERM vetoes escalation to KILL", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("kill-race", { ignoreTerm: true });
		const proof = eligible(child, fixture);
		const signals: string[] = [];
		const result = killOrphan(proof, { ...fixture.deps, kill: (pid, signal) => {
			signals.push(signal);
			process.kill(pid, signal);
			if (signal === "SIGTERM") writeFileSync(join(child.dir, ".users"), "metadata became unknown", { mode: 0o600 });
			return true;
		} });
		expect(result).toMatchObject({ ok: false, status: "preserved", reason: "registered-user-live-or-unknown" });
		expect(signals).toEqual(["SIGTERM"]);
		expect(probeIncarnationSync(child).state).toBe("live");
	});
}, 60000);

test.skipIf(!supported)("unchanged abandoned interpreter ignoring TERM is revalidated and actually exits after KILL", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("kill-positive", { ignoreTerm: true });
		const result = killOrphan(eligible(child, fixture), fixture.deps);
		expect(result).toMatchObject({ pid: child.pid, start: child.start, path: child.dir, ok: true, status: "terminated" });
		expect(isDead(probeIncarnationSync(child))).toBe(true);
	});
}, 60000);

test.skipIf(!supported)("complete directory-user evidence arriving after three seconds can still authorize the real interpreter proof", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("loaded-directory-probe", { inline: true });
		const realRunner = fixture.deps.run;
		fixture.deps.run = (args, options) => {
			if (args[0] !== "lsof" || !args.includes("+D")) return realRunner(args, options);
			// Deliberately exceed the old 3 s deadline before executing the real OS probe.
			// This tests the deadline itself, not a guessed delay for interpreter readiness.
			const out = runSync(["python3", "-c", "import os,sys,time; time.sleep(3.1); os.execvp(sys.argv[1], sys.argv[1:])", ...args], {
				deadline_s: (options?.timeoutMs ?? 0) / 1000, max_output_bytes: 8192,
			});
			return { code: out.timed_out || out.truncated ? null : out.rc,
				stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
		};
		expect(eligible(child, fixture).pid).toBe(child.pid);
	});
}, 60000);

test.skipIf(!supported)("Unicode scratch paths retain their real open-FD veto while ps keeps stable identity dates", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("unicode-owned", { inline: true });
		const descriptor = openSync(join(child.dir, "linkage.data"), "r");
		try {
			const result = applyScratch(fixture.home, fixture.deps);
			expect(existsSync(child.dir)).toBe(true);
			expect(probeIncarnationSync(child).state).toBe("live");
			expect(result.killed.some(row => row.pid === child.pid)).toBe(false);
			expect(result.orphanDecisions.find(row => row.pid === child.pid)).toMatchObject({
				status: "preserved", reason: "other-process-using-scratch",
			});
		} finally { closeSync(descriptor); }
	}, true);
}, 90000);

test.skipIf(!supported)("FIFO ownership metadata refuses promptly and a regular absent-users control remains eligible", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("fifo-users", { inline: true });
		const fifo = join(child.dir, ".users");
		const made = await run(["mkfifo", fifo], { deadline_s: 30, max_output_bytes: 4096 });
		expect(made.rc).toBe(0);
		const program = `
import { inspectScratchOrphan, listProcesses, defaultRunner, defaultLiveness } from ${JSON.stringify(scratchModule)};
const proc = listProcesses(defaultRunner).find(row => row.pid === ${child.pid});
if (proc === undefined) throw new Error("owned interpreter vanished");
const decision = inspectScratchOrphan(proc, ${JSON.stringify(fixture.home)}, {
  run: defaultRunner, liveness: defaultLiveness(), systemTempBases: [] });
console.log(JSON.stringify({ status: decision.status, reason: decision.reason }));
`;
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
		const refused = await run([process.execPath, "-e", program], { cwd: repo, env, deadline_s: 30, max_output_bytes: 8192 });
		expect(refused.timed_out).toBe(false);
		expect(refused.rc, new TextDecoder().decode(refused.stderr)).toBe(0);
		expect(JSON.parse(new TextDecoder().decode(refused.stdout))).toEqual({
			status: "refused", reason: "owner-or-users-metadata-unproven",
		});
		expect(probeIncarnationSync(child).state).toBe("live");
		unlinkSync(fifo);
		expect(eligible(child, fixture).pid).toBe(child.pid);
	});
}, 90000);
