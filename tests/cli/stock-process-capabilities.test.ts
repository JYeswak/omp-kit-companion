import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const ROOT = resolve(import.meta.dir, "../..");
const deadlineS = fixtureDeadlineS(90);

test("STOCKPS1: the actual isolated runner satisfies owned-process contracts without fleet adapters", async () => {
	const result = await run([process.execPath, "--no-env-file", resolve(ROOT, "scripts/test-stock-extensions.ts")], {
		cwd: ROOT,
		deadline_s: deadlineS,
		max_output_bytes: 8 * 1024 * 1024,
		max_total_bytes: 16 * 1024 * 1024,
	});
	const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
	const diagnostic = `stock runner rc=${result.rc} timed_out=${result.timed_out} truncated=${result.truncated}/${result.total_truncated}\n${output}`;
	expect(result.timed_out, diagnostic).toBe(false);
	expect(result.truncated, diagnostic).toBe(false);
	expect(result.total_truncated, diagnostic).toBe(false);
	expect(result.rc, diagnostic).toBe(0);
	// Require the real child test summary, not an empty successful launcher.
	expect(output, diagnostic).toContain("\n 0 fail\n");
}, (deadlineS + 5) * 1000);
