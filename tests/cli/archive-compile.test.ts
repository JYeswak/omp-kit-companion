import { expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const gate = join(root, "scripts/fresh-gate.sh");

function fixture(): string {
	const dir = ownedTmp("archive-compile-test", { root: resolve(root, "var/agent-tmp") }).path;
	for (const name of ["src", "scripts", "rules", "retired", "cases", "policy", "extensions", "examples", "checkers"]) {
		cpSync(join(root, name), join(dir, name), { recursive: true });
	}
	for (const name of ["package.json", "bunfig.toml"]) {
		const source = join(root, name);
		try { writeFileSync(join(dir, name), readFileSync(source)); } catch { /* package-time manifest may be absent */ }
	}
	return dir;
}

test("archive gate refuses a CLI import of a missing export", () => {
	const dir = fixture();
	try {
		const cli = join(dir, "src/cli.ts");
		writeFileSync(cli, `import { archiveGateMissingExport } from "./missing-archive-gate-export.ts";\n${readFileSync(cli, "utf8")}`);
		const result = Bun.spawnSync(["sh", gate, "--archive-dir", dir, "--changed-file", "src/cli.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("RED cli-compile");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
