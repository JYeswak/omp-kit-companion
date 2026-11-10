/** Project registration preserves fleet routing/admission metadata, creates
 * named seats and proves their initial goal delivery. Status reads live seats
 * and their latest recorded mail wake; registration is not a monitoring service.
 */
import { closeSync, existsSync, fdatasyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { deliverFirstSeatGoal } from "./send.ts";
import type { TernObserverIo, TernSeatBinding } from "./plane-tern.ts";
import { observeTernSeat } from "./plane-tern.ts";
import { callAgentMail } from "./fleet-guard/reservations.ts";
import { fleetWatchConfigPath } from "./service.ts";
import { loadFleetWatchConfig, type FleetWatchSession } from "./fleet-watch.ts";
import { run as runBounded } from "./kitlib/run.ts";
import { writePrivate } from "./mutations.ts";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { readJsonl } from "./kitlib/jsonl.ts";

export interface ProjectAddExec {
	run: (argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string>; deadlineMs?: number }) => Promise<{ code: number; out: string; err: string }>;
}

export interface ProjectAddMail {
	call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface ProjectAddDeps {
	exec?: ProjectAddExec;
	mail?: ProjectAddMail;
	observe?: (seat: TernSeatBinding, io: TernObserverIo) => Promise<{ sessionFile: string | null }>;
	io?: TernObserverIo;
	wait?: (ms: number) => Promise<void>;
}

export interface ProjectAddPaths {
	home: string;
	stateRoot: string;

	fleetWatchPath: string;
}

const SESSION_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_OPAQUE_LEN = 128;


export function resolveProjectAddPaths(env: NodeJS.ProcessEnv, home: string): ProjectAddPaths {
	const xdg = env.XDG_STATE_HOME;
	const stateRoot = xdg !== undefined && xdg !== "" && isAbsolute(xdg) && resolve(xdg) === xdg
		? join(xdg, "omp-kit") : join(home, ".local", "state", "omp-kit");
	return { home, stateRoot, fleetWatchPath: fleetWatchConfigPath(home) };
}
async function defaultExec(argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string>; deadlineMs?: number }): Promise<{ code: number; out: string; err: string }> {
	const result = await runBounded([...argv], {
		deadline_s: Math.max(1, Math.ceil((opts?.deadlineMs ?? 60_000) / 1000)),
		...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts?.env !== undefined ? { env: opts.env } : {}),
	});
	return { code: result.rc ?? 1, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr) };
}

async function defaultMail(tool: string, args: Record<string, unknown>): Promise<unknown> {
	return callAgentMail(tool, args);
}

function defaultObserve(seat: TernSeatBinding, io: TernObserverIo): Promise<{ sessionFile: string | null }> {
	return observeTernSeat(seat, io).then(
		(observation) => ({ sessionFile: observation.sessionFile }),
		() => ({ sessionFile: null }),
	);
}



function agentNameOf(value: unknown): string | null {
	const record = (typeof value === "object" && value !== null ? value : null) as Record<string, unknown> | null;
	const name = record === null ? null : record.agent_name ?? record.name;
	return typeof name === "string" && name.trim() !== "" ? name : null;
}

export interface ProjectAddInput {
	repo: string;
	session: string;
	workers: number;
	profile: string;
	model?: string;
	mission?: string;
	goal?: string;
	orientation?: string;
	env: NodeJS.ProcessEnv;
	deps?: ProjectAddDeps;
	pollMs?: number;
	deadlineMs?: number;
}

export interface ProjectAddPlan {
	session: string;
	repo: string;
	projectKey: string;
	seats: { role: "director" | "worker"; index: number; name: string | null }[];
	stores: { optIn: { path: string; action: "create" | "keep" }; roster: { path: string; action: "insert" | "keep" }; fleetWatch: { path: string; action: "insert" | "patch" | "keep" } };
	turnOn: { argv: string[] };
	deliveries: { seat: string; kind: "goal-set" | "message" }[];
	mission: string | null;
}

function fail(code: string, detail: string, remediation: string): { ok: false; code: string; detail: string; remediation: string } {
	return { ok: false, code, detail, remediation };
}

