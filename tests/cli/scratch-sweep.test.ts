import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectSweepInventory, parseSweepInventory, planSweep } from "../../src/scratch-sweep.ts";
import { applyOwnedQuarantine, defaultLiveness, defaultRunner, inspectSession, reapLogPath } from "../../src/scratch.ts";
import type { SweepInventory } from "../../src/scratch-sweep.ts";
import type { InspectDeps } from "../../src/scratch.ts";

const NOW = Date.now();
const roots: string[] = [];
function freshRoot(): string {
	const base = process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "sweep-boundary-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seed(root: string, name = "finished.999999", ageHours = 80): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"), `pid=999999\nlabel=finished\nrepo=${root}\ncreated=2020-01-01T00:00:00Z\n`);
	writeFileSync(join(dir, "payload"), "recover-me-byte-identically");
	const date = new Date(NOW - ageHours * 3600_000);
	for (const path of [join(dir, ".owner"), join(dir, "payload"), dir]) utimesSync(path, date, date);
	return dir;
}
const dead = { signalAlive: () => false, psVisible: () => false, processStart: () => null };
const clear: InspectDeps = { liveness: dead, lsofSnapshot: new Set(), run: () => ({ code: 0, stdout: "", stderr: "" }) };
function inventory(freePct = 80): SweepInventory {
	return { status: "DONE", reason: "inventory-read", observedAtMs: NOW, freePct, entries: [], unrunPaths: [] };
}
function envelope() {
	return {
		schema_version: "1.0.0", success: true, code: "PASS", exit_code: 0,
		data: {
			schema_version: "1.0.0", scanned_at_epoch: Math.floor(NOW / 1000),
			host_free: { total_bytes: 1000, used_bytes: 950, free_bytes: 50, mount_point: "/" },
			entries: [] as unknown[],
			axes: [{ axis: "A5_BUILD_LANES", axis_budget_exhausted: false, candidates: 0, measured: 0, unmeasured: [], denied: [] }],
			denylist_rules: ["POSTGRES_DATA"], wall_budget_exhausted: false, axes_unreached: [] as string[],
			positive_control: { ran: true, passed: true },
		},
	};
}

test("planning is quarantine-only and never fabricates reclaimed bytes or undo", () => {
	const root = freshRoot();
	const dir = seed(root);
	const result = planSweep(root, clear, { nowMs: NOW, inventory: inventory() });
	expect(result.quarantined.map(row => row.dir)).toEqual([dir]);
	expect(result.quarantined[0]?.action).toBe("QUARANTINE");
	expect(result.plannedBytes).toBeGreaterThan(0);
	expect(result.stagedBytes).toBe(0);
	expect(result.gb).toBe(0);
	expect(result.undoLines).toEqual([]);
	expect(existsSync(join(dir, "payload"))).toBe(true);
});

test("unchanged root mtime never caches dead-owner or fd eligibility", () => {
	const root = freshRoot();
	const dir = seed(root);
	const first = planSweep(root, clear, { nowMs: NOW, inventory: inventory() });
	const held: InspectDeps = { ...clear, lsofSnapshot: new Set([join(dir, "payload")]) };
	const second = planSweep(root, held, { nowMs: NOW, inventory: inventory(), tracking: first.nextTracking });
	expect(second.walkedDirs).toBe(1);
	expect(second.quarantined).toEqual([]);
	expect(second.rows[0]?.action).toBe("LIVE");
	expect(second.nextTracking.entries[dir]?.sizeBytes).toBe(first.nextTracking.entries[dir]?.sizeBytes);
});

test("pressure shortens72h to24h but deepest fresh writes still veto", () => {
	const root = freshRoot();
	const dir = seed(root, "finished.999999", 36);
	expect(planSweep(root, clear, { nowMs: NOW, inventory: inventory(80) }).quarantined).toEqual([]);
	const pressured = planSweep(root, clear, { nowMs: NOW, inventory: inventory(5) });
	expect(pressured.idleHours).toBe(24);
	expect(pressured.quarantined.map(row => row.dir)).toEqual([dir]);
	utimesSync(join(dir, "payload"), new Date(NOW), new Date(NOW));
	expect(planSweep(root, clear, { nowMs: NOW, inventory: inventory(5), tracking: pressured.nextTracking }).quarantined).toEqual([]);
});

