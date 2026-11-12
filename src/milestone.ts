/** CUTWRITE1: the sole native milestone pin writer; kitlib owns locking and publication. */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";
import type { Command, DataSchema } from "./commands.ts";
import { atomicReplaceBytes, AtomicReplaceError } from "./kitlib/io.ts";
import { privateLock, type PrivateLock } from "./kitlib/lock.ts";
import { run } from "./kitlib/run.ts";

const dataSchema: DataSchema = { type: "object", required: ["overall", "session", "repo", "epic", "due", "declaredAt", "pinned", "pinLog"], properties: {
	overall: { enum: ["OK"] }, session: { type: "string" }, repo: { type: "string" }, epic: { type: "string" },
	pinned: { type: "array", items: { type: "string" } }, pinLog: { type: "array", items: { type: "object" } },
	due: { type: ["string", "null"] }, declaredAt: { type: ["string", "null"] },
} };
const auditFlags = [{ name: "--reason", value: "TEXT", description: "Required reason recorded in milestone.pinLog" }, { name: "--by", value: "NAME", description: "Audit actor (default AGENT_NAME, then operating-system user)" }];
export const MILESTONE_COMMAND: Command = {
	name: "milestone", description: "Inspect a session's milestone cut, change its validated pins or set its due date with an audit trail", usage: "milestone pin|unpin|date|show|launch SESSION [BEAD...|DATE]", flags: [], example: "omp-kit milestone show omp-test --json", runnable: true,
	subcommands: ["pin", "unpin", "show"].map(action => ({
		name: action, description: action === "show" ? "Read the declared milestone and recent pin history; validate every pinned id in its tracker" : `${action === "pin" ? "Add" : "Remove"} tracker-validated bead pins atomically; append actor, time and reason`,
		usage: `milestone ${action} SESSION${action === "show" ? "" : ` BEAD... --reason TEXT [--by NAME]${action === "pin" ? " [--first]" : ""}`}`,
		argument: action === "show" ? "SESSION" : "SESSION BEAD...", maxArguments: action === "show" ? 1 : 129,
		flags: action === "show" ? [] : action === "pin" ? [...auditFlags, { name: "--first", description: "Move the named pins to the front of the cut in argument order; every other pin keeps its relative order" }] : auditFlags,
		example: action === "show" ? "omp-kit milestone show SESSION --json" : `omp-kit milestone ${action} SESSION BEAD --reason 'Director replan' --json`,
		runnable: true, mutation: action !== "show", dataSchema,
	} as Command)).concat([{
		name: "date", description: "Set milestone.due (today or later, UTC) atomically; append actor, time, old/new due and reason to pinLog",
		usage: "milestone date SESSION YYYY-MM-DD[THH:MMZ] --reason TEXT [--by NAME]", argument: "SESSION DATE", maxArguments: 2, flags: auditFlags,
		example: "omp-kit milestone date SESSION 2026-11-12 --reason 'Director replan' --json", runnable: true, mutation: true, dataSchema,
	} as Command, {
		name: "launch", description: "Store launch pins on the milestone record and report READY only when asset_freeze, runbook, value_metric and rollback all resolve",
		usage: "milestone launch SESSION [--set KEY=VALUE ...]", argument: "SESSION", maxArguments: 1,
		flags: [{ name: "--set", value: "KEY=VALUE", repeatable: true, description: "Launch pin asset_freeze|runbook|value_metric|rollback; repeat for each pin" }],
		example: "omp-kit milestone launch SESSION --set asset_freeze=BEAD --set runbook=docs/run.md --json", runnable: true, mutation: true,
		dataSchema: { type: "object", required: ["overall", "session", "repo", "epic"], properties: {
			overall: { enum: ["READY", "NOT_READY"] }, session: { type: "string" }, repo: { type: "string" }, epic: { type: "string" },
			launch: { type: "object" }, resolved: { type: "object" }, issues: { type: "array" },
		} },
	} as Command]),
};
const DUE = /^(\d{4}-\d{2}-\d{2})(T([01]\d|2[0-3]):[0-5]\dZ)?$/;
/** Returns the UTC day of a valid due string, or undefined when malformed or not a real calendar date. */
function dueDay(value: string): string | undefined {
	const match = DUE.exec(value);
	if (!match) return undefined;
	const parsed = new Date(match[2] ? value.replace("Z", ":00Z") : `${value}T00:00:00Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[1] ? undefined : match[1];
}

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string" && id.length <= 4096 && id.trim() === id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
class MilestoneError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}
const LAUNCH_KEYS = ["asset_freeze", "runbook", "value_metric", "rollback"] as const;
type LaunchKey = (typeof LAUNCH_KEYS)[number];
const isLaunchKey = (value: string): value is LaunchKey => (LAUNCH_KEYS as readonly string[]).includes(value);
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const METRIC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUNBOOK_CHARS = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Repo-relative path: no absolute, no parent escape, no empty segments. */
function cleanRunbook(value: string): string | undefined {
	if (value.length === 0 || value.length > 1024 || value.trim() !== value) return undefined;
	if (isAbsolute(value) || value.startsWith("\\")) return undefined;
	const parts = value.split("/");
	if (parts.some(part => part === "" || part === "." || part === "..")) return undefined;
	if (!RUNBOOK_CHARS.test(value)) return undefined;
	return value;
}
function splitArgv(value: string): string[] | undefined {
	const argv = value.split(/\s+/).filter(Boolean);
	if (argv.length === 0 || argv.length > 32 || argv.some(part => part.length === 0 || part.length > 512)) return undefined;
	return argv;
}
type LaunchPins = { asset_freeze?: string; runbook?: string; value_metric?: string; rollback?: string };
function readLaunchPins(value: unknown): LaunchPins {
	if (!record(value)) return {};
	const pins: LaunchPins = {};
	if (typeof value.asset_freeze === "string") pins.asset_freeze = value.asset_freeze;
	if (typeof value.runbook === "string") pins.runbook = value.runbook;
	if (typeof value.value_metric === "string") pins.value_metric = value.value_metric;
	if (typeof value.rollback === "string") pins.rollback = value.rollback;
	return pins;
}
/** Injectable metric reader: $OMP_KIT_MILESTONE_VALUE_READER overrides, else <kit>/scripts/turnline.py when present, else UNKNOWN. */
async function readLaunchMetric(name: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
	const override = env.OMP_KIT_MILESTONE_VALUE_READER;
	const fallback = join(resolve(import.meta.dir, ".."), "scripts", "turnline.py");
	const reader = typeof override === "string" && override.trim() !== "" ? override : fallback;
	let isFile = false;
	try { isFile = lstatSync(reader).isFile(); } catch { isFile = false; }
	if (!isFile) return undefined;
	const argv = reader.endsWith(".py") ? ["python3", reader, "--json"] : [reader, "--json"];
	try {
		const ran = await run(argv, { cwd, env, deadline_s: 30, max_output_bytes: 1024 * 1024 });
		if (ran.rc !== 0 || ran.timed_out || ran.truncated) return undefined;
		const parsed: unknown = JSON.parse(Buffer.from(ran.stdout).toString("utf8"));
		const candidate = record(parsed) ? (parsed[name] ?? (record(parsed.metrics) ? parsed.metrics[name] : undefined) ?? (parsed.metric === name ? parsed.value : undefined)) : undefined;
		if (typeof candidate !== "string" && typeof candidate !== "number") return undefined;
		const value = String(candidate).trim();
		return value === "" || value === "UNKNOWN" ? undefined : value;
	} catch { return undefined; }
}
const refuse = (code: string, message: string, exit = 2): CliResult => ({ code: exit, data: { overall: "NOT_RUN" }, errors: [{ code, message,
	remediation: "Use omp-kit milestone show SESSION; pin/unpin require existing tracker ids and --reason TEXT. No unvalidated write is allowed." }], verification: "NOT_RUN" });

/** Reads only the session's own tracker, ignoring ambient bindings to a different tracker. */
function trackerEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined && key !== "BEADS_DB" && key !== "BEADS_DIR") clean[key] = value;
	return clean;
}
export async function runMilestone(request: ParsedCommand, env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {

	const action = request.command.name;
	const [session, ...wanted] = (request.argument ?? "").split(/\s+/).filter(Boolean);
	if (action === "launch") return runLaunch(session, request, env);
	if (!session || !["pin", "unpin", "date", "show"].includes(action) || (action === "show" ? wanted.length !== 0 : action === "date" ? wanted.length !== 1 : wanted.length === 0 || wanted.length > 128 || !ids(wanted)))
		return refuse("MILESTONE_USAGE", "Expected milestone pin|unpin|show SESSION [BEAD...] or milestone date SESSION YYYY-MM-DD[THH:MMZ]; bead ids cannot be options.");
	const why = request.flags.get("--reason");
	if (action !== "show" && !text(why)) return refuse("MILESTONE_REASON_REQUIRED", "pin/unpin/date need a nonempty --reason TEXT.");
	const due = action === "date" ? wanted[0] : undefined;
	if (due !== undefined) {
		const day = dueDay(due);
		if (!day) return refuse("MILESTONE_USAGE", `Due date ${due} must be a real YYYY-MM-DD or YYYY-MM-DDTHH:MMZ.`);
		if (day < new Date().toISOString().slice(0, 10)) return refuse("PAST_DUE", `Due date ${due} is before today (UTC); a milestone must be dated today or later.`);
	}
	const explicitActor = request.flags.get("--by");
	if (explicitActor !== undefined && !text(explicitActor)) return refuse("MILESTONE_USAGE", "--by needs a nonempty actor.");
	let lock: PrivateLock | undefined;
	try {
		const home = env.HOME ?? homedir();
		if (env.OMP_KIT_FLEET_WATCH_CONFIG !== undefined && !text(env.OMP_KIT_FLEET_WATCH_CONFIG)) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "OMP_KIT_FLEET_WATCH_CONFIG is empty.");
		const configPath = resolve(env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "omp-kit", "fleet-watch.json"));
		if (action !== "show") {
			const stateBase = env.XDG_STATE_HOME ?? join(home, ".local", "state");
			if (!isAbsolute(stateBase)) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "XDG_STATE_HOME must be absolute.");
			mkdirSync(stateBase, { recursive: true, mode: 0o700 });
			lock = await privateLock({ namespace: "fleet-watch-config", path: configPath }, { deadline_s: 30, state_dir: join(stateBase, "omp-kit") });
		}
		const stat = lstatSync(configPath);
		if (!stat.isFile() || stat.size > 1024 * 1024) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "fleet-watch config must be a regular file of at most 1 MiB.");
		const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!record(config) || !Array.isArray(config.sessions)) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "fleet-watch sessions is malformed.");
		const matches = config.sessions.filter(row => record(row) && row.session === session);
		if (matches.length !== 1) throw new MilestoneError("MILESTONE_SESSION_UNKNOWN", `Session ${session} must match exactly one fleet-watch session.`);
		const row: unknown = matches[0];
		if (!record(row) || !text(row.repo) || !isAbsolute(row.repo) || !record(row.milestone) || !text(row.milestone.epic))
			throw new MilestoneError("MILESTONE_CONFIG_INVALID", "Session needs an absolute repo and an existing milestone.epic.");
		const milestone = row.milestone;
		if (milestone.pinned !== undefined && (!ids(milestone.pinned) || new Set(milestone.pinned).size !== milestone.pinned.length))
			throw new MilestoneError("MILESTONE_CONFIG_INVALID", "milestone.pinned must contain distinct bead ids.");
		if (milestone.pinLog !== undefined && (!Array.isArray(milestone.pinLog) || !milestone.pinLog.every(record)))
			throw new MilestoneError("MILESTONE_CONFIG_INVALID", "milestone.pinLog must be an array of rows.");
		const pinned = ids(milestone.pinned) ? milestone.pinned : [];
		const pinLog = Array.isArray(milestone.pinLog) ? milestone.pinLog : [];
		const childEnv = trackerEnvironment(env);
		childEnv.BEADS_DB = join(row.repo, ".beads", "beads.db");
		const unique = [...new Set(action === "show" ? pinned : action === "date" ? [] : wanted)];
		if (unique.length > 0) {
			const shown = await run(["br", "--no-auto-import", "--no-auto-flush", "--db", join(row.repo, ".beads", "beads.db"), "show", ...unique, "--json"], { cwd: row.repo, env: childEnv, deadline_s: 30, max_output_bytes: 16 * 1024 * 1024 });
			if (shown.rc !== 0 || shown.timed_out || shown.truncated) throw new MilestoneError("MILESTONE_BEAD_UNKNOWN", `Tracker refused pin ids in ${row.repo}: ${Buffer.from(shown.stderr).toString("utf8").slice(0, 1000)}`);
			const beads: unknown = JSON.parse(Buffer.from(shown.stdout).toString("utf8"));
			if (!Array.isArray(beads) || beads.some(bead => !record(bead) || !text(bead.id))) throw new MilestoneError("MILESTONE_BEAD_UNKNOWN", "Tracker show returned malformed rows.");
			const found = new Set(beads.map(bead => bead.id));
			if (unique.some(id => !found.has(id))) throw new MilestoneError("MILESTONE_BEAD_UNKNOWN", "Every supplied id must match an exact tracker id (no prefix aliases).");
		}
		const dates = { due: typeof milestone.due === "string" ? milestone.due : null, declaredAt: typeof milestone.declaredAt === "string" ? milestone.declaredAt : null };
		if (action === "show") return { code: 0, data: { overall: "OK", session, repo: row.repo, epic: milestone.epic, ...dates, pinned, pinLog: pinLog.slice(-10) }, verification: "NOT_RUN" };
		const actor = [explicitActor, env.AGENT_NAME, env.USER].find(text) ?? userInfo().username;
		if (due !== undefined) {
			milestone.due = due;
			milestone.pinLog = [...pinLog, { at: new Date().toISOString(), by: actor, due: { from: dates.due, to: due }, why }];
			dates.due = due;
		} else {
			const selected = new Set(unique), existing = new Set(pinned), first = action === "pin" && request.flags.has("--first");
			const delta = action === "pin" ? unique.filter(id => !existing.has(id)) : pinned.filter(id => selected.has(id));
			milestone.pinned = first ? [...unique, ...pinned.filter(id => !selected.has(id))] : action === "pin" ? [...pinned, ...delta] : pinned.filter(id => !selected.has(id));
			milestone.pinLog = [...pinLog, { at: new Date().toISOString(), by: actor,
				[action === "pin" ? "added" : "removed"]: delta, ...(first ? { first: unique } : {}), why }];
		}
		atomicReplaceBytes(configPath, Buffer.from(JSON.stringify(config, null, 2) + "\n"), { mode: stat.mode & 0o755, durability: "full" });
		return { code: 0, data: { overall: "OK", session, repo: row.repo, epic: milestone.epic, ...dates, pinned: ids(milestone.pinned) ? milestone.pinned : pinned, pinLog: (milestone.pinLog as unknown[]).slice(-10) }, verification: "NOT_RUN" };
	} catch (error) {
		if (error instanceof AtomicReplaceError && error.published) return { code: 3, data: { overall: "UNVERIFIED", published: true }, errors: [{ code: "MILESTONE_DURABILITY_UNKNOWN", message: error.message, remediation: "The new config is visible, but directory durability failed. Read milestone show before retrying." }], verification: "UNVERIFIED" };
		return refuse(error instanceof MilestoneError ? error.code : "MILESTONE_UNAVAILABLE", error instanceof Error ? error.message : String(error), error instanceof MilestoneError ? 2 : 3);
	} finally { lock?.release(); }
}
async function runLaunch(session: string | undefined, request: ParsedCommand, env: NodeJS.ProcessEnv): Promise<CliResult> {
	const extra = (request.argument ?? "").split(/\s+/).filter(Boolean).slice(session ? 1 : 0);
	if (!session || extra.length > 0) return refuse("MILESTONE_USAGE", "Expected milestone launch SESSION [--set KEY=VALUE ...]; SESSION takes no extra positionals.");
	const raw = request.flags.get("--set");
	const sets = typeof raw === "string" ? raw.split("\n").filter(part => part !== "") : [];
	const pins: LaunchPins = {};
	for (const entry of sets) {
		const equals = entry.indexOf("=");
		const key = equals < 0 ? entry : entry.slice(0, equals);
		const value = equals < 0 ? "" : entry.slice(equals + 1);
		if (!isLaunchKey(key)) return refuse("MILESTONE_USAGE", `Unknown launch pin ${key}; use one of asset_freeze, runbook, value_metric, rollback.`);
		if (value.trim() === "") return refuse("MILESTONE_USAGE", `Launch pin ${key} needs a nonempty value; use --set ${key}=VALUE.`);
		if (key === "asset_freeze" && (value.length > 4096 || !BEAD_ID.test(value))) return refuse("MILESTONE_USAGE", `asset_freeze ${value} must be a tracker bead id.`);
		if (key === "runbook" && cleanRunbook(value) === undefined) return refuse("MILESTONE_USAGE", `runbook ${value} must be a repo-relative path like docs/runbook.md.`);
		if (key === "value_metric" && (value.length > 256 || !METRIC_NAME.test(value))) return refuse("MILESTONE_USAGE", `value_metric ${value} must be a metric name.`);
		if (key === "rollback" && splitArgv(value) === undefined) return refuse("MILESTONE_USAGE", "rollback must be a command of at most 32 words, each at most 512 bytes.");
		pins[key] = value;
	}
	let lock: PrivateLock | undefined;
	try {
		const home = env.HOME ?? homedir();
		if (env.OMP_KIT_FLEET_WATCH_CONFIG !== undefined && !text(env.OMP_KIT_FLEET_WATCH_CONFIG)) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "OMP_KIT_FLEET_WATCH_CONFIG is empty.");
		const configPath = resolve(env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "omp-kit", "fleet-watch.json"));
		if (sets.length > 0) {
			const stateBase = env.XDG_STATE_HOME ?? join(home, ".local", "state");
			if (!isAbsolute(stateBase)) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "XDG_STATE_HOME must be absolute.");
			mkdirSync(stateBase, { recursive: true, mode: 0o700 });
			lock = await privateLock({ namespace: "fleet-watch-config", path: configPath }, { deadline_s: 30, state_dir: join(stateBase, "omp-kit") });
		}
		const stat = lstatSync(configPath);
		if (!stat.isFile() || stat.size > 1024 * 1024) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "fleet-watch config must be a regular file of at most 1 MiB.");
		const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!record(config) || !Array.isArray(config.sessions)) throw new MilestoneError("MILESTONE_CONFIG_INVALID", "fleet-watch sessions is malformed.");
		const matches = config.sessions.filter(row => record(row) && row.session === session);
		if (matches.length !== 1) throw new MilestoneError("MILESTONE_SESSION_UNKNOWN", `Session ${session} must match exactly one fleet-watch session.`);
		const row: unknown = matches[0];
		if (!record(row) || !text(row.repo) || !isAbsolute(row.repo) || !record(row.milestone) || !text(row.milestone.epic))
			throw new MilestoneError("MILESTONE_CONFIG_INVALID", "Session needs an absolute repo and an existing milestone.epic.");
		const milestone = row.milestone;
		const stored = readLaunchPins(milestone.launch);
		const merged: LaunchPins = { ...stored, ...pins };
		if (sets.length > 0) {
			milestone.launch = merged;
			atomicReplaceBytes(configPath, Buffer.from(JSON.stringify(config, null, 2) + "\n"), { mode: stat.mode & 0o755, durability: "full" });
		}
		const childEnv = trackerEnvironment(env);
		childEnv.BEADS_DB = join(row.repo, ".beads", "beads.db");
		const issues: { pin: string; fix: string }[] = [];
		const resolved: Record<string, boolean> = {};
		if (!merged.asset_freeze) {
			issues.push({ pin: "asset_freeze", fix: "Set it: --set asset_freeze=BEAD for a closed tracker bead." });
		} else {
			let closed = false;
			try {
				const shown = await run(["br", "--no-auto-import", "--no-auto-flush", "--db", join(row.repo, ".beads", "beads.db"), "show", merged.asset_freeze, "--json"], { cwd: row.repo, env: childEnv, deadline_s: 30, max_output_bytes: 16 * 1024 * 1024 });
				if (!shown.timed_out && !shown.truncated && shown.rc === 0) {
					const beads: unknown = JSON.parse(Buffer.from(shown.stdout).toString("utf8"));
					closed = Array.isArray(beads) && beads.some(bead => record(bead) && bead.id === merged.asset_freeze && bead.status === "closed");
				}
			} catch { closed = false; }
			resolved.asset_freeze = closed;
			if (!closed) issues.push({ pin: "asset_freeze", fix: `Close bead ${merged.asset_freeze} or point asset_freeze at a closed bead.` });
		}
		if (!merged.runbook) {
			issues.push({ pin: "runbook", fix: "Set it: --set runbook=docs/runbook.md for a repo-relative file." });
		} else {
			let present = false;
			try {
				const full = resolve(row.repo, merged.runbook);
				present = full === row.repo || full.startsWith(row.repo + "/") ? lstatSync(full).isFile() : false;
			} catch { present = false; }
			resolved.runbook = present;
			if (!present) issues.push({ pin: "runbook", fix: `Create the runbook file at ${merged.runbook} inside ${row.repo}.` });
		}
		if (!merged.value_metric) {
			issues.push({ pin: "value_metric", fix: "Set it: --set value_metric=NAME for a metric the reader reports." });
		} else {
			const value = await readLaunchMetric(merged.value_metric, env, row.repo);
			resolved.value_metric = value !== undefined;
			if (value === undefined) issues.push({ pin: "value_metric", fix: `Make the metric reader report a non-UNKNOWN value for ${merged.value_metric}; default reader is python3 <omp-kit>/scripts/turnline.py --json, override with $OMP_KIT_MILESTONE_VALUE_READER.` });
		}
		if (!merged.rollback) {
			issues.push({ pin: "rollback", fix: "Set it: --set rollback='CMD ARGS' so that CMD --help exits 0." });
		} else {
			const argv = splitArgv(merged.rollback) ?? [];
			let ok = false;
			try {
				const ran = await run([...argv, "--help"], { cwd: row.repo, env: childEnv, deadline_s: 30, max_output_bytes: 1024 * 1024 });
				ok = ran.rc === 0 && !ran.timed_out && !ran.truncated;
			} catch { ok = false; }
			resolved.rollback = ok;
			if (!ok) issues.push({ pin: "rollback", fix: `Make \`${merged.rollback} --help\` exit 0.` });
		}
		for (const key of LAUNCH_KEYS) if (resolved[key] === undefined) resolved[key] = false;
		const ready = issues.length === 0;
		return { code: 0, data: { overall: ready ? "READY" : "NOT_READY", session, repo: row.repo, epic: milestone.epic, launch: merged, resolved, issues }, verification: "PERFORMED" };
	} catch (error) {
		if (error instanceof AtomicReplaceError && error.published) return { code: 3, data: { overall: "UNVERIFIED", published: true }, errors: [{ code: "MILESTONE_DURABILITY_UNKNOWN", message: error.message, remediation: "The new config is visible, but directory durability failed. Read milestone show before retrying." }], verification: "UNVERIFIED" };
		return refuse(error instanceof MilestoneError ? error.code : "MILESTONE_UNAVAILABLE", error instanceof Error ? error.message : String(error), error instanceof MilestoneError ? 2 : 3);
	} finally { lock?.release(); }
}
