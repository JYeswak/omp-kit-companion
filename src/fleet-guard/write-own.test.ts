import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { run } from "../kitlib/run.ts";
import { boardLog, boardRace, boardScenario, startBoard, type BoardRow } from "../../tests/fleet-guard/board-fixture.ts";
import { ownedTmp } from "../kitlib/tmp.ts";

// WRITEOWNCHILD1 (ompkit-1ra0d.126): a native task child writes under its parent seat's custody. The seat is
// AGENT_NAME (never the child's spawn-minted name); a free path auto-reserves for the seat and admits; only a
// foreign-held path refuses, naming the holder. A Board that cannot answer is an outage, never zero holds.
const scratchRoot = join(import.meta.dir, "../../var/agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = realpathSync(ownedTmp("fleet-guard-writeownchild", { root: scratchRoot }).path);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
async function fleetRepo(name: string): Promise<string> {
	const root = join(scratch, name);
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "fleet.json"), JSON.stringify({ enabled: true }));
	writeFileSync(join(root, "scripts", "x.py"), "print('canonical')\n");
	writeFileSync(join(root, "scripts", "y.py"), "print('peer')\n");
	writeFileSync(join(root, "scripts", "free.py"), "print('free')\n");
	const git = async (...args: string[]) => {
		const result = await run(["git", "-C", root, ...args], { deadline_s: 30, max_output_bytes: 1 << 16, env: gitEnv });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	};
	await git("init", "-q", "-b", "main");
	await git("add", ".omp/fleet.json", "scripts/x.py", "scripts/y.py", "scripts/free.py");
	await git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
	return root;
}
const repo = await fleetRepo("repo");

// Test seam for the Board: the guard's real child spawn, attested read and hold parsing run unchanged against a fake
// Board that seeds holds, journals auto-reserves so the next read sees them, and logs every request.
const fixtureBin = join(scratch, "bin");
mkdirSync(fixtureBin, { recursive: true });
await startBoard(scratch);
writeFileSync(join(fixtureBin, "br"), `#!/bin/sh
if [ -n "$BR_FIXTURE_BEAD" ]; then printf '[{"id":"%s","status":"in_progress","assignee":"%s"}]' "$BR_FIXTURE_BEAD" "$BR_FIXTURE_ASSIGNEE"; else exit 1; fi
`);
chmodSync(join(fixtureBin, "br"), 0o755);

async function withAm<T>(options: { seed?: string[]; mode?: "ok" | "fail"; agent?: string; bead?: string; assignee?: string; raceHolder?: string }, runFn: () => Promise<T>): Promise<T> {
	const saved = { PATH: process.env.PATH, AGENT_NAME: process.env.AGENT_NAME, BR_FIXTURE_BEAD: process.env.BR_FIXTURE_BEAD,
		BR_FIXTURE_ASSIGNEE: process.env.BR_FIXTURE_ASSIGNEE, BOARD_URL: process.env.BOARD_URL };
	process.env.PATH = `${fixtureBin}:${saved.PATH ?? ""}`;
	if (options.agent === undefined) delete process.env.AGENT_NAME;
	else process.env.AGENT_NAME = options.agent;
	if (options.bead === undefined) delete process.env.BR_FIXTURE_BEAD;
	else process.env.BR_FIXTURE_BEAD = options.bead;
	if (options.assignee === undefined) delete process.env.BR_FIXTURE_ASSIGNEE;
	else process.env.BR_FIXTURE_ASSIGNEE = options.assignee;
	// A seed row is `project|agent|path`; every row here lives in the one fixture project.
	const rows: BoardRow[] = (options.seed ?? []).map((row) => { const [, agent, path] = row.split("|"); return { agent: agent!, path: path! }; });
	await boardScenario({ rows, down: options.mode === "fail" });
	if (options.raceHolder !== undefined) await boardRace(options.raceHolder);
	try { return await runFn(); }
	finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// The later HTTP reservation layer is held neutral so every verdict is the write-ownership read's.
const neutral = async () => ({ covered: true, conflicts: [] as readonly unknown[] });
interface CallContext {
	cwd: string;
	lookupReservations: () => Promise<{ covered: boolean; conflicts: readonly unknown[] }>;
	childAgentName?: string;
	warn: (message: string) => void;
}
function caller(childAgentName: string | undefined, warns: string[]): CallContext {
	return { cwd: repo, lookupReservations: neutral, ...(childAgentName === undefined ? {} : { childAgentName }), warn: (message: string) => { warns.push(message); } };
}
const reserves = (): string[] => boardLog([repo]).filter((line) => line.startsWith("file_reservations reserve "));
const write = (path: string, context: CallContext) =>
	handleToolCall({ toolName: "write", input: { path, content: "planted\n" }, cwd: repo }, context);
test("WRITEOWNCHILD1: a task child's write to a path its parent seat reserved is admitted under the seat", async () => {
	const warns: string[] = [];
	await withAm({ seed: [`${repo}|Seat|scripts/x.py`], agent: "Seat" }, async () => {
		expect(await write("scripts/x.py", caller("ChildA", warns))).toBeUndefined();
		expect(await write("scripts/x.py", caller(undefined, warns))).toBeUndefined();
		expect(warns, "seat-covered writes reserve nothing and say nothing").toEqual([]);
		expect(boardLog([repo]).filter((line) => line.startsWith("robot reservations ")).length, "the seat read the Board").toBeGreaterThan(0);
	});
	expect(readFileSync(join(repo, "scripts", "x.py"), "utf8")).toBe("print('canonical')\n");
});

test("WRITEOWNCHILD1: a path another agent holds is refused naming the holder", async () => {
	const warns: string[] = [];
	await withAm({ seed: [`${repo}|Seat|scripts/x.py`, `${repo}|Other|scripts/y.py`], agent: "Seat" }, async () => {
		for (const context of [caller("ChildA", warns), caller(undefined, warns)]) {
			const result = await write("scripts/y.py", context);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
			expect(result?.reason).toContain("Other");
		}
		expect(reserves(), "a foreign-held path is never auto-reserved").toEqual([]);
	});
});

test("WRITEOWNCHILD1-auto: a first write to a free path reserves it for the seat and is admitted", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat" }, async () => {
		expect(await write("scripts/free.py", caller("ChildA", warns))).toBeUndefined();
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("auto-reserved scripts/free.py");
		expect(warns[0]).toContain("for Seat");
		expect(warns[0]).toContain("auto: first write");
		expect(reserves()).toEqual([
			`file_reservations reserve ${repo} Seat scripts/free.py --exclusive --ttl 3600 --reason auto: first write`,
		]);
	});
});

