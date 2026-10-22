/**
 * STALEDEF1 (ompkit-f9dun): is the holder of an in_progress claim live? The AGENTS
 * rule reclaims a claim untouched 24 h only when its holder is not live, where live
 * means any of:
 *   - a live seat: the name Agent Mail's identity registry binds to a live Tern block
 *     (`tern inspect --json`) or a tmux pane, in any project folder;
 *   - genuine Agent Mail activity within 24 h: a sent message, a read or ack, or a
 *     reservation granted (last_active_ts alone never counts, per AMLIVE1);
 *   - a live reservation: unreleased and unexpired, any project.
 * Every source is read or reported unreadable. A holder with no live evidence is
 * DEAD only when all three sources were read; otherwise UNKNOWN, never DEAD.
 * Names match case-insensitively across projects, so a namesake elsewhere reads
 * live (the safe direction: a wrong LIVE keeps a claim, a wrong DEAD steals one).
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOLDER_LIVE_WINDOW_MS = 24 * 3600 * 1000;

export type Liveness = "LIVE" | "DEAD" | "UNKNOWN";
export type Source<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };
export type LivenessSources = {
	/** Lower-cased names sitting in a live seat. */
	readonly seats: Source<ReadonlySet<string>>;
	/** Lower-cased name -> newest genuine Agent Mail activity (ms) inside the window. */
	readonly mail: Source<ReadonlyMap<string, number>>;
	/** Lower-cased names holding an unreleased, unexpired reservation. */
	readonly reservations: Source<ReadonlySet<string>>;
};
export type HolderVerdict = { readonly liveness: Liveness; readonly evidence: readonly string[] };
export type CommandResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
export type LivenessProbe = {
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly run: (argv: readonly string[]) => CommandResult;
};
export type AsyncLivenessProbe = Omit<LivenessProbe, "run"> & { readonly run: (argv: readonly string[]) => Promise<CommandResult> };

export const TERN_INSPECT = ["tern", "inspect", "--json"] as const;
export const TMUX_PANES = ["tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}:#{window_index}:#{pane_index}"] as const;

export function holderVerdict(holder: string, sources: LivenessSources, nowMs: number): HolderVerdict {
	const key = holder.trim().toLowerCase();
	const live: string[] = [];
	const unreadable: string[] = [];
	if (!sources.seats.ok) unreadable.push(`seat inventory unreadable: ${sources.seats.why}`);
	else if (sources.seats.value.has(key)) live.push("sits in a live seat");
	if (!sources.mail.ok) unreadable.push(`Agent Mail activity unreadable: ${sources.mail.why}`);
	else {
		const at = sources.mail.value.get(key);
		if (at !== undefined && nowMs - at <= HOLDER_LIVE_WINDOW_MS) live.push(`Agent Mail activity at ${new Date(at).toISOString()}`);
	}
	if (!sources.reservations.ok) unreadable.push(`reservations unreadable: ${sources.reservations.why}`);
	else if (sources.reservations.value.has(key)) live.push("holds a live reservation");
	if (live.length > 0) return { liveness: "LIVE", evidence: live };
	if (unreadable.length > 0) return { liveness: "UNKNOWN", evidence: unreadable };
	return { liveness: "DEAD", evidence: ["no live seat", "no Agent Mail activity in 24 h", "no live reservation"] };
}

