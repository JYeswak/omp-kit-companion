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
export const MILESTONE_COMMAND: Command = {
	name: "milestone", description: "Inspect a session's milestone cut or change its validated pins with an audit trail", usage: "milestone pin|unpin|show SESSION [BEAD...]", flags: [], example: "omp-kit milestone show omp-test --json", runnable: true,
	subcommands: ["pin", "unpin", "show"].map(action => ({
		name: action, description: action === "show" ? "Read the declared milestone and recent pin history; validate every pinned id in its tracker" : `${action === "pin" ? "Add" : "Remove"} tracker-validated bead pins atomically; append actor, time and reason`,
		usage: `milestone ${action} SESSION${action === "show" ? "" : " BEAD... --reason TEXT [--by NAME]"}`,
		argument: action === "show" ? "SESSION" : "SESSION BEAD...", maxArguments: action === "show" ? 1 : 129,
		flags: action === "show" ? [] : [{ name: "--reason", value: "TEXT", description: "Required reason recorded in milestone.pinLog" }, { name: "--by", value: "NAME", description: "Audit actor (default AGENT_NAME, then operating-system user)" }],
		example: action === "show" ? "omp-kit milestone show omp-test --json" : `omp-kit milestone ${action} omp-test ompkit-123 --reason 'Director replan' --json`,
		runnable: true, mutation: action !== "show", dataSchema,
	})),
};

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string" && id.length <= 4096 && id.trim() === id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
class MilestoneError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
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
	if (!session || !["pin", "unpin", "show"].includes(action) || (action === "show" ? wanted.length !== 0 : wanted.length === 0 || wanted.length > 128) || !ids(wanted))
		return refuse("MILESTONE_USAGE", "Expected milestone pin|unpin|show SESSION [BEAD...]; bead ids cannot be options.");
	const why = request.flags.get("--reason");
	if (action !== "show" && !text(why)) return refuse("MILESTONE_REASON_REQUIRED", "pin/unpin need a nonempty --reason TEXT.");
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
		const unique = [...new Set(action === "show" ? pinned : wanted)];
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
		const selected = new Set(unique), existing = new Set(pinned);
		const delta = action === "pin" ? unique.filter(id => !existing.has(id)) : pinned.filter(id => selected.has(id));
		milestone.pinned = action === "pin" ? [...pinned, ...delta] : pinned.filter(id => !selected.has(id));
		const actor = [explicitActor, env.AGENT_NAME, env.USER].find(text) ?? userInfo().username;
		milestone.pinLog = [...pinLog, { at: new Date().toISOString(), by: actor,
			[action === "pin" ? "added" : "removed"]: delta, why }];
		atomicReplaceBytes(configPath, Buffer.from(JSON.stringify(config, null, 2) + "\n"), { mode: stat.mode & 0o755, durability: "full" });
		return { code: 0, data: { overall: "OK", session, repo: row.repo, epic: milestone.epic, ...dates, pinned: milestone.pinned, pinLog: milestone.pinLog.slice(-10) }, verification: "NOT_RUN" };
	} catch (error) {
		if (error instanceof AtomicReplaceError && error.published) return { code: 3, data: { overall: "UNVERIFIED", published: true }, errors: [{ code: "MILESTONE_DURABILITY_UNKNOWN", message: error.message, remediation: "The new config is visible, but directory durability failed. Read milestone show before retrying." }], verification: "UNVERIFIED" };
		return refuse(error instanceof MilestoneError ? error.code : "MILESTONE_UNAVAILABLE", error instanceof Error ? error.message : String(error), error instanceof MilestoneError ? 2 : 3);
	} finally { lock?.release(); }
}
