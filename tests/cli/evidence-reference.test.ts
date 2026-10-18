// ompkit-fp72.101: the retained-result verifier replays a real failing producer through the real native
// reader seams (`liveFleetIo` readFile and git) and a real disposable git repository. Every negative differs
// from the valid control in exactly one boundary and must name its check; none may ever read as VERIFIED.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEvidenceReference, type EvidenceIo, type EvidenceVerification, type GitLocator } from "../../src/evidence-reference.ts";
import { liveFleetIo } from "../../src/fleet-flywheel-doctor.ts";
import { describeFullTestProducer, type FullTestProducer, type FullTestResultReference } from "../../src/full-test-runner.ts";

const BEAD = "ompkit-fp72.101";
const MESSAGE = 63900;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

interface Fixture {
	root: string;
	git(...args: string[]): string;
	tracker(comment: string): string;
	trackerCommit: string;
	logCommit: string;
	reference: FullTestResultReference;
	producer: FullTestProducer;
	gitCitation(stream: "stdout" | "stderr", commit?: string, path?: string): Record<string, unknown>;
	mailCitation(stream: "stdout" | "stderr", id?: number): Record<string, unknown>;
	describe(references: unknown[]): FullTestResultReference;
	shaOut: string;
	shaErr: string;
	pointer: GitLocator;
}
const CASES = {
	failing: [
		'import { expect, test } from "bun:test";',
		'test("real producer keeps its log", () => { console.log("π".repeat(40)); expect(1).toBe(1); });',
		'test("real producer detects wrong bytes", () => { expect("observed").toBe("required"); });',
	].join("\n"),
	passing: [
		'import { expect, test } from "bun:test";',
		'test("real producer passes", () => { console.log("ok"); expect(1).toBe(1); });',
	].join("\n"),
};

