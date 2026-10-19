import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { type ActiveHold, readActiveHolds } from "../reservation-age.ts";
import { checkHotCap, HOT_CAP_MINUTES, isHotPath, isReservationTool, readHotPaths, renewScope, reservationArgs } from "./hot-cap.ts";
import { shellTokens } from "./scratch.ts";

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
	/** Live holds for renewal-cap judgment (test seam; production reads the archive). */
	activeHolds?: ActiveHold[];
	/** Agent Mail archive root override for hold lookup. */
	archiveRoot?: string;
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

/** True for Agent Mail reservation-release tool calls (any prefix/suffix shape). */
function isReleaseTool(name: string): boolean {
	const lowered = name.toLowerCase();
	return lowered.includes("file_reservation") && lowered.includes("release");
}

/** Drop cached lookups so the next edit re-queries instead of seeing a stale allow. */
function dropCachedLookups(projectKey: string, agentName: string | undefined): void {
	const scope = agentName === undefined ? projectKey + "\\0" : projectKey + "\\0" + agentName + "\\0";
	for (const key of cache.keys()) if (key.startsWith(scope)) cache.delete(key);
}

function isBashTool(name: string): boolean {
	return /(?:^|[._/-])bash$/.test(name.toLowerCase());
}

function bashCommand(event: ReservationEvent): string | undefined {
	const candidates: unknown[] = [
		event.arguments && typeof event.arguments === "object" ? (event.arguments as Record<string, unknown>).command : undefined,
		event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>).command : undefined,
		event.params && typeof event.params === "object" ? (event.params as Record<string, unknown>).command : undefined,
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate;
	return undefined;
}

/**
 * Project/agent of an `am file_reservations release` CLI call, parsed
 * source-aware: only UNQUOTED words count, so the same words inside an echo
 * string never clear the cache. Positional PROJECT then AGENT per
 * `am file_reservations release --help`; --paths/--ids consume the next word
 * and --opt=value is one word. Returns "ambiguous" when a release is present
 * but unscannable: the caller must clear everything, because under-clearing
 * is the bug and over-clearing costs one re-query.
 */
function bashReleaseScope(command: string): { project: string; agent: string } | "ambiguous" | undefined {
	const words = shellTokens(command).filter(token => !token.quoted).map(token => token.text);
	for (let i = 0; i + 2 < words.length; i++) {
		const head = words[i]!;
		if (head !== "am" && !head.endsWith("/am")) continue;
		if (words[i + 1] !== "file_reservations" || words[i + 2] !== "release") continue;
		const positionals: string[] = [];
		for (let j = i + 3; j < words.length; j++) {
			const word = words[j]!;
			if (/^[;&|()]$/.test(word)) continue;
			if (word === "--paths" || word === "--ids") { j++; continue; }
			if (word.startsWith("--")) {
				if (word.includes("=") || word === "--help") continue;
				return "ambiguous";
			}
			if (word === "-h") continue;
			if (word.startsWith("-")) return "ambiguous";
			positionals.push(word);
		}
		if (positionals.length < 2 || positionals[0] === undefined || positionals[1] === undefined) return "ambiguous";
		return { project: positionals[0], agent: positionals[1] };
	}
	return undefined;
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

export let AGENT_MAIL_STORAGE_ROOT: string | undefined;

export function storageRootFromEnvironment(environment: unknown): string | undefined {
	if (!environment || typeof environment !== "object") return undefined;
	const databaseUrl = (environment as Record<string, unknown>).database_url;
	if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("sqlite:")) return undefined;
	const databasePath = databaseUrl.slice("sqlite:".length).replace(/^\/+/, "/");
	return databasePath.startsWith("/") ? dirname(databasePath) : undefined;
}

