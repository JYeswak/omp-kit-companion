import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { existsSync, mkdirSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { appendLesson, collectCheckinActivity, lessonIdentity, readLessonsLog } from "./lessons.ts";
import { runPlanningScore } from "./planning-score.ts";
import { LESSON_CLASS_DESCRIPTIONS, type LessonEntry } from "./lessons.ts";

export interface FleetRepoConfig {
	name: string;
	path: string;
	trackerPath: string | null;
}

export interface ClefClassifierConfig {
	mode: "off" | "shadow";
	endpoint: string;
	model: string;
	guardScript: string;
	maxCpuBusyPct: number;
	timeoutMs: number;
}

export interface LessonsConfig {
	checkinIntervalMinutes: number;
	reportIntervalSeconds: number;
	intakeTracker: string;
	repos: FleetRepoConfig[];
	classifier: ClefClassifierConfig;
}

export interface FleetRepoSnapshot {
	name: string;
	status: "OK" | "MISSING" | "INVALID" | "UNAVAILABLE";
	entries: readonly LessonEntry[];
}

export interface ClefShadowResult {
	status: "OK" | "UNAVAILABLE" | "DISABLED" | "NOT_RUN";
	results: Readonly<Record<string, { class: string | null; grouping: string | null }>>;
	reason?: string;
}

export interface ClefShadowDependencies {
	guard?: (scriptPath: string) => { code: number | null; stdout: string; stderr: string };
	load?: () => { status: "OK" | "UNAVAILABLE"; cpuBusyPct: number | null; reason?: string };
	post?: (url: string, payload: unknown, timeoutMs: number) => { httpStatus: number | null; body: string; error?: string };
}

export interface FleetRuleGroup {
	id: string;
	class: NonNullable<LessonEntry["class"]>;
	normalized_hash: string;
	external_ref: string;
	what: string;
	repo_names: string[];
	cross_repo: boolean;
	applies_to: "repo" | "fleet";
	entries: { repo: string; entry: LessonEntry }[];
	shadow?: { status: "OK" | "UNAVAILABLE" | "DISABLED" | "NOT_RUN"; class: string | null; grouping: string | null; reason?: string };
}

export interface FleetIntakeItem {
	external_ref: string;
	labels: ["uphill", "lesson"];
	class: NonNullable<LessonEntry["class"]>;
	normalized_hash: string;
	what: string;
	repo_names: string[];
}

export interface FleetSurveyTarget {
	repo: string;
	mission: string;
	stage: string | null;
	target: string;
	status: string;
	value: unknown;
}

export interface FleetFailureClassSurvey {
	class: string;
	count: number;
	repos: string[];
	known: boolean;
	bead_ids: string[];
	remediation_steps: string[];
}

export interface FleetHourlySample {
	repo: string;
	start_at: string;
	end_at: string;
	status: "OK" | "UNAVAILABLE";
	closes: number | null;
	shipped_commits: number | null;
}
export interface FleetLessonsSurvey {
	target_stages: FleetSurveyTarget[];
	hourly_samples: FleetHourlySample[];
	failure_classes: FleetFailureClassSurvey[];
	intake_beads: { external_ref: string; status: "CREATED" | "EXISTS" | "FAILED" | "ESCALATE"; bead_id: string | null; reason?: string }[];
	escalations: { class: string; bead_id: string; reason: string }[];
}

export interface FleetLessonsTrigger {
	kind: "LOW_THROUGHPUT" | "DIFFERENT_BLOCKERS" | "GRADE_FAILED_TWICE";
	repo?: string;
	bead_id?: string;
	evidence: Record<string, unknown>;
}

export interface FleetLessonsReportInput {
	generatedAt: Date;
	previousReportAt: string | null;
	repos: readonly FleetRepoSnapshot[];
	scoreChanges: readonly unknown[];
	scoreSnapshot?: readonly unknown[];
	survey?: FleetLessonsSurvey;
	triggers?: readonly FleetLessonsTrigger[];
	existingExternalRefs?: readonly string[];
	shadow?: ClefShadowResult;
}

export interface FleetLessonsReport {
	schema: "omp-kit.fleet-lessons/v1";
	generated_at: string;
	previous_report_at: string | null;
	repos: { name: string; status: FleetRepoSnapshot["status"]; logged_since_last_report: LessonEntry[] }[];
	rule_groups: FleetRuleGroup[];
	intake_plan: FleetIntakeItem[];
	score_changes: unknown[];
	score_snapshot: unknown[];
	survey: FleetLessonsSurvey;
	triggers: FleetLessonsTrigger[];
	classifier: ClefShadowResult;
	run_status?: "OK" | "BLOCKED";
	blockers?: string[];
}

function configuredPath(value: unknown, home: string, kitRoot: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`LESSONS_CONFIG_${name.toUpperCase()}_INVALID`);
	const raw = value.trim();
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(kitRoot, raw);
	if (!isAbsolute(expanded) || resolve(expanded) !== expanded) throw new Error(`LESSONS_CONFIG_${name.toUpperCase()}_INVALID`);
	return expanded;
}

function positiveInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`LESSONS_CONFIG_${name.toUpperCase()}_INVALID`);
	return value;
}

