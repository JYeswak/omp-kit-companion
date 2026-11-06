// FIXEDENV1 supersedes caller-PATH rejection: discard caller shims before qualification.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

const kit = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("suite-shim-path", { bead: "ompkit-1ra0d.31" });
afterAll(() => scratch.cleanup());
for (const name of ["agent-bin", "linked-shim"]) {
	test(`caller ${name} cannot supply br to the suite`, () => {
		const bin = join(scratch.path, name);
		mkdirSync(bin);
		writeFileSync(join(bin, "br"), "#!/bin/sh\necho CALLER_BR_USED >&2\nexit 97\n");
		chmodSync(join(bin, "br"), 0o755);
		const r = runFixture(["/bin/sh", join(kit, "scripts/full-suite-verdict.sh"), "--check-env"], {
			cwd: kit, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		expect({ rc: r.rc, stderr: new TextDecoder().decode(r.stderr) }).toMatchObject({ rc: 0 });
		const observed = JSON.parse(new TextDecoder().decode(r.stdout));
		expect(observed.environment.PATH.split(":" )).not.toContain(bin);
	});
}
