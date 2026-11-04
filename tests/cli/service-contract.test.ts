import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KNOWN_JOBS, renderLaunchdPlist, renderSystemdUnits } from "../../src/service.ts";
import { checkPlistContract, checkSystemdContract } from "../../src/service-contract.ts";
import { RUN_TIME_CAPS_MS } from "../../src/service-run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const HOME = "/fixture/user-home/test-op";
const LAUNCHER = "/fixture/user-home/test-op/.local/bin/omp-kit";

function statusOf(checks: { id: string; status: string }[], id: string): string {
	return checks.find(check => check.id === id)?.status ?? "(missing)";
}

function goodJobDef() {
	return { name: "load-watch", label: "com.omp-kit.load-watch", kind: "interval" as const, intervalSeconds: 60, runAtLoad: false };
}

test("real renderer output with RunAtLoad false passes every plist contract check", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text;
	const checks = checkPlistContract("load-watch", rendered);
	const bad = checks.filter(check => check.status !== "PASS" && check.id !== "contract-low-priority");
	expect(bad).toEqual([]);
	expect(statusOf(checks, "contract-low-priority")).toBe("PASS");
});

test("real renderer output with RunAtLoad true fails contract-run-at-load", () => {
	const rendered = renderLaunchdPlist(HOME, { ...goodJobDef(), runAtLoad: true }, LAUNCHER, null).text;
	const checks = checkPlistContract("load-watch", rendered);
	expect(statusOf(checks, "contract-run-at-load")).toBe("FAIL");
});

test("planted ProcessType Interactive fails contract-processtype", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.replace("<string>Background</string>", "<string>Interactive</string>");
	expect(statusOf(checkPlistContract("load-watch", rendered), "contract-processtype")).toBe("FAIL");
});

test("planted relative HOME fails contract-env", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.replace(`<key>HOME</key>\n\t\t<string>${HOME}</string>`, "<key>HOME</key>\n\t\t<string>relative/home</string>");
	expect(statusOf(checkPlistContract("load-watch", rendered), "contract-env")).toBe("FAIL");
});

test("planted API_TOKEN env entry fails contract-no-secrets and names the key", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.replace("\t\t<key>OMP_KIT_JOB</key>",
			"\t\t<key>API_TOKEN</key>\n\t\t<string>planted-synthetic-token-value</string>\n\t\t<key>OMP_KIT_JOB</key>");
	const check = checkPlistContract("load-watch", rendered).find(check => check.id === "contract-no-secrets")!;
	expect(check.status).toBe("FAIL");
	expect(check.message).toContain("API_TOKEN");
	expect(check.message).not.toContain("planted-synthetic-token-value");
});

test("planted secret-shaped PATH value fails contract-no-secrets without printing it", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.replace(`<key>PATH</key>\n\t\t<string>`, "<key>PATH</key>\n\t\t<string>postgres://syntheticuser:syntheticpassword@invalid.example/test:");
	const check = checkPlistContract("load-watch", rendered).find(check => check.id === "contract-no-secrets")!;
	expect(check.status).toBe("FAIL");
	expect(check.message).toContain("PATH");
	expect(check.message).not.toContain("syntheticpassword");
});

test("missing log paths fail contract-log-paths", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.split("\n").filter(line => !line.includes("StandardOutPath") && !line.includes("StandardErrorPath") &&
			!line.includes(".out.log") && !line.includes(".err.log")).join("\n");
	expect(statusOf(checkPlistContract("load-watch", rendered), "contract-log-paths")).toBe("FAIL");
});

test("real systemd renderer output passes every systemd contract check", () => {
	const rendered = renderSystemdUnits(HOME, goodJobDef(), LAUNCHER, null).service;
	const checks = checkSystemdContract("load-watch", rendered);
	expect(checks.filter(check => check.status === "FAIL")).toEqual([]);
});