export function parseLessonsConfig(text: string, home: string, kitRoot: string): LessonsConfig {
	if (!isAbsolute(home) || resolve(home) !== home || !isAbsolute(kitRoot) || resolve(kitRoot) !== kitRoot)
		throw new Error("LESSONS_CONFIG_ROOT_INVALID");
	let parsed: unknown;
	try { parsed = Bun.TOML.parse(text); }
	catch { throw new Error("LESSONS_CONFIG_INVALID_TOML"); }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LESSONS_CONFIG_INVALID_TOML");
	const root = parsed as Record<string, unknown>;
	const checkins = root.checkins;
	if (checkins === null || typeof checkins !== "object" || Array.isArray(checkins)) throw new Error("LESSONS_CONFIG_CHECKINS_INVALID");
	const fleet = root.fleet;
	if (fleet === null || typeof fleet !== "object" || Array.isArray(fleet)) throw new Error("LESSONS_CONFIG_FLEET_INVALID");
	const classifier = root.classifier;
	if (classifier === null || typeof classifier !== "object" || Array.isArray(classifier)) throw new Error("LESSONS_CONFIG_CLASSIFIER_INVALID");
	const checkinFields = checkins as Record<string, unknown>;
	const fleetFields = fleet as Record<string, unknown>;
	const classifierFields = classifier as Record<string, unknown>;
	if (!Array.isArray(fleetFields.repos) || fleetFields.repos.length === 0) throw new Error("LESSONS_CONFIG_REPOS_INVALID");
	const names = new Set<string>(), paths = new Set<string>();
	const repos: FleetRepoConfig[] = fleetFields.repos.map((value, index) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`LESSONS_CONFIG_REPO_${index}_INVALID`);
		const row = value as Record<string, unknown>;
		if (typeof row.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.name)) throw new Error(`LESSONS_CONFIG_REPO_${index}_NAME_INVALID`);
		if (names.has(row.name)) throw new Error(`LESSONS_CONFIG_REPO_NAME_DUPLICATE:${row.name}`);
		const path = configuredPath(row.path, home, kitRoot, `repo_${row.name}`);
		if (paths.has(path)) throw new Error(`LESSONS_CONFIG_REPO_PATH_DUPLICATE:${path}`);
		names.add(row.name);
		paths.add(path);
		return { name: row.name, path, trackerPath: row.tracker === undefined || row.tracker === null ? null : configuredPath(row.tracker, home, kitRoot, `tracker_${row.name}`) };
	});
	const mode = classifierFields.mode;
	if (mode !== "off" && mode !== "shadow") throw new Error("LESSONS_CONFIG_CLASSIFIER_MODE_INVALID");
	const endpoint = classifierFields.endpoint === undefined ? "http://127.0.0.1:8010/v1/systemone" : String(classifierFields.endpoint);
	let parsedEndpoint: URL;
	try { parsedEndpoint = new URL(endpoint); }
	catch { throw new Error("LESSONS_CONFIG_CLASSIFIER_URL_INVALID"); }
	if (parsedEndpoint.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(parsedEndpoint.hostname) || parsedEndpoint.username || parsedEndpoint.password)
		throw new Error("LESSONS_CONFIG_CLASSIFIER_URL_NOT_LOOPBACK");
	const model = classifierFields.model === undefined ? "clef-flash" : String(classifierFields.model);
	if (!model.trim()) throw new Error("LESSONS_CONFIG_CLASSIFIER_MODEL_INVALID");
	const maxCpuBusyPct = classifierFields.max_cpu_busy_pct === undefined ? 80 : classifierFields.max_cpu_busy_pct;
	if (!finiteNumberInRange(maxCpuBusyPct, 0, 100)) throw new Error("LESSONS_CONFIG_CLASSIFIER_LOAD_THRESHOLD_INVALID");
	const timeoutMs = classifierFields.timeout_ms === undefined ? 10_000 : classifierFields.timeout_ms;
	if (!finiteNumberInRange(timeoutMs, 1, 30_000)) throw new Error("LESSONS_CONFIG_CLASSIFIER_TIMEOUT_INVALID");
	const guardScript = configuredPath(classifierFields.guard_script ?? "~/Developer/jev/scripts/local-model-guard.sh", home, kitRoot, "guard_script");
	const intakeTracker = configuredPath(fleetFields.intake_tracker ?? repos.find(repo => repo.name === "omp-kit-companion")?.trackerPath,
		home, kitRoot, "intake_tracker");
	return {
		checkinIntervalMinutes: positiveInteger(checkinFields.interval_minutes ?? 120, "checkin_interval_minutes"),
		reportIntervalSeconds: positiveInteger(fleetFields.report_interval_seconds ?? 21_600, "report_interval_seconds"),
		intakeTracker, repos,
		classifier: { mode, endpoint, model, guardScript, maxCpuBusyPct, timeoutMs },
	};
}

function finiteNumberInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function readLessonsConfig(kitRoot: string, home: string): LessonsConfig {
	try {
		return parseLessonsConfig(readFileSync(join(kitRoot, "config", "lessons.toml"), "utf8"), home, kitRoot);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("LESSONS_CONFIG_")) throw error;
		throw new Error("LESSONS_CONFIG_UNAVAILABLE");
	}
}

