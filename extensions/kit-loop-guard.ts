/**
 * kit-loop-guard (LOOPGUARD1, ompkit-xa5s.18): stop an agent looping for hours
 * on the same tool error inside one turn.
 *
 * Measured 2026-10-13: one 2h+ turn with TODO 0/8 repeating
 * `JSON_PARSE SyntaxError: Unable to parse JSON string` while parsing
 * `br show` output from tool-result text. Tool-result text carries a
 * `Wall time` trailer and large output is truncated into an artifact, so
 * JSON.parse on it cannot succeed; nothing stopped the turn.
 *
 * The guard counts consecutive tool results in one turn carrying the same
 * normalized error signature. At 3 it injects one message naming the error,
 * the count and, for known classes, the fix. At 6 it emits one line for the
 * pane's director (fleet-watch target) with the session, error and count.
 * Any successful tool result resets the count.
 */

export const LOOPGUARD_INJECT_AT = 3;
export const LOOPGUARD_NOTIFY_AT = 6;

/** Known error class with a canned fix. */
export const JSON_PARSE_CLASS = "JSON_PARSE";
/** Inputs are capped before matching: tool-result text can be megabytes. */
const SIGNATURE_SCAN_LIMIT = 8192;

const JSON_PARSE_PATTERN =
	/json[_. ]?parse|syntaxerror[^\n]*json|unable to parse json|unexpected (?:token|end of json)|json string/i;

export const JSON_PARSE_FIX =
	"Tool-result text is not JSON: it carries a `Wall time` trailer and large output " +
	"is truncated into an artifact, so JSON.parse on it cannot succeed. Parse inside the " +
	"command with jq (e.g. `br show <id> --json | jq ...`), or parse the captured stdout " +
	"of a subprocess instead of the tool-result text. See rules/kit-tool-result-is-not-json.md.";

export interface LoopGuardState {
	count: number;
	signature: string | null;
	/** Signature already escalated to the director in this run; each run notifies once. */
	notifiedFor: string | null;
}

export interface ToolResultObservation {
	isError: unknown;
	result: unknown;
}

export interface LoopGuardAction {
	/** Message to inject into the turn (at INJECT_AT). */
	inject?: string;
	/** One line for the pane's director (at NOTIFY_AT, exactly once per run). */
	notifyDirector?: string;
}

export function newLoopGuardState(): LoopGuardState {
	return { count: 0, signature: null, notifiedFor: null };
}

/** Pull human-readable text out of the tool-result envelope shapes omp exposes. */
function pushText(parts: string[], value: unknown): void {
	if (typeof value === "string" && value.trim() !== "") parts.push(value);
	else if (value !== null && typeof value === "object" && !Array.isArray(value) && "text" in value) {
		pushText(parts, value.text);
	}
}

export function extractResultText(result: unknown): string | null {
	if (typeof result === "string") return result;
	if (result === null || typeof result !== "object") return null;
	if (Array.isArray(result)) {
		const parts: string[] = [];
		for (const part of result) pushText(parts, part);
		return parts.length > 0 ? parts.join("\n") : null;
	}
	const parts: string[] = [];
	for (const [key, value] of Object.entries(result)) {
		if (key === "content" && Array.isArray(value)) {
			for (const part of value) pushText(parts, part);
		} else if (TEXT_FIELDS[key] === true) {
			pushText(parts, value);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

const TEXT_FIELDS: Record<string, true> = {
	text: true,
	message: true,
	error: true,
	stderr: true,
	stdout: true,
	output: true,
	details: true,
};

/**
 * Normalize a tool-result text to an error signature, or null when the
 * result is not an error. Known classes collapse to their class name;
 * anything else collapses to the first error-like line with numbers,
 * paths and durations stripped, so the same failure repeats identically
 * while distinct failures differ.
 */
export function normalizeErrorSignature(text: string | null): string | null {
	if (text === null || text.trim() === "") return null;
	if (text.length > SIGNATURE_SCAN_LIMIT) text = text.slice(0, SIGNATURE_SCAN_LIMIT);
	if (JSON_PARSE_PATTERN.test(text)) return JSON_PARSE_CLASS;
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	const errorLine = lines.find((line) => /error|fail|exception|refus|denied|timeout|econn|enoent|not found/i.test(line)) ?? lines[0]!;
	const normalized = errorLine
		.toLowerCase()
		.replace(/\b\d+(\.\d+)+\b/g, "<ver>")
		.replace(/\b\d+\b/g, "<n>")
		.replace(/(\/[\w.~-]+)+/g, "<path>")
		.replace(/[\w.-]+@[\w.-]+/g, "<addr>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	return `OTHER:${normalized}`;
}

export function fixForSignature(signature: string): string | null {
	if (signature === JSON_PARSE_CLASS) return JSON_PARSE_FIX;
	return null;
}

export function injectMessage(signature: string, count: number): string {
	const fix = fixForSignature(signature);
	return (
		`kit-loop-guard: the last ${count} tool results in this turn failed with the same error (${signature}). ` +
		"Repeating the same call will not fix it; change approach before the next call." +
		(fix !== null ? ` Fix: ${fix}` : " Inspect the error above and try a different command or input.")
	);
}

export function directorLine(session: string, signature: string, count: number): string {
	return `LOOPGUARD ${session}: same tool error ${signature} x${count} in one turn; agent is looping, consider interrupting the turn (queued/composer input is preserved).`;
}

export function observeToolResult(
	state: LoopGuardState,
	observation: ToolResultObservation,
	session: string,
): LoopGuardAction {
	const failed = observation.isError === true;
	const signature = failed ? normalizeErrorSignature(extractResultText(observation.result)) : null;
	if (signature === null) {
		state.count = 0;
		state.signature = null;
		return {};
	}
	if (state.signature === signature) {
		state.count += 1;
	} else {
		state.count = 1;
		state.signature = signature;
	}
	const action: LoopGuardAction = {};
	if (state.count === LOOPGUARD_INJECT_AT) action.inject = injectMessage(signature, state.count);
	if (state.count >= LOOPGUARD_NOTIFY_AT && state.notifiedFor !== signature) {
		state.notifiedFor = signature;
		action.notifyDirector = directorLine(session, signature, state.count);
	}
	return action;
}

/** The slice of omp's ExtensionAPI this guard touches. */
export interface LoopGuardApi {
	on(event: "tool_execution_end", handler: (event: ToolResultObservation, ctx: LoopGuardContext) => unknown): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options?: { deliverAs?: "nextTurn" | "aside" }): void;
}

export interface LoopGuardContext {
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	sessionManager?: { getSessionId?: () => string | undefined };
}

export interface LoopGuardDeps {
	session?: string;
	onDirectorNotify?: (line: string) => void;
}

export default async function loopGuard(pi: LoopGuardApi, deps?: LoopGuardDeps): Promise<void> {
	const state = newLoopGuardState();
	pi.on("tool_execution_end", (event, ctx) => {
		const session = deps?.session ?? ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
		const action = observeToolResult(state, event, session);
		if (action.inject !== undefined) {
			pi.sendMessage(
				{ customType: "kit-loop-guard", content: action.inject, display: true },
				{ deliverAs: "aside" },
			);
		}
		if (action.notifyDirector !== undefined) {
			if (deps?.onDirectorNotify) deps.onDirectorNotify(action.notifyDirector);
			else ctx.ui?.notify(action.notifyDirector, "error");
		}
	});
}
