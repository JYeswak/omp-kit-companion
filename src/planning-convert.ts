import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import type { PresentationResult } from "./output.ts";
import { scorePlanningSnapshot, type MissionScore, type PlanningBead, type PlanningScoreSnapshot } from "./planning-score.ts";

type PlanItem = {
	slug: string;
	title: string;
	line: number;
	type: string;
	priority: string;
	labels: string[];
	dependsOn: string[];
	existing: string;
	discoveredFrom: string;
	what: string;
	why: string;
	acceptance: string;
	noClaim: string;
	templateHeading: string | null;
	templateBody: string;
	relates: string;
	removeDependsOn: string;
};
type UnparseableBlock = { line: number; slug: string | null; heading: string; reasons: string[] };
type ItemFinding = { line?: number; slug?: string; code: string; message: string };
type CoverageFinding = { slug: string; line: number; letter: string; missing_positive: boolean; missing_planted_negative: boolean };
type PlanCycle = { slugs: string[]; path: string[] };
type CapturedCommand = { exit_code: number | null; stdout: string; stderr: string; error: string | null };
type CreatedItem = { slug: string; title: string; id: string; line: number; external_ref: string };
type NativeIssue = {
	id: string;
	title: string;
	description: string;
	acceptance_criteria: string;
	status: string;
	priority: Priority;
	issue_type: string;
	labels: string[];
	dependency_count: number;
	external_ref: string | null;
};
type NativeIssueDetails = NativeIssue & { updated_at: string; parent: string | null; notes: string };
type NativeDependency = { issue_id: string; depends_on_id: string; type: string; status: string };
type ApplyWrite = {
	kind: "EPIC_CREATED" | "ITEM_CREATED" | "AMENDED" | "DEPENDENCY_ADDED";
	id: string;
	slug?: string;
	slugs?: string[];
	target?: string;
	external_ref?: string;
	acceptance_added?: string[];
	contributions_added?: string[];
};
type AmendedTarget = { id: string; slugs: string[]; acceptance_added: string[]; contributions_added: string[]; status: "AMENDED" | "UNCHANGED" };
type ForeignTarget = { status: "FOREIGN"; id: string; slug: string };
type ApplyFailure = { step: string; message: string; exit_code: number | null; stdout: string; stderr: string; reconciliation_error?: string };
type ApplyReconciliation = { writes: ApplyWrite[]; error: string | null };
type NativeList = { issues: NativeIssue[]; error: string | null };
type Priority = 0 | 1 | 2 | 3 | 4;
type BeadScoreMetrics = { median_chars: number | null; acceptance_share: number | null; deps_per_bead: number | null; mission_beads: number | null };
type PlanningBeadMetrics = { median_description_chars: number | null; planning_score_median_chars: number | null; acceptance_share: number | null; deps_per_bead: number | null; mission_beads: number | null };
type CreateFailure = { slug: string; line: number | null; exit_code: number | null; stdout: string; stderr: string; error: string | null };
type DependencyEdge = { slug: string; target: string; status: "ADDED" | "SKIPPED_CYCLE" | "ALREADY_PRESENT" | "SKIPPED_FOREIGN"; issue_id: string; depends_on_id: string };
type DependencyFailure = { slug: string; target: string; message: string; exit_code?: number | null };
type ConvertReport = {
	kind: "planning-convert";
	overall: "CLEAN" | "FINDINGS" | "REFUSED" | "UNAVAILABLE";
	mission: string;
	plan_path: string;
	db_dir: string;
	candidate_blocks: number;
	items_parsed: number;
	beads_created: number;
	total_beads_created: number;
	parent_epic_id: string | null;
	created_items: CreatedItem[];
	create_failures: CreateFailure[];
	dependency_edges: DependencyEdge[];
	dependency_failures: DependencyFailure[];
	dependency_cycles: PlanCycle[];
	uncovered_what_letters: CoverageFinding[];
	unparseable_blocks: UnparseableBlock[];
	item_findings: ItemFinding[];
	br_lint_exit_code: number | null;
	br_lint_finding_count: number | null;
	br_lint_clean: boolean | null;
	br_lint_parse_error: string | null;
	br_lint_stdout: string;
	br_lint_stderr: string;
	br_lint_error: string | null;
	br_cycle_exit_code: number | null;
	br_cycle_count: number | null;
	br_cycle_clean: boolean | null;
	br_cycle_parse_error: string | null;
	br_cycle_stdout: string;
	br_cycle_stderr: string;
	br_cycle_error: string | null;
	br_list_exit_code: number | null;
	br_list_error: string | null;
	planning_score_bead_metrics: PlanningBeadMetrics;
	database_path?: string;
	db_refusal?: string;
	apply?: boolean;
	tracker_root?: string;
	reused_items?: CreatedItem[];
	amended_targets?: AmendedTarget[];
	foreign_targets?: ForeignTarget[];
	writes_landed?: ApplyWrite[];
	apply_preflight_error?: string;
	apply_failure?: ApplyFailure;
	merged_dependency_cycles?: string[][];
	text?: string;
};
type BrExitCode = 0 | 1 | 2 | 3 | 4;
const ALLOWED_PRIORITIES: Priority[] = [0, 1, 2, 3, 4];

type BlockHeader = { slug: string; title: string; inlineType: string | null; inlinePriority: string | null; error: string | null };
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const BR_TIMEOUT_MS = 60_000;
const BR_MAX_BUFFER = 64 * 1024 * 1024;
const KNOWN_FIELDS = ["type", "priority", "labels", "depends-on", "relates", "remove-depends-on", "existing", "discovered-from", "WHAT", "WHY", "ACCEPTANCE", "NO-CLAIM"] as const;
const ALLOWED_LABEL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_:";
const ALLOWED_SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";
const VALID_TYPES = ["task", "feature", "bug", "epic"];
const REQUIRED_FIELDS = ["type", "priority", "labels", "depends-on", "existing", "discovered-from", "WHAT", "WHY", "ACCEPTANCE", "NO-CLAIM"];
const ACTOR_ARGS = ["--no-auto-import", "--no-auto-flush", "--no-daemon", "--no-color"];

function splitLines(value: string): string[] {
	const lines = value.split("\n");
	for (let index = 0; index < lines.length; index++) if (lines[index]!.endsWith("\r")) lines[index] = lines[index]!.slice(0, -1);
	return lines;
}

function isSlug(value: string): boolean {
	if (!value || value.startsWith("-") || value.endsWith("-")) return false;
	for (const character of value) if (!ALLOWED_SLUG_CHARS.includes(character)) return false;
	return true;
}

function isValidLabel(value: string): boolean {
	if (!value) return false;
	for (const character of value) if (!ALLOWED_LABEL_CHARS.includes(character)) return false;
	return true;
}

function headerFromLine(line: string): BlockHeader | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("### ")) return null;
	const body = trimmed.slice(4);
	const separator = body.indexOf(" — ");
	if (separator < 0) {
		const partialSlug = body.trim().split(" ")[0] ?? "";
		return { slug: partialSlug || "", title: "", inlineType: null, inlinePriority: null, error: "expected `### <slug> — <title>`" };
	}
	const slug = body.slice(0, separator).trim();
	const titleAndFields = body.slice(separator + 3);
	let title = titleAndFields.trim();
	let inlineType: string | null = null;
	let inlinePriority: string | null = null;
	const typeAt = titleAndFields.indexOf("type:");
	if (typeAt > 0 && titleAndFields[typeAt - 1] === " " && titleAndFields.indexOf("priority:", typeAt + 5) > typeAt) {
		const fields = titleAndFields.slice(typeAt).trim();
		const typeValue = fields.slice("type:".length).trimStart();
		const priorityAt = typeValue.indexOf("priority:");
		if (priorityAt > 0 && typeValue[priorityAt - 1] === " ") {
			inlineType = typeValue.slice(0, priorityAt).trim();
			inlinePriority = typeValue.slice(priorityAt + "priority:".length).trim();
			title = titleAndFields.slice(0, typeAt).trim();
		}
	}
	const error = !isSlug(slug) ? "slug must contain lowercase ASCII letters, digits and hyphens" : !title ? "title is empty" : null;
	return { slug, title, inlineType, inlinePriority, error };
}

function fieldLine(line: string): { key: string; value: string } | null {
	const trimmed = line.trimStart();
	for (const key of KNOWN_FIELDS) {
		const marker = key + ":";
		if (trimmed.startsWith(marker)) return { key, value: trimmed.slice(marker.length).trimStart() };
	}
	return null;
}

function parseTypeAndPriority(value: string): { type: string; priority: string | null } {
	const marker = "priority:";
	const index = value.indexOf(marker);
	if (index > 0 && value[index - 1] === " ") return { type: value.slice(0, index).trim(), priority: value.slice(index + marker.length).trim() };
	return { type: value.trim(), priority: null };
}

function fieldValue(fields: Map<string, string[]> , key: string): string {
	return (fields.get(key) ?? []).join("\n").trim();
}

function parseDelimited(value: string): string[] {
	const values: string[] = [];
	let part = "";
	const push = () => {
		const token = part.trim();
		if (token && token.toLowerCase() !== "(none)" && token.toLowerCase() !== "none") values.push(token);
		part = "";
	};
	for (const character of value) {
		if (character === "," || character === "\n") push();
		else part += character;
	}
	push();
	return values;
}

