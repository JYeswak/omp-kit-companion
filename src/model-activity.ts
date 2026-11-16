import {
	ACTIVITY_MAX_RECORDS, isActivityEvent,
	type ActivityEvent, type ActivityIdentity, type ActivityModel,
} from "./model-activity-schema.ts";
import { readActivityJournal } from "./model-activity-journal.ts";
import { MODEL_USAGE_MAX_FILES, type ModelSessionSource } from "./model-work-usage.ts";

export interface ActivityWindow { start_ms: number; end_ms: number; }
export interface ModelContribution extends ActivityModel { known_active_ms: number; }
export interface ModelActivityInspection {
	status: "KNOWN" | "UNKNOWN";
	active_ms: number | null;
	known_active_ms: number | null;
	unattributed_ms: number | null;
	valid_processing_segment_coverage: number | null;
	counts: { observed_segments: number; valid_segments: number; unknown_segments: number; duplicate_events: number };
	problems: string[];
	cohort: { window: ActivityWindow; definition: string };
	by_model: ModelContribution[];
	session_sources: ModelSessionSource[];
	session_sources_complete: boolean;
	bytes_read?: number;
	pages_read?: number;
}

type Open = Extract<ActivityEvent, { kind: "open" }>;
type Settle = Extract<ActivityEvent, { kind: "settle" }>;
interface Segment { open?: Open; settle?: Settle; invalid: boolean; }
interface Boundary { at: number; delta: 1 | -1; model: ActivityModel; key: string; }
const NS_PER_MS = 1_000_000n;
const segmentKey = (event: ActivityEvent) => `${event.identity.incarnation}\0${event.identity.segment_id}`;
const modelKey = (model: ActivityModel) => `${model.provider}\0${model.model}`;

/** Journal identity collection has its own bound, independent of interval union. */
function recordSessionSource(sources: Map<string, ModelSessionSource>, journal: string, identity: string, sessionId: string): boolean {
	const key = `${sessionId}\0${identity}`;
	if (sources.has(key)) return true;
	if (sources.size >= MODEL_USAGE_MAX_FILES) return false;
	sources.set(key, { journal, identity, session_id: sessionId });
	return true;
}

function sameIdentity(a: ActivityIdentity, b: ActivityIdentity): boolean {
	return a.seat === b.seat && a.session_id === b.session_id && a.session_file === b.session_file
		&& a.file_id === b.file_id && a.incarnation === b.incarnation && a.run_id === b.run_id
		&& a.segment_id === b.segment_id && a.turn_index === b.turn_index;
}
function mayTouchWindow(segment: Segment, window: ActivityWindow): boolean {
	const start = segment.open?.clock.epoch_ms ?? null;
	const end = segment.settle?.clock.epoch_ms ?? null;
	if (start !== null && end !== null) {
		if (start === end) return start >= window.start_ms && start < window.end_ms;
		return Math.min(start, end) < window.end_ms && Math.max(start, end) > window.start_ms;
	}
	if (start !== null && start >= window.end_ms) return false;
	if (end !== null && end < window.start_ms) return false;
	return true;
}

/** Project only locally captured native processing boundaries. Missing evidence is
 * not idle time, and a percentage describes observed segments, not an entire week. */
