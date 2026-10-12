import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, constants } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const MAX_MISSION_BYTES = 1024 * 1024;
const MAX_CHECK_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PILLAR_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CHECK_COMMAND = /^omp-kit heavy -- bun ([A-Za-z0-9._/-]+) --pillar ([a-z][a-z0-9-]*)$/;
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export type MissionCheckStatus = "REGISTERED" | "UNREGISTERED";
export type MissionValidationStatus = "VALID" | "UNREGISTERED" | "INVALID";

export interface MissionCheckReport {
	readonly id: string;
	readonly clause: string;
	readonly check: string;
	readonly status: MissionCheckStatus;
	readonly path: string | null;
	readonly sha256: string | null;
	readonly command_sha256: string | null;
	readonly reason?: string;
}

export interface MissionValidationReport {
	readonly overall: MissionValidationStatus;
	readonly mission_file: string;
	readonly identity: string | null;
	readonly stage: string | null;
	readonly pillars: readonly MissionCheckReport[];
	readonly errors: readonly string[];
	readonly no_claim: "A registered check is integrity-pinned; its measurement quality is not established.";
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function hash(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function report(status: MissionValidationStatus, missionFile: string, identity: string | null, stage: string | null,
	pillars: readonly MissionCheckReport[], errors: readonly string[]): MissionValidationReport {
	return Object.freeze({ overall: status, mission_file: missionFile, identity, stage,
		pillars: Object.freeze([...pillars]), errors: Object.freeze([...errors]),
		no_claim: "A registered check is integrity-pinned; its measurement quality is not established." });
}

function safeRead(path: string, maxBytes: number): Buffer {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("UNSAFE_OR_OVERSIZED_FILE");
	const canonical = realpathSync(path);
	if (canonical !== path) throw new Error("NONCANONICAL_PATH");
	const fd = openSync(path, NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode || opened.size !== before.size) throw new Error("FILE_CHANGED");
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.mode !== opened.mode || after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size) throw new Error("FILE_CHANGED");
		return bytes;
	} finally {
		closeSync(fd);
	}
}

function canonicalProjectRoot(projectRoot: string): string {
	if (!isAbsolute(projectRoot)) throw new Error("PROJECT_PATH_MUST_BE_ABSOLUTE");
	const root = realpathSync(projectRoot);
	if (!lstatSync(root).isDirectory()) throw new Error("PROJECT_PATH_NOT_DIRECTORY");
	return root;
}

function missionFilePath(root: string, relativePath: string): string {
	if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\") || normalize(relativePath) !== relativePath ||
		relativePath.split("/").some(part => part === ".." || part === "." || part === "")) throw new Error("MISSION_PATH_INVALID");
	const path = join(root, relativePath);
	if (!path.startsWith(`${root}/`)) throw new Error("MISSION_PATH_INVALID");
	return path;
}

function checkSourcePath(root: string, relativePath: unknown): { path: string; bytes: Buffer } {
	if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) || relativePath.includes("\\") ||
		normalize(relativePath) !== relativePath || relativePath.split("/").some(part => part === ".." || part === "." || part === "")) {
		throw new Error("CHECK_PATH_INVALID");
	}
	const path = join(root, relativePath);
	if (!path.startsWith(`${root}/`)) throw new Error("CHECK_PATH_INVALID");
	return { path: relativePath, bytes: safeRead(path, MAX_CHECK_BYTES) };
}

