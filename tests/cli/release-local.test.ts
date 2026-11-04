import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

// LOCAL-RELEASE-V1 (ompkit-v66l.27.11, docs/release-signing.md): enabling release.yml must never start the
// expensive pipeline. Its default mode runs only attest-local; every other job needs mode=ci-pipeline.
const ROOT = join(import.meta.dir, "..", "..");
type Job = { if?: string; needs?: string | string[]; steps?: { run?: string; uses?: string; with?: Record<string, unknown> }[] };
type Workflow = { on: Record<string, { inputs?: Record<string, { default?: unknown; options?: string[] }> } | null>; jobs: Record<string, Job> };
const release = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as Workflow;

test("release.yml has only a manual trigger and defaults to local-attest", () => {
	expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
	const mode = release.on.workflow_dispatch!.inputs!.mode!;
	expect(mode.default).toBe("local-attest");
	expect(mode.options).toEqual(["local-attest", "ci-pipeline"]);
});

test("every pipeline job requires the explicit ci-pipeline mode; attest-local requires local-attest", () => {
	const jobs = Object.entries(release.jobs);
	expect(jobs.length).toBeGreaterThan(5);
	for (const [name, job] of jobs) {
		if (name === "attest-local") expect(job.if).toStartWith("inputs.mode == 'local-attest' &&");
		else expect(job.if ?? "").toContain("inputs.mode == 'ci-pipeline' &&");
	}
	// The negative control: a job without the gate fails the same check.
	expect("github.event.repository.private == false").not.toContain("inputs.mode == 'ci-pipeline' &&");
});

test("attest-local verifies the draft and the consumer policy before it publishes", () => {
	const steps = release.jobs["attest-local"]!.steps!;
	const scripts = steps.map(step => step.run ?? "").join("\n");
	expect(scripts).toContain('[[ "$GITHUB_REF" == "refs/tags/v$VERSION" ]]');
	expect(scripts).toContain("sha256sum --strict -c SHA256SUMS");
	expect(scripts).toContain("mkdir dist sbom"); // v0.2.56's attest-local died on ENOENT writing sbom/ (run 39205018538)
	expect(scripts).toContain('python3 -I -c "$(cat installer/install.py)" attestation "$archive" "$VERSION" unused');
	expect(scripts).toContain("--signer-workflow \"$GITHUB_REPOSITORY/.github/workflows/release.yml\"");
	expect(scripts).not.toContain("--clobber");
	const order = steps.map(step => step.uses?.split("@")[0] ?? (step.run?.includes("--draft=false") ? "publish" : step.run?.includes("attestation \"$archive\"") ? "consumer-verify" : "run"));
	expect(order.indexOf("actions/attest-build-provenance")).toBeLessThan(order.indexOf("consumer-verify"));
	expect(order.indexOf("consumer-verify")).toBeLessThan(order.indexOf("publish"));
});

test("the train's release.yml dispatches pass mode=ci-pipeline", () => {
	const reuse = readFileSync(join(ROOT, "scripts/release_reuse.py"), "utf8");
	expect(reuse).toContain('RELEASE_PIPELINE_MODE = "ci-pipeline"');
	const dispatches = reuse.split("\n").filter(line => line.includes("_native_dispatch(") && line.includes('"release.yml"'));
	expect(dispatches.length).toBe(3);
	expect(reuse.split('"mode": RELEASE_PIPELINE_MODE').length - 1).toBe(3);
	const train = readFileSync(join(ROOT, ".github/workflows/release-train.yml"), "utf8");
	for (const line of train.split("\n").filter(line => line.includes("gh workflow run release.yml"))) expect(line).toContain("-f mode=ci-pipeline");
});

