import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// FILEBUDGET1: wall latency is judged only within a declared measurement
// envelope. Frozen CPU references measure work, never divide wall by host load.
type Reference = {
	wall_s: number; cpu_s: number;
	evidence: { tree: string; verdict_sha256: string; judge_sha256: string; output_sha256: string };
};
type FilePolicy = {
	cap: number; grandfathered: Map<string, number>; references: Map<string, Reference>;
	envelope: { maxLoad: number; workerRule: "gate-default-widths" } | undefined;
};
function digest(value: unknown, length: number): string {
	if (typeof value !== "string" || value.length !== length) throw new Error("INVALID_INPUT reference evidence digest");
	for (const character of value) if (!"0123456789abcdef".includes(character)) throw new Error("INVALID_INPUT reference evidence digest");
	return value;
}
function filePolicy(config: Record<string, unknown>, predecessor = false): FilePolicy {
	const policy = object(config.changed_file_budget);
	const cap = number(policy.cap_s, "changed_file_budget.cap_s");
	if (cap <= 0 || cap > 90) throw new Error("INVALID_INPUT changed-file cap must be in (0, 90] seconds");
	const grandfathered = new Map<string, number>();
	for (const [name, value] of Object.entries(object(policy.grandfathered))) {
		path(name);
		const entry = object(value);
		const measured = number(entry.measured_s, name);
		if (measured <= cap || typeof entry.evidence !== "string" || !entry.evidence.trim()) throw new Error(`INVALID_INPUT grandfather evidence ${name}`);
		grandfathered.set(name, measured);
	}
	const references = new Map<string, Reference>();
	if (predecessor && policy.version === undefined) return { cap, grandfathered, references, envelope: undefined };
	if (policy.version !== 2) throw new Error("INVALID_INPUT changed-file budget version");
	const envelope = object(policy.envelope);
	const maxLoad = number(envelope.max_load_per_cpu, "max_load_per_cpu");
	if (maxLoad <= 0 || maxLoad > 0.5 || envelope.worker_rule !== "gate-default-widths") throw new Error("INVALID_INPUT qualification envelope");
	for (const [name, value] of Object.entries(object(policy.references))) {
		path(name);
		const reference = object(value);
		const wall = number(reference.wall_s, "reference wall_s");
		const cpu = number(reference.cpu_s, "reference cpu_s");
		if (wall <= 0 || cpu <= 0) throw new Error("INVALID_INPUT reference pair must be positive");
		const evidence = object(reference.evidence);
		references.set(name, { wall_s: wall, cpu_s: cpu, evidence: {
			tree: digest(evidence.tree, 40), verdict_sha256: digest(evidence.verdict_sha256, 64),
			judge_sha256: digest(evidence.judge_sha256, 64), output_sha256: digest(evidence.output_sha256, 64),
		} });
	}
	return { cap, grandfathered, references, envelope: { maxLoad, workerRule: "gate-default-widths" } };
}

function checkFilePolicy(config: Record<string, unknown>, baseline: Record<string, unknown>, repo: string) {
	const next = filePolicy(config);
	if (baseline.changed_file_budget === undefined) return; // First adoption only.
	const previous = filePolicy(baseline, true);
	if (next.cap > previous.cap) throw new Error("FILE_BUDGET_RATCHET default cap may only shrink");
	for (const [name, ceiling] of next.grandfathered) {
		const old = previous.grandfathered.get(name);
		if (old === undefined || ceiling > old) throw new Error(`FILE_BUDGET_RATCHET ${name}: grandfather list and measured ceilings may only shrink`);
	}
	if (previous.envelope && next.envelope && next.envelope.maxLoad > previous.envelope.maxLoad) throw new Error("FILE_BUDGET_RATCHET qualification envelope may only tighten");
	for (const [name, reference] of previous.references) {
		const replacement = next.references.get(name);
		if ((!replacement && existsSync(resolve(repo, name))) || (replacement && JSON.stringify(replacement) !== JSON.stringify(reference))) throw new Error(`FILE_BUDGET_RATCHET ${name}: reference pair and evidence are frozen`);
	}
	for (const [name, reference] of next.references) {
		if (!previous.references.has(name) && reference.wall_s > (next.grandfathered.get(name) ?? next.cap)) throw new Error(`FILE_BUDGET_RATCHET ${name}: initial reference exceeds its wall ceiling`);
	}
}

