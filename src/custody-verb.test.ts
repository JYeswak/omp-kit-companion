/** CC15 custody verb (bead ompkit-fp72.120.16.2.1): unit tests for src/custody.ts.
 *
 * exit_code_passthrough_0_10_11_2_3, absent_adapter_never_grants,
 * timeout_maps_probe_timeout (planted sleeping custody stub), argv_not_shell
 * (planted path `a;touch x` creates no file), result_code_mapping,
 * attempt_written_for_usage_error, race re-read passthrough (DIRTY_UNOWNED with
 * the lease named for release passes through as exit 11).
 */
import { expect, test } from "bun:test";
import { afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ccActionOutcome, runCli, type ParsedCommand } from "./cli.ts";
import {
	resolveCustodyScript,
	runCustodyCheck,
	custodyCheckCommand,
} from "./custody.ts";

const repoRoot = join(import.meta.dir, "..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });

const scratchPrefix = `custody-verb-test.${process.pid}.`;
afterAll(() => {
	for (const name of readdirSync(scratchRoot)) {
		if (name.startsWith(scratchPrefix)) { try { rmSync(join(scratchRoot, name), { recursive: true, force: true }); } catch { /* best effort */ } }
	}
});

function freshDir(prefix: string): string {
	return mkdtempSync(join(scratchRoot, `custody-verb-test.${process.pid}.${prefix}.`));
}

/** Fixture fleet root: scripts/cc/custody.py with the given body, owned by the caller. */
function fixtureFleet(body: string): string {
	const root = freshDir("fleet");
	const dir = join(root, "scripts", "cc");
	mkdirSync(dir, { recursive: true });
	const script = join(dir, "custody.py");
	writeFileSync(script, body);
	chmodSync(script, 0o755);
	return root;
}

const ECHO_STUB = `#!/usr/bin/env python3
import json, os, sys
print(json.dumps({"schema_version": "omp-kit.custody.v1", "ok": True, "argv": sys.argv[1:]}))
sys.exit(int(os.environ.get("CUSTODY_STUB_EXIT", "0")))
`;

const savedEnv = { ...process.env };

function custodyEnv(fleetRoot: string | null, extra?: Record<string, string>): void {
	for (const key of ["OMP_KIT_FLEET_ROOT", "OMP_KIT_FLEET_WATCH_CONFIG", "OMP_KIT_CUSTODY_TIMEOUT_MS", "CUSTODY_STUB_EXIT"]) {
		delete process.env[key];
	}
	if (fleetRoot !== null) process.env.OMP_KIT_FLEET_ROOT = fleetRoot;
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = join(freshDir("cfg"), "fleet-watch.json");
	if (extra) for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

function restoreEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

function checkRequest(flags: [string, string | true][], argument?: string): ParsedCommand {
	return {
		command: { name: "check", description: "t", usage: "t", flags: [], example: "t", runnable: false },
		parent: { name: "custody", description: "t", usage: "t", flags: [], example: "t", runnable: false },
		flags: new Map(flags),
		...(argument === undefined ? {} : { argument }),
		json: true,
		robot: false,
	};
}

test("exit_code_passthrough_0_10_11_2_3", () => {
	const fleet = fixtureFleet(ECHO_STUB);
	try {
		for (const exit of [0, 10, 11, 2, 3]) {
			custodyEnv(fleet, { CUSTODY_STUB_EXIT: String(exit) });
			const result = custodyCheckCommand(checkRequest([["--repo", "/repo"]], "doc/a.md"));
			expect(result.code).toBe(exit);
		}
	} finally {
		restoreEnv();
	}
});

test("result_code_mapping", () => {
	const fleet = fixtureFleet(ECHO_STUB);
	try {
		const cases: [string, number, "ok" | "refused" | "failed", string][] = [
			["0", 0, "ok", "GRANTED"],
			["10", 10, "ok", "HELD"],
			["11", 11, "ok", "DIRTY_UNOWNED"],
			["2", 2, "refused", "USAGE"],
			["3", 3, "failed", "PROBE_FAILED"],
		];
		for (const [stubExit, code, outcome, resultCode] of cases) {
			custodyEnv(fleet, { CUSTODY_STUB_EXIT: stubExit });
			const result = custodyCheckCommand(checkRequest([["--repo", "/repo"]], "doc/a.md"));
			expect(result.code).toBe(code);
			expect(ccActionOutcome(result.code, result.errors).outcome).toBe(outcome);
			expect((result.data as Record<string, unknown>).code).toBe(resultCode);
		}
	} finally {
		restoreEnv();
	}
});

test("absent_adapter_never_grants", () => {
	const emptyHome = freshDir("home");
	const emptyBin = freshDir("bin");
	try {
		custodyEnv(null);
		process.env.HOME = emptyHome;
		process.env.PATH = emptyBin;
		expect(resolveCustodyScript()).toBeNull();
		// Even with no python on PATH, the refusal is clean: nothing was spawned.
		const result = custodyCheckCommand(checkRequest([["--repo", "/repo"]], "doc/a.md"));
		expect(result.code).toBe(3);
		expect(result.errors?.[0]?.code).toBe("CUSTODY_ADAPTER_ABSENT");
		expect((result.data as Record<string, unknown>).code).toBe("PROBE_FAILED");
	} finally {
		restoreEnv();
	}
});

test("timeout_maps_probe_timeout", () => {
	const fleet = fixtureFleet("#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n");
	try {
		custodyEnv(fleet);
		const script = resolveCustodyScript();
		expect(script).not.toBeNull();
		const result = runCustodyCheck(script ?? "", ["--repo", "/repo", "doc/a.md"], { timeoutMs: 300 });
		expect(result.code).toBe(3);
		expect(result.errors?.[0]?.code).toBe("PROBE_TIMEOUT");
		expect((result.data as Record<string, unknown>).code).toBe("PROBE_TIMEOUT");
	} finally {
		restoreEnv();
	}
});

test("argv_not_shell", () => {
	const work = freshDir("work");
	const fleet = fixtureFleet(ECHO_STUB);
	try {
		custodyEnv(fleet, { CUSTODY_STUB_EXIT: "0" });
		const result = custodyCheckCommand(checkRequest([["--repo", "/repo"]], "a;touch x"));
		expect(result.code).toBe(0);
		const argv = (result.data as Record<string, unknown>).argv as string[];
		expect(argv).toContain("a;touch x");
		expect(existsSync(join(work, "x"))).toBe(false);
		expect(existsSync(join(process.cwd(), "x"))).toBe(false);
	} finally {
		restoreEnv();
	}
});

test("race_reread_passthrough_names_lease", () => {
	// custody.py's round-17 shape: a path that turned dirty while reserving comes
	// back DIRTY_UNOWNED with the caller's own lease named for release. The verb
	// must pass exit 11 and the lease through untouched, never a GRANTED.
	const doc = {
		schema_version: "omp-kit.custody.v1",
		ok: false,
		paths: [{ path: "doc/a.md", outcome: "DIRTY_UNOWNED", dirty: true,
			lease: { id: 4242, expires: "2030-01-01T00:00:00Z" },
			next: "do not edit; the path turned dirty while reserving; release this lease" }],
	};
	const fleet = fixtureFleet(`#!/usr/bin/env python3\nimport json, os, sys\nprint(${JSON.stringify(JSON.stringify(doc))})\nsys.exit(int(os.environ.get("CUSTODY_STUB_EXIT", "0")))\n`);
	try {
		custodyEnv(fleet, { CUSTODY_STUB_EXIT: "11" });
		const result = custodyCheckCommand(checkRequest([["--repo", "/repo"]], "doc/a.md"));
		expect(result.code).toBe(11);
		const paths = (result.data as Record<string, unknown>).paths as Record<string, unknown>[];
		expect(paths[0]?.outcome).toBe("DIRTY_UNOWNED");
		expect((paths[0]?.lease as Record<string, unknown>)?.id).toBe(4242);
	} finally {
		restoreEnv();
	}
});

test("attempt_written_for_usage_error", async () => {
	// "custody check" is registered by cli.ts at module load; registering again throws.
	const state = freshDir("state");
	mkdirSync(join(state, "spool"), { recursive: true });
	const savedOut = process.stdout.write.bind(process.stdout);
	const savedErr = process.stderr.write.bind(process.stderr);
	let captured = "";
	const savedState = process.env.CC_STATE, savedAgent = process.env.AGENT_NAME;
	process.env.CC_STATE = state;
	process.env.AGENT_NAME = "TestCustody";
	try {
		// A PATH positional without --repo parses to the command, so the
		// handler-level usage refusal (exit 2) carries surface kit:custody check.
		const code = await runCli(["custody", "check", "--json", "doc/a.md"]);
		expect(code).toBe(2);
		const day = new Date().toISOString().slice(0, 10);
		const lines = readFileSync(join(state, "spool", "kit", `${day}.jsonl`), "utf8")
			.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const attempts = lines.filter((line) => line.type === "action.attempt"
			&& (line.data as Record<string, unknown>).surface === "kit:custody check");
		expect(attempts.length).toBe(1);
		void captured;
	} finally {
		process.stdout.write = savedOut;
		process.stderr.write = savedErr;
		if (savedState === undefined) delete process.env.CC_STATE; else process.env.CC_STATE = savedState;
		if (savedAgent === undefined) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = savedAgent;
		restoreEnv();
	}
});
