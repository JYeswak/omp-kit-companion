// Verifies a retained gate result (the native full-test `result_ref`, ompkit-fp72.100) against the bytes
// and the git-tracked citation it names, so a DONE or close that cites a result can be checked rather
// than trusted (ompkit-bj08.11, ompkit-fp72.101). Read-only: it only calls the doctor's existing
// `readFile` and `git` seams, keeps no store and never reads the Agent Mail archive.
import { createHash } from "node:crypto";
import type { FleetIo } from "./fleet-flywheel-doctor.ts";

export type EvidenceIo = Pick<FleetIo, "readFile" | "git">;
export type EvidenceCheckName = "reference_shape" | "metadata_complete" | "retained_log" | "git_citation" | "bead_pointer" | "mail_message_id";
export type EvidenceCheck = { name: EvidenceCheckName; stream: "stdout" | "stderr" | null; status: "PASS" | "FAIL" | "UNVERIFIED"; code: string; detail: string };
export type GitLocator = { repository: string; commit: string };
export type EvidenceVerification = {
	bead: string;
	/** Integrity and retention of the cited result only. */
	evidence: "VERIFIED" | "FAIL" | "UNVERIFIED";
	/** What the verified result itself says; UNKNOWN unless the evidence verified. */
	suite: "PASS" | "FAIL" | "UNKNOWN";
	checks: EvidenceCheck[];
	limits: string[];
};

const STREAMS = ["stdout", "stderr"] as const;
type StreamName = typeof STREAMS[number];
const LIMITS = [
	"Integrity and retention only: a verified result is not suite correctness, root cause or live behavior.",
	"Agent Mail message existence is not verified (no archive read); the id is only required inside the git-tracked pointer.",
	"Whether the cited commit was pushed is not checked.",
];

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
function identityDiffers(text: string, expected: { bytes: unknown; sha256: unknown }): boolean {
	return Buffer.byteLength(text, "utf8") !== expected.bytes || sha256(text) !== expected.sha256;
}
const DIGIT = "0123456789";
const WORD = `${DIGIT}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-`;
/**
 * True when `token` occurs in `text` bounded by characters outside `alphabet` (a dot closes a sentence
 * only when no word character follows), so a message id 6388 never matches inside 63881 and a bead id
 * never matches inside a longer one.
 */
function mentions(text: string, token: string, alphabet: string): boolean {
	for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
		const before = text[at - 1];
		const after = text[at + token.length];
		const next = text[at + token.length + 1];
		const dotted = after === "." && alphabet === WORD && next !== undefined && WORD.includes(next);
		const leading = before !== undefined && (alphabet.includes(before) || (alphabet === WORD && before === "."));
		if (!leading && (after === undefined || !alphabet.includes(after)) && !dotted) return true;
	}
	return false;
}

type Citation = Record<string, unknown>;

function citationsFor(reference: Record<string, unknown>, stream: StreamName, kind: "git" | "agent-mail"): Citation[] {
	const retention = reference.retention;
	const rows = record(retention) && Array.isArray(retention.citations) ? retention.citations : [];
	return rows.filter((row): row is Citation => record(row) && row.kind === kind && row.stream === stream);
}

function pointerTexts(io: EvidenceIo, bead: string, locator: GitLocator): { texts: string[]; unreadable: boolean } {
	const texts: string[] = [];
	if (io.git(locator.repository, ["rev-parse", "--git-dir"]) === null) return { texts, unreadable: true };
	const message = io.git(locator.repository, ["log", "-n", "1", "--format=%B", locator.commit]);
	if (message !== null) texts.push(message);
	const tracker = io.git(locator.repository, ["show", `${locator.commit}:.beads/issues.jsonl`]);
	if (tracker !== null) {
		for (const line of tracker.split("\n")) {
			if (!line.startsWith("{")) continue;
			let row: unknown;
			try { row = JSON.parse(line); } catch { continue; }
			if (!record(row) || row.id !== bead || !Array.isArray(row.comments)) continue;
			for (const comment of row.comments) if (record(comment) && typeof comment.text === "string") texts.push(comment.text);
		}
	}
	return { texts, unreadable: false };
}

