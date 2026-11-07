import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";
import { mintNativeSpawn, nativeIdentity, nativeReservationIdentity, observeNativeWrite, type NativeContext, type NativeExec } from "../../extensions/native-identity.ts";
import { checkNativeClose, nativeAcDigest, recordNativePregrade, registerNativePregradeTool, type NativePregradeInput } from "../../src/native-pregrade.ts";
import kitAgentMailGuard from "../../extensions/kit-agent-mail-guard.ts";

// Contract harness, NOT live child/server evidence: host contexts and tracker rows are fixtures;
// git history and the unchanged Python in_review admission are real. Live acceptance belongs to the lead.
const scratch = ownedTmp("native-pregrade-test");
const base = scratch.path;
const repo = join(base, "repo");
const state = join(base, "state");
const acceptance = "- [x] [a] [build] control plus planted negative `bun test test.ts` -> 0 fail";
const env = { ...process.env, HOME: base, XDG_STATE_HOME: state, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: base };
let sha: string;
const git = async (...args: string[]) => {
	const result = await runFixtureAsync(["git", ...args], { cwd: repo, env });
	if (result.rc !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
};
beforeAll(async () => {
	mkdirSync(repo);
	await git("init", "--quiet", "--template=");
	await git("config", "user.name", "Builder");
	await git("config", "user.email", "builder@example.invalid");
	writeFileSync(join(repo, "feature.ts"), "export const value = 1;\n");
	await git("add", "--", "feature.ts");
	await git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture implementation\n\nBead: kit-native");
	sha = await git("rev-parse", "HEAD");
});
afterAll(() => scratch.cleanup());

function contexts(id = `Verifier-${randomUUID()}`) {
	const parentSession = randomUUID();
	const parentFile = join(base, `${parentSession}.jsonl`);
	const parent: NativeContext = { cwd: repo, agent: { kind: "main", id: "Main" }, sessionManager: { getSessionId: () => parentSession, getSessionFile: () => parentFile } };
	const childSession = randomUUID();
	const child: NativeContext = { cwd: repo, agent: { kind: "sub", id, parentId: "Main" }, sessionManager: { getSessionId: () => childSession, getSessionFile: () => join(parentFile.slice(0, -6), `${id}.jsonl`) } };
	mintNativeSpawn({ spawnKey: id }, parent);
	return { parent, child };
}
function tracker() {
	const bead = { id: "kit-native", assignee: "Builder", status: "in_progress", created_at: "2026-11-01T00:00:00Z", acceptance_criteria: acceptance, comments: [] as { author: string; text: string }[] };
	const exec: NativeExec = async (command, args, options) => {
		if (command === "br") {
			if (args[0] === "comments") bead.comments.push({ author: args[4]!, text: args[6]! });
			return { code: 0, stdout: JSON.stringify([bead]), stderr: "" };
		}
		const result = await runFixtureAsync([command, ...args], { cwd: options?.cwd ?? repo, env });
		return { code: result.rc ?? -1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), killed: result.killed };
	};
	return { bead, exec };
}
function input(): NativePregradeInput { return { bead: "kit-native", repo, export_sha: sha, ac_sha256: nativeAcDigest(acceptance), evidence: "[a] PASS control and planted negative, 2 pass 0 fail; mutant killed" }; }

test("native non-author PASS writes unchanged schema and admits in_review through real ac_phase", async () => {
	const { child } = contexts();
	const { bead, exec } = tracker();
	const result = await recordNativePregrade(child, input(), exec, env);
	expect(result.record).toMatchObject({ schema: "omp-kit.pregrade.v1", grader: child.agent!.id, author: "Builder", candidate_commit: sha, verdict: "PASS" });
	expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.record);
	mkdirSync(join(repo, ".omp"));
	writeFileSync(join(repo, ".omp", "pregrade.json"), '{"required":true}');
	const admission = await runFixtureAsync(["python3", "-c", "import json,sys; from ac_phase import in_review_admission; b=json.loads(sys.stdin.read(65537)); print(json.dumps(in_review_admission(b,repo=sys.argv[1])))", repo], { cwd: resolve(import.meta.dir, "../../scripts"), env, stdin: JSON.stringify(bead) });
	expect(admission.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(admission.stdout)).refusals).toEqual([]);
});

test("planted author child and a lead seat cannot produce independent pregrades", async () => {
	const { child, parent } = contexts("Builder");
	const { exec } = tracker();
	await expect(recordNativePregrade(child, input(), exec, env)).rejects.toThrow("NATIVE_SELF_REFUSED");
	await expect(recordNativePregrade(parent, input(), exec, env)).rejects.toThrow("NATIVE_IDENTITY_UNBOUND");
});

test("planted commit author is refused even when a different implementer is assigned", async () => {
	const { child } = contexts("Builder");
	const { bead, exec } = tracker();
	bead.assignee = "AnotherBuilder";
	await expect(recordNativePregrade(child, input(), exec, env)).rejects.toThrow("NATIVE_SELF_REFUSED");
});