function requiredFieldError(fields: Map<string, string[]>, key: string): string | null {
	if (!fields.has(key) || !fieldValue(fields, key)) return "required field `" + key + ":` is missing or empty";
	return null;
}

function parseBlock(lines: string[], header: BlockHeader, line: number): { item: PlanItem | null; reasons: string[] } {
	const fields = new Map<string, string[]>();
	const reasons: string[] = [];
	if (header.error) reasons.push(header.error);
	if (header.inlineType !== null) fields.set("type", [header.inlineType]);
	if (header.inlinePriority !== null) fields.set("priority", [header.inlinePriority]);
	let activeField = "";
	let templateHeading: string | null = null;
	const templateLines: string[] = [];
	for (const rawLine of lines.slice(1)) {
		const trimmed = rawLine.trim();
		if (trimmed === "## Steps to Reproduce" || trimmed === "## Success Criteria") {
			if (templateHeading !== null) reasons.push("multiple template sections are present");
			else templateHeading = trimmed;
			activeField = "template";
			continue;
		}
		const parsedField = fieldLine(rawLine);
		if (parsedField) {
			if (parsedField.key === "type") {
				const parsedType = parseTypeAndPriority(parsedField.value);
				if (fields.has("type")) reasons.push("field `type:` appears more than once");
				else fields.set("type", [parsedType.type]);
				if (parsedType.priority !== null) {
					if (fields.has("priority")) reasons.push("field `priority:` appears more than once");
					else fields.set("priority", [parsedType.priority]);
				}
				activeField = "type";
				continue;
			}
			if (fields.has(parsedField.key)) reasons.push("field `" + parsedField.key + ":` appears more than once");
			else fields.set(parsedField.key, parsedField.value ? [parsedField.value] : []);
			activeField = parsedField.key;
			continue;
		}
		if (!trimmed) {
			if (activeField === "template") templateLines.push("");
			else if (activeField) fields.get(activeField)?.push("");
			continue;
		}
		if (activeField === "template") templateLines.push(rawLine.trim());
		else if (activeField) fields.get(activeField)?.push(rawLine.trim());
		else reasons.push("unrecognized content without a field name: " + trimmed);
	}
	for (const key of REQUIRED_FIELDS) {
		const reason = requiredFieldError(fields, key);
		if (reason) reasons.push(reason);
	}
	if (reasons.length) return { item: null, reasons };
	const labels = parseDelimited(fieldValue(fields, "labels"));
	const item: PlanItem = {
		slug: header.slug,
		title: header.title,
		line,
		type: fieldValue(fields, "type"),
		priority: fieldValue(fields, "priority"),
		labels,
		dependsOn: parseDelimited(fieldValue(fields, "depends-on")),
		existing: fieldValue(fields, "existing"),
		discoveredFrom: fieldValue(fields, "discovered-from"),
		what: fieldValue(fields, "WHAT"),
		why: fieldValue(fields, "WHY"),
		acceptance: fieldValue(fields, "ACCEPTANCE"),
		noClaim: fieldValue(fields, "NO-CLAIM"),
		templateHeading,
		templateBody: templateLines.join("\n").trim(),
		relates: fieldValue(fields, "relates"),
		removeDependsOn: fieldValue(fields, "remove-depends-on"),
	};
	return { item, reasons: [] };
}

function parsePlan(source: string): { items: PlanItem[]; unparseable: UnparseableBlock[]; candidateSlugs: Set<string>; candidateBlocks: number } {
	const lines = splitLines(source);
	const items: PlanItem[] = [];
	const unparseable: UnparseableBlock[] = [];
	const candidateSlugs = new Set<string>();
	const seenHeaders = new Set<string>();
	let candidateBlocks = 0;
	let lineIndex = 0;
	while (lineIndex < lines.length) {
		if (lines[lineIndex]!.trim() !== "```text") { lineIndex++; continue; }
		const opening = lineIndex;
		const contentStart = opening + 1;
		let closing = contentStart;
		while (closing < lines.length && lines[closing]!.trim() !== "```") closing++;
		const header = lines[contentStart] === undefined ? null : headerFromLine(lines[contentStart]!);
		if (header) {
			candidateBlocks++;
			const blockLine = contentStart + 1;
			const duplicate = Boolean(header.slug && seenHeaders.has(header.slug));
			if (header.slug) {
				candidateSlugs.add(header.slug);
				seenHeaders.add(header.slug);
			}
			if (duplicate) unparseable.push({ line: blockLine, slug: header.slug || null, heading: lines[contentStart]!, reasons: ["duplicate plan slug"] });
			else if (closing === lines.length) unparseable.push({ line: blockLine, slug: header.slug || null, heading: lines[contentStart]!, reasons: ["text fence is not closed"] });
			else {
				const parsed = parseBlock(lines.slice(contentStart, closing), header, blockLine);
				if (!parsed.item) unparseable.push({ line: blockLine, slug: header.slug || null, heading: lines[contentStart]!, reasons: parsed.reasons });
				else items.push(parsed.item);
			}
		}
		lineIndex = closing < lines.length ? closing + 1 : lines.length;
	}
	return { items, unparseable, candidateSlugs, candidateBlocks };
}

function whatLetters(value: string): string[] {
	const letters = new Set<string>();
	for (let index = 0; index + 2 < value.length; index++) {
		if (value[index] !== "(") continue;
		const letter = value[index + 1]!;
		if (letter >= "a" && letter <= "z" && value[index + 2] === ")") letters.add(letter);
	}
	return [...letters].sort();
}

function acceptanceBoxes(value: string): Array<{ letter: string; text: string }> {
	const boxes: Array<{ letter: string; text: string }> = [];
	for (const line of splitLines(value)) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("- [")) {
			const close = trimmed.indexOf("]", 3);
			if (close > 3) boxes.push({ letter: trimmed.slice(3, close).trim(), text: trimmed.slice(close + 1).trim() });
		} else if (trimmed && boxes.length) boxes[boxes.length - 1]!.text += " " + trimmed;
	}
	return boxes;
}

function coverageFindings(items: PlanItem[]): CoverageFinding[] {
	const findings: CoverageFinding[] = [];
	for (const item of items) {
		const letters = whatLetters(item.what);
		if (!letters.length) {
			findings.push({ slug: item.slug, line: item.line, letter: "(none)", missing_positive: true, missing_planted_negative: true });
			continue;
		}
		const boxes = acceptanceBoxes(item.acceptance);
		for (const letter of letters) {
			const matching = boxes.filter((box) => box.letter === letter);
			const hasNegative = matching.some((box) => box.text.toLowerCase().includes("planted negative"));
			const hasPositive = matching.some((box) => !box.text.toLowerCase().includes("planted negative"));
			if (!hasPositive || !hasNegative) findings.push({ slug: item.slug, line: item.line, letter, missing_positive: !hasPositive, missing_planted_negative: !hasNegative });
		}
	}
	return findings;
}

function itemFindings(items: PlanItem[], mission: string): ItemFinding[] {
	const findings: ItemFinding[] = [];
	for (const item of items) {
		for (const label of item.labels) if (!isValidLabel(label)) findings.push({ line: item.line, slug: item.slug, code: "INVALID_LABEL", message: "label `" + label + "` contains characters outside letters, digits, hyphen, underscore and colon" });
		if (!VALID_TYPES.includes(item.type)) findings.push({ line: item.line, slug: item.slug, code: "INVALID_TYPE", message: "unsupported issue type `" + item.type + "`" });
		if (!["0", "1", "2", "3", "4"].includes(item.priority)) findings.push({ line: item.line, slug: item.slug, code: "INVALID_PRIORITY", message: "priority must be 0 through 4" });
		if (item.type === "bug" && item.templateHeading !== "## Steps to Reproduce")
			findings.push({ line: item.line, slug: item.slug, code: "MISSING_BUG_REPRODUCTION", message: "bug item is missing `## Steps to Reproduce`" });
		if (item.type === "epic" && item.templateHeading !== "## Success Criteria")
			findings.push({ line: item.line, slug: item.slug, code: "MISSING_EPIC_SUCCESS_CRITERIA", message: "epic item is missing `## Success Criteria`" });
		if (!item.labels.includes("mission:" + mission)) findings.push({ line: item.line, slug: item.slug, code: "MISSION_LABEL_MISSING", message: "labels do not include `mission:" + mission + "`" });
	}
	return findings;
}

function cycleKey(slugs: string[]): string {
	const loop = slugs.slice(0, -1);
	if (!loop.length) return "";
	let least = 0;
	for (let index = 1; index < loop.length; index++) if (loop[index]! < loop[least]!) least = index;
	const rotated = loop.slice(least).concat(loop.slice(0, least));
	return rotated.concat(rotated[0]!).join("\u0000");
}