test("WRITEOWNCHILD1-auto: directory-scoped writes reserve the directory pattern for the seat", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat" }, async () => {
		expect(await handleToolCall({ toolName: "bash", input: { command: "echo x > scripts/sub/out-$RANDOM.txt" }, cwd: repo }, caller("ChildA", warns))).toBeUndefined();
		expect(warns).toHaveLength(1);
		expect(reserves()).toEqual([
			`file_reservations reserve ${repo} Seat scripts/sub/* --exclusive --ttl 3600 --reason auto: first write`,
		]);
	});
});

test("WRITEOWNCHILD1-auto: the reserve reason names the seat's held bead when the tracker names one", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", bead: "seat-bead-9", assignee: "Seat" }, async () => {
		expect(await write("scripts/free.py", caller("ChildA", warns))).toBeUndefined();
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("reason seat-bead-9");
		expect(reserves()).toEqual([
			`file_reservations reserve ${repo} Seat scripts/free.py --exclusive --ttl 3600 --reason seat-bead-9`,
		]);
	});
	await withAm({ agent: "Seat", bead: "other-bead-1", assignee: "Other" }, async () => {
		expect(await write("scripts/free.py", caller("ChildA", warns))).toBeUndefined();
		expect(reserves()[0]).toContain("--reason auto: first write");
	});
});

test("WRITEOWNCHILD1-auto: a second seat's write to an auto-reserved path is refused", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat" }, async () => {
		expect(await write("scripts/free.py", caller("ChildA", warns))).toBeUndefined();
		expect(reserves()).toHaveLength(1);
		process.env.AGENT_NAME = "Seat2";
		const secondWarns: string[] = [];
		const refused = await write("scripts/free.py", caller(undefined, secondWarns));
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(refused?.reason).toContain("Seat");
		expect(refused?.reason).not.toContain("LOOKUP_UNAVAILABLE");
		expect(reserves(), "the refused second writer reserves nothing more").toHaveLength(1);
		expect(secondWarns).toEqual([]);
	});
});

test("WRITEOWNCHILD1: a Board outage refuses as an outage", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", mode: "fail" }, async () => {
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
		expect(result?.reason).toContain("the Board could not be read");
	});
});

test("WRITEOWNCHILD1: one call touching a free path and a foreign-held path refuses and reserves nothing", async () => {
	const warns: string[] = [];
	await withAm({ seed: [`${repo}|Other|scripts/held.txt`], agent: "Seat" }, async () => {
		const result = await handleToolCall({ toolName: "bash", input: { command: "echo x > scripts/free.txt; echo y > scripts/held.txt" }, cwd: repo }, caller(undefined, warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).toContain("Other");
		expect(reserves(), "a foreign-held path in the call blocks every reserve").toEqual([]);
		expect(warns).toEqual([]);
	});
});

test("WRITEOWNCHILD1: a foreign hold wins over child cover and names the holder", async () => {
	const warns: string[] = [];
	await withAm({ seed: [`${repo}|Other|scripts/x.py`, `${repo}|ChildA|scripts/*`], agent: "Seat" }, async () => {
		const result = await write("scripts/x.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).toContain("Other");
		expect(reserves(), "a foreign-held path is never auto-reserved").toEqual([]);
		expect(warns).toEqual([]);
	});
});

test("WRITEOWNCHILD1-auto: a reserve that loses the race on the Board is refused naming the winner", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", raceHolder: "Other" }, async () => {
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).toContain("Other");
		expect(reserves(), "the refused write attempted exactly one reserve").toHaveLength(1);
		expect(warns).toEqual([]);
	});
});
