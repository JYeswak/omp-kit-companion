import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendJsonl } from "../src/kitlib/jsonl.ts";

/**
 * gate-events (GATEEVENTS1, ompkit-fp72.135.3.12; plan section 23.4): one ledger every gate appends to, so
 * refusals and passes per act are measured instead of remembered. The git hook chain runner writes the same
 * rows from shell (`scripts/gate-event.sh`); `omp-kit`'s `scripts/measure.py` reads them (M-REFUSAL-RATE,
 * M-REFUSAL-CHAIN, M-FIRST-ATTEMPT, M-AUTO-COMPLETED).
 *
 * Row: { ts, seat, act, target, gate, kind, detail }. `kind` is pass | refuse | inject | auto_complete.
 * `act` names what the agent was trying to do (commit, close, claim, in-review, release, publish, bash);
 * `gate` names the check that answered (CLAIM_REFUSED, SELF_CLOSE_REFUSED, commit-notes, ...).
 * Writing is best effort and never throws into the guard: a ledger failure is reported, never a refusal.
 */
export type GateEventKind = "pass" | "refuse" | "inject" | "auto_complete";

export interface GateEvent {
	seat: string | null;
	act: string;
	target: string | null;
	gate: string;
	kind: GateEventKind;
	/** One act attempt: the tool call id, or the git process pid shared by every hook runner of one git command. */
	attempt?: string;
	detail?: string;
}

export function gateEventsPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME : join(home, ".local", "state");
	return join(state, "omp-kit", "gate-events.jsonl");
}

/** The tracker act a bash command performs, or null when it is not a tracker act. */
export function trackerAct(command: string): { act: string; target: string | null } | null {
	// Intended: a `br`/`bd` invocation at a command start (after `;`, `&&`, `|`, `(` or line start), optionally with
	// global `--flag value` pairs, then the subcommand. `echo br close` is not a tracker act. Linear: each class
	// excludes what follows it; verified with a 40 KB near-miss in 0.06 ms.
	const m = /(?:^|[;&|(]\s*)(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:br|bd)\s+(?:--[a-z-]+(?:[= ]\S+)?\s+)*([a-z-]+)\b([^;&|]*)/.exec(command);
	if (!m) return null;
	const sub = m[1];
	const rest = m[2] ?? "";
	const id = /\b([a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]*)\b/.exec(rest)?.[1] ?? null;
	if (sub === "close") return { act: "close", target: id };
	if (sub === "create") return { act: "create", target: null };
	if (sub === "update") {
		if (/\s--claim\b/.test(rest)) return { act: "claim", target: id };
		const status = /\s--status[= ]+([a-z_]+)/.exec(rest)?.[1];
		if (status === "in_review") return { act: "in-review", target: id };
		if (status === "open" && /--assignee[= ]+(""|'')/.test(rest)) return { act: "release", target: id };
		if (status) return { act: `status:${status}`, target: id };
		return { act: "update", target: id };
	}
	return null;
}

/** The gate name inside a guard refusal: the JSON `code`, else the first `<GUARD> <CODE>` token pair, else the guard. */
export function gateFromReason(reason: string): string {
	try {
		const parsed = JSON.parse(reason) as { code?: unknown; guard?: unknown };
		if (typeof parsed.code === "string" && parsed.code) return parsed.code;
		if (typeof parsed.guard === "string" && parsed.guard) return parsed.guard;
	} catch { /* not JSON */ }
	const m = /^(?:\[?kit-[a-z-]+\]?)\s+([A-Z][A-Z0-9_]+)/.exec(reason.trim());
	return m?.[1] ?? reason.trim().split(/\s+/)[0] ?? "UNKNOWN";
}

export async function recordGateEvent(event: GateEvent, options: { env?: Record<string, string | undefined>; home?: string; path?: string } = {}): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
	const path = options.path ?? gateEventsPath(options.env, options.home);
	const row = { ts: new Date().toISOString(), seat: event.seat, act: event.act, target: event.target, gate: event.gate, kind: event.kind,
		...(event.attempt ? { attempt: event.attempt } : {}),
		...(event.detail ? { detail: event.detail.slice(0, 400) } : {}) };
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// The lock lives beside the ledger, so a test or a seat with its own XDG_STATE_HOME never shares a lock root.
		await appendJsonl(path, () => row, { deadline_s: 2, tornTail: "newline", state_dir: dirname(path) });
		return { ok: true, path };
	} catch (error) {
		return { ok: false, why: error instanceof Error ? error.message : String(error) };
	}
}
