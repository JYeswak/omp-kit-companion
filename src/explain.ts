import { closeSync, constants, existsSync, fstatSync, openSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { gateEventsPath, gateFromReason } from "../extensions/gate-events.ts";
import { briefContract, type BriefContract, type BriefRule } from "./brief.ts";
import { discoverFleetRepos } from "./sha.ts";
import { readJsonl } from "./kitlib/jsonl.ts";
import { readInto } from "./kitlib/positioned-read.ts";
import { captureMineReplay } from "./mine-replay.ts";

const TAIL_BYTES = 1024 * 1024;
const TAIL_ROWS = 10_000;
const SCAN_BYTES = 64 * 1024;
const CONTRACT_REPOS = 4;
const MAX_REPORT_GROUPS = 100;
const ATTEMPT_FALLBACK_MS = 5_000;
const SEAT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EVENT_KINDS: Record<string, true> = { pass: true, refuse: true, inject: true, auto_complete: true, notice: true };

type SourceStatus = "READ" | "PARTIAL" | "MISSING" | "UNAVAILABLE";
type ExplainEvent = {
	ts: string;
	seat: string | null;
	act: string;
	gate: string;
	kind: string;
	repo: string | null;
	member: string | null;
	attempt: string | null;
	event_id: string | null;
	detail: string | null;
};
type TailRead = {
	status: SourceStatus;
	events: ExplainEvent[];
	rows_read: number;
	invalid_rows: number;
	tail_window_bytes: number;
	truncated_before: boolean;
	incomplete_after: boolean;
};
type Attempt = {
	id: string | null;
	act: string;
	start_ms: number;
	end_ms: number;
	rows: ExplainEvent[];
	refused: boolean;
};

interface ExplainReport {
	scope: "explain";
	overall: "PARTIAL" | "UNVERIFIED";
	seat: string;
	last: number;
	refusal_groups_omitted: number;
	rule_fire_groups_omitted: number;
	window: { attempts: number; start_at: string | null; end_at: string | null; complete: boolean };
	refusals: Array<{
		cause: string;
		gate: string;
		member: string | null;
		refusal: string;
		compliant: string | null;
		remedy_status: "MATCHED" | "UNAVAILABLE";
		count: number;
		latest_at: string;
	}>;
	rule_fires: Array<{ member: string | null; count: number; latest_at: string }>;
	commit_first_try: { status: "READ" | "PARTIAL" | "UNVERIFIED"; attempts: number; passed: number; refused: number; rate_pct: number | null };
	sources: {
		gate_events: { status: SourceStatus; rows_read: number; invalid_rows: number; tail_window_bytes: number; truncated_before: boolean; incomplete_after: boolean };
		gate_contracts: { status: "READ" | "PARTIAL" | "UNAVAILABLE"; repos_read: number; reason: string | null };
		dcg: { status: "UNATTRIBUTED"; records: null; reason: string };
		rule_fires: { status: "PARTIAL" | "UNAVAILABLE"; records: null; reason: string };
	};
	text: string;
}


function timestampMs(value: unknown): number | null {
	if (typeof value !== "string" || value.length > 30 || !value.endsWith("Z") || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value)) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function eventRow(value: unknown): ExplainEvent | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (timestampMs(raw.ts) === null
		|| (raw.seat !== null && (typeof raw.seat !== "string" || raw.seat.length > 64))
		|| typeof raw.act !== "string" || raw.act.length > 128
		|| typeof raw.gate !== "string" || raw.gate.length > 128
		|| typeof raw.kind !== "string" || raw.kind.length > 64 || !Object.hasOwn(EVENT_KINDS, raw.kind)
		|| (typeof raw.repo === "string" && raw.repo.length > 4096)
		|| (typeof raw.member === "string" && raw.member.length > 512)
		|| (typeof raw.attempt === "string" && raw.attempt.length > 256)
		|| (typeof raw.event_id === "string" && raw.event_id.length > 256)) return null;
	return {
		ts: raw.ts as string,
		seat: raw.seat as string | null,
		act: raw.act,
		gate: raw.gate,
		kind: raw.kind,
		repo: typeof raw.repo === "string" ? raw.repo : null,
		member: typeof raw.member === "string" ? raw.member : null,
		attempt: typeof raw.attempt === "string" && raw.attempt !== "" ? raw.attempt : null,
		event_id: typeof raw.event_id === "string" && raw.event_id !== "" ? raw.event_id : null,
		detail: typeof raw.detail === "string" ? raw.detail : null,
	};
}

