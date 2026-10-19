/**
 * secret-output-guard (ompkit-fp72.87 SECRETOUT1): kit-owned pre-emission
 * tool-output protection.
 *
 * Covers, with synthetic sentinels only (never real credentials):
 *   (a) gh auth metadata / token-shaped output (ghp_/gho_/github_pat_/hosts.yml
 *       oauth_token) -> SHA-256 fingerprint prefix (first 16 hex), the same
 *       semantics as src/gh-doctor.ts `fingerprint_prefix`. Safe metadata
 *       (usernames, scopes, status, remedy) passes through byte-identical.
 *   (a) `security find-generic-password` output through truncating/prefix
 *       consumers: the `password: "..."` value is redacted BEFORE any
 *       truncation, so first-byte prefixes cannot leak.
 *   (b) `cf-secret --list` with newline/multiline values -> key names only.
 *       Continuation lines, value fragments and escaped equivalents are dropped.
 *   (G8) registration_token/sender_token and equivalent binding fields nested in
 *       tool arguments, AgentMail records, session-preview output and exceptions:
 *       redacted BEFORE truncation/rendering. Non-secret identifiers and counts
 *       are preserved.
 *
 * Seam: the pure scrub functions below are the enforcement point. The default
 * OMP extension delegates `tool_execution_end` to them and returns the OMP
 * final-result replacement envelope ({content, details, isError}, cf. the
 * extensions/wrapper.ts hook cited on the bead) when sensitive material is
 * found, and undefined otherwise so credential-use/action-direct behavior is
 * preserved. Live no-emission proof still needs the deployed OMP integration
 * and actual owner acceptance (recorded on the bead); this module is the
 * kit-owned candidate under test, not a containment claim.
 */
import { createHash } from "node:crypto";

export const REDACTED = "[REDACTED]";
export const FINGERPRINT_HEX = 16;

/** First 16 hex chars of the SHA-256 digest; a one-way marker, never token bytes. */
export function fingerprintOfSecret(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex").slice(0, FINGERPRINT_HEX);
}

const GH_CLASSIC = /\bgh[po]_[A-Za-z0-9]{8,}/g;
const GH_FINE_GRAINED = /\bgithub_pat_[A-Za-z0-9_]{8,}/g;
const HOSTS_OAUTH_TOKEN = /^([ \t]*oauth_token[ \t]*:[ \t]*)(\S+)[ \t]*$/gm;
const SECURITY_PASSWORD = /(password[ \t]*:[ \t]*)(?:"[^"\n]*"|'[^'\n]*')/g;

/** gh token-shaped values -> `fp:<16hex>`; safe metadata untouched. */
export function redactGhTokenShapes(text: string): string {
	// Hosts lines first: otherwise the classic shape would eat the oauth value
	// and the hosts pass would fingerprint the fingerprint marker instead.
	return text
		.replace(HOSTS_OAUTH_TOKEN, (_match, lead: string, value: string) => `${lead}fp:${fingerprintOfSecret(value)}`)
		.replace(GH_CLASSIC, (match) => `fp:${fingerprintOfSecret(match)}`)
		.replace(GH_FINE_GRAINED, (match) => `fp:${fingerprintOfSecret(match)}`);
}
/** `security` credential-read output: the password value is redacted pre-emission. */
export function redactSecurityPasswordOutput(text: string): string {
	return text.replace(SECURITY_PASSWORD, `$1"${REDACTED}"`);
}

/** Every pre-emission text scrub: gh shapes + security password values. */
export function scrubText(text: string): string {
	return redactSecurityPasswordOutput(redactGhTokenShapes(text));
}

/**
 * Preview-safe text: scrub FIRST, then truncate. A prefix consumer of the
 * return value can never see secret first-bytes.
 */
export function previewText(text: string, maxChars: number): string {
	return scrubText(text).slice(0, Math.max(0, maxChars));
}

const DOTENV_NAME = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

/**
 * `cf-secret --list` output -> key names only, one per line. Value-bearing
 * lines yield their name; continuation lines of multiline values, blanks and
 * anything without a `NAME=` lead are dropped, so no value fragment or escaped
 * equivalent is ever emitted. Order and duplicates are preserved as printed.
 */
export function cfSecretListNamesOnly(text: string): string {
	const names: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = DOTENV_NAME.exec(line);
		if (match) names.push(match[1]!);
	}
	return names.join("\n") + (names.length > 0 ? "\n" : "");
}

/**
 * The naive old-helper specimen: first-line `cut -d= -f1` style extraction.
 * Kept so tests can show it passes continuation lines of multiline values
 * through (the mutant that must fail); never use it for emission.
 */
export function legacyListFirstField(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => line.split("=")[0]!)
		.join("\n") + "\n";
}

/** Binding/capability fields whose string values must never reach a preview. */
const BINDING_KEYS: Record<string, true> = {
	registration_token: true,
	sender_token: true,
	bearer_token: true,
	session_token: true,
	access_token: true,
	refresh_token: true,
	auth_token: true,
};

