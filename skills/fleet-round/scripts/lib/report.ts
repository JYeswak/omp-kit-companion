// Round report: labeled lines plus exactly one fenced ```json block (schema fleet-round.report/v1).
// The two halves must say the same thing, and every claim must equal the validator's own
// recomputation. Structure comes from the markdown parser (lib/markdown.ts); JSON from JSON.parse;
// regexes only tokenize single, length-capped lines (lib/patterns.ts).
import { isRecord } from "./model.ts";
import { jsonFences, parseBlocks } from "./markdown.ts";
import { CITATION, CLAIM_VALUE, LABEL_LINE, matchLine, ROUND_NUMBER, SEAT } from "./patterns.ts";

export const REPORT_SCHEMA = "fleet-round.report/v1";
export const PHASES = ["insight", "agree", "execute", "measure", "validate"];
export const STATUSES = ["done", "warn", "blocked"];
const SINGLE = ["ROUND", "PROJECT", "SEAT", "PHASE", "STATUS", "MISSION", "FOCUS"];
const REQUIRED = ["ROUND", "PROJECT", "SEAT", "PHASE", "STATUS"];
/** MISSION value of a director-drafted mission awaiting approval (decisions Q9: round 0 only); the text is json.mission_proposed. */
export const PROPOSED = "PROPOSED";

export type Labeled = { key: string; id: string | null; value: string; line: number };
export type ClaimCheck = { id: string; metric: string; reported: string; measured: number | null; status: "VERIFIED" | "MISMATCH" | "UNVERIFIABLE"; evidence: string };
export type ReportVerdict = {
	status: "ACCEPTED" | "REJECTED" | "UNVERIFIED";
	errors: string[];
	unverified: string[];
	fields: { round: number | null; project: string | null; seat: string | null; phase: string | null; status: string | null; mission: string | null; mission_proposed: string | null; focus: string[] | null };
	claims: ClaimCheck[];
	predictions: { id: string; text: string; metric: string | null }[];
};

export function labeledLines(markdown: string): { lines: Labeled[]; errors: string[] } {
	const lines: Labeled[] = [];
	const errors: string[] = [];
	for (const block of parseBlocks(markdown)) {
		if (block.kind !== "paragraph" || block.nested) continue;
		for (const entry of block.lines) {
			const match = matchLine(LABEL_LINE, entry.text);
			if (!match) continue;
			if (entry.line === null) {
				errors.push(`labeled line ${JSON.stringify(entry.text.slice(0, 80))} is not verbatim in the source (inline markdown or escapes); write labeled lines as plain text`);
				continue;
			}
			lines.push({ key: match[1]!, id: match[2] ?? null, value: match[3]!.trimEnd(), line: entry.line });
		}
	}
	return { lines, errors };
}