function readAt(fd: number, buffer: Buffer, position: number, length: number): number {
	const read = readInto(fd, buffer, 0, length, position);
	if (read !== length) throw new Error("short gate-event read");
	return read;
}


/** Find a line-aligned suffix without reading the ledger prefix; at most TAIL_ROWS complete rows are parsed. */
function tailOffset(fd: number, size: number): { offset: number; truncated: boolean } {
	const windowStart = Math.max(0, size - TAIL_BYTES);
	const scanEnd = Math.min(size, windowStart + TAIL_BYTES);
	const scratch = Buffer.alloc(SCAN_BYTES);
	let position = size;
	let newlines = 0;
	while (position > windowStart) {
		const start = Math.max(windowStart, position - scratch.length);
		const got = readAt(fd, scratch, start, position - start);
		for (let index = got - 1; index >= 0; index--) {
			if (scratch[index] !== 0x0a) continue;
			newlines++;
			if (newlines > TAIL_ROWS) return { offset: start + index + 1, truncated: true };
		}
		if (got === 0) break;
		position = start;
	}
	if (windowStart === 0) return { offset: 0, truncated: false };
	const previous = Buffer.alloc(1);
	if (readAt(fd, previous, windowStart - 1, 1) === 1 && previous[0] === 0x0a)
		return { offset: windowStart, truncated: true };
	let cursor = windowStart;
	while (cursor < scanEnd) {
		const length = Math.min(scratch.length, scanEnd - cursor);
		const got = readAt(fd, scratch, cursor, length);
		const newline = scratch.subarray(0, got).indexOf(0x0a);
		if (newline >= 0) return { offset: cursor + newline + 1, truncated: true };
		cursor += got;
	}
	return { offset: size, truncated: true };
}

function readTail(path: string): TailRead {
	const empty = (status: SourceStatus): TailRead => ({ status, events: [], rows_read: 0, invalid_rows: 0, tail_window_bytes: 0, truncated_before: false, incomplete_after: false });
	if (!isAbsolute(path) || resolve(path) !== path) return empty("UNAVAILABLE");
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) {
		const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
		return empty(code === "ENOENT" ? "MISSING" : "UNAVAILABLE");
	}
	let info: Stats;
	let offset: number;
	let truncated: boolean;
	try {
		info = fstatSync(fd);
		if (!info.isFile()) return empty("UNAVAILABLE");
		({ offset, truncated } = tailOffset(fd, info.size));
	} catch { return empty("UNAVAILABLE"); }
	finally { try { closeSync(fd); } catch { /* readJsonl reopens and verifies the inode */ } }
	const length = Math.max(1, Math.min(TAIL_BYTES, info.size - offset));
	try {
		const parsed = readJsonl(path, { maxBytes: length, fromCursor: { dev: info.dev, ino: info.ino, offset, line: 0 } });
		if (parsed.missing) return empty("MISSING");
		if (parsed.reset !== null) return { ...empty("PARTIAL"), truncated_before: true, incomplete_after: true };
		const events: ExplainEvent[] = [];
		let invalidRows = parsed.errors.length;
		for (const row of parsed.rows) {
			const event = eventRow(row);
			if (event) events.push(event);
			else invalidRows++;
		}
		const incompleteAfter = parsed.more || parsed.pending_tail_bytes > 0;
		const partial = truncated || incompleteAfter || invalidRows > 0;
		return {
			status: partial ? "PARTIAL" : "READ", events,
			rows_read: parsed.rows.length + parsed.errors.length, invalid_rows: invalidRows,
			tail_window_bytes: Math.max(0, info.size - offset), truncated_before: truncated || parsed.more,
			incomplete_after: incompleteAfter,
		};
	} catch { return { ...empty("UNAVAILABLE"), truncated_before: truncated, incomplete_after: true }; }
}

