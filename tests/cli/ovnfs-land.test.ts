import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const root = ownedTmp("ovnfs-land-test");
afterAll(() => root.cleanup());
const cli = resolve(import.meta.dir, "../../src/cli.ts");
let sequence = 0;

function command(cwd: string, argv: string[], env: Record<string, string>) {
	const p = runFixture(argv, { cwd, env, floor_s: 90 });
	const stdout = Buffer.from(p.stdout).toString(), stderr = Buffer.from(p.stderr).toString();
	if (p.rc !== 0 || p.truncated) throw new Error(`${argv.join(" ")} -> ${p.rc}\n${stdout}\n${stderr}`);
	return stdout.trim();
}

function fixture() {
	const dir = join(root.path, String(sequence++));
	mkdirSync(dir);
	const home = join(dir, "home");
	mkdirSync(home);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
	Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, TMPDIR: root.path });
	const git = (cwd: string, ...args: string[]) => command(cwd, ["git", "--literal-pathspecs", ...args], env);
	const repo = join(dir, "main"), remote = join(dir, "origin.git");
	mkdirSync(repo);
	git(dir, "init", "--bare", "--initial-branch=main", remote);
	git(repo, "init", "--initial-branch=main");
	git(repo, "config", "user.name", "Landing fixture");
	git(repo, "config", "user.email", "fixture@example.invalid");
	for (const path of ["a.txt", "b.txt", "peer.txt", "old.txt"]) writeFileSync(join(repo, path), `base ${path}\n`);
	writeFileSync(join(repo, "a.txt"), Array.from({ length: 20 }, (_, i) => `line${i}\n`).join(""));
	git(repo, "add", "--", "a.txt", "b.txt", "peer.txt", "old.txt");
	git(repo, "commit", "-m", "base [test]");
	git(repo, "remote", "add", "origin", remote);
	git(repo, "push", "origin", "main");
	const base = git(repo, "rev-parse", "HEAD");
	function worker(independent = false) {
		const checkout = join(dir, `worker-${sequence++}`);
		if (!independent) {
			git(repo, "worktree", "add", "-b", `builder-${sequence++}`, checkout, base);
		} else {
			mkdirSync(checkout);
			git(checkout, "init", "--initial-branch=main");
			git(checkout, "fetch", repo, base);
			git(checkout, "checkout", "FETCH_HEAD");
			git(checkout, "config", "user.name", "Worker fixture");
			git(checkout, "config", "user.email", "worker@example.invalid");
		}
		return checkout;
	}
	function commit(checkout: string, path: string, content: string, message = "worker change [test]\n\nBead: fixture-1") {
		writeFileSync(join(checkout, path), content);
		git(checkout, "add", "--", path);
		git(checkout, "commit", "-m", message);
	}
	function land(checkout: string, extra: string[] = []) {
		const p = runFixture([process.execPath, cli, "ovnfs-land", "--repo", repo, "--checkout", checkout, "--base", base, "--apply", "--yes", "--json", ...extra], {
			cwd: dir, env, floor_s: 90,
		});
		const stdout = Buffer.from(p.stdout).toString(), stderr = Buffer.from(p.stderr).toString();
		let body;
		try { body = JSON.parse(stdout); } catch { throw new Error(`CLI output: ${stdout}\n${stderr}`); }
		return { code: p.rc, data: body.data, stderr };
	}
	function snapshot() {
		return {
			head: git(repo, "rev-parse", "HEAD"), index: readFileSync(join(repo, ".git", "index")).toString("base64"),
			status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
			a: readFileSync(join(repo, "a.txt"), "utf8"), b: readFileSync(join(repo, "b.txt"), "utf8"),
			remote: git(dir, "--git-dir", remote, "rev-parse", "refs/heads/main"),
		};
	}
	return { dir, env, git, repo, remote, base, worker, commit, land, snapshot };
}

type LandedFixture = { repo: string; dir: string; remote: string; git(cwd: string, ...args: string[]): string };

