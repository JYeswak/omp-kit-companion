import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { dirname, join, resolve } from "node:path";
import { proveSend, type ProvenSend } from "./send.ts";
import { isRecord } from "./type-guards.ts";
import { intakeCountsLine, readIntakeRows, summarizeIntakeHour, INTAKE_DELIVER_HOUR_MS } from "./intake-deliver.ts";

export const REPORT_INJECT_JOB = "fleet-report";
export const REPORT_INJECT_INTERVAL_SECONDS = 3600;
export const REPORT_INJECT_DEADLINE_MS = 85_000;
export const REPORT_INJECT_STALE_MS = 70 * 60_000;
export const REPORT_INJECT_MAX_DIGEST_LINES = 60;

export interface ReportInjectConfig {
	/** Canonical chief-tool root (scripts/sitrep.sh, fleet-state.py), not release root. */
	reportRoot: string;
	home: string;
	dropDir: string;
	fleetConfigPath?: string;
	/** Absolute repo root holding intake.jsonl; appends the hourly intake counts line. */
	intakeRepo?: string;
}

export interface ReportInjectCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface ReportInjectDeps {
	run?: (argv: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => ReportInjectCommandResult;
	send?: typeof proveSend;
	now?: () => Date;
	log?: (line: string) => void;
}

export type ReportSourceAges = {
	sitrep: string;
	fleetState: string;
	fleetPulse: string;
	fleetFlow: string;
	mission: string;
};

export interface ReportProjectRow {
	name: string;
	status: "OK" | "UNKNOWN" | "STALE";
	detail: string;
}

export interface ReportInjectResult {
	status: "DELIVERED" | "FAILED";
	exit: 0 | 1;
	reportPath: string;
	generatedAt: string;
	sourceAges: ReportSourceAges;
	projects: ReportProjectRow[];
	send: ProvenSend | null;
	error?: "CHIEF_PANE_MISSING" | "REPORT_PRODUCER_FAILED" | "SEND_NOT_DELIVERED" | "SEND_BUDGET_EXHAUSTED";
}

interface FleetState {
	generated_at: string;
	sessions: { session: string }[];
}

type PulseRow = Record<string, unknown> & { repo?: unknown; ts?: unknown };

function defaultRun(argv: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): ReportInjectCommandResult {
	try {
		const out = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", env, timeout: timeoutMs });
		return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
	} catch (error) {
		return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}


function readFleetConfig(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function configSessions(config: Record<string, unknown> | null): string[] {
	if (!config) return [];
	const names: string[] = [];
	for (const key of ["sessions", "herdr"]) {
		const entries = config[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (isRecord(entry) && typeof entry.session === "string" && entry.session.trim()) names.push(entry.session.trim());
		}
	}
	return [...new Set(names)];
}

function stateFrom(text: string): FleetState | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || typeof parsed.generated_at !== "string" || !Array.isArray(parsed.sessions)) return null;
		const sessions: { session: string }[] = [];
		for (const entry of parsed.sessions) {
			if (!isRecord(entry) || typeof entry.session !== "string" || !entry.session.trim()) return null;
			sessions.push({ session: entry.session.trim() });
		}
		return { generated_at: parsed.generated_at, sessions };
	} catch {
		return null;
	}
}

function timestampMs(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function ageLabel(sourceAt: unknown, generatedAtMs: number): string {
	const sourceMs = timestampMs(sourceAt);
	if (sourceMs === null || sourceMs > generatedAtMs) return "UNKNOWN";
	const ageMs = generatedAtMs - sourceMs;
	if (ageMs > REPORT_INJECT_STALE_MS) return "STALE";
	return `${Math.floor(ageMs / 1000)}s`;
}

function boundedAge(elapsedMs: number, sectionVisible: boolean): string {
	if (!sectionVisible) return "UNKNOWN";
	if (elapsedMs > REPORT_INJECT_STALE_MS) return "STALE";
	return `<=${Math.max(0, Math.ceil(elapsedMs / 1000))}s`;
}

function pulseOffset(path: string): number | null {
	try { return existsSync(path) ? readFileSync(path).byteLength : 0; }
	catch { return null; }
}

function pulseRowsSince(path: string, offset: number | null): PulseRow[] | null {
	if (offset === null) return null;
	try {
		const bytes = readFileSync(path);
		if (bytes.byteLength < offset) return null;
		const appended = bytes.subarray(offset).toString("utf8");
		const rows: PulseRow[] = [];
		for (const raw of appended.split("\n")) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line) continue;
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) return null;
			rows.push(parsed as PulseRow);
		}
		return rows;
	} catch {
		return null;
	}
}