function readGateHistory(): TailRead {
	const currentPath = gateEventsPath(process.env, process.env.HOME?.trim() || homedir());
	const rotated = readTail(`${currentPath}.1`);
	const current = readTail(currentPath);
	const events = [...rotated.events, ...current.events];
	const seen = new Set<string>();
	const unique = events.filter(event => {
		if (!event.event_id) return true;
		if (seen.has(event.event_id)) return false;
		seen.add(event.event_id);
		return true;
	}).sort((a, b) => (timestampMs(a.ts) ?? 0) - (timestampMs(b.ts) ?? 0));
	let status: SourceStatus;
	if (current.status === "READ") status = rotated.status === "PARTIAL" || rotated.status === "UNAVAILABLE" ? "PARTIAL" : "READ";
	else if (current.status === "PARTIAL") status = "PARTIAL";
	else if (current.status === "MISSING") status = rotated.status === "READ" || rotated.status === "PARTIAL" ? "PARTIAL" : "MISSING";
	else status = "UNAVAILABLE";
	return {
		status, events: unique, rows_read: rotated.rows_read + current.rows_read,
		invalid_rows: rotated.invalid_rows + current.invalid_rows,
		tail_window_bytes: rotated.tail_window_bytes + current.tail_window_bytes,
		truncated_before: rotated.truncated_before || current.truncated_before || current.status === "MISSING",
		incomplete_after: rotated.incomplete_after || current.incomplete_after || current.status === "MISSING" || current.status === "UNAVAILABLE",
	};
}

/** Explicit IDs span interleaved ledger rows; only missing IDs use the 5 s fallback window. */
function attemptsForSeat(events: ExplainEvent[], seat: string): Attempt[] {
	const rows = events.filter(event => event.seat === seat && (event.kind === "pass" || event.kind === "refuse"))
		.sort((a, b) => (timestampMs(a.ts) ?? 0) - (timestampMs(b.ts) ?? 0));
	const attempts: Attempt[] = [];
	const identified = new Map<string, Attempt>();
	let previousAttempt: Attempt | null = null;
	for (const event of rows) {
		const at = timestampMs(event.ts);
		if (at === null) continue;
		const idKey = event.attempt === null ? null : `${event.act.length}:${event.act}${event.attempt.length}:${event.attempt}`;
		let attempt = idKey === null ? undefined : identified.get(idKey);
		if (attempt) {
			attempt.start_ms = Math.min(attempt.start_ms, at);
			attempt.end_ms = Math.max(attempt.end_ms, at);
			attempt.rows.push(event);
		} else if (event.attempt === null && previousAttempt !== null && previousAttempt.id === null
			&& previousAttempt.act === event.act && at - previousAttempt.end_ms <= ATTEMPT_FALLBACK_MS) {
			attempt = previousAttempt;
			attempt.end_ms = Math.max(attempt.end_ms, at);
			attempt.rows.push(event);
		} else {
			attempt = { id: event.attempt, act: event.act, start_ms: at, end_ms: at, rows: [event], refused: false };
			attempts.push(attempt);
			if (idKey !== null) identified.set(idKey, attempt);
		}
		if (event.kind === "refuse") attempt.refused = true;
		previousAttempt = attempt;
	}
	return attempts.sort((a, b) => a.start_ms - b.start_ms);
}

function safeText(value: unknown, max = 400): string | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const clean = captureMineReplay({ message: value }).message;
	if (!clean) return null;
	let visible = "";
	for (let index = 0; index < clean.length; index++) {
		const code = clean.charCodeAt(index);
		visible += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : clean.charAt(index);
	}
	return visible.replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function safeCause(event: ExplainEvent): string {
	const direct = event.gate.length <= 128 ? safeText(event.gate, 128) : null;
	if (direct && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(direct)) {
		if (direct !== "tool-error:unclassified") return direct;
		const detail = (event.detail ?? "").trim().slice(0, 256);
		let prefix = safeText(detail, 96);
		if (prefix === "[REDACTED]") {
			let end = 0;
			while (end < detail.length && detail[end] !== ":" && detail[end] !== " " && detail[end] !== "\t" && detail[end] !== "\r" && detail[end] !== "\n") end++;
			prefix = safeText(detail.slice(0, end), 64);
		}
		return `${direct}: ${prefix ?? "no message prefix"}`;
	}
	const reason = event.detail?.slice(0, 256) ?? "";
	const extracted = safeText(gateFromReason(reason), 128);
	return extracted && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(extracted) ? extracted : "UNKNOWN";
}

function memberName(value: string | null): string | null {
	if (!value || value.length > 4096) return null;
	const tail = value.split(/[\\/]/).at(-1) ?? value;
	const safe = tail.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
	return safe || null;
}

