/**
 * kit-seat-identity: SEATNAME1 (ompkit-d5cd5). A seat restored without AGENT_NAME takes its name from its own
 * Tern pane's Agent Mail identity files, at plugin load, before any other kit extension reads the environment.
 *
 * Tern restores a pane as `omp --restore <session file>` (2026-11-08: a daemon restart did this to every seat),
 * and that process has no AGENT_NAME, so every guard that reads it refuses the seat's own writes. register_agent /
 * macro_start_session write `~/.config/agent-mail/identity/<project hash>/tern-<block>` = `{"name":"X"}` for the
 * calling pane. When AGENT_NAME is unset and those files for this process's own TERN_PANE give exactly one valid
 * name, that name is set in process.env: the same state as a seat launched with `AGENT_NAME=X omp ...`, read by
 * every guard, hook and child process. Anything else (an existing AGENT_NAME, no pane, no file, two names, a
 * malformed name) changes nothing.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Agent Mail names: letters and digits only (respawn_seat and kit-inbox-wake accept the same shape). */
const NAME = /^[A-Za-z0-9]{1,64}$/;
const PANE = /^[0-9]{1,20}$/;

/** Pane identity file body: `{"name":"X"}` (current writer) or one bare name (legacy). */
function fileName(path: string): string | null {
	try {
		if (!lstatSync(path).isFile()) return null;
		const text = readFileSync(path, "utf8").trim();
		if (text.startsWith("{")) {
			const value: unknown = JSON.parse(text);
			const name = value !== null && typeof value === "object" ? (value as Record<string, unknown>).name : undefined;
			return typeof name === "string" ? name.trim() : null;
		}
		return text.split("\n")[0]?.trim() ?? null;
	} catch {
		return null;
	}
}

export type SeatName = { kind: "kept" | "set"; name: string } | { kind: "none"; why: string };

/** The name this pane's identity files give, without touching env. */
export function paneSeatName(env: Record<string, string | undefined>, home: string): SeatName {
	const existing = env.AGENT_NAME?.trim();
	if (existing) return { kind: "kept", name: existing };
	const pane = env.TERN_PANE?.trim() ?? "";
	if (!PANE.test(pane)) return { kind: "none", why: "no Tern pane" };
	const root = join(home, ".config", "agent-mail", "identity");
	let dirs: string[];
	try { dirs = readdirSync(root); } catch { return { kind: "none", why: "no identity directory" }; }
	const names = new Map<string, string>();
	for (const dir of dirs) {
		const name = fileName(join(root, dir, `tern-${pane}`));
		if (name === null) continue;
		if (!NAME.test(name)) return { kind: "none", why: `malformed name in ${dir}/tern-${pane}` };
		names.set(name.toLowerCase(), name);
	}
	if (names.size === 0) return { kind: "none", why: `no identity file for tern-${pane}` };
	if (names.size > 1) return { kind: "none", why: `tern-${pane} is bound to ${[...names.values()].join(", ")}` };
	return { kind: "set", name: [...names.values()][0]! };
}

export interface SeatIdentityDeps { env?: Record<string, string | undefined>; home?: string }

export default async function kitSeatIdentity(_pi: unknown, deps: SeatIdentityDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const seat = paneSeatName(env, deps.home ?? homedir());
	if (seat.kind === "set") env.AGENT_NAME = seat.name;
}
