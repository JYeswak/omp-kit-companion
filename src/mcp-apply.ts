import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyMutation, ensureMutationStateRoot, inspectPendingMutations, planMutation, undoMutation, writePrivate, type FileMutation, type Image, type MutationPlan } from "./mutations.ts";
import { looksSecret, parseSourceEntry, record, secretArgIndexes, SERVER_NAME, type McpSource, type OmpProfileDir, type SourceServer } from "./mcp-sources.ts";

/**
 * Writes OMP's own mcp.json schema directly. OMP's native writer cannot carry an imported server:
 * headless `/mcp add` (slash-commands/helpers/mcp.ts buildMcpServerConfig) builds only
 * {type, command, args} or {url, Authorization: Bearer <literal>}; no env, cwd or timeout.
 */
export class McpApplyError extends Error {
	constructor(readonly code: string, message: string, readonly findings: readonly Record<string, unknown>[] = []) {
		super(message);
		this.name = "McpApplyError";
	}
}

export interface McpOverride { name: string; path: string; sha256: string; server: SourceServer }
export interface McpApplyInput {
	source: McpSource;
	servers: readonly string[];
	profiles: readonly OmpProfileDir[];
	stateRoot: string;
	/** Installed OMP src/config/mcp-schema.json, parsed. */
	schema: unknown;
	schemaPath: string;
	/** Server name -> OMP `timeout` ms; it bounds the connect handshake as well as each request (mcp/client.ts connectToServer). */
	timeouts?: ReadonlyMap<string, number>;
	/** Env keys whose source value is copied verbatim after the secret scan; every other env value becomes a reference. */
	envLiteral?: ReadonlySet<string>;
	overrides?: readonly McpOverride[];
	env?: Record<string, string | undefined>;
}
export interface RenderedServer {
	name: string;
	config: Record<string, unknown>;
	/** Same shape with literal env values masked; used for diffs and output. */
	display: Record<string, unknown>;
	env_refs: { key: string; var: string }[];
	env_literal: string[];
	env_unset: string[];
	override: string | null;
}
export interface McpProfilePlan {
	profile: string;
	path: string;
	action: "ADD" | "EDIT" | "NO_CHANGE" | "SKIPPED";
	reason?: string;
	/** Insert mode: server names added; edit mode: edit labels applied. */
	added: string[];
	already_present: string[];
	/** Insert mode: names whose existing entry differs; edit mode: edits that do not apply to this profile. */
	conflicts: string[];
	diff: string;
	before_sha256: string | null;
	after_sha256: string | null;
}
/** `env.KEY` of an existing server becomes an OMP `!command` value. */
export interface McpEnvCommand { server: string; key: string; command: string }
export interface McpApplyPlan {
	/** Null in edit mode (--env-command / --enable), which reads no source. */
	source: { id: string; path: string } | null;
	servers: Omit<RenderedServer, "config">[];
	edits: { env_commands: McpEnvCommand[]; enable: string[] } | null;
	profiles: McpProfilePlan[];
	overrides: { name: string; path: string; sha256: string }[];
	schema: { path: string; validated: true };
	stateRoot: string;
	mutation: MutationPlan | null;
	/** Internal: per touched profile, the mcpServers entries the written file must hold (pre-existing ones unchanged), for readback. */
	readonly existing: ReadonlyMap<string, Record<string, unknown>>;
}

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPANSION = /\$\{[A-Za-z_]/;

/** OMP resolves an env value as an env-var name, else a `!command`, else the literal (config/resolve-config-value.ts). */
function envReference(key: string, value: string): string {
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	return braced?.[1] ?? key;
}

export function renderServer(server: SourceServer, options: { timeoutMs?: number; envLiteral?: ReadonlySet<string>; env?: Record<string, string | undefined>; override?: string | null }): RenderedServer {
	const env = options.env ?? process.env;
	for (const [field, value] of [["command", server.command], ["cwd", server.cwd], ["url", server.url], ...(server.args ?? []).map((arg, index) => [`args[${index}]`, arg])] as [string, string | undefined][])
		if (value !== undefined && EXPANSION.test(value))
			throw new McpApplyError("UNSUPPORTED_EXPANSION", `Server ${server.name}: OMP does not expand \${VAR} in ${field}`, [{ server: server.name, field }]);
	const config: Record<string, unknown> = { type: server.transport };
	if (server.transport === "stdio") {
		config.command = server.command;
		if (server.args?.length) config.args = [...server.args];
		if (server.cwd !== undefined) config.cwd = server.cwd;
	} else config.url = server.url;
	const display: Record<string, unknown> = { ...config };
	const envRefs: RenderedServer["env_refs"] = [], envLiteral: string[] = [], envUnset: string[] = [];
	const keys = Object.keys(server.env);
	if (keys.length) {
		const rendered: Record<string, string> = {}, shown: Record<string, string> = {};
		for (const key of keys) {
			const value = server.env[key]!;
			if (options.envLiteral?.has(key)) {
				rendered[key] = value;
				shown[key] = `<literal ${Buffer.byteLength(value)} bytes>`;
				envLiteral.push(key);
				continue;
			}
			const name = envReference(key, value);
			rendered[key] = shown[key] = name;
			envRefs.push({ key, var: name });
			if (env[name] === undefined) envUnset.push(name);
		}
		config.env = rendered;
		display.env = shown;
	}
	const headerKeys = Object.keys(server.headers);
	if (headerKeys.length) {
		// `${VAR}` becomes the OMP env-name form; any other literal is left for the secret scan to refuse.
		const rendered: Record<string, string> = {};
		for (const key of headerKeys) {
			const value = server.headers[key]!;
			rendered[key] = value.startsWith("$") ? envReference(key, value) : value;
		}
		config.headers = display.headers = rendered;
	}
	if (options.timeoutMs !== undefined) config.timeout = display.timeout = options.timeoutMs;
	if (!server.enabled) config.enabled = display.enabled = false;
	return { name: server.name, config, display, env_refs: envRefs, env_literal: envLiteral, env_unset: envUnset, override: options.override ?? null };
}

/** An env-var NAME reference, or an OMP `!command` whose text holds no likely credential. */
function referenceValue(value: string): boolean {
	return ENV_NAME.test(value) || (value.startsWith("!") && value.slice(1).trim() !== "" && !looksSecret(value.slice(1)));
}

/** PUB1: refuse a rendered server holding a likely literal credential. Findings carry field paths, never values. */
export function scanRenderedSecrets(name: string, config: Record<string, unknown>, envLiteral: ReadonlySet<string> = new Set()): Record<string, unknown>[] {
	const findings: Record<string, unknown>[] = [];
	for (const field of ["command", "cwd", "url"] as const)
		if (typeof config[field] === "string" && looksSecret(config[field] as string)) findings.push({ server: name, field });
	if (Array.isArray(config.args)) for (const index of secretArgIndexes(config.args as string[])) findings.push({ server: name, field: `args[${index}]` });
	if (record(config.env)) for (const [key, value] of Object.entries(config.env)) {
		if (typeof value !== "string") continue;
		if (envLiteral.has(key) ? looksSecret(value) : !referenceValue(value)) findings.push({ server: name, field: `env.${key}` });
	}
	if (record(config.headers)) for (const [key, value] of Object.entries(config.headers))
		if (typeof value !== "string" || !referenceValue(value)) findings.push({ server: name, field: `headers.${key}` });
	return findings;
}

const SCHEMA_KEYWORDS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "type", "properties", "additionalProperties",
	"required", "propertyNames", "pattern", "items", "uniqueItems", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "enum", "const",
	"$ref", "$defs", "allOf", "anyOf", "oneOf", "not"]);
