import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
	applyProjectGuard,
	checkCustodyBash,
	checkCustodyFileTool,
	checkCustodyTracker,
	createCustodyToolCallHandler,
	doctorStaleGuard,
	isReadOnlyCustodyBash,
	parseHashlineTargets,
	type CustodyGit,
	type CustodyPolicy,
	type HandoffRow,
} from "./custody.ts";

const BLOB = "a".repeat(40);
const OTHER = "b".repeat(40);
const ROOT = "/repo/proj";

function policy(over: Partial<CustodyPolicy> = {}): CustodyPolicy {
	return {
		repoRoot: ROOT,
		heldPaths: ["data/owners.json"],
		protectedPaths: [],
		ownerHandoffs: [],
		director: "RusticPine",
		...over,
	};
}

function git(over: Partial<CustodyGit> = {}): CustodyGit {
	return {
		hashObject: () => BLOB,
		revParse: () => BLOB,
		...over,
	};
}

const DIRECTOR = { name: "RusticPine", isDirector: true };
const WORKER = { name: "SomeWorker", isDirector: false };

test("CUSTODY1: director handoff append admitted when worktree blob == named commit blob", () => {
	const rows: HandoffRow[] = [];
	const block = checkCustodyTracker(
		{ command: "br handoff add --path data/owners.json --commit abc123 --bead ompkit-1", cwd: ROOT },
		policy(),
		DIRECTOR,
		ROOT,
		git(),
		(row) => rows.push(row),
	);
	expect(block).toBeUndefined();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ path: "data/owners.json", blob: BLOB, signedBy: "RusticPine" });
});

test("CUSTODY1 planted: worker identity running the same command is refused", () => {
	const block = checkCustodyTracker(
		{ command: "br handoff add --path data/owners.json --commit abc123 --bead ompkit-1", cwd: ROOT },
		policy(),
		WORKER,
		ROOT,
		git(),
	);
	expect(block?.reason).toMatch(/worker identity refused/);
});

test("CUSTODY1 planted: blob drift from the named commit is refused", () => {
	const block = checkCustodyTracker(
		{ command: "br handoff add --path data/owners.json --commit abc123 --bead ompkit-1", cwd: ROOT },
		policy(),
		DIRECTOR,
		ROOT,
		git({ revParse: () => OTHER }),
	);
	expect(block?.reason).toMatch(/blob drift refused/);
});

test("CUSTODY1 planted: edits to manifests/module/trackerRowExceptions stay denied", () => {
	for (const target of [
		"etc/manifest.json",
		".omp/extensions/proj-held-path-custody.ts",
		"data/trackerRowExceptions.json",
	]) {
		const block = checkCustodyFileTool({ input: { path: target } }, policy(), ROOT, ROOT);
		expect(block?.reason).toMatch(/protected target denied/);
	}
});

test("CUSTODY1 planted: direct file write to a held path stays denied", () => {
	const block = checkCustodyFileTool({ input: { path: "data/owners.json" } }, policy(), ROOT, ROOT);
	expect(block?.reason).toMatch(/held path denied/);
});

test("CUSTODY1: hashline edit to an admitted path ALLOWED, to a held path DENIED, opaque DENIED", () => {
	const admitted = checkCustodyFileTool(
		{ toolName: "edit", input: { input: "[src/notes.ts#1A2B]\nPUT >$:\n+x\n" } },
		policy(),
		ROOT,
		ROOT,
	);
	expect(admitted).toBeUndefined();
	const held = checkCustodyFileTool(
		{ toolName: "edit", input: { input: "[data/owners.json#1A2B]\nPUT >$:\n+x\n" } },
		policy(),
		ROOT,
		ROOT,
	);
	expect(held?.reason).toMatch(/held path denied/);
	const opaque = checkCustodyFileTool(
		{ toolName: "edit", input: { input: "just some text without a header\n" } },
		policy(),
		ROOT,
		ROOT,
	);
	expect(opaque?.reason).toMatch(/opaque edit payload denied/);
	const tagless = checkCustodyFileTool(
		{ toolName: "edit", input: { input: "[data/owners.json]\nPUT >$:\n+x\n" } },
		policy(),
		ROOT,
		ROOT,
	);
	expect(tagless?.reason).toMatch(/opaque edit payload denied/);
	const twoHeaders = checkCustodyFileTool(
		{ toolName: "edit", input: { input: "[src/notes.ts#1A2B]\nPUT >$:\n+x\n[data/owners.json#2B3C]\nPUT >$:\n+y\n" } },
		policy(),
		ROOT,
		ROOT,
	);
	expect(twoHeaders?.reason).toMatch(/held path denied/);
	const mv = checkCustodyFileTool(
		{ toolName: "edit", input: { input: "[src/notes.ts#1A2B]\nMV src/notes.ts data/owners.json\n" } },
		policy(),
		ROOT,
		ROOT,
	);
	expect(mv?.reason).toMatch(/held path denied/);
	expect(parseHashlineTargets(42)).toMatchObject({ kind: "opaque" });
});

