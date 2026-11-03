// ompkit-xa5s.54 / PYGATE2 original AC d. Runtime proof, not a forged age/table/owner.
// Before this change, a new PPID1 Python interpreter is never selected (only old harness argv is);
// the old exported numeric killOrphan can also signal an unrelated current PID without ownership.
import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyScratch, defaultLiveness, defaultRunner, inspectScratchOrphan, killOrphan,
	parseOwnerFile, reapLogPath, updateScratchUsers, type ApplyDeps, type ScratchRunner } from "../../src/scratch.ts";
import { isDead, probeIncarnationSync } from "../../src/kitlib/proc.ts";
import { privateLock } from "../../src/kitlib/lock.ts";

// Runtime coverage: src/scratch.ts, src/kitlib/proc.ts, src/kitlib/lock.ts, src/kitlib/run.ts, src/kitlib/tmp.ts
import { eligible, processRow, runtimeFixture, supported } from "./scratch-orphan-reap.helpers.ts";

// Deliberately no age wait/bypass. Replay the observed Python -c import ... boundary literally.
test.skipIf(!supported)("scratch apply stops a real PPID1 Python -c import interpreter, receipts PID/start/path/linkage, and preserves a live-owned PPID1 -c control", async () => {
	await runtimeFixture(async fixture => {
		const orphan = await fixture.launch("abandoned", { inline: true });
		const control = await fixture.launch("live-owned", { inline: true, liveOwner: true });
		const owner = parseOwnerFile(readFileSync(join(orphan.dir, ".owner"), "utf8"));
		expect(owner?.pid).toBe(orphan.ownerPid);
		expect(owner?.processStart).not.toBeNull();
		const proof = eligible(orphan, fixture);
		expect(proof).toMatchObject({ invocation: "python-c", script: null });
		expect(existsSync(join(orphan.dir, "interpreter.py"))).toBe(false);
		expect(proof.ageSeconds).toBeLessThan(3600);
		expect(proof.linkage.some(link => link.kind === "cwd" && link.path === orphan.dir)).toBe(true);
		expect(proof.linkage.every(link => link.kind === "cwd")).toBe(true); // The inline positive has no script/FD surrogate.
		const result = applyScratch(fixture.home, fixture.deps);
		const stopped = result.killed.find(row => row.pid === orphan.pid);
		expect(stopped).toMatchObject({ pid: orphan.pid, start: orphan.start, path: orphan.dir, status: "terminated", ok: true });
		expect(stopped?.linkage.length).toBeGreaterThan(0);
		expect(isDead(probeIncarnationSync(orphan))).toBe(true);
		expect(probeIncarnationSync(control).state).toBe("live");
		expect(result.orphanDecisions.find(row => row.pid === control.pid)).toMatchObject({ status: "preserved", reason: "owner-live" });
		expect(result.killed.some(row => row.pid === control.pid)).toBe(false);
		expect(result.receipt.orphan_processes).toContainEqual(expect.objectContaining({
			pid: orphan.pid, start: orphan.start, path: orphan.dir, status: "terminated", ok: true }));
		expect(result.receipt.orphan_processes).toContainEqual(expect.objectContaining({
			pid: control.pid, start: control.start, path: control.dir, status: "preserved", ok: false }));
		expect(JSON.stringify(result)).not.toContain("py54-inline-private-payload");
		const events: { event: string; pid?: number; start?: string; path?: string; ok?: boolean }[] = readFileSync(reapLogPath(fixture.home), "utf8")
			.trim().split("\n").map(line => JSON.parse(line));
		expect(events).toContainEqual(expect.objectContaining({ event: "orphan-kill", pid: orphan.pid, start: orphan.start, path: orphan.dir, ok: true }));
		expect(JSON.stringify(events)).not.toContain("py54-inline-private-payload");
	});
}, 90000);

