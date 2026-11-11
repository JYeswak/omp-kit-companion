import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_SRC } from "../../scripts/rule-class.ts";
import { run } from "../../src/kitlib/run.ts";
import { NONDETERMINISM_ERROR } from "../../src/mechanical-admission.ts";

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

for (const mode of ["slow", "failed", "changed"] as const) {
	test(`ADMITFLAKE1 selftest names ${mode === "changed" ? "NONDETERMINISM" : "UNKNOWN"} for a ${mode} live read without an uncaught throw`, async () => {
		const temp = ownedTmp("admitflake-selftest");
		const located = process.platform === "darwin" ? await run(["xcrun", "--find", "git"], { deadline_s: 10 }) : null;
		const realGit = located ? Buffer.from(located.stdout).toString().trim() : Bun.which("git");
		if (!realGit) throw new Error("ADMITFLAKE1 requires Git");
		try {
			const shim = join(temp.path, "git"), injected = join(temp.path, "injected");
			writeFileSync(shim, `#!/bin/sh
if [ "$1" = --no-pager ]; then
  if { [ "${mode}" = changed ] && [ "$8" = rev-parse ]; } ||
     { [ "${mode}" != changed ] && [ "$8" = ls-files ] && [ "$9" = --stage ]; }; then
    counter="$7/.git/admitflake-count"
    n=0
    if [ -f "$counter" ]; then IFS= read -r n < "$counter"; fi
    n=$((n + 1))
    printf '%s\\n' "$n" > "$counter"
    if [ "$n" = 2 ] && mkdir ${JSON.stringify(injected)} 2>/dev/null; then
      case "${mode}" in
        slow) exec sleep 30 ;;
        failed) printf '%s\\n' 'planted index read failure' >&2; exit 73 ;;
        changed) printf '/\\n'; exit 0 ;;
      esac
    fi
  fi
fi
exec ${JSON.stringify(realGit)} "$@"
`);
			chmodSync(shim, 0o700);
			const report = join(temp.path, "selftest.jsonl");
			const result = await run([process.execPath, harness, "--selftest"], {
				deadline_s: 45, cwd: temp.path,
				env: { ...process.env, TMPDIR: temp.path, PATH: `${temp.path}:${process.env.PATH ?? "/usr/bin:/bin"}`,
					OMP_KIT_TEST_CASE_REPORT: report, OMP_KIT_TEST_CASE_SCOPE: "harness-selftest" },
			});
			const stdout = Buffer.from(result.stdout).toString(), stderr = Buffer.from(result.stderr).toString();
			expect(result.rc, stdout + stderr).toBe(1);
			const named = mode === "changed" ? "NONDETERMINISM" : "UNKNOWN";
			expect(stdout.split("\n").some(line => line.startsWith(`FAIL ${named} mechanical control`)), stdout + stderr).toBe(true);
			if (mode !== "changed") expect(stdout).toContain("git ls-files --stage -z");
			expect(stdout).toContain("SELFTEST: 1 arm(s) failed");
			expect(stdout).toContain("ok   plant (flip) RED as intended: NONDETERMINISM");
			expect(stderr).not.toContain("error:");
			expect(stderr).not.toContain("at deterministicDispatch");
			const events = readFileSync(report, "utf8").trim().split("\n").map(line => JSON.parse(line));
			expect(events.at(-1)?.event).toBe("end");
			const failures = events.filter(event => event.event === "case" && event.outcome === "FAIL");
			expect(failures).toHaveLength(1);
			expect(failures[0]?.name).toContain("mechanical control scratch-is-not-a-home");
			if (mode === "changed") {
				// Plant the old selftest rethrow in memory: the named-FAIL assertion must detect its regression.
				rmSync(injected, { recursive: true });
				const marker = "failure ??= `${kind} mechanical control";
				const mutant = readFileSync(harness, "utf8").replace(marker, `throw error;\n\t\t\t\t${marker}`);
				const negative = await run([process.execPath, "-e", mutant, "--", "--selftest"], {
					deadline_s: 45, cwd: join(repoRoot, "scripts"),
					env: { ...process.env, TMPDIR: temp.path, PATH: `${temp.path}:${process.env.PATH ?? "/usr/bin:/bin"}`,
						OMP_KIT_TEST_CASE_REPORT: join(temp.path, "mutant.jsonl"), OMP_KIT_TEST_CASE_SCOPE: "harness-selftest" },
				});
				const negativeOut = Buffer.from(negative.stdout).toString(), negativeErr = Buffer.from(negative.stderr).toString();
				expect(negative.rc, negativeOut + negativeErr).toBe(1);
				expect(negativeErr).toContain(NONDETERMINISM_ERROR);
				expect(negativeOut).not.toContain("FAIL NONDETERMINISM mechanical control");
				expect(negativeOut).not.toContain("SELFTEST:");
			}
		} finally { temp.cleanup(); }
	}, 60_000);
}
