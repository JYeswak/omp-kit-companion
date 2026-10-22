import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard from "../../extensions/fleet-guard.ts";
import type { FleetGuardBlock, FleetGuardEvent } from "../../src/fleet-guard/git.ts";
import { checkPlutilInPlace } from "../../src/fleet-guard/plutil.ts";

// PLUTILINPLACE1 (ompkit-ffb85): on 2026-10-21 `plutil -extract ProgramArguments json <plist>` (no `-o`) rewrote
// 12 LaunchAgent plists as JSON arrays. fleet-guard refuses a plutil edit without `-o` in every session.

const scratchRoot = join(import.meta.dir, "../../var/agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("fleet-guard-plutil", { root: scratchRoot }).path;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const savedEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv) as ["TMPDIR" | "TMP" | "TEMP", string | undefined][]) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const bash = (command: string): FleetGuardEvent => ({ toolName: "bash", input: { command } });

const PLIST = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
	'<plist version="1.0">',
	"<dict>",
	"\t<key>Label</key>",
	"\t<string>ai.example.fixture</string>",
	"\t<key>ProgramArguments</key>",
	"\t<array>",
	"\t\t<string>/bin/echo</string>",
	"\t\t<string>hi</string>",
	"\t</array>",
	"</dict>",
	"</plist>",
	"",
].join("\n");

type Handler = (event: FleetGuardEvent, context?: { cwd: string }) => Promise<FleetGuardBlock | undefined>;

// A session loaded the way omp loads the profile extension; the first block wins, as in omp's handler chain.
async function session(cwd: string): Promise<(command: string, callingCwd?: string) => Promise<FleetGuardBlock | undefined>> {
	const handlers: Handler[] = [];
	await fleetGuard({
		setLabel() {},
		on(event: string, handler: (...args: never[]) => unknown) { if (event === "tool_call") handlers.push(handler as Handler); },
	} as never, { cwd, pid: process.pid });
	return async (command, callingCwd = cwd) => {
		for (const handler of handlers) {
			const result = await handler(bash(command), { cwd: callingCwd });
			if (result?.block) return result;
		}
		return undefined;
	};
}

function repository(name: string, fleet: boolean): string {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_DIR") || key === "GIT_WORK_TREE") delete env[key];
	const init = spawnSync("git", ["-C", dir, "init", "--quiet"], { env, encoding: "utf8" });
	if (init.status !== 0) throw new Error(init.stderr);
	if (fleet) {
		mkdirSync(join(dir, ".omp"));
		writeFileSync(join(dir, ".omp", "fleet.json"), '{"enabled":true}\n');
	}
	return dir;
}