/** mcp-agent-mail pane_identity sanitize_pane_id: drop a leading %, ':' -> '-', other non [A-Za-z0-9_-] -> '_'. */
export function sanitizePaneKey(key: string): string {
	let out = "";
	for (const ch of key.startsWith("%") ? key.slice(1) : key) {
		const code = ch.charCodeAt(0);
		const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ch === "_" || ch === "-";
		out += word ? ch : ch === ":" ? "-" : "_";
	}
	return out;
}

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Identity keys (`tern-<block>`) of live Tern blocks whose pane has not exited. */
export function liveTernBlockKeys(result: CommandResult): Source<string[]> {
	if (result.code !== 0) return { ok: false, why: `tern inspect exited ${result.code ?? "without a status"}: ${result.stderr.trim().slice(0, 160)}` };
	let parsed: Record<string, unknown> | null;
	try { parsed = record(JSON.parse(result.stdout)); } catch { return { ok: false, why: "tern inspect returned unparseable JSON" }; }
	if (parsed === null || !Array.isArray(parsed.sessions)) return { ok: false, why: "tern inspect returned no sessions list" };
	const exited = new Set<string>();
	for (const pane of Array.isArray(parsed.panes) ? parsed.panes : []) {
		const row = record(pane);
		if (row !== null && row.exited !== null && row.exited !== undefined) exited.add(String(row.pane));
	}
	const keys: string[] = [];
	for (const session of parsed.sessions) {
		for (const tab of Array.isArray(record(session)?.tabs) ? record(session)!.tabs as unknown[] : []) {
			for (const block of Array.isArray(record(tab)?.blocks) ? record(tab)!.blocks as unknown[] : []) {
				const row = record(block);
				if (row === null || row.live === false || row.id === undefined || row.id === null) continue;
				const id = String(row.id);
				if (!exited.has(id)) keys.push(`tern-${id}`);
			}
		}
	}
	return { ok: true, value: keys };
}

/** Identity keys of live tmux panes (composite first, then bare pane id); no server is an empty fleet. */
export function tmuxPaneKeys(result: CommandResult): Source<string[]> {
	if (result.code !== 0) {
		const stderr = result.stderr;
		if (stderr.includes("no server running") || stderr.includes("error connecting to")) return { ok: true, value: [] };
		return { ok: false, why: `tmux list-panes exited ${result.code ?? "without a status"}: ${stderr.trim().slice(0, 160)}` };
	}
	const keys: string[] = [];
	for (const line of result.stdout.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		keys.push(sanitizePaneKey(line.slice(tab + 1).trim()), sanitizePaneKey(line.slice(0, tab).trim()));
	}
	return { ok: true, value: keys };
}

/** Names bound to any of `keys` in any project folder of the identity registry. */
export function seatNames(identityRoot: string, keys: readonly string[]): Source<ReadonlySet<string>> {
	let folders: string[];
	try { folders = readdirSync(identityRoot); } catch { return { ok: false, why: `identity registry ${identityRoot} is unreadable` }; }
	const wanted = new Set(keys);
	const names = new Set<string>();
	for (const folder of folders) {
		let files: string[];
		try { files = readdirSync(join(identityRoot, folder)); } catch { continue; }
		for (const file of files) {
			if (!wanted.has(file)) continue;
			let text: string;
			try { text = readFileSync(join(identityRoot, folder, file), "utf8").trim(); } catch { continue; }
			try {
				const value = record(JSON.parse(text));
				if (value !== null) text = typeof value.name === "string" ? value.name : "";
			} catch { /* a bare name file */ }
			const name = text.split("\n")[0]?.trim().toLowerCase() ?? "";
			if (name !== "") names.add(name);
		}
	}
	return { ok: true, value: names };
}

function expandHome(value: string, home: string): string {
	return value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

/** The live Agent Mail storage root: AGENT_MAIL_STORAGE_ROOT, else the server's own config.env keys. */
export function agentMailStorageRoot(env: Readonly<Record<string, string | undefined>>, home: string): string | null {
	const fromEnv = env.AGENT_MAIL_STORAGE_ROOT?.trim();
	if (fromEnv) return expandHome(fromEnv, home);
	let text: string;
	try { text = readFileSync(join(home, ".config", "mcp-agent-mail", "config.env"), "utf8"); } catch { return null; }
	const found: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		let line = raw.trim();
		if (line.startsWith("export ")) line = line.slice("export ".length).trim();
		const eq = line.indexOf("=");
		if (eq <= 0 || line.startsWith("#")) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
		if (value !== "" && (key === "AGENT_MAIL_STORAGE_ROOT" || key === "STORAGE_ROOT")) found[key] = value;
	}
	const root = found.AGENT_MAIL_STORAGE_ROOT ?? found.STORAGE_ROOT;
	return root === undefined ? null : expandHome(root, home);
}