/** Validate a report against itself and against `measured` (metric -> recomputed value). */
export function validateReport(markdown: string, measured: Record<string, number>, expectedProject: string | null): ReportVerdict {
	const errors: string[] = [];
	const unverified: string[] = [];
	const fields: ReportVerdict["fields"] = { round: null, project: null, seat: null, phase: null, status: null, mission: null, mission_proposed: null, focus: null };
	const claims: ClaimCheck[] = [];
	const predictions: ReportVerdict["predictions"] = [];
	const done = (): ReportVerdict => ({ status: errors.length > 0 ? "REJECTED" : unverified.length > 0 ? "UNVERIFIED" : "ACCEPTED", errors, unverified, fields, claims, predictions });

	const blocks = parseBlocks(markdown);
	const fences = jsonFences(blocks);
	if (fences.length !== 1) errors.push(`expected exactly one fenced json block, found ${fences.length}`);
	let json: Record<string, unknown> | null = null;
	if (fences.length >= 1) {
		try {
			const parsed: unknown = JSON.parse(fences[0]!.text);
			if (isRecord(parsed)) json = parsed;
			else errors.push("json block is not a JSON object");
		} catch (error) {
			errors.push(`json block is malformed: ${(error as Error).message}`);
		}
	}
	if (json && json.schema !== REPORT_SCHEMA) errors.push(`json.schema is ${JSON.stringify(json.schema)}; expected ${JSON.stringify(REPORT_SCHEMA)}`);

	const { lines, errors: lineErrors } = labeledLines(markdown);
	errors.push(...lineErrors);
	const single: Record<string, Labeled> = {};
	for (const entry of lines) {
		if (!SINGLE.includes(entry.key)) continue;
		if (entry.id !== null) errors.push(`line ${entry.line}: ${entry.key} takes no id`);
		if (single[entry.key]) errors.push(`${entry.key} appears twice (lines ${single[entry.key]!.line} and ${entry.line})`);
		else single[entry.key] = entry;
	}
	for (const key of REQUIRED) if (!single[key]) errors.push(`missing labeled line ${key}`);
	if (!json) return done();

	const jsonKey = (key: string): unknown => json![key.toLowerCase()];
	for (const key of REQUIRED) if (jsonKey(key) === undefined) errors.push(`json is missing field ${key.toLowerCase()}`);

	// round
	const roundLine = single.ROUND?.value;
	if (roundLine !== undefined && !matchLine(ROUND_NUMBER, roundLine)) errors.push(`ROUND ${JSON.stringify(roundLine)} is not a round number`);
	if (json.round !== undefined && !(typeof json.round === "number" && Number.isInteger(json.round) && json.round >= 0)) errors.push(`json.round ${JSON.stringify(json.round)} is not a non-negative integer`);
	if (roundLine !== undefined && typeof json.round === "number" && Number(roundLine) !== json.round) errors.push(`field round disagrees: line ROUND says ${roundLine}, json.round says ${json.round}`);
	if (typeof json.round === "number") fields.round = json.round;

	// string fields
	for (const key of ["PROJECT", "SEAT", "PHASE", "STATUS"]) {
		const name = key.toLowerCase();
		const line = single[key]?.value;
		const value = jsonKey(key);
		if (value !== undefined && typeof value !== "string") errors.push(`json.${name} is not a string`);
		if (line !== undefined && typeof value === "string" && line !== value) errors.push(`field ${name} disagrees: line ${key} says ${JSON.stringify(line)}, json.${name} says ${JSON.stringify(value)}`);
		if (typeof value === "string") fields[name as "project" | "seat" | "phase" | "status"] = value;
	}
	if (fields.seat !== null && !matchLine(SEAT, fields.seat)) errors.push(`seat ${JSON.stringify(fields.seat)} is not session:window.pane`);
	if (fields.phase !== null && !PHASES.includes(fields.phase)) errors.push(`phase ${JSON.stringify(fields.phase)} is not one of ${PHASES.join("|")}`);
	if (fields.status !== null && !STATUSES.includes(fields.status)) errors.push(`status ${JSON.stringify(fields.status)} is not one of ${STATUSES.join("|")}`);
	if (expectedProject !== null && fields.project !== null && fields.project !== expectedProject) errors.push(`project ${JSON.stringify(fields.project)} is not the project under validation (${expectedProject})`);

	// mission citation, or PROPOSED with its drafted text in round 0 (optional, both sides or neither)
	const missionLine = single.MISSION?.value;
	if ((missionLine === undefined) !== (json.mission === undefined)) errors.push(`field mission present on only one side (line MISSION ${missionLine === undefined ? "absent" : "present"}, json.mission ${json.mission === undefined ? "absent" : "present"})`);
	else if (missionLine !== undefined) {
		if (typeof json.mission !== "string") errors.push("json.mission is not a path:line string");
		else if (json.mission !== missionLine) errors.push(`field mission disagrees: line MISSION says ${JSON.stringify(missionLine)}, json.mission says ${JSON.stringify(json.mission)}`);
		else if (missionLine === PROPOSED) {
			if (fields.round !== 0) errors.push(`MISSION: ${PROPOSED} is accepted in round 0 only; cite the approved mission as path:line`);
			else if (typeof json.mission_proposed !== "string" || json.mission_proposed.trim() === "") errors.push(`MISSION: ${PROPOSED} needs the drafted mission text in json.mission_proposed`);
			else {
				fields.mission = PROPOSED;
				fields.mission_proposed = json.mission_proposed.trim();
			}
		} else if (!matchLine(CITATION, missionLine)) errors.push(`mission ${JSON.stringify(missionLine)} is neither a path:line citation nor ${PROPOSED}`);
		else fields.mission = missionLine;
	}
	if (json.mission_proposed !== undefined && missionLine !== PROPOSED) errors.push(`json.mission_proposed is set but MISSION is not ${PROPOSED}`);

	// focus (optional, both sides or neither)
	const focusLine = single.FOCUS?.value;
	if ((focusLine === undefined) !== (json.focus === undefined)) errors.push(`field focus present on only one side (line FOCUS ${focusLine === undefined ? "absent" : "present"}, json.focus ${json.focus === undefined ? "absent" : "present"})`);
	else if (focusLine !== undefined) {
		const fromLine = focusLine.split(",").map(part => part.trim());
		if (!Array.isArray(json.focus) || !json.focus.every(item => typeof item === "string")) errors.push("json.focus is not an array of bead ids");
		else if (fromLine.join("\u0000") !== json.focus.join("\u0000")) errors.push(`field focus disagrees: line FOCUS says ${fromLine.join(", ")}, json.focus says ${json.focus.join(", ")}`);
		else fields.focus = fromLine;
	}

	// claims
	if (!Array.isArray(json.claims)) errors.push("json.claims is not an array");
	const jsonClaims = new Map<string, { metric: string; value: string; evidence: string }>();
	for (const [index, raw] of (Array.isArray(json.claims) ? json.claims : []).entries()) {
		if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.metric !== "string" || typeof raw.evidence !== "string" || raw.evidence.trim() === "" || !["number", "string", "boolean"].includes(typeof raw.value)) {
			errors.push(`json.claims[${index}] needs string id, string metric, scalar value and a non-empty evidence command`);
			continue;
		}
		if (jsonClaims.has(raw.id)) errors.push(`json.claims has duplicate id ${raw.id}`);
		jsonClaims.set(raw.id, { metric: raw.metric, value: String(raw.value), evidence: raw.evidence });
	}
	const lineClaims = new Map<string, Labeled>();
	for (const entry of lines.filter(l => l.key === "CLAIM")) {
		if (entry.id === null) errors.push(`line ${entry.line}: CLAIM needs an id (CLAIM <id>: metric = value)`);
		else if (lineClaims.has(entry.id)) errors.push(`CLAIM ${entry.id} appears twice`);
		else lineClaims.set(entry.id, entry);
	}
	for (const [id, entry] of lineClaims) {
		const match = matchLine(CLAIM_VALUE, entry.value);
		const claim = jsonClaims.get(id);
		if (!match) {
			errors.push(`CLAIM ${id} (line ${entry.line}) is not "metric = value"`);
			continue;
		}
		if (!claim) {
			errors.push(`CLAIM ${id} has no json.claims entry`);
			continue;
		}
		if (match[1] !== claim.metric) errors.push(`CLAIM ${id} field metric disagrees: line says ${match[1]}, json says ${claim.metric}`);
		if (match[2] !== claim.value) errors.push(`CLAIM ${id} field ${match[1]} disagrees: line says ${match[1]}=${match[2]}, json says ${claim.value}`);
	}
	for (const id of jsonClaims.keys()) if (!lineClaims.has(id)) errors.push(`json.claims ${id} has no CLAIM line`);
	for (const [id, claim] of jsonClaims) {
		const value = measured[claim.metric];
		if (value === undefined) {
			unverified.push(`CLAIM ${id} metric ${claim.metric} is not recomputable by the validator`);
			claims.push({ id, metric: claim.metric, reported: claim.value, measured: null, status: "UNVERIFIABLE", evidence: claim.evidence });
			continue;
		}
		const ok = Number(claim.value) === value && claim.value.trim() !== "";
		if (!ok) errors.push(`CLAIM ${id} ${claim.metric}: reported ${claim.value}, validator measured ${value}`);
		claims.push({ id, metric: claim.metric, reported: claim.value, measured: value, status: ok ? "VERIFIED" : "MISMATCH", evidence: claim.evidence });
	}

	// predictions: ids must match across lines and json when either side has them
	const linePredictions = lines.filter(l => l.key === "PREDICTION");
	const jsonPredictions = Array.isArray(json.predictions) ? json.predictions : json.predictions === undefined ? [] : null;
	if (jsonPredictions === null) errors.push("json.predictions is not an array");
	const jsonIds = new Map<string, string | null>();
	for (const [index, raw] of (jsonPredictions ?? []).entries()) {
		if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.metric !== "string") {
			errors.push(`json.predictions[${index}] needs string id and metric`);
			continue;
		}
		if (jsonIds.has(raw.id)) errors.push(`json.predictions has duplicate id ${raw.id}`);
		jsonIds.set(raw.id, raw.metric);
	}
	const seen = new Set<string>();
	for (const entry of linePredictions) {
		if (entry.id === null) {
			errors.push(`line ${entry.line}: PREDICTION needs an id`);
			continue;
		}
		if (seen.has(entry.id)) errors.push(`PREDICTION ${entry.id} appears twice`);
		seen.add(entry.id);
		if (!jsonIds.has(entry.id)) errors.push(`PREDICTION ${entry.id} has no json.predictions entry`);
		predictions.push({ id: entry.id, text: entry.value, metric: jsonIds.get(entry.id) ?? null });
	}
	for (const id of jsonIds.keys()) if (!seen.has(id)) errors.push(`json.predictions ${id} has no PREDICTION line`);
	return done();
}
