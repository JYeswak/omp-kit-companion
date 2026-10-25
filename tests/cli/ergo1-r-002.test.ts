/** R-002 passing behavior: bare human invocation and help exit 0 without OMP;
 * explicit status and machine-flag-only invocation retain exit 3 OMP_UNAVAILABLE. */
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run as runCommand } from "../../src/kitlib/run";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

test("R-002: bare human discovery does not become an unavailable presence check", async () => {
	const tmp = ownedTmp("ergo1-r-002");
	try {
		const run = async (args: string[]) => {
			const result = await runCommand([process.execPath, entry, ...args], {
				deadline_s: 15, cwd: tmp.path,
				env: { HOME: tmp.path, PATH: tmp.path, TMPDIR: process.env.TMPDIR ?? tmp.path, NO_COLOR: "1", OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "",
					XDG_CONFIG_HOME: join(tmp.path, "config"), XDG_STATE_HOME: join(tmp.path, "state"), XDG_DATA_HOME: join(tmp.path, "data"), XDG_CACHE_HOME: join(tmp.path, "cache") },
			});
			return { exitCode: result.rc, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
		};
		const help = await run(["help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("Usage: omp-kit");
		for (const args of [["status", "--json"], ["--json"], ["--robot"]]) {
			const result = await run(args);
			expect(result.exitCode).toBe(3);
			const envelope = JSON.parse(result.stdout.toString());
			expect(envelope.ok).toBe(false);
			expect(envelope.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OMP_UNAVAILABLE" })]));
		}
		const bare = await run([]);
		expect(bare.exitCode).toBe(0);
		expect(bare.stdout.toString()).toBe(help.stdout.toString());
		expect(bare.stderr.toString()).toBe("");
	} finally {
		tmp.cleanup();
	}
}, 65_000);