function checkInput(input: ProjectAddInput, home: string): { ok: true; repo: string } | { ok: false; code: string; detail: string; remediation: string } {
	if (!isAbsolute(input.repo) || resolve(input.repo) !== input.repo) {
		return fail("PROJECT_REPO_INVALID", "repo must be an absolute canonical path", "Pass an absolute --repo path with no symlinks or .. segments.");
	}
	let stat: { isDirectory: boolean };
	try {
		const st = statSync(input.repo);
		stat = { isDirectory: st.isDirectory() };
	} catch {
		return fail("PROJECT_REPO_MISSING", `repo ${input.repo} does not exist`, "Point --repo at the repository working copy to manage.");
	}
	if (!stat.isDirectory) return fail("PROJECT_REPO_INVALID", `repo ${input.repo} is not a directory`, "Point --repo at the repository working copy to manage.");
	if (!SESSION_NAME.test(input.session)) {
		return fail("PROJECT_SESSION_INVALID", `session ${JSON.stringify(input.session)} must match [a-z0-9][a-z0-9-]*`, "Pick a lowercase session name like skillgrowth.");
	}
	if (!Number.isSafeInteger(input.workers) || input.workers < 0 || input.workers > 16) {
		return fail("PROJECT_WORKERS_INVALID", "workers must be an integer 0..16", "Pass --workers N with 0 to 16 worker seats beside the director.");
	}
	if (typeof input.profile !== "string" || !input.profile.trim() || input.profile.length > MAX_OPAQUE_LEN) {
		return fail("PROJECT_PROFILE_INVALID", "profile must be a non-empty name", "Pass the Tern profile to start the seats with via --profile.");
	}
	if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > MAX_OPAQUE_LEN)) {
		return fail("PROJECT_MODEL_INVALID", "model must be a non-empty name", "Pass the seat model via --model or omit it.");
	}
	if (input.mission !== undefined && !/^[^\n:][^\n]*:[1-9][0-9]{0,6}$/.test(input.mission)) {
		return fail("PROJECT_MISSION_INVALID", "mission must look like <slug>:<number>", "Pass --mission like skill-library-growth:104 or omit it.");
	}
	if (input.goal !== undefined && !input.goal.trim()) return fail("PROJECT_GOAL_INVALID", "goal must not be blank", "Pass a director objective via --goal or omit it for the default.");
	if (input.orientation !== undefined && !input.orientation.trim()) {
		return fail("PROJECT_ORIENTATION_INVALID", "orientation must not be blank", "Pass worker orientation text via --orientation or omit it for the default.");
	}
	if (!home || !isAbsolute(home) || resolve(home) !== home) {
		return fail("PROJECT_HOME_UNAVAILABLE", "a canonical absolute HOME is required", "Set HOME to an absolute path with no symlinks.");
	}
	return { ok: true, repo: input.repo };
}

function directorGoal(input: ProjectAddInput, session: string, repo: string): string {
	return input.goal?.trim() ?? `Own ${session}: keep ${repo} green, triaged, and moving; report blockers to the chief.`;
}

function workerOrientation(input: ProjectAddInput, session: string, repo: string, index: number, total: number): string {
	return input.orientation?.trim() ?? `You are worker ${index + 1} of ${total} in ${session} on ${repo}; take goals from the director and report findings back.`;
}

/** Minimal text insertion of one sessions entry: only the new entry's lines are added, never a reformat. */
export function insertRosterSession(text: string, name: string, entry: string): string | null {
	const key = text.indexOf('"sessions"');
	if (key < 0) return null;
	const open = text.indexOf("{", key);
	if (open < 0) return null;
	let depth = 0, inStr = false, esc = false, end = -1;
	for (let i = open; i < text.length; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') { inStr = true; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end < 0) return null;
	const inner = text.slice(open + 1, end);
	const lineStart = text.lastIndexOf("\n", key) + 1;
	const baseIndent = text.slice(lineStart, key).match(/^\s*/)?.[0] ?? "";
	const firstEntry = /\n(\s*)"/.exec(inner);
	const entryIndent = firstEntry?.[1] ?? baseIndent + "  ";
	const line = `\n${entryIndent}"${name}": ${entry}`;
	if (inner.trim() === "") return text.slice(0, open + 1) + line + "\n" + text.slice(end);
	return text.slice(0, open + 1) + line + "," + text.slice(open + 1);
}

/** Minimal text insertion of one fleet-watch sessions[] element. */
export function insertFleetWatchSession(text: string, entry: string): string | null {
	const key = text.indexOf('"sessions"');
	if (key < 0) return null;
	const open = text.indexOf("[", key);
	if (open < 0) return null;
	let depth = 0, inStr = false, esc = false, end = -1;
	for (let i = open; i < text.length; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') { inStr = true; continue; }
		if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end < 0) return null;
	const inner = text.slice(open + 1, end);
	const lineStart = text.lastIndexOf("\n", key) + 1;
	const baseIndent = text.slice(lineStart, key).match(/^\s*/)?.[0] ?? "";
	const firstEntry = /\n(\s*)\S/.exec(inner);
	const entryIndent = firstEntry?.[1] ?? baseIndent + "  ";
	if (inner.trim() === "") return text.slice(0, open + 1) + `\n${entryIndent}${entry}\n${baseIndent}` + text.slice(end);
	return text.slice(0, end) + `,\n${entryIndent}${entry}\n${baseIndent}` + text.slice(end);
}

interface StoredFile {
	path: string;
	before: string | null;
	after: string | null;
}

function readBytes(path: string): string | null {
	try {
		return readFileSync(path).toString("base64");
	} catch {
		return null;
	}
}

function writeBytes(path: string, base64: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, Buffer.from(base64, "base64"));
	try {
		const fd = openSync(dirname(path), "r");
		try { fdatasyncSync(fd); } finally { closeSync(fd); }
	} catch { /* best effort directory durability */ }
}

export interface ProjectAddReceipt {
	schema_version: 1;
	kind: "project-add";
	id: string;
	state: "APPLIED" | "PARTIAL" | "UNDONE";
	session: string;
	repo: string;
	projectKey: string;
	profile: string;
	model: string | null;
	mission: string | null;
	agents: string[];
	coordinatorPane: string | null;
	workerPanes: string[];
	tab: string | null;
	files: StoredFile[];
	createdAt: string;
}

function receiptPath(stateRoot: string, id: string): string {
	return join(stateRoot, `project-add-${id}.json`);
}

