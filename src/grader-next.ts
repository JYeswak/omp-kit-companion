import type { DataSchema } from "./commands.ts";

export type QueueObservation<T> =
	| { status: "KNOWN"; source: string; value: T }
	| { status: "UNKNOWN" | "FAILED"; source: string; reason: string };

export type GraderCandidate = {
	id: string;
	title: string;
	author: string | null;
	assignee: string | null;
	priority: number;
	cost?: number;
	skillStep: string;
	exportSha?: string;
};

export type GraderQueue = {
	gradable: QueueObservation<GraderCandidate[]>;
	cutAdmission: QueueObservation<{ cut: string[]; failures: GraderCandidate[] }>;
	gaps: QueueObservation<GraderCandidate[]>;
	downtime: QueueObservation<GraderCandidate[]>;
};

export type GraderAction = {
	step: 1 | 2 | 3 | 4;
	bead: string;
	title: string;
	source: string;
	skillStep: string;
	command: string;
	marker: string | null;
	research: string | null;
};

export type GraderSelection =
	| { status: "ACTION"; action: GraderAction }
	| { status: "UNKNOWN" | "FAILED"; source: string; reason: string }
	| { status: "EMPTY"; reason: "all priority classes are known and empty" };

const GRADER_ACTION_SCHEMA = { type: "object", required: ["step", "bead", "title", "source", "skillStep", "command", "marker", "research"], properties: {
	step: { enum: [1, 2, 3, 4] }, bead: { type: "string" }, title: { type: "string" }, source: { type: "string" },
	skillStep: { type: "string" }, command: { type: "string" }, marker: { type: ["string", "null"] }, research: { type: ["string", "null"] },
} };
export const GRADER_NEXT_DATA_SCHEMA: DataSchema = { type: "object", required: ["status", "next_action", "unknown_sources"], properties: {
	status: { enum: ["ACTION", "UNKNOWN", "FAILED", "EMPTY"] }, next_action: { anyOf: [GRADER_ACTION_SCHEMA, { type: "null" }] },
	unknown_sources: { type: "array", items: { type: "object", required: ["source", "status", "reason"], properties: {
		source: { type: "string" }, status: { enum: ["UNKNOWN", "FAILED"] }, reason: { type: "string" },
	} } },
	source: { type: "string" }, reason: { type: "string" }, text: { type: "string" },
} };

const shellQuote = (value: string): string => `'${value.split("'").join("'\\''")}'`;
const comparePriority = (a: GraderCandidate, b: GraderCandidate): number => a.priority - b.priority || a.id.localeCompare(b.id);

const RESEARCH_STEP = "Before any edit, search for implementing code in public repositories and record one comment as prior=<url#Lx-Ly> did=<what they do> applied=<what we change> quoted=<source lines>. Docs-only links are refused. If no implementing code exists, record prior=nothing-found with repos=<repositories searched>, queries=<queries used>, did=nothing-found, and applied=<what we change>.";

function action(step: GraderAction["step"], candidate: GraderCandidate, source: string, command: string): GraderAction {
	const marker = step >= 3 ? `grader-next-step-${step}` : null;
	const research = marker === null ? null : RESEARCH_STEP;
	return { step, bead: candidate.id, title: candidate.title, source, skillStep: candidate.skillStep, command, marker, research };
}

function eligible(candidate: GraderCandidate, agent: string): boolean {
	return candidate.id.trim() !== "" && candidate.title.trim() !== "" && candidate.skillStep.trim() !== ""
		&& candidate.author !== null && candidate.author !== agent && candidate.assignee !== agent;
}

function firstUnknown(queue: GraderQueue, rung: keyof GraderQueue): GraderSelection | null {
	const observation = queue[rung];
	return observation.status === "KNOWN" ? null : { status: observation.status, source: observation.source, reason: observation.reason };
}


export function graderUnavailableSources(queue: GraderQueue): { source: string; status: "UNKNOWN" | "FAILED"; reason: string }[] {
	return Object.values(queue).filter((observation): observation is Exclude<QueueObservation<unknown>, { status: "KNOWN" }> =>
		observation.status !== "KNOWN").map(({ source, status, reason }) => ({ source, status, reason }));
}

