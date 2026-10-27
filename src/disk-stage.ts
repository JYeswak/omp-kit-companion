import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runScratchPressureTrigger, type ServiceRunner } from "./service.ts";

export const DISK_WARN_BELOW = 20;
export const DISK_STOP_BELOW = 10;
export const DISK_CRITICAL_BELOW = 5;
export const WRITER_WINDOW_MS = 15 * 60 * 1000;
const BEAD = "ompkit-774u.9.8.1";
export type DiskStage = "ok" | "warn" | "stop" | "critical" | "unknown";
export type DiskRefusal = "DISK_HEAVY_REFUSED" | "DISK_WAVE_REFUSED" | "DISK_OBSERVER_UNAVAILABLE";
export type DiskAdmission = { allowed: true; stage: DiskStage; freePct: number } | { allowed: false; stage: DiskStage; freePct: number | null; code: DiskRefusal; reaper: ReaperObservation };
export type DiskStageOptions = { stateDir?: string; platform?: string; reaper?: ServiceRunner; readFreePct?: (path: string) => number | null; nowMs?: number; allowLowPercentForStatfs?: boolean };
export type ReaperObservation = {
	action: "NOOP" | "WARN" | "UNKNOWN" | "UNSUPPORTED" | "RECLAIM_TRIGGERED" | "RECLAIM_TRIGGER_FAILED";
	command: readonly string[] | null;
	code: number | null;
	stdout: string;
	stderr: string;
};
export type WriterObservation = {
	dir: string;
	bytes: number;
	pid: number | null;
	seat: string;
	bead: string | null;
	alive: boolean;
	interrupted: boolean;
	notifyPath: string | null;
};
export type DiskTickResult = {
	stage: DiskStage;
	freePct: number | null;
	reaper: ReaperObservation;
	writer: WriterObservation | null;
	receiptPath: string;
};

type Snapshot = { ts: number; dirs: Record<string, number> };

export function statvfsFreePercent(path = process.cwd()): number | null {
	try {
		const s = statfsSync(path);
		const blocks = Number(s.blocks);
		const available = Number(s.bavail);
		if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(available) || available < 0) return null;
		return Math.max(0, Math.min(100, available / blocks * 100));
	} catch { return null; }
}

export function diskStage(freePct: number | null): DiskStage {
	if (freePct === null || !Number.isFinite(freePct) || freePct < 0) return "unknown";
	if (freePct < DISK_CRITICAL_BELOW) return "critical";
	if (freePct < DISK_STOP_BELOW) return "stop";
	if (freePct < DISK_WARN_BELOW) return "warn";
	return "ok";
}

function stateRoot(explicit?: string): string {
	return explicit ?? process.env.OMPKIT_DISK_STAGE_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-kit", "disk-stage");
}

function ensureState(root: string): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	mkdirSync(join(root, "outbox"), { recursive: true, mode: 0o700 });
}

