import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fleetPolicyState } from "./fleet-policy";
import { ownerIdentity } from "../src/kitlib/owner.ts";

/**
 * kit-composer-state (COMPOSERTRUTH1, ompkit-hznvg): each fleet seat publishes whether its own composer holds a draft.
 *
 * The sentinel's reload/arm gate (respawn_seat.composer_empty) read the composer from a Tern screen capture and held
 * every seat whose screen layout it did not know as HELD_DRAFT. On 2026-10-22 five goal-mode seats with empty
 * composers never reloaded onto 0.2.69-0.2.71, and their own self-restarts rolled back the same way. omp gives a
 * seat's extension its live composer text (ctx.ui.getEditorText(), interactive TUI), so the seat reports it itself:
 * one JSON record per session file under ~/.local/state/omp-kit/composer/, rewritten at session start, at each turn
 * boundary and every COMPOSER_INTERVAL_MS, removed at shutdown. The record says only whether a draft exists, never
 * its text. Inert unless the repo opted into the fleet, and outside the interactive TUI (RPC's getEditorText is "").
 */
export const COMPOSER_INTERVAL_MS = 5_000;

export interface ComposerStateRecord {
	schema: 1;
	/** Realpath of the omp session file this seat writes, as `tern inspect` reports it. */
	session_file: string;
	pid: number;
	process_start: string;
	/** Epoch milliseconds of this observation. */
	at: number;
	empty: boolean;
	idle: boolean | null;
}

/** Where the record for one session file lives: sha1 of its realpath, so the reader needs no listing. */
export function composerRecordPath(home: string, sessionFile: string): string {
	const key = createHash("sha1").update(sessionFile).digest("hex").slice(0, 16);
	return join(home, ".local", "state", "omp-kit", "composer", `${key}.json`);
}

export interface ComposerStateContext {
	cwd: string;
	mode?: string;
	hasUI?: boolean;
	isIdle?: () => boolean;
	ui?: { getEditorText?: () => string };
	sessionManager?: { getSessionFile?: () => string | undefined };
	setInterval?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

export interface ComposerStateApi {
	on(event: string, handler: (event: never, ctx: ComposerStateContext) => unknown): void;
}

export interface ComposerStateDeps {
	home?: string;
	env?: Readonly<Record<string, string | undefined>>;
	now?: () => number;
}

/** A registered seat's repo owns its opt-in, even when its process starts above that repo. */
function policyCwd(cwd: string, home: string, env: Readonly<Record<string, string | undefined>>): string {
	const pane = env.TERN_PANE;
	if (!pane || !Number.isSafeInteger(Number(pane)) || Number(pane) < 0 || String(Number(pane)) !== pane) return cwd;
	try {
		const registry: unknown = JSON.parse(readFileSync(env.CC_SEATS || join(home, ".local", "state", "omp-kit", "cc", "seats.v1.json"), "utf8"));
		if (typeof registry !== "object" || registry === null || !("schema_version" in registry) ||
			registry.schema_version !== "omp-kit.cc.seats.v1" || !("sessions" in registry) || !Array.isArray(registry.sessions)) return cwd;
		let registeredRepo: string | undefined;
		for (const session of registry.sessions) {
			if (typeof session !== "object" || session === null || typeof session.repo !== "string" ||
				!isAbsolute(session.repo) || !Array.isArray(session.seats)) return cwd;
			for (const seat of session.seats) {
				if (typeof seat !== "object" || seat === null || typeof seat.pane !== "string") return cwd;
				if (seat.pane === `tern:${pane}`) {
					if (registeredRepo !== undefined && registeredRepo !== session.repo) return cwd;
					registeredRepo = session.repo;
				}
			}
		}
		return registeredRepo ?? cwd;
	} catch {
		return cwd;
	}
}

export default async function kitComposerState(pi: ComposerStateApi, deps: ComposerStateDeps = {}): Promise<void> {
	const home = deps.home ?? homedir();
	const now = deps.now ?? Date.now;
	const identity = ownerIdentity(process.pid);
	if (identity === null) return;
	const processIdentity = identity;
	const env = deps.env ?? process.env;
	let timer: unknown = null;
	let written: string | null = null;
	let on = false;

	/** RESTARTRACE1 (J-2026-10-26-20): the seat registry lists a Tern block only while omp runs in it, so a restarted
	 *  seat's session_start can read a registry that dropped it during the restart (lead, 2026-10-26 17:26:51Z: omp
	 *  up, registry re-listed the block at 17:27:06Z). Deciding once there left the seat with no record for its whole
	 *  life, and respawn_seat could never prove the composer empty to resume the goal. The policy is read again on
	 *  every tick until it is on; once on it stays on for this process. */
	async function policyOn(ctx: ComposerStateContext): Promise<boolean> {
		if (!on) on = (await fleetPolicyState(policyCwd(ctx.cwd, home, env))).kind === "on";
		return on;
	}

	async function tick(ctx: ComposerStateContext): Promise<void> {
		try {
			if (await policyOn(ctx)) publish(ctx);
		} catch {
			// An unreadable policy is "not on" for this tick; the next tick reads it again.
		}
	}

	function publish(ctx: ComposerStateContext): void {
		try {
			if (ctx.mode !== "tui" || ctx.hasUI !== true || typeof ctx.ui?.getEditorText !== "function") return;
			const raw = ctx.sessionManager?.getSessionFile?.();
			if (typeof raw !== "string" || raw === "") return;
			let sessionFile = raw;
			try { sessionFile = realpathSync(raw); } catch { /* not on disk yet: the raw path is what Tern will report */ }
			const text = ctx.ui.getEditorText();
			const record: ComposerStateRecord = {
				schema: 1, session_file: sessionFile, pid: processIdentity.pid, process_start: processIdentity.process_start, at: now(),
				empty: typeof text === "string" && text.trim() === "",
				idle: typeof ctx.isIdle === "function" ? ctx.isIdle() : null,
			};
			const path = composerRecordPath(home, sessionFile);
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const tmp = `${path}.${processIdentity.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(record));
			renameSync(tmp, path);
			written = path;
		} catch {
			// A missed publish only means the reader falls back to its (fail-closed) screen check.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// publish() checks the mode and UI on every call, so a seat whose UI is not up at start still publishes later.
		await tick(ctx);
		if (timer === null && typeof ctx.setInterval === "function") timer = ctx.setInterval(() => tick(ctx), COMPOSER_INTERVAL_MS);
	});
	for (const event of ["agent_start", "agent_end", "session_switch"]) {
		pi.on(event, (_event, ctx) => {
			if (on) publish(ctx);
		});
	}
	pi.on("session_shutdown", (_event, ctx) => {
		if (timer !== null) {
			try { ctx.clearTimer?.(timer); } catch { /* cleared on shutdown anyway */ }
			timer = null;
		}
		if (written !== null) {
			try { rmSync(written, { force: true }); } catch { /* a stale or reused writer identity is rejected by the reader */ }
			written = null;
		}
	});
}
