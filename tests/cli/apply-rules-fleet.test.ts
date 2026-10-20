import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { applyRulePlan, planRules } from "../../src/apply-rules.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
type F = { root: string; home: string; installed: string };
function fixture(run: (f: F) => void): void {
	const dir = mkdtempSync(join(scratch, "apply-rules-fleet-"));
	const root = join(dir, "release"), home = join(dir, "home");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "rules-fleet"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(home);
	writeFileSync(join(root, "rules", "alpha.md"), "kit original\n");
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nalpha\t${hash("kit original\n")}\treminder\tabcdef0\n`);
	writeFileSync(join(root, "rules-fleet", "fleet.md"), "fleet protocol\n");
	writeFileSync(join(root, "MANIFEST.fleet.tsv"), `name\tsha256\tclass\tpack\nfleet\t${hash("fleet protocol\n")}\treminder\tabcdef0\n`);
	try { run({ root, home, installed: join(home, ".agents", "rules") }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("default plan installs only the default pack and never reads the fleet pack", () => fixture(f => {
	const plan = planRules({ root: f.root, home: f.home });
	expect(plan.entries.map(e => [e.name, e.action])).toEqual([["alpha", "install"]]);
	expect(existsSync(f.installed)).toBe(false);
}));

test("fleet plan installs only the fleet pack", () => fixture(f => {
	const plan = planRules({ root: f.root, home: f.home, fleet: true });
	expect(plan.entries.map(e => [e.name, e.action])).toEqual([["fleet", "install"]]);
	expect(existsSync(f.installed)).toBe(false);
}));

test("fleet apply installs the fleet rule, records ownership, and repeats exactly", () => fixture(f => {
	const receipt = applyRulePlan(planRules({ root: f.root, home: f.home, fleet: true }), { confirmed: true });
	expect(receipt.status).toBe("APPLIED");
	expect(readFileSync(join(f.installed, "fleet.md"), "utf8")).toBe("fleet protocol\n");
	expect(readdirSync(f.installed)).toEqual(["fleet.md"]);
	expect(applyRulePlan(planRules({ root: f.root, home: f.home, fleet: true }), { confirmed: true }))
		.toEqual({ status: "UNCHANGED", files: 0, id: null });
}));

test("fleet plan refuses a missing fleet manifest without touching HOME", () => fixture(f => {
	rmSync(join(f.root, "MANIFEST.fleet.tsv"));
	rmSync(join(f.root, "rules-fleet"), { recursive: true, force: true });
	const before = existsSync(f.installed);
	expect(() => planRules({ root: f.root, home: f.home, fleet: true })).toThrow(/SOURCE_INVALID/);
	expect(existsSync(f.installed)).toBe(before);
	// The default pack still plans while the fleet pack is absent: no coupling.
	expect(planRules({ root: f.root, home: f.home }).entries.map(e => e.name)).toEqual(["alpha"]);
}));

test("fleet plan refuses a fleet rule omitted from the fleet manifest", () => fixture(f => {
	writeFileSync(join(f.root, "rules-fleet", "stowaway.md"), "unmanifested\n");
	expect(() => planRules({ root: f.root, home: f.home, fleet: true })).toThrow(/SOURCE_INVALID/);
}));

test("fleet plan refuses a hash mismatch between manifest and fleet rule bytes", () => fixture(f => {
	writeFileSync(join(f.root, "rules-fleet", "fleet.md"), "tampered\n");
	expect(() => planRules({ root: f.root, home: f.home, fleet: true })).toThrow(/SOURCE_INVALID/);
}));

test("compiled CLI accepts --fleet for apply rules and reports the pack", () => fixture(f => {
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
	const fleet = run(["apply", "rules", "--plan", "--fleet"]);
	expect(fleet.code).toBe(0);
	expect(fleet.envelope.data.fleet).toBe(true);
	expect(fleet.envelope.data.entries).toEqual([{ name: "fleet", action: "install", owned: false }]);
	const def = run(["apply", "rules", "--plan"]);
	expect(def.code).toBe(0);
	expect(def.envelope.data.fleet).toBe(false);
	expect(def.envelope.data.entries).toEqual([{ name: "alpha", action: "install", owned: false }]);
}));
