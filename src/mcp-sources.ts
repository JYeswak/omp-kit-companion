import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** MCP servers configured for other harnesses, and the OMP profiles that would receive them. Read-only. */
export type McpTransport = "stdio" | "http" | "sse";
export interface SourceServer {
	name: string;
	transport: McpTransport;
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	/** Raw source values: rendered as references, never serialized to output. */
	env: Record<string, string>;
	/** Raw source values: never serialized to output. */
	headers: Record<string, string>;
	enabled: boolean;
}
export type SourceKind = "claude" | "claude-mcp" | "cursor" | "codex" | "project" | "path";
export interface McpSource {
	id: SourceKind;
	path: string;
	status: "PRESENT" | "ABSENT" | "UNPARSEABLE";
	servers: SourceServer[];
	invalid: { name: string; reason: string }[];
}
export interface OmpProfileDir { name: string; agentDir: string; mcpPath: string }
export interface ProfileServers {
	state: "ABSENT" | "OK" | "UNPARSEABLE" | "UNSAFE";
	/** Server name -> enabled (false when `enabled: false` or listed in disabledServers). */
	servers: Map<string, boolean>;
	/** Raw parsed entries, for equality checks only. */
	entries: Record<string, unknown>;
}

export const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const SERVER_NAME = /^[a-zA-Z0-9_.-]{1,100}$/;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const stringMap = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every(item => typeof item === "string");

function readCapped(path: string): string | null {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY); } catch { return null; }
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error("UNSAFE_SOURCE");
		return readFileSync(fd, "utf8");
	} finally { closeSync(fd); }
}

/** One harness entry in Claude/Cursor/.mcp.json/Codex shape. */
export function parseSourceEntry(name: string, value: unknown): SourceServer | { reason: string } {
	if (!record(value)) return { reason: "entry is not an object" };
	const env = value.env === undefined ? {} : value.env;
	if (!stringMap(env)) return { reason: "env is not a string map" };
	const headers = value.headers ?? value.http_headers ?? {};
	if (!stringMap(headers)) return { reason: "headers is not a string map" };
	if (value.args !== undefined && !strings(value.args)) return { reason: "args is not a string list" };
	if (value.cwd !== undefined && typeof value.cwd !== "string") return { reason: "cwd is not a string" };
	if (value.bearer_token_env_var !== undefined) return { reason: "bearer_token_env_var has no OMP mcp.json equivalent" };
	const enabled = value.enabled === undefined ? value.disabled !== true : value.enabled !== false;
	if (typeof value.url === "string") {
		if (value.command !== undefined) return { reason: "both command and url are set" };
		const type = value.type === "sse" ? "sse" : value.type === undefined || value.type === "http" || value.type === "streamable-http" ? "http" : null;
		if (!type) return { reason: `unsupported transport ${String(value.type)}` };
		return { name, transport: type, url: value.url, env, headers, enabled };
	}
	if (typeof value.command !== "string") return { reason: "neither command nor url is set" };
	if (value.type !== undefined && value.type !== "stdio") return { reason: `unsupported transport ${String(value.type)}` };
	return { name, transport: "stdio", command: value.command, ...(value.args ? { args: value.args as string[] } : {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}), env, headers, enabled };
}

function sourceFrom(id: SourceKind, path: string, key: "mcpServers" | "mcp_servers", toml = false): McpSource {
	let text: string | null;
	try { text = readCapped(path); } catch { return { id, path, status: "UNPARSEABLE", servers: [], invalid: [] }; }
	if (text === null) return { id, path, status: "ABSENT", servers: [], invalid: [] };
	let data: unknown;
	try { data = toml ? Bun.TOML.parse(text) : JSON.parse(text); } catch { return { id, path, status: "UNPARSEABLE", servers: [], invalid: [] }; }
	if (!record(data)) return { id, path, status: "UNPARSEABLE", servers: [], invalid: [] };
	const table = data[key];
	if (table !== undefined && !record(table)) return { id, path, status: "UNPARSEABLE", servers: [], invalid: [] };
	const servers: SourceServer[] = [], invalid: { name: string; reason: string }[] = [];
	for (const [name, value] of Object.entries(table ?? {})) {
		const parsed = parseSourceEntry(name, value);
		if ("reason" in parsed) invalid.push({ name, reason: parsed.reason });
		else servers.push(parsed);
	}
	return { id, path, status: "PRESENT", servers, invalid };
}

