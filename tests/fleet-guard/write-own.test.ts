import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "../cli/fixture-process.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { resolveFilesystemWriteTarget, writeScratchOwner } from "../../src/fleet-guard/scratch.ts";

// WRITEOWN1 (ompkit-vf33j) + WRITEOWNCHILD1 (ompkit-1ra0d.126): in an opted-in canonical checkout every write outside
// var/agent-tmp needs the caller's live exclusive Agent Mail reservation, read through the same `am robot reservations`
// lookup `git commit --only` uses — or the guard auto-reserves the free path for the seat itself and admits the write.
const scratchRoot = join(import.meta.dir, "../../var/agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = realpathSync(ownedTmp("fleet-guard-writeown", { root: scratchRoot }).path);
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
const peer = fleetRepo("peer", true);
const owned = join(repo, "var", "agent-tmp", "own.1");
writeScratchOwner(owned, { pid: process.pid, label: "own", repo, created: new Date().toISOString() });

// Test seam for the Agent Mail CLI only: the guard's real spawn, attestation and hold parsing run unchanged.
const fixtureBin = join(scratch, "bin");
mkdirSync(fixtureBin, { recursive: true });
writeFileSync(join(fixtureBin, "am"), "#!" + process.execPath + "\n" + [
"import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
"const calls = process.env.AM_FIXTURE_CALLS || '';",
"const journalPath = process.env.AM_FIXTURE_JOURNAL || '';",
"const args = process.argv.slice(2);",
"if (calls !== '') appendFileSync(calls, args.join(' ') + '\\n');",
"if (process.env.AM_FIXTURE_MODE === 'fail') { console.error('connection refused'); process.exit(1); }",
"function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }",
"function journaled(base) {",
"  let response;",
"  try { response = JSON.parse(base); } catch (e) { return base; }",
"  if (journalPath === '' || !existsSync(journalPath)) return JSON.stringify(response);",
"  const project = flag('--project') || '';",
"  const agent = flag('--agent') || '';",
"  const mine = Array.isArray(response.my_reservations) ? response.my_reservations.slice() : [];",
"  const all = Array.isArray(response.all_active) ? response.all_active.slice() : [];",
"  const lines = readFileSync(journalPath, 'utf8').split('\\n');",
"  for (const line of lines) {",
"    const parts = line.split('|');",
"    if (parts.length < 3 || parts[0] === '' || parts[0] !== project) continue;",
"    const row = { agent: parts[1], path: parts[2], exclusive: true, remaining_seconds: 3600 };",
"    if (parts[1] === agent) mine.push(row);",
"    all.push(row);",
"  }",
"  response.my_reservations = mine;",
"  response.all_active = all;",
"  return JSON.stringify(response);",
"}",
"if (args[0] === 'file_reservations' && args[1] === 'reserve') {",
"  const agent = args[3] || '';",
"  const missing = process.env.AM_FIXTURE_AGENT_MISSING || '';",
"  if (missing !== '' && agent === missing) { console.error('error: invalid argument: agent not found: ' + agent); process.exit(1); }",
"  const paths = []; let reason = ''; let exclusive = true;",
"  for (let i = 4; i < args.length; i++) {",
"    const a = args[i] || '';",
"    if (a === '--ttl') { i++; continue; }",
"    if (a === '--reason') { reason = args[i + 1] || ''; i++; continue; }",
"    if (a === '--shared') { exclusive = false; continue; }",
"    if (a.indexOf('--') === 0) continue;",
"    paths.push(a);",
"  }",
"  if (journalPath !== '') for (const p of paths) appendFileSync(journalPath, (args[2] || '') + '|' + agent + '|' + p + '\\n');",
"  const granted = paths.map((p, n) => ({ id: n + 1, path_pattern: p, exclusive, reason, expires_ts: '2030-01-01T00:00:00.000Z' }));",
"  process.stdout.write(JSON.stringify({ granted, conflicts: [] }));",
"  process.exit(0);",
"}",
"const agent = flag('--agent') || '';",
"const missing = process.env.AM_FIXTURE_AGENT_MISSING || '';",
"if (missing !== '' && agent === missing) { console.error('error: invalid argument: agent not found: ' + agent); process.exit(1); }",
"const perAgent = process.env.AM_FIXTURE_AGENT || '';",
"if (perAgent !== '' && agent === perAgent) { process.stdout.write(journaled(process.env.AM_FIXTURE_AGENT_RESPONSE || '')); process.exit(0); }",
"const onlyProject = process.env.AM_FIXTURE_PROJECT || '';",
"const project = flag('--project') || '';",
"if (onlyProject !== '' && project !== onlyProject) { process.stdout.write(journaled(process.env.AM_FIXTURE_OTHER_RESPONSE || '')); process.exit(0); }",
"process.stdout.write(journaled(process.env.AM_FIXTURE_RESPONSE || ''));",
].join('\n') + '\n');
chmodSync(join(fixtureBin, "am"), 0o755);
// The reserve reason reads the seat's held bead from the target tracker; the stub answers no bead (and never
// hangs), so shared assertions stay reason-agnostic while the reason itself is pinned in src/fleet-guard/write-own.test.ts.
writeFileSync(join(fixtureBin, "br"), "#!/bin/sh\nexit 1\n");
chmodSync(join(fixtureBin, "br"), 0o755);
const callLog = join(scratch, "am-calls.log");
const journal = join(scratch, "am-journal.log");

const attested = { state: "current", database_matches_server: true, storage_root_matches_server: true };
const holds = (agent: string, ...paths: string[]) => ({
	reservation_read_attestation: attested,
	my_reservations: paths.map((path) => ({ agent, path, exclusive: true, remaining_seconds: 3600 })),
});

async function withAm<T>(response: unknown, mode: "ok" | "fail", agent: string | undefined, run: () => Promise<T>,
	projectRoute?: { project: string; otherResponse: unknown }): Promise<T> {
	const saved = { PATH: process.env.PATH, AGENT_NAME: process.env.AGENT_NAME, AM_FIXTURE_RESPONSE: process.env.AM_FIXTURE_RESPONSE,
		AM_FIXTURE_MODE: process.env.AM_FIXTURE_MODE, AM_FIXTURE_CALLS: process.env.AM_FIXTURE_CALLS,
		AM_FIXTURE_JOURNAL: process.env.AM_FIXTURE_JOURNAL,
		AM_FIXTURE_PROJECT: process.env.AM_FIXTURE_PROJECT, AM_FIXTURE_OTHER_RESPONSE: process.env.AM_FIXTURE_OTHER_RESPONSE };
	process.env.PATH = `${fixtureBin}:${saved.PATH ?? ""}`;
	if (agent === undefined) delete process.env.AGENT_NAME;
	else process.env.AGENT_NAME = agent;
	process.env.AM_FIXTURE_RESPONSE = JSON.stringify(response);
	process.env.AM_FIXTURE_MODE = mode;
	process.env.AM_FIXTURE_CALLS = callLog;
	process.env.AM_FIXTURE_JOURNAL = journal;
	if (projectRoute === undefined) {
		delete process.env.AM_FIXTURE_PROJECT;
		delete process.env.AM_FIXTURE_OTHER_RESPONSE;
	} else {
		process.env.AM_FIXTURE_PROJECT = projectRoute.project;
		process.env.AM_FIXTURE_OTHER_RESPONSE = JSON.stringify(projectRoute.otherResponse);
	}
	writeFileSync(callLog, "");
	writeFileSync(journal, "");
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
const bashAt = (command: string, inputCwd: string, sessionCwd = repo) =>
	handleToolCall({ toolName: "bash", input: { command, cwd: inputCwd }, cwd: sessionCwd },
		{ cwd: sessionCwd, lookupReservations: neutral });
const write = (path: string, content = "planted\n", cwd = repo) =>
	handleToolCall({ toolName: "write", input: { path, content }, cwd }, { cwd, lookupReservations: neutral });
const edit = (path: string, cwd = repo) =>
	handleToolCall({ toolName: "edit", input: { input: `[${path}#1A2B]\nPUT >$:\n+planted\n` }, cwd }, { cwd, lookupReservations: neutral });

describe("WRITEOWNCHILD1: a first write auto-reserves for the seat and is admitted; unscoped staging still refuses", () => {
	test("write and edit tools to a tracked path with no reservation are admitted with a seat reserve", async () => {
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			for (const result of [await write("scripts/x.py"), await edit("scripts/x.py"), await write(join(repo, "scripts", "x.py"))]) {
				expect(result).toBeUndefined();
			}
			// Untracked paths are dirt too: the first write reserves them as well.
			expect(await write("scripts/new.py")).toBeUndefined();
			for (const path of ["scripts/x.py", "scripts/new.py"]) {
				expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder ${path} --exclusive --ttl 3600 --reason `)), path).toBe(true);
			}
		});
		expect(readFileSync(join(repo, "scripts", "x.py"), "utf8")).toBe("print('canonical')\n");
	});

	test("git add of a path reserves and admits; bare git add and every pathless staging form are still refused", async () => {
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			for (const command of ["git add scripts/x.py", "git stage scripts/x.py", `git -C ${repo} add scripts/x.py`,
				"cd scripts && git add x.py", "git add -f -- scripts/x.py", "git add 'scripts/*.py'"]) {
				expect(await bash(command), command).toBeUndefined();
			}
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder scripts/x.py --exclusive --ttl 3600 --reason `))).toBe(true);
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder scripts/* --exclusive --ttl 3600 --reason `))).toBe(true);
			for (const command of ["git add", "git add -u", "git add --update", "git add -p", "git add ':/'",
				"git add --pathspec-from-file=list.txt", "git -C scripts add ..", "P=scripts/x.py; git add -- $P"]) {
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
			expect(await edit(viaHome)).toBeUndefined();
			expect(await write(viaHome)).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder scripts/x.py --exclusive --ttl 3600 --reason `))).toBe(true);
		});
		expect(readFileSync(join(repo, "scripts", "x.py"), "utf8")).toBe("print('canonical')\n");
	});

	test("bash write targets (redirects, cp/mv/install/tee/sed -i) outside var/agent-tmp reserve and admit", async () => {
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
				// Climb from $HOME to / by its real depth (the suite scrub puts HOME deep in scratch).
				[`echo x > ~/${"../".repeat((process.env.HOME ?? "/").split("/").filter(Boolean).length)}${repo.slice(1)}/scripts/z.py`, "scripts/z.py"],
				["echo x >&scripts/dup.txt", "scripts/dup.txt"],
				["bash -c 'echo x > scripts/n.py'", "scripts/n.py"],
				["echo $(echo x > scripts/s.py)", "scripts/s.py"],
				["echo x > scripts/out-$RANDOM.txt", "scripts/*"],
			] as const) {
				expect(await bash(command), command).toBeUndefined();
				expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder ${path} --exclusive --ttl 3600 --reason `)), `${command} reserves ${path}`).toBe(true);
			}
		});
	}, fixtureDeadlineS(30) * 1_000);
	test("bash reservations follow the invoked checkout when its cwd differs from the session", async () => {
		await withAm(holds("Holder", "README.md"), "ok", "Holder", async () => {
			expect(await bashAt("echo x > README.md", peer, repo)).toBeUndefined();
		}, { project: peer, otherResponse: holds("Holder") });
		expect(lookups()).toContain(`robot reservations --project ${peer} --agent Holder --json`);
	});

	test("a write in another bash checkout reserves under that checkout and is admitted", async () => {
		await withAm(holds("Holder", "README.md"), "ok", "Holder", async () => {
			expect(await bashAt("echo x > README.md", peer, repo)).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${peer} Holder README.md --exclusive --ttl 3600 --reason `))).toBe(true);
		}, { project: repo, otherResponse: holds("Holder") });
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
			// The holder's reservation does not stretch to unreserved neighbours: the first write there
			// reserves for the holder instead of refusing.
			expect(await write("scripts/other.py")).toBeUndefined();
			expect(await bash("git add scripts")).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Holder scripts/other.py --exclusive --ttl 3600 --reason `))).toBe(true);
		});
		await withAm(holds("Holder"), "fail", "Holder", async () => {
			const savedTmpdir = process.env.TMPDIR;
			process.env.TMPDIR = owned;
			try {
				for (const command of ["cat scripts/x.py", "git status --porcelain", "ls > /dev/null 2>&1", "grep -rn x scripts | head",
					`echo x > ${owned}/out.txt`, "echo x > var/agent-tmp/own.1/out.txt", `cp scripts/x.py ${owned}/`,
					`cd ${owned} && echo x > rel.txt`, "git add --dry-run scripts/x.py", "echo x > \"$TMPDIR/out.txt\"",
					"echo 'git add scripts/x.py > scripts/x.py'", "printf x > >(sed 's/^/a/') 2> >(cat >&2)", "make 2>&1 >&2 | cat",
					"sh scripts/x.py 2> >(sed 's/^/[err] /' >&2)"]) {
					expect(await bash(command), command).toBeUndefined();
				}
			} finally {
				if (savedTmpdir === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = savedTmpdir;
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

describe("NATIVEPREGRADE1 (ompkit-1ra0d.41): a native child writes under its own hold or its seat's", () => {
	const childWrite = (path: string, childAgentName: string) =>
		handleToolCall({ toolName: "write", input: { path, content: "planted\n" }, cwd: repo }, { cwd: repo, lookupReservations: neutral, childAgentName });
	async function asChild<T>(childHolds: unknown, run: () => Promise<T>): Promise<T> {
		process.env.AM_FIXTURE_AGENT = "ChildBuilder";
		process.env.AM_FIXTURE_AGENT_RESPONSE = JSON.stringify(childHolds);
		try { return await run(); } finally { delete process.env.AM_FIXTURE_AGENT; delete process.env.AM_FIXTURE_AGENT_RESPONSE; }
	}
	test("the child's own exclusive hold admits its write; the seat's first write reserves for the seat", async () => {
		await withAm(holds("Seat"), "ok", "Seat", () => asChild(holds("ChildBuilder", "scripts/x.py"), async () => {
			expect(await childWrite("scripts/x.py", "ChildBuilder")).toBeUndefined();
			// The seat itself writes under its own custody: the free path auto-reserves for the seat.
			expect(await write("scripts/x.py")).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Seat scripts/x.py --exclusive --ttl 3600 --reason `))).toBe(true);
		}));
	});
	test("control: the seat's hold still covers its child (the parent reserves on the child's behalf)", async () => {
		await withAm(holds("Seat", "scripts/x.py"), "ok", "Seat", () => asChild(holds("ChildBuilder"), async () => {
			expect(await childWrite("scripts/x.py", "ChildBuilder")).toBeUndefined();
		}));
	});
	test("a stale child lookup never refuses: the seat's fresh read governs and a free path auto-reserves", async () => {
		const unattested = { ...holds("ChildBuilder"), reservation_read_attestation: { ...attested, state: "stale" } };
		await withAm(holds("Seat", "scripts/x.py"), "ok", "Seat", () => asChild(unattested, async () => {
			expect(await childWrite("scripts/x.py", "ChildBuilder")).toBeUndefined();
			// The seat does not hold this path but the child read is only stale, so the free path reserves.
			expect(await childWrite("README.md", "ChildBuilder")).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Seat README.md --exclusive --ttl 3600 --reason `))).toBe(true);
		}));
	});
	test("planted: a free path auto-reserves for the seat while another child's hold still refuses naming the holder", async () => {
		const foreign = { ...holds("Seat"), all_active: [{ agent: "ChildBuilder", path: "scripts/other.py", exclusive: true, remaining_seconds: 3600 }] };
		await withAm(foreign, "ok", "Seat", () => asChild(holds("ChildBuilder", "scripts/other.py"), async () => {
			expect(await childWrite("scripts/x.py", "ChildBuilder")).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Seat scripts/x.py --exclusive --ttl 3600 --reason `))).toBe(true);
			const held = await childWrite("scripts/other.py", "SomeOtherChild");
			expect(held?.block).toBe(true);
			expect(held?.reason).toContain("WRITE_OWN_UNRESERVED");
			expect(held?.reason).toContain("ChildBuilder");
		}));
	});
	test("CHILDUNKNOWN1: a child Agent Mail does not know holds nothing, so a free write auto-reserves for the seat", async () => {
		process.env.AM_FIXTURE_AGENT_MISSING = "WeeklyEditionGates";
		try {
			await withAm(holds("Seat", "scripts/x.py"), "ok", "Seat", async () => {
				expect(await childWrite("scripts/x.py", "WeeklyEditionGates")).toBeUndefined();
				expect(await childWrite("README.md", "WeeklyEditionGates")).toBeUndefined();
				expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Seat README.md --exclusive --ttl 3600 --reason `))).toBe(true);
			});
		} finally { delete process.env.AM_FIXTURE_AGENT_MISSING; }
	});
});

describe("CFSFALSEREF1 (ompkit-1ra0d.75): fixture repos in scratch and omp internal URLs are not canonical writes", () => {
	test("SCRATCHFIXTURE1: a write into a git fixture repo inside owned scratch is admitted with no lookup; canonical writes auto-reserve instead", async () => {
		// A fixture cloned or copied from a checkout carries its .omp/fleet.json opt-in: without the
		// CFSFALSEREF1 skip the write is treated as a canonical-checkout write and the reservation lookup
		// runs against the fixture project. A bare `git init` without opt-in would be admitted either way.
		const fx = join(owned, "fx");
		mkdirSync(join(fx, "src"), { recursive: true });
		mkdirSync(join(fx, ".omp"), { recursive: true });
		writeFileSync(join(fx, ".omp", "fleet.json"), JSON.stringify({ enabled: true }));
		const inited = await run(["git", "-C", fx, "init", "-q", "-b", "main"],
			{ cwd: scratch, env: gitEnv, deadline_s: fixtureDeadlineS() });
		expect(inited.rc, new TextDecoder().decode(inited.stderr)).toBe(0);
		await withAm(holds("Intruder"), "fail", "Intruder", async () => {
			expect(await write(join(fx, "src", "note.txt"), "fixture notes\n")).toBeUndefined();
			expect(lookups(), "fixture-repo write consulted Agent Mail").toEqual([]);
		});
		// Control: a write in the canonical checkout outside var/agent-tmp auto-reserves instead.
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			expect(await write("scripts/other.py")).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder scripts/other.py --exclusive --ttl 3600 --reason `))).toBe(true);
		});
	}, fixtureDeadlineS(30) * 1_000);
	test("URLWRITE1: a write to an omp internal URL is admitted with no lookup; a plain relative lookalike is still judged", async () => {
		await withAm(holds("Intruder"), "fail", "Intruder", async () => {
			expect(await write("out://report.md", "report\n")).toBeUndefined();
			expect(await write("cfg://ns/key", "value\n")).toBeUndefined();
			expect(lookups(), "internal-URL writes consulted Agent Mail").toEqual([]);
		});
		// Control: a plain relative path is still a filesystem write, so it auto-reserves too.
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			expect(await write("out/report.md")).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder out/report.md --exclusive --ttl 3600 --reason `))).toBe(true);
		});
	}, fixtureDeadlineS(30) * 1_000);
});

describe("PRIVATECHECKOUT1 (ompkit-1ra0d.75): a private object-borrowing checkout has one writer, so no reservation", () => {
	test("a write in a separate-git-dir shared clone is admitted with no lookup; the canonical checkout it borrows from is still judged", async () => {
		// The ovnfs shape: a .git pointer file to a private git dir whose objects/info/alternates borrow the canonical repo's objects.
		const checkout = join(scratch, "private-checkout");
		mkdirSync(join(scratch, "private-gitdirs"), { recursive: true });
		const gitDir = join(scratch, "private-gitdirs", "private-checkout");
		const cloned = await run(["git", "clone", "-q", "--shared", "--separate-git-dir", gitDir, repo, checkout], { env: gitEnv, deadline_s: fixtureDeadlineS(30), max_output_bytes: 1 << 16 });
		expect(cloned.rc).toBe(0);
		expect(readFileSync(join(checkout, ".git"), "utf8")).toStartWith("gitdir: ");
		await withAm(holds("Intruder"), "ok", "Intruder", async () => {
			expect((await write(join(checkout, "scripts", "x.py"), "private edit\n", checkout))?.reason ?? "").toBe("");
			expect(lookups()).toEqual([]);
			// Control: the canonical checkout itself auto-reserves on a free path.
			expect(await write(join(repo, "scripts", "x.py"))).toBeUndefined();
			expect(lookups().some((line) => line.startsWith(`file_reservations reserve ${repo} Intruder scripts/x.py --exclusive --ttl 3600 --reason `))).toBe(true);
		});
		expect(readFileSync(join(repo, "scripts", "x.py"), "utf8")).toBe("print('canonical')\n");
	}, fixtureDeadlineS(30) * 1_000);
});
