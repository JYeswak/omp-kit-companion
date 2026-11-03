import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { type DiskCapacity, decideDiskPressure, type DiskVerdict, diskVerdict, HEAVY_DISK_NEED_BYTES, HEAVY_PREREQ_MISSING } from "../../src/heavy.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { fixture, configure, invoke, QUIET_LOAD, waitForLedgerState, fakeSbh, observerRefusals, forgeHealthyStatfs } from "./heavy-fixtures.ts";

const GIB = 1024 ** 3;

type Decide = (capacity: DiskCapacity | null, floorPct: number | null) => DiskVerdict;

// The original oq1h.1 decision matrix as named cases, so the same assertions can also be pointed at
// planted mutants through the injected boundary (no environment seam).
const HEALTHY_CASE = "healthy: 100 GiB free runs";

const PRESSURE_CASE = "pressure: 5 GiB free defers";

const FLOOR_CASE = "floor: percent below disk_floor_pct defers";

const FAILURE_CASE = "failure: an unreadable statfs is unavailable, never healthy";

const STATFS_CASES: Record<string, (decide: Decide) => void> = {
	[HEALTHY_CASE]: (decide) => {
		expect(decide({ freeBytes: 100 * GIB, freePct: 50 }, null)).toEqual({ kind: "ok", observer: "statfs" });
	},
	[PRESSURE_CASE]: (decide) => {
		expect(decide({ freeBytes: 5 * GIB, freePct: 50 }, null)).toEqual({ kind: "pressure", text: "disk low (statfs)", observer: "statfs" });
	},
	[FLOOR_CASE]: (decide) => {
		const floor = decide({ freeBytes: 100 * GIB, freePct: 30 }, 40);
		expect(floor.kind).toBe("pressure");
		if (floor.kind === "pressure") expect(floor.text).toContain("disk low (statfs)");
	},
	[FAILURE_CASE]: (decide) => {
		expect(decide(null, null)).toEqual({ kind: "unavailable", text: "no disk observer available", observer: "statfs" });
	},
};

// A kill is a case's own assertion failing (Bun reports it as an Error whose message starts "expect(").
// Anything else, such as a mutant that crashes or a case that cannot run, is a setup error: it must surface
// instead of being counted as a kill.
function failingCases(decide: Decide): string[] {
	return Object.entries(STATFS_CASES).flatMap(([name, check]) => {
		try {
			check(decide);
			return [];
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("expect(")) return [name];
			throw new Error(`setup error in statfs case "${name}": ${String(error)}`, { cause: error });
		}
	});
}

test.concurrent("oq1h.1 unit: statfs decision matrix without environment", () => {
	for (const check of Object.values(STATFS_CASES)) check(decideDiskPressure);
});

test.concurrent("oq1h.1 planted: each statfs mutant is killed by exactly the cases that guard it", () => {
	const healthy: DiskVerdict = { kind: "ok", observer: "statfs" };
	const mutants: Record<string, { decide: Decide; killedBy: string[] }> = {
		"always healthy (forced ok): the 5 GiB pressure case fails": {
			decide: () => healthy, killedBy: [PRESSURE_CASE, FLOOR_CASE, FAILURE_CASE] },
		"always pressure": {
			decide: () => ({ kind: "pressure", text: "disk low (statfs)", observer: "statfs" }), killedBy: [HEALTHY_CASE, FAILURE_CASE] },
		"floor ignored": {
			decide: (capacity) => decideDiskPressure(capacity, null), killedBy: [FLOOR_CASE] },
		"unreadable statfs treated as healthy": {
			decide: (capacity, floor) => capacity === null ? healthy : decideDiskPressure(capacity, floor), killedBy: [FAILURE_CASE] },
		"sbh-only (no statfs observer)": {
			decide: () => ({ kind: "unavailable", text: "no disk observer available", observer: "statfs" }), killedBy: [HEALTHY_CASE, PRESSURE_CASE, FLOOR_CASE] },
	};
	// Positive control: the real decider fails none of the cases, so a kill below is the mutant's doing.
	expect(failingCases(decideDiskPressure)).toEqual([]);
	// Setup errors are not kills: a decider that crashes surfaces as an error, never as a silently killed mutant.
	expect(() => failingCases(() => { throw new TypeError("decider crashed"); })).toThrow("setup error in statfs case");
	for (const [name, mutant] of Object.entries(mutants)) {
		expect({ mutant: name, killed: failingCases(mutant.decide).sort() }).toEqual({ mutant: name, killed: [...mutant.killedBy].sort() });
	}
});

