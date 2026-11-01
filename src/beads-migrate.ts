import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { commandOf, expectedOf, parseBoxes, unreplayableReason } from "./verify.ts";
import { commandName, executedShellCommands } from "./fleet-guard/git.ts";
import { run } from "./kitlib/run.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";

const ORIGINAL = "## Original acceptance";
const MAX_OUTPUT = 16 << 20;
const RC_PREFIX = /^[ \t]*(?:->|expect(?:ed)?:)[ \t]*(?:rc|exit)[ \t]+[0-9]+\b/i;
const SWALLOWED_RC = /^(?:rc|exit)[ \t]+[0-9]+[ \t]+[^ \t]/i;
const WHAT_LINE = /^(?:what|scope)\b/im;
const WHY_LINE = /^(?:why|reason)\b/im;

export interface MigrationBead extends Record<string, unknown> {
	id: string; title: string; description: string; acceptance_criteria: string;
	status: string; updated_at: string; created_by: string; labels: string[];
}
interface Insertion { at: number; text: string }
interface Untick { at: number; previous: string }
interface Fields { description: string; acceptance_criteria: string; labels: string[] }
export interface MigrationPlan {
	id: string; status: "PLANNED"; before: MigrationBead; after: Fields;
	baseAcceptance: string; descriptionSource: { start: number; end: number } | null;
	insertions: Insertion[]; unticks: Untick[]; descriptionInsertions: Insertion[];
}
export interface MigrationUnchanged { id: string; status: "UNCHANGED"; reason: string }
interface PlanOptions { project: string; actor: string; failures?: readonly string[] }
interface RunOptions { project: string; actor: string; kitRoot: string; apply: boolean; ids?: readonly string[] }

function beadRecord(value: unknown): MigrationBead | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)
		|| !("id" in value) || typeof value.id !== "string" || !("title" in value) || typeof value.title !== "string"
		|| !("status" in value) || typeof value.status !== "string" || !("updated_at" in value) || typeof value.updated_at !== "string"
		|| !("created_by" in value) || typeof value.created_by !== "string") return null;
	// Match the incumbent native reader: omitted/null optional text is empty; malformed present values refuse.
	const description = "description" in value ? value.description ?? "" : "";
	const acceptance = "acceptance_criteria" in value ? value.acceptance_criteria ?? "" : "";
	const rawLabels = "labels" in value ? value.labels : undefined;
	if (typeof description !== "string" || typeof acceptance !== "string"
		|| (rawLabels !== undefined && !Array.isArray(rawLabels))) return null;
	const labels: string[] = [];
	if (Array.isArray(rawLabels)) for (const label of rawLabels) {
		if (typeof label !== "string") return null;
		labels.push(label);
	}
	return { ...value, id: value.id, title: value.title, status: value.status, updated_at: value.updated_at,
		created_by: value.created_by, description, acceptance_criteria: acceptance, labels };
}

/** Only insert metadata; the sole replacement allowed is an evidenced checkbox's explicit untick. */
function inserted(source: string, changes: readonly Insertion[], unticks: readonly Untick[] = []): string {
	const ordered = [...changes].sort((a, b) => a.at - b.at);
	let cursor = 0, result = "";
	for (const change of ordered) {
		if (!Number.isSafeInteger(change.at) || change.at < cursor || change.at > source.length) throw new Error("OBLIGATION_CHANGED: invalid insertion");
		result += source.slice(cursor, change.at) + change.text;
		cursor = change.at;
	}
	result += source.slice(cursor);
	// Apply unticks in original-coordinate space, accounting for metadata inserted before the checkbox.
	for (const tick of unticks) {
		if ((tick.previous !== "x" && tick.previous !== "X") || source[tick.at] !== tick.previous
			|| source.slice(tick.at - 3, tick.at) !== "- [" || source[tick.at + 1] !== "]") throw new Error("OBLIGATION_CHANGED: invalid untick");
		let at = tick.at;
		for (const change of ordered) if (change.at <= tick.at) at += change.text.length;
		result = result.slice(0, at) + " " + result.slice(at + 1);
	}
	return result;
}

