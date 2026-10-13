import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const STALE_UNASSIGNED_MS = 24 * 3600 * 1000;
export const STALE_EVIDENCE_MS = 48 * 3600 * 1000;

/** A grader verdict line: the close stays drained only with one of these after landing. */
export const VERDICT_LINE = /^(CLOSED|REWORK|GRADE[SD]?|VERDICT|REVIEW(?:ED)?|PASS(?:ED)?|FAIL(?:ED)?)\b/i;
/** Bead ids named by landing commits (commit subject or Bead: trailer). */
export const BEAD_ID = /\b([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g;

export type DrainIssue = {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly assignee: string | null;
	readonly updatedMs: number;
};
export type DrainComment = { readonly issueId: string; readonly author: string; readonly text: string; readonly createdMs: number };
export type Landing = { readonly sha: string; readonly committedMs: number };
export type CloseQueueRow = { readonly id: string; readonly title: string; readonly landingSha: string; readonly landedMs: number };
export type StaleClaimRow = {
	readonly id: string;
	readonly title: string;
	readonly reason: "unassigned-24h" | "evidence-stale-48h";
	readonly lastActivityMs: number;
	readonly reclaim: string;
};

const ms = (value: string | number): number => (typeof value === "number" ? value : Date.parse(value));

function commentsByIssue(comments: readonly DrainComment[]): Map<string, DrainComment[]> {
	const byId = new Map<string, DrainComment[]>();
	for (const comment of comments) {
		const list = byId.get(comment.issueId) ?? [];
		list.push(comment);
		byId.set(comment.issueId, list);
	}
	for (const list of byId.values()) list.sort((a, b) => a.createdMs - b.createdMs);
	return byId;
}

/** Landed-but-open beads (ompkit-kdbz.1 DRAIN1): an open bead whose id a landing
 * commit names, with no grader VERDICT comment since that commit. Proves landings
 * lack verdicts, never that the landings are correct. */
export function closeQueue(
	issues: readonly DrainIssue[],
	comments: readonly DrainComment[],
	landings: ReadonlyMap<string, Landing>,
): CloseQueueRow[] {
	const byId = commentsByIssue(comments);
	const rows: CloseQueueRow[] = [];
	for (const issue of issues) {
		if (issue.status !== "open") continue;
		const landing = landings.get(issue.id);
		if (!landing) continue;
		const since = (byId.get(issue.id) ?? []).filter(comment => comment.createdMs >= landing.committedMs);
		if (since.some(comment => VERDICT_LINE.test(comment.text.trimStart()))) continue;
		rows.push({ id: issue.id, title: issue.title, landingSha: landing.sha, landedMs: landing.committedMs });
	}
	return rows.sort((a, b) => a.landedMs - b.landedMs || (a.id < b.id ? -1 : 1));
}

/** Stale claims (ompkit-kdbz.1 DRAIN1): in_progress with no worker older than 24 h,
 * or no new evidence in 48 h. Fail-closed: only what the tracker shows. */
export function staleClaims(
	issues: readonly DrainIssue[],
	comments: readonly DrainComment[],
	nowMs: number,
): StaleClaimRow[] {
	const byId = commentsByIssue(comments);
	const rows: StaleClaimRow[] = [];
	for (const issue of issues) {
		if (issue.status !== "in_progress") continue;
		const latest = (byId.get(issue.id) ?? []).reduce((max, comment) => Math.max(max, comment.createdMs), issue.updatedMs);
		const stamp = new Date(nowMs).toISOString().slice(0, 10);
		const reclaim = `br comments add ${issue.id} "reclaimed ${stamp}: no live holder" && br update ${issue.id} --status open --assignee ""`;
		if (issue.assignee === null && nowMs - issue.updatedMs > STALE_UNASSIGNED_MS) {
			rows.push({ id: issue.id, title: issue.title, reason: "unassigned-24h", lastActivityMs: latest, reclaim });
		} else if (nowMs - latest > STALE_EVIDENCE_MS) {
			rows.push({ id: issue.id, title: issue.title, reason: "evidence-stale-48h", lastActivityMs: latest, reclaim });
		}
	}
	return rows.sort((a, b) => a.lastActivityMs - b.lastActivityMs || (a.id < b.id ? -1 : 1));
}

export type DrainStore = { readonly issues: DrainIssue[]; readonly comments: DrainComment[] };
/** Resolve a project dir to its tracker DB. Throws naming the missing path. */
export function resolveProjectDb(projectDir: string): string {
	const db = join(projectDir, ".beads", "beads.db");
	if (!existsSync(db)) throw new Error(`no tracker database at ${db}`);
	return db;
}

/** Read-only tracker snapshot for the drain views. Throws on unreadable input. */
export function readDrainStore(dbPath: string): DrainStore {
	const db = new Database(dbPath, { readonly: true });
	try {
		const issues = db.query("SELECT id, title, status, assignee, updated_at FROM issues").all() as Array<{
			id: unknown; title: unknown; status: unknown; assignee: unknown; updated_at: unknown;
		}>;
		const comments = db.query("SELECT issue_id, author, text, created_at FROM comments").all() as Array<{
			issue_id: unknown; author: unknown; text: unknown; created_at: unknown;
		}>;
		return {
			issues: issues
				.filter(row => typeof row.id === "string" && typeof row.status === "string")
				.map(row => ({
					id: row.id as string,
					title: typeof row.title === "string" ? row.title : "",
					status: row.status as string,
					assignee: typeof row.assignee === "string" && row.assignee ? row.assignee : null,
					updatedMs: ms(row.updated_at as string | number),
				}))
				.filter(row => Number.isFinite(row.updatedMs)),
			comments: comments
				.filter(row => typeof row.issue_id === "string" && typeof row.text === "string")
				.map(row => ({
					issueId: row.issue_id as string,
					author: typeof row.author === "string" ? row.author : "",
					text: row.text as string,
					createdMs: ms(row.created_at as string | number),
				}))
				.filter(row => Number.isFinite(row.createdMs)),
		};
	} finally {
		db.close();
	}
}

/** Landing commits naming bead ids: one git log pass, bead ids matched in code. */
export function landingCommits(repoDir: string, ids: ReadonlySet<string>): Map<string, Landing> {
	const child = spawnSync("git", ["-C", repoDir, "log", "--format=%H%x00%ct%x00%s%x00%b%x1e", "HEAD"], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
	if (child.status !== 0 || child.error) throw new Error(`git log failed in ${repoDir}`);
	const found = new Map<string, Landing>();
	const records = child.stdout.split("\x1e").map(record => record.trim()).filter(record => record.length > 0);
	for (const record of records) {
		const [sha = "", created = "", subject = "", body = ""] = record.split("\0");
		if (!/^[0-9a-f]{40}$/.test(sha)) continue;
		const committedMs = Number(created) * 1000;
		if (!Number.isFinite(committedMs)) continue;
		const trailer = /Bead:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i.exec(body)?.[1];
		const names = new Set<string>();
		if (trailer) names.add(trailer);
		for (const match of subject.matchAll(BEAD_ID)) {
			const token = match[1]!;
			if (ids.has(token)) names.add(token);
		}
		for (const id of names) {
			if (!ids.has(id)) continue;
			const prior = found.get(id);
			if (!prior || committedMs < prior.committedMs) found.set(id, { sha, committedMs });
		}
	}
	return found;
}
