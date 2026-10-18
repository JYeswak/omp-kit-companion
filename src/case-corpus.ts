import { isAbsolute } from "node:path";

export const CASE_HEADER = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\treference_facts";

export interface CaseReferenceFacts {
	readonly tracked: Record<string, string>;
}

function isTrackedSourceMap(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.entries(value).every(([file, content]) =>
		file !== "" && !isAbsolute(file) && !file.includes("\\") && !file.includes("\0") &&
		!file.split("/").some(segment => segment === ".." || segment === ".git") && typeof content === "string");
}

/** Empty facts are explicit in column eight; malformed facts must never become an empty index. */
export function parseReferenceFacts(raw: string): CaseReferenceFacts | undefined {
	if (raw === "") return undefined;
	const value: unknown = JSON.parse(raw);
	if (typeof value !== "object" || value === null || Array.isArray(value) ||
		Object.keys(value).length !== 1 || !("tracked" in value) || !isTrackedSourceMap(value.tracked))
		throw new Error("expected a tracked repository-relative path/content map");
	return { tracked: value.tracked };
}

export interface CorpusCase {
	line: number;
	rule: string;
	expect: "fire" | "quiet";
	source: "text" | "thinking" | "tool";
	tool: string;
	path: string;
	snippet: string;
	note: string;
	/** Declared fixture inputs, not an expected admission outcome. */
	reference?: CaseReferenceFacts;
}

/** One strict schema for every shipped corpus consumer; preserve explicit trailing fields. */
export function parseCaseCorpus(text: string): { cases: CorpusCase[]; errors: string[] } {
	const cases: CorpusCase[] = [];
	const errors: string[] = [];
	const lines = text.split("\n");
	if (lines[0].replace(/\r$/, "") !== CASE_HEADER) return { cases, errors: ["cases header: expected exact eight-column CASE_HEADER"] };
	for (let i = 1; i < lines.length; i++) {
		const raw = lines[i].replace(/\r$/, "");
		if (raw.trim() === "" || raw.startsWith("#")) continue;
		const cols = raw.split("\t");
		if (cols.length !== 8) {
			errors.push(`cases line ${i + 1}: ${cols.length} columns, need exactly 8`);
			continue;
		}
		const [rule, expect, source, tool, path, snippet, note, rawReference] = cols;
		let reference: CaseReferenceFacts | undefined;
		try {
			reference = parseReferenceFacts(rawReference);
		} catch (error) {
			errors.push(`cases line ${i + 1}: invalid reference facts: ${error}`);
			continue;
		}
		if (expect !== "fire" && expect !== "quiet") errors.push(`cases line ${i + 1}: expect=${expect}`);
		if (!["text", "thinking", "tool"].includes(source)) errors.push(`cases line ${i + 1}: source=${source}`);
		if (source === "tool" && !["bash", "edit", "write"].includes(tool)) errors.push(`cases line ${i + 1}: tool=${tool}`);
		cases.push({
			line: i + 1, rule, expect: expect as CorpusCase["expect"], source: source as CorpusCase["source"],
			tool, path, snippet: snippet.replace(/\\([nt])/g, (_, character: string) => character === "n" ? "\n" : "\t"), note, reference,
		});
	}
	return { cases, errors };
}