/** Minimal JSON Schema validator for the keywords OMP's mcp-schema.json uses; an unknown keyword fails closed. */
export function validateJsonSchema(value: unknown, schema: unknown, root: unknown = schema, path = "$"): string[] {
	if (schema === true) return [];
	if (schema === false) return [`${path}: rejected by false schema`];
	if (!record(schema)) throw new McpApplyError("SCHEMA_UNSUPPORTED", "Installed OMP MCP schema has an unexpected shape");
	for (const keyword of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(keyword))
		throw new McpApplyError("SCHEMA_UNSUPPORTED", `Installed OMP MCP schema uses unsupported keyword ${keyword}; refusing rather than skipping it`);
	const errors: string[] = [];
	if (typeof schema.$ref === "string") {
		const match = /^#\/\$defs\/([^/]+)$/.exec(schema.$ref);
		const target = match && record(root) && record(root.$defs) ? root.$defs[match[1]!] : undefined;
		if (target === undefined) throw new McpApplyError("SCHEMA_UNSUPPORTED", `Unresolvable schema reference ${schema.$ref}`);
		errors.push(...validateJsonSchema(value, target, root, path));
	}
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		const ok = types.some(type => type === actual || (type === "integer" && Number.isInteger(value)) || (type === "number" && actual === "number"));
		if (!ok) return [...errors, `${path}: expected ${types.join("|")}`];
	}
	if (schema.enum !== undefined && !(schema.enum as unknown[]).some(item => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}: not in enum`);
	if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: not const`);
	if (typeof value === "string") {
		const length = [...value].length;
		if (typeof schema.minLength === "number" && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
		if (typeof schema.maxLength === "number" && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
		if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
		if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
	}
	if (Array.isArray(value)) {
		if (schema.items !== undefined) value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, root, `${path}[${index}]`)));
		if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items not unique`);
		if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
	}
	if (record(value)) {
		const properties = record(schema.properties) ? schema.properties : {};
		for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`);
		for (const [key, item] of Object.entries(value)) {
			if (schema.propertyNames !== undefined) errors.push(...validateJsonSchema(key, schema.propertyNames, root, `${path}{${key}}`));
			if (Object.hasOwn(properties, key)) errors.push(...validateJsonSchema(item, properties[key], root, `${path}.${key}`));
			else if (schema.additionalProperties !== undefined) errors.push(...validateJsonSchema(item, schema.additionalProperties, root, `${path}.${key}`).map(error => schema.additionalProperties === false ? `${path}: unexpected property ${key}` : error));
		}
	}
	if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) errors.push(...validateJsonSchema(value, branch, root, path));
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some(branch => validateJsonSchema(value, branch, root, path).length === 0)) errors.push(`${path}: matches no anyOf branch`);
	if (Array.isArray(schema.oneOf)) {
		const matches = schema.oneOf.filter(branch => validateJsonSchema(value, branch, root, path).length === 0).length;
		if (matches !== 1) errors.push(`${path}: matches ${matches} oneOf branches, expected 1`);
	}
	if (schema.not !== undefined && validateJsonSchema(value, schema.not, root, path).length === 0) errors.push(`${path}: matches a not schema`);
	return errors;
}

