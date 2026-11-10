import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";

const kit = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("fixed-env", { bead: "ompkit-1ra0d.31" });
afterAll(() => scratch.cleanup());
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const poison = join(scratch.path, "poison");
mkdirSync(poison);
for (const tool of ["python3", "bun", "git", "tsc"]) {
	writeFileSync(join(poison, tool), "#!/bin/sh\necho CALLER_TOOL_WAS_USED >&2\nexit 97\n");
	chmodSync(join(poison, tool), 0o755);
}
const foreignOmp = join(poison, "omp");
writeFileSync(foreignOmp, "#!/bin/sh\nexit 97\n");
chmodSync(foreignOmp, 0o755);
const foreignIdentity = { OMP_PATH: foreignOmp, OMP_BIN: foreignOmp, OMP: foreignOmp, OMP_SRC: poison };
const hostileParent = {
	...foreignIdentity, OMP_PROFILE: "muse", PI_PROFILE: "muse",
	PI_CODING_AGENT_DIR: poison, PI_SESSION_FILE: join(poison, "session"),
	PI_SESSION_ID: "foreign-session", PI_TOOL_CALL_ID: "foreign-call",
	GIT_DIR: poison, GIT_WORK_TREE: poison, BEADS_DB: join(poison, "beads.db"),
	FIXED_ENV_RANDOM_CALLER_VALUE: "must-not-reach-qualification",
};
const env = (path: string, agent = "caller-a") => ({
	HOME: process.env.HOME, PATH: path, LANG: "caller-locale", LC_ALL: "C", AGENT_NAME: agent,
	TMPDIR: process.env.TMPDIR!, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
	GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined,
});
function command(argv: string[], environment = env(process.env.PATH!)) {
	const r = runFixture(argv, { cwd: kit, env: environment, floor_s: 60 });
	expect({ rc: r.rc, err: text(r.stderr), out: text(r.stdout) }).toMatchObject({ rc: 0 });
	return text(r.stdout).trim();
}
// fresh-gate refuses caller Git/tracker authority outright (HERMETIC1, tested there); every other hostile
// variable must leave each gate's constructed suite environment unchanged.
const { GIT_DIR: _gd, GIT_WORK_TREE: _gw, BEADS_DB: _bd, ...gateHostile } = hostileParent;
function probe(script: string, path: string, agent?: string, hostile = false) {
	return JSON.parse(command([script.endsWith("release-local.sh") ? "/bin/bash" : "/bin/sh",
		join(kit, "scripts", script), "--check-env"], { ...env(path, agent), ...(hostile ? gateHostile : {}) }));
}

test("release, post-push and suite gates ignore reordered/extended caller PATH and identity", () => {
	const paths = [`${poison}:/usr/bin:/bin`, `/bin:/usr/bin:${poison}`];
	const control = probe("full-suite-verdict.sh", process.env.PATH!);
	for (const script of ["release-local.sh", "release-verdict.sh", "full-suite-verdict.sh", "fresh-gate.sh"]) {
		for (const path of paths) {
			const observed = probe(script, path, "another-agent", true);
			expect(observed).toEqual(control);
			expect(observed.environment.PATH.split(":" )).not.toContain(poison);
			expect(observed.environment.LANG).toBe("C");
		}
	}
}, fixtureDeadlineS(60) * 1000); // eight gate probes, each a python constructor run

test("shell and Python qualification construct the same environment despite arbitrary caller inputs", () => {
	const resolver = `import { resolveOmpIdentity } from ${JSON.stringify(join(kit, "src/paths.ts"))}; console.log(JSON.stringify(resolveOmpIdentity()));`;
	const shell = ["/bin/sh", "-c", '. "$1"; fixed_env_exec "$2" bun -e "$3"', "fixture",
		join(kit, "scripts/fixed-env.sh"), join(kit, "scripts"), resolver];
	const python = ["/usr/bin/python3", "-c",
		"import os,runpy,sys; runpy.run_path(sys.argv[1])['pin_runtime'](); os.execvp('bun', ['bun', '-e', sys.argv[2]])",
		join(kit, "scripts/suite-metrics.py"), resolver];
	const control = command(python);
	// Compare the complete environment without exposing any admitted gate credential on failure.
	const snapshot = "import os,json,hashlib; print(hashlib.sha256(json.dumps(dict(os.environ), sort_keys=True).encode()).hexdigest())";
	const snapshotArgv = ["/usr/bin/python3", "-c",
		"import os,runpy,sys; runpy.run_path(sys.argv[1])['pin_runtime'](); exec(sys.argv[2])",
		join(kit, "scripts/suite-metrics.py"), snapshot];
	expect(command(snapshotArgv, { ...env(process.env.PATH!), ...hostileParent })).toBe(command(snapshotArgv));
	for (const argv of [shell, python]) {
		expect(command(argv, { ...env(process.env.PATH!), ...hostileParent })).toBe(control);
	}
}, fixtureDeadlineS(30) * 1000);

