import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { run } from "../kitlib/run.ts";
import { ownedTmp } from "../kitlib/tmp.ts";

// WRITEOWNCHILD1 (ompkit-1ra0d.126): a native task child writes under its parent seat's custody. The seat is
// AGENT_NAME (never the child's spawn-minted name); a free path auto-reserves for the seat and admits; only a
// foreign-held path refuses, naming the holder. `agent not found` is an answer (zero holds), not an outage.
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

// Test seam for the Agent Mail CLI: the guard's real spawn, attestation and hold parsing run unchanged. Reserves
// append `project|agent|path` journal rows, and `robot reservations` answers from the journal, so an auto-reserve
// is visible to the next lookup the way the server would show it.
const fixtureBin = join(scratch, "bin");
mkdirSync(fixtureBin, { recursive: true });
writeFileSync(join(fixtureBin, "am"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AM_FIXTURE_CALLS"
if [ "$AM_FIXTURE_MODE" = "fail" ]; then echo 'connection refused' >&2; exit 1; fi
if [ "$1" = "file_reservations" ] && [ "$2" = "reserve" ]; then
  root="$3"; agent="$4"
  if [ -n "$AM_FIXTURE_AGENT_MISSING" ] && [ "$agent" = "$AM_FIXTURE_AGENT_MISSING" ]; then
    echo "error: invalid argument: agent not found: $agent" >&2; exit 1
  fi
  shift 4
  paths=""; reason=""; exclusive="true"; skip=""; want=""
  for p in "$@"; do
    if [ -n "$skip" ]; then skip=""; continue; fi
    case "$p" in
      --ttl) skip="1"; continue;;
      --reason) want="1"; continue;;
      --*) continue;;
      *) if [ -n "$want" ]; then reason="$p"; want=""; continue; fi
        paths="$paths $p";;
    esac
  done
  if [ "$AM_FIXTURE_RESERVE_MODE" = "conflict" ]; then
    out='{"granted":[],"conflicts":['; first=1
    for q in $paths; do
      if [ "$first" = 1 ]; then first=0; else out="$out,"; fi
      out="$out$(printf '{"holder":"%s","path_pattern":"%s","exclusive":true}' "\${AM_FIXTURE_RACE_HOLDER:-Other}" "$q")"
    done
    printf '%s]}\n' "$out"; exit 0
  fi
  if [ "$AM_FIXTURE_RESERVE_MODE" = "short" ]; then
    echo '{"granted":[],"conflicts":[]}'; exit 0
  fi
  winner="$agent"
  if [ "$AM_FIXTURE_RESERVE_MODE" = "race" ]; then winner="\${AM_FIXTURE_RACE_HOLDER:-Other}"; fi
  out='{"granted":['; first=1; n=0
  for q in $paths; do
    n=$((n + 1))
    out="$out$(printf '{"id":%d,"path_pattern":"%s","exclusive":%s,"reason":"%s","expires_ts":"2030-01-01T00:00:00.000Z"}' "$n" "$q" "$exclusive" "$reason")"
    printf '%s|%s|%s\n' "$root" "$winner" "$q" >> "$AM_FIXTURE_JOURNAL"
  done
  printf '%s],"conflicts":[]}\n' "$out"; exit 0
fi
root=""; agent=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--project" ]; then root="$a"; fi
  if [ "$prev" = "--agent" ]; then agent="$a"; fi
  prev="$a"
done
if [ -n "$AM_FIXTURE_AGENT_MISSING" ] && [ "$agent" = "$AM_FIXTURE_AGENT_MISSING" ]; then
  echo "error: invalid argument: agent not found: $agent" >&2; exit 1
fi
mine_rows=""; all_rows=""
if [ -f "$AM_FIXTURE_JOURNAL" ]; then
  while IFS='|' read -r p a path; do
    case "$p" in ""|\\#*) continue;; esac
    if [ "$p" = "$root" ]; then
      cell=$(printf '{"agent":"%s","path":"%s","exclusive":true,"remaining_seconds":3600}' "$a" "$path")
      if [ -z "$all_rows" ]; then all_rows="$cell"; else all_rows="$all_rows,$cell"; fi
      if [ "$a" = "$agent" ]; then
        if [ -z "$mine_rows" ]; then mine_rows="$cell"; else mine_rows="$mine_rows,$cell"; fi
      fi
    fi
  done < "$AM_FIXTURE_JOURNAL"
