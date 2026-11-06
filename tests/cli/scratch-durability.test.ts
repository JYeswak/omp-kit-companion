import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { check as durabilityCheck } from "../../src/fleet-guard/durability.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
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

test("GUARDGITLOAD1: slow first Git execution recovers without bypassing the canonical index", async () => {
	const fixture = ownedTmp("durability-git-first", { root: join(import.meta.dir, "../../var/agent-tmp") });
	const previousPath = process.env.PATH;
	try {
		const nativeGit = Bun.which("git");
		if (!nativeGit) throw new Error("Git is required");
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
		const initialized = await runFixtureAsync([nativeGit, "init", "--quiet", fixture.path], { cwd: fixture.path, env });
		expect(initialized.rc, new TextDecoder().decode(initialized.stderr)).toBe(0);
		const scratch = join(fixture.path, "var/agent-tmp/probe");
		const bin = join(fixture.path, "bin");
		mkdirSync(scratch, { recursive: true });
		mkdirSync(bin);
		writeFileSync(join(scratch, ".owner"),
			`pid=${process.pid}\nlabel=probe\nrepo=${fixture.path}\ncreated=${new Date().toISOString()}\n`);
		// exec preserves the shim PID: the deadline kills Python itself, never an orphaned sleep child.
		writeFileSync(join(bin, "git"), `#!/bin/sh\nexec python3 -c '
import os, pathlib, sys, time
if "--probe-ready" in sys.argv:
    sys.exit(0)
marker = pathlib.Path(sys.argv[sys.argv.index("-C") + 1]) / "first-exec"
if "--show-toplevel" in sys.argv:
    with (marker.parent / "root-attempts").open("a") as log:
        log.write("attempt\\n")
if not marker.exists():
    marker.touch()
    time.sleep(3)
if "ls-files" in sys.argv and (marker.parent / "hang-index").exists():
    with (marker.parent / "index-attempts").open("a") as log:
        log.write("attempt\\n")
    time.sleep(60)
os.execv(sys.argv[1], sys.argv[1:])
' '${nativeGit.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
		// Isolate the intentional first-read delay from macOS assessing the newly written fixture itself.
		// Readiness does not touch the first-exec marker: the first real Git invocation still sleeps 3 s.
		const ready = await runFixtureAsync([join(bin, "git"), "--probe-ready"], { cwd: fixture.path, env });
		expect(ready.rc, new TextDecoder().decode(ready.stderr)).toBe(0);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		const context = { cwd: fixture.path };
		const content = "fresh disposable specimen\n";
		const event = { toolName: "write", input: { path: join(scratch, "specimen.txt"), content } };
		expect(await durabilityCheck(event, context)).toBeUndefined();
		expect(readFileSync(join(fixture.path, "root-attempts"), "utf8").trim().split("\n")).toEqual(["attempt", "attempt"]);
		// A recovered read is not permission to skip later Git facts.
		writeFileSync(join(fixture.path, "specimen.txt"), content);
		const indexed = await runFixtureAsync([nativeGit, "-C", fixture.path, "add", "--", "specimen.txt"], { cwd: fixture.path, env });
		expect(indexed.rc, new TextDecoder().decode(indexed.stderr)).toBe(0);
		const denied = await durabilityCheck(event, context);
		expect(denied?.block).toBe(true);
		expect(denied?.status).not.toBe("UNKNOWN");
		expect(denied?.reason).toContain("tracked-source-copy");
		// The first-exec allowance must never extend a later read's deadline.
		writeFileSync(join(fixture.path, "hang-index"), "");
		const hungIndex = await durabilityCheck(event, context);
		expect(hungIndex).toMatchObject({ block: true, status: "UNKNOWN", read: "git ls-files --stage -z" });
		expect(hungIndex?.reason).toContain("killed=true");
		expect(hungIndex?.reason).toContain("signal=SIGTERM");
		expect(hungIndex?.reason).toContain("code=null");
		expect(readFileSync(join(fixture.path, "index-attempts"), "utf8").trim().split("\n")).toEqual(["attempt"]);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fixture.cleanup();
	}
}, fixtureDeadlineS() * 1000);

async function failedGitRead(script: string, warmupExitCode?: number) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const shim = ownedTmp("durability-git-failure", { root: base });
	const previousPath = process.env.PATH;
	try {
		const attemptsPath = join(shim.path, "attempts");
		writeFileSync(attemptsPath, "");
		writeFileSync(join(shim.path, "git"),
			`#!/bin/sh\nprintf 'attempt\\n' >> '${attemptsPath.replaceAll("'", "'\\''")}'\n${script}\n`, { mode: 0o755 });
		if (warmupExitCode !== undefined) {
			// GUARDDIAG1: first execution of a fresh script can exhaust the product's two-second deadline.
			// Warm only the exit/stderr plants under a fixture bound; the kill plant stays unprimed.
			const warmup = await runFixtureAsync([join(shim.path, "git")], { cwd: shim.path });
			expect(warmup.rc, new TextDecoder().decode(warmup.stderr)).toBe(warmupExitCode);
			writeFileSync(attemptsPath, "");
		}
		process.env.PATH = `${shim.path}:${previousPath ?? ""}`;
		const result = await durabilityCheck({
			toolName: "write",
			input: { path: join(shim.path, "var/agent-tmp/probe/PACKET.md"), content: "# dispatch packet" },
		}, { cwd: shim.path });
		return { result, attempts: readFileSync(attemptsPath, "utf8").split("\n").filter(Boolean) };
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		shim.cleanup();
	}
}

test("GUARDGITLOAD1: failed Git read stays UNKNOWN and reports exit code and first stderr line", async () => {
	const { result, attempts } = await failedGitRead("printf '%s\\n' 'fatal: planted not a git repository' 'second line is not reported' >&2\nexit 128", 128);
	expect(attempts).toEqual(["attempt"]);
	expect(result).toMatchObject({ block: true, status: "UNKNOWN", read: "git rev-parse --show-toplevel" });
	expect(result?.reason).toContain("killed=false");
	expect(result?.reason).toContain("signal=null");
	expect(result?.reason).toContain("code=128");
	expect(result?.reason).toContain('stderr="fatal: planted not a git repository"');
	expect(result?.reason).not.toContain("second line is not reported");
	expect(result?.reason).not.toContain("Command failed: git");
}, fixtureDeadlineS() * 1000);

test("GUARDGITLOAD1: persistently hanging Git stays UNKNOWN with at most one first-exec retry", async () => {
	// exec leaves one process per attempt for the two-second deadline to kill and reap.
	const { result, attempts } = await failedGitRead("exec sleep 60");
	// Under load an attempt can time out before the shim records its start.
	expect(attempts.length).toBeLessThanOrEqual(2);
	expect(result).toMatchObject({ block: true, status: "UNKNOWN", read: "git rev-parse --show-toplevel" });
	expect(result?.reason).toContain("killed=true");
	expect(result?.reason).toContain("signal=SIGTERM");
	expect(result?.reason).toContain("code=null");
}, fixtureDeadlineS() * 1000);

test("GUARDGITLOAD1: a long Git stderr first line is bounded without hiding the failure fields", async () => {
	const line = `fatal: ${"x".repeat(2_000)}`;
	const { result, attempts } = await failedGitRead(`printf '%s\\n' '${line}' >&2\nexit 128`, 128);
	expect(attempts).toEqual(["attempt"]);
	expect(result).toMatchObject({ block: true, status: "UNKNOWN", read: "git rev-parse --show-toplevel" });
	expect(result?.reason).toContain("code=128");
	expect(result?.reason).toContain('stderr="fatal: ');
	expect(result?.reason).not.toContain(line);
	expect(result?.reason.length).toBeLessThan(700);
}, fixtureDeadlineS() * 1000);