/** Every known harness config, present or not. */
export function discoverSources(home: string, cwd: string): McpSource[] {
	return [
		sourceFrom("claude", join(home, ".claude.json"), "mcpServers"),
		sourceFrom("claude-mcp", join(home, ".claude", "mcp.json"), "mcpServers"),
		sourceFrom("cursor", join(home, ".cursor", "mcp.json"), "mcpServers"),
		sourceFrom("codex", join(home, ".codex", "config.toml"), "mcp_servers", true),
		sourceFrom("project", join(resolve(cwd), ".mcp.json"), "mcpServers"),
	];
}

/** `--from claude|cursor|codex|ABS_PATH`. Claude merges ~/.claude.json with ~/.claude/mcp.json; ~/.claude.json wins on a name clash. */
export function readSource(from: string, home: string, cwd: string): McpSource {
	if (from === "claude") {
		const primary = sourceFrom("claude", join(home, ".claude.json"), "mcpServers");
		const secondary = sourceFrom("claude-mcp", join(home, ".claude", "mcp.json"), "mcpServers");
		const names = new Set(primary.servers.map(server => server.name));
		return { ...primary, status: primary.status === "PRESENT" || secondary.status === "PRESENT" ? "PRESENT" : primary.status,
			servers: [...primary.servers, ...secondary.servers.filter(server => !names.has(server.name))],
			invalid: [...primary.invalid, ...secondary.invalid.filter(entry => !names.has(entry.name))] };
	}
	if (from === "cursor") return sourceFrom("cursor", join(home, ".cursor", "mcp.json"), "mcpServers");
	if (from === "claude-mcp") return sourceFrom("claude-mcp", join(home, ".claude", "mcp.json"), "mcpServers");
	if (from === "codex") return sourceFrom("codex", join(home, ".codex", "config.toml"), "mcp_servers", true);
	if (from === "project") return sourceFrom("project", join(resolve(cwd), ".mcp.json"), "mcpServers");
	if (!isAbsolute(from) || resolve(from) !== from) throw new Error("INVALID_SOURCE");
	return from.endsWith(".toml") ? sourceFrom("path", from, "mcp_servers", true) : sourceFrom("path", from, "mcpServers");
}

function realDirectory(path: string): boolean {
	try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

/** Default profile plus every addressable ~/.omp/profiles/NAME/agent, enumerated now. */
export function listOmpProfiles(home: string): { profiles: OmpProfileDir[]; skipped: { name: string; reason: string }[] } {
	const profiles: OmpProfileDir[] = [], skipped: { name: string; reason: string }[] = [];
	const defaultAgent = join(home, ".omp", "agent");
	if (realDirectory(defaultAgent)) profiles.push({ name: "default", agentDir: defaultAgent, mcpPath: join(defaultAgent, "mcp.json") });
	const named = join(home, ".omp", "profiles");
	let entries: string[] = [];
	try { if (statSync(named).isDirectory()) entries = readdirSync(named).sort(); } catch { /* No named profiles. */ }
	for (const name of entries) {
		if (!PROFILE_NAME.test(name) || name === "default" || name.endsWith(".")) { skipped.push({ name, reason: "profile directory name is not addressable" }); continue; }
		const agentDir = join(named, name, "agent");
		if (!realDirectory(join(named, name)) || !realDirectory(agentDir)) { skipped.push({ name, reason: "profile agent directory is missing or a symlink" }); continue; }
		profiles.push({ name, agentDir, mcpPath: join(agentDir, "mcp.json") });
	}
	return { profiles, skipped };
}

/** `all` or NAME[,NAME]; unknown names refuse. */
export function selectProfiles(all: readonly OmpProfileDir[], selection: string): OmpProfileDir[] {
	if (selection === "all") return [...all];
	const names = selection.split(",").map(name => name.trim()).filter(Boolean);
	if (!names.length || new Set(names).size !== names.length || names.some(name => !PROFILE_NAME.test(name))) throw new Error("INVALID_PROFILES");
	return names.map(name => all.find(profile => profile.name === name) ?? (() => { throw new Error(`MISSING_PROFILE:${name}`); })());
}

export function readProfileServers(mcpPath: string): ProfileServers {
	const empty = { servers: new Map<string, boolean>(), entries: {} };
	let info;
	try { info = lstatSync(mcpPath); } catch { return { state: "ABSENT", ...empty }; }
	if (!info.isFile() || info.isSymbolicLink()) return { state: "UNSAFE", ...empty };
	let data: unknown;
	try { data = JSON.parse(readCapped(mcpPath) ?? ""); } catch { return { state: "UNPARSEABLE", ...empty }; }
	if (!record(data) || (data.mcpServers !== undefined && !record(data.mcpServers)) || (data.disabledServers !== undefined && !strings(data.disabledServers)))
		return { state: "UNPARSEABLE", ...empty };
	const denied = new Set((data.disabledServers as string[] | undefined) ?? []);
	const entries = (data.mcpServers as Record<string, unknown> | undefined) ?? {};
	const servers = new Map<string, boolean>();
	for (const [name, value] of Object.entries(entries)) servers.set(name, !denied.has(name) && !(record(value) && value.enabled === false));
	return { state: "OK", servers, entries };
}

const SECRET_ARG_FLAG = /^--?(?:api[-_]?key|token|access[-_]?token|secret|password|passwd|auth|bearer)$/i;
const SECRET_VALUE = [
	/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|glpat-[A-Za-z0-9_-]{20,})/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*[^\s,;"'&]{8,}/i,
	/:\/\/[^/\s:@]+:[^/\s@]+@/,
	/[?&](?:key|api[_-]?key|token|secret|access_token|appid)=[^&\s]{8,}/i,
];
/** Likely literal credential in one string; never returns the value. */
export function looksSecret(value: string): boolean {
	return SECRET_VALUE.some(pattern => pattern.test(value));
}
/** Indexes of args that hold a likely literal credential (pattern match, or the value after a credential flag). */
export function secretArgIndexes(args: readonly string[]): number[] {
	const flagged: number[] = [];
	args.forEach((arg, index) => {
		if (looksSecret(arg) || (index > 0 && SECRET_ARG_FLAG.test(args[index - 1] ?? "") && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) && !arg.startsWith("$"))) flagged.push(index);
	});
	return flagged;
}

