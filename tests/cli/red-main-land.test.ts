import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run, type RunResult } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("red-main-land");
const template = join(scratch.path, "template");
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const output = (value: { stdout: Uint8Array; stderr: Uint8Array }) => decode(value.stdout) + decode(value.stderr);
const cleanEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BEADS_DB"]) delete cleanEnv[key];
const env = {
	...cleanEnv,
	HOME: join(scratch.path, "home"), XDG_CONFIG_HOME: join(scratch.path, "config"),
	XDG_STATE_HOME: join(scratch.path, "state"), TMPDIR: scratch.path,
	GIT_CEILING_DIRECTORIES: scratch.path,
	FULL_SUITE_VERDICT_CACHE_DIR: join(scratch.path, "installation-store"),
	GIT_AUTHOR_NAME: "Red landing fixture", GIT_AUTHOR_EMAIL: "red@example.invalid",
	GIT_COMMITTER_NAME: "Red landing fixture", GIT_COMMITTER_EMAIL: "red@example.invalid",
};

async function command(argv: string[], cwd: string, overrides: Record<string, string> = {}) {
	return run(argv, { cwd, env: { ...env, ...overrides }, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4 << 20 });
}
async function checked(argv: string[], cwd: string, overrides: Record<string, string> = {}) {
	const result = await command(argv, cwd, overrides);
	expect({ rc: result.rc, timedOut: result.timed_out, truncated: result.truncated }, output(result))
		.toEqual({ rc: 0, timedOut: false, truncated: false });
	return decode(result.stdout).trim();
}

beforeAll(async () => {
	mkdirSync(template, { recursive: true });
	mkdirSync(env.HOME, { recursive: true });
	await checked(["git", "init", "-q", "--template=", "-b", "main"], template);
	mkdirSync(join(template, "tests/cli"), { recursive: true });
	writeFileSync(join(template, "tests/cli/broken.test.sh"), "exit 1\n");
	writeFileSync(join(template, "notes.txt"), "root\n");
	await checked(["git", "add", "tests/cli/broken.test.sh", "notes.txt"], template);
	await checked(["git", "commit", "-q", "-m", "[test] first red", "-m", "Bead: ompkit-x"], template);
	await checked(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], template);
	await checked(["git", "remote", "add", "origin", join(scratch.path, "origin.git")], template);
	await checked(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", template], root);
	// Exercise the actual installed member through git commit, while isolating
	// unrelated tracker/policy members from this member's planted verdict cases.
	for (const hook of ["pre-commit", "reference-transaction"]) chmodSync(join(template, ".git/hooks", hook), 0o644);
	writeFileSync(join(template, ".git/hooks/commit-msg"), '#!/bin/sh\nexec sh "$(dirname "$0")/hooks.d/commit-msg/55-omp-kit-commit-gate" "$@"\n');
	chmodSync(join(template, ".git/hooks/commit-msg"), 0o755);
	if (process.env.RED_MAIN_INCUMBENT_GATE)
		copyFileSync(process.env.RED_MAIN_INCUMBENT_GATE, join(template, ".git/hooks/hooks.d/commit-msg/55-omp-kit-commit-gate"));
}, fixtureDeadlineS(90) * 1000);
afterAll(() => scratch.cleanup());

let sequence = 0, commitSequence = 0;
interface Fixture { repo: string; store: string; overrides: Record<string, string>; sha: string }
async function fixture(): Promise<Fixture> {
	const repo = join(scratch.path, `case-${++sequence}`);
	cpSync(template, repo, { recursive: true });
	const store = join(repo, "verdict-store");
	const overrides = { FULL_SUITE_VERDICT_CACHE_DIR: store };
	mkdirSync(store);
	const sha = await checked(["git", "rev-parse", "HEAD"], repo);
	return { repo, store, overrides, sha };
}

