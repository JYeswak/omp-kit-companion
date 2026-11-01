import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run, RunResult } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { nativeBr } from "./lib/native-br.ts";

afterAll(cleanupAllOwnedTmp);
const ROOT = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();
const AUTHOR = "FixtureBuilder";
const REVIEWER = "FixtureReviewer";

async function fixture() {
	const dir = ownedTmp("pwdi-native-handoff").path;
	const repo = join(dir, "repo"), origin = join(dir, "origin.git"), bin = join(dir, "bin");
	mkdirSync(repo); mkdirSync(bin);
	const backend = nativeBr();
	symlinkSync(backend, join(bin, "br"));
	const env: Record<string, string> = {
		HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
		PATH: `${bin}:${process.env.PATH ?? ""}`, AGENT_NAME: AUTHOR, BR_REAL: backend,
	};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string" && !(key in env)) env[key] = value;
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BEADS_DB", "BD_DB", "BD_DATABASE", "BEADS_JSONL", "GRADE_WAVE_SCRATCH"]) delete env[key];
	const checked = async (argv: string[], cwd = repo) => {
		const result = await run(argv, { cwd, env, deadline_s: 30, max_output_bytes: 4 << 20 });
		if (result.rc !== 0 || result.timed_out || result.truncated) throw new Error(`${argv.join(" ")}: ${result.rc}\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
		return decoder.decode(result.stdout).trim();
	};
	const git = (args: string[]) => checked(["git", "-C", repo, ...args]);
	await checked(["git", "init", "--bare", "-q", origin], dir);
	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.name", "Fixture"]);
	await git(["config", "user.email", "fixture@invalid.example"]);
	await git(["commit", "--allow-empty", "-q", "-m", "owned native fixture", "-m", "Bead: pw-trailer", "-m", `Agent: ${AUTHOR}`]);
	await git(["remote", "add", "origin", origin]);
	await git(["push", "-q", "--set-upstream", "origin", "main"]);
	const published = await git(["rev-parse", "HEAD"]);
	const db = join(repo, ".beads/beads.db");
	const br = (args: string[]) => checked([backend, "--db", join(repo, ".beads/beads.db"), "--no-auto-import", "--no-auto-flush", ...args]);
	await br(["init", "--prefix", "pw", "--actor", AUTHOR]);
	mkdirSync(join(repo, "tests"));
	writeFileSync(join(repo, "payload.txt"), "preserved\n");
	writeFileSync(join(repo, "tests/replay.sh"), "#!/bin/sh\n[ -f payload.txt ]\n", { mode: 0o755 });
	const records = ["owned", "trailer", "other"].map(name => ({
		id: `pw-${name}`, title: "Preserve the actual native fixture transition", issue_type: "task", priority: 2,
		created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", created_by: AUTHOR,
		status: "in_progress", assignee: name === "owned" ? AUTHOR : "OtherBuilder", labels: ["fixture"],
		description: "WHAT: (a) preserve native transition state. WHY: ownership must not confuse handoff with close. Planted negative refuses an author close.",
		acceptance_criteria: "- [x] [a] [build] preserve the fixture payload; planted negative rejects a missing payload `sh tests/replay.sh` -> rc 0",
		dependencies: [], comments: [],
	}));
	writeFileSync(join(repo, ".beads/issues.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
	await br(["sync", "--import-only", "--actor", AUTHOR]);
	// Only the unrelated optional ownership transport is a fixture adapter. Guard,
	// publication checks, tracker database and the resulting state transition are real.
	writeFileSync(join(bin, "am"), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "agents" && a[1] === "show") console.log(JSON.stringify({name:process.env.AGENT_NAME}));
else if (a[0] === "file_reservations" && a[1] === "conflicts") console.log("No conflicts detected.");
else process.exit(9);
`, { mode: 0o755 });
	// A valid prior-observation protocol fixture is not a claim that this owned
	// sample repository passed the product's whole suite.
	mkdirSync(join(repo, ".git/omp-kit"), { recursive: true });
	writeFileSync(join(repo, ".git/omp-kit/fresh-gate-runs.jsonl"), JSON.stringify({ version: 2, commit: published, rc: 0, evidence: { complete: true } }) + "\n");
	const state = async (id: string) => {
		const parsed: unknown = JSON.parse(await br(["show", id, "--json"]));
		const row: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
		if (row === null || typeof row !== "object" || !("status" in row) || typeof row.status !== "string") throw new Error("native tracker returned no status");
		return row.status;
	};
	const guard = (id: string, actor: string, sub = "", reason = "") => run(["sh", join(ROOT, "scripts/close-guard.sh"), id, "--db", db,
		...(sub ? ["--sub", sub] : []), ...(reason ? ["--reason", reason] : [])], {
		cwd: repo, env: { ...env, AGENT_NAME: actor }, deadline_s: 30, max_output_bytes: 4 << 20,
	});
	const shim = (args: string[], actor = AUTHOR) => run(["sh", join(ROOT, "scripts/br-shim.sh"), "--db", db, ...args], {
		cwd: repo, env: { ...env, AGENT_NAME: actor }, deadline_s: 30, max_output_bytes: 4 << 20,
	});
	return { dir, repo, origin, published, env, git, br, checked, state, guard, shim, reason: `DONE ${repo}@${published}: native fixture qualification` };
}

function output(result: RunResult): string {
	return decoder.decode(result.stdout) + decoder.decode(result.stderr);
}

test("PWDI author handoff reaches real in_review while the claimant and Agent author cannot close", async () => {
	const f = await fixture();
	const handed = await f.shim(["update", "pw-owned", "--status", "in_review", "--transition-comment", f.reason]);
	expect(handed.rc, output(handed)).toBe(0);
	expect(await f.state("pw-owned")).toBe("in_review");
	for (const args of [
		["close", "pw-owned", "--reason", `Lesson: none\nexport ${f.published}`],
		["update", "pw-owned", "--status", "closed", "--transition-comment", `Lesson: none\nexport ${f.published}`],
	]) {
		const refused = await f.shim(args);
		expect(refused.rc, output(refused)).toBe(4);
		expect(await f.state("pw-owned")).toBe("in_review");
	}
	const trailerHandoff = await f.shim(["update", "pw-trailer", "--status", "in_review", "--transition-comment", f.reason]);
	expect(trailerHandoff.rc, output(trailerHandoff)).toBe(0);
	const trailerClose = await f.shim(["close", "pw-trailer", "--reason", `Lesson: none\nexport ${f.published}`]);
	expect(trailerClose.rc, output(trailerClose)).toBe(4);
	expect(await f.state("pw-trailer")).toBe("in_review");
	const reviewerClose = await f.shim(["close", "pw-owned", "--reason", `Lesson: none\nexport ${f.published}`], REVIEWER);
	expect(reviewerClose.rc, output(reviewerClose)).toBe(0);
	expect(await f.state("pw-owned")).toBe("closed");
}, 120_000);

test("PWDI actual guard preserves legacy grading ownership and non-author close Lesson controls", async () => {
	const f = await fixture();
	for (const id of ["pw-owned", "pw-trailer"]) {
		const legacy = await f.guard(id, AUTHOR);
		expect(legacy.rc, output(legacy)).toBe(4);
		expect(await f.state(id)).toBe("in_progress");
	}
	const eligible = await f.guard("pw-owned", REVIEWER);
	expect(eligible.rc, output(eligible)).toBe(0);
	const missingLesson = await f.guard("pw-owned", REVIEWER, "close", `export ${f.published}`);
	expect(missingLesson.rc, output(missingLesson)).toBe(4);
	expect(await f.state("pw-owned")).toBe("in_progress");
	const withLesson = await f.guard("pw-owned", REVIEWER, "close", `Lesson: none\nexport ${f.published}`);
	expect(withLesson.rc, output(withLesson)).toBe(0);
}, 120_000);

test("PWDI author handoff still refuses unpublished, unresolved and unreachable source authority", async () => {
	const f = await fixture();
	await f.git(["commit", "--allow-empty", "-q", "-m", "unpublished fixture source"]);
	const unpublished = await f.git(["rev-parse", "HEAD"]);
	for (const sha of [unpublished, "0000000000000000000000000000000000000000"]) {
		const refused = await f.guard("pw-owned", AUTHOR, "update", `DONE ${f.repo}@${sha}: evidence`);
		expect(refused.rc, output(refused)).toBe(4);
		expect(output(refused)).toContain("NOT_PUBLISHED");
		expect(await f.state("pw-owned")).toBe("in_progress");
	}
	await f.git(["push", "-q", "origin", "main"]);
	const nowPublished = await f.guard("pw-owned", AUTHOR, "update", `DONE ${f.repo}@${unpublished}: evidence`);
	expect(nowPublished.rc, output(nowPublished)).toBe(0);
	await f.git(["remote", "set-url", "origin", join(f.dir, "absent.git")]);
	const unreachable = await f.guard("pw-owned", AUTHOR, "update", `DONE ${f.repo}@${unpublished}: evidence`);
	expect(unreachable.rc, output(unreachable)).toBe(4);
	expect(output(unreachable)).toContain("NOT_PUBLISHED");
	expect(await f.state("pw-owned")).toBe("in_progress");
}, 120_000);

test("PWDI original sync controls preserve three-behind, fast-forward, dirty and post-push outcomes", async () => {
	const f = await fixture();
	const peer = join(f.dir, "peer");
	await f.checked(["git", "clone", "-q", "--branch", "main", f.origin, peer], f.dir);
	const seed = (args: string[]) => f.checked(["git", "-C", peer, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.example", ...args], peer);
	for (const n of [1, 2, 3]) {
		writeFileSync(join(peer, "tracked.txt"), `${n}\n`);
		await seed(["add", "tracked.txt"]); await seed(["commit", "-q", "-m", `advance ${n}`]);
	}
	await seed(["push", "-q", "origin", "main"]);
	const check = (flags: string[]) => run(["sh", join(ROOT, "scripts/sync-check.sh"), "--repo", f.repo, ...flags], { cwd: f.repo, env: f.env, deadline_s: 30, max_output_bytes: 4 << 20 });
	const refused = await check([]);
	expect(refused.rc, output(refused)).toBe(4);
	expect(output(refused)).toContain("3 commit(s) behind");
	const postPush = await check(["--assert-synced"]);
	expect(postPush.rc, output(postPush)).toBe(4);
	expect(output(postPush)).toContain("POST-PUSH-GAP");
	writeFileSync(join(f.repo, "unrelated.txt"), "keep these uncommitted bytes\n");
	const forwarded = await check(["--fast-forward"]);
	expect(forwarded.rc, output(forwarded)).toBe(0);
	expect(await f.git(["rev-parse", "HEAD"])).toBe(await f.git(["rev-parse", "origin/main"]));
	expect(readFileSync(join(f.repo, "unrelated.txt"), "utf8")).toBe("keep these uncommitted bytes\n");
	expect((await check(["--assert-synced"])).rc).toBe(0);
	writeFileSync(join(f.repo, "tracked.txt"), "precious local edit\n");
	writeFileSync(join(peer, "tracked.txt"), "new remote value\n");
	await seed(["add", "tracked.txt"]); await seed(["commit", "-q", "-m", "overlapping upstream"]); await seed(["push", "-q", "origin", "main"]);
	const before = await f.git(["rev-parse", "HEAD"]);
	const dirty = await check(["--fast-forward"]);
	expect(dirty.rc, output(dirty)).toBe(4);
	expect(await f.git(["rev-parse", "HEAD"])).toBe(before);
	expect(readFileSync(join(f.repo, "tracked.txt"), "utf8")).toBe("precious local edit\n");
	writeFileSync(join(f.repo, "tracked.txt"), "3\n");
	await f.git(["commit", "--allow-empty", "-q", "-m", "local divergence"]);
	const divergentHead = await f.git(["rev-parse", "HEAD"]);
	const diverged = await check(["--fast-forward"]);
	expect(diverged.rc, output(diverged)).toBe(4);
	expect(output(diverged)).toContain("DIVERGED");
	expect(await f.git(["rev-parse", "HEAD"])).toBe(divergentHead);
}, 120_000);