async function callAgentMailResource(uri: string): Promise<unknown> {
	const token = process.env.AGENTMAIL_HTTP_BEARER_TOKEN ?? process.env.AGENT_MAIL_TOKEN;
	if (!token) throw new Error("Agent Mail bearer token is unavailable");
	const response = await fetch(process.env.AGENTMAIL_HTTP_URL ?? "http://127.0.0.1:8765/api", {
		method: "POST",
		headers: { authorization: "Bearer " + token, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "resources/read", params: { uri } }),
	});
	if (!response.ok) throw new Error("Agent Mail HTTP " + response.status);
	const body = await response.json() as { error?: { message?: string }; result?: { contents?: unknown[] } };
	if (body.error) throw new Error(body.error.message ?? "Agent Mail resource request failed");
	const content = body.result?.contents?.find((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string");
	if (!content) throw new Error("Agent Mail environment resource is empty");
	const text = (content as Record<string, unknown>).text as string;
	try { return JSON.parse(text); } catch { throw new Error("Agent Mail environment resource is not JSON"); }
}

export async function resolveAgentMailStorageRoot(): Promise<string | undefined> {
	const environment = await callAgentMailResource("resource://config/environment");
	return storageRootFromEnvironment(environment);
}

export async function exportAgentMailStorageRoot(): Promise<string | undefined> {
	const root = await resolveAgentMailStorageRoot();
	if (root) AGENT_MAIL_STORAGE_ROOT = root;
	if (AGENT_MAIL_STORAGE_ROOT) process.env.AGENT_MAIL_STORAGE_ROOT = AGENT_MAIL_STORAGE_ROOT;
	return AGENT_MAIL_STORAGE_ROOT;
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

function normalizeReservationPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function reservationPatternCovers(pattern: string, requestedPath: string): boolean {
	const normalizedPattern = normalizeReservationPath(pattern);
	const normalizedPath = normalizeReservationPath(requestedPath);
	if (normalizedPattern === normalizedPath) return true;
	const hasWildcard = normalizedPattern.includes("*") || normalizedPattern.includes("?") || normalizedPattern.includes("[");
	if (!hasWildcard && normalizedPath.startsWith(normalizedPattern + "/")) return true;
	let expression = "^";
	for (let index = 0; index < normalizedPattern.length; index += 1) {
		const character = normalizedPattern[index]!;
		if (character === "*" && normalizedPattern[index + 1] === "*") {
			expression += ".*";
			index += 1;
		} else if (character === "*") {
			expression += "[^/]*";
		} else if (character === "?") {
			expression += "[^/]";
		} else {
			if ("\\^$+{}().|".includes(character)) expression += "\\";
			expression += character;
		}
	}
	return new RegExp(expression + "$").test(normalizedPath);
}

export function reservationLookupFromResponse(response: unknown, requestedPath: string): ReservationLookupResult {
	if (!response || typeof response !== "object") throw new Error("Agent Mail returned no reservation result");
	const record = response as Record<string, unknown>;
	const active = record.own_active ?? record.own_reservations ?? record.ownReservations;
	const ownActive = Array.isArray(active) ? active : [];
	const covered = record.covered === true || ownActive.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const reservation = entry as Record<string, unknown>;
		return reservation.exclusive !== false && typeof reservation.path_pattern === "string" && reservationPatternCovers(reservation.path_pattern, requestedPath);
	});
	const conflicts = record.conflicts;
	return { covered, conflicts: Array.isArray(conflicts) ? conflicts : [] };
}

