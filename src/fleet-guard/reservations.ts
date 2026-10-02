import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface ReservationEvent {
	toolName?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
	params?: unknown;
}

export interface ReservationLookupInput {
	projectKey: string;
	agentName: string;
	path: string;
}

export interface ReservationLookupResult {
	covered: boolean;
	conflicts: readonly unknown[];
}

export interface ReservationCheckContext {
	cwd?: string;
	repoRoot?: string;
	projectRoot?: string;
	projectKey?: string;
	agentName?: string;
	isTrackedPath?: (absolutePath: string, repoRoot: string) => Promise<boolean> | boolean;
	lookupReservations?: (input: ReservationLookupInput) => Promise<ReservationLookupResult>;
	warn?: (message: string) => void;
	now?: () => number;
}

export interface ReservationBlock {
	block: true;
	reason: string;
}

interface CacheEntry {
	expiresAt: number;
	result: ReservationLookupResult;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const RESERVATION_REASON =
	"fleet-guard reservations: tracked edits require an active exclusive Agent Mail reservation. Call file_reservation_paths first; see AGENTS.md Working on main.";

export function clearReservationCache(): void {
	cache.clear();
}

function eventToolName(event: ReservationEvent): string {
	const value = event.toolName ?? event.name;
	return typeof value === "string" ? value.toLowerCase() : "";
}

function eventPath(event: ReservationEvent): string | undefined {
	const candidates: unknown[] = [
		event.arguments && typeof event.arguments === "object" ? (event.arguments as Record<string, unknown>).path : undefined,
		event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>).path : undefined,
		event.params && typeof event.params === "object" ? (event.params as Record<string, unknown>).path : undefined,
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate;
	return undefined;
}

function isEditOrWriteTool(name: string): boolean {
	return /(?:^|[._/-])(edit|write)(?:[-_]?file)?$/.test(name) || name === "edit" || name === "write";
}

function findRepoRoot(start: string): string | undefined {
	for (let current = resolve(start); ; current = dirname(current)) {
		if (existsSync(resolve(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
	}
}

function insideRepo(repoRoot: string, absolutePath: string): boolean {
	const pathFromRoot = relative(repoRoot, absolutePath);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && pathFromRoot !== ".." && !pathFromRoot.startsWith("/"));
}

async function trackedPath(absolutePath: string, repoRoot: string, context: ReservationCheckContext): Promise<boolean> {
	if (context.isTrackedPath) return context.isTrackedPath(absolutePath, repoRoot);
	const child = Bun.spawn(["git", "-C", repoRoot, "ls-files", "--error-unmatch", "--", relative(repoRoot, absolutePath)], { stdout: "ignore", stderr: "ignore" });
	return (await child.exited) === 0;
}

function warn(context: ReservationCheckContext, message: string): void {
	if (context.warn) context.warn(message);
	else console.warn(message);
}

function mcpText(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const record = payload as Record<string, unknown>;
	if (record.structuredContent) return record.structuredContent;
	const content = record.content;
	if (Array.isArray(content)) {
		const text = content.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text");
		if (text && typeof (text as Record<string, unknown>).text === "string") {
			try { return JSON.parse((text as Record<string, unknown>).text as string); } catch { return (text as Record<string, unknown>).text; }
		}
	}
	return payload;
}

async function callAgentMail(toolName: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
	const token = process.env.AGENTMAIL_HTTP_BEARER_TOKEN ?? process.env.AGENT_MAIL_TOKEN;
	if (!token) throw new Error("Agent Mail bearer token is unavailable");
	const response = await fetch(process.env.AGENTMAIL_HTTP_URL ?? "http://127.0.0.1:8765/api", {
		method: "POST",
		headers: { authorization: "Bearer " + token, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: argumentsValue } }),
	});
	if (!response.ok) throw new Error("Agent Mail HTTP " + response.status);
	const body = await response.json() as { error?: { message?: string }; result?: unknown };
	if (body.error) throw new Error(body.error.message ?? "Agent Mail request failed");
	return mcpText(body.result);
}

async function resolveAgentName(context: ReservationCheckContext, projectKey: string): Promise<string | undefined> {
	if (context.agentName) return context.agentName;
	if (process.env.AGENT_NAME) return process.env.AGENT_NAME;
	const paneId = process.env.TMUX_PANE;
	if (!paneId) return undefined;
	const result = await callAgentMail("resolve_pane_identity", { project_key: projectKey, pane_id: paneId });
	if (!result || typeof result !== "object") return undefined;
	const record = result as Record<string, unknown>;
	const name = record.agent_name ?? record.agentName ?? record.name;
	return typeof name === "string" && name ? name : undefined;
}

async function lookupReservations(input: ReservationLookupInput, context: ReservationCheckContext): Promise<ReservationLookupResult> {
	if (context.lookupReservations) return context.lookupReservations(input);
	const result = await callAgentMail("check_file_reservation_conflicts", {
		project_key: input.projectKey,
		agent_name: input.agentName,
		paths: [input.path],
	});
	if (!result || typeof result !== "object") throw new Error("Agent Mail returned no reservation result");
	const record = result as Record<string, unknown>;
	const own = record.own_reservations ?? record.ownReservations;
	const conflicts = record.conflicts;
	return {
		covered: record.covered === true || (Array.isArray(own) && own.length > 0),
		conflicts: Array.isArray(conflicts) ? conflicts : [],
	};
}

function cachedLookup(key: string, now: number): ReservationLookupResult | undefined {
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= now) {
		cache.delete(key);
		return undefined;
	}
	return entry.result;
}