type Token = { kind: "{" | "}" | "[" | "]" | ":" | "," | "string" | "literal"; start: number; end: number };
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	for (let index = 0; index < text.length;) {
		const char = text[index]!;
		if (/\s/.test(char)) { index++; continue; }
		if ("{}[]:,".includes(char)) { tokens.push({ kind: char as Token["kind"], start: index, end: index + 1 }); index++; continue; }
		if (char === "\"") {
			let cursor = index + 1;
			while (cursor < text.length && text[cursor] !== "\"") cursor += text[cursor] === "\\" ? 2 : 1;
			tokens.push({ kind: "string", start: index, end: cursor + 1 });
			index = cursor + 1;
			continue;
		}
		let cursor = index;
		while (cursor < text.length && !/[\s{}[\]:,]/.test(text[cursor]!)) cursor++;
		tokens.push({ kind: "literal", start: index, end: cursor });
		index = cursor;
	}
	return tokens;
}
/** Index of the token closing the container opened at `open`. */
function closing(tokens: readonly Token[], open: number): number {
	let depth = 0;
	for (let index = open; index < tokens.length; index++) {
		const kind = tokens[index]!.kind;
		if (kind === "{" || kind === "[") depth++;
		else if ((kind === "}" || kind === "]") && --depth === 0) return index;
	}
	throw new McpApplyError("UNPARSEABLE_PROFILE_MCP", "Unbalanced JSON");
}
function lineIndent(text: string, at: number): string {
	const lineStart = text.lastIndexOf("\n", at - 1) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart))![0];
}
function pretty(value: unknown, unit: string, indent: string): string {
	return JSON.stringify(value, null, unit).replaceAll("\n", `\n${indent}`);
}

/**
 * Byte-preserving insertion: every original byte keeps its position before/after one inserted block.
 * Returns the new text and the insertion span.
 */
export function insertMcpServers(text: string | null, additions: readonly [string, unknown][]): { text: string; at: number; length: number } {
	if (text === null || text.trim() === "") {
		const created = `${JSON.stringify({ mcpServers: Object.fromEntries(additions) }, null, 2)}\n`;
		return { text: created, at: 0, length: created.length - (text?.length ?? 0) };
	}
	const tokens = tokenize(text);
	if (tokens[0]?.kind !== "{") throw new McpApplyError("UNPARSEABLE_PROFILE_MCP", "Profile mcp.json root is not an object");
	const rootClose = closing(tokens, 0);
	let serversOpen = -1;
	let firstRootMember = -1;
	for (let index = 1; index < rootClose; index++) {
		const token = tokens[index]!;
		if (token.kind === "string" && tokens[index + 1]?.kind === ":") {
			if (firstRootMember < 0) firstRootMember = index;
			if (JSON.parse(text.slice(token.start, token.end)) === "mcpServers" && tokens[index + 2]?.kind === "{") serversOpen = index + 2;
		}
		if (token.kind === "{" || token.kind === "[") index = closing(tokens, index);
	}
	const multiline = text.includes("\n");
	const unit = firstRootMember >= 0 && multiline && lineIndent(text, tokens[firstRootMember]!.start) ? lineIndent(text, tokens[firstRootMember]!.start) : "  ";
	let at: number, insert: string;
	if (serversOpen >= 0) {
		const serversClose = closing(tokens, serversOpen);
		const empty = serversClose === serversOpen + 1;
		const outer = multiline ? lineIndent(text, tokens[serversOpen - 2]!.start) : "";
		const inner = outer + unit;
		const members = additions.map(([name, value]) => multiline ? `${inner}${JSON.stringify(name)}: ${pretty(value, unit, inner)}` : `${JSON.stringify(name)}: ${JSON.stringify(value)}`);
		if (empty) {
			at = tokens[serversOpen]!.end;
			insert = multiline ? `\n${members.join(",\n")}\n${outer}` : members.join(", ");
		} else {
			at = tokens[serversClose - 1]!.end;
			insert = multiline ? `,\n${members.join(",\n")}` : `, ${members.join(", ")}`;
		}
	} else {
		const value = Object.fromEntries(additions);
		const member = multiline ? `${unit}"mcpServers": ${pretty(value, unit, unit)}` : `"mcpServers": ${JSON.stringify(value)}`;
		if (rootClose === 1) {
			at = tokens[0]!.end;
			insert = multiline ? `\n${member}\n` : member;
		} else {
			at = tokens[rootClose - 1]!.end;
			insert = multiline ? `,\n${member}` : `, ${member}`;
		}
	}
	return { text: text.slice(0, at) + insert + text.slice(at), at, length: insert.length };
}