function readReceipt(stateRoot: string, id: string): ProjectAddReceipt | null {
	if (!/^[a-f0-9-]+$/.test(id)) return null;
	let raw: string;
	try {
		raw = readFileSync(receiptPath(stateRoot, id), "utf8");
	} catch {
		return null;
	}
	try {
		const value = JSON.parse(raw) as ProjectAddReceipt;
		if (!value || typeof value !== "object" || value.schema_version !== 1 || value.kind !== "project-add" || value.id !== id) return null;
		return value;
	} catch {
		return null;
	}
}

export function planProjectAdd(input: ProjectAddInput): { ok: true; plan: ProjectAddPlan } | { ok: false; code: string; detail: string; remediation: string } {
	const home = input.env.HOME ?? "";
	const checked = checkInput(input, home);
	if (!checked.ok) return checked;
	const fleetWatchPath = fleetWatchConfigPath(home);
	const turnOn = resolveTurnOnPath(input.env, fleetWatchPath);
	if (!turnOn.ok) return turnOn;
	const paths = resolveProjectAddPaths(input.env, home);
	const rosterPath = resolveRosterPath(input.env, turnOn.bin);
	const repo = realpathSync(input.repo);
	const names: (string | null)[] = Array.from({ length: 1 + input.workers }, () => null);
	const seats = names.map((name, index) => ({ role: (index === 0 ? "director" : "worker") as "director" | "worker", index, name }));
	return {
		ok: true,
		plan: {
			session: input.session, repo, projectKey: repo, seats,
			stores: {
				optIn: { path: join(repo, ".omp", "fleet.json"), action: existsSync(join(repo, ".omp", "fleet.json")) ? "keep" : "create" },
				roster: { path: rosterPath, action: "insert" },
				fleetWatch: { path: paths.fleetWatchPath, action: "insert" },
			},
			turnOn: { argv: [turnOn.bin, "--turn-on", "--session", input.session, "--profile", input.profile.trim(), "--apply", "--json"] },
			deliveries: [
				{ seat: "coordinator", kind: "goal-set" as const },
				...Array.from({ length: input.workers }, (_, index) => ({ seat: `worker-${index}`, kind: "message" as const })),
			],
			mission: input.mission ?? null,
		},
	};
}

/** Turn-on script path: explicit env override, else the fleet-watch `respawnSeat` key. */
export function resolveTurnOnPath(env: NodeJS.ProcessEnv, fleetWatchPath: string): { ok: true; bin: string } | { ok: false; code: string; detail: string; remediation: string } {
	const fromEnv = env.OMP_KIT_RESPAWN_SEAT?.trim() ?? "";
	if (fromEnv !== "") {
		if (!isAbsolute(fromEnv) || resolve(fromEnv) !== fromEnv) {
			return { ok: false, code: "PROJECT_TURN_ON_INVALID", detail: "OMP_KIT_RESPAWN_SEAT must be an absolute canonical path", remediation: "Set OMP_KIT_RESPAWN_SEAT to the turn-on script path." };
		}
		return { ok: true, bin: fromEnv };
	}
	try {
		const config = JSON.parse(readFileSync(fleetWatchPath, "utf8")) as { respawnSeat?: unknown };
		if (typeof config?.respawnSeat === "string" && config.respawnSeat.trim() !== "" && isAbsolute(config.respawnSeat.trim()) && resolve(config.respawnSeat.trim()) === config.respawnSeat.trim()) {
			return { ok: true, bin: config.respawnSeat.trim() };
		}
	} catch { /* absent or unreadable config: fall through to the refusal below */ }
	return { ok: false, code: "PROJECT_TURN_ON_UNCONFIGURED", detail: "no turn-on script configured", remediation: "Set OMP_KIT_RESPAWN_SEAT to the turn-on script path, or set a fleet-watch.json respawnSeat key." };
}

/** Roster path: explicit OMP_KIT_FLEET_ROSTER override, else the turn-on script's own ROSTER file. */
export function resolveRosterPath(env: NodeJS.ProcessEnv, turnOnBin: string): string {
	const override = env.OMP_KIT_FLEET_ROSTER?.trim() ?? "";
	if (override !== "") return override;
	return join(dirname(dirname(turnOnBin)), "fleet-roster.json");
}

/**
 * Parse the real turn-on (--turn-on --apply --json) output: result ALL_NAMED with
 * per-seat rows carrying the created block ids as strings (ids exceed 2^53, so
 * they are never parsed as numbers). coordinatorPane is the director row's
 * block; workerPanes are the worker rows' blocks in order.
 */
function parseTurnOn(stdout: string, workers: number): { coordinatorPane: string; workerPanes: string[]; tab: string | null } | { error: string } | null {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.result !== "ALL_NAMED") {
		const rows = Array.isArray(record.rows) ? (record.rows as { name?: unknown; result?: unknown }[]) : [];
		return { error: `turn-on ${typeof record.result === "string" ? record.result : "refused"}: ${rows.map((row) => `${String(row.name ?? "?")}=${String(row.result ?? "?")}`).join(", ") || "no rows"}` };
	}
	const rows = Array.isArray(record.rows) ? (record.rows as Record<string, unknown>[]) : null;
	if (rows === null) return null;
	const pane = (entry: unknown): string | null => {
		if (typeof entry !== "string") return null;
		const text = entry.trim().startsWith("tern:") ? entry.trim().slice("tern:".length) : entry.trim();
		return text !== "" && /^[0-9]+$/.test(text) ? text : null;
	};
	const director = rows.find((row) => row.role === "director");
	const coordinatorPane = director === undefined ? null : pane(director.block);
	const panes: string[] = [];
	for (const row of rows.filter((row) => row.role === "worker")) {
		const id = pane(row.block);
		if (id === null) return null;
		panes.push(id);
	}
	if (coordinatorPane === null || panes.length !== workers) return null;
	const tab = record.tab === undefined || record.tab === null ? null : typeof record.tab === "string" && record.tab.trim() !== "" ? record.tab.trim() : null;
	return { coordinatorPane, workerPanes: panes, tab };
}

