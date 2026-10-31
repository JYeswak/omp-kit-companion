import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { run, type RunResult } from "../kitlib/run.ts";
import type { GraderCandidate } from "../grader-next.ts";

type GradeWaveItem = { bead: string; gradable: boolean; code: string; detail: string; subjects?: { commit: string; repo: string; landing_ref: string }[] };
type Admission = { gradable: string[]; items: GradeWaveItem[]; installed_kit: string | null };
type TrackerBead = { id: string; title: string; created_by: string | null; assignee: string | null; priority: number; status: string };
export type SourceResult<T> =
	| { status: "OK"; source: string; rows: T }
	| { status: "UNKNOWN" | "FAILED"; source: string; reason: string };

export type GraderSourceRuntime = {
	home: string;
	env: Record<string, string | undefined>;
	exists: (path: string) => boolean;
	readText: (path: string) => Promise<string>;
	realpath: (path: string) => string;
	which: (command: string) => string | null;
	run: typeof run;
};

export const productionGraderSourceRuntime: GraderSourceRuntime = {
	home: homedir(),
	env: process.env,
	exists: existsSync,
	readText: path => readFile(path, "utf8"),
	realpath: path => realpathSync(path),
	which: findExecutable,
	run,
};

function findExecutable(command: string): string | null {
	if (command.includes("/")) {
		try { accessSync(command, constants.X_OK); return command; }
		catch { return null; }
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, command);
		try { accessSync(candidate, constants.X_OK); return candidate; }
		catch { /* continue through PATH */ }
	}
	return null;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const unique = (values: string[]): string[] => [...new Set(values)];
const malformed = (source: string, reason: string): SourceResult<never> => ({ status: "FAILED", source, reason });
const unavailable = (source: string, reason: string): SourceResult<never> => ({ status: "UNKNOWN", source, reason });

export async function declaredMilestonePins(repo: string, runtime: GraderSourceRuntime = productionGraderSourceRuntime): Promise<SourceResult<string[]>> {
	const source = join(runtime.home, ".config", "omp-kit", "fleet-watch.json");
	let config: unknown;
	try {
		config = JSON.parse(await runtime.readText(source));
	} catch (error) {
		return unavailable(source, `fleet-watch unreadable: ${String(error)}`);
	}
	if (!object(config) || !Array.isArray(config.sessions)) return malformed(source, "fleet-watch sessions must be an array");
	let targetRepo: string;
	try { targetRepo = runtime.realpath(resolve(repo)); }
	catch (error) { return unavailable(source, `repository path unreadable: ${String(error)}`); }
	const pins: string[] = [];
	for (const session of config.sessions) {
		if (!object(session) || typeof session.repo !== "string") return malformed(source, "fleet-watch session is incomplete");
		let sessionRepo: string;
		try { sessionRepo = runtime.realpath(resolve(session.repo)); }
		catch (error) { return unavailable(source, `fleet-watch session repository unreadable: ${String(error)}`); }
		if (sessionRepo !== targetRepo || session.milestone === undefined || session.milestone === null) continue;
		if (!object(session.milestone) || !Array.isArray(session.milestone.pinned)
			|| !session.milestone.pinned.every(pin => typeof pin === "string" && pin.trim().length > 0)) {
			return malformed(source, "matching session has malformed milestone pins");
		}
		pins.push(...session.milestone.pinned.map(pin => pin.trim()));
	}
	return { status: "OK", source, rows: unique(pins).sort() };
}

