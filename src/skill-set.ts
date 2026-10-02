import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runCapabilitiesCheck, runContextInventory, validateProfileName, type CapabilitiesReport, type ContextInventory } from "./context.ts";

export const SKILL_URL_PATTERN = "skill://";
const SKILL_NAME = "[a-z0-9][a-z0-9_-]*";
const SKILL_URL = new RegExp(`skill:(?:\\\\)?/(?:\\\\)?/(${SKILL_NAME})`, "g");
const SKILL_TOKEN = new RegExp(`/skill:(${SKILL_NAME})`, "g");

const HISTORY_WINDOW_DAYS_MIN = 1;
const HISTORY_WINDOW_DAYS_MAX = 90;
const PER_FILE_BYTES_MAX = 8 * 1024 * 1024;
const TOTAL_BYTES_MAX = 64 * 1024 * 1024;
const FILES_MAX = 5000;
const LINE_BYTES_MAX = 1024 * 1024;

export interface HistoryProjectUsage {
	/** Skill names read in sessions rooted at this cwd, with distinct mentioning rows. */
	reads: Record<string, number>;
	/** Skill names written explicitly in sessions rooted at this cwd. */
	explicit: Record<string, number>;
}

export interface HistoryScan {
	/** Skill names read (skill:// mentions) with distinct mentioning rows. */
	reads: Record<string, number>;
	/** Skill names written explicitly (/skill: tokens or skill:// in user text). */
	explicit: Record<string, number>;
	/** Per-session-cwd usage; a session row's cwd decides, "" when no session row precedes. */
	by_project: Record<string, HistoryProjectUsage>;
	files_scanned: number;
	files_skipped_window: number;
	files_skipped_oversize: number;
	files_skipped_unsafe: number;
	bytes_scanned: number;
	rows_scanned: number;
	rows_malformed: number;
	truncated: boolean;
}

export interface SkillSetInput {
	/** Inspected HOME; session files are read, never written. */
	home: string;
	/** OMP profile name, or "default". */
	profile: string;
	/** Lookback window in days; file mtime decides. */
	days: number;
	/** Release root carrying scripts/context-inventory.ts. */
	root: string;
	/** Compiled release executable selecting the release root. */
	executablePath: string;
	/** Project cwd for the before/after loader measurements. */
	project: string;
}

export interface SkillSetReport {
	candidate_skills: string[];
	reads: Record<string, number>;
	explicit: Record<string, number>;
	history: Omit<HistoryScan, "reads" | "explicit" | "by_project">;
	/** Usage grouped by session cwd; session rows without a preceding session row land under "". */
	projects: Record<string, HistoryProjectUsage>;
	/** Rendered recipes per session-cwd project, each resolved through that project's own loader. */
	project_recipes: SkillSetProjectRecipe[];
	/** Skills used in a session cwd that resolve in no inventoried scope; in no recipe. */
	unresolved_projects: Record<string, string[]>;
	bytes_before: number;
	bytes_after: number;
	listed_before: number;
	listed_after: number;
	capability_check: { overall: "PASS" | "FAIL"; missing: number; capabilities: CapabilitiesReport["capabilities"] };
	recipe: string;
	guidance: string;
}

export interface SkillSetProjectRecipe {
	/** Session cwd this recipe resolves; "project:<path>" in human-facing summaries. */
	project: string;
	candidate_skills: string[];
	bytes_before: number;
	bytes_after: number;
	listed_before: number;
	listed_after: number;
	capability_check: { overall: "PASS" | "FAIL"; missing: number; capabilities: CapabilitiesReport["capabilities"] };
	recipe: string;
}

export class SkillSetInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "SkillSetInputError";
	}
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null || !("type" in part) || !("text" in part)) continue;
		if (part.type !== "text" || typeof part.text !== "string") continue;
		parts.push(part.text);
	}
	return parts.join("\n");
}

function countInto(target: Record<string, number>, names: Iterable<string>): void {
	for (const name of names) target[name] = (target[name] ?? 0) + 1;
}

function skillUrls(line: string): string[] {
	SKILL_URL.lastIndex = 0;
	const names: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = SKILL_URL.exec(line)) !== null) names.push(match[1] ?? "");
	return names.filter(name => name.length > 0);
}

function skillTokens(text: string): string[] {
	SKILL_TOKEN.lastIndex = 0;
	const names: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = SKILL_TOKEN.exec(text)) !== null) names.push(match[1] ?? "");
	return names.filter(name => name.length > 0);
}

