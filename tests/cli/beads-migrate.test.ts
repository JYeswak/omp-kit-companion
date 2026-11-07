import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { assertObligationUnchanged, planBeadMigration } from "../../src/beads-migrate.ts";
import { nativeBr } from "./lib/native-br.ts";

afterAll(cleanupAllOwnedTmp);
const ROOT = resolve(import.meta.dir, "../..");
const STAMP = "2026-10-01T00:00:00Z";
const DESCRIPTION = "WHAT: (a) Validate the fixture payload.\nWHY: prevent payload regressions.\nPlanted negative: a changed payload is rejected.";
const REPLAY = "sh tests/replay.sh";
const CLEAN = `- [x] [a] [build] \`${REPLAY}\` -> rc 0; planted negative rejects a changed payload.`;

async function fixture() {
	const root = ownedTmp("beads-migrate-test").path;
	const project = join(root, "project"), bin = join(root, "bin");
	mkdirSync(project); mkdirSync(bin); mkdirSync(join(project, "tests"));
	writeFileSync(join(project, "payload.txt"), "original\n");
	writeFileSync(join(project, "tests/replay.sh"), '#!/bin/sh\n[ "$(cat payload.txt)" = original ]\n', { mode: 0o755 });
	symlinkSync(nativeBr(), join(bin, "br"));
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENT_NAME: "FixtureReviewer", HOME: root };
	const db = join(project, ".beads/beads.db");
	const br = async (args: string[]) => {
		const result = await run([join(bin, "br"), "--db", db, "--no-auto-import", "--no-auto-flush", ...args], {
			cwd: project, env, deadline_s: 30, max_output_bytes: 4 << 20,
		});
		expect(result.rc, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
		return result;
	};
	await br(["init", "--prefix", "bm", "--actor", "FixtureAuthor"]);
	const record = (id: string, acceptance: string, description = DESCRIPTION, labels: string[] = ["fixture"]) => ({
		id: `bm-${id}`, title: "Validate the fixture payload", description, acceptance_criteria: acceptance,
		status: "open", priority: 2, issue_type: "task", created_at: STAMP, updated_at: STAMP,
		created_by: "FixtureAuthor", labels, dependencies: [], comments: [],
	});
	const original = [
		record("description", "", `${DESCRIPTION}\nAC: (a) Validate the payload with \`${REPLAY}\` -> rc 0; planted negative rejects changes.`),
		record("prose", `- [x] [a] [build] \`${REPLAY}\` checks the operator's Ω/🙂 payload preservation; planted negative rejects changes.`),
		record("delimiter", `- [x] [a] [build] \`${REPLAY}\` -> rc 0 on exact committed source; planted negative rejects changes.`),
		record("markers", CLEAN, "what (a) Validate the fixture payload.\nwhy prevent payload regressions.\nPlanted negative rejects a changed payload."),
		record("label", CLEAN, DESCRIPTION, []),
		record("underivable", "- [ ] [a] [build] An unbuilt consumer preserves payload bytes; planted negative rejects a change."),
		record("clean", CLEAN),
	];
	writeFileSync(join(project, ".beads/issues.jsonl"), original.map(value => JSON.stringify(value)).join("\n") + "\n");
	await br(["sync", "--import-only", "--actor", "FixtureAuthor"]);
	const read = async () => {
		const result = await br(["list", "--all", "--limit", "0", "--json"]);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
		if (Array.isArray(parsed)) return parsed;
		if (parsed !== null && typeof parsed === "object" && "issues" in parsed && Array.isArray(parsed.issues)) return parsed.issues;
		throw new Error("native br list returned no issue array");
	};
	const cli = (apply = false, overrides: Record<string, string> = {}) => run([process.execPath, join(ROOT, "src/cli.ts"), "beads", "migrate", "--project", project,
		"--actor", "FixtureReviewer", ...(apply ? ["--apply", "--yes"] : []), "--json"], {
		cwd: ROOT, env: { ...env, ...overrides }, deadline_s: 90, max_output_bytes: 4 << 20,
	});
	return { root, project, env, db, original, br, read, cli };
}

