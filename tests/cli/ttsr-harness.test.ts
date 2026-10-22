import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_SRC } from "../../scripts/rule-class.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const harness = join(repoRoot, "scripts", "ttsr-harness.ts");

test("cli-crosscheck stops before cases and names a fail-closed OMP trust guard", () => {
	const temp = ownedTmp("omp-kit-trust-guard").path;
	const wrapper = join(temp, "omp-trust-guard");
	const trace = join(temp, "invocations.txt");
	try {
		writeFileSync(wrapper, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$OMP_GUARD_TRACE\"\nprintf '%s\\n' 'omp-trust-guard: FAIL-CLOSED: config: real omp is unavailable in isolated HOME' >&2\nexit 3\n");
		chmodSync(wrapper, 0o700);
		const result = Bun.spawnSync([process.execPath, harness, "--cli-crosscheck", "--jobs", "1"], {
			cwd: temp,
			env: { ...process.env, HOME: join(temp, "home"), OMP_BIN: wrapper, OMP_GUARD_TRACE: trace, OMP_SRC: OMP_SRC },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();
		expect(result.exitCode).toBe(3);
		expect(stdout).toContain("OMP_TRUST_GUARD_FAIL_CLOSED");
		expect(stdout + stderr).toContain("omp-trust-guard: FAIL-CLOSED");
		expect(stdout).not.toContain("ERROR ");
		expect(stdout).not.toContain("429");
		expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(["--version"]);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
