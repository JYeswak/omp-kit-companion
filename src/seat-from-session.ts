/**
 * EVALIDENTITY1 (ompkit-1ra0d.221.2): resolve this seat from its omp session file.
 *
 * omp's Python eval kernels receive an allowlisted environment (PATH, HOME, USER,
 * LC_*, XDG_*, PI_*), so AGENT_NAME and TERN_PANE never reach eval while PI_SESSION_FILE
 * (the seat's own omp session jsonl) does. Kit verbs run from eval therefore refuse the
 * seat's own work: `land` reads OWNER_UNKNOWN and the br shim reads
 * BR_SHIM_IDENTITY_REQUIRED. When TERN_PANE/AGENT_NAME are absent and PI_SESSION_FILE is
 * set, ask Tern (one bounded `tern inspect --json` through the existing observer IO) for
 * live panes and pick the single pane whose omp session file realpath equals
 * PI_SESSION_FILE's realpath. Zero or several matches resolve null: the original refusal
 * stands, never a guess. The name then comes from paneSeatName with that TERN_PANE.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parseTernJson } from "../extensions/tern-json.ts";
import { paneSeatName } from "../extensions/kit-seat-identity.ts";
import { defaultTernIo, type TernObserverIo } from "./plane-tern.ts";

/** Anchored: canonical Tern pane ids are positive decimals without leading zeros. */
const PANE_ID = /^[1-9][0-9]*$/;

export interface SeatSessionDeps {
	env?: Record<string, string | undefined>;
	io?: Pick<TernObserverIo, "run">;
	home?: string;
	realpath?: (path: string) => string;
}

export interface PaneSessionRow {
	paneId: string;
	sessionFile: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Live panes carrying an omp session file, from one `tern inspect --json` snapshot. */
export function listPaneSessionRows(snapshot: unknown): PaneSessionRow[] {
	let parsed: unknown = snapshot;
	if (typeof snapshot === "string") {
		try {
			parsed = parseTernJson(snapshot);
		} catch {
			return [];
		}
	}
	const root = recordOf(parsed);
	const panes = root !== null ? root.panes : null;
	if (!Array.isArray(panes)) return [];
	const rows: PaneSessionRow[] = [];
	for (const raw of panes) {
		const pane = recordOf(raw);
		if (pane === null) continue;
		const id = pane.pane;
		const file = pane.omp_session_file;
		const paneId = typeof id === "number" && Number.isSafeInteger(id) && id > 0
			? String(id)
			: typeof id === "string" && PANE_ID.test(id) ? id : null;
		if (paneId === null || typeof file !== "string" || !file.startsWith("/")) continue;
		rows.push({ paneId, sessionFile: file });
	}
	return rows;
}

/** The single pane whose session file realpath equals the target, else null. */
export function selectPaneBySessionFile(
	targetReal: string,
	rows: Array<{ paneId: string; sessionFileReal: string | null }>,
): string | null {
	const hits = rows.filter((row) => row.sessionFileReal === targetReal).map((row) => row.paneId);
	return hits.length === 1 ? hits[0]! : null;
}

/** This seat's Tern pane from PI_SESSION_FILE alone; null when absent or ambiguous. */
export function resolvePaneForSessionFileSync(deps: SeatSessionDeps = {}): string | null {
	const env = deps.env ?? process.env;
	const target = env.PI_SESSION_FILE?.trim();
	if (!target) return null;
	const realpath = deps.realpath ?? realpathSync;
	let targetReal: string;
	try {
		targetReal = realpath(target);
	} catch {
		return null;
	}
	const io = deps.io ?? defaultTernIo();
	let raw: { code: number; out: string };
	try {
		raw = io.run(["tern", "inspect", "--json"]);
	} catch {
		return null;
	}
	if (raw.code !== 0) return null;
	const rows = listPaneSessionRows(raw.out);
	return selectPaneBySessionFile(targetReal, rows.map((row) => {
		let sessionFileReal: string | null = null;
		try {
			sessionFileReal = realpath(row.sessionFile);
		} catch {
			sessionFileReal = null;
		}
		return { paneId: row.paneId, sessionFileReal };
	}));
}

/** This seat's pane and Agent Mail name from PI_SESSION_FILE alone; null when unknown. */
export function resolveSeatNameFromSessionFileSync(
	deps: SeatSessionDeps = {},
): { pane: string; name: string } | null {
	const env = deps.env ?? process.env;
	const pane = resolvePaneForSessionFileSync(deps);
	if (pane === null) return null;
	const seat = paneSeatName({ ...env, TERN_PANE: pane }, deps.home ?? homedir());
	if (seat.kind === "none") return null;
	return { pane, name: seat.name };
}

if (import.meta.main) {
	const seat = resolveSeatNameFromSessionFileSync();
	if (seat === null) process.exit(1);
	process.stdout.write(`${seat.name}\n`);
}
