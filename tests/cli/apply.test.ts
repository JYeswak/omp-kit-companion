import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { diagnose } from "../../src/diagnostics.ts";
import { applyRulePlan, planRules } from "../../src/apply-rules.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function fixture(run: (f: { root: string; home: string; rules: string; state: string; installed: string }) => void): void {
	mkdirSync(scratch, { recursive: true });
	const dir = mkdtempSync(join(scratch, "apply-rules-"));
	const root = join(dir, "release"), home = join(dir, "home"), rules = join(root, "rules"), installed = join(home, ".agents", "rules"), state = join(home, ".local", "state", "omp-kit");
	mkdirSync(rules, { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(home);
	writeFileSync(join(rules, "alpha.md"), "kit original\n");
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nalpha\t${hash("kit original\n")}\treminder\tabcdef0\n`);
	try { run({ root, home, rules, state, installed }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function retireAlpha(f: { root: string; rules: string }): void {
	rmSync(join(f.rules, "alpha.md"));
	writeFileSync(join(f.rules, "beta.md"), "replacement\n");
	writeFileSync(join(f.root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nbeta\t${hash("replacement\n")}\treminder\tabcdef0\n`);
	writeFileSync(join(f.root, "retired", "alpha.md"), "retired description");
}
function snapshot(path: string): string[] {
	if (!existsSync(path)) return [];
	return readdirSync(path, { recursive: true }).map(String).sort();
}

test("plan observes absent destination and leaves all HOME paths unchanged", () => fixture(f => {
	const before = snapshot(f.home);
	const plan = planRules({ root: f.root, home: f.home });
	expect(plan.entries.map(e => [e.name, e.action])).toEqual([["alpha", "install"]]);
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.installed)).toBe(false);
	expect(existsSync(f.state)).toBe(false);
}));

test("a selected private XDG state root owns the receipt without creating a competing default root", () => fixture(f => {
	const stateRoot = join(f.root, "..", "custom-state");
	const plan = planRules({ root: f.root, home: f.home, stateRoot });
	const receipt = applyRulePlan(plan, { confirmed: true });
	expect(receipt.id).toEqual(expect.any(String));
	expect(existsSync(join(stateRoot, "receipts", `${receipt.id}.json`))).toBe(true);
	expect(existsSync(f.state)).toBe(false);
}));

test("private receipts cannot be placed inside the managed rule directory or release source", () => fixture(f => {
	const before = snapshot(f.home);
	for (const stateRoot of [f.installed, join(f.installed, "receipts"), join(f.home, ".agents"), f.root]) {
		expect(() => planRules({ root: f.root, home: f.home, stateRoot })).toThrow(/UNSAFE_PATH/);
		expect(snapshot(f.home)).toEqual(before);
	}
}));

test("a direct apply without explicit consent is rejected before creating state", () => fixture(f => {
	const plan = planRules({ root: f.root, home: f.home });
	expect(() => applyRulePlan(plan, {} as { confirmed: true })).toThrow(/INVALID_PLAN/);
	expect(existsSync(f.state)).toBe(false);
	expect(existsSync(f.installed)).toBe(false);
}));