test("planted password env line fails contract-systemd-no-secrets and names the key", () => {
	const rendered = renderSystemdUnits(HOME, goodJobDef(), LAUNCHER, null).service
		.replace("Environment=OMP_KIT_JOB=", "Environment=DB_PASSWORD=\"planted-synthetic-password\"\nEnvironment=OMP_KIT_JOB=");
	const check = checkSystemdContract("load-watch", rendered).find(check => check.id === "contract-systemd-no-secrets")!;
	expect(check.status).toBe("FAIL");
	expect(check.message).toContain("DB_PASSWORD");
	expect(check.message).not.toContain("planted-synthetic-password");
});

test("unit without TimeoutStartSec fails contract-systemd-timeout", () => {
	const rendered = renderSystemdUnits(HOME, goodJobDef(), LAUNCHER, null).service
		.split("\n").filter(line => !line.startsWith("TimeoutStartSec=")).join("\n");
	expect(statusOf(checkSystemdContract("load-watch", rendered), "contract-systemd-timeout")).toBe("FAIL");
});

// SVCQOS1 (ompkit-fp72.120.16.50): per-job QoS class.
test("cc renders the deadline shape; a non-cc daemon keeps background QoS", () => {
	const cc = renderLaunchdPlist(HOME, { ...KNOWN_JOBS["cc"]! }, LAUNCHER, null).text;
	expect(cc).toContain("<key>ProcessType</key>\n\t<string>Standard</string>\n\t<key>Nice</key>\n\t<integer>10</integer>");
	expect(cc).not.toContain("LowPriorityIO");
	expect(checkPlistContract("cc", cc, "on-failure", "deadline").filter(check => check.status !== "PASS")).toEqual([]);
	const bg = renderLaunchdPlist(HOME, { name: "bg-daemon", label: "com.omp-kit.bg-daemon", kind: "daemon" as const, intervalSeconds: 0 }, LAUNCHER, null).text;
	expect(bg).toContain("<key>ProcessType</key>\n\t<string>Background</string>");
	expect(bg).toContain("<key>LowPriorityIO</key>\n\t<true/>");
});

test("planted: a deadline job rendered Background fails contract-processtype naming the class", () => {
	const planted = renderLaunchdPlist(HOME, { ...KNOWN_JOBS["cc"]!, qos: "background" as const }, LAUNCHER, null).text;
	const check = checkPlistContract("cc", planted, "on-failure", "deadline").find(row => row.id === "contract-processtype")!;
	expect(check.status).toBe("FAIL");
	expect(check.remediation).toContain("deadline QoS class");
});

test("planted: a background job rendered Standard still fails contract-processtype", () => {
	const planted = renderLaunchdPlist(HOME, { ...goodJobDef(), qos: "deadline" as const }, LAUNCHER, null).text;
	expect(statusOf(checkPlistContract("load-watch", planted), "contract-processtype")).toBe("FAIL");
});

// GATEEVENTS1 (ompkit-fp72.135.3.12): the weekly rationalize child runs the operator's argv on a 7-day interval.
test("gate-rationalize renders the operator argv with a weekly StartInterval; planted: unconfigured it refuses to render", () => {
	const job = KNOWN_JOBS["gate-rationalize"]!;
	expect([job.kind, job.intervalSeconds, job.commandConfigKey]).toEqual(["interval", 604800, "gateRationalize"]);
	const program = { argv: ["/usr/bin/python3", "/repo/scripts/gate_registry.py", "rationalize", "--out", "/state/gate-rationalize.json"], cwd: "/repo" };
	const text = renderLaunchdPlist(HOME, { ...job, program }, LAUNCHER, null).text;
	expect(text).toContain("<string>/repo/scripts/gate_registry.py</string>\n\t\t<string>rationalize</string>");
	expect(text).toContain("<key>StartInterval</key>\n\t<integer>604800</integer>");
	expect(text).not.toContain("service</string>\n\t\t<string>run</string>");
	expect(() => renderLaunchdPlist(HOME, { ...job }, LAUNCHER, null)).toThrow("GATE_RATIONALIZE_UNCONFIGURED");
});

