// Round-0 pass-bar checks. Each check recomputes from the parsed tracker, repo docs and seat view;
// none reads a director's report. A check is PASS only when every input it needs was observed: a
// missing source makes it UNKNOWN, never PASS.
import { createHash } from "node:crypto";
import { parseBlocks } from "./markdown.ts";
import { type Bead, HELD_STATUSES, holderStatus, lastTouch, parentOf, type SeatView, type Tracker } from "./model.ts";
import { DONE_CALLBACK, firstLine, LABEL_LINE, matchLine, NO_EPIC } from "./patterns.ts";

export type Status = "PASS" | "FAIL" | "UNKNOWN";
export type Finding = { kind: string; status: "FAIL" | "UNKNOWN"; id?: string; detail: string };
export type CheckResult = { name: string; status: Status; summary: string; findings: Finding[]; data?: Record<string, unknown> };
export type Snapshot = { schema: "fleet-round.snapshot/v1"; project: string; round_start: string; beads: { id: string; status: string; assignee: string | null }[] };
export type CheckOptions = { now: number; staleHours: number; frontierTop: number; approver: string | null; focus: string[] | null; snapshot: Snapshot | null };

const OPEN_LIKE = ["open", "in_progress", "blocked", "in_review", "rework"];
const TERMINAL = ["closed", "tombstone"];
const HOUR = 3_600_000;

function verdict(name: string, findings: Finding[], summary: string, data?: Record<string, unknown>): CheckResult {
	const status: Status = findings.some(f => f.status === "FAIL") ? "FAIL" : findings.some(f => f.status === "UNKNOWN") ? "UNKNOWN" : "PASS";
	return { name, status, summary, findings, data };
}

// ---- mission -------------------------------------------------------------------------------

/** Tracked live docs that may hold the mission: repo-root *.md and docs/**.md. `.flywheel/` and other paths are never live docs. */
export function missionCandidates(lsFiles: string): string[] {
	return lsFiles.split("\n").filter(path => path.endsWith(".md") && (!path.includes("/") || path.startsWith("docs/")) && !path.split("/").some(segment => segment.startsWith(".flywheel")));
}

/** A mission heading: "Mission", "Mission statement", or "Mission" followed by " (" or ":" (e.g. "Mission (approved ...)"). */
function isMissionHeading(text: string): boolean {
	const title = text.trim().toLowerCase();
	return title === "mission" || title === "mission statement" || title.startsWith("mission (") || title.startsWith("mission:") || title.startsWith("mission statement (") || title.startsWith("mission statement:");
}

export type Mission = { path: string; line: number | null; heading: string; statement: string; state: string | null; approved_by: string | null };

export function findMissions(docs: Record<string, string>): Mission[] {
	const found: Mission[] = [];
	for (const path of Object.keys(docs).sort()) {
		const blocks = parseBlocks(docs[path]!);
		for (let i = 0; i < blocks.length; i++) {
			const heading = blocks[i]!;
			if (heading.kind !== "heading" || heading.nested) continue;
			if (!isMissionHeading(heading.text)) continue;
			const mission: Mission = { path, line: heading.line, heading: heading.text.trim(), statement: "", state: null, approved_by: null };
			for (let j = i + 1; j < blocks.length; j++) {
				const block = blocks[j]!;
				if (block.kind === "heading" && !block.nested && block.level <= heading.level) break;
				if (block.kind !== "paragraph" || block.nested) continue;
				const labeled = block.lines.map(entry => matchLine(LABEL_LINE, entry.text));
				if (mission.statement === "" && labeled.every(match => match === null)) mission.statement = block.lines.map(entry => entry.text).join(" ").trim();
				for (const match of labeled) {
					if (match?.[1] === "STATE" && match[2] === undefined) mission.state = match[3]!.trim();
					if (match?.[1] === "APPROVED_BY" && match[2] === undefined) mission.approved_by = match[3]!.trim();
				}
			}
			found.push(mission);
		}
	}
	return found;
}

