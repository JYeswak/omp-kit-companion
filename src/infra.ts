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
		stages };
}
