/**
 * TOOL1: toolchain pins the kit's gates run on.
 *
 * Pure parse/compare over the infra pin file; installed versions are injected
 * by the caller (the CLI reads them via spawn), so this module never touches
 * the toolchain it judges. Fail-closed: any malformed pin file parses to null.
 */

export interface InfraPin {
	version: string;
	receipt: string;
}

export interface InfraPins {
	tools: Record<string, InfraPin>;
}

export interface InfraDrift {
	tool: string;
	pinned: string;
	installed: string | null;
}

/** Type guard: a pin is a version plus the receipt that certified it. */
function isPin(value: unknown): value is InfraPin {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!("version" in value) || !("receipt" in value)) return false;
	return typeof value.version === "string" && value.version.length > 0 &&
		typeof value.receipt === "string" && value.receipt.length > 0;
}

/** Parse pin file text; null when missing, malformed, or carrying no pins. */
export function parseInfraPins(text: string): InfraPins | null {
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("tools" in parsed)) return null;
	const tools = parsed.tools;
	if (!tools || typeof tools !== "object" || Array.isArray(tools)) return null;
	const entries = Object.entries(tools);
	if (entries.length === 0) return null;
	const pins: Record<string, InfraPin> = {};
	for (const [name, value] of entries) {
		if (!isPin(value)) return null;
		pins[name] = { version: value.version, receipt: value.receipt };
	}
	return { tools: pins };
}

/** One row per pinned tool whose installed version differs (or is unknown). */
export function diffInfraPins(pins: InfraPins, installed: Record<string, string | null>): InfraDrift[] {
	const drift: InfraDrift[] = [];
	for (const [tool, pin] of Object.entries(pins.tools).sort(([a], [b]) => a.localeCompare(b))) {
		const have = installed[tool] ?? null;
		if (have !== pin.version) drift.push({ tool, pinned: pin.version, installed: have });
	}
	return drift;
}

export interface InfraExec {
	run(argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): Promise<{ code: number; out: string }>;
}

export interface LadderStage {
	label: string;
	status: "GREEN" | "RED";
	producerRc: number;
}

export interface InfraCheckReport {
	tool: string;
	version: string;
	status: "PASS" | "FAIL";
	failedStage: string | null;
	stages: LadderStage[];
	logTail: string;
}

const GREEN_STAGE = /^GREEN (\S+) producer_rc=(\d+)\s*$/;
const RED_STAGE = /^RED\s+(\S+) producer_rc=(-?\d+)/;

/**
 * TOOL1 check: run the kit ladder in a child whose PATH prefers the candidate
 * prefix, then name the failing stage. The child inherits nothing else; the
 * machine toolchain is untouched (PATH is set on the child env only).
 * Per-tool acquisition URLs are resolved by the caller, not here.
 */
export async function checkInfraCandidate(input: {
	tool: string;
	version: string;
	repoRoot: string;
	pathPrefix: string;
	baseEnv: Record<string, string>;
	exec: InfraExec;
}): Promise<InfraCheckReport> {
	const out = await input.exec.run(["/bin/sh", "scripts/ladder.sh"], {
		cwd: input.repoRoot,
		env: { ...input.baseEnv, PATH: `${input.pathPrefix}/bin:${input.baseEnv["PATH"] ?? "/usr/bin:/bin"}` },
	}).then(result => result.out).catch((error: unknown) => `RED ladder-spawn producer_rc=1\n${error instanceof Error ? error.message : String(error)}`);
	const stages: LadderStage[] = [];
	for (const line of out.split("\n")) {
		const green = GREEN_STAGE.exec(line.trim());
		if (green) {
			stages.push({ label: green[1] ?? "unknown", status: "GREEN", producerRc: Number(green[2]) });
			continue;
		}
		const red = RED_STAGE.exec(line.trim());
		if (red) stages.push({ label: red[1] ?? "unknown", status: "RED", producerRc: Number(red[2]) });
	}
	const failed = stages.find(stage => stage.status === "RED") ?? null;
	const green = out.split("\n").some(line => line.trim() === "LADDER: GREEN");
	return { tool: input.tool, version: input.version,
		status: failed === null && green ? "PASS" : "FAIL",
		failedStage: failed?.label ?? (green ? null : "ladder-incomplete"),
		stages, logTail: out.slice(-2000) };
}