/** A proposal's field values must be exactly the witnessed insertions, never a rewritten obligation. */
export function assertObligationUnchanged(plan: MigrationPlan): void {
	const original = plan.descriptionSource === null ? plan.before.acceptance_criteria
		: plan.before.description.slice(plan.descriptionSource.start, plan.descriptionSource.end);
	if (original !== plan.baseAcceptance || inserted(original, plan.insertions, plan.unticks) !== plan.after.acceptance_criteria
		|| inserted(plan.before.description, plan.descriptionInsertions) + `\n\n${ORIGINAL}\n${original}` !== plan.after.description) {
		throw new Error("OBLIGATION_CHANGED");
	}
}

/** Existence is checked in the selected candidate, not against the operator's unrelated filesystem. */
function candidateFile(project: string, name: string): boolean {
	try {
		const root = realpathSync(project), path = realpathSync(resolve(root, name)), rel = relative(root, path);
		return rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/") && statSync(path).isFile();
	} catch { return false; }
}
function namedTestCommand(command: string, project: string): boolean {
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection || inspection.commands.length !== 1 || inspection.writes.length !== 0 || inspection.assignments.length !== 0) return false;
	const entry = inspection.commands[0];
	if (entry === undefined || entry.argv.some(word => word.expanded)) return false;
	const [executable, ...args] = entry.words;
	if (executable === undefined) return false;
	const name = commandName(executable);
	if (name === "cargo" && args[0] === "test") return candidateFile(project, "Cargo.toml");
	if (name === "bun" && args[0] === "test") {
		return args.slice(1).some(arg => !arg.startsWith("-") && candidateFile(project, arg));
	}
	if (!["sh", "bash", "zsh", "python", "python3", "node", "bun"].includes(name)) return false;
	const script = args.find(arg => !arg.startsWith("-"));
	return script !== undefined && (script.startsWith("tests/") || basename(script).includes("test")) && candidateFile(project, script);
}
function replaySpan(body: string, project: string): { command: string; start: number; end: number } | null {
	for (let start = body.indexOf("`"); start >= 0;) {
		const end = body.indexOf("`", start + 1);
		if (end < 0) return null;
		const command = body.slice(start + 1, end);
		if (namedTestCommand(command, project)) return { command, start, end: end + 1 };
		start = body.indexOf("`", end + 1);
	}
	return null;
}

function acceptanceSource(bead: MigrationBead): { text: string; range: { start: number; end: number } | null } | null {
	if (bead.acceptance_criteria.trim() !== "") return { text: bead.acceptance_criteria, range: null };
	const newline = bead.description.indexOf("\nAC:");
	const marker = bead.description.startsWith("AC:") ? 0 : newline < 0 ? -1 : newline + 1;
	if (marker < 0) return null;
	const start = marker + 3, next = bead.description.indexOf("\n## ", start);
	const end = next < 0 ? bead.description.length : next;
	return { text: bead.description.slice(start, end), range: { start, end } };
}
/** AC-description/single-inline-v1: complete single-backtick spans only; no escape/fence recovery. */
function clauseStarts(text: string): { at: number; letter: string }[] | null {
	if (text.includes("\\`") || text.includes("```")) return null;
	const starts: { at: number; letter: string }[] = [];
	let quoted = false;
	for (let at = 0; at < text.length; at++) {
		if (text[at] === "`") { quoted = !quoted; continue; }
		const letter = text[at + 1];
		if (!quoted && text[at] === "(" && letter !== undefined && letter >= "a" && letter <= "z"
			&& text[at + 2] === ")" && (text[at + 3] === " " || text[at + 3] === "\t")) starts.push({ at, letter });
	}
	return quoted ? null : starts;
}