test("LIVE UNKNOWN denylist and failed inventory probes cannot authorize staging", () => {
	const root = freshRoot();
	const dir = seed(root);
	for (const veto of ["inventory-live", "inventory-unknown", "inventory-denylist:POSTGRES_DATA", "inventory-probe-error"]) {
		const evidence = inventory();
		evidence.entries.push({ path: dir, axis: "A5_BUILD_LANES", sizeBytes: 25, veto });
		const result = planSweep(root, clear, { nowMs: NOW, inventory: evidence });
		expect(result.quarantined).toEqual([]);
		expect(result.rows[0]?.reason).toBe(veto);
	}
	const failed = { ...inventory(), status: "UNKNOWN" as const, reason: "inventory-probe-error" };
	expect(planSweep(root, clear, { nowMs: NOW, inventory: failed }).status).toBe("UNRUN");
	expect(existsSync(dir)).toBe(true);
});

test("owner-live and failed fresh fd evidence remain untouched", () => {
	const root = freshRoot();
	const dir = seed(root);
	const live: InspectDeps = { ...clear, liveness: { signalAlive: () => true, psVisible: () => true, processStart: () => null } };
	expect(planSweep(root, live, { nowMs: NOW, inventory: inventory() }).quarantined).toEqual([]);
	const error: InspectDeps = { ...clear, lsofSnapshot: null };
	const result = planSweep(root, error, { nowMs: NOW, inventory: inventory() });
	expect(result.quarantined).toEqual([]);
	expect(result.rows[0]?.reason).toBe("lsof-evidence-unavailable");
	expect(existsSync(dir)).toBe(true);
});

test("expired budget names every unrun candidate rather than clean zero", () => {
	const root = freshRoot();
	const dir = seed(root);
	const result = planSweep(root, clear, { nowMs: NOW, budgetMs: 0, inventory: inventory() });
	expect(result.status).toBe("UNRUN");
	expect(result.unrunPaths).toContain(dir);
	expect(result.quarantined).toEqual([]);
});

test("oversized actual tree returns partial evidence and named UNRUN without whole walk", () => {
	const root = freshRoot();
	const dir = seed(root);
	for (let i = 0; i < 10_010; i++) writeFileSync(join(dir, `entry-${i}`), "x");
	const started = Date.now();
	const result = planSweep(root, clear, { nowMs: NOW, inventory: inventory() });
	expect(Date.now() - started).toBeLessThan(60_000);
	expect(result.status).toBe("UNRUN");
	expect(result.unrunPaths.some(path => path.startsWith(dir))).toBe(true);
	expect(result.sizeEvidence[dir]?.status).toBe("partial");
	expect(result.rows[0]?.sizeBytes).toBe(0);
	expect(result.quarantined).toEqual([]);
});

test("enumeration errors cannot masquerade as an empty completed root", () => {
	const root = freshRoot();
	const result = planSweep(join(root, "missing"), clear, { nowMs: NOW, inventory: inventory() });
	expect(result.status).toBe("UNRUN");
	expect(result.unrunPaths[0]).toContain("enumeration-error");
});

test("structured inventory retains pressure and partial-axis coverage; malformed and stale refuse", () => {
	const good = envelope();
	expect(parseSweepInventory(good, NOW).freePct).toBe(5);
	expect(parseSweepInventory(good, NOW).status).toBe("DONE");
	const partial = { ...good, success: false, code: "CANNOT_DETERMINE", exit_code: 4, failure_kind: "WALL_BUDGET_EXHAUSTED",
		data: { ...good.data, wall_budget_exhausted: true, axes_unreached: ["A6_AGENT_SCRATCH"] } };
	expect(parseSweepInventory(partial, NOW).unrunPaths).toContain("fsw:axis:A6_AGENT_SCRATCH");
	expect(parseSweepInventory("raw log", NOW).status).toBe("UNKNOWN");
	expect(parseSweepInventory(good, NOW + 61_000).reason).toBe("inventory-stale");
	expect(parseSweepInventory({ ...good, data: { ...good.data, positive_control: { ran: true, passed: false } } }, NOW).reason).toBe("inventory-positive-control-failed");
});

