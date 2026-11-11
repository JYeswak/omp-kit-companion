import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { sanitizedEnv } from "../../src/runtime.ts";
import { parseOwnerFile } from "../../src/scratch.ts";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";
import { createFlywheelHost, toolCall as guardCall, type Responder as GuardResponder } from "../fleet-guard/kit-flywheel-host";
import type { FlywheelToolCallResult } from "../../extensions/kit-flywheel-guard";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const fixtures: OwnedTmp[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureRoot(): string {
	const scope = ownedTmp("flywheel-guard-runtime", { root: join(REPO_ROOT, "var", "agent-tmp") });
	fixtures.push(scope);
	return scope.path;
}

type RequestLogRow = { body: { messages: Array<{ role: string; content?: unknown }> } };

function toolResults(log: string): string[] {
	return log.split("\n").filter(Boolean).flatMap(line => {
		const row: RequestLogRow = JSON.parse(line);
		return row.body.messages.filter(message => message.role === "tool")
			.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content) ?? "");
	});
}

async function waitForPort(path: string, child: { readonly exited: Promise<number> }): Promise<string> {
	const { promise: ready, resolve: publishPort } = Promise.withResolvers<{ kind: "ready"; port: string }>();
	const observe = () => {
		const port = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
		if (port) publishPort({ kind: "ready", port });
	};
	const exited = child.exited.then(code => ({ kind: "exit" as const, code }));
	// Directory notifications can be absent while the server is already listening.
	// Observe the durable port state; the child's unchanged deadline remains the bound.
	watchFile(path, { interval: 10, persistent: false }, observe);
	try {
		observe();
		const event = await Promise.race([ready, exited]);
		if (event.kind === "exit") throw new Error(`mock model exited before readiness (${event.code})`);
		return event.port;
	} finally {
		unwatchFile(path, observe);
	}
}
async function runCommand(command: string[], cwd: string, env: Record<string, string>, timeout: number) {
	const result = await kitlibRun(command, { cwd, env, deadline_s: timeout / 1000 });
	return { exitCode: result.rc, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
test("mock readiness refuses an exited child that never published a port", async () => {
	const scope = ownedTmp("mock-readiness-exit");
	try {
		const portPath = join(scope.path, "port");
		const result = kitlibRun([process.execPath, "-e", "process.exit(7)"], {
			cwd: scope.path, env: { BUN_BE_BUN: "1" }, deadline_s: 1,
			max_output_bytes: 4096, max_total_bytes: 8192,
		});
		await expect(waitForPort(portPath, { exited: result.then(value => value.rc ?? 1) }))
			.rejects.toThrow("mock model exited before readiness (7)");
		const completed = await result;
		expect({ rc: completed.rc, timed_out: completed.timed_out, killed: completed.killed, truncated: completed.truncated })
			.toEqual({ rc: 7, timed_out: false, killed: false, truncated: false });
		expect(existsSync(portPath)).toBe(false);
	} finally {
		scope.cleanup();
	}
});


test("the linked OMP plugin refuses an async timeout-zero command before it runs", async () => {
	const base = fixtureRoot();
	const project = join(base, "project");
	const identity = resolveOmpIdentity(process.env);
	const env = sanitizedEnv(identity, { PATH: process.env.PATH, OMP_KIT_CASE_CWD: project }, base);
	for (const directory of [project, env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
		env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.BUN_INSTALL]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const agentDir = join(env.HOME, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(agentDir, "config.yml"), [
		"bash:",
		"  enabled: true",
		"async:",
		"  enabled: true",
		"disabledProviders:",
		"  - ollama",
		'  - "llama.cpp"',
		"  - lm-studio",
		"",
	].join("\n"));

	const linked = await runCommand([identity.launcher, "plugin", "link", REPO_ROOT], project, env, 15_000);
	const linkOutput = `stdout:\n${linked.stdout}\nstderr:\n${linked.stderr}`;
	expect(linked.exitCode, linkOutput).toBe(0);

	const scenarioPath = join(base, "scenario.json");
	const logPath = join(base, "requests.jsonl");
	const portPath = join(base, "port");
	writeFileSync(scenarioPath, JSON.stringify({ turns: [
		{ tool: { name: "bash", args: { command: "printf unsafe > .ran_bgdeadline", async: true, timeout: 0 } } },
		{ tool: { name: "bash", args: { command: "printf bounded > .ran_bounded", timeout: 10 } } },
	] }));

	const mock = Bun.spawn([process.execPath, join(REPO_ROOT, "tests/live/mock-model.mjs")], {
		cwd: REPO_ROOT,
		env: {
			HOME: env.HOME, TMPDIR: env.TMPDIR, TMP: env.TMPDIR, TEMP: env.TMPDIR,
			SCEN: scenarioPath, LOG: logPath, PORTFILE: portPath, BUN_BE_BUN: "1",
		},
		stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 55_000,
	});
	const mockStderr = new Response(mock.stderr).text();
	try {
		const port = await waitForPort(portPath, mock);
		writeFileSync(join(agentDir, "models.yml"), [
			"providers:",
			"  mock:",
			`    baseUrl: http://127.0.0.1:${port}/v1`,
			"    apiKey: sk-mock",
			"    api: openai-completions",
			"    models:",
			"      - id: mock",
			"        name: mock",
			"        supportsTools: true",
			"        contextWindow: 128000",
			"        maxTokens: 4096",
			"",
		].join("\n"));

		const run = await runCommand([identity.launcher, "-p", "--no-session", "--model", "mock/mock",
			"--approval-mode", "yolo", "go"], project, env, 45_000);
		const output = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
		expect(run.exitCode, output).toBe(0);
		expect(existsSync(join(project, ".ran_bgdeadline")), output).toBe(false);
		expect(readFileSync(join(project, ".ran_bounded"), "utf8")).toBe("bounded");
		const refusal = toolResults(readFileSync(logPath, "utf8")).find(result => result.includes("FINITE_JOB_NO_DEADLINE"));
		expect(refusal !== undefined, output).toBe(true);
		expect(refusal, output).toContain("deadline");
		expect(refusal, output).toContain("owning OMP session");
		expect(refusal, output).toContain("job");
	} finally {
		if (mock.exitCode === null) mock.kill("SIGTERM");
		await mock.exited;
		await mockStderr;
	}
}, 75_000);

test("fixture creator lifetime binds the owned root: TERM after allocation removes it, manual residue survives", async () => {
	const base = fixtureRoot();
	const scopeRoot = join(REPO_ROOT, "var", "agent-tmp");
	const tmpApi = join(REPO_ROOT, "src/kitlib/tmp.ts");
	const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const fieldOf = (stdout: string, key: string) => {
		const m = new RegExp(key + " (\\S+)").exec(stdout);
		return m && m[1] ? m[1] : "";
	};

	// Positive: a real child suite runs the ACTUAL fixtureRoot wrapper and is TERM'd before teardown; the root must be gone.
	const subjectFile = join(REPO_ROOT, "tests/cli/kit-flywheel-guard-runtime.test.ts");
	const owned = await runCommand([process.execPath, "test", subjectFile, "-t", "lifetime subject"], base,
		{ ...childEnv, LIFETIME_SUBJECT: "1" }, 15_000);
	const ownedOut = `stdout:\n${owned.stdout}\nstderr:\n${owned.stderr}`;
	const ownedPath = fieldOf(owned.stdout, "ALLOCATED");
	expect(ownedPath.startsWith(scopeRoot + "/"), ownedOut).toBe(true);
	const ownedMarker = parseOwnerFile(fieldOf(owned.stdout, "OWNER").split(";").join("\n"));
	expect(ownedMarker !== null && ownedMarker.label === "flywheel-guard-runtime", ownedOut).toBe(true);
	expect(existsSync(ownedPath), ownedOut).toBe(false);

	// Negative (isolated da37 manual constructor): the same kill leaves the residue behind.
	const manualProgram = `const { mkdirSync, writeFileSync } = await import("node:fs");
const { join: joinPath } = await import("node:path");
const root = joinPath(${JSON.stringify(base)}, "manual-residue");
mkdirSync(root, { recursive: true, mode: 0o700 });
writeFileSync(joinPath(root, ".owner"), "pid=" + process.pid + "\\nlabel=manual-residue\\nrepo=" + ${JSON.stringify(base)} + "\\ncreated=" + new Date().toISOString() + "\\n", { mode: 0o600 });
console.log("ALLOCATED " + root);
await new Promise(() => {});`;
	const manual = await runCommand([process.execPath, "--no-install", "-e", manualProgram], base, childEnv, 10_000);
	const manualOut = `stdout:\n${manual.stdout}\nstderr:\n${manual.stderr}`;
	const manualPath = fieldOf(manual.stdout, "ALLOCATED");
	expect(manualPath, manualOut).toBe(join(base, "manual-residue"));
	expect(existsSync(manualPath), manualOut).toBe(true);
	// Residue retires with the parent-owned base at afterEach; the observed survival is the requirement failure.

	// Mutant control: a registry-disabled creator survives the same kill, so the positive depends on lifetime cleanup.
	const nocleanProgram = `const { ownedTmp } = await import(${JSON.stringify(tmpApi)});\nconst scope = ownedTmp("lifetime-noclean", { root: ${JSON.stringify(base)}, autoCleanup: false });
console.log("ALLOCATED " + scope.path);
await new Promise(() => {});`;
	const noclean = await runCommand([process.execPath, "--no-install", "-e", nocleanProgram], base, childEnv, 10_000);
	const nocleanOut = `stdout:\n${noclean.stdout}\nstderr:\n${noclean.stderr}`;
	const nocleanPath = fieldOf(noclean.stdout, "ALLOCATED");
	expect(nocleanPath.startsWith(base + "/"), nocleanOut).toBe(true);
	expect(existsSync(nocleanPath), nocleanOut).toBe(true);
}, 120_000);

test("lifetime subject: allocate owned fixture and hang until killed", async () => {
	if (process.env.LIFETIME_SUBJECT !== "1") return;
	const root = fixtureRoot();
	console.log("ALLOCATED " + root);
	console.log("OWNER " + readFileSync(join(root, ".owner"), "utf8").trim().split("\n").join(";"));
	await new Promise(() => {});
}, 120_000);

// --- GATEDEMOTE1 (ompkit-1ra0d.128): demoted codes proceed with a notice; dead codes are gone ---

type GuardRow = Record<string, unknown>;

function gatedemoteProject(root: string, name: string): string {
	const project = join(root, name);
	mkdirSync(project, { recursive: true });
	return project;
}

/** br show/dep answers plus a lint-clean env, shaped like br 0.7.4. */
function gatedemoteResponder(shows: Record<string, GuardRow>, edges: Record<string, GuardRow[]> = {}, mine?: GuardRow): GuardResponder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.command === "env") return { stdout: "", stderr: "", code: 0 };
		if (call.command === "omp-kit") {
			if (mine === undefined) return { stdout: "", stderr: "not stubbed", code: 127 };
			return { stdout: JSON.stringify(mine), stderr: "", code: 0 };
		}
		if (call.args[0] === "dep") return { stdout: JSON.stringify((edges[call.args[2] ?? ""] ?? []).map(edge => ({ issue_id: call.args[2] ?? "", depends_on_id: "kit-fix", ...edge }))), stderr: "", code: 0 };
		const id = call.args[1] ?? "";
		const row = shows[id];
		if (row === undefined) return { stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }), stderr: "", code: 3 };
		return { stdout: JSON.stringify([row]), stderr: "", code: 0 };
	};
}

