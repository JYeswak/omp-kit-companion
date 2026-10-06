/**
 * flywheel-score.ts — FLY2 (ompkit-8m75): seven fleet-practice grades from git and the tracker.
 *
 * Each metric carries its definition, value, threshold and letter grade so the
 * coordinator grades practices with numbers, not opinion. Thresholds are the
 * kit default (A>=90 B>=75 C>=60 D>=40 F<40, direction-aware); the bead owns them.
 * Data: `git log` subjects on main plus `br list/audit/comments/search --json`
 * against the tracker's beads.db. Proxies are named as proxies in `detail`.
 */
export type Grade = "A" | "B" | "C" | "D" | "F";

export interface FlywheelMetric {
	metric: string;
	value: number;
	display: string;
	threshold: string;
	grade: Grade;
	detail: string;
}

export interface FlywheelInput {
	repo: string;
	beadsDb: string;
	windowCommits?: number;
	windowDays?: number;
	now?: number;
}

export type RunFn = (cmd: string[]) => { code: number | null; stdout: string; stderr?: string };

const BEAD_ID = /\bompkit-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
const DAY_MS = 86_400_000;

export function letterGrade(pct: number): Grade {
	if (pct >= 90) return "A";
	if (pct >= 75) return "B";
	if (pct >= 60) return "C";
	if (pct >= 40) return "D";
	return "F";
}

interface Issue {
	id: string;
	status: string;
	assignee?: string | null;
	created_at?: string;
	updated_at?: string;
	acceptance_items?: { checked?: boolean }[];
}

interface AuditEvent {
	event_type: string;
	actor?: string;
	timestamp?: string;
	old_value?: string;
	new_value?: string;
}

function parseJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

function issuesOf(payload: unknown): Issue[] {
	// Boundary: br list --json prints {issues: Issue[]} (or a bare array in older builds).
	if (Array.isArray(payload)) return payload as Issue[];
	if (typeof payload === "object" && payload !== null && "issues" in payload) {
		const issues: unknown = payload.issues;
		if (Array.isArray(issues)) return issues as Issue[];
	}
	return [];
}

function eventsOf(payload: unknown): AuditEvent[] {
	// Boundary: br audit log --json prints {events: AuditEvent[]}.
	if (typeof payload === "object" && payload !== null && "events" in payload) {
		const events: unknown = payload.events;
		if (Array.isArray(events)) return events as AuditEvent[];
	}
	return [];
}

function openBoxes(issue: Issue): number {
	return (issue.acceptance_items ?? []).filter(item => !item.checked).length;
}

function realIds(text: string, known: Record<string, true>): string[] {
	const found: Record<string, true> = {};
	for (const match of text.match(BEAD_ID) ?? []) if (known[match]) found[match] = true;
	return Object.keys(found);
}

/** M1a: share of in-progress beads with at most 5 open boxes. */
export function metricBeadSize(issues: Issue[]): FlywheelMetric {
	const active = issues.filter(issue => issue.status === "in_progress");
	const small = active.filter(issue => openBoxes(issue) <= 5).length;
	const pct = active.length ? (small / active.length) * 100 : 100;
	return { metric: "bead-size", value: pct, display: `${small}/${active.length} in-progress beads with <=5 open boxes`,
		threshold: "A>=90", grade: letterGrade(pct), detail: active.length ? "" : "no in-progress beads; vacuous A" };
}

/** M1b: share of window commits naming a real bead id. */
export function metricCommitLinkage(subjects: string[], known: Record<string, true>): FlywheelMetric {
	const linked = subjects.filter(subject => realIds(subject, known).length > 0).length;
	const pct = subjects.length ? (linked / subjects.length) * 100 : 100;
	return { metric: "commit-linkage", value: pct, display: `${linked}/${subjects.length} commits name a real bead id`,
		threshold: "A>=90", grade: letterGrade(pct), detail: subjects.length ? "" : "no commits in window; vacuous A" };
}

export interface ClaimTally { self: number; dispatched: number }