function receipt(root: string, stage: DiskStage, freePct: number | null, action: string, detail: Record<string, unknown> = {}): string {
	ensureState(root);
	const path = join(root, "receipts.jsonl");
	appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), bead: BEAD, stage, free_pct: freePct, observer: "statvfs", action, ...detail })}\n`, { mode: 0o600 });
	return path;
}

function nativeReaperRunner(args: readonly string[]): { code: number; stdout: string; stderr: string } {
	try {
		const child = spawnSync(args[0]!, [...args.slice(1)], { stdio: ["ignore", "pipe", "pipe"] });
		return { code: child.status ?? 127, stdout: child.stdout?.toString() ?? "", stderr: child.stderr?.toString() ?? "" };
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}
export function admitDiskWork(kind: "heavy" | "wave", path = process.cwd(), options: DiskStageOptions = {}): DiskAdmission {
	const freePct = (options.readFreePct ?? statvfsFreePercent)(path);
	const stage = diskStage(freePct);
	const root = stateRoot(options.stateDir);
	if (freePct === null || stage === "unknown") {
		const empty: ReaperObservation = { action: "UNKNOWN", command: null, code: null, stdout: "", stderr: "" };
		receipt(root, stage, freePct, "observer-unavailable");
		return { allowed: false, stage: "unknown", freePct, code: "DISK_OBSERVER_UNAVAILABLE", reaper: empty };
	}
	if (stage === "stop" || stage === "critical") {
		if (kind === "heavy" && options.allowLowPercentForStatfs) {
			receipt(root, stage, freePct, "heavy-admit-statfs-physical-check");
			return { allowed: true, stage, freePct };
		}
		const action = reaper(root, freePct, options);
		const code = kind === "heavy" ? "DISK_HEAVY_REFUSED" : "DISK_WAVE_REFUSED";
		receipt(root, stage, freePct, `${kind}-refused`, { code, reaper: action });
		return { allowed: false, stage, freePct, code, reaper: action };
	}
	receipt(root, stage, freePct, `${kind}-admit`);
	return { allowed: true, stage, freePct };
}

function reaper(root: string, freePct: number, options: DiskStageOptions): ReaperObservation {
	const trigger = runScratchPressureTrigger(freePct, options.platform ?? process.platform,
		options.reaper ?? nativeReaperRunner);
	const result = trigger.result;
	const observation: ReaperObservation = {
		action: trigger.action,
		command: trigger.command,
		code: result?.code ?? null,
		stdout: result?.stdout ?? "",
		stderr: result?.stderr ?? "",
	};
	receipt(root, diskStage(freePct), freePct, "reaper", { reaper: observation });
	return observation;
}


function directoryBytes(root: string): number {
	let total = 0;
	const pending = [root];
	for (let scanned = 0; pending.length > 0 && scanned < 100_000; scanned++) {
		const current = pending.pop()!;
		let names: string[];
		try { names = readdirSync(current); } catch { continue; }
		for (const name of names) {
			const path = join(current, name);
			try {
				const item = lstatSync(path);
				if (item.isSymbolicLink()) continue;
				if (item.isDirectory()) pending.push(path);
				else if (item.isFile()) total += item.size;
			} catch { /* Concurrent scratch release is not a writer failure. */ }
		}
	}
	return total;
}

function snapshotWrites(root: string, roots: readonly string[], nowMs: number): Snapshot {
	const dirs: Record<string, number> = {};
	for (const watchRoot of roots) {
		let names: string[];
		try { names = readdirSync(watchRoot); } catch { continue; }
		for (const name of names) {
			const path = join(watchRoot, name);
			try { if (lstatSync(path).isDirectory()) dirs[path] = directoryBytes(path); } catch { /* vanished entry */ }
		}
	}
	const current = { ts: nowMs, dirs };
	ensureState(root);
	appendFileSync(join(root, "writes.jsonl"), `${JSON.stringify(current)}\n`, { mode: 0o600 });
	return current;
}

function readSnapshots(root: string): Snapshot[] {
	try {
		return readFileSync(join(root, "writes.jsonl"), "utf8").split("\n").flatMap(line => {
			try {
				const value: unknown = JSON.parse(line);
				if (typeof value !== "object" || value === null || Array.isArray(value) || !("ts" in value) || !("dirs" in value) || typeof value.ts !== "number" || typeof value.dirs !== "object" || value.dirs === null || Array.isArray(value.dirs)) return [];
				const dirs: Record<string, number> = {};
				for (const [path, bytes] of Object.entries(value.dirs)) if (typeof bytes === "number" && Number.isFinite(bytes)) dirs[path] = bytes;
				return [{ ts: value.ts, dirs }];
			} catch { return []; }
		});
	} catch { return []; }
}

function owner(dir: string): { pid: number | null; seat: string; bead: string | null } {
	try {
		const text = readFileSync(join(dir, ".owner"), "utf8").slice(0, 4096);
		const pidMatch = /\bpid\s*[=:]\s*([0-9]{1,7})\b/.exec(text);
		const seatMatch = /\b(?:seat|agent|owner|actor)\s*[=:]\s*([A-Za-z0-9_.-]+)/.exec(text);
		const beadMatch = /\b(ompkit-[A-Za-z0-9_.-]+)\b/.exec(text);
		return { pid: pidMatch ? Number(pidMatch[1]) : null, seat: seatMatch?.[1]?.slice(0, 64) ?? "", bead: beadMatch?.[1] ?? null };
	} catch { return { pid: null, seat: "", bead: null }; }
}

function processAlive(pid: number | null): boolean {
	if (pid === null || pid <= 1 || pid === process.pid) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function topWriter(root: string, roots: readonly string[], nowMs: number): Omit<WriterObservation, "interrupted" | "notifyPath"> | null {
	const snapshots = readSnapshots(root);
	const baseline = snapshots.filter(item => nowMs - item.ts >= WRITER_WINDOW_MS).sort((left, right) => right.ts - left.ts)[0];
	if (!baseline) return null;
	const current = snapshotWrites(root, roots, nowMs);
	let selected: { dir: string; bytes: number } | null = null;
	for (const [dir, bytes] of Object.entries(current.dirs)) {
		const growth = bytes - (baseline.dirs[dir] ?? 0);
		if (growth > (selected?.bytes ?? 0)) selected = { dir, bytes: growth };
	}
	if (!selected) return null;
	const identity = owner(selected.dir);
	return { ...selected, ...identity, alive: processAlive(identity.pid) };
}

function interrupt(pid: number | null): boolean {
	if (pid === null || pid <= 1 || pid === process.pid) return false;
	try { process.kill(-pid, "SIGINT"); return true; } catch {
		try { process.kill(pid, "SIGINT"); return true; } catch { return false; }
	}
}

function notify(root: string, writer: Omit<WriterObservation, "interrupted" | "notifyPath">, freePct: number): string | null {
	const seat = writer.seat || "unknown-seat";
	const path = join(root, "outbox", `seat-notify-${seat}.txt`);
	try {
		ensureState(root);
		writeFileSync(path, `DISKSTAGE1 CRITICAL (${freePct.toFixed(1)}% free): pid=${writer.pid ?? "unknown"} seat=${seat} bytes=${writer.bytes} dir=${writer.dir}; top writer interrupted; reaper requested\n`, { mode: 0o600 });
		return path;
	} catch { return null; }
}

export function runDiskStageTick(options: DiskTickOptions = {}): DiskTickResult {
	const path = options.path ?? process.cwd();
	const root = stateRoot(options.stateDir);
	const freePct = (options.readFreePct ?? statvfsFreePercent)(path);
	const stage = diskStage(freePct);
	const roots = options.watchRoots ?? [join(path, "var", "agent-tmp")];
	if (freePct === null || stage === "unknown") {
		const empty: ReaperObservation = { action: "UNKNOWN", command: null, code: null, stdout: "", stderr: "" };
		const receiptPath = receipt(root, "unknown", freePct, "observer-unavailable");
		return { stage: "unknown", freePct, reaper: empty, writer: null, receiptPath };
	}
	if (stage === "ok" || stage === "warn") {
		snapshotWrites(root, roots, options.nowMs ?? Date.now());
		const receiptPath = receipt(root, stage, freePct, stage === "warn" ? "warn" : "none");
		return { stage, freePct, reaper: { action: stage === "warn" ? "WARN" : "NOOP", command: null, code: null, stdout: "", stderr: "" }, writer: null, receiptPath };
	}
	const action = reaper(root, freePct, options);
	const candidate = stage === "critical" ? topWriter(root, roots, options.nowMs ?? Date.now()) : null;
	let writer: WriterObservation | null = null;
	if (candidate) {
		const interrupted = interrupt(candidate.pid);
		const notifyPath = notify(root, candidate, freePct);
		writer = { ...candidate, interrupted, notifyPath };
	}
	const receiptPath = receipt(root, stage, freePct, stage === "critical" ? "interrupt-top-writer" : "stop-plus-reaper", { reaper: action, writer });
	return { stage, freePct, reaper: action, writer, receiptPath };
}

export type DiskTickOptions = DiskStageOptions & { path?: string; watchRoots?: readonly string[] };

if (import.meta.main) {
	const args = process.argv.slice(2);
	const mode = args[0];
	const pathAt = args.indexOf("--path");
	const stateAt = args.indexOf("--state-dir");
	const watchAt = args.indexOf("--watch-root");
	const path = pathAt >= 0 ? args[pathAt + 1] : undefined;
	const stateDir = stateAt >= 0 ? args[stateAt + 1] : undefined;
	const watchRoot = watchAt >= 0 ? args[watchAt + 1] : undefined;
	if (mode === "--tick") {
		const result = runDiskStageTick({ ...(path ? { path } : {}), ...(stateDir ? { stateDir } : {}), ...(watchRoot ? { watchRoots: [watchRoot] } : {}) });
		process.stdout.write(`DISKSTAGE1 ${result.stage.toUpperCase()} free=${result.freePct === null ? "unknown" : result.freePct.toFixed(1)}%\n`);
		process.exitCode = result.stage === "unknown" ? 69 : result.stage === "ok" || result.stage === "warn" ? 0 : 1;
	} else if (mode === "--admit" && (args[1] === "heavy" || args[1] === "wave")) {
		const result = admitDiskWork(args[1], path ?? process.cwd(), stateDir ? { stateDir } : {});
		if (!result.allowed) process.stdout.write(`${result.code}\n`);
		process.exitCode = result.allowed ? 0 : result.code === "DISK_OBSERVER_UNAVAILABLE" ? 69 : 10;
	} else {
		process.stderr.write("disk-stage: use --tick or --admit heavy|wave\n");
		process.exitCode = 2;
	}
}
