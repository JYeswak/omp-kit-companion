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
	// OMP prints its MCP failure envelope one field per line; the single-line form is matched too.
	const mcp = /(?:^|\s)MCP failure server: ([a-zA-Z0-9_-]+) tool: ([a-zA-Z0-9_.-]+) transport: \S+ stage: \S+ failure: \S+ retryable:/.exec(lines.join(" "));
	if (mcp) return finding(`mcp-transport:mcp__${mcp[1]!.replace(/-/g, "_")}_${mcp[2]}`, mcp[0].trim());
	const guard = lines.map(line => line.match(/^(?:Error: )?fleet-guard [a-zA-Z0-9_.-]+ \(([A-Z][A-Z0-9_]+)\):/)).find(Boolean);
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
	// LEDGERCLASS1 (ompkit-1ra0d.68): refusal shapes the header matchers above miss. A refused act
	// already holds its ledger row under the gate name; these classes keep the miners' own outputs
	// truthful without a second refusal row. Ordered: specific shapes before generic code matches.
	// Text-derived codes pass the same scrub oracle as tool names: a redacted code yields no class.
	const codeName = (code: string): string | null => {
		const name = toolName(code);
		return name === "unknown" ? null : name;
	};
	const gateText: readonly [RegExp, (match: RegExpMatchArray, line: string) => string | null][] = [
		// GATEBUDGETHYGIENE1 (ompkit-1ra0d.129): a shim or handoff refusal observed in command
		// output files under its real code, never tool-error:unclassified. The br-shim: prefix
		// sits mid-line in hook and mine replays (comment_rc 4 br-shim: ...), so both edges anchor.
		[/(?:^|[\s"'([])(?:br-shim:\s*)?(HANDOFF_UNGATED|BR_SHIM_[A-Z0-9_]{1,60})\b/, match => `guard-friction:${match[1]}`],
		[/^(?:Error: )?fleet-guard ([A-Za-z0-9_.-]+):/, match => {
			const name = codeName(match[1]!);
			return name ? `guard-friction:${name}` : null;
		}],
		[/^(?:Error: )?dcg denied\b(.*)$/, match => {
			const rule = /\(([A-Za-z0-9_.-]+\.[A-Za-z0-9_.:+-]{1,95})\)/.exec(match[1]!);
			if (!rule) return "guard-friction:dcg-denied";
			const name = codeName(rule[1]!);
			return name ? `guard-friction:${name}` : null;
		}],
		// A gate header quoted mid-line (verify output citing the refusal it observed) still names its gate.
		[/(?:^|[\s:"\[])(MEMBER_REFUSED|REFUSED|[A-Z][A-Z0-9_]*_REFUSED):/, match => {
			const name = codeName(match[1]!);
			return name ? `guard-friction:${name}` : null;
		}],
		[/^Embedded (?:code|shell command) blocked:/, () => "guard-friction:embedded-blocked"],
		[/AM_GUARD_FAILED/, (match, line) => {
			const id = /\((AM_[A-Z][A-Z0-9_]{1,60})\b/.exec(line) ?? /\b(AM_[A-Z][A-Z0-9_]{1,60})\b/.exec(line);
			return id ? `guard-friction:${id[1]}` : null;
		}],
		[/\bRule: ([A-Za-z0-9_.-]+\.[A-Za-z0-9_.:+-]{1,95})\s*$/, match => {
			const name = codeName(match[1]!);
			return name ? `guard-friction:${name}` : null;
		}],
		[/"code"\s*:\s*"([A-Z][A-Z0-9_]*_REFUSED)"/, match => `guard-friction:${match[1]}`],
		[/"overall"\s*:\s*"([A-Z][A-Z0-9_]*_(?:REQUIRED|REFUSED))"/, match => `guard-friction:${match[1]}`],
		[/^RESOURCE_DEFERRED\b|heavy-work slots are occupied/, () => "guard-friction:resource-deferred"],
		[/STALE installed member/, () => "guard-friction:stale-member"],
		[/^\[close-evidence\] BLOCKED/, () => "guard-friction:close-evidence"],
		[/\bIDENTITY_UNBOUND\b/, () => "guard-friction:IDENTITY_UNBOUND"],
		[/^SLB CAUTION:/, () => "guard-friction:slb-caution"],
		[/^SLB DANGEROUS:/, () => "guard-friction:slb-dangerous"],
	];
	for (const line of lines) for (const [pattern, toClass] of gateText) {
		const gateMatch = pattern.exec(line);
		if (gateMatch) { const classId = toClass(gateMatch, line); if (classId) return finding(classId, line); }
	}
	const named: readonly [RegExp, string][] = [
		[/^(?:Errors:\s*Missing phase name for append operation|ValidationError:\s*phase name is required)\b/i, "validation:phase-name-required"],
		[/^Process director verification decision:\s*Error:\s*Wiring disposition not persisted\b/, "assertion:wiring-disposition-not-persisted"],
		[/^Per-call model is disabled for task calls \(task\.perCallModel: off\)\./, "validation:task-per-call-model-disabled"],
		[/^content is required for \S+\./, "validation:content-required"],
		[/^Failed to execute JSON query:\s*(?:Error:)?/, "validation:json-query"],
		[/^This edit anchors to lines .*?(displayed|exceed|shown|visible)\b/, "validation:edit-undisplayed-anchor"],
		[/^Patch did not match\b/, "validation:edit-anchor-mismatch"],
		[/^(?:Edit rejected for |`PUT \d+\.=\d+:` rejected:)/, "validation:edit-rejected"],
		[/^line \d+: .*?(hunk|payload|PUT)\b/, "validation:edit-patch-failed"],
		[/^Line \d+ does not exist/, "validation:edit-line-out-of-range"],
		[/^(?:error: patch (?:failed|fragment)|Apply failed|error: corrupt patch at line \d|error: while searching for:|patch: \*{4} malformed patch at line \d)/, "validation:edit-patch-failed"],
		[/^(?:rc=\d+ )?Error: cannot index/, "validation:query-unindexable"],
		[/suppression-no-reason/, "validation:pysafe-suppression-reason"],
	];
	for (const line of lines) {
		for (const [pattern, cause] of named) if (pattern.test(line)) return finding(cause, line);
		const diagnostic = line.match(/^(ValidationError|AssertionError|IdentityError):\s*(.+)$/);
		if (diagnostic) return finding(`${diagnostic[1] === "AssertionError" ? "assertion" : diagnostic[1] === "IdentityError" ? "identity" : "validation"}:${slug(diagnostic[2]!)}`, line);
	}
	const timeoutDiagnostic = lines.some(line => /^(?:(?:Error:\s*)?(?:Command|Execution|Request) timed out\b|(?:Error:\s*)?(?:timeout|deadline exceeded)\b|MCP error -?\d+:\s*(?:Request )?(?:timed out|timeout)\b)/i.test(line)
		|| /\btimed? out after \d+(?:\.\d+)?\s*(?:ms|s|m)\b/i.test(line)
		|| /\b[A-Z][A-Z0-9_]*(?:TIMEOUT|TIMED_OUT)[A-Z0-9_]*\b/.test(line));
	if (timedOut !== false && (timedOut === true || exit === 124 || exit === 142 || outcome === "timeout" || timeoutDiagnostic)) {
		return finding(`${/^mcp(?:__|[._-])/.test(tool) ? "mcp-transport" : "timeout"}:${toolName(tool)}`);
	}
	// LEDGERCLASS1: a check that answers with its own `name: CODE` verdict is that check's answer,
	// kept visible like FINDING. Gate headers ending in _REFUSED are claimed by the table above.
	const verdict = lines.map(line => line.match(/^[a-z][\w.-]*: ([A-Z][A-Z0-9_]{2,60})\b/)).find(Boolean);
	if (verdict) return finding(`finding:${toolName(tool)}`, verdict[0]);
	if (lines.some(line => /'overall':\s*'UNVERIFIED'|"overall"\s*:\s*"UNVERIFIED"/.test(line))) {
		return finding(`finding:${toolName(tool)}`);
	}
	// LEDGERCLASS1: the agent's own call was wrong (bad path, bad args, stale refs, broken code).
	// Actionable by the next call, and never a gate refusal.
	const agentText: readonly [RegExp, string][] = [
		[/Unknown ARIA ref/, "stale-ref"],
		[/selector currently matches no elements|No element found for selector/, "selector-no-match"],
		[/takes .* but was called as|takes no keyword arguments|takes \d+ positional arguments? but \d+ were given|expects? a dict of arguments|Invalid parameters/, "invalid-arguments"],
		[/^error: unexpected argument/, "invalid-arguments"],
		[/Invalid resource at/, "invalid-arguments"],
		[/: Is a directory\b/, "invalid-arguments"],
		// RECLASS2: the harness rejected the call's own arguments before running it.
		[/^(?:Invalid args for \S+: )?Validation failed for tool "/, "invalid-arguments"],
		[/unsupported request fields/, "invalid-arguments"],
		[/did not match any file\(s\) known to git/, "path-not-found"],
		[/\bno such file or directory\b/i, "path-not-found"],
		[/^(?:Path|File) (?:not found:|"[^"]*" not found|'[^']*' not found)/, "path-not-found"],
		[/:\s*unbound variable/, "unbound-variable"],
		[/error TS\d+:/, "type-error"],
		[/Cannot find module\b|\bModule not found\b|MODULE_NOT_FOUND|Cannot find package '/, "module-not-found"],
		[/Agent not found:/, "unknown-agent"],
		[/Artifact \d+ not found|Background job or service not found|Tool \S+ not found\. Did you mean|Did you mean:|Unknown skill:/, "unknown-reference"],
		[/unknown revision|unable to resolve revision|not a git repository|ambiguous argument/, "bad-git-state"],
		[/syntax error near unexpected token/, "syntax-error"],
		[/blocked: covered by/, "element-covered"],
		[/"code"\s*:\s*"INVALID_ARGUMENTS"/, "invalid-arguments"],
		// A JS eval cell that threw prints its stack frame inside the cell (js-cell-<id>).
		[/(?:^|\s)at <anonymous> \(js-cell-[0-9a-f-]+/, "thrown-error"],
		// RECLASS3: the 2026-11-12 24 h unclassified rows. Each is the agent's own call naming
		// something that does not exist, or an edit that changed nothing.
		[/^No such tool: xd:\/\/\S/, "unknown-reference"],
		[/^Tool default\.\S+ not found/, "unknown-reference"],
		[/^LSP error: Symbol "[^"]{1,200}" not found/, "unknown-reference"],
		[/^LSP error: File not found: /, "path-not-found"],
		[/^Errors: Task "[^"]{1,300}" not found/, "unknown-reference"],
		[/parsed and applied cleanly, but produced no change/, "no-op-edit"],
		[/^EACCES: permission denied, /, "permission-denied"],
	];
	for (const line of lines) for (const [pattern, cause] of agentText) {
		if (pattern.test(line)) return finding(`agent-input:${toolName(tool)}:${cause}`, line);
	}
	// LEDGERCLASS1: the tool or its environment failed (no browser here, backend down, upstream
	// 5xx, a warning with a failing exit). Named causes, still tool-error rows.
	const toolText: readonly [RegExp, string][] = [
		[/No pages to adopt here/, "no-browser-target"],
		[/relay .* is out of date/, "stale-relay"],
		[/Tool execution was aborted:|^Command aborted$|^Operation aborted$|^The operation was aborted\.$/, "aborted"],
		[/^Previous OMP process exited before completing the turn\.$/, "seat-restarted"],
		[/^\[Kernel died during execution\b/, "kernel-died"],
		// diff exits 1 when inputs differ: its own answer, not a broken tool.
		[/^Files \S+ and \S+ differ$|^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|^\d+(?:,\d+)?[acd]\d+(?:,\d+)?$/, "diff-differs"],
		[/DeprecationWarning|MODULE_TYPELESS_PACKAGE_JSON|\(\!\) Your \S+ config uses|^Warning: /, "warning"],
		[/"status"\s*:\s*"RED"/, "red-verdict"],
		[/"outcome"\s*:\s*"(?:partial|unavailable)"|'outcome':\s*'(?:partial|unavailable)'|no cursor to advance/, "incomplete-result"],
		[/"outcome"\s*:\s*"complete"/, "wrapper-failed"],
		[/"outcome"\s*:\s*"conflict"/, "version-conflict"],
		[/"delivery"\s*:\s*"blocked"/, "delivery-blocked"],
		[/"status"\s*:\s*"BACKOFF"/, "upstream-backoff"],
		[/"(?:bridgeS|s)tatus":\s*503/, "upstream-unavailable"],
		[/"injected"/, "injected-fault"],
		[/Infisical unreachable|no cache fallback|machine-identity login failed|^cf-secret: /, "backend-unreachable"],
		[/send_message failed; queued a durable UNSENT/, "message-unsent"],
		[/: Input\/output error/, "io-error"],
		[/Unable to read current working directory|^Working directory does not exist: /, "missing-cwd"],
		// RECLASS2: the self-restart verb replaces the calling seat, so its own tool call never returns 0.
		[/"result"\s*:\s*"LAUNCHED"/, "seat-restarted"],
		[/MISSING_PANE_ID|No pane_id provided/, "identity-unresolved"],
		[/[×✖]|\bFAIL\b|\bfail [1-9]|\(fail\)|^not ok\b|fixture plan rejected|Unhandled error between tests|^\s*\d+\s*\||^FAILED \((?:failures|errors)=\d/, "test-failure"],
	];
	for (const line of lines) for (const [pattern, cause] of toolText) {
		if (pattern.test(line)) return finding(`tool-error:${toolName(tool)}:${cause}`, line);
	}
	// RECLASS3: Agent Mail answers with {"error":{"type":"CODE",...}}, not "code". A backend
	// database failure is the tool's; a rejected argument or a missing record is the caller's.
	const amType = lines.map(line => line.match(/"error"\s*:\s*\{\s*"type"\s*:\s*"([A-Z][A-Z0-9_]{2,60})"/)).find(Boolean);
	if (amType) {
		const type = amType[1]!;
		if (type === "DATABASE_ERROR") return finding(`tool-error:${toolName(tool)}:backend-db-error`, amType[0]);
		if (type === "NOT_FOUND") return finding(`agent-input:${toolName(tool)}:unknown-reference`, amType[0]);
		if (type.startsWith("INVALID_") || type === "SUSPICIOUS_PATTERN") return finding(`agent-input:${toolName(tool)}:invalid-arguments`, amType[0]);
		return finding(`tool-error:${toolName(tool)}:${slug(type)}`, amType[0]);
	}
	const lastExc = (pattern: RegExp): string | null => {
		let found: string | null = null;
		for (const line of lines) { const match = pattern.exec(line); if (match) found = match[1]!; }
		return found;
	};
	const excName = lastExc(/(?:^|\s)([A-Za-z_]\w{0,60}(?:Error|Exception|Warning|Interrupt|Exit))\s*:/)
		?? lastExc(/(?:^|\s)([A-Za-z_]\w{1,60}(?:Error|Exception|Warning|Interrupt|Exit))\b/);
	if (excName) {
		if (/timeout/i.test(excName)) return finding(`timeout:${toolName(tool)}`);
		const lower = excName.toLowerCase();
		const cause = lower === "filenotfounderror" ? "path-not-found" : lower === "modulenotfounderror" ? "module-not-found" : lower;
		return finding(`agent-input:${toolName(tool)}:${cause}`);
	}
	if (lines.some(line => line.includes("Traceback (most recent call last):"))) {
		return finding(`agent-input:${toolName(tool)}:python-error`);
	}
	const jsonCode = lines.map(line => line.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]{2,60})"/)).find(Boolean);
	if (jsonCode) {
		if (codeName(jsonCode[1]!) !== null) return finding(`tool-error:${toolName(tool)}:${slug(jsonCode[1]!)}`, jsonCode[0]);
	}
	// LEDGERCLASS1: kit envelopes carry their verdict as data, not prose: the reader above parses
	// JSON diagnostics into layers, so name the structured verdicts with the same classes as text.
	// The caller's own labels (layers[0]) never count: only the record's own fields do (JEVDOCTOR1).
	const structuredVerdict = (): string | null => {
		const seen = new Set<unknown>();
		const visit = (value: unknown): string | null => {
			if (value === null || typeof value !== "object" || seen.has(value)) return null;
			seen.add(value);
			if (Array.isArray(value)) {
				for (const item of value) { const found = visit(item); if (found) return found; }
				return null;
			}
			const record = value as Record<string, unknown>;
			const code = typeof record.code === "string" ? record.code : "";
			if (/^[A-Z][A-Z0-9_]*_REFUSED$/.test(code)) return `guard-friction:${code}`;
			if (code === "INVALID_ARGUMENTS") return `agent-input:${toolName(tool)}:invalid-arguments`;
			if (record.status === "RED") return `tool-error:${toolName(tool)}:red-verdict`;
			if (record.outcome === "partial" || record.outcome === "unavailable") return `tool-error:${toolName(tool)}:incomplete-result`;
			if (record.outcome === "conflict") return `tool-error:${toolName(tool)}:version-conflict`;
			if (record.delivery === "blocked") return `tool-error:${toolName(tool)}:delivery-blocked`;
			if (record.outcome === "complete") return `tool-error:${toolName(tool)}:wrapper-failed`;
			if (typeof record.overall === "string" && /^[A-Z][A-Z0-9_]*_(?:REQUIRED|REFUSED)$/.test(record.overall)) return `guard-friction:${record.overall}`;
			if (record.overall === "UNVERIFIED") return `finding:${toolName(tool)}`;
			if (record.status === "BACKOFF") return `tool-error:${toolName(tool)}:upstream-backoff`;
			if (record.status === 503 || record.bridgeStatus === 503) return `tool-error:${toolName(tool)}:upstream-unavailable`;
			if (record.error === "injected") return `tool-error:${toolName(tool)}:injected-fault`;
			if (code !== "FINDING" && /^[A-Z][A-Z0-9_]{2,60}$/.test(code) && codeName(code) !== null) return `tool-error:${toolName(tool)}:${toolName(code)}`;
			for (const key of ["errors", "error", "data", "result", "details"] as const) {
				const found = visit(record[key]);
				if (found) return found;
			}
			return null;
		};
		for (let index = 1; index < layers.length; index++) {
			const found = visit(layers[index]);
			if (found) return found;
		}
		return null;
	};
	const structured = structuredVerdict();
	if (structured) return finding(structured);
	// JEVDOCTOR1 (ompkit-fp72.120.16.161): a failed record that carries its own contract code is
	// that class, never unclassified. Only the record's own `code` counts: a guard rule on a failed
	// call is not its cause. The kit's exit-1 class FINDING is a check's answer, kept visible.
	const ownCode = text(root?.code);
	if (failed && ownCode.length <= 96 && /^[A-Z][A-Z0-9_]*$/.test(ownCode)) {
		const name = toolName(tool);
		return ownCode === "FINDING"
			? finding(`finding:${name}`, body || `${name} exited with a FAIL finding (exit class FINDING)`)
			: finding(`tool-error:${name}:${toolName(ownCode)}`, body || `${name} failed with ${ownCode}`);
	}
	// RECLASS2: a command that exited nonzero and printed nothing but its exit status names that
	// cause: the next step is to rerun with its diagnostics, not to look for a guard. Ledger replays
	// carry the same text whitespace-collapsed onto one line, so the check runs on the joined body.
	const statusOnly = lines.join(" ").replace(/\s+/g, " ").trim();
	if (failed && statusOnly.length <= 200
		&& /^(?:(?:\(no output\)|exit=-?\d{1,3}|-?\d{1,3}|Wall time: \d{1,6}(?:\.\d{1,3})? seconds) )*Command exited with code -?\d{1,3}$/.test(statusOnly))
		return finding(`tool-error:${toolName(tool)}:silent-exit`);
	return failed ? finding("tool-error:unclassified") : null;
}

/** GATEBUDGETHYGIENE1 (ompkit-1ra0d.129): the gate-events gate for a classifier class.
 * Classifier exhaust is not a refusal and writes no refusal row: a check's own FINDING
 * answer (`finding:*`), an MCP transport failure (`mcp-transport:*`), the guard's own
 * name with no code, and a member hook's duplicate (`commit-refusal:*`, whose real row
 * the hook already wrote) all map to null. A derived guard class (`guard-friction:<code>`)
 * maps to its real code so one refusal writes one row. Every other class (agent-input:*,
 * tool-error:*, validation:*, timeout:*, assertion:*, bare gate codes) passes through: the
 * TURN line excludes the non-refusals itself and tolerates the old rows already filed. */
export function budgetLedgerGate(classId: string): string | null {
	if (classId === "kit-flywheel-guard" || classId === "kit-flywheel-guard:") return null;
	if (classId.startsWith("finding:") || classId.startsWith("mcp-transport:")) return null;
	if (classId.startsWith("commit-refusal:")) return null;
	if (classId.startsWith("guard-friction:")) {
		const real = classId.slice("guard-friction:".length);
		if (real === "" || real === "kit-flywheel-guard") return null;
		return real;
	}
	return classId;
}
