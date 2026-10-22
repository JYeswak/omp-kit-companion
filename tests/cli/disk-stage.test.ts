import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { admitDiskWork, diskStage, runDiskStageTick, WRITER_WINDOW_MS } from "../../src/disk-stage.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = join(root, "var", "agent-tmp");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const created: string[] = [];

afterEach(() => {
	for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(label: string): string {
	const path = mkdtempSync(join(scratch, `diskstage-${label}.`));
	created.push(path);
	return path;
}

function reaperResult(args: readonly string[]) {
	return { code: 0, stdout: args.join(" "), stderr: "" };
}
function lowDiskPreload(state: string): string {
	const path = join(state, "low-statfs.ts");
	writeFileSync(path, `import { mock } from "bun:test";
import * as realFs from "node:fs";

const snapshot = { ...realFs };
const realStatfs = realFs.statfsSync;
function forcedStatfs(path: realFs.PathLike, options?: never) {
	const observed = realStatfs(path, options);
	const freePct = Number(process.env.OMP_TEST_DISK_FREE_PCT ?? "4.7");
	return { ...observed, bavail: Math.floor(Number(observed.blocks) * freePct / 100) };
}
mock.module("node:fs", () => ({ ...snapshot, default: { ...snapshot, statfsSync: forcedStatfs }, statfsSync: forcedStatfs }));
`);
	return path;
}

function lowDiskPythonPreload(state: string): string {
	const path = join(state, "sitecustomize.py");
	writeFileSync(path, `import os
_real_statvfs = os.statvfs
def _forced_statvfs(path):
    observed = _real_statvfs(path)
    free_pct = float(os.environ.get("OMP_TEST_DISK_FREE_PCT", "4.7"))
    class ForcedStatvfs:
        f_blocks = observed.f_blocks
        f_bavail = int(observed.f_blocks * free_pct / 100)
    return ForcedStatvfs()
os.statvfs = _forced_statvfs
`);
	return path;
}

test("DISKSTAGE-WIRE1 exact thresholds keep the 21% control and refuse below 10%", () => {
	expect(diskStage(21)).toBe("ok");
	expect(diskStage(20)).toBe("ok");
	expect(diskStage(19.9)).toBe("warn");
	expect(diskStage(10)).toBe("warn");
	expect(diskStage(9)).toBe("stop");
	expect(diskStage(5)).toBe("stop");
	expect(diskStage(4.7)).toBe("critical");
});

test("DISKSTAGE-WIRE1 real admission is before work and records the reaper refusal", () => {
	const state = fixture("admit");
	const control = admitDiskWork("heavy", root, { stateDir: state, readFreePct: () => 21, platform: "linux", reaper: reaperResult });
	expect(control).toMatchObject({ allowed: true, stage: "ok", freePct: 21 });
	const refused = admitDiskWork("wave", root, { stateDir: state, readFreePct: () => 9, platform: "linux", reaper: reaperResult });
	expect(refused.allowed).toBe(false);
	if (refused.allowed) return;
	expect(refused).toMatchObject({ code: "DISK_WAVE_REFUSED", stage: "stop", reaper: { action: "RECLAIM_TRIGGERED", code: 0 } });
	const rows = readFileSync(join(state, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
	expect(rows.some(row => row.action === "reaper" && (row.reaper as Record<string, unknown>)?.action === "RECLAIM_TRIGGERED")).toBe(true);
	expect(rows.some(row => row.action === "wave-refused" && row.code === "DISK_WAVE_REFUSED")).toBe(true);
});
test("DISKSTAGE-WIRE1 real entrypoints admit the paired 21% boundary", () => {
	const state = fixture("admit-entrypoints");
	const env = {
		...process.env,
		OMP_TEST_DISK_FREE_PCT: "21",
		OMPKIT_DISK_STAGE_STATE: state,
		XDG_STATE_HOME: state,
		XDG_CONFIG_HOME: state,
		HOME: state,
		OMP_KIT_HEAVY_FAKE_LOAD1: "0.5",
		AGENT_NAME: "diskstage-test",
		PATH: `${state}:${process.env.PATH ?? ""}`,
	};
	const heavyPreload = lowDiskPreload(state);
	lowDiskPythonPreload(state);
	const heavyMarker = join(state, "heavy-ran");
	const heavy = spawnSync(process.execPath, ["--preload", heavyPreload, resolve(root, "src/cli.ts"), "heavy", "--no-wait", "--disk-observer", "statfs", "--", "sh", "-c", `printf ran > '${heavyMarker}'`], {
		cwd: root, env, encoding: "utf8",
	});
	expect(heavy.status, heavy.stderr).toBe(0);
	expect(heavy.stdout).not.toContain("DISK_HEAVY_REFUSED");
	expect(readFileSync(heavyMarker, "utf8")).toBe("ran");
	const wave = spawnSync("python3", [resolve(root, "scripts/wave_log.py"), "open", "--path", root, "--kind", "build", "--state-dir", state, "--repo", root, "--agent", "diskstage-test", "--json"], {
		cwd: root,
		env: { ...env, PYTHONPATH: `${state}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}` },
		encoding: "utf8",
	});
	expect(wave.status, wave.stderr).toBe(0);
	expect(wave.stdout).toContain('"overall": "OK"');
	expect(existsSync(join(state, "waves", "waves.jsonl"))).toBe(true);
});

test("DISKSTAGE-WIRE1 planted STOP/CRITICAL refusal cannot bypass real heavy or wave entrypoints", () => {
	for (const freePct of [9, 4.7]) {
		const state = fixture(`refusal-${String(freePct).replace(".", "-")}`);
		const expectedStage = freePct < 5 ? "critical" : "stop";
		const env = {
			...process.env,
			OMP_TEST_DISK_FREE_PCT: String(freePct),
			OMPKIT_DISK_STAGE_STATE: state,
			XDG_STATE_HOME: state,
			XDG_CONFIG_HOME: state,
			HOME: state,
			OMP_KIT_HEAVY_FAKE_LOAD1: "0.5",
			OMP_KIT_DISK_OBSERVER: "",
			AGENT_NAME: "diskstage-test",
			PATH: `${state}:${process.env.PATH ?? ""}`,
		};
		const launchctl = join(state, "launchctl");
		writeFileSync(launchctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const heavyPreload = lowDiskPreload(state);
		lowDiskPythonPreload(state);
		for (const kind of ["heavy", "wave"] as const) {
			const admission = admitDiskWork(kind, root, { stateDir: state, readFreePct: () => freePct, platform: "other", reaper: reaperResult });
			expect(admission).toMatchObject({ allowed: false, stage: expectedStage, freePct, code: kind === "heavy" ? "DISK_HEAVY_REFUSED" : "DISK_WAVE_REFUSED" });
		}
		const heavyMarker = join(state, "heavy-ran");
		const heavy = spawnSync(process.execPath, ["--preload", heavyPreload, resolve(root, "src/cli.ts"), "heavy", "--no-wait", "--", "sh", "-c", `printf ran > '${heavyMarker}'`], { cwd: root, env, encoding: "utf8" });
		expect(heavy.status).toBe(10);
		expect(heavy.stdout).toContain("DISK_HEAVY_REFUSED");
		expect(existsSync(heavyMarker)).toBe(false);
		expect(existsSync(join(state, "load"))).toBe(false);
		const wave = spawnSync("python3", [resolve(root, "scripts/wave_log.py"), "open", "--path", root, "--kind", "build", "--state-dir", state, "--repo", root, "--agent", "diskstage-test", "--json"], {
			cwd: root,
			env: { ...env, PYTHONPATH: `${state}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}` },
			encoding: "utf8",
		});
		expect(wave.status).toBe(10);
		expect(wave.stdout).toContain("DISK_WAVE_REFUSED");
		expect(existsSync(join(state, "waves", "waves.jsonl"))).toBe(false);
	}
});


test("DISKSTAGE-WIRE1 critical tick names and interrupts the top writer", () => {
	const state = fixture("critical-state");
	const watch = fixture("critical-watch");
	const writer = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	try {
		if (writer.pid === undefined) throw new Error("writer pid unavailable");
		const writerDir = join(watch, "writer.1");
		mkdirSync(writerDir, { mode: 0o700 });
		writeFileSync(join(writerDir, ".owner"), `pid=${writer.pid}\nseat=writer-seat\nbead=ompkit-774u.9.8.1\n`, { mode: 0o600 });
		writeFileSync(join(writerDir, "bytes"), "x", { mode: 0o600 });
		runDiskStageTick({ stateDir: state, path: root, watchRoots: [watch], readFreePct: () => 21, nowMs: 1, platform: "linux", reaper: reaperResult });
		appendFileSync(join(writerDir, "bytes"), "xxxxxxxx", { encoding: "utf8" });
		const result = runDiskStageTick({ stateDir: state, path: root, watchRoots: [watch], readFreePct: () => 4.7, nowMs: 1 + WRITER_WINDOW_MS + 1, platform: "linux", reaper: reaperResult });
		expect(result.stage).toBe("critical");
		expect(result.writer).toMatchObject({ pid: writer.pid, seat: "writer-seat", bytes: 8, interrupted: true });
		if (result.writer?.notifyPath) expect(existsSync(result.writer.notifyPath)).toBe(true);
		const rows = readFileSync(join(state, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		const critical = rows.find(row => row.action === "interrupt-top-writer");
		expect(critical).toBeDefined();
		expect(critical?.writer).toMatchObject({ pid: writer.pid, seat: "writer-seat", bytes: 8 });
	} finally {
		writer.kill();
	}
});

test("DISKSTAGE-WIRE1 real heavy and wave entrypoints admit on the control filesystem", () => {
	const state = fixture("entrypoints");
	const env = {
		...process.env,
		OMP_TEST_DISK_FREE_PCT: "21",
		OMPKIT_DISK_STAGE_STATE: state,
		XDG_STATE_HOME: state,
		XDG_CONFIG_HOME: state,
		HOME: state,
		OMP_KIT_HEAVY_FAKE_LOAD1: "0.5",
		AGENT_NAME: "diskstage-test",
	};
	const heavyPreload = lowDiskPreload(state);
	const heavy = spawnSync(process.execPath, ["--preload", heavyPreload, resolve(root, "src/cli.ts"), "heavy", "--no-wait", "--disk-observer", "statfs", "--", "true"], { cwd: root, env, encoding: "utf8" });
	expect(heavy.status, heavy.stderr).toBe(0);
	lowDiskPythonPreload(state);
	const wave = spawnSync("python3", [resolve(root, "scripts/wave_log.py"), "open", "--kind", "build", "--state-dir", state, "--repo", root, "--agent", "diskstage-test", "--json"], {
		cwd: root, env: { ...env, PYTHONPATH: `${state}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}` }, encoding: "utf8",
	});
	expect(wave.status, wave.stderr).toBe(0);
	expect(JSON.parse(wave.stdout).overall).toBe("OK");
});