export function checkMission(docs: Record<string, string>, approver: string | null): CheckResult {
	const missions = findMissions(docs);
	const cite = (m: Mission): string => `${m.path}:${m.line ?? "?"}`;
	const findings: Finding[] = [];
	if (missions.length === 0) findings.push({ kind: "mission-missing", status: "FAIL", detail: `no "Mission" heading in any tracked AGENTS.md, README.md or docs/**.md (${Object.keys(docs).length} docs read)` });
	if (missions.length > 1) findings.push({ kind: "mission-duplicate", status: "FAIL", detail: `${missions.length} mission statements: ${missions.map(cite).join(", ")}; exactly one may be current` });
	if (missions.length === 1) {
		const m = missions[0]!;
		if (m.line === null) findings.push({ kind: "mission-unlocated", status: "UNKNOWN", detail: `${m.path}: mission heading could not be located on a source line` });
		if (m.statement === "") findings.push({ kind: "mission-empty", status: "FAIL", detail: `${cite(m)}: mission heading has no statement paragraph` });
		if (m.state !== "PROPOSED" && m.state !== "APPROVED") findings.push({ kind: "mission-state", status: "FAIL", detail: `${cite(m)} (heading "${m.heading}"): STATE line is ${m.state === null ? "missing" : JSON.stringify(m.state)}; expected a "STATE: PROPOSED" line (or "STATE: APPROVED" plus "APPROVED_BY: <approver> <date>")` });
		if (m.state === "APPROVED") {
			if (!m.approved_by) findings.push({ kind: "mission-approval", status: "FAIL", detail: `${cite(m)}: STATE APPROVED without an APPROVED_BY line` });
			else if (approver && !m.approved_by.startsWith(approver)) findings.push({ kind: "mission-approval", status: "FAIL", detail: `${cite(m)}: APPROVED_BY ${JSON.stringify(m.approved_by)} does not name the configured approver ${approver}` });
		}
	}
	const one = missions.length === 1 ? missions[0]! : null;
	return verdict("mission", findings, one ? `${cite(one)} STATE ${one.state ?? "missing"}` : `${missions.length} mission statements`, {
		missions: missions.map(m => ({ citation: cite(m), heading: m.heading, state: m.state, approved_by: m.approved_by, statement: m.statement })),
	});
}

// ---- pile ----------------------------------------------------------------------------------

function doneCallback(bead: Bead, since: number): boolean {
	return bead.comments.some(c => {
		if (Date.parse(c.created_at) < since) return false;
		const match = matchLine(DONE_CALLBACK, firstLine(c.text));
		return match !== null && match[1] === bead.id;
	});
}