/** Read-only scan of one profile's OMP session transcripts for skill usage. */
export function scanSessionHistory(sessionsDir: string, days: number): HistoryScan {
	const cutoff = Date.now() - days * 86400 * 1000;
	const reads: Record<string, number> = {};
	const explicit: Record<string, number> = {};
	const scan: HistoryScan = { reads, explicit, by_project: {}, files_scanned: 0, files_skipped_window: 0,
		files_skipped_oversize: 0, files_skipped_unsafe: 0, bytes_scanned: 0, rows_scanned: 0,
		rows_malformed: 0, truncated: false };
	const projectUsage = (project: string): HistoryProjectUsage =>
		scan.by_project[project] ?? (scan.by_project[project] = { reads: {}, explicit: {} });
	const files: string[] = [];
	const visit = (directory: string, depth: number): void => {
		if (scan.truncated || files.length >= FILES_MAX) return;
		let names: string[];
		try {
			names = readdirSync(directory).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (scan.truncated || files.length >= FILES_MAX) return;
			const path = join(directory, name);
			let stat;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) {
				scan.files_skipped_unsafe += 1;
				continue;
			}
			if (stat.isDirectory()) {
				if (depth < 1) visit(path, depth + 1);
				continue;
			}
			if (!stat.isFile() || !name.endsWith(".jsonl")) continue;
			if (stat.mtimeMs < cutoff) {
				scan.files_skipped_window += 1;
				continue;
			}
			if (stat.size > PER_FILE_BYTES_MAX) {
				scan.files_skipped_oversize += 1;
				continue;
			}
			files.push(path);
		}
	};
	visit(sessionsDir, 0);
	for (const path of files) {
		if (scan.bytes_scanned >= TOTAL_BYTES_MAX) {
			scan.truncated = true;
			break;
		}
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch {
			continue;
		}
		scan.files_scanned += 1;
		scan.bytes_scanned += text.length;
		let sessionCwd = "";
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			if (line.length > LINE_BYTES_MAX) continue;
			scan.rows_scanned += 1;
			let row: unknown;
			try {
				row = JSON.parse(line);
			} catch {
				scan.rows_malformed += 1;
				row = null;
			}
			if (typeof row === "object" && row !== null && "type" in row && row.type === "session"
				&& "cwd" in row && typeof row.cwd === "string") {
				sessionCwd = row.cwd;
			}
			const seen = new Set(skillUrls(line));
			if (seen.size > 0) {
				countInto(reads, seen);
				countInto(projectUsage(sessionCwd).reads, seen);
			}
			if (typeof row === "object" && row !== null && "message" in row) {
				const message = row.message;
				if (typeof message === "object" && message !== null && "role" in message
					&& message.role === "user" && "content" in message) {
					const userText = textOf(message.content);
					const names = new Set([...skillTokens(userText), ...skillUrls(userText)]);
					countInto(explicit, names);
					countInto(projectUsage(sessionCwd).explicit, names);
				}
			}
		}
	}
	if (scan.bytes_scanned >= TOTAL_BYTES_MAX) scan.truncated = true;
	return scan;
}

const RECIPE_GUIDANCE = "Copy this fragment into a NEW, operator-owned named profile only after confirming the name and destination are unused; never merge into the default profile. Hand the before/after bytes and the capability check below to the benchmark (localbench Experiment C) before adopting the pruned set: passing the check does not prove equal task success.";

function renderRecipe(candidate: string[], before: number, after: number,
	check: { overall: string; missing: number }): string {
	const lines = [
		"# omp-kit skill-set recipe (render-only; the kit never applies a profile)",
		"# Prune path: copy the skills block into a NEW named profile config.yml manually.",
		"skills:",
		"  includeSkills:",
		...candidate.map(name => `    - ${name}`),
		`# listing bytes before: ${before}`,
		`# listing bytes after (measured through OMP's loader on these settings): ${after}`,
		`# capability check: ${check.overall} (missing ${check.missing})`,
	];
	return lines.join("\n") + "\n";
}

/** A session cwd resolves through its own directory; "" (no session row) falls back to the invocation cwd. */
function resolveDir(sessionCwd: string, fallback: string): string {
	if (sessionCwd === "") return fallback;
	return sessionCwd;
}

async function measureRecipe(input: SkillSetInput, profile: string, project: string,
	candidate: string[], before: ContextInventory, capabilitiesPath: string): Promise<Omit<SkillSetProjectRecipe,
		"project" | "candidate_skills" | "recipe"> & { recipe: string }> {
	writeFileSync(capabilitiesPath, JSON.stringify({ schema_version: 1, skills: candidate }));
	const after = await runContextInventory({ root: input.root, executablePath: input.executablePath,
		home: input.home, profile, project, overrides: { includeSkills: candidate } });
	const check = await runCapabilitiesCheck({ root: input.root, executablePath: input.executablePath,
		home: input.home, profile, project, overrides: { includeSkills: candidate },
		capabilitiesPath });
	return {
		bytes_before: before.skills.listed_bytes,
		bytes_after: after.skills.listed_bytes,
		listed_before: before.skills.listed,
		listed_after: after.skills.listed,
		capability_check: { overall: check.overall, missing: check.missing, capabilities: check.capabilities },
		recipe: renderRecipe(candidate, before.skills.listed_bytes, after.skills.listed_bytes, check),
	};
}

