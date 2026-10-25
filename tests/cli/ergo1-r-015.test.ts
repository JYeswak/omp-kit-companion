// R-015 reachable boundary: a genuine EACCES while reading an isolated pin file
// exits nonzero; --json/--robot produce one stdout error envelope, human mode
// uses stderr, and neither presentation leaks private paths, content or stacks.
// This handler-level boundary already emits HANDLER_FAILED. The outer rejected-
// promise CLI_FAILURE renderer remains UNVERIFIED: this does not exercise it.
// Requires an unprivileged test process; the EACCES precondition fails explicitly
// rather than silently substituting a synthetic exception or skipping under root.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";

const cli = resolve(import.meta.dir, "../../src/cli.ts");

for (const mode of ["human", "json", "robot"] as const) {
	test(`R-015 genuine read EACCES respects ${mode} output without private diagnostics`, () => {
		const owned = ownedTmp("ergo1-r-015");
		const pins = join(owned.path, "private-ergo1-pins.toml");
		try {
			const home = join(owned.path, "home");
			mkdirSync(home);
			const content = '[tools.ergo1_private_pin]\nversion = "1.0.0"\nreceipt = "private-ergo1-receipt-marker"\n';
			writeFileSync(pins, content, { mode: 0o600 });
			chmodSync(pins, 0o000);
			// lstat succeeds in infra pin, but its readFileSync must genuinely fail.
			expect(statSync(pins).isFile()).toBe(true);
			let readError: string | undefined;
			try {
				readFileSync(pins, "utf8");
			} catch (error) {
				readError = (error as NodeJS.ErrnoException).code;
			}
			expect(readError, "Fixture must cause real EACCES; run tests as an unprivileged user").toBe("EACCES");
			const flags = mode === "human" ? [] : [`--${mode}`];
			const child = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", cli, "infra", "pin", "--file", pins, ...flags], { cwd: owned.path, deadline_s: 8,
				env: { ...process.env, HOME: home, TMPDIR: owned.path, OMP_KIT_CC: "0", CI: "true", NO_COLOR: "1", PATH: "",
					XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"),
					XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache") } as Record<string, string> });
			const stdout = new TextDecoder().decode(child.stdout), stderr = new TextDecoder().decode(child.stderr);
			expect(child.timed_out || child.killed).toBe(false);
			expect(child.rc, stdout + stderr).toBe(1);
			if (mode === "human") {
				expect(stdout).toBe("");
				expect(stderr).toContain("HANDLER_FAILED:");
			} else {
				expect(stderr).toBe("");
				// Parsing all stdout rejects multiple envelopes and appended prose.
				const envelope = JSON.parse(stdout);
				expect(envelope.ok).toBe(false);
				expect(typeof envelope.tool_version).toBe("string");
				expect(typeof envelope.meta.schema_version).toBe("string");
				expect(envelope.meta.verification).toBe("UNVERIFIED");
				expect(envelope.errors).toHaveLength(1);
				expect(envelope.errors[0].code).toBe("HANDLER_FAILED");
				expect(typeof envelope.errors[0].remediation).toBe("string");
				expect(envelope.errors[0].remediation.length).toBeGreaterThan(0);
			}
			const output = stdout + stderr;
			expect(output).not.toContain(owned.path);
			expect(output).not.toContain("private-ergo1-pins");
			expect(output).not.toContain("private-ergo1-receipt-marker");
			expect(output).not.toContain("readFileSync");
			expect(output).not.toContain("src/cli.ts:");
			expect(output).not.toContain("\n    at ");
			expect(output).not.toContain("\n\tat ");
			expect(output).not.toContain("\u001b");
			chmodSync(pins, 0o600);
			expect(readFileSync(pins, "utf8")).toBe(content);
		} finally {
			// ownedTmp.cleanup removes files even if an assertion leaves mode 000.
			owned.cleanup();
		}
	}, 12_000);
}