export function projectActivityRecords(
	records: readonly unknown[], window: ActivityWindow,
	source: { complete: boolean; problems: readonly string[] } = { complete: true, problems: [] },
): ModelActivityInspection {
	const problems = new Set(source.problems);
	const events = new Map<string, ActivityEvent>();
	const badSegments = new Set<string>();
	let trustworthyDenominator = source.complete;
	let duplicateEvents = 0;
	if (!Number.isSafeInteger(window.start_ms) || !Number.isSafeInteger(window.end_ms)
		|| window.start_ms < 0 || Object.is(window.start_ms, -0) || window.end_ms <= window.start_ms) {
		return { status: "UNKNOWN", active_ms: null, known_active_ms: null, unattributed_ms: 0,
			valid_processing_segment_coverage: null,
			counts: { observed_segments: 0, valid_segments: 0, unknown_segments: 0, duplicate_events: 0 },
			problems: [...problems, "INVALID_REPORTING_WINDOW"],
			cohort: { window: { ...window }, definition: "Observed native processing segments; no unrecorded wall-time or request-duration inference" },
			by_model: [], session_sources: [], session_sources_complete: false };
	}
	const count = Math.min(records.length, ACTIVITY_MAX_RECORDS);
	if (records.length > count) { problems.add("RECORD_LIMIT"); trustworthyDenominator = false; }
	for (let index = 0; index < count; index++) {
		const row = records[index];
		if (!isActivityEvent(row)) { problems.add("INVALID_ACTIVITY_EVENT"); trustworthyDenominator = false; continue; }
		const prior = events.get(row.id);
		if (prior !== undefined) {
			if (JSON.stringify(prior) === JSON.stringify(row)) duplicateEvents++;
			else {
				problems.add("CONFLICTING_EVENT_ID"); trustworthyDenominator = false;
				badSegments.add(segmentKey(prior)); badSegments.add(segmentKey(row));
			}
			continue;
		}
		events.set(row.id, row);
	}

	const segments = new Map<string, Segment>();
	const sequences = new Map<string, Map<number, ActivityEvent>>();
	for (const event of events.values()) {
		const key = segmentKey(event);
		let sequence = sequences.get(event.identity.incarnation);
		if (sequence === undefined) sequences.set(event.identity.incarnation, sequence = new Map());
		const previous = sequence.get(event.sequence);
		if (previous !== undefined && previous.id !== event.id) {
			problems.add("CONFLICTING_EVENT_SEQUENCE"); trustworthyDenominator = false;
			badSegments.add(segmentKey(previous)); badSegments.add(key);
		} else sequence.set(event.sequence, event);
		if (event.kind === "loss") {
			problems.add("RECORDER_EVENT_LOSS"); trustworthyDenominator = false; badSegments.add(key); continue;
		}
		let segment = segments.get(key);
		if (segment === undefined) segments.set(key, segment = { invalid: false });
		if (event.kind === "invalidate") segment.invalid = true;
		else if (event.kind === "open") {
			if (segment.open !== undefined) segment.invalid = true;
			else segment.open = event;
		} else {
			if (segment.settle !== undefined) segment.invalid = true;
			else segment.settle = event;
		}
	}
	for (const sequence of sequences.values()) {
		const positions = [...sequence.keys()].sort((a, b) => a - b);
		for (let index = 1; index < positions.length; index++) {
			if (positions[index]! !== positions[index - 1]! + 1) {
				problems.add("EVENT_SEQUENCE_GAP"); trustworthyDenominator = false; break;
			}
		}
	}

	let observed = 0, valid = 0, unknown = 0;
	const boundaries = new Map<string, Boundary[]>();
	const sessionSources = new Map<string, ModelSessionSource>();
	let sessionSourcesComplete = true;
	for (const [key, segment] of segments) {
		if (!mayTouchWindow(segment, window)) continue;
		observed++;
		const open = segment.open, settle = segment.settle;
		if (segment.invalid || badSegments.has(key) || open === undefined || settle === undefined) {
			unknown++; problems.add("INCOMPLETE_PROCESSING_SEGMENT"); continue;
		}
		if (!sameIdentity(open.identity, settle.identity) || open.identity.file_id === null) {
			unknown++; problems.add("PROCESSING_SOURCE_REPLACED_OR_UNPROVEN"); continue;
		}
		const start = open.clock.epoch_ms, end = settle.clock.epoch_ms;
		const startNs = open.clock.mono_ns, endNs = settle.clock.mono_ns;
		if (settle.reason !== null || start === null || end === null || startNs === null || endNs === null
			|| open.native_timestamp_ms === null || end < start) {
			unknown++; problems.add("PROCESSING_CLOCK_OR_BOUNDARY_INVALID"); continue;
		}
		const elapsedNs = BigInt(endNs) - BigInt(startNs);
		const driftMs = BigInt(end - start) - elapsedNs / NS_PER_MS;
		// Both epoch samples are integer milliseconds. Two endpoint quantization
		// errors bound agreement; no floating epsilon or request duration is used.
		if (elapsedNs < 0n || driftMs < -2n || driftMs > 2n) {
			unknown++; problems.add("PROCESSING_CLOCKS_DISAGREE"); continue;
		}
		const model = settle.model;
		if (model === null || settle.models_seen.length === 0
			|| settle.models_seen.some(seen => modelKey(seen) !== modelKey(model))) {
			unknown++; problems.add("PROCESSING_MODEL_UNPROVEN"); continue;
		}
		valid++;
		const startClipped = Math.max(start, window.start_ms), endClipped = Math.min(end, window.end_ms);
		if (endClipped <= startClipped) continue;
		sessionSourcesComplete = recordSessionSource(sessionSources, open.identity.session_file,
			open.identity.file_id, open.identity.session_id) && sessionSourcesComplete;
		let seat = boundaries.get(open.identity.seat);
		if (seat === undefined) boundaries.set(open.identity.seat, seat = []);
		const modelId = modelKey(model);
		seat.push({ at: startClipped, delta: 1, model, key: modelId }, { at: endClipped, delta: -1, model, key: modelId });
	}

	let knownMs = 0, unattributedMs = 0, sumOverflow = false;
	const contributions = new Map<string, ModelContribution>();
	for (const points of boundaries.values()) {
		points.sort((a, b) => a.at - b.at);
		const active = new Map<string, { count: number; model: ActivityModel }>();
		let previousAt = points[0]!.at, index = 0;
		while (index < points.length) {
			const at = points[index]!.at, span = at - previousAt;
			if (span > 0 && active.size > 0) {
				if (Number.isSafeInteger(knownMs + span)) knownMs += span;
				else sumOverflow = true;
				if (active.size === 1) {
					const [modelId, entry] = active.entries().next().value!;
					let contribution = contributions.get(modelId);
					if (contribution === undefined) contributions.set(modelId, contribution = { ...entry.model, known_active_ms: 0 });
					if (Number.isSafeInteger(contribution.known_active_ms + span)) contribution.known_active_ms += span;
					else sumOverflow = true;
				} else {
					if (Number.isSafeInteger(unattributedMs + span)) unattributedMs += span;
					else sumOverflow = true;
					problems.add("CROSS_MODEL_PROCESSING_OVERLAP");
				}
			}
			while (index < points.length && points[index]!.at === at) {
				const point = points[index++]!, current = active.get(point.key);
				const next = (current?.count ?? 0) + point.delta;
				if (next === 0) active.delete(point.key);
				else active.set(point.key, { count: next, model: point.model });
			}
			previousAt = at;
		}
	}
	if (sumOverflow) {
		problems.add("PROCESSING_SUM_OVERFLOW"); trustworthyDenominator = false;
	}
	if (!source.complete) problems.add("ACTIVITY_SOURCE_INCOMPLETE");
	if (observed === 0) problems.add("NO_PROCESSING_EVIDENCE_IN_WINDOW");
	const complete = trustworthyDenominator && problems.size === 0 && observed > 0 && valid === observed;
	return {
		status: complete ? "KNOWN" : "UNKNOWN",
		active_ms: complete ? knownMs : null,
		known_active_ms: valid > 0 && !sumOverflow ? knownMs : null,
		unattributed_ms: sumOverflow ? null : unattributedMs,
		// Display-only observed-cohort percentage; hours remain UNKNOWN for any
		// unresolved segment. It is not a full-week recording-completeness claim.
		valid_processing_segment_coverage: trustworthyDenominator && observed > 0 ? 100 * valid / observed : null,
		counts: { observed_segments: observed, valid_segments: valid, unknown_segments: unknown, duplicate_events: duplicateEvents },
		problems: [...problems],
		cohort: { window: { ...window }, definition: "Observed native processing segments, unioned per seat; excludes unrecorded time and request-duration inference" },
		by_model: sumOverflow ? [] : [...contributions.values()],
		session_sources: [...sessionSources.values()], session_sources_complete: sessionSourcesComplete,
	};
}

export function inspectModelActivity(stateRoot: string | null, now = Date.now(), window?: ActivityWindow): ModelActivityInspection {
	const selected = window ?? { start_ms: Math.max(0, now - 7 * 86_400_000), end_ms: now };
	const read = readActivityJournal(stateRoot, now);
	const report = projectActivityRecords(read.records, selected, { complete: read.complete, problems: read.problems });
	report.bytes_read = read.bytes_read;
	report.pages_read = read.pages_read;
	return report;
}