export function planBeadMigration(bead: MigrationBead, options: PlanOptions): MigrationPlan | MigrationUnchanged {
	const unchanged = (reason: string): MigrationUnchanged => ({ id: bead.id, status: "UNCHANGED", reason });
	if (bead.status !== "open") return unchanged("status-not-open");
	const actor = options.actor.trim().toLowerCase();
	if (!actor || !bead.created_by.trim()) return unchanged("author-unknown");
	if (actor === bead.created_by.trim().toLowerCase() || (typeof bead.assignee === "string" && actor === bead.assignee.trim().toLowerCase())) return unchanged("non-author-required");
	const source = acceptanceSource(bead);
	if (source === null) return unchanged("needs-builder-command");
	const insertions: Insertion[] = [], unticks: Untick[] = [], descriptionInsertions: Insertion[] = [];
	const base = source.text;
	if (source.range !== null && parseBoxes(base).length === 0) {
		const starts = clauseStarts(base);
		if (starts === null) return unchanged("unsupported-acceptance-carrier");
		if (starts.length === 0) return unchanged("needs-builder-command");
		for (let index = 0; index < starts.length; index++) {
			const start = starts[index];
			if (start !== undefined) insertions.push({ at: index === 0 ? 0 : start.at, text: `${index === 0 ? "" : "\n"}- [ ] [${start.letter}] [build] ` });
		}
	}
	// Recognize only exact checklist carriers, then let verify.ts parse their tag runs and commands.
	let offset = 0;
	for (const raw of base.split("\n")) {
		const trim = raw.trimStart(), leading = raw.length - trim.length;
		if (trim.startsWith("- [ ] ") || trim.startsWith("- [x] ") || trim.startsWith("- [X] ")) {
			const box = parseBoxes(raw)[0];
			if (box === undefined) {
				insertions.push({ at: offset + leading + 6, text: "[a] [build] " });
				if (trim[3] === "x" || trim[3] === "X") unticks.push({ at: offset + leading + 3, previous: trim[3] });
			} else if (box.phase === null && box.letter !== null) {
				const tag = raw.indexOf(`[${box.letter}]`, leading + 6);
				insertions.push({ at: offset + tag + 3, text: " [build]" });
				if (trim[3] === "x" || trim[3] === "X") unticks.push({ at: offset + leading + 3, previous: trim[3] });
			}
		}
		offset += raw.length + 1;
	}
	let candidate = inserted(base, insertions, unticks);
	if (parseBoxes(candidate).length === 0) return unchanged("needs-builder-command");
	// Native box bodies are exact suffixes of their own raw lines; repeated text is never relocated by search.
	const commandChanges: Insertion[] = [], orderedInsertions = [...insertions].sort((a, b) => a.at - b.at);
	let candidateOffset = 0;
	for (const raw of candidate.split("\n")) {
		const box = parseBoxes(raw)[0], lineOffset = candidateOffset;
		candidateOffset += raw.length + 1;
		if (box === undefined) continue;
		const replay = replaySpan(box.body, options.project);
		if (replay === null) return unchanged("needs-builder-command");
		const bodyAt = lineOffset + raw.trimEnd().length - box.body.length;
		const first = commandOf(box.body);
		const expected = expectedOf(box.body);
		let at: number, text: string;
		if (first !== replay.command) { at = bodyAt; text = `\`${replay.command}\` -> rc 0; `; }
		else if (expected === null) { at = bodyAt + replay.end; text = " -> rc 0;"; }
		else if (SWALLOWED_RC.test(expected)) {
			const prefix = RC_PREFIX.exec(box.body.slice(replay.end));
			if (prefix === null) return unchanged("needs-builder-command");
			at = bodyAt + replay.end + prefix[0].length; text = ";";
		} else if (unreplayableReason(box) !== null) return unchanged("unsupported-replay");
		else continue;
		let shift = 0;
		for (const addition of orderedInsertions) {
			const start = addition.at + shift;
			if (at < start) break;
			if (at < start + addition.text.length) return unchanged("unmapped-metadata-span");
			shift += addition.text.length;
		}
		const originalAt = at - shift;
		commandChanges.push({ at: originalAt, text });
		const lineAt = base.lastIndexOf("\n", originalAt - 1) + 1;
		const originalLine = base.slice(lineAt).split("\n", 1)[0] ?? "", trimmed = originalLine.trimStart();
		const tickAt = lineAt + originalLine.length - trimmed.length + 3;
		if ((trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) && !unticks.some(tick => tick.at === tickAt)) {
			unticks.push({ at: tickAt, previous: trimmed[3] ?? "" });
		}
	}
	insertions.push(...commandChanges);
	candidate = inserted(base, insertions, unticks);
	if (parseBoxes(candidate).some(box => unreplayableReason(box) !== null)) return unchanged("unsupported-replay");
	const failures = options.failures ?? [];
	if (failures.includes("b-what-why-acc")) {
		if (!/\bWHAT[ \t]*:/.test(bead.description)) {
			const match = WHAT_LINE.exec(bead.description);
			if (match === null) return unchanged("reason-or-scope-not-derived");
			descriptionInsertions.push({ at: match.index, text: "WHAT: " });
		}
		if (!/\bWHY[ \t]*:/.test(bead.description)) {
			const match = WHY_LINE.exec(bead.description);
			if (match === null) return unchanged("reason-or-scope-not-derived");
			descriptionInsertions.push({ at: match.index, text: "WHY: " });
		}
	}
	let labels = bead.labels;
	if (failures.includes("a-label")) {
		if (typeof bead.issue_type !== "string" || bead.issue_type.trim() === "") return unchanged("label-not-derived");
		labels = [bead.issue_type];
	}
	if (source.range === null && candidate === bead.acceptance_criteria && descriptionInsertions.length === 0 && labels === bead.labels) return unchanged("already-clean");
	if (bead.description.split("\n").some(line => line.startsWith(ORIGINAL))) return unchanged("original-acceptance-already-present");
	const plan: MigrationPlan = { id: bead.id, status: "PLANNED", before: bead,
		after: { acceptance_criteria: candidate, description: inserted(bead.description, descriptionInsertions) + `\n\n${ORIGINAL}\n${base}`, labels },
		baseAcceptance: base, descriptionSource: source.range, insertions, unticks, descriptionInsertions };
	assertObligationUnchanged(plan);
	return plan;
}

function outputJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function canonicalLint(records: readonly MigrationBead[], targets: readonly string[], options: RunOptions, env: Record<string, string>): Promise<Map<string, string[]>> {
	const result = await run(["python3", "-I", "-B", "bead_lint.py", "--admission-stdin"], {
		cwd: join(options.kitRoot, "scripts"), env, stdin: JSON.stringify({ records, targets }), deadline_s: 60, max_output_bytes: MAX_OUTPUT,
	});
	if (result.rc !== 0 || result.timed_out || result.truncated) throw new Error(`MIGRATION_LINT_UNAVAILABLE rc=${result.rc}`);
	const parsed = outputJson(result.stdout);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
		|| !("schema_version" in parsed) || parsed.schema_version !== "bead-lint.kit/v1"
		|| !("mode" in parsed) || parsed.mode !== "admission-stdin"
		|| !("rows" in parsed) || !Array.isArray(parsed.rows)) throw new Error("MIGRATION_LINT_UNAVAILABLE invalid envelope");
	const rows = new Map<string, string[]>();
	for (const row of parsed.rows) {
		if (row === null || typeof row !== "object" || Array.isArray(row) || !("id" in row) || typeof row.id !== "string"
			|| !("failures" in row) || !Array.isArray(row.failures) || !row.failures.every((item: unknown) => typeof item === "string")
			|| rows.has(row.id)) throw new Error("MIGRATION_LINT_UNAVAILABLE invalid row");
		rows.set(row.id, row.failures);
	}
	if (targets.some(id => !rows.has(id))) throw new Error("MIGRATION_LINT_UNAVAILABLE incomplete rows");
	return rows;
}

