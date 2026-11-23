// Coverage: src/service.ts.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { checkService, checkServiceLinux, KNOWN_JOBS, plistPath, renderLaunchdPlist, renderSystemdUnits } from "../../src/service.ts";

// The botcn class (ompkit-botcn, J-2026-11-23-01): a hand-set job variable survives a service install from a shell that does not
// carry it. The probe target, the Agent Mail RSS ceiling and the kit-update poll config already do; these are the other two the
// renderer reads from the installing shell: the am-retain storage root and the ci-poller repo scope.
afterAll(cleanupAllOwnedTmp);
const ROOT_KEY = "AGENT_MAIL_STORAGE_ROOT";
const REPOS_KEY = "OMP_KIT_CI_REPOS";
const KIT_KEYS = ["OMP_KIT_UPDATE_ENABLED", "OMP_KIT_UPDATE_POLL", "OMP_KIT_UPDATE_REPO", "OMP_KIT_UPDATE_INDEX", "OMP_KIT_UPDATE_ARCHIVE", "OMP_KIT_UPDATE_VERSION", "OMP_KIT_UPDATE_SOURCE_TAG"] as const;
const saved = new Map([ROOT_KEY, REPOS_KEY, ...KIT_KEYS].map(key => [key, process.env[key]]));
afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