export function checkPile(tracker: Tracker, seats: SeatView, options: CheckOptions): CheckResult {
	const findings: Finding[] = [];
	const staleMs = options.staleHours * HOUR;
	const held = [...tracker.beads.values()].filter(b => HELD_STATUSES.includes(b.status));
	const holders: Record<string, { status: string; seat: string | null; reason: string; age_hours: number }> = {};
	for (const bead of held) {
		const age = options.now - lastTouch(bead);
		const holder = holderStatus(bead.assignee, seats);
		holders[bead.id] = { ...holder, age_hours: Math.round((age / HOUR) * 10) / 10 };
		if (age <= staleMs || holder.status === "LIVE") continue;
		const detail = `${bead.status} ${(age / HOUR).toFixed(1)}h since last touch, assignee ${bead.assignee ?? "(none)"}: ${holder.reason}`;
		findings.push(holder.status === "DEAD" ? { kind: "stale-no-holder", status: "FAIL", id: bead.id, detail } : { kind: "stale-holder-unknown", status: "UNKNOWN", id: bead.id, detail });
	}
	const outcomes: Record<string, string[]> = { closed: [], reclaimed: [], blocked: [], active: [], "review-queue": [], unsorted: [], unknown: [] };
	if (options.snapshot === null) {
		findings.push({ kind: "snapshot-missing", status: "UNKNOWN", detail: "no round-start snapshot: the sort-outcome partition cannot be evaluated" });
	} else {
		const since = Date.parse(options.snapshot.round_start);
		for (const entry of options.snapshot.beads) {
			const bead = tracker.beads.get(entry.id);
			if (!bead) {
				findings.push({ kind: "snapshot-bead-missing", status: "FAIL", id: entry.id, detail: "in the round-start snapshot but absent from the tracker" });
				continue;
			}
			const evidence = bead.comments.filter(c => Date.parse(c.created_at) >= since);
			let outcome: string;
			if (bead.status === "closed") outcome = "closed";
			else if (bead.status === "in_review" || doneCallback(bead, since)) outcome = "review-queue";
			else if (bead.status === "blocked") {
				outcome = "blocked";
				if (!(bead.assignee || bead.owner) || evidence.length === 0)
					findings.push({ kind: "blocked-without-owner-route", status: "FAIL", id: bead.id, detail: `blocked with ${bead.assignee || bead.owner ? "an owner" : "no owner"} and ${evidence.length} comment(s) since round start; needs owner and a route comment` });
			} else if ((bead.status === "open" || bead.status === "rework") && !bead.assignee) outcome = "reclaimed";
			else if (HELD_STATUSES.includes(bead.status)) {
				const holder = holderStatus(bead.assignee, seats);
				const fresh = options.now - lastTouch(bead) <= staleMs;
				outcome = holder.status === "LIVE" && fresh ? "active" : holder.status === "UNKNOWN" ? "unknown" : "unsorted";
				if (outcome === "unknown") findings.push({ kind: "outcome-unknown", status: "UNKNOWN", id: bead.id, detail: `still ${bead.status}; holder liveness unknown: ${holder.reason}` });
				if (outcome === "unsorted") findings.push({ kind: "unsorted", status: "FAIL", id: bead.id, detail: `still ${bead.status} (assignee ${bead.assignee ?? "(none)"}): ${holder.status === "LIVE" ? `live at ${holder.seat} but untouched for ${options.staleHours}h` : holder.reason}` });
			} else {
				outcome = "unsorted";
				findings.push({ kind: "unsorted", status: "FAIL", id: bead.id, detail: `status ${bead.status} with assignee ${bead.assignee ?? "(none)"} is not a sort outcome` });
			}
			outcomes[outcome]!.push(bead.id);
			// blocked already reports a missing route comment as blocked-without-owner-route.
			if (outcome !== "unsorted" && outcome !== "unknown" && outcome !== "blocked" && evidence.length === 0)
				findings.push({ kind: "outcome-without-evidence", status: "FAIL", id: bead.id, detail: `${outcome} but no comment since round start ${options.snapshot.round_start}` });
		}
	}
	const failing = findings.filter(f => f.kind === "stale-no-holder").length;
	return verdict("pile", findings, `${held.length} held beads, ${failing} stale without a live holder; snapshot ${options.snapshot ? `${options.snapshot.beads.length} beads` : "absent"}`, {
		held: held.length,
		stale_no_holder: failing,
		holders,
		outcomes,
	});
}

// ---- dag -----------------------------------------------------------------------------------

