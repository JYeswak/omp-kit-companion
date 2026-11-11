	import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendJsonl } from "../src/kitlib/jsonl.ts";
import { captureMineReplay, readMineReplay, type MineReplay } from "../src/mine-replay.ts";

/**
 * gate-events (GATEEVENTS1, ompkit-fp72.135.3.12; plan section 23.4): one ledger every gate appends to, so
 * refusals and passes per act are measured instead of remembered. The git hook chain runner writes the same
 * rows from shell (`scripts/gate-event.sh`); `omp-kit`'s `scripts/measure.py` reads them (M-REFUSAL-RATE,
 * M-REFUSAL-CHAIN, M-FIRST-ATTEMPT, M-AUTO-COMPLETED).
 *
 * Row: { ts, seat, act, target, gate, kind, repo, member, started_at, duration_s, detail }.
 * `act` names what the agent was trying to do (commit, close, claim, in-review, release, publish, bash);
 * `gate` names the check that answered (CLAIM_REFUSED, SELF_CLOSE_REFUSED, commit-notes, ...).
 * Writing is best effort and never throws into the guard: a ledger failure is reported, never a refusal.
 */
export type GateEventKind = "pass" | "refuse" | "inject" | "auto_complete" | "notice";

export interface GateEvent {
	seat: string | null;
	act: string;
	target: string | null;
	gate: string;
	kind: GateEventKind;
	/** Git worktree root (resolved from replay.cwd when omitted); null outside a repository. */
	repo?: string | null;
	member?: string;
	/** Check start, not ledger append time. Omitted clocks describe only this recorder invocation. */
	started_at?: string;
	duration_s?: number;
	/** One act attempt: the tool call id, or the git process pid shared by every hook runner of one git command. */
	attempt?: string;
	event_id?: string;
	replay?: MineReplay;
	/** Actual producer exit status, never a synthesized refusal status. */
	rc?: number;
	detail?: string;
}

export function gateEventsPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME : join(home, ".local", "state");
	return join(state, "omp-kit", "gate-events.jsonl");
}

function eventRepo(cwd: string): string | null {
	try {
		let path = realpathSync(resolve(cwd));
		for (;;) {
			if (existsSync(join(path, ".git"))) return path;
			const parent = dirname(path);
			if (parent === path) return null;
			path = parent;
		}
	} catch { return null; }
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

/** Lines of a refusal searched for its `<GUARD> <CODE>` header: a wait refusal leads with the seat's constraint line and
 * carries the header on line 2 (KEEPALIVE2a ompkit-774u.50.1); a header further down is quoted text, not the refusal's own. */
const HEADER_LINES = 3;

/** The gate name inside a guard refusal: the JSON `code`, else the `<GUARD> <CODE>` header in the first three lines,
 * else the first token. */
export function gateFromReason(reason: string): string {
	try {
		const parsed = JSON.parse(reason) as { code?: unknown; guard?: unknown };
		if (typeof parsed.code === "string" && parsed.code) return parsed.code;
		if (typeof parsed.guard === "string" && parsed.guard) return parsed.guard;
	} catch { /* not JSON */ }
	for (const line of reason.trim().split("\n", HEADER_LINES)) {
		const m = /^(?:\[?kit-[a-z-]+\]?)\s+([A-Z][A-Z0-9_]+)/.exec(line.trim());
		if (m) return m[1]!;
	}
	return reason.trim().split(/\s+/)[0] ?? "UNKNOWN";
}

/** A refusal class derived from refusal text, never a gate's own verdict. */
const DERIVED_REFUSAL_GATE = /^(?:guard-friction|commit-refusal):/;
/** How far back to look for the first refusal of one attempt; the second write lands seconds later. */
const DERIVED_SIBLING_TAIL_BYTES = 256 * 1024;

/** Whether the ledger already holds a refusal row for this attempt under the same real code. Fail-open: any read failure keeps the append. */
function hasRefuseSibling(path: string, attempt: string, code: string): boolean {
	let fd = -1;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size <= 0) return false;
		const start = Math.max(0, stat.size - DERIVED_SIBLING_TAIL_BYTES);
		const buffer = Buffer.alloc(Math.min(stat.size - start, DERIVED_SIBLING_TAIL_BYTES));
		let got = 0;
		while (got < buffer.length) {
			const n = readSync(fd, buffer, got, buffer.length - got, start + got);
			if (n <= 0) break;
			got += n;
		}
		const rows = buffer.subarray(0, got).toString("utf8").split("\n");
		// A nonzero start may cut a row in two; it cannot complete a later row.
		for (let index = start > 0 ? 1 : 0; index < rows.length; index++) {
			const raw = rows[index]!.trim();
			if (raw === "") continue;
			let row: { kind?: unknown; gate?: unknown; attempt?: unknown };
			try { row = JSON.parse(raw) as typeof row; } catch { continue; }
			if (row.kind === "refuse" && row.attempt === attempt && typeof row.gate === "string" && row.gate.replace(DERIVED_REFUSAL_GATE, "") === code) return true;
		}
		return false;
	} catch {
		return false;
	} finally {
		if (fd >= 0) try { closeSync(fd); } catch { /* Best effort. */ }
	}
}