// ---- oq1h.1 native cases: the real statfs through the real CLI -----------------------------------------
// Native cases use a real small filesystem for pressure. The test-only preload
// is limited to queue baselines and the planted forced-healthy mutant below.
const NO_SBH_PATH = "/usr/bin:/bin";

function measure(directory: string): { freeBytes: number; freePct: number } {
	const observed = statfsSync(directory);
	return { freeBytes: Number(observed.bavail) * Number(observed.bsize), freePct: Math.min(100, (Number(observed.bavail) / Number(observed.blocks)) * 100) };
}

// A real filesystem with less than the 10 GiB admission need, so pressure is observed, not injected.
// Linux: /dev/shm, a tmpfs sized from RAM (about 7.8 GiB on GitHub's 16 GB runners). Elsewhere set
// OMP_KIT_TEST_LOW_FS_DIR to a directory on a small mounted volume (macOS: hdiutil create -size 200m -fs APFS -attach).
function lowCapacityBase(): string | null {
	for (const candidate of [process.env.OMP_KIT_TEST_LOW_FS_DIR, process.platform === "linux" ? "/dev/shm" : undefined]) {
		if (!candidate) continue;
		try {
			if (measure(candidate).freeBytes < HEAVY_DISK_NEED_BYTES) return candidate;
		} catch { /* absent or unreadable: try the next candidate */ }
	}
	return null;
}

const LOW_BASE = lowCapacityBase();

// On GitHub's Linux runners the pressure cases are not optional: a runner whose /dev/shm outgrew the need must fail, not skip.
const LOW_FS_REQUIRED = process.platform === "linux" && process.env.GITHUB_ACTIONS === "true";

async function onLowFilesystem(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = ownedTmp("omp-kit-heavy-test", { root: LOW_BASE as string }).path;
	writeFileSync(join(directory, ".owner"), `pid=${process.pid} label=heavy-test-lowfs created=${new Date().toISOString()}\n`, { mode: 0o600 });
	try {
		expect(measure(directory).freeBytes).toBeLessThan(HEAVY_DISK_NEED_BYTES);
		await body(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// One real `heavy --no-wait` of a marker-writing command with `cwd` as the measured directory.
async function nativeRun(input: { cwd: string; config?: Parameters<typeof configure>[1]; sbh?: 0 | 1; preload?: string }) {
	// Positive control for the planted state: this PATH must really lack sbh.
	const pathProbe = await runFixtureAsync(["/bin/sh", "-c", "command -v sbh"], { cwd: input.cwd, env: { PATH: NO_SBH_PATH }, floor_s: 30 });
	expect(pathProbe.rc).not.toBe(0);
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, ...input.config });
	const path = input.sbh === undefined ? NO_SBH_PATH : `${fakeSbh(root, input.sbh, "native-bin")}:${NO_SBH_PATH}`;
	const marker = join(root, "native-marker");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "oq1h1-native", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: path }, { cwd: input.cwd, preload: input.preload ?? null });
	return { code: result.code, stderr: result.stderr, ran: existsSync(marker) };
}

test.skipIf(!LOW_FS_REQUIRED).concurrent("oq1h.1 native: GitHub's Linux runner offers a real filesystem below the 10 GiB need", () => {
	expect(LOW_BASE).not.toBeNull();
});

