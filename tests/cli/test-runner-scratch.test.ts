import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

test("stock Bun runner ignores scratch copies but runs the control", () => {
	const config = readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8");
	expect(config).toContain('pathIgnorePatterns = ["var/agent-tmp/**"');
	const root = mkdtempSync(join(REPO_ROOT, "var/agent-tmp", "testscope1-"));
	try {
		mkdirSync(join(root, "tests", "cli"), { recursive: true });
		writeFileSync(join(root, "tests", "cli", "control.test.ts"), 'import { test, expect } from "bun:test"; test("control", () => expect(true).toBe(true));\n');
		const negative = join(root, "var", "agent-tmp", "nested", "tests", "cli");
		mkdirSync(negative, { recursive: true });
		writeFileSync(join(negative, "control.test.ts"), 'import { test, expect } from "bun:test"; test("planted scratch negative", () => expect(false).toBe(true));\n');
		const result = Bun.spawnSync([process.execPath, "test", "tests/cli/control.test.ts"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(result.stdout.toString()).toContain("control");
		expect(result.stdout.toString()).not.toContain("planted scratch negative");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable stock-runner configuration declares the scratch boundary", () => {
	expect(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8")).toMatch(/pathIgnorePatterns\s*=\s*\[[^\]]*var\/agent-tmp\/\*\*/);
});