function judgeFiles(policy: FilePolicy, observed: Record<string, unknown>[], changed: Set<string>, gateWorkers?: number, defaultWorkers?: number) {
	const envelope = policy.envelope;
	if (!envelope) throw new Error("INVALID_INPUT missing qualification envelope");
	return observed.filter(row => changed.has(path(row.path))).map(row => {
		const name = path(row.path);
		const elapsed = number(row.elapsed_ms, "elapsed_ms") / 1000;
		const cpu = number(number(row.cpu_user_ms, "cpu_user_ms") + number(row.cpu_system_ms, "cpu_system_ms"), "CPU sum") / 1000;
		const ceiling = policy.grandfathered.get(name) ?? policy.cap;
		const reference = policy.references.get(name);
		const equivalent = reference ? number(cpu / reference.cpu_s * reference.wall_s, "CPU-equivalent wall seconds") : undefined;
		const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
		const ncpu = row.ncpu;
		const workerCount = gateWorkers;
		const qualified = finite(ncpu) && Number.isSafeInteger(ncpu) && ncpu > 0
			&& finite(workerCount) && Number.isSafeInteger(workerCount) && workerCount > 0
			&& finite(row.workers) && row.workers > 0 && Number.isSafeInteger(row.workers) && row.workers <= workerCount
			&& workerCount === defaultWorkers
			&& finite(row.load_1m) && finite(row.load_1m_end)
			&& row.load_1m <= ncpu * envelope.maxLoad && row.load_1m_end <= ncpu * envelope.maxLoad;
		const cpuOver = equivalent !== undefined && equivalent > ceiling;
		const wallOver = qualified && elapsed > ceiling;
		return {
			path: name, elapsed_s: elapsed, cpu_s: cpu, equivalent_wall_s: equivalent, cap_s: ceiling,
			qualified, ncpu, workers: workerCount, default_workers: defaultWorkers, load_1m: row.load_1m, load_1m_end: row.load_1m_end,
			status: cpuOver || wallOver ? "FILE_OVER_BUDGET" : qualified ? "OK" : "NOT_CALIBRATED",
			clock: cpuOver ? "cpu-equivalent" : wallOver ? "qualified-wall" : undefined,
			reference_evidence: reference?.evidence,
		};
	});
}