// Plant complete structured records using the same schema/validation functions
// the producer uses. Every case owns its store; no machine verdict is read/written.
async function record(f: Fixture, mode: string, options: { culprit?: boolean; flakes?: string[]; extraFailure?: string; stamp?: number; commit?: string } = {}) {
	const program = `
import hashlib, importlib.util, json, pathlib, sys
root, repo, directory, mode, options = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4], json.loads(sys.argv[5])
spec = importlib.util.spec_from_file_location("store", root / "scripts/full-suite-verdict-store.py")
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
sha = options.get("commit") or s.checked_run(["git", "-C", str(repo), "rev-parse", "refs/remotes/origin/main"]).decode().strip()
tree = s.checked_run(["git", "-C", str(repo), "rev-parse", sha + "^{tree}"]).decode().strip()
environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
checks, runtime, stamp = "a" * 64, "Darwin/arm64/fixture/env-" + s.load_metrics(root).environment_digest(environment), options.get("stamp", 1)
metrics = s.load_metrics(root)
names = ["tests/cli/broken.test.sh"] + ([options["extraFailure"]] if options.get("extraFailure") else [])
judge = {"sha256": metrics.JUDGE_SHA256, "python": sys.version.split()[0]}
files = [{"path": name, "runner": "sh", "elapsed_ms": 1, "started_ms": 1, "finished_ms": 2, "wait_ms": 0, "setup_ms": 0, "run_ms": 1, "phase_basis": "stage-queue+exec-marker", "cpu_user_ms": 0, "cpu_system_ms": 0, "rc": int(mode == "FAIL"), "command": ["sh", name], "complete": True, "judge": judge, "output_sha256": hashlib.sha256(b"fixture").hexdigest(), "closure": {"kind": "whole-source-tree", "tree": tree}} for name in names]
log = b"planted full-suite release verdict\\n"
path = directory / (s.record_key(tree, "main", checks, runtime) + ".json")
entry = {"version": 3, "tree": tree, "judge_role": "main", "checks": checks, "runtime": runtime, "judge": {"role": "main", "checks_sha256": checks, "runtime": runtime}, "verdict": mode, "exit_code": int(mode == "FAIL"), "timing": {"started_ms": stamp, "wall_ms": 1}, "evidence": {"complete": True, "files": files, "declared_files": names, "bun_files": 0, "bun_ran": 0, "bun_fail": 0, "shell_suites": len(files), "shell_fail": len(files) if mode == "FAIL" else 0, "py_suites": 0, "py_fail": 0, "log_sha256": hashlib.sha256(log).hexdigest()}}
if options.get("culprit"):
    entry["culprit"] = {"sha": sha, "author": "red@example.invalid", "bead": "ompkit-x", "failing_files": names, "method": "bisect", "reason": ""}
if "flakes" in options:
    entry["culprit"] = {"sha": None, "author": None, "bead": None, "failing_files": options["flakes"], "method": "flake-rerun", "reason": "flake: passes on rerun at head"}
path.with_suffix(".log").write_bytes(log); path.write_text(json.dumps(entry))
if mode in ("PASS", "FAIL"):
    valid, reason = s.validate_record(path, judge_root=root, historical=True)
    assert valid is not None, reason
print(path)
`;
	return checked(["python3", "-B", "-c", program, root, f.repo, f.store, mode, JSON.stringify(options)], f.repo, f.overrides);
}
async function commit(f: Fixture, message = "[test] unrelated", path = "notes.txt") {
	writeFileSync(join(f.repo, path), `case ${sequence} commit ${++commitSequence}\n`);
	await checked(["git", "add", path], f.repo, f.overrides);
	return command(["git", "commit", "-q", "-m", message], f.repo, f.overrides);
}
// SAVEALONGSIDE1 (J-2026-11-08-11): a red release verdict is reported at every commit and never blocks the save.
async function reported(f: Fixture, result: RunResult, sha: string, file = "tests/cli/broken.test.sh") {
	expect(result.rc, output(result)).toBe(0);
	expect(output(result)).toContain("commit-gate: RED release verdict (releases wait, saves continue)");
	expect(output(result)).not.toContain("RED FIX admitted");
	expect(output(result)).toContain(`first recorded red commit ${sha}`);
	expect(output(result)).toContain(file);
	expect(await checked(["git", "rev-parse", "HEAD"], f.repo, f.overrides)).not.toBe(sha);
}

test("SAVEALONGSIDE1 an unrelated commit on red main lands and names the first red SHA, failing tests and bead", async () => {
	const f = await fixture();
	await record(f, "FAIL", { culprit: true });
	const result = await commit(f);
	await reported(f, result, f.sha);
	expect(output(result)).toContain("bead ompkit-x");
}, fixtureDeadlineS(60) * 1000);

for (const repair of ["trailer", "failing-file"]) test(`REDMAINLAND1 admits ${repair} repair of red main`, async () => {
	const f = await fixture();
	await record(f, "FAIL", { culprit: true });
	const result = repair === "trailer"
		? await commit(f, "[test] repair\n\nFixes-Red: ompkit-x")
		: await commit(f, "[test] repair", "tests/cli/broken.test.sh");
	expect(result.rc, output(result)).toBe(0);
	expect(output(result)).toContain("RED FIX admitted");
}, fixtureDeadlineS(60) * 1000);

test("REDMAINLAND1 green full-suite record admits without UNKNOWN", async () => {
	const f = await fixture();
	await record(f, "PASS");
	const result = await commit(f);
	expect(result.rc, output(result)).toBe(0);
	expect(output(result)).not.toContain("UNKNOWN");
}, fixtureDeadlineS(60) * 1000);

for (const mode of ["absent", "PENDING", "corrupt"]) test(`REDMAINLAND1 ${mode} evidence admits with one UNKNOWN notice`, async () => {
	const f = await fixture();
	if (mode === "PENDING") await record(f, mode);
	if (mode === "corrupt") {
		const path = await record(f, "FAIL"); writeFileSync(path, "{not JSON");
	}
	const result = await commit(f);
	expect(result.rc, output(result)).toBe(0);
	expect(output(result).split("UNKNOWN")).toHaveLength(2);
}, fixtureDeadlineS(60) * 1000);

