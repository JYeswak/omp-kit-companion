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
function probe(script: string, path: string, agent?: string) {
	return JSON.parse(command([script.endsWith("release-local.sh") ? "/bin/bash" : "/bin/sh",
		join(kit, "scripts", script), "--check-env"], env(path, agent)));
}

test("release, post-push and suite gates ignore reordered/extended caller PATH and identity", () => {
	const paths = [`${poison}:/usr/bin:/bin`, `/bin:/usr/bin:${poison}`];
	const control = probe("full-suite-verdict.sh", process.env.PATH!);
	for (const script of ["release-local.sh", "release-verdict.sh", "full-suite-verdict.sh"]) {
		for (const path of paths) {
			const observed = probe(script, path, "another-agent");
			expect(observed).toEqual(control);
			expect(observed.environment.PATH.split(":" )).not.toContain(poison);
			expect(observed.environment.LANG).toBe("C");
		}
	}
});

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
	const ciFiles: string[] = JSON.parse(command(["/usr/bin/python3", "-c",
		"import json,runpy,sys; print(json.dumps([p for p,_ in runpy.run_path(sys.argv[1])['CI_ONLY_FILES']]))",
		join(kit, "scripts/full-suite-verdict-store.py")]));
	for (const path of ciFiles) writeFileSync(join(repo, path),
		`import { expect, test } from "bun:test";\ntest("pinned qualification locale", () => { expect(process.env.LANG).toBe("C"); expect(process.env.PATH?.split(":")).not.toContain(${JSON.stringify(poison)}); });\n`);
	writeFileSync(join(repo, "tests/cli/control.test.sh"), "#!/bin/sh\nprintf 'ACTUAL_SUITE_RAN\\n'\n");
	const git = (...args: string[]) => command(["git", "-C", repo, ...args]);
	git("init", "-q", "--template=", "-b", "main");
	git("config", "user.name", "fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("add", "--", "scripts", "tests", ".github");
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
	const secondRun = await runFixtureAsync(argv, { cwd: kit, env: env(`/bin:/usr/bin:${poison}`, "caller-b"), floor_s: 30 });
	expect({ rc: secondRun.rc, out: text(secondRun.stdout), err: text(secondRun.stderr) }).toMatchObject({ rc: 0 });
	const second = text(secondRun.stdout);
	expect(second).toContain("VERDICT REUSED PASS");
	expect(second).not.toContain("ACTUAL_SUITE_RAN");
	const postPush = await runFixtureAsync(["/bin/sh", join(repo, "scripts/release-verdict.sh"),
		"--commit", "HEAD", "--no-fetch"], { cwd: repo,
		env: { ...env(`${poison}:/usr/bin:/bin`), FULL_SUITE_VERDICT_CACHE_DIR: cache }, floor_s: 30 });
	expect({ rc: postPush.rc, out: text(postPush.stdout), err: text(postPush.stderr) }).toMatchObject({ rc: 0 });
	expect(text(postPush.stdout)).toContain("reusing exact-tree main PASS");
	const ciRecords = readdirSync(join(cache, "ci-only")).filter(name => name.endsWith(".json"));
	expect(ciRecords).toHaveLength(1);
	const ciRecord = JSON.parse(readFileSync(join(cache, "ci-only", ciRecords[0]!), "utf8"));
	expect(ciRecord.environment).toEqual(record.environment);
	const ciLookup = ["/usr/bin/python3", join(kit, "scripts/full-suite-verdict-store.py"), "require-ci-only-pass",
		"--repo", repo, "--tree", record.tree, "--judge-root", kit, "--suite-root", repo, "--cache-dir", cache];
	expect(command(ciLookup, env(`${poison}:/usr/bin:/bin`))).toBe("PASS");
	ciRecord.environment.PATH += ":/planted-unjudged-tool";
	writeFileSync(join(cache, "ci-only", ciRecords[0]!), JSON.stringify(ciRecord));
	const tampered = runFixture(ciLookup, { cwd: kit, env: env(process.env.PATH!), floor_s: 30 });
	expect(tampered.rc).toBe(1);
	expect(text(tampered.stdout)).not.toBe("PASS\n");
	// Changing a real admitted input must still refuse reuse, not normalize a mismatch into PASS.
	const tree = git("rev-parse", "HEAD^{tree}");
	const lookup = ["/usr/bin/python3", join(kit, "scripts/full-suite-verdict-store.py"), "require-pass",
		"--repo", repo, "--tree", tree, "--role", "main", "--judge-root", kit, "--suite-root", repo, "--cache-dir", cache];
	expect(command(lookup, env(`${poison}:/usr/bin:/bin`))).toBe("PASS");
	const changed = runFixture(lookup, { cwd: kit, env: { ...env(process.env.PATH!), FULL_SUITE_RUNTIME_ID: "planted-change" }, floor_s: 60 });
	expect(changed.rc).toBe(1);
	expect(text(changed.stdout)).toContain("RUNTIME_MISMATCH");
}, fixtureDeadlineS(30) * 1000);