test.skipIf(LOW_BASE === null).concurrent("oq1h.1 native: statfs pressure on a real low-capacity filesystem defers 75 and never starts the command", async () => {
	await onLowFilesystem(async (cwd) => {
		const result = await nativeRun({ cwd });
		expect(result.code).toBe(75);
		expect(result.stderr).toContain("disk low (statfs)");
		expect(result.ran).toBe(false);
	});
});

test.skipIf(LOW_BASE === null).concurrent("oq1h.1 planted: a forged-healthy statfs reading starts the command on the same real low filesystem", async () => {
	await onLowFilesystem(async (cwd) => {
		const honest = await nativeRun({ cwd });
		expect(honest.code).toBe(75);
		expect(honest.ran).toBe(false);
		// The mutant: only the statfs reading is forced healthy. The 75 above is what the pressure case would then lose.
		const forced = await nativeRun({ cwd, preload: forgeHealthyStatfs });
		expect(forced.code).toBe(0);
		expect(forced.ran).toBe(true);
	});
});

test.skipIf(LOW_BASE === null).concurrent("SAVEFIRST1: explicit statfs returns typed floor refusal", async () => {
	await onLowFilesystem(async (cwd) => {
		const root = fixture();
		configure(root, { slots: 8, max_wait_s: 0 });
		const marker = join(root, "savefirst-floor-marker");
		const result = await invoke(root, ["heavy", "--disk-observer", "statfs", "--", "touch", marker], QUIET_LOAD, { cwd, preload: null });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("heavy: REFUSED reason=DISK_BELOW_FLOOR need=10G");
		expect(result.stderr).toContain("free at least 10 GiB");
		expect(existsSync(marker)).toBe(false);
	});
});

test.skipIf(LOW_BASE === null).concurrent("oq1h.1 native: auto lets a healthy sbh decide over real statfs pressure (sbh precedence)", async () => {
	await onLowFilesystem(async (cwd) => {
		const result = await nativeRun({ cwd, sbh: 0 });
		expect(result.code).toBe(0);
		expect(result.ran).toBe(true);
	});
});

test.skipIf(LOW_BASE === null).concurrent("oq1h.1 native: disk_observer statfs never consults sbh, so a healthy sbh cannot hide real pressure", async () => {
	await onLowFilesystem(async (cwd) => {
		const result = await nativeRun({ cwd, sbh: 0, config: { disk_observer: "statfs" } });
		expect(result.code).toBe(75);
		expect(result.stderr).toContain("disk low (statfs)");
		expect(result.ran).toBe(false);
	});
});

test.concurrent("oq1h.1 native: with no sbh the statfs verdict on the fixture disk equals the independent measurement", async () => {
	const cwd = fixture();
	const pressured = measure(cwd).freeBytes < HEAVY_DISK_NEED_BYTES;
	const result = await nativeRun({ cwd });
	expect(result.code).toBe(pressured ? 75 : 0);
	expect(result.ran).toBe(!pressured);
	if (pressured) expect(result.stderr).toContain("disk low (statfs)");
});

test.concurrent("oq1h.1 native: disk_floor_pct reaches the real CLI verdict", async () => {
	const cwd = fixture();
	const { freeBytes, freePct } = measure(cwd);
	const pressured = freeBytes < HEAVY_DISK_NEED_BYTES || freePct < 50;
	const result = await nativeRun({ cwd, config: { disk_floor_pct: 50 } });
	expect(result.code).toBe(pressured ? 75 : 0);
	expect(result.ran).toBe(!pressured);
});

test.concurrent("oq1h.1 native: a floor above the measured percent defers through diskVerdict", async () => {
	const verdict = await diskVerdict({ config: { slots: 2, max_wait_s: 1, disk_observer: "statfs", disk_floor_pct: 100 }, cwd: fixture() });
	expect(verdict.kind).toBe("pressure");
	if (verdict.kind === "pressure") {
		expect(verdict.observer).toBe("statfs");
		expect(verdict.text).toContain("disk low (statfs)");
	}
});