export function normalizeLessonWhat(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function lessonDigest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function defaultClefGuard(scriptPath: string): { code: number | null; stdout: string; stderr: string } {
	const result = spawnSync("/bin/bash", [scriptPath, "--once"], { encoding: "utf8", timeout: 5_000, maxBuffer: 1_048_576 });
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function defaultCpuLoad(): { status: "OK" | "UNAVAILABLE"; cpuBusyPct: number | null; reason?: string } {
	const result = spawnSync("localbench", ["load", "--seconds", "1", "--json"], { encoding: "utf8", timeout: 5_000, maxBuffer: 4_194_304 });
	if (result.status !== 0 || result.error) return { status: "UNAVAILABLE", cpuBusyPct: null, reason: "LOCALBENCH_LOAD_FAILED" };
	try {
		const parsed: unknown = JSON.parse(result.stdout ?? "");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		const cpu = (parsed as Record<string, unknown>).cpu;
		if (cpu === null || typeof cpu !== "object" || Array.isArray(cpu)) throw new Error();
		const idle = (cpu as Record<string, unknown>).idle;
		if (typeof idle !== "number" || !Number.isFinite(idle) || idle < 0 || idle > 100) throw new Error();
		return { status: "OK", cpuBusyPct: 100 - idle };
	} catch {
		return { status: "UNAVAILABLE", cpuBusyPct: null, reason: "LOCALBENCH_LOAD_INVALID" };
	}
}

function defaultClefPost(url: string, payload: unknown, timeoutMs: number): { httpStatus: number | null; body: string; error?: string } {
	const result = spawnSync("nice", ["-n", "10", "curl", "--disable", "--noproxy", "*", "--silent", "--show-error",
		"--connect-timeout", "1", "--max-time", String(timeoutMs / 1_000), "--request", "POST",
		"--header", "Content-Type: application/json", "--data-binary", "@-", "--write-out", "\\n%{http_code}", url], {
		encoding: "utf8", input: JSON.stringify(payload), timeout: timeoutMs + 1_000, maxBuffer: 2_097_152,
	});
	const output = result.stdout ?? "";
	const boundary = output.lastIndexOf("\n");
	const codeText = boundary < 0 ? "" : output.slice(boundary + 1).trim();
	const status = Number.parseInt(codeText, 10);
	return { httpStatus: Number.isInteger(status) ? status : null, body: boundary < 0 ? output : output.slice(0, boundary),
		...(result.error ? { error: result.error.message } : result.status !== 0 ? { error: result.stderr || "CURL_FAILED" } : {}) };
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unavailableShadow(reason: string): ClefShadowResult {
	return { status: "UNAVAILABLE", results: {}, reason };
}

	export function runClefShadow(ruleGroups: readonly FleetRuleGroup[], config: ClefClassifierConfig, dependencies: ClefShadowDependencies = {}): ClefShadowResult {
	if (config.mode === "off") return { status: "DISABLED", results: {} };
	if (config.model !== "clef-flash") return unavailableShadow("UNEXPECTED_MODEL");
	let endpoint: URL;
	try { endpoint = new URL(config.endpoint); }
	catch { return unavailableShadow("INVALID_ENDPOINT"); }
	if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname) || endpoint.username || endpoint.password)
		return unavailableShadow("ENDPOINT_NOT_LOOPBACK");

	const groups = ruleGroups.filter(group => group.applies_to === "fleet");
	if (groups.length === 0) return { status: "NOT_RUN", results: {} };
	if (groups.length > 24) return unavailableShadow("CANDIDATE_GROUP_LIMIT");
	const results: Record<string, { class: string | null; grouping: string | null }> = {};
	for (const group of ruleGroups) results[group.id] = { class: null, grouping: group.applies_to === "fleet" ? "KEEP_SEPARATE" : "NOT_APPLICABLE" };
	const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {};
	const targets = new Map<string, { groupId: string; field: "class" | "grouping"; choices: Set<string> }>();
	for (let index = 0; index < groups.length; index++) {
		const group = groups[index]!;
		const prefix = "g" + index;
		if (group.class.startsWith("OTHER:")) {
			const criteria = Object.fromEntries(Object.entries(LESSON_CLASS_DESCRIPTIONS).filter(([name]) => !name.startsWith("OTHER:")));
			const key = prefix + "_class";
			questions[key] = { type: "choice", instructions: "Choose the best canonical class for this lesson. Select only when the evidence supports it; do not change the rule result.", criteria };
			targets.set(key, { groupId: group.id, field: "class", choices: new Set(Object.keys(criteria)) });
		}
		if (groups.length > 1) {
			const criteria: Record<string, string> = { KEEP_SEPARATE: "No near-duplicate group is supported; keep this lesson separate." };
			for (const candidate of groups) {
				if (candidate.id === group.id) continue;
				criteria[candidate.id] = "Possible near-duplicate: class " + candidate.class + "; repos " + candidate.repo_names.join(", ") + "; lesson " + candidate.what.slice(0, 320);
			}
			const key = prefix + "_grouping";
			questions[key] = { type: "choice", instructions: "Choose one possible existing near-duplicate group, or KEEP_SEPARATE. This is a review suggestion only; do not merge rule groups.", criteria };
			targets.set(key, { groupId: group.id, field: "grouping", choices: new Set(Object.keys(criteria)) });
		}
	}
	if (targets.size === 0) return { status: "NOT_RUN", results };

	const guard = (dependencies.guard ?? defaultClefGuard)(config.guardScript);
	if (guard.code !== 0) return unavailableShadow("JEV_GUARD_REFUSED");
	const load = (dependencies.load ?? defaultCpuLoad)();
	if (load.status !== "OK" || load.cpuBusyPct === null || !Number.isFinite(load.cpuBusyPct))
		return unavailableShadow(load.reason ?? "CPU_LOAD_UNAVAILABLE");
	const limit = Math.min(config.maxCpuBusyPct, 80);
	if (load.cpuBusyPct >= limit) return unavailableShadow("CPU_LOAD_LIMIT");

	const payload = {
		model: "clef-flash",
		state: {
			task: "Shadow review only: suggest a canonical class for OTHER lessons and candidate near-duplicate groups. Deterministic rule groups and intake decisions remain authoritative.",
			groups: groups.map(group => ({ id: group.id, class: group.class, what: group.what.slice(0, 500), repos: [...group.repo_names] })),
		},
		questions,
	};
	const post = (dependencies.post ?? defaultClefPost)(config.endpoint, payload, config.timeoutMs);
	if (post.error || post.httpStatus === null || post.httpStatus < 200 || post.httpStatus >= 300)
		return unavailableShadow(post.httpStatus === null ? "HTTP_UNAVAILABLE" : "HTTP_STATUS_" + post.httpStatus);
	let response: Record<string, unknown> | null;
	try { response = objectValue(JSON.parse(post.body)); }
	catch { return unavailableShadow("RESPONSE_INVALID_JSON"); }
	if (!response) return unavailableShadow("RESPONSE_INVALID_JSON");
	const usage = objectValue(response.usage);
	const inputTokens = usage?.input_tokens;
	if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens >= 16_384)
		return unavailableShadow("INPUT_TOKEN_LIMIT_OR_UNKNOWN");
	const answers = objectValue(response.answers);
	if (!answers) return unavailableShadow("ANSWERS_MISSING");
	for (const [key, target] of targets) {
		const answer = objectValue(answers[key]);
		const choice = typeof answers[key] === "string" ? answers[key] : answer?.choice;
		if (typeof choice !== "string" || !target.choices.has(choice)) return unavailableShadow("ANSWER_INVALID");
		results[target.groupId]![target.field] = choice;
	}
	return { status: "OK", results };
}

