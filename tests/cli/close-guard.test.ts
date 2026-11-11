import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);
const ROOT = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();
const ACTOR = "HandoffBuilder";

async function setup() {
	const dir = ownedTmp("close-guard-handoff").path;
	const repo = join(dir, "repo"), origin = join(dir, "origin.git"), bin = join(dir, "bin");
	mkdirSync(repo, { recursive: true }); mkdirSync(bin, { recursive: true });
	const env: Record<string, string> = {
		HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
		PATH: `${bin}:${process.env.PATH ?? ""}`, AGENT_NAME: ACTOR,
	};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string" && !(key in env)) env[key] = value;
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BEADS_DB", "BD_DB", "BD_DATABASE", "BEADS_JSONL", "GRADE_WAVE_SCRATCH"]) delete env[key];
	const git = async (args: string[]) => {
		const result = await runFixtureAsync(["git", "-C", repo, ...args], { cwd: dir, env, floor_s: 10, label: `handoff git ${args[0]}` });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")} -> ${result.rc}: ${decoder.decode(result.stderr)}`);
		return decoder.decode(result.stdout).trim();
	};
	await runFixtureAsync(["git", "init", "--bare", "-q", origin], { cwd: dir, env, floor_s: 10, label: "handoff init origin" });
	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.name", "Handoff"]);
	await git(["config", "user.email", "handoff@invalid.example"]);
	await git(["commit", "-q", "--allow-empty", "-m", "published root [test]"]);
	await git(["remote", "add", "origin", origin]);
	await git(["push", "-q", "--set-upstream", "origin", "main"]);
	const published = await git(["rev-parse", "HEAD"]);
	await git(["commit", "-q", "--allow-empty", "-m", "unpushed builder work [test]"]);
	const unpublished = await git(["rev-parse", "HEAD"]);
	const bead = {
		id: "handoff-1", title: "Builder work awaiting review", issue_type: "task", priority: 2,
		status: "in_progress", assignee: "DirectorDana", labels: [],
		created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", created_by: ACTOR,
		description: "WHAT: unpushed work. WHY: handoff fixture.",
		acceptance_criteria: "- [ ] [a] [build] `printf ok` -> ok",
		dependencies: [], comments: [],
	};
	writeFileSync(join(dir, "bead.json"), JSON.stringify([bead]));
	writeFileSync(join(bin, "br"), `#!/bin/sh\ncat "$BR_GUARD_JSON_FILE"\n`, { mode: 0o755 });
	chmodSync(join(bin, "br"), 0o755);
	const guardEnv = { ...env, BR_GUARD_JSON_FILE: join(dir, "bead.json") };
	const guard = (sub: string, reason: string) => runFixtureAsync(
		["sh", join(ROOT, "scripts/close-guard.sh"), "handoff-1", "--db", join(dir, "db"), "--sub", sub, "--reason", reason],
		{ cwd: repo, env: guardEnv, floor_s: 30, label: `handoff guard ${sub}` });
	return { dir, repo, published, unpublished, guard };
}

function output(result: { stdout: Uint8Array; stderr: Uint8Array }): string {
	return decoder.decode(result.stdout) + decoder.decode(result.stderr);
}

test("HANDOFFUNPUB1: in_review admits a locally present but unpublished commit; close still refuses it", async () => {
	const f = await setup();
	const handoff = `DONE ${f.repo}@${f.unpublished}: builder evidence`;
	// Planted negative: the 0.2.117 decision procedure (unpublished = not an
	// ancestor of origin/main) refuses this handoff.
	const ancestry = await runFixtureAsync(["git", "-C", f.repo, "merge-base", "--is-ancestor", f.unpublished, "origin/main"],
		{ cwd: f.dir, floor_s: 10, label: "handoff ancestry probe" });

	const admitted = await f.guard("update", handoff);
	expect(admitted.rc, output(admitted)).toBe(0);

	const refused = await f.guard("close", `Lesson: none\nexport ${f.unpublished}`);
	expect(refused.rc, output(refused)).toBe(4);
	expect(output(refused)).toContain("NOT_PUBLISHED");

	// Fail-closed on both paths: a citation that resolves nowhere is refused.
	const bogus = await f.guard("update", `DONE ${f.repo}@${"0".repeat(40)}: builder evidence`);
	expect(bogus.rc, output(bogus)).toBe(4);
	expect(output(bogus)).toContain("NOT_PUBLISHED");

	// A published citation is still admitted on the handoff path.
	const publishedHandoff = await f.guard("update", `DONE ${f.repo}@${f.published}: builder evidence`);
	expect(publishedHandoff.rc, output(publishedHandoff)).toBe(0);
}, fixtureDeadlineS() * 1000);