/**
 * Bump one tool's version line inside its [tools.<name>] section, keeping
 * receipt lines, comments and layout byte-identical otherwise. Null when the
 * section or its version line is absent (fail-closed, never invents TOML).
 * With a receipt, the section's receipt line is set to it as well.
 */
export function updatePinVersion(text: string, tool: string, version: string, receipt?: string): string | null {
	const escaped = tool.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`);
	const lines = text.split("\n");
	const section = new RegExp(`^\\[tools\\.${escaped}\\]\\s*$`);
	let at = -1;
	for (let index = 0; index < lines.length; index++) {
		if (section.test(lines[index] ?? "")) {
			at = index;
			break;
		}
	}
	if (at < 0) return null;
	let versioned = false;
	let receipted = receipt === undefined;
	for (let index = at + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (/^\s*\[/.test(line)) break;
		const versionMatch = /^(\s*version\s*=\s*)"[^"]*"(.*)$/.exec(line);
		if (versionMatch && !versioned) {
			lines[index] = `${versionMatch[1]}"${version}"${versionMatch[2] ?? ""}`;
			versioned = true;
			continue;
		}
		const receiptMatch = /^(\s*receipt\s*=\s*)"[^"]*"(.*)$/.exec(line);
		if (receiptMatch && receipt !== undefined && !receipted) {
			lines[index] = `${receiptMatch[1]}"${receipt}"${receiptMatch[2] ?? ""}`;
			receipted = true;
		}
	}
	if (!versioned || !receipted) return null;
	return lines.join("\n");
}

export interface PromoteCheck {
	tool: string;
	version: string;
	status: "PASS" | "FAIL";
}

export interface PromoteReceipt {
	tool: string;
	from: string;
	to: string;
	check: "PASS";
	at: string;
}

export type PromoteResult =
	| { status: "REFUSED"; reason: string }
	| { status: "PROMOTED"; receipt: PromoteReceipt; pins: InfraPins }
	| { status: "FAILED"; reason: string };

/**
 * TOOL1 promote: move one pinned tool to a checked version. Refuses without
 * explicit human authorization and without a PASSING check for the exact
 * candidate; the installer is injected so tests prove the call sequence.
 * Undo is a second promote back, not a special case (see undoPromote).
 */
export async function promoteInfra(input: {
	tool: string;
	version: string;
	pins: InfraPins;
	check: PromoteCheck;
	human: boolean;
	install: (tool: string, version: string) => Promise<boolean>;
	nowIso?: string;
}): Promise<PromoteResult> {
	if (!input.human) {
		return { status: "REFUSED", reason: "Human authorization required: Josh promotes, agents prepare the check." };
	}
	const current = input.pins.tools[input.tool];
	if (!current) return { status: "REFUSED", reason: `Unknown tool ${input.tool}; the pin file governs the promoted set.` };
	if (input.check.status !== "PASS" || input.check.tool !== input.tool || input.check.version !== input.version) {
		return { status: "REFUSED", reason: `No passing check for ${input.tool} ${input.version}; run infra check first.` };
	}
	if (current.version === input.version) {
		return { status: "REFUSED", reason: `${input.tool} is already pinned at ${input.version}; nothing to promote.` };
	}
	const installed = await input.install(input.tool, input.version);
	if (!installed) return { status: "FAILED", reason: `Installer reported failure for ${input.tool} ${input.version}; pin unchanged.` };
	return { status: "PROMOTED",
		receipt: { tool: input.tool, from: current.version, to: input.version, check: "PASS", at: input.nowIso ?? new Date().toISOString() },
		pins: { tools: { ...input.pins.tools, [input.tool]: { version: input.version, receipt: current.receipt } } } };
}

/**
 * Undo a promotion by promoting back: reinstalls the receipt's from-version
 * and returns pins showing it. The rollback target needs its own PASSING
 * check like any promote; nothing here fabricates one.
 */
export async function undoPromote(input: {
	receipt: PromoteReceipt;
	pins: InfraPins;
	check: PromoteCheck;
	human: boolean;
	install: (tool: string, version: string) => Promise<boolean>;
	nowIso?: string;
}): Promise<PromoteResult> {
	if (!input.human) {
		return { status: "REFUSED", reason: "Human authorization required: Josh promotes, agents prepare the check." };
	}
	return promoteInfra({ tool: input.receipt.tool, version: input.receipt.from,
		pins: input.pins, check: input.check, human: true, install: input.install, nowIso: input.nowIso });
}
