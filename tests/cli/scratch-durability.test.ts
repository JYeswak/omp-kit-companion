import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { check as durabilityCheck } from "../../src/fleet-guard/durability.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("identical owned-scratch input is quiet until its canonical source is actually tracked", async () => {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const repo = ownedTmp("scratch-durability", { root: base }).path;
	roots.push(repo);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	const git = (args: string[], input?: string) => Bun.spawnSync(["git", "-C", repo, ...args], {
		env, stdout: "pipe", stderr: "pipe",
		...(input === undefined ? {} : { stdin: Buffer.from(input) }),
	});
	const initialized = git(["init", "--quiet"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
	const scratch = join(repo, "var", "agent-tmp", `probe.${process.pid}`);
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(scratch, ".owner"),
		`pid=${process.pid}\nlabel=probe\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	const content = "export const specimen = 1;\n";
	const event = { toolName: "write", input: { path: join(scratch, "src", "specimen.ts"), content } };
	const context = {
		cwd: repo,
		isTrackedPath: (absolutePath: string) => git(["ls-files", "--error-unmatch", "--", absolutePath]).exitCode === 0,
	};
	expect(await handleToolCall(event, context)).toBeUndefined();
	const blob = git(["hash-object", "-w", "--stdin"], content);
	if (blob.exitCode !== 0) throw new Error(blob.stderr.toString());
	const indexed = git(["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.toString().trim()},src/specimen.ts`]);
	if (indexed.exitCode !== 0) throw new Error(indexed.stderr.toString());
	const denied = await handleToolCall(event, context);
	expect(denied?.block).toBe(true);
	expect(denied?.reason).toContain("scratch-is-not-a-home");
});

async function failedGitRead(script: string) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const shim = ownedTmp("durability-git-failure", { root: base });
	const previousPath = process.env.PATH;
	try {
		writeFileSync(join(shim.path, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		process.env.PATH = `${shim.path}:${previousPath ?? ""}`;
		return await durabilityCheck({
			toolName: "write",
			input: { path: join(shim.path, "var/agent-tmp/probe/PACKET.md"), content: "# dispatch packet" },
		}, { cwd: shim.path });
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		shim.cleanup();
	}
}

test("GUARDGITLOAD1: failed Git read stays UNKNOWN and reports exit code and first stderr line", async () => {
	const result = await failedGitRead("printf '%s\\n' 'fatal: planted not a git repository' 'second line is not reported' >&2\nexit 128");
	expect(result).toMatchObject({ block: true, status: "UNKNOWN", read: "git rev-parse --show-toplevel" });
	expect(result?.reason).toContain("killed=false");
	expect(result?.reason).toContain("signal=null");
	expect(result?.reason).toContain("code=128");
	expect(result?.reason).toContain('stderr="fatal: planted not a git repository"');
	expect(result?.reason).not.toContain("second line is not reported");
	expect(result?.reason).not.toContain("Command failed: git");
});

test("GUARDGITLOAD1: a Git read killed by the unchanged deadline stays UNKNOWN and names its signal", async () => {
	// exec leaves one process for the existing two-second deadline to kill and reap.
	const result = await failedGitRead("exec sleep 60");
	expect(result).toMatchObject({ block: true, status: "UNKNOWN", read: "git rev-parse --show-toplevel" });
	expect(result?.reason).toContain("killed=true");
	expect(result?.reason).toContain("signal=SIGTERM");
	expect(result?.reason).toContain("code=null");
}, fixtureDeadlineS() * 1000);

test("GUARDGITLOAD1: a long Git stderr first line is bounded without hiding the failure fields", async () => {
	const line = `fatal: ${"x".repeat(2_000)}`;
	const result = await failedGitRead(`printf '%s\\n' '${line}' >&2\nexit 128`);
	expect(result).toMatchObject({ block: true, status: "UNKNOWN", read: "git rev-parse --show-toplevel" });
	expect(result?.reason).toContain("code=128");
	expect(result?.reason).toContain('stderr="fatal: ');
	expect(result?.reason).not.toContain(line);
	expect(result?.reason.length).toBeLessThan(700);
});