test("REDMAINLAND1 existing flake-rerun clearance admits without weakening uncleared failures", async () => {
	const f = await fixture();
	await record(f, "FAIL", { flakes: ["tests/cli/broken.test.sh"] });
	expect((await commit(f)).rc).toBe(0);
	await record(f, "FAIL", { flakes: ["tests/cli/broken.test.sh"], extraFailure: "tests/cli/still-red.test.sh" });
	await reported(f, await commit(f, "[test] still unrelated"), f.sha, "tests/cli/still-red.test.sh");
}, fixtureDeadlineS(60) * 1000);

test("SAVEALONGSIDE1 unstaged failing-file edits and malformed Fixes-Red are reported as RED, not as a repair", async () => {
	const f = await fixture();
	await record(f, "FAIL");
	writeFileSync(join(f.repo, "tests/cli/broken.test.sh"), "exit 0\n");
	await reported(f, await commit(f, "[test] unrelated\n\nFixes-Red: not-a-bead!"), f.sha);
}, fixtureDeadlineS(60) * 1000);

test("REDMAINLAND1 latest stored PASS supersedes an older FAIL for the same tree", async () => {
	const f = await fixture();
	const path = await record(f, "FAIL", { stamp: 1 });
	// Different judge identities can coexist; preserve the validated old record.
	const old = JSON.parse(readFileSync(path, "utf8"));
	old.checks = "b".repeat(64); old.judge.checks_sha256 = old.checks;
	const script = 'import importlib.util,json,pathlib,sys; spec=importlib.util.spec_from_file_location("s",pathlib.Path(sys.argv[1])/"scripts/full-suite-verdict-store.py"); s=importlib.util.module_from_spec(spec); spec.loader.exec_module(s); e=json.loads(sys.argv[2]); print(s.record_key(e["tree"],"main",e["checks"],e["runtime"])+".json")';
	const oldName = await checked(["python3", "-B", "-c", script, root, JSON.stringify(old)], f.repo, f.overrides);
	writeFileSync(join(f.store, oldName), JSON.stringify(old));
	copyFileSync(path.slice(0, -5) + ".log", join(f.store, oldName.slice(0, -5) + ".log"));
	await record(f, "PASS", { stamp: 2 });
	const result = await commit(f);
	expect(result.rc, output(result)).toBe(0);
	expect(output(result)).not.toContain("UNKNOWN");
}, fixtureDeadlineS(60) * 1000);

test("REDMAINLAND1 first red lookup crosses unjudged heads but stops at a recorded green", async () => {
	const f = await fixture();
	await record(f, "PASS");
	expect((await commit(f, "[test] introduced failure")).rc).toBe(0);
	const first = await checked(["git", "rev-parse", "HEAD"], f.repo, f.overrides);
	await record(f, "FAIL", { commit: first });
	// Publish two further fixture heads without running the commit gate, as the
	// background release producer can coalesce intermediate pushed heads.
	await checked(["git", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-q", "-m", "[test] unjudged"], f.repo, f.overrides);
	writeFileSync(join(f.repo, "notes.txt"), "newest published head\n");
	await checked(["git", "add", "notes.txt"], f.repo, f.overrides);
	await checked(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "[test] latest red"], f.repo, f.overrides);
	await checked(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], f.repo, f.overrides);
	await record(f, "FAIL");
	await reported(f, await commit(f), first);
}, fixtureDeadlineS(60) * 1000);


test("REDMAINLAND1 another branch is not held by main's release verdict", async () => {
	const f = await fixture();
	await record(f, "FAIL");
	await checked(["git", "checkout", "-q", "-b", "side"], f.repo, f.overrides);
	const result = await commit(f);
	expect(result.rc, output(result)).toBe(0);
	expect(output(result)).not.toContain("REFUSED");
}, fixtureDeadlineS(60) * 1000);

test("REDMAINLAND1 commit --only judges its prospective index, not another staged repair", async () => {
	const f = await fixture();
	await record(f, "FAIL");
	writeFileSync(join(f.repo, "tests/cli/broken.test.sh"), "exit 0\n");
	writeFileSync(join(f.repo, "notes.txt"), "unrelated only commit\n");
	await checked(["git", "add", "tests/cli/broken.test.sh"], f.repo, f.overrides);
	await reported(f, await command(["git", "commit", "--only", "notes.txt", "-q", "-m", "[test] not the repair"], f.repo, f.overrides), f.sha);
	const repair = await command(["git", "commit", "--only", "tests/cli/broken.test.sh", "-q", "-m", "[test] actual repair"], f.repo, f.overrides);
	expect(repair.rc, output(repair)).toBe(0);
	expect(output(repair)).toContain("RED FIX admitted");
}, fixtureDeadlineS(60) * 1000);
