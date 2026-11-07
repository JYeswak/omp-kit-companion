import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);
const script = resolve(import.meta.dir, "../../skills/fleet-restart/scripts/fleet_restart.py");

test("NATIVESESSION1: profile alignment remains read-only; stale link fails and correct link passes", () => {
	const dir = ownedTmp("profile-align").path;
	const releases = join(dir, "releases");
	const expected = join(releases, "1.0.0");
	const stale = join(releases, "0.0.0");
	const parent = join(dir, "home/.omp/plugins/node_modules");
	mkdirSync(parent, { recursive: true });
	mkdirSync(expected, { recursive: true });
	mkdirSync(stale);
	const link = join(parent, "omp-kit-companion");
	symlinkSync(stale, link);
	const argv = ["python3", script, "align", "--home", join(dir, "home"), "--releases", releases, "--version", "1.0.0"];
	const negative = runFixture(argv, { cwd: dir });
	expect(negative.rc).toBe(3);
	expect(JSON.parse(new TextDecoder().decode(negative.stdout)).ok).toBe(false);
	expect(readlinkSync(link)).toBe(stale);
	unlinkSync(link);
	symlinkSync(expected, link);
	const control = runFixture(argv, { cwd: dir });
	expect(control.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(control.stdout)).ok).toBe(true);
	expect(readlinkSync(link)).toBe(expected);
});

test("NATIVESESSION1: retired respawn and watcher commands cannot act on seats", () => {
	const dir = ownedTmp("profile-align-cli").path;
	for (const command of ["run", "send", "manifest", "watchers", "save"]) {
		const result = runFixture(["python3", script, command], { cwd: dir });
		expect(result.rc).toBe(2);
		expect(new TextDecoder().decode(result.stderr)).toContain("invalid choice");
	}
});