function latestPulseRows(rows: PulseRow[] | null): Map<string, PulseRow> | null {
	if (rows === null) return null;
	const latest = new Map<string, PulseRow>();
	for (const row of rows) {
		if (typeof row.repo !== "string" || !row.repo.trim()) continue;
		latest.set(row.repo, row);
	}
	return latest;
}

function pulseProjectRows(names: readonly string[], latest: Map<string, PulseRow> | null, generatedAtMs: number): ReportProjectRow[] {
	return names.map(name => {
		const row = latest?.get(name);
		if (!row) return { name, status: "UNKNOWN", detail: "fleet-pulse row unavailable" };
		const age = ageLabel(row.ts, generatedAtMs);
		if (age === "STALE") return { name, status: "STALE", detail: "fleet-pulse older than 70 minutes" };
		if (age === "UNKNOWN") return { name, status: "UNKNOWN", detail: "fleet-pulse timestamp unavailable" };
		if (typeof row.error === "string" && row.error) return { name, status: "UNKNOWN", detail: "fleet-pulse reported a project error" };
		for (const [key, value] of Object.entries(row)) {
			if (key.endsWith("_error") && typeof value === "string" && value) return { name, status: "UNKNOWN", detail: "fleet-pulse reported a producer error" };
		}
		for (const key of ["ready", "in_progress", "closed_24h", "blocked", "blocked_no_fix"]) {
			if (typeof row[key] !== "number" || !Number.isFinite(row[key])) return { name, status: "UNKNOWN", detail: `${key} unavailable` };
		}
		return {
			name,
			status: "OK",
			detail: `ready=${row.ready} in_progress=${row.in_progress} closed_24h=${row.closed_24h} blocked=${row.blocked} blocked_no_fix=${row.blocked_no_fix}`,
		};
	});
}

function pulseAgeLabel(latest: Map<string, PulseRow> | null, projects: readonly ReportProjectRow[], generatedAtMs: number): string {
	if (latest === null || projects.length === 0) return "UNKNOWN";
	if (projects.some(row => row.status === "STALE")) return "STALE";
	if (projects.some(row => row.status !== "OK")) return "UNKNOWN";
	let oldest = 0;
	for (const project of projects) {
		const age = ageLabel(latest.get(project.name)?.ts, generatedAtMs);
		if (age === "STALE" || age === "UNKNOWN") return age;
		oldest = Math.max(oldest, Number(age.slice(0, -1)));
	}
	return `${oldest}s`;
}


function chiefRoute(config: Record<string, unknown> | null): { session: string; pane: string } | null {
	const chief = config?.chief;
	if (!isRecord(chief) || typeof chief.session !== "string" || !chief.session.trim() || typeof chief.pane !== "string" || !chief.pane.trim()) return null;
	return { session: chief.session.trim(), pane: chief.pane.trim() };
}

function atomicReplace(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	try {
		for (const name of readdirSync(dirname(path))) {
			if (name.endsWith(".tmp")) { try { unlinkSync(join(dirname(path), name)); } catch { /* best effort */ } }
		}
	} catch { /* best effort: a stale crash orphan is never fatal */ }
	atomicReplaceBytes(path, Buffer.from(body, "utf8"), { mode: 0o600, durability: "none" });
}


export function intakeDigestLine(repo: string | undefined, nowMs: number): string | null {
	if (typeof repo !== "string" || repo.trim() === "") return null;
	let rows;
	try {
		rows = readIntakeRows(repo);
	} catch {
		return null;
	}
	const hourStart = Math.floor(nowMs / INTAKE_DELIVER_HOUR_MS) * INTAKE_DELIVER_HOUR_MS;
	return intakeCountsLine(summarizeIntakeHour(rows, hourStart));
}

