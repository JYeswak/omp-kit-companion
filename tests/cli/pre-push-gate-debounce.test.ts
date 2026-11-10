import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("post-push-debounce").path;
afterAll(cleanupAllOwnedTmp);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function fixture(name: string) {
	const work = join(scratch, name), repo = join(work, "repo"), origin = join(work, "origin.git");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	const env: Record<string, string | undefined> = { ...process.env, GIT_CEILING_DIRECTORIES: work,
		OMP_KIT_RELEASE_VERDICT_QUIET_S: "1", PRE_PUSH_FULL_SUITE: "release" };
	delete env.OMP_KIT_RELEASE_VERDICT;
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CEILING_DIRECTORIES") delete env[key];
	async function git(...args: string[]) {
		const r = await runFixtureAsync(["git", ...args], { cwd: repo, env, floor_s: 30 });
		expect(r.rc, text(r.stdout) + text(r.stderr)).toBe(0);
		return text(r.stdout).trim();
	}
	for (const file of ["pre-push-gate.sh", "kitlib_run.py", "pysafe.py"]) copyFileSync(join(root, "scripts", file), join(repo, "scripts", file));
	writeFileSync(join(repo, "scripts/release-verdict.sh"), '#!/bin/sh\nprintf "%s\\n" "$*" >>"$(git rev-parse --absolute-git-dir)/started"\n');
	await git("init", "-q", "--template=", "-b", "main");
	await git("config", "user.email", "fixture@example.invalid");
	await git("config", "user.name", "fixture");
	await git("add", "."); await git("commit", "-qm", "base [test]");
	const base = await git("rev-parse", "HEAD");
	await git("init", "--bare", "-q", "--template=", origin);
	await git("remote", "add", "origin", origin); await git("push", "-q", "origin", "main");
	writeFileSync(join(repo, "candidate"), "candidate\n"); await git("add", "candidate"); await git("commit", "-qm", "candidate [test]");
	const sha = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
	// Seed the adapter's existing exact commit-gate parity result, not a full-suite verdict.
	// This makes a real git push reach the post-push boundary without unrelated checker fixtures.
	const message = await runFixtureAsync(["git", "hash-object", "--stdin"], { cwd: repo, env, stdin: "candidate [test]\n", floor_s: 10 });
	const gate = await git("hash-object", "scripts/pre-push-gate.sh");
	const keyResult = await runFixtureAsync(["git", "hash-object", "--stdin"], { cwd: repo, env,
		stdin: `commit-gate-v1\n${tree}\n${base}\n${base}\n${text(message.stdout).trim()}\n${gate}\n`, floor_s: 10 });
	expect(message.rc).toBe(0); expect(keyResult.rc).toBe(0);
	const state = join(repo, ".git/omp-kit"); mkdirSync(join(state, "commit-gate-pass"), { recursive: true });
	writeFileSync(join(state, "commit-gate-pass", text(keyResult.stdout).trim()), "PASS\n");
	mkdirSync(join(repo, ".git/hooks"));
	writeFileSync(join(repo, ".git/hooks/pre-push"), '#!/bin/sh\nexec sh "$(git rev-parse --show-toplevel)/scripts/pre-push-gate.sh" "$@"\n');
	chmodSync(join(repo, ".git/hooks/pre-push"), 0o755);
	const log = join(state, "release-verdict.log"), started = join(repo, ".git/started");
	async function push() { return git("push", "-q", "origin", "main"); }
	// The child is a separate OS process; await its log condition, not a guessed completion delay.
	async function waitFor(...needles: string[]) {
		const deadline = Date.now() + fixtureDeadlineS(15) * 1000;
		while (!(existsSync(log) && needles.some(needle => readFileSync(log, "utf8").includes(needle)))) {
			if (Date.now() > deadline) throw new Error(`missing ${needles.join(" or ")}: ${existsSync(log) ? readFileSync(log, "utf8") : "no log"}`);
			await Bun.sleep(20);
		}
	}
	return { repo, origin, sha, env, git, push, waitFor, log, started };
}

test("default-on main push qualifies after QUIET_S=1 when fetched main is unchanged", async () => {
	const f = await fixture("unchanged");
	await f.push(); await f.waitFor("qualification finished");
	expect(readFileSync(f.started, "utf8").trim()).toBe(`--commit ${f.sha} --no-fetch`);
	expect(readFileSync(f.log, "utf8")).toContain("quiet interval 1s");
}, fixtureDeadlineS(60) * 1000);

test("main moved during the quiet interval records superseded and never starts a verdict", async () => {
	const f = await fixture("moved");
	// Transfer the future object before scheduling, so moving remote main during the wait is one local ref update.
	await f.git("commit", "-q", "--allow-empty", "-m", "newer [test]");
	const newer = await f.git("rev-parse", "HEAD");
	await f.git("--git-dir", f.origin, "fetch", "-q", f.repo, newer);
	// Push the qualified candidate explicitly; main's local HEAD is intentionally newer.
	await f.git("push", "-q", "origin", `${f.sha}:refs/heads/main`);
	await f.waitFor("quiet interval 1s");
	await f.git("--git-dir", f.origin, "update-ref", "refs/heads/main", newer);
	await f.waitFor(`superseded by ${newer}`, "qualification finished");
	expect(readFileSync(f.log, "utf8")).toContain(`superseded by ${newer}`);
	expect(existsSync(f.started)).toBe(false);
}, fixtureDeadlineS(60) * 1000);

test("OMP_KIT_RELEASE_VERDICT=0 leaves no child or qualification log", async () => {
	const f = await fixture("optout"); f.env.OMP_KIT_RELEASE_VERDICT = "0";
	await f.push();
	expect(existsSync(f.log)).toBe(false); expect(existsSync(f.started)).toBe(false);
}, fixtureDeadlineS(60) * 1000);