describe("fleet guard PLUTILINPLACE1: plutil edits must name their output (ompkit-ffb85)", () => {
	test("an editing verb without -o is refused, in chains, quoted paths, loops, wrappers and nested shells", () => {
		for (const command of [
			"plutil -extract ProgramArguments json fixture.plist",
			"plutil -convert xml1 a.plist && cat a.plist",
			"cd agents; plutil -convert json \"My Agent.plist\"",
			"/usr/bin/plutil -replace Label -string x 'a b.plist'",
			"plutil -insert KeepAlive -dictionary a.plist",
			"plutil -remove Label a.plist",
			"plutil -convert json -s \"$f\"",
			"for f in *.plist; do plutil -convert xml1 \"$f\"; done",
			"nice -n 10 plutil -convert binary1 a.plist",
			"bash -c 'plutil -extract Label json a.plist'",
			"echo $(plutil -convert json a.plist)",
			// The value of -replace/-insert and the keypath are operands, not the -o option: plutil still rewrites a.plist.
			"plutil -replace Label -string -o a.plist",
			"plutil -remove -o a.plist",
			// After `--` every word is a file name.
			"plutil -convert json -- -o a.plist",
			// Only `-extract keypath raw` prints to stdout; the exemption is not a word anywhere in an edit.
			"plutil -convert raw a.plist",
		]) {
			const result = checkPlutilInPlace(bash(command));
			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain("PLUTIL_IN_PLACE");
			expect(result?.reason, command).toContain("-o -");
		}
	});

	test("-o, read-only verbs, -extract raw and mentions inside other commands are admitted", () => {
		for (const command of [
			"plutil -extract ProgramArguments json -o - fixture.plist",
			"plutil -convert json -o out.json a.plist",
			"plutil -convert json a.plist -o -",
			"plutil -convert json -o - -- a.plist",
			"plutil -insert New -array -o - a.plist",
			"plutil -extract ProgramArguments json -expect array -o - a.plist",
			"plutil -lint x.plist",
			"plutil x.plist",
			"plutil -p x.plist",
			"plutil -help",
			"plutil -type Label x.plist",
			"plutil -extract Label raw x.plist",
			"echo \"plutil -convert json x\"",
			"grep -rn 'plutil -extract ProgramArguments json' docs",
			"git commit -m \"plutil -convert json is refused\"",
			"man plutil",
		]) expect(checkPlutilInPlace(bash(command)), command).toBeUndefined();
	});

	test("the always-on rule ignores calls with no shell command", () => {
		expect(checkPlutilInPlace({ toolName: "write", input: { path: "a.plist", content: "plutil -convert json a.plist" } })).toBeUndefined();
	});

	test("text the lexer cannot delimit is refused only when it names plutil", () => {
		expect(checkPlutilInPlace(bash("plutil -convert json 'a.plist"))?.reason).toContain("could not be inspected");
		expect(checkPlutilInPlace(bash("echo 'unterminated"))).toBeUndefined();
	});

	test("a session in a repository without .omp/fleet.json still refuses the incident form", async () => {
		const stock = repository("stock-admission", false);
		const guarded = await session(stock);
		expect((await guarded("plutil -extract ProgramArguments json fixture.plist"))?.reason).toContain("PLUTIL_IN_PLACE");
		expect(await guarded("plutil -extract ProgramArguments json -o - fixture.plist")).toBeUndefined();
		expect(await guarded("git checkout -b stock-topic")).toBeUndefined();
	});

	test("an opted-in session refuses it for a call made outside any opted-in repository", async () => {
		const fleet = repository("fleet-admission", true);
		const outside = repository("outside-admission", false);
		const guarded = await session(fleet);
		expect((await guarded("plutil -convert xml1 a.plist && cat a.plist", outside))?.reason).toContain("PLUTIL_IN_PLACE");
		expect(await guarded("plutil -lint a.plist", outside)).toBeUndefined();
	});

	const plutil = Bun.which("plutil");
	describe.skipIf(plutil === null)("real plist fixtures (macOS plutil)", () => {
		// Runs the command only when the stock session admits it, as omp does with a blocked tool call.
		async function run(dir: string, command: string): Promise<{ block?: FleetGuardBlock; stdout?: string }> {
			const block = await (await session(dir))(command);
			if (block) return { block };
			const result = spawnSync("bash", ["-c", command], { cwd: dir, encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			return { stdout: result.stdout };
		}

		test("planted: the incident command is refused and the plist bytes are unchanged", async () => {
			const dir = repository("planted", false);
			writeFileSync(join(dir, "fixture.plist"), PLIST);
			const outcome = await run(dir, "plutil -extract ProgramArguments json fixture.plist");
			expect(readFileSync(join(dir, "fixture.plist"), "utf8")).toBe(PLIST);
			expect(outcome.block?.reason).toContain("PLUTIL_IN_PLACE");
		});

		test("planted chain: -convert in an && chain is refused and the plist bytes are unchanged", async () => {
			const dir = repository("planted-chain", false);
			// A binary1 fixture, so the xml1 rewrite the rule prevents would change its bytes.
			writeFileSync(join(dir, "source.plist"), PLIST);
			const made = spawnSync("plutil", ["-convert", "binary1", "-o", "a.plist", "source.plist"], { cwd: dir, encoding: "utf8" });
			expect(made.status, made.stderr).toBe(0);
			const binary = readFileSync(join(dir, "a.plist"));
			const outcome = await run(dir, "plutil -convert xml1 a.plist && cat a.plist");
			expect(readFileSync(join(dir, "a.plist"))).toEqual(binary);
			expect(outcome.block?.reason).toContain("PLUTIL_IN_PLACE");
		});

		test("control: -o - runs, prints the extracted value and leaves the plist unchanged", async () => {
			const dir = repository("control", false);
			writeFileSync(join(dir, "fixture.plist"), PLIST);
			const outcome = await run(dir, "plutil -extract ProgramArguments json -o - fixture.plist");
			expect(outcome.block).toBeUndefined();
			expect(JSON.parse(outcome.stdout!)).toEqual(["/bin/echo", "hi"]);
			expect(readFileSync(join(dir, "fixture.plist"), "utf8")).toBe(PLIST);
		});

		test("unguarded, the planted command rewrites the fixture into a JSON array (the damage the rule prevents)", () => {
			const dir = repository("unguarded", false);
			writeFileSync(join(dir, "fixture.plist"), PLIST);
			const result = spawnSync("plutil", ["-extract", "ProgramArguments", "json", "fixture.plist"], { cwd: dir, encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(readFileSync(join(dir, "fixture.plist"), "utf8"))).toEqual(["/bin/echo", "hi"]);
		});
	});
});