test("planted absent/abbreviated export and stale AC digest are refused", async () => {
	const { child } = contexts();
	const { exec } = tracker();
	for (const export_sha of ["", sha.slice(0, 12), "f".repeat(40)]) await expect(recordNativePregrade(child, { ...input(), export_sha }, exec, env)).rejects.toThrow();
	await expect(recordNativePregrade(child, { ...input(), ac_sha256: "stale" }, exec, env)).rejects.toThrow("PREGRADE_AC_CHANGED");
});

test("a parent-written fake identity file cannot mint a native child", async () => {
	const { child, parent } = contexts();
	const fake = join(base, "forged-identity.json");
	writeFileSync(fake, JSON.stringify({ ...nativeIdentity(child), kind: "sub" }));
	const forged = { ...parent, sessionManager: { getSessionId: () => child.sessionManager!.getSessionId!(), getSessionFile: () => fake } };
	expect(nativeIdentity(forged)).toBeNull();
	expect(nativeIdentity({ ...child, agent: { kind: "sub", id: "Unminted", parentId: "Main" } })).toBeNull();
	await expect(recordNativePregrade(forged, input(), tracker().exec, env)).rejects.toThrow("NATIVE_IDENTITY_UNBOUND");
});

test("own-session implementation writes cannot become independent by renaming or lead commits", async () => {
	const { child } = contexts();
	const { exec } = tracker();
	await observeNativeWrite({ toolName: "edit", input: { patch: "*** Begin Patch\n[feature.ts#ABCD]\nPUT 1.=1:\n+changed\n*** End Patch" } }, child, exec);
	await expect(recordNativePregrade(child, input(), exec, env)).rejects.toThrow("NATIVE_SELF_REFUSED");
	const renamed = { ...child, agent: { ...child.agent!, id: "RenamedVerifier" } };
	expect(nativeIdentity(renamed)).toBeNull();
	await expect(recordNativePregrade(renamed, input(), exec, env)).rejects.toThrow("NATIVE_IDENTITY_UNBOUND");
});

test("a changed acceptance during the authorship read never writes PASS", async () => {
	const { child } = contexts();
	const { bead, exec } = tracker();
	let shows = 0;
	const racing: NativeExec = async (command, args, opts) => {
		if (command === "br" && args[0] === "show" && ++shows === 2) bead.acceptance_criteria += " changed";
		return exec(command, args, opts);
	};
	await expect(recordNativePregrade(child, input(), racing, env)).rejects.toThrow("PREGRADE_AC_CHANGED");
	expect(bead.comments).toHaveLength(0);
});

test("AGENTCLOSE1 native non-author closes only on its current authenticated verdict", async () => {
	const { child } = contexts();
	const { bead, exec } = tracker();
	await recordNativePregrade(child, input(), exec, env);
	await expect(checkNativeClose(child, { ...bead, acceptance }, repo, `PASS export ${sha}`, exec)).resolves.toBeUndefined();
	await expect(checkNativeClose(child, { ...bead, acceptance }, repo, "PASS without exact export", exec)).rejects.toThrow("NATIVE_VERDICT_REQUIRED");
	const another = contexts().child;
	await expect(checkNativeClose(another, { ...bead, acceptance }, repo, `PASS export ${sha}`, exec)).rejects.toThrow("NATIVE_VERDICT_REQUIRED");
});

test("AGENTCLOSE1 planted: a verifier that writes implementation after PASS cannot close", async () => {
	const { child } = contexts();
	const { bead, exec } = tracker();
	await recordNativePregrade(child, input(), exec, env);
	await observeNativeWrite({ toolName: "write", input: { path: "feature.ts" } }, child, exec);
	await expect(checkNativeClose(child, { ...bead, acceptance }, repo, `PASS export ${sha}`, exec)).rejects.toThrow("NATIVE_SELF_REFUSED");
});

test("reservations: different spawn-minted children retain distinct server names", () => {
	const one = contexts().child;
	const two = contexts().child;
	expect(nativeReservationIdentity(one, one.agent!.id)).not.toBe(nativeReservationIdentity(two, two.agent!.id));
	expect(() => nativeReservationIdentity(one, "PeachLeopard")).toThrow("AM_IDENTITY_MISMATCH");
	expect(() => nativeReservationIdentity(two, one.agent!.id)).toThrow("AM_IDENTITY_MISMATCH");
});