function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateRoot(raw: Record<string, unknown>, errors: string[]): void {
	for (const field of ["identity", "stage", "done_rule", "approved_by", "approved_at", "approval_quote"]) {
		if (!hasText(raw[field])) errors.push(`MISSION_FIELD_REQUIRED:${field}`);
	}
	if (!stringArray(raw.not_in_mission) || raw.not_in_mission.length === 0) errors.push("MISSION_NOT_IN_MISSION_INVALID");
	if (!stringArray(raw.product_paths) || raw.product_paths.length === 0) errors.push("MISSION_PRODUCT_PATHS_INVALID");
	if (!stringArray(raw.pillar_ids) || raw.pillar_ids.length === 0) errors.push("MISSION_PILLAR_IDS_INVALID");
	else {
		const ids = new Set<string>();
		for (const id of raw.pillar_ids) {
			if (!PILLAR_ID.test(id)) errors.push(`MISSION_PILLAR_ID_UNKNOWN:${id}`);
			if (ids.has(id)) errors.push(`MISSION_PILLAR_ID_DUPLICATE:${id}`);
			ids.add(id);
		}
	}
	const cadence = raw.cadence;
	if (!record(cadence) || !["daily", "weekly", "exit"].every(key => hasText(cadence[key]))) errors.push("MISSION_CADENCE_INVALID");
	const blastRadius = raw.blast_radius;
	if (!record(blastRadius) || !["binaries", "paths", "sessions"].every(key => stringArray(blastRadius[key]))) errors.push("MISSION_BLAST_RADIUS_INVALID");
}

function checkReport(root: string, pillar: Record<string, unknown>, index: number, errors: string[], expectedPillarIds: ReadonlySet<string>): MissionCheckReport {
	const id = hasText(pillar.id) ? pillar.id : `#${index + 1}`;
	const clause = hasText(pillar.clause) ? pillar.clause : "";
	const check = hasText(pillar.check) ? pillar.check : "";
	let path: string | null = typeof pillar.check_path === "string" ? pillar.check_path : null;
	let codeSha256: string | null = typeof pillar.check_sha256 === "string" ? pillar.check_sha256 : null;
	let commandSha256: string | null = typeof pillar.check_command_sha256 === "string" ? pillar.check_command_sha256 : null;
	let reason = "";
	if (!PILLAR_ID.test(id) || !expectedPillarIds.has(id)) errors.push(`MISSION_PILLAR_ID_UNKNOWN:${id}`);
	if (!clause) errors.push(`MISSION_PILLAR_CLAUSE_MISSING:${id}`);
	if (!check) {
		errors.push(`MISSION_PILLAR_CHECK_MISSING:${id}`);
		reason = "CHECK_MISSING";
	}
	const match = CHECK_COMMAND.exec(check);
	if (!match) reason ||= "CHECK_COMMAND_UNSUPPORTED";
	else if (match[1] !== path || match[2] !== id) reason ||= "CHECK_COMMAND_REGISTRATION_MISMATCH";
	if (!SHA256.test(codeSha256 ?? "")) reason ||= "CHECK_SHA256_INVALID";
	if (!SHA256.test(commandSha256 ?? "")) reason ||= "CHECK_COMMAND_SHA256_INVALID";
	if (!reason && hash(check) !== commandSha256) reason = "CHECK_COMMAND_SHA256_MISMATCH";
	if (!reason) {
		try {
			const source = checkSourcePath(root, path);
			if (hash(source.bytes) !== codeSha256) reason = "CHECK_SHA256_MISMATCH";
		} catch (error) {
			reason = error instanceof Error ? error.message : "CHECK_SOURCE_UNAVAILABLE";
		}
	}
	const status: MissionCheckStatus = reason ? "UNREGISTERED" : "REGISTERED";
	if (status === "UNREGISTERED") errors.push(`MISSION_CHECK_UNREGISTERED:${id}:${reason}`);
	return Object.freeze({ id, clause, check, status, path, sha256: codeSha256, command_sha256: commandSha256, ...(reason ? { reason } : {}) });
}

