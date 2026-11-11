import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureBoxDeps } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

/** A dependency-free package with a real package-lock.json: `npm install` writes it offline. */
async function lockedPackage(dir: string, name: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: {} }));
	const r = await run(["npm", "install", "--no-audit", "--no-fund", "--offline"], { cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(r.rc).toBe(0);
	expect(existsSync(join(dir, "package-lock.json"))).toBe(true);
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