test("CUSTODY1: ntm wait forms ALLOWED as read-only; send/spawn/kill still DENIED", () => {
	expect(isReadOnlyCustodyBash("ntm wait --help")).toBe(true);
	expect(isReadOnlyCustodyBash("ntm wait --pane=1 --until=complete --timeout=60s --json")).toBe(true);
	expect(isReadOnlyCustodyBash("ntm status --help")).toBe(true);
	expect(isReadOnlyCustodyBash("ntm send cfsios --panes=1 hi")).toBe(false);
	expect(checkCustodyBash({ command: "ntm kill cfsios" }, policy())?.reason).toMatch(/mutating command denied/);
	expect(checkCustodyBash({ command: "ntm spawn worker" }, policy())?.reason).toMatch(/mutating command denied/);
	expect(checkCustodyBash({ command: "tmux kill-server" }, policy())?.reason).toMatch(/mutating command denied/);
	expect(checkCustodyBash({ command: "ntm wait --pane=1 --until=complete" }, policy())).toBeUndefined();
});

test("CUSTODY1: read-only tracker queries need no lease; writes denied; import/export refused", () => {
	for (const cmd of ["br list --json", "br show ompkit-1", "br ready", "bv --robot-list"]) {
		expect(checkCustodyTracker({ command: cmd, cwd: ROOT }, policy(), WORKER, ROOT, git())).toBeUndefined();
	}
	expect(checkCustodyTracker({ command: "br update ompkit-1 --claim", cwd: ROOT }, policy(), WORKER, ROOT, git())?.reason)
		.toMatch(/without an exact lease denied/);
	expect(checkCustodyTracker({ command: "br close ompkit-1", cwd: ROOT }, policy(), WORKER, ROOT, git())?.reason)
		.toMatch(/without an exact lease denied/);
	expect(checkCustodyTracker({ command: "br export --file /tmp/x", cwd: ROOT }, policy(), DIRECTOR, ROOT, git())?.reason)
		.toMatch(/import\/export flags refused/);
	expect(checkCustodyTracker({ command: "br update ompkit-1 --claim", cwd: "/elsewhere" }, policy(), WORKER, ROOT, git())?.reason)
		.toMatch(/foreign repo or DB refused/);
	expect(checkCustodyTracker(
		{ command: "br handoff add --path data/owners.json --commit abc --bead b --import x", cwd: ROOT },
		policy(), DIRECTOR, ROOT, git())?.reason).toMatch(/import\/export flags refused/);
});

test("CUSTODY1: guard probe shows the new row ALLOWED and an unrelated held path still DENIED", () => {
	const withRow = policy({ ownerHandoffs: [{ path: "data/owners.json", blob: BLOB, commit: "abc123", bead: "ompkit-1", signedBy: "RusticPine" }] });
	const probe = createCustodyToolCallHandler(withRow, { actor: DIRECTOR, git: git() });
	const allowed = probe({ toolName: "read", input: { path: "data/owners.json" } });
	expect(allowed.verdict).toBe("ALLOWED");
	expect(allowed.reason).toMatch(/digest-bound handoff row allows/);
	const heldElsewhere = createCustodyToolCallHandler(
		policy({ heldPaths: ["data/owners.json", "data/other.json"] }),
		{ actor: DIRECTOR, git: git() },
	);
	const denied = heldElsewhere({ toolName: "write", input: { path: "data/other.json" } });
	expect(denied.verdict).toBe("DENIED");
	expect(denied.reason).toMatch(/held path denied/);
});

test("CUSTODY1: digest-checked director apply replaces guard code with undo; negatives refused", () => {
	const undos: { project: string; beforeSha256: string; afterSha256: string }[] = [];
	const source = "new guard bytes";
	const digest = createHash("sha256").update(source, "utf8").digest("hex");
	const ok = applyProjectGuard(
		{ project: "P", fromCommit: "abc123", expectSha256: digest, sourceBytes: source, callerIsDirector: true },
		"old guard bytes",
		(u) => undos.push(u),
	);
	expect(ok.ok).toBe(true);
	expect(undos).toHaveLength(1);
	expect(undos[0].beforeSha256).not.toBe(undos[0].afterSha256);
	const workerDenied = applyProjectGuard(
		{ project: "P", fromCommit: "abc123", expectSha256: digest, sourceBytes: source, callerIsDirector: false },
		"old", () => { throw new Error("must not record undo"); },
	);
	expect(workerDenied.ok).toBe(false);
	expect(workerDenied.reason).toMatch(/worker identity refused/);
	const drift = applyProjectGuard(
		{ project: "P", fromCommit: "abc123", expectSha256: "0".repeat(64), sourceBytes: source, callerIsDirector: true },
		"old", () => { throw new Error("must not record undo"); },
	);
	expect(drift.ok).toBe(false);
	expect(drift.reason).toMatch(/digest mismatch refused/);
});

test("CUSTODY1: doctor reports a stale loaded guard; fresh matches pass", () => {
	expect(doctorStaleGuard("aaa", "bbb").stale).toBe(true);
	expect(doctorStaleGuard(undefined, "bbb").stale).toBe(true);
	expect(doctorStaleGuard("bbb", "bbb").stale).toBe(false);
});
