import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstFailure } from "../../src/cli.ts";
import { applyScratch, defaultLiveness, defaultRunner, reapLogPath } from "../../src/scratch.ts";

const roots: string[] = [];
const savedState = process.env.XDG_STATE_HOME;
const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
afterEach(() => {
	for (const root of roots.splice(0)) {
		try { chmodSync(root, 0o755); } catch { /* already gone */ }
		rmSync(root, { recursive: true, force: true });
	}
	if (savedState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedState;
	if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS; else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
});

function verdict(dir: string, reason: string) {
	return { dir, action: "SKIP" as const, reason, owner: null, sizeBytes: 0 };
}

test("summary names the first failed action with dir and reason", () => {
	const out = firstFailure({ applied: [verdict("/w/ok", "not-directory"), verdict("/w/no", "quarantine-create-failed")], killed: [] });
	expect(out).toBe("; first: /w/no quarantine-create-failed");
});

test("summary names an unreaped orphan when no action failed", () => {
	const out = firstFailure({ applied: [], killed: [{ pid: 7, command: "mock-model", ok: false }] });
	expect(out).toBe("; first: pid 7 mock-model not reaped");
});

test("summary names nothing when everything held", () => {
	expect(firstFailure({ applied: [], killed: [] })).toBe("");
});

test("unremovable quarantine target fails with dir, errno and summary naming it", () => {
	const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "failure-home-"));
	roots.push(home);
	process.env.XDG_STATE_HOME = home;
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "failure-root-"));
	roots.push(root);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	const stuck = join(root, "stuck.1");
	mkdirSync(stuck, { recursive: true });
	const past = new Date(Date.now() - 73 * 3600 * 1000);
	utimesSync(stuck, past, past);
	chmodSync(root, 0o555);
	const result = applyScratch(home, { liveness: defaultLiveness(), run: defaultRunner, home });
	const terminal = result.applied.find(entry => entry.dir === stuck);
	expect(terminal?.action).toBe("SKIP");
	expect(terminal?.reason).toBe("atomic-quarantine-failed");
	expect(existsSync(stuck)).toBe(true);
	const rows = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const row = rows.find(entry => entry.event === "failure" && entry.dir === stuck);
	expect(row?.error).toBe("atomic-quarantine-failed");
	const summary = `scratch-reaper had 1 failed action(s)${firstFailure({ applied: result.applied, killed: result.killed })}`;
	expect(summary).toContain(stuck);
	expect(summary).toContain("atomic-quarantine-failed");
});
