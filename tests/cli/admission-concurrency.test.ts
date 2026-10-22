import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fileURLToPath } from "node:url";

const harness = join(fileURLToPath(new URL("../..", import.meta.url)), "scripts", "ttsr-harness.ts");

// The fast proof's gate and selftest build one isolated Git fixture per admission case.
// Run serially, they put the packaged-CLI tests at bun's 5 s limit (ompkit-v66l.27.2).
// This shim holds each fixture's `git init` until a second fixture's `git init` has
// started; a serial harness never starts a second fixture while the first waits, so the
// held init exits 97 (well inside the harness's 2 s Git deadline) and the run fails.
// The wait is a real-clock poll because it runs in a git process the harness spawns, where
// bun's fake timers cannot reach; a concurrent harness passes it within milliseconds, and
// the 1 s bound only decides how fast a serial harness fails.
test("the gate and the selftest build their admission fixtures concurrently, with unchanged verdicts", async () => {
	const owned = ownedTmp("omp-kit-admission-overlap");
	const temp = owned.path;
	const realGit = Bun.which("git");
	if (!realGit) throw new Error("the overlap proof needs git on the suite PATH");
	try {
		const runs = ["--gate-json", "--selftest"].map(mode => {
			const shimDir = join(temp, `${mode.slice(2)}-bin`);
			const barrier = join(temp, `${mode.slice(2)}-inits`);
			mkdirSync(shimDir);
			mkdirSync(barrier);
			writeFileSync(join(shimDir, "git"), [
				"#!/bin/sh",
				`peers() { set -- ${JSON.stringify(barrier)}/*; [ "$#" -ge 2 ]; }`,
				'case " $* " in',
				'*" init "*)',
				`\t: > ${JSON.stringify(barrier)}/$$`,
				"\twaited=0",
				"\tuntil peers; do",
				"\t\twaited=$((waited + 1))",
				'\t\t[ "$waited" -gt 100 ] && exit 97',
				"\t\tsleep 0.01",
				"\tdone ;;",
				"esac",
				`exec ${JSON.stringify(realGit)} "$@"`,
				"",
			].join("\n"));
			chmodSync(join(shimDir, "git"), 0o700);
			const child = Bun.spawn([process.execPath, harness, mode], {
				cwd: temp,
				env: { ...process.env, TMPDIR: temp, PATH: `${shimDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
				stdout: "pipe",
				stderr: "pipe",
			});
			return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
				.then(([code, stdout, stderr]) => ({ code, stdout, stderr, inits: readdirSync(barrier).length }));
		});
		const [gate, selftest] = await Promise.all(runs);
		expect(gate!.code, gate!.stdout + gate!.stderr).toBe(0);
		expect(JSON.parse(gate!.stdout)).toMatchObject({ schema_version: 1, status: "PASS", failures: [] });
		expect(gate!.inits).toBeGreaterThan(1);
		expect(selftest!.code, selftest!.stdout + selftest!.stderr).toBe(0);
		expect(selftest!.stdout).toContain("SELFTEST: all seven plants RED and named; controls GREEN");
		expect(selftest!.stdout).toContain("plant (flip) RED as intended");
		expect(selftest!.inits).toBeGreaterThan(1);
	} finally {
		owned.cleanup();
	}
});