/** Genuine activity and live reservations from the Agent Mail store (timestamps in microseconds). */
export function readMailLiveness(storageRoot: string | null, nowMs: number): { mail: LivenessSources["mail"]; reservations: LivenessSources["reservations"] } {
	if (storageRoot === null) {
		const why = "no Agent Mail storage root (AGENT_MAIL_STORAGE_ROOT unset and no ~/.config/mcp-agent-mail/config.env root)";
		return { mail: { ok: false, why }, reservations: { ok: false, why } };
	}
	const path = join(storageRoot, "storage.sqlite3");
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		const sinceUs = (nowMs - HOLDER_LIVE_WINDOW_MS) * 1000;
		const activity = db.query(`SELECT lower(a.name) AS name, MAX(e.ts) AS ts FROM (
			SELECT sender_id AS agent_id, created_ts AS ts FROM messages WHERE created_ts >= ?1
			UNION ALL SELECT agent_id, read_ts FROM message_recipients WHERE read_ts >= ?1
			UNION ALL SELECT agent_id, ack_ts FROM message_recipients WHERE ack_ts >= ?1
			UNION ALL SELECT agent_id, created_ts FROM file_reservations WHERE created_ts >= ?1
		) e JOIN agents a ON a.id = e.agent_id GROUP BY lower(a.name)`).all(sinceUs) as Array<{ name: unknown; ts: unknown }>;
		const held = db.query(`SELECT DISTINCT lower(a.name) AS name FROM file_reservations r JOIN agents a ON a.id = r.agent_id
			WHERE r.released_ts IS NULL AND r.expires_ts > ?1`).all(nowMs * 1000) as Array<{ name: unknown }>;
		const mail = new Map<string, number>();
		for (const row of activity) if (typeof row.name === "string" && typeof row.ts === "number") mail.set(row.name, Math.floor(row.ts / 1000));
		const reservations = new Set<string>();
		for (const row of held) if (typeof row.name === "string") reservations.add(row.name);
		return { mail: { ok: true, value: mail }, reservations: { ok: true, value: reservations } };
	} catch (error) {
		const why = `${path} unreadable: ${error instanceof Error ? error.message : String(error)}`;
		return { mail: { ok: false, why }, reservations: { ok: false, why } };
	} finally {
		db?.close();
	}
}

function combine(home: string, env: LivenessProbe["env"], tern: CommandResult, tmux: CommandResult, nowMs: number): LivenessSources {
	const ternKeys = liveTernBlockKeys(tern);
	const tmuxKeys = tmuxPaneKeys(tmux);
	const seats: LivenessSources["seats"] = !ternKeys.ok ? ternKeys : !tmuxKeys.ok ? tmuxKeys
		: seatNames(join(home, ".config", "agent-mail", "identity"), [...ternKeys.value, ...tmuxKeys.value]);
	return { seats, ...readMailLiveness(agentMailStorageRoot(env, home), nowMs) };
}

export function readLivenessSources(probe: LivenessProbe, nowMs: number): LivenessSources {
	return combine(probe.home, probe.env, probe.run(TERN_INSPECT), probe.run(TMUX_PANES), nowMs);
}

export async function readLivenessSourcesAsync(probe: AsyncLivenessProbe, nowMs: number): Promise<LivenessSources> {
	const [tern, tmux] = await Promise.all([probe.run(TERN_INSPECT), probe.run(TMUX_PANES)]);
	return combine(probe.home, probe.env, tern, tmux, nowMs);
}

export function defaultLivenessProbe(env: Readonly<Record<string, string | undefined>> = process.env): LivenessProbe {
	return {
		home: env.HOME ?? homedir(),
		env,
		run: argv => {
			const child = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
			if (child.error) return { code: null, stdout: "", stderr: child.error.message };
			return { code: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
		},
	};
}