const args = process.argv.slice(2);
const machine = args.includes("--json");
try {
	let repo = resolve(import.meta.dir, "..");
	let workers = 4;
	let defaultWorkers: number | undefined;
	let annotateRecords = false;
	let derive = false;
	let check = false;
	let enforcement: string | undefined;
	let history: string | undefined;
	let timingsDir: string | undefined;
	let changedFiles: string | undefined;
	let basePolicy: string | undefined;
	let checkFile = false;
	let limitsOnly = false;
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg || seen.has(arg)) throw new Error(`INVALID_ARGUMENT ${arg}`);
		seen.add(arg);
		if (arg === "--derive") derive = true;
		else if (arg === "--check") check = true;
		else if (arg === "--json") continue;
		else if (arg === "--check-file-policy") checkFile = true;
		else if (arg === "--file-limits") limitsOnly = true;
		else if (arg === "--annotate-records") annotateRecords = true;
		else if (["--repo", "--workers", "--default-workers", "--enforce", "--verdict-history", "--timings-dir", "--changed-files", "--base-policy"].includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`INVALID_ARGUMENT missing ${arg} value`);
			if (arg === "--repo") repo = resolve(value);
			else if (arg === "--workers") {
				workers = Number(value);
				if (String(workers) !== value || !Number.isSafeInteger(workers) || workers < 1) throw new Error("INVALID_ARGUMENT workers");
			} else if (arg === "--default-workers") {
				defaultWorkers = Number(value);
				if (String(defaultWorkers) !== value || !Number.isSafeInteger(defaultWorkers) || defaultWorkers < 1) throw new Error("INVALID_ARGUMENT default workers");
			} else if (arg === "--enforce") enforcement = value;
			else if (arg === "--timings-dir") timingsDir = value;
			else if (arg === "--changed-files") changedFiles = value;
			else if (arg === "--base-policy") basePolicy = value;
			else history = value;
		} else throw new Error(`INVALID_ARGUMENT ${arg}`);
	}
	if (limitsOnly ? (checkFile || basePolicy || derive || enforcement || changedFiles || history || timingsDir || check || seen.has("--workers")) : checkFile ? (!basePolicy || derive || enforcement || changedFiles || history || timingsDir || check) : ((!derive && !enforcement) || (derive && enforcement) || (check && !derive) || (history && !derive) || (timingsDir && !derive) || (changedFiles && !enforcement) || basePolicy)) throw new Error("INVALID_ARGUMENT use --file-limits, --check-file-policy --base-policy FILE, --derive [--check] [--timings-dir DIR], or --enforce FILE [--changed-files FILE]");
	if ((defaultWorkers !== undefined && !changedFiles) || (annotateRecords && (!changedFiles || !enforcement || enforcement === "-"))) throw new Error("INVALID_ARGUMENT default workers/record annotation require measured changed files");
	const config = object(json(resolve(repo, ".github/test-budget.json")));
	if (config.version !== 1) throw new Error("INVALID_INPUT budget version");
	if (limitsOnly) {
		const policy = filePolicy(config);
		console.log(JSON.stringify({ cap_s: policy.cap, grandfathered: Object.fromEntries(policy.grandfathered) }));
		process.exit(0);
	}
	if (checkFile) {
		checkFilePolicy(config, object(json(resolve(repo, basePolicy!))), repo);
		console.log(machine ? JSON.stringify({ status: "OK", mode: "file-policy" }) : "FILE_BUDGET_POLICY OK (ceilings may only shrink; references are frozen)");
		process.exit(0);
	}
	const requirements = object(config.requirements);
	const heuristic = object(config.initial_heuristic);
	const push = number(requirements.push_p95_s, "push_p95_s");
	const cycle = number(requirements.full_cycle_s, "full_cycle_s");
	const cap = number(heuristic.per_file_cap_s, "per_file_cap_s");
	if (push <= 0 || cycle <= 0 || cap !== cycle / 4 || heuristic.status !== "INITIAL_HEURISTIC_NOT_DISTRIBUTION_DERIVED" || heuristic.derivation !== "full_cycle_s / 4" || heuristic.mode !== "report") throw new Error("INVALID_INPUT budget derivation or heuristic mode");
	const rows: { path: string; elapsed_ms: number }[] = [];
	let observed: Record<string, unknown>[] = [];
	let timingSource: string | undefined;
	if (enforcement) {
		observed = samples(json(enforcement === "-" ? "-" : resolve(repo, enforcement)));
		for (const row of observed) {
			if (changedFiles && (row.complete !== true || row.rc !== 0)) throw new Error(`INVALID_INPUT incomplete or failed measured file ${row.path}`);
			rows.push({ path: path(row.path), elapsed_ms: number(row.elapsed_ms, "elapsed_ms") });
		}
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
	const fileBudget = changedFiles ? filePolicy(config) : undefined;
	const changed = changedFiles ? new Set(readFileSync(resolve(repo, changedFiles), "utf8").split("\n").filter(Boolean)) : new Set<string>();
	const judgments = fileBudget ? judgeFiles(fileBudget, observed, changed, seen.has("--workers") ? workers : undefined, defaultWorkers) : [];
	const fileViolations = judgments.filter(row => row.status === "FILE_OVER_BUDGET").map(row => ({
		...row, code: "FILE_OVER_BUDGET",
		remedy: "Split this file, preserving assertions, like private-index-land-2/-3 and kit-update-*; do not raise the budget or reference.",
	}));
	const uncalibrated = judgments.filter(row => row.status === "NOT_CALIBRATED");
	if (annotateRecords && enforcement) {
		const byPath = new Map(judgments.map(row => [row.path, row]));
		for (const row of observed) {
			const judgment = byPath.get(path(row.path));
			if (judgment) row.file_budget = judgment;
		}
		// The reusable focused records carry the budget item's actual status,
		// including NOT_CALIBRATED; native-test success is not budget PASS credit.
		writeFileSync(resolve(repo, enforcement), JSON.stringify(observed) + "\n");
	}
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
	const result = { status: violations.length ? "OVER_BUDGET" : aggregateOverBudget ? "AGGREGATE_OVER_BUDGET" : "OK", mode: enforcement ? "enforce" : "derive", timings_dir: timingSource, W_s: total, p_max_s: longest.elapsed_ms / 1000, p_max_path: longest.path, m: workers, worker_count_source: seen.has("--workers") ? "declared" : "default_not_measured", makespan_lower_bound_s: makespanLowerBound, makespan_bound_note: "Necessary lower bound only; not a scheduling or p95 guarantee", push_p95_s: push, full_cycle_s: cycle, per_file_cap_s: cap, per_file_cap_status: heuristic.status, per_file_cap_mode: heuristic.mode, queueing, violations };
	const fileResult = { cap_s: fileBudget?.cap, mode: "enforce", clock: "qualified-wall+cpu-equivalent", envelope: fileBudget?.envelope, judgments, violations: fileViolations, not_calibrated: uncalibrated };
	const output = { ...result, ...(fileBudget ? { file_budget: fileResult } : {}), status: fileViolations.length ? "FILE_OVER_BUDGET" : uncalibrated.length ? "NOT_CALIBRATED" : result.status };
	if (machine) console.log(JSON.stringify(output));
	else {
		console.log(`W=${total}s p_max=${result.p_max_s}s path=${longest.path} m=${workers} (${result.worker_count_source})`);
		console.log(`push_p95_s=${push} full_cycle_s=${cycle} per_file_cap_s=${cap} INITIAL_HEURISTIC (full_cycle_s / 4)`);
		console.log(`queueing=${JSON.stringify(queueing)}`);
		for (const violation of violations) console.log(`OVER_BUDGET ${violation.path} ${violation.elapsed_s} ${violation.cap_s}`);
		if (aggregateOverBudget) console.log(`AGGREGATE_OVER_BUDGET max(W_s/m,p_max_s)=${makespanLowerBound} full_cycle_s=${cycle}; necessary lower bound only, not a p95 guarantee`);
		for (const violation of fileViolations) console.error(`${violation.code} ${violation.path}: ${violation.clock}=${violation.clock === "cpu-equivalent" ? violation.equivalent_wall_s : violation.elapsed_s}s > ${violation.cap_s}s. ${violation.remedy}`);
	}
	for (const row of uncalibrated) console.error(`NOT_CALIBRATED busy machine or non-default worker widths: ${row.path} wall=${row.elapsed_s}s load1=${row.load_1m}/${row.load_1m_end} ncpu=${row.ncpu} workers=${row.workers} default_workers=${row.default_workers}; no budget PASS credit; other gates may continue`);
	// The per-file cap is an initial heuristic, not derived from measured distributions: it reports
	// and never refuses until SUITEBUDGET1 (ompkit-kup44.1) derives it (J-2026-10-31-01).
	if (aggregateOverBudget || fileViolations.length) process.exitCode = 1;
	else if (uncalibrated.length) process.exitCode = 75;
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (machine) console.log(JSON.stringify({ status: "ERROR", error: message }));
	else console.error(message);
	process.exitCode = 1;
}
