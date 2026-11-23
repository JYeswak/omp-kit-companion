// Coverage: src/service-launcher.ts, src/cli.ts (runServiceLauncher), src/service-run.ts (observeServiceLaunchers).
import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runServiceLauncher } from "../../src/cli.ts";
import { renderLaunchdPlist, KNOWN_JOBS } from "../../src/service.ts";
import { observeServiceLaunchers } from "../../src/service-run.ts";
import { ensureServiceLauncher, installPrefix, isServiceLauncher, launcherChildPath, launcherExitStatus, serviceLauncherPath } from "../../src/service-launcher.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

// STABLETCC1 (ompkit-ck2av): macOS keys the network-volume consent of a bundle-less tool by its path, so every launchd job
// runs one copy of the kit binary at one path (the service launcher) that starts the active release as a child.
afterAll(cleanupAllOwnedTmp);

/** A prefix with one release (a shell script standing in for the binary), the active-release symlink, and nothing else. */
function fixturePrefix(version = "1.0.0", body = "#!/bin/sh\nexit 0\n"): string {
	const prefix = realpathSync(ownedTmp("service-launcher").path);
	installRelease(prefix, version, body);
	mkdirSync(join(prefix, "bin"), { recursive: true });
	return prefix;
}

function installRelease(prefix: string, version: string, body: string): void {
	mkdirSync(join(prefix, "releases", version, "bin"), { recursive: true });
	writeFileSync(join(prefix, "releases", version, "bin", "omp-kit"), body, { mode: 0o755 });
	const link = join(prefix, "bin", "omp-kit");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	rmSync(link, { force: true });
	symlinkSync(`../releases/${version}/bin/omp-kit`, link);
}

test("STABLETCC1: the launcher is a byte-identical executable copy of the active release at a fixed path, replaced in place by the next release", () => {
	const prefix = fixturePrefix("1.0.0", "#!/bin/sh\necho one\n");
	const first = ensureServiceLauncher(prefix);
	expect(first.path).toBe(serviceLauncherPath(prefix));
	expect(first.changed).toBe(true);
	expect(readFileSync(first.path, "utf8")).toBe("#!/bin/sh\necho one\n");
	expect(statSync(first.path).mode & 0o777).toBe(0o755);
	expect(lstatSync(first.path).isSymbolicLink()).toBe(false);
	// Idempotent: the same active release leaves the launcher untouched.
	const inode = statSync(first.path).ino;
	expect(ensureServiceLauncher(prefix).changed).toBe(false);
	expect(statSync(first.path).ino).toBe(inode);
	// The next release replaces the content at the SAME path.
	installRelease(prefix, "1.0.1", "#!/bin/sh\necho two\n");
	const second = ensureServiceLauncher(prefix);
	expect(second.path).toBe(first.path);
	expect(second.changed).toBe(true);
	expect(readFileSync(second.path, "utf8")).toBe("#!/bin/sh\necho two\n");
	expect(second.source).toBe(join(prefix, "releases", "1.0.1", "bin", "omp-kit"));
	expect(existsSync(join(prefix, "service", ".omp-kit-svc.tmp"))).toBe(false);
}, fixtureDeadlineS() * 1000);

test("STABLETCC1 planted: a launcher that is a symlink to a release is replaced by a real file, never followed", () => {
	const prefix = fixturePrefix("1.0.0", "#!/bin/sh\necho real\n");
	mkdirSync(join(prefix, "service"), { recursive: true });
	symlinkSync(join(prefix, "releases", "1.0.0", "bin", "omp-kit"), serviceLauncherPath(prefix));
	expect(lstatSync(serviceLauncherPath(prefix)).isSymbolicLink()).toBe(true);
	const result = ensureServiceLauncher(prefix);
	expect(result.changed).toBe(true);
	expect(lstatSync(result.path).isSymbolicLink()).toBe(false);
	expect(readFileSync(result.path, "utf8")).toBe("#!/bin/sh\necho real\n");
	expect(() => readlinkSync(result.path)).toThrow();
}, fixtureDeadlineS() * 1000);

