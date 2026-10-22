import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { resolveFilesystemWriteTarget, writeScratchOwner } from "../../src/fleet-guard/scratch.ts";

// WRITEOWN1 (ompkit-vf33j): in an opted-in canonical checkout every write outside var/agent-tmp needs the caller's
// live exclusive Agent Mail reservation, read through the same `am robot reservations` lookup `git commit --only` uses.
const scratchRoot = join(import.meta.dir, "../../var/agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = realpathSync(mkdtempSync(join(scratchRoot, "fleet-guard-writeown-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function fleetRepo(name: string, enabled: boolean): string {
	const root = join(scratch, name);
	mkdirSync(join(root, "scripts", "sub"), { recursive: true });
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "fleet.json"), JSON.stringify({ enabled }));
	writeFileSync(join(root, "scripts", "x.py"), "print('canonical')\n");
	writeFileSync(join(root, "README.md"), "readme\n");
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: gitEnv, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("add", ".omp/fleet.json", "scripts/x.py", "README.md");
	git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
	return root;
}
const repo = fleetRepo("repo", true);
const stock = fleetRepo("stock", false);
const owned = join(repo, "var", "agent-tmp", "own.1");
writeScratchOwner(owned, { pid: process.pid, label: "own", repo, created: new Date().toISOString() });