function digestText(generatedAt: string, ages: ReportSourceAges, projects: readonly ReportProjectRow[], reportPath: string): string {
	const first = `REPORTINJECT1 generated_at=${generatedAt} source_age(sitrep)=${ages.sitrep} fleet-state=${ages.fleetState} fleet-pulse=${ages.fleetPulse} fleet-flow=${ages.fleetFlow} mission=${ages.mission}`;
	const projectLimit = REPORT_INJECT_MAX_DIGEST_LINES - 3;
	const lines = [first, ...projects.slice(0, projectLimit).map(row => {
		const name = row.name.split("\r").join(" ").split("\n").join(" ").slice(0, 80);
		return `${name}: ${row.status === "OK" ? row.detail : `${row.status} (${row.detail})`}`;
	})];
	if (projects.length > projectLimit) lines.push(`... ${projects.length - projectLimit} project row(s) omitted`);
	lines.push(`Full report: ${reportPath}`);
	return lines.join("\n");
}


function dateFromReport(report: string): string | null {
	const first = report.split("\n", 1)[0] ?? "";
	const marker = "SITREP ";
	if (!first.startsWith(marker)) return null;
	const value = first.slice(marker.length).trim();
	return timestampMs(value) === null ? null : value;
}

function safeFailureText(text: string): string {
	return text.split("\n", 1)[0]!.split("\r").join(" ").slice(0, 240);
}

