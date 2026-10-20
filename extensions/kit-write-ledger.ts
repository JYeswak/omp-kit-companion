/**
 * kit-write-ledger (ompkit-52p3 OWN1-LEDGER): every agent write is attributed.
 *
 * git cannot tell who wrote unstaged bytes, so shared-checkout dirt reads as
 * "unknown foreign". On a successful edit/write/ast_edit tool result the guard
 * appends {repo, relpath, agent (pane identity), session id, ts, blob after}
 * to a per-repo append-only JSONL ledger under the kit state dir, never in
 * the repo. bash writes that cannot be attributed stay unattributed and are
 * reported as such.
 *
 * The census and the save guard read the ledger: the owner of a dirty path is
 * its last writer while that writer is live, else the owner of record by rule.
 *
 * Ledger writes are synchronous, timed, and never throw: a ledger failure
 * never blocks the tool call (AC4).
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
export const WRITE_LEDGER_VERSION = 1;
export const WRITE_LEDGER_DIR = "write-ledger";

/** One attributed write. `blob` is the sha256 of the resulting bytes (or `link:<target>`), null when absent. */
export interface WriteLedgerEntry {
	v: number;
	repo: string;
	relpath: string;
	agent: string;
	session: string;
	ts: string;
	blob: string | null;
}

/** Agent (pane) identity: explicit env first; null when unknown (never guessed). */
export function resolveLedgerAgent(env: Record<string, string | undefined>): string | null {
	for (const name of ["BR_ACTOR", "BR_AGENT_NAME", "AGENT_NAME"] as const) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return null;
}

/** Kit state root: `$XDG_STATE_HOME/omp-kit`, default `~/.local/state/omp-kit`. Null without a canonical absolute HOME. */
export function ledgerStateRoot(home: string | undefined, xdgStateHome: string | undefined): string | null {
	if (!home || !path.isAbsolute(home) || path.resolve(home) !== home) return null;
	const xdg = xdgStateHome && xdgStateHome.length > 0 ? xdgStateHome : path.join(home, ".local", "state");
	if (!path.isAbsolute(xdg) || path.resolve(xdg) !== xdg) return null;
	return path.join(xdg, "omp-kit");
}

/** Append-only per-repo ledger file. The repo root is hashed so no repo path leaks into the filename. */
export function ledgerFileFor(stateRoot: string, repoRoot: string): string {
	const digest = createHash("sha256").update(repoRoot).digest("hex");
	return path.join(stateRoot, WRITE_LEDGER_DIR, `${digest}.jsonl`);
}

export interface LedgerAppendResult {
	ok: boolean;
	durationMs: number;
}

/**
 * Append one entry. Never throws and never blocks the caller on failure:
 * failure reads as ok:false. AC4: p95 under 5 ms per tool call (measured in test).
 */
export function appendLedgerEntry(stateRoot: string, entry: WriteLedgerEntry): LedgerAppendResult {
	const started = Date.now();
	try {
		const file = ledgerFileFor(stateRoot, entry.repo);
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
		return { ok: true, durationMs: Date.now() - started };
	} catch {
		return { ok: false, durationMs: Date.now() - started };
	}
}

/** Last ledger entry per relpath for one repo. Malformed lines are skipped, never fatal. */
export function lastWriters(stateRoot: string, repoRoot: string): Map<string, WriteLedgerEntry> {
	const out = new Map<string, WriteLedgerEntry>();
	let raw: string;
	try {
		raw = readFileSync(ledgerFileFor(stateRoot, repoRoot), "utf8");
	} catch {
		return out;
	}
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const row = parsed as Record<string, unknown>;
		if (row.v !== WRITE_LEDGER_VERSION || row.repo !== repoRoot ||
			typeof row.relpath !== "string" || typeof row.agent !== "string" ||
			typeof row.session !== "string" || typeof row.ts !== "string" ||
			!(typeof row.blob === "string" || row.blob === null)) continue;
		out.set(row.relpath, parsed as unknown as WriteLedgerEntry);
	}
	return out;
}

export type DirtyOwner =
	| { kind: "writer"; agent: string; session: string }
	| { kind: "rule" }
	| { kind: "unattributed" };

/**
 * Census ownership of one dirty path: its last ledger writer while that
 * writer is live, else the owner of record by rule. A path with no ledger
 * entry stays unattributed (bash writes are never guessed).
 */
export function resolveDirtyOwner(
	last: WriteLedgerEntry | undefined,
	isLive: (agent: string, session: string) => boolean,
): DirtyOwner {
	if (!last) return { kind: "unattributed" };
	if (isLive(last.agent, last.session)) return { kind: "writer", agent: last.agent, session: last.session };
	return { kind: "rule" };
}

/** Census a set of dirty paths against the ledger in one read. */
export function censusDirtyPaths(
	stateRoot: string,
	repoRoot: string,
	dirtyPaths: string[],
	isLive: (agent: string, session: string) => boolean,
): Map<string, DirtyOwner> {
	const writers = lastWriters(stateRoot, repoRoot);
	const out = new Map<string, DirtyOwner>();
	for (const relpath of dirtyPaths) out.set(relpath, resolveDirtyOwner(writers.get(relpath), isLive));
	return out;
}

/** True when the ledger's last writer of this path is the given session (AC3: save demand only then). */
export function isCurrentSessionWriter(last: { session: string } | undefined, sessionId: string): boolean {
	return last !== undefined && last.session === sessionId;
}