/** Strongly connected components (iterative Tarjan) over blocks + parent edges among non-terminal beads. */
export function cycles(tracker: Tracker): string[][] {
	const live = [...tracker.beads.values()].filter(b => !TERMINAL.includes(b.status));
	const alive = new Set(live.map(b => b.id));
	const edges = new Map<string, string[]>();
	for (const bead of live) {
		const out = new Set<string>();
		for (const dep of bead.deps) if ((dep.type === "blocks" || dep.type === "parent-child") && alive.has(dep.id)) out.add(dep.id);
		if (bead.parent && alive.has(bead.parent)) out.add(bead.parent);
		edges.set(bead.id, [...out].sort());
	}
	let counter = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const found: string[][] = [];
	for (const start of [...alive].sort()) {
		if (index.has(start)) continue;
		const work: { node: string; next: number }[] = [{ node: start, next: 0 }];
		index.set(start, counter);
		low.set(start, counter++);
		stack.push(start);
		onStack.add(start);
		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const targets = edges.get(frame.node)!;
			if (frame.next < targets.length) {
				const target = targets[frame.next++]!;
				if (!index.has(target)) {
					index.set(target, counter);
					low.set(target, counter++);
					stack.push(target);
					onStack.add(target);
					work.push({ node: target, next: 0 });
				} else if (onStack.has(target)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
				continue;
			}
			work.pop();
			if (work.length > 0) {
				const parent = work[work.length - 1]!.node;
				low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
			}
			if (low.get(frame.node) === index.get(frame.node)) {
				const component: string[] = [];
				let member: string;
				do {
					member = stack.pop()!;
					onStack.delete(member);
					component.push(member);
				} while (member !== frame.node);
				if (component.length > 1 || edges.get(frame.node)!.includes(frame.node)) found.push(component.sort());
			}
		}
	}
	return found;
}

export function checkDag(tracker: Tracker): CheckResult {
	const findings: Finding[] = [];
	const orphans: string[] = [];
	for (const bead of tracker.beads.values()) {
		if (!OPEN_LIKE.includes(bead.status) || bead.issue_type === "epic") continue;
		const parent = parentOf(bead, tracker.beads);
		if (parent && tracker.beads.has(parent.id)) continue;
		const reason = bead.comments.map(c => matchLine(NO_EPIC, firstLine(c.text))).find(match => match !== null);
		if (reason) continue;
		orphans.push(bead.id);
		findings.push({ kind: "orphan", status: "FAIL", id: bead.id, detail: `${bead.status} ${bead.issue_type} with ${parent ? `parent ${parent.id} (via ${parent.via}) absent from the tracker` : "no parent epic"} and no "no-epic: <reason>" comment` });
	}
	const found = cycles(tracker);
	for (const component of found) findings.push({ kind: "cycle", status: "FAIL", id: component[0], detail: `dependency cycle: ${component.join(" -> ")}` });
	const blockedOnClosed: string[] = [];
	for (const bead of tracker.beads.values()) {
		if (bead.status !== "blocked") continue;
		for (const dep of bead.deps) {
			if (dep.type !== "blocks" || dep.status !== "closed") continue;
			blockedOnClosed.push(`${bead.id}->${dep.id}`);
			findings.push({ kind: "blocked-on-closed", status: "FAIL", id: bead.id, detail: `status blocked on ${dep.id}, which is closed` });
		}
	}
	return verdict("dag", findings, `${orphans.length} orphans, ${found.length} cycles, ${blockedOnClosed.length} blocked-on-closed edges`, { orphans, cycles: found, blocked_on_closed: blockedOnClosed });
}

// ---- frontier and focus --------------------------------------------------------------------

function underAny(id: string, roots: string[], tracker: Tracker): boolean {
	const seen = new Set<string>();
	let current: string | null = id;
	while (current !== null && !seen.has(current)) {
		if (roots.includes(current)) return true;
		seen.add(current);
		const bead = tracker.beads.get(current);
		current = bead ? (parentOf(bead, tracker.beads)?.id ?? null) : null;
	}
	return false;
}

export function checkFrontier(tracker: Tracker, options: CheckOptions): CheckResult {
	const findings: Finding[] = [];
	const openUnblocked: string[] = [];
	for (const bead of tracker.beads.values()) {
		if (bead.status !== "open" || bead.issue_type === "epic") continue;
		if (bead.deps.some(dep => dep.type === "blocks" && !TERMINAL.includes(dep.status))) continue;
		openUnblocked.push(bead.id);
	}
	openUnblocked.sort();
	if (tracker.ready.length === 0 && openUnblocked.length > 0)
		findings.push({ kind: "frontier-empty", status: "FAIL", detail: `br ready is empty despite open unblocked tasks: ${openUnblocked.join(", ")}` });
	const top = tracker.ready.slice(0, options.frontierTop);
	if (options.focus === null) findings.push({ kind: "focus-undeclared", status: "UNKNOWN", detail: "no focus epics declared; frontier membership cannot be judged" });
	else
		for (const id of top)
			if (!underAny(id, options.focus, tracker)) findings.push({ kind: "frontier-outside-focus", status: "FAIL", id, detail: `ready item ${id} is not under any focus epic (${options.focus.join(", ")})` });
	return verdict("frontier", findings, `${tracker.ready.length} ready; ${openUnblocked.length} open unblocked; top ${top.length}: ${top.join(", ") || "(none)"}`, { ready: tracker.ready.length, open_unblocked: openUnblocked.length, top });
}