export async function runReportInjectJob(config: ReportInjectConfig, deps: ReportInjectDeps = {}): Promise<ReportInjectResult> {
	const started = performance.now();
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? (line => console.log(line));
	const runner = deps.run ?? defaultRun;
	const send = deps.send ?? proveSend;
	const reportRoot = resolve(config.reportRoot);
	const home = resolve(config.home);
	if (!reportRoot.startsWith("/") || reportRoot !== config.reportRoot || !home.startsWith("/") || home !== config.home) {
		const reportPath = join(reportRoot, "docs", "fleet-state", "latest.md");
		return { status: "FAILED", exit: 1, reportPath, generatedAt: now().toISOString(), sourceAges: { sitrep: "UNKNOWN", fleetState: "UNKNOWN", fleetPulse: "UNKNOWN", fleetFlow: "UNKNOWN", mission: "UNKNOWN" }, projects: [], send: null, error: "REPORT_PRODUCER_FAILED" };
	}
	const reportDir = join(reportRoot, "docs", "fleet-state");
	const reportPath = join(reportDir, "latest.md");
	const statePath = join(reportDir, "latest.json");
	const configPath = config.fleetConfigPath ?? process.env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
	const configData = readFleetConfig(configPath);
	const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, OMP_KIT_FLEET_WATCH_CONFIG: configPath, FW_CFG: configPath };
	delete childEnv.MUTANT_SKIP_DIVERGENCE;
	const pulseLogPath = join(reportRoot, "var", "sitrep", "pulse.jsonl");
	const pulseStart = pulseOffset(pulseLogPath);
	const reportStart = now();
	const invoke = (argv: readonly string[]): ReportInjectCommandResult => {
		const timeout = Math.max(0, REPORT_INJECT_DEADLINE_MS - (performance.now() - started));
		if (timeout <= 0) return { code: null, stdout: "", stderr: "REPORTINJECT1 deadline exhausted" };
		return runner(argv, childEnv, timeout);
	};

	const stateRun = invoke(["python3", join(reportRoot, "scripts", "fleet-state.py"), "--json", "--out", reportDir]);
	const stateText = stateRun.code === 0 ? stateRun.stdout : "";
	const state = stateFrom(stateText);

	const sitrepRun = invoke(["sh", join(reportRoot, "scripts", "sitrep.sh")]);
	const runFinished = now();
	const sitrepGeneratedAt = dateFromReport(sitrepRun.stdout);
	let reportBody = sitrepRun.stdout;
	if (sitrepRun.code !== 0) {
		const reason = sitrepRun.code === null ? "timeout or spawn failure" : `exit ${sitrepRun.code}`;
		reportBody = `${reportBody}${reportBody.endsWith("\n") || reportBody === "" ? "" : "\n"}SITREP UNKNOWN (${reason})\n`;
	}
	if (reportBody === "") reportBody = "SITREP UNKNOWN (producer returned no report)\n";
	atomicReplace(reportPath, reportBody);

	const pulseRows = pulseRowsSince(pulseLogPath, pulseStart);
	const generatedAt = runFinished.toISOString();
	const generatedAtMs = runFinished.getTime();
	const stateAge = ageLabel(state?.generated_at, generatedAtMs);
	const stateCurrent = stateRun.code === 0 && state !== null && stateAge !== "UNKNOWN" && stateAge !== "STALE";
	if (!stateCurrent) {
		atomicReplace(statePath, `${JSON.stringify({ status: "UNKNOWN", generated_at: generatedAt, reason: "fleet-state source unavailable or stale" }, null, 2)}\n`);
	}
	const expectedNames = stateCurrent ? state!.sessions.map(session => session.session) : configSessions(configData);
	const latestPulse = latestPulseRows(pulseRows);
	const projects = pulseProjectRows(expectedNames, latestPulse, generatedAtMs);
	const sourceAges: ReportSourceAges = {
		sitrep: sitrepGeneratedAt === null ? "UNKNOWN" : ageLabel(sitrepGeneratedAt, generatedAtMs),
		fleetState: stateAge,
		fleetPulse: pulseAgeLabel(latestPulse, projects, generatedAtMs),
		fleetFlow: reportBody.includes("FLOW UNKNOWN") ? "UNKNOWN" : boundedAge(runFinished.getTime() - reportStart.getTime(), reportBody.includes("== Closes per day")),
		mission: reportBody.includes("MISSION UNKNOWN") ? "UNKNOWN" : boundedAge(runFinished.getTime() - reportStart.getTime(), reportBody.includes("== Mission")),
	};
	const sourceFailed = stateCurrent === false || sitrepRun.code !== 0
		|| projects.some(row => row.status !== "OK")
		|| Object.values(sourceAges).some(age => age === "UNKNOWN" || age === "STALE");
	// INTAKE1 AC3: hourly intake counts ride the digest as one pseudo-project row.
	// Insert-only splice (push before digest, pop right after) touching no landed
	// line; result.projects below never carries the row.
	const intakeLine = intakeDigestLine(config.intakeRepo, generatedAtMs);
	if (intakeLine !== null) projects.push({ name: "intake", status: "OK", detail: intakeLine.slice("intake: ".length) });
	const digest = digestText(generatedAt, sourceAges, projects, reportPath);
	if (intakeLine !== null) projects.pop();
	const route = chiefRoute(configData);
	if (route === null) {
		log(`CHIEF_PANE_MISSING report=${reportPath}`);
		return { status: "FAILED", exit: 1, reportPath, generatedAt, sourceAges, projects, send: null, error: "CHIEF_PANE_MISSING" };
	}

	const sendTime = Math.max(0, REPORT_INJECT_DEADLINE_MS - (performance.now() - started));
	const phaseBudget = Math.floor(sendTime / 6);
	if (phaseBudget < 1_000) {
		log("SEND_BUDGET_EXHAUSTED: less than one second remains for each bounded sender phase");
		return { status: "FAILED", exit: 1, reportPath, generatedAt, sourceAges, projects, send: null, error: "SEND_BUDGET_EXHAUSTED" };
	}
	const attemptBudget = phaseBudget;
	const sendBudget = phaseBudget;
	const sent = await send({
		session: route.session,
		pane: route.pane,
		message: digest,
		dropDir: config.dropDir,
		deadlineMs: attemptBudget,
		untilDeliveredMs: sendBudget,
	});
	if (sent.status === "DELIVERED") log(`DEFERRED marker=${sent.marker} detail=${safeFailureText(sent.detail)}`);
	if (sent.status === "DELIVERED" || sent.status === "OK") {
		log(`DELIVERED marker=${sent.marker} pane=${route.session}:${route.pane}`);
		if (sourceFailed) log("REPORT_SOURCE_UNKNOWN: report was delivered with one or more stale or unavailable sources");
		return { status: "DELIVERED", exit: sourceFailed ? 1 : 0, reportPath, generatedAt, sourceAges, projects, send: sent, ...(sourceFailed ? { error: "REPORT_PRODUCER_FAILED" as const } : {}) };
	}
	log(`SEND_${sent.status} marker=${sent.marker} detail=${safeFailureText(sent.detail)}${sent.drop_path ? ` recovery=${sent.drop_path}` : ""}`);
	return { status: "FAILED", exit: 1, reportPath, generatedAt, sourceAges, projects, send: sent, error: "SEND_NOT_DELIVERED" };
}
