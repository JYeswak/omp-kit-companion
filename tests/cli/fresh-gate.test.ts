import { expect, test } from "bun:test";
import { cpSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = resolve(root, "var/agent-tmp");
const gate = join(root, "scripts/fresh-gate.sh");

function fixture(): string {
	const dir = mkdtempSync(join(scratchRoot, "fresh-gate-test-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	for (const name of ["rules", "scripts", "checkers", "cases", "policy", "retired", "extensions", "examples"]) {
		cpSync(join(root, name), join(dir, name), { recursive: true });
	}
	writeFileSync(join(dir, "package.json"), readFileSync(join(root, "package.json")));
	return dir;
}

function run(script: string, args: string[]) {
	return Bun.spawnSync(["sh", script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
}

test("fresh gate refuses an edited rule with a stale manifest", () => {
	const dir = fixture();
	try {
		writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
		const rule = join(dir, "rules/bash-glob-silenced.md");
		writeFileSync(rule, readFileSync(rule, "utf8") + "\nStale manifest plant.\n");
		const result = run(gate, ["--archive-dir", dir, "--changed-file", "rules/bash-glob-silenced.md"]);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("build-manifest --check: FAIL");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh gate accepts rule-only edits without a committed manifest", () => {
	const dir = fixture();
	try {
		const rule = join(dir, "rules/bash-glob-silenced.md");
		writeFileSync(rule, readFileSync(rule, "utf8") + "\nPackage-time manifest plant.\n");
		const result = run(gate, ["--archive-dir", dir, "--changed-file", "rules/bash-glob-silenced.md"]);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).toBe(0);
		expect(output).toContain("FRESH-GATE: GREEN");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh gate selftest refuses a deleted gate function", () => {
	const dir = fixture();
	try {
		const mutant = join(dir, "scripts/fresh-gate-mutant.sh");
		const source = readFileSync(gate, "utf8");
		const deleted = source.replace(/\ngate_harness\(\) \{[\s\S]*?\n\}\n/, "\n");
		expect(deleted).not.toBe(source);
		writeFileSync(mutant, deleted);
		chmodSync(mutant, 0o755);
		const result = run(mutant, ["--selftest"]);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("gate_harness");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