test.skipIf(!supported)("FD-linked orphan is positive; shared socket services and live registered users remain protected", async () => {
	await runtimeFixture(async fixture => {
		const fdOnly = await fixture.launch("fd-linked", { inline: true, fdOnly: true });
		const proof = eligible(fdOnly, fixture);
		expect(proof.linkage.some(link => link.kind === "fd" && link.path === join(fdOnly.dir, "linkage.data"))).toBe(true);
		expect(proof.linkage.some(link => link.kind === "cwd")).toBe(false);
		const unregisteredReader = openSync(join(fdOnly.dir, "linkage.data"), "r");
		try {
			expect(killOrphan(proof, fixture.deps)).toMatchObject({ ok: false, status: "preserved", reason: "other-process-using-scratch" });
			expect(probeIncarnationSync(fdOnly).state).toBe("live");
		} finally { closeSync(unregisteredReader); }
		const service = await fixture.launch("shared-service", { service: true });
		expect(inspectScratchOrphan(processRow(service), fixture.home, fixture.deps).status).not.toBe("eligible");
		const registration = await updateScratchUsers(fdOnly.dir, process.pid, "use", { home: fixture.home, liveness: fixture.deps.liveness });
		expect(registration.ok).toBe(true);
		expect(killOrphan(proof, fixture.deps)).toMatchObject({ ok: false, status: "preserved", reason: "registered-user-live-or-unknown" });
		expect(probeIncarnationSync(fdOnly).state).toBe("live");
		const unknownUser: ApplyDeps = { ...fixture.deps, liveness: { ...defaultLiveness(), probe: user => user.pid === process.pid
			? { state: "unknown", evidence: { pid: user.pid, recorded_start: user.start, observed_start: null, stat: null,
				signal0: null, reason: "planted unavailable registered-user observation" } } : probeIncarnationSync(user) } };
		expect(killOrphan(proof, unknownUser)).toMatchObject({ ok: false, reason: "registered-user-live-or-unknown" });
		expect((await updateScratchUsers(fdOnly.dir, process.pid, "unuse", { home: fixture.home, liveness: fixture.deps.liveness })).ok).toBe(true);
		// A fresh complete proof (not the pre-registration snapshot) authorizes the FD-only positive.
		expect(killOrphan(eligible(fdOnly, fixture), fixture.deps)).toMatchObject({ ok: true, status: "terminated" });
		expect(probeIncarnationSync(service).state).toBe("live");
	});
}, 90000);

test.skipIf(!supported)("unknown owner/seat/user state, reused incarnation and unavailable process metadata never authorize TERM", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("guards");
		const proof = eligible(child, fixture);
		const signals: string[] = [];
		const noSignal: ApplyDeps = { ...fixture.deps, kill: (_pid, signal) => { signals.push(signal); return true; } };
		expect(killOrphan({ ...proof, start: "Mon Jan 1 00:00:00 1900" }, noSignal)).toMatchObject({ ok: false, reason: "incarnation-reused" });
		const unknownOwner: ApplyDeps = { ...noSignal, liveness: { ...defaultLiveness(), probe: owner => ({ state: "unknown", evidence: {
			pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: null, reason: "planted unavailable owner observation" } }) } };
		expect(killOrphan(proof, unknownOwner)).toMatchObject({ ok: false, reason: "owner-unknown" });
		const failedRun: ScratchRunner = (args, options) => args[0] === "ps" && args.includes(String(child.pid))
			? { code: null, stdout: "", stderr: "planted metadata timeout" } : defaultRunner(args, options);
		expect(killOrphan(proof, { ...noSignal, run: failedRun }).ok).toBe(false);
		const foreignUidRun: ScratchRunner = (args, options) => {
			const out = defaultRunner(args, options);
			if (args[0] !== "ps" || !args.includes("uid=") || !args.includes(String(child.pid))) return out;
			const text = out.stdout.trimStart(), end = text.indexOf(" ");
			return end < 0 ? out : { ...out, stdout: `${(process.getuid?.() ?? 0) + 1}${text.slice(end)}` };
		};
		expect(killOrphan(proof, { ...noSignal, run: foreignUidRun })).toMatchObject({ ok: false, reason: "foreign-uid" });
		renameSync(join(child.dir, ".owner"), join(child.dir, "original-owner"));
		try { expect(killOrphan(proof, noSignal)).toMatchObject({ ok: false, reason: "owner-or-users-metadata-unproven" }); }
		finally { renameSync(join(child.dir, "original-owner"), join(child.dir, ".owner")); }
		writeFileSync(join(child.dir, ".users"), "malformed", { mode: 0o600 });
		expect(killOrphan(proof, noSignal)).toMatchObject({ ok: false, reason: "registered-user-live-or-unknown" });
		const seated = await fixture.launch("unknown-seat", { seat: true });
		const seatDeps: ApplyDeps = { ...noSignal, liveness: { ...defaultLiveness(), seatLive: () => null } };
		expect(inspectScratchOrphan(processRow(seated), fixture.home, seatDeps)).toMatchObject({ status: "preserved", reason: "owner-seat-live-or-unknown" });
		expect(signals).toEqual([]);
		expect(probeIncarnationSync(child).state).toBe("live");
		expect(probeIncarnationSync(seated).state).toBe("live");
	});
}, 90000);

test.skipIf(!supported)("replaced recognized root and busy users lock refuse the previously valid proof before TERM", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("root-race");
		const proof = eligible(child, fixture);
		const lock = await privateLock({ namespace: "scratch-users", path: child.dir }, { deadline_s: 0 });
		try { expect(killOrphan(proof, fixture.deps)).toMatchObject({ ok: false, reason: "users-lock-busy" }); }
		finally { lock.release(); }
		renameSync(fixture.root, `${fixture.root}.original`);
		mkdirSync(fixture.root, { mode: 0o700 });
		expect(killOrphan(proof, fixture.deps).ok).toBe(false);
		expect(probeIncarnationSync(child).state).toBe("live");
	});
}, 60000);