test("STABLETCC1 planted: no active release, or an active link that leaves the releases directory, builds no launcher", () => {
	const empty = realpathSync(ownedTmp("service-launcher-empty").path);
	expect(() => ensureServiceLauncher(empty)).toThrow();
	expect(existsSync(serviceLauncherPath(empty))).toBe(false);
	const prefix = fixturePrefix();
	const elsewhere = realpathSync(ownedTmp("service-launcher-elsewhere").path);
	mkdirSync(join(elsewhere, "bin"), { recursive: true });
	writeFileSync(join(elsewhere, "bin", "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	rmSync(join(prefix, "bin", "omp-kit"), { force: true });
	symlinkSync(join(elsewhere, "bin", "omp-kit"), join(prefix, "bin", "omp-kit"));
	expect(() => ensureServiceLauncher(prefix)).toThrow(/SERVICE_LAUNCHER_SOURCE_INVALID/);
	expect(existsSync(serviceLauncherPath(prefix))).toBe(false);
}, fixtureDeadlineS() * 1000);

test("STABLETCC1 planted: a copy a crashed install left under a dead pid is removed; a live pid's temporary and unrelated names stay", () => {
	const prefix = fixturePrefix("1.0.0", "#!/bin/sh\necho one\n");
	const directory = join(prefix, "service");
	mkdirSync(directory, { recursive: true });
	const dead = Number(new TextDecoder().decode(runSync(["sh", "-c", "echo $$"], { deadline_s: fixtureDeadlineS() }).stdout).trim());
	expect(Number.isInteger(dead) && dead > 0).toBe(true);
	const names = { dead: `.omp-kit-svc.${dead}.tmp`, deadRecord: `omp-kit-svc.source.${dead}.tmp`, live: `.omp-kit-svc.${process.ppid}.tmp`, other: ".omp-kit-svc.notapid.tmp", unrelated: "keep.tmp" };
	for (const name of Object.values(names)) writeFileSync(join(directory, name), "partial\n");
	ensureServiceLauncher(prefix);
	expect(existsSync(join(directory, names.dead))).toBe(false);
	expect(existsSync(join(directory, names.deadRecord))).toBe(false);
	for (const kept of [names.live, names.other, names.unrelated]) expect(existsSync(join(directory, kept))).toBe(true);
}, fixtureDeadlineS() * 1000);

test("STABLETCC1: the install prefix honors an absolute OMP_KIT_INSTALL_PREFIX and the launcher is recognized by its name only", () => {
	expect(installPrefix("/home/x", {})).toBe("/home/x/.local/opt/omp-kit");
	expect(installPrefix("/home/x", { OMP_KIT_INSTALL_PREFIX: "/opt/kit" })).toBe("/opt/kit");
	expect(installPrefix("/home/x", { OMP_KIT_INSTALL_PREFIX: "relative/kit" })).toBe("/home/x/.local/opt/omp-kit");
	expect(isServiceLauncher("/p/service/omp-kit-svc")).toBe(true);
	expect(isServiceLauncher("/p/releases/1.0.0/bin/omp-kit")).toBe(false);
	expect(isServiceLauncher("/p/service/omp-kit-svc-old")).toBe(false);
	expect(launcherChildPath("/p/service/omp-kit-svc")).toBe("/p/bin/omp-kit");
	expect(launcherExitStatus(7, null)).toBe(7);
	expect(launcherExitStatus(0, undefined)).toBe(0);
	expect(launcherExitStatus(-1, "SIGTERM")).toBe(143);
	expect(launcherExitStatus(-1, "SIGKILL")).toBe(137);
});

test("STABLETCC1: a rendered job program is the launcher, never a per-release path", () => {
	const prefix = fixturePrefix();
	const home = realpathSync(ownedTmp("service-launcher-home").path);
	const job = { ...KNOWN_JOBS["load-watch"]!, label: "com.omp-kit.test.stabletcc1.load-watch" };
	const plist = renderLaunchdPlist(home, job, serviceLauncherPath(prefix), null).text;
	const arguments_ = plist.slice(plist.indexOf("<key>ProgramArguments</key>"), plist.indexOf("</array>", plist.indexOf("<key>ProgramArguments</key>")));
	expect(arguments_).toContain(`<string>${join(prefix, "service", "omp-kit-svc")}</string>`);
	expect(arguments_).not.toContain("/releases/");
	expect(arguments_.indexOf("omp-kit-svc")).toBeLessThan(arguments_.indexOf("<string>service</string>"));
});

test("STABLETCC1: the launcher starts the active release with the same arguments and environment and returns its exit status", async () => {
	const out = join(realpathSync(ownedTmp("service-launcher-run").path), "seen");
	const prefix = fixturePrefix("1.0.0", `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$OMP_KIT_JOB" "$(basename "$0")" > "${out}"\nexit 7\n`);
	const launcher = ensureServiceLauncher(prefix).path;
	const status = await runServiceLauncher(launcher, ["service", "run", "load-watch"], { ...process.env, OMP_KIT_JOB: "load-watch" });
	expect(status).toBe(7);
	expect(readFileSync(out, "utf8").trim()).toBe("service run load-watch|load-watch|omp-kit");
}, fixtureDeadlineS() * 1000);

test("STABLETCC1 planted: a forwarded SIGTERM ends the child with 143 and a missing active release exits 127", async () => {
	const ready = join(realpathSync(ownedTmp("service-launcher-ready").path), "ready");
	const prefix = fixturePrefix("1.0.0", `#!/bin/sh\n: > "${ready}"\nexec sleep 60\n`);
	const launcher = ensureServiceLauncher(prefix).path;
	// The launcher listens on the emitter it is given; emitting SIGTERM on the process would reach every handler an earlier test
	// file left in a shared `bun test` process (CI shard core-4 died with 143 that way). It installs them before its first await.
	const signals = new EventEmitter();
	const sleeper = runServiceLauncher(launcher, ["service", "run", "x"], { ...process.env }, signals);
	for (let waited = 0; waited < 2000 && !existsSync(ready); waited++) Bun.sleepSync(5);
	expect(existsSync(ready)).toBe(true);
	signals.emit("SIGTERM");
	expect(await sleeper).toBe(143);
	rmSync(join(prefix, "bin", "omp-kit"), { force: true });
	expect(await runServiceLauncher(launcher, ["service", "run", "x"], { ...process.env })).toBe(127);
}, fixtureDeadlineS() * 1000);

test("STABLETCC1: the job-launcher observation skips the launcher row, so one run is one launcher", () => {
	const ps = [
		"101 /Users/josh/.local/opt/omp-kit/service/omp-kit-svc service run cc",
		"102 /Users/josh/.local/opt/omp-kit/bin/omp-kit service run cc",
		"103 /Users/josh/.local/bin/omp-kit service run ci-poller",
	].join("\n");
	const observed = observeServiceLaunchers(() => ({ code: 0, stdout: ps }), "cc");
	expect(observed).toEqual({ launchers: [{ pid: 102, command: "service run cc" }] });
	// Planted negative: a second real launcher of the job is still counted.
	const two = observeServiceLaunchers(() => ({ code: 0, stdout: `${ps}\n104 /Users/josh/.local/bin/omp-kit service run cc` }), "cc");
	expect("launchers" in two ? two.launchers.map(row => row.pid) : []).toEqual([102, 104]);
});

// The rendered program at the CLI boundary: a host with an active release gets the launcher; a host with none keeps the stable CLI path
// (an install is never refused for want of a release to copy).
function plannedProgram(withRelease: boolean): { text: string; home: string } {
	const home = realpathSync(ownedTmp("service-launcher-cli").path);
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	writeFileSync(join(home, ".local", "bin", "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	if (withRelease) installRelease(join(home, ".local", "opt", "omp-kit"), "1.0.0", "#!/bin/sh\nexit 0\n");
	const result = runFixture([process.execPath, join(import.meta.dir, "../../src/cli.ts"), "service", "install", "load-watch", "--plan", "--json"], {
		cwd: home,
		env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), OMP_KIT_TEST_LABEL_NAMESPACE: `com.omp-kit.test.stcc${Math.random().toString(36).slice(2, 10)}` },
	});
	const envelope = JSON.parse(new TextDecoder().decode(result.stdout));
	expect(envelope.errors ?? [], new TextDecoder().decode(result.stderr)).toEqual([]);
	return { text: process.platform === "darwin" ? envelope.data.plist : envelope.data.service, home };
}

test("STABLETCC1: on macOS the planned job program is the launcher when a release is active, and the stable CLI path when none is", () => {
	const withRelease = plannedProgram(true);
	const without = plannedProgram(false);
	if (process.platform === "darwin") {
		expect(withRelease.text).toContain(`<string>${join(withRelease.home, ".local", "opt", "omp-kit", "service", "omp-kit-svc")}</string>`);
		expect(without.text).toContain(`<string>${join(without.home, ".local", "bin", "omp-kit")}</string>`);
		expect(without.text).not.toContain("omp-kit-svc");
	} else {
		expect(withRelease.text).toContain(join(withRelease.home, ".local", "bin", "omp-kit"));
		expect(withRelease.text).not.toContain("omp-kit-svc");
	}
}, fixtureDeadlineS() * 1000);