async function lookupReservations(input: ReservationLookupInput, context: ReservationCheckContext): Promise<ReservationLookupResult> {
	if (context.lookupReservations) return context.lookupReservations(input);
	const response = await callAgentMail("check_file_reservation_conflicts", {
		project_key: input.projectKey,
		agent_name: input.agentName,
		paths: [input.path],
	});
	return reservationLookupFromResponse(response, input.path);
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

/** RES1: refuse over-cap exclusive holds on hot paths at request/renew time. */
async function checkHotReservation(
	event: ReservationEvent,
	context: ReservationCheckContext,
	kind: "reserve" | "renew",
): Promise<ReservationBlock | undefined> {
	const cwd = context.cwd ?? process.cwd();
	const root = context.repoRoot ?? context.projectRoot ?? findRepoRoot(cwd);
	if (!root) return undefined;
	const hotPaths = readHotPaths(root);
	if (hotPaths.length === 0) return undefined;
	const args = reservationArgs(event);
	const verdict = checkHotCap({ hotPaths, request: { ...args, kind } });
	if (verdict.blocked) return { block: true, reason: verdict.reason ?? "fleet-guard hot-path cap refused the hold" };
	if (kind === "renew") return checkHotRenewal(event, context, hotPaths);
	return undefined;
}

/**
 * A renewal inherits the hold's exclusivity: judge the existing hold's own
 * exclusive flag and path, not the call's flags. ID-only renewals carry no
 * paths, so without this the cap is bypassed. Total lifetime is hold age plus
 * the requested extension; past the cap the renewal is refused.
 */
async function checkHotRenewal(
	event: ReservationEvent,
	context: ReservationCheckContext,
	hotPaths: readonly string[],
): Promise<ReservationBlock | undefined> {
	const scope = renewScope(event);
	const holder = scope.agentName ?? context.agentName;
	if (!holder) {
		warn(context, "fleet-guard hot-path cap fail-open: renewal without an agent identity cannot be matched to a hold");
		return undefined;
	}
	const now = context.now?.() ?? Date.now();
	let holds = context.activeHolds;
	if (!holds) {
		const archiveRoot = context.archiveRoot ?? AGENT_MAIL_STORAGE_ROOT ?? process.env.AGENT_MAIL_STORAGE_ROOT;
		if (!archiveRoot) {
			warn(context, "fleet-guard hot-path cap fail-open: no hold source for renewal judgment");
			return undefined;
		}
		const projectKey = scope.projectKey ?? context.projectKey;
		if (!projectKey) {
			warn(context, "fleet-guard hot-path cap fail-open: renewal without a project key cannot be matched to a hold");
			return undefined;
		}
		const report = readActiveHolds(archiveRoot, projectKey, now);
		if (!report.available) {
			warn(context, "fleet-guard hot-path cap fail-open: hold archive is unavailable");
			return undefined;
		}
		holds = report.holds;
	}
	const namedPaths = reservationArgs(event).paths;
	const inScope = (hold: ActiveHold): boolean => {
		if (scope.ids.length > 0 && (hold.id === null || !scope.ids.includes(hold.id))) return false;
		if (namedPaths.length > 0 && !namedPaths.some((named) =>
			reservationPatternCovers(hold.path_pattern, named) || reservationPatternCovers(named, hold.path_pattern))) return false;
		return true;
	};
	const extendMinutes = scope.extendSeconds === undefined ? 0 : scope.extendSeconds / 60;
	for (const hold of holds) {
		if (hold.agent_name !== holder) continue;
		if (!inScope(hold)) continue;
		if (!hold.exclusive) continue;
		const hot = isHotPath(hotPaths, hold.path_pattern);
		if (hot === null) continue;
		const totalMinutes = (now - hold.granted_ms) / 60000 + extendMinutes;
		if (totalMinutes > HOT_CAP_MINUTES) {
			const label = hold.id === null ? hold.path_pattern : `hold ${hold.id} on ${hold.path_pattern}`;
			return { block: true, reason: `fleet-guard hot-path cap: renewal of exclusive ${label} reaches ${Math.round(totalMinutes)} min, over the ${HOT_CAP_MINUTES} min cap for hot path ${hot} (listed in .omp/hot-paths). Release first.` };
		}
	}
	return undefined;
}

interface BashReservationCall { kind: "reserve" | "renew"; event: ReservationEvent }

/**
 * `am file_reservations reserve|renew` CLI calls in a bash command, parsed
 * source-aware (only an UNQUOTED `am file_reservations <verb>` head counts, so
 * echoed text never triggers). reserve: PROJECT AGENT PATHS... with --ttl
 * seconds (CLI default 3600) and --exclusive/--shared; a call without --shared
 * is judged exclusive (cap-safe: only >30 min on a hot path is refused).
 * renew: PROJECT AGENT with --extend-seconds (default 1800), --paths, --ids.
 * Each call is mapped onto the MCP argument shape so the MCP route's checks run.
 */
function bashReservationCalls(command: string): BashReservationCall[] {
	const tokens = shellTokens(command);
	const calls: BashReservationCall[] = [];
	for (let i = 0; i + 2 < tokens.length; i++) {
		const head = tokens[i]!;
		if (head.quoted || (head.text !== "am" && !head.text.endsWith("/am"))) continue;
		if (tokens[i + 1]!.quoted || tokens[i + 1]!.text !== "file_reservations") continue;
		const verb = tokens[i + 2]!;
		if (verb.quoted || (verb.text !== "reserve" && verb.text !== "renew")) continue;
		const positionals: string[] = [];
		let ttl: number | undefined;
		let extend: number | undefined;
		let shared = false;
		const named: string[] = [];
		const ids: number[] = [];
		let j = i + 3;
		for (; j < tokens.length; j++) {
			const word = tokens[j]!.text;
			if (!tokens[j]!.quoted && /^(;|&&|\|\||\||&|\n)$/.test(word)) break;
			const eq = !tokens[j]!.quoted && word.startsWith("--") ? word.indexOf("=") : -1;
			const flag = eq >= 0 ? word.slice(0, eq) : word;
			const inline = eq >= 0 ? word.slice(eq + 1) : undefined;
			if (!tokens[j]!.quoted && ["--ttl", "--extend-seconds", "--reason", "--paths", "--ids"].includes(flag)) {
				const value = inline ?? tokens[++j]?.text ?? "";
				if (flag === "--ttl") ttl = Number(value);
				else if (flag === "--extend-seconds") extend = Number(value);
				else if (flag === "--paths") named.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
				else if (flag === "--ids") ids.push(...value.split(",").map(Number).filter((item) => Number.isFinite(item)));
				continue;
			}
			if (!tokens[j]!.quoted && flag === "--shared") { shared = true; continue; }
			if (!tokens[j]!.quoted && word.startsWith("-")) continue;
			positionals.push(word);
		}
		i = j - 1;
		const [project, agent, ...rest] = positionals;
		if (verb.text === "reserve") {
			const seconds = ttl !== undefined && Number.isFinite(ttl) ? ttl : 3600;
			calls.push({ kind: "reserve", event: { arguments: { project_key: project, agent_name: agent, paths: rest, exclusive: !shared, ttl_seconds: seconds } } });
		} else {
			const seconds = extend !== undefined && Number.isFinite(extend) ? extend : 1800;
			calls.push({ kind: "renew", event: { arguments: { project_key: project, agent_name: agent, paths: named, exclusive: named.length > 0, extend_seconds: seconds, ...(ids.length ? { file_reservation_ids: ids } : {}) } } });
		}
	}
	return calls;
}

export async function check(event: ReservationEvent, context: ReservationCheckContext): Promise<ReservationBlock | undefined> {
	// A release retires holds: drop cached allows so the next edit re-queries
	// instead of seeing a stale lock. Releases are never blocked.
	if (isReleaseTool(eventToolName(event))) {
		const cwd = context.cwd ?? process.cwd();
		const root = context.repoRoot ?? context.projectRoot ?? findRepoRoot(cwd);
		dropCachedLookups(context.projectKey ?? root ?? cwd, context.agentName ?? process.env.AGENT_NAME);
		return undefined;
	}
	const reservationKind = isReservationTool(eventToolName(event));
	// The am CLI reaches the hook as a bash tool call: parse it source-aware.
	if (isBashTool(eventToolName(event))) {
		const command = bashCommand(event);
		if (command !== undefined) {
			const scope = bashReleaseScope(command);
			if (scope === "ambiguous") clearReservationCache();
			else if (scope !== undefined) dropCachedLookups(scope.project, scope.agent);
		}
		if (command !== undefined) {
			for (const call of bashReservationCalls(command)) {
				const block = await checkHotReservation(call.event, context, call.kind);
				if (block) return block;
			}
		}
		return undefined;
	}
	if (reservationKind !== null) return checkHotReservation(event, context, reservationKind);
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
	if (early?.covered) return undefined;
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
	if (cached?.covered) return undefined;
	try {
		const result = await lookupReservations({ projectKey, agentName, path: pathKey }, context);
		if (result.covered) cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
		if (result.covered) return undefined;
		return { block: true, reason: RESERVATION_REASON };
	} catch (error) {
		warn(context, "fleet-guard reservations fail-open: Agent Mail reservation lookup failed (" + String(error) + ")");
		return undefined;
	}
}
export default check;
