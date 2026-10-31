import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const source = resolve(import.meta.dir, "../..");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function fixture(foreign = false, required = 2) {
	const root = ownedTmp("informing-gate").path;
	const repo = join(root, "repo");
	const empty = join(root, "empty-template");
	mkdirSync(empty, { recursive: true });
	mkdirSync(join(repo, "tests", "scripts"), { recursive: true });
	mkdirSync(join(repo, "scripts"), { recursive: true });
	copyFileSync(join(source, "scripts", "kitlib-tmp.sh"), join(repo, "scripts", "kitlib-tmp.sh"));
	writeFileSync(join(repo, "tests", "scripts", "probe_test.py"), "import os\nassert 2 + 2 == 4\nassert os.environ.get('INFORMING_FIXTURE_FAIL') != '1'\n");
	const global = join(root, "gitconfig");
	writeFileSync(global, `[init]\n\ttemplateDir = ${empty}\n\tdefaultBranch = main\n`);
	const env: Record<string, string> = { ...process.env, GIT_CONFIG_GLOBAL: global,
		XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: root } as Record<string, string>;
	for (const name of ["BEADS_DB", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"]) delete env[name];
	const command = (argv: string[], stdin?: Uint8Array) => run(argv, { cwd: repo, env, deadline_s: 120,
		max_output_bytes: 8 * 1024 * 1024, ...(stdin ? { stdin } : {}) });
	const checked = async (argv: string[]) => {
		const result = await command(argv);
		if (result.rc !== 0) throw new Error(`${JSON.stringify(argv)} -> ${result.rc}\n${text(result.stdout)}\n${text(result.stderr)}`);
		return text(result.stdout).trim();
	};
	await checked(["git", "init", "-q"]);
	await checked(["git", "config", "user.name", "Fixture"]);
	await checked(["git", "config", "user.email", "fixture@example.invalid"]);
	await checked(["git", "add", "tests", "scripts"]);
	await checked(["git", "commit", "-q", "-m", "fixture [test]"]);
	const sha = await checked(["git", "rev-parse", "HEAD"]);
	const hooks = join(repo, ".git", "hooks");
	const chain = join(hooks, "hooks.d", "pre-commit");
	mkdirSync(chain, { recursive: true });
	const member = join(chain, "95-fixture-rollout");
	writeFileSync(member, `#!/bin/sh\n# omp-kit-rollout: informing ${required}\nprintf 'FINDING\\tfixture\\tPLANTED\\tplanted informing failure\\tfix fixture\\t-\\n'\nprintf '%s' "$PWD:$*" >&2\nexit 7\n`);
	chmodSync(member, 0o755);
	if (foreign) {
		writeFileSync(join(hooks, "pre-commit"), '#!/bin/sh\n# foreign hooks.d chain, intentionally not the kit runner\nhere=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nfor member in "$here/hooks.d/pre-commit"/[0-9][0-9]-*; do\n [ -x "$member" ] || continue\n "$member" "$@" || exit "$?"\ndone\n');
		chmodSync(join(hooks, "pre-commit"), 0o755);
	}
	const installed = await command(["sh", join(source, "scripts", "install-commit-msg-bead.sh"), "--no-pushed-beads", repo]);
	if (installed.rc !== 0) throw new Error(`install -> ${installed.rc}\n${text(installed.stdout)}\n${text(installed.stderr)}`);
	const history = join(repo, ".git", "omp-kit", "gate-rollout", "full-runs.jsonl");
	const verdicts = join(repo, ".git", "omp-kit", "gate-rollout", "member-verdicts.jsonl");
	const hook = (...args: string[]) => command(["sh", join(hooks, "pre-commit"), ...args]);
	const full = (identity: string, commit = sha, failing = false, qualify = false) => run(["sh", join(source, "scripts", "full-suite-verdict.sh"),
		"--repo", repo, "--commit", commit, "--judge-role", "main", ...(qualify ? ["--qualify-informing"] : [])], { cwd: source,
		env: { ...env, FULL_SUITE_RUNTIME_ID: identity, INFORMING_FIXTURE_FAIL: failing ? "1" : "0" }, deadline_s: 120, max_output_bytes: 8 * 1024 * 1024 });
	return { root, repo, hooks, chain, member, sha, env, command, checked, hook, full, history, verdicts };
}

for (const foreign of [false, true]) {
	test(`INFORMING1: failing informing member admits a real pre-commit consumer; unmarked blocking control still refuses (${foreign ? "foreign" : "kit"} chain)`, async () => {
		const f = await fixture(foreign);
		const result = await f.hook();
		expect(result.rc, text(result.stdout) + text(result.stderr)).toBe(0);
		expect(text(result.stdout)).toContain("INFORMING 95-fixture-rollout: FINDING");
		expect(text(result.stderr)).toContain(`${f.repo}:`);
		const rows = readFileSync(f.verdicts, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(rows.at(-1)).toMatchObject({ member: "95-fixture-rollout", mode: "informing", rc: 7,
			finding: true, green_runs: 0, required_green: 2, commit: f.sha });
		// Exercise Git itself, restricted to this pre-commit boundary; unrelated commit-msg/ref guards are not this test.
		const boundary = join(f.root, "pre-commit-boundary");
		mkdirSync(boundary);
		// A forwarding launcher retains the actual installed chain's directory resolution.
		writeFileSync(join(boundary, "pre-commit"), `#!/bin/sh\nexec sh ${JSON.stringify(join(f.hooks, "pre-commit"))} "$@"\n`);
		chmodSync(join(boundary, "pre-commit"), 0o755);
		const admitted = await f.command(["git", "-c", `core.hooksPath=${boundary}`, "commit", "-q", "--allow-empty", "-m", "informing admitted [test]"]);
		expect(admitted.rc).toBe(0);
		writeFileSync(join(f.chain, "96-established-blocking"), "#!/bin/sh\necho 'established refusal' >&2\nexit 9\n");
		chmodSync(join(f.chain, "96-established-blocking"), 0o755);
		const refused = await f.command(["git", "-c", `core.hooksPath=${boundary}`, "commit", "-q", "--allow-empty", "-m", "blocking refused [test]"]);
		expect(refused.rc).toBe(1);
		expect(text(refused.stderr)).toContain("established refusal");
	}, 120_000);
}

test("INFORMING1: only distinct real complete green main runs on one exact commit promote; cache hits do not count; promoted failures block", async () => {
	const f = await fixture(true);
	const first = await f.full("same-context-green");
	expect(first.rc, text(first.stdout) + text(first.stderr)).toBe(0);
	expect(text(first.stdout)).toContain("FULL-SUITE: VERDICT PASS");
	const once = readFileSync(f.history, "utf8");
	const cached = await f.full("same-context-green");
	expect(cached.rc).toBe(0);
	expect(text(cached.stdout)).toContain("VERDICT REUSED PASS");
	expect(readFileSync(f.history, "utf8")).toBe(once);
	expect((await f.hook()).rc).toBe(0);
	const failure = await f.full("failed-full-run", f.sha, true);
	expect(failure.rc).not.toBe(0);
	expect(text(failure.stderr)).toContain("VERDICT FAIL");
	const second = await f.full("same-context-green", f.sha, false, true);
	expect(second.rc).toBe(0);
	expect((await f.hook()).rc).toBe(0);
	const third = await f.full("same-context-green", f.sha, false, true);
	expect(third.rc).toBe(0);
	const promoted = await f.hook();
	expect(promoted.rc).toBe(7);
	expect(text(promoted.stderr)).toContain('"mode": "blocking"');
	const recorded = JSON.parse(readFileSync(join(f.chain, ".95-fixture-rollout.rollout.json"), "utf8"));
	expect(recorded.promoted).toMatchObject({ commit: f.sha, green_runs: 2 });
	const laterMember = join(f.chain, "97-added-after-green");
	writeFileSync(laterMember, "#!/bin/sh\n# omp-kit-rollout: informing 2\necho 'new member failure' >&2\nexit 7\n");
	chmodSync(laterMember, 0o755);
	await f.checked(["python3", join(source, "scripts", "gate-rollout.py"), "install", "--hooks", f.hooks]);
	const later = await f.command([laterMember]);
	expect(later.rc).toBe(0);
	expect(text(later.stderr)).toContain('"green_runs": 0');
	writeFileSync(f.member, "#!/bin/sh\n# omp-kit-rollout: informing 2\necho 'new payload revision' >&2\nexit 8\n");
	chmodSync(f.member, 0o755);
	await f.checked(["python3", join(source, "scripts", "gate-rollout.py"), "install", "--hooks", f.hooks]);
	const changed = await f.command([f.member]);
	expect(changed.rc).toBe(0);
	expect(text(changed.stderr)).toContain('"green_runs": 0');
	expect(JSON.parse(readFileSync(join(f.chain, ".95-fixture-rollout.rollout.json"), "utf8")).promoted).toBeNull();
}, 120_000);

test("INFORMING1: a different commit or incomplete full-run start cannot promote; corrupt history stays informing with an explicit reason", async () => {
	const f = await fixture(true);
	const original = await f.full("old-commit-green");
	expect(original.rc, text(original.stdout) + text(original.stderr)).toBe(0);
	await f.checked(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "next fixture [test]"]);
	const next = await f.checked(["git", "rev-parse", "HEAD"]);
	expect((await f.full("new-commit-green", next)).rc).toBe(0);
	expect((await f.hook()).rc).toBe(0);
	const begin = await f.command(["python3", join(source, "scripts", "gate-rollout.py"), "begin", "--repo", f.repo, "--commit", next]);
	expect(begin.rc).toBe(0);
	const incomplete = await f.hook();
	expect(incomplete.rc).toBe(0);
	expect(text(incomplete.stderr)).toContain('"green_runs": 0');
	writeFileSync(f.history, "{broken\n");
	const corrupt = await f.hook();
	expect(corrupt.rc).toBe(0);
	expect(text(corrupt.stderr)).toContain("full-run history incomplete");
	renameSync(f.history, f.history + ".retained");
	symlinkSync(f.history + ".retained", f.history);
	const unreadable = await f.hook();
	expect(unreadable.rc).toBe(0);
	expect(text(unreadable.stderr)).toContain("promotion unavailable");
}, 120_000);

test("INFORMING1: a later invalid declaration rolls back earlier wrapper publication without losing original members or promotion metadata", async () => {
	const f = await fixture(true);
	const metadata = join(f.chain, ".95-fixture-rollout.rollout.json");
	const before = readFileSync(metadata, "utf8");
	const original = "#!/bin/sh\n# omp-kit-rollout: informing 2\necho 'pending member' >&2\nexit 7\n";
	const pending = join(f.chain, "97-pending");
	const invalid = join(f.chain, "98-invalid");
	writeFileSync(pending, original);
	writeFileSync(invalid, "#!/bin/sh\n# omp-kit-rollout: informing 0\nexit 0\n");
	chmodSync(pending, 0o755);
	chmodSync(invalid, 0o755);
	const refused = await f.command(["sh", join(source, "scripts", "install-commit-msg-bead.sh"), "--no-pushed-beads", f.repo]);
	expect(refused.rc).not.toBe(0);
	expect(text(refused.stderr)).toContain("informing declaration needs a green-run count");
	expect(readFileSync(pending, "utf8")).toBe(original);
	expect(existsSync(join(f.chain, ".97-pending.payload"))).toBe(false);
	expect(existsSync(join(f.chain, ".97-pending.rollout.json"))).toBe(false);
	expect(readFileSync(metadata, "utf8")).toBe(before);
	expect((await f.command([f.member])).rc).toBe(0);
}, 120_000);