// Test seam for the Agent Mail CLI only: the guard's real spawn, attestation and hold parsing run unchanged.
const fixtureBin = join(scratch, "bin");
mkdirSync(fixtureBin, { recursive: true });
writeFileSync(join(fixtureBin, "am"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$AM_FIXTURE_CALLS\"\nif [ \"$AM_FIXTURE_MODE\" = \"fail\" ]; then echo 'connection refused' >&2; exit 1; fi\nprintf '%s' \"$AM_FIXTURE_RESPONSE\"\n");
chmodSync(join(fixtureBin, "am"), 0o755);
const callLog = join(scratch, "am-calls.log");

const attested = { state: "current", database_matches_server: true, storage_root_matches_server: true };
const holds = (agent: string, ...paths: string[]) => ({
	reservation_read_attestation: attested,
	my_reservations: paths.map((path) => ({ agent, path, exclusive: true, remaining_seconds: 3600 })),
});

async function withAm<T>(response: unknown, mode: "ok" | "fail", agent: string | undefined, run: () => Promise<T>): Promise<T> {
	const saved = { PATH: process.env.PATH, AGENT_NAME: process.env.AGENT_NAME, AM_FIXTURE_RESPONSE: process.env.AM_FIXTURE_RESPONSE,
		AM_FIXTURE_MODE: process.env.AM_FIXTURE_MODE, AM_FIXTURE_CALLS: process.env.AM_FIXTURE_CALLS };
	process.env.PATH = `${fixtureBin}:${saved.PATH ?? ""}`;
	if (agent === undefined) delete process.env.AGENT_NAME;
	else process.env.AGENT_NAME = agent;
	process.env.AM_FIXTURE_RESPONSE = JSON.stringify(response);
	process.env.AM_FIXTURE_MODE = mode;
	process.env.AM_FIXTURE_CALLS = callLog;
	writeFileSync(callLog, "");
	try { return await run(); }
	finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
const lookups = (): string[] => readFileSync(callLog, "utf8").split("\n").filter(Boolean);

// The later HTTP reservation layer (reservations.ts) is held neutral so every verdict is the write-ownership read's.
const neutral = async () => ({ covered: true, conflicts: [] as readonly unknown[] });
const bash = (command: string, cwd = repo) => handleToolCall({ toolName: "bash", input: { command }, cwd }, { cwd, lookupReservations: neutral });
const write = (path: string, content = "planted\n", cwd = repo) =>
	handleToolCall({ toolName: "write", input: { path, content }, cwd }, { cwd, lookupReservations: neutral });
const edit = (path: string, cwd = repo) =>
	handleToolCall({ toolName: "edit", input: { input: `[${path}#1A2B]\nPUT >$:\n+planted\n` }, cwd }, { cwd, lookupReservations: neutral });

describe("WRITEOWN1 AC1: unreserved writes in a canonical checkout are refused at the act", () => {
	test("write and edit tools to a tracked path with no reservation are refused, naming the exact reserve call", async () => {
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			for (const result of [await write("scripts/x.py"), await edit("scripts/x.py"), await write(join(repo, "scripts", "x.py"))]) {
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
				expect(result?.reason).toContain(`am file_reservations reserve ${repo} Intruder scripts/x.py --exclusive`);
			}
			// Untracked paths are dirt too.
			expect((await write("scripts/new.py"))?.reason).toContain(`reserve ${repo} Intruder scripts/new.py`);
		});
		expect(readFileSync(join(repo, "scripts", "x.py"), "utf8")).toBe("print('canonical')\n");
	});

	test("git add of a path, bare git add and every pathless staging form are refused in the canonical checkout", async () => {
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			for (const command of ["git add scripts/x.py", "git stage scripts/x.py", `git -C ${repo} add scripts/x.py`,
				"cd scripts && git add x.py", "git add -f -- scripts/x.py"]) {
				const result = await bash(command);
				expect(result?.block, command).toBe(true);
				expect(result?.reason, command).toContain("am file_reservations reserve");
			}
			for (const command of ["git add", "git add -u", "git add --update", "git add -p", "git add ':/'",
				"git add --pathspec-from-file=list.txt", "git add 'scripts/*.py'", "git -C scripts add ..", "P=scripts/x.py; git add -- $P"]) {
				const result = await bash(command);
				expect(result?.block, command).toBe(true);
				expect(result?.reason, command).toMatch(/WRITE_OWN_(?:BLANKET_ADD|UNRESERVED|UNRESOLVED_PATHSPEC)/);
			}
		});
	});

	// TILDEPATH1 (2026-10-22): CopperTrout, seated in omp-kit, edited `~/Developer/omp-kit-companion/src/cc-spool.ts`;
	// the guard resolved `~` against the cwd and refused against omp-kit. A `~/` tool path is the file under $HOME.
	test("a ~/ edit or write path is the file under $HOME, judged in the repo that holds it", async () => {
		const savedHome = process.env.HOME;
		process.env.HOME = scratch;
		try {
			expect(resolveFilesystemWriteTarget("/elsewhere/cwd", "~/repo/scripts/x.py", {})).toBe(join(scratch, "repo", "scripts", "x.py"));
			expect(resolveFilesystemWriteTarget("/elsewhere/cwd", "~", {})).toBe(scratch);
			expect(resolveFilesystemWriteTarget("/elsewhere/cwd", "~other/x", {})).toBe("/elsewhere/cwd/~other/x");
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
		// The real $HOME: `~/<path to repo>/scripts/x.py`, which normalizes even when the checkout sits outside $HOME.
		const viaHome = `~/${relative(process.env.HOME ?? "/", repo)}/scripts/x.py`;
		await withAm(holds("Holder", "scripts/x.py"), "ok", "Holder", async () => {
			for (const result of [await edit(viaHome), await write(viaHome)]) expect(result?.reason ?? "").toBe("");
		});
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			expect((await edit(viaHome))?.reason).toContain(`am file_reservations reserve ${repo} Intruder scripts/x.py --exclusive`);
		});
		expect(readFileSync(join(repo, "scripts", "x.py"), "utf8")).toBe("print('canonical')\n");
	});

	test("bash write targets (redirects, cp/mv/install/tee/sed -i) outside var/agent-tmp are refused", async () => {
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			for (const [command, path] of [
				["echo x > scripts/new.py", "scripts/new.py"],
				["echo x >> README.md", "README.md"],
				["printf x 2> scripts/err.log", "scripts/err.log"],
				["make &> build.log", "build.log"],
				["cat > scripts/x.py <<'EOF'\nx\nEOF", "scripts/x.py"],
				["cp /etc/hosts scripts/", "scripts/hosts"],
				["cp /etc/hosts scripts/hosts.txt", "scripts/hosts.txt"],
				["cp -t scripts /etc/hosts", "scripts/hosts"],
				[`mv scripts/x.py ${owned}/`, "scripts/x.py"],
				["install -m 644 /etc/hosts scripts/h", "scripts/h"],
				["echo x | tee -a scripts/t.txt", "scripts/t.txt"],
				["sed -i '' 's/a/b/' scripts/x.py", "scripts/x.py"],
				["sed -i.bak -e 's/a/b/' scripts/x.py", "scripts/x.py"],
				["cd scripts && echo x > y.py", "scripts/y.py"],
				["echo x > ~/../../" + repo.slice(1) + "/scripts/z.py", "scripts/z.py"],
				["echo x >&scripts/dup.txt", "scripts/dup.txt"],
				["bash -c 'echo x > scripts/n.py'", "scripts/n.py"],
				["echo $(echo x > scripts/s.py)", "scripts/s.py"],
				["echo x > scripts/out-$RANDOM.txt", "'scripts/*'"],
			] as const) {
				const result = await bash(command);
				expect(result?.block, command).toBe(true);
				expect(result?.reason, command).toContain(`reserve ${repo} Intruder ${path} --exclusive`);
			}
		});
	});

	test("controls: the holder's writes, git add and commit --only are admitted; reads and scratch writes need no reservation", async () => {
		await withAm(holds("Holder", "scripts/x.py", "scripts/sub/*", "docs/*.md", "README.md"), "ok", "Holder", async () => {
			expect(await write("scripts/x.py")).toBeUndefined();
			expect(await edit("scripts/x.py")).toBeUndefined();
			expect(await write("scripts/sub/deep/y.py")).toBeUndefined();
			expect(await write("docs/guide.md")).toBeUndefined();
			for (const command of ["git add scripts/x.py", "git add -- scripts/x.py README.md", "git commit --only -m m -- scripts/x.py",
				"echo x > scripts/x.py", "sed -i '' 's/a/b/' scripts/x.py", "cp /etc/hosts scripts/sub/", "echo x | tee README.md",
				"echo x > scripts/sub/out-$RANDOM.txt"]) {
				expect(await bash(command), command).toBeUndefined();
			}
			// The holder's reservation does not stretch to unreserved neighbours.
			expect((await write("scripts/other.py"))?.reason).toContain("WRITE_OWN_UNRESERVED");
			expect((await bash("git add scripts"))?.reason).toContain("WRITE_OWN_UNRESERVED");
		});
		await withAm(holds("Holder"), "fail", "Holder", async () => {
			for (const command of ["cat scripts/x.py", "git status --porcelain", "ls > /dev/null 2>&1", "grep -rn x scripts | head",
				`echo x > ${owned}/out.txt`, "echo x > var/agent-tmp/own.1/out.txt", `cp scripts/x.py ${owned}/`,
				`cd ${owned} && echo x > rel.txt`, "git add --dry-run scripts/x.py", "echo x > \"$TMPDIR/out.txt\"",
				"echo 'git add scripts/x.py > scripts/x.py'", "printf x > >(sed 's/^/a/') 2> >(cat >&2)", "make 2>&1 >&2 | cat",
				"sh scripts/x.py 2> >(sed 's/^/[err] /' >&2)"]) {
				expect(await bash(command), command).toBeUndefined();
			}
			expect(await write(join(owned, "note.txt"), "evidence notes\n")).toBeUndefined();
			expect(await write("var/agent-tmp/own.1/raw.txt", "raw capture\n")).toBeUndefined();
			expect(lookups(), "scratch and read-only calls consulted Agent Mail").toEqual([]);
		});
	});

	test("repositories that did not opt in, and paths outside any repository, are untouched", async () => {
		await withAm(holds("Holder"), "fail", "Holder", async () => {
			expect(await write(join(stock, "scripts", "x.py"), "planted\n", stock)).toBeUndefined();
			expect(await bash(`echo x > ${stock}/scripts/x.py && git -C ${stock} add scripts/x.py`)).toBeUndefined();
			expect(await bash("git add", stock)).toBeUndefined();
			expect(lookups()).toEqual([]);
		});
	});
});

describe("WRITEOWN1 AC2: a failed reservation lookup refuses with a named error, never admits", () => {
	test("Agent Mail unreachable, unattested reads or a missing identity all refuse", async () => {
		await withAm(holds("Holder", "scripts/x.py"), "fail", "Holder", async () => {
			for (const result of [await write("scripts/x.py"), await bash("git add scripts/x.py"), await bash("echo x > scripts/x.py")]) {
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
				expect(result?.reason).toContain(`am robot reservations --project ${repo} --agent Holder --json`);
			}
			expect(lookups().length).toBeGreaterThan(0);
		});
		const stale = { ...holds("Holder", "scripts/x.py"), reservation_read_attestation: { ...attested, state: "stale" } };
		await withAm(stale, "ok", "Holder", async () => {
			expect((await write("scripts/x.py"))?.reason).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
		});
		await withAm(holds("Holder", "scripts/x.py"), "ok", undefined, async () => {
			const result = await write("scripts/x.py");
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("WRITE_OWN_NO_IDENTITY");
			expect(result?.reason).toContain("AGENT_NAME");
		});
	});
});