test("BACKLOGMIG1 dry-run plans lossless replay repairs and leaves label-free clean records unchanged", async () => {
	const f = await fixture();
	const before = await f.read();
	const result = await f.cli();
	expect(result.rc, JSON.stringify(before.map(row => Object.keys(row))) + "\n" + new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
	const output = JSON.parse(new TextDecoder().decode(result.stdout));
	expect(output.data.migrations.filter((row: { status: string }) => row.status === "PLANNED").map((row: { id: string }) => row.id).sort()).toEqual([
		"bm-delimiter", "bm-description", "bm-markers", "bm-prose",
	]);
	expect(output.data.migrations.find((row: { id: string }) => row.id === "bm-underivable").reason).toBe("needs-builder-command");
	expect(output.data.migrations.find((row: { id: string }) => row.id === "bm-clean").status).toBe("UNCHANGED");
	expect(output.data.migrations.find((row: { id: string }) => row.id === "bm-label").status).toBe("UNCHANGED");
	expect(await f.read()).toEqual(before);
}, 120_000);

test("BACKLOGMIG1 applies only derived replay repairs, preserves label-free records and exact originals, and is idempotent", async () => {
	const f = await fixture();
	const before = await f.read();
	const result = await f.cli(true);
	expect(result.rc, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(1);
	const output = JSON.parse(new TextDecoder().decode(result.stdout));
	expect(output.data.migrations.filter((row: { status: string }) => row.status === "APPLIED").map((row: { id: string }) => row.id).sort()).toEqual([
		"bm-delimiter", "bm-description", "bm-markers", "bm-prose",
	]);
	const after = await f.read();
	for (const original of before) {
		const current = after.find(row => row.id === original.id);
		if (original.id === "bm-underivable" || original.id === "bm-clean" || original.id === "bm-label") {
			expect(current).toEqual(original);
			continue;
		}
		expect(current.status).toBe(original.status);
		expect(current.assignee).toBe(original.assignee);
		expect(current.description).toContain("## Original acceptance");
		expect(current.description).toContain(original.acceptance_criteria || original.description.slice(original.description.indexOf("AC:") + 3));
	}
	const repeat = await f.cli();
	expect(repeat.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(repeat.stdout)).data.migrations.some((row: { status: string }) => row.status === "PLANNED")).toBe(false);
	expect(await f.read()).toEqual(after);
}, 120_000);

test("BACKLOGMIG1 OBLIGATION_UNCHANGED refuses a one-word mutation of an otherwise valid plan", async () => {
	const f = await fixture();
	const before = await f.read();
	const source = before.find(row => row.id === "bm-prose");
	const plan = planBeadMigration(source, { project: f.project, actor: "FixtureReviewer" });
	expect(plan.status).toBe("PLANNED");
	if (plan.status !== "PLANNED") throw new Error("the named repair control must be planned");
	const changed = { ...plan, after: { ...plan.after, acceptance_criteria: plan.after.acceptance_criteria.replace("preservation", "corruption") } };
	expect(() => assertObligationUnchanged(changed)).toThrow("OBLIGATION_CHANGED");
	assertObligationUnchanged(plan);
	expect(await f.read()).toEqual(before);
}, 120_000);

test("BACKLOGMIG1 adding replay metadata unticks a previously unjudged box", async () => {
	const f = await fixture();
	const seed = f.original[1];
	if (seed === undefined) throw new Error("fixture seed missing");
	const untagged = { ...seed, acceptance_criteria: `- [x] \`${REPLAY}\` -> rc 0; planted negative rejects changes.` };
	const tagged = planBeadMigration(untagged, { project: f.project, actor: "FixtureReviewer" });
	expect(tagged.status).toBe("PLANNED");
	if (tagged.status !== "PLANNED") throw new Error("untagged replay requires migration");
	expect(tagged.after.acceptance_criteria.startsWith("- [ ] ")).toBe(true);
}, 120_000);

test("BACKLOGMIG1 duplicate obligations retain separate exact edit locations", async () => {
	const f = await fixture();
	const seed = f.original[1];
	if (seed === undefined) throw new Error("fixture seed missing");
	const duplicated = { ...seed, acceptance_criteria: `${seed.acceptance_criteria}\n${seed.acceptance_criteria}` };
	const plan = planBeadMigration(duplicated, { project: f.project, actor: "FixtureReviewer" });
	expect(plan.status).toBe("PLANNED");
	if (plan.status !== "PLANNED") throw new Error("both identical original lines require their own insertion");
	expect(plan.after.acceptance_criteria.split("\n").length).toBe(2);
	expect(plan.after.description.endsWith(duplicated.acceptance_criteria)).toBe(true);
	assertObligationUnchanged(plan);
}, 120_000);

test("BACKLOGMIG1 description-source coordinates preserve a leading newline without importing the AC marker", async () => {
	const f = await fixture();
	const seed = f.original[0];
	if (seed === undefined) throw new Error("fixture seed missing");
	const original = ` (a) \`${REPLAY}\` -> rc 0; planted negative rejects changes.`;
	const source = { ...seed, description: `\nAC:${original}\n## Context\n${DESCRIPTION}` };
	const plan = planBeadMigration(source, { project: f.project, actor: "FixtureReviewer" });
	expect(plan.status).toBe("PLANNED");
	if (plan.status !== "PLANNED") throw new Error("explicit AC carrier must be recoverable");
	expect(plan.baseAcceptance).toBe(original);
	expect(plan.after.description.endsWith(original)).toBe(true);
	assertObligationUnchanged(plan);
}, 120_000);

test("BACKLOGMIG1 unsupported escaped or unfinished inline carriers remain unchanged, never partially promoted", async () => {
	const f = await fixture();
	const seed = f.original[0];
	if (seed === undefined) throw new Error("fixture seed missing");
	for (const text of [" (a) `" + REPLAY + "` -> rc 0; escaped \\` (b) is not a clause.", " (a) `" + REPLAY + " -> rc 0; (b) is inside an unfinished span."]) {
		const source = { ...seed, description: `${DESCRIPTION}\nAC:${text}` };
		const plan = planBeadMigration(source, { project: f.project, actor: "FixtureReviewer" });
		expect(plan.status).toBe("UNCHANGED");
		if (plan.status === "UNCHANGED") expect(plan.reason).toBe("unsupported-acceptance-carrier");
	}
}, 120_000);

test("BACKLOGMIG1 the author cannot apply their own acceptance repair", async () => {
	const f = await fixture();
	const before = await f.read();
	const result = await run([process.execPath, join(ROOT, "src/cli.ts"), "beads", "migrate", "--project", f.project,
		"--actor", "FixtureAuthor", "--bead", "bm-prose", "--apply", "--yes", "--json"], {
		cwd: ROOT, env: { ...f.env, AGENT_NAME: "FixtureAuthor" }, deadline_s: 90, max_output_bytes: 4 << 20,
	});
	expect(result.rc).toBe(1);
	const row = JSON.parse(new TextDecoder().decode(result.stdout)).data.migrations[0];
	expect(row).toMatchObject({ id: "bm-prose", status: "UNCHANGED", reason: "non-author-required" });
	expect(await f.read()).toEqual(before);
}, 120_000);

test("BACKLOGMIG1 confirmation alone still writes no tracker data without apply", async () => {
	const f = await fixture();
	const before = await f.read();
	const result = await run([process.execPath, join(ROOT, "src/cli.ts"), "beads", "migrate", "--project", f.project,
		"--actor", "FixtureReviewer", "--yes", "--json"], { cwd: ROOT, env: f.env, deadline_s: 90, max_output_bytes: 4 << 20 });
	expect(result.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(result.stdout)).data.apply).toBe(false);
	expect(await f.read()).toEqual(before);
}, 120_000);