function assertLanded(f: LandedFixture, paths: string[], sha: string) {
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(sha);
	expect(f.git(f.dir, "--git-dir", f.remote, "rev-parse", "main")).toBe(sha);
	expect(f.git(f.repo, "diff", "--cached", "--name-only", sha, "--", ...paths)).toBe("");
	expect(f.git(f.repo, "diff", "--name-only", "--", ...paths)).toBe("");
}

test("two linked builder worktrees land sequentially through CLI hooks; main, index, tree and origin agree", () => {
	const f = fixture(), first = f.worker(), second = f.worker();
	f.commit(first, "a.txt", "worker one\n", "first [test]\n\nBead: fixture-1");
	f.commit(first, "a.txt", "worker one final\n", "first followup [test]\n\nBead: fixture-1");
	f.commit(second, "b.txt", "worker two\n", "second [test]\n\nBead: fixture-2");
	const hookLog = join(f.dir, "hooks.log");
	for (const [hook, body] of [
		["pre-commit", `printf 'pre-commit\\n' >> '${hookLog}'`],
		["commit-msg", `cat "$1" >> '${hookLog}'`],
		["pre-push", `printf 'pre-push\\n' >> '${hookLog}'`],
	]) {
		writeFileSync(join(f.repo, ".git", "hooks", hook!), `#!/bin/sh\n${body}\n`);
		chmodSync(join(f.repo, ".git", "hooks", hook!), 0o755);
	}
	const a = f.land(first);
	expect(a.code).toBe(0);
	expect(a.data.overall).toBe("PUSHED");
	assertLanded(f, ["a.txt"], a.data.commit);
	const b = f.land(second);
	expect(b.code).toBe(0);
	assertLanded(f, ["a.txt", "b.txt"], b.data.commit);
	expect(f.git(f.repo, "show", "-s", "--format=%P", b.data.commit)).toBe(a.data.commit);
	expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("worker one final\n");
	expect(readFileSync(join(f.repo, "b.txt"), "utf8")).toBe("worker two\n");
	expect(f.git(f.repo, "log", "-1", "--format=%B")).toBe("second [test]\n\nBead: fixture-2");
	const hooks = readFileSync(hookLog, "utf8");
	expect(hooks).toContain("pre-commit\nfirst [test]");
	expect(hooks).toContain("pre-push\npre-commit\nsecond [test]");
	expect(hooks).toContain("pre-commit\nfirst followup [test]");
	expect(f.git(f.repo, "log", "--reverse", "--format=%s", `${f.base}..HEAD`)).toBe("first [test]\nfirst followup [test]\nsecond [test]");
	expect(f.git(first, "log", "-1", "--format=%s")).toBe("first followup [test]");
	expect(f.git(second, "symbolic-ref", "--short", "HEAD")).toStartWith("builder-");
}, fixtureDeadlineS(90) * 1000);

