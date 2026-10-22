import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, executedShellCommands } from "../../src/fleet-guard/git.ts";
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
// AM_FIXTURE_PROJECT: answer holds only for that --project; any other project gets a current read with no
// my_reservations key, which is how am answers for an agent holding nothing there (am 0.3.36).
writeFileSync(join(fixtureBin, "am"), "#!/bin/sh\nif [ \"$AM_FIXTURE_MODE\" = \"fail\" ]; then exit 1; fi\nif [ -n \"$AM_FIXTURE_PROJECT\" ] && [ \"$4\" != \"$AM_FIXTURE_PROJECT\" ]; then printf '%s' '{\"reservation_read_attestation\":{\"state\":\"current\",\"database_matches_server\":true,\"storage_root_matches_server\":true},\"all_active\":[]}'; exit 0; fi\nprintf '%s' \"$AM_FIXTURE_RESPONSE\"\n");
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

	test("ompkit-rz5.158: a call's own cwd picks the repository its commit is judged in", () => {
		const other = join(scratch, "other");
		mkdirSync(other, { recursive: true });
		execSync("git init -b main", { cwd: other, env: gitEnv });
		const callIn = (cwd: string) => ({ toolName: "bash", input: { command: "git commit --only -m m -- some/path", cwd } });
		const saved = process.env.AM_FIXTURE_PROJECT;
		try {
			withOnlyFixture(onlyHolds("some/path"), "ok", "FixtureAgent", () => {
				// Holds live in the repository the call runs in: admitted, by absolute or session-relative cwd.
				process.env.AM_FIXTURE_PROJECT = other;
				expect(check(callIn(other), context)).toBeUndefined();
				expect(check(callIn("../other"), context)).toBeUndefined();
				// Planted: holds live only in the session's repository; the commit runs in the other one and is refused
				// as unreserved there (it was judged against the session's holds before, and admitted).
				process.env.AM_FIXTURE_PROJECT = repo;
				const verdict = check(callIn(other), context);
				expect(verdict?.block).toBe(true);
				expect(verdict?.reason).toContain("without an active exclusive reservation");
			});
		} finally {
			if (saved === undefined) delete process.env.AM_FIXTURE_PROJECT;
			else process.env.AM_FIXTURE_PROJECT = saved;
		}
	});

	test("redirections are not pathspecs: a redirected --only commit of reserved paths is admitted (ompkit-xa5s.27)", () => {
		withOnlyFixture(onlyHolds("some/path"), "ok", "FixtureAgent", () => {
			for (const command of [
				"git commit --only -m msg -- some/path > var/agent-tmp/c.txt 2>&1",
				"git commit --only -m msg -- some/path >> var/agent-tmp/c.txt 2>&1",
				"git commit --only -m msg -- some/path &> var/agent-tmp/c.txt",
				"git commit --only -m msg -- some/path >var/agent-tmp/c.txt 2>/dev/null",
				"git commit --only -m msg -- some/path < /dev/null",
				"git commit --only -m msg > out.txt 2>&1 -- some/path",
				"git commit --only -m msg -- some/path 2>&1 | cat",
				"git commit --only -m \"a > b 2>&1\" -- some/path > f",
			]) {
				expect(check(event(command), context), command).toBeUndefined();
			}
		});
	});

	test("redirections do not hide an unreserved path or a second command (ompkit-xa5s.27 planted negatives)", () => {
		withOnlyFixture(onlyHolds("some/path"), "ok", "FixtureAgent", () => {
			for (const command of [
				"git commit --only -m msg -- foreignB.txt > f 2>&1",
				"git commit --only -m msg -- some/path > f foreignB.txt",
				"git commit --only -m msg -- some/path 2>&1 foreignB.txt",
				"git commit --only -m msg -- '>x'",
				"git commit --only -m msg -- some/path '> foreignB.txt'",
				"git commit --only -m \"a > b\" -- foreignB.txt",
				"git commit --only -m msg -- some/path 2>&1 && git commit --only -m msg -- foreignB.txt",
				"echo a && git commit --only -m msg -- foreignB.txt",
				"git commit --only -m msg -- some/path > f ; git commit --only -m msg -- foreignB.txt",
				"git commit --only -m msg -- some/path & git commit --only -m msg -- foreignB.txt",
			]) {
				const verdict = check(event(command), context);
				expect(verdict?.block, command).toBe(true);
				expect(verdict?.reason, command).toContain("reservation");
			}
		});
	});

	test("the shared traversal splits on ; & | && and newlines but not on the & of a redirection", () => {
		const words = (command: string) => {
			const inspection = executedShellCommands(command);
			if ("refusal" in inspection) throw new Error(inspection.refusal);
			return inspection.commands.map((executed) => executed.words);
		};
		expect(words("a && b")).toEqual([["a"], ["b"]]);
		expect(words("a & b")).toEqual([["a"], ["b"]]);
		expect(words("a ; b | c")).toEqual([["a"], ["b"], ["c"]]);
		expect(words("a > f 2>&1")).toEqual([["a"]]);
		expect(words("a &> f")).toEqual([["a"]]);
		expect(words("a >& f")).toEqual([["a"]]);
		expect(words("a 2>&1 && b")).toEqual([["a"], ["b"]]);
		expect(words("a '2>&1' & b")).toEqual([["a", "2>&1"], ["b"]]);
		expect(words("a x2>f")).toEqual([["a", "x2"]]);
		expect(words("a\nb # c; d\n# e\nf")).toEqual([["a"], ["b"], ["f"]]);
		expect(words("cat <<'EOF' | g\nx; y\nEOF\nz")).toEqual([["cat"], ["g"], ["z"]]);
		expect(words("FOO=1 env -u BAR nice -n 5 timeout 9 git status")).toEqual([["git", "status"]]);
		expect(words("command -v git")).toEqual([]);
	});

	test("a newline-separated command cannot hide amend behind an allowed one", () => {
		for (const command of ["git status\ngit commit --amend", "if true; then git commit --amend; fi", "git status # ok\ngit commit --amend"])
			expect(check(event(command), context)?.reason, command).toContain("amend");
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

describe("fleet guard BRANCHGUARD1 raw-publication refusal (ompkit-xa5s.11)", () => {
	const SHA = "97081b70d4a355844ad0f6c0bbd0c0a0f6c0bbd0";
	const fire = [
		"git push origin cfs-save-brightforge-80-reader",
		"git push origin HEAD:refs/heads/cfs-save-brightforge-80-reader",
		"git push origin main",
		"git push origin refs/heads/main",
		"git push origin HEAD:refs/heads/main",
		"git push",
		`git push origin ${SHA}:refs/agent-candidates/candidate97081b70`,
		"git push origin HEAD:refs/agent-candidates/candidate97081b70",
		"git push origin refs/agent-candidates/candidate97081b70",
		"git push origin :refs/heads/stale-branch",
		"git push --delete origin stale-branch",
		"git push --force origin main",
		"git push --tags origin",
		"git push --all origin",
		"git push --mirror origin",
		"git -C sub push origin main",
		"git -c user.name=t push origin main",
		"GIT_DIR=x git push origin main",
		"env GIT_SSH=x git push origin main",
		"git push origin main && git status",
		"git status && git push origin HEAD:refs/heads/side",
		"sh -c 'git push origin main'",
		"bash -c \"git push origin main\"",
		"echo $(git push origin main)",
		"git commit -m \"$(git push origin main)\"",
		`git push origin +HEAD:refs/heads/side`,
	];
	test("every raw push spelling is refused before effect and names the rule and landing route", () => {
		const before = snapshotTree(repo);
		const gitBefore = gitState();
		for (const command of fire) {
			const result = check(event(command), context);
			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain("publication");
			expect(result?.reason, command).toContain("land");
		}
		expect(snapshotTree(repo)).toEqual(before);
		expect(gitState()).toBe(gitBefore);
	});

	test("structured argv pushes are refused with the same reason", async () => {
		const argv = (...words: string[]) => ({ toolName: "bash", arguments: words });
		for (const words of [
			["git", "push", "origin", "main"],
			["git", "push", "origin", "HEAD:refs/heads/side"],
			["git", "push", "origin", `${SHA}:refs/agent-candidates/candidate97081b70`],
		]) {
			const result = check(argv(...words), context);
			expect(result?.block, words.join(" ")).toBe(true);
			expect(result?.reason, words.join(" ")).toContain("publication");
		}
		const entry = await handleToolCall(argv("git", "push", "origin", "main"), context);
		expect(entry?.block).toBe(true);
		expect(entry?.reason).toContain("publication");
	});

	test("branch creation refusal names the landing route (AC1 switch -c row)", () => {
		rmSync(join(repo, ".omp", "fleet-guard.json"), { force: true });
		rmSync(join(repo, ".omp-fleet-guard.json"), { force: true });
		const result = check(event("git switch -c topic"), context);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("land");
	});

	test("the branch opt-out never admits a raw push", () => {
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp", "fleet-guard.json"), JSON.stringify({ branches: true }));
		try {
			const result = check(event("git push origin main"), context);
			expect(result?.block, "opt-out admitted a raw push").toBe(true);
		} finally {
			rmSync(join(repo, ".omp", "fleet-guard.json"), { force: true });
			rmSync(join(repo, ".omp-fleet-guard.json"), { force: true });
		}
	});

	test("dry runs, stash, reads, and quoted prose stay quiet", () => {
		const before = snapshotTree(repo);
		for (const command of [
			"git push -n origin main",
			"git push --dry-run origin HEAD:refs/heads/side",
			"git stash push -m wip",
			"git switch main",
			"git checkout main",
			"git status",
			"git log --oneline",
			"git fetch origin main",
			"git branch",
			"printf 'git push origin main'",
			"git commit -m 'mention git push origin main in prose'",
		]) {
			expect(check(event(command), context), command).toBeUndefined();
		}
		expect(check(event("git push origin main"), { cwd: "/" })).toBeUndefined();
		expect(snapshotTree(repo)).toEqual(before);
	});
});

describe("fleet guard BYPASSENV1: agent calls never switch the reservation guard off (ompkit-0daxx)", () => {
	test("every spelling that sets AGENT_MAIL_BYPASS or AGENT_MAIL_GUARD_MODE is refused, naming the variable", () => {
		const before = snapshotTree(repo);
		const gitBefore = gitState();
		for (const [command, variable] of [
			["AGENT_MAIL_BYPASS=1 git commit --only -m m -- ownA.txt", "AGENT_MAIL_BYPASS"],
			["export AGENT_MAIL_GUARD_MODE=warn; git commit -m m", "AGENT_MAIL_GUARD_MODE"],
			["env AGENT_MAIL_BYPASS=1 git commit -m m", "AGENT_MAIL_BYPASS"],
			["env -u FOO AGENT_MAIL_GUARD_MODE=warn git commit -m m", "AGENT_MAIL_GUARD_MODE"],
			["env -i PATH=/usr/bin AGENT_MAIL_BYPASS=1 /usr/bin/git commit -m m", "AGENT_MAIL_BYPASS"],
			["AGENT_MAIL_BYPASS=1", "AGENT_MAIL_BYPASS"],
			["AGENT_MAIL_GUARD_MODE=warn && git commit -m m", "AGENT_MAIL_GUARD_MODE"],
			["export AGENT_MAIL_BYPASS", "AGENT_MAIL_BYPASS"],
			["declare -x AGENT_MAIL_GUARD_MODE=warn", "AGENT_MAIL_GUARD_MODE"],
			["typeset -x AGENT_MAIL_BYPASS=1", "AGENT_MAIL_BYPASS"],
			["bash -c 'AGENT_MAIL_BYPASS=1 git commit -m m'", "AGENT_MAIL_BYPASS"],
			["sh -c \"export AGENT_MAIL_GUARD_MODE=warn\"", "AGENT_MAIL_GUARD_MODE"],
			["echo $(AGENT_MAIL_BYPASS=1 git commit -m m)", "AGENT_MAIL_BYPASS"],
			["nice -n 10 env AGENT_MAIL_BYPASS=1 git commit -m m", "AGENT_MAIL_BYPASS"],
			["FOO=1 AGENT_MAIL_GUARD_MODE=warn git commit -m m", "AGENT_MAIL_GUARD_MODE"],
		] as const) {
			const result = check(event(command), context);
			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain(variable);
			expect(result?.reason, command).toContain("BYPASS_ENV");
		}
		expect(snapshotTree(repo)).toEqual(before);
		expect(gitState()).toBe(gitBefore);
	});

	test("mentions, reads and unsets stay quiet; the reserved commit is admitted", () => {
		for (const command of [
			"grep -rn AGENT_MAIL_BYPASS src",
			"echo \"AGENT_MAIL_BYPASS=1 git commit -m m\"",
			"printf '%s\\n' 'export AGENT_MAIL_GUARD_MODE=warn'",
			"unset AGENT_MAIL_BYPASS AGENT_MAIL_GUARD_MODE",
			"env -u AGENT_MAIL_BYPASS git status",
			"printenv AGENT_MAIL_GUARD_MODE",
			"git commit -m 'AGENT_MAIL_BYPASS=1 is refused now'",
		]) {
			expect(check(event(command), context), command).toBeUndefined();
		}
		withOnlyFixture(onlyHolds("ownA.txt"), "ok", "FixtureAgent", () => {
			expect(check(event("git commit --only -m m -- ownA.txt"), context)).toBeUndefined();
		});
	});
});