/** M2: claims whose actor is the new assignee (bv self-pick) vs another actor (dispatch). */
export function metricSelfPick(tally: ClaimTally): FlywheelMetric {
	const total = tally.self + tally.dispatched;
	const pct = total ? (tally.self / total) * 100 : 100;
	return { metric: "self-pick", value: pct, display: `${tally.self}/${total} claims self-picked via bv`,
		threshold: "A>=90", grade: letterGrade(pct), detail: total ? "" : "no claims in window; vacuous A" };
}
export function tallyClaims(allEvents: AuditEvent[][], since: number): ClaimTally {
	const tally: ClaimTally = { self: 0, dispatched: 0 };
	for (const events of allEvents) for (const event of events) {
		if (event.event_type !== "assignee_changed" || !event.new_value) continue;
		if (!event.timestamp || Date.parse(event.timestamp) < since) continue;
		if (event.actor === event.new_value) tally.self++;
		else tally.dispatched++;
	}
	return tally;
}

/** M3: share of non-merge window commits naming exactly one real bead id (focused landings). */
export function metricLandingHygiene(subjects: { subject: string; merge: boolean }[], known: Record<string, true>): FlywheelMetric {
	const eligible = subjects.filter(entry => !entry.merge);
	const focused = eligible.filter(entry => realIds(entry.subject, known).length === 1).length;
	const pct = eligible.length ? (focused / eligible.length) * 100 : 100;
	return { metric: "landing-hygiene", value: pct, display: `${focused}/${eligible.length} non-merge commits name exactly one bead`,
		threshold: "A>=90", grade: letterGrade(pct), detail: eligible.length ? "" : "no non-merge commits; vacuous A" };
}

/** M3 incidents: shared-index incident hits in the tracker (graded separately: A iff zero). */
export function metricIndexIncidents(hits: number): FlywheelMetric {
	return { metric: "index-incidents", value: hits, display: `${hits} shared-index incidents in window`,
		threshold: "A iff 0", grade: hits === 0 ? "A" : "F", detail: "keyword search over issue text; see detail" };
}

/** M4: closes vs starts per day in window, plus max age in review. Grade is the weaker half. */
export function metricCloseFlow(closes: number, starts: number, maxInReviewH: number | null): FlywheelMetric {
	const ratio = starts > 0 ? closes / starts : closes > 0 ? 2 : 1;
	const ratioGrade = ratio >= 1 ? "A" : ratio >= 0.75 ? "B" : ratio >= 0.5 ? "C" : ratio >= 0.25 ? "D" : "F";
	const ageGrade = maxInReviewH === null ? "A" : maxInReviewH <= 24 ? "A" : maxInReviewH <= 72 ? "C" : "F";
	const order: Grade[] = ["A", "B", "C", "D", "F"];
	const grade = order[Math.max(order.indexOf(ratioGrade as Grade), order.indexOf(ageGrade as Grade))];
	return { metric: "close-flow", value: ratio, display: `${closes} closes vs ${starts} starts/day-window; max in_review ${maxInReviewH === null ? "n/a" : maxInReviewH.toFixed(1) + "h"}`,
		threshold: "A iff closes>=starts and max in_review<=24h", grade, detail: `ratio grade ${ratioGrade}, age grade ${ageGrade}` };
}

/**
 * M5: freshness proxy for worker idleness. True worker-minutes-idle needs fleet
 * telemetry the tracker does not record; this counts in-progress beads idle
 * past 24h while other beads sit ready, which is the hoarding shape of the
 * same failure. Documented proxy, not the thing itself.
 */
export function metricFreshness(stale: number, active: number): FlywheelMetric {
	const pct = active ? ((active - stale) / active) * 100 : 100;
	return { metric: "freshness", value: pct, display: `${active - stale}/${active} in-progress beads touched in 24h`,
		threshold: "A>=90", grade: letterGrade(pct), detail: "proxy: updated_at freshness while ready is non-empty" };
}

/** M6: share of window closes with a VERDICT comment from the closer near close time. */
export function metricVerdictCloses(withVerdict: number, closes: number): FlywheelMetric {
	const pct = closes ? (withVerdict / closes) * 100 : 100;
	return { metric: "verdict-closes", value: pct, display: `${withVerdict}/${closes} closes carry a closer VERDICT comment`,
		threshold: "A>=90", grade: letterGrade(pct), detail: "proxy: VERDICT token in a closer comment within 24h before close" };
}