export interface ProjectApplyResult {
	status: "APPLIED";
	session: string;
	agents: { role: "director" | "worker"; name: string; pane: string }[];
	receiptId: string;
	census: { named: string };
}

export async function applyProjectAdd(input: ProjectAddInput): Promise<{ ok: true; result: ProjectApplyResult } | { ok: false; code: string; detail: string; remediation: string; receiptId?: string }> {
	const home = input.env.HOME ?? "";
	const checked = checkInput(input, home);
	if (!checked.ok) return checked;
	const fleetWatchPath = fleetWatchConfigPath(home);
	const turnOn = resolveTurnOnPath(input.env, fleetWatchPath);
	if (!turnOn.ok) return turnOn;
	const basePaths = resolveProjectAddPaths(input.env, home);
	const rosterPath = resolveRosterPath(input.env, turnOn.bin);
	const paths = { ...basePaths, rosterPath };
	const exec = input.deps?.exec ?? { run: defaultExec };
	const mail = input.deps?.mail ?? { call: defaultMail };
	const repo = realpathSync(input.repo);
	const session = input.session;
	const planned = planProjectAdd({ ...input, repo });
	if (!planned.ok) return planned;
	const failed = (code: string, detail: string, remediation: string, receiptId?: string) => ({ ok: false as const, code, detail, remediation, ...(receiptId === undefined ? {} : { receiptId }) });

	// Existing session: resume a pane-less entry left by an interrupted run, refuse a managed one.
	let fleetText: string | null = null;
	try {
		fleetText = readFileSync(paths.fleetWatchPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			return failed("PROJECT_FLEET_WATCH_UNREADABLE", `fleet-watch config ${paths.fleetWatchPath} is unreadable`, "Repair the JSON file or point OMP_KIT_FLEET_WATCH_CONFIG at a readable one.");
		}
	}
	let existing: FleetWatchSession | null = null;
	if (fleetText !== null) {
		try {
			const parsed = loadFleetWatchConfig(paths.fleetWatchPath);
			existing = parsed.sessions.find((row) => row.session === session) ?? null;
		} catch {
			return failed("PROJECT_FLEET_WATCH_INVALID", `fleet-watch config ${paths.fleetWatchPath} does not parse`, "Repair the JSON file; the run changed nothing.");
		}
		if (existing !== null && existing.coordinatorPane.trim() !== "") {
			return failed("PROJECT_SESSION_EXISTS", `session ${session} is already a managed project`, "Undo it first (project add --undo RECEIPT) or pick another --session.");
		}
	}

	// Roster names are reused on resume so a retried run never mints duplicates.
	let rosterText: string | null = null;
	try {
		rosterText = readFileSync(paths.rosterPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			return failed("PROJECT_ROSTER_UNREADABLE", `roster ${paths.rosterPath} is unreadable`, "Repair the JSON file or point OMP_KIT_FLEET_ROSTER at a readable one.");
		}
	}
	let rosterNames: string[] | null = null;
	if (rosterText !== null) {
		try {
			const roster = JSON.parse(rosterText) as { sessions?: Record<string, { director?: unknown; workers?: unknown }> };
			const entry = roster?.sessions?.[session];
			if (entry && typeof entry === "object") {
				const director = typeof entry.director === "string" ? entry.director : null;
				const workers = Array.isArray(entry.workers) ? entry.workers.filter((name): name is string => typeof name === "string") : null;
				if (director !== null && workers !== null && workers.length === input.workers) rosterNames = [director, ...workers];
			}
		} catch {
			return failed("PROJECT_ROSTER_INVALID", `roster ${paths.rosterPath} does not parse`, "Repair the JSON file; the run changed nothing.");
		}
	}

	// 1. Mint seat names in the repo's Agent Mail project (skipped when the roster already names them).
	let agents: string[];
	if (rosterNames !== null) {
		agents = rosterNames;
	} else {
		agents = [];
		try {
			for (let index = 0; index < 1 + input.workers; index++) {
				const minted = await mail.call("create_agent_identity", { project_key: repo });
				const name = agentNameOf(minted);
				if (name === null) return failed("PROJECT_MAIL_MINT_FAILED", "Agent Mail minted an identity without a usable name", "Check the Agent Mail server health and retry; nothing was written.");
				agents.push(name);
			}
		} catch (error) {
			return failed("PROJECT_MAIL_UNAVAILABLE", `Agent Mail minting failed: ${error instanceof Error ? error.message : String(error)}`, "Check AGENTMAIL_HTTP_URL and the bearer token; nothing was written.");
		}
	}
	const [director, ...workers] = agents as [string, ...string[]];

	// 2-4. File stores, snapshotting before-bytes for byte-identical undo.
	const files: StoredFile[] = [];
	const optInPath = join(repo, ".omp", "fleet.json");
	const optInBefore = readBytes(optInPath);
	if (optInBefore === null) {
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeBytes(optInPath, Buffer.from('{"enabled": true}\n', "utf8").toString("base64"));
	}
	files.push({ path: optInPath, before: optInBefore, after: readBytes(optInPath) });
	const rosterEntry = JSON.stringify({ director, workers });
	let nextRoster: string;
	if (rosterText === null) {
		nextRoster = `{\n  "sessions": {\n    "${session}": ${rosterEntry}\n  }\n}\n`;
	} else {
		const inserted = insertRosterSession(rosterText, session, rosterEntry);
		if (inserted === null) return failed("PROJECT_ROSTER_UNEDITABLE", `roster ${paths.rosterPath} has no sessions object to extend`, "Repair the roster JSON shape; agents were minted but no file was changed.");
		nextRoster = inserted;
	}
	const rosterBefore = readBytes(paths.rosterPath);
	if (rosterNames === null) {
		mkdirSync(dirname(paths.rosterPath), { recursive: true });
		writeFileSync(paths.rosterPath, nextRoster);
	}
	files.push({ path: paths.rosterPath, before: rosterBefore, after: readBytes(paths.rosterPath) });
	const placeholder = (prefix: string, index: number): string => `__PROJECTADD_${prefix}_${index}__`;
	const entryFor = (coordinatorPane: string, workerPanes: string[]): FleetWatchSession => ({
		session,
		coordinatorPane,
		coordinatorSession: session,
		repo,
		workerPanes,
		skipLabels: [],
		...(input.mission !== undefined ? { mission: input.mission } : {}),
	});
	const paneLess: FleetWatchSession = entryFor(placeholder("PANE", 0), workers.map((_, index) => placeholder("WORKER", index)));
	let nextFleet: string;
	if (fleetText === null) {
		nextFleet = JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5, sessions: [paneLess] }, null, 2) + "\n";
	} else {
		const inserted = insertFleetWatchSession(fleetText, JSON.stringify(paneLess));
		if (inserted === null) return failed("PROJECT_FLEET_WATCH_UNEDITABLE", `fleet-watch config ${paths.fleetWatchPath} has no sessions array to extend`, "Repair the fleet-watch JSON shape; agents were minted but no file was changed.");
		nextFleet = inserted;
	}
	const fleetBefore = readBytes(paths.fleetWatchPath);
	if (existing === null) {
		mkdirSync(dirname(paths.fleetWatchPath), { recursive: true });
		writeFileSync(paths.fleetWatchPath, nextFleet);
	}
	files.push({ path: paths.fleetWatchPath, before: fleetBefore, after: readBytes(paths.fleetWatchPath) });

	// Receipt first: everything after this point is resumable and undoable.
	const receiptId = randomUUID();
	const receipt: ProjectAddReceipt = {
		schema_version: 1, kind: "project-add", id: receiptId, state: "PARTIAL",
		session, repo, projectKey: repo, profile: input.profile.trim(), model: input.model?.trim() ?? null,
		mission: input.mission ?? null, agents, coordinatorPane: null, workerPanes: [], tab: null,
		files, createdAt: new Date().toISOString(),
	};
	try {
		writePrivate(join(paths.stateRoot, `project-add-${receiptId}.json`), JSON.stringify(receipt, null, 2) + "\n");
	} catch (error) {
		return failed("PROJECT_RECEIPT_UNWRITABLE", `project receipt is unwritable: ${error instanceof Error ? error.message : String(error)}`, "Repair the state root; file stores were written and need project add --undo once receipts work.");
	}

	// 5. Turn-on, then record the created pane ids back into fleet-watch (textual placeholder swap).
	let turnOnRun: { code: number; out: string; err: string };
	try {
		turnOnRun = await exec.run([turnOn.bin, "--turn-on", "--session", session, "--profile", input.profile.trim(), "--apply", "--json"], { cwd: repo, deadlineMs: 300_000 });
	} catch (error) {
		return failed("PROJECT_TURN_ON_FAILED", `turn-on threw: ${error instanceof Error ? error.message : String(error)}`, "Inspect the seat host, then retry; the pane-less session entry resumes.", receiptId);
	}
	if (turnOnRun.code !== 0) {
		return failed("PROJECT_TURN_ON_FAILED", `turn-on exited ${turnOnRun.code}: ${turnOnRun.err.slice(0, 500) || turnOnRun.out.slice(0, 500)}`, "Inspect the seat host, then retry; the pane-less session entry resumes.", receiptId);
	}
	let panes: { coordinatorPane: string; workerPanes: string[]; tab: string | null };
	const turnOnPanes = parseTurnOn(turnOnRun.out, input.workers);
	if (turnOnPanes === null) {
		return failed("PROJECT_TURN_ON_UNPARSEABLE", "turn-on output did not name the created panes", "Inspect the seat host, then retry; the pane-less session entry resumes.", receiptId);
	}
	if ("error" in turnOnPanes) {
		return failed("PROJECT_TURN_ON_FAILED", turnOnPanes.error, "Inspect the seat host and roster entry, then retry; the pane-less session entry resumes.", receiptId);
	}
	panes = turnOnPanes;
	try {
		let patched = readFileSync(paths.fleetWatchPath, "utf8");
		patched = patched.split(placeholder("PANE", 0)).join(`tern:${panes.coordinatorPane}`);
		workers.forEach((_, index) => {
			patched = patched.split(placeholder("WORKER", index)).join(`tern:${panes.workerPanes[index]!}`);
		});
		if (patched.includes("__PROJECTADD_")) throw new Error("unreplaced placeholder");
		JSON.parse(patched);
		loadFleetWatchConfig(paths.fleetWatchPath);
		writeFileSync(paths.fleetWatchPath, patched);
	} catch {
		return failed("PROJECT_FLEET_WATCH_PATCH_FAILED", "created panes could not be recorded back into fleet-watch", "Record coordinatorPane/workerPanes by hand, then retry delivery; the pane-less session entry resumes.", receiptId);
	}
	// NOTE: loadFleetWatchConfig above validated the pre-patch file; re-validate the patched bytes.
	try {
		const reparsed = JSON.parse(readFileSync(paths.fleetWatchPath, "utf8")) as { sessions?: unknown };
		if (!Array.isArray(reparsed.sessions) || !reparsed.sessions.some((row) => (row as FleetWatchSession)?.session === session)) {
			throw new Error("session entry missing after patch");
		}
	} catch {
		return failed("PROJECT_FLEET_WATCH_PATCH_FAILED", "patched fleet-watch does not carry the session", "Repair fleet-watch by hand; the pane-less session entry resumes.", receiptId);
	}
	receipt.coordinatorPane = panes.coordinatorPane;
	receipt.workerPanes = panes.workerPanes;
	receipt.tab = panes.tab;

	// 6. First goals with proof, reusing the kit's send proof machinery (never ad hoc).
	const io = input.deps?.io;
	const observe = input.deps?.observe ?? defaultObserve;
	const wait = input.deps?.wait;
	const pollMs = input.pollMs ?? 50;
	const deadlineMs = input.deadlineMs ?? 20_000;
	const goalText = `/goal set ${directorGoal(input, session, repo)}`;
	const goal = await deliverFirstSeatGoal({
		seat: { session, pane: `tern:${panes.coordinatorPane}`, cwd: repo }, text: goalText, ...(io === undefined ? {} : { io }),
		observe, pollMs, deadlineMs, ...(wait === undefined ? {} : { wait }),
	});
	if (goal.status !== "OK") {
		return failed("PROJECT_GOAL_UNPROVEN", `director goal has no consumption proof: ${goal.detail}`, "Inspect the seat, then deliver by hand; the session entry carries the created panes.", receiptId);
	}
	for (let index = 0; index < workers.length; index++) {
		const oriented = await deliverFirstSeatGoal({
			seat: { session, pane: `tern:${panes.workerPanes[index]!}`, cwd: repo },
			text: workerOrientation(input, session, repo, index, workers.length), ...(io === undefined ? {} : { io }),
			observe, pollMs, deadlineMs, ...(wait === undefined ? {} : { wait }),
		});
		if (oriented.status !== "OK") {
			return failed("PROJECT_ORIENTATION_UNPROVEN", `worker ${index} orientation has no consumption proof: ${oriented.detail}`, "Inspect the seat, then deliver by hand; the session entry carries the created panes.", receiptId);
		}
	}

	receipt.state = "APPLIED";
	receipt.files = receipt.files.map((file) => ({ ...file, after: readBytes(file.path) }));
	try {
		atomicReplaceBytes(join(paths.stateRoot, `project-add-${receiptId}.json`), Buffer.from(JSON.stringify(receipt, null, 2) + "\n"), { mode: 0o600, durability: "full" });
	} catch (error) {
		return failed("PROJECT_RECEIPT_UNWRITABLE", `project receipt update failed: ${error instanceof Error ? error.message : String(error)}`, "The project is live; record the receipt id by hand.", receiptId);
	}
	return {
		ok: true,
		result: {
			status: "APPLIED", session,
			agents: [
				{ role: "director", name: director, pane: `tern:${panes.coordinatorPane}` },
				...workers.map((name, index) => ({ role: "worker" as const, name, pane: `tern:${panes.workerPanes[index]!}` })),
			],
			receiptId, census: { named: `${agents.length}/${agents.length}` },
		},
	};
}

