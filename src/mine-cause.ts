import { captureMineReplay } from "./mine-replay.ts";
import { gateFromReason } from "../extensions/gate-events.ts";

export interface MineResultInput {
	tool: string;
	result: unknown;
	text?: string;
	is_error?: boolean;
	exit_code?: unknown;
	timed_out?: unknown;
	outcome?: string;
	code?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function content(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map(part => { const item = object(part); return item?.type === "text" ? text(item.text) : ""; }).filter(Boolean).join("\n");
}
function slug(value: string): string { return (captureMineReplay({ message: value }).message ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "unclassified"; }
function toolName(value: string): string { return (captureMineReplay({ tool: value }).tool ?? "").replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 160) || "unknown"; }
function rc(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
	return undefined;
}

/** Inspect native envelopes only, never arbitrary command/search output subtrees. */
export function classifyMineResult(input: MineResultInput): { class_id: string; summary: string } | null {
	const layers: Record<string, unknown>[] = [];
	const diagnostics: string[] = [];
	const visited = new Set<object>();
	const root = object(input.result);
	const allowTextStatus = input.is_error !== false && root?.is_error !== false && root?.isError !== false && root?.success !== true;
	function inspect(value: unknown, depth = 0, textStatus = allowTextStatus): void {
		if (depth > 8) return;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (textStatus && trimmed.length <= 65_536 && trimmed.startsWith("{")) {
				try { const parsed = object(JSON.parse(trimmed)); if (parsed) { inspect(parsed, depth + 1, textStatus); return; } } catch { /* Ordinary diagnostic text. */ }
			}
			const diagnostic = captureMineReplay({ message: trimmed }).message ?? "";
			const retainedStatus = diagnostic.match(/^findings=\d+ rc=(-?\d+)$/);
			if (retainedStatus && (textStatus || Number(retainedStatus[1]) === 0)) layers.push({ rc: Number(retainedStatus[1]) });
			if (diagnostic) diagnostics.push(diagnostic);
			return;
		}
		const row = object(value);
		if (!row || visited.has(row)) return;
		visited.add(row); layers.push(row);
		const childTextStatus = textStatus && row.is_error !== false && row.isError !== false && row.success !== true;
		for (const key of ["message", "error", "stderr", "output", "text", "detail"] as const) {
			if (typeof row[key] === "string") inspect(row[key], depth + 1, childTextStatus);
		}
		const body = content(row.content);
		if (body) inspect(body, depth + 1, childTextStatus);
		// `command`, `stdout`, arbitrary JSON data, and quoted text are not status envelopes.
		inspect(row.details, depth + 1, childTextStatus);
		inspect(row.result, depth + 1, childTextStatus);
	}
	inspect(input.result);
	if (input.text && !diagnostics.includes(input.text.trim())) inspect(input.text);
	const explicit = { is_error: input.is_error, exit_code: input.exit_code, timed_out: input.timed_out, outcome: input.outcome, code: input.code };
	layers.unshift(explicit);
	let tool = input.tool;
	for (const layer of layers) {
		const inner = text(layer.toolName) || text(layer.tool) || text(layer.name);
		if (inner) tool = inner;
	}
	const first = (keys: readonly string[]): unknown => {
		for (const layer of layers) for (const key of keys) if (layer[key] !== undefined && layer[key] !== null) return layer[key];
		return undefined;
	};
	const exit = layers.flatMap(layer => ["exit_code", "exitCode", "rc", "code"].map(key => rc(layer[key]))).find(value => value !== undefined);
	const outcome = text(first(["outcome", "status", "decision", "guard_decision"])).toLowerCase();
	const timedOut = first(["timed_out", "timedOut"]);
	const error = first(["is_error", "isError"]);
	const succeeded = exit === 0 || (error !== true && error !== 1 && (outcome === "success" || outcome === "succeeded" || first(["success"]) === true));
	if (succeeded) return null;
	const failed = error === true || error === 1 || first(["success"]) === false || (exit !== undefined && exit !== 0)
		|| ["error", "failed", "failure", "timeout", "refuse", "refused", "refusal", "deny", "denied", "block", "blocked", "warn", "inject"].includes(outcome);
	const body = diagnostics.join("\n");
	const finding = (classId: string, diagnostic = body) => ({ class_id: classId, summary: (captureMineReplay({ message: diagnostic || `${toolName(tool)} reported an unclassified failure` }).message ?? "").replace(/\s+/g, " ").trim().slice(0, 400) });
	// A successful search may contain any of these diagnostic prefixes as quoted source.
	if (!failed && timedOut !== true && outcome !== "timeout") return null;
	const lines = diagnostics.flatMap(diagnostic => diagnostic.split("\n").map(line => line.trim()));
	const mcp = lines.map(line => line.match(/^MCP failure server: ([a-zA-Z0-9_-]+) tool: ([a-zA-Z0-9_.-]+) transport: \S+ stage: \S+ failure: \S+ retryable:/)).find(Boolean);
	if (mcp) return finding(`mcp-transport:mcp__${mcp[1]!.replace(/-/g, "_")}_${mcp[2]}`, lines.find(line => line.startsWith("MCP failure server:")));
	const guard = lines.map(line => line.match(/^fleet-guard [a-zA-Z0-9_.-]+ \(([A-Z][A-Z0-9_]+)\):/)).find(Boolean);
	const refusal = lines.map(line => line.match(/^(?:(?:omp-kit|commit)[ :\-]+)?(MEMBER_REFUSED|REFUSED)\b/)).find(Boolean);
	const code = text(first(["code", "guard_rule", "rule", "gate"]));
	const kitGuard = lines.find(line => line.startsWith("kit-") || line.startsWith("[kit-"));
	const parsedKitCode = kitGuard ? gateFromReason(kitGuard) : "";
	const kitCode = parsedKitCode.startsWith("kit-") || parsedKitCode.startsWith("[kit-") ? "" : parsedKitCode;
	const refused = ["refuse", "refused", "refusal", "deny", "denied", "block", "blocked", "warn", "inject"].includes(outcome);
	const commit = tool === "commit" || text(first(["act", "surface"])) === "commit" || refusal?.[1] === "MEMBER_REFUSED";
	if (guard || kitCode || text(first(["guard"])).startsWith("kit-") && code || refused || refusal && failed) {
		const cause = guard?.[1] || kitCode || code || refusal?.[1] || "unknown";
		return finding(`${commit ? "commit-refusal" : "guard-friction"}:${toolName(cause)}`);
	}
	const named: readonly [RegExp, string][] = [
		[/^(?:Errors:\s*Missing phase name for append operation|ValidationError:\s*phase name is required)\b/i, "validation:phase-name-required"],
		[/^Process director verification decision:\s*Error:\s*Wiring disposition not persisted\b/, "assertion:wiring-disposition-not-persisted"],
		[/^Per-call model is disabled for task calls \(task\.perCallModel: off\)\./, "validation:task-per-call-model-disabled"],
		[/^content is required for \S+\./, "validation:content-required"],
		[/^Failed to execute JSON query:\s*(?:Error:)?/, "validation:json-query"],
		[/^This edit anchors to lines .* never displayed\b/, "validation:edit-undisplayed-anchor"],
		[/^Patch did not match\b/, "validation:edit-anchor-mismatch"],
	];
	for (const line of lines) {
		for (const [pattern, cause] of named) if (pattern.test(line)) return finding(cause, line);
		const diagnostic = line.match(/^(ValidationError|AssertionError|IdentityError):\s*(.+)$/);
		if (diagnostic) return finding(`${diagnostic[1] === "AssertionError" ? "assertion" : diagnostic[1] === "IdentityError" ? "identity" : "validation"}:${slug(diagnostic[2]!)}`, line);
	}
	const timeoutDiagnostic = lines.some(line => /^(?:(?:Error:\s*)?(?:Command|Execution|Request) timed out\b|(?:Error:\s*)?(?:timeout|deadline exceeded)\b|MCP error -?\d+:\s*(?:Request )?(?:timed out|timeout)\b)/i.test(line));
	if (timedOut !== false && (timedOut === true || exit === 124 || exit === 142 || outcome === "timeout" || timeoutDiagnostic)) {
		return finding(`${/^mcp(?:__|[._-])/.test(tool) ? "mcp-transport" : "timeout"}:${toolName(tool)}`);
	}
	return failed ? finding("tool-error:unclassified") : null;
}
