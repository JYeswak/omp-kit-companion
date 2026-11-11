import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FINITE_JOB_DEFAULT_TIMEOUT_S } from "../../extensions/kit-flywheel-guard";
import { createFlywheelHost, bashInput } from "../fleet-guard/kit-flywheel-host";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const base = ownedTmp("deadline-auto").path;
for (const dir of ["t1", "t2", "t3"]) mkdirSync(join(base, dir), { recursive: true });

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

test("DEADLINEAUTO1: timeout zero is admitted with the input patched to the default and a note", async () => {
	const h = await createFlywheelHost(base);
	const admitted = await bashInput(h, { command: "bun test", async: true, timeout: 0 }); // product-deadline: timeout 0 is the guard subject under test, never executed by the fake host.
	expect(admitted?.block).not.toBe(true);
	expect(admitted?.block).toBe(undefined);
	expect(admitted?.input).toMatchObject({ command: "bun test", timeout: FINITE_JOB_DEFAULT_TIMEOUT_S });
	expect(FINITE_JOB_DEFAULT_TIMEOUT_S).toBe(3600);
	expect(admitted?.additionalContext).toContain("DEADLINEAUTO1");
	expect(admitted?.additionalContext).toContain("3600 s");
	expect(admitted?.additionalContext).toContain("named service mode");
	expect(h.execs).toHaveLength(0);
});

test("DEADLINEAUTO1: timeout zero is admitted for sync calls too", async () => {
	const h = await createFlywheelHost(base);
	const admitted = await bashInput(h, { command: "cargo test", timeout: 0 }); // product-deadline: timeout 0 is the guard subject under test, never executed by the fake host.
	expect(admitted?.block).not.toBe(true);
	expect(admitted?.input).toMatchObject({ timeout: FINITE_JOB_DEFAULT_TIMEOUT_S });
});

test("DEADLINEAUTO1 planted negative: no FINITE_JOB_NO_DEADLINE refusal for the same call; unparsable timeouts keep FINITE_JOB_DEADLINE_UNKNOWN", async () => {
	const h = await createFlywheelHost(base);
	const admitted = await bashInput(h, { command: "bun test", async: true, timeout: 0 }); // product-deadline: timeout 0 is the guard subject under test, never executed by the fake host.
	expect(JSON.stringify(admitted ?? {})).not.toContain("FINITE_JOB_NO_DEADLINE");
	const unknown = await bashInput(h, { command: "bun test", async: true, timeout: "0" });
	expect(unknown?.block).toBe(true);
	expect(unknown?.reason).toContain("FINITE_JOB_DEADLINE_UNKNOWN");
});
