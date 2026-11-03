import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { nativeCacheEnv } from "./release-manifest-fixture.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CAPS = ["UV_THREADPOOL_SIZE", "TOKIO_WORKER_THREADS", "RAYON_NUM_THREADS"] as const;
const observe = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([...CAPS, "OMP_KIT_CC"])}.map(key => [key, process.env[key] ?? null]))));`;
const decoder = new TextDecoder();
let scratch: OwnedTmp;
let executable: string;
let release: string;
let environment: Record<string, string>;

beforeAll(async () => {
	const identity = resolveOmpIdentity();
	scratch = ownedTmp("child-thread-caps", { root: join(REPO_ROOT, "var/agent-tmp") });
	release = join(scratch.path, "release");
	executable = join(release, "bin", "omp-kit");
	for (const path of [join(release, "bin"), join(release, "scripts"), join(scratch.path, "home"), join(scratch.path, "tmp")]) {
		mkdirSync(path, { recursive: true });
	}
	// The observer is a real packaged child: the fixture runner calls runtime.ts,
	// which admits the release and starts its embedded Bun with the sanitized env.
	writeFileSync(join(release, "scripts", "rule-class.ts"), observe);
	const build = await run([process.execPath, "build", join(import.meta.dir, "runtime-release-runner.ts"),
		"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
		`--outfile=${executable}`], { cwd: REPO_ROOT, deadline_s: 120 });
	if (build.rc !== 0) throw new Error(`child runtime fixture build failed: ${decoder.decode(build.stderr)}`);
	chmodSync(executable, 0o755);
	environment = {
		...nativeCacheEnv,
		PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(scratch.path, "home"), TMPDIR: join(scratch.path, "tmp"),
		OMP: identity.launcher, OMP_BIN: identity.launcher, OMP_PATH: identity.launcher, OMP_SRC: identity.source,
		OMP_KIT_CC: "0", OMP_KIT_CASE_CWD: REPO_ROOT, OMP_KIT_TEST_WORK_ROOT: scratch.path,
		OMP_KIT_FIXTURE_ROOT: release, OMP_KIT_FIXTURE_EXECUTABLE: executable,
		OMP_KIT_FIXTURE_SCRIPT: "scripts/rule-class.ts", OMP_KIT_FIXTURE_ARGS: "[]",
	};
}, 120_000);

afterAll(() => scratch?.cleanup());

test("runtime children inherit configured thread budgets and retain upstream defaults when unset", async () => {
	for (const caps of [{}, { UV_THREADPOOL_SIZE: "3", TOKIO_WORKER_THREADS: "5", RAYON_NUM_THREADS: "7" }]) {
		const child = await run([executable], {
			cwd: REPO_ROOT, env: { ...environment, ...caps }, deadline_s: 30,
		});
		expect(child.rc, decoder.decode(child.stderr)).toBe(0);
		const values = JSON.parse(decoder.decode(child.stdout));
		for (const key of CAPS) expect(values[key]).toBe(key in caps ? caps[key] : null);
	}
}, 120_000);

test("suite children get the fixed test budget in inherited and scrubbed environments", async () => {
	for (const hermetic of ["0", "1"]) {
		const child = await run(["sh", join(REPO_ROOT, "scripts/suite-hermetic-env.sh"),
			"--archive", REPO_ROOT, "--scratch", scratch.path, "--suite", "tests/cli/child-thread-caps.test.ts",
			"--loopback-port", "18765", "--", process.execPath, "-e", observe], {
			cwd: REPO_ROOT,
			env: { ...environment, OMP_KIT_SUITE_HERMETIC_ENABLE: hermetic, OMP_KIT_SUITE_FENCE_ENABLE: "0",
				UV_THREADPOOL_SIZE: "19", TOKIO_WORKER_THREADS: "23", RAYON_NUM_THREADS: "29", OMP_KIT_CC: "1" },
			deadline_s: 30,
		});
		expect(child.rc, decoder.decode(child.stderr)).toBe(0);
		const output = decoder.decode(child.stdout).trim().split("\n");
		const values = JSON.parse(output.pop() ?? "");
		expect(values).toEqual({ UV_THREADPOOL_SIZE: "4", TOKIO_WORKER_THREADS: "4", RAYON_NUM_THREADS: "4", OMP_KIT_CC: "0" });
	}
}, 120_000);

test("suite allowlisting cannot override the measured thread budget", async () => {
	for (const key of CAPS) {
		const child = await run(["sh", join(REPO_ROOT, "scripts/suite-hermetic-env.sh"),
			"--archive", REPO_ROOT, "--scratch", scratch.path, "--suite", "tests/cli/child-thread-caps.test.ts",
			"--allow-env", key, "--", process.execPath, "-e", "process.exit(99)"], {
			cwd: REPO_ROOT, env: { ...environment, [key]: "99" }, deadline_s: 30,
		});
		expect(child.rc).toBe(125);
		expect(decoder.decode(child.stderr)).toContain(`allowlist cannot override wrapper variable ${key}`);
	}
}, 120_000);
