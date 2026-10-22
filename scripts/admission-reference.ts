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

const BYPASS_VARIABLES = ["AGENT_MAIL_BYPASS", "AGENT_MAIL_GUARD_MODE"];
const DECLARATIONS = ["export", "declare", "typeset", "readonly", "local"];

/**
 * Independent specification for BYPASSENV1 rows: a plain-word bash snippet (commands joined by `;` or `&&`, no
 * quoting or expansion) fires iff a command assigns or exports AGENT_MAIL_BYPASS or AGENT_MAIL_GUARD_MODE as a
 * leading NAME=value word, an `env` operand, or a declaration-builtin operand. Other shell syntax is unsupported.
 */
export function referenceBypassEnvironment(input: { source: string; tool: string; snippet: string }): boolean {
	if (input.source !== "tool" || input.tool !== "bash") return false;
	for (const special of ["'", "\"", "`", "$", "\\", "(", ")", "{", "}", "|", "<", ">", "\n"]) {
		if (input.snippet.includes(special)) throw new Error("ADMISSION_REFERENCE_UNSUPPORTED_SHELL");
	}
	const named = (word: string): boolean => BYPASS_VARIABLES.includes(word.split("=")[0]!);
	for (const command of input.snippet.split(";").flatMap(part => part.split("&&"))) {
		const words = command.split(" ").filter(Boolean);
		let index = 0;
		while (index < words.length && words[index]!.includes("=")) if (named(words[index++]!)) return true;
		if (words[index] === "env") {
			for (index++; index < words.length; index++) {
				const word = words[index]!;
				if (word === "-u" || word === "--unset") index++;
				else if (word.includes("=")) { if (named(word)) return true; }
				else if (!word.startsWith("-")) break;
			}
		}
		if (DECLARATIONS.includes(words[index] ?? "") && words.slice(index + 1).some(named)) return true;
	}
	return false;
}

// Operand words before options: `-extract keypath fmt`, `-convert fmt`, `-insert|-replace keypath -type value`, `-remove keypath`.
const PLUTIL_EDIT_OPERANDS: Record<string, number> = { "-extract": 2, "-convert": 1, "-insert": 3, "-replace": 3, "-remove": 1 };

/**
 * Independent specification for PLUTILINPLACE1 rows: a plain-word bash snippet (commands joined by `;` or `&&`, no
 * quoting or expansion) fires iff a command is `plutil` with an editing verb and no `-o <path>` among the words after
 * the verb's operands and before any `--`. `-extract keypath raw` prints to stdout and does not fire.
 */
export function referencePlutilInPlace(input: { source: string; tool: string; snippet: string }): boolean {
	if (input.source !== "tool" || input.tool !== "bash") return false;
	for (const special of ["'", "\"", "`", "$", "\\", "(", ")", "{", "}", "|", "<", ">", "\n"]) {
		if (input.snippet.includes(special)) throw new Error("ADMISSION_REFERENCE_UNSUPPORTED_SHELL");
	}
	for (const command of input.snippet.split(";").flatMap(part => part.split("&&"))) {
		const words = command.split(" ").filter(Boolean);
		const verb = words[1] ?? "";
		if (words[0] !== "plutil" || !Object.hasOwn(PLUTIL_EDIT_OPERANDS, verb)) continue;
		if (verb === "-extract" && words[3] === "raw") continue;
		const container = (verb === "-insert" || verb === "-replace") && (words[3] === "-dictionary" || words[3] === "-array");
		const options = words.slice(2 + PLUTIL_EDIT_OPERANDS[verb]! - (container ? 1 : 0));
		const end = options.indexOf("--");
		const output = options.indexOf("-o");
		if (output >= 0 && (end < 0 || output < end) && output + 1 < options.length) continue;
		return true;
	}
	return false;
}
