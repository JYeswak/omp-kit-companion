import { expect, test } from "bun:test";

import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { kitCommitSh } from "../../src/land.ts";

const savedScriptsDir = process.env.OMP_KIT_SCRIPTS_DIR;

function withoutOverride<T>(fn: () => T): T {
	const had = "OMP_KIT_SCRIPTS_DIR" in process.env;
	const saved = process.env.OMP_KIT_SCRIPTS_DIR;
	delete process.env.OMP_KIT_SCRIPTS_DIR;
	try {
		return fn();
	} finally {
		if (had) process.env.OMP_KIT_SCRIPTS_DIR = saved as string;
		else delete process.env.OMP_KIT_SCRIPTS_DIR;
	}
}

function fakeRelease(): { bin: string; sh: string } {
	const root = realpathSync(ownedTmp("kitcommit-layout").path);
	const binDir = join(root, "bin");
	const scriptsDir = join(root, "scripts");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(scriptsDir, { recursive: true });
	const bin = join(binDir, "omp-kit");
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	const sh = join(scriptsDir, "kit-commit.sh");
	writeFileSync(sh, "#!/bin/sh\nexit 0\n");
	chmodSync(sh, 0o755);
	return { bin, sh };
}

test("GITLOCKLAYOUT1: a release tree outside the source tree resolves its helper", () => {
	const { bin, resolved, sh } = withoutOverride(() => {
		const layout = fakeRelease();
		return { bin: layout.bin, sh: layout.sh, resolved: kitCommitSh(layout.bin) };
	});
	expect(resolved).toBe(sh);
	expect(existsSync(resolved)).toBe(true);
	expect(bin.endsWith("bin/omp-kit")).toBe(true);
});

test("GITLOCKLAYOUT1-override: an explicit scripts dir wins, a missing file refuses", () => {
	const dir = realpathSync(ownedTmp("kitcommit-override").path);
	const sh = join(dir, "kit-commit.sh");
	writeFileSync(sh, "#!/bin/sh\nexit 0\n");
	process.env.OMP_KIT_SCRIPTS_DIR = dir;
	try {
		expect(kitCommitSh("/definitely/not/a/release/bin")).toBe(sh);
	} finally {
		if (savedScriptsDir === undefined) delete process.env.OMP_KIT_SCRIPTS_DIR;
		else process.env.OMP_KIT_SCRIPTS_DIR = savedScriptsDir;
	}
	const empty = realpathSync(ownedTmp("kitcommit-empty").path);
	process.env.OMP_KIT_SCRIPTS_DIR = empty;
	try {
		expect(() => kitCommitSh("/definitely/not/a/release/bin")).toThrow("KIT_COMMIT_TRAMPOLINE_UNAVAILABLE");
	} finally {
		if (savedScriptsDir === undefined) delete process.env.OMP_KIT_SCRIPTS_DIR;
		else process.env.OMP_KIT_SCRIPTS_DIR = savedScriptsDir;
	}
});

test("GITLOCKLAYOUT1-fallback: dev source tree still resolves", () => {
	const resolved = withoutOverride(() => kitCommitSh("/definitely/not/a/release/bin"));
	expect(existsSync(resolved)).toBe(true);
	expect(resolved.endsWith("scripts/kit-commit.sh")).toBe(true);
});
