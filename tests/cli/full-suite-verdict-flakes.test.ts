import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

// RELFLAKE1: exercise the real producer and canonical reader on tiny committed suites.
const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("full-suite-flakes").path;
afterAll(cleanupAllOwnedTmp);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const env = { ...process.env, GIT_CEILING_DIRECTORIES: scratch, FULL_SUITE_JOBS: "1", FULL_SUITE_REMOTE: "0" };
function command(argv: string[], cwd: string) {
	return runFixture(argv, { cwd, env, floor_s: 120 });
}
function git(repo: string, ...args: string[]) {
	const result = command(["git", "-C", repo, ...args], repo);
	expect(decode(result.stderr)).toBe("");
	expect(result.rc).toBe(0);
	return decode(result.stdout).trim();
}
function fixture(name: string, files: number, alwaysFail = false, role = "main") {
	const repo = join(scratch, name);
	const cache = join(scratch, `${name}-cache`);
	mkdirSync(join(repo, "tests/cli"), { recursive: true });
	mkdirSync(join(repo, "scripts"));
	copyFileSync(join(root, "scripts/kitlib-tmp.sh"), join(repo, "scripts/kitlib-tmp.sh"));
	for (let i = 0; i < files; i++) {
		writeFileSync(join(repo, `tests/cli/f${i}_test.py`), `from pathlib import Path\nimport sys\np = Path('attempt-${i}')\nn = int(p.read_text()) + 1 if p.exists() else 1\np.write_text(str(n))\nprint('attempt', n, flush=True)\nsys.exit(1 if ${alwaysFail ? "True" : "n == 1"} else 0)\n`);
	}
	git(repo, "init", "-q", "--template=", "-b", "main");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "user.name", "fixture");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "fixture [test]");
	const sha = git(repo, "rev-parse", "HEAD");
	const tree = git(repo, "rev-parse", "HEAD^{tree}");
	const result = command(["sh", process.env.FULL_SUITE_VERDICT_UNDER_TEST ?? join(root, "scripts/full-suite-verdict.sh"),
		"--repo", repo, "--commit", sha, "--judge-role", role, "--archive-dir", repo, "--cache-dir", cache], root);
	const filename = readdirSync(cache).find(file => file.endsWith(".json") && file.startsWith(tree));
	expect(filename).toBeDefined();
	const recordPath = join(cache, filename!);
	const record = JSON.parse(readFileSync(recordPath, "utf8"));
	const lookup = () => command(["python3", join(root, "scripts/full-suite-verdict-store.py"), "require-pass",
		"--repo", repo, "--tree", tree, "--role", role, "--judge-root", root, "--suite-root", repo, "--cache-dir", cache]);
	return { repo, cache, result, recordPath, record, lookup, tree };
}

test("one failing file gets exactly one rerun, named PASS evidence and an intact original log", () => {
	const f = fixture("once", 1);
	expect(decode(f.result.stderr)).not.toContain("VERDICT FAIL");
	expect(f.result.rc).toBe(0);
	expect(f.record.verdict).toBe("PASS");
	expect(f.record.flakes).toEqual([{ file: "tests/cli/f0_test.py", first_fail_tests: 1, rerun: "pass" }]);
	expect(readFileSync(join(f.repo, "attempt-0"), "utf8")).toBe("2");
	const log = readFileSync(f.recordPath.slice(0, -5) + ".log", "utf8");
	expect(log).toContain("attempt 1");
	expect(log).toContain("attempt 2");
	expect(f.record.evidence.files[0].rc).toBe(1);
	expect(f.record.evidence.reruns[0].rc).toBe(0);
	expect(decode(f.lookup().stdout).trim()).toBe("PASS");
	// A label alone is never permission to ignore a failure.
	f.record.evidence.reruns[0].rc = 1;
	writeFileSync(f.recordPath, JSON.stringify(f.record));
	expect(f.lookup().rc).toBe(1);
}, fixtureDeadlineS(180) * 1000);

test("a twice-failing file remains FAIL and is named", () => {
	const f = fixture("twice", 1, true);
	expect(f.result.rc).not.toBe(0);
	expect(f.record.verdict).toBe("FAIL");
	expect(decode(f.result.stderr)).toContain("twice-failing file: tests/cli/f0_test.py");
	expect(readFileSync(join(f.repo, "attempt-0"), "utf8")).toBe("2");
	expect(f.lookup().rc).toBe(1);
}, fixtureDeadlineS(180) * 1000);

test("four failing files are broad failure, never rerun", () => {
	const f = fixture("broad", 4);
	expect(f.result.rc).not.toBe(0);
	expect(f.record.verdict).toBe("FAIL");
	for (let i = 0; i < 4; i++) expect(readFileSync(join(f.repo, `attempt-${i}`), "utf8")).toBe("1");
	expect(f.record.evidence.reruns ?? []).toEqual([]);
}, fixtureDeadlineS(180) * 1000);

test("base-role FAIL never receives release flake policy", () => {
	const f = fixture("base", 1, false, "base");
	expect(f.result.rc).not.toBe(0);
	expect(readFileSync(join(f.repo, "attempt-0"), "utf8")).toBe("1");
	expect(f.record.flakes).toBeUndefined();
}, fixtureDeadlineS(180) * 1000);
