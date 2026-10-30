import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../src/kitlib/run.ts";

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_INPUT expected object");
	return value as Record<string, unknown>;
}
function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`INVALID_INPUT ${label}: expected finite nonnegative number`);
	return value;
}
function path(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_INPUT missing path");
	return value;
}
function json(file: string): unknown { return JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")); }
function samples(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("INVALID_INPUT expected nonempty measured rows");
	return value.map(object);
}
function mean(values: number[]): number { return values.reduce((a, b) => a + b, 0) / values.length; }
function cv2(values: number[]): number {
	const average = mean(values);
	return average === 0 ? 0 : mean(values.map(value => (value - average) ** 2)) / average ** 2;
}

const args = process.argv.slice(2);
const machine = args.includes("--json");
try {
	let repo = resolve(import.meta.dir, "..");
	let workers = 4;
	let derive = false;
	let check = false;
	let enforcement: string | undefined;
	let history: string | undefined;
	let timingsDir: string | undefined;
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg || seen.has(arg)) throw new Error(`INVALID_ARGUMENT ${arg}`);
		seen.add(arg);
		if (arg === "--derive") derive = true;
		else if (arg === "--check") check = true;
		else if (arg === "--json") continue;
		else if (["--repo", "--workers", "--enforce", "--verdict-history", "--timings-dir"].includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`INVALID_ARGUMENT missing ${arg} value`);
			if (arg === "--repo") repo = resolve(value);
			else if (arg === "--workers") {
				workers = Number(value);
				if (String(workers) !== value || !Number.isSafeInteger(workers) || workers < 1) throw new Error("INVALID_ARGUMENT workers");
			} else if (arg === "--enforce") enforcement = value;
			else if (arg === "--timings-dir") timingsDir = value;
			else history = value;
		} else throw new Error(`INVALID_ARGUMENT ${arg}`);
	}
	if ((!derive && !enforcement) || (derive && enforcement) || (check && !derive) || (history && !derive) || (timingsDir && !derive)) throw new Error("INVALID_ARGUMENT use --derive [--check] [--timings-dir DIR] or --enforce FILE");
	const config = object(json(resolve(repo, ".github/test-budget.json")));
	if (config.version !== 1) throw new Error("INVALID_INPUT budget version");
	const requirements = object(config.requirements);
	const heuristic = object(config.initial_heuristic);
	const push = number(requirements.push_p95_s, "push_p95_s");
	const cycle = number(requirements.full_cycle_s, "full_cycle_s");
	const cap = number(heuristic.per_file_cap_s, "per_file_cap_s");
	if (push <= 0 || cycle <= 0 || cap !== cycle / 4 || heuristic.status !== "INITIAL_HEURISTIC_NOT_DISTRIBUTION_DERIVED" || heuristic.derivation !== "full_cycle_s / 4") throw new Error("INVALID_INPUT budget derivation");
	const rows: { path: string; elapsed_ms: number }[] = [];
	let timingSource: string | undefined;
	if (enforcement) {
		for (const row of samples(json(enforcement === "-" ? "-" : resolve(repo, enforcement)))) rows.push({ path: path(row.path), elapsed_ms: number(row.elapsed_ms, "elapsed_ms") });
	} else {
		timingSource = resolve(repo, timingsDir ?? ".github");
		if (!timingsDir) {
			const store = await run([
				"python3", resolve(import.meta.dir, "full-suite-verdict-store.py"),
				"timings", "--repo", repo,
			], { deadline_s: 10 });
			if (store.rc !== 0 || store.timed_out || store.truncated) throw new Error("INVALID_INPUT shared verdict timings discovery incomplete");
			const cached = new TextDecoder().decode(store.stdout).trim();
			if (!cached) throw new Error("INVALID_INPUT shared verdict timing path is empty");
			if (["core-test-timings.json", "script-test-timings.json"].every(file => existsSync(resolve(cached, file)))) timingSource = cached;
		}
		const paths = new Set<string>();
		for (const table of ["core-test-timings.json", "script-test-timings.json"]) {
			const timing = object(json(resolve(timingSource, table)));
			if (timing.version !== 1 || Object.keys(timing).some(key => key !== "version" && key !== "files")) throw new Error(`INVALID_INPUT timing schema ${table}: expected version 1/files`);
			const entries = Object.entries(object(timing.files));
			if (!entries.length) throw new Error(`INVALID_INPUT empty timing table ${table}`);
			for (const [name, value] of entries) {
				path(name);
				if (paths.has(name)) throw new Error(`INVALID_INPUT duplicate path ${name}`);
				paths.add(name);
				rows.push({ path: name, elapsed_ms: number(value, name) });
			}
		}
	}
	const violations = rows.filter(row => row.elapsed_ms / 1000 > cap).map(row => ({ code: "OVER_BUDGET", path: row.path, elapsed_s: row.elapsed_ms / 1000, cap_s: cap }));
	let queueing: Record<string, unknown> = { status: "NOT_MEASURED", guarantee: "NONE", reason: "No measured arrival/service history supplied" };
	if (history) {
		const records = samples(json(resolve(repo, history))).map(row => ({ arrival: number(row.arrival_ms, "arrival_ms"), service: number(row.service_ms, "service_ms") })).sort((a, b) => a.arrival - b.arrival);
		if (records.length < 3) throw new Error("INVALID_INPUT history requires at least three arrival/service samples");
		const intervals = records.slice(1).map((row, i) => row.arrival - records[i]!.arrival);
		if (intervals.some(value => value <= 0)) throw new Error("INVALID_INPUT arrivals must be distinct");
		const services = records.map(row => row.service / 1000);
		const lambda = 1000 / mean(intervals);
		const service = mean(services);
		const rho = lambda * service / workers;
		const ca2 = cv2(intervals);
		const cs2 = cv2(services);
		queueing = { status: "MEASURED_DIAGNOSTICS", sample_count: records.length, arrival_rate_per_s: lambda, mean_service_s: service, utilisation: rho, arrival_cv2: ca2, service_cv2: cs2, kingman_single_server_wait_s: workers === 1 && rho < 1 ? ((ca2 + cs2) / 2) * rho / (1 - rho) * service : null, guarantee: "NONE", note: "Kingman is a single-server approximation, not a p95 guarantee; multi-worker wait is not inferred" };
	}
	const longest = rows.reduce((a, b) => b.elapsed_ms > a.elapsed_ms ? b : a);
	const total = rows.reduce((sum, row) => sum + row.elapsed_ms / 1000, 0);
	if (!Number.isFinite(total)) throw new Error("INVALID_INPUT total timing overflow");
	const makespanLowerBound = Math.max(total / workers, longest.elapsed_ms / 1000);
	const aggregateOverBudget = derive && makespanLowerBound > cycle;
	const result = { status: violations.length ? "OVER_BUDGET" : aggregateOverBudget ? "AGGREGATE_OVER_BUDGET" : "OK", mode: enforcement ? "enforce" : "derive", timings_dir: timingSource, W_s: total, p_max_s: longest.elapsed_ms / 1000, p_max_path: longest.path, m: workers, worker_count_source: seen.has("--workers") ? "declared" : "default_not_measured", makespan_lower_bound_s: makespanLowerBound, makespan_bound_note: "Necessary lower bound only; not a scheduling or p95 guarantee", push_p95_s: push, full_cycle_s: cycle, per_file_cap_s: cap, per_file_cap_status: heuristic.status, queueing, violations };
	if (machine) console.log(JSON.stringify(result));
	else {
		console.log(`W=${total}s p_max=${result.p_max_s}s path=${longest.path} m=${workers} (${result.worker_count_source})`);
		console.log(`push_p95_s=${push} full_cycle_s=${cycle} per_file_cap_s=${cap} INITIAL_HEURISTIC (full_cycle_s / 4)`);
		console.log(`queueing=${JSON.stringify(queueing)}`);
		for (const violation of violations) console.log(`OVER_BUDGET ${violation.path} ${violation.elapsed_s} ${violation.cap_s}`);
		if (aggregateOverBudget) console.log(`AGGREGATE_OVER_BUDGET max(W_s/m,p_max_s)=${makespanLowerBound} full_cycle_s=${cycle}; necessary lower bound only, not a p95 guarantee`);
	}
	if (violations.length || aggregateOverBudget) process.exitCode = 1;
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (machine) console.log(JSON.stringify({ status: "ERROR", error: message }));
	else console.error(message);
	process.exitCode = 1;
}
