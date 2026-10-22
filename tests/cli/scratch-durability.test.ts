import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
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