test("inventory incomplete liveness probes veto even a proposable class", () => {
	const good = envelope();
	const root = freshRoot();
	const dir = seed(root);
	good.data.entries.push({ path: dir, axis: "A5_BUILD_LANES", class: "SCRATCH", measurement: { state: "complete", bytes: 42 },
		liveness: { live: false, indeterminate: false, probes: [{ ran: false, live: false }] },
		identity: { vetoes_reclaim: false }, ownership: { vetoes_reclaim: false } });
	expect(parseSweepInventory(good, NOW).entries[0]?.veto).toBe("inventory-probe-error");
	const result = planSweep(root, clear, { nowMs: NOW, inventory: parseSweepInventory(good, NOW) });
	expect(result.quarantined).toEqual([]);
});

test("adapter refuses mismatched process exit rather than trusting an envelope", () => {
	const good = envelope();
	const result = collectSweepInventory(() => ({ code: 127, stdout: JSON.stringify(good), stderr: "exec failed" }), NOW);
	expect(result.reason).toBe("inventory-exit-mismatch");
	expect(result.status).toBe("UNKNOWN");
});

test("identity change at fresh fd probe refuses before staging", () => {
	const root = freshRoot();
	const dir = seed(root);
	const planned = inspectSession(dir, root, { ...clear, skipSize: true });
	const changed: InspectDeps = { liveness: dead, run: () => {
		writeFileSync(join(dir, ".owner"), `pid=999999\nlabel=replaced\nrepo=${root}\ncreated=2020-01-01T00:00:00Z\n`);
		return { code: 0, stdout: "", stderr: "" };
	}};
	const terminal = applyOwnedQuarantine(dir, root, planned, { ...changed, home: root, now: NOW });
	expect(terminal.status).toBe("REFUSED");
	expect(terminal.reason).toContain("final-recheck-refused");
	expect(existsSync(dir)).toBe(true);
	expect(terminal.undo).toBeUndefined();
});

test("isolated real dead owner stages with durable receipt and byte-identical actual undo; fd holder stays live", async () => {
	const root = freshRoot();
	const dir = seed(root);
	const held = seed(root, "held.999999");
	const home = join(root, "home");
	const holder = Bun.spawn([process.execPath, "-e", 'const fs=require("node:fs"); const fd=fs.openSync(process.argv[1],"r"); process.stdout.write("ready\\n"); process.stdin.resume();', join(held, "payload")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	try {
		const ready = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(ready.value)).toContain("ready");
		const deps = { liveness: defaultLiveness(), run: defaultRunner, home, now: NOW, skipSize: true, deadlineMs: Date.now() + 55_000 };
		const heldVerdict = inspectSession(held, root, deps);
		expect(heldVerdict.action).toBe("LIVE");
		expect(existsSync(held)).toBe(true);
		const planned = inspectSession(dir, root, deps);
		expect(planned.action).toBe("REAP");
		const identity = `${lstatSync(dir).dev}:${lstatSync(dir).ino}`;
		const terminal = applyOwnedQuarantine(dir, root, planned, deps);
		expect(terminal.action).toBe("QUARANTINE");
		expect(existsSync(dir)).toBe(false);
		expect(readFileSync(join(terminal.dir, "payload"), "utf8")).toBe("recover-me-byte-identically");
		const receipt = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.event === "quarantine");
		expect(receipt).toMatchObject({ dir, destination: terminal.dir, identity, undo: terminal.undo });
		expect(terminal.undo).toBeDefined();
		const restored = Bun.spawnSync(["sh", "-c", terminal.undo!], { stdout: "pipe", stderr: "pipe" });
		expect(restored.exitCode).toBe(0);
		expect(`${lstatSync(dir).dev}:${lstatSync(dir).ino}`).toBe(identity);
		expect(readFileSync(join(dir, "payload"), "utf8")).toBe("recover-me-byte-identically");
		expect(readdirSync(root)).toContain("held.999999");
	} finally {
		holder.kill();
		await holder.exited;
	}
}, 60_000);