export function buildFleetLessonsReport(input: FleetLessonsReportInput): FleetLessonsReport {
	if (!Number.isFinite(input.generatedAt.getTime())) throw new Error("FLEET_REPORT_TIMESTAMP_INVALID");
	const previousTime = input.previousReportAt === null ? Number.NEGATIVE_INFINITY : Date.parse(input.previousReportAt);
	if (!Number.isFinite(previousTime) && previousTime !== Number.NEGATIVE_INFINITY) throw new Error("FLEET_REPORT_PREVIOUS_TIMESTAMP_INVALID");
	const repos = input.repos.map(repo => ({
		name: repo.name,
		status: repo.status,
		logged_since_last_report: repo.entries.filter(entry => Date.parse(entry.ts) > previousTime),
	}));
	const grouped = new Map<string, FleetRuleGroup>();
	for (const repo of input.repos) for (const entry of repo.entries) {
		if (entry.kind === "CHECKIN" || entry.class === null) continue;
		const normalized = normalizeLessonWhat(entry.what);
		const normalizedHash = lessonDigest(normalized);
		const key = `${entry.class}\u0000${normalizedHash}`;
		let group = grouped.get(key);
		if (!group) {
			group = {
				id: "rule-" + lessonDigest(entry.class + "\u0000" + normalized).slice(0, 16),
				class: entry.class,
				normalized_hash: normalizedHash,
				external_ref: `lesson1:${lessonDigest(`${entry.class}\u0000${normalized}`)}`,
				what: entry.what,
				repo_names: [], cross_repo: false, applies_to: "repo", entries: [],
			};
			grouped.set(key, group);
		}
		group.entries.push({ repo: repo.name, entry });
		if (!group.repo_names.includes(repo.name)) group.repo_names.push(repo.name);
		if (entry.applies_to === "fleet") group.applies_to = "fleet";
	}
	const ruleGroups = [...grouped.values()].map(group => {
		group.repo_names.sort();
		group.cross_repo = group.repo_names.length > 1;
		return group;
	}).sort((left, right) => left.class.localeCompare(right.class) || left.normalized_hash.localeCompare(right.normalized_hash));
	const existing = new Set(input.existingExternalRefs ?? []);
	const intakePlan = ruleGroups.filter(group => group.cross_repo && group.applies_to === "fleet" && !existing.has(group.external_ref))
		.map(group => ({ external_ref: group.external_ref, labels: ["uphill", "lesson"] as ["uphill", "lesson"],
			class: group.class, normalized_hash: group.normalized_hash, what: group.what, repo_names: [...group.repo_names] }));
const annotatedRuleGroups = ruleGroups.map(group => {
	if (!input.shadow) return group;
	const result = input.shadow.results[group.id];
	const status = input.shadow.status === "OK" && !result ? "UNAVAILABLE" : input.shadow.status;
	return { ...group, shadow: { status, class: result?.class ?? null, grouping: result?.grouping ?? null,
		...(input.shadow.reason ? { reason: input.shadow.reason } : {}) } };
});
	return {
		schema: "omp-kit.fleet-lessons/v1",
		generated_at: input.generatedAt.toISOString(),
		previous_report_at: input.previousReportAt,
		repos,
		rule_groups: annotatedRuleGroups,
		intake_plan: intakePlan,
		score_changes: [...input.scoreChanges],
		score_snapshot: [...(input.scoreSnapshot ?? [])],
		survey: input.survey ?? { target_stages: [], hourly_samples: [], failure_classes: [], intake_beads: [], escalations: [] },
		triggers: [...(input.triggers ?? [])],
		classifier: input.shadow ?? { status: "NOT_RUN", results: {} },
	};
}
export function gradeFailureRunIds(comments: readonly string[]): string[] {
	const runs = new Set<string>();
	for (const comment of comments) {
		const expression = /\bGRADE_FAIL:([A-Za-z0-9][A-Za-z0-9._-]*)/g;
		for (let match = expression.exec(comment); match !== null; match = expression.exec(comment)) runs.add(match[1]!);
	}
	return [...runs].sort();
}