export async function check(event: ReservationEvent, context: ReservationCheckContext): Promise<ReservationBlock | undefined> {
	if (!isEditOrWriteTool(eventToolName(event))) return undefined;
	const inputPath = eventPath(event);
	if (!inputPath) return undefined;
	const cwd = context.cwd ?? process.cwd();
	const root = context.repoRoot ?? context.projectRoot ?? findRepoRoot(cwd);
	if (!root) return undefined;
	const absolutePath = resolve(cwd, inputPath);
	if (!insideRepo(root, absolutePath)) return undefined;
	const projectKey = context.projectKey ?? root;
	const pathKey = relative(root, absolutePath).split("\\\\").join("/");
	const knownAgent = context.agentName ?? process.env.AGENT_NAME;
	const now = context.now?.() ?? Date.now();
	const earlyKey = knownAgent ? projectKey + "\\0" + knownAgent + "\\0" + pathKey : undefined;
	const early = earlyKey ? cachedLookup(earlyKey, now) : undefined;
	if (early) return early.covered ? undefined : { block: true, reason: RESERVATION_REASON };
	if (!(await trackedPath(absolutePath, root, context))) return undefined;
	let agentName = knownAgent;
	try {
		if (!agentName) agentName = await resolveAgentName(context, projectKey);
	} catch (error) {
		warn(context, "fleet-guard reservations fail-open: Agent Mail identity lookup failed (" + String(error) + ")");
		return undefined;
	}
	if (!agentName) {
		warn(context, "fleet-guard reservations fail-open: Agent Mail identity is unavailable");
		return undefined;
	}
	const key = projectKey + "\\0" + agentName + "\\0" + pathKey;
	const cached = cachedLookup(key, now);
	if (cached) return cached.covered ? undefined : { block: true, reason: RESERVATION_REASON };
	try {
		const result = await lookupReservations({ projectKey, agentName, path: pathKey }, context);
		cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
		if (result.covered) return undefined;
		return { block: true, reason: RESERVATION_REASON };
	} catch (error) {
		warn(context, "fleet-guard reservations fail-open: Agent Mail reservation lookup failed (" + String(error) + ")");
		return undefined;
	}
}
export default check;