async function fixture(source: string): Promise<Fixture> {
	// `work` is the private producer root the runner redacts; `root` is the separate git repository that retains the logs.
	const work = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-evidence-work-")));
	const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-evidence-reference-")));
	roots.push(work, root);
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CONFIG_NOSYSTEM" && key !== "GIT_CONFIG_GLOBAL") delete env[key];
	const gitIn = (dir: string, ...args: string[]): string => {
		const child = Bun.spawnSync(["git", "-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "user.name=EvidenceFixture", "-c", "user.email=evidence@example.invalid", ...args], { env, stdout: "pipe", stderr: "pipe" });
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return child.stdout.toString().trim();
	};
	const git = (...args: string[]): string => gitIn(root, ...args);
	await Bun.write(join(work, ".owner"), `pid=${process.pid}\nlabel=evidence-reference\nrepo=${work}\ncreated=${new Date().toISOString()}\n`);
	await Bun.write(join(work, ".gitignore"), "/.owner\n/var/\n");
	await Bun.write(join(work, "cases.test.ts"), source);
	gitIn(work, "init", "--quiet", "--initial-branch=main");
	gitIn(work, "add", "--", ".gitignore", "cases.test.ts");
	gitIn(work, "commit", "--only", "-qm", "producer source", "--", ".gitignore", "cases.test.ts");
	const revision = gitIn(work, "rev-parse", "HEAD");
	const argv = [process.execPath, "--no-env-file", "test", "--config", "/dev/null", join(work, "cases.test.ts")];
	const child = Bun.spawnSync(argv, { cwd: work, env, stdout: "pipe", stderr: "pipe" });
	const stdout = child.stdout.toString(), stderr = child.stderr.toString();
	const identity = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") });
	const result = { code: child.exitCode, stdout, stderr, execution: {
		argv, cwd: work, launched: true, exit_code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null,
		interrupted: false, stdout_complete: true, stderr_complete: true, stdout_capture: identity(stdout), stderr_capture: identity(stderr),
	} };
	const options = { source_revision: revision, roots: [work], artifact_root: work };
	const producer = describeFullTestProducer(result, options);
	git("init", "--quiet", "--initial-branch=main");
	// Retain the redacted decoded streams in git, then record a tracker comment that points at them.
	mkdirSync(join(root, "retained"));
	writeFileSync(join(root, "retained", "producer.stdout"), producer.stdout);
	writeFileSync(join(root, "retained", "producer.stderr"), producer.stderr);
	git("add", "--", "retained/producer.stdout", "retained/producer.stderr");
	git("commit", "--only", "-qm", "retain producer streams", "--", "retained/producer.stdout", "retained/producer.stderr");
	const logCommit = git("rev-parse", "HEAD");
	const shaOut = producer.result_ref.stdout!.sha256, shaErr = producer.result_ref.stderr!.sha256;
	const tracker = (comment: string): string => {
		mkdirSync(join(root, ".beads"), { recursive: true });
		writeFileSync(join(root, ".beads", "issues.jsonl"), [
			JSON.stringify({ id: "ompkit-other", comments: [{ id: 1, author: "X", text: `unrelated ${shaOut} AM${MESSAGE}` }] }),
			JSON.stringify({ id: BEAD, comments: [{ id: 2, author: "TurquoiseSummit", text: comment }] }),
		].join("\n") + "\n");
		git("add", "--", ".beads/issues.jsonl");
		git("commit", "--only", "-qm", "tracker export", "--", ".beads/issues.jsonl");
		return git("rev-parse", "HEAD");
	};
	const trackerCommit = tracker(`${BEAD} retained producer streams: stdout sha256 ${shaOut}, stderr sha256 ${shaErr}, Agent Mail AM${MESSAGE}`);
	const gitCitation = (stream: "stdout" | "stderr", commit = logCommit, path = `retained/producer.${stream}`) =>
		({ kind: "git", stream, repository: root, commit, path, bytes: producer.result_ref[stream]!.bytes, sha256: producer.result_ref[stream]!.sha256 });
	const mailCitation = (stream: "stdout" | "stderr", id = MESSAGE) =>
		({ kind: "agent-mail", stream, project_key: root, message_id: id, attachment: `producer.${stream}`, bytes: producer.result_ref[stream]!.bytes, sha256: producer.result_ref[stream]!.sha256 });
	const describe = (references: unknown[]) => describeFullTestProducer(result, { ...options, references }).result_ref;
	const reference = describe([gitCitation("stdout"), gitCitation("stderr"), mailCitation("stdout"), mailCitation("stderr")]);
	return { root, git, tracker, trackerCommit, logCommit, reference, producer, gitCitation, mailCitation, describe, shaOut, shaErr, pointer: { repository: root, commit: trackerCommit } };
}

const real: EvidenceIo = liveFleetIo();
const verify = (f: Fixture, over: { reference?: unknown; bead?: string; io?: EvidenceIo; pointers?: GitLocator[] } = {}) =>
	verifyEvidenceReference(over.io ?? real, { bead: over.bead ?? BEAD, reference: over.reference ?? f.reference, pointers: over.pointers ?? [f.pointer] });
const check = (r: EvidenceVerification, code: string, stream: "stdout" | "stderr" | null = null) => r.checks.find((c) => c.code === code && c.stream === stream);
function expectRefused(r: EvidenceVerification, evidence: "FAIL" | "UNVERIFIED", code: string, stream: "stdout" | "stderr" | null = null) {
	expect(r.evidence).toBe(evidence);
	expect(r.suite).toBe("UNKNOWN");
	expect(check(r, code, stream)?.status).toBe(evidence);
}

let failing: Fixture;
test("valid control: a real failing producer verifies as retained evidence and stays a FAIL, never a suite PASS", async () => {
	failing = await fixture(CASES.failing);
	expect(failing.reference.counts).toEqual({ protocol: "BUN_TEST", unit: "TEST_CASE", pass: 1, fail: 1, skip: 0, total: 2 });
	expect(failing.reference.missing_fields).toEqual([]);
	const r = verify(failing);
	expect(r.checks.filter((c) => c.status !== "PASS")).toEqual([]);
	expect(r.checks.map((c) => `${c.name}:${c.stream}`).sort()).toEqual([
		"bead_pointer:stderr", "bead_pointer:stdout", "git_citation:stderr", "git_citation:stdout", "mail_message_id:stderr", "mail_message_id:stdout",
		"metadata_complete:null", "reference_shape:null", "retained_log:stderr", "retained_log:stdout",
	]);
	expect(r.evidence).toBe("VERIFIED");
	expect(r.suite).toBe("FAIL");
	expect(r.limits.join(" ")).toContain("not suite correctness");
});

test("valid control: a real passing producer verifies and reports a suite PASS only from its own verified counts", async () => {
	const passing = await fixture(CASES.passing);
	const r = verify(passing);
	expect(r.evidence).toBe("VERIFIED");
	expect(r.suite).toBe("PASS");
	expect(passing.reference.counts).toMatchObject({ pass: 1, fail: 0 });
});

test("a commit message carrying bead, both hashes and the message id is an accepted pointer", async () => {
	const f = await fixture(CASES.failing);
	f.git("commit", "--allow-empty", "-qm", `${BEAD} retained streams ${f.shaOut} ${f.shaErr} AM${MESSAGE}`);
	const commit = f.git("rev-parse", "HEAD");
	expect(verify(f, { pointers: [{ repository: f.root, commit }] }).evidence).toBe("VERIFIED");
});

test("planted: a deleted retained log is UNVERIFIED and names the missing path", () => {
	const path = failing.reference.stdout!.path!;
	renameSync(path, `${path}.moved`);
	try {
		const r = verify(failing);
		expectRefused(r, "UNVERIFIED", "LOG_UNREADABLE", "stdout");
		expect(check(r, "LOG_UNREADABLE", "stdout")!.detail).toContain(path);
		expect(check(r, "OK", "stderr")).toBeDefined();
	} finally { renameSync(`${path}.moved`, path); }
});

test("planted: one changed byte at the same length is a hash mismatch, not a pass", () => {
	const path = failing.reference.stderr!.path!;
	const original = readFileSync(path);
	const changed = Buffer.from(original);
	changed[0] = changed[0] === 0x41 ? 0x42 : 0x41;
	expect(changed.byteLength).toBe(original.byteLength);
	writeFileSync(path, changed);
	try { expectRefused(verify(failing), "FAIL", "LOG_HASH_MISMATCH", "stderr"); }
	finally { writeFileSync(path, original); }
	expect(verify(failing).evidence).toBe("VERIFIED");
});

test("planted: no citation and mail-only evidence are flagged under different names and are never complete", () => {
	const noCitation = failing.describe([]);
	expect(noCitation.retention.status).toBe("UNRETAINED");
	for (const stream of ["stdout", "stderr"] as const) expectRefused(verify(failing, { reference: noCitation }), "FAIL", "NO_CITATION", stream);
	const mailOnly = failing.describe([failing.mailCitation("stdout"), failing.mailCitation("stderr")]);
	for (const stream of ["stdout", "stderr"] as const) expectRefused(verify(failing, { reference: mailOnly }), "FAIL", "MAIL_ONLY", stream);
	expect(check(verify(failing, { reference: mailOnly }), "NO_CITATION", "stdout")).toBeUndefined();
});

test("planted: a cited commit, path or blob that does not hold the cited bytes fails by name", () => {
	const absent = failing.describe([failing.gitCitation("stdout", "f".repeat(40)), failing.gitCitation("stderr"), failing.mailCitation("stdout"), failing.mailCitation("stderr")]);
	expectRefused(verify(failing, { reference: absent }), "FAIL", "COMMIT_ABSENT", "stdout");
	const missingPath = failing.describe([failing.gitCitation("stdout", failing.logCommit, "retained/absent.stdout"), failing.gitCitation("stderr"), failing.mailCitation("stdout"), failing.mailCitation("stderr")]);
	expectRefused(verify(failing, { reference: missingPath }), "FAIL", "PATH_ABSENT", "stdout");
	// describeFullTestProducer refuses a citation whose bytes differ from the stream, so the wrong blob is crafted in the reference itself.
	const wrongBlob = structuredClone(failing.reference) as { retention: { citations: { path: string; stream: string; kind: string }[] } };
	for (const c of wrongBlob.retention.citations) if (c.kind === "git" && c.stream === "stdout") c.path = "retained/producer.stderr";
	expectRefused(verify(failing, { reference: wrongBlob }), "FAIL", "BLOB_HASH_MISMATCH", "stdout");
	expect(check(verify(failing, { reference: wrongBlob }), "OK", "stderr")).toBeDefined();
});

test("planted: a wrong bead, or a record that omits the hash or the message id, is a pointer mismatch", () => {
	expectRefused(verify(failing, { bead: "ompkit-fp72.102" }), "FAIL", "POINTER_MISMATCH", "stdout");
	const noHash = failing.tracker(`${BEAD} retained producer streams, Agent Mail AM${MESSAGE}`);
	expectRefused(verify(failing, { pointers: [{ repository: failing.root, commit: noHash }] }), "FAIL", "POINTER_MISMATCH", "stdout");
	const noMessage = failing.tracker(`${BEAD} retained producer streams: stdout sha256 ${failing.shaOut}, stderr sha256 ${failing.shaErr}`);
	expectRefused(verify(failing, { pointers: [{ repository: failing.root, commit: noMessage }] }), "FAIL", "POINTER_MISMATCH", "stderr");
	const other = failing.tracker(`unrelated ${failing.shaOut} ${failing.shaErr} AM${MESSAGE}`);
	expectRefused(verify(failing, { pointers: [{ repository: failing.root, commit: other }] }), "FAIL", "POINTER_MISMATCH", "stdout");
});

test("planted: a longer message id or bead id never satisfies the cited one", () => {
	const longerMessage = failing.tracker(`${BEAD} streams ${failing.shaOut} ${failing.shaErr} AM${MESSAGE}0 and ${MESSAGE + 1}`);
	expectRefused(verify(failing, { pointers: [{ repository: failing.root, commit: longerMessage }] }), "FAIL", "POINTER_MISMATCH", "stdout");
	const longerBead = failing.tracker(`${BEAD}0 streams ${failing.shaOut} ${failing.shaErr} AM${MESSAGE}`);
	expectRefused(verify(failing, { pointers: [{ repository: failing.root, commit: longerBead }] }), "FAIL", "POINTER_MISMATCH", "stdout");
	const sentenceEnd = failing.tracker(`Retained for ${BEAD}. ${failing.shaOut} ${failing.shaErr} (AM${MESSAGE}).`);
	expect(verify(failing, { pointers: [{ repository: failing.root, commit: sentenceEnd }] }).evidence).toBe("VERIFIED");
});

test("planted: a reference with no Agent Mail message id names it and never reads as complete", () => {
	const noMail = failing.describe([failing.gitCitation("stdout"), failing.gitCitation("stderr")]);
	for (const stream of ["stdout", "stderr"] as const) expectRefused(verify(failing, { reference: noMail }), "FAIL", "NO_MESSAGE_ID", stream);
	expect(check(verify(failing, { reference: noMail }), "OK", "stdout")).toBeDefined();
});

test("planted: each missing metadata field is UNVERIFIED and named; contradictory counts are a FAIL", () => {
	const base = structuredClone(failing.reference) as Record<string, unknown>;
	for (const [field, value] of [["source_revision", null], ["argv", null], ["counts", null], ["failing_names", null], ["producer_exit", null], ["execution", "NOT_OBSERVED"], ["execution_capture_complete", false]] as const) {
		const r = verify(failing, { reference: { ...base, [field]: value } });
		expectRefused(r, "UNVERIFIED", "METADATA_INCOMPLETE");
		expect(check(r, "METADATA_INCOMPLETE")!.detail).toContain(field);
	}
	const streamGap = verify(failing, { reference: { ...base, stderr: { ...(base.stderr as object), identity_matches: false } } });
	expect(check(streamGap, "METADATA_INCOMPLETE")!.detail).toContain("stderr.identity");
	const clean = { ...base, producer_exit: 0 };
	expectRefused(verify(failing, { reference: clean }), "FAIL", "METADATA_CONTRADICTION");
	const unnamed = { ...base, failing_names: [] };
	expectRefused(verify(failing, { reference: unnamed }), "FAIL", "METADATA_CONTRADICTION");
});

test("planted: unavailable readers, unreadable repositories and malformed references are never VERIFIED", () => {
	const dead: EvidenceIo = { readFile: () => null, git: () => null };
	const r = verify(failing, { io: dead });
	expect(r.evidence).toBe("UNVERIFIED");
	expect(r.suite).toBe("UNKNOWN");
	expect(check(r, "LOG_UNREADABLE", "stdout")!.detail).toContain(failing.reference.stdout!.path!);
	expect(check(r, "GIT_UNREADABLE", "stdout")!.detail).toContain(failing.root);
	expect(check(r, "POINTER_UNREADABLE", "stdout")!.status).toBe("UNVERIFIED");
	for (const reference of [null, undefined, "text", [], {}, { ...structuredClone(failing.reference), schema_version: 2 }])
		expectRefused(verifyEvidenceReference(real, { bead: BEAD, reference }), "FAIL", "REFERENCE_SHAPE");
	const noPointer = verifyEvidenceReference(real, { bead: BEAD, reference: failing.describe([failing.mailCitation("stdout"), failing.mailCitation("stderr")]) });
	expect(noPointer.evidence).toBe("FAIL");
});

test("planted: a repository the producer redacted is UNVERIFIED and says so, never silently trusted", () => {
	const redacted = structuredClone(failing.reference) as { retention: { citations: { repository?: string; kind: string; stream: string }[] } };
	for (const c of redacted.retention.citations) if (c.kind === "git" && c.stream === "stdout") c.repository = "<private-path>";
	const r = verify(failing, { reference: redacted });
	expectRefused(r, "UNVERIFIED", "REPOSITORY_REDACTED", "stdout");
	expect(check(r, "OK", "stderr")).toBeDefined();
});

test("planted: a stream that names no retained log path is UNVERIFIED while its sibling stream still verifies", () => {
	const base = structuredClone(failing.reference) as { stdout: { path: string | null } };
	base.stdout.path = null;
	const r = verify(failing, { reference: base });
	expectRefused(r, "UNVERIFIED", "LOG_PATH_ABSENT", "stdout");
	expect(check(r, "OK", "stderr")).toBeDefined();
});
