import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abortCompensatedKitUpdateReceipt, acquireKitUpdateLock, applyMutation, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate, inspectPendingMutations, planMutation, reconcileKitUpdateReceipt, recoverMutation } from "../../src/mutations.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");
function fixture(run: (root: string, state: string, target: string) => void): void {
	const isolated = mkdtempSync(join(scratch, "mutation-"));
	const target = join(isolated, "managed");
	const state = join(isolated, "state");
	mkdirSync(target);
	try { run(isolated, state, target); } finally { rmSync(isolated, { recursive: true, force: true }); }
}
function expectedBefore(file: string) {
	const info = lstatSync(file, { throwIfNoEntry: false });
	if (!info) return null;
	if (info.isSymbolicLink()) return null;
	const data = readFileSync(file);
	return { sha256: createHash("sha256").update(data).digest("hex"), size: data.length, mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
}
function plan(state: string, root: string, name: string, data: string) {
	return planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [{ root: "rules", relativePath: name, expectedBefore: expectedBefore(join(root, name)), after: { bytes: Buffer.from(data), mode: 0o600 } }] });
}

test("planning captures preimages without writing state or managed files", () => fixture((isolated, state, root) => {
	const file = join(root, "rule.md");
	writeFileSync(file, "old", { mode: 0o600 });
	const before = readdirSync(isolated).sort();
	const prepared = plan(state, root, "rule.md", "new");
	expect(prepared.files[0]?.before?.sha256).toBe("cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4");
	expect(prepared.files[0]?.after?.mode).toBe(0o600);
	expect(readdirSync(isolated).sort()).toEqual(before);
	expect(readFileSync(file, "utf8")).toBe("old");
	expect(JSON.stringify(prepared)).not.toContain("new");
}));

test("a fresh missing allowlisted root is planned without writes and created only after a pending receipt", () => fixture((isolated, state) => {
	const root = join(isolated, "fresh-home", ".agents", "rules");
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "nested/new.md", expectedBefore: null, after: { bytes: Buffer.from("managed"), mode: 0o600 } },
	] });
	expect(existsSync(join(isolated, "fresh-home"))).toBe(false);
	expect(existsSync(state)).toBe(false);
	const receipt = applyMutation(prepared, { onBoundary: boundary => {
		if (boundary === "pending-synced") expect(existsSync(root)).toBe(false);
	} });
	expect(readFileSync(join(root, "nested", "new.md"), "utf8")).toBe("managed");
	expect(lstatSync(root).mode & 0o077).toBe(0);
	expect(existsSync(join(state, "receipts", `${receipt.id}.json`))).toBe(true);
}));

test("fault after guarded directory creation leaves a pending receipt and recovery removes empty parents", () => fixture((isolated, state) => {
	const root = join(isolated, "fresh-home", ".omp", "omp-extensions");
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "extensions", path: root }], files: [
		{ root: "extensions", relativePath: "new.ts", expectedBefore: null, after: { bytes: Buffer.from("export {};"), mode: 0o600 } },
	] });
	expect(() => applyMutation(prepared, { onBoundary: boundary => {
		if (boundary === "directories-created") throw new Error("fault before first rename");
	} })).toThrow();
	expect(existsSync(root)).toBe(true);
	expect(existsSync(join(root, "new.ts"))).toBe(false);
	const [pending] = inspectPendingMutations(state);
	expect(pending?.state).toBe("BEFORE");
	expect(recoverMutation(state, pending!.id).state).toBe("ABORTED_BEFORE");
	expect(existsSync(join(isolated, "fresh-home"))).toBe(false);
	expect(inspectPendingMutations(state)).toEqual([]);
}));

test("recovery refuses an unmarked directory rather than deleting a possible bystander", () => fixture((isolated, state) => {
	const root = join(isolated, "fresh-home", "rules");
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "new.md", expectedBefore: null, after: { bytes: Buffer.from("new"), mode: 0o600 } },
	] });
	expect(() => applyMutation(prepared, { onBoundary: boundary => {
		if (boundary === "directories-created") throw new Error("fault");
	} })).toThrow();
	const [pending] = inspectPendingMutations(state);
	unlinkSync(join(root, `.omp-kit-create-${pending!.id}`));
	expect(() => recoverMutation(state, pending!.id)).toThrow(/PENDING_RECOVERY/);
	expect(existsSync(root)).toBe(true);
}));