export async function undoProjectAdd(input: { receiptId: string; env: NodeJS.ProcessEnv; deps?: ProjectAddDeps }): Promise<{ ok: true; undone: { session: string; files: string[]; panes: string[]; agents: string[] } } | { ok: false; code: string; detail: string; remediation: string }> {
	const home = input.env.HOME ?? "";
	if (!home || !isAbsolute(home) || resolve(home) !== home) {
		return fail("PROJECT_HOME_UNAVAILABLE", "a canonical absolute HOME is required", "Set HOME to an absolute path with no symlinks.");
	}
	const paths = resolveProjectAddPaths(input.env, home);
	const exec = input.deps?.exec ?? { run: defaultExec };
	const mail = input.deps?.mail ?? { call: defaultMail };
	const failed = (code: string, detail: string, remediation: string) => ({ ok: false as const, code, detail, remediation });
	if (!/^[a-f0-9-]+$/.test(input.receiptId)) return failed("PROJECT_RECEIPT_INVALID", "receipt id is malformed", "Pass a project-add receipt id from a previous apply.");
	const receipt = readReceipt(paths.stateRoot, input.receiptId);
	if (receipt === null) return failed("PROJECT_RECEIPT_INVALID", "project receipt is missing or malformed", "Pass a project-add receipt id from a previous apply.");
	if (receipt.state === "UNDONE") return failed("PROJECT_ALREADY_UNDONE", "this receipt was already undone", "Nothing to do.");
	for (const file of receipt.files) {
		const live = readBytes(file.path);
		const after = file.after;
		if (live !== after) {
			return failed("PROJECT_UNDO_POSTIMAGE_CHANGED", `${file.path} no longer matches the applied state`, "Restore by hand; the receipt is kept for inspection.");
		}
	}
	try {
		for (const name of receipt.agents) {
			await mail.call("deregister_agent", { project_key: receipt.projectKey, agent_name: name });
		}
	} catch (error) {
		return failed("PROJECT_UNDO_MAIL_FAILED", `Agent Mail deregistration failed: ${error instanceof Error ? error.message : String(error)}`, "Retry undo once the Agent Mail server is reachable; no file was restored.");
	}
	const ternBin = input.env.TERN_CTL_BIN?.trim() || "tern";
	const closed: string[] = [];
	try {
		const panes = [...(receipt.coordinatorPane === null ? [] : [receipt.coordinatorPane]), ...receipt.workerPanes];
		for (const pane of panes) {
			const closedPane = await exec.run([ternBin, "close", `${receipt.session}/${pane}`], { deadlineMs: 60_000 });
			if (closedPane.code !== 0) throw new Error(`tern close ${pane} exited ${closedPane.code}`);
			closed.push(pane);
		}
	} catch (error) {
		return failed("PROJECT_UNDO_CLOSE_FAILED", `seat teardown failed: ${error instanceof Error ? error.message : String(error)}`, "Close the seats by hand, then retry undo; no file was restored.");
	}
	for (const file of receipt.files) {
		if (file.before === null) {
			try { unlinkSync(file.path); } catch { /* already absent */ }
		} else {
			writeBytes(file.path, file.before);
		}
	}
	try {
		atomicReplaceBytes(join(paths.stateRoot, `project-add-${input.receiptId}.json`), Buffer.from(JSON.stringify({ ...receipt, state: "UNDONE" }, null, 2) + "\n"), { mode: 0o600, durability: "full" });
	} catch (error) {
		return failed("PROJECT_RECEIPT_UNWRITABLE", `undo receipt update failed: ${error instanceof Error ? error.message : String(error)}`, "Stores were restored; record the receipt state by hand.");
	}
	return { ok: true, undone: { session: receipt.session, files: receipt.files.map((file) => file.path), panes: closed, agents: receipt.agents } };
}

