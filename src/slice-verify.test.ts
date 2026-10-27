/** SLICEVERIFY1 (ompkit-t7cn7.7): behavior tests for src/slice-verify.ts.
 *
 * Units pin the bun-output parsers (required match, reject, boundary, long
 * near-miss), classification, deadlines and path validation. Integration builds
 * miniature git repos in owned scratch and runs the real verb: planted
 * negative (breaking overlay is introduced, exit 1) with a paired control
 * (a failure in both runs is pre-existing, never failing), foreign dirt
 * exclusion, setup-failure errors, shellcheck classification, title-linked
 * selection, a real overlay timeout with its honest note, and CLI wiring.
 */
import { expect, test } from "bun:test";
import { afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { ownedTmp, type OwnedTmp } from "./kitlib/tmp.ts";
import { run } from "./kitlib/run.ts";
import {
	classifyFailures,
	cleanRel,
	linkedRegistries,
	overlayDeadline,
	parseBunFailures,
	parseBunSummary,
	sliceVerify,
} from "./slice-verify.ts";

const repoRoot = join(import.meta.dir, "..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
});

function freshDir(prefix: string): string {
	const t = ownedTmp(`slice-verify-test-${prefix}`, { root: scratchRoot });
	owned.push(t);
	return t.path;
}

/** A miniature git repo: files committed hookless, node_modules present. */
async function fixtureRepo(files: Record<string, string>): Promise<string> {
	const root = freshDir("repo");
	const env = { ...process.env };
	const git = async (...args: string[]) => {
		const r = await run(["git", "-c", "core.hooksPath=/dev/null",
			"-c", "user.name=slice-verify-test", "-c", "user.email=slice-verify-test@invalid", ...args],
			{ cwd: root, deadline_s: 60, env: env as Record<string, string> });
		expect(r.rc).toBe(0);
	};
	await git("init", "-q", "-b", "main");
	mkdirSync(join(root, "node_modules"), { recursive: true });
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(join(root, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
		writeFileSync(join(root, rel), body);
	}
	await git("add", "-A");
	await git("commit", "-qm", "[test] slice-verify fixture base");
	return root;
}

function worktreeWrite(root: string, rel: string, body: string): void {
	writeFileSync(join(root, rel), body);
}

// Units: parsers, classification, deadlines, paths.

test("summary parses the real bun shape and rejects garbage", () => {
	const out = "tests/cli/readme-check.test.ts:\n(pass) a\n 12 pass\n 0 fail\n 50 expect() calls\n";
	expect(parseBunSummary(out)).toEqual({ pass: 12, fail: 0, found: true });
	expect(parseBunSummary("no summary here\n").found).toBe(false);
	expect(parseBunSummary("12 pass\n").found).toBe(false);
});

test("failures strip the timing and dedupe, ignoring passes", () => {
	const out = [
		"(pass) readme covers commands [12.00ms]",
		"(fail) fresh gate accepts rule-only edits without a committed manifest [5712.64ms]",
		"(fail) quick break [12ms]",
		"(fail) slow break [1.2s]",
		"(fail) fresh gate accepts rule-only edits without a committed manifest [5712.64ms]",
		"(fail)",
		"not a failure line (fail) x",
	].join("\n");
	expect(parseBunFailures(out)).toEqual([
		"fresh gate accepts rule-only edits without a committed manifest",
		"quick break",
		"slow break",
	]);
});

test("failures handle a long near-miss line exactly", () => {
	const long = `(fail) ${"x".repeat(100_000)}`;
	expect(parseBunFailures(long)).toEqual(["x".repeat(100_000)]);
	expect(parseBunFailures(`(fail) ${"y ".repeat(50_000)} [9.9ms]`)).toEqual([("y ".repeat(50_000)).trim()]);
	expect(parseBunFailures("x".repeat(200_000))).toEqual([]);
});

test("classification splits pre-existing from introduced", () => {
	expect(classifyFailures(["a", "b"], ["b", "c"])).toEqual({ preexisting: ["b"], introduced: ["c"] });
	expect(classifyFailures([], [])).toEqual({ preexisting: [], introduced: [] });
});

test("overlay deadline is eight times the base with a floor and a ceiling", () => {
	expect(overlayDeadline(10)).toBe(120);
	expect(overlayDeadline(100)).toBe(800);
	expect(overlayDeadline(0)).toBe(120);
	expect(overlayDeadline(1000)).toBe(1800);
});

test("cleanRel admits repo-relative paths and refuses escapes", () => {
	expect(cleanRel("a/b.test.ts")).toBe("a/b.test.ts");
	expect(cleanRel("")).toBeNull();
	expect(cleanRel("/abs/path")).toBeNull();
	expect(cleanRel("../escape")).toBeNull();
	expect(cleanRel("a/../../escape")).toBeNull();
	expect(cleanRel(".")).toBeNull();
});

test("linkedRegistries names a registry that cites the changed file", () => {
	const root = freshDir("registry");
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "cases"), { recursive: true });
	writeFileSync(join(root, "docs/flywheel-invariants.tsv"),
		"id\tfire\tquiet\nK1\tcli\ttests/victim.test.ts::Old title\ttests/other.test.ts::Other\n");
	writeFileSync(join(root, "cases/cases.tsv"), "rule\texpect\tpath\nr\tfire\tsrc/code.ts\n");
	expect(linkedRegistries(root, ["tests/victim.test.ts"])).toEqual([
		{ registry: "docs/flywheel-invariants.tsv", forChanged: "tests/victim.test.ts" },
	]);
	expect(linkedRegistries(root, ["src/unrelated.ts"])).toEqual([]);
	expect(linkedRegistries(root, ["src/code.ts"])).toEqual([{ registry: "cases/cases.tsv", forChanged: "src/code.ts" }]);
});