test("a real stored suite PASS is reused across caller shells and retains the judged PATH", async () => {
	const repo = join(scratch.path, "repo");
	const cache = join(scratch.path, "cache");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "tests/cli"), { recursive: true });
	const closure = command(["/usr/bin/python3", join(kit, "scripts/suite-metrics.py"), "judging-files"]).split("\n");
	for (const path of [...closure, "scripts/gate-ci-only.tsv", "scripts/release-verdict.sh",
		"scripts/kitlib_io.py", "scripts/kitlib_jsonl.py"]) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		copyFileSync(join(kit, path), join(repo, path));
	}
	mkdirSync(join(repo, "src", "kitlib"), { recursive: true });
	// omp-source-cache.ts reads the npm registry through kitlib run (OMPSRCLAG1); run.ts embeds pysafe-source.ts.
	for (const file of ["paths.ts", "omp-source-cache.ts", "kitlib/run.ts", "kitlib/pysafe-source.ts"]) copyFileSync(join(kit, "src", file), join(repo, "src", file));
	const identitySuite = join(repo, "tests/cli/omp-identity.test.ts");
	// The inner suite resolves OMP in the constructed suite environment (which names the operator's OMP source
	// cache), so the expected identity is computed in exactly that environment, not the test runner's.
	const expectedIdentity = JSON.parse(command(["/usr/bin/python3", "-c",
		"import os,runpy,sys; e=runpy.run_path(sys.argv[1])['suite_environment'](); os.execvpe('bun', ['bun', '-e', sys.argv[2]], e)",
		join(kit, "scripts/suite-metrics.py"),
		`import { resolveOmpIdentity } from ${JSON.stringify(join(kit, "src/paths.ts"))}; console.log(JSON.stringify(resolveOmpIdentity()));`]));
	const identityControl = `import { expect, test } from "bun:test";\nimport { resolveOmpIdentity } from "../../src/paths.ts";\ntest("qualification resolves the pinned OMP identity without caller state", () => { expect(resolveOmpIdentity()).toEqual(${JSON.stringify(expectedIdentity)}); for (const name of ${JSON.stringify(Object.keys(hostileParent))}) expect(process.env[name]).toBeUndefined(); });\n`;
	writeFileSync(identitySuite, identityControl);
	writeFileSync(join(repo, "tests/cli/control.test.sh"), "#!/bin/sh\nprintf 'ACTUAL_SUITE_RAN\\n'\n");
	const git = (...args: string[]) => command(["git", "-C", repo, ...args]);
	git("init", "-q", "--template=", "-b", "main");
	git("config", "user.name", "fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("add", "--", "scripts", "src", "tests", ".github");
	git("commit", "-qm", "[test] fixture");
	const argv = ["/bin/sh", join(kit, "scripts/full-suite-verdict.sh"), "--repo", repo,
		"--commit", "HEAD", "--judge-role", "main", "--cache-dir", cache];
	const firstRun = await runFixtureAsync(argv, { cwd: kit, env: env(`${poison}:/usr/bin:/bin`), floor_s: 30 });
	expect({ rc: firstRun.rc, out: text(firstRun.stdout), err: text(firstRun.stderr) }).toMatchObject({ rc: 0 });
	const first = text(firstRun.stdout);
	expect(first).toContain("VERDICT PASS");
	const records = readdirSync(cache).filter(name => name.endsWith(".json"));
	expect(records).toHaveLength(1);
	const record = JSON.parse(readFileSync(join(cache, records[0]!), "utf8"));
	expect(readFileSync(join(cache, records[0]!.slice(0, -5) + ".log"), "utf8")).toContain("ACTUAL_SUITE_RAN");
	const release = probe("release-local.sh", `/bin:/usr/bin:${poison}`);
	expect(record.runtime).toBe(release.runtime);
	expect(record.environment).toEqual(release.environment);
	const secondRun = await runFixtureAsync(argv, { cwd: kit,
		env: { ...env(`/bin:/usr/bin:${poison}`, "caller-b"), ...hostileParent }, floor_s: 30 });
	expect({ rc: secondRun.rc, out: text(secondRun.stdout), err: text(secondRun.stderr) }).toMatchObject({ rc: 0 });
	const second = text(secondRun.stdout);
	expect(second).toContain("VERDICT REUSED PASS");
	expect(second).not.toContain("ACTUAL_SUITE_RAN");
	// A cold verdict must also pass: reuse alone would hide poisoned suite execution.
	const foreignRun = await runFixtureAsync([...argv.slice(0, -1), join(scratch.path, "foreign-cache")], {
		cwd: kit, env: { ...env(`${poison}:/usr/bin:/bin`), ...hostileParent }, floor_s: 30,
	});
	expect({ rc: foreignRun.rc, out: text(foreignRun.stdout), err: text(foreignRun.stderr) }).toMatchObject({ rc: 0 });
	expect(text(foreignRun.stdout)).toContain("VERDICT PASS");
	const foreignRecordName = readdirSync(join(scratch.path, "foreign-cache")).find(name => name.endsWith(".json"))!;
	const foreignRecord = JSON.parse(readFileSync(join(scratch.path, "foreign-cache", foreignRecordName), "utf8"));
	expect(foreignRecord.runtime).toBe(record.runtime);
	expect(foreignRecord.environment).toEqual(record.environment);
	const postPush = await runFixtureAsync(["/bin/sh", join(repo, "scripts/release-verdict.sh"),
		"--commit", "HEAD", "--no-fetch"], { cwd: repo,
		env: { ...env(`${poison}:/usr/bin:/bin`), FULL_SUITE_VERDICT_CACHE_DIR: cache }, floor_s: 30 });
	expect({ rc: postPush.rc, out: text(postPush.stdout), err: text(postPush.stderr) }).toMatchObject({ rc: 0 });
	expect(text(postPush.stdout)).toContain("reusing exact-tree main PASS");
	// Changing a real admitted input must still refuse reuse, not normalize a mismatch into PASS.
	const tree = git("rev-parse", "HEAD^{tree}");
	const lookup = ["/usr/bin/python3", join(kit, "scripts/full-suite-verdict-store.py"), "require-pass",
		"--repo", repo, "--tree", tree, "--role", "main", "--judge-root", kit, "--suite-root", repo, "--cache-dir", cache];
	expect(command(lookup, env(`${poison}:/usr/bin:/bin`))).toBe("PASS");
	const changed = runFixture(lookup, { cwd: kit, env: { ...env(process.env.PATH!), FULL_SUITE_RUNTIME_ID: "planted-change" }, floor_s: 60 });
	expect(changed.rc).toBe(1);
	expect(text(changed.stdout)).toContain("RUNTIME_MISMATCH");
	// Candidate-owned overrides are defects, not caller contamination to discard.
	writeFileSync(identitySuite, `process.env.OMP_PATH = ${JSON.stringify(foreignOmp)};\n${identityControl}`);
	git("add", "--", "tests/cli/omp-identity.test.ts");
	git("commit", "-qm", "[test] candidate mixed OMP identity");
	const broken = await runFixtureAsync(argv, { cwd: kit, env: env(process.env.PATH!), floor_s: 30 });
	expect(broken.rc).toBe(1);
	expect(text(broken.stdout) + text(broken.stderr)).toContain("VERDICT FAIL");
	const brokenLogs = readdirSync(cache).filter(name => name.endsWith(".log"))
		.map(name => readFileSync(join(cache, name), "utf8")).join("\n");
	expect(brokenLogs).toContain("OMP_PATH conflicts with the PATH-selected OMP launcher");
}, fixtureDeadlineS(30) * 1000);
