import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveOmpSource } from "../../scripts/rule-class.ts";

// resolveOmpSource follows the launcher symlink to a real path; on macOS tmpdir() sits under the
// /var -> /private/var symlink, so the fixture root must be real for the paths to compare equal.
const base = realpathSync(mkdtempSync(join(tmpdir(), "rule-class-source-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function ompPackage(root: string, version: string): string {
	const dir = join(root, "node_modules", "@oh-my-pi", "pi-coding-agent");
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
	writeFileSync(join(dir, "dist", "cli.js"), "#!/usr/bin/env bun\n");
	chmodSync(join(dir, "dist", "cli.js"), 0o755);
	return dir;
}

function launcherDir(name: string, target?: string): string {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	if (target) symlinkSync(target, join(dir, "omp"));
	else {
		writeFileSync(join(dir, "omp"), "compiled omp stand-in\n");
		chmodSync(join(dir, "omp"), 0o755);
	}
	return dir;
}

const compiled = launcherDir("compiled");
const linked = ompPackage(join(base, "linked-pkg"), "9.9.9");
const linkedBin = launcherDir("linked-bin", join(linked, "dist", "cli.js"));
const bunInstall = join(base, "bun");
const bunGlobal = ompPackage(join(bunInstall, "install", "global"), "9.9.9");
const noBun = join(base, "no-bun");

test("a launcher inside its package resolves without asking for a version", () => {
	const src = resolveOmpSource({
		env: { PATH: linkedBin, BUN_INSTALL: noBun },
		launcherVersion: () => { throw new Error("must not run the launcher"); },
	});
	expect(src).toBe(join(linked, "src"));
});

test("a compiled first launcher takes the same version's package from a later PATH entry", () => {
	const src = resolveOmpSource({ env: { PATH: [compiled, linkedBin].join(delimiter), BUN_INSTALL: noBun }, launcherVersion: () => "9.9.9" });
	expect(src).toBe(join(linked, "src"));
});

test("a compiled launcher alone falls back to bun's global install", () => {
	const src = resolveOmpSource({ env: { PATH: compiled, BUN_INSTALL: bunInstall }, launcherVersion: () => "9.9.9" });
	expect(src).toBe(join(bunGlobal, "src"));
});

test("a package of another version is refused with the exact OMP_SRC shape", () => {
	expect(() => resolveOmpSource({ env: { PATH: [compiled, linkedBin].join(delimiter), BUN_INSTALL: bunInstall }, launcherVersion: () => "9.9.8" }))
		.toThrow("set OMP_SRC to its src directory (…/@oh-my-pi/pi-coding-agent/src)");
});

test("OMP_SRC still wins over every launcher", () => {
	expect(resolveOmpSource({ env: { OMP_SRC: "/explicit/src", PATH: compiled }, launcherVersion: () => null })).toBe("/explicit/src");
});
