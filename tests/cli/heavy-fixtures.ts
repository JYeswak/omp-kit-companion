import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { ownedTmp } from "../../src/kitlib/tmp";
import { readJsonl } from "../../src/kitlib/jsonl";
import type { diskVerdict } from "../../src/heavy.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

type HeavyFixtureConfig = Partial<NonNullable<NonNullable<Parameters<typeof diskVerdict>[0]>["config"]>> & { default_runtime_s?: number };

export const entry = resolve(import.meta.dir, "../../src/cli.ts");

export function fixture(): string {
	const root = join(process.cwd(), "var", "agent-tmp");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = ownedTmp("heavy-test", { root }).path;
	writeFileSync(join(dir, ".owner"), `pid=${process.pid} label=heavy-test repo=${process.cwd()} created=${new Date().toISOString()}\n`, { mode: 0o600 });
	return dir;
}

export function configure(root: string, values: HeavyFixtureConfig): void {
	const directory = join(root, "config", "omp-kit");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, "load.json"), JSON.stringify(values), { mode: 0o600 });
}

// Queue and load tests run at a controlled healthy disk reading; the native
// heavy-statfs.test.ts separately exercises the real pressure boundary and its mutant.
export function heavyEnv(root: string, extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
	const healthy = fakeSbh(root, 0, "healthy-bin");
	return { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PATH: `${healthy}:${process.env.PATH ?? ""}:/usr/bin:/bin`, TMUX_PANE: "", AGENT_NAME: "heavy-test", GITHUB_ACTIONS: "", OMP_KIT_DISK_OBSERVER: "", ...QUIET_LOAD, ...extraEnv };
}

export async function invoke(root: string, args: string[], extraEnv: Record<string, string> = {}, options: { cwd?: string; preload?: string | null } = {}) {
	const preloadPath = options.preload === null ? undefined : options.preload ?? forgeHealthyStatfs;
	const preload = preloadPath ? ["--preload", preloadPath] : [];
	const result = await runFixtureAsync([process.execPath, ...preload, entry, ...args], {
		cwd: options.cwd ?? root, env: heavyEnv(root, extraEnv), floor_s: 60, label: "heavy CLI fixture",
	});
	const stdout = new TextDecoder().decode(result.stdout);
	const stderr = new TextDecoder().decode(result.stderr);
	const code = result.rc;
	// Fixture HOME is removed after this file. Preserve timeout measurements in
	// the suite's captured output too, without changing the CLI's returned stderr.
	const refusalPath = join(root, "state", "omp-kit", "load", "observer-refusals.jsonl");
	if (code !== 0 && existsSync(refusalPath)) {
		const timeouts = readJsonl(refusalPath, { maxBytes: 1024 * 1024 }).rows.filter(row =>
			typeof row === "object" && row !== null && "kind" in row && row.kind === "timeout");
		if (timeouts.length) console.error("HEAVY_OBSERVER_TIMEOUT", JSON.stringify(timeouts));
	}
	return { code, stdout, stderr };
}

export async function seedJob(root: string, input: { id: string; pid?: number; process_start?: string; pane?: string; state?: "queued" | "running" }): Promise<string> {
	const stateRoot = join(root, "state", "omp-kit", "load");
	const directory = join(stateRoot, "jobs");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let processStart = input.process_start;
	if (!processStart) {
		const result = await runFixtureAsync(["ps", "-p", String(process.pid), "-o", "lstart="],
			{ cwd: root, floor_s: 30, label: "heavy fixture owner identity" });
		processStart = result.rc === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
	}
	if (!processStart) throw new Error("test process start is unavailable");
	writeFileSync(join(directory, `${input.id}.json`), JSON.stringify({
		id: input.id, pid: input.pid ?? process.pid, process_start: processStart, label: "existing", repo: root, cwd: root,
		agent: "seed", tmux_pane: input.pane ?? "", argv: ["held-job"], state: input.state ?? "running",
		queued_at: new Date(0).toISOString(), started_at: new Date(0).toISOString(),
	}), { mode: 0o600 });
	return directory;
}

// Slot-logic tests pin the heavy-specific load seam so the
// slot behavior under test, not ambient runner load, decides the outcome.
// The LOAD1 gate itself stays covered by the machineLoadBlockReason tests.
export const QUIET_LOAD = { OMP_KIT_HEAVY_FAKE_LOAD1: "0.5" };

// Integration suites drive real child processes (slot handoff, signal
// delivery); fake timers cannot stand in, so coordination waits poll the job
// ledger for the awaited state with a deadline instead of sleeping blindly.
export async function waitForLedgerState(root: string, want: "queued" | "running" | "empty", timeoutMs: number): Promise<void> {
	const directory = join(root, "state", "omp-kit", "load", "jobs");
	timeoutMs = fixtureDeadlineS(timeoutMs / 1000) * 1000;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
		} catch { /* jobs dir appears on first write */ }
		if (want === "empty" && entries.length === 0) return;
		if (want === "queued" || want === "running") {
			for (const name of entries) {
				try {
					if (JSON.parse(readFileSync(join(directory, name), "utf8")).state === want) return;
				} catch { /* concurrent write; keep polling */ }
			}
		}
		await Bun.sleep(100);
	}
	throw new Error(`ledger never reached ${want} within ${timeoutMs}ms`);
}

export function fakeSbh(dir: string, code: number, name = "fakebin"): string {
	const bin = join(dir, name);
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nif [ "$1 $2 $3" = "check --need 10G" ]; then exit ${code}; fi\nexit 0\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	return bin;
}

export function observerRefusals(root: string) {
	const ledger = readJsonl(join(root, "state", "omp-kit", "load", "observer-refusals.jsonl"), { maxBytes: 1024 * 1024 });
	expect(ledger.missing).toBe(false);
	expect(ledger.errors).toEqual([]);
	expect(ledger.more).toBe(false);
	expect(ledger.pending_tail_bytes).toBe(0);
	return ledger.rows;
}

// First call healthy (the pre-queue observation); every later call exits laterCode.
export function countingSbh(dir: string, laterCode: number): string {
	const bin = join(dir, "counting-bin");
	const calls = join(dir, "sbh-calls");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nn=0\nif [ -r '${calls}' ]; then IFS= read -r n < '${calls}'; fi\nn=$((n + 1))\nprintf '%s\\n' "$n" > '${calls}'\n[ "$n" -le 1 ] && exit 0\nexit ${laterCode}\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	return bin;
}

export const forgeHealthyStatfs = resolve(import.meta.dir, "fixtures", "forge-healthy-statfs.ts");