export function chooseGraderNext(agent: string, repo: string, queue: GraderQueue): GraderSelection {
	const gradableUnknown = firstUnknown(queue, "gradable");
	if (gradableUnknown) return gradableUnknown;
	if (queue.gradable.status === "KNOWN") {
		const candidate = [...queue.gradable.value].filter(row => eligible(row, agent) && typeof row.exportSha === "string" && row.exportSha.length > 0)
			.sort(comparePriority)[0];
		if (candidate && candidate.exportSha !== undefined) return { status: "ACTION", action: action(1, candidate, queue.gradable.source,
			`omp-kit verify ${shellQuote(candidate.id)} --export ${shellQuote(candidate.exportSha)} --project ${shellQuote(repo)} --actor ${shellQuote(agent)}`) };
	}

	const cutUnknown = firstUnknown(queue, "cutAdmission");
	if (cutUnknown) return cutUnknown;
	if (queue.cutAdmission.status === "KNOWN") {
		const cut = new Set(queue.cutAdmission.value.cut);
		const candidate = queue.cutAdmission.value.failures.filter(row => cut.has(row.id) && row.assignee === null && eligible(row, agent))
			.sort(comparePriority)[0];
		if (candidate) return { status: "ACTION", action: action(2, candidate, queue.cutAdmission.source,
			`omp-kit preflight claim ${shellQuote(candidate.id)} --project ${shellQuote(repo)} --actor ${shellQuote(agent)}`) };
	}

	const gapsUnknown = firstUnknown(queue, "gaps");
	if (gapsUnknown) return gapsUnknown;
	if (queue.gaps.status === "KNOWN") {
		const candidate = queue.gaps.value.filter(row => row.assignee === null && eligible(row, agent)
			&& typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost > 0)
			.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || comparePriority(a, b))[0];
		if (candidate) {
			const marker = "grader-next-step-3";
			return { status: "ACTION", action: action(3, candidate, queue.gaps.source,
				`cd ${shellQuote(repo)} && br update ${shellQuote(candidate.id)} --claim --actor ${shellQuote(agent)} --add-label ${shellQuote(marker)}`) };
		}
	}

	const downtimeUnknown = firstUnknown(queue, "downtime");
	if (downtimeUnknown) return downtimeUnknown;
	if (queue.downtime.status === "KNOWN") {
		const candidate = queue.downtime.value.filter(row => (row.assignee === null || row.assignee === agent) && eligible(row, agent))
			.sort(comparePriority)[0];
		if (candidate) {
			const marker = "grader-next-step-4";
			return { status: "ACTION", action: action(4, candidate, queue.downtime.source,
				`cd ${shellQuote(repo)} && br update ${shellQuote(candidate.id)} --claim --actor ${shellQuote(agent)} --add-label ${shellQuote(marker)}`) };
		}
	}

	return { status: "EMPTY", reason: "all priority classes are known and empty" };
}

const PRIOR_ART_FIELDS = ["prior", "did", "applied", "quoted", "repos", "queries"] as const;
type PriorArtField = typeof PRIOR_ART_FIELDS[number];

function extractFields(text: string): Map<PriorArtField, string> {
	const found: { key: PriorArtField; start: number; valueStart: number }[] = [];
	for (const key of PRIOR_ART_FIELDS) {
		const marker = `${key}=`;
		let offset = 0;
		while (offset < text.length) {
			const at = text.indexOf(marker, offset);
			if (at < 0) break;
			if (at === 0 || text[at - 1] === " " || text[at - 1] === "\n" || text[at - 1] === "\r") {
				found.push({ key, start: at, valueStart: at + marker.length });
				break;
			}
			offset = at + marker.length;
		}
	}
	found.sort((a, b) => a.start - b.start);
	const fields = new Map<PriorArtField, string>();
	for (let i = 0; i < found.length; i++) {
		const item = found[i]!;
		const end = found[i + 1]?.start ?? text.length;
		fields.set(item.key, text.slice(item.valueStart, end).trim());
	}
	return fields;
}