/** Validate record shape and integrity registrations only. This function never launches checks. */
export function validateMissionRecord(projectRoot: string, options: { readonly missionFile?: string } = {}): MissionValidationReport {
	let root: string;
	try { root = canonicalProjectRoot(projectRoot); }
	catch (error) {
		return report("INVALID", projectRoot, null, null, [], [error instanceof Error ? error.message : "PROJECT_PATH_INVALID"]);
	}
	const relativeMissionFile = options.missionFile ?? ".omp/mission.toml";
	let path: string;
	let raw: unknown;
	try {
		path = missionFilePath(root, relativeMissionFile);
		raw = Bun.TOML.parse(safeRead(path, MAX_MISSION_BYTES).toString("utf8"));
	} catch (error) {
		return report("INVALID", relativeMissionFile, null, null, [], [error instanceof Error ? error.message : "MISSION_UNAVAILABLE"]);
	}
	if (!record(raw)) return report("INVALID", relativeMissionFile, null, null, [], ["MISSION_ROOT_NOT_TABLE"]);
	const errors: string[] = [];
	validateRoot(raw, errors);
	const sourcePillars = raw.pillar;
	if (!Array.isArray(sourcePillars) || sourcePillars.length === 0) errors.push("MISSION_PILLARS_MISSING");
	const pillars: MissionCheckReport[] = [];
	const seen = new Set<string>();
	if (Array.isArray(sourcePillars)) {
		const expected = stringArray(raw.pillar_ids) ? new Set(raw.pillar_ids) : new Set<string>();
		for (let index = 0; index < sourcePillars.length; index++) {
			const value = sourcePillars[index];
			if (!record(value)) {
				errors.push(`MISSION_PILLAR_INVALID:${index + 1}`);
				continue;
			}
			const pillar = checkReport(root, value, index, errors, expected);
			if (seen.has(pillar.id)) errors.push(`MISSION_PILLAR_DUPLICATE:${pillar.id}`);
			seen.add(pillar.id);
			pillars.push(pillar);
		}
		for (const id of expected) if (!seen.has(id)) errors.push(`MISSION_PILLAR_MISSING:${id}`);
	}
	const identity = hasText(raw.identity) ? raw.identity : null;
	const stage = hasText(raw.stage) ? raw.stage : null;
	const unregistered = pillars.some(pillar => pillar.status === "UNREGISTERED");
	return report(errors.length === 0 ? "VALID" : unregistered ? "UNREGISTERED" : "INVALID", relativeMissionFile, identity, stage, pillars, errors);
}

const ANCHOR_DOC_CANDIDATES = ["ROADMAP.md", "MISSION.md", "docs/ROADMAP.md", ".flywheel/MISSION.md", "README.md"];
const ANCHOR_HEADING = /^#{1,3}[ \t]+Mission\b/i;
const ANCHOR_APPROVAL = /approved?[ \t]+by|STATE[ \t]*:[ \t]*(PROPOSED|APPROVED)|APPROVED_BY/i;
const ANCHOR_HUMAN_TEXT = /^#[^\n]*Human text:[ \t]*(\S+)/m;

export type MissionAnchorVerdict = "AGREE" | "DRIFT";

export interface MissionAnchorDoc {
	readonly file: string | null;
	readonly heading: string | null;
	readonly approved: boolean;
	readonly errors: readonly string[];
}

export interface MissionAnchorStatus {
	readonly root: string;
	readonly doc: MissionAnchorDoc;
	readonly record: MissionValidationReport | null;
	readonly wordingAgrees: boolean | null;
	readonly verdict: MissionAnchorVerdict;
	readonly details: readonly string[];
}

