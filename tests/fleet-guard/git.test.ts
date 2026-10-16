import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../../src/fleet-guard/git.ts";
import { handleToolCall } from "../../extensions/fleet-guard.ts";

const scratchRoot = join(import.meta.dir, "../../var/agent-tmp");
const scratch = mkdtempSync(join(scratchRoot, "fleet-guard-git-"));
const repo = join(scratch, "repo");
mkdirSync(repo, { recursive: true });
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args: string): string => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env: gitEnv }).trim();
git("init -b main");
git("config user.email t@t");
git("config user.name t");
git("config commit.gpgsign false");
writeFileSync(join(repo, "ownA.txt"), "owned bytes");
writeFileSync(join(repo, "receipt.txt"), "receipt bytes");
git("add ownA.txt receipt.txt");
git("commit -m init");
writeFileSync(join(repo, "foreignB.txt"), "peer bytes");
git("add foreignB.txt");
rmSync(join(repo, "receipt.txt"));
const gitState = (): string => `${git("rev-parse HEAD")}\n${git("status --porcelain")}`;

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const walk = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory)) {
			const relative = prefix ? `${prefix}/${name}` : name;
			if (statSync(join(directory, name)).isDirectory()) {
				entries.push(`${relative}/`);
				walk(join(directory, name), relative);
			} else {
				entries.push(`${relative}:${readFileSync(join(directory, name)).toString()}`);
			}
		}
	};
	walk(root, "");
	return entries.sort();
}
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fixtureBin = join(scratch, "bin");
mkdirSync(fixtureBin, { recursive: true });
writeFileSync(join(fixtureBin, "am"), "#!/bin/sh\nif [ \"$AM_FIXTURE_MODE\" = \"fail\" ]; then exit 1; fi\nprintf '%s' \"$AM_FIXTURE_RESPONSE\"\n");
chmodSync(join(fixtureBin, "am"), 0o755);
function withOnlyFixture(response: unknown, mode: string, agent: string | undefined, run: () => void): void {
	const savedPath = process.env.PATH;
	const savedAgent = process.env.AGENT_NAME;
	const savedResponse = process.env.AM_FIXTURE_RESPONSE;
	const savedMode = process.env.AM_FIXTURE_MODE;
	process.env.PATH = `${fixtureBin}:${savedPath ?? ""}`;
	if (agent === undefined) delete process.env.AGENT_NAME;
	else process.env.AGENT_NAME = agent;
	process.env.AM_FIXTURE_RESPONSE = JSON.stringify(response);
	process.env.AM_FIXTURE_MODE = mode;
	try {
		run();
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedAgent === undefined) delete process.env.AGENT_NAME;
		else process.env.AGENT_NAME = savedAgent;
		if (savedResponse === undefined) delete process.env.AM_FIXTURE_RESPONSE;
		else process.env.AM_FIXTURE_RESPONSE = savedResponse;
		if (savedMode === undefined) delete process.env.AM_FIXTURE_MODE;
		else process.env.AM_FIXTURE_MODE = savedMode;
	}
}
const onlyAttestation = { state: "current", database_matches_server: true, storage_root_matches_server: true };
const onlyHolds = (...paths: string[]) => ({
	my_reservations: paths.map((path) => ({ agent: "FixtureAgent", path, exclusive: true, remaining_seconds: 3600 })),
	reservation_read_attestation: onlyAttestation,
});

const event = (command: string) => ({ toolName: "bash", arguments: { command } });
const context = { cwd: repo };