/** M7: share of window closes with a lesson line or an explicit none. */
export function metricLessons(withLesson: number, closes: number): FlywheelMetric {
	const pct = closes ? (withLesson / closes) * 100 : 100;
	return { metric: "lessons", value: pct, display: `${withLesson}/${closes} closes cite a lesson or explicit none`,
		threshold: "A>=90", grade: letterGrade(pct), detail: "proxy: /^lesson\\b/i line or /^none\\.?$/i line in a closer comment" };
}

export interface CommentRow { author?: string; body?: string; created_at?: string }

/** Run the full seven-metric (plus incidents) computation against live git + tracker. */
export function scoreFlywheel(input: FlywheelInput, run: RunFn): FlywheelMetric[] {
	const windowCommits = input.windowCommits ?? 50;
	const windowDays = input.windowDays ?? 7;
	const now = input.now ?? Date.now();
	const since = now - windowDays * DAY_MS;
	const br = process.env.BR_BIN ?? "br";
	const db = ["--db", input.beadsDb];

	const issues = issuesOf(parseJson(run([br, ...db, "list", "--status", "all", "--json"]).stdout));
	const known: Record<string, true> = {};
	for (const issue of issues) known[issue.id] = true;

	const logOut = run(["git", "-C", input.repo, "log", "--format=%H%x01%s%x01%P", "-n", String(windowCommits)]).stdout;
	const commits = logOut.split("\n").filter(line => line.length > 0).map(line => {
		const [, subject = "", parents = ""] = line.split("");
		return { subject, merge: parents.trim().split(/\s+/).filter(Boolean).length > 1 };
	});
	const subjects = commits.map(entry => entry.subject);

	const recentIds = issues.filter(issue => issue.updated_at && Date.parse(issue.updated_at) >= since).map(issue => issue.id);
	const allEvents = recentIds.map(id => eventsOf(parseJson(run([br, ...db, "audit", "log", id, "--json"]).stdout)));
	const tally = tallyClaims(allEvents, since);

	const searchHits = parseJson(run([br, ...db, "search", "shared-index OR shared index OR restore --staged", "--json"]).stdout);
	const incidentCount = issuesOf(searchHits).length;

	const closes = issues.filter(issue => issue.status === "closed" && issue.updated_at && Date.parse(issue.updated_at) >= since);
	const starts = issues.filter(issue => issue.created_at && Date.parse(issue.created_at) >= since).length;
	const inReview = issues.filter(issue => issue.status === "in_review" && issue.updated_at);
	const maxInReviewH = inReview.length ? Math.max(...inReview.map(issue => (now - Date.parse(issue.updated_at ?? "")) / 3_600_000)) : null;

	let withVerdict = 0, withLesson = 0;
	for (const issue of closes) {
		const payload = parseJson(run([br, ...db, "comments", issue.id, "--json"]).stdout);
		const rows: CommentRow[] = Array.isArray(payload) ? payload.filter((row): row is CommentRow => typeof row === "object" && row !== null) : [];
		const closeTs = Date.parse(issue.updated_at ?? "");
		const near = rows.filter(row => row.created_at && Date.parse(row.created_at) >= closeTs - DAY_MS);
		if (near.some(row => (row.body ?? "").includes("VERDICT"))) withVerdict++;
		if (near.some(row => (row.body ?? "").split("\n").some(line => /^lesson\b/i.test(line.trim()) || /^none\.?$/i.test(line.trim())))) withLesson++;
	}

	const active = issues.filter(issue => issue.status === "in_progress");
	const ready = issues.filter(issue => issue.status === "open").length;
	const stale = ready > 0 ? active.filter(issue => !issue.updated_at || Date.parse(issue.updated_at) < now - DAY_MS).length : 0;

	return [
		metricBeadSize(issues),
		metricCommitLinkage(subjects, known),
		metricSelfPick(tally),
		metricLandingHygiene(commits, known),
		metricIndexIncidents(incidentCount),
		metricCloseFlow(closes.length, starts, maxInReviewH),
		metricFreshness(stale, active.length),
		metricVerdictCloses(withVerdict, closes.length),
		metricLessons(withLesson, closes.length),
	];
}