const LAUNCHER = "/fixture/bin/omp-kit";
const amRetain = KNOWN_JOBS["am-retain"]!;
const ciPoller = KNOWN_JOBS["ci-poller"]!;
const render = (home: string, job = amRetain) => renderLaunchdPlist(home, job, LAUNCHER, null).text;
const freshHome = () => ownedTmp("service-env-keep").path;
function setEnv(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
function install(home: string, job: typeof amRetain, text: string) {
	const path = plistPath(home, job.label);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}
function valueOf(text: string, key: string): string | null {
	const open = `<key>${key}</key>`;
	const at = text.indexOf(open);
	if (at < 0) return null;
	const rest = text.slice(at + open.length);
	const start = rest.indexOf("<string>");
	const end = rest.indexOf("</string>");
	return start < 0 || end < start ? null : rest.slice(start + "<string>".length, end);
}

test("botcn: a re-render of am-retain from a shell without AGENT_MAIL_STORAGE_ROOT keeps the installed root", () => {
	const home = freshHome();
	setEnv(ROOT_KEY, "/fixture/mail-root");
	install(home, amRetain, render(home));
	expect(valueOf(render(home), ROOT_KEY)).toBe("/fixture/mail-root");
	setEnv(ROOT_KEY, undefined);
	expect(valueOf(render(home), ROOT_KEY)).toBe("/fixture/mail-root");
});

test("botcn control: an explicit new storage root replaces the installed one and an empty string clears it", () => {
	const home = freshHome();
	setEnv(ROOT_KEY, "/fixture/mail-root");
	install(home, amRetain, render(home));
	setEnv(ROOT_KEY, "/fixture/other-root");
	expect(valueOf(render(home), ROOT_KEY)).toBe("/fixture/other-root");
	setEnv(ROOT_KEY, "");
	expect(valueOf(render(home), ROOT_KEY)).toBeNull();
});

test("botcn planted: no root anywhere renders none, other jobs never get one, an explicit relative path is refused and an unusable installed one is dropped", () => {
	const home = freshHome();
	setEnv(ROOT_KEY, undefined);
	expect(valueOf(render(home), ROOT_KEY)).toBeNull();
	setEnv(ROOT_KEY, "/fixture/mail-root");
	expect(render(home, ciPoller)).not.toContain(ROOT_KEY);
	setEnv(ROOT_KEY, "relative/root");
	expect(() => render(home)).toThrow("AM_RETAIN_ROOT_INVALID");
	setEnv(ROOT_KEY, undefined);
	install(home, amRetain, render(home).replace("<key>OMP_KIT_JOB</key>", `<key>${ROOT_KEY}</key>\n\t\t<string>relative/root</string>\n\t\t<key>OMP_KIT_JOB</key>`));
	expect(valueOf(render(home), ROOT_KEY)).toBeNull();
});

test("botcn: a re-render of ci-poller from a shell without OMP_KIT_CI_REPOS keeps the installed scope", () => {
	const home = freshHome();
	setEnv(REPOS_KEY, "JYeswak/omp-kit-companion, JYeswak/zestroku");
	install(home, ciPoller, render(home, ciPoller));
	setEnv(REPOS_KEY, undefined);
	expect(valueOf(render(home, ciPoller), REPOS_KEY)).toBe("JYeswak/omp-kit-companion,JYeswak/zestroku");
});

test("botcn control and planted: an explicit CI scope replaces the installed one, a bad explicit one is refused, a bad installed one is dropped", () => {
	const home = freshHome();
	setEnv(REPOS_KEY, "JYeswak/omp-kit-companion");
	install(home, ciPoller, render(home, ciPoller));
	setEnv(REPOS_KEY, "JYeswak/zestroku");
	expect(valueOf(render(home, ciPoller), REPOS_KEY)).toBe("JYeswak/zestroku");
	setEnv(REPOS_KEY, "not a repo");
	expect(() => render(home, ciPoller)).toThrow("CI_REPOS_INVALID");
	setEnv(REPOS_KEY, undefined);
	install(home, ciPoller, render(home, ciPoller).replace("<key>OMP_KIT_JOB</key>", `<key>${REPOS_KEY}</key>\n\t\t<string>not a repo</string>\n\t\t<key>OMP_KIT_JOB</key>`));
	expect(valueOf(render(home, ciPoller), REPOS_KEY)).toBeNull();
});

// AC2 (this bead): `service doctor kit-update` names the stripped-config state. A kit-update job that is
// installed and loaded but carries neither poll nor static configuration fails every run with
// KIT_UPDATE_JOB_CONFIG, so doctor reports FAIL on a named check instead of staying green.
const kitUpdate = KNOWN_JOBS["kit-update"]!;
function doctorKitUpdateConfig(home: string, text: string, loaded: boolean): string | undefined {
	return checkService({ home, job: kitUpdate, launcher: LAUNCHER, watch: null, rendered: text,
		installed: { path: plistPath(home, kitUpdate.label), text },
		print: { loaded, path: plistPath(home, kitUpdate.label), state: loaded ? "running" : null,
			pid: loaded ? 1 : null, runs: 1, lastExit: 0 } }).find(check => check.id === "kit-update-config")?.status;
}

test("botcn planted: an installed and loaded kit-update with neither poll nor static config fails kit-update-config", () => {
	const home = freshHome();
	for (const key of KIT_KEYS) setEnv(key, undefined);
	const text = render(home, kitUpdate);
	expect(valueOf(text, "OMP_KIT_UPDATE_POLL")).toBeNull();
	expect(valueOf(text, "OMP_KIT_UPDATE_INDEX")).toBeNull();
	install(home, kitUpdate, text);
	expect(doctorKitUpdateConfig(home, text, true)).toBe("FAIL");
});

test("botcn control: an installed and loaded kit-update with poll config passes kit-update-config", () => {
	const home = freshHome();
	setEnv("OMP_KIT_UPDATE_ENABLED", "1");
	setEnv("OMP_KIT_UPDATE_POLL", "github");
	setEnv("OMP_KIT_UPDATE_REPO", "JYeswak/omp-kit-companion");
	const text = render(home, kitUpdate);
	for (const key of KIT_KEYS) setEnv(key, undefined);
	install(home, kitUpdate, text);
	expect(valueOf(text, "OMP_KIT_UPDATE_REPO")).toBe("JYeswak/omp-kit-companion");
	expect(doctorKitUpdateConfig(home, text, true)).toBe("PASS");
});

test("botcn control: an installed and loaded kit-update with static config passes kit-update-config", () => {
	const home = freshHome();
	setEnv("OMP_KIT_UPDATE_ENABLED", "1");
	setEnv("OMP_KIT_UPDATE_INDEX", join(home, "kit", "index.json"));
	setEnv("OMP_KIT_UPDATE_ARCHIVE", join(home, "kit", "archive.tar.gz"));
	setEnv("OMP_KIT_UPDATE_VERSION", "0.2.146");
	setEnv("OMP_KIT_UPDATE_SOURCE_TAG", "v0.2.146");
	const text = render(home, kitUpdate);
	for (const key of KIT_KEYS) setEnv(key, undefined);
	install(home, kitUpdate, text);
	expect(valueOf(text, "OMP_KIT_UPDATE_VERSION")).toBe("0.2.146");
	expect(doctorKitUpdateConfig(home, text, true)).toBe("PASS");
});

test("botcn planted: other jobs never report kit-update-config and an unloaded stripped job does not fail it", () => {
	const home = freshHome();
	for (const key of KIT_KEYS) setEnv(key, undefined);
	const other = checkService({ home, job: amRetain, launcher: LAUNCHER, watch: null,
		rendered: render(home), installed: { path: plistPath(home, amRetain.label), text: render(home) },
		print: { loaded: true, path: plistPath(home, amRetain.label), state: "running", pid: 1, runs: 1, lastExit: 0 } });
	expect(other.some(check => check.id === "kit-update-config")).toBe(false);
	const stripped = render(home, kitUpdate);
	install(home, kitUpdate, stripped);
	expect(doctorKitUpdateConfig(home, stripped, false)).toBe("PASS");
});

test("botcn planted: a systemd unit with neither poll nor static config fails kit-update-config when enabled", () => {
	const home = freshHome();
	for (const key of KIT_KEYS) setEnv(key, undefined);
	const service = renderSystemdUnits(home, kitUpdate, LAUNCHER, null).service;
	expect(service).not.toContain("OMP_KIT_UPDATE_POLL");
	const unitDir = join(home, ".config", "systemd", "user");
	mkdirSync(unitDir, { recursive: true });
	const serviceFile = join(unitDir, "omp-kit-kit-update.service");
	writeFileSync(serviceFile, service);
	const input = { home, job: kitUpdate, launcher: LAUNCHER, unit: "omp-kit-kit-update.service",
		timer: null, pathUnit: null, renderedService: service, enabled: true, active: true, fragmentPath: serviceFile };
	expect(checkServiceLinux(input).find(check => check.id === "kit-update-config")?.status).toBe("FAIL");
	expect(checkServiceLinux({ ...input, enabled: false, active: false }).find(check => check.id === "kit-update-config")?.status).toBe("PASS");
});
