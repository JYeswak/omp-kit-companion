import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { planInstall, renderLaunchdPlist, renderSystemdUnits } from "../../src/service.ts";
import { checkPlistContract, checkSystemdContract } from "../../src/service-contract.ts";

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

test("planted relative HOME fails contract-env and is named accurately", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.replace(`<key>HOME</key>\n\t\t<string>${HOME}</string>`, "<key>HOME</key>\n\t\t<string>relative/home</string>");
	const check = checkPlistContract("load-watch", rendered).find(check => check.id === "contract-env")!;
	expect(check.status).toBe("FAIL");
	expect(check.message).toContain("HOME=not absolute PATH=absolute");
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

test("relative plist PATH is reported without mislabeling absolute HOME", () => {
	const rendered = renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text
		.replace("\t\t<key>PATH</key>\n\t\t<string>", "\t\t<key>PATH</key>\n\t\t<string>relative/bin:");
	const check = checkPlistContract("load-watch", rendered).find(check => check.id === "contract-env")!;
	expect(check.status).toBe("FAIL");
	expect(check.message).toContain("HOME=absolute PATH=has relative entries");
});

test("missing systemd TMPDIR is reported separately from absolute HOME and PATH", () => {
	const rendered = renderSystemdUnits(HOME, goodJobDef(), LAUNCHER, null).service
		.split("\n").filter(line => !line.startsWith("Environment=TMPDIR=")).join("\n");
	const check = checkSystemdContract("load-watch", rendered).find(check => check.id === "contract-systemd-env")!;
	expect(check.status).toBe("FAIL");
	expect(check.message).toContain("HOME=absolute PATH=absolute TMPDIR=(missing)");
});

test("fleet-watch plan and systemd render preserve its resolved custom config path", () => {
	const previous = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	const configuredPath = "custom/fleet&watch.json";
	const expectedPath = resolve(configuredPath);
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = configuredPath;
	try {
		const fleetWatch = { name: "fleet-watch", label: "com.omp-kit.fleet-watch", kind: "interval" as const, intervalSeconds: 120, runAtLoad: false };
		const preview = planInstall(HOME, fleetWatch, LAUNCHER, null, null);
		expect(preview.plist).toContain(`<key>OMP_KIT_FLEET_WATCH_CONFIG</key>\n\t\t<string>${expectedPath.replaceAll("&", "&amp;")}</string>`);
		const systemd = renderSystemdUnits(HOME, fleetWatch, LAUNCHER, null).service;
		expect(systemd).toContain(`Environment=OMP_KIT_FLEET_WATCH_CONFIG="${expectedPath}"`);
		expect(renderLaunchdPlist(HOME, goodJobDef(), LAUNCHER, null).text).not.toContain("OMP_KIT_FLEET_WATCH_CONFIG");
	} finally {
		if (previous === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		else process.env.OMP_KIT_FLEET_WATCH_CONFIG = previous;
	}
});
