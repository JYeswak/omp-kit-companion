import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { mintNativeSpawn, nativeReservationIdentity, type NativeContext } from "../../extensions/native-identity.ts";
import kitAgentMailGuard from "../../extensions/kit-agent-mail-guard.ts";
import { checkNativeClose } from "../../src/native-close.ts";
import { type NativeExec } from "../../extensions/native-identity.ts";
import { runFixtureAsync } from "./fixture-process.ts";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";

// Contract harness: host contexts and Agent Mail responses are fixtures, not live server proof.
const scratch = ownedTmp("native-reservation-test");
const base = realpathSync(scratch.path);
const repo = join(base, "repo");
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

test("native close refuses claimed builders and parent seats but admits verifier export work", async () => {
	mkdirSync(repo);
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: base };
	const exec: NativeExec = async (command, args, options) => {
		const result = await runFixtureAsync([command, ...args], { cwd: options?.cwd ?? repo, env });
		return { code: result.rc ?? -1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), killed: result.killed };
	};
	for (const args of [
		["init", "--quiet", "--template="],
		["config", "user.name", "Builder"],
		["config", "user.email", "builder@example.invalid"],
	]) expect((await exec("git", args)).code).toBe(0);
	writeFileSync(join(repo, "feature.ts"), "export const value = 1;\n");
	expect((await exec("git", ["add", "--", "feature.ts"])).code).toBe(0);
	expect((await exec("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "implementation\n\nBead: kit-native"])).code).toBe(0);
	const bead = { id: "kit-native", assignee: "Implementer", acceptance: null, comments: [] };
	const { child, parent } = contexts();
	await expect(checkNativeClose(child, bead, repo, null, exec)).resolves.toBeUndefined();
	await expect(checkNativeClose(child, { ...bead, assignee: child.agent!.id! }, repo, null, exec)).rejects.toThrow("NATIVE_SELF_REFUSED");
	await expect(checkNativeClose(parent, { ...bead, assignee: "Main" }, repo, null, exec)).rejects.toThrow("NATIVE_IDENTITY_UNBOUND");
	await expect(checkNativeClose(child, { ...bead, comments: [{ author: child.agent!.id!, text: "DONE implementation" }] }, repo, null, exec)).rejects.toThrow("NATIVE_SELF_REFUSED");
	const exported = join(base, "export");
	mkdirSync(exported);
	expect((await exec("git", ["init", "--quiet", "--template="], { cwd: exported })).code).toBe(0);
	const exportedChild = { ...child, cwd: exported };
	writeFileSync(join(exported, "mutant.ts"), "export const mutant = true;\n");
	expect((await exec("git", ["status", "--short"], { cwd: exported })).code).toBe(0);
	expect((await exec("bun", ["-e", "if (1 + 1 !== 2) throw new Error('failed')"], { cwd: exported })).code).toBe(0);
	await expect(checkNativeClose(exportedChild, bead, repo, null, exec)).resolves.toBeUndefined();
});