test("release-local.sh dry run never pushes or reaches a GitHub write", () => {
	const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
	// The dry-run branch may open with comment lines (a shellcheck directive for its `ls`) before its say.
	const dryExit = script.search(/if \[ "\$DRY_RUN" = 1 \]; then\n(?:\t#[^\n]*\n)*\tsay "dry run/);
	expect(dryExit).toBeGreaterThan(0);
	for (const write of ["push --porcelain origin", "gh release create", "gh workflow run release.yml"])
		expect(script.indexOf(write)).toBeGreaterThan(dryExit);
	expect(script.split("\n").filter(line => line.includes(" push ") && line.includes("--force"))).toEqual([]);
	expect(script).toContain('if [ "$DRY_RUN" = 1 ]; then\n\t\tsay "dry run prepare: committed');
	expect(script).not.toContain("-f mode=ci-pipeline");
	expect(Bun.spawnSync(["bash", "-n", join(ROOT, "scripts/release-local.sh")]).exitCode).toBe(0);
});

test("release-local runs the bundled TTSR selftest after coverage, and its removal is RED", () => {
	const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
	const gate = script.indexOf('stage rule-gate');
	const selftest = script.indexOf('ttsr-harness.ts" --selftest', gate);
	expect(gate).toBeGreaterThanOrEqual(0);
	expect(selftest).toBeGreaterThan(gate);
	expect(script.slice(gate, selftest)).toContain('ttsr-harness.ts" --gate-json');
	expect(script.slice(selftest)).toContain('die "ttsr-harness --selftest failed');

	// Planted negative: removing the selftest invocation must fail this contract.
	const mutant = script.replace(/\nbounded 600 bun "\$SRC\/scripts\/ttsr-harness\.ts" --selftest[^]*?say "rule selftest PASS"\n/, "\n");
	expect(mutant).not.toContain('ttsr-harness.ts" --selftest');
	expect(mutant.slice(gate)).not.toContain('die "ttsr-harness --selftest failed');
});

test("release gate refuses a kit rule with its fire fixture removed", () => {
	const work = realpathSync(ownedTmp("kitpost-gate", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const cases = join(ROOT, "cases", "cases.tsv");
	const mutated = join(work, "cases.tsv");
	try {
		cpSync(cases, mutated);
		const rows = readFileSync(mutated, "utf8").split("\n").map(row => row.endsWith("\r") ? row.slice(0, -1) : row);
		const target = "bash-pipe-exit\tfire\t";
		const index = rows.findIndex(row => row.startsWith(target));
		if (index < 0) throw new Error("KITPOST fixture is missing its fire row");
		rows.splice(index, 1);
		writeFileSync(mutated, rows.join("\n"));
		const run = (casesPath: string) => Bun.spawnSync(["bun", "scripts/ttsr-harness.ts", "--gate-json",
			"--rules", join(ROOT, "rules"), "--cases", casesPath], {
			// No HOME-derived OMP_SRC: rule-class.ts resolves the launcher's exact-version package itself
			// (beside the launcher, bun global, or the OMP_KIT_OMP_SRC_CACHE source cache under the scrub).
			cwd: ROOT, env: { ...process.env },
			stdout: "pipe", stderr: "pipe",
		});
		const control = run(cases);
		expect(control.exitCode, control.stderr.toString()).toBe(0);
		const negative = run(mutated);
		expect(negative.exitCode).not.toBe(0);
		expect(negative.stdout.toString() + negative.stderr.toString()).toContain("COVERAGE bash-pipe-exit");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

// RELFAILFAST1 (ompkit-fp72.120.16.104, Joshua J-2026-11-03-34): heavy admission is asked in preflight, in seconds,
// instead of being discovered by the ci-only stage's 900 s timeout. Stubs: gh (authenticated), omp-kit (admission),
// git (records the fetch and fails it, so a passing probe stops right after preflight's next step).
test.skipIf(process.platform !== "darwin")("RELFAILFAST1 preflight refuses at once when heavy work cannot be admitted", async () => {
	const work = realpathSync(ownedTmp("relfailfast", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const bin = join(work, "bin");
	mkdirSync(bin);
	const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
	stub("gh", "exit 0");
	stub("git", `echo called >> "${join(work, "git-called")}"; exit 1`);
	// Stub admission: 75 = heavy refuses under any observer (statfs below the 10 GiB floor); "sbh" = only the sbh
	// observer reports pressure, so the statfs-observed probe must admit (ompkit-fp72.120.16.155).
	const attempt = async (admission: 0 | 75 | "sbh") => {
		stub("omp-kit", admission === 75 ? "echo 'heavy: waiting: disk low: statfs 4 GiB free, floor 10 GiB' >&2; exit 75"
			: admission === "sbh" ? `[ "$OMP_KIT_DISK_OBSERVER" = statfs ] && exit 0; echo 'heavy: waiting: disk low: sbh check --need 10G reports pressure' >&2; exit 75`
			: "exit 0");
		rmSync(join(work, "git-called"), { force: true });
		const started = Date.now();
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
		const result = await run(["bash", join(ROOT, "scripts/release-local.sh"), "--dry-run", "--version", "9.9.9"], {
			deadline_s: fixtureDeadlineS(60), cwd: ROOT, env: { ...env, PATH: `${bin}:${env.PATH ?? ""}`, TMPDIR: work },
		});
		return { rc: result.rc, err: new TextDecoder().decode(result.stderr), ms: Date.now() - started, gitCalled: existsSync(join(work, "git-called")) };
	};
	try {
		const held = await attempt(75);
		expect(held.rc, held.err).toBe(4);
		expect(held.err).toContain("heavy work cannot be admitted now");
		expect(held.err).toContain("disk low");
		expect(held.gitCalled).toBe(false);
		expect(held.ms).toBeLessThan(10_000);
		// Control: with admission available, preflight passes the probe and reaches its next step (the stubbed fetch).
		const admitted = await attempt(0);
		expect(admitted.rc, admitted.err).toBe(4);
		expect(admitted.err).toContain("git fetch origin main failed");
		expect(admitted.gitCalled).toBe(true);
		// Planted: sbh reports pressure while statfs is above the floor; the ci-only stage observes statfs, so admit.
		const sbhOnly = await attempt("sbh");
		expect(sbhOnly.rc, sbhOnly.err).toBe(4);
		expect(sbhOnly.err).not.toContain("heavy work cannot be admitted now");
		expect(sbhOnly.err).toContain("git fetch origin main failed");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
// Three release-local preflights run back to back (stubbed admission, git and gh); bun's 5 s default is too tight under load.
}, fixtureDeadlineS(60) * 1_000);

// Execute the production shell stages with real curl/checksums and only the
// GitHub transport redirected to a loopback server. No signing or remote writes.
const localScript = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
function releaseStage(start: string, end: string): string {
	const first = localScript.indexOf(start);
	const last = localScript.indexOf(end, first + start.length);
	if (first < 0 || last < 0) throw new Error(`release stage boundary missing: ${start} / ${end}`);
	return localScript.slice(first, last);
}
const helperScript = releaseStage("bounded() {", "# ---------------------------------------------------------------------------------------------- 1. preflight");
const downloadStage = releaseStage("stage verify\n", 'for platform in "${SHIP[@]}"; do');
const attestStage = releaseStage("stage attest\n", "# -------------------------------------------------------------------------------------------------- 8. verify");
const stagePrelude = `set -euo pipefail
die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
WORK=$1; DIST="$WORK/dist"; VERSION=0.0.0; REPO=fixture/release
DARWIN="omp-kit-v$VERSION-darwin-arm64-none.tar"
STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"
${helperScript}`;

// Real git, isolated repository: execute the production prepare stage, not a
// reimplementation of the metadata updater. Dry-run commits locally only.
for (const dirty of [null, "package.json", "README.md", "changelog.d/774u.md"] as const) {
	test(`release prepare dry run ${dirty ? `refuses foreign ${dirty}` : "creates metadata commit without a prior prepare"}`, () => {
		const work = realpathSync(ownedTmp("release-prepare", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const repo = join(work, "repo");
		mkdirSync(join(repo, "changelog.d"), { recursive: true });
		const env = { ...process.env, GIT_CEILING_DIRECTORIES: work, GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", AGENT_NAME: "ReleaseFixture" };
		delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
		const git = (...args: string[]) => {
			const result = runFixture(["git", "-C", repo, ...args], { cwd: repo, env, floor_s: 30 });
			if (result.rc !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git("init", "-q", "-b", "main");
			writeFileSync(join(repo, "package.json"), '{\n  "version": "1.2.3",\n  "omp": { "version": "1.2.3" }\n}\n');
			writeFileSync(join(repo, "README.md"), "Current release: v1.2.3\n");
			writeFileSync(join(repo, "changelog.d/774u.md"), "### Changed\n");
			writeFileSync(join(repo, "foreign.txt"), "base\n");
			git("add", "."); git("commit", "-qm", "fixture base");
			const base = git("rev-parse", "HEAD");
			writeFileSync(join(repo, "foreign.txt"), "foreign staged change\n");
			git("add", "foreign.txt");
			if (dirty) writeFileSync(join(repo, dirty), readFileSync(join(repo, dirty), "utf8") + "foreign edit\n");
			const before = Object.fromEntries(["package.json", "README.md", "changelog.d/774u.md"].map(path => [path, readFileSync(join(repo, path), "utf8")]));
			const script = `set -euo pipefail
die() { echo "$*" >&2; exit 4; }
say() { echo "$*"; }
ROOT=$1; WORK=$2; STAGE_LOG="$WORK/stages"; DRY_RUN=1; VERSION=1.2.4
${helperScript}
prepare_release
`;
			const scriptPath = join(work, "prepare.sh");
			writeFileSync(scriptPath, script);
			const result = runFixture(["bash", scriptPath, repo, work], { cwd: repo, env, floor_s: 60 });
			const stderr = new TextDecoder().decode(result.stderr);
			const stdout = new TextDecoder().decode(result.stdout);
			if (dirty) {
				expect(result.rc, stderr).toBe(4);
				expect(stderr).toContain("foreign changes on release prepare paths");
				expect(git("rev-parse", "HEAD")).toBe(base);
				for (const [path, contents] of Object.entries(before)) expect(readFileSync(join(repo, path), "utf8")).toBe(contents);
			} else {
				expect(result.rc, stderr).toBe(0);
				expect(git("rev-parse", "HEAD")).not.toBe(base);
				const pkg = JSON.parse(git("show", "HEAD:package.json"));
				expect([pkg.version, pkg.omp.version]).toEqual(["1.2.4", "1.2.4"]);
				expect(git("show", "HEAD:README.md")).toBe("Current release: v1.2.4");
				expect(git("show", "HEAD:changelog.d/774u.md")).toContain("metadata to 1.2.4");
				const message = git("log", "-1", "--format=%B");
				expect(message).toContain("chore(release): prepare 1.2.4 ompkit-774u [test]");
				for (const trailer of ["Gap-Bead: none (release metadata)", "Bead: ompkit-774u", "Agent: ReleaseFixture"]) expect(message).toContain(trailer);
				expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort()).toEqual(["README.md", "changelog.d/774u.md", "package.json"]);
				expect(git("diff", "--cached", "--name-only")).toBe("foreign.txt");
				expect(stdout).toContain("locally; no push");
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}

for (const scenario of ["updated", "symlinked-work", "browser-partial", "foreign-write", "stale-link", "wrong-version", "reconcile-refused"] as const) {
	test(`release install ${scenario} only stamps installed after real store alignment`, async () => {
		const work = realpathSync(ownedTmp("release-install", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		// RELINSTALLPATH1 (ompkit-fp72.120.16.155): macOS TMPDIR lies under /var -> /private/var; the stage must hand the
		// updater physical paths even when its work dir is reached through a symlinked parent.
		const stageWork = scenario === "symlinked-work" ? join(work, "via-link") : work;
		if (scenario === "symlinked-work") symlinkSync(work, stageWork);
		const home = join(work, "home");
		const prefix = join(home, ".local/opt/omp-kit");
		const store = join(prefix, "releases/0.0.0");
		const scriptDir = join(store, "skills/fleet-restart/scripts");
		mkdirSync(scriptDir, { recursive: true });
		mkdirSync(join(store, "scripts"), { recursive: true });
		mkdirSync(join(store, "bin"));
		mkdirSync(join(prefix, "bin"));
		writeFileSync(join(store, "package.json"), JSON.stringify({ name: "omp-kit-companion", version: "0.0.0" }));
		cpSync(join(ROOT, "scripts/kitlib_run.py"), join(store, "scripts/kitlib_run.py"));
		cpSync(join(ROOT, "scripts/pysafe.py"), join(store, "scripts/pysafe.py"));
		cpSync(join(ROOT, "skills/fleet-restart/scripts/fleet_restart.py"), join(scriptDir, "fleet_restart.py"));
		// Only activation transport is a fixture; real align reads private symlinks.
		const kit = join(prefix, "bin/omp-kit");
		writeFileSync(kit, `#!${process.execPath}
import { appendFileSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
const root = process.env.RELEASE_TEST_WORK;
const scenario = process.env.RELEASE_TEST_SCENARIO;
const prefix = join(process.env.HOME, ".local/opt/omp-kit");
const store = join(prefix, "releases/0.0.0");
const args = process.argv.slice(2);
appendFileSync(join(root, "calls"), JSON.stringify(args) + "\\n");
const emit = (data, commands = [], ok = true) => console.log(JSON.stringify({ ok, data, commands }));
if (args[0] === "--version") { console.log(scenario === "wrong-version" ? "omp-kit 0.0.1" : "omp-kit 0.0.0"); process.exit(0); }
// Like kit-update.ts assertRegular: a source that is not its own realpath is UNSAFE_KIT_SOURCE.
for (const flag of ["--index", "--archive"]) {
  const at = args.indexOf(flag);
  if (at >= 0 && dirname(args[at + 1]) !== realpathSync(dirname(args[at + 1]))) { console.error("UNSAFE_KIT_SOURCE " + args[at + 1]); process.exit(3); }
}
if (args[0] === "update" && args.includes("--reconcile")) {
  if (scenario === "reconcile-refused") process.exit(1);
  emit({ action: "RECONCILED", active_version: "0.0.0" }); process.exit(0);
}
if (args[0] === "update") {
  if (["browser-partial", "foreign-write", "reconcile-refused"].includes(scenario)) {
    emit({ action: "PARTIAL", receipt_id: "abc-123", active_version: "0.0.0", matcher: "PASS", live: "PASS", postcheck: "FAIL",
      postcheck_detail: { changed_operator_paths: scenario === "foreign-write" ? ["config.yml"] : [], failures: [], cause: null, live_state_paths: ["Library/Application Support/Google/Chrome/Default/History"] } },
      ["omp-kit update --reconcile abc-123 --yes"], false);
    process.exit(1);
  }
  emit({ action: "UPDATED", active_version: "0.0.0" }); process.exit(0);
}
if (args[0] === "apply" && args[1] === "plugin") {
  for (const profile of ["", "profiles/claude/", "profiles/codex/"]) {
    const link = join(process.env.HOME, ".omp", profile, "plugins/node_modules/omp-kit-companion");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(scenario === "stale-link" && profile === "profiles/codex/" ? join(prefix, "releases/old") : store, link);
  }
  emit({ action: "APPLIED" }); process.exit(0);
}
process.exit(99);
`);
		chmodSync(kit, 0o755);
		const receiptFunction = releaseStage("receipt() {", 'if [ "$DRY_RUN" = 1 ]; then\n\t# shellcheck');
		const fixture = join(work, "install.sh");
		writeFileSync(fixture, `${stagePrelude}
ROOT=$2; HOME=$3; INSTALL_PREFIX="$HOME/.local/opt/omp-kit"; INSTALLED=0
PUB="$WORK/public"; mkdir "$PUB"; : >"$DIST/SHA256SUMS"
STARTED=$(date +%s); PUSH_STARTED=$STARTED; RELEASED_AT=$STARTED
SOURCE=fixture; BASE_TAG=v0.0.0; NOTARY_ID=fixture; TAG_PUSH_SECONDS=0
. "$ROOT/scripts/kitlib-tmp.sh"
${receiptFunction}
install_release
receipt installed fixture fixture
`);
		mkdirSync(join(work, "dist"));
		try {
			const result = await runFixtureAsync(["bash", fixture, stageWork, ROOT, home], {
				cwd: ROOT, env: { ...process.env, HOME: home, TMPDIR: work, RELEASE_TEST_WORK: work, RELEASE_TEST_SCENARIO: scenario }, floor_s: 30,
			});
			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);
			const successful = scenario === "updated" || scenario === "symlinked-work" || scenario === "browser-partial";
			expect(result.rc, stderr).toBe(successful ? 0 : 4);
			const calls = readFileSync(join(work, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
			expect(calls[0]).toEqual(["update", "--apply", "--yes", "--version", "0.0.0", "--index", join(work, "public/release-index.json"),
				"--archive", join(work, "public/omp-kit-v0.0.0-darwin-arm64-none.tar"), "--json"]);
			expect(calls.filter(args => args.includes("--reconcile")).length).toBe(scenario === "browser-partial" || scenario === "reconcile-refused" ? 1 : 0);
			if (successful) {
				expect(stdout).toContain('"installed": true');
				expect(stdout).toContain('"push_to_installed_seconds":');
				expect(stdout).toContain("substep install.align-readback took");
				expect(stdout).toContain("stage install took");
				expect(JSON.parse(readFileSync(join(work, "install-align.json"), "utf8")).links).toHaveLength(3);
				expect(calls.find(args => args[0] === "apply")).toEqual(["apply", "plugin", "--apply", "--yes", "--store", store, "--profiles", "all", "--include-default", "--json"]);
			} else {
				expect(stdout).not.toContain('"installed": true');
				expect(stdout).not.toContain("installed 0.0.0; every profile link aligned");
				const refusal = scenario === "foreign-write" ? "not the known live-browser-only PARTIAL"
					: scenario === "stale-link" ? "installed profile alignment is stale"
					: scenario === "wrong-version" ? "installed CLI version readback differs"
					: "live-browser-state reconcile refused";
				expect(stderr).toContain(refusal);
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}

for (const verdict of ["cached", "queued", "failure"] as const) {
	test(`release qualification ${verdict} uses exact source and both verdicts`, async () => {
		const work = realpathSync(ownedTmp("release-verdict-wait", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const bin = join(work, "bin");
		mkdirSync(bin);
		// The first read is a miss. The producer returns 0 like the real
		// lock-holder acknowledgement, not like a completed qualification.
		writeFileSync(join(bin, "python3"), `#!/bin/sh
echo "$*" >>"$RELEASE_TEST_WORK/reads"
if [ "$RELEASE_TEST_VERDICT" = cached ]; then echo PASS; exit 0; fi
if [ -f "$RELEASE_TEST_WORK/triggered" ]; then
  if [ "$RELEASE_TEST_VERDICT" = failure ]; then echo FAIL; exit 1; fi
  echo PASS; exit 0
fi
echo MISS; exit 1
`);
		writeFileSync(join(bin, "sh"), `#!/bin/sh
printf '%s\\n' "$*" >"$RELEASE_TEST_WORK/producer"
touch "$RELEASE_TEST_WORK/triggered"
`);
		chmodSync(join(bin, "python3"), 0o755); chmodSync(join(bin, "sh"), 0o755);
		const qualification = releaseStage("stage verdict\n", 'if ! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \\\n\t--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" \\\n\t>"$WORK/full-suite-verdict.out"');
		try {
			const result = await runFixtureAsync(["bash", "-c", `${stagePrelude}
ROOT="$WORK/repo"; SRC="$WORK/export"; SOURCE=0123456789012345678901234567890123456789; source_tree=exact-tree
${qualification}`, "release-verdict-test", work], {
				cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TEST_WORK: work, RELEASE_TEST_VERDICT: verdict }, floor_s: 10,
			});
			expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(verdict === "failure" ? 4 : 0);
			if (verdict === "cached") expect(existsSync(join(work, "producer"))).toBe(false);
			else expect(readFileSync(join(work, "producer"), "utf8")).toContain("--commit 0123456789012345678901234567890123456789 --no-fetch");
			const reads = readFileSync(join(work, "reads"), "utf8");
			expect(reads).toContain("require-pass --repo");
			expect(reads).toContain("require-ci-only-pass --repo");
			expect(reads.split("\n").filter(Boolean).every(line => line.includes("--tree exact-tree") && line.includes(`--judge-root ${work}/export`))).toBe(true);
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(30) * 1_000);
}

for (const failure of ["none", "http", "bytes"] as const) {
	test(`public release downloads ${failure === "none" ? "overlap without rejecting valid bytes" : "refuse " + failure + " failures"}`, async () => {
		const work = realpathSync(ownedTmp("release-download", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const dist = join(work, "dist");
		const bin = join(work, "bin");
		mkdirSync(dist); mkdirSync(bin);
		const names = ["release-index.json", ...["darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu"].map(platform => `omp-kit-v0.0.0-${platform}.tar`)];
		const payloads = new Map(names.map(name => [name, `published bytes for ${name}\n`]));
		payloads.set("SHA256SUMS", names.map(name => `${new Bun.CryptoHasher("sha256").update(payloads.get(name)!).digest("hex")}  ${name}\n`).join(""));
		for (const [name, bytes] of payloads) writeFileSync(join(dist, name), bytes);
		const broken = names[2]!;
		const archives = new Set<string>();
		const { promise: allArchivesStarted, resolve: releaseDownloads } = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1", port: Number(process.env.KIT_TEST_LOOPBACK_PORT ?? 0),
			async fetch(request) {
				const name = new URL(request.url).pathname.split("/").at(-1)!;
				if (name.endsWith(".tar")) {
					archives.add(name);
					if (archives.size === 3) releaseDownloads();
					// A serial implementation cannot pass this control. No timing assertion
					// or arbitrary sleep: all three archive requests must coexist.
					if (failure === "none") await allArchivesStarted;
				}
				if (failure === "http" && name === broken) return new Response("missing", { status: 404 });
				return new Response(failure === "bytes" && name === broken ? "tampered" : payloads.get(name));
			},
		});
		const curl = Bun.which("curl");
		if (!curl) throw new Error("curl is required for the release download contract");
		writeFileSync(join(bin, "curl"), `#!/bin/bash
args=()
for arg do
	case "$arg" in
		https://github.com/*) args+=("$RELEASE_TEST_URL/\${arg#https://github.com/}") ;;
		*) args+=("$arg") ;;
	esac
done
exec ${JSON.stringify(curl)} "\${args[@]}"
`);
		chmodSync(join(bin, "curl"), 0o755);
		try {
			const result = await runFixtureAsync(["bash", "-c", stagePrelude + downloadStage, "release-download-test", work], {
				cwd: ROOT, env: { ...process.env, TMPDIR: work, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TEST_URL: server.url.origin }, floor_s: 10,
			});
			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);
			if (failure === "none") {
				expect(result.rc, stderr).toBe(0);
				expect(archives.size).toBe(3);
				for (const [name, bytes] of payloads) expect(readFileSync(join(work, "public", name), "utf8"), name).toBe(bytes);
				for (const name of payloads.keys()) expect(stdout).toContain(`public download ${name} took `);
			} else {
				expect(result.rc, stderr).toBe(4);
				expect(stderr).toContain(failure === "http" ? `public download of ${broken} failed (curl 22)` : `public ${broken} differs from the locally signed bytes`);
			}
		} finally {
			releaseDownloads();
			server.stop(true);
			rmSync(work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(20) * 1_000);
}

for (const conclusion of ["success", "failure"]) {
	test(`attestation completion polls promptly and preserves ${conclusion}`, async () => {
		const work = realpathSync(ownedTmp("release-poll", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const bin = join(work, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
	"workflow run "*) exit 0 ;;
	"run list "*) echo 123 ;;
	*"--log-failed"*) echo "runner failed" ;;
	*"--log"*) echo "PUBLISHED draft=false" ;;
	"run view "*)
		if [ -f "$RELEASE_TEST_WORK/polled" ]; then echo "completed $RELEASE_TEST_CONCLUSION"
		else touch "$RELEASE_TEST_WORK/polled"; echo "in_progress "; fi ;;
	*) exit 99 ;;
esac
`);
		writeFileSync(join(bin, "sleep"), '#!/bin/sh\nprintf "%s\\n" "$1" >>"$RELEASE_TEST_WORK/sleeps"\n');
		chmodSync(join(bin, "gh"), 0o755); chmodSync(join(bin, "sleep"), 0o755);
		try {
			const result = await runFixtureAsync(["bash", "-c", stagePrelude + attestStage, "release-poll-test", work], {
				cwd: ROOT, env: { ...process.env, TMPDIR: work, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TEST_WORK: work, RELEASE_TEST_CONCLUSION: conclusion }, floor_s: 10,
			});
			const stderr = new TextDecoder().decode(result.stderr);
			expect(readFileSync(join(work, "sleeps"), "utf8")).toBe("3\n");
			expect(result.rc, stderr).toBe(conclusion === "success" ? 0 : 4);
			if (conclusion === "failure") expect(stderr).toContain("attest-local run 123 ended: completed failure");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(20) * 1_000);
}