function parseAdmission(value: unknown, pins: string[], source: string): SourceResult<Admission> {
	if (!object(value) || !Array.isArray(value.gradable) || !Array.isArray(value.items)
		|| !(typeof value.installed_kit === "string" || value.installed_kit === null)) {
		return malformed(source, "grade_wave output has an unsupported shape");
	}
	const items: GradeWaveItem[] = [];
	for (const row of value.items) {
		if (!object(row) || typeof row.bead !== "string" || typeof row.gradable !== "boolean"
			|| typeof row.code !== "string" || typeof row.detail !== "string") {
			return malformed(source, "grade_wave item is incomplete or malformed");
		}
		const subjects: NonNullable<GradeWaveItem["subjects"]> = [];
		if (row.subjects !== undefined) {
			if (!Array.isArray(row.subjects)) return malformed(source, `grade_wave item ${row.bead} has malformed subjects`);
			for (const subject of row.subjects) {
				if (!object(subject) || typeof subject.commit !== "string" || typeof subject.repo !== "string" || typeof subject.landing_ref !== "string") {
					return malformed(source, `grade_wave item ${row.bead} has malformed subjects`);
				}
				subjects.push({ commit: subject.commit, repo: subject.repo, landing_ref: subject.landing_ref });
			}
		}
		if (row.gradable && row.code !== "ADMITTED" && row.code !== "CLOSE_PASS") {
			return malformed(source, `gradable item ${row.bead} has refusal code ${row.code}`);
		}
		if (row.gradable && subjects.length === 0) return malformed(source, `gradable item ${row.bead} has incomplete subjects`);
		items.push({ bead: row.bead, gradable: row.gradable, code: row.code, detail: row.detail, subjects });
	}
	const expected = new Set(pins);
	const observed = new Set(items.map(row => row.bead));
	if (observed.size !== items.length || observed.size !== expected.size || [...expected].some(pin => !observed.has(pin))) {
		return malformed(source, "grade_wave item coverage does not exactly match pinned beads");
	}
	const eligible = items.filter(row => row.gradable).map(row => row.bead).sort();
	if (!value.gradable.every(bead => typeof bead === "string") || value.gradable.length !== eligible.length
		|| [...value.gradable].sort().some((bead, index) => bead !== eligible[index])) {
		return malformed(source, "grade_wave gradable list disagrees with complete item rows");
	}
	return { status: "OK", source, rows: { gradable: eligible, items, installed_kit: value.installed_kit } };
}

function parseTracker(value: unknown, pins: string[], source: string): SourceResult<TrackerBead[]> {
	if (!Array.isArray(value)) return malformed(source, "br show output must be a complete array");
	const rows: TrackerBead[] = [];
	for (const item of value) {
		if (!object(item)) return malformed(source, "br show bead row is malformed");
		if (typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()
			|| !(typeof item.created_by === "string" || item.created_by === null)
			|| !(typeof item.assignee === "string" || item.assignee === null)
			|| typeof item.priority !== "number" || !Number.isFinite(item.priority) || typeof item.status !== "string") {
			return malformed(source, "br show bead row is incomplete or malformed");
		}
		rows.push({ id: item.id, title: item.title, created_by: item.created_by, assignee: item.assignee,
			priority: item.priority, status: item.status });
	}
	const expected = new Set(pins), observed = new Set(rows.map(row => row.id));
	if (observed.size !== rows.length || observed.size !== expected.size || [...expected].some(pin => !observed.has(pin))) {
		return malformed(source, "br show coverage does not exactly match pinned beads");
	}
	return { status: "OK", source, rows };
}