export function targetStageSurvey(rows: readonly unknown[]): FleetSurveyTarget[] {
	const survey: FleetSurveyTarget[] = [];
	for (const value of rows) {
		const row = objectValue(value);
		if (!row || row.kind !== "mission" || typeof row.repo !== "string" || typeof row.mission !== "string") continue;
		const metrics = objectValue(row.metrics);
		if (!metrics) continue;
		for (const [target, raw] of Object.entries(metrics)) {
			const metric = objectValue(raw);
			if (!metric || typeof metric.status !== "string") continue;
			survey.push({ repo: row.repo, mission: row.mission, stage: typeof row.stage === "string" ? row.stage : null,
				target, status: metric.status, value: metric.value ?? null });
		}
	}
	return survey.sort((left, right) => left.repo.localeCompare(right.repo) || left.mission.localeCompare(right.mission) || left.target.localeCompare(right.target));
}

export function scoreChanges(previous: readonly unknown[], current: readonly unknown[]): Record<string, unknown>[] {
	const before = new Map<string, Record<string, unknown>>();
	for (const value of previous) {
		const row = objectValue(value);
		if (row && (row.kind === "mission" || row.kind === "overall") && typeof row.repo === "string" && typeof row.mission === "string") before.set(row.repo + "\u0000" + row.mission, row);
	}
	const changes: Record<string, unknown>[] = [];
	for (const value of current) {
		const row = objectValue(value);
		if (!row || (row.kind !== "mission" && row.kind !== "overall") || typeof row.repo !== "string" || typeof row.mission !== "string") continue;
		const prior = before.get(row.repo + "\u0000" + row.mission) ?? null;
		const oldScore = prior && typeof prior.weighted_score === "number" ? prior.weighted_score : null;
		const newScore = typeof row.weighted_score === "number" ? row.weighted_score : null;
		if (!prior || prior.status !== row.status || oldScore !== newScore) changes.push({ repo: row.repo, mission: row.mission,
			from: prior ? { status: prior.status, weighted_score: oldScore } : null,
			to: { status: row.status, weighted_score: newScore },
			weighted_score_delta: oldScore !== null && newScore !== null ? Math.round((newScore - oldScore) * 100) / 100 : null });
	}
	return changes;
}

export function lowThroughputTriggers(samples: readonly FleetHourlySample[]): FleetLessonsTrigger[] {
	const repos = [...new Set(samples.map(sample => sample.repo))].sort();
	const triggers: FleetLessonsTrigger[] = [];
	for (const repo of repos) {
		const recent = samples.filter(sample => sample.repo === repo).sort((left, right) => left.start_at.localeCompare(right.start_at)).slice(-2);
		if (recent.length === 2 && recent.every(sample => sample.status === "OK" && sample.closes === 0 && sample.shipped_commits === 0))
			triggers.push({ kind: "LOW_THROUGHPUT", repo, evidence: { hourly_samples: recent } });
	}
	return triggers;
}

export function differentBlockerTrigger(previous: readonly string[], current: readonly string[]): FleetLessonsTrigger | null {
	const before = [...new Set(previous)].sort(), after = [...new Set(current)].sort();
	if (!before.length || !after.length || before.join("\u0000") === after.join("\u0000")) return null;
	return { kind: "DIFFERENT_BLOCKERS", evidence: { previous_blockers: before, current_blockers: after } };
}
export interface FleetLessonsCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface FleetLessonsRunDependencies {
	tracker?: (database: string, args: readonly string[]) => FleetLessonsCommandResult;
	planningScore?: typeof runPlanningScore;
	shadow?: ClefShadowDependencies;
}

export interface FleetLessonsRunResult {
	status: "OK" | "BLOCKED";
	report: FleetLessonsReport;
	report_path: string;
	archive_path: string;
	blockers: string[];
}

function trackerDatabase(path: string): string {
	const resolved = resolve(path);
	if (resolved.endsWith(".db")) return resolved;
	return basename(resolved) === ".beads" ? join(resolved, "beads.db") : join(resolved, ".beads", "beads.db");
}

function runFleetTracker(database: string, args: readonly string[], dependencies: FleetLessonsRunDependencies): FleetLessonsCommandResult {
	if (dependencies.tracker) return dependencies.tracker(database, args);
	const result = spawnSync("br", ["--db", database, "--no-auto-import", "--no-auto-flush", ...args], {
		encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
	});
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
}

function jsonValue(text: string): unknown {
	try { return JSON.parse(text); } catch { return null; }
}

function trackerIssues(value: unknown): Record<string, unknown>[] | null {
	const source = Array.isArray(value) ? value : objectValue(value)?.issues;
	if (!Array.isArray(source)) return null;
	return source.map(objectValue).filter((item): item is Record<string, unknown> => item !== null);
}

function findIssueRecord(value: unknown, match: (issue: Record<string, unknown>) => boolean): Record<string, unknown> | null {
	if (Array.isArray(value)) {
		for (const item of value) { const found = findIssueRecord(item, match); if (found) return found; }
		return null;
	}
	const row = objectValue(value);
	if (!row) return null;
	if (match(row)) return row;
	for (const item of Object.values(row)) { const found = findIssueRecord(item, match); if (found) return found; }
	return null;
}

