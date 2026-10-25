import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { releaseRoot } from "./paths.ts";

/** The reviewed map ships as config/skill-stations.toml under the kit root (package-release copies config/ whole).
 * Read at runtime, not via a TS import attribute: the regexploit gate cannot parse those (staged-regexploit,
 * dead2a62b9). A source run reads the checkout; a release binary reads its release root; neither found is null. */
export function readSkillStationsText(): string | null {
	try {
		const root = Bun.main.endsWith(".ts") ? resolve(dirname(Bun.main), "..") : releaseRoot(process.execPath);
		return readFileSync(join(root, "config", "skill-stations.toml"), "utf8");
	} catch {
		try { return readFileSync(resolve(import.meta.dir, "..", "config", "skill-stations.toml"), "utf8"); } catch { return null; }
	}
}

export type SkillStation = {
	station: string; trigger: string; detector: string; skills: string[];
	artifact: string; mandatory: boolean; skill_source: string; rule?: string;
};
export type ApplicableSkill = { skill: string; station: string; mandatory: boolean; trigger: string; why: string };
export type Detection = { status: "MATCH" | "NO_MATCH" | "UNKNOWN"; why: string };
export type SkillMap = { rows: SkillStation[]; errors: string[]; warnings: string[] };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const stations = new Set([...Array.from({ length: 10 }, (_, i) => `G${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `L${i + 1}`), "Plan", "Convert", "Polish", "Execute", "Learn"]);

/** Structural violations reject the map; an unavailable installed skill is a warning. */
export function validateSkillStations(data: unknown, root = join(homedir(), ".claude", "skills")): SkillMap {
	const result: SkillMap = { rows: [], errors: [], warnings: [] };
	if (!record(data)) return { ...result, errors: ["ROOT: expected TOML table"] };
	if (data.schema_version !== 1) result.errors.push("SCHEMA: schema_version must be integer 1");
	if (!Array.isArray(data.row) || !data.row.length) return { ...result, errors: [...result.errors, "ROWS: expected nonempty [[row]] array"] };
	const seen = new Set<string>();
	for (const [index, row] of data.row.entries()) {
		const prefix = `row[${index + 1}]`;
		if (!record(row)) { result.errors.push(`${prefix}: expected table`); continue; }
		const before = result.errors.length;
		for (const field of ["station", "trigger", "detector", "artifact", "skill_source"]) if (!text(row[field])) result.errors.push(`${prefix}: ${field} must be nonempty text`);
		if (typeof row.station !== "string" || !stations.has(row.station)) result.errors.push(`${prefix}: UNKNOWN_STATION ${String(row.station)}`);
		if (typeof row.station === "string" && typeof row.trigger === "string") {
			const key = JSON.stringify([row.station.trim(), row.trigger.trim()]);
			if (seen.has(key)) result.errors.push(`${prefix}: DUPLICATE station/trigger ${key}`);
			seen.add(key);
		}
		if (typeof row.mandatory !== "boolean") result.errors.push(`${prefix}: mandatory must be boolean`);
		if (row.mandatory === true && !text(row.rule)) result.errors.push(`${prefix}: MISSING_RULE mandatory row needs rule citation`);
		if (!Array.isArray(row.skills) || !row.skills.length) { result.errors.push(`${prefix}: skills must be nonempty array`); continue; }
		const names = new Set<string>();
		for (const name of row.skills) {
			if (typeof name !== "string" || !name.length || [...name].some(c => !"abcdefghijklmnopqrstuvwxyz0123456789-".includes(c))) {
				result.errors.push(`${prefix}: INVALID_SKILL_NAME ${String(name)}`); continue;
			}
			if (names.has(name)) result.errors.push(`${prefix}: repeated skill ${name}`);
			names.add(name);
			try { if (!statSync(join(root, name, "SKILL.md")).isFile()) throw Error("not a file"); }
			catch { result.warnings.push(`${prefix}: MISSING_SKILL ${name}`); }
		}
		if (before === result.errors.length) result.rows.push(row as SkillStation);
	}
	return result;
}

export function parseSkillStations(source: string | null = readSkillStationsText(), root = join(homedir(), ".claude", "skills")): SkillMap {
	if (source === null) return { rows: [], errors: ["MAP_UNAVAILABLE: config/skill-stations.toml not found under the kit root"], warnings: [] };
	try { return validateSkillStations(Bun.TOML.parse(source), root); }
	catch (error) { return { rows: [], errors: [`TOML: ${String(error)}`], warnings: [] }; }
}

type DiffFile = { path: string; before: string[]; after: string[]; startsAtBeginning: boolean };
function diffFiles(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) { file = undefined; inHunk = false; }
		else if (!inHunk && line.startsWith("+++ ")) {
			let path = line.slice(4);
			if (path.startsWith('"')) { try { path = JSON.parse(path); } catch { continue; } }
			file = { path: path.startsWith("b/") ? path.slice(2) : path, before: [], after: [], startsAtBeginning: false };
			files.push(file);
		} else if (line.startsWith("@@ ")) {
			if (file) file.startsAtBeginning = !inHunk && (line.startsWith("@@ -1,") || line.startsWith("@@ -0,") || line.startsWith("@@ -1 "));
			inHunk = true;
		} else if (file && inHunk) {
			if (line.startsWith(" ") || line.startsWith("-")) file.before.push(line.slice(1));
			if (line.startsWith(" ") || line.startsWith("+")) file.after.push(line.slice(1));
		}
	}
	return files;
}
const jsKinds = [".js", ".ts", ".mjs", ".cjs", ".mts", ".cts"];
const proseKinds = [".md", ".rst", ".txt"];
const answer = (status: Detection["status"], why: string): Detection => ({ status, why });

/** Limited JS/TS lexical adapter: regex literals in unambiguous expression-start
 * contexts, strings and comments. Templates, JSX, ambiguous slash contexts and
 * incomplete syntax/hunks return UNKNOWN, never a negative regex verdict.
 */
function regexLiterals(source: string): string[] | null {
	const literals: string[] = [];
	let previous = "";
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (c.trim() === "") continue;
		if (c === "`") return null;
		if ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$".includes(c)) {
			const start = i;
			while (i + 1 < source.length && "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$0123456789".includes(source[i + 1]!)) i++;
			previous = source.slice(start, i + 1); continue;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			for (i++; i < source.length; i++) { if (source[i] === "\\") i++; else if (source[i] === quote) break; }
			previous = "string"; continue;
		}
		if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
		if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2); if (end < 0) return null; i = end + 1; continue;
		}
		if (c === "/" && ["", "=", "(", "[", "{", ",", ":", ";", "!", "?", "return", "throw", "yield"].includes(previous)) {
			const start = i;
			let inClass = false;
			for (i++; i < source.length && source[i] !== "\n"; i++) {
				if (source[i] === "\\") i++;
				else if (source[i] === "[") inClass = true;
				else if (source[i] === "]") inClass = false;
				else if (source[i] === "/" && !inClass) break;
			}
			if (source[i] !== "/") return null;
			while (i + 1 < source.length && "dgimsuvy".includes(source[i + 1]!)) i++;
			literals.push(source.slice(start, i + 1)); previous = "literal"; continue;
		}
		if (c === "/") return null;
		// Only a single assignment '=', not ==, ===, !=, <=, >= or =>.
		previous = c === "=" && !"=!<>".includes(source[i - 1] ?? " ") && source[i + 1] !== "=" && source[i + 1] !== ">" ? "=" : c;
	}
	return literals;
}