// Integration: planted negative with paired control.

const APP_TEST = `import { expect, test } from "bun:test";
import { broken } from "./dep.ts";
test("works", () => { expect(broken()).toBe("ok"); });
test("always fails", () => { expect(1).toBe(2); });
`;
const DEP_OK = `export function broken(): string { return "ok"; }\n`;
const DEP_BROKEN = `export function broken(): string { return "bust"; }\n`;

test("breaking overlay is introduced while a shared failure stays pre-existing", async () => {
	const root = await fixtureRepo({ "tests/app.test.ts": APP_TEST, "tests/dep.ts": DEP_OK });
	worktreeWrite(root, "tests/dep.ts", DEP_BROKEN);
	const res = await sliceVerify({ repo: root, overlay: ["tests/dep.ts"], tests: ["tests/app.test.ts"] });
	expect(res.exitCode).toBe(1);
	expect(res.code).toBe("INTRODUCED");
	expect(res.files).toHaveLength(1);
	const file = res.files[0]!;
	expect(file.base.counts).toEqual({ pass: 1, fail: 1, found: true });
	expect(file.overlay.failures).toContain("works");
	expect(file.preexisting).toEqual(["always fails"]);
	expect(file.introduced).toEqual(["works"]);
	expect(res.log.join("\n")).toContain("INTRODUCED tests/app.test.ts");
}, 300_000);

test("an identical overlay leaves a shared failure pre-existing and clean", async () => {
	const root = await fixtureRepo({ "tests/app.test.ts": APP_TEST, "tests/dep.ts": DEP_OK });
	worktreeWrite(root, "tests/dep.ts", `${DEP_OK}// touch\n`);
	const res = await sliceVerify({ repo: root, overlay: ["tests/dep.ts"], tests: ["tests/app.test.ts"] });
	expect(res.exitCode).toBe(0);
	expect(res.code).toBe("CLEAN");
	expect(res.files[0]!.preexisting).toEqual(["always fails"]);
	expect(res.files[0]!.introduced).toEqual([]);
}, 300_000);

test("foreign dirt never reaches either run", async () => {
	const root = await fixtureRepo({
		"tests/app.test.ts": `import { expect, test } from "bun:test";\ntest("works", () => { expect(1).toBe(1); });\n`,
		"tests/dep.ts": DEP_OK,
	});
	worktreeWrite(root, "tests/foreign.test.ts",
		`import { expect, test } from "bun:test";\ntest("foreign breaks", () => { expect(1).toBe(2); });\n`);
	const res = await sliceVerify({ repo: root, overlay: ["tests/dep.ts"], tests: ["tests/app.test.ts"] });
	expect(res.exitCode).toBe(0);
	expect(res.code).toBe("CLEAN");
	for (const f of res.files) {
		expect([...f.base.failures, ...f.overlay.failures].join("\n")).not.toContain("foreign breaks");
	}
}, 300_000);

test("an unresolvable base is an error on which no test runs", async () => {
	const root = await fixtureRepo({ "tests/dep.ts": DEP_OK });
	const res = await sliceVerify({ repo: root, base: "deadbeef", overlay: ["tests/dep.ts"], tests: ["tests/dep.ts"] });
	expect(res.exitCode).toBe(2);
	expect(res.code).toBe("ERROR");
	expect(res.error).toContain("INVALID_BASE");
	expect(res.files).toEqual([]);
}, 120_000);

test("a test file that exits silently is an error, never clean", async () => {
	const root = await fixtureRepo({
		"tests/quit.test.ts": `process.exit(0);\n`,
		"tests/dep.ts": DEP_OK,
	});
	const res = await sliceVerify({ repo: root, overlay: ["tests/dep.ts"], tests: ["tests/quit.test.ts"] });
	expect(res.exitCode).toBe(2);
	expect(res.code).toBe("ERROR");
	expect(res.error).toContain("NO_VERDICT");
}, 120_000);

