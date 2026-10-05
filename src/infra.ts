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
