import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { addedFromHashline, check as durabilityCheck, gitDeadlineMs } from "../../src/fleet-guard/durability.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
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

test("GUARDGITLOAD1: quiet load keeps the 2 s git base; pinned-high load scales it", () => {
	const previous = process.env.OMP_KIT_LOAD_OVERRIDE;
	try {
		process.env.OMP_KIT_LOAD_OVERRIDE = "1/32";
		expect(gitDeadlineMs()).toBe(2000);
		process.env.OMP_KIT_LOAD_OVERRIDE = "128/32";
		expect(gitDeadlineMs()).toBe(8000);
		if (previous === undefined) delete process.env.OMP_KIT_LOAD_OVERRIDE;
		else process.env.OMP_KIT_LOAD_OVERRIDE = previous;
		const live = gitDeadlineMs();
		expect(live).toBeGreaterThanOrEqual(2000);
		expect(live).toBeLessThanOrEqual(8000);
	} finally {
		if (previous === undefined) delete process.env.OMP_KIT_LOAD_OVERRIDE;
		else process.env.OMP_KIT_LOAD_OVERRIDE = previous;
	}
});

test("GUARDGITLOAD1: slow first Git execution recovers without bypassing the canonical index", async () => {
	const fixture = ownedTmp("durability-git-first", { root: join(import.meta.dir, "../../var/agent-tmp") });
	const previousPath = process.env.PATH;
	const previousOverride = process.env.OMP_KIT_LOAD_OVERRIDE;
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
		// Pin the quiet-load 2 s base: the exact-two-attempts recovery below only holds
		// when the first 3 s-delayed read actually exceeds its bound, whatever the live host load is.
		process.env.OMP_KIT_LOAD_OVERRIDE = "1/32";
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
		// CFSCOPY1: the tracked-copy refusal names the isolated-checkout route; the hung-index refusal below does not.
		expect(denied?.reason).toContain("separate checkout of the repository (for example `ovnfs new --name <x>`");
		// The first-exec allowance must never extend a later read's deadline.
		writeFileSync(join(fixture.path, "hang-index"), "");
		const hungIndex = await durabilityCheck(event, context);
		expect(hungIndex).toMatchObject({ block: true, status: "UNKNOWN", read: "git ls-files --stage -z" });
		expect(hungIndex?.reason).toContain("killed=true");
		expect(hungIndex?.reason).not.toContain("separate checkout");
		expect(hungIndex?.reason).toContain("signal=SIGTERM");
		expect(hungIndex?.reason).toContain("code=null");
		expect(readFileSync(join(fixture.path, "index-attempts"), "utf8").trim().split("\n")).toEqual(["attempt"]);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousOverride === undefined) delete process.env.OMP_KIT_LOAD_OVERRIDE;
		else process.env.OMP_KIT_LOAD_OVERRIDE = previousOverride;
		fixture.cleanup();
	}
}, fixtureDeadlineS() * 1000);

async function failedGitRead(script: string, warmupExitCode?: number) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const shim = ownedTmp("durability-git-failure", { root: base });
	const previousPath = process.env.PATH;
	const previousOverride = process.env.OMP_KIT_LOAD_OVERRIDE;
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
		// Pin the quiet-load 2 s base so hang plants stay bounded by two 2 s attempts
		// whatever the live host load is; exit/stderr plants answer at once either way.
		process.env.OMP_KIT_LOAD_OVERRIDE = "1/32";
		const result = await durabilityCheck({
			toolName: "write",
			input: { path: join(shim.path, "var/agent-tmp/probe/PACKET.md"), content: "# dispatch packet" },
		}, { cwd: shim.path });
		return { result, attempts: readFileSync(attemptsPath, "utf8").split("\n").filter(Boolean) };
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousOverride === undefined) delete process.env.OMP_KIT_LOAD_OVERRIDE;
		else process.env.OMP_KIT_LOAD_OVERRIDE = previousOverride;
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