test("a missing shellcheck runner is an error, never a pass", async () => {
	const root = await fixtureRepo({ "scripts/job.sh": "#!/bin/sh\nexit 0\n", "tests/dep.ts": DEP_OK });
	const res = await sliceVerify({ repo: root, overlay: ["scripts/job.sh"], tests: ["tests/dep.ts"], env: { DOCKER_BIN: "/nonexistent-probe-docker-bin" } });
	expect(res.exitCode).toBe(2);
	expect(res.code).toBe("ERROR");
	expect(res.error).toContain("SHELLCHECK_UNAVAILABLE");
}, 120_000);

test("a shellcheck finding on an overlaid script is introduced", async () => {
	const root = await fixtureRepo({
		"scripts/job.sh": "#!/bin/sh\nexit 0\n",
		"tests/dep.ts": DEP_OK,
		"tests/app.test.ts": `import { expect, test } from "bun:test";\ntest("works", () => { expect(1).toBe(1); });\n`,
	});
	worktreeWrite(root, "scripts/job.sh", "#!/bin/sh\necho SC_EVIL\n");
	const res = await sliceVerify({
		repo: root, overlay: ["scripts/job.sh"], tests: ["tests/app.test.ts"],
		env: { DOCKER_BIN: join(repoRoot, "tests/fixtures/slice-verify/fake-shellcheck.sh") },
	});
	expect(res.exitCode).toBe(1);
	expect(res.code).toBe("INTRODUCED");
	expect(res.shellcheck).toHaveLength(1);
	expect(res.shellcheck[0]!.clean).toBe(false);
	expect(res.shellcheck[0]!.detail).toContain("SC_EVIL");
}, 300_000);

test("title-linked selection picks the registry reader for a changed test", async () => {
	const root = await fixtureRepo({
		"docs/flywheel-invariants.tsv": "id\tfire\tquiet\nK9\tcli\ttests/victim.test.ts::Old title\ttests/victim.test.ts::Old title\n",
		"tests/victim.test.ts": `import { expect, test } from "bun:test";\ntest("Old title", () => { expect(1).toBe(1); });\n`,
		"tests/title-reader.test.ts": `import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("registry names victim", () => { expect(readFileSync("docs/flywheel-invariants.tsv", "utf8")).toContain("victim"); });\n`,
		"tests/dep.ts": DEP_OK,
	});
	worktreeWrite(root, "tests/victim.test.ts",
		`import { expect, test } from "bun:test";\ntest("New title", () => { expect(1).toBe(1); });\n`);
	const res = await sliceVerify({ repo: root, overlay: ["tests/victim.test.ts"] });
	expect(res.selection.linked).toEqual([{ registry: "docs/flywheel-invariants.tsv", forChanged: "tests/victim.test.ts" }]);
	expect(res.selection.tests).toContain("tests/title-reader.test.ts");
	expect(res.exitCode).toBe(0);
}, 300_000);
// Real ~120 s wall wait: the overlay deadline is measured from the same platform
// clock the run is killed by, so fake timers cannot exercise the timeout path.
test("an overlay that hangs past its measured deadline is introduced as TIMEOUT", async () => {
	const root = await fixtureRepo({
		"tests/sleep.test.ts": `import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("sleeps", async () => { const ms = Number(readFileSync("tests/sleep-ms.txt", "utf8").trim()); await new Promise(r => setTimeout(r, ms)); expect(true).toBe(true); });\n`,
		"tests/sleep-ms.txt": "100\n",
	});
	worktreeWrite(root, "tests/sleep-ms.txt", "200000\n");
	const res = await sliceVerify({ repo: root, overlay: ["tests/sleep-ms.txt"], tests: ["tests/sleep.test.ts"] });
	expect(res.exitCode).toBe(1);
	expect(res.code).toBe("INTRODUCED");
	const file = res.files[0]!;
	expect(file.overlay.timedOut).toBe(true);
	expect(file.introduced.some(n => n.startsWith("TIMEOUT after "))).toBe(true);
	expect(res.log.join("\n")).toContain(`TIMEOUT after ${Math.min(1800, Math.max(120, Math.ceil(8 * file.base.elapsedS)))}s`);
}, 300_000);

test("the CLI wires slice-verify flags to the verb", async () => {
	const root = await fixtureRepo({ "tests/app.test.ts": APP_TEST, "tests/dep.ts": DEP_OK });
	worktreeWrite(root, "tests/dep.ts", DEP_BROKEN);
	const code = await runCli(["slice-verify", "--overlay", "tests/dep.ts", "--test", "tests/app.test.ts", "--project", root]);
	expect(code).toBe(1);
	const clean = await runCli(["slice-verify", "--overlay", "tests/dep.ts", "--project", root, "--changed-file", "tests/dep.ts", "--test", "tests/app.test.ts"]);
	expect(clean).toBe(1);
}, 300_000);