function metadataGaps(reference: Record<string, unknown>): string[] {
	const gaps: string[] = [];
	if (typeof reference.source_revision !== "string" || reference.source_revision.length === 0) gaps.push("source_revision");
	if (!Array.isArray(reference.argv) || reference.argv.length === 0) gaps.push("argv");
	if (reference.execution !== "EXITED") gaps.push("execution");
	if (!Number.isSafeInteger(reference.producer_exit)) gaps.push("producer_exit");
	if (!record(reference.counts)) gaps.push("counts");
	if (!Array.isArray(reference.failing_names)) gaps.push("failing_names");
	if (reference.execution_capture_complete !== true) gaps.push("execution_capture_complete");
	if (Array.isArray(reference.missing_fields)) for (const field of reference.missing_fields) gaps.push(`missing:${String(field)}`);
	for (const name of STREAMS) {
		const stream = reference[name];
		if (!record(stream)) gaps.push(name);
		else if (stream.capture_complete !== true || stream.identity_matches !== true) gaps.push(`${name}.identity`);
	}
	return gaps;
}

/** Counts, exit and names must agree with each other before the result is reported at all. */
function contradiction(reference: Record<string, unknown>): string | null {
	const counts = reference.counts;
	if (!record(counts) || !Array.isArray(reference.failing_names)) return null;
	const failed = counts.fail;
	if (typeof failed !== "number") return "counts.fail is not a number";
	if (failed === 0 && reference.failing_names.length > 0) return "failing names present with zero failed cases";
	if (failed > 0 && reference.failing_names.length !== failed) return `${failed} failed cases but ${reference.failing_names.length} failing names`;
	if (reference.producer_exit === 0 && failed > 0) return "producer exit 0 with failed cases";
	return null;
}

