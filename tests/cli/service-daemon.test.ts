import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KNOWN_JOBS, renderLaunchdPlist, renderSystemdUnits, resolveFleetAdapter, serviceLabel } from "../../src/service.ts";
import { CC_SERVICE_HOST, CC_SERVICE_PORT, ccServiceCommand } from "../../src/service.ts";
import { checkPlistContract, checkSystemdContract } from "../../src/service-contract.ts";
import { acquireDaemonLock, DAEMON_HELD_EXIT } from "../../src/service-run.ts";

// CC14 (.18.1): kit supervisor gains a long-running `daemon` job kind.
// Fixture HOME is synthetic so renders are byte-stable; every CLI spawn gets
// its own OMP_KIT_TEST_LABEL_NAMESPACE via extraEnv (never process.env).

const HOME = "/fixture/user-home/test-op";
const LAUNCHER = "/fixture/user-home/test-op/.local/bin/omp-kit";

const roots: string[] = [];
const savedXdg = process.env.XDG_STATE_HOME;
const savedTmux = process.env.TMUX_TMPDIR;
const savedFleetRoot = process.env.OMP_KIT_FLEET_ROOT;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	if (savedTmux === undefined) delete process.env.TMUX_TMPDIR;
	else process.env.TMUX_TMPDIR = savedTmux;
	if (savedFleetRoot === undefined) delete process.env.OMP_KIT_FLEET_ROOT;
	else process.env.OMP_KIT_FLEET_ROOT = savedFleetRoot;
});

function sanitizedEnv(): void {
	delete process.env.XDG_STATE_HOME;
	delete process.env.TMUX_TMPDIR;
	delete process.env.OMP_KIT_FLEET_ROOT;
}

function namespace(): string {
	return `com.omp-kit.test.daemon${Math.random().toString(36).slice(2, 10)}`;
}

function fixtureHome(): string {
	const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-daemon-"));
	roots.push(home);
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	chmodSync(join(bin, "omp-kit"), 0o755);
	return home;
}

function fixtureFleetRoot(): string {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-daemon-fleet-"));
	roots.push(root);
	mkdirSync(join(root, "scripts", "cc"), { recursive: true });
	writeFileSync(join(root, "scripts", "cc", "cc.py"), "#!/usr/bin/env python3\n", { mode: 0o755 });
	return root;
}
function cli(args: string[], home: string, ns: string, extraEnv: Record<string, string> = {}) {
	const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
		cwd: home,
		env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), OMP_KIT_TEST_LABEL_NAMESPACE: ns, ...extraEnv },
		stdout: "pipe", stderr: "pipe",
	});
	return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
}

function statusOf(checks: { id: string; status: string }[], id: string): string {
	return checks.find(check => check.id === id)?.status ?? "(missing)";
}

const DAEMON_PLIST_GOLDEN = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.omp-kit.cc</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/fixture/user-home/test-op/.local/bin/omp-kit</string>
\t\t<string>service</string>
\t\t<string>run</string>
\t\t<string>cc</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>/fixture/user-home/test-op</string>
\t\t<key>XDG_STATE_HOME</key>
\t\t<string>/fixture/user-home/test-op/.local/state</string>
\t\t<key>TMPDIR</key>
\t\t<string>/fixture/user-home/test-op/.local/state/omp-kit/service-tmp</string>
\t\t<key>PATH</key>
\t\t<string>/fixture/user-home/test-op/.local/bin:/fixture/user-home/test-op/.bun/bin:/fixture/user-home/test-op/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t\t<key>OMP_KIT_JOB</key>
\t\t<string>cc</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>/fixture/user-home/test-op/Library/Logs/omp-kit/cc.out.log</string>
\t<key>StandardErrorPath</key>
\t<string>/fixture/user-home/test-op/Library/Logs/omp-kit/cc.err.log</string>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>60</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>Nice</key>
\t<integer>10</integer>
\t<key>LowPriorityIO</key>
\t<true/>
\t<key>WorkingDirectory</key>
\t<string>/fixture/user-home/test-op</string>
</dict>
</plist>
`;

const DAEMON_SERVICE_GOLDEN = `[Unit]
Description=omp-kit cc