export async function migrateBeads(options: RunOptions, inherited: Readonly<Record<string, string | undefined>> = process.env): Promise<{ overall: string; apply: boolean; migrations: Record<string, unknown>[] }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inherited)) if (typeof value === "string") env[key] = value;
	for (const key of ["BEADS_DB", "BD_DB", "BD_DATABASE", "BEADS_JSONL", "BEADS_CACHE_DIR"]) delete env[key];
	const db = join(options.project, ".beads/beads.db");
	if (!existsSync(db)) throw new Error("MIGRATION_TRACKER_UNAVAILABLE");
	const callBr = (args: string[], readOnly: boolean) => run(["br", "--db", join(options.project, ".beads/beads.db"), "--no-auto-import", ...(readOnly ? ["--no-auto-flush"] : []), ...args], {
		cwd: options.project, env, deadline_s: 30, max_output_bytes: MAX_OUTPUT,
	});
	const listed = await callBr(["list", "--all", "--limit", "0", "--json"], true);
	if (listed.rc !== 0 || listed.timed_out || listed.truncated) throw new Error(`MIGRATION_READ_UNAVAILABLE rc=${listed.rc}`);
	const parsed = outputJson(listed.stdout);
	const raw = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object"
		&& "issues" in parsed && Array.isArray(parsed.issues) ? parsed.issues : null;
	if (raw === null) throw new Error("MIGRATION_READ_UNAVAILABLE invalid records");
	const records: MigrationBead[] = [];
	for (const row of raw) {
		const bead = beadRecord(row);
		if (bead === null) throw new Error("MIGRATION_READ_UNAVAILABLE invalid record");
		records.push(bead);
	}
	const selected = options.ids === undefined ? records.filter(bead => bead.status === "open") : records.filter(bead => options.ids?.includes(bead.id));
	if (options.ids?.some(id => !selected.some(bead => bead.id === id))) throw new Error("MIGRATION_BEAD_UNKNOWN");
	const baseline = await canonicalLint(records, selected.map(bead => bead.id), options, env);
	const plans = selected.map(bead => planBeadMigration(bead, { ...options, failures: baseline.get(bead.id) }));
	const proposed = new Map(plans.filter((plan): plan is MigrationPlan => plan.status === "PLANNED").map(plan => [plan.id, plan]));
	const afterRecords = records.map(bead => { const plan = proposed.get(bead.id); return plan === undefined ? bead : { ...bead, ...plan.after }; });
	const admission = await canonicalLint(afterRecords, [...proposed.keys()], options, env);
	const migrations: Record<string, unknown>[] = [];
	for (const plan of plans) {
		if (plan.status !== "PLANNED") { migrations.push({ ...plan }); continue; }
		assertObligationUnchanged(plan);
		const failures = admission.get(plan.id);
		if (failures === undefined || failures.length !== 0) { migrations.push({ id: plan.id, status: "UNCHANGED", reason: "admission-needs-owner", failures }); continue; }
		if (!options.apply) { migrations.push({ id: plan.id, status: "PLANNED", before: plan.before, after: plan.after }); continue; }
		const argv = ["update", plan.id, "--if-unchanged", plan.before.updated_at, "--description", plan.after.description, "--acceptance-criteria", plan.after.acceptance_criteria, "--actor", options.actor];
		for (const label of plan.after.labels) if (!plan.before.labels.includes(label)) argv.push("--add-label", label);
		const applied = await callBr(argv, false);
		if (applied.rc !== 0 || applied.timed_out || applied.truncated) { migrations.push({ id: plan.id, status: "REFUSED", reason: "conditional-update-refused", rc: applied.rc }); continue; }
		const readback = await callBr(["show", plan.id, "--json"], true);
		const decoded = readback.rc === 0 && !readback.timed_out && !readback.truncated ? outputJson(readback.stdout) : null;
		const bead = beadRecord(Array.isArray(decoded) ? decoded[0] : decoded);
		const same = bead !== null && bead.description === plan.after.description && bead.acceptance_criteria === plan.after.acceptance_criteria
			&& bead.status === plan.before.status && (bead.assignee ?? null) === (plan.before.assignee ?? null)
			&& [...bead.labels].sort().join("\n") === [...plan.after.labels].sort().join("\n");
		migrations.push({ id: plan.id, status: same ? "APPLIED" : "UNVERIFIED", reason: same ? "readback-matched" : "readback-mismatch" });
	}
	const outstanding = migrations.some(row => row.reason !== "already-clean" && row.status !== "APPLIED" && row.status !== "PLANNED");
	return { overall: options.apply && outstanding ? "FINDINGS" : "OK", apply: options.apply, migrations };
}

export async function beadsMigrateCommand(request: ParsedCommand, kitRoot: string): Promise<CliResult> {
	const projectFlag = request.flags.get("--project"), actorFlag = request.flags.get("--actor"), idsFlag = request.flags.get("--bead");
	const actor = typeof actorFlag === "string" ? actorFlag : process.env.AGENT_NAME ?? "";
	if (!actor.trim()) return { code: 2, data: { overall: "NOT_RUN" }, errors: [{ code: "MIGRATION_ACTOR_REQUIRED", message: "Migration requires an identified non-author actor", remediation: "Pass --actor; no tracker was changed." }], verification: "NOT_RUN" };
	const result = await migrateBeads({ project: realpathSync(typeof projectFlag === "string" ? projectFlag : process.cwd()), actor,
		kitRoot, apply: request.flags.has("--apply"), ...(typeof idsFlag === "string" ? { ids: idsFlag.split("\n") } : {}) });
	return { code: result.overall === "OK" ? 0 : 1, data: result, verification: "UNVERIFIED" };
}