test("new root swapped for a symlink after plan never writes outside allowlist", () => fixture((isolated, state) => {
	const root = join(isolated, "fresh-home", ".agents", "rules");
	const outside = join(isolated, "outside");
	mkdirSync(outside);
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "new.md", expectedBefore: null, after: { bytes: Buffer.from("new"), mode: 0o600 } },
	] });
	mkdirSync(join(isolated, "fresh-home", ".agents"), { recursive: true });
	symlinkSync(outside, root);
	expect(() => applyMutation(prepared)).toThrow(/FRESH_PLAN|UNSAFE_PATH/);
	expect(readdirSync(outside)).toEqual([]);
}));

test("stale bytes and stale ownership refuse before replacing a managed file", () => fixture((_isolated, state, root) => {
	const file = join(root, "rule.md");
	writeFileSync(file, "old", { mode: 0o600 });
	const owned = expectedBefore(file)!;
	expect(() => planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "rule.md", expectedBefore: { ...owned, uid: owned.uid + 1 }, after: { bytes: Buffer.from("new"), mode: 0o600 } },
	] })).toThrow(/FRESH_PLAN/);
	const prepared = plan(state, root, "rule.md", "new");
	writeFileSync(file, "changed");
	expect(() => applyMutation(prepared)).toThrow(/FRESH_PLAN/);
	expect(readFileSync(file, "utf8")).toBe("changed");
	writeFileSync(file, "old");
	chmodSync(file, 0o644);
	expect(() => applyMutation(prepared)).toThrow(/FRESH_PLAN/);
	expect(readFileSync(file, "utf8")).toBe("old");
}));

test("existing unmanaged target cannot be claimed by an absent-file plan", () => fixture((_isolated, state, root) => {
	const file = join(root, "existing.md");
	writeFileSync(file, "operator content");
	expect(() => planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "existing.md", expectedBefore: null, after: { bytes: Buffer.from("kit content"), mode: 0o600 } },
	] })).toThrow(/FRESH_PLAN/);
	expect(readFileSync(file, "utf8")).toBe("operator content");
}));

test("replacing a parent directory after planning cannot redirect a new file", () => fixture((_isolated, state, root) => {
	const folder = join(root, "sub");
	mkdirSync(folder);
	const prepared = plan(state, root, "sub/new.md", "managed");
	rmSync(folder, { recursive: true });
	mkdirSync(folder);
	expect(() => applyMutation(prepared)).toThrow(/FRESH_PLAN/);
	expect(readdirSync(folder)).toEqual([]);
}));

test("symlinked parent or target refuses without touching an outside file", () => fixture((isolated, state, root) => {
	const outside = join(isolated, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "rule.md"), "private");
	const inside = join(root, "sub");
	mkdirSync(inside);
	const prepared = plan(state, root, "sub/rule.md", "new");
	rmSync(inside, { recursive: true });
	symlinkSync(outside, inside);
	expect(() => applyMutation(prepared)).toThrow(/FRESH_PLAN|UNSAFE_PATH/);
	expect(readFileSync(join(outside, "rule.md"), "utf8")).toBe("private");
	const link = join(root, "target.md");
	symlinkSync(join(outside, "rule.md"), link);
	expect(() => plan(state, root, "target.md", "new")).toThrow(/UNSAFE_PATH/);
}));

test("insufficient capacity refuses before file or receipt mutation", () => fixture((_isolated, state, root) => {
	const file = join(root, "rule.md");
	writeFileSync(file, "original");
	const prepared = plan(state, root, "rule.md", "replacement");
	expect(() => applyMutation(prepared, { freeBytes: () => 0 })).toThrow(/INSUFFICIENT_SPACE/);
	expect(readFileSync(file, "utf8")).toBe("original");
	expect(inspectPendingMutations(state)).toEqual([]);
	expect(existsSync(state)).toBe(false);
}));

test("successful replacement preserves a private byte-exact backup and a receipt", () => fixture((_isolated, state, root) => {
	const file = join(root, "rule.md");
	writeFileSync(file, Buffer.from([0, 255, 42]), { mode: 0o600 });
	const receipt = applyMutation(plan(state, root, "rule.md", "replacement"));
	expect(readFileSync(file, "utf8")).toBe("replacement");
	expect(lstatSync(file).mode & 0o777).toBe(0o600);
	const backup = join(state, "backups", receipt.id, "0.bak");
	expect(readFileSync(backup)).toEqual(Buffer.from([0, 255, 42]));
	expect(lstatSync(backup).mode & 0o077).toBe(0);
	expect(lstatSync(join(state, "receipts", `${receipt.id}.json`)).mode & 0o077).toBe(0);
	expect(inspectPendingMutations(state)).toEqual([]);
}));

