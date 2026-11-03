import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "./kitlib/tmp.ts";
import { run } from "./kitlib/run.ts";

function snapshot(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name);
			result[path.slice(root.length)] = readFileSync(path).toString("hex");
		}
	}
	return result;
}

test("suite wrapper leaves run-scoped CC sentinel empty; unwrapped CLI is the planted control", async () => {
	const root = ownedTmp("cc-hermetic").path;
	const store = join(root, "sentinel-cc");
	mkdirSync(join(store, "spool"), { recursive: true });
	expect(snapshot(store)).toEqual({});
	const env = { ...process.env, CC_STATE: store, OMP_KIT_CC: "1", OMP_KIT_SUITE_HERMETIC_ENABLE: "0" };
	const cli = [process.execPath, resolve("src/cli.ts"), "--help"];
	for (const enabled of ["0", "1"]) {
		const wrapped = await run(["sh", "scripts/suite-hermetic-env.sh", "--archive", process.cwd(), "--scratch", root, "--suite", "ccleak", "--", ...cli], {
			env: { ...env, OMP_KIT_SUITE_HERMETIC_ENABLE: enabled }, deadline_s: 10,
		});
		expect(wrapped.rc).toBe(0);
		expect(snapshot(store)).toEqual({});
	}
	const control = await run(cli, { env, deadline_s: 10 });
	expect(control.rc).toBe(0);
	expect(Object.keys(snapshot(store)).some((path) => path.includes("/spool/kit/"))).toBe(true);
});