test("GUARDGITLOAD1: pinned-high load judges a read delayed past 2 s but inside the scaled bound", async () => {
	const fixture = ownedTmp("durability-git-scaled", { root: join(import.meta.dir, "../../var/agent-tmp") });
	const previousPath = process.env.PATH;
	const previousOverride = process.env.OMP_KIT_LOAD_OVERRIDE;
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
		// Warmed shim: every real Git invocation sleeps 3 s, past the quiet 2 s base but
		// inside the pinned-high 8 s bound. exec preserves the shim PID for the deadline.
		writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = "--probe-ready" ]; then exit 0; fi\nsleep 3\nexec '${nativeGit.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
		const ready = await runFixtureAsync([join(bin, "git"), "--probe-ready"], { cwd: fixture.path, env });
		expect(ready.rc, new TextDecoder().decode(ready.stderr)).toBe(0);
		const content = "fresh disposable specimen\n";
		writeFileSync(join(fixture.path, "specimen.txt"), content);
		const indexed = await runFixtureAsync([nativeGit, "-C", fixture.path, "add", "--", "specimen.txt"], { cwd: fixture.path, env });
		expect(indexed.rc, new TextDecoder().decode(indexed.stderr)).toBe(0);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		// 128/32 pins the shared factor to its 4x ceiling: one read gets 8 s, like land's am bound.
		process.env.OMP_KIT_LOAD_OVERRIDE = "128/32";
		expect(gitDeadlineMs()).toBe(8000);
		const denied = await durabilityCheck({
			toolName: "write",
			input: { path: join(scratch, "specimen.txt"), content },
		}, { cwd: fixture.path });
		expect(denied?.block).toBe(true);
		expect(denied?.status).not.toBe("UNKNOWN");
		expect(denied?.reason).toContain("tracked-source-copy");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousOverride === undefined) delete process.env.OMP_KIT_LOAD_OVERRIDE;
		else process.env.OMP_KIT_LOAD_OVERRIDE = previousOverride;
		fixture.cleanup();
	}
}, fixtureDeadlineS(30) * 1000);

async function editPayloadFixture(label: string) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const repo = ownedTmp(label, { root: base }).path;
	roots.push(repo);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
	const git = async (args: string[], input?: string) => {
		const result = await runFixtureAsync(["git", "-C", repo, ...args],
			{ cwd: repo, env, ...(input === undefined ? {} : { stdin: input }) });
		if (result.rc !== 0) throw new Error(new TextDecoder().decode(result.stderr));
		return new TextDecoder().decode(result.stdout).trim();
	};
	await git(["init", "--quiet"]);
	const scratch = join(repo, "var", "agent-tmp", `payload.${process.pid}`);
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(scratch, ".owner"),
		`pid=${process.pid}\nlabel=payload\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	const index = async (path: string, content: string) => {
		const hash = await git(["hash-object", "-w", "--stdin"], content);
		await git(["update-index", "--add", "--cacheinfo", `100644,${hash},${path}`]);
	};
	return { repo, scratch, index, context: { cwd: repo } };
}

test("EDITPAYLOAD1: hashline sections parse to per-file added lines", () => {
	const patch = "*** Begin Patch\n[a.txt#0000]\nPUT 1.=1:\n+hello\n+world\n*** End Patch\n[b.txt#1234]\nREM\n*** End Patch";
	expect(addedFromHashline(patch, "/repo", ["/repo/a.txt"])).toBe("hello\nworld\n");
	// A section with no added rows (delete) and a non-patch text establish nothing.
	expect(addedFromHashline(patch, "/repo", ["/repo/b.txt"])).toBeUndefined();
	expect(addedFromHashline(patch, "/repo", ["/repo/missing.txt"])).toBeUndefined();
	expect(addedFromHashline("not a patch", "/repo", ["/repo/a.txt"])).toBeUndefined();
});

test("EDITPAYLOAD1: a hashline delete or move with no readable bytes is admitted with a one-line notice", async () => {
	const f = await editPayloadFixture("durability-editpayload");
	const abs = join(f.scratch, "notes.txt");
	writeFileSync(abs, "hello\n");
	// Runtime-selected like the guard itself: the owning OMP installation provides this module, so no static import can name it.
	const native = await import(pathToFileURL(join(resolveOmpIdentity().nativeRoot!, "native", "index.js")).href);
	const currentTag = new native.EditStore().recordSnapshotFile(abs);
	const notices: string[] = [];
	const context = { ...f.context, warn: (message: string) => { notices.push(message); } };
	const del = { toolName: "edit", input: { input: `*** Begin Patch\n[${abs}#${currentTag}]\nREM\n*** End Patch` } };
	expect(await durabilityCheck(del, context)).toBeUndefined();
	expect(notices).toHaveLength(1);
	expect(notices[0]).not.toContain("\n");
	const moved = join(f.scratch, "moved.txt");
	const mv = { toolName: "edit", input: { input: `*** Begin Patch\n[${abs}#${currentTag}]\nMV ${moved}\n*** End Patch` } };
	expect(await durabilityCheck(mv, context)).toBeUndefined();
	expect(notices).toHaveLength(2);
	expect(notices[1]).not.toContain("\n");
	// EDITREJECT1 still holds: a stale-tag patch writes nothing, so the guard stays silent
	// and the real tool reports its own re-read error.
	const stale = { toolName: "edit", input: `*** Begin Patch\n[${abs}#ABCD]\nPUT 1.=1:\n+stale\n*** End Patch` };
	expect(await durabilityCheck(stale, context)).toBeUndefined();
	expect(notices).toHaveLength(2);
	// The judgment never writes: the file on disk is untouched.
	expect(readFileSync(abs, "utf8")).toBe("hello\n");
}, fixtureDeadlineS() * 1000);

