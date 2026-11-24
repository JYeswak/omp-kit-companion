// Seat-facing reservation verbs on the Board adapter (bead ompkit-tnqyr.3).
import { realpathSync } from "node:fs";
import { runSync } from "./kitlib/run.ts";
import { BoardReservations, boardChannel, type Hold } from "./fleet-guard/board-reservations.ts";

export interface ReservationRequest {
	verb: "reserve" | "release" | "reservations";
	globs: string[];
	project?: string;
	reason?: string;
	ttl?: number;
	checkStaged?: boolean;
	holder?: string;
}

export interface ReservationOutcome {
	code: number;
	data: Record<string, unknown>;
	error?: { code: string; message: string; remediation: string };
}

/** Seats reach one checkout through several spellings (symlinks); the channel keys on the real path. */
function realpathOr(path: string): string {
	try { return realpathSync(path); } catch { return path; }
}

function projectRoot(project: string | undefined): string {
	if (project) return realpathOr(project);
	const r = runSync(["git", "rev-parse", "--show-toplevel"], { cwd: process.cwd(), deadline_s: 10 });
	return realpathOr(r.rc === 0 ? new TextDecoder().decode(r.stdout).trim() : process.cwd());
}

function stagedPaths(root: string): string[] {
	const r = runSync(["git", "-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMRTD"], { cwd: root, deadline_s: 30 });
	if (r.rc !== 0) throw new Error("cannot list staged paths");
	return new TextDecoder().decode(r.stdout).split("\n").map((p) => p.trim()).filter(Boolean);
}

export async function runReservation(req: ReservationRequest, board: BoardReservations = new BoardReservations()): Promise<ReservationOutcome> {
	const holder = req.holder ?? process.env.AGENT_NAME ?? "";
	const root = projectRoot(req.project);
	const channel = boardChannel(root);
	const needHolder = req.verb !== "reservations" || req.checkStaged;
	if (needHolder && !holder) {
		return { code: 1, data: { overall: "REFUSED" }, error: { code: "AGENT_NAME_REQUIRED", message: "AGENT_NAME names the holder", remediation: "Run from a seat with AGENT_NAME set; nothing was changed." } };
	}
	try {
		if (req.verb === "reserve") {
			if (!req.reason) return { code: 1, data: { overall: "REFUSED" }, error: { code: "REASON_REQUIRED", message: "reserve needs --reason BEAD", remediation: "Pass --reason with the bead id; nothing was reserved." } };
			const grant = await board.reserve(root, holder, req.globs, req.ttl ?? 3600, req.reason);
			const refused = grant.conflicts.length > 0 && grant.granted.length < req.globs.length;
			return { code: refused ? 1 : 0, data: { overall: refused ? "REFUSED" : "CHANGED", channel, granted: grant.granted, conflicts: grant.conflicts },
				...(refused ? { error: { code: "RESERVATION_CONFLICT", message: `held by ${[...new Set(grant.conflicts.map((h) => h.holder))].join(", ")}`, remediation: "Wait, or ask the holder to release; granted paths (if any) stay held until released." } } : {}) };
		}
		if (req.verb === "release") {
			const released = await board.release(root, holder, req.globs);
			return { code: 0, data: { overall: "CHANGED", channel, released } };
		}
		if (req.checkStaged) {
			const refused: Array<{ path: string; holders: string[] }> = [];
			for (const path of stagedPaths(root)) {
				const verdict = await board.check(root, holder, path);
				if (verdict.conflicts.length) refused.push({ path, holders: [...new Set(verdict.conflicts.map((h: Hold) => h.holder))] });
			}
			return { code: refused.length ? 1 : 0, data: { overall: refused.length ? "REFUSED" : "OK", channel, refused },
				...(refused.length ? { error: { code: "RESERVED_BY_OTHER", message: refused.map((r) => `${r.path} held by ${r.holders.join(", ")}`).join("; "), remediation: "Unstage those paths or wait for the holder to release." } } : {}) };
		}
		const holds = await board.attestedOpen(root);
		return { code: 0, data: { overall: "OK", channel, holds } };
	} catch (error) {
		return { code: 1, data: { overall: "UNVERIFIED", channel, snapshot_age_s: board.snapshotAgeS(root) }, error: { code: "BOARD_UNAVAILABLE", message: String(error), remediation: "Check the Board server (BOARD_URL); nothing was changed." } };
	}
}