describe("fleet guard main-only git checks", () => {
	test("blocks every branch/worktree creation form in a repository", () => {
		for (const command of [
			"git worktree add ../new-worktree",
			"git worktree --force add ../new-worktree",
			"git checkout -b topic",
			"git checkout -B topic",
			"git checkout --orphan topic",
			"git switch -c topic",
			"git switch -C topic",
			"git switch --orphan topic",
			"git branch topic",
		]) {
			const result = check(event(command), context);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("main-only");
		}
	});

	test("allows ordinary checkout, switch, listing, and non-repository commands", () => {
		for (const command of ["git switch main", "git checkout main", "git worktree list", "printf 'git switch -c fake'"]) {
			expect(check(event(command), context)).toBeUndefined();
		}
		expect(check(event("git switch -c topic"), { cwd: "/" })).toBeUndefined();
	});

	test("allows branch creation only for an explicit repository opt-out", () => {
		writeFileSync(join(repo, ".omp-fleet-guard.json"), "{}");
		expect(check(event("git switch -c topic"), context)).toBeDefined();
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp", "fleet-guard.json"), JSON.stringify({ branches: true }));
		expect(check(event("git switch -c topic"), context)).toBeUndefined();
	});

	test("refuses unscoped git commit --amend in every wrapper form", () => {
		const before = snapshotTree(repo);
		const gitBefore = gitState();
		for (const command of [
			"git commit --amend --no-edit",
			"git commit --amend",
			"git commit -m msg --amend",
			"git -C sub commit --amend",
			"git -c user.name=t commit --amend",
			"GIT_DIR=x git commit --amend",
			"env GIT_SSH=x git commit --amend",
			"git commit --amend --only -- some/path",
			"git status && git commit --amend",
			`/usr/bin/git -C ${repo} commit --amend --no-edit`,
		]) {
			const result = check(event(command), context);
			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain("amend");
		}
		expect(snapshotTree(repo)).toEqual(before);
		expect(gitState()).toBe(gitBefore);
	});

	test("allows ordinary scoped commits and quiet quoted prose", () => {
		const before = snapshotTree(repo);
		for (const command of [
			"git commit -m msg",
			"git commit --no-amend",
			"git commit -m \"fix --amend stuff\"",
			"git commit -m msg -- --amend",
			"git commit -m \"--amend\"",
			"git commit -am \"--amend\"",
			"git commit --author \"x <x@y>\" -m msg",
			"git --no-pager commit -m msg",
			"printf 'git commit --amend fake'",
			"git commit -amend -m msg",
		]) {
			expect(check(event(command), context), command).toBeUndefined();
		}
		expect(snapshotTree(repo)).toEqual(before);
		expect(readFileSync(join(repo, "ownA.txt"), "utf8")).toBe("owned bytes");
		expect(readFileSync(join(repo, "foreignB.txt"), "utf8")).toBe("peer bytes");
	});

	test("scoped --only admits covered paths and refuses foreign or unknown callers", () => {
		const before = snapshotTree(repo);
		const gitBefore = gitState();
		withOnlyFixture(onlyHolds("some/path"), "ok", "FixtureAgent", () => {
			expect(check(event("git commit --only -m msg -- some/path"), context)).toBeUndefined();
		});
		withOnlyFixture(onlyHolds("sub/*"), "ok", "FixtureAgent", () => {
			expect(check(event("git commit --only -m msg -- sub/file.txt"), context)).toBeUndefined();
		});
		withOnlyFixture(onlyHolds("some/path"), "ok", "FixtureAgent", () => {
			const foreign = check(event("git commit --only -m foreign -- foreignB.txt"), context);
			expect(foreign?.block, "foreign --only admitted").toBe(true);
			expect(foreign?.reason, "foreign --only admitted").toContain("reservation");
		});
		withOnlyFixture(onlyHolds("some/path"), "ok", undefined, () => {
			const anonymous = check(event("git commit --only -m msg -- some/path"), context);
			expect(anonymous?.block, "anonymous --only admitted").toBe(true);
			expect(anonymous?.reason, "anonymous --only admitted").toContain("AGENT_NAME");
		});
		withOnlyFixture(onlyHolds("some/path"), "fail", "FixtureAgent", () => {
			const broken = check(event("git commit --only -m msg -- some/path"), context);
			expect(broken?.block, "unreadable reservations admitted").toBe(true);
			expect(broken?.reason, "unreadable reservations admitted").toContain("reservation");
		});
		withOnlyFixture(onlyHolds("some/path"), "ok", "FixtureAgent", () => {
			const escape = check(event("git commit --only -m msg -- ../escape.txt"), context);
			expect(escape?.block, "outside-repo --only admitted").toBe(true);
			expect(escape?.reason, "outside-repo --only admitted").toContain("outside the repository");
		});
		expect(snapshotTree(repo)).toEqual(before);
		expect(gitState()).toBe(gitBefore);
	});

	test("native entry path blocks unscoped amend through the chained checks", async () => {
		const result = await handleToolCall(event("git commit --amend --no-edit"), context);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("amend");
	});

	test("structured argv forms refuse amend and respect values without shell quoting", async () => {
		const argv = (...words: string[]) => ({ toolName: "bash", arguments: words });
		for (const words of [
			["git", "commit", "--amend"],
			["git", "commit", "--amend", "--", "some/path"],
			["GIT_DIR=x", "git", "-C", "sub", "commit", "--amend"],
		]) {
			const result = check(argv(...words), context);
			expect(result?.block, words.join(" ")).toBe(true);
			expect(result?.reason, words.join(" ")).toContain("amend");
		}
		for (const words of [
			["git", "commit", "-m", "--amend"],
			["git", "commit", "-m", "msg", "--", "--amend"],
			["git", "commit", "--author", "x", "-m", "msg"],
		]) {
			expect(check(argv(...words), context), words.join(" ")).toBeUndefined();
		}
		const entry = await handleToolCall(argv("git", "commit", "--amend"), context);
		expect(entry?.block).toBe(true);
		expect(entry?.reason).toContain("amend");
	});

	test("nested shell substitution cannot smuggle amend past the guard", () => {
		for (const command of [
			"git commit -m \"$(git commit --amend --no-edit)\"",
			"git commit -m \"`git commit --amend`\"",
			"echo $(git commit --amend)",
			"echo $(echo $(git commit --amend --no-edit))",
			"sh -c 'git commit --amend'",
			"bash -c \"git commit --amend --no-edit\"",
			"bash <<EOF\ngit commit --amend --no-edit\nEOF",
			"bash <<< \"git commit --amend\"",
		]) {
			const result = check(event(command), context);
			expect(result?.block, command).toBe(true);
		}
	});

	test("inert quoting stays quiet and bare branch listing passes", () => {
		for (const command of [
			"echo '$(git commit --amend)'",
			"git commit -m 'fixed $(thing) stuff'",
			"bash -c 'git status'",
			"cat <<EOF\ngit commit --amend\nEOF",
			"git branch",
		]) {
			expect(check(event(command), context), command).toBeUndefined();
		}
	});

	test("runaway substitution nesting is refused instead of inspected forever", () => {
		const deep = "echo " + "$(".repeat(40) + "echo hi" + ")".repeat(40);
		const result = check(event(deep), context);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("budget");
	});
});
