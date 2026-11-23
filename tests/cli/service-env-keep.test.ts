// Coverage: src/service.ts.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { KNOWN_JOBS, plistPath, renderLaunchdPlist } from "../../src/service.ts";

// The botcn class (ompkit-botcn, J-2026-11-23-01): a hand-set job variable survives a service install from a shell that does not
// carry it. The probe target, the Agent Mail RSS ceiling and the kit-update poll config already do; these are the other two the
// renderer reads from the installing shell: the am-retain storage root and the ci-poller repo scope.
afterAll(cleanupAllOwnedTmp);
const ROOT_KEY = "AGENT_MAIL_STORAGE_ROOT";
const REPOS_KEY = "OMP_KIT_CI_REPOS";
const saved = new Map([ROOT_KEY, REPOS_KEY].map(key => [key, process.env[key]]));
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