test("simultaneous disjoint workers serialize through commit and push", async () => {
	const f = fixture(), first = f.worker(), second = f.worker();
	f.commit(first, "a.txt", "parallel one\n");
	f.commit(second, "b.txt", "parallel two\n");
	const results = await Promise.all([first, second].map(checkout => run([
		process.execPath, cli, "ovnfs-land", "--repo", f.repo, "--checkout", checkout,
		"--base", f.base, "--apply", "--yes", "--json",
	], { cwd: f.dir, env: f.env, deadline_s: fixtureDeadlineS(90), max_output_bytes: 4 * 1024 * 1024 })));
	for (const output of results) {
		expect(output.rc).toBe(0);
		expect(JSON.parse(Buffer.from(output.stdout).toString()).data.overall).toBe("PUSHED");
	}
	const head = f.git(f.repo, "rev-parse", "HEAD");
	assertLanded(f, ["a.txt", "b.txt"], head);
	expect(f.git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe("2");
	expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("parallel one\n");
	expect(readFileSync(join(f.repo, "b.txt"), "utf8")).toBe("parallel two\n");
}, fixtureDeadlineS(90) * 1000);

for (const kind of ["unstaged", "staged", "untracked", "ignored"] as const) {
	test(`planted negative: ${kind} parent path refuses without changing index, ref, bytes or origin`, () => {
		const f = fixture(), worker = f.worker();
		const path = kind === "untracked" || kind === "ignored" ? "new.txt" : "a.txt";
		f.commit(worker, path, "worker delta\n");
		if (kind === "ignored") writeFileSync(join(f.repo, ".git", "info", "exclude"), "new.txt\n");
		writeFileSync(join(f.repo, path), "peer owns these bytes\n");
		if (kind === "staged") f.git(f.repo, "add", "--", path);
		const before = f.snapshot();
		const refused = f.land(worker);
		expect(refused.code).toBe(1);
		expect(refused.data.reason).toBe("PARENT_DIRTY");
		expect(refused.data.text).toContain(path);
		expect(refused.data.applied).toBe(false);
		expect(f.snapshot()).toEqual(before);
		expect(readFileSync(join(f.repo, path), "utf8")).toBe("peer owns these bytes\n");
		expect(f.git(worker, "show", `HEAD:${path}`)).toBe("worker delta");
		expect(f.git(worker, "symbolic-ref", "--short", "HEAD")).toStartWith("builder-");
	}, fixtureDeadlineS(90) * 1000);
}

test("planted negative: second worker diverges on the same path even with nonoverlapping hunks", () => {
	const f = fixture(), first = f.worker(), second = f.worker();
	const original = readFileSync(join(first, "a.txt"), "utf8");
	f.commit(first, "a.txt", original.replace("line0\n", "first winner\n"));
	f.commit(second, "a.txt", original.replace("line19\n", "stale loser\n"));
	expect(f.land(first).code).toBe(0);
	const before = f.snapshot(), refused = f.land(second);
	expect(refused.code).toBe(1);
	expect(refused.data.reason).toBe("PATH_DIVERGED");
	expect(refused.data.text).toContain("a.txt");
	expect(refused.data.applied).toBe(false);
	expect(f.snapshot()).toEqual(before);
	expect(f.git(second, "symbolic-ref", "--short", "HEAD")).toStartWith("builder-");
	expect(readFileSync(join(second, "a.txt"), "utf8")).toContain("stale loser");
}, fixtureDeadlineS(90) * 1000);

test("binary, rename, executable and literal filenames land while unrelated staged/unstaged bytes survive", () => {
	const f = fixture(), worker = f.worker();
	f.git(worker, "mv", "old.txt", "renamed file.txt");
	const binary = Buffer.from([0, 255, 1, 0, 13, 10]);
	writeFileSync(join(worker, "[literal]*.bin"), binary);
	writeFileSync(join(worker, "script.sh"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(worker, "script.sh"), 0o755);
	f.git(worker, "add", "--", "[literal]*.bin", "script.sh");
	f.git(worker, "commit", "-m", "binary and rename [test]");
	writeFileSync(join(f.repo, "peer.txt"), "peer staged\n");
	f.git(f.repo, "add", "--", "peer.txt");
	writeFileSync(join(f.repo, "peer.txt"), "peer unstaged\n");
	const result = f.land(worker);
	expect(result.code).toBe(0);
	assertLanded(f, ["old.txt", "renamed file.txt", "[literal]*.bin", "script.sh"], result.data.commit);
	expect(readFileSync(join(f.repo, "[literal]*.bin"))).toEqual(binary);
	expect(f.git(f.repo, "ls-tree", "HEAD", "--", "script.sh")).toStartWith("100755 blob");
	expect(f.git(f.repo, "show", ":peer.txt")).toBe("peer staged");
	expect(readFileSync(join(f.repo, "peer.txt"), "utf8")).toBe("peer unstaged\n");
	expect(f.git(f.repo, "show", "HEAD:peer.txt")).toBe("base peer.txt");
}, fixtureDeadlineS(90) * 1000);

test("commit gate rejection is not published or hidden; applied bytes remain inspectable", () => {
	const f = fixture(), worker = f.worker();
	f.commit(worker, "a.txt", "worker\n");
	writeFileSync(join(f.repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf 'PLANTED_COMMIT_REFUSAL\\n' >&2\nexit 1\n");
	chmodSync(join(f.repo, ".git", "hooks", "commit-msg"), 0o755);
	const result = f.land(worker);
	expect(result.code).toBe(1);
	expect(result.data.applied).toBe(true);
	expect(result.data.published).toBe(false);
	expect(result.data.text).toContain("PLANTED_COMMIT_REFUSAL");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
	expect(f.git(f.dir, "--git-dir", f.remote, "rev-parse", "main")).toBe(f.base);
	expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("worker\n");
	expect(f.git(worker, "symbolic-ref", "--short", "HEAD")).toStartWith("builder-");
	expect(readFileSync(join(worker, "a.txt"), "utf8")).toBe("worker\n");
}, fixtureDeadlineS(90) * 1000);

test("dirty worker is refused rather than silently losing uncommitted changes", () => {
	const f = fixture(), worker = f.worker();
	f.commit(worker, "a.txt", "committed\n");
	writeFileSync(join(worker, "b.txt"), "not committed\n");
	const before = f.snapshot(), result = f.land(worker);
	expect(result.code).toBe(1);
	expect(result.data.reason).toBe("WORKER_DIRTY");
	expect(f.snapshot()).toEqual(before);
}, fixtureDeadlineS(90) * 1000);

test("an independent committed checkout remains supported", () => {
	const f = fixture(), worker = f.worker(true);
	f.commit(worker, "b.txt", "independent worker\n");
	const result = f.land(worker);
	expect(result.code).toBe(0);
	assertLanded(f, ["b.txt"], result.data.commit);
}, fixtureDeadlineS(90) * 1000);

test("main touching then reverting a worker path is still divergence", () => {
	const f = fixture(), worker = f.worker();
	f.commit(worker, "b.txt", "worker\n");
	f.commit(f.repo, "b.txt", "main changed\n");
	f.commit(f.repo, "b.txt", "base b.txt\n");
	const before = f.snapshot(), result = f.land(worker);
	expect(result.code).toBe(1);
	expect(result.data.reason).toBe("PATH_DIVERGED");
	expect(result.data.applied).toBe(false);
	expect(f.snapshot()).toEqual(before);
}, fixtureDeadlineS(90) * 1000);

test("worker paths touched then reverted are admitted and landed as separate commits", () => {
	const f = fixture(), worker = f.worker();
	f.commit(worker, "b.txt", "temporary worker content\n", "worker edit [test]");
	f.commit(worker, "b.txt", "base b.txt\n", "worker revert [test]");
	const result = f.land(worker);
	expect(result.code).toBe(0);
	assertLanded(f, ["b.txt"], result.data.commit);
	expect(f.git(f.repo, "log", "--reverse", "--format=%s", `${f.base}..HEAD`)).toBe("worker edit [test]\nworker revert [test]");
}, fixtureDeadlineS(90) * 1000);

// Opt-in native adapter smoke: every daemon state, mount, checkout and repo is under
// this test's owned TMPDIR. Relative state paths avoid Unix socket length limits.
test.skipIf(process.env.OVNFS_LAND_LIVE !== "1")("live ovnfs private checkout lands and is removed without apply", () => {
	const f = fixture();
	const ovnfs = (...args: string[]) => command(f.dir, ["ovnfs", "--state", "s", "--mount", "m", ...args], f.env);
	let started = false, created = false;
	try {
		ovnfs("start", "--json"); started = true;
		const reply = ovnfs("new", f.repo, "--rev", f.base, "--name", "landing-worker", "--json"); created = true;
		console.log(`OVNFS_NEW ${reply}`);
		const checkout = join(f.dir, "m", "landing-worker");
		f.commit(checkout, "a.txt", "real ovnfs delta\n");
		const result = f.land(checkout);
		expect(result.code).toBe(0);
		assertLanded(f, ["a.txt"], result.data.commit);
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("real ovnfs delta\n");
	} finally {
		if (created) ovnfs("rm", "landing-worker");
		if (started) ovnfs("stop");
	}
}, fixtureDeadlineS(90) * 1000);
