import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureBoxDeps } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

/** A package with a real npm lock, generated offline from empty or local-file dependencies. */
async function lockedPackage(dir: string, name: string, dependencies: Record<string, string> = {}): Promise<void> {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies }));
	const r = await run(["npm", "install", "--no-audit", "--no-fund", "--offline"], { cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(r.rc).toBe(0);
	expect(existsSync(join(dir, "package-lock.json"))).toBe(true);
}

/**
 * Replay a box command the way the verifier does: from a script file, never `sh -c` with a dynamic payload. The pysafe
 * ratchet cannot read a shell program passed as a variable and refuses it ("dynamic executable shell argument").
 */
async function replayBox(root: string, command: string, env: Record<string, string>) {
	const script = join(root, "replay-box.sh");
	writeFileSync(script, `${command}\n`, { mode: 0o700 });
	return run(["sh", script], { cwd: root, deadline_s: fixtureDeadlineS(30), env });
}

test("VERIFYDEPSWALK1: a box in a nested package with its own lockfile also provisions every ancestor lockfile, root first", async () => {
	const root = ownedTmp("verify-depswalk").path;
	await lockedPackage(root, "workspace-root");
	await lockedPackage(join(root, "apps", "worker"), "worker");
	const log: string[] = [];
	const env = { ...process.env } as Record<string, string>;
	const outcome = await ensureBoxDeps("cd apps/worker && bun test", root, env, log, new Map());
	expect(outcome).toBeNull();
	const installs = log.filter(line => line.startsWith("deps ") && line.includes(" rc "));
	// Both lockfile directories install, the workspace root before the nested package.
	expect(installs.length).toBe(2);
	expect(installs[0]).toContain(`in ${root} `);
	expect(installs[1]).toContain(join(root, "apps", "worker"));
	// Planted negative (0.2.121 behavior): stopping at the nearest lockfile would log exactly one install.
	expect(installs.length).not.toBe(1);
}, fixtureDeadlineS(90) * 1000);

async function prefixedProject(label: string, target: string, lock: "ok" | "none" | "stale" = "ok"): Promise<string> {
	const root = ownedTmp(label).path;
	await lockedPackage(root, "prefix-root");
	const app = join(root, target);
	const vendor = join(app, "vendor", "greet");
	mkdirSync(vendor, { recursive: true });
	writeFileSync(join(vendor, "package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", main: "index.cjs" }));
	writeFileSync(join(vendor, "index.cjs"), 'module.exports = "locked-prefix-dependency";\n');
	await lockedPackage(app, "prefix-app", { "greet-local": "file:./vendor/greet" });
	const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
	manifest.scripts = { test: "node check.cjs" };
	if (lock === "stale") {
		const extra = join(app, "vendor", "extra");
		mkdirSync(extra);
		writeFileSync(join(extra, "package.json"), JSON.stringify({ name: "extra-local", version: "1.0.0" }));
		manifest.dependencies["extra-local"] = "file:./vendor/extra";
	}
	writeFileSync(join(app, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(app, "check.cjs"), 'console.log(require("greet-local"));\n');
	rmSync(join(app, "node_modules"), { recursive: true, force: true });
	if (lock === "none") {
		rmSync(join(app, "package-lock.json"));
		rmSync(join(root, "package-lock.json"));
	}
	return root;
}

for (const { target, flag } of [
	{ target: "apps/cfs-followup-worker", flag: "--prefix apps/cfs-followup-worker" },
	{ target: "apps/followup worker", flag: '--prefix="apps/followup worker"' },
	{ target: "apps/followup worker", flag: '-C "apps/followup worker"' },
]) {
	test(`VERIFYDEPS1 npm ${flag} provisions the target lock before the real Node import`, async () => {
		const root = await prefixedProject("verify-prefix", target);
		const env = { ...process.env } as Record<string, string>;
		const command = `npm ${flag} test`;
		const outcome = await ensureBoxDeps(command, root, env, [], new Map());
		expect(outcome).toBeNull();
		const replay = await replayBox(root, command, env);
		expect(replay.rc, new TextDecoder().decode(replay.stderr)).toBe(0);
		expect(new TextDecoder().decode(replay.stdout)).toContain("locked-prefix-dependency");
	}, fixtureDeadlineS(90) * 1000);
}

for (const lock of ["none", "stale"] as const) {
	test(`VERIFYDEPS1 npm prefix ${lock} lock refuses before importing outside the lock`, async () => {
		const root = await prefixedProject("verify-prefix-lock", "apps/cfs-followup-worker", lock);
		const outcome = await ensureBoxDeps("npm --prefix apps/cfs-followup-worker test", root, { ...process.env } as Record<string, string>, [], new Map());
		expect(outcome).not.toBeNull();
		expect(outcome?.ok).toBe(false);
		if (outcome !== null && !outcome.ok) expect(outcome.detail).toContain("DEPENDENCIES_NOT_LOCKED");
		expect(existsSync(join(root, "apps/cfs-followup-worker/node_modules"))).toBe(false);
	}, fixtureDeadlineS(90) * 1000);
}

test("VERIFYDEPS1 npm -- stops directory-option parsing before script arguments", async () => {
	const root = await prefixedProject("verify-prefix-args", "apps/cfs-followup-worker");
	const env = { ...process.env } as Record<string, string>;
	const command = "npm --prefix apps/cfs-followup-worker test -- --prefix ../outside";
	const outcome = await ensureBoxDeps(command, root, env, [], new Map());
	expect(outcome).toBeNull();
	const replay = await replayBox(root, command, env);
	expect(replay.rc, new TextDecoder().decode(replay.stderr)).toBe(0);
	expect(new TextDecoder().decode(replay.stdout)).toContain("locked-prefix-dependency");
}, fixtureDeadlineS(90) * 1000);

for (const target of ['"$UNRESOLVED_TARGET"', "../outside"]) {
	test(`VERIFYDEPS1 unresolved or escaping npm prefix ${target} remains an environment prerequisite`, async () => {
		const root = ownedTmp("verify-prefix-boundary").path;
		const outcome = await ensureBoxDeps(`npm --prefix ${target} test`, root, { ...process.env } as Record<string, string>, [], new Map());
		expect(outcome).not.toBeNull();
		expect(outcome?.ok).toBe(false);
		if (outcome !== null && !outcome.ok) expect(outcome.detail).toContain("environment prerequisite unmet");
	});
}