export function checkFocus(tracker: Tracker, options: CheckOptions): CheckResult {
	const findings: Finding[] = [];
	const focus = options.focus;
	if (focus === null) return verdict("focus", [{ kind: "focus-undeclared", status: "UNKNOWN", detail: "no focus epics declared" }], "no focus declared");
	if (focus.length !== 3 || new Set(focus).size !== 3) findings.push({ kind: "focus-count", status: "FAIL", detail: `expected 3 distinct epics, got ${focus.length}: ${focus.join(", ")}` });
	const hasChildren = new Set<string>();
	for (const bead of tracker.beads.values()) {
		const parent = parentOf(bead, tracker.beads);
		if (parent) hasChildren.add(parent.id);
	}
	for (const id of focus) {
		const bead = tracker.beads.get(id);
		if (!bead) findings.push({ kind: "focus-missing", status: "FAIL", id, detail: `${id} does not exist in the tracker` });
		else if (TERMINAL.includes(bead.status) || bead.status === "deferred") findings.push({ kind: "focus-not-open", status: "FAIL", id, detail: `${id} is ${bead.status}` });
		else if (bead.issue_type !== "epic" && !hasChildren.has(id)) findings.push({ kind: "focus-not-epic", status: "FAIL", id, detail: `${id} is a ${bead.issue_type} with no children` });
	}
	return verdict("focus", findings, `focus ${focus.join(", ")}`);
}

// ---- metrics and spot check ----------------------------------------------------------------

/** Values a CLAIM may assert; the validator recomputes each. */
export function metrics(tracker: Tracker, results: CheckResult[], missions: number): Record<string, number> {
	const out: Record<string, number> = { total: tracker.beads.size, ready: tracker.ready.length, missions };
	const observed = new Set([...tracker.statuses, ...[...tracker.beads.values()].map(b => b.status)]);
	for (const status of observed) out[status] = 0;
	for (const bead of tracker.beads.values()) out[bead.status]! += 1;
	const dag = results.find(r => r.name === "dag")?.data;
	if (dag) {
		out.orphans = (dag.orphans as unknown[]).length;
		out.cycles = (dag.cycles as unknown[]).length;
		out.blocked_on_closed = (dag.blocked_on_closed as unknown[]).length;
	}
	const pile = results.find(r => r.name === "pile")?.data;
	if (pile) out.stale_no_holder = pile.stale_no_holder as number;
	return out;
}

/** Reproducible sample of beads closed in [since, now]: order by sha256(seed:id), take ceil(rate*n). */
export function spotCheck(tracker: Tracker, since: number, now: number, seed: string, rate: number): { population: string[]; sample: string[] } {
	const population = [...tracker.beads.values()]
		.filter(b => b.status === "closed" && b.closed_at !== null && Date.parse(b.closed_at) >= since && Date.parse(b.closed_at) <= now)
		.map(b => b.id)
		.sort();
	const keyed = population.map(id => ({ id, key: createHash("sha256").update(`${seed}:${id}`).digest("hex") }));
	keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return { population, sample: keyed.slice(0, Math.ceil(population.length * rate)).map(k => k.id) };
}

export function overall(results: CheckResult[]): Status {
	if (results.some(r => r.status === "FAIL")) return "FAIL";
	if (results.some(r => r.status === "UNKNOWN")) return "UNKNOWN";
	return "PASS";
}
