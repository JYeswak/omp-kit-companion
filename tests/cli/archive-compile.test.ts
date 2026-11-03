import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const gate = join(root, "scripts/fresh-gate.sh");
const fixtureEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
	GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

async function fixture(): Promise<string> {
	const dir = ownedTmp("archive-compile-test", { root: resolve(root, "var/agent-tmp") }).path;
	for (const name of ["src", "scripts", "rules", "retired", "cases", "policy", "extensions", "examples", "checkers"]) {
		cpSync(join(root, name), join(dir, name), { recursive: true });
	}
	for (const name of ["package.json", "bunfig.toml"]) {
		const source = join(root, name);
		try { writeFileSync(join(dir, name), readFileSync(source)); } catch { /* package-time manifest may be absent */ }
	}
	// The policy gate precedes CLI compilation and reads immutable predecessor bytes.
	// Own that history so source exports never consult an enclosing checkout's HEAD^.
	mkdirSync(join(dir, ".github"));
	cpSync(join(root, ".github/test-budget.json"), join(dir, ".github/test-budget.json"));
	const baseline = join(dir, "policy-baseline");
	mkdirSync(join(baseline, ".github"), { recursive: true });
	cpSync(join(dir, ".github/test-budget.json"), join(baseline, ".github/test-budget.json"));
	for (const args of [["init", "-q", "--initial-branch=main"],
		["add", ".github/test-budget.json"], ["commit", "-q", "-m", "archive policy baseline [test]"]]) {
		const result = await run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
			"-c", "user.name=ArchiveFixture", "-c", "user.email=archive@example.invalid", ...args], {
			cwd: baseline, env: fixtureEnv, deadline_s: 10,
		});
		expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
	}
	return dir;
}

test("archive gate refuses a CLI import of a missing export", async () => {
	const dir = await fixture();
	try {
		const cli = join(dir, "src/cli.ts");
		writeFileSync(cli, `import { archiveGateMissingExport } from "./missing-archive-gate-export.ts";\n${readFileSync(cli, "utf8")}`);
		const result = await run(["sh", gate, "--archive-dir", dir, "--base", "HEAD", "--changed-file", "src/cli.ts"], {
			cwd: dir, env: { ...fixtureEnv, FRESH_GATE_REPO: join(dir, "policy-baseline") }, deadline_s: 60,
		});
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(result.rc).not.toBe(0);
		expect(output).toContain("GREEN file-budget-policy");
		expect(output).toContain("RED cli-compile");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
