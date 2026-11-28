import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectHookInstallers, inspectHooks, liveHookFreshnessIo } from "../../src/hook-refresh.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const relativeHelper = "hooks.d/pre-commit/kitlib-tmp.sh";
const installer = join(root, "scripts/install-commit-msg-bead.sh");
const decode = new TextDecoder();

test("HOOKHELPERS1: an installed import check still refuses, with the actual installer command", async () => {
	const owned = ownedTmp("hook-helper-missing", { bead: "ompkit-namk5" });
	try {
		const repo = join(owned.path, "fixture repo");
		const release = join(owned.path, "installed release");
		const repair = join(release, "scripts/install-commit-msg-bead.sh");
		const marker = join(owned.path, "launcher-ran");
		const path = join(owned.path, "path");
		mkdirSync(join(release, "bin"), { recursive: true });
		mkdirSync(path);
		symlinkSync(join(root, "scripts"), join(release, "scripts"));
		symlinkSync(join(root, "src"), join(release, "src"));
		writeFileSync(join(release, "bin/omp-kit"), '#!/bin/sh\nprintf ran >"$HOOK_FIXTURE_MARKER"\nexit 97\n', { mode: 0o755 });
		symlinkSync(join(release, "bin/omp-kit"), join(path, "omp-kit"));
		const env = { HOME: owned.path, PATH: `${path}:${process.env.PATH ?? "/usr/bin:/bin"}`, TMPDIR: owned.path,
			GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOOK_FIXTURE_MARKER: marker };
		const options = { cwd: owned.path, env, deadline_s: fixtureDeadlineS(20) };
		const init = await run(["git", "init", "-q", "--template=", repo], options);
		expect(init.rc, decode.decode(init.stderr)).toBe(0);
		const commit = await run(["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
			"commit", "-q", "--allow-empty", "-m", "fixture import base"], options);
		expect(commit.rc, decode.decode(commit.stderr)).toBe(0);
		const head = await run(["git", "-C", repo, "rev-parse", "HEAD"], options);
		expect(head.rc).toBe(0);
		const sha = decode.decode(head.stdout).trim();
		const installed = await run(["sh", installer, repo], options);
		expect(installed.rc, decode.decode(installed.stderr)).toBe(0);
		const hooks = join(repo, ".git/hooks");
		const helper = join(hooks, relativeHelper);
		const before = readFileSync(helper);
		renameSync(helper, join(owned.path, "removed-helper"));
		const refused = await run(["sh", join(hooks, "hooks.d/pre-commit/check-commit-imports.sh"),
			"--repo", repo, "--base", sha, "--tip", sha], options);
		const message = decode.decode(refused.stderr);
		expect(refused.rc, message).toBe(2);
		expect(message).toContain("kitlib-tmp.sh missing beside");
		expect(message).toContain(`Run: sh '${repair}' '${repo}'`);
		const unavailable = await run(["sh", join(hooks, "hooks.d/pre-commit/check-commit-imports.sh"),
			"--repo", join(owned.path, "not-a-repository"), "--base", sha, "--tip", sha], options);
		expect(unavailable.rc).toBe(2);
		expect(decode.decode(unavailable.stderr)).not.toContain("Run: sh");
		expect(message).not.toContain("rerun scripts/install-commit-msg-bead.sh");
		expect(existsSync(helper)).toBe(false);
		expect(existsSync(marker)).toBe(false);
		const reinstalled = await run(["sh", repair, repo], options);
		expect(reinstalled.rc, decode.decode(reinstalled.stderr)).toBe(0);
		expect(readFileSync(helper)).toEqual(before);
	} finally { owned.cleanup(); }
}, fixtureDeadlineS(60) * 1000);

test("HOOKHELPERS1 doctor names the missing helper and quotes the scoped repair", async () => {
	const owned = ownedTmp("hook-helper-doctor", { bead: "ompkit-namk5" });
	try {
		const repo = join(owned.path, "doctor's fixture");
		const options = { cwd: owned.path, deadline_s: fixtureDeadlineS(20) };
		const init = await run(["git", "init", "-q", "--template=", repo], options);
		expect(init.rc, decode.decode(init.stderr)).toBe(0);
		const installed = await run(["sh", installer, repo], options);
		expect(installed.rc, decode.decode(installed.stderr)).toBe(0);
		const io = { ...liveHookFreshnessIo(owned.path, root), repos: () => [{ repo, source: "owned-fixture" }] };
		expect((await inspectHooks(io))[0]?.status).toBe("OK");
		const helper = join(repo, ".git/hooks", relativeHelper);
		renameSync(helper, join(owned.path, "removed-helper"));
		const [finding] = await inspectHooks(io);
		expect(finding?.status).toBe("DEGRADED");
		expect(finding?.evidence?.missing_members).toEqual([{ repo, member: relativeHelper }]);
		const projection = (await inspectHookInstallers(repo, root)).find(row => row.evidence?.installer === installer);
		expect(projection?.status).toBe("DRIFT");
		expect(projection?.reason).toContain(`MISSING installed member: ${helper}`);
		expect(finding?.recommended_action).toContain(`sh '${installer}' '${repo.replaceAll("'", "'\\''")}'`);
	} finally { owned.cleanup(); }
}, fixtureDeadlineS(60) * 1000);