function digitsOnly(value: string): boolean {
	if (value.length === 0) return false;
	for (const char of value) if (char < "0" || char > "9") return false;
	return true;
}

function hasLineRange(fragment: string): boolean {
	if (!fragment.startsWith("L")) return false;
	const separator = fragment.indexOf("-L", 1);
	if (separator < 0) return false;
	const start = fragment.slice(1, separator);
	const end = fragment.slice(separator + 2);
	if (!digitsOnly(start) || !digitsOnly(end)) return false;
	const first = Number(start);
	const last = Number(end);
	return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first > 0 && last >= first;
}

function isSourceFileUrl(value: string): boolean {
	let url: URL;
	try { url = new URL(value); } catch { return false; }
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "") return false;
	const host = url.hostname.toLowerCase();
	const segments = url.pathname.split("/").filter(Boolean);
	let sourceIndex = -1;
	if (host === "github.com" || host === "codeberg.org") sourceIndex = segments.indexOf("blob", 2);
	else if (host === "gitlab.com") {
		const marker = segments.findIndex((part, index) => part === "-" && segments[index + 1] === "blob");
		sourceIndex = marker < 0 ? -1 : marker + 1;
	} else if (host === "bitbucket.org") sourceIndex = segments.indexOf("src", 2);
	if (sourceIndex < 2 || sourceIndex + 2 >= segments.length || !hasLineRange(url.hash.slice(1))) return false;
	const file = segments[segments.length - 1] ?? "";
	const dot = file.lastIndexOf(".");
	const extension = dot < 0 ? "" : file.slice(dot + 1).toLowerCase();
	return ["c", "cc", "cpp", "cs", "go", "h", "hpp", "java", "js", "jsx", "kt", "m", "mjs", "php", "py", "rb", "rs", "sh", "swift", "ts", "tsx"].includes(extension);
}

export type PriorArtVerdict = { status: "CODE" | "NOTHING_FOUND" | "REFUSED"; reason: string };

export function validatePriorArtComment(text: string): PriorArtVerdict {
	const fields = extractFields(text);
	const prior = fields.get("prior") ?? "";
	const did = fields.get("did") ?? "";
	const applied = fields.get("applied") ?? "";
	if (prior === "nothing-found") {
		if (fields.get("repos")?.trim() && fields.get("queries")?.trim() && did.includes("nothing-found") && applied.trim()) {
			return { status: "NOTHING_FOUND", reason: "searches, repositories, and applied approach are recorded" };
		}
		return { status: "REFUSED", reason: "nothing-found requires repositories, queries, did, and applied fields" };
	}
	if (!prior || !did || !applied || !fields.get("quoted")?.trim()) {
		return { status: "REFUSED", reason: "code prior art requires prior URL, did, applied, and quoted source lines" };
	}
	if (!isSourceFileUrl(prior)) {
		return { status: "REFUSED", reason: "prior URL must identify a public repository source-code file and line range; documentation links do not count" };
	}
	return { status: "CODE", reason: "repository source-code URL, line range, implementation, and applied approach are recorded" };
}

export function formatGraderAction(action: GraderAction): string {
	const lines = [`NEXT step ${action.step}: ${action.bead} — ${action.title}`, `Skill step: ${action.skillStep}`, `Command: ${action.command}`];
	if (action.research !== null) lines.push(`Research before editing: ${action.research}`);
	return lines.join("\n");
}
export function formatGraderSelection(selection: GraderSelection, queue: GraderQueue): string {
	const unavailable = graderUnavailableSources(queue);
	const lines = selection.status === "ACTION" ? [formatGraderAction(selection.action)]
		: [selection.status === "EMPTY" ? "No eligible grader action." : "No action: queue sources are unavailable."];
	if (unavailable.length) {
		lines.push("Unavailable queue sources:");
		for (const source of unavailable) lines.push(`- ${source.status} ${source.source}: ${source.reason}`);
	}
	return lines.join("\n");
}