/** Unified-style diff of one insertion. */
function insertionDiff(path: string, before: string | null, after: string, at: number, length: number): string {
	if (before === null || before.trim() === "") {
		const lines = after.replace(/\n$/, "").split("\n");
		return [`--- ${before === null ? "/dev/null" : path}`, `+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join("\n");
	}
	const lineStart = before.lastIndexOf("\n", at - 1) + 1;
	const oldEndRaw = before.indexOf("\n", at);
	const oldEnd = oldEndRaw < 0 ? before.length : oldEndRaw;
	const oldLine = before.slice(lineStart, oldEnd);
	const newLines = after.slice(lineStart, oldEnd + length).split("\n");
	const lineNumber = before.slice(0, lineStart).split("\n").length;
	return [`--- ${path}`, `+++ ${path}`, `@@ -${lineNumber},1 +${lineNumber},${newLines.length} @@`, `-${oldLine}`, ...newLines.map(line => `+${line}`)].join("\n");
}

function readProfileFile(path: string): { bytes: Buffer; image: Image } | null {
	let info;
	try { info = lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new McpApplyError("UNSAFE_PATH", "Profile mcp.json cannot be inspected");
	}
	if (!info.isFile() || info.isSymbolicLink()) throw new McpApplyError("UNSAFE_PATH", "Profile mcp.json is not a regular file");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		const bytes = readFileSync(fd);
		return { bytes, image: { sha256: hash(bytes), size: bytes.length, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid } };
	} finally { closeSync(fd); }
}

/** Parse NAME=ABS_JSON override files: one server entry in Claude/Cursor shape, replacing the source entry. */
export function readOverride(spec: string): McpOverride {
	const split = spec.indexOf("=");
	const name = spec.slice(0, split), path = spec.slice(split + 1);
	if (split <= 0 || !SERVER_NAME.test(name) || !path.startsWith("/")) throw new McpApplyError("INVALID_OVERRIDE", "Override must be NAME=ABS_JSON_FILE");
	let bytes: Buffer;
	try { bytes = readFileSync(path); } catch { throw new McpApplyError("INVALID_OVERRIDE", `Override file for ${name} is unreadable`); }
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new McpApplyError("INVALID_OVERRIDE", `Override file for ${name} is not JSON`); }
	const server = parseSourceEntry(name, parsed);
	if ("reason" in server) throw new McpApplyError("INVALID_OVERRIDE", `Override for ${name}: ${server.reason}`);
	return { name, path, sha256: hash(bytes), server };
}

/** Read-only: renders, scans, validates and diffs every selected profile. Throws McpApplyError on any refusal. */
export function planMcpApply(input: McpApplyInput): McpApplyPlan {
	const overrides = new Map((input.overrides ?? []).map(entry => [entry.name, entry]));
	for (const name of overrides.keys()) if (!input.servers.includes(name))
		throw new McpApplyError("INVALID_OVERRIDE", `Override ${name} is not a selected server`);
	const available = new Map(input.source.servers.map(server => [server.name, server]));
	const missing = input.servers.filter(name => !available.has(name) && !overrides.has(name));
	if (missing.length) throw new McpApplyError("UNKNOWN_SERVER", `Not in ${input.source.id}: ${missing.join(", ")}`, [{ missing, available: [...available.keys()].sort() }]);
	for (const name of input.timeouts?.keys() ?? []) if (!input.servers.includes(name))
		throw new McpApplyError("INVALID_TIMEOUT", `Timeout names unselected server ${name}`);
	const rendered = input.servers.map(name => {
		const override = overrides.get(name);
		return renderServer(override?.server ?? available.get(name)!, { timeoutMs: input.timeouts?.get(name), envLiteral: input.envLiteral,
			env: input.env, override: override ? override.path : null });
	});
	const findings = rendered.flatMap(server => scanRenderedSecrets(server.name, server.config, input.envLiteral));
	if (findings.length) throw new McpApplyError("LITERAL_SECRET", "Rendered MCP config holds a likely literal credential; use an env-var reference", findings);
	const schemaErrors = rendered.flatMap(server => validateJsonSchema({ mcpServers: { [server.name]: server.config } }, input.schema));
	if (schemaErrors.length) throw new McpApplyError("SCHEMA_INVALID", "Rendered MCP config fails the installed OMP mcp-schema.json", schemaErrors.map(error => ({ error })));
	const profiles: McpProfilePlan[] = [], files: FileMutation[] = [], roots: { id: string; path: string }[] = [];
	const existing = new Map<string, Record<string, unknown>>();
	for (const profile of input.profiles) {
		const base = { profile: profile.name, path: profile.mcpPath, added: [] as string[], already_present: [] as string[], conflicts: [] as string[], diff: "", before_sha256: null as string | null, after_sha256: null as string | null };
		let current: { bytes: Buffer; image: Image } | null;
		try { current = readProfileFile(profile.mcpPath); }
		catch { profiles.push({ ...base, action: "SKIPPED", reason: "UNSAFE: mcp.json is not a regular file; left untouched" }); continue; }
		const text = current?.bytes.toString("utf8") ?? null;
		let data: Record<string, unknown> = {};
		if (text !== null && text.trim() !== "") {
			let parsed: unknown;
			try { parsed = JSON.parse(text); } catch { parsed = undefined; }
			if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))) {
				profiles.push({ ...base, action: "SKIPPED", reason: "UNPARSEABLE: mcp.json is not a JSON object with an mcpServers object; left untouched", before_sha256: current?.image.sha256 ?? null });
				continue;
			}
			data = parsed;
		}
		const entries = (data.mcpServers as Record<string, unknown> | undefined) ?? {};
		const additions: [string, unknown][] = [], shown: [string, unknown][] = [];
		for (const server of rendered) {
			if (!Object.hasOwn(entries, server.name)) { additions.push([server.name, server.config]); shown.push([server.name, server.display]); base.added.push(server.name); }
			else if (JSON.stringify(entries[server.name]) === JSON.stringify(server.config)) base.already_present.push(server.name);
			else base.conflicts.push(server.name);
		}
		if (!additions.length) { profiles.push({ ...base, action: "NO_CHANGE", before_sha256: current?.image.sha256 ?? null, after_sha256: current?.image.sha256 ?? null }); continue; }
		const next = insertMcpServers(text, additions);
		const merged = { ...data, mcpServers: { ...entries, ...Object.fromEntries(additions) } };
		let reparsed: unknown;
		try { reparsed = JSON.parse(next.text); } catch { throw new McpApplyError("RENDER_FAILED", `Insertion for ${profile.name} produced invalid JSON`); }
		if (JSON.stringify(reparsed) !== JSON.stringify(merged)) throw new McpApplyError("RENDER_FAILED", `Insertion for ${profile.name} changed existing content`);
		const documentErrors = validateJsonSchema(reparsed, input.schema);
		if (documentErrors.length) {
			profiles.push({ ...base, action: "SKIPPED", reason: `SCHEMA_INVALID: existing profile mcp.json already fails the OMP schema (${documentErrors.slice(0, 3).join("; ")}); left untouched`, before_sha256: current?.image.sha256 ?? null });
			continue;
		}
		const shownText = insertMcpServers(text, shown);
		const afterBytes = Buffer.from(next.text);
		const rootId = `profile-${roots.length}`;
		roots.push({ id: rootId, path: dirname(profile.mcpPath) });
		files.push({ root: rootId, relativePath: "mcp.json", expectedBefore: current?.image ?? null,
			after: { bytes: afterBytes, mode: current?.image.mode ?? 0o600, ...(current ? { uid: current.image.uid, gid: current.image.gid } : {}) } });
		existing.set(profile.mcpPath, entries);
		profiles.push({ ...base, action: "ADD", diff: insertionDiff(profile.mcpPath, text, shownText.text, shownText.at, shownText.length),
			before_sha256: current?.image.sha256 ?? null, after_sha256: hash(afterBytes) });
	}
	return {
		source: { id: input.source.id, path: input.source.path },
		servers: rendered.map(({ config: _config, ...rest }) => rest), edits: null,
		profiles, overrides: [...overrides.values()].map(({ name, path, sha256 }) => ({ name, path, sha256 })),
		schema: { path: input.schemaPath, validated: true }, stateRoot: input.stateRoot, existing,
		mutation: files.length ? planMutation({ stateRoot: input.stateRoot, roots, files }) : null,
	};
}

/** One receipt for every touched profile; readback proves planned bytes landed and pre-existing entries are unchanged. */
export function applyMcpPlan(plan: McpApplyPlan): { receiptId: string | null; files: number } {
	if (!plan.mutation) {
		if (inspectPendingMutations(plan.stateRoot).length) throw new McpApplyError("PENDING_RECOVERY", "A pending receipt needs recovery first");
		return { receiptId: null, files: 0 };
	}
	const receipt = applyMutation(plan.mutation);
	for (const step of plan.profiles.filter(row => row.action === "ADD" || row.action === "EDIT")) {
		const after = readProfileFile(step.path);
		let entries: unknown;
		try {
			const document: unknown = after ? JSON.parse(after.bytes.toString("utf8")) : undefined;
			entries = record(document) ? document.mcpServers : undefined;
		} catch { entries = undefined; }
		const before = plan.existing.get(step.path) ?? {};
		const intact = record(entries) && Object.entries(before).every(([name, value]) => JSON.stringify(entries[name]) === JSON.stringify(value));
		if (after?.image.sha256 !== step.after_sha256 || !intact) {
			undoMutation(plan.stateRoot, receipt.id, { confirmed: true });
			throw new McpApplyError("READBACK_FAILED", `Readback of ${step.profile} did not match the plan; the receipt was undone`);
		}
	}
	ensureMutationStateRoot(plan.stateRoot);
	writePrivate(join(plan.stateRoot, `mcp-apply-${receipt.id}.json`), `${JSON.stringify({
		schema_version: 1, receipt_id: receipt.id, recorded_at: new Date().toISOString(), source: plan.source,
		servers: plan.servers.map(server => ({ name: server.name, env_refs: server.env_refs, env_literal: server.env_literal, override: server.override, timeout: server.display.timeout ?? null })),
		overrides: plan.overrides, edits: plan.edits, omp_schema: plan.schema.path,
		profiles: plan.profiles.map(({ diff: _diff, ...row }) => row),
	}, null, 2)}\n`);
	return { receiptId: receipt.id, files: receipt.files };
}

/** `SERVER:KEY=!COMMAND`; the command text is secret-scanned, and a value without `!` is refused, never written as a literal. */
export function parseEnvCommand(spec: string): McpEnvCommand {
	const colon = spec.indexOf(":"), equals = spec.indexOf("=", colon + 1);
	const server = spec.slice(0, colon), key = spec.slice(colon + 1, equals), command = spec.slice(equals + 1);
	if (colon <= 0 || equals < 0 || !SERVER_NAME.test(server) || !ENV_NAME.test(key) || !command.startsWith("!") || command.slice(1).trim() === "")
		throw new McpApplyError("INVALID_ENV_COMMAND", "--env-command needs SERVER:KEY=!COMMAND (an OMP command value starting with !)");
	if (!referenceValue(command))
		throw new McpApplyError("LITERAL_SECRET", `--env-command for ${server} env.${key} holds a likely literal credential; read it from a store instead`, [{ server, field: `env.${key}` }]);
	return { server, key, command };
}

/** Token index of the value of member `name` directly inside the object opened at token `open`; -1 when absent or `open` is not an object. */
function memberValue(text: string, tokens: readonly Token[], open: number, name: string): number {
	if (tokens[open]?.kind !== "{") return -1;
	const close = closing(tokens, open);
	for (let index = open + 1; index < close; index++) {
		const token = tokens[index]!;
		if (token.kind !== "string" || tokens[index + 1]?.kind !== ":") continue;
		if (JSON.parse(text.slice(token.start, token.end)) === name) return index + 2;
		index += 2;
		if (tokens[index]?.kind === "{" || tokens[index]?.kind === "[") index = closing(tokens, index);
	}
	return -1;
}

/** Byte-preserving: rewrites only the string token of mcpServers[server].env[key]; null when that string value is absent. */
export function setMcpEnvValue(text: string, server: string, key: string, value: string): string | null {
	const tokens = tokenize(text);
	const env = memberValue(text, tokens, memberValue(text, tokens, memberValue(text, tokens, 0, "mcpServers"), server), "env");
	const at = memberValue(text, tokens, env, key);
	if (at < 0 || tokens[at]!.kind !== "string") return null;
	return text.slice(0, tokens[at]!.start) + JSON.stringify(value) + text.slice(tokens[at]!.end);
}

/** Byte-preserving: removes every `server` element of the root disabledServers array with one separator; null when not listed. */
export function removeDisabledServer(text: string, server: string): string | null {
	let changed = false;
	for (;;) {
		const tokens = tokenize(text);
		const list = memberValue(text, tokens, 0, "disabledServers");
		if (tokens[list]?.kind !== "[") break;
		const close = closing(tokens, list);
		const items: { start: number; end: number; match: boolean }[] = [];
		for (let index = list + 1; index < close; index++) {
			const token = tokens[index]!;
			if (token.kind === ",") continue;
			const last = token.kind === "{" || token.kind === "[" ? closing(tokens, index) : index;
			items.push({ start: token.start, end: tokens[last]!.end, match: token.kind === "string" && JSON.parse(text.slice(token.start, token.end)) === server });
			index = last;
		}
		const at = items.findIndex(item => item.match);
		if (at < 0) break;
		// Drop the element and the separator after it; the last element takes the separator before it.
		const [from, to] = items.length === 1 ? [tokens[list]!.end, tokens[close]!.start]
			: at < items.length - 1 ? [items[at]!.start, items[at + 1]!.start] : [items[at - 1]!.end, items[at]!.end];
		text = text.slice(0, from) + text.slice(to);
		changed = true;
	}
	return changed ? text : null;
}

/** Unified-style diff of the one changed line block between two texts. */
function lineDiff(path: string, before: string, after: string): string {
	const a = before.split("\n"), b = after.split("\n");
	let head = 0, tail = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const removed = a.slice(head, a.length - tail), added = b.slice(head, b.length - tail);
	return [`--- ${path}`, `+++ ${path}`, `@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join("\n");
}

export interface McpEditInput {
	profiles: readonly OmpProfileDir[];
	stateRoot: string;
	schema: unknown;
	schemaPath: string;
	envCommands: readonly McpEnvCommand[];
	/** Servers to remove from each profile's disabledServers list. */
	enable: readonly string[];
}

/** Edit mode, read-only: env `!command` values and disabledServers removals, in place; every other byte is kept. Throws McpApplyError on any refusal. */
export function planMcpEdit(input: McpEditInput): McpApplyPlan {
	if (!input.envCommands.length && !input.enable.length) throw new McpApplyError("NO_EDIT", "Edit mode needs --env-command or --enable");
	for (const name of input.enable) if (!SERVER_NAME.test(name)) throw new McpApplyError("INVALID_ENABLE", "--enable needs comma-separated server names");
	if (new Set(input.envCommands.map(edit => `${edit.server}\n${edit.key}`)).size !== input.envCommands.length || new Set(input.enable).size !== input.enable.length)
		throw new McpApplyError("DUPLICATE_EDIT", "Each --env-command SERVER:KEY and each --enable name may appear once");
	for (const edit of input.envCommands) if (!referenceValue(edit.command))
		throw new McpApplyError("LITERAL_SECRET", `env.${edit.key} of ${edit.server} is not a clean !command value`, [{ server: edit.server, field: `env.${edit.key}` }]);
	const profiles: McpProfilePlan[] = [], files: FileMutation[] = [], roots: { id: string; path: string }[] = [];
	const existing = new Map<string, Record<string, unknown>>();
	for (const profile of input.profiles) {
		const base = { profile: profile.name, path: profile.mcpPath, added: [] as string[], already_present: [] as string[], conflicts: [] as string[], diff: "", before_sha256: null as string | null, after_sha256: null as string | null };
		let current: { bytes: Buffer; image: Image } | null;
		try { current = readProfileFile(profile.mcpPath); }
		catch { profiles.push({ ...base, action: "SKIPPED", reason: "UNSAFE: mcp.json is not a regular file; left untouched" }); continue; }
		const text = current?.bytes.toString("utf8") ?? null;
		let parsed: unknown;
		try { parsed = text === null ? {} : JSON.parse(text); } catch { parsed = undefined; }
		if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))
			|| (parsed.disabledServers !== undefined && !(Array.isArray(parsed.disabledServers) && parsed.disabledServers.every(item => typeof item === "string")))) {
			profiles.push({ ...base, action: "SKIPPED", reason: "UNPARSEABLE: mcp.json is not a JSON object with an mcpServers object and a string disabledServers list; left untouched", before_sha256: current?.image.sha256 ?? null });
			continue;
		}
		const expected = structuredClone(parsed);
		const entries = record(expected.mcpServers) ? expected.mcpServers : {};
		let next = text ?? "";
		const diffs: string[] = [];
		for (const edit of input.envCommands) {
			const label = `${edit.server} env.${edit.key}=${edit.command}`;
			const entry = entries[edit.server];
			const env = record(entry) && record(entry.env) ? entry.env : undefined;
			if (typeof env?.[edit.key] !== "string") { base.conflicts.push(`${label}: ${record(entry) ? `the entry has no string env.${edit.key}` : "server absent"}; left untouched`); continue; }
			if (env[edit.key] === edit.command) { base.already_present.push(label); continue; }
			const edited = setMcpEnvValue(next, edit.server, edit.key, edit.command);
			if (edited === null) throw new McpApplyError("RENDER_FAILED", `Could not locate ${edit.server} env.${edit.key} in ${profile.name}'s mcp.json`);
			diffs.push(lineDiff(profile.mcpPath, next, edited));
			next = edited;
			env[edit.key] = edit.command;
			base.added.push(label);
		}
		for (const name of input.enable) {
			const label = `enable ${name}`;
			const listed = (expected.disabledServers as string[] | undefined) ?? [];
			if (record(entries[name]) && entries[name].enabled === false) base.conflicts.push(`${label}: the entry itself has enabled false; left as is`);
			if (!listed.includes(name)) { base.already_present.push(`${label} (not in disabledServers)`); continue; }
			const edited = removeDisabledServer(next, name);
			if (edited === null) throw new McpApplyError("RENDER_FAILED", `Could not locate ${name} in ${profile.name}'s disabledServers`);
			diffs.push(lineDiff(profile.mcpPath, next, edited));
			next = edited;
			expected.disabledServers = listed.filter(item => item !== name);
			base.added.push(label);
		}
		if (!diffs.length) { profiles.push({ ...base, action: "NO_CHANGE", before_sha256: current?.image.sha256 ?? null, after_sha256: current?.image.sha256 ?? null }); continue; }
		let reparsed: unknown;
		try { reparsed = JSON.parse(next); } catch { throw new McpApplyError("RENDER_FAILED", `Edit of ${profile.name} produced invalid JSON`); }
		if (JSON.stringify(reparsed) !== JSON.stringify(expected)) throw new McpApplyError("RENDER_FAILED", `Edit of ${profile.name} changed content it was not asked to change`);
		const documentErrors = validateJsonSchema(reparsed, input.schema);
		if (documentErrors.length) {
			profiles.push({ ...base, action: "SKIPPED", reason: `SCHEMA_INVALID: edited mcp.json would fail the OMP schema (${documentErrors.slice(0, 3).join("; ")}); left untouched`, before_sha256: current?.image.sha256 ?? null });
			continue;
		}
		const afterBytes = Buffer.from(next);
		const rootId = `profile-${roots.length}`;
		roots.push({ id: rootId, path: dirname(profile.mcpPath) });
		files.push({ root: rootId, relativePath: "mcp.json", expectedBefore: current!.image,
			after: { bytes: afterBytes, mode: current!.image.mode, uid: current!.image.uid, gid: current!.image.gid } });
		existing.set(profile.mcpPath, entries);
		profiles.push({ ...base, action: "EDIT", diff: diffs.join("\n"), before_sha256: current!.image.sha256, after_sha256: hash(afterBytes) });
	}
	return {
		source: null, servers: [], edits: { env_commands: [...input.envCommands], enable: [...input.enable] }, profiles, overrides: [],
		schema: { path: input.schemaPath, validated: true }, stateRoot: input.stateRoot, existing,
		mutation: files.length ? planMutation({ stateRoot: input.stateRoot, roots, files }) : null,
	};
}