fi
printf '{"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true},"my_reservations":[%s],"all_active":[%s]}' "$mine_rows" "$all_rows"
`);
writeFileSync(join(fixtureBin, "br"), `#!/bin/sh
if [ -n "$BR_FIXTURE_BEAD" ]; then printf '[{"id":"%s","status":"in_progress","assignee":"%s"}]' "$BR_FIXTURE_BEAD" "$BR_FIXTURE_ASSIGNEE"; else exit 1; fi
`);
chmodSync(join(fixtureBin, "am"), 0o755);
chmodSync(join(fixtureBin, "br"), 0o755);
const callLog = join(scratch, "am-calls.log");
const journal = join(scratch, "holds.log");

async function withAm<T>(options: { seed?: string[]; mode?: "ok" | "fail"; agent?: string; missing?: string; bead?: string; assignee?: string; reserveMode?: string; raceHolder?: string }, runFn: () => Promise<T>): Promise<T> {
	const saved = { PATH: process.env.PATH, AGENT_NAME: process.env.AGENT_NAME, AM_FIXTURE_MODE: process.env.AM_FIXTURE_MODE,
		AM_FIXTURE_CALLS: process.env.AM_FIXTURE_CALLS, AM_FIXTURE_JOURNAL: process.env.AM_FIXTURE_JOURNAL,
		AM_FIXTURE_AGENT_MISSING: process.env.AM_FIXTURE_AGENT_MISSING, BR_FIXTURE_BEAD: process.env.BR_FIXTURE_BEAD,
		BR_FIXTURE_ASSIGNEE: process.env.BR_FIXTURE_ASSIGNEE, AM_FIXTURE_RESERVE_MODE: process.env.AM_FIXTURE_RESERVE_MODE,
		AM_FIXTURE_RACE_HOLDER: process.env.AM_FIXTURE_RACE_HOLDER };
	process.env.PATH = `${fixtureBin}:${saved.PATH ?? ""}`;
	if (options.agent === undefined) delete process.env.AGENT_NAME;
	else process.env.AGENT_NAME = options.agent;
	process.env.AM_FIXTURE_MODE = options.mode ?? "ok";
	process.env.AM_FIXTURE_CALLS = callLog;
	process.env.AM_FIXTURE_JOURNAL = journal;
	if (options.missing === undefined) delete process.env.AM_FIXTURE_AGENT_MISSING;
	else process.env.AM_FIXTURE_AGENT_MISSING = options.missing;
	if (options.bead === undefined) delete process.env.BR_FIXTURE_BEAD;
	else process.env.BR_FIXTURE_BEAD = options.bead;
	if (options.assignee === undefined) delete process.env.BR_FIXTURE_ASSIGNEE;
	else process.env.BR_FIXTURE_ASSIGNEE = options.assignee;
	if (options.reserveMode === undefined) delete process.env.AM_FIXTURE_RESERVE_MODE;
	else process.env.AM_FIXTURE_RESERVE_MODE = options.reserveMode;
	if (options.raceHolder === undefined) delete process.env.AM_FIXTURE_RACE_HOLDER;
	else process.env.AM_FIXTURE_RACE_HOLDER = options.raceHolder;
	writeFileSync(callLog, "");
	writeFileSync(journal, (options.seed ?? []).join("\n") + (options.seed?.length ? "\n" : ""));
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
const reserves = (): string[] => readFileSync(callLog, "utf8").split("\n").filter(Boolean)
	.filter((line) => line.startsWith("file_reservations reserve "));
const write = (path: string, context: CallContext) =>
	handleToolCall({ toolName: "write", input: { path, content: "planted\n" }, cwd: repo }, context);
test("WRITEOWNCHILD1: a task child's write to a path its parent seat reserved is admitted under the seat", async () => {
	const warns: string[] = [];
	await withAm({ seed: [`${repo}|Seat|scripts/x.py`], agent: "Seat" }, async () => {
		expect(await write("scripts/x.py", caller("ChildA", warns))).toBeUndefined();
		expect(await write("scripts/x.py", caller(undefined, warns))).toBeUndefined();
		expect(warns, "seat-covered writes reserve nothing and say nothing").toEqual([]);
		const agents = readFileSync(callLog, "utf8").split("\n").filter(Boolean)
			.filter((line) => line.startsWith("robot reservations ")).map((line) => /--agent (\S+)/.exec(line)?.[1]);
		expect(agents).toContain("Seat");
		expect(agents, "the primary lookup never uses the child's own name").not.toContain("ChildA");
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

test("WRITEOWNCHILD1: an Agent Mail outage refuses as an outage, while agent-not-found reads as no holds", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", mode: "fail" }, async () => {
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
		expect(result?.reason).toContain("connection refused");
	});
	await withAm({ agent: "Seat", missing: "Seat" }, async () => {
		// The seat itself is unknown to Agent Mail: that is zero holds, so the guard tries the seat's own
		// reserve, which fails with the real cause instead of a lookup outage.
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).not.toContain("LOOKUP_UNAVAILABLE");
		expect(result?.reason).toContain("agent not found: Seat");
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

test("WRITEOWNCHILD1-auto: a reserve that reports a conflict is refused", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", reserveMode: "conflict" }, async () => {
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).toContain("conflict");
		expect(result?.reason).toContain("Other");
		expect(reserves(), "the refused write attempted exactly one reserve").toHaveLength(1);
		expect(warns).toEqual([]);
	});
});

test("WRITEOWNCHILD1-auto: a reserve that grants nothing is refused without admitting", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", reserveMode: "short" }, async () => {
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).toContain("did not take");
		expect(reserves(), "the refused write attempted exactly one reserve").toHaveLength(1);
		expect(warns).toEqual([]);
	});
});

test("WRITEOWNCHILD1-auto: a reserve the re-read does not confirm is refused naming the winner", async () => {
	const warns: string[] = [];
	await withAm({ agent: "Seat", reserveMode: "race", raceHolder: "Other" }, async () => {
		const result = await write("scripts/free.py", caller("ChildA", warns));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WRITE_OWN_UNRESERVED");
		expect(result?.reason).toContain("Other");
		expect(reserves(), "the refused write attempted exactly one reserve").toHaveLength(1);
		expect(warns).toEqual([]);
	});
});