/** Output-safe view: env and header values never appear, likely-secret args are redacted. */
export function describeServer(server: SourceServer): Record<string, unknown> {
	const secretArgs = new Set(secretArgIndexes(server.args ?? []));
	return {
		name: server.name, transport: server.transport, enabled: server.enabled,
		...(server.command !== undefined ? { command: looksSecret(server.command) ? "<redacted: likely secret>" : server.command } : {}),
		...(server.args ? { args: server.args.map((arg, index) => secretArgs.has(index) ? "<redacted: likely secret>" : arg) } : {}),
		...(server.url !== undefined ? { url: looksSecret(server.url) ? "<redacted: likely secret>" : server.url } : {}),
		env_names: Object.keys(server.env).sort(), header_names: Object.keys(server.headers).sort(),
	};
}

export type MatrixCell = "CONFIGURED" | "DISABLED" | "ABSENT" | "UNREADABLE";
export interface McpSourcesReport {
	sources: { id: SourceKind; path: string; status: McpSource["status"]; servers: Record<string, unknown>[]; invalid: { name: string; reason: string }[] }[];
	profiles: string[];
	skipped_profiles: { name: string; reason: string }[];
	/** Server name -> profile -> cell. */
	matrix: Record<string, Record<string, MatrixCell>>;
}

/** Read-only: no OMP invocation, no server start, no writes; env and header values never leave this module. */
export function inspectMcpSources(home: string, cwd: string): McpSourcesReport {
	const sources = discoverSources(home, cwd);
	const { profiles, skipped } = listOmpProfiles(home);
	const configured = new Map(profiles.map(profile => [profile.name, readProfileServers(profile.mcpPath)]));
	const names = [...new Set(sources.flatMap(source => source.servers.map(server => server.name)))].sort();
	const matrix: McpSourcesReport["matrix"] = {};
	for (const name of names) {
		matrix[name] = {};
		for (const profile of profiles) {
			const servers = configured.get(profile.name)!;
			matrix[name]![profile.name] = servers.state === "UNPARSEABLE" || servers.state === "UNSAFE" ? "UNREADABLE"
				: !servers.servers.has(name) ? "ABSENT" : servers.servers.get(name) ? "CONFIGURED" : "DISABLED";
		}
	}
	return {
		sources: sources.map(source => ({ id: source.id, path: source.path, status: source.status, servers: source.servers.map(describeServer), invalid: source.invalid })),
		profiles: profiles.map(profile => profile.name), skipped_profiles: skipped, matrix,
	};
}