test("deleting a matching file removes only its path and retains its private original", () => fixture((_isolated, state, root) => {
	const file = join(root, "old.md");
	writeFileSync(file, "retired bytes");
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "old.md", expectedBefore: expectedBefore(file), after: null },
	] });
	const receipt = applyMutation(prepared);
	expect(existsSync(file)).toBe(false);
	expect(readFileSync(join(state, "backups", receipt.id, "0.bak"), "utf8")).toBe("retired bytes");
	expect(inspectPendingMutations(state)).toEqual([]);
}));

test("simultaneous writers and nested update locks cannot bypass held owner", () => fixture((_isolated, state, root) => {
	const first = plan(state, root, "a.md", "first");
	const second = plan(state, root, "b.md", "second");
	applyMutation(first, { onBoundary: boundary => {
		if (boundary !== "pending-synced") return;
		expect(() => applyMutation(second)).toThrow(/LOCK_BUSY/);
	} });
	expect(readFileSync(join(root, "a.md"), "utf8")).toBe("first");
	const lock = acquireKitUpdateLock(state);
	try {
		expect(() => acquireKitUpdateLock(state)).toThrow(/LOCK_BUSY/);
		const same = acquireKitUpdateLock(state, lock);
		expect(same).toBe(lock);
		expect(() => acquireKitUpdateLock(join(root, "other"), lock)).toThrow(/LOCK_TOKEN/);
	} finally { lock.release(); }
	expect(() => acquireKitUpdateLock(state, lock)).toThrow(/LOCK_TOKEN/);
	const next = acquireKitUpdateLock(state);
	next.release();
}));

test("external updater must reconcile a fsynced pending record before retry after interruption", () => fixture((_isolated, state) => {
	const initial = { scope: "omp" as const, identitySha256: "a".repeat(64), kitVersion: "1.0", ompVersion: "2.0", channel: "npm" };
	const held = acquireKitUpdateLock(state);
	let id = "";
	try { id = beginKitUpdateReceipt(state, held, initial).id; } finally { held.release(); }
	expect(inspectPendingKitUpdate(state)?.id).toBe(id);
	const resumed = acquireKitUpdateLock(state);
	try {
		expect(() => beginKitUpdateReceipt(state, resumed, initial)).toThrow(/PENDING_RECOVERY/);
		expect(() => reconcileKitUpdateReceipt(state, resumed, id, () => false)).toThrow(/PENDING_RECOVERY/);
		expect(inspectPendingKitUpdate(state)?.id).toBe(id);
		expect(reconcileKitUpdateReceipt(state, resumed, id, () => true)).toEqual({ id, state: "RECONCILED" });
		expect(inspectPendingKitUpdate(state)).toBeNull();
	} finally { resumed.release(); }
}));

test("failed kit post-check can only finish as compensated after a real postimage rescan", () => fixture((_isolated, state, root) => {
	const link = join(root, "kit-link");
	writeFileSync(link, "prior", { mode: 0o600 });
	const heldLock = acquireKitUpdateLock(state);
	try {
		const metadata = { scope: "kit" as const, identitySha256: "a".repeat(64), kitVersion: "1.2.2", ompVersion: null, channel: null };
		const id = beginKitUpdateReceipt(state, heldLock, metadata).id;
		expect(() => abortCompensatedKitUpdateReceipt(state, heldLock, id, () => false)).toThrow(/PENDING_RECOVERY/);
		expect(inspectPendingKitUpdate(state)?.id).toBe(id);
		expect(abortCompensatedKitUpdateReceipt(state, heldLock, id,
			() => readFileSync(link, "utf8") === "prior")).toEqual({ id, state: "ABORTED_AFTER_COMPENSATION" });
		expect(inspectPendingKitUpdate(state)).toBeNull();
		expect(auditMutations(state)).toEqual(expect.arrayContaining([
			expect.objectContaining({ id, kind: "update", status: "ABORTED_AFTER_COMPENSATION", scope: "kit" }),
		]));
		expect(() => abortCompensatedKitUpdateReceipt(state, heldLock, id, () => true)).toThrow(/PENDING_RECOVERY/);
	} finally { heldLock.release(); }
}));

