import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBoundedFile } from "../../src/external-pack.ts";
import { runtimeTempRoot } from "../../src/runtime.ts";

test("bounded fixture reader handles regular data and refuses a FIFO without waiting for a writer", () => {
	const root = mkdtempSync(join(runtimeTempRoot(), "omp-kit-fixture-input-"));

	try {
		const regular = join(root, "fixture.json");
		writeFileSync(regular, '{"fixture":"public"}\n');
		expect(new TextDecoder().decode(readBoundedFile(regular, 128, "fixture"))).toBe('{"fixture":"public"}\n');
		const fifo = join(root, "fixture.fifo");
		const made = Bun.spawnSync(["mkfifo", fifo], { stdout: "pipe", stderr: "pipe" });
		if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
		const source = resolve(import.meta.dir, "../../src/external-pack.ts");
		const program = `import {readBoundedFile,ExternalPackInputError} from ${JSON.stringify(source)};
			try { readBoundedFile(${JSON.stringify(fifo)},128,"fixture"); process.exitCode=1; }
			catch (error) { if (!(error instanceof ExternalPackInputError)) throw error;
				console.log(JSON.stringify({code:error.code})); process.exitCode=error.code==="UNSAFE_EXTERNAL_FILE"?0:1; }`;
		// A real FIFO open can block before JavaScript runs; use the existing OS process-group
		// deadline and observe actual exit instead of sleeping or faking a kernel clock.
		const limiter = resolve(import.meta.dir, "../../scripts/limit-process-tree.sh");
		const result = Bun.spawnSync(["/bin/sh", limiter, "10", process.execPath, "-e", program], {
			cwd: root, stdout: "pipe", stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(JSON.parse(result.stdout.toString())).toEqual({ code: "UNSAFE_EXTERNAL_FILE" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);