/**
 * Deep redaction of binding fields. Objects/arrays keep their shape (counts
 * preserved); non-secret identifiers and non-string values pass through;
 * string values under a binding key become `[REDACTED]`. All other string
 * leaves get the text scrub (gh/security shapes inside nested output).
 */
export function redactBindingFields(value: unknown): unknown {
	if (typeof value === "string") return scrubText(value);
	if (Array.isArray(value)) return value.map(redactBindingFields);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = typeof entry === "string" && BINDING_KEYS[key.toLowerCase()] === true ? REDACTED : redactBindingFields(entry);
		}
		return out;
	}
	return value;
}

/** Object field read without prototype surprises; undefined for anything else. */
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}

function contentBlocksText(blocks: unknown): string | null {
	if (!Array.isArray(blocks)) return null;
	const parts: string[] = [];
	for (const block of blocks) {
		if (field(block, "type") !== "text") continue;
		const text = field(block, "text");
		if (typeof text === "string") parts.push(text);
	}
	return parts.length > 0 ? parts.join("") : null;
}

const RESULT_TEXT_KEYS = ["content", "text", "output", "stdout", "stderr"] as const;

/** Best-effort result text across OMP's native and older envelope shapes. */
export function resultTextOf(result: unknown): string | null {
	if (typeof result === "string") return result;
	if (result === null || typeof result !== "object") return null;
	const record = result as Record<string, unknown>;
	if (Array.isArray(record["content"])) return contentBlocksText(record["content"]);
	for (const key of RESULT_TEXT_KEYS) {
		const candidate = key in record ? record[key] : undefined;
		if (typeof candidate === "string") return candidate;
		const nested = field(record["details"], key);
		if (typeof nested === "string") return nested;
	}
	const message = field(record, "message");
	if (typeof message === "string") return message;
	return null;
}

export interface ScrubbedResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError: unknown;
}

/**
 * Pre-emission rewrite of one tool result. Returns undefined when the result
 * carries no secret-shaped material (behavior preserved: no rewrite). When
 * `cfSecretList` is true the text is a `cf-secret --list` capture and is
 * reduced to key names only. Binding fields are redacted across the whole
 * envelope, not just `details`, so structured tokens beside the text
 * (exceptions, AgentMail records) are covered too.
 */
export function scrubToolResult(result: unknown, opts?: { cfSecretList?: boolean }): ScrubbedResult | undefined {
	const text = resultTextOf(result);
	const clean = text === null ? null : opts?.cfSecretList === true ? cfSecretListNamesOnly(text) : scrubText(text);
	const redacted = redactBindingFields(result);
	const textChanged = clean !== null && clean !== text;
	const shapeChanged = JSON.stringify(redacted) !== JSON.stringify(result);
	if (!textChanged && !shapeChanged) return undefined;
	const priorContent = field(result, "content");
	return {
		content: textChanged || !Array.isArray(priorContent) ? (clean !== null ? [{ type: "text", text: clean }] : []) : priorContent as Array<{ type: "text"; text: string }>,
		details: field(redacted, "details") ?? {},
		isError: field(result, "isError"),
	};
}

const CF_SECRET_LIST = /(?:^|[;&|]\s*|["'`\s])cf-secret(?:\s+[^\s;&|]+)*\s+(?:--list\b|list\b)/;

/** True for a `cf-secret --list`/`cf-secret list` bash command (any scope flags ok). */
export function isCfSecretListCommand(command: string): boolean {
	return CF_SECRET_LIST.test(command);
}


export interface SecretGuardToolCallEvent {
	type?: "tool_call";
	toolCallId?: unknown;
	toolName?: unknown;
	input?: unknown;
}

export interface SecretGuardExecutionEndEvent {
	type?: "tool_execution_end";
	toolCallId?: unknown;
	toolName?: unknown;
	result?: unknown;
	isError?: unknown;
}

export interface SecretGuardApi {
	on(event: "tool_call", handler: (event: SecretGuardToolCallEvent) => unknown): void;
	on(event: "tool_execution_end", handler: (event: SecretGuardExecutionEndEvent) => unknown): void;
}

/**
 * OMP extension: remembers bash commands per toolCallId at `tool_call`
 * (observational), then rewrites `tool_execution_end` results through
 * scrubToolResult — names-only for `cf-secret --list` captures, full scrub
 * otherwise. Returns undefined when there is nothing to rewrite.
 */
export default async function secretOutputGuard(pi: SecretGuardApi): Promise<void> {
	const commands = new Map<unknown, string>();
	pi.on("tool_call", (event) => {
		const command = field(event.input, "command");
		if (typeof command === "string") commands.set(event.toolCallId, command);
		return undefined;
	});
	pi.on("tool_execution_end", (event) => {
		const command = commands.get(event.toolCallId);
		commands.delete(event.toolCallId);
		const cfSecretList = command !== undefined && isCfSecretListCommand(command);
		return scrubToolResult(event.result, { cfSecretList }) ?? undefined;
	});
}