test("an all-scope receipt cannot be marked compensated by only a kit rollback", () => fixture((_isolated, state) => {
	const heldLock = acquireKitUpdateLock(state);
	try {
		const id = beginKitUpdateReceipt(state, heldLock, { scope: "all", identitySha256: "b".repeat(64),
			kitVersion: "1.2.2", ompVersion: "18.4.2", channel: "stable" }).id;
		expect(() => abortCompensatedKitUpdateReceipt(state, heldLock, id, () => true)).toThrow(/PENDING_RECOVERY/);
		expect(inspectPendingKitUpdate(state)?.id).toBe(id);
	} finally { heldLock.release(); }
}));

test("fault after first rename survives restart, refuses new writes, and only reconciles known final images", () => fixture((_isolated, state, root) => {
	const old = join(root, "first.md");
	writeFileSync(old, "before", { mode: 0o600 });
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "first.md", expectedBefore: expectedBefore(old), after: { bytes: Buffer.from("after"), mode: 0o600 } },
		{ root: "rules", relativePath: "second.md", expectedBefore: null, after: { bytes: Buffer.from("second"), mode: 0o600 } },
	] });
	expect(() => applyMutation(prepared, { onBoundary: boundary => { if (boundary === "renamed:0") throw new Error("simulated process death"); } })).toThrow();
	expect(readFileSync(old, "utf8")).toBe("after");
	expect(readdirSync(root).sort()).toEqual(["first.md"]);
	const pending = inspectPendingMutations(state);
	expect(pending).toHaveLength(1);
	expect(pending[0]?.state).toBe("PARTIAL");
	expect(() => applyMutation(plan(state, root, "third.md", "third"))).toThrow(/PENDING_RECOVERY/);
	expect(() => recoverMutation(state, pending[0]!.id)).toThrow(/PENDING_RECOVERY/);
	writeFileSync(old, "before", { mode: 0o600 });
	expect(recoverMutation(state, pending[0]!.id).state).toBe("ABORTED_BEFORE");
	applyMutation(plan(state, root, "third.md", "third"));
	expect(readFileSync(join(root, "third.md"), "utf8")).toBe("third");
	expect(lstatSync(state).mode & 0o077).toBe(0);
}));

test("a fault after the only rename can be reconciled without rewriting its accepted postimage", () => fixture((_isolated, state, root) => {
	const prepared = plan(state, root, "new.md", "postimage");
	expect(() => applyMutation(prepared, { onBoundary: boundary => { if (boundary === "renamed:0") throw new Error("stop"); } })).toThrow();
	const [pending] = inspectPendingMutations(state);
	expect(pending?.state).toBe("AFTER");
	expect(recoverMutation(state, pending!.id).state).toBe("COMPLETED_AFTER");
	expect(readFileSync(join(root, "new.md"), "utf8")).toBe("postimage");
	expect(inspectPendingMutations(state)).toEqual([]);
}));

test("a post-rename restart keeps new managed parents and clears their provenance markers", () => fixture((isolated, state) => {
	const root = join(isolated, "fresh-home", "rules");
	const prepared = planMutation({ stateRoot: state, roots: [{ id: "rules", path: root }], files: [
		{ root: "rules", relativePath: "new.md", expectedBefore: null, after: { bytes: Buffer.from("postimage"), mode: 0o600 } },
	] });
	expect(() => applyMutation(prepared, { onBoundary: boundary => {
		if (boundary === "renamed:0") throw new Error("stop");
	} })).toThrow();
	const [pending] = inspectPendingMutations(state);
	expect(pending?.state).toBe("AFTER");
	expect(recoverMutation(state, pending!.id).state).toBe("COMPLETED_AFTER");
	expect(readdirSync(root)).toEqual(["new.md"]);
	expect(readFileSync(join(root, "new.md"), "utf8")).toBe("postimage");
}));

test("failure messages and JSON diagnostics never include private bytes", () => fixture((_isolated, state, root) => {
	writeFileSync(join(root, "private.md"), "secret-marker-do-not-echo");
	const prepared = plan(state, root, "private.md", "replaced");
	writeFileSync(join(root, "private.md"), "secret-marker-do-not-echo-edited");
	let message = "";
	try { applyMutation(prepared); } catch (error) { message = JSON.stringify({ error: String(error) }); }
	expect(message).toContain("FRESH_PLAN");
	expect(message).not.toContain("secret-marker-do-not-echo");
}));
