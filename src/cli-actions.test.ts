import { expect, test } from "bun:test";
import { afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ccActionOutcome, ccActionTarget, registerCommandHandler, runCli } from "../src/cli.ts";
import { ownedTmp, type OwnedTmp } from "../src/kitlib/tmp.ts";

const repoRoot = resolve(import.meta.dir, "..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
}, 120000);

function freshState(): string {
	const t = ownedTmp("cli-actions-test", { root: scratchRoot });
	owned.push(t);
	const dir = t.path;
	mkdirSync(join(dir, "spool"), { recursive: true });
	return dir;
}

type CliRun = { exitCode: number; stdout: string; stderr: string };

function spawnCli(args: string[], env: Record<string, string>): Promise<CliRun> {
	const child = Bun.spawn([process.execPath, join(repoRoot, "src", "cli.ts"), ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			TMPDIR: env.TMPDIR ?? join(env.STATE, "tmp"),
			XDG_STATE_HOME: join(env.STATE, "xdg"),
			HOME: join(env.STATE, "home"),
			CC_STATE: env.STATE,
			AGENT_NAME: "TestCliActions",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		.then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

function spoolLines(state: string): Record<string, unknown>[] {
	const day = new Date().toISOString().slice(0, 10);
	const path = join(state, "spool", "kit", `${day}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function tripleFor(lines: Record<string, unknown>[], actionId: string): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const line of lines) {
		const data = line.data as Record<string, unknown>;
		if (data.action_id === actionId || line.position === `kit:${actionId}:tick`) out[line.type as string] = line;
	}
	return out;
}

// attempt_before_effect: the planted probe runs inside dispatch and must already
// see its own attempt line, while the result line must not exist yet.
test("attempt_before_effect", async () => {
	const state = freshState();
	let probeSawAttempt = false;
	let probeSawResult = false;
	registerCommandHandler("status", () => {
		const mine = spoolLines(state).filter((line) => (line.data as Record<string, unknown>).surface === "kit-status");
		probeSawAttempt = mine.some((line) => line.type === "action.attempt");
		probeSawResult = mine.some((line) => line.type === "action.result");
		return { code: 0 as const, data: { overall: "OK" }, verification: "PERFORMED" as const };
	});
	const savedOut = process.stdout.write.bind(process.stdout);
	const savedErr = process.stderr.write.bind(process.stderr);
	let captured = "";
	process.stdout.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	const savedState = process.env.CC_STATE, savedAgent = process.env.AGENT_NAME;
	process.env.CC_STATE = state;
	process.env.AGENT_NAME = "TestProbe";
	try {
		// The probe is registered for "status", so the contract-safe surface is kit-status;
		// the attempt-line check below keys on the attempt existing at probe time.
		const code = await runCli(["status", "--json"]);
		expect(code).toBe(0);
		const mine = spoolLines(state);
		expect(mine.filter((line) => line.type === "action.attempt").length).toBe(1);
		expect(mine.filter((line) => line.type === "action.result").length).toBe(1);
		expect(captured.length).toBeGreaterThan(0);
	} finally {
		process.stdout.write = savedOut;
		process.stderr.write = savedErr;
		if (savedState === undefined) delete process.env.CC_STATE; else process.env.CC_STATE = savedState;
		if (savedAgent === undefined) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = savedAgent;
	}
	expect(probeSawAttempt).toBe(true);
	expect(probeSawResult).toBe(false);
});

// result_outcome_mapping: ok/refused/failed/timeout table over the pure mapper.
test("result_outcome_mapping", () => {
	expect(ccActionOutcome(0)).toEqual({ outcome: "ok", code: null });
	expect(ccActionOutcome(0, [{ code: "ANYTHING" }])).toEqual({ outcome: "ok", code: null });
	expect(ccActionOutcome(2, [{ code: "CONSENT_REQUIRED" }])).toEqual({ outcome: "refused", code: "CONSENT_REQUIRED" });
	expect(ccActionOutcome(2, [{ code: "UNKNOWN_COMMAND" }])).toEqual({ outcome: "refused", code: "UNKNOWN_COMMAND" });
	expect(ccActionOutcome(2, [{ code: "ADMISSION_REFUSED" }])).toEqual({ outcome: "refused", code: "ADMISSION_REFUSED" });
	expect(ccActionOutcome(1, [{ code: "HANDLER_FAILED" }])).toEqual({ outcome: "failed", code: "HANDLER_FAILED" });
	expect(ccActionOutcome(1, [{ code: "REQUIRED_FINDING_FAILED" }])).toEqual({ outcome: "failed", code: "REQUIRED_FINDING_FAILED" });
	expect(ccActionOutcome(1)).toEqual({ outcome: "failed", code: "HANDLER_FAILED" });
	expect(ccActionOutcome(3, [{ code: "OMP_UNAVAILABLE" }])).toEqual({ outcome: "failed", code: "OMP_UNAVAILABLE" });
	expect(ccActionOutcome(2)).toEqual({ outcome: "failed", code: "HANDLER_FAILED" });
	expect(ccActionOutcome(124)).toEqual({ outcome: "timeout", code: "TIMEOUT" });
	expect(ccActionOutcome(75)).toEqual({ outcome: "timeout", code: "TIMEOUT" });
	expect(ccActionOutcome(1, [{ code: "READ_DEADLINE_EXCEEDED" }])).toEqual({ outcome: "timeout", code: "READ_DEADLINE_EXCEEDED" });
});

// ok_triple: a verb that exits 0 writes exactly attempt+result+tick with outcome ok.
test("ok_triple", async () => {
	const state = freshState();
	const run = await spawnCli(["capabilities", "--json"], { STATE: state });
	expect(run.exitCode).toBe(0);
	const lines = spoolLines(state);
	expect(lines.length).toBe(3);
	const types = lines.map((line) => line.type);
	expect(types).toEqual(["action.attempt", "action.result", "source.tick"]);
	const attempt = lines[0].data as Record<string, unknown>;
	expect(attempt.surface).toBe("kit-capabilities");
	expect(attempt.target).toBeNull();
	expect(attempt.idempotency_key).toBeNull();
	expect(typeof attempt.action_id).toBe("string");
	expect((attempt.action_id as string).length).toBe(32);
	const result = lines[1].data as Record<string, unknown>;
	expect(result).toMatchObject({ action_id: attempt.action_id, outcome: "ok", code: null });
	expect(typeof result.duration_ms).toBe("number");
	const tick = lines[2].data as Record<string, unknown>;
	expect(tick.records_seen).toBe(0);
	expect(tick.records_emitted).toBe(2);
	// ctx agent is emitted only for pattern-valid names; the spawn sets one.
	expect(lines[0].agent).toBe("TestCliActions");
	expect(lines[1].agent).toBe("TestCliActions");
});

// heavy_bypass_emits: heavy returns before dispatch, so a dispatch-only wrapper
// would emit nothing here; the pair must still exist with contract-safe surface kit-heavy.
test("heavy_bypass_emits", async () => {
	const state = freshState();
	const run = await spawnCli(["heavy", "--no-wait", "--", "true"], { STATE: state });
	expect([0, 75]).toContain(run.exitCode);
	const lines = spoolLines(state);
	const attempts = lines.filter((line) => line.type === "action.attempt");
	const results = lines.filter((line) => line.type === "action.result");
	expect(attempts.length).toBe(1);
	expect(results.length).toBe(1);
	const attempt = attempts[0].data as Record<string, unknown>;
	const result = results[0].data as Record<string, unknown>;
	expect(attempt.surface).toBe("kit-heavy");
	expect(result.action_id).toBe(attempt.action_id);
	if (run.exitCode === 0) expect(result.outcome).toBe("ok");
	else expect(result.outcome).toBe("timeout");
	expect(lines.filter((line) => line.type === "source.tick").length).toBe(1);
	const triple = tripleFor(lines, attempt.action_id as string);
	expect(Object.keys(triple).sort()).toEqual(["action.attempt", "action.result", "source.tick"]);
}, 120_000);

// launchd_surface_from_env: OMP_KIT_JOB=NAME makes service run NAME its own surface.
test("launchd_surface_from_env", async () => {
	const state = freshState();
	const run = await spawnCli(["service", "run", "no-such-cc-job", "--json"], {
		STATE: state,
		OMP_KIT_JOB: "no-such-cc-job",
	});
	expect(run.exitCode).toBe(2);
	const lines = spoolLines(state);
	const attempt = (lines.find((line) => line.type === "action.attempt")!.data) as Record<string, unknown>;
	expect(attempt.surface).toBe("launchd-no-such-cc-job");
	const result = (lines.find((line) => line.type === "action.result")!.data) as Record<string, unknown>;
	expect(result).toMatchObject({ outcome: "refused", code: "UNKNOWN_JOB" });
});

// parse_error_surface: unknown verbs never reach dispatch.
test("parse_error_surface", async () => {
	const state = freshState();
	const run = await spawnCli(["nosuchverb", "--json"], { STATE: state });
	expect(run.exitCode).toBe(2);
	const lines = spoolLines(state);
	expect(lines.length).toBe(3);
	const attempt = lines[0].data as Record<string, unknown>;
	expect(attempt.surface).toBe("kit-parse_error");
	const result = lines[1].data as Record<string, unknown>;
	expect(result).toMatchObject({ outcome: "refused", code: "UNKNOWN_COMMAND" });
});

// target_never_free_text: a planted credential-shaped --message must not reach the spool.
test("target_never_free_text", async () => {
	const state = freshState();
	const token = `ghp_${"z".repeat(36)}`;
	const run = await spawnCli(["land", "--paths", "x", "--message", token, "--apply", "--json"], { STATE: state });
	expect(run.exitCode).toBe(2);
	const lines = spoolLines(state);
	const attempt = (lines.find((line) => line.type === "action.attempt")!.data) as Record<string, unknown>;
	expect(attempt.target).toBeNull();
	const result = (lines.find((line) => line.type === "action.result")!.data) as Record<string, unknown>;
	expect(result).toMatchObject({ outcome: "refused", code: "CONSENT_REQUIRED" });
	const day = new Date().toISOString().slice(0, 10);
	const body = readFileSync(join(state, "spool", "kit", `${day}.jsonl`), "utf8");
	expect(body.includes(token)).toBe(false);
});

// target is the canonical realpath of --repo/--project, never the raw flag text.
test("target_realpath", () => {
	const real = realpathSync(scratchRoot);
	expect(ccActionTarget(new Map([["--project", scratchRoot + "/."]]))).toBe(real);
	expect(ccActionTarget(new Map([["--repo", join(scratchRoot, "does-not-exist")]]))).toBeNull();
	expect(ccActionTarget(new Map())).toBeNull();
});

// output_parity_with_and_without_spool: ten sampled verbs, identical bytes and exit.
test("output_parity_with_and_without_spool", async () => {
	const verbs: string[][] = [
		["status", "--json"],
		["capabilities", "--json"],
		["--help"],
		["--version"],
		["--info"],
		["help", "--json"],
		["examples", "--json"],
		["schema", "--json"],
		["quickstart", "--json"],
		["help", "status", "--json"],
	];
	expect(verbs.length).toBe(10);
	const state = freshState();
	for (const args of verbs) {
		const withSpool = await spawnCli(args, { STATE: state });
		const withoutSpool = await spawnCli(args, { STATE: state, OMP_KIT_CC: "0" });
		expect(withSpool.exitCode).toBe(withoutSpool.exitCode);
		expect(withSpool.stdout).toBe(withoutSpool.stdout);
		expect(withSpool.stderr).toBe(withoutSpool.stderr);
	}
}, 180_000);

// inert_without_state: with no fleet state dir the wrapper writes zero spool
test("inert_without_state", async () => {
	const missing = join(scratchRoot, "cli-actions-missing." + process.pid);
	try {
		const run = await spawnCli(["capabilities", "--json"], { STATE: missing });
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout).ok).toBe(true);
		expect(existsSync(join(missing, "spool"))).toBe(false);
	} finally {
		try { rmSync(missing, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}, 120_000);
