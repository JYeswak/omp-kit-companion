import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("commit-gate-lock");
afterAll(() => scratch.cleanup());
const check = process.env.COMMIT_GATE_CHECK ?? join(root, "scripts/check-commit-gate.sh");
const env: Record<string, string | undefined> = { ...process.env, TMPDIR: scratch.path, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Gate fixture", GIT_AUTHOR_EMAIL: "gate@example.invalid",
	GIT_COMMITTER_NAME: "Gate fixture", GIT_COMMITTER_EMAIL: "gate@example.invalid" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
const text = (r: { stdout: Uint8Array; stderr: Uint8Array }) => new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
let sequence = 0;
async function command(repo: string, argv: string[], extra: Record<string, string> = {}) {
	return runFixtureAsync(argv, { cwd: repo, env: { ...env, ...extra }, floor_s: 30 });
}
async function good(repo: string, argv: string[], extra: Record<string, string> = {}) {
	const r = await command(repo, argv, extra);
	expect(r.rc, text(r)).toBe(0);
	return new TextDecoder().decode(r.stdout).trim();
}
async function fixture() {
	const repo = join(scratch.path, `repo-${++sequence}`);
	mkdirSync(repo);
	await good(repo, ["git", "init", "--template=", "-q", "-b", "main"]);
	writeFileSync(join(repo, "a"), "base\n"); writeFileSync(join(repo, "b"), "base\n");
	await good(repo, ["git", "add", "a", "b"]);
	await good(repo, ["git", "commit", "-qm", "base"]);
	await good(repo, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
	const hooks = join(repo, ".git/hooks");
	mkdirSync(join(hooks, "hooks.d/pre-push"), { recursive: true });
	writeFileSync(join(hooks, "commit-msg"), `#!/bin/sh\nexec sh '${check}' "$@"\n`);
	chmodSync(join(hooks, "commit-msg"), 0o755);
	const gate = join(hooks, "hooks.d/pre-push/40-omp-kit-fresh-gate");
	// Bounded fixture judge at the real installed push-gate boundary. The
	// candidate, not the mutable worktree or shared index, determines RED.
	writeFileSync(gate, `#!/bin/sh
read -r lref candidate rref base
if [ "\${BLOCK_GATE:-0}" = 1 ]; then
  printf ready > "$READY"
  read -r release < "$FIFO"
fi
if git cat-file -e "$candidate:BROKEN" 2>/dev/null; then
  echo 'planted RED BROKEN' >&2
  exit 7
fi
git rev-parse "$candidate^{tree}" >> "$PWD/judged"
`);
	chmodSync(gate, 0o755);
	const msg = join(repo, "message"); writeFileSync(msg, "[test] candidate\n\nBead: fixture-1\n");
	return { repo, msg, gate };
}

test("GATELOCK1 another writer stages and commits while the first tree is judged; changed parent refuses", async () => {
	const { repo, msg } = await fixture();
	writeFileSync(join(repo, "a"), "first\n");
	const fifo = join(repo, "release"), ready = join(repo, "ready");
	await good(repo, ["mkfifo", fifo]);
	const { promise: readyPromise, resolve: signalReady } = Promise.withResolvers<void>();
	const watcher = watch(repo, () => { if (existsSync(ready)) signalReady(); });
	const first = command(repo, ["sh", check, "--prepare", msg, "--files", "a"], { BLOCK_GATE: "1", FIFO: fifo, READY: ready });
	try {
		await Promise.race([readyPromise, first.then(r => { throw new Error(`gate ended before ready: ${text(r)}`); })]);
		try {
			expect(existsSync(join(repo, ".git/index.lock"))).toBe(false);
			writeFileSync(join(repo, "b"), "second\n");
			await good(repo, ["git", "add", "b"]);
			await good(repo, ["sh", check, "--prepare", msg, "--files", "b"]);
			await good(repo, ["git", "commit", "--only", "-q", "-F", msg, "--", "b"]);
			expect(await good(repo, ["git", "show", "HEAD:b"])).toBe("second");
		} finally { writeFileSync(fifo, "release\n"); }
		expect((await first).rc).toBe(0);
		const refused = await command(repo, ["git", "commit", "--only", "-q", "-F", msg, "--", "a"]);
		expect(refused.rc, text(refused)).not.toBe(0);
		expect(text(refused)).toContain("HEAD changed");
	} finally { watcher.close(); }
}, fixtureDeadlineS(120) * 1000);

test("GATELOCK1 index mutation names the changed path, unchanged tree commits, and RED never admits", async () => {
	const { repo, msg } = await fixture();
	writeFileSync(join(repo, "a"), "approved\n");
	await good(repo, ["git", "add", "a"]);
	await good(repo, ["sh", check, "--prepare", msg]);
	writeFileSync(join(repo, "b"), "unjudged\n");
	await good(repo, ["git", "add", "b"]);
	const refused = await command(repo, ["git", "commit", "-q", "-F", msg]);
	expect(refused.rc, text(refused)).not.toBe(0);
	expect(text(refused)).toContain("INDEX_CHANGED");
	expect(text(refused)).toContain("b");
	await good(repo, ["sh", check, "--prepare", msg]);
	await good(repo, ["git", "commit", "-q", "-F", msg]);
	expect(await good(repo, ["git", "show", "HEAD:b"])).toBe("unjudged");
	writeFileSync(join(repo, "BROKEN"), "planted\n");
	await good(repo, ["git", "add", "BROKEN"]);
	const red = await command(repo, ["sh", check, "--prepare", msg]);
	expect(red.rc, text(red)).toBe(7);
	expect(text(red)).toContain("planted RED BROKEN");
	expect((await command(repo, ["git", "commit", "-q", "-F", msg])).rc).not.toBe(0);
}, fixtureDeadlineS(120) * 1000);