test.concurrent("SAVEFIRST1: explicit statfs saves bypass percent-stage refusal but auto and sbh retain it", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, disk_observer: "auto", disk_floor_pct: 20 });
	const statfsFixture = join(root, "nine-percent-statfs.ts");
	writeFileSync(statfsFixture, `
import { mock } from "bun:test";
import * as realFs from "node:fs";
const snapshot = { ...realFs };
const realStatfs = realFs.statfsSync;
function ninePercentStatfs(path: realFs.PathLike, options?: never) {
	const observed = realStatfs(path, options);
	const blockSize = Number(observed.bsize);
	const bavail = Math.floor((12 * 1024 ** 3) / blockSize);
	return { ...observed, bavail, blocks: Math.ceil(bavail / 0.09) };
}
mock.module("node:fs", () => ({ ...snapshot, default: { ...snapshot, statfsSync: ninePercentStatfs }, statfsSync: ninePercentStatfs }));
`);
	const marker = join(root, "explicit-statfs-marker");
	const admittedByFlag = await invoke(root,
		["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "save-statfs-flag", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: NO_SBH_PATH }, { preload: statfsFixture });
	expect(admittedByFlag.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");

	const envMarker = join(root, "env-statfs-marker");
	const admittedByEnvironment = await invoke(root,
		["heavy", "--no-wait", "--label", "save-statfs-env", "--", "sh", "-c", `printf ran > '${envMarker}'`],
		{ OMP_KIT_DISK_OBSERVER: "statfs", PATH: NO_SBH_PATH }, { preload: statfsFixture });
	expect(admittedByEnvironment.code).toBe(0);
	expect(readFileSync(envMarker, "utf8")).toBe("ran");

	for (const observer of ["auto", "sbh"] as const) {
		configure(root, { slots: 8, max_wait_s: 1, disk_observer: observer });
		const generic = await invoke(root,
			["heavy", "--no-wait", "--label", `generic-${observer}`, "--", "sh", "-c", "exit 0"],
			{ PATH: NO_SBH_PATH }, { preload: statfsFixture });
		expect(generic.code).toBe(10);
		expect(generic.stdout).toContain("DISK_HEAVY_REFUSED");
	}
	expect(observerRefusals(root)).toEqual(["auto", "sbh"].map(observer => expect.objectContaining({
		label: `generic-${observer}`, phase: "disk-stage", observer: "statfs", kind: "pressure",
		reason: "DISK_HEAVY_REFUSED",
		timing: expect.objectContaining({ start_boundary: null, spawn_to_start_ms: null, start_to_exit_ms: null, deadline_ms: null }),
	})));
});

// ---- SAVEFIRST1 (ompkit-774u.16): --disk-observer lets a save path admit on physical bytes -------------
// The fixture disk must really hold the 10 GiB need for the "ample bytes" half; a runner without it
// skips by name rather than passing on a different state.
const FIXTURE_AMPLE = measure(process.cwd()).freeBytes >= HEAVY_DISK_NEED_BYTES;

test.skipIf(!FIXTURE_AMPLE).concurrent("SAVEFIRST1 planted: --disk-observer statfs admits under sbh pressure when the bytes physically fit (needs >= 10 GiB free)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const pressured = { PATH: `${fakeSbh(root, 1)}:${process.env.PATH ?? ""}:/usr/bin:/bin` };
	const control = join(root, "control-marker");
	// Positive control for the plant: without the flag this sbh really refuses.
	const refused = await invoke(root, ["heavy", "--no-wait", "--label", "sbh-veto", "--", "sh", "-c", `printf ran > '${control}'`], pressured);
	expect(refused.code).toBe(75);
	expect(refused.stderr).toContain("disk low: sbh check --need 10G reports pressure");
	// MACHINEMEASURES1 (ompkit-774u.9.22): the OS reading sits beside the sbh verdict so a wedge is visible.
	expect(refused.stderr).toMatch(/RESOURCE_DEFERRED: disk low: sbh check --need 10G reports pressure; statfs: \d+\.\d GB free \(\d+\.\d%\)/);
	expect(existsSync(control)).toBe(false);
	const marker = join(root, "saved-marker");
	const admitted = await invoke(root, ["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "save-path", "--", "sh", "-c", `printf ran > '${marker}'`], pressured);
	expect(admitted.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
});

test.concurrent("SAVEFIRST1: --disk-observer overrides load.json, so a missing sbh named there cannot block a statfs call", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, disk_observer: "sbh" });
	const noSbh = { PATH: "/usr/bin:/bin" };
	const strict = await invoke(root, ["heavy", "--no-wait", "--label", "cfg-sbh", "--", "sh", "-c", "exit 0"], noSbh);
	expect(strict.code).toBe(HEAVY_PREREQ_MISSING);
	const marker = join(root, "override-marker");
	const overridden = await invoke(root, ["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "cfg-override", "--", "sh", "-c", `printf ran > '${marker}'`], noSbh);
	const pressured = measure(root).freeBytes < HEAVY_DISK_NEED_BYTES;
	expect(overridden.code).toBe(pressured ? 75 : 0);
	expect(existsSync(marker)).toBe(!pressured);
	expect(overridden.stderr).not.toContain("sbh unavailable");
});

test.concurrent("SAVEFIRST1: an unknown --disk-observer value runs nothing", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const marker = join(root, "bogus-marker");
	const result = await invoke(root, ["heavy", "--disk-observer", "bytes", "--", "sh", "-c", `printf ran > '${marker}'`]);
	expect(result.code).toBe(2);
	expect(result.stderr).toContain('--disk-observer must be "statfs", "sbh" or "auto", got "bytes"');
	expect(existsSync(marker)).toBe(false);
});

test.skipIf(LOW_BASE === null).concurrent("SAVEFIRST1 planted: --disk-observer statfs still refuses below the 10 GiB physical floor, whatever sbh says", async () => {
	await onLowFilesystem(async (cwd) => {
		const root = fixture();
		configure(root, { slots: 8, max_wait_s: 1 });
		const marker = join(root, "lowfs-marker");
		const result = await invoke(root, ["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "lowfs-save", "--", "sh", "-c", `printf ran > '${marker}'`],
			{ PATH: `${fakeSbh(root, 0, "native-bin")}:${NO_SBH_PATH}` }, { cwd, preload: null });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("heavy: REFUSED reason=DISK_BELOW_FLOOR need=10G");
		expect(result.stderr).toContain("free at least 10 GiB");
		expect(existsSync(marker)).toBe(false);
	});
});

test.skipIf(!FIXTURE_AMPLE).concurrent("SAVEFIRST1: a waiting job re-reads load.json each poll, so an observer change admits it before its deadline (needs >= 10 GiB free)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 8 });
	const marker = join(root, "refresh-marker");
	const jobs = join(root, "state", "omp-kit", "load", "jobs");
	// The admitted child snapshots its real running row before the parent removes
	// it. Launch/precheck and child-exit delays are outside the admission budget.
	const run = invoke(root, ["heavy", "--label", "stale-config", "--", "sh", "-c", `cat ${JSON.stringify(jobs)}/*.json > ${JSON.stringify(marker)}`],
		{ PATH: `${fakeSbh(root, 1)}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	await waitForLedgerState(root, "queued", 15_000);
	const queuedObservedAt = Date.now();
	configure(root, { slots: 8, max_wait_s: 8, disk_observer: "statfs" });
	const result = await run;
	expect(result.code).toBe(0);
	const admitted = JSON.parse(readFileSync(marker, "utf8"));
	expect(admitted).toMatchObject({ label: "stale-config", state: "running" });
	const admissionWaitMs = Date.parse(admitted.started_at) - queuedObservedAt;
	expect(admissionWaitMs).toBeGreaterThanOrEqual(0);
	expect(admissionWaitMs).toBeLessThan(8_000);
}, fixtureDeadlineS(30) * 1000);

afterAll(() => cleanupAllOwnedTmp());