test("apply installs only named rules, records ownership outside rule directory, and preserves exact repeat", () => fixture(f => {
	const first = planRules({ root: f.root, home: f.home });
	const receipt = applyRulePlan(first, { confirmed: true });
	expect(receipt.status).toBe("APPLIED");
	expect(receipt.files).toBe(2); // rule and separately guarded ownership record
	expect(readFileSync(join(f.installed, "alpha.md"), "utf8")).toBe("kit original\n");
	expect(readdirSync(f.installed)).toEqual(["alpha.md"]);
	expect(existsSync(join(f.state, "receipts", `${receipt.id}.json`))).toBe(true);
	const owned = join(f.home, ".agents", "omp-kit-ownership.json");
	expect(JSON.parse(readFileSync(owned, "utf8")).rules.alpha.sha256).toBe(hash("kit original\n"));
	expect(lstatSync(owned).mode & 0o077).toBe(0);
	const timestamp = new Date("2020-01-01T00:00:00.000Z");
	utimesSync(join(f.installed, "alpha.md"), timestamp, timestamp);
	const before = { files: snapshot(f.home), record: readFileSync(owned), ruleMtime: lstatSync(join(f.installed, "alpha.md")).mtimeMs, recordMtime: lstatSync(owned).mtimeMs, receipts: snapshot(join(f.state, "receipts")) };
	expect(applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true })).toEqual({ status: "UNCHANGED", files: 0, id: null });
	expect(snapshot(f.home)).toEqual(before.files);
	expect(readFileSync(owned)).toEqual(before.record);
	expect(lstatSync(join(f.installed, "alpha.md")).mtimeMs).toBe(before.ruleMtime);
	expect(lstatSync(owned).mtimeMs).toBe(before.recordMtime);
	expect(snapshot(join(f.state, "receipts"))).toEqual(before.receipts);
}));

test("different unowned managed-name collision refuses all changes", () => fixture(f => {
	mkdirSync(f.installed, { recursive: true });
	writeFileSync(join(f.installed, "alpha.md"), "operator rule\n");
	const plan = planRules({ root: f.root, home: f.home });
	expect(plan.entries.map(e => e.action)).toEqual(["collision"]);
	expect(() => applyRulePlan(plan, { confirmed: true })).toThrow(/RULE_COLLISION/);
	expect(readFileSync(join(f.installed, "alpha.md"), "utf8")).toBe("operator rule\n");
	expect(existsSync(f.state)).toBe(false);
}));

test("identical unowned remains unowned through repeat and subsequent retirement", () => fixture(f => {
	mkdirSync(f.installed, { recursive: true });
	writeFileSync(join(f.installed, "alpha.md"), "kit original\n");
	const file = join(f.installed, "alpha.md"), originalMtime = lstatSync(file).mtimeMs;
	for (let i = 0; i < 2; i++) {
		expect(planRules({ root: f.root, home: f.home }).entries[0]?.action).toBe("unowned-identical");
		expect(applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true }).status).toBe("UNCHANGED");
	}
	expect(existsSync(join(f.home, ".agents", "omp-kit-ownership.json"))).toBe(false);
	expect(lstatSync(file).mtimeMs).toBe(originalMtime);
	retireAlpha(f);
	expect(planRules({ root: f.root, home: f.home }).entries[0]?.action).toBe("unowned-retired");
	expect(applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true }).status).toBe("APPLIED");
	expect(applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true }).status).toBe("UNCHANGED");
	expect(readFileSync(file, "utf8")).toBe("kit original\n");
}));

test("owned unchanged retirement backs up and removes just owned file, leaving unknown Markdown", () => fixture(f => {
	applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true });
	writeFileSync(join(f.installed, "personal.md"), "private rule");
	retireAlpha(f);
	const plan = planRules({ root: f.root, home: f.home });
	expect(plan.entries[0]?.action).toBe("retire");
	expect(plan.unknownMarkdown).toBe(1);
	const receipt = applyRulePlan(plan, { confirmed: true });
	expect(receipt.status).toBe("APPLIED");
	expect(readFileSync(join(f.state, "backups", receipt.id!, "0.bak"), "utf8")).toBe("kit original\n");
	expect(existsSync(join(f.installed, "alpha.md"))).toBe(false);
	expect(readFileSync(join(f.installed, "personal.md"), "utf8")).toBe("private rule");
}));

test("changed owned retirement blocks instead of deleting user edit", () => fixture(f => {
	applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true });
	writeFileSync(join(f.installed, "alpha.md"), "user edit");
	retireAlpha(f);
	const plan = planRules({ root: f.root, home: f.home });
	expect(plan.entries[0]?.action).toBe("collision");
	expect(() => applyRulePlan(plan, { confirmed: true })).toThrow(/RULE_COLLISION/);
	expect(readFileSync(join(f.installed, "alpha.md"), "utf8")).toBe("user edit");
}));