/** Derive a usage-based candidate set and render (never apply) a pruned-profile recipe. */
export async function renderSkillSet(input: SkillSetInput): Promise<SkillSetReport> {
	if (![input.home, input.root, input.executablePath, input.project].every(path => typeof path === "string" && isAbsolute(path))) {
		throw new SkillSetInputError("INVALID_SKILL_SET_SELECTION", "HOME, release root, executable and project must be absolute paths");
	}
	const profile = validateProfileName(input.profile);
	if (!Number.isSafeInteger(input.days) || input.days < HISTORY_WINDOW_DAYS_MIN || input.days > HISTORY_WINDOW_DAYS_MAX) {
		throw new SkillSetInputError("INVALID_HISTORY_WINDOW", "History window must be 1..90 days");
	}
	const sessionsDir = profile === "default"
		? join(input.home, ".omp", "agent", "sessions")
		: join(input.home, ".omp", "profiles", profile, "agent", "sessions");
	const scan = scanSessionHistory(sessionsDir, input.days);
	const projects: Record<string, HistoryProjectUsage> = {};
	for (const [key, usage] of Object.entries(scan.by_project)) {
		if (Object.keys(usage.reads).length > 0 || Object.keys(usage.explicit).length > 0) projects[key] = usage;
	}
	// The global recipe holds only user-scope skills: resolve usage from the invocation
	// project so project-scoped skills from other cwds cannot leak into it.
	const globalInventory = await runContextInventory({ root: input.root, executablePath: input.executablePath,
		home: input.home, profile, project: input.project });
	const userNames = new Set(globalInventory.skills.rows.map(row => row.name));
	const projectInventories: Record<string, ContextInventory> = {};
	for (const key of Object.keys(projects)) {
		const dir = resolveDir(key, input.project);
		if (!existsSync(dir)) continue;
		try {
			projectInventories[key] = await runContextInventory({ root: input.root, executablePath: input.executablePath,
				home: input.home, profile, project: dir });
		} catch {
			continue;
		}
	}
	const projectNames: Record<string, Set<string>> = {};
	for (const [key, inventory] of Object.entries(projectInventories)) {
		projectNames[key] = new Set(inventory.skills.rows.map(row => row.name));
	}
	const usedOf = (usage: HistoryProjectUsage): string[] =>
		[...new Set([...Object.keys(usage.reads), ...Object.keys(usage.explicit)])].sort();
	const globalCandidate = [...new Set(Object.values(projects).flatMap(usage =>
		usedOf(usage).filter(name => userNames.has(name))))].sort();
	const unresolved: Record<string, string[]> = {};
	for (const [key, usage] of Object.entries(projects)) {
		const names = projectNames[key];
		const missing = usedOf(usage).filter(name => !userNames.has(name)
			&& (names === undefined || !names.has(name)));
		if (missing.length > 0) unresolved[key] = missing;
	}
	const capabilitiesPath = join(mkdtempSync(join(tmpdir(), "omp-kit-skill-set-")), "capabilities.json");
	try {
		const global = await measureRecipe(input, profile, input.project, globalCandidate, globalInventory, capabilitiesPath);
		const recipes: SkillSetProjectRecipe[] = [];
		for (const [key, usage] of Object.entries(projects)) {
			const dir = resolveDir(key, input.project);
			const names = projectNames[key];
			const before = projectInventories[key];
			if (names === undefined || before === undefined || !existsSync(dir)) continue;
			const candidate = usedOf(usage).filter(name => userNames.has(name) || names.has(name));
			if (candidate.length === 0) continue;
			const measured = await measureRecipe(input, profile, dir, candidate, before, capabilitiesPath);
			recipes.push({ project: key, candidate_skills: candidate, ...measured });
		}
		recipes.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
		return {
			candidate_skills: globalCandidate,
			reads: scan.reads,
			explicit: scan.explicit,
			history: { files_scanned: scan.files_scanned, files_skipped_window: scan.files_skipped_window,
				files_skipped_oversize: scan.files_skipped_oversize, files_skipped_unsafe: scan.files_skipped_unsafe,
				bytes_scanned: scan.bytes_scanned, rows_scanned: scan.rows_scanned,
				rows_malformed: scan.rows_malformed, truncated: scan.truncated },
			projects,
			project_recipes: recipes,
			unresolved_projects: unresolved,
			bytes_before: global.bytes_before,
			bytes_after: global.bytes_after,
			listed_before: global.listed_before,
			listed_after: global.listed_after,
			capability_check: global.capability_check,
			recipe: global.recipe,
			guidance: RECIPE_GUIDANCE,
		};
	} finally {
		rmSync(join(capabilitiesPath, ".."), { recursive: true, force: true });
	}
}