function verifiedBead(database: string, actor: string, externalRef: string, title: string, description: string, labels: string, requiredText: readonly string[], dependencies: FleetLessonsRunDependencies): { id: string | null; status: "CREATED" | "FAILED"; reason?: string } {
	const created = runFleetTracker(database, ["--actor", actor, "create", "--title", title, "--type", "task", "--priority", "2",
		"--description", description, "--labels", labels, "--external-ref", externalRef, "--json"], dependencies);
	if (created.code !== 0) return { id: null, status: "FAILED", reason: created.stderr || "BR_CREATE_FAILED" };
	const createValue = jsonValue(created.stdout);
	const createIssue = findIssueRecord(createValue, issue => issue.external_ref === externalRef) ?? findIssueRecord(createValue, issue => typeof issue.id === "string");
	const id = typeof createIssue?.id === "string" ? createIssue.id : null;
	if (!id) return { id: null, status: "FAILED", reason: "BR_CREATE_ID_MISSING" };
	const readback = runFleetTracker(database, ["show", "--json", id], dependencies);
	if (readback.code !== 0) return { id, status: "FAILED", reason: "BR_READBACK_FAILED" };
	const issue = findIssueRecord(jsonValue(readback.stdout), row => row.id === id);
	const rawLabels = issue?.labels;
	const labelSet = new Set(Array.isArray(rawLabels) ? rawLabels.filter((label): label is string => typeof label === "string") : typeof rawLabels === "string" ? rawLabels.split(",").map(label => label.trim()) : []);
	const actualDescription = typeof issue?.description === "string" ? issue.description : "";
	if (!issue || issue.external_ref !== externalRef || !labelSet.has("uphill") || !labelSet.has("lesson") || !requiredText.every(text => actualDescription.includes(text)))
		return { id, status: "FAILED", reason: "BR_READBACK_MISMATCH" };
	return { id, status: "CREATED" };
}

function writeFleetJson(path: string, value: unknown): void {
	const temporary = path + ".tmp-" + process.pid;
	writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	renameSync(temporary, path);
}

