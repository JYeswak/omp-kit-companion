import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SHA_PATTERN, discoverFleetRepos, formatShaText, lookupSha, type ShaRunner } from "../../src/sha.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");
const fixtures: string[] = [];
function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-kit-sha-"));
	fixtures.push(root);
	return root;
}

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "sha-test",
	GIT_AUTHOR_EMAIL: "sha-test@example.com",
	GIT_COMMITTER_NAME: "sha-test",
	GIT_COMMITTER_EMAIL: "sha-test@example.com",
};

function git(args: string[], cwd: string): string {
	const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
	if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().slice(0, 200)}`);
	return out.stdout.toString().trim();
}

/** Real git repo with one commit; returns { repo, full, short }. */
function gitRepo(root: string, name: string, message: string): { repo: string; full: string; short: string } {
	const repo = join(root, name);
	mkdirSync(repo, { recursive: true });
	git(["init", "-b", "main"], repo);
	writeFileSync(join(repo, "file.txt"), `${name}\n`);
	git(["add", "file.txt"], repo);
	git(["commit", "-m", message], repo);
	const full = git(["rev-parse", "HEAD"], repo);
	return { repo, full, short: full.slice(0, 8) };
}

function run(args: string[], root: string) {
	const result = Bun.spawnSync([process.execPath, entry, ...args], {
		cwd: root,
		env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "xdg-state"), NO_COLOR: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("sha lookup module", () => {
	test("pattern accepts prefixes, rejects non-hex and bad lengths", () => {
		expect(SHA_PATTERN.test("dd82fb4e")).toBe(true);
		expect(SHA_PATTERN.test("14ec04eadd")).toBe(true);
		expect(SHA_PATTERN.test("a".repeat(40))).toBe(true);
		expect(SHA_PATTERN.test("abc")).toBe(false);
		expect(SHA_PATTERN.test("xyz")).toBe(false);
		expect(SHA_PATTERN.test("a".repeat(41))).toBe(false);
		expect(SHA_PATTERN.test("")).toBe(false);
	});

	test("lookup finds a commit in one repo and misses the other", () => {
		const root = workspace();
		const a = gitRepo(root, "a", "alpha subject [test]");
		const b = gitRepo(root, "b", "beta subject [test]");
		const runner: ShaRunner = (args) => {
			const out = Bun.spawnSync(args as [string, ...string[]], { stdout: "pipe", stderr: "pipe" });
			return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
		};
		const rows = lookupSha(runner, [a.repo, b.repo], a.short);
		expect(rows.find((row) => row.repo === a.repo)?.present).toBe(true);
		expect(rows.find((row) => row.repo === a.repo)?.full).toBe(a.full);
		expect(rows.find((row) => row.repo === a.repo)?.subject).toBe("alpha subject [test]");
		expect(rows.find((row) => row.repo === b.repo)?.present).toBe(false);
	});

	test("absent-everywhere text carries the proof marker", () => {
		const text = formatShaText("deadbee1234", ["/r/a", "/r/b"], [
			{ repo: "/r/a", present: false, full: null, subject: null, onOriginMain: "unknown" },
			{ repo: "/r/b", present: false, full: null, subject: null, onOriginMain: "unknown" },
		]);
		expect(text.split("\n")[0]).toBe("SHA-ABSENT-EVERYWHERE deadbee1234");
	});

	test("discovery covers kit, companion, .claude and project repos only", () => {
		const home = workspace();
		mkdirSync(join(home, "Developer", "omp-kit", ".git"), { recursive: true });
		mkdirSync(join(home, "Developer", "omp-kit-companion", ".git"), { recursive: true });
		mkdirSync(join(home, ".claude", ".git"), { recursive: true });
		mkdirSync(join(home, "Developer", "proj", ".git"), { recursive: true });
		mkdirSync(join(home, "Developer", "notrepo"), { recursive: true });
		const repos = discoverFleetRepos(home);
		expect(repos).toContain(join(home, "Developer", "omp-kit"));
		expect(repos).toContain(join(home, "Developer", "omp-kit-companion"));
		expect(repos).toContain(join(home, ".claude"));
		expect(repos).toContain(join(home, "Developer", "proj"));
		expect(repos).not.toContain(join(home, "Developer", "notrepo"));
		expect(repos[0]).toBe(join(home, "Developer", "omp-kit"));
		expect(existsSync(home)).toBe(true);
	});
});

describe("omp-kit sha command", () => {
	test("known sha in one repo: exit 0 with subject; unknown sha: exit 1 with marker", () => {
		const root = workspace();
		const a = gitRepo(root, "a", "alpha subject here [test]");
		const b = gitRepo(root, "b", "beta subject here [test]");
		const found = run(["sha", a.short, "--repo", a.repo, "--repo", b.repo], root);
		expect(found.code).toBe(0);
		expect(found.stdout).toContain(`SHA-FOUND ${a.repo} ${a.full}`);
		expect(found.stdout).toContain("alpha subject here");
		const missing = run(["sha", "deadbee1234567890abcdef1234567890abcd", "--repo", a.repo, "--repo", b.repo], root);
		expect(missing.code).toBe(1);
		expect(missing.stdout.split("\n")[0]).toBe("SHA-ABSENT-EVERYWHERE deadbee1234567890abcdef1234567890abcd");
	});

	test("malformed sha is refused with exit 2", () => {
		const root = workspace();
		const bad = run(["sha", "not-a-sha!!", "--repo", root], root);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("SHA_MALFORMED");
	});

	test("--json envelope carries hits and overall", () => {
		const root = workspace();
		const a = gitRepo(root, "a", "json subject [test]");
		const out = run(["sha", a.short, "--repo", a.repo, "--json"], root);
		expect(out.code).toBe(0);
		const envelope = JSON.parse(out.stdout);
		expect(envelope.data.overall).toBe("OK");
		expect(envelope.data.hits).toHaveLength(1);
		expect(envelope.data.hits[0].subject).toBe("json subject [test]");
	});
});