test("EDITPAYLOAD1: readable added lines are judged durable: disposable admitted, tracked source refused", async () => {
	const f = await editPayloadFixture("durability-editpayload-added");
	const abs = join(f.scratch, "notes.txt");
	writeFileSync(abs, "hello\n");
	// OMP patch-mode edits carry unified diffs: the guard judges their added lines.
	const diff = { toolName: "edit", input: { path: abs, edits: [{ op: "update", diff: "@@\n-hello\n+disposable line\n" }] } };
	expect(await durabilityCheck(diff, f.context)).toBeUndefined();
	await f.index("src/canonical.ts", "disposable line\n");
	expect((await durabilityCheck(diff, f.context))?.reason).toContain("tracked-source-copy content");
	// The current omp replace schema names its strings old_string/new_string.
	const replace = { toolName: "edit", input: { path: abs, old_string: "hello\n", new_string: "more disposable\n" } };
	expect(await durabilityCheck(replace, f.context)).toBeUndefined();
	await f.index("src/other.ts", "more disposable\n");
	expect((await durabilityCheck(replace, f.context))?.reason).toContain("tracked-source-copy content");
}, fixtureDeadlineS() * 1000);

test("EDITPAYLOAD1: a patch-mode rename into owned scratch is judged on the move source", async () => {
	const f = await editPayloadFixture("durability-editpayload-rename");
	const home = join(f.repo, "home-source.txt");
	writeFileSync(home, "canonical bytes\n");
	const rename = { toolName: "edit", input: { path: home, edits: [{ rename: join(f.scratch, "arrived.txt") }] } };
	expect(await durabilityCheck(rename, f.context)).toBeUndefined();
	await f.index("src/canonical.ts", "canonical bytes\n");
	expect((await durabilityCheck(rename, f.context))?.reason).toContain("tracked-source-copy");
}, fixtureDeadlineS() * 1000);

test("EDITPAYLOAD1: a moved-from scratch file is judged on its added lines", async () => {
	const f = await editPayloadFixture("durability-editpayload-movedfrom");
	const abs = join(f.scratch, "notes.txt");
	writeFileSync(abs, "hello\n");
	// Runtime-selected like the guard itself: the owning OMP installation provides this module, so no static import can name it.
	const native = await import(pathToFileURL(join(resolveOmpIdentity().nativeRoot!, "native", "index.js")).href);
	const currentTag = new native.EditStore().recordSnapshotFile(abs);
	const notices: string[] = [];
	const context = { ...f.context, warn: (message: string) => { notices.push(message); } };
	// PUT-then-MV: the engine moves the edited bytes to the destination, so the simulator
	// yields nothing for the source while its section still names the added lines.
	const move = { toolName: "edit", input: { input: `*** Begin Patch\n[${abs}#${currentTag}]\nPUT 1.=1:\n+disposable line\nMV renamed-outside.txt\n*** End Patch` } };
	expect(await durabilityCheck(move, context)).toBeUndefined();
	expect(notices).toHaveLength(0);
	await f.index("src/canonical.ts", "disposable line\n");
	expect((await durabilityCheck(move, context))?.reason).toContain("tracked-source-copy content");
}, fixtureDeadlineS() * 1000);