// AUTOCUT1 (ompkit-2uubn): the release cut runs the operator's argv hourly; its run cap ends before the next start.
test("autocut renders the operator argv hourly; planted: unconfigured it refuses to render", () => {
	const job = KNOWN_JOBS["autocut"]!;
	expect([job.kind, job.intervalSeconds, job.commandConfigKey]).toEqual(["interval", 3600, "autocut"]);
	expect(RUN_TIME_CAPS_MS["autocut"]!).toBeLessThan(job.intervalSeconds * 1000);
	const program = { argv: ["/bin/sh", "/repo/scripts/autocut.sh", "run", "--repo", "/repo"], cwd: "/repo" };
	const text = renderLaunchdPlist(HOME, { ...job, program }, LAUNCHER, null).text;
	expect(text).toContain("<string>/repo/scripts/autocut.sh</string>\n\t\t<string>run</string>");
	expect(text).toContain("<key>StartInterval</key>\n\t<integer>3600</integer>");
	expect(() => renderLaunchdPlist(HOME, { ...job }, LAUNCHER, null)).toThrow("AUTOCUT_UNCONFIGURED");
});

// CLOSEPASS1b (ompkit-774u.52.1): the close pass runs every 5 min from the operator's closePass argv, never a kit path.
test("close-pass is a 300 s interval job whose argv and cwd come from fleet-watch.json closePass; planted: keyless install refuses CLOSE_PASS_UNCONFIGURED", () => {
	const job = KNOWN_JOBS["close-pass"]!;
	expect(job).toMatchObject({ label: "com.omp-kit.close-pass", kind: "interval", intervalSeconds: 300, runAtLoad: false, commandConfigKey: "closePass", lockedRun: true });
	expect(job.program).toBeUndefined();
	expect(() => renderLaunchdPlist(HOME, { ...job }, LAUNCHER, null)).toThrow("CLOSE_PASS_UNCONFIGURED");
	if (process.platform !== "darwin") return;
	const home = ownedTmp("service-contract-closepass", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	try {
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(join(home, ".local", "bin", "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const configPath = join(home, ".config", "omp-kit", "fleet-watch.json");
		mkdirSync(dirname(configPath), { recursive: true });
		const plan = (config: unknown) => {
			writeFileSync(configPath, JSON.stringify(config));
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
			Object.assign(env, { HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), OMP_KIT_FLEET_WATCH_CONFIG: configPath,
				OMP_KIT_TEST_LABEL_NAMESPACE: `com.omp-kit.test.closepass${Math.random().toString(36).slice(2, 10)}` });
			const child = runSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "service", "install", "close-pass", "--plan", "--json"],
				{ deadline_s: fixtureDeadlineS(20), cwd: home, env });
			return { code: child.rc, envelope: JSON.parse(new TextDecoder().decode(child.stdout)) };
		};
		const argv = ["/usr/bin/python3", "/fixture/skills/grade_wave.py", "apply", "--close-pass"];
		const configured = plan({ sessions: [], closePass: { argv, cwd: "/fixture/skills" } });
		expect(configured.envelope.errors ?? []).toEqual([]);
		expect(configured.code).toBe(0);
		expect(configured.envelope.data.program).toEqual({ argv, cwd: "/fixture/skills" });
		expect(configured.envelope.data.plist).toContain("<key>StartInterval</key>\n\t<integer>300</integer>");
		expect(configured.envelope.data.plist).toContain("<key>WorkingDirectory</key>\n\t<string>/fixture/skills</string>");
		// The configured argv carries no kit path; the supervisor only invokes the kit's run lock around it.
		expect(argv.some(arg => arg.includes("omp-kit"))).toBe(false);
		expect(configured.envelope.data.plist).toContain("<string>service</string>\n\t\t<string>run</string>\n\t\t<string>close-pass</string>");
		const keyless = plan({ sessions: [] });
		expect(keyless.code).toBe(2);
		expect(keyless.envelope.errors[0].code).toBe("CLOSE_PASS_UNCONFIGURED");
		expect(keyless.envelope.errors[0].message).toContain("no closePass key");
		expect(keyless.envelope.errors[0].message).toContain(configPath);
		expect(keyless.envelope.errors[0].remediation).toContain(`"closePass"`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