test("tampered or incomplete source fails before creating target or state", () => fixture(f => {
	writeFileSync(join(f.rules, "alpha.md"), "wrong content");
	expect(() => planRules({ root: f.root, home: f.home })).toThrow(/SOURCE_INVALID/);
	expect(existsSync(f.installed)).toBe(false);
	expect(existsSync(f.state)).toBe(false);
	rmSync(join(f.rules, "alpha.md"));
	expect(() => planRules({ root: f.root, home: f.home })).toThrow(/SOURCE_INVALID/);
}));

test("stale manifest, source or target after plan refuses before target writes", () => fixture(f => {
	const plan = planRules({ root: f.root, home: f.home });
	writeFileSync(join(f.rules, "alpha.md"), "changed after plan");
	expect(() => applyRulePlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN|SOURCE_INVALID/);
	expect(existsSync(join(f.installed, "alpha.md"))).toBe(false);
	writeFileSync(join(f.rules, "alpha.md"), "kit original\n");
	const next = planRules({ root: f.root, home: f.home });
	mkdirSync(f.installed, { recursive: true });
	writeFileSync(join(f.installed, "alpha.md"), "intruder");
	expect(() => applyRulePlan(next, { confirmed: true })).toThrow(/FRESH_PLAN|RULE_COLLISION/);
	expect(readFileSync(join(f.installed, "alpha.md"), "utf8")).toBe("intruder");
}));

test("symlinked target cannot redirect writes outside selected HOME", () => fixture(f => {
	const outside = join(f.root, "outside.md");
	writeFileSync(outside, "keep me");
	mkdirSync(f.installed, { recursive: true });
	symlinkSync(outside, join(f.installed, "alpha.md"));
	expect(() => planRules({ root: f.root, home: f.home })).toThrow(/UNSAFE_PATH/);
	expect(readFileSync(outside, "utf8")).toBe("keep me");
}));

test("changed file mode of owned rule is not quietly re-owned", () => fixture(f => {
	applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true });
	chmodSync(join(f.installed, "alpha.md"), 0o600);
	expect(planRules({ root: f.root, home: f.home }).entries[0]?.action).toBe("collision");
}));