function binChange(files: DiffFile[]): Detection {
	for (const file of files.filter(f => basename(f.path) === "package.json")) {
		try {
			const before: unknown = file.before.length ? JSON.parse(file.before.join("\n")) : {};
			const after: unknown = file.after.length ? JSON.parse(file.after.join("\n")) : {};
			if (!record(before) || !record(after)) continue;
			const bin = (v: unknown) => typeof v === "string" && v.length > 0 || record(v) && Object.values(v).some(text);
			if ((bin(before.bin) || bin(after.bin)) && JSON.stringify(before.bin) !== JSON.stringify(after.bin)) return answer("MATCH", `${file.path}: changed package.json bin declaration; mandatory CLI review nomination, classification not certified`);
		} catch { /* Partial or malformed manifest cannot establish applicability. */ }
	}
	return answer("UNKNOWN", "CLI classification/reachability unavailable; no decidable package.json bin change");
}

function detect(row: SkillStation, paths: string[], files: DiffFile[]): Detection {
	const pathMatch = (predicate: (p: string) => boolean) => {
		const path = paths.find(predicate);
		return path ? answer("MATCH", `changed path ${path}; advisory path fact, not semantic proof`) : answer("NO_MATCH", "no matching changed path");
	};
	switch (row.trigger) {
		case "mission-or-user-stories-changed": return pathMatch(p => p === ".omp/mission.toml" || p === "MISSION.md" || p.startsWith("docs/stories/"));
		case "architectural-choice-or-prior-art-record-changed": return pathMatch(p => p.startsWith("docs/adr/") || p.startsWith("docs/research/"));
		case "domain-model-changed": return pathMatch(p => ["CONTEXT.md", "CONTEXT-MAP.md"].includes(basename(p)) || p.startsWith("docs/adr/"));
		case "build-right-framework-manifest-changed": return pathMatch(p => p === "docs/contracts/build_right_framework_contract.md");
		case "public-prose-changed": return pathMatch(p => p === "README.md" || p.startsWith("docs/") && [".md", ".mdx", ".rst"].includes(extname(p)));
		case "skill-package-created-or-modified": {
			const direct = paths.find(p => basename(p) === "SKILL.md");
			return direct ? answer("MATCH", `changed skill file ${direct}`) : answer("UNKNOWN", "skill-root inventory needed to classify helper/reference paths");
		}
		case "migration-file-added": {
			const file = files.find(f => f.startsAtBeginning && !f.before.length && f.after.length
				&& ["migrations/", "db/migrations/", "supabase/migrations/"].some(prefix => f.path.startsWith(prefix))
				&& [".sql", ".py", ".ts"].includes(extname(f.path)));
			return file ? answer("MATCH", `${file.path}: added migration-path candidate; dialect/DDL semantics not established`) : answer("UNKNOWN", "no default added migration path established; declared migration directories unavailable");
		}
		case "regex-pattern-or-regex-command-changed": {
			if (paths.every(p => proseKinds.includes(extname(p)))) return answer("NO_MATCH", "only prose paths changed; no executable regex carrier");
			for (const file of files) if (jsKinds.includes(extname(file.path)) && file.startsAtBeginning) {
				try {
					const parser = new Bun.Transpiler({ loader: extname(file.path).includes("ts") ? "ts" : "js" });
					parser.transformSync(file.before.join("\n"));
					parser.transformSync(file.after.join("\n"));
				} catch { continue; }
				const old = regexLiterals(file.before.join("\n"));
				const current = regexLiterals(file.after.join("\n"));
				if (old !== null && current !== null && JSON.stringify(old) !== JSON.stringify(current)) return answer("MATCH", `${file.path}: changed literal regex`);
			}
			return answer("UNKNOWN", "no changed literal regex established; ambiguous slash contexts, constructors, dynamic patterns, other languages and incomplete hunks need native adapters");
		}
		default:
			if (row.skills.includes("agent-ergonomics-and-intuitiveness-maximization-for-cli-tools")) return binChange(files);
			return answer("UNKNOWN", `detector needs inputs beyond paths/diff: ${row.detector}`);
	}
}