[Service]
Type=simple
TimeoutStartSec=600
ExecStart=/fixture/user-home/test-op/.local/bin/omp-kit service run cc
Environment=HOME="/fixture/user-home/test-op"
Environment=XDG_STATE_HOME="/fixture/user-home/test-op/.local/state"
Environment=PATH="/fixture/user-home/test-op/.local/bin:/fixture/user-home/test-op/.bun/bin:/fixture/user-home/test-op/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
Environment=TMPDIR="/fixture/user-home/test-op/.local/state/omp-kit/service-tmp"
Environment=OMP_KIT_JOB="cc"
WorkingDirectory=/fixture/user-home/test-op
Restart=on-failure
RestartSec=60
`;

test("known_jobs_includes_cc_daemon", () => {
	expect(KNOWN_JOBS["cc"]).toMatchObject({ name: "cc", label: "com.omp-kit.cc", kind: "daemon", intervalSeconds: 0 });
});

test("run_cc_resolves_fleet_root", () => {
	sanitizedEnv();
	const home = fixtureHome();
	const root = fixtureFleetRoot();
	const adapter = join(root, "scripts", "cc", "cc.py");
	const cmd = ccServiceCommand(home, adapter);
	expect(cmd.argv).toEqual(["python3", adapter, "serve", "--host", "127.0.0.1", "--port", "7474", "--lanes"]);
	expect(CC_SERVICE_HOST).toBe("127.0.0.1");
	expect(CC_SERVICE_PORT).toBe(7474);
	expect(cmd.env.CC_STATE).toBe(join(home, ".local", "state", "omp-kit", "cc"));
});

test("render_daemon_plist_golden", () => {
	sanitizedEnv();
	const rendered = renderLaunchdPlist(HOME, { ...KNOWN_JOBS["cc"]! }, LAUNCHER, null);
	expect(rendered.text).toBe(DAEMON_PLIST_GOLDEN);
	expect(rendered.text).toContain("<key>KeepAlive</key>");
	expect(rendered.text).toContain("<key>SuccessfulExit</key>");
	expect(rendered.text).not.toContain("StartInterval");
	expect(rendered.text).not.toContain("WatchPaths");
});

test("render_daemon_systemd_golden", () => {
	sanitizedEnv();
	const units = renderSystemdUnits(HOME, { ...KNOWN_JOBS["cc"]! }, LAUNCHER, null);
	expect(units.service).toBe(DAEMON_SERVICE_GOLDEN);
	expect(units.timer).toBeNull();
	expect(units.path).toBeNull();
	expect(units.service).toContain("Restart=on-failure");
	expect(units.service).toContain("RestartSec=60");
});

test("interval_watch_goldens_unchanged", () => {
	sanitizedEnv();
	const reaperPlist = renderLaunchdPlist(HOME, { ...KNOWN_JOBS["scratch-reaper"]! }, LAUNCHER, null).text;
	expect(reaperPlist).toBe(readFileSync(join(import.meta.dir, "service-daemon-reaper.plist.golden"), "utf8"));
	const reaperUnit = renderSystemdUnits(HOME, { ...KNOWN_JOBS["scratch-reaper"]! }, LAUNCHER, null);
	expect(reaperUnit.service).toBe(readFileSync(join(import.meta.dir, "service-daemon-reaper.service.golden"), "utf8"));
	const watchPlist = renderLaunchdPlist(HOME, { ...KNOWN_JOBS["omp-watch"]! }, LAUNCHER, join(HOME, "pkg.json")).text;
	expect(watchPlist).toBe(readFileSync(join(import.meta.dir, "service-daemon-watch.plist.golden"), "utf8"));
	const watchUnit = renderSystemdUnits(HOME, { ...KNOWN_JOBS["omp-watch"]! }, LAUNCHER, join(HOME, "pkg.json"));
	expect(watchUnit.service).toBe(readFileSync(join(import.meta.dir, "service-daemon-watch.service.golden"), "utf8"));
});

test("daemon renderer output passes every contract check", () => {
	sanitizedEnv();
	const plistFails = checkPlistContract("cc", DAEMON_PLIST_GOLDEN).filter(check => check.status === "FAIL");
	expect(plistFails).toEqual([]);
	expect(statusOf(checkPlistContract("cc", DAEMON_PLIST_GOLDEN), "contract-daemon-keepalive")).toBe("PASS");
	const unitFails = checkSystemdContract("cc", DAEMON_SERVICE_GOLDEN).filter(check => check.status === "FAIL");
	expect(unitFails).toEqual([]);
	expect(statusOf(checkSystemdContract("cc", DAEMON_SERVICE_GOLDEN), "contract-daemon-lock")).toBe("PASS");
});

test("planted plist missing KeepAlive fails contract-daemon-keepalive", () => {
	sanitizedEnv();
	const edited = DAEMON_PLIST_GOLDEN.replace("\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n", "");
	expect(edited).not.toContain("KeepAlive");
	expect(statusOf(checkPlistContract("cc", edited), "contract-daemon-keepalive")).toBe("FAIL");
});

test("planted unit missing RestartSec fails contract-daemon-lock", () => {
	sanitizedEnv();
	const edited = DAEMON_SERVICE_GOLDEN.split("\n").filter(line => !line.startsWith("RestartSec=")).join("\n");
	expect(statusOf(checkSystemdContract("cc", edited), "contract-daemon-lock")).toBe("FAIL");
});

test("interval RunAtLoad true still fails contract-run-at-load (daemon exemption is shape-scoped)", () => {
	sanitizedEnv();
	const rendered = renderLaunchdPlist(HOME, { ...KNOWN_JOBS["scratch-reaper"]!, runAtLoad: true }, LAUNCHER, null).text;
	expect(statusOf(checkPlistContract("scratch-reaper", rendered), "contract-run-at-load")).toBe("FAIL");
	expect(statusOf(checkPlistContract("scratch-reaper", rendered), "contract-daemon-keepalive")).toBe("PASS");
});

test("resolveFleetAdapter absent without root or config", () => {
	sanitizedEnv();
	const home = fixtureHome();
	const adapter = resolveFleetAdapter(home);
	expect(adapter.ok).toBe(false);
});

test("resolveFleetAdapter finds the adapter under OMP_KIT_FLEET_ROOT", () => {
	sanitizedEnv();
	const home = fixtureHome();
	const root = fixtureFleetRoot();
	process.env.OMP_KIT_FLEET_ROOT = root;
	const adapter = resolveFleetAdapter(home);
	expect(adapter).toMatchObject({ ok: true, root, adapter: join(root, "scripts", "cc", "cc.py") });
});

test("install_refuses_without_fleet", () => {
	sanitizedEnv();
	const home = fixtureHome();
	const result = cli(["service", "install", "cc", "--plan"], home, namespace());
	expect(result.code).toBe(2);
	expect(result.envelope.errors[0].code).toBe("FLEET_ADAPTER_ABSENT");
	const emptyRoot = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-daemon-empty-"));
	roots.push(emptyRoot);
	const rooted = cli(["service", "install", "cc", "--plan"], home, namespace(), { OMP_KIT_FLEET_ROOT: emptyRoot });
	expect(rooted.envelope.errors[0].code).toBe("FLEET_ADAPTER_ABSENT");
});

test("install plan renders with the fleet adapter present", () => {
	if (process.platform !== "darwin" && process.platform !== "linux") return;
	sanitizedEnv();
	const home = fixtureHome();
	const root = fixtureFleetRoot();
	const result = cli(["service", "install", "cc", "--plan"], home, namespace(), { OMP_KIT_FLEET_ROOT: root });
	expect(result.code).toBe(0);
	expect(result.envelope.data.plan).toBe(true);
	expect(result.envelope.data.plist).toContain("<key>KeepAlive</key>");
});

test("single_instance_lock: second concurrent service run exits 75 ALREADY_RUNNING", () => {
	if (process.platform !== "darwin" && process.platform !== "linux") return;
	sanitizedEnv();
	const home = fixtureHome();
	const root = fixtureFleetRoot();
	process.env.OMP_KIT_FLEET_ROOT = root;
	const dir = join(home, ".local", "state", "omp-kit", "jobs");
	const first = acquireDaemonLock(dir, "cc");
	expect(first.status).toBe("ACQUIRED");
	try {
		const second = cli(["service", "run", "cc"], home, namespace());
		expect(second.code).toBe(75);
		expect(second.code).toBe(DAEMON_HELD_EXIT);
		expect(second.envelope.data.status).toBe("ALREADY_RUNNING");
		expect(second.envelope.errors[0].code).toBe("ALREADY_RUNNING");
	} finally {
		if (first.status === "ACQUIRED") first.lock.release();
	}
	// Lock free: `service run cc` execs the fixture adapter (a python stub that
	// exits 0) with CC_STATE set, holding the one-instance lock for the child.
	const after = cli(["service", "run", "cc"], home, namespace());
	expect(after.code).toBe(0);
	expect(after.envelope.data).toMatchObject({ job: "cc", status: "EXITED", exit: 0 });
});

test("sigkill holder leaves no stale daemon lock", async () => {
	sanitizedEnv();
	const home = fixtureHome();
	const dir = join(home, ".local", "state", "omp-kit", "jobs");
	const holderPath = join(dir, "..", "cc114-holder.ts");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(holderPath, `import { acquireDaemonLock } from ${JSON.stringify(resolve(import.meta.dir, "../../src/service-run.ts"))};\nconst r = acquireDaemonLock(${JSON.stringify(dir)}, "cc");\nif (r.status !== "ACQUIRED") { console.log("HOLDER-HELD"); process.exit(1); }\nconsole.log("HOLDER-READY");\nawait new Promise(() => {});\n`);
	const child = Bun.spawn([process.execPath, holderPath], { stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	const deadline = Date.now() + 15000;
	while (!output.includes("HOLDER-READY") && !output.includes("HOLDER-HELD")) {
		if (Date.now() > deadline) break;
		const { done, value } = await reader.read();
		if (done) break;
		output += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	expect(output).toContain("HOLDER-READY");
	expect(acquireDaemonLock(dir, "cc").status).toBe("HELD");
	child.kill(9);
	await child.exited;
	const after = acquireDaemonLock(dir, "cc");
	expect(after.status).toBe("ACQUIRED");
	if (after.status === "ACQUIRED") after.lock.release();
});

test("doctor_flags_missing_keepalive on a hand-edited daemon plist", () => {
	if (process.platform !== "darwin") return;
	sanitizedEnv();
	const home = fixtureHome();
	const ns = namespace();
	const savedNs = process.env.OMP_KIT_TEST_LABEL_NAMESPACE;
	process.env.OMP_KIT_TEST_LABEL_NAMESPACE = ns;
	let label: string;
	try {
		label = serviceLabel("cc");
	} finally {
		if (savedNs === undefined) delete process.env.OMP_KIT_TEST_LABEL_NAMESPACE;
		else process.env.OMP_KIT_TEST_LABEL_NAMESPACE = savedNs;
	}
	expect(label).toBe(`${ns}.cc`);
	const edited = DAEMON_PLIST_GOLDEN.replace("\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n", "")
		.replace("<string>com.omp-kit.cc</string>", `<string>${label}</string>`);
	const agents = join(home, "Library", "LaunchAgents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, `${label}.plist`), edited);
	const result = cli(["service", "doctor", "cc"], home, ns);
	const checks = result.envelope.data.checks as { id: string; status: string }[];
	expect(statusOf(checks, "contract-daemon-keepalive")).toBe("FAIL");
	expect(result.code).toBe(1);
});
