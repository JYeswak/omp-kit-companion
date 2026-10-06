import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
const gate = join(root, "scripts/fresh-gate.sh");

function fixture(): string {
	const dir = mkdtempSync(join(scratchRoot, "fresh-gate-test-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	mkdirSync(join(dir, "rules"));
	mkdirSync(join(dir, "scripts"));
	for (const name of ["rules/bash-glob-silenced.md", "scripts/build-manifest.sh", "scripts/rule-class.ts", "scripts/ttsr-harness.ts"]) {
		cpSync(join(root, name), join(dir, name));
	}
	return dir;
}


// Manifest tests isolate manifest behavior from compile/harness work.
// The test-local Bun shim supplies fixture classifications, then stops at the
// first downstream Bun command; regex-budget.test.ts exercises RX1 by default.
const SKIP_BUDGET = { FRESH_GATE_SKIP_REGEX: "manifest fixture does not assess regex cost" };
function manifestTestEnv(dir: string): Record<string, string> {
	const fakeBin = join(dir, "bin");
	mkdirSync(fakeBin);
	const fakeBun = join(fakeBin, "bun");
	writeFileSync(fakeBun, `#!/bin/sh
case "$*" in
  *scripts/rule-class.ts*) printf 'bash-glob-silenced\\ttripwire\\n' ;;
  *)
    echo "fresh-gate.test: stopped after manifest verification" >&2
    exit 99
    ;;
esac
`);
	chmodSync(fakeBun, 0o755);
	return { ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
}



function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
	return Bun.spawnSync(["sh", script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } });
}

test("fresh gate refuses an edited rule with a stale manifest", () => {
	const dir = fixture();
	try {
		const rule = join(dir, "rules/bash-glob-silenced.md");
		writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
		writeFileSync(rule, readFileSync(rule, "utf8") + "\nStale manifest plant.\n");
		const result = run(gate, ["--archive-dir", dir, "--changed-file", "rules/bash-glob-silenced.md"], manifestTestEnv(dir));
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("build-manifest --check: FAIL");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("fresh gate validates the package-time manifest for rule-only edits", () => {
	const dir = fixture();
	try {
		const rule = join(dir, "rules/bash-glob-silenced.md");
		const editedRule = readFileSync(rule, "utf8") + "\nPackage-time manifest plant.\n";
		writeFileSync(rule, editedRule);
		const result = run(gate, ["--archive-dir", dir, "--changed-file", "rules/bash-glob-silenced.md"], manifestTestEnv(dir));
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("GREEN manifest");
		expect(output).toContain("fresh-gate.test: stopped after manifest verification");
		const expectedHash = createHash("sha256").update(editedRule).digest("hex");
		expect(readFileSync(join(dir, "MANIFEST.tsv"), "utf8")).toContain(`bash-glob-silenced\t${expectedHash}\ttripwire\t`);
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