export function evaluateSkillDetector(row: SkillStation, changedPaths: string[], diffText: string): Detection {
	return detect(row, changedPaths, diffFiles(diffText).filter(file => changedPaths.includes(file.path)));
}

/** Only MATCH rows are recommendations. UNKNOWN mandatory rows are reported separately. */
export function skillStationReport(changedPaths: string[], diffText: string) {
	const map = parseSkillStations();
	const warnings = [...map.warnings, ...map.errors];
	const applicable_skills: ApplicableSkill[] = [];
	if (map.errors.length) return { applicable_skills, warnings };
	const files = diffFiles(diffText).filter(file => changedPaths.includes(file.path));
	const seen = new Set<string>();
	for (const row of map.rows) {
		const result = detect(row, changedPaths, files);
		if (result.status === "UNKNOWN" && row.mandatory) warnings.push(`UNKNOWN ${row.station}/${row.trigger}: ${result.why}`);
		if (result.status !== "MATCH") continue;
		for (const skill of row.skills) {
			const key = JSON.stringify([skill, row.station, row.trigger]);
			if (!seen.has(key)) applicable_skills.push({ skill, station: row.station, mandatory: row.mandatory, trigger: row.trigger, why: result.why });
			seen.add(key);
		}
	}
	return { applicable_skills, warnings };
}

export function applicableSkills(changedPaths: string[], diffText: string): ApplicableSkill[] {
	return skillStationReport(changedPaths, diffText).applicable_skills;
}
