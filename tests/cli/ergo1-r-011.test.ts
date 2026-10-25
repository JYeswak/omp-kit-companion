// R-011: closed-stdin CLI invocations terminate without ANSI or prompts in each
// automation mode; machine errors stay in stdout, human errors in stderr, real
// findings retain exit 1, and unconsented deep probes leave HOME/state untouched.
// These protections already exist: this is regression coverage, not a claimed red test.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";

const cli = resolve(import.meta.dir, "../../src/cli.ts");
const environments = [
	{ name: "closed stdin alone", env: {}, flags: [] },
	{ name: "CI", env: { CI: "true" }, flags: [] },
	{ name: "TERM=dumb", env: { TERM: "dumb" }, flags: [] },
	{ name: "NO_COLOR", env: { NO_COLOR: "1" }, flags: [] },
	{ name: "--no-color", env: {}, flags: ["--no-color"] },
];

for (const mode of environments) {
	for (const presentation of ["human", "json", "robot"] as const) {
		test(`R-011 ${mode.name}, ${presentation}: streams, findings and consent`, () => {
			const owned = ownedTmp("ergo1-r-011");
			try {
				const home = join(owned.path, "home");
				mkdirSync(home);
				const sentinel = join(home, "keep.txt");
				writeFileSync(sentinel, "operator content\n");
				const pins = join(owned.path, "pins.toml");
				writeFileSync(pins, '[tools.ergo1_uninstalled_tool]\nversion = "1.0.0"\nreceipt = "ergo1-fixture"\n');
				const env = { ...process.env };
				delete env.CI;
				delete env.NO_COLOR;
				delete env.FORCE_COLOR;
				Object.assign(env, {
					HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"),
					XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
					TMPDIR: owned.path, OMP_KIT_CC: "0", PATH: "", TERM: "xterm", ...mode.env,
				});
				const outputFlags = presentation === "human" ? [] : [`--${presentation}`];
				const run = (args: string[], exitCode: number, errorCode: string) => {
					const child = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", cli, ...args, ...mode.flags, ...outputFlags], { cwd: owned.path, env: env as Record<string, string>, deadline_s: 8 });
					const stdout = new TextDecoder().decode(child.stdout), stderr = new TextDecoder().decode(child.stderr);
					expect(child.timed_out || child.killed).toBe(false);
					expect(child.rc, stdout + stderr).toBe(exitCode);
					expect(stdout + stderr).not.toContain("\u001b");
					expect(stdout + stderr).not.toContain("Type CONFIRM");
					if (presentation === "human") {
						expect(stdout).toBe("");
						expect(stderr).toContain(`${errorCode}:`);
					} else {
						expect(stderr).toBe("");
						const envelope = JSON.parse(stdout);
						expect(envelope.ok).toBe(false);
						expect(envelope.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: errorCode })]));
						expect(typeof envelope.meta.schema_version).toBe("string");
						if (exitCode === 1) expect(envelope.data.overall).toBe("FINDINGS");
					}
				};
				run(["ergo1-no-such-command"], 2, "UNKNOWN_COMMAND");
				// Baseline after startup: a read-side runtime cache is not a mutation.
				const homeBeforeConsent = readdirSync(home, { recursive: true }).sort();
				const stateBeforeConsent = existsSync(join(home, "state"));
				// --deep without --yes refuses before any guarded probe can start.
				run(["doctor", "--deep"], 2, "CONSENT_REQUIRED");
				expect(readFileSync(sentinel, "utf8")).toBe("operator content\n");
				expect(readdirSync(home, { recursive: true }).sort()).toEqual(homeBeforeConsent);
				expect(existsSync(join(home, "state"))).toBe(stateBeforeConsent);
				// A valid read-only finding is not a parse error or a crash.
				run(["infra", "pin", "--file", pins], 1, "INFRA_DRIFT");
			} finally {
				owned.cleanup();
			}
		}, 30_000);
	}
}