/** `N` for every selected server, or NAME=N[,NAME=N]. */
export function parseTimeouts(value: string, servers: readonly string[]): Map<string, number> {
	const parse = (raw: string): number => {
		if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1000) throw new McpApplyError("INVALID_TIMEOUT", "--startup-timeout-ms needs N >= 1000 or NAME=N[,NAME=N]");
		return Number(raw);
	};
	if (/^\d+$/.test(value)) return new Map(servers.map(name => [name, parse(value)]));
	return new Map(value.split(",").map(part => {
		const [name, raw] = part.split("=", 2);
		if (!name || raw === undefined) throw new McpApplyError("INVALID_TIMEOUT", "--startup-timeout-ms needs N >= 1000 or NAME=N[,NAME=N]");
		return [name, parse(raw)];
	}));
}

export interface WizardIo { ask(question: string): Promise<string>; say(text: string): void }
/** `all`, or a comma list of names and/or 1-based numbers from `options`. */
function pick(answer: string, options: readonly string[]): string[] | null {
	const trimmed = answer.trim();
	if (trimmed === "all") return [...options];
	const chosen = trimmed.split(",").map(part => part.trim()).filter(Boolean).map(part => /^\d+$/.test(part) ? options[Number(part) - 1] : options.includes(part) ? part : undefined);
	return chosen.length && chosen.every(item => item !== undefined) ? [...new Set(chosen as string[])] : null;
}
/** Interactive walk-through: source (unless preset), servers, profiles. Null when the user gives up. */
export async function chooseMcpSelection(io: WizardIo, input: { sources: readonly { id: string; servers: readonly string[] }[]; profiles: readonly string[]; from?: string }): Promise<{ from: string; servers: string[]; profiles: string[] } | null> {
	let from = input.from;
	if (!from) {
		const usable = input.sources.filter(source => source.servers.length);
		if (!usable.length) { io.say("No MCP servers were found in any harness config."); return null; }
		io.say(["MCP sources:", ...usable.map((source, index) => `  ${index + 1}. ${source.id} (${source.servers.length} servers)`)].join("\n"));
		const answer = await io.ask(`Source [${usable[0]!.id}]: `);
		const chosen = answer.trim() === "" ? [usable[0]!.id] : pick(answer, usable.map(source => source.id));
		if (chosen?.length !== 1) { io.say("Pick exactly one source."); return null; }
		from = chosen[0]!;
	}
	const servers = input.sources.find(source => source.id === from)?.servers ?? [];
	if (!servers.length) { io.say(`Source ${from} has no MCP servers.`); return null; }
	io.say([`Servers in ${from}:`, ...servers.map((name, index) => `  ${index + 1}. ${name}`)].join("\n"));
	const serverChoice = pick(await io.ask("Servers to import (names or numbers, comma-separated, or all): "), servers);
	if (!serverChoice) { io.say("No valid server selection."); return null; }
	io.say(["OMP profiles:", ...input.profiles.map((name, index) => `  ${index + 1}. ${name}`)].join("\n"));
	const profileChoice = pick(await io.ask("Profiles to receive them (names or numbers, comma-separated, or all): "), input.profiles);
	if (!profileChoice) { io.say("No valid profile selection."); return null; }
	return { from, servers: serverChoice, profiles: profileChoice };
}
