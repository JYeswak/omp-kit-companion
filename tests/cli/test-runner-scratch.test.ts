import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

test("stock Bun runner ignores scratch copies but runs the control", () => {
	const config = readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8");
	expect(config).toContain('pathIgnorePatterns = ["var/agent-tmp/**"');
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "testscope1-"));
	try {
		writeFileSync(join(root, "bunfig.toml"), "[test]\npathIgnorePatterns = [\"var/agent-tmp/**\", \"node_modules/**\"]\n");
		mkdirSync(join(root, "tests", "cli"), { recursive: true });
		writeFileSync(join(root, "tests", "cli", "control.test.ts"), 'import { test, expect } from "bun:test"; test("control", () => expect(true).toBe(true));\n');
		const negative = join(root, "var", "agent-tmp", "nested", "tests", "cli");
		mkdirSync(negative, { recursive: true });
		writeFileSync(join(negative, "control.test.ts"), 'import { test, expect } from "bun:test"; test("planted scratch negative", () => expect(false).toBe(true));\n');
		const result = Bun.spawnSync([process.execPath, "test", "tests/cli"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(output).toContain("1 pass");
		expect(output).not.toContain("planted scratch negative");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable stock-runner configuration declares the scratch boundary", () => {
	expect(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8")).toMatch(/pathIgnorePatterns\s*=\s*\[[^\]]*var\/agent-tmp\/\*\*/);
});
test("doctor test-scope reports planted Jest negative and passing Bun control", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "testscope1-doctor-"));
	try {
		const good = join(root, "good");
		const bad = join(root, "bad");
		mkdirSync(good, { recursive: true });
		mkdirSync(bad, { recursive: true });
		writeFileSync(join(good, "bunfig.toml"), "[test]\npathIgnorePatterns = [\"var/agent-tmp/**\", \"/tmp/**\", \"/var/tmp/**\", \"/var/folders/**\"]\n");
		writeFileSync(join(bad, "package.json"), JSON.stringify({ scripts: { test: "jest" }, devDependencies: { jest: "^29" } }));
		const config = join(root, "fleet-watch.json");
		writeFileSync(config, JSON.stringify({ sessions: [{ repo: good }, { repo: bad }] }));
		const negative = Bun.spawnSync([process.execPath, "run", join(REPO_ROOT, "src", "cli.ts"), "doctor", "--scope", "test-scope", "--json"], {
			env: { ...process.env, OMP_KIT_FLEET_WATCH_CONFIG: config, OMP_KIT_OMP_SRC_FETCH: "0" },
			stdout: "pipe", stderr: "pipe", stdin: "ignore",
		});
		const negativeOutput = negative.stdout.toString();
		expect(negative.exitCode, negativeOutput + negative.stderr.toString()).toBe(0);
		const negativeParsed = JSON.parse(negativeOutput) as { data: { findings: Array<{ component: string; status: string; evidence?: { repos?: Array<{ repo: string; verdict: string; runner: string }> } }> } };
		const negativeFinding = negativeParsed.data.findings.find((row) => row.component === "test-scope")!;
		expect(negativeFinding.status).toBe("FAIL");
		expect(negativeFinding.evidence?.repos).toEqual(expect.arrayContaining([
			expect.objectContaining({ repo: good, runner: "bun", verdict: "PASS" }),
			expect.objectContaining({ repo: bad, runner: "jest", verdict: "FAIL" }),
		]));
		writeFileSync(join(bad, "jest.config.js"), "module.exports = { testPathIgnorePatterns: ['/var/agent-tmp/', '/tmp/', '/var/tmp/', '/var/folders/'] };\n");
		const control = Bun.spawnSync([process.execPath, "run", join(REPO_ROOT, "src", "cli.ts"), "doctor", "--scope", "test-scope", "--json"], {
			env: { ...process.env, OMP_KIT_FLEET_WATCH_CONFIG: config, OMP_KIT_OMP_SRC_FETCH: "0" },
			stdout: "pipe", stderr: "pipe", stdin: "ignore",
		});
		const controlOutput = control.stdout.toString();
		expect(control.exitCode, controlOutput + control.stderr.toString()).toBe(0);
		const controlParsed = JSON.parse(controlOutput) as { data: { findings: Array<{ component: string; status: string; evidence?: { repos?: Array<{ repo: string; verdict: string; runner: string }> } }> } };
		const controlFinding = controlParsed.data.findings.find((row) => row.component === "test-scope")!;
		expect(controlFinding.status).toBe("OK");
		expect(controlFinding.evidence?.repos).toEqual(expect.arrayContaining([
			expect.objectContaining({ repo: good, runner: "bun", verdict: "PASS" }),
			expect.objectContaining({ repo: bad, runner: "jest", verdict: "PASS" }),
		]));
	} finally { rmSync(root, { recursive: true, force: true }); }
});