test("reservations guard: inherited-parent release and unregistered child holds are refused before server acts", async () => {
	const { child } = contexts();
	let handler: (event: unknown, ctx: NativeContext) => Promise<unknown>;
	await kitAgentMailGuard({
		on: ((event: string, fn: typeof handler) => { if (event === "tool_call") handler = fn; }) as never,
		exec: async () => ({ code: 0, stdout: JSON.stringify([]), stderr: "" }),
	}, { env: { AGENT_NAME: "PeachLeopard" }, home: base });
	const release = { toolName: "write", input: { path: "xd://mcp__mcp_agent_mail_release_file_reservations", content: JSON.stringify({ project_key: repo, agent_name: "PeachLeopard" }) } };
	const refused = await handler!(release, child) as { block?: boolean; reason?: string };
	expect(refused.block).toBe(true);
	expect(refused.reason).toContain("AM_IDENTITY_MISMATCH");
	const shellRelease = await handler!({ toolName: "bash", input: { command: 'am file_reservations release "$PWD" "$AGENT_NAME"' } }, child) as { block?: boolean; reason?: string };
	expect(shellRelease.block).toBe(true);
	expect(shellRelease.reason).toContain("AM_NATIVE_TOOL_REQUIRED");
	const ownHold = { toolName: "write", input: { path: "xd://mcp__mcp_agent_mail_file_reservation_paths", content: JSON.stringify({ project_key: repo, agent_name: child.agent!.id, paths: ["feature.ts"], exclusive: true }) } };
	const unregistered = await handler!(ownHold, child) as { block?: boolean; reason?: string };
	expect(unregistered.block).toBe(true);
	expect(unregistered.reason).toContain("not registered");
	expect(unregistered.reason).toContain("cannot substitute the parent's registration");
});

test("reservations guard: registered child names pass unchanged, never rewritten to parent", async () => {
	const one = contexts().child;
	const two = contexts().child;
	let handler: (event: unknown, ctx: NativeContext) => Promise<unknown>;
	await kitAgentMailGuard({
		on: ((event: string, fn: typeof handler) => { if (event === "tool_call") handler = fn; }) as never,
		exec: async () => ({ code: 0, stdout: JSON.stringify([one, two].map(ctx => ({ name: ctx.agent!.id, program: "omp", model: "fixture" }))), stderr: "" }),
	}, { env: { AGENT_NAME: "PeachLeopard" }, home: base });
	for (const ctx of [one, two]) {
		const event = { toolName: "write", input: { path: "xd://mcp__mcp_agent_mail_file_reservation_paths", content: JSON.stringify({ project_key: repo, agent_name: ctx.agent!.id, paths: ["feature.ts"], exclusive: true }) } };
		expect(await handler!(event, ctx)).toBeUndefined();
		expect(JSON.parse(event.input.content).agent_name).toBe(ctx.agent!.id);
	}
});

test("AC digest keeps ticks but not contract changes invariant", () => {
	expect(nativeAcDigest(acceptance)).toBe(nativeAcDigest(acceptance.replace("[x]", "[ ]")));
	expect(nativeAcDigest(acceptance)).not.toBe(nativeAcDigest(`${acceptance}\nchanged`));
	expect(() => nativeAcDigest(" ".repeat(65_537))).toThrow("NATIVE_AC_UNREADABLE");
});

test("native kit command takes identity from host context, never caller parameters", async () => {
	const { child, parent } = contexts();
	const { exec } = tracker();
	let execute: (id: string, input: NativePregradeInput, signal: undefined, update: undefined, ctx: NativeContext) => Promise<unknown>;
	const stringSchema = { describe() { return this; }, optional() { return this; } };
	registerNativePregradeTool({
		zod: { string: () => stringSchema, object: (shape: unknown) => shape },
		registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; },
	} as never, exec, env);
	const result = await execute!("record-native", input(), undefined, undefined, child) as { details: { record: { grader: string } } };
	expect(result.details.record.grader).toBe(child.agent!.id);
	await expect(execute!("forged-parent", { ...input(), ...{ actor: child.agent!.id, principal: nativeIdentity(child)!.principal } }, undefined, undefined, parent)).rejects.toThrow("NATIVE_IDENTITY_UNBOUND");
});

test("ownership follows absolute writes from a repo-less parent cwd without blocking ordinary editing", async () => {
	const { child, parent } = contexts();
	const { exec } = tracker();
	await expect(observeNativeWrite({ toolName: "write", input: { path: join(base, "outside-repo.txt") } }, { ...parent, cwd: base }, exec)).resolves.toBeUndefined();
	const rootChild = { ...child, cwd: base };
	await observeNativeWrite({ toolName: "write", input: { path: join(repo, "feature.ts") } }, rootChild, exec);
	await expect(recordNativePregrade(rootChild, input(), exec, env)).rejects.toThrow("NATIVE_SELF_REFUSED");
});

test("pregrade binds a separate tracker to the implementation export and cannot authorize another tracker", async () => {
	const { child } = contexts();
	const { bead, exec } = tracker();
	await recordNativePregrade(child, { ...input(), tracker: base }, exec, env);
	await expect(checkNativeClose(child, { ...bead, acceptance }, base, `PASS export ${sha}`, exec)).resolves.toBeUndefined();
	await expect(checkNativeClose(child, { ...bead, acceptance }, repo, `PASS export ${sha}`, exec)).rejects.toThrow("NATIVE_VERDICT_REQUIRED");
});
