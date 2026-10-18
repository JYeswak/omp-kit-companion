import { posix } from "node:path";
import type { CaseReferenceFacts } from "../src/case-corpus.ts";

/**
 * Independent specification lane for the owned, opted-in corpus fixtures.
 * It consumes declared fixture inputs, never expected verdicts or production
 * admission/fact-loader code. The kit lane separately materializes real Git
 * repositories and evaluates the production predicate. This is not a TTSR rule.
 */
export function referenceAdmission(input: {
	source: string;
	tool: string;
	path: string;
	snippet: string;
	reference?: CaseReferenceFacts;
}): boolean {
	if (input.source !== "tool" || (input.tool !== "write" && input.tool !== "edit")) return false;
	// Corpus path semantics are POSIX. Unsupported carriers are explicit failures,
	// not an assertion that an unexamined URI or malformed path is synthetic.
	if (input.path.includes("://") || input.path.includes("\\") || input.path.includes("\0")) {
		throw new Error("ADMISSION_REFERENCE_UNSUPPORTED_PATH");
	}
	const parts = posix.normalize(input.path).split("/");
	const scratch = parts.findIndex((part, index) => part === "var" && parts[index + 1] === "agent-tmp");
	if (scratch < 0) return false;
	// The first child names the owned session, not an instructional artifact.
	const relativeParts = parts.slice(scratch + 3);
	const target = relativeParts.join("/");
	const name = posix.basename(target);
	const instructionPath = relativeParts.some(segment => {
		const word = segment.toLowerCase();
		return word.indexOf("prompt") !== -1 || word.slice(0, 6) === "packet";
	});
	const skillArtifact = relativeParts.indexOf("skills") !== -1;
	const ruleDocument = relativeParts[relativeParts.length - 2] === "rules" && name.slice(-3) === ".md";
	const shellArtifact = name.toLowerCase().endsWith(".sh") || input.snippet.startsWith("#!");
	if (instructionPath || skillArtifact || ruleDocument || shellArtifact) return true;
	for (const [canonical, content] of Object.entries(input.reference?.tracked ?? {})) {
		if (target === canonical || target.endsWith(`/${canonical}`) || input.snippet === content) return true;
	}
	return false;
}