export function runFleetLessonsOnce(options: { kitRoot: string; home: string; stateRoot: string; now?: Date }, dependencies: FleetLessonsRunDependencies = {}): FleetLessonsRunResult {
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime()) || !isAbsolute(options.kitRoot) || !isAbsolute(options.home) || !isAbsolute(options.stateRoot)) throw new Error("FLEET_LESSONS_ROOT_INVALID");
	const config = readLessonsConfig(options.kitRoot, options.home);
	const kitStateDirectory = join(options.stateRoot, "omp-kit");
	const reportDirectory = join(kitStateDirectory, "fleet-lessons");
	const archiveDirectory = join(reportDirectory, "reports");
	for (const directory of [options.stateRoot, kitStateDirectory, reportDirectory, archiveDirectory]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const info = lstatSync(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("FLEET_LESSONS_REPORT_PATH_UNSAFE");
	}
	const latestPath = join(reportDirectory, "latest.json"), runStatePath = join(reportDirectory, "last-run.json");
	let previousReport: Record<string, unknown> = {}, previousRun: Record<string, unknown> = {};
	if (existsSync(latestPath)) {
		const info = lstatSync(latestPath);
		const loaded = objectValue(jsonValue(readFileSync(latestPath, "utf8")));
		if (!info.isFile() || info.isSymbolicLink() || !loaded) throw new Error("FLEET_LESSONS_REPORT_STATE_INVALID");
		previousReport = loaded;
	}
	if (existsSync(runStatePath)) {
		const info = lstatSync(runStatePath);
		const loaded = objectValue(jsonValue(readFileSync(runStatePath, "utf8")));
		if (!info.isFile() || info.isSymbolicLink() || !loaded) throw new Error("FLEET_LESSONS_REPORT_STATE_INVALID");
		previousRun = loaded;
	}
	const previousAt = typeof previousReport.generated_at === "string" && Number.isFinite(Date.parse(previousReport.generated_at)) ? previousReport.generated_at : null;
	const previousScores = Array.isArray(previousReport.score_snapshot) ? previousReport.score_snapshot : [];
	const repos: FleetRepoSnapshot[] = config.repos.map(repo => {
		const log = readLessonsLog(repo.path);
		return { name: repo.name, status: log.status === "MISSING" ? "MISSING" : log.status === "INVALID" ? "INVALID" : "OK", entries: log.entries };
	});
	const scoreResult = (dependencies.planningScore ?? runPlanningScore)({ kitRoot: options.kitRoot, home: options.home, fleet: true });
	const scoreRows = Array.isArray(scoreResult.jsonl) ? scoreResult.jsonl : [];
	const currentScoreChanges = scoreChanges(previousScores, scoreRows);
	const surveyTargets = targetStageSurvey(scoreRows);
	const classGroups = new Map<string, { count: number; repos: Set<string>; beads: Set<string>; fixes: Set<string> }>();
	for (const repo of repos) for (const entry of repo.entries) {
		if (entry.kind === "CHECKIN" || entry.class === null) continue;
		let group = classGroups.get(entry.class);
		if (!group) { group = { count: 0, repos: new Set<string>(), beads: new Set<string>(), fixes: new Set<string>() }; classGroups.set(entry.class, group); }
		group.count++;
		group.repos.add(repo.name);
		if (entry.bead) group.beads.add(entry.bead);
		if (entry.proposed_fix) group.fixes.add(entry.proposed_fix);
	}
	const intakeDatabase = trackerDatabase(config.intakeTracker);
	const issueList = runFleetTracker(intakeDatabase, ["list", "--status", "all", "--label", "uphill", "--label", "lesson", "--format", "json"], dependencies);
	const listedIssues = issueList.code === 0 ? trackerIssues(jsonValue(issueList.stdout)) : null;
	const inventoryAvailable = listedIssues !== null;
	const existingIssues = listedIssues ?? [];
	const existingRefs = existingIssues.map(issue => issue.external_ref).filter((value): value is string => typeof value === "string");
	const surveyClasses: FleetFailureClassSurvey[] = [...classGroups.entries()].map(([name, group]) => {
		const surveyRef = "lesson1-survey:" + lessonDigest(name);
		const existingSurvey = existingIssues.some(issue => issue.external_ref === surveyRef);
		return { class: name, count: group.count, repos: [...group.repos].sort(), known: group.beads.size > 0 || group.fixes.size > 0 || existingSurvey,
			bead_ids: [...group.beads].sort(), remediation_steps: [...group.fixes].sort() };
	}).sort((left, right) => left.class.localeCompare(right.class));
	const reportInput = { generatedAt: now, previousReportAt: previousAt, repos, scoreChanges: currentScoreChanges,
		scoreSnapshot: scoreRows, existingExternalRefs: existingRefs,
		survey: { target_stages: surveyTargets, hourly_samples: [], failure_classes: surveyClasses, intake_beads: [], escalations: [] } };
	const deterministicReport = buildFleetLessonsReport(reportInput);
	const shadow = runClefShadow(deterministicReport.rule_groups, config.classifier, dependencies.shadow);
	const reportBase = buildFleetLessonsReport({ ...reportInput, shadow });
	const blockers: string[] = [];
	if (!inventoryAvailable) blockers.push(issueList.code === 0 ? "intake-tracker-list-invalid" : "intake-tracker-list-unavailable");
	for (const repo of repos) if (repo.status !== "OK") blockers.push("repo-log-" + repo.status.toLowerCase() + ":" + repo.name);
	if (scoreResult.code !== 0) blockers.push("planning-score-unavailable");
	const actor = process.env.AGENT_NAME?.trim() || process.env.OMP_AGENT_NAME?.trim() || "omp-kit-fleet-lessons";
	const intakeBeads: FleetLessonsSurvey["intake_beads"] = [];
	for (const item of reportBase.intake_plan) {
		if (!inventoryAvailable) {
			intakeBeads.push({ external_ref: item.external_ref, status: "FAILED", bead_id: null, reason: "tracker inventory unavailable; create held" });
			continue;
		}
		const existing = existingIssues.find(issue => issue.external_ref === item.external_ref);
		if (existing) { intakeBeads.push({ external_ref: item.external_ref, status: "EXISTS", bead_id: typeof existing.id === "string" ? existing.id : null }); continue; }
		const description = "Cross-repository lesson group\nClass: " + item.class + "\nNormalized hash: " + item.normalized_hash + "\nRepositories: " + item.repo_names.join(", ") + "\nEvidence: " + item.what;
		const result = verifiedBead(intakeDatabase, actor, item.external_ref, "Fleet lesson: " + item.class + " — " + item.what.slice(0, 100), description, "uphill,lesson", [item.class, item.normalized_hash, item.what], dependencies);
		intakeBeads.push({ external_ref: item.external_ref, status: result.status, bead_id: result.id, ...(result.reason ? { reason: result.reason } : {}) });
		if (result.status === "FAILED") blockers.push("intake-bead-create-failed:" + item.external_ref);
	}
	const escalations: FleetLessonsSurvey["escalations"] = [];
	for (const survey of surveyClasses) {
		const externalRef = "lesson1-survey:" + lessonDigest(survey.class);
		if (!inventoryAvailable) {
			if (!survey.known) intakeBeads.push({ external_ref: externalRef, status: "FAILED", bead_id: null, reason: "tracker inventory unavailable; remediation bead creation held" });
			continue;
		}
		const existing = existingIssues.find(issue => issue.external_ref === externalRef);
		if (existing) {
			const beadId = typeof existing.id === "string" ? existing.id : "";
			const status = typeof existing.status === "string" ? existing.status.toLowerCase() : "";
			if (status === "closed" && beadId && survey.bead_ids.length === 0 && survey.remediation_steps.length === 0) {
				intakeBeads.push({ external_ref: externalRef, status: "ESCALATE", bead_id: beadId, reason: "remediation ladder is closed while the failure class remains unknown" });
				escalations.push({ class: survey.class, bead_id: beadId, reason: "x.1/x.2/x.3 ladder exhausted; hold dispatch and escalate" });
				blockers.push("unknown-class-ladder-exhausted:" + survey.class);
			} else intakeBeads.push({ external_ref: externalRef, status: "EXISTS", bead_id: beadId || null });
			continue;
		}
		if (survey.known) continue;
		const ladder = "x.1 Reproduce the exact failure at the recorded target/stage and preserve command output.\nx.2 Trace the failing contract to its owner and state a measurable acceptance check.\nx.3 Implement the smallest fix and rerun that same target/stage; if it still fails, hold and escalate instead of creating another bead.";
		const description = "Unknown failure class: " + survey.class + "\nRepositories: " + survey.repos.join(", ") + "\nOccurrences: " + survey.count + "\nRemediation ladder (ordered):\n" + ladder;
		const result = verifiedBead(intakeDatabase, actor, externalRef, "LESSON1 survey: " + survey.class, description, "uphill,lesson,unknown-class", [survey.class, "x.1", "x.2", "x.3"], dependencies);
		intakeBeads.push({ external_ref: externalRef, status: result.status, bead_id: result.id, ...(result.reason ? { reason: result.reason } : {}) });
		if (result.status === "FAILED") blockers.push("survey-bead-create-failed:" + externalRef);
	}
	const hourlySamples = collectHourlySamples(config.repos, now);
	const triggers = lowThroughputTriggers(hourlySamples);
	if (issueList.code === 0) triggers.push(...gradeTriggers(config.repos, dependencies, blockers));
	else blockers.push("grade-marker-search-unavailable");
	const runBlockers = Array.isArray(previousRun.blockers) ? previousRun.blockers.filter((item): item is string => typeof item === "string") : [];
	const different = differentBlockerTrigger(runBlockers, blockers);
	if (different) triggers.push(different);
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const archivePath = join(archiveDirectory, timestamp + ".json");
	const targetRepo = config.repos.find(repo => repo.name === "omp-kit-companion") ?? config.repos[0];
	const classTable = surveyClasses.map(row => row.class + "=" + (row.known ? "known" : "unknown") + "(n=" + row.count + ",repos=" + row.repos.join(",") + ")").join(" | ") || "no failure classes";
	try {
		if (targetRepo) appendLesson(targetRepo.path, { kind: "LESSON", class: "OTHER:fleet_survey",
			what: "Fleet survey table: " + classTable + "; planning targets covered: " + surveyTargets.length,
			evidence: "fleet report " + archivePath, applies_to: "fleet", proposed_fix: "This record is the generated survey table, not an unresolved operational failure." }, { identity: lessonIdentity(targetRepo.path), now });
	} catch { blockers.push("survey-lesson-append-failed"); }
	const report: FleetLessonsReport = { ...reportBase, survey: { target_stages: surveyTargets, hourly_samples: hourlySamples,
		failure_classes: surveyClasses, intake_beads: intakeBeads, escalations }, triggers,
		run_status: blockers.length ? "BLOCKED" : "OK", blockers: [...new Set(blockers)].sort() };
	writeFleetJson(archivePath, report);
	writeFleetJson(latestPath, report);
	writeFleetJson(runStatePath, { finished_at: now.toISOString(), blockers: report.blockers, status: report.run_status });
	return { status: report.run_status!, report, report_path: latestPath, archive_path: archivePath, blockers: report.blockers! };
}
function gradeTriggers(repos: readonly FleetRepoConfig[], dependencies: FleetLessonsRunDependencies, blockers: string[]): FleetLessonsTrigger[] {
	const trackers = new Map<string, string[]>();
	for (const repo of repos) {
		if (!repo.trackerPath) { blockers.push("grade-marker-tracker-unconfigured:" + repo.name); continue; }
		const database = trackerDatabase(repo.trackerPath);
		const names = trackers.get(database) ?? [];
		names.push(repo.name);
		trackers.set(database, names);
	}
	const triggers: FleetLessonsTrigger[] = [];
	for (const [database, repoNames] of trackers) {
		const repoName = repoNames[0] ?? "unknown";
		const search = runFleetTracker(database, ["search", "--status", "all", "--format", "json", "GRADE_FAIL:"], dependencies);
		if (search.code !== 0) { blockers.push("grade-marker-search-unavailable:" + repoName); continue; }
		const matches = trackerIssues(jsonValue(search.stdout));
		if (matches === null) { blockers.push("grade-marker-search-invalid:" + repoName); continue; }
		const seen = new Set<string>();
		for (const issue of matches) {
			if (typeof issue.id !== "string" || seen.has(issue.id)) continue;
			seen.add(issue.id);
			const comments = runFleetTracker(database, ["comments", "list", "--json", issue.id], dependencies);
			if (comments.code !== 0) { blockers.push("grade-marker-comments-unavailable:" + repoName + ":" + issue.id); continue; }
			const parsed = jsonValue(comments.stdout);
			const rows = Array.isArray(parsed) ? parsed : objectValue(parsed)?.comments;
			if (!Array.isArray(rows)) { blockers.push("grade-marker-comments-invalid:" + repoName + ":" + issue.id); continue; }
			const texts = rows.map(objectValue).filter((row): row is Record<string, unknown> => row !== null)
				.map(row => typeof row.text === "string" ? row.text : "").filter(Boolean);
			const runIds = gradeFailureRunIds(texts);
			if (runIds.length >= 2) triggers.push({ kind: "GRADE_FAILED_TWICE", repo: repoName, bead_id: issue.id,
				evidence: { tracker_repos: repoNames, distinct_run_ids: runIds } });
		}
	}
	return triggers;
}