export async function recordGateEvent(event: GateEvent, options: { env?: Record<string, string | undefined>; home?: string; path?: string } = {}): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
	const recordedAt = new Date().toISOString();
	const startedAt = event.started_at ?? recordedAt;
	const duration = event.duration_s ?? 0;
	if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(duration) || duration < 0)
		return { ok: false, why: "Invalid gate event timing" };
	const path = options.path ?? gateEventsPath(options.env, options.home);
	const replay = event.replay === undefined ? undefined : readMineReplay(event.replay);
	let metadataRedacted = false;
	let metadataTruncated = false;
	const clean = (value: string | null): string | null => {
		if (value === null) return null;
		const captured = captureMineReplay({ message: value });
		metadataRedacted ||= captured.redacted;
		metadataTruncated ||= captured.truncated;
		return captured.message ?? "[OMITTED]";
	};
	const row = { ts: recordedAt, seat: clean(event.seat), act: clean(event.act), target: clean(event.target), gate: clean(event.gate),
		repo: clean(event.repo === null ? null : eventRepo(event.repo ?? replay?.cwd ?? process.cwd())),
		member: clean(event.member ?? event.gate), started_at: startedAt, duration_s: duration,
		kind: event.rc === 0 && event.kind === "refuse" ? "pass" : clean(event.kind),
		...(event.attempt ? { attempt: clean(event.attempt) } : {}),
		...(event.event_id ? { event_id: clean(event.event_id) } : {}),
		...(typeof event.rc === "number" ? { rc: event.rc } : {}),
		...(replay ? { replay } : {}),
		...(event.detail ? { detail: clean(event.detail)?.slice(0, 400) } : {}),
		...(metadataRedacted ? { metadata_redacted: true } : {}),
		...(metadataTruncated ? { metadata_truncated: true } : {}) };
	// LEDGERCLASS1 (ompkit-1ra0d.68): one refused act writes one row. The guard records the block
	// (gate X) and classifies the same attempt again; the re-observation belongs in the miners'
	// own outputs, not in a second refusal row. GATEBUDGETHYGIENE1 (ompkit-1ra0d.129): the guard
	// files the re-observation under its real code, so the duplicate is caught by comparing real
	// codes, not prefixes. Fail-open by construction.
	if (row.kind === "refuse" && typeof row.gate === "string"
		&& typeof row.attempt === "string" && row.attempt !== "" && hasRefuseSibling(path, row.attempt, row.gate.replace(DERIVED_REFUSAL_GATE, ""))) {
		return { ok: true, path };
	}
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// The lock lives beside the ledger, so a test or a seat with its own XDG_STATE_HOME never shares a lock root.
		await appendJsonl(path, () => row, { deadline_s: 2, tornTail: "newline", state_dir: dirname(path) });
		return { ok: true, path };
	} catch (error) {
		return { ok: false, why: error instanceof Error ? error.message : String(error) };
	}
}
