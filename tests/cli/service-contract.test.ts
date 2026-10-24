import { expect, test } from "bun:test";
import { KNOWN_JOBS, renderLaunchdPlist, renderSystemdUnits } from "../../src/service.ts";
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