function collectHourlySamples(repos: readonly FleetRepoConfig[], now: Date): FleetHourlySample[] {
	const hourMs = 3_600_000;
	const currentHour = Math.floor(now.getTime() / hourMs) * hourMs;
	const samples: FleetHourlySample[] = [];
	for (const repo of repos) {
		const firstStart = new Date(currentHour - 2 * hourMs);
		const identity = lessonIdentity(repo.path);
		const collection = collectCheckinActivity(repo.path, repo.trackerPath, identity, firstStart.toISOString(), { allAgents: true });
		for (let offset = 2; offset >= 1; offset--) {
			const start = new Date(currentHour - offset * hourMs), end = new Date(start.getTime() + hourMs);
			const git = spawnSync("git", ["-C", repo.path, "log", "origin/main", "--format=%H%x09%cI",
				"--since=" + start.toISOString(), "--until=" + end.toISOString()], { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
			const shipped = git.status === 0 && !git.error ? (git.stdout ?? "").split("\n").filter(Boolean).length : null;
			const closes = collection.events.filter(event => event.kind === "close" && Date.parse(event.ts) >= start.getTime() && Date.parse(event.ts) < end.getTime()).length;
			const status = collection.status === "OK" && shipped !== null ? "OK" : "UNAVAILABLE";
			samples.push({ repo: repo.name, start_at: start.toISOString(), end_at: end.toISOString(), status,
				closes: status === "OK" ? closes : null, shipped_commits: status === "OK" ? shipped : null });
		}
	}
	return samples;
}
