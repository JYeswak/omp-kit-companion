import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { KNOWN_JOBS, plistPath, renderLaunchdPlist } from "../../src/service.ts";

// AMWATCH2 (ompkit-1ra0d.190): the load-watch job carries the Agent Mail probe target in its rendered job file, and a re-render
// from a shell without it keeps what is installed, so an update never silently reverts the probe to its list-projects default.
afterAll(cleanupAllOwnedTmp);
const KEYS = ["OMP_KIT_AM_PROBE_PROJECT", "OMP_KIT_AM_PROBE_AGENT"] as const;
const saved = new Map(KEYS.map(key => [key, process.env[key]]));
afterEach(() => {
	for (const key of KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

const LAUNCHER = "/fixture/bin/omp-kit";
const PROJECT = "/fixture/project";
const loadWatch = KNOWN_JOBS["load-watch"]!;
const render = (home: string, job = loadWatch) => renderLaunchdPlist(home, job, LAUNCHER, null).text;
const freshHome = () => ownedTmp("load-watch-env").path;
function setProbe(project: string | undefined, agent: string | undefined) {
	for (const [key, value] of [["OMP_KIT_AM_PROBE_PROJECT", project], ["OMP_KIT_AM_PROBE_AGENT", agent]] as const) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
}
function install(home: string, text: string) {
	const path = plistPath(home, loadWatch.label);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}
const carries = (text: string) => text.includes("<key>OMP_KIT_AM_PROBE_PROJECT</key>") && text.includes(`<string>${PROJECT}</string>`)
	&& text.includes("<key>OMP_KIT_AM_PROBE_AGENT</key>") && text.includes("<string>PeachLeopard</string>");

test("AMWATCH2: a load-watch install from a shell naming the probe target renders both variables", () => {
	setProbe(PROJECT, "PeachLeopard");
	expect(carries(render(freshHome()))).toBe(true);
});

test("AMWATCH2: a re-render from a shell without them keeps the installed probe target", () => {
	const home = freshHome();
	setProbe(PROJECT, "PeachLeopard");
	install(home, render(home));
	setProbe(undefined, undefined);
	expect(carries(render(home))).toBe(true);
});

test("AMWATCH2 planted: without any setting or installed value no probe variable is rendered, and other jobs never get one", () => {
	const home = freshHome();
	setProbe(undefined, undefined);
	expect(render(home)).not.toContain("OMP_KIT_AM_PROBE");
	setProbe(PROJECT, "PeachLeopard");
	expect(render(home, KNOWN_JOBS["scratch-reaper"]!)).not.toContain("OMP_KIT_AM_PROBE");
});

test("AMWATCH2: two empty explicit values clear an installed probe target", () => {
	const home = freshHome();
	setProbe(PROJECT, "PeachLeopard");
	install(home, render(home));
	setProbe("", "");
	expect(render(home)).not.toContain("OMP_KIT_AM_PROBE");
});

test("AMWATCH2 planted: an explicit half-set, relative path, option-like or over-long agent is refused loudly", () => {
	const home = freshHome();
	const refused = (project: string, agent: string | undefined) => {
		setProbe(project, agent);
		try { render(home); return null; } catch (error) { return error instanceof Error ? error.message.split(":")[0] : String(error); }
	};
	expect(refused(PROJECT, undefined)).toBe("AM_PROBE_INVALID");
	expect(refused("relative/project", "PeachLeopard")).toBe("AM_PROBE_INVALID");
	expect(refused(PROJECT, "-PeachLeopard")).toBe("AM_PROBE_INVALID");
	expect(refused(PROJECT, "a".repeat(65))).toBe("AM_PROBE_INVALID");
	expect(refused(PROJECT + "/../project", "PeachLeopard")).toBe("AM_PROBE_INVALID");
	setProbe(PROJECT, "a".repeat(64));
	expect(render(home)).toContain(`<string>${"a".repeat(64)}</string>`);
});
