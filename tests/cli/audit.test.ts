import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyRulePlan, planRules } from "../../src/apply-rules.ts";
import { audit, undo, why } from "../../src/audit.ts";
import { applyMutation, planMutation, recoverMutation } from "../../src/mutations.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");
function fixture(run: (f: { home: string; source: string; state: string; rules: string; directory: string }) => void): void {
	mkdirSync(scratch, { recursive: true });
	const directory = mkdtempSync(join(scratch, "audit-"));
	const home = join(directory, "home"), source = join(directory, "source"), rules = join(home, ".agents", "rules");
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(source, "rules"), { recursive: true });
	mkdirSync(join(source, "retired"));
	mkdirSync(home);
	const text = "kit original\n";
	writeFileSync(join(source, "rules", "alpha.md"), text);
	writeFileSync(join(source, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nalpha\t${createHash("sha256").update(text).digest("hex")}\treminder\tabcdef0\n`);
	try { run({ home, source, state, rules, directory }); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function install(f: { home: string; source: string }) {
	return applyRulePlan(planRules({ root: f.source, home: f.home }), { confirmed: true });
}

test("real rule install appears in redacted chronology and undo restores the original HOME", () => fixture(f => {
	const receipt = install(f);
	const id = receipt.id!;
	const rows = audit(f.state);
	expect(rows.map(row => [row.id, row.status])).toEqual([[id, "APPLIED"]]);
	const detail = why(f.state, id);
	expect(detail.files.map(file => [file.root, file.name, file.action])).toEqual([
		["home", ".agents/rules/<rule>.md", "CREATED"], ["home", ".agents/omp-kit-ownership.json", "CREATED"],
	]);
	const publicData = JSON.stringify({ rows, detail });
	expect(publicData).not.toContain(f.directory);
	expect(publicData).not.toContain("kit original");
	expect(publicData).not.toContain(createHash("sha256").update("kit original\n").digest("hex"));
	expect(publicData).not.toContain(".bak");
	const restored = undo(f.state, id, { confirmed: true });
	expect(restored.status).toBe("RESTORED");
	expect(restored.id).not.toBe(id);
	expect(existsSync(join(f.rules, "alpha.md"))).toBe(false);
	expect(existsSync(join(f.home, ".agents", "omp-kit-ownership.json"))).toBe(false);
	expect(why(f.state, id).status).toBe("RESTORED");
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/ALREADY_UNDONE/);
}));

test("audit does not claim restored state after the inverse postimage drifts", () => fixture(f => {
	const id = install(f).id!;
	const inverse = undo(f.state, id, { confirmed: true });
	mkdirSync(join(f.home, ".agents"), { recursive: true });
	writeFileSync(join(f.home, ".agents", "omp-kit-ownership.json"), "out-of-band");
	expect(why(f.state, inverse.id).current).toBe("DRIFT");
	expect(why(f.state, id).status).not.toBe("RESTORED");
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/ALREADY_UNDONE/);
}));
test("audit marks recreated original directories as drift after a previously completed inverse", () => fixture(f => {
	const id = install(f).id!;
	const inverse = undo(f.state, id, { confirmed: true });
	mkdirSync(f.rules, { recursive: true });
	expect(why(f.state, inverse.id).current).toBe("DRIFT");
	expect(why(f.state, id).status).toBe("DRIFT");
}));

test("corrupted receipt cannot remove an unrelated empty private directory", () => fixture(f => {
	const id = install(f).id!;
	const unrelated = join(f.directory, "unrelated-private");
	mkdirSync(unrelated, { mode: 0o700 });
	const path = join(f.state, "receipts", `${id}.json`);
	const receipt = JSON.parse(readFileSync(path, "utf8")) as { createdDirectories: string[] };
	receipt.createdDirectories.push(unrelated);
	writeFileSync(path, JSON.stringify(receipt));
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/STATE_UNSAFE/);
	expect(existsSync(unrelated)).toBe(true);
	expect(existsSync(join(f.rules, "alpha.md"))).toBe(true);
}));
test("forged receipt cannot claim a pre-existing empty target ancestor as created", () => fixture(f => {
	mkdirSync(f.rules, { recursive: true, mode: 0o700 });
	const id = install(f).id!;
	const path = join(f.state, "receipts", `${id}.json`);
	const receipt = JSON.parse(readFileSync(path, "utf8")) as { createdDirectories: string[] };
	expect(receipt.createdDirectories).toEqual([]);
	receipt.createdDirectories.push(f.rules);
	writeFileSync(path, JSON.stringify(receipt));
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/STATE_UNSAFE|BACKUP_CORRUPT/);
	expect(existsSync(f.rules)).toBe(true);
	expect(readFileSync(join(f.rules, "alpha.md"), "utf8")).toBe("kit original\n");
}));


test("a killed writer's durable after-image can be reconciled instead of leaving a permanent lock", () => fixture(f => {
	const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "mutation-crash-fixture.ts"), f.state, f.home], {
		cwd: f.directory, env: { ...process.env, HOME: f.home, TMPDIR: f.directory },
		stdout: "pipe", stderr: "pipe",
	});
	expect(child.exitCode).not.toBe(0);
	expect(readFileSync(join(f.home, "crash-probe.txt"), "utf8")).toBe("committed after rename\n");
	const [pending] = readdirSync(join(f.state, "pending"));
	expect(pending).toMatch(/^[a-f0-9-]+\.json$/);
	const id = pending!.slice(0, -".json".length);
	expect(why(f.state, id).status).toBe("AFTER");
	expect(recoverMutation(f.state, id)).toEqual({ id, state: "COMPLETED_AFTER" });
	expect(why(f.state, id).status).toBe("COMPLETED_AFTER");
}));


test("a killed inverse reconciles original newly created directories before declaring RESTORED", () => fixture(f => {
	const id = install(f).id!;
	const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "mutation-crash-fixture.ts"), f.state, f.home, id], {
		cwd: f.directory, env: { ...process.env, HOME: f.home, TMPDIR: f.directory },
		stdout: "pipe", stderr: "pipe",
	});
	expect(child.exitCode).not.toBe(0);
	expect(existsSync(join(f.rules, "alpha.md"))).toBe(false);
	expect(existsSync(f.rules)).toBe(true);
	const [pending] = readdirSync(join(f.state, "pending"));
	expect(pending).toMatch(/^[a-f0-9-]+\.json$/);
	const inverseId = pending!.slice(0, -".json".length);
	expect(why(f.state, id).status).toBe("UNDO_PARTIAL");
	expect(recoverMutation(f.state, inverseId)).toEqual({ id: inverseId, state: "COMPLETED_AFTER" });
	expect(why(f.state, id).status).toBe("RESTORED");
	expect(existsSync(f.rules)).toBe(false);
	expect(existsSync(join(f.home, ".agents"))).toBe(false);
}));

test("audit hides private profile path segments and arbitrary file names", () => fixture(f => {
	const privateProfile = "customer-account-735";
	const path = join(f.home, ".omp", "profiles", privateProfile, "agent");
	mkdirSync(path, { recursive: true });
	const receipt = applyMutation(planMutation({ stateRoot: f.state, roots: [{ id: "home", path: f.home }], files: [
		{ root: "home", relativePath: `.omp/profiles/${privateProfile}/agent/config.yml`,
			expectedBefore: null, after: { bytes: Buffer.from("secret customer config"), mode: 0o600 } },
		{ root: "home", relativePath: "customer-private-record.txt", expectedBefore: null,
			after: { bytes: Buffer.from("secret document"), mode: 0o600 } },
		{ root: "home", relativePath: ".agents/rules/customer-private-case.md", expectedBefore: null,
			after: { bytes: Buffer.from("secret rule"), mode: 0o600 } },
	] }));
	const result = why(f.state, receipt.id);
	expect(result.files.map(file => file.name)).toEqual([
		".omp/profiles/<profile>/agent/config.yml", "<private-path>", ".agents/rules/<rule>.md",
	]);
	expect(JSON.stringify(audit(f.state))).not.toContain(privateProfile);
	expect(JSON.stringify(result)).not.toContain("customer-private-record");
	expect(JSON.stringify(result)).not.toContain("customer-private-case");
	expect(JSON.stringify(result)).not.toContain("secret customer config");
}));

test("undo restores binary preimage, original mode and a deleted file", () => fixture(f => {
	mkdirSync(f.rules, { recursive: true });
	const first = join(f.rules, "first.md"), second = join(f.rules, "retired.md");
	const original = Buffer.from([0, 255, 42, 0]);
	writeFileSync(first, original, { mode: 0o640 });
	writeFileSync(second, "retired\n", { mode: 0o600 });
	const image = (path: string) => {
		const bytes = readFileSync(path), info = lstatSync(path);
		return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
	};
	const result = applyMutation(planMutation({ stateRoot: f.state, roots: [{ id: "rules", path: f.rules }], files: [
		{ root: "rules", relativePath: "first.md", expectedBefore: image(first), after: { bytes: Buffer.from("new"), mode: 0o600 } },
		{ root: "rules", relativePath: "retired.md", expectedBefore: image(second), after: null },
	] }));
	undo(f.state, result.id, { confirmed: true });
	expect(readFileSync(first)).toEqual(original);
	expect(lstatSync(first).mode & 0o7777).toBe(0o640);
	expect(readFileSync(second, "utf8")).toBe("retired\n");
	expect(lstatSync(second).mode & 0o7777).toBe(0o600);
}));

test("changed target or backup refuses before touching any target", () => fixture(f => {
	const id = install(f).id!;
	const rule = join(f.rules, "alpha.md"), owner = join(f.home, ".agents", "omp-kit-ownership.json");
	chmodSync(rule, 0o600);
	expect(why(f.state, id).current).toBe("DRIFT");
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(lstatSync(rule).mode & 0o7777).toBe(0o600);
	expect(existsSync(owner)).toBe(true);
	chmodSync(rule, 0o644);
	// A second fixture with a real replaced preimage exercises the private backup check.
	const owned = readFileSync(rule), stat = lstatSync(rule);
	const updated = applyMutation(planMutation({ stateRoot: f.state, roots: [{ id: "rules", path: f.rules }], files: [
		{ root: "rules", relativePath: "alpha.md", expectedBefore: {
			sha256: createHash("sha256").update(owned).digest("hex"), size: owned.length,
			mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid,
		}, after: { bytes: Buffer.from("changed by kit"), mode: 0o600 } },
	] }));
	writeFileSync(join(f.state, "backups", updated.id, "0.bak"), "corrupt");
	expect(() => undo(f.state, updated.id, { confirmed: true })).toThrow(/BACKUP_CORRUPT/);
	expect(readFileSync(rule, "utf8")).toBe("changed by kit");
	expect(existsSync(owner)).toBe(true);
}));

test("pending mixed mutation is visible and refuses undo without implied rollback", () => fixture(f => {
	mkdirSync(f.rules, { recursive: true });
	const plan = planMutation({ stateRoot: f.state, roots: [{ id: "rules", path: f.rules }], files: [
		{ root: "rules", relativePath: "one.md", expectedBefore: null, after: { bytes: Buffer.from("one"), mode: 0o600 } },
		{ root: "rules", relativePath: "two.md", expectedBefore: null, after: { bytes: Buffer.from("two"), mode: 0o600 } },
	] });
	expect(() => applyMutation(plan, { onBoundary: boundary => { if (boundary === "renamed:0") throw new Error("simulated interruption"); } })).toThrow();
	const [pending] = audit(f.state);
	expect(pending?.status).toBe("PARTIAL");
	expect(why(f.state, pending!.id).status).toBe("PARTIAL");
	expect(() => undo(f.state, pending!.id, { confirmed: true })).toThrow(/PENDING_RECOVERY/);
	expect(readFileSync(join(f.rules, "one.md"), "utf8")).toBe("one");
	expect(existsSync(join(f.rules, "two.md"))).toBe(false);
	expect(readdirSync(join(f.state, "pending"))).toEqual([`${pending!.id}.json`]);
}));

test("interrupted undo records a partial inverse and keeps the restored fragment visible", () => fixture(f => {
	const id = install(f).id!;
	expect(() => undo(f.state, id, { confirmed: true, onBoundary: boundary => {
		if (boundary === "renamed:0") throw new Error("simulated interrupted inverse");
	} })).toThrow(/MUTATION_FAILED/);
	expect(existsSync(join(f.rules, "alpha.md"))).toBe(false);
	expect(existsSync(join(f.home, ".agents", "omp-kit-ownership.json"))).toBe(true);
	expect(why(f.state, id).status).toBe("UNDO_PARTIAL");
	const inverse = audit(f.state).find(row => row.undoOf === id);
	expect(inverse?.status).toBe("PARTIAL");
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/PENDING_RECOVERY/);
}));

test("undo refuses during another writer's held mutation lock", () => fixture(f => {
	const id = install(f).id!;
	const staged = planMutation({ stateRoot: f.state, roots: [{ id: "rules", path: f.rules }], files: [
		{ root: "rules", relativePath: "other.md", expectedBefore: null, after: { bytes: Buffer.from("other"), mode: 0o600 } },
	] });
	applyMutation(staged, { onBoundary: boundary => {
		if (boundary !== "pending-synced") return;
		expect(() => undo(f.state, id, { confirmed: true })).toThrow(/LOCK_BUSY/);
		expect(readFileSync(join(f.rules, "alpha.md"), "utf8")).toBe("kit original\n");
	} });
	expect(readFileSync(join(f.rules, "other.md"), "utf8")).toBe("other");
}));

test("symlink ancestor blocks undo without following external content", () => fixture(f => {
	const id = install(f).id!;
	const outside = join(f.directory, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "alpha.md"), "outside private content");
	rmSync(f.rules, { recursive: true });
	symlinkSync(outside, f.rules);
	expect(() => undo(f.state, id, { confirmed: true })).toThrow(/UNSAFE_PATH|FRESH_PLAN/);
	expect(readFileSync(join(outside, "alpha.md"), "utf8")).toBe("outside private content");
}));

test("compiled apply to audit and why to byte-verified undo never exposes HOME or private backup contents", () => fixture(f => {
	mkdirSync(join(f.source, "bin"), { recursive: true });
	const binary = join(f.source, "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", binary], {
		cwd: f.directory, stdout: "pipe", stderr: "pipe",
	});
	expect(build.exitCode).toBe(0);
	const run = (args: string[]) => {
		const child = Bun.spawnSync([binary, ...args, "--json"], {
			cwd: f.source, env: { ...process.env, HOME: f.home,
				XDG_STATE_HOME: join(f.home, ".local", "state"), XDG_CACHE_HOME: join(f.directory, "cache") },
			stdout: "pipe", stderr: "pipe",
		});
		return { code: child.exitCode, raw: child.stdout.toString() + child.stderr.toString(),
			envelope: JSON.parse(child.stdout.toString()) };
	};
	const installed = run(["apply", "rules", "--apply", "--yes"]);
	expect(installed.code).toBe(0);
	const id = installed.envelope.data.receipt_id as string;
	expect(readFileSync(join(f.rules, "alpha.md"), "utf8")).toBe("kit original\n");
	const chronology = run(["audit"]);
	expect(chronology.code).toBe(0);
	expect(chronology.envelope.data.receipts).toEqual([expect.objectContaining({ id, status: "APPLIED" })]);
	const explanation = run(["why", id]);
	expect(explanation.code).toBe(0);
	expect(explanation.envelope.data.receipt.files).toEqual(expect.arrayContaining([
		expect.objectContaining({ root: "home", name: ".agents/rules/<rule>.md", action: "CREATED" }),
	]));
	for (const report of [chronology.raw, explanation.raw]) {
		expect(report).not.toContain(f.directory);
		expect(report).not.toContain("kit original");
		expect(report).not.toContain(createHash("sha256").update("kit original\n").digest("hex"));
	}
	expect(run(["undo", id]).envelope.errors[0].code).toBe("CONSENT_REQUIRED");
	expect(readFileSync(join(f.rules, "alpha.md"), "utf8")).toBe("kit original\n");
	const restored = run(["undo", id, "--yes"]);
	expect(restored.code).toBe(0);
	expect(restored.envelope.data.status).toBe("RESTORED");
	expect(existsSync(join(f.rules, "alpha.md"))).toBe(false);
	expect(existsSync(join(f.home, ".agents", "omp-kit-ownership.json"))).toBe(false);
	expect(run(["why", id]).envelope.data.receipt.status).toBe("RESTORED");
	const repeated = run(["undo", id, "--yes"]);
	expect(repeated.code).toBe(2);
	expect(repeated.envelope.errors[0].code).toBe("ALREADY_UNDONE");
}));