export function verifyEvidenceReference(io: EvidenceIo, input: { bead: string; reference: unknown; pointers?: readonly GitLocator[] }): EvidenceVerification {
	const checks: EvidenceCheck[] = [];
	const add = (name: EvidenceCheckName, stream: StreamName | null, status: EvidenceCheck["status"], code: string, detail: string): void => {
		checks.push({ name, stream, status, code, detail });
	};
	const finish = (reference: Record<string, unknown> | null): EvidenceVerification => {
		const evidence = checks.some((check) => check.status === "FAIL") ? "FAIL"
			: checks.some((check) => check.status === "UNVERIFIED") ? "UNVERIFIED" : "VERIFIED";
		let suite: EvidenceVerification["suite"] = "UNKNOWN";
		if (evidence === "VERIFIED" && reference) {
			const counts = reference.counts as Record<string, unknown>;
			suite = reference.producer_exit === 0 && counts.fail === 0 ? "PASS" : "FAIL";
		}
		return { bead: input.bead, evidence, suite, checks, limits: LIMITS };
	};
	const reference = input.reference;
	if (!record(reference) || reference.schema_version !== 1) {
		add("reference_shape", null, "FAIL", "REFERENCE_SHAPE", "not a schema_version 1 result reference");
		return finish(null);
	}
	add("reference_shape", null, "PASS", "OK", "schema_version 1");

	const gaps = metadataGaps(reference);
	const conflict = contradiction(reference);
	if (conflict) add("metadata_complete", null, "FAIL", "METADATA_CONTRADICTION", conflict);
	else if (gaps.length) add("metadata_complete", null, "UNVERIFIED", "METADATA_INCOMPLETE", `missing in the reference: ${gaps.join(", ")}`);
	else add("metadata_complete", null, "PASS", "OK", "argv, source revision, exit, counts, failing names and stream captures present");

	const pointers: GitLocator[] = [...(input.pointers ?? [])];
	for (const name of STREAMS) {
		for (const citation of citationsFor(reference, name, "git"))
			if (typeof citation.repository === "string" && typeof citation.commit === "string"
				&& !pointers.some((p) => p.repository === citation.repository && p.commit === citation.commit))
				pointers.push({ repository: citation.repository, commit: citation.commit });
	}

	for (const name of STREAMS) {
		const stream = reference[name];
		if (!record(stream)) continue;
		const expected = { bytes: stream.bytes, sha256: stream.sha256 };

		// 1. The retained log bytes on disk.
		if (typeof stream.path !== "string" || stream.path.length === 0) add("retained_log", name, "UNVERIFIED", "LOG_PATH_ABSENT", `${name} names no retained log path`);
		else {
			const text = io.readFile(stream.path);
			if (text === null) add("retained_log", name, "UNVERIFIED", "LOG_UNREADABLE", `${name} log ${stream.path} cannot be read`);
			else if (identityDiffers(text, expected)) add("retained_log", name, "FAIL", "LOG_HASH_MISMATCH", `${name} log ${stream.path} is not the cited ${String(stream.bytes)} bytes / sha256 ${String(stream.sha256)}`);
			else add("retained_log", name, "PASS", "OK", `${name} log bytes and sha256 match`);
		}

		// 2. A git-tracked copy at the cited commit; mail alone is not a record.
		const gitCitations = citationsFor(reference, name, "git");
		const mailCitations = citationsFor(reference, name, "agent-mail");
		if (gitCitations.length === 0)
			add("git_citation", name, "FAIL", mailCitations.length ? "MAIL_ONLY" : "NO_CITATION",
				mailCitations.length ? `${name} is cited only through Agent Mail, which is delivery and not a git-tracked record` : `${name} has no git-tracked citation`);
		for (const citation of gitCitations) {
			const where = `${String(citation.repository)}@${String(citation.commit)}:${String(citation.path)}`;
			if (typeof citation.repository !== "string" || typeof citation.commit !== "string" || typeof citation.path !== "string") {
				add("git_citation", name, "FAIL", "CITATION_INCOMPLETE", `${name} git citation lacks repository, commit or path`);
			} else if (citation.repository.includes("<private-path>")) {
				add("git_citation", name, "UNVERIFIED", "REPOSITORY_REDACTED", `${name} repository path was redacted by the producer (${citation.repository}); cite a repository outside its private roots`);
			} else if (io.git(citation.repository, ["rev-parse", "--git-dir"]) === null) {
				add("git_citation", name, "UNVERIFIED", "GIT_UNREADABLE", `${name} repository ${citation.repository} cannot be read`);
			} else if (io.git(citation.repository, ["cat-file", "-e", `${citation.commit}^{commit}`]) === null) {
				add("git_citation", name, "FAIL", "COMMIT_ABSENT", `${name} cited commit is not in ${citation.repository}: ${citation.commit}`);
			} else {
				const blob = io.git(citation.repository, ["show", `${citation.commit}:${citation.path}`]);
				if (blob === null) add("git_citation", name, "FAIL", "PATH_ABSENT", `${name} ${where} does not exist at the cited commit`);
				else if (identityDiffers(blob, expected)) add("git_citation", name, "FAIL", "BLOB_HASH_MISMATCH", `${name} ${where} differs from the cited bytes / sha256`);
				else add("git_citation", name, "PASS", "OK", `${name} ${where} matches`);
			}
		}

		// 3. The Agent Mail message id the record must carry.
		const messageIds = mailCitations.map((citation) => citation.message_id).filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
		if (messageIds.length === 0) add("mail_message_id", name, "FAIL", "NO_MESSAGE_ID", `${name} cites no Agent Mail message id`);
		else add("mail_message_id", name, "PASS", "OK", `${name} cites Agent Mail message ${messageIds.join(", ")}`);

		// 4. A git-tracked bead comment or commit message that carries bead id, sha256 and message id together.
		if (typeof stream.sha256 === "string" && messageIds.length) {
			let readable = false;
			let found = false;
			let sawBead = false;
			let sawSha = false;
			for (const locator of pointers) {
				const { texts, unreadable } = pointerTexts(io, input.bead, locator);
				if (unreadable) continue;
				readable = true;
				for (const text of texts) {
					const hasBead = mentions(text, input.bead, WORD);
					const hasSha = text.includes(stream.sha256);
					sawBead ||= hasBead; sawSha ||= hasSha;
					if (hasBead && hasSha && messageIds.some((id) => mentions(text, String(id), DIGIT))) found = true;
				}
			}
			if (found) add("bead_pointer", name, "PASS", "OK", `a git-tracked record names ${input.bead}, the ${name} sha256 and the message id`);
			else if (pointers.length === 0) add("bead_pointer", name, "UNVERIFIED", "POINTER_ABSENT", `${name} has no git-tracked pointer to read`);
			else if (!readable) add("bead_pointer", name, "UNVERIFIED", "POINTER_UNREADABLE", `no pointer repository can be read: ${pointers.map((p) => p.repository).join(", ")}`);
			else add("bead_pointer", name, "FAIL", "POINTER_MISMATCH",
				`no git-tracked record names ${input.bead}, the ${name} sha256 and the message id together (bead seen: ${sawBead}, sha seen: ${sawSha})`);
		}
	}
	return finish(reference);
}
