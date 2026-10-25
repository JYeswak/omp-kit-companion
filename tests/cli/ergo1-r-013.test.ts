// R-013: real CLI schema gives only --receipt a PATH value; --apply and --yes
// are booleans. A closed-stdin --apply --plan request without --yes must reach
// safe plan/flag refusal, never mistake the next flag for --apply's value.
// --plan is currently unsupported here. No rollback, consented apply, injected
// handler, or receipt propagation is exercised by this read-only grammar test.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run as runCommand } from "../../src/kitlib/run";

const cli = resolve(import.meta.dir, "../../src/cli.ts");

async function fixture(check: (run: (args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>, root: string, home: string) => Promise<void>) {
	const owned = ownedTmp("ergo1-r-013");
	try {
		const home = join(owned.path, "home");
		mkdirSync(home);
		const run = async (args: string[]) => {
			const child = await runCommand([process.execPath, "run", "--no-env-file", "--config=/dev/null", cli, ...args, "--json"], {
				cwd: owned.path, deadline_s: 8,
				env: { ...process.env, HOME: home, TMPDIR: owned.path, OMP_KIT_CC: "0", CI: "true", NO_COLOR: "1",
					XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"),
					XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache") },
			});
			expect(child.rc !== null && child.rc >= 0 ? null : child.rc).toBeNull();
			return { exitCode: child.rc, stdout: Buffer.from(child.stdout).toString(), stderr: Buffer.from(child.stderr).toString() };
		};
		await check(run, owned.path, home);
	} finally {
		owned.cleanup();
	}
}

test("R-013 schema advertises boolean --apply and --yes separately from --receipt PATH", () => fixture(async (run) => {
	const child = await run(["schema"]);
	expect(child.exitCode, child.stdout + child.stderr).toBe(0);
	expect(child.stderr).toBe("");
	const schema = JSON.parse(child.stdout);
	const infra = schema.data.commands.find((command: { name: string }) => command.name === "infra");
	expect(infra).toBeDefined();
	const undo = infra.subcommands.find((command: { name: string }) => command.name === "undo");
	expect(undo).toBeDefined();
	const receipt = undo.flags.find((flag: { name: string }) => flag.name === "--receipt");
	const apply = undo.flags.find((flag: { name: string }) => flag.name === "--apply");
	const yes = undo.flags.find((flag: { name: string }) => flag.name === "--yes");
	expect(receipt).toMatchObject({ name: "--receipt", value: "PATH" });
	expect(apply).toBeDefined();
	expect(yes).toBeDefined();
	expect(apply.value).toBeUndefined();
	expect(yes.value).toBeUndefined();
}));

test("R-013 --apply is parsed as boolean before a safe --plan refusal, without consent", () => fixture(async (run, root, home) => {
	const receipt = join(root, "nonexistent-promote-receipt.json");
	const child = await run(["infra", "undo", "--receipt", receipt, "--apply", "--plan"]);
	expect(child.exitCode, child.stdout + child.stderr).toBe(2);
	expect(child.stderr).toBe("");
	const envelope = JSON.parse(child.stdout);
	expect(envelope.ok).toBe(false);
	// INVALID_FLAG is today's safe refusal because undo has no --plan flag.
	// If a real preview is later admitted, conflicting modes must still refuse.
	expect(["INVALID_FLAG", "CONFLICTING_FLAGS"]).toContain(envelope.errors[0].code);
	expect(envelope.errors[0].message).toContain("--plan");
	expect(envelope.errors[0].code).not.toBe("MISSING_VALUE");
	expect(existsSync(receipt)).toBe(false);
}));