test("BACKLOGMIG1 a concurrent native update refuses the stale plan without overwriting its bytes", async () => {
	const f = await fixture();
	const before = (await f.read()).find(row => row.id === "bm-prose");
	const raceBin = join(f.root, "race-bin");
	mkdirSync(raceBin);
	const backend = realpathSync(join(f.root, "bin/br"));
	const concurrentDescription = `${DESCRIPTION}\nConcurrent writer's apostrophe and \`quoted\` bytes.`;
	writeFileSync(join(raceBin, "br"), `#!/usr/bin/env bun
import { run } from ${JSON.stringify(join(ROOT, "src/kitlib/run.ts"))};
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([,value]) => typeof value === "string"));
const update = args.indexOf("update"), db = args[args.indexOf("--db") + 1];
if (update >= 0) {
  const changed = await run([${JSON.stringify(backend)}, "--db", db, "--no-auto-import", "update", args[update + 1],
    "--description", ${JSON.stringify(concurrentDescription)}, "--actor", "ConcurrentWriter"], {
    cwd: ${JSON.stringify(f.project)}, env, deadline_s: 20, max_output_bytes: 1048576 });
  if (changed.rc !== 0) { process.stderr.write(changed.stderr); process.exit(changed.rc ?? 3); }
}
const result = await run([${JSON.stringify(backend)}, ...args], { cwd: ${JSON.stringify(f.project)}, env, deadline_s: 20, max_output_bytes: 1048576 });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.rc ?? 3);
`, { mode: 0o755 });
	const result = await run([process.execPath, join(ROOT, "src/cli.ts"), "beads", "migrate", "--project", f.project,
		"--actor", "FixtureReviewer", "--bead", "bm-prose", "--apply", "--yes", "--json"], {
		cwd: ROOT, env: { ...f.env, PATH: `${raceBin}:${f.env.PATH}` }, deadline_s: 90, max_output_bytes: 4 << 20,
	});
	expect(result.rc).toBe(1);
	expect(JSON.parse(new TextDecoder().decode(result.stdout)).data.migrations[0]).toMatchObject({
		id: "bm-prose", status: "REFUSED", reason: "conditional-update-refused",
	});
	const after = (await f.read()).find(row => row.id === "bm-prose");
	expect(after.description).toBe(concurrentDescription);
	expect(after.acceptance_criteria).toBe(before.acceptance_criteria);
	expect(after.status).toBe(before.status);
	expect(after.assignee).toBe(before.assignee);
}, 120_000);

test("BACKLOGMIG1 the canonical linter cannot be replaced by the selected project's Python modules", async () => {
	const f = await fixture();
	const marker = join(f.root, "poison-imported");
	writeFileSync(join(f.project, "json.py"), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("untrusted module ran")\nraise SystemExit(9)\n`);
	const before = await f.read();
	const result = await f.cli(false, { PYTHONPATH: f.project });
	expect(result.rc, new TextDecoder().decode(result.stdout)).toBe(0);
	expect(existsSync(marker)).toBe(false);
	expect(await f.read()).toEqual(before);
}, 120_000);
