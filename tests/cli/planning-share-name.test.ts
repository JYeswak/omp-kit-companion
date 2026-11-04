import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");

// PIDIDENT1 (ompkit-a0vy1): the e2e allocates its scratch through kitlib owned_tmp, which removes
// it at exit. Planted: the old bare-pid `.owner` writer left planning-share-name.<pid> behind.
test("planning-share-name e2e passes every case and leaves no scratch dir behind", () => {
	const result = runFixture(["sh", "scripts/e2e/planning-share-name.sh"], { cwd: root, floor_s: 120 });
	const stdout = new TextDecoder().decode(result.stdout);
	const rows = stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
	const totals = rows.find(row => row.kind === "totals");
	expect({ rc: result.rc, totals: totals && { cases: totals.cases, failed: totals.failed } },
		`stdout=${stdout.slice(-2000)} stderr=${new TextDecoder().decode(result.stderr).slice(-1000)}`)
		.toEqual({ rc: 0, totals: { cases: 8, failed: 0 } });
	const score = rows.find(row => row.case === "score-prose");
	const command = Array.isArray(score?.command) ? score.command as string[] : [];
	const repo = command[command.indexOf("--repo") + 1];
	expect(typeof repo).toBe("string");
	const scratch = dirname(repo!);
	expect(dirname(scratch)).toBe(resolve(root, "var", "agent-tmp"));
	expect(basename(scratch)).toMatch(/^planning-share-name\.\d+\.[a-z0-9]{6}$/);
	expect(existsSync(scratch), `scratch ${scratch} survived the run`).toBe(false);
}, fixtureDeadlineS(180) * 1_000);
