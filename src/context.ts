import { isAbsolute } from "node:path";
import { type Finding } from "./diagnostics.ts";
import { readBoundedFile } from "./external-pack.ts";
import { runBundled } from "./runtime.ts";

const HARNESS = "scripts/context-inventory.ts";
const CAPABILITIES_MAX_BYTES = 64 * 1024;

export interface ContextRunInput {
	/** Release root carrying scripts/context-inventory.ts. */
	root: string;
	/** Compiled release executable selecting the release root. */
	executablePath: string;
	/** Inspected HOME (operator or isolated fixture); never written. */
	home: string;
	/** OMP profile name, or "default". */
	profile: string;
	/** Inspected project cwd for project-scoped discovery. */
	project: string;
	/** Harness budget in ms; 5000..600000 when set. */
	timeoutMs?: number;
}

export interface CapabilitiesRunInput extends ContextRunInput {
	/** Absolute declared-capabilities JSON file. */
	capabilitiesPath: string;
}

export type CapabilityStatus = "RESOLVED" | "HIDDEN_BUT_READABLE" | "MISSING";

export interface CapabilityVerdict {
	kind: string;
	name: string;
	status: CapabilityStatus;
	detail: string;
}

export interface ContextInventory {
	status: "OK";
	scope: "CONTEXT_INVENTORY";
	project: string;
	knobs: Record<string, unknown>;
	skills: {
		active: number; listed: number; listed_bytes: number;
		hidden: number; hidden_names: string[]; discovered: number;
		rows: { name: string; description: string; hide: boolean; source: string; filePath: string; listed_bytes: number }[];
	};
	context_files: { count: number; bytes: number; rows: { path: string; bytes: number }[] };
	rules: { count: number; bytes: number; bytes_known: boolean; rows: { name: string; path: string; bytes: number | null }[] };
	tools: {
		builtin: number; builtin_names: string[]; hidden_builtin_names: string[];
		custom: string[]; mcp_servers: { name: string; state: string }[];
		inline_descriptors: string; inline_descriptors_reason: string;
	};
	lsp: { enabled: unknown; languages: Record<string, string[]> };
}

export interface CapabilitiesReport extends ContextInventory {
	scope: "CAPABILITY_CHECK";
	overall: "PASS" | "FAIL";
	missing: number;
	capabilities: CapabilityVerdict[];
}

export class ContextInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ContextInputError";
	}
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validateProfileName(value: unknown): string {
	if (typeof value !== "string" || !PROFILE_NAME.test(value) || value.endsWith(".")) {
		throw new ContextInputError("INVALID_PROFILE", "Selected profile name is not a safe OMP profile name");
	}
	return value;
}

function baseArgs(input: ContextRunInput): string[] {
	if (![input.root, input.executablePath, input.home, input.project].every(path => typeof path === "string" && isAbsolute(path))) {
		throw new ContextInputError("INVALID_CONTEXT_SELECTION", "Release root, executable, HOME and project must be absolute paths");
	}
	validateProfileName(input.profile);
	if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 5_000 || input.timeoutMs > 600_000)) {
		throw new ContextInputError("INVALID_TIMEOUT", "Context timeout must be an integer from 5000 through 600000");
	}
	return ["--home", input.home, "--profile", input.profile, "--project", input.project,
		...(input.timeoutMs === undefined ? [] : ["--timeout-ms", String(input.timeoutMs)])];
}

function parseEnvelope(stdout: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new ContextInputError("INVALID_INVENTORY", "Context harness did not return JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ContextInputError("INVALID_INVENTORY", "Context harness returned a non-object envelope");
	}
	return parsed as Record<string, unknown>;
}

function harnessFailure(code: number, stdout: string): ContextInputError {
	let reason = "CONTEXT_UNAVAILABLE";
	try {
		const parsed = JSON.parse(stdout) as { reason?: unknown };
		if (parsed && typeof parsed.reason === "string" && parsed.reason.length > 0) reason = parsed.reason;
	} catch { /* keep the default reason */ }
	if (code === 2) return new ContextInputError(reason, `Context selection was refused: ${reason}`);
	return new ContextInputError(reason, `Context inventory could not complete: ${reason}`);
}

function isInventory(value: Record<string, unknown>): value is ContextInventory & { status: "OK" } {
	return value.status === "OK" && value.scope === "CONTEXT_INVENTORY"
		&& typeof value.skills === "object" && value.skills !== null;
}

/** Read-only listing-cost report through OMP's own loaders; the inspected HOME is never written. */
export async function runContextInventory(input: ContextRunInput): Promise<ContextInventory> {
	const result = await runBundled(HARNESS, [...baseArgs(input), "--mode", "inventory"], input.root, input.executablePath)
		.catch((error: unknown) => {
			throw new ContextInputError("CONTEXT_UNAVAILABLE", error instanceof Error ? error.message : String(error));
		});
	if (result.code !== 0) throw harnessFailure(result.code, result.stdout);
	const envelope = parseEnvelope(result.stdout);
	if (!isInventory(envelope)) throw new ContextInputError("INVALID_INVENTORY", "Context harness returned an unexpected inventory shape");
	return envelope;
}

function isCapabilitiesReport(value: Record<string, unknown>): value is CapabilitiesReport {
	return value.status === "OK" && value.scope === "CAPABILITY_CHECK"
		&& (value.overall === "PASS" || value.overall === "FAIL") && Array.isArray(value.capabilities);
}

/** Required-capability check; exit mapping is the caller's (PASS 0, FAIL 1). */
export async function runCapabilitiesCheck(input: CapabilitiesRunInput): Promise<CapabilitiesReport> {
	readBoundedFile(input.capabilitiesPath, CAPABILITIES_MAX_BYTES, "Capabilities JSON");
	const result = await runBundled(HARNESS,
		[...baseArgs(input), "--mode", "check", "--capabilities", input.capabilitiesPath], input.root, input.executablePath)
		.catch((error: unknown) => {
			throw new ContextInputError("CONTEXT_UNAVAILABLE", error instanceof Error ? error.message : String(error));
		});
	if (result.code !== 0) throw harnessFailure(result.code, result.stdout);
	const envelope = parseEnvelope(result.stdout);
	if (!isCapabilitiesReport(envelope)) {
		throw new ContextInputError("INVALID_INVENTORY", "Capabilities harness returned an unexpected check shape");
	}
	return envelope;
}

/** Doctor finding for --scope context. */
export function contextFinding(inventory: ContextInventory, profile: string, profileSource: string): Finding {
	const skills = inventory.skills;
	const reason = `Prompt listing: ${skills.listed} skills (${skills.listed_bytes} bytes), ` +
		`${inventory.context_files.count} context files (${inventory.context_files.bytes} bytes), ` +
		`${inventory.rules.count} rules (${inventory.rules.bytes_known ? `${inventory.rules.bytes} bytes` : "builtins without file bytes"}), ` +
		`${inventory.tools.builtin} builtin + ${inventory.tools.custom.length} custom tools, ` +
		`${inventory.tools.mcp_servers.length} declared MCP servers; ${skills.hidden} listed-hidden skills. ` +
		`Inline descriptor bytes are UNVERIFIED without a live session.`;
	return { component: "context", status: "OK", reason,
		recommended_action: "Prune with OMP's native skill knobs, then re-run test --capabilities to confirm required capabilities still resolve.",
		evidence: { profile_selected: profile, profile_source: profileSource, project: inventory.project,
			knobs: inventory.knobs, skills: inventory.skills, context_files: inventory.context_files,
			rules: inventory.rules, tools: inventory.tools, lsp: inventory.lsp } };
}