export async function gradableCandidates(repo: string, agent: string, pins: string[], runtime: GraderSourceRuntime = productionGraderSourceRuntime): Promise<SourceResult<GraderCandidate[]>> {
	const beadIds = unique(pins.map(pin => pin.trim())).sort();
	const source = `grade_wave.py gradable + br show (${beadIds.length} pins)`;
	if (!agent.trim()) return malformed(source, "grader identity is required");
	if (pins.some(pin => !pin.trim())) return malformed(source, "pinned bead list contains an empty id");
	if (beadIds.length === 0) return { status: "OK", source, rows: [] };
	const configuredScript = runtime.env.OMP_KIT_GRADE_WAVE?.trim();
	if (!configuredScript) return unavailable("OMP_KIT_GRADE_WAVE", "set OMP_KIT_GRADE_WAVE to the grade_wave.py producer path");
	const script = resolve(repo, configuredScript);
	if (!runtime.exists(script)) return unavailable(script, "configured grade_wave.py producer is absent");
	if (!runtime.which("python3")) return unavailable("python3", "python3 is absent");
	if (!runtime.which("br")) return unavailable("br", "br is absent");
	const gradeArgs = ["python3", "-B", script, "gradable", "--repo", resolve(repo), "--agent", agent, "--beads", beadIds.join(",")];
	let gradeOutput: RunResult;
	try { gradeOutput = await runtime.run(gradeArgs, { cwd: repo, deadline_s: 60, grace_s: 0.2, max_output_bytes: 16 * 1024 * 1024 }); }
	catch (error) { return unavailable(gradeArgs.join(" "), String(error)); }
	if (gradeOutput.timed_out || gradeOutput.truncated) return unavailable(gradeArgs.join(" "), gradeOutput.timed_out ? "grade_wave timed out" : "grade_wave output truncated");
	if (gradeOutput.rc !== 0) return { status: "FAILED", source: gradeArgs.join(" "), reason: `grade_wave exited ${gradeOutput.rc}: ${new TextDecoder().decode(gradeOutput.stderr).trim()}` };
	let admissionValue: unknown;
	try { admissionValue = JSON.parse(new TextDecoder().decode(gradeOutput.stdout)); }
	catch { return malformed(gradeArgs.join(" "), "grade_wave output is not valid JSON"); }
	const admission = parseAdmission(admissionValue, beadIds, gradeArgs.join(" "));
	if (admission.status !== "OK") return admission;
	const brArgs = ["br", "show", ...beadIds, "--no-auto-import", "--no-auto-flush", "--json"];
	let trackerOutput: RunResult;
	try { trackerOutput = await runtime.run(brArgs, { cwd: repo, deadline_s: 60, grace_s: 0.2, max_output_bytes: 16 * 1024 * 1024 }); }
	catch (error) { return unavailable(brArgs.join(" "), String(error)); }
	if (trackerOutput.timed_out || trackerOutput.truncated) return unavailable(brArgs.join(" "), trackerOutput.timed_out ? "br show timed out" : "br show output truncated");
	if (trackerOutput.rc !== 0) return { status: "FAILED", source: brArgs.join(" "), reason: `br show exited ${trackerOutput.rc}: ${new TextDecoder().decode(trackerOutput.stderr).trim()}` };
	let trackerValue: unknown;
	try { trackerValue = JSON.parse(new TextDecoder().decode(trackerOutput.stdout)); }
	catch { return malformed(brArgs.join(" "), "br show output is not valid JSON"); }
	const tracker = parseTracker(trackerValue, beadIds, brArgs.join(" "));
	if (tracker.status !== "OK") return tracker;
	const byId = new Map(tracker.rows.map(row => [row.id, row]));
	const admissionById = new Map(admission.rows.items.map(row => [row.bead, row]));
	const candidates: GraderCandidate[] = [];
	for (const id of admission.rows.gradable) {
		const bead = byId.get(id), proof = admissionById.get(id);
		if (!bead || !proof?.subjects?.[0]?.commit || bead.status !== "in_review") return malformed(source, `admitted pin ${id} lacks complete tracker or export evidence`);
		candidates.push({ id, title: bead.title, author: bead.created_by, assignee: bead.assignee,
			priority: bead.priority, skillStep: "non-author bead review", exportSha: proof.subjects[0].commit });
	}
	return { status: "OK", source, rows: candidates };
}

export async function realGradableCandidates(repo: string, agent: string): Promise<SourceResult<GraderCandidate[]>> {
	const pins = await declaredMilestonePins(repo);
	if (pins.status !== "OK") return pins;
	return gradableCandidates(repo, agent, pins.rows);
}