function planCycles(items: PlanItem[]): { cycles: PlanCycle[]; cycleEdges: Set<string> } {
	const bySlug = new Map(items.map((item) => [item.slug, item]));
	const states = new Map<string, number>();
	const stack: string[] = [];
	const cyclesByKey = new Map<string, PlanCycle>();
	const cycleEdges = new Set<string>();
	const visit = (slug: string): void => {
		states.set(slug, 1);
		stack.push(slug);
		for (const dependency of bySlug.get(slug)?.dependsOn ?? []) {
			if (!bySlug.has(dependency)) continue;
			const state = states.get(dependency) ?? 0;
			if (state === 0) visit(dependency);
			else if (state === 1) {
				const cycleStart = stack.lastIndexOf(dependency);
				const path = stack.slice(cycleStart).concat(dependency);
				const key = cycleKey(path);
				if (!cyclesByKey.has(key)) cyclesByKey.set(key, { slugs: path.slice(0, -1), path });
				for (let index = 0; index + 1 < path.length; index++) cycleEdges.add(path[index]! + "\u0000" + path[index + 1]!);
			}
		}
		stack.pop();
		states.set(slug, 2);
	};
	for (const item of items) if ((states.get(item.slug) ?? 0) === 0) visit(item.slug);
	return { cycles: [...cyclesByKey.values()], cycleEdges };
}

function descriptionFor(item: PlanItem, planPath: string, textOnlyDependencies: string[]): string {
	const sections = [
		"Source item: core8:" + item.slug + " (" + planPath + ":" + item.line + ")",
		"",
		"WHAT:", item.what,
		"",
		"WHY:", item.why,
		"",
		"NO-CLAIM:", item.noClaim,
	];
	if (item.templateHeading) sections.push("", item.templateHeading, item.templateBody);
	const metadata = [
		["existing", item.existing],
		["discovered-from", item.discoveredFrom],
		["relates", item.relates],
		["remove-depends-on", item.removeDependsOn],
		["depends-on references kept as text", textOnlyDependencies.join(", ")],
	].filter((entry) => entry[1]);
	if (metadata.length) {
		sections.push("", "Source metadata:");
		for (const [key, value] of metadata) sections.push(key + ": " + value);
	}
	return sections.join("\n").trim();
}

function safeDbDirectory(path: string, cwd: string): { directory: string; database: string } | { error: string } {
	const directory = resolve(cwd, path);
	if (directory.split(sep).includes(".beads")) return { error: "--db must not be inside a `.beads` tracker directory" };
	if (directory === parse(directory).root) return { error: "--db must name a dedicated isolated directory" };
	let current = parse(directory).root;
	for (const component of directory.slice(current.length).split(sep)) {
		if (!component) continue;
		current = join(current, component);
		try {
			if (lstatSync(current).isSymbolicLink()) return { error: "--db path contains a symbolic link" };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
			return { error: "--db path cannot be safely inspected: " + (error instanceof Error ? error.message : String(error)) };
		}
	}
	try {
		const stat = lstatSync(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return { error: "--db must be a real directory, not a file or link" };
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			return { error: "--db directory cannot be inspected: " + (error instanceof Error ? error.message : String(error)) };
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
		} catch (createError) {
			return { error: "cannot create isolated --db directory: " + (createError instanceof Error ? createError.message : String(createError)) };
		}
	}
	try {
		const names = readdirSync(directory);
		const unexpected = names.filter((name) => name !== ".owner");
		if (unexpected.length) return { error: "--db directory is not fresh; unexpected entries: " + unexpected.join(", ") };
		if (names.includes(".owner")) {
			const owner = lstatSync(join(directory, ".owner"));
			if (!owner.isFile() || owner.isSymbolicLink()) return { error: "--db .owner must be a regular file" };
		}
	} catch (error) {
		return { error: "--db directory cannot be inspected: " + (error instanceof Error ? error.message : String(error)) };
	}
	return { directory, database: join(directory, ".beads", "beads.db") };
}

function safeTrackerRoot(path: string, cwd: string): { trackerRoot: string; commandCwd: string; database: string } | { error: string } {
	if (!path.trim()) return { error: "--tracker-root requires a non-empty directory" };
	const trackerRoot = resolve(cwd, path);
	let current = parse(trackerRoot).root;
	for (const component of trackerRoot.slice(current.length).split(sep)) {
		if (!component) continue;
		current = join(current, component);
		try {
			if (lstatSync(current).isSymbolicLink()) return { error: "--tracker-root path contains a symbolic link" };
		} catch (error) {
			return { error: "--tracker-root path cannot be safely inspected: " + (error instanceof Error ? error.message : String(error)) };
		}
	}
	try {
		const rootStat = lstatSync(trackerRoot);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { error: "--tracker-root must be a real directory, not a file or link" };
		const isBeadsDirectory = parse(trackerRoot).base === ".beads";
		const beadsDirectory = isBeadsDirectory ? trackerRoot : join(trackerRoot, ".beads");
		const beadsStat = isBeadsDirectory ? rootStat : lstatSync(beadsDirectory);
		if (beadsStat.isSymbolicLink() || !beadsStat.isDirectory()) return { error: "--tracker-root must contain a real `.beads` directory" };
		const database = join(beadsDirectory, "beads.db");
		const databaseStat = lstatSync(database);
		if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) return { error: "--tracker-root must contain a regular `.beads/beads.db` file" };
		return { trackerRoot, commandCwd: isBeadsDirectory ? parse(trackerRoot).dir : trackerRoot, database };
	} catch (error) {
		return { error: "--tracker-root cannot be safely inspected: " + (error instanceof Error ? error.message : String(error)) };
	}
}