test("owned update replaces only unchanged prior image, with receipt backup", () => fixture(f => {
	applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true });
	writeFileSync(join(f.rules, "alpha.md"), "kit upgraded\n");
	writeFileSync(join(f.root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nalpha\t${hash("kit upgraded\n")}\treminder\tabcdef0\n`);
	const plan = planRules({ root: f.root, home: f.home });
	expect(plan.entries[0]?.action).toBe("update");
	const receipt = applyRulePlan(plan, { confirmed: true });
	expect(receipt.status).toBe("APPLIED");
	expect(readFileSync(join(f.installed, "alpha.md"), "utf8")).toBe("kit upgraded\n");
	expect(readFileSync(join(f.state, "backups", receipt.id!, "0.bak"), "utf8")).toBe("kit original\n");
}));

test("legacy installed.tsv is not an ownership claim", () => fixture(f => {
	mkdirSync(f.installed, { recursive: true });
	writeFileSync(join(f.installed, "alpha.md"), "kit original\n");
	mkdirSync(f.state, { recursive: true, mode: 0o700 });
	writeFileSync(join(f.state, "installed.tsv"), `name\tsha256\tpack\tinstalled_utc\nalpha\t${hash("kit original\n")}\tabcdef0\t2020-01-01T00:00:00Z\n`);
	expect(planRules({ root: f.root, home: f.home }).entries[0]?.action).toBe("unowned-identical");
	expect(applyRulePlan(planRules({ root: f.root, home: f.home }), { confirmed: true }).status).toBe("UNCHANGED");
	expect(existsSync(join(f.home, ".agents", "omp-kit-ownership.json"))).toBe(false);
}));

test("a forged or unreadable ownership record never authorizes replacement", () => fixture(f => {
	mkdirSync(join(f.home, ".agents"), { recursive: true });
	writeFileSync(join(f.home, ".agents", "omp-kit-ownership.json"), "{\"version\":1,\"rules\":{\"alpha\":{\"sha256\":\"invalid\"}}}", { mode: 0o600 });
	expect(() => planRules({ root: f.root, home: f.home })).toThrow(/STATE_UNSAFE/);
	expect(existsSync(join(f.installed, "alpha.md"))).toBe(false);
}));

test("target symlink introduced after plan cannot redirect the mutation", () => fixture(f => {
	const outside = join(f.root, "outside.md");
	writeFileSync(outside, "outside");
	const plan = planRules({ root: f.root, home: f.home });
	mkdirSync(f.installed, { recursive: true });
	symlinkSync(outside, join(f.installed, "alpha.md"));
	expect(() => applyRulePlan(plan, { confirmed: true })).toThrow(/UNSAFE_PATH|FRESH_PLAN/);
	expect(readFileSync(outside, "utf8")).toBe("outside");
	expect(existsSync(f.state)).toBe(false);
}));

test("compiled rules plan and consented apply establish verifiable ownership without adopting unowned Markdown", () => fixture(f => {
	mkdirSync(join(f.root, "bin"), { recursive: true });
	const binary = join(f.root, "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", binary], {
		cwd: f.root, stdout: "pipe", stderr: "pipe",
	});
	expect(build.exitCode).toBe(0);
	const run = (args: string[]) => {
		const result = Bun.spawnSync([binary, ...args, "--json"], {
			cwd: f.root, env: { ...process.env, HOME: f.home,
				XDG_STATE_HOME: join(f.home, ".local", "state"), XDG_CACHE_HOME: join(f.root, "cache") },
			stdout: "pipe", stderr: "pipe",
		});
		return { code: result.exitCode, envelope: JSON.parse(result.stdout.toString()) };
	};
	const before = snapshot(f.home);
	const plan = run(["apply", "rules", "--plan"]);
	expect(plan.code).toBe(0);
	expect(plan.envelope.data.entries).toEqual([{ name: "alpha", action: "install", owned: false }]);
	expect(snapshot(f.home)).toEqual(before);
	expect(run(["apply", "rules", "--apply"]).envelope.errors[0].code).toBe("CONSENT_REQUIRED");
	expect(snapshot(f.home)).toEqual(before);
	const applied = run(["apply", "rules", "--apply", "--yes"]);
	expect(applied.code).toBe(0);
	expect(applied.envelope.data.receipt_id).toEqual(expect.any(String));
	expect(readFileSync(join(f.installed, "alpha.md"), "utf8")).toBe("kit original\n");
	expect(readdirSync(f.installed)).toEqual(["alpha.md"]);
	expect(existsSync(join(f.state, "receipts", `${applied.envelope.data.receipt_id}.json`))).toBe(true);
	const diagnosed = run(["doctor", "--scope", "rules"]);
	expect(diagnosed.envelope.data.findings.find((row: { component: string }) => row.component === "installed_rules").status).toBe("OK");
	const ownership = join(f.home, ".agents", "omp-kit-ownership.json");
	const unchanged = readFileSync(ownership), oldMtime = lstatSync(ownership).mtimeMs;
	const receipts = snapshot(join(f.state, "receipts"));
	const repeat = run(["apply", "rules", "--apply", "--yes"]);
	expect(repeat.code).toBe(0);
	expect(repeat.envelope.data.receipt_id).toBeNull();
	expect(readFileSync(ownership)).toEqual(unchanged);
	expect(lstatSync(ownership).mtimeMs).toBe(oldMtime);
	expect(snapshot(join(f.state, "receipts"))).toEqual(receipts);
	writeFileSync(join(f.installed, "personal.md"), "operator-only rule");
	retireAlpha(f);
	const retired = run(["apply", "rules", "--apply", "--yes"]);
	expect(retired.code).toBe(0);
	expect(existsSync(join(f.installed, "alpha.md"))).toBe(false);
	expect(readFileSync(join(f.installed, "personal.md"), "utf8")).toBe("operator-only rule");
	expect(readFileSync(join(f.installed, "beta.md"), "utf8")).toBe("replacement\n");
	writeFileSync(join(f.installed, "beta.md"), "operator edit\n");
	const collision = run(["apply", "rules", "--apply", "--yes"]);
	expect(collision.code).toBe(2);
	expect(collision.envelope.errors[0].code).toBe("RULE_COLLISION");
	expect(readFileSync(join(f.installed, "beta.md"), "utf8")).toBe("operator edit\n");
}));

test("doctor distinguishes kit-owned postimage from identical unowned bytes and drift", async () => {
	mkdirSync(scratch, { recursive: true });
	const dir = mkdtempSync(join(scratch, "doctor-rules-"));
	const root = join(dir, "release"), home = join(dir, "home"), rules = join(root, "rules");
	const installed = join(home, ".agents", "rules"), ownership = join(home, ".agents", "omp-kit-ownership.json");
	mkdirSync(rules, { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(installed, { recursive: true });
	writeFileSync(join(rules, "alpha.md"), "kit original\n");
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nalpha\t${hash("kit original\n")}\treminder\tabcdef0\n`);
	try {
		writeFileSync(join(installed, "alpha.md"), "kit original\n");
		const unowned = (await diagnose({ root, home })).find(row => row.component === "installed_rules")!;
		expect(unowned.status).toBe("UNVERIFIED");
		expect(unowned.evidence?.ownership).toBe("UNVERIFIED");
		rmSync(join(installed, "alpha.md"));
		applyRulePlan(planRules({ root, home }), { confirmed: true });
		const owned = (await diagnose({ root, home })).find(row => row.component === "installed_rules")!;
		expect(owned.status).toBe("OK");
		expect(owned.evidence?.ownership).toBe("KIT_OWNED");
		expect((await diagnose({ root, home })).find(row => row.component === "effective_profile")?.status).toBe("UNVERIFIED");
		chmodSync(join(installed, "alpha.md"), 0o600);
		expect((await diagnose({ root, home })).find(row => row.component === "installed_rules")?.status).toBe("DEGRADED");
		chmodSync(join(installed, "alpha.md"), 0o644);
		const stale = JSON.parse(readFileSync(ownership, "utf8"));
		stale.rules.alpha.sha256 = hash("different bytes");
		writeFileSync(ownership, JSON.stringify(stale));
		const drifted = (await diagnose({ root, home })).find(row => row.component === "installed_rules")!;
		expect(drifted.status).toBe("DEGRADED");
		expect(drifted.evidence?.ownershipDrift).toEqual(["alpha"]);
		writeFileSync(ownership, "{\"version\":1,\"rules\":{\"alpha\":{\"sha256\":\"invalid\"}}}");
		const invalid = (await diagnose({ root, home })).find(row => row.component === "installed_rules")!;
		expect(invalid.status).toBe("DEGRADED");
		expect(invalid.evidence?.ownership).toBe("UNSAFE_RECORD");
		const outside = join(dir, "outside-canary");
		writeFileSync(outside, "leave intact");
		rmSync(ownership);
		symlinkSync(outside, ownership);
		const linked = (await diagnose({ root, home })).find(row => row.component === "installed_rules")!;
		expect(linked.status).toBe("DEGRADED");
		expect(linked.evidence?.ownership).toBe("UNSAFE_RECORD");
		expect(readFileSync(outside, "utf8")).toBe("leave intact");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