function validRepo(value: string | null): string | null {
	return value !== null && value.length <= 4096 && isAbsolute(value) && resolve(value) === value ? value : null;
}
function trustedRepoRoots(home: string): Set<string> {
	const roots = new Set<string>();
	for (const repo of discoverFleetRepos(home)) try { roots.add(realpathSync(repo)); } catch { /* unavailable repo is not trusted */ }
	try {
		let current = realpathSync(process.cwd());
		for (;;) {
			if (existsSync(join(current, ".git"))) { roots.add(current); break; }
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	} catch { /* no current repository */ }
	return roots;
}

function matchingRule(contract: BriefContract | null, member: string | null, gate: string): BriefRule | undefined {
	if (!contract) return undefined;
	for (const candidate of [member, gate]) {
		if (!candidate) continue;
		const exact = contract.rules.filter(rule => rule.member === candidate);
		if (exact.length === 1) return exact[0];
	}
	const wanted = memberName(member);
	if (!wanted) return undefined;
	const matches = contract.rules.filter(rule => memberName(rule.member) === wanted);
	return matches.length === 1 ? matches[0] : undefined;
}
// Kit-owned remedies never execute or repeat commands from event detail.
// A classified external error gets a remedy only when its diagnostic gives
// enough structured context for one safe, precise next step.
function kitRemedy(gate: string, detail: string | null): string | null {
	switch (gate) {
		case "scratch-write":
			return "In the owning repository, run `omp-kit scratch new --label refusal-output --json`, then write disposable output under the returned data.dir.";
		case "scratch-is-not-a-home":
			return "Keep durable source, scripts and packets in their owning repository. For an isolated edit, run `ovnfs new` from that repository and edit the returned checkout outside scratch.";
		case "49-omp-kit-stale-worktree":
			return "Run `omp-kit doctor --scope stale-worktree --json` in the affected repository; rework accidental reversions on current bytes. Declare Revert: or Supersedes: trailers only for intended reversions.";
		case "REFUSED":
			// REFUSED is shared by unrelated producers; only this header
			// supports the stale-worktree remedy.
			return detail?.includes("stale-worktree: REFUSED: commit would revert landed lines")
				? kitRemedy("49-omp-kit-stale-worktree", null) : null;
		case "validation:edit-undisplayed-anchor": {
			const diagnostic = safeText(detail, 600);
			const anchor = diagnostic && /^This edit anchors to lines ([0-9]+(?:-[0-9]+)?(?:, ?[0-9]+(?:-[0-9]+)?)*) of ([A-Za-z0-9_./~ -]+) that \[/.exec(diagnostic);
			if (!anchor) return null;
			return `Use the read tool: ${JSON.stringify({ path: `${anchor[2]}:${anchor[1]!.replaceAll(" ", "")}` })}. Rebuild the edit with the returned snapshot tag and only displayed changed lines; folded summaries are not edit anchors.`;
		}
		default:
			return null;
	}
}



function renderText(report: Omit<ExplainReport, "text">): string {
	const lines = [
		`EXPLAIN ${report.seat} — ${report.overall}`,
		`Window: ${report.window.attempts} of the requested ${report.last} seat attempts; complete=${report.window.complete}`,
	];
	const metric = report.commit_first_try;
	lines.push(metric.attempts
		? `Commit first-try: ${metric.passed}/${metric.attempts} passed (${metric.rate_pct}%; ${metric.status})`
		: `Commit first-try: unavailable (${metric.status})`);
	if (report.refusals.length === 0) lines.push("Refusals: none recorded in the observed window.");
	for (const refusal of report.refusals) {
		lines.push(`Refusal ${refusal.cause} (${refusal.count} attempts; latest ${refusal.latest_at})`);
		lines.push(`  gate/member: ${refusal.gate}${refusal.member ? ` / ${refusal.member}` : ""}`);
		lines.push(`  why: ${refusal.refusal}`);
		lines.push(`  compliant form: ${refusal.compliant ?? "unavailable from a trusted current gate contract or uniquely joined rule fix"}`);
	}
	if (report.refusal_groups_omitted) lines.push(`${report.refusal_groups_omitted} refusal groups omitted by the ${MAX_REPORT_GROUPS}-group display cap.`);
	if (report.rule_fires.length) for (const fire of report.rule_fires)
		lines.push(`Rule fire ${fire.member ?? "unknown"}: ${fire.count} recorded; latest ${fire.latest_at}`);
	if (report.rule_fire_groups_omitted) lines.push(`${report.rule_fire_groups_omitted} rule-fire groups omitted by the ${MAX_REPORT_GROUPS}-group display cap.`);
	lines.push(`Sources: gate-events=${report.sources.gate_events.status}, gate-contracts=${report.sources.gate_contracts.status}, dcg=${report.sources.dcg.status}, rule-fires=${report.sources.rule_fires.status}`);
	if (report.sources.gate_contracts.reason) lines.push(`Gate-contract coverage: ${report.sources.gate_contracts.reason}`);
	lines.push(`DCG coverage: ${report.sources.dcg.reason}`);
	lines.push(`Rule-fire coverage: ${report.sources.rule_fires.reason}`);
	return lines.join("\n");
}

export async function buildExplainReport(seat: string, last = 50): Promise<ExplainReport> {
	if (seat.length > 64 || SEAT_PATTERN.exec(seat)?.[0] !== seat) throw new Error("invalid seat name");
	if (!Number.isSafeInteger(last) || last < 1 || last > 500) throw new Error("invalid history limit");
	const history = readGateHistory();
	const trustedRepos = trustedRepoRoots(process.env.HOME?.trim() || homedir());
	const allAttempts = attemptsForSeat(history.events, seat);
	const selected = allAttempts.slice(-last);
	const windowStartMs = selected[0]?.start_ms ?? null;
	let windowEndMs: number | null = null;
	for (const attempt of selected) if (windowEndMs === null || attempt.end_ms > windowEndMs) windowEndMs = attempt.end_ms;
	const complete = history.status === "READ" && !history.truncated_before && !history.incomplete_after && history.invalid_rows === 0;
	const commitAttempts = selected.filter(attempt => attempt.act === "commit");
	const passed = commitAttempts.filter(attempt => !attempt.refused).length;
	const refused = commitAttempts.length - passed;
	const metricStatus: ExplainReport["commit_first_try"]["status"] = commitAttempts.length === 0 ? "UNVERIFIED" : complete ? "READ" : "PARTIAL";
	const groups = new Map<string, { cause: string; gate: string; memberRaw: string | null; repo: string | null; count: number; latest: ExplainEvent }>();
	let untrustedRepoPaths = false;
	for (const attempt of selected) {
		const perAttempt = new Map<string, { event: ExplainEvent; repo: string | null }>();
		for (const event of attempt.rows) {
			if (event.kind !== "refuse") continue;
			const cause = safeCause(event);
			const observedRepo = validRepo(event.repo);
			const repo = observedRepo !== null && trustedRepos.has(observedRepo) ? observedRepo : null;
			if (event.repo !== null && repo === null) untrustedRepoPaths = true;
			const memberKey = event.member ?? "";
			const repoKey = repo ?? "";
			const key = `${cause.length}:${cause}${memberKey.length}:${memberKey}${repoKey.length}:${repoKey}`;
			const prior = perAttempt.get(key);
			if (!prior || (timestampMs(prior.event.ts) ?? 0) < (timestampMs(event.ts) ?? 0)) perAttempt.set(key, { event, repo });
		}
		for (const [key, candidate] of perAttempt) {
			const { event, repo } = candidate;
			let group = groups.get(key);
			if (!group) {
				group = { cause: safeCause(event), gate: event.gate === "tool-error:unclassified" ? event.gate : safeCause(event), memberRaw: event.member, repo, count: 0, latest: event };
				groups.set(key, group);
			}
			group.count++;
			if ((timestampMs(group.latest.ts) ?? 0) < (timestampMs(event.ts) ?? 0)) group.latest = event;
		}
	}
	const orderedGroups = [...groups.values()].sort((a, b) => b.count - a.count || (timestampMs(b.latest.ts) ?? 0) - (timestampMs(a.latest.ts) ?? 0));
	const refusalGroupsOmitted = Math.max(0, orderedGroups.length - MAX_REPORT_GROUPS);
	const displayedGroups = orderedGroups.slice(0, MAX_REPORT_GROUPS);
	const repoWeights = new Map<string, number>();
	for (const group of displayedGroups) if (group.repo) repoWeights.set(group.repo, (repoWeights.get(group.repo) ?? 0) + group.count);
	const repos = [...repoWeights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const contracts = new Map<string, BriefContract | null>();
	await Promise.all(repos.slice(0, CONTRACT_REPOS).map(async ([repo]) => {
		try { contracts.set(repo, await briefContract(repo)); } catch { contracts.set(repo, null); }
	}));
	const refusalRows = displayedGroups.map(group => {
		const rule = matchingRule(group.repo ? contracts.get(group.repo) ?? null : null, group.memberRaw, group.gate);
		const compliant = safeText(rule?.compliant, 600) ?? kitRemedy(group.gate, group.latest.detail);
		return {
			cause: group.cause, gate: group.gate, member: memberName(group.memberRaw),
			refusal: safeText(group.latest.detail, 400) ?? `Refused by ${group.cause}.`,
			compliant, remedy_status: compliant ? "MATCHED" as const : "UNAVAILABLE" as const,
			count: group.count, latest_at: group.latest.ts,
		};
	}).sort((a, b) => b.count - a.count || (timestampMs(b.latest_at) ?? 0) - (timestampMs(a.latest_at) ?? 0));
	const fireGroups = new Map<string, { member: string | null; count: number; latest_at: string }>();
	for (const event of history.events) {
		if (event.seat !== seat || event.kind !== "inject" || windowStartMs === null || windowEndMs === null) continue;
		const at = timestampMs(event.ts);
		if (at === null || at < windowStartMs || at > windowEndMs) continue;
		const member = memberName(event.member);
		const key = member ?? "unknown";
		const group = fireGroups.get(key) ?? { member, count: 0, latest_at: event.ts };
		group.count++;
		if ((timestampMs(event.ts) ?? 0) > (timestampMs(group.latest_at) ?? 0)) group.latest_at = event.ts;
		fireGroups.set(key, group);
	}
	const allRuleFires = [...fireGroups.values()].sort((a, b) => (timestampMs(b.latest_at) ?? 0) - (timestampMs(a.latest_at) ?? 0));
	const ruleFireGroupsOmitted = Math.max(0, allRuleFires.length - MAX_REPORT_GROUPS);
	const ruleFires = allRuleFires.slice(0, MAX_REPORT_GROUPS);
	const dcg: ExplainReport["sources"]["dcg"] = { status: "UNATTRIBUTED", records: null, reason: "Not read: DCG history has no verified OMP-seat join, and its records may contain raw commands." };
	const ruleFireStatus: ExplainReport["sources"]["rule_fires"]["status"] = ruleFires.length ? "PARTIAL" : "UNAVAILABLE";
	const contractFailures = refusalRows.filter(row => row.remedy_status !== "MATCHED").length;
	const contractStatus: ExplainReport["sources"]["gate_contracts"]["status"] = repos.length === 0 ? "UNAVAILABLE" : contractFailures || repos.length > CONTRACT_REPOS || refusalGroupsOmitted > 0 || untrustedRepoPaths ? "PARTIAL" : "READ";
	const contractReason = untrustedRepoPaths
		? repos.length === 0 ? "Refusal repository paths outside trusted fleet roots were not inspected." : "Some refusal repository paths outside trusted fleet roots were not inspected."
		: repos.length === 0 ? "No trusted refusal repository path was recorded."
			: refusalGroupsOmitted > 0 ? `${refusalGroupsOmitted} refusal groups were omitted by the display cap.`
				: repos.length > CONTRACT_REPOS ? "Some repository contracts were not read because of the lookup cap."
					: contractFailures ? "Some refusal causes have no exact current gate-contract match; rule fixes require a unique trusted member join." : null;
	const overall: ExplainReport["overall"] = history.status === "MISSING" || history.status === "UNAVAILABLE" ? "UNVERIFIED" : "PARTIAL";
	const window = {
		attempts: selected.length,
		start_at: windowStartMs === null ? null : new Date(windowStartMs).toISOString(),
		end_at: windowEndMs === null ? null : new Date(windowEndMs).toISOString(),
		complete,
	};
	const source: ExplainReport["sources"] = {
		gate_events: { status: history.status, rows_read: history.rows_read, invalid_rows: history.invalid_rows, tail_window_bytes: history.tail_window_bytes, truncated_before: history.truncated_before, incomplete_after: history.incomplete_after },
		gate_contracts: { status: contractStatus, repos_read: contracts.size, reason: contractReason },
		dcg,
		rule_fires: {
			status: ruleFireStatus, records: null,
			reason: ruleFires.length ? "Counts are observed seat-attributed inject events only; complete rule-fire history is unavailable." : "No inject rows in this action window; rule-fire history is unavailable, not zero.",
		},
	};
	const reportWithoutText: Omit<ExplainReport, "text"> = {
		scope: "explain", overall, seat, last, refusal_groups_omitted: refusalGroupsOmitted, rule_fire_groups_omitted: ruleFireGroupsOmitted,
		window, refusals: refusalRows, rule_fires: ruleFires,
		commit_first_try: {
			status: metricStatus, attempts: commitAttempts.length, passed, refused,
			rate_pct: commitAttempts.length ? Math.round(passed / commitAttempts.length * 1000) / 10 : null,
		},
		sources: source,
	};
	return { ...reportWithoutText, text: renderText(reportWithoutText) };
}
