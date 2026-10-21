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
	const env = { ...process.env, OMPKIT_DISK_STAGE_STATE: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, HOME: state, OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", AGENT_NAME: "diskstage-test" };
	const heavy = spawnSync(process.execPath, [resolve(root, "src/cli.ts"), "heavy", "--no-wait", "--disk-observer", "statfs", "--", "true"], { cwd: root, env, encoding: "utf8" });
	expect(heavy.status).toBe(0);
	const wave = spawnSync("python3", [resolve(root, "scripts/wave_log.py"), "open", "--kind", "build", "--state-dir", state, "--repo", root, "--agent", "diskstage-test", "--json"], { cwd: root, env, encoding: "utf8" });
	expect(wave.status).toBe(0);
	expect(JSON.parse(wave.stdout).overall).toBe("OK");
});
