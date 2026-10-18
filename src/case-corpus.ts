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