function runApplyBr(args: string[], database: string, cwd: string, write: boolean, input?: string): CapturedCommand {
	try {
		const options = ["--no-auto-import", ...(write ? [] : ["--no-auto-flush"]), "--no-daemon", "--no-color", "--json"];
		const result = spawnSync("br", [...args, "--db", database, ...options], {
			cwd, input, encoding: "utf8", timeout: BR_TIMEOUT_MS, maxBuffer: BR_MAX_BUFFER,
			env: { ...process.env, RUST_LOG: "warn" },
		});
		return { exit_code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null };
	} catch (error) {
		return { exit_code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
	}
}

function runBr(args: string[], database: string, cwd: string, input?: string): CapturedCommand {
	try {
		const result = spawnSync("br", [...args, "--db", database, ...ACTOR_ARGS, "--json"], {
			cwd, input, encoding: "utf8", timeout: BR_TIMEOUT_MS, maxBuffer: BR_MAX_BUFFER,
			env: { ...process.env, RUST_LOG: "warn" },
		});
		return { exit_code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null };
	} catch (error) {
		return { exit_code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
	}
}

function createdId(stdout: string): string | null {
	let value: unknown;
	try { value = JSON.parse(stdout); }
	catch { return null; }
	if (Array.isArray(value)) value = value[0];
	if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return null;
	return value.id;
}

function decodeNativeList(stdout: string): NativeList {
	let value: unknown;
	try { value = JSON.parse(stdout); }
	catch (error) { return { issues: [], error: "br list returned invalid JSON: " + (error instanceof Error ? error.message : String(error)) }; }
	let values: unknown[];
	if (Array.isArray(value)) values = value;
	else if (typeof value === "object" && value !== null && "issues" in value && Array.isArray(value.issues)) values = value.issues;
	else return { issues: [], error: "br list JSON did not contain an issues array" };
	const issues: NativeIssue[] = [];
	for (let index = 0; index < values.length; index++) {
		const row = values[index];
		if (typeof row !== "object" || row === null || Array.isArray(row) ||
			!("id" in row) || typeof row.id !== "string" ||
			!("title" in row) || typeof row.title !== "string" ||
			!("description" in row) || typeof row.description !== "string" ||
			!("acceptance_criteria" in row) || typeof row.acceptance_criteria !== "string" ||
			!("status" in row) || typeof row.status !== "string" ||
			!("priority" in row) || typeof row.priority !== "number" ||
			!("issue_type" in row) || typeof row.issue_type !== "string" ||
			!("labels" in row) || !Array.isArray(row.labels) ||
			!("dependency_count" in row) || typeof row.dependency_count !== "number")
			return { issues: [], error: "br list issue " + index + " has an invalid shape" };
		const priority = ALLOWED_PRIORITIES.find((candidate) => candidate === row.priority);
		if (priority === undefined) return { issues: [], error: "br list issue " + index + " has an invalid priority" };
		const labels: string[] = [];
		for (const label of row.labels) {
			if (typeof label !== "string") return { issues: [], error: "br list issue " + index + " has a non-string label" };
			labels.push(label);
		}
		const externalRef = "external_ref" in row && typeof row.external_ref === "string" ? row.external_ref : null;
		issues.push({ id: row.id, title: row.title, description: row.description, acceptance_criteria: row.acceptance_criteria,
			status: row.status, priority, issue_type: row.issue_type, labels, dependency_count: row.dependency_count, external_ref: externalRef });
	}
	return { issues, error: null };
}

function decodeNativeShow(stdout: string, requestedId: string): { issue: NativeIssueDetails | null; error: string | null } {
	let value: unknown;
	try { value = JSON.parse(stdout); }
	catch (error) { return { issue: null, error: "br show returned invalid JSON: " + (error instanceof Error ? error.message : String(error)) }; }
	if (!Array.isArray(value) || value.length !== 1) return { issue: null, error: "br show did not return exactly one issue" };
	const row = value[0];
	if (typeof row !== "object" || row === null || Array.isArray(row)) return { issue: null, error: "br show issue has an invalid shape" };
	const record = row as Record<string, unknown>;
	if (record.id !== requestedId) return { issue: null, error: "br show returned a different issue id" };
	if (typeof record.title !== "string" || typeof record.description !== "string" ||
		typeof record.acceptance_criteria !== "string" || typeof record.status !== "string" ||
		typeof record.priority !== "number" || !ALLOWED_PRIORITIES.includes(record.priority as Priority) ||
		typeof record.issue_type !== "string" || !Array.isArray(record.labels))
		return { issue: null, error: "br show issue has an invalid field shape" };
	if (typeof record.updated_at !== "string") return { issue: null, error: "br show issue has no updated_at value" };
	if ("parent" in record && record.parent !== null && typeof record.parent !== "string")
		return { issue: null, error: "br show issue has an invalid parent value" };
	if ("notes" in record && record.notes !== null && typeof record.notes !== "string")
		return { issue: null, error: "br show issue has invalid notes" };
	const labels: string[] = [];
	for (const label of record.labels) {
		if (typeof label !== "string") return { issue: null, error: "br show issue has a non-string label" };
		labels.push(label);
	}
	if ("external_ref" in record && record.external_ref !== null && typeof record.external_ref !== "string")
		return { issue: null, error: "br show issue has an invalid external_ref" };
	return {
		issue: {
			id: requestedId, title: record.title, description: record.description,
			acceptance_criteria: record.acceptance_criteria, status: record.status,
			priority: record.priority as Priority, issue_type: record.issue_type, labels,
			dependency_count: 0, external_ref: typeof record.external_ref === "string" ? record.external_ref : null,
			updated_at: record.updated_at, parent: typeof record.parent === "string" ? record.parent : null,
			notes: typeof record.notes === "string" ? record.notes : "",
		},
		error: null,
	};
}

function decodeNativeDependencies(stdout: string, issueId: string): { dependencies: NativeDependency[]; error: string | null } {
	let value: unknown;
	try { value = JSON.parse(stdout); }
	catch (error) { return { dependencies: [], error: "br dep list returned invalid JSON: " + (error instanceof Error ? error.message : String(error)) }; }
	if (!Array.isArray(value)) return { dependencies: [], error: "br dep list JSON was not an array" };
	const dependencies: NativeDependency[] = [];
	for (let index = 0; index < value.length; index++) {
		const row = value[index];
		if (typeof row !== "object" || row === null || Array.isArray(row) ||
			!("issue_id" in row) || typeof row.issue_id !== "string" ||
			!("depends_on_id" in row) || typeof row.depends_on_id !== "string" ||
			!("type" in row) || typeof row.type !== "string" ||
			!("status" in row) || typeof row.status !== "string")
			return { dependencies: [], error: "br dep list row " + index + " has an invalid shape" };
		if (row.issue_id !== issueId) return { dependencies: [], error: "br dep list returned an edge for a different issue" };
		dependencies.push({ issue_id: row.issue_id, depends_on_id: row.depends_on_id, type: row.type, status: row.status });
	}
	return { dependencies, error: null };
}

type NativeCount = { count: number | null; error: string | null };

function nativeCount(output: string, label: string, arrayKeys: string[], countKeys: string[]): NativeCount {
	let value: unknown;
	try { value = JSON.parse(output); }
	catch (error) { return { count: null, error: label + " returned invalid JSON: " + (error instanceof Error ? error.message : String(error)) }; }
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { count: null, error: label + " JSON was not an object" };
	const counts: number[] = [];
	for (const key of arrayKeys) {
		if (!(key in value)) continue;
		const entries = value[key];
		if (!Array.isArray(entries)) return { count: null, error: label + " JSON field `" + key + "` was not an array" };
		counts.push(entries.length);
	}
	for (const key of countKeys) {
		if (!(key in value)) continue;
		const count = value[key];
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
			return { count: null, error: label + " JSON field `" + key + "` was not a nonnegative integer" };
		counts.push(count);
	}
	if (!counts.length) return { count: null, error: label + " JSON did not expose a count" };
	const count = Math.max(...counts);
	if (counts.some((value) => value !== count)) return { count, error: label + " JSON count fields disagree" };
	return { count, error: null };
}

function metricValue(score: MissionScore): BeadScoreMetrics {
	const value = score.metrics.bead_self_contained?.value;
	if (typeof value !== "object" || value === null || !("median_chars" in value) || !("test_share" in value) || !("deps_per_bead" in value) || !("mission_beads" in value))
		return { median_chars: null, acceptance_share: null, deps_per_bead: null, mission_beads: null };
	return {
		median_chars: typeof value.median_chars === "number" ? value.median_chars : null,
		acceptance_share: typeof value.test_share === "number" ? value.test_share : null,
		deps_per_bead: typeof value.deps_per_bead === "number" ? value.deps_per_bead : null,
		mission_beads: typeof value.mission_beads === "number" ? value.mission_beads : null,
	};
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function reportText(data: ConvertReport): string {
	const lines = [
		"Planning conversion: " + data.overall,
		"Mission: " + data.mission,
		"Plan: " + data.plan_path,
		data.apply ? "Tracker root: " + (data.tracker_root ?? data.db_dir) : "Isolated database directory: " + data.db_dir,
		"Items parsed: " + data.items_parsed,
		"Plan beads created: " + data.beads_created + "; total beads including parent epic: " + data.total_beads_created,
		"Parent epic: " + (data.parent_epic_id ?? "not created"),
	];
	if (data.db_refusal) lines.push("Database refusal: " + data.db_refusal);
	lines.push("", "br lint findings (stdout verbatim; exit code " + data.br_lint_exit_code + "; count " + data.br_lint_finding_count + "; clean " + data.br_lint_clean + "):", data.br_lint_stdout || "(no stdout)");
	if (data.br_lint_parse_error) lines.push("br lint result parse error: " + data.br_lint_parse_error);
	if (data.br_lint_stderr) lines.push("br lint stderr (verbatim):", data.br_lint_stderr);
	if (data.br_lint_error) lines.push("br lint process error: " + data.br_lint_error);
	lines.push("", "Dependency cycles:");
	if (!data.dependency_cycles.length) lines.push("(none in plan source)");
	else for (const cycle of data.dependency_cycles) lines.push("- " + cycle.path.join(" -> "));
	lines.push("Native br cycle check (exit code " + data.br_cycle_exit_code + "; count " + data.br_cycle_count + "; clean " + data.br_cycle_clean + "; stdout verbatim):", data.br_cycle_stdout || "(no stdout)");
	if (data.br_cycle_parse_error) lines.push("br cycle result parse error: " + data.br_cycle_parse_error);
	if (data.br_cycle_stderr) lines.push("br cycle stderr (verbatim):", data.br_cycle_stderr);
	if (data.br_cycle_error) lines.push("br cycle process error: " + data.br_cycle_error);
	lines.push("", "WHAT-letter coverage:");
	if (!data.uncovered_what_letters.length) lines.push("(all WHAT letters have positive and planted-negative boxes)");
	else for (const entry of data.uncovered_what_letters) {
		const missing: string[] = [];
		if (entry.missing_positive) missing.push("missing positive");
		if (entry.missing_planted_negative) missing.push("missing planted-negative");
		lines.push("- " + entry.slug + " (line " + entry.line + ") WHAT " + entry.letter + ": " + missing.join(", "));
	}
	lines.push("", "Item findings:");
	if (!data.item_findings.length) lines.push("(none)");
	else for (const finding of data.item_findings) lines.push("- " + (finding.slug ?? "<plan>") + (finding.line ? " (line " + finding.line + ")" : "") + " " + finding.code + ": " + finding.message);
	lines.push("", "Unparseable blocks:");
	if (!data.unparseable_blocks.length) lines.push("(none)");
	else for (const block of data.unparseable_blocks) lines.push("- " + (block.slug ?? "<unknown>") + " (line " + block.line + "): " + block.reasons.join("; "));
	lines.push("", "Planning-score bead metrics:");
	const metrics = data.planning_score_bead_metrics;
	lines.push(
		"- median description chars: " + metrics.median_description_chars,
		"- planning-score median item chars: " + metrics.planning_score_median_chars,
		"- acceptance share: " + metrics.acceptance_share,
		"- deps per bead: " + metrics.deps_per_bead,
		"- mission beads: " + metrics.mission_beads,
	);
	lines.push("", "Created items:");
	if (!data.created_items.length) lines.push("(none)");
	else for (const item of data.created_items) lines.push("- " + item.slug + " => " + item.id + " (" + item.external_ref + ")");
	if (data.create_failures.length) {
		lines.push("", "Creation failures:");
		for (const failure of data.create_failures) lines.push("- " + failure.slug + ": " + (failure.error ?? failure.stderr));
	}
	lines.push("", "Dependency edges:");
	if (!data.dependency_edges.length) lines.push("(none)");
	else for (const edge of data.dependency_edges) lines.push("- " + edge.slug + " -> " + edge.target + " [" + edge.status + "]");
	if (data.dependency_failures.length) {
		lines.push("", "Dependency failures:");
		for (const failure of data.dependency_failures) lines.push("- " + failure.slug + " -> " + failure.target + ": " + failure.message);
	}
	if (data.br_list_error) lines.push("br list error: " + data.br_list_error);
	if (data.apply) {
		lines.push("", "Apply writes landed: " + (data.writes_landed?.length ?? 0));
		if (data.writes_landed?.length) for (const write of data.writes_landed) lines.push("- " + JSON.stringify(write));
		if (data.reused_items?.length) for (const item of data.reused_items) lines.push("- REUSED " + item.id + " (" + item.slug + ")");
		if (data.amended_targets?.length) for (const target of data.amended_targets)
			lines.push("- " + target.status + " " + target.id + " (" + target.slugs.join(", ") + ")");
		if (data.foreign_targets?.length) for (const target of data.foreign_targets)
			lines.push("- FOREIGN " + target.id + " + " + target.slug);
		if (data.merged_dependency_cycles?.length) for (const cycle of data.merged_dependency_cycles)
			lines.push("- merged tracker: " + cycle.join(" -> "));
		if (data.apply_preflight_error) lines.push("Apply preflight refused: " + data.apply_preflight_error);
		if (data.apply_failure) lines.push("Apply failed at " + data.apply_failure.step + ": " + data.apply_failure.message);
		if (data.apply_failure?.reconciliation_error) lines.push("Apply write reconciliation: " + data.apply_failure.reconciliation_error);
	}
	return lines.join("\n");
}

function finish(data: ConvertReport, code: BrExitCode): PresentationResult {
	data.text = reportText(data);
	const command = data.apply
		? "omp-kit planning convert --plan PATH --mission M --apply --tracker-root DIR"
		: "omp-kit planning convert --plan PATH --mission M --dry-run --db DIR";
	return { code, data, verification: code === 0 ? "PERFORMED" : "UNVERIFIED", commands: [command] };
}

function baseReport(planPath: string, mission: string, dbDir: string): ConvertReport {
	return {
		kind: "planning-convert", overall: "FINDINGS", mission, plan_path: planPath, db_dir: dbDir,
		candidate_blocks: 0, items_parsed: 0, beads_created: 0, total_beads_created: 0, parent_epic_id: null,
		created_items: [], create_failures: [], dependency_edges: [], dependency_failures: [], dependency_cycles: [],
		uncovered_what_letters: [], unparseable_blocks: [], item_findings: [],
		br_lint_exit_code: null, br_lint_finding_count: null, br_lint_clean: null, br_lint_parse_error: null,
		br_lint_stdout: "", br_lint_stderr: "", br_lint_error: null,
		br_cycle_exit_code: null, br_cycle_count: null, br_cycle_clean: null, br_cycle_parse_error: null,
		br_cycle_stdout: "", br_cycle_stderr: "", br_cycle_error: null,
		br_list_exit_code: null, br_list_error: null,
		planning_score_bead_metrics: { median_description_chars: null, planning_score_median_chars: null, acceptance_share: null, deps_per_bead: null, mission_beads: null },
	};
}


function descriptionDependencies(item: PlanItem, candidateSlugs: Set<string>): string[] {
	return item.dependsOn.filter((slug) => !candidateSlugs.has(slug));
}

function createArgs(item: PlanItem, parentId: string, planPath: string, candidateSlugs: Set<string>): { args: string[]; input: string } {
	const textOnlyDependencies = descriptionDependencies(item, candidateSlugs);
	return {
		args: ["create", "--title", item.title, "--type", item.type, "--priority", item.priority,
			"--labels", item.labels.join(","), "--parent", parentId, "--external-ref", "core8:" + item.slug,
			"--description-file", "-", "--acceptance-criteria", item.acceptance],
		input: descriptionFor(item, planPath, textOnlyDependencies),
	};
}

type ApplyTarget = { kind: "existing" | "new" | "foreign"; id: string | null; reused: boolean; details?: NativeIssueDetails };
type ApplyDependency = { item: PlanItem; targetSlug: string; foreign: boolean };

function mergedGraphCycles(adjacency: Map<string, string[]>): string[][] {
	const nodes = new Set<string>(adjacency.keys());
	for (const targets of adjacency.values()) for (const target of targets) nodes.add(target);
	const state = new Map<string, number>();
	const stack: string[] = [];
	const cycles = new Map<string, string[]>();
	const visit = (node: string): void => {
		state.set(node, 1);
		stack.push(node);
		for (const target of adjacency.get(node) ?? []) {
			const targetState = state.get(target) ?? 0;
			if (targetState === 0) visit(target);
			else if (targetState === 1) {
				const cycle = stack.slice(stack.lastIndexOf(target)).concat(target);
				cycles.set(cycleKey(cycle), cycle);
			}
		}
		stack.pop();
		state.set(node, 2);
	};
	for (const node of nodes) if ((state.get(node) ?? 0) === 0) visit(node);
	return [...cycles.values()];
}

function runPlanningConvertApply(
	data: ConvertReport,
	items: PlanItem[],
	candidateSlugs: Set<string>,
	cwd: string,
	trackerRoot: string,
): PresentationResult {
	data.writes_landed = [];
	data.created_items = [];
	data.reused_items = [];
	data.amended_targets = [];
	data.foreign_targets = [];
	data.merged_dependency_cycles = [];
	const refuse = (message: string): PresentationResult => {
		data.overall = "REFUSED";
		data.apply_preflight_error = message;
		return finish(data, 1);
	};
	if (data.unparseable_blocks.length || data.item_findings.length || data.uncovered_what_letters.length || data.dependency_cycles.length)
		return refuse("the plan has parse, validation, coverage, or dependency-cycle findings");
	if (!items.length) return refuse("the plan contains no applicable items");

	const tracker = safeTrackerRoot(trackerRoot, cwd);
	if ("error" in tracker) return refuse(tracker.error);
	data.tracker_root = tracker.trackerRoot;
	data.db_dir = tracker.trackerRoot;
	data.database_path = tracker.database;

	const listResult = runApplyBr(["list", "--all", "--limit", "0"], tracker.database, tracker.commandCwd, false);
	data.br_list_exit_code = listResult.exit_code;
	if (listResult.exit_code !== 0 || listResult.error)
		return refuse(listResult.error ?? (listResult.stderr.trim() || "br list failed"));
	const decodedList = decodeNativeList(listResult.stdout);
	if (decodedList.error) {
		data.br_list_error = decodedList.error;
		return refuse(decodedList.error);
	}
	const issuesById = new Map(decodedList.issues.map((issue) => [issue.id, issue]));
	const detailsById = new Map<string, NativeIssueDetails>();
	let detailsError: string | null = null;
	const loadDetails = (id: string): NativeIssueDetails | null => {
		const cached = detailsById.get(id);
		if (cached) return cached;
		const result = runApplyBr(["show", id], tracker.database, tracker.commandCwd, false);
		if (result.exit_code !== 0 || result.error) {
			detailsError = result.error ?? (result.stderr.trim() || "br show exited with status " + result.exit_code);
			return null;
		}
		const decoded = decodeNativeShow(result.stdout, id);
		if (decoded.error || !decoded.issue) {
			detailsError = decoded.error ?? "br show did not return issue details";
			return null;
		}
		detailsById.set(id, decoded.issue);
		return decoded.issue;
	};

	const targetBySlug = new Map<string, ApplyTarget>();
	const foreignTargets: ForeignTarget[] = [];
	for (const item of items) {
		if (item.existing !== "(new)") {
			const existingId = item.existing.endsWith(" (amend)") ? item.existing.slice(0, -8) : item.existing;
			const issue = issuesById.get(existingId);
			if (!issue) {
				targetBySlug.set(item.slug, { kind: "foreign", id: existingId, reused: false });
				foreignTargets.push({ status: "FOREIGN", id: existingId, slug: item.slug });
				data.foreign_targets = foreignTargets;
				continue;
			}
			const details = loadDetails(issue.id);
			if (!details) return refuse("cannot preflight target " + issue.id + ": " + (detailsError ?? "br show failed"));
			if (details.status === "closed" || details.status === "tombstone")
				return refuse("target " + issue.id + " is terminal and cannot be amended");
			const contribution = "core8:" + item.slug;
			const noteSearch = runApplyBr(["list", "--all", "--limit", "0", "--notes-contains", contribution], tracker.database, tracker.commandCwd, false);
			if (noteSearch.exit_code !== 0 || noteSearch.error)
				return refuse(noteSearch.error ?? (noteSearch.stderr.trim() || "cannot search contribution notes for " + contribution));
			const noteList = decodeNativeList(noteSearch.stdout);
			if (noteList.error) return refuse(noteList.error);
			for (const candidate of noteList.issues) {
				const candidateDetails = loadDetails(candidate.id);
				if (!candidateDetails) return refuse("cannot preflight contribution " + contribution + ": " + (detailsError ?? "br show failed"));
				if (candidate.id !== issue.id && splitLines(candidateDetails.notes).some((line) => line.trim() === contribution))
					return refuse("contribution " + contribution + " already belongs to tracker issue " + candidate.id);
			}
			targetBySlug.set(item.slug, { kind: "existing", id: issue.id, reused: false, details });
			continue;
		}

		const token = "core8:" + item.slug;
		const byExternalRef = decodedList.issues.filter((issue) => issue.external_ref === token);
		const noteSearch = runApplyBr(["list", "--all", "--limit", "0", "--notes-contains", token], tracker.database, tracker.commandCwd, false);
		if (noteSearch.exit_code !== 0 || noteSearch.error)
			return refuse(noteSearch.error ?? (noteSearch.stderr.trim() || "cannot search contribution notes for " + token));
		const noteList = decodeNativeList(noteSearch.stdout);
		if (noteList.error) return refuse(noteList.error);
		const byNote: NativeIssue[] = [];
		for (const candidate of noteList.issues) {
			const details = loadDetails(candidate.id);
			if (!details) return refuse("cannot preflight note match for " + token + ": " + (detailsError ?? "br show failed"));
			if (splitLines(details.notes).some((line) => line.trim() === token)) byNote.push(candidate);
		}
		const matches = new Map<string, NativeIssue>();
		for (const issue of [...byExternalRef, ...byNote]) matches.set(issue.id, issue);
		if (matches.size > 1) return refuse("multiple tracker issues match " + token + " by external_ref or contribution note");
		const matched = matches.values().next().value as NativeIssue | undefined;
		if (!matched) {
			targetBySlug.set(item.slug, { kind: "new", id: null, reused: false });
			continue;
		}
		if (matched.issue_type !== item.type) return refuse("reused target " + matched.id + " has type " + matched.issue_type + ", expected " + item.type);
		const details = loadDetails(matched.id);
		if (!details) return refuse("cannot preflight reused target " + matched.id + ": " + (detailsError ?? "br show failed"));
		if (details.status === "closed" || details.status === "tombstone")
			return refuse("reused target " + matched.id + " is terminal");
		targetBySlug.set(item.slug, { kind: "existing", id: matched.id, reused: true, details });
		data.reused_items.push({
			slug: item.slug, title: item.title, id: matched.id, line: item.line,
			external_ref: matched.external_ref ?? token,
		});
	}
	data.foreign_targets = foreignTargets;
	const needsCore8Epic = items.some((item) => item.existing === "(new)");
	const newItems = items.filter((item) => targetBySlug.get(item.slug)?.kind === "new");

	const epicMatches = needsCore8Epic ? decodedList.issues.filter((issue) => issue.external_ref === "core8") : [];
	if (epicMatches.length > 1) return refuse("multiple tracker issues use external_ref core8");
	if (epicMatches.length === 1 && epicMatches[0]!.issue_type !== "epic")
		return refuse("external_ref core8 is already used by a non-epic issue");
	let parentId = epicMatches[0]?.id ?? null;
	if (parentId) {
		const parentDetails = loadDetails(parentId);
		if (!parentDetails) return refuse("cannot preflight core8 epic " + parentId + ": " + (detailsError ?? "br show failed"));
		if (parentDetails.status === "closed" || parentDetails.status === "tombstone")
			return refuse("core8 epic " + parentId + " is terminal");
	}
	for (const item of items) {
		const target = targetBySlug.get(item.slug)!;
		if (target.reused && target.details && (!parentId || target.details.parent !== parentId))
			return refuse("reused target " + target.id + " is not beneath the tracker core8 epic");
	}
	if (parentId) data.parent_epic_id = parentId;

	const graphNode = (slug: string): string | null => {
		const target = targetBySlug.get(slug);
		if (!target || target.kind === "foreign") return null;
		return target.kind === "existing" ? target.id : "__core8_new__" + slug;
	};
	const graphAdjacency = new Map<string, string[]>();
	const existingBlockEdges = new Set<string>();
	const graphQueue = [...new Set(items.map((item) => {
		const target = targetBySlug.get(item.slug);
		return target?.kind === "existing" ? target.id : null;
	}).filter((id): id is string => id !== null))];
	for (let index = 0; index < graphQueue.length; index++) {
		const id = graphQueue[index]!;
		if (graphAdjacency.has(id)) continue;
		const result = runApplyBr(["dep", "list", id], tracker.database, tracker.commandCwd, false);
		if (result.exit_code !== 0 || result.error)
			return refuse(result.error ?? (result.stderr.trim() || "cannot preflight dependencies for " + id));
		const decoded = decodeNativeDependencies(result.stdout, id);
		if (decoded.error) return refuse(decoded.error);
		const dependencies = decoded.dependencies.filter((edge) => edge.type === "blocks");
		graphAdjacency.set(id, dependencies.map((edge) => edge.depends_on_id));
		for (const edge of dependencies) {
			existingBlockEdges.add(edge.issue_id + "\u0000" + edge.depends_on_id);
			if (issuesById.has(edge.depends_on_id) && !graphAdjacency.has(edge.depends_on_id)) graphQueue.push(edge.depends_on_id);
		}
	}
	const plannedDependencies: ApplyDependency[] = [];
	for (const item of items) {
		for (const targetSlug of item.dependsOn) {
			if (!candidateSlugs.has(targetSlug)) continue;
			const source = targetBySlug.get(item.slug);
			const target = targetBySlug.get(targetSlug);
			if (!source || !target) return refuse("dependency target " + targetSlug + " has no preflight resolution");
			const foreign = source.kind === "foreign" || target.kind === "foreign";
			plannedDependencies.push({ item, targetSlug, foreign });
			if (foreign) continue;
			const sourceNode = graphNode(item.slug)!;
			const targetNode = graphNode(targetSlug)!;
			const edges = graphAdjacency.get(sourceNode) ?? [];
			if (!edges.includes(targetNode)) edges.push(targetNode);
			graphAdjacency.set(sourceNode, edges);
			if (!graphAdjacency.has(targetNode)) graphAdjacency.set(targetNode, []);
		}
	}
	const placeholders = new Map(items.filter((item) => targetBySlug.get(item.slug)?.kind === "new")
		.map((item) => ["__core8_new__" + item.slug, "new:" + item.slug]));
	const mergedCycles = mergedGraphCycles(graphAdjacency).map((cycle) => cycle.map((id) => placeholders.get(id) ?? id));
	if (mergedCycles.length) {
		data.merged_dependency_cycles = mergedCycles;
		return refuse("planned native dependency edges would create a cycle in the merged tracker graph");
	}

	const writeFailure = (
		step: string,
		result: CapturedCommand,
		fallback: string,
		reconcile?: () => ApplyReconciliation,
	): PresentationResult => {
		data.overall = "FINDINGS";
		const failure: ApplyFailure = {
			step, message: result.error ?? (result.stderr.trim() || result.stdout.trim() || fallback),
			exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr,
		};
		if (!reconcile) failure.reconciliation_error = "no operation-specific readback is available";
		else {
			const readback = reconcile();
			if (readback.error) failure.reconciliation_error = readback.error;
			else for (const write of readback.writes) {
				data.writes_landed!.push(write);
				if (write.kind === "EPIC_CREATED") {
					parentCreated = true;
					parentId = write.id;
					data.parent_epic_id = write.id;
				} else if (write.kind === "ITEM_CREATED" && write.slug) {
					const item = items.find((candidate) => candidate.slug === write.slug);
					if (item && !data.created_items.some((created) => created.id === write.id)) {
						targetBySlug.set(item.slug, { kind: "existing", id: write.id, reused: false });
						data.created_items.push({ slug: item.slug, title: item.title, id: write.id, line: item.line, external_ref: write.external_ref ?? "core8:" + item.slug });
					}
				} else if (write.kind === "AMENDED") {
					data.amended_targets!.push({
						id: write.id, slugs: write.slugs ?? [], acceptance_added: write.acceptance_added ?? [],
						contributions_added: write.contributions_added ?? [], status: "AMENDED",
					});
				} else if (write.kind === "DEPENDENCY_ADDED" && write.slug && write.target) {
					const target = targetBySlug.get(write.target);
					if (target?.id) data.dependency_edges.push({
						slug: write.slug, target: write.target, status: "ADDED", issue_id: write.id, depends_on_id: target.id,
					});
				}
			}
		}
		data.apply_failure = failure;
		data.beads_created = data.created_items.length;
		data.total_beads_created = data.created_items.length + (parentCreated ? 1 : 0);
		return finish(data, 1);
	};
	const reconcileCreated = (externalRef: string, item?: PlanItem): (() => ApplyReconciliation) => () => {
		const result = runApplyBr(["list", "--all", "--limit", "0"], tracker.database, tracker.commandCwd, false);
		if (result.exit_code !== 0 || result.error)
			return { writes: [], error: result.error ?? (result.stderr.trim() || "br list reconciliation failed") };
		const decoded = decodeNativeList(result.stdout);
		if (decoded.error) return { writes: [], error: decoded.error };
		const matches = decoded.issues.filter((issue) => issue.external_ref === externalRef);
		if (matches.length > 1) return { writes: [], error: "multiple issues now match external_ref " + externalRef };
		const issue = matches[0];
		if (!issue) return { writes: [], error: null };
		return {
			writes: [item
				? { kind: "ITEM_CREATED", id: issue.id, slug: item.slug, external_ref: externalRef }
				: { kind: "EPIC_CREATED", id: issue.id, external_ref: externalRef }],
			error: null,
		};
	};

	let parentCreated = false;
	if (newItems.length && !parentId) {
		const result = runApplyBr(["create", "--title", "core8 applied plan", "--type", "epic", "--priority", "0",
			"--labels", "plan:core8,mission:core8", "--external-ref", "core8", "--description-file", "-",
			"--acceptance-criteria", "- [ ] Every locally applied plan item is parented under this epic."],
		tracker.database, tracker.commandCwd, true,
		"## Success Criteria\nAll locally created plan items are children of this core8 epic; foreign targets remain untouched.");
		const id = createdId(result.stdout);
		if (result.exit_code !== 0 || result.error || !id)
			return writeFailure("create-core8-epic", result, "br create did not return a parent epic id", reconcileCreated("core8"));
		parentId = id;
		parentCreated = true;
		data.parent_epic_id = id;
		data.writes_landed.push({ kind: "EPIC_CREATED", id, external_ref: "core8" });
	}
	for (const item of newItems) {
		if (!parentId) return refuse("new plan items have no core8 parent epic");
		const request = createArgs(item, parentId, data.plan_path, candidateSlugs);
		const result = runApplyBr(request.args, tracker.database, tracker.commandCwd, true, request.input);
		const id = createdId(result.stdout);
		if (result.exit_code !== 0 || result.error || !id)
			return writeFailure("create-" + item.slug, result, "br create did not return an issue id", reconcileCreated("core8:" + item.slug, item));
		targetBySlug.set(item.slug, { kind: "existing", id, reused: false });
		const created = { slug: item.slug, title: item.title, id, line: item.line, external_ref: "core8:" + item.slug };
		data.created_items.push(created);
		data.writes_landed.push({ kind: "ITEM_CREATED", id, slug: item.slug, external_ref: created.external_ref });
	}

	const amendmentGroups = new Map<string, { details: NativeIssueDetails; items: PlanItem[] }>();
	for (const item of items) {
		if (item.existing === "(new)") continue;
		const target = targetBySlug.get(item.slug);
		if (!target || target.kind !== "existing" || !target.id || !target.details) continue;
		const group = amendmentGroups.get(target.id) ?? { details: target.details, items: [] };
		group.items.push(item);
		amendmentGroups.set(target.id, group);
	}
	for (const [id, group] of amendmentGroups) {
		const noteLines = splitLines(group.details.notes).map((line) => line.trim());
		const acceptanceAdded: string[] = [];
		const contributionsAdded: string[] = [];
		for (const item of group.items) {
			const token = "core8:" + item.slug;
			if (noteLines.includes(token)) continue;
			for (const box of acceptanceBoxes(item.acceptance))
				acceptanceAdded.push("[" + box.letter + "] " + box.text);
			contributionsAdded.push(token);
		}
		const amended: AmendedTarget = {
			id, slugs: group.items.map((item) => item.slug), acceptance_added: acceptanceAdded,
			contributions_added: contributionsAdded, status: acceptanceAdded.length || contributionsAdded.length ? "AMENDED" : "UNCHANGED",
		};
		if (!acceptanceAdded.length && !contributionsAdded.length) {
			data.amended_targets.push(amended);
			continue;
		}
		const args = ["update", id, "--if-unchanged", group.details.updated_at];
		for (const criterion of acceptanceAdded) args.push("--add-acceptance", criterion);
		for (const token of contributionsAdded) args.push("--append-notes", token);
		const result = runApplyBr(args, tracker.database, tracker.commandCwd, true);
		if (result.exit_code !== 0 || result.error)
			return writeFailure("amend-" + id, result, "br update failed", () => {
				const check = runApplyBr(["show", id], tracker.database, tracker.commandCwd, false);
				if (check.exit_code !== 0 || check.error)
					return { writes: [], error: check.error ?? (check.stderr.trim() || "br show reconciliation failed") };
				const after = decodeNativeShow(check.stdout, id);
				if (after.error || !after.issue) return { writes: [], error: after.error ?? "br show reconciliation returned no issue" };
				const beforeTexts = acceptanceBoxes(group.details.acceptance_criteria).map((box) => box.text);
				const afterTexts = acceptanceBoxes(after.issue.acceptance_criteria).map((box) => box.text);
				const counts = new Map<string, number>();
				for (const text of afterTexts) counts.set(text, (counts.get(text) ?? 0) + 1);
				for (const text of beforeTexts) counts.set(text, (counts.get(text) ?? 0) - 1);
				const observedAcceptance: string[] = [];
				for (const text of acceptanceAdded) {
					const count = counts.get(text) ?? 0;
					if (count > 0) {
						observedAcceptance.push(text);
						counts.set(text, count - 1);
					}
				}
				const beforeNotes = splitLines(group.details.notes).map((line) => line.trim());
				const afterNotes = splitLines(after.issue.notes).map((line) => line.trim());
				const observedContributions = contributionsAdded.filter((token) => !beforeNotes.includes(token) && afterNotes.includes(token));
				if (!observedAcceptance.length && !observedContributions.length) return { writes: [], error: null };
				return {
					writes: [{
						kind: "AMENDED", id, slugs: amended.slugs,
						acceptance_added: observedAcceptance, contributions_added: observedContributions,
					}],
					error: null,
				};
			});
		data.amended_targets.push(amended);
		data.writes_landed.push({ kind: "AMENDED", id, slugs: amended.slugs, acceptance_added: acceptanceAdded, contributions_added: contributionsAdded });
	}

	for (const dependency of plannedDependencies) {
		const source = targetBySlug.get(dependency.item.slug)!;
		const target = targetBySlug.get(dependency.targetSlug)!;
		if (dependency.foreign) {
			data.dependency_edges.push({
				slug: dependency.item.slug, target: dependency.targetSlug, status: "SKIPPED_FOREIGN",
				issue_id: source.id ?? "", depends_on_id: target.id ?? "",
			});
			continue;
		}
		const sourceId = source.id!;
		const targetId = target.id!;
		const edgeKey = sourceId + "\u0000" + targetId;
		if (existingBlockEdges.has(edgeKey)) {
			data.dependency_edges.push({ slug: dependency.item.slug, target: dependency.targetSlug, status: "ALREADY_PRESENT", issue_id: sourceId, depends_on_id: targetId });
			continue;
		}
		const result = runApplyBr(["dep", "add", sourceId, targetId], tracker.database, tracker.commandCwd, true);
		if (result.exit_code !== 0 || result.error)
			return writeFailure("dependency-" + dependency.item.slug + "-" + dependency.targetSlug, result, "br dep add failed", () => {
				const check = runApplyBr(["dep", "list", sourceId], tracker.database, tracker.commandCwd, false);
				if (check.exit_code !== 0 || check.error)
					return { writes: [], error: check.error ?? (check.stderr.trim() || "br dep list reconciliation failed") };
				const decoded = decodeNativeDependencies(check.stdout, sourceId);
				if (decoded.error) return { writes: [], error: decoded.error };
				const landed = decoded.dependencies.some((edge) => edge.type === "blocks" && edge.depends_on_id === targetId);
				return {
					writes: landed ? [{ kind: "DEPENDENCY_ADDED", id: sourceId, slug: dependency.item.slug, target: dependency.targetSlug }] : [],
					error: null,
				};
			});
		existingBlockEdges.add(edgeKey);
		data.dependency_edges.push({ slug: dependency.item.slug, target: dependency.targetSlug, status: "ADDED", issue_id: sourceId, depends_on_id: targetId });
		data.writes_landed.push({ kind: "DEPENDENCY_ADDED", id: sourceId, slug: dependency.item.slug, target: dependency.targetSlug });
	}

	const finalList = runApplyBr(["list", "--all", "--limit", "0"], tracker.database, tracker.commandCwd, false);
	data.br_list_exit_code = finalList.exit_code;
	if (finalList.exit_code !== 0 || finalList.error)
		return writeFailure("final-readback", finalList, "br list readback failed");
	const finalDecoded = decodeNativeList(finalList.stdout);
	if (finalDecoded.error) {
		data.br_list_error = finalDecoded.error;
		data.overall = "FINDINGS";
		data.apply_failure = {
			step: "final-readback", message: finalDecoded.error, exit_code: finalList.exit_code,
			stdout: finalList.stdout, stderr: finalList.stderr,
		};
		data.beads_created = data.created_items.length;
		data.total_beads_created = data.created_items.length + (parentCreated ? 1 : 0);
		return finish(data, 1);
	}
	const scoreBeads: PlanningBead[] = finalDecoded.issues.map((issue) => ({
		...issue, dependencies: Array.from({ length: issue.dependency_count }, () => ({})),
	}));
	const score = scorePlanningSnapshot({
		repoPath: cwd, trackerPath: tracker.trackerRoot, mission: data.mission, planPath: null,
		planExists: null, repoCommits: null, trackerCommits: null, beads: scoreBeads, nowEpochSeconds: null, ci: {},
	}, { targets: {}, weights: {} });
	const scoreMetrics = metricValue(score);
	const missionRows = finalDecoded.issues.filter((issue) => issue.issue_type !== "epic" && issue.labels.includes("mission:" + data.mission));
	data.planning_score_bead_metrics = {
		median_description_chars: median(missionRows.map((issue) => issue.description.length)),
		planning_score_median_chars: scoreMetrics.median_chars, acceptance_share: scoreMetrics.acceptance_share,
		deps_per_bead: scoreMetrics.deps_per_bead, mission_beads: scoreMetrics.mission_beads,
	};
	data.beads_created = data.created_items.length;
	data.total_beads_created = data.created_items.length + (parentCreated ? 1 : 0);
	data.overall = "CLEAN";
	return finish(data, 0);
}

export type PlanningConvertOptions = { planPath: string; mission: string; cwd?: string } & (
	| { apply: true; trackerRoot: string; dbDir?: never }
	| { apply?: false; dbDir: string; trackerRoot?: never }
);
export function runPlanningConvert(options: PlanningConvertOptions): PresentationResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const planPath = resolve(cwd, options.planPath);
	const mission = options.mission.trim();
	const requestedDb = options.apply ? options.trackerRoot : options.dbDir;
	const initial = baseReport(planPath, mission, requestedDb);
	initial.apply = options.apply === true;
	if (options.apply) initial.tracker_root = options.trackerRoot;
	if (!mission || !isSlug(mission)) {
		initial.overall = "REFUSED";
		initial.item_findings = [{ code: "INVALID_MISSION", message: "--mission must be a lowercase slug" }];
		return finish(initial, 1);
	}
	let source: string;
	try {
		const stat = lstatSync(planPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLAN_BYTES) throw new Error("--plan must be a regular file no larger than 8 MiB");
		source = readFileSync(planPath, "utf8");
	} catch (error) {
		initial.overall = "REFUSED";
		initial.item_findings = [{ code: "PLAN_READ_FAILED", message: error instanceof Error ? error.message : String(error) }];
		return finish(initial, 1);
	}
	const parsed = parsePlan(source);
	const items = parsed.items;
	const findings = itemFindings(items, mission);
	const coverage = coverageFindings(items);
	const graph = planCycles(items);
	Object.assign(initial, {
		candidate_blocks: parsed.candidateBlocks,
		items_parsed: items.length,
		unparseable_blocks: parsed.unparseable,
		item_findings: findings,
		uncovered_what_letters: coverage,
		dependency_cycles: graph.cycles,
	});
	if (options.apply) return runPlanningConvertApply(initial, items, parsed.candidateSlugs, cwd, options.trackerRoot);
	const database = safeDbDirectory(requestedDb, cwd);
	if ("error" in database) {
		initial.overall = "REFUSED";
		initial.db_refusal = database.error;
		return finish(initial, 1);
	}
	initial.db_dir = database.directory;
	initial.database_path = database.database;
	const itemsToCreate = items;
	let parentId: string | null = null;
	const created: CreatedItem[] = [];
	const createFailures: CreateFailure[] = [];
	const initialization = itemsToCreate.length
		? runBr(["init", "--prefix", "core8"], database.database, database.directory)
		: null;
	const initializationError = initialization && (initialization.exit_code !== 0 || initialization.error !== null)
		? initialization.error ?? (initialization.stderr.trim() || "br init exited with status " + initialization.exit_code)
		: null;
	if (initialization && initializationError !== null)
		createFailures.push({ slug: "core8-database-init", line: null, exit_code: initialization.exit_code,
			stdout: initialization.stdout, stderr: initialization.stderr, error: initializationError });
	if (itemsToCreate.length && initializationError === null) {
		const parentDescription = "## Success Criteria\nAll parsed plan items are children of this isolated core8 dry-run epic; no real tracker is modified.";
		const parent = runBr(["create", "--title", "core8 isolated plan conversion", "--type", "epic", "--priority", "0",
			"--labels", "plan:core8,mission:core8", "--description-file", "-", "--acceptance-criteria", "- [ ] Every parsed plan item is parented under this isolated epic."],
		database.database, database.directory, parentDescription);
		const parentIssueId = createdId(parent.stdout);
		if (parent.exit_code === 0 && parentIssueId) parentId = parentIssueId;
		else createFailures.push({ slug: "core8-parent-epic", line: null, exit_code: parent.exit_code, stdout: parent.stdout, stderr: parent.stderr, error: parent.error ?? (parent.exit_code === 0 ? "br create did not return a parent issue id" : "br create exited with status " + parent.exit_code) });
	}
	if (parentId) {
		for (const item of itemsToCreate) {
			const request = createArgs(item, parentId, planPath, parsed.candidateSlugs);
			const result = runBr(request.args, database.database, database.directory, request.input);
			const id = createdId(result.stdout);
			if (result.exit_code === 0 && id) created.push({ slug: item.slug, title: item.title, id, line: item.line, external_ref: "core8:" + item.slug });
			else createFailures.push({ slug: item.slug, line: item.line, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, error: result.error ?? (result.exit_code === 0 ? "br create did not return an issue id" : "br create exited with status " + result.exit_code) });
		}
	}
	const createdBySlug = new Map(created.map((item) => [item.slug, item]));
	const itemBySlug = new Map(items.map((item) => [item.slug, item]));
	const dependencyEdges: DependencyEdge[] = [];
	const dependencyFailures: DependencyFailure[] = [];
	if (parentId) for (const item of items) {
		const sourceIssue = createdBySlug.get(item.slug);
		if (!sourceIssue) continue;
		for (const targetSlug of item.dependsOn) {
			if (!parsed.candidateSlugs.has(targetSlug)) continue;
			const targetItem = itemBySlug.get(targetSlug);
			const targetIssue = createdBySlug.get(targetSlug);
			if (!targetItem || !targetIssue) {
				dependencyFailures.push({ slug: item.slug, target: targetSlug, message: "plan dependency target was not created" });
				continue;
			}
			const edgeKey = item.slug + "\u0000" + targetSlug;
			if (graph.cycleEdges.has(edgeKey)) {
				dependencyEdges.push({ slug: item.slug, target: targetSlug, status: "SKIPPED_CYCLE", issue_id: sourceIssue.id, depends_on_id: targetIssue.id });
				continue;
			}
			const result = runBr(["dep", "add", sourceIssue.id, targetIssue.id], database.database, database.directory);
			if (result.exit_code === 0) dependencyEdges.push({ slug: item.slug, target: targetSlug, status: "ADDED", issue_id: sourceIssue.id, depends_on_id: targetIssue.id });
			else dependencyFailures.push({ slug: item.slug, target: targetSlug, message: result.error ?? result.stderr ?? result.stdout ?? "br dep add failed", exit_code: result.exit_code });
		}
	}
	const lint = created.length || parentId ? runBr(["lint"], database.database, database.directory) : null;
	const cycleCheck = created.length || parentId ? runBr(["dep", "cycles"], database.database, database.directory) : null;
	const listed = created.length || parentId ? runBr(["list"], database.database, database.directory) : null;
	const lintCounts = lint ? nativeCount(lint.stdout, "br lint", ["results"], ["issues", "total"]) : { count: null, error: "not run because no bead was created" };
	const cycleCounts = cycleCheck ? nativeCount(cycleCheck.stdout, "br dep cycles", ["cycles"], ["count"]) : { count: null, error: "not run because no bead was created" };
	const lintClean = lint ? lint.exit_code === 0 && !lint.error && lintCounts.error === null && lintCounts.count === 0 : null;
	const cycleClean = cycleCheck ? cycleCheck.exit_code === 0 && !cycleCheck.error && cycleCounts.error === null && cycleCounts.count === 0 : null;
	const nativeList = listed ? decodeNativeList(listed.stdout) : { issues: [], error: "not run because no bead was created" };
	const scoreBeads: PlanningBead[] = nativeList.issues.map((issue) => ({
		...issue,
		dependencies: Array.from({ length: issue.dependency_count }, () => ({})),
	}));
	const scoreSnapshot: PlanningScoreSnapshot = {
		repoPath: cwd, trackerPath: database.directory, mission, planPath: null, planExists: null,
		repoCommits: null, trackerCommits: null, beads: scoreBeads, nowEpochSeconds: null, ci: {},
	};
	const score = scorePlanningSnapshot(scoreSnapshot, { targets: {}, weights: {} });
	const scoreMetrics = metricValue(score);
	const missionRows = nativeList.issues.filter((issue) => issue.issue_type !== "epic" && issue.labels.includes("mission:" + mission));
	const medianDescriptionChars = median(missionRows.map((issue) => issue.description.length));
	const metrics = {
		median_description_chars: medianDescriptionChars,
		planning_score_median_chars: scoreMetrics.median_chars,
		acceptance_share: scoreMetrics.acceptance_share,
		deps_per_bead: scoreMetrics.deps_per_bead,
		mission_beads: scoreMetrics.mission_beads,
	};
	Object.assign(initial, {
		parent_epic_id: parentId,
		created_items: created,
		create_failures: createFailures,
		beads_created: created.length,
		total_beads_created: created.length + (parentId ? 1 : 0),
		dependency_edges: dependencyEdges,
		dependency_failures: dependencyFailures,
		br_lint_exit_code: lint?.exit_code ?? null,
		br_lint_finding_count: lintCounts.count,
		br_lint_clean: lintClean,
		br_lint_parse_error: lintCounts.error,
		br_lint_stdout: lint?.stdout ?? "",
		br_lint_stderr: lint?.stderr ?? "",
		br_lint_error: lint?.error ?? null,
		br_cycle_exit_code: cycleCheck?.exit_code ?? null,
		br_cycle_count: cycleCounts.count,
		br_cycle_clean: cycleClean,
		br_cycle_parse_error: cycleCounts.error,
		br_cycle_stdout: cycleCheck?.stdout ?? "",
		br_cycle_stderr: cycleCheck?.stderr ?? "",
		br_cycle_error: cycleCheck?.error ?? null,
		br_list_exit_code: listed?.exit_code ?? null,
		br_list_error: listed?.error ?? nativeList.error,
		planning_score_bead_metrics: metrics,
	});
	const clean = parsed.unparseable.length === 0 && findings.length === 0 && coverage.length === 0 && graph.cycles.length === 0 &&
		createFailures.length === 0 && created.length === items.length && dependencyFailures.length === 0 &&
		lintClean === true && cycleClean === true && listed?.exit_code === 0 && !listed.error && nativeList.error === null;
	initial.overall = clean ? "CLEAN" : "FINDINGS";
	return finish(initial, clean ? 0 : 1);
}