test("GATEDEMOTE1: export-index writes still refuse; clones proceed with a one-line notice", async () => {
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-paths");
	mkdirSync(join(project, "var", "agent-tmp", "a.1"), { recursive: true });
	const h = await createFlywheelHost(root, { respond: () => ({ code: 1, stdout: "", stderr: "not stubbed" }) });
	const exported = await guardCall(h, project, "GIT_DIR=$X git read-tree HEAD");
	expect(exported?.block).toBe(true);
	expect(exported?.reason).toContain("EXPORT_INDEX_REFUSED");
	const cloned = await guardCall(h, project, "git clone /Users/x/repo var/agent-tmp/a.1/c");
	expect(cloned?.block).not.toBe(true);
	expect(cloned?.additionalContext).toContain("CLONE_NOTICE");
	expect(h.notices.some(message => message.includes("CLONE_NOTICE"))).toBe(true);
});

test("GATEDEMOTE1: a notice never skips a kept refusal in a compound command", async () => {
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-compound");
	mkdirSync(join(project, "var", "agent-tmp", "a.1"), { recursive: true });
	const closeHost = await createFlywheelHost(root, { env: { BR_ACTOR: "Holder" }, respond: gatedemoteResponder(
		{ "k-9": { id: "k-9", title: "t", status: "in_progress", assignee: "Holder" } }) });
	const selfClose = await guardCall(closeHost, project, "git clone /Users/x/repo var/agent-tmp/a.1/c && br close k-9 --reason done");
	expect(selfClose?.block).toBe(true);
	expect(selfClose?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(selfClose?.additionalContext).toContain("CLONE_NOTICE");
	const claimHost = await createFlywheelHost(root, { respond: gatedemoteResponder(
		{ "k-3": { id: "k-3", title: "t", status: "in_progress", assignee: "Ghost" } }) });
	const peerClaim = await guardCall(claimHost, project, "git clone /Users/x/repo var/agent-tmp/a.1/c && br --actor Holder update k-3 --claim");
	expect(peerClaim?.block).toBe(true);
	expect(peerClaim?.reason).toContain("CLAIM_REFUSED");
	expect(peerClaim?.additionalContext).toContain("CLONE_NOTICE");
});

test("GATEDEMOTE1: blocked-without-fix and orphaned-dependent share one BLOCK_NOTICE and proceed", async () => {
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-block");
	const blocked = await createFlywheelHost(root, { respond: gatedemoteResponder(
		{ "kit-9": { id: "kit-9", status: "open", assignee: "BlueFox", labels: [], comments: [] } }, {}) });
	const noEdge = await guardCall(blocked, project, "br --actor BlueFox update kit-9 --status blocked");
	expect(noEdge?.block).not.toBe(true);
	expect(noEdge?.additionalContext).toContain("BLOCK_NOTICE");
	expect(noEdge?.additionalContext).toContain("kit-9 has no open blocks edge to a fix");
	expect(noEdge?.reason ?? "").not.toContain("BLOCK_REFUSED");
	const stranding = await createFlywheelHost(root, { respond: gatedemoteResponder(
		{ "kit-x": { id: "kit-x", status: "in_progress", assignee: null, dependents: [{ id: "kit-d1", status: "blocked", dependency_type: "blocks" }] } },
		{ "kit-d1": [{ depends_on_id: "kit-x", status: "open" }] }) });
	const orphan = await guardCall(stranding, project, "br close kit-x --reason done");
	expect(orphan?.block).not.toBe(true);
	expect(orphan?.additionalContext).toContain("BLOCK_NOTICE");
	expect(orphan?.additionalContext).toContain("kit-d1");
	expect(orphan?.reason ?? "").not.toContain("BLOCK_RELEASE_REQUIRED");
});

test("GATEDEMOTE1: holder-shaped release and scratch findings proceed with a notice; narrow evidence still refuses", async () => {
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-notices");
	const revision = "2026-10-19T19:00:00Z";
	const release = await createFlywheelHost(root, { env: { BR_ACTOR: "Holder" }, respond: gatedemoteResponder(
		{ "k-1": { id: "k-1", title: "t", status: "in_progress", assignee: "Holder", updated_at: revision } }) });
	const parked = await guardCall(release, project, "br update k-1 --status open");
	expect(parked?.block).not.toBe(true);
	expect(parked?.additionalContext).toContain("RELEASE_NOTICE");
	const narrow = await createFlywheelHost(root, { respond: gatedemoteResponder(
		{ "kit-narrow": { id: "kit-narrow", title: "t", status: "in_progress", assignee: "Builder", created_by: "Filer", comments: [] } }) });
	const incomplete = await guardCall(narrow, project, "br --actor Verifier close kit-narrow --reason \"box 2 UNVERIFIED\"");
	expect(incomplete?.block).toBe(true);
	expect(incomplete?.reason).toContain("NARROW_CLOSE_REFUSED");
	const scratch = await createFlywheelHost(root, { env: { AGENT_NAME: "BlueFox" }, respond: gatedemoteResponder({},
		{}, { ok: true, data: { overall: "FINDINGS", unreleased: 1, dirs: [{ label: "seat", dir: "/r/var/agent-tmp/owed.1", state: "unreleased", bin: "unbinned" }] } }) });
	const owed = await guardCall(scratch, project, "br update kit-9 --status in_review --actor BlueFox");
	expect(owed?.block).not.toBe(true);
	expect(owed?.additionalContext).toContain("SCRATCH_DISPOSAL_NOTICE");
	for (const result of [parked, owed]) expect(result?.reason ?? "").not.toContain("REFUSED");
});

test("GATEDEMOTE1: a failed brief lookup proceeds with LOOKUP_NOTICE instead of refusing the spawn", async () => {
	const root = fixtureRoot();
	const repo = gatedemoteProject(root, "gatedemote-brief");
	const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const git = async (args: string[]) => {
		const result = await runFixtureAsync(["git", ...args], { cwd: repo, env: gitEnv });
		return { code: result.rc ?? 1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
	};
	expect((await git(["init", "-q", "--template="])).code).toBe(0);
	const hooks = join(repo, ".git", "hooks", "hooks.d", "pre-commit");
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const execute: GuardResponder = async call => {
		if (call.command === "git" && call.args[0] === "log") throw new Error("planted marker-log failure");
		const result = await runFixtureAsync([call.command, ...call.args], { cwd: call.options?.cwd ?? repo, env: gitEnv });
		return { code: result.rc ?? 1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
	};
	const h = await createFlywheelHost(root, { respond: execute });
	const input = { context: `Repo: ${repo}`, tasks: [{ task: "# Target\nThese paths are reserved for you: src/x.ts.\n# Change\nFix the bug." }] };
	const [verdict] = await h.emit("tool_call", { toolCallId: "gatedemote-brief", toolName: "task", input }, h.ctx(repo));
	const result = verdict as FlywheelToolCallResult | undefined;
	expect(result?.block).not.toBe(true);
	expect(result?.additionalContext).toContain("LOOKUP_NOTICE");
	expect(h.notices.some(message => message.includes("LOOKUP_NOTICE"))).toBe(true);
});

test("GATEDEMOTE1: deleted refusal codes are gone from the guard; typed /goal lines still refuse", async () => {
	const guardSource = readFileSync(join(REPO_ROOT, "extensions", "kit-flywheel-guard.ts"), "utf8");
	for (const code of ["NO_WAIT_REFUSED", "ASKBLOCK1", "ASKDEFAULT1", "PRIOR_ART_GRANDFATHERED"]) {
		expect(guardSource, code).not.toContain(code);
	}
	expect(guardSource).toContain("GOAL_SEND_REFUSED");
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-goal");
	const h = await createFlywheelHost(root, { env: { AGENT_NAME: "RusticPine" } });
	for (const command of ["tern send 5 paste '/goal set x'", "ntm send fleet --pane 2 '/goal x'"]) {
		const refused = await guardCall(h, project, command);
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("GOAL_SEND_REFUSED");
	}
});

test("GATEDEMOTE1-kept: a self-close by the assignee still refuses", async () => {
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-kept-close");
	const h = await createFlywheelHost(root, { env: { BR_ACTOR: "Holder" }, respond: gatedemoteResponder(
		{ "k-9": { id: "k-9", title: "t", status: "in_progress", assignee: "Holder" } }) });
	const refused = await guardCall(h, project, "br close k-9 --reason done");
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("SELF_CLOSE_REFUSED");
});

test("GATEDEMOTE1-kept: a claim of a peer-held bead still refuses", async () => {
	const root = fixtureRoot();
	const project = gatedemoteProject(root, "gatedemote-kept-claim");
	const h = await createFlywheelHost(root, { respond: gatedemoteResponder(
		{ "k-3": { id: "k-3", title: "t", status: "in_progress", assignee: "Ghost" } }) });
	const refused = await guardCall(h, project, "br --actor Holder update k-3 --claim");
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("CLAIM_REFUSED");
	expect(refused?.reason).toContain("Ghost retains k-3");
});