export interface ProjectSeatStatus {
	role: "director" | "worker";
	name: string | null;
	pane: string;
	alive: boolean;
	named: boolean;
	lastActivity: string | null;
	activeGoal: string | null;
	wake: { outcome: string; at: string | null };
}

export interface ProjectStatusResult {
	session: string;
	repo: string;
	seats: ProjectSeatStatus[];
	beads: { ready: number | null; inProgress: number | null };
	lastCommit: { sha: string; at: number; subject: string } | null;
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Both mail-wake writers record recipient, status and ts in the kit state root. */
function latestSeatWakes(stateRoot: string): Map<string, { outcome: string; at: string }> {
	const wakes = new Map<string, { outcome: string; at: string }>();
	let cursor;
	do {
		const result = readJsonl(join(stateRoot, "mail-wake.jsonl"), { fromCursor: cursor });
		for (const value of result.rows) {
			if (typeof value !== "object" || value === null) continue;
			const row = value as Record<string, unknown>;
			if (typeof row.recipient !== "string" || typeof row.status !== "string" || typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) continue;
			const previous = wakes.get(row.recipient);
			if (previous === undefined || Date.parse(row.ts) >= Date.parse(previous.at)) wakes.set(row.recipient, { outcome: row.status, at: row.ts });
		}
		if (!result.more || result.cursor === null) break;
		cursor = result.cursor;
	} while (true);
	return wakes;
}

export async function projectStatus(input: { session: string; env: NodeJS.ProcessEnv; deps?: ProjectAddDeps }): Promise<{ ok: true; status: ProjectStatusResult } | { ok: false; code: string; detail: string; remediation: string }> {
	const home = input.env.HOME ?? "";
	if (!home || !isAbsolute(home) || resolve(home) !== home) {
		return fail("PROJECT_HOME_UNAVAILABLE", "a canonical absolute HOME is required", "Set HOME to an absolute path with no symlinks.");
	}
	const paths = resolveProjectAddPaths(input.env, home);
	const exec = input.deps?.exec ?? { run: defaultExec };
	const mail = input.deps?.mail ?? { call: defaultMail };
	const failed = (code: string, detail: string, remediation: string) => ({ ok: false as const, code, detail, remediation });
	let config: { sessions: FleetWatchSession[] };
	try {
		config = loadFleetWatchConfig(paths.fleetWatchPath);
	} catch {
		return failed("PROJECT_FLEET_WATCH_INVALID", `fleet-watch config ${paths.fleetWatchPath} does not parse`, "Repair the JSON file.");
	}
	const entry = config.sessions.find((row) => row.session === input.session) ?? null;
	if (entry === null) return failed("PROJECT_SESSION_UNKNOWN", `session ${input.session} is not a managed project`, "Add it first with project add.");
	const bare = (pane: string): string | null => {
		const text = pane.startsWith("tern:") ? pane.slice("tern:".length) : pane;
		return /^[0-9]+$/.test(text) ? text : null;
	};
	const coordinator = bare(entry.coordinatorPane);
	const workerIds = entry.workerPanes.map(bare);
	if (coordinator === null || workerIds.some((id) => id === null)) {
		return failed("PROJECT_PANES_UNRECORDED", `session ${input.session} has no recorded panes yet`, "Wait for project add to finish recording them.");
	}
	const ternBin = input.env.TERN_CTL_BIN?.trim() || "tern";
	let inspect: { sessions: { name?: unknown; tabs?: { name?: unknown; blocks?: { id?: unknown; live?: unknown }[] }[] }[]; panes: { pane?: unknown; omp_session_file?: unknown; exited?: unknown }[] } | null = null;
	try {
		const probed = await exec.run([ternBin, "inspect", "--json"], { deadlineMs: 30_000 });
		const parsed = probed.code === 0 ? tryParseJson(probed.out) : null;
		inspect = parsed !== null && typeof parsed === "object" ? parsed as typeof inspect : null;
	} catch { inspect = null; }
	const blockLive = (id: string): boolean => {
		if (inspect === null) return false;
		for (const session of inspect.sessions ?? []) {
			for (const tab of session.tabs ?? []) {
				for (const block of tab.blocks ?? []) {
					if (String(block.id ?? "") === id) return block.live === true;
				}
			}
		}
		return false;
	};
	const paneFile = (id: string): string | null => {
		if (inspect === null) return null;
		for (const row of inspect.panes ?? []) {
			if (String(row.pane ?? "") === id && typeof row.omp_session_file === "string" && row.exited === null) return row.omp_session_file;
		}
		return null;
	};
	const names: (string | null)[] = [];
	for (const id of [coordinator, ...(workerIds as string[])]) {
		try {
			const resolved = await mail.call("resolve_pane_identity", { project_key: entry.repo, pane_id: `tern:${id}` });
			const record = (typeof resolved === "object" && resolved !== null ? resolved : null) as Record<string, unknown> | null;
			const name = record === null ? null : record.agent_name ?? record.name;
			names.push(typeof name === "string" && name !== "" ? name : null);
		} catch {
			names.push(null);
		}
	}
	const wakes = latestSeatWakes(paths.stateRoot);
	const seats: ProjectSeatStatus[] = [coordinator, ...(workerIds as string[])].map((id, index) => {
		const file = paneFile(id);
		let lastActivity: string | null = null;
		let activeGoal: string | null = null;
		if (file !== null) {
			try {
				const stat = statSync(file);
				lastActivity = new Date(stat.mtimeMs).toISOString();
			} catch { lastActivity = null; }
			try {
				const lines = readFileSync(file, "utf8").split("\n");
				for (let line = lines.length - 1; line >= 0; line--) {
					const record = tryParseJson(lines[line]!) as { type?: unknown; mode?: unknown; data?: unknown } | null;
					const goal = record !== null && record.type === "mode_change" && record.mode === "goal"
						? (record.data as { goal?: { status?: unknown; objective?: unknown } } | null)?.goal ?? null : null;
					if (goal !== null && goal.status === "active" && typeof goal.objective === "string") { activeGoal = goal.objective; break; }
				}
			} catch { activeGoal = null; }
		}
		return {
			role: index === 0 ? "director" : "worker", name: names[index] ?? null, pane: `tern:${id}`,
			alive: blockLive(id), named: names[index] !== null, lastActivity, activeGoal,
			wake: wakes.get(names[index] ?? "") ?? { outcome: "no wake recorded", at: null },
		};
	});
	const brBin = input.env.BR_BIN?.trim() || "br";
	const count = async (argv: string[]): Promise<number | null> => {
		try {
			const result = await exec.run([brBin, ...argv, "--json", "--no-auto-import", "--no-auto-flush"], { cwd: entry.repo, deadlineMs: 60_000 });
			if (result.code !== 0) return null;
			const parsed = tryParseJson(result.out) as { issues?: unknown[]; total?: unknown } | null;
			if (parsed === null) return null;
			if (Array.isArray(parsed.issues)) return parsed.issues.length;
			return typeof parsed.total === "number" ? parsed.total : null;
		} catch {
			return null;
		}
	};
	const ready = await count(["ready"]);
	const inProgress = await count(["list", "--status", "in_progress"]);
	let lastCommit: ProjectStatusResult["lastCommit"] = null;
	try {
		const logged = await exec.run(["git", "-C", entry.repo, "log", "-1", "--format=%H%n%ct%n%s"], { deadlineMs: 30_000 });
		if (logged.code === 0) {
			const [sha, at, subject] = logged.out.split("\n");
			if (sha && at && /^\d+$/.test(at.trim())) lastCommit = { sha: sha.trim(), at: Number(at.trim()), subject: (subject ?? "").trim() };
		}
	} catch { lastCommit = null; }
	return { ok: true, status: { session: entry.session, repo: entry.repo, seats, beads: { ready, inProgress }, lastCommit } };
}