function anchorDocFile(root: string, tomlText: string | null, explicitDocFile: string | undefined): string | null {
	if (explicitDocFile !== undefined) return missionFilePath(root, explicitDocFile);
	if (tomlText !== null) {
		const declared = ANCHOR_HUMAN_TEXT.exec(tomlText)?.[1]?.replace(/[",)]+$/, "");
		if (declared) {
			try {
				const path = missionFilePath(root, declared);
				if (lstatSync(path).isFile()) return path;
				return null;
			} catch { return null; }
		}
	}
	for (const candidate of ANCHOR_DOC_CANDIDATES) {
		try {
			const path = missionFilePath(root, candidate);
			if (lstatSync(path).isFile()) return path;
		} catch { continue; }
	}
	return null;
}

function anchorDocSection(text: string): { heading: string | null; body: string } {
	const lines = text.split("\n");
	const start = lines.findIndex(line => ANCHOR_HEADING.test(line));
	if (start < 0) return { heading: null, body: "" };
	const level = /^#{1,3}/.exec(lines[start]!)![0].length;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		const edge = /^(#{1,3})[ \t]/.exec(lines[index]!);
		if (edge && edge[1]!.length <= level) { end = index; break; }
	}
	return { heading: lines[start]!.trim(), body: lines.slice(start, end).join("\n") };
}

/** One anchor, two faces (ompkit-fp72.9 ANCHOR1): the live-doc Mission statement is the
 * human source of truth for wording; .omp/mission.toml is the machine record. Reports
 * per-repo status and flags any disagreement as DRIFT. Never launches checks. */
export function missionAnchorStatus(projectRoot: string, options: { readonly missionFile?: string; readonly docFile?: string } = {}): MissionAnchorStatus {
	let root: string;
	try { root = canonicalProjectRoot(projectRoot); }
	catch {
		return { root: projectRoot, doc: { file: null, heading: null, approved: false, errors: ["ANCHOR_PROJECT_PATH_INVALID"] },
			record: null, wordingAgrees: null, verdict: "DRIFT", details: ["ANCHOR_PROJECT_PATH_INVALID"] };
	}
	const relativeMissionFile = options.missionFile ?? ".omp/mission.toml";
	let tomlText: string | null = null;
	let recordValue: MissionValidationReport | null = null;
	try {
		tomlText = safeRead(missionFilePath(root, relativeMissionFile), MAX_MISSION_BYTES).toString("utf8");
		recordValue = validateMissionRecord(root, { missionFile: relativeMissionFile });
	} catch { recordValue = null; }
	const details: string[] = [];
	const docErrors: string[] = [];
	let docFile: string | null = null;
	try { docFile = anchorDocFile(root, tomlText, options.docFile); }
	catch { docFile = null; }
	let heading: string | null = null;
	let approved = false;
	let section = "";
	if (docFile === null) {
		docErrors.push("ANCHOR_DOC_MISSING");
	} else {
		let docText = "";
		try { docText = safeRead(docFile, MAX_MISSION_BYTES).toString("utf8"); }
		catch { docErrors.push("ANCHOR_DOC_UNREADABLE"); }
		if (docText) {
			const parsed = anchorDocSection(docText);
			heading = parsed.heading;
			section = parsed.body;
			if (heading === null) docErrors.push("ANCHOR_DOC_NO_MISSION_HEADING");
			approved = ANCHOR_APPROVAL.test(`${heading ?? ""}\n${section}`);
			if (!approved) docErrors.push("ANCHOR_DOC_APPROVAL_MISSING");
		}
	}
	for (const error of docErrors) details.push(error);
	let wordingAgrees: boolean | null = null;
	if (recordValue !== null && recordValue.overall !== "VALID") details.push(`ANCHOR_RECORD_${recordValue.overall}`);
	if (recordValue === null) details.push("ANCHOR_RECORD_UNAVAILABLE");
	if (docErrors.length === 0 && recordValue !== null && recordValue.overall === "VALID") {
		wordingAgrees = recordValue.identity !== null && section.replace(/\s+/g, " ").trim().includes(recordValue.identity.replace(/\s+/g, " ").trim());
		if (!wordingAgrees) details.push("ANCHOR_WORDING_DRIFT");
	}
	const verdict: MissionAnchorVerdict = details.length === 0 ? "AGREE" : "DRIFT";
	return { root, doc: { file: docFile, heading, approved, errors: Object.freeze([...docErrors]) },
		record: recordValue, wordingAgrees, verdict, details: Object.freeze([...details]) };
}
