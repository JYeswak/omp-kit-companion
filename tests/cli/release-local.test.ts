import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	// observer reports pressure, so the statfs-observed probe must admit (ompkit-fp72.120.16.155). Like `omp-kit heavy`,
	// the stub answers at once only with --no-wait; without it, it waits for admission (here: never).
	const attempt = async (admission: 0 | 75 | "sbh") => {
		stub("omp-kit", `printf '%s\\n' "$*" >> "${join(work, "kit-args")}"
case " $* " in *" --no-wait "*) ;; *) exec sleep 300 ;; esac
${admission === 75 ? "echo 'heavy: waiting: disk low: statfs 4 GiB free, floor 10 GiB' >&2; exit 75"
			: admission === "sbh" ? `[ "$OMP_KIT_DISK_OBSERVER" = statfs ] && exit 0; echo 'heavy: waiting: disk low: sbh check --need 10G reports pressure' >&2; exit 75`
			: "exit 0"}`);
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
		expect(readFileSync(join(work, "kit-args"), "utf8")).toContain("heavy --no-wait --label release-preflight -- true");
		// "In seconds": preflight's probe is `bounded 60 omp-kit heavy --no-wait`, so a probe that waited for admission
		// ends only at that 60 s deadline. The limit is the 10 s floor scaled for load (at most 40 s), always under it.
		expect(held.ms).toBeLessThan(fixtureDeadlineS(10) * 1_000);
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

// RELPENDING1 (ompkit-fp72.120.16.227): a previous install's pending recovery receipt refuses the release at preflight,
// before any build, instead of at the install stage after publishing. Same stubs as RELFAILFAST1; the fixture HOME's
// default state root (XDG_STATE_HOME unset) is the one omp-kit update reads. Never a real release: the stubbed fetch fails.
test.skipIf(process.platform !== "darwin")("RELPENDING1 preflight refuses a pending kit update receipt before any build", async () => {
	const work = realpathSync(ownedTmp("relpending", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const bin = join(work, "bin");
	const home = join(work, "home");
	const prefix = join(work, "prefix");
	const stateRoot = join(home, ".local/state/omp-kit");
	const pending = join(stateRoot, "kit-update.pending.json");
	const id = "4f2daa9e-2326-4d40-be66-6d9f65b1df5e";
	mkdirSync(bin); mkdirSync(join(prefix, "bin"), { recursive: true }); mkdirSync(stateRoot, { recursive: true });
	const stub = (path: string, body: string) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
	stub(join(bin, "gh"), "exit 0");
	stub(join(bin, "omp-kit"), "exit 0");
	stub(join(prefix, "bin/omp-kit"), `echo called >> "${join(work, "kit-called")}"; exit 0`);
	stub(join(bin, "git"), `echo called >> "${join(work, "git-called")}"; exit 1`);
	const attempt = async () => {
		rmSync(join(work, "git-called"), { force: true });
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "XDG_STATE_HOME") env[name] = value;
		const started = Date.now();
		const result = await run(["bash", join(ROOT, "scripts/release-local.sh"), "--version", "9.9.9"], {
			deadline_s: fixtureDeadlineS(60), cwd: ROOT,
			env: { ...env, HOME: home, PATH: `${bin}:${env.PATH ?? ""}`, TMPDIR: work, OMP_KIT_INSTALL_PREFIX: prefix },
		});
		return { rc: result.rc, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr),
			ms: Date.now() - started, gitCalled: existsSync(join(work, "git-called")) };
	};
	try {
		// Planted: the 0.2.88 PARTIAL receipt left unreconciled.
		const receipt = JSON.stringify({ scope: "kit", identitySha256: "0".repeat(64), kitVersion: "0.2.88", ompVersion: null, channel: null, id, state: "PENDING" });
		writeFileSync(pending, receipt, { mode: 0o600 });
		const held = await attempt();
		expect(held.rc, held.err).toBe(4);
		expect(held.err).toContain(`RELPENDING1: a previous kit update left pending recovery receipt ${id}`);
		expect(held.err).toContain(`omp-kit update --reconcile ${id} --yes`);
		expect(held.err).toContain("reconcile only a false PARTIAL whose postimages verify");
		expect(held.out).not.toContain("stage source");
		expect(held.out).not.toContain("stage build");
		expect(held.gitCalled).toBe(false);
		expect(existsSync(join(work, "kit-called"))).toBe(false);
		expect(readFileSync(pending, "utf8")).toBe(receipt);
		expect(held.ms).toBeLessThan(fixtureDeadlineS(10) * 1_000);
		// Planted: an unreadable receipt still refuses, and says so.
		writeFileSync(pending, "{ truncated", { mode: 0o600 });
		const unreadable = await attempt();
		expect(unreadable.rc, unreadable.err).toBe(4);
		expect(unreadable.err).toContain(`RELPENDING1: pending kit update receipt ${pending} is unreadable`);
		expect(unreadable.err).toContain("omp-kit update --reconcile <id> --yes");
		expect(unreadable.gitCalled).toBe(false);
		// Control: no pending receipt; preflight passes the check and reaches its next step (the stubbed fetch).
		rmSync(pending);
		const clear = await attempt();
		expect(clear.rc, clear.err).toBe(4);
		expect(clear.err).not.toContain("RELPENDING1");
		expect(clear.err).toContain("git fetch origin main failed");
		expect(clear.gitCalled).toBe(true);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
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
const downloadStage = releaseStage("stage verify\n", "substep verify.archive-chains");
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

// RELREMEDY1 (ompkit-fp72.120.16.246): writer-* replay the 0.2.91 PARTIAL whose only failures are the kit's own live
// writers (gate-events.jsonl, inbox-wake/*.json) plus the state-root snapshot budget overflow.
const writerScenarios = ["writer-partial", "writer-foreign", "writer-mutant"] as const;
const reconcileScenarios = ["reconciled-complete", "reconciled-missing-profile", "reconciled-wrong-store", "reconciled-stale-link", "reconciled-no-receipt", "reconciled-new-profile"] as const;
for (const scenario of ["updated", "symlinked-work", "browser-partial", "foreign-write", "stale-link", "wrong-version", "reconcile-refused", ...writerScenarios, ...reconcileScenarios] as const) {
	const writer = (writerScenarios as readonly string[]).includes(scenario);
	test(`${writer ? "RELREMEDY1 " : ""}release install ${scenario} only stamps installed after real store alignment`, async () => {
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
		if (scenario === "reconciled-new-profile") {
			const alignPath = join(scriptDir, "fleet_restart.py");
			// A profile is created after the reuse decision, while final alignment
			// inventories links. Link-only alignment cannot see its missing link.
			writeFileSync(alignPath, readFileSync(alignPath, "utf8").replace("def align_check(home, releases_root, version):",
				'def align_check(home, releases_root, version):\n    os.makedirs(os.path.join(home, ".omp/profiles/new/agent"), exist_ok=True)'));
		}
		// Only activation transport is a fixture; real align reads private symlinks.
		const kit = join(prefix, "bin/omp-kit");
		writeFileSync(kit, `#!${process.execPath}
import { appendFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
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
  if (scenario.startsWith("reconciled-")) {
    const rows = [];
    for (const profile of ["default", "claude", "codex"]) {
      const base = join(process.env.HOME, ".omp", ...(profile === "default" ? [] : ["profiles", profile]));
      mkdirSync(join(base, "agent"), { recursive: true });
      const link = join(base, "plugins/node_modules/omp-kit-companion");
      if (scenario === "reconciled-missing-profile" && profile === "codex") continue;
      mkdirSync(dirname(link), { recursive: true });
      const target = scenario === "reconciled-stale-link" && profile === "codex" ? join(prefix, "releases/old") : store;
      symlinkSync(target, link);
      rows.push({ profile, status: "APPLIED", before: {}, after: { link_kind: "SYMLINK", target: store, link_path: link } });
    }
    const state = join(process.env.HOME, ".local/state/omp-kit");
    mkdirSync(state, { recursive: true });
    if (scenario !== "reconciled-no-receipt") writeFileSync(join(state, "plugin-abc-456.json"),
      JSON.stringify({ schema_version: 1, id: "abc-456", store: scenario === "reconciled-wrong-store" ? join(prefix, "releases/old") : store, rows }));
    emit({ action: "RECONCILED", active_version: "0.0.0", plugin_relink: "APPLIED", plugin_receipt_id: "abc-456",
      verified: { version: "0.0.0", binary: join(store, "bin/omp-kit") } }); process.exit(0);
  }
  emit({ action: "RECONCILED", active_version: "0.0.0" }); process.exit(0);
}
if (args[0] === "update") {
  if (["browser-partial", "foreign-write", "reconcile-refused"].includes(scenario) || scenario.startsWith("reconciled-")) {
    emit({ action: "PARTIAL", receipt_id: "abc-123", active_version: "0.0.0", matcher: "PASS", live: "PASS", postcheck: "FAIL",
      postcheck_detail: { changed_operator_paths: scenario === "foreign-write" ? ["config.yml"] : [], failures: [], cause: null, live_state_paths: ["Library/Application Support/Google/Chrome/Default/History"] } },
      ["omp-kit update --reconcile abc-123 --yes"], false);
    process.exit(1);
  }
  if (scenario.startsWith("writer-")) {
    const changed = ["~/.local/state/omp-kit/gate-events.jsonl", "~/.local/state/omp-kit/inbox-wake/PeachLeopard.15fbe370fb29.json",
      ...(scenario === "writer-foreign" ? ["~/.omp/agent/config.yml"] : [])];
    emit({ action: "PARTIAL", receipt_id: "cd03799d-67fd", active_version: "0.0.0", matcher: "PASS", live: "PASS", postcheck: "FAIL",
      postcheck_detail: { status: "FAIL", changed_operator_paths: changed, failed_stages: [], deferred_stages: [],
        failures: [...changed.map(path => "Operator file changed during isolated test: " + path), "Operator file could not be read completely: ~/.local/state/omp-kit"],
        cause: { cause_code: "Error", cause_message: "KIT_POSTCHECK_FAILED" }, live_state_paths: ["~/.local/state/omp-kit/chrome-jfp"] } },
      ["omp-kit update --reconcile cd03799d-67fd --yes"], false);
    process.exit(1);
  }
  emit({ action: "UPDATED", active_version: "0.0.0" }); process.exit(0);
}
if (args[0] === "apply" && args[1] === "plugin") {
  for (const profile of ["", "profiles/claude/", "profiles/codex/", ...(scenario === "reconciled-new-profile" ? ["profiles/new/"] : [])]) {
    const link = join(process.env.HOME, ".omp", profile, "plugins/node_modules/omp-kit-companion");
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(scenario === "stale-link" && profile === "profiles/codex/" ? join(prefix, "releases/old") : store, link);
  }
  emit({ action: "APPLIED" }); process.exit(0);
}
process.exit(99);
`);
		chmodSync(kit, 0o755);
		// The mutant drops the live-writer class: its writer-only PARTIAL must fall back to the refusal.
		const installHelpers = scenario === "writer-mutant"
			? stagePrelude.replace(/^RELREMEDY_LIVE_WRITER=.*$/m, "RELREMEDY_LIVE_WRITER='^$.'") : stagePrelude;
		if (scenario === "writer-mutant") expect(installHelpers).not.toBe(stagePrelude);
		const receiptFunction = releaseStage("receipt() {", 'if [ "$DRY_RUN" = 1 ]; then\n\t# shellcheck');
		const fixture = join(work, "install.sh");
		writeFileSync(fixture, `${installHelpers}
ROOT=$2; HOME=$3; INSTALL_PREFIX="$HOME/.local/opt/omp-kit"; INSTALLED=0
PUB="$WORK/public"; mkdir "$PUB"; : >"$DIST/SHA256SUMS"; : >"$PUB/release-index.json"; : >"$PUB/$DARWIN"
STARTED=$(date +%s); PUSH_STARTED=$STARTED; RELEASED_AT=$STARTED
SOURCE=fixture; BASE_TAG=v0.0.0; NOTARY_ID=fixture; TAG_PUSH_SECONDS=0
. "$ROOT/scripts/kitlib-tmp.sh"
${receiptFunction}
install_release
receipt installed fixture fixture
`);
		mkdirSync(join(work, "dist"));
		try {
			const env: Record<string, string | undefined> = { ...process.env, HOME: home, TMPDIR: work, RELEASE_TEST_WORK: work, RELEASE_TEST_SCENARIO: scenario };
			delete env.XDG_STATE_HOME;
			const result = await runFixtureAsync(["bash", fixture, stageWork, ROOT, home], { cwd: ROOT, env: env as Record<string, string>, floor_s: 30 });
			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);
			const successful = scenario === "updated" || scenario === "symlinked-work" || scenario === "browser-partial" || scenario === "writer-partial" || scenario.startsWith("reconciled-");
			expect(result.rc, stderr).toBe(successful ? 0 : 4);
			const calls = readFileSync(join(work, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
			expect(calls[0]).toEqual(["update", "--apply", "--yes", "--version", "0.0.0", "--index", join(work, "public/release-index.json"),
				"--archive", join(work, "public/omp-kit-v0.0.0-darwin-arm64-none.tar"), "--json"]);
			expect(calls.filter(args => args.includes("--reconcile")).length).toBe(["browser-partial", "reconcile-refused", "writer-partial"].includes(scenario) || scenario.startsWith("reconciled-") ? 1 : 0);
			if (scenario === "writer-partial") {
				expect(calls.find(args => args.includes("--reconcile"))).toEqual(["update", "--reconcile", "cd03799d-67fd", "--yes", "--json"]);
				expect(stdout).toContain("substep install.reconcile-kit-live-writer-state");
				expect(stderr).toContain("release-local: postcheck: ~/.local/state/omp-kit: exceeds the postcheck snapshot budget");
				expect(stderr).toContain("gate-events.jsonl: written by a kit service during the isolated test (live-writer race)");
			}
			if (scenario === "writer-foreign" || scenario === "writer-mutant") {
				expect(stderr).toContain("not the known live-browser or kit live-writer PARTIAL");
				expect(stderr).toContain(`reconcile it with: ${kit} update --reconcile cd03799d-67fd --yes`);
				const apply = /re-apply with: (\S+) update --apply --yes --version 0\.0\.0 --index (\/\S+) --archive (\/\S+)$/m.exec(stderr);
				expect(apply?.[1]).toBe(kit);
				for (const source of [apply![2]!, apply![3]!]) { expect(existsSync(source)).toBe(true); expect(source.startsWith(join(work, "public"))).toBe(false); }
				if (scenario === "writer-foreign") expect(stderr).toContain("~/.omp/agent/config.yml: changed outside the kit live-writer class");
			}
			if (successful) {
				expect(stdout).toContain('"installed": true');
				expect(stdout).toContain('"push_to_installed_seconds":');
				expect(stdout).toContain("substep install.align-readback took");
				expect(stdout).toContain("stage install took");
				expect(JSON.parse(readFileSync(join(work, "install-align.json"), "utf8")).links).toHaveLength(scenario === "reconciled-new-profile" ? 4 : 3);
				if (scenario === "reconciled-complete") expect(calls.filter(args => args[0] === "apply")).toEqual([]);
				else expect(calls.find(args => args[0] === "apply")).toEqual(["apply", "plugin", "--apply", "--yes", "--store", store, "--profiles", "all", "--include-default", "--json"]);
			} else {
				expect(stdout).not.toContain('"installed": true');
				expect(stdout).not.toContain("installed 0.0.0; every profile link aligned");
				const refusal = scenario === "foreign-write" || scenario === "writer-foreign" || scenario === "writer-mutant" ? "not the known live-browser or kit live-writer PARTIAL"
					: scenario === "stale-link" ? "installed profile alignment is stale"
					: scenario === "wrong-version" ? "installed CLI version readback differs"
					: "live-browser-state reconcile refused";
				expect(stderr).toContain(refusal);
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}

// The verdict stage reads release-verdict.sh's lock and queue under the checkout's git dir: fixtures get an isolated repo.
function gitFixtureEnv(work: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
	delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
	return { ...env, GIT_CEILING_DIRECTORIES: work, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
function initFixtureRepo(work: string, env: Record<string, string>): string {
	const repo = join(work, "repo");
	const result = runFixture(["git", "init", "-q", repo], { cwd: work, env, floor_s: 30 });
	if (result.rc !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return repo;
}
const qualification = releaseStage("stage verdict\n", 'if ! bounded 30 python3 "$SRC/scripts/full-suite-verdict-store.py" require-pass \\\n\t--repo "$ROOT" --tree "$source_tree" --role main --judge-root "$SRC" --suite-root "$SRC" \\\n\t>"$WORK/full-suite-verdict.out"');

for (const verdict of ["cached", "missing-main", "missing-ci", "queued", "failure"] as const) {
	test(`release qualification ${verdict} uses exact source and both verdicts`, async () => {
		const work = realpathSync(ownedTmp("release-verdict-wait", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const env = gitFixtureEnv(work);
		initFixtureRepo(work, env);
		const bin = join(work, "bin");
		mkdirSync(bin);
		// Planted negatives: either PASS alone is insufficient. The producer returns
		// a queue acknowledgement, so only subsequent reads can prove qualification.
		writeFileSync(join(bin, "python3"), `#!/bin/sh
echo "$*" >>"$RELEASE_TEST_WORK/reads"
if [ "$RELEASE_TEST_VERDICT" = cached ]; then echo PASS; exit 0; fi
if [ "$RELEASE_TEST_VERDICT" = missing-main ] && [ "$2" = require-ci-only-pass ]; then echo PASS; exit 0; fi
if [ "$RELEASE_TEST_VERDICT" = missing-ci ] && [ "$2" = require-pass ]; then echo PASS; exit 0; fi
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
		try {
			const result = await runFixtureAsync(["bash", "-c", `${stagePrelude}
ROOT="$WORK/repo"; SRC="$WORK/export"; SOURCE=0123456789012345678901234567890123456789; source_tree=exact-tree
${qualification}`, "release-verdict-test", work], {
				cwd: ROOT, env: { ...env, PATH: `${bin}:${env.PATH ?? ""}`, RELEASE_TEST_WORK: work, RELEASE_TEST_VERDICT: verdict }, floor_s: 10,
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

// VERDICTSTARVE1 (ompkit-fp72.120.16.198): a real fixture holder process owns release-verdict's lock and runs a
// child whose argv names the commit it judges, as release-verdict.sh's runner children do. On the third verdict read
// a push lands: the one-slot queue now names a newer commit. A holder judging another commit has then skipped the
// prepare: the stage stops VERDICT_STARVED on the next poll. A holder judging the prepare lets the stage proceed.
for (const holderJudges of ["other", "prepare"] as const) {
	test(`VERDICTSTARVE1 verdict wait ${holderJudges === "other" ? "stops when the holder skips the prepare" : "proceeds while the holder judges the prepare"}`, async () => {
		const work = realpathSync(ownedTmp("verdictstarve", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const env = gitFixtureEnv(work);
		const repo = initFixtureRepo(work, env);
		const state = join(repo, ".git/omp-kit");
		const wanted = join(state, "release-verdict.wanted");
		mkdirSync(join(state, "release-verdict.lock"), { recursive: true });
		const source = "0123456789012345678901234567890123456789", other = "a".repeat(40), pushed = "b".repeat(40);
		const bin = join(work, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "python3"), `#!/bin/sh
echo "$*" >>"$RELEASE_TEST_WORK/reads"
n=$(($(wc -l <"$RELEASE_TEST_WORK/reads")))
[ "$n" -ne 3 ] || printf '%s\\n' ${pushed} >${JSON.stringify(wanted)}
if [ ${holderJudges} = prepare ] && [ "$n" -ge 4 ]; then echo PASS; exit 0; fi
echo MISS; exit 1
`);
		// The producer behaves like release-verdict.sh under a live holder: queue the commit and return 0.
		writeFileSync(join(bin, "sh"), `#!/bin/sh
printf '%s\\n' "$*" >>"$RELEASE_TEST_WORK/producer"
printf '%s\\n' ${source} >${JSON.stringify(wanted)}
echo "release-verdict: run holder holds the lock; it will judge ${source} next"
`);
		chmodSync(join(bin, "python3"), 0o755); chmodSync(join(bin, "sh"), 0o755);
		writeFileSync(join(work, "holder.sh"), `printf '%s\\n' "$$" >"$1/release-verdict.lock/pid"
/bin/bash -c 'exec -a "$0" /bin/sleep 120' "sh $2/tree/scripts/full-suite-verdict.sh --repo $3 --commit $4 --judge-role main" </dev/null &
printf '%s\\n' "$!" >"$2/runner.pid"
echo ready
wait
`);
		const judged = holderJudges === "other" ? other : source;
		try {
			const started = Date.now();
			// The fixture shell owns the holder: it starts it, waits for its runner child, and stops both on every exit.
			const result = await runFixtureAsync(["bash", "-c", `${stagePrelude}
exec 3< <(/bin/sh "$WORK/holder.sh" "$WORK/repo/.git/omp-kit" "$WORK" "$WORK/repo" ${judged})
IFS= read -r _ <&3
trap 'kill "$(cat "$WORK/runner.pid")" "$(cat "$WORK/repo/.git/omp-kit/release-verdict.lock/pid")" 2>/dev/null || :' EXIT
ROOT="$WORK/repo"; SRC="$WORK/export"; SOURCE=${source}; source_tree=exact-tree
${qualification}`, "verdict-starve-test", work], {
				cwd: ROOT, env: { ...env, PATH: `${bin}:${env.PATH ?? ""}`, RELEASE_TEST_WORK: work }, floor_s: 30,
			});
			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);
			const reads = readFileSync(join(work, "reads"), "utf8").trim().split("\n");
			expect(readFileSync(join(work, "producer"), "utf8")).toBe(`${join(work, "repo/scripts/release-verdict.sh")} --commit ${source} --no-fetch\n`);
			const holderPid = readFileSync(join(state, "release-verdict.lock/pid"), "utf8").trim();
			// First poll: the prepare is still queued (or judged), so the stage waits and says what the holder judges.
			expect(stdout).toContain(`verdict wait for ${source}: release-verdict run ${holderPid} judges ${judged}; queued next ${source}`);
			// One pre-check read, then two per poll: the stage decides on the first poll after the push (read 3).
			expect(reads.length).toBe(5);
			if (holderJudges === "other") {
				expect(result.rc, stderr).toBe(4);
				expect(stderr).toContain(`VERDICT_STARVED: release-verdict run ${holderPid} judges ${other} and queues ${pushed} next, so it skips prepare ${source}`);
				expect(stderr).toContain(`sh scripts/release-verdict.sh --commit ${source} --no-fetch`);
				expect(stderr).toContain(`scripts/release-local.sh --source ${source} --version 0.0.0`);
			} else {
				expect(result.rc, stderr).toBe(0);
				expect(stderr).not.toContain("VERDICT_STARVED");
			}
			// Bound: one 3 s poll plus fixture reads (reads.length above is exact), far inside the 73 s worst case.
			expect(Date.now() - started).toBeLessThan(fixtureDeadlineS(20) * 1_000);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(40) * 1_000);
}

// RUNTIMEMISS1 (ompkit-fp72.120.16.242): a verdict stored under another runtime id reads RUNTIME_MISMATCH. When every
// read is PASS or RUNTIME_MISMATCH, the stage refuses with the mismatch and starts no verdict run. A genuine ci-only
// MISS still needs a run, so that case starts one; when it leaves ci-only missing, starvation is the true cause and
// the VERDICT_STARVED refusal carries the main mismatch text.
for (const ciOnly of ["PASS", "MISS"] as const) {
	test(`RUNTIMEMISS1 verdict stage with a main runtime mismatch and ci-only ${ciOnly}`, async () => {
		const work = realpathSync(ownedTmp("runtimemiss", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const env = gitFixtureEnv(work);
		initFixtureRepo(work, env);
		const bin = join(work, "bin");
		mkdirSync(bin);
		const mismatch = "RUNTIME_MISMATCH stored env-aaaa current env-bbbb: PATH added /seat/agent-bin (stored PASS)";
		writeFileSync(join(bin, "python3"), `#!/bin/sh
echo "$*" >>"$RELEASE_TEST_WORK/reads"
case "$2" in require-pass) echo ${JSON.stringify(mismatch)}; exit 1 ;; esac
echo ${ciOnly}; [ ${ciOnly} = PASS ]
`);
		writeFileSync(join(bin, "sh"), `#!/bin/sh
printf '%s\\n' "$*" >>"$RELEASE_TEST_WORK/producer"
`);
		chmodSync(join(bin, "python3"), 0o755); chmodSync(join(bin, "sh"), 0o755);
		try {
			const result = await runFixtureAsync(["bash", "-c", `${stagePrelude}
ROOT="$WORK/repo"; SRC="$WORK/export"; SOURCE=0123456789012345678901234567890123456789; source_tree=exact-tree
${qualification}`, "runtimemiss-test", work], {
				cwd: ROOT, env: { ...env, PATH: `${bin}:${env.PATH ?? ""}`, RELEASE_TEST_WORK: work }, floor_s: 10,
			});
			const stderr = new TextDecoder().decode(result.stderr);
			expect(result.rc, stderr).toBe(4);
			const reads = readFileSync(join(work, "reads"), "utf8").trim().split("\n");
			if (ciOnly === "PASS") {
				expect(stderr).toContain(`release-local: refused: ${mismatch} (main verdict of prepare 0123456789012345678901234567890123456789`);
				expect(stderr).not.toContain("VERDICT_STARVED");
				expect(existsSync(join(work, "producer"))).toBe(false);
				expect(reads.length).toBe(2);
			} else {
				expect(stderr).toContain(`VERDICT_STARVED: no release-verdict run holds the lock and prepare 0123456789012345678901234567890123456789 has no verdict (main ${mismatch}, ci-only MISS)`);
				expect(readFileSync(join(work, "producer"), "utf8")).toContain("--commit 0123456789012345678901234567890123456789 --no-fetch");
				expect(reads.length).toBe(4);
			}
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

// CHANGELOGCATCHUP1 (ompkit-fp72.120.16.231): releases cut without a promote get their notes back one tag at a time,
// from each tag's own bytes, and a refused install no longer skips the next-version advance.
function catchUpRepo(label: string) {
	const work = realpathSync(ownedTmp(label, { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const env = { ...gitFixtureEnv(work), GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", AGENT_NAME: "ReleaseFixture" };
	const repo = join(work, "repo");
	const git = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
		const result = runFixture(["git", "-C", cwd, ...args], { cwd, env: { ...env, ...extra }, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
		return new TextDecoder().decode(result.stdout).trim();
	};
	return { work, env, repo, git };
}
const catchUpPackage = (version: string) => `{\n  "name": "fixture",\n  "version": "${version}",\n  "omp": {\n    "version": "${version}"\n  }\n}\n`;

test("CHANGELOGCATCHUP1 catch-up gives each tag its own section, holding exactly its own fragments at cut-time bytes", () => {
	const { work, env, repo, git } = catchUpRepo("catchup-sections");
	mkdirSync(join(repo, "changelog.d"), { recursive: true });
	const fragment = (name: string, text: string) => writeFileSync(join(repo, "changelog.d", name), text);
	// Each release is a commit on main with its own committer date; release-local pushes lightweight tags.
	const release = (version: string, date: string) => {
		writeFileSync(join(repo, "package.json"), catchUpPackage(version));
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", `release ${version}`], { GIT_COMMITTER_DATE: `${date}T12:00:00Z`, GIT_AUTHOR_DATE: `${date}T12:00:00Z` });
		git(repo, ["tag", `v${version}`]);
	};
	try {
		git(work, ["init", "-q", "-b", "main", repo]);
		writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Changed\n\n- Base release.\n");
		release("1.0.0", "2026-01-01");
		fragment("a.md", "- A one.\n");
		fragment("gone.md", "- Shipped in 1.0.1, then deleted.\n");
		release("1.0.1", "2026-01-02");
		fragment("a.md", "- A one.\n- A two, appended for 1.0.2.\n");
		fragment("b.md", "### Fixed\n\n- B one.\n  - B detail.\n");
		rmSync(join(repo, "changelog.d/gone.md"));
		release("1.0.2", "2026-01-03");
		fragment("c.md", "### Removed\n\n- C one.\n");
		release("1.0.3", "2026-01-05");
		// After the last cut: an edit to a shipped fragment and a new fragment are committed; a peer's edit is not.
		fragment("a.md", "- A one, edited after its cut.\n- A two, appended for 1.0.2.\n");
		// Planted (fp72.120.16.214, 46804c8e7f): a continuation line of an entry shipped in 1.0.2, rewritten in place.
		fragment("b.md", "### Fixed\n\n- B one.\n  - B detail, rewritten after the 1.0.3 cut.\n");
		fragment("later.md", "- Landed after 1.0.3.\n");
		git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "later work"]);
		const peerC = "### Removed\n\n- C one, a peer's uncommitted edit.\n";
		fragment("c.md", peerC);
		fragment("peer.md", "- A peer's untracked fragment.\n");
		const head = git(repo, ["rev-parse", "HEAD"]);
		const out = join(work, "out");
		mkdirSync(out);
		const catchUp = (...args: string[]) => runFixture(["sh", join(ROOT, "scripts/release-notes.sh"), "catch-up", ...args], { cwd: repo, env, floor_s: 60 });
		const result = catchUp("--base-tag", "v1.0.0", "--through-tag", "v1.0.3", "--next-version", "1.0.4", "--output", out);
		const stdout = new TextDecoder().decode(result.stdout);
		expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
		const changelog = readFileSync(join(out, "CHANGELOG.md"), "utf8");
		expect(changelog).toBe(`# Changelog

## [Unreleased]

## [1.0.3] - 2026-01-05

### Removed

- C one.

## [1.0.2] - 2026-01-03

### Changed

- A two, appended for 1.0.2.

### Fixed

- B one.
  - B detail.

## [1.0.1] - 2026-01-02

### Changed

- A one.
- Shipped in 1.0.1, then deleted.

## [1.0.0] - 2026-01-01

### Changed

- Base release.
`);
		// Fully released head fragments are listed for deletion; a fragment with an entry edited after its cut, or
		// added after the last tag, or with a line rewritten after its cut, keeps them for the next release.
		expect(readFileSync(join(out, "delete.txt"), "utf8")).toBe("changelog.d/c.md\n");
		expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("changelog.d/a.md\t1 unreleased entry\nchangelog.d/b.md\t1 unreleased entry\nchangelog.d/later.md\t1 unreleased entry\n");
		expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8")).version).toBe("1.0.4");
		expect(stdout).toContain("CATCHUP version=1.0.2 date=2026-01-03");
		expect(stdout).toContain("fragments=2 new_fragments=1 extended_fragments=1 entries=2");
		expect(stdout).toContain(`CATCHUP_TOTAL head=${head} versions=3 sections=3 entries=5 folded_fragments=4 folded_absent_at_head=1 delete=1 keep=3 package_version=1.0.3->1.0.4`);
		// Only git objects were read and nothing in the checkout changed.
		expect(readFileSync(join(repo, "changelog.d/c.md"), "utf8")).toBe(peerC);
		expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toContain("## [Unreleased]\n\n## [1.0.0]");
		expect(git(repo, ["status", "--porcelain"])).toBe("M changelog.d/c.md\n?? changelog.d/peer.md");
		// A report-only run writes nothing; a second run never overwrites the first output.
		expect(catchUp("--base-tag", "v1.0.0", "--through-tag", "v1.0.3").rc).toBe(0);
		expect(catchUp("--base-tag", "v1.0.0", "--through-tag", "v1.0.3", "--output", out).rc).not.toBe(0);
		// Planted: a base that is not the CHANGELOG's newest section would re-promote released notes; refused.
		const rebase = catchUp("--base-tag", "v1.0.1", "--through-tag", "v1.0.3");
		expect(rebase.rc).not.toBe(0);
		expect(new TextDecoder().decode(rebase.stderr)).toContain("must end at ## [1.0.1] (its newest released section is 1.0.0)");
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(90) * 1_000);

test("CHANGELOGCATCHUP1 a release whose install ends PARTIAL still advances the version on main, then refuses naming the install", () => {
	const { work, env, repo, git } = catchUpRepo("catchup-partial");
	const origin = join(work, "origin.git");
	const prefix = join(work, "kit");
	try {
		git(work, ["init", "-q", "--bare", "-b", "main", origin]);
		git(work, ["init", "-q", "-b", "main", repo]);
		for (const dir of ["scripts", "changelog.d"]) mkdirSync(join(repo, dir), { recursive: true });
		for (const name of ["release-notes.sh", "release-notes.ts", "stamp-release-line.sh", "kitlib-tmp.sh"]) cpSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
		writeFileSync(join(repo, "README.md"), readFileSync(join(ROOT, "README.md"), "utf8").replace(/^Current release: v\d+\.\d+\.\d+$/m, "Current release: v1.2.4"));
		writeFileSync(join(repo, "package.json"), catchUpPackage("1.2.4"));
		writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n### Changed\n\n- Base release.\n");
		writeFileSync(join(repo, "changelog.d/shipped.md"), "### Fixed\n\n- Shipped in v1.2.4.\n");
		git(repo, ["add", "."]); git(repo, ["commit", "-qm", "release 1.2.4"]);
		git(repo, ["remote", "add", "origin", origin]);
		git(repo, ["push", "-q", "origin", "main"]);
		const source = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["tag", "v1.2.4"]); git(repo, ["push", "-q", "origin", "v1.2.4"]);
		// The 0.2.89 install: the updater refuses a previous PARTIAL's pending receipt, which release-local never reconciles.
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(join(prefix, "bin/omp-kit"), `#!/bin/sh
echo '{"ok":false,"data":{"action":"PARTIAL","overall":"FAIL","scope":"kit"},"commands":[],"errors":[{"code":"PENDING_RECOVERY","message":"Previous kit/OMP update requires recovery"}]}'
exit 1
`);
		chmodSync(join(prefix, "bin/omp-kit"), 0o755);
		// The production refusal, install stage, advance and post-verify tail; only the kit transport is a fixture.
		const productionDie = releaseStage("ADVANCE_PENDING=0\nadvance_after_refusal() {", "\nsay() {");
		const advanceFunction = releaseStage("# NEXTVERSION1 (ompkit-d8qic", "\n# VERSIONSRC1");
		const tail = releaseStage("RELEASED_AT=$(date +%s)\n", "\nadvance_next_version\n");
		const fixture = join(work, "partial.sh");
		writeFileSync(fixture, `set -euo pipefail
${productionDie}
say() { echo "== $*"; }
ROOT=$1; WORK=$2; STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"; CHILD=''
. "$ROOT/scripts/kitlib-tmp.sh"
${helperScript}
${advanceFunction}
VERSION=1.2.4; SOURCE=${source}; INSTALL=1; INSTALLED=0; INSTALL_PREFIX=${JSON.stringify(prefix)}
PUB="$WORK/public"; mkdir "$PUB"; DARWIN="omp-kit-v$VERSION-darwin-arm64-none.tar"; : >"$PUB/release-index.json"; : >"$PUB/$DARWIN"
${tail}
advance_next_version
echo "unreachable: the install refusal must exit"
`);
		const result = runFixture(["bash", fixture, repo, work], { cwd: repo, env: { ...env, TMPDIR: work, README_GATE: join(work, "no-readme-update-gate") }, floor_s: 180 });
		const stdout = new TextDecoder().decode(result.stdout);
		const stderr = new TextDecoder().decode(result.stderr);
		expect(result.rc, stderr).toBe(4);
		expect(stdout).not.toContain("unreachable");
		expect(stderr).toContain("release-local: refused: install update failed (rc 1); not the known live-browser or kit live-writer PARTIAL");
		expect(stderr).toContain("v1.2.4 is published; advancing main to the next version before exiting");
		// RELREMEDY1: the remedy is runnable: --index/--archive name sources kept past the work dir's cleanup.
		const remedy = /not installed \(refusal above\); install it with: (\S+) update --apply --yes --version 1\.2\.4 --index (\/\S+) --archive (\/\S+)$/m.exec(stderr);
		expect(remedy?.[1]).toBe(`${prefix}/bin/omp-kit`);
		for (const source of [remedy![2]!, remedy![3]!]) expect(existsSync(source)).toBe(true);
		// The advance landed on origin main: next patch, the v1.2.4 notes promoted, the shipped fragment folded.
		const show = (path: string) => git(origin, ["show", `refs/heads/main:${path}`]);
		expect(JSON.parse(show("package.json")).version).toBe("1.2.5");
		expect(show("CHANGELOG.md")).toContain("## [1.2.4] - ");
		expect(show("CHANGELOG.md")).toContain("- Shipped in v1.2.4.");
		expect(git(origin, ["ls-tree", "-r", "--name-only", "refs/heads/main", "--", "changelog.d"])).toBe("");
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(git(origin, ["rev-parse", "refs/heads/main"]));
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(180) * 1_000);

test("CHANGELOGCATCHUP1 prepare starts the release fragment again after an advance folded it", () => {
	const { work, env, repo, git } = catchUpRepo("catchup-prepare");
	try {
		git(work, ["init", "-q", "-b", "main", repo]);
		writeFileSync(join(repo, "package.json"), catchUpPackage("1.2.3"));
		writeFileSync(join(repo, "README.md"), "Current release: v1.2.3\n");
		git(repo, ["add", "."]); git(repo, ["commit", "-qm", "advanced: changelog.d/774u.md was folded"]);
		writeFileSync(join(work, "prepare.sh"), `set -euo pipefail
die() { echo "$*" >&2; exit 4; }
say() { echo "$*"; }
ROOT=$1; WORK=$2; STAGE_LOG="$WORK/stages"; DRY_RUN=1; VERSION=1.2.4
${helperScript}
prepare_release
`);
		const result = runFixture(["bash", join(work, "prepare.sh"), repo, work], { cwd: repo, env, floor_s: 60 });
		expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
		expect(git(repo, ["show", "HEAD:changelog.d/774u.md"])).toBe("### Changed\n- Set CLI and OMP plugin version metadata to 1.2.4. The release is qualified on this prepare commit's exact exported tree before signing.");
		expect(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").sort()).toEqual(["README.md", "changelog.d/774u.md", "package.json"]);
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(60) * 1_000);

// ADVANCEREF1 (ompkit-fp72.120.16.235): the next-version advance promotes the fragments' SOURCE bytes. A fragment changed
// after the cut keeps only what it gained (v0.2.90: 774u.50.1 rewritten in b55c98c0dc), and an unchanged one is deleted.
test("ADVANCEREF1 the advance promotes SOURCE's fragment bytes and keeps only post-cut entries", () => {
	const { work, env, repo, git } = catchUpRepo("advanceref");
	const origin = join(work, "origin.git");
	try {
		git(work, ["init", "-q", "--bare", "-b", "main", origin]);
		git(work, ["init", "-q", "-b", "main", repo]);
		for (const dir of ["scripts", "changelog.d"]) mkdirSync(join(repo, dir), { recursive: true });
		for (const name of ["release-notes.sh", "release-notes.ts", "stamp-release-line.sh", "kitlib-tmp.sh"]) cpSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
		writeFileSync(join(repo, "README.md"), readFileSync(join(ROOT, "README.md"), "utf8").replace(/^Current release: v\d+\.\d+\.\d+$/m, "Current release: v1.2.4"));
		// Planted (e1aec02f60): companion's .gitattributes marks package.json export-subst, so an archive expands this field.
		writeFileSync(join(repo, ".gitattributes"), "package.json export-subst\n");
		writeFileSync(join(repo, "package.json"), catchUpPackage("1.2.4").replace('"name": "fixture",', '"name": "fixture",\n  "source_revision": "$Format:%H$",'));
		writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n### Changed\n\n- Base release.\n");
		writeFileSync(join(repo, "changelog.d/same.md"), "### Fixed\n\n- Unchanged since the cut.\n");
		writeFileSync(join(repo, "changelog.d/edited.md"), "### Changed\n\n- Shipped text.\n  - Shipped detail.\n- Also shipped.\n");
		git(repo, ["add", "."]); git(repo, ["commit", "-qm", "release 1.2.4"]);
		git(repo, ["remote", "add", "origin", origin]);
		git(repo, ["push", "-q", "origin", "main"]);
		const source = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["tag", "v1.2.4"]); git(repo, ["push", "-q", "origin", "v1.2.4"]);
		// Landed between the cut and the advance: a continuation line rewritten in place, and one new bullet.
		writeFileSync(join(repo, "changelog.d/edited.md"), "### Changed\n\n- Shipped text.\n  - Shipped detail, rewritten after the cut.\n- Also shipped.\n- Added after the cut.\n");
		git(repo, ["add", "."]); git(repo, ["commit", "-qm", "post-cut edit"]); git(repo, ["push", "-q", "origin", "main"]);
		const fixture = join(work, "advance.sh");
		writeFileSync(fixture, `set -euo pipefail
die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
ROOT=$1; WORK=$2; STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"; CHILD=''
${helperScript}
${releaseStage("# NEXTVERSION1 (ompkit-d8qic", "\n# VERSIONSRC1")}
VERSION=1.2.4; SOURCE=${source}; INSTALLED=1; INSTALL_PREFIX=${JSON.stringify(join(work, "kit"))}
advance_next_version
`);
		const result = runFixture(["bash", fixture, repo, work], { cwd: repo, env: { ...env, TMPDIR: work, README_GATE: join(work, "no-readme-update-gate") }, floor_s: 180 });
		expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
		const show = (path: string) => git(origin, ["show", `refs/heads/main:${path}`]);
		expect(JSON.parse(show("package.json")).version).toBe("1.2.5");
		expect(show("package.json")).toContain('"source_revision": "$Format:%H$",');
		// [1.2.4] holds exactly the shipped text.
		const changelog = show("CHANGELOG.md");
		const section = changelog.slice(changelog.indexOf("## [1.2.4] - "), changelog.indexOf("## [1.2.3]"));
		expect(section.slice(section.indexOf("\n"))).toBe("\n\n### Changed\n\n- Shipped text.\n  - Shipped detail.\n- Also shipped.\n\n### Fixed\n\n- Unchanged since the cut.\n\n");
		expect(changelog).not.toContain("after the cut");
		// The unchanged fragment is deleted; the changed one keeps its heading and only its post-cut entries.
		expect(git(origin, ["ls-tree", "-r", "--name-only", "refs/heads/main", "--", "changelog.d"])).toBe("changelog.d/edited.md");
		expect(show("changelog.d/edited.md")).toBe("### Changed\n\n- Shipped text.\n  - Shipped detail, rewritten after the cut.\n- Added after the cut.");
		expect(git(repo, ["status", "--porcelain"])).toBe("");
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(git(origin, ["rev-parse", "refs/heads/main"]));
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(180) * 1_000);

// RELCARD1 (ompkit-fp72.120.16.254, Joshua J-2026-11-05-03): a cut needs a complete two-lane release card at the exact
// source commit (docs/release-rubric.md "Card grammar"). Fixture repos commit the card; the checker reads it with git,
// so a different working-tree card never changes the verdict. No release, tag or signing step runs.
const realCard = readFileSync(join(ROOT, "docs/releases/v0.2.92.md"), "utf8");
const appliedCell = "| **applied** (companion e61fef4b64)";
// Planted: the only applied idea is filed for later; its gap rows still ship, so this is incomplete, not a wave.
const noAppliedCard = realCard.replace(appliedCell, "| next release (companion e61fef4b64)");
// Planted: a version-bump-only card, with no shipped gap and no applied idea.
const bumpOnlyCard = "# Release card: v0.2.92\n\n## 1. Gap lane\n\nVersion metadata set to 0.2.92.\n\n## 2. Optimization lane\n\nNone.\n\n## 3. Measures\n\n| Measure | Before | After |\n|---|---|---|\n| Change lead time (push → installed) | 66 min | |\n\n## 4. Error budget\n\nWithin budget.\n";
function cardRepo(label: string, cards: Record<string, string>) {
	const fixture = catchUpRepo(label);
	const { repo, git } = fixture;
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "docs/releases"), { recursive: true });
	for (const name of ["release-card-check.py", "pysafe.py"]) cpSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
	git(fixture.work, ["init", "-q", "-b", "main", repo]);
	git(repo, ["add", "scripts"]); git(repo, ["commit", "-qm", "checker"]);
	const shas: Record<string, string> = { none: git(repo, ["rev-parse", "HEAD"]) };
	for (const [name, text] of Object.entries(cards)) {
		writeFileSync(join(repo, "docs/releases/v0.2.92.md"), text);
		git(repo, ["add", "docs"]); git(repo, ["commit", "-qm", `card ${name}`]);
		shas[name] = git(repo, ["rev-parse", "HEAD"]);
	}
	return { ...fixture, shas };
}
function checkCard(repo: string, rev: string, env: Record<string, string>) {
	const result = runFixture(["python3", "-B", join(ROOT, "scripts/release-card-check.py"), "--repo", repo, "--rev", rev, "--version", "0.2.92"], { cwd: repo, env, floor_s: 30 });
	return { rc: result.rc, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
}

test("RELCARD1 checker: the real v0.2.92 card passes; a card missing its applied idea names section 2; a bump-only card is a wave", () => {
	const { work, env, repo, shas } = cardRepo("relcard-check", {
		real: realCard, noApplied: noAppliedCard, bumpOnly: bumpOnlyCard,
		fourIdeas: realCard.replace("\n\n## 3. Measures", "\n| 4 | a fourth idea | x | y | later |\n\n## 3. Measures"),
		emptyBefore: realCard.replace("| Published releases, 24 h | 5 |", "| Published releases, 24 h |  |"),
		noBudget: realCard.replace("## 4. Error budget", "## 4b. Budget notes"),
		noClosedGap: realCard.replace(/\| (closed|landed)[^|\n]*\|\n/g, "| open |\n"),
	});
	try {
		const real = checkCard(repo, shas.real, env);
		expect(real.rc, real.out).toBe(0);
		expect(real.out).toStartWith(`RELEASE_CARD_OK docs/releases/v0.2.92.md at ${shas.real}: 10 gap row(s) closed or landed; 3 idea(s), applied: PYCACHE1`);
		const noApplied = checkCard(repo, shas.noApplied, env);
		expect(noApplied.rc, noApplied.out).toBe(1);
		expect(noApplied.out).toStartWith("RELEASE_CARD_INCOMPLETE section 2 (Optimization lane): no idea's Decision starts with applied");
		expect(noApplied.out).toContain("docs/release-rubric.md §2");
		const bump = checkCard(repo, shas.bumpOnly, env);
		expect(bump.rc, bump.out).toBe(1);
		expect(bump.out).toStartWith("RELEASE_WAVE: docs/releases/v0.2.92.md at");
		const missing = checkCard(repo, shas.none, env);
		expect(missing.rc, missing.out).toBe(1);
		expect(missing.out).toStartWith(`RELEASE_CARD_MISSING: source ${shas.none} has no docs/releases/v0.2.92.md`);
		for (const [name, refusal] of [
			["fourIdeas", "RELEASE_CARD_INCOMPLETE section 2 (Optimization lane): the optimization table lists 4 ideas"],
			["emptyBefore", "RELEASE_CARD_INCOMPLETE section 3 (Measures): the Before column is empty for DORA row(s): Published releases, 24 h"],
			["noBudget", "RELEASE_CARD_INCOMPLETE section 4 (Error budget)"],
			["noClosedGap", "RELEASE_CARD_INCOMPLETE section 1 (Gap lane): no gap-lane row has State closed or landed"],
		] as const) {
			const result = checkCard(repo, shas[name]!, env);
			expect([name, result.rc], result.out).toEqual([name, 1]);
			expect(result.out).toStartWith(refusal);
		}
		// The exact commit decides: the complete card in the working tree does not admit the committed incomplete card.
		writeFileSync(join(repo, "docs/releases/v0.2.92.md"), realCard);
		expect(checkCard(repo, shas.noApplied, env).out).toStartWith("RELEASE_CARD_INCOMPLETE section 2");
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(60) * 1_000);

test("RELCARD1 release-local refuses an incomplete card before the keychain and a prepare push; the mutant without the check admits it", () => {
	const cardStage = releaseStage('release_card_check "$SOURCE"\n', "MODE=");
	const prepareStage = releaseStage('if [ "$PREPARE" = 1 ]; then\n\t# The prepare commit', "# Explicit --source");
	// Order: both checks run before the keychain opens, before signing and before the tag; HEAD's check precedes the prepare.
	for (const call of ['release_card_check "$SOURCE"', 'release_card_check "$(git -C "$ROOT" rev-parse HEAD)"\n\tprepare_release'])
		for (const later of ["keychain-unlock", "stage sign", "stage tag"]) expect(localScript.indexOf(call)).toBeLessThan(localScript.indexOf(later));
	expect(localScript.indexOf('release_card_check "$SOURCE"')).toBeGreaterThan(localScript.indexOf("release-train.sh\" version-match"));
	const { work, env, repo, git, shas } = cardRepo("relcard-wiring", { noApplied: noAppliedCard, real: realCard });
	const runStage = (stage: string, rev: string) => {
		const script = join(work, "card-stage.sh");
		writeFileSync(script, `${stagePrelude}
ROOT=${JSON.stringify(repo)}; SOURCE=${rev}; VERSION=0.2.92; PREPARE=1
prepare_release() { echo "PREPARED at $(git -C "$ROOT" rev-parse HEAD)"; }
${stage}`);
		const result = runFixture(["bash", script, work], { cwd: repo, env: { ...env, TMPDIR: work }, floor_s: 30 });
		return { rc: result.rc, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr) };
	};
	try {
		const refused = runStage(cardStage, shas.noApplied!);
		expect(refused.rc, refused.err).toBe(4);
		expect(refused.err).toContain("release-local: refused: RELEASE_CARD_INCOMPLETE section 2 (Optimization lane)");
		const admitted = runStage(cardStage, shas.real!);
		expect(admitted.rc, admitted.err).toBe(0);
		expect(admitted.out).toContain(`== RELEASE_CARD_OK docs/releases/v0.2.92.md at ${shas.real}`);
		// Mutant: the same stage with the check bypassed admits the incomplete card.
		const mutant = runStage(cardStage.replace('release_card_check "$SOURCE"', ":"), shas.noApplied!);
		expect(mutant.rc, mutant.err).toBe(0);
		expect(mutant.err).not.toContain("RELEASE_CARD");
		// The prepare path judges HEAD before prepare_release can commit or push.
		git(repo, ["checkout", "-q", shas.noApplied!]);
		const prepRefused = runStage(prepareStage, "");
		expect(prepRefused.rc, prepRefused.err).toBe(4);
		expect(prepRefused.err).toContain("RELEASE_CARD_INCOMPLETE section 2");
		expect(prepRefused.out).not.toContain("PREPARED");
		git(repo, ["checkout", "-q", shas.real!]);
		const prepared = runStage(prepareStage, "");
		expect(prepared.rc, prepared.err).toBe(0);
		expect(prepared.out).toContain(`PREPARED at ${shas.real}`);
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(60) * 1_000);

// RELPREREG1 (ompkit-fp72.120.16.258, Joshua J-2026-11-05-05): from card version 0.2.94 an applied idea needs a
// `### Prereg <id>` block and a `### Result <id>` block of paired readings; the checker recomputes n, drops VOID pairs,
// computes the paired-t CI and accepts only SHIPPED. v0.2.92 and v0.2.93 were cut before it and keep their verdicts.
type Pair = [before: number, after: number, loadBefore?: number, loadAfter?: number];
const shippedDiffs = [2, 18, 10, 0, 20, 4, 16]; // mean 10, s_d 8.16: 95% CI 2.45..17.55 > 0 and mean >= mde/2
const pairsOf = (diffs: number[]): Pair[] => diffs.map((d) => [60 + d, 60]);
function preregBlock(fields: Partial<Record<string, string>> = {}): string {
	const values: Record<string, string> = {
		endpoint: "cpu_s_per_run", direction: "lower", producer: "scripts/bench-pair.sh --target tests/cli/br-shim.test.ts --metric cpu_s",
		unit: "s (user+sys CPU of one targeted test-file run)", mde: "10 s", mde_source: "profile var/sitrep/perf-shimchain1",
		sigma_d: "8 s", sigma_source: "pilot 2026-11-05 4 pairs", alpha: "0.05 (two-sided)", power: "0.80", n_pairs: "7",
		stopping: "fixed-n; no peeking", control: "paired ABBA order, same host;\n            a pair is VOID if |load1 delta| > 2.0 or load1 > 0.75*ncpu",
		...fields,
	};
	const lines = Object.entries(values).filter(([, value]) => value !== "").map(([key, value]) => `${key}: ${value}`);
	return `### Prereg PREREGFIX1\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`;
}
function resultBlock(pairs: Pair[]): string {
	const rows = pairs.map(([before, after, a = 3.1, b = 3.4], index) => `| ${index + 1} | ${before} | ${after} | ${a} | ${b} |`);
	return `### Result PREREGFIX1\n\nncpu: 32\n\n| Pair | before | after | load1_before | load1_after |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
}
function preregCard(version: string, blocks: string): string {
	return `# Release card: v${version}\n\n## 1. Gap lane\n\n| Bead | Defect | State |\n|---|---|---|\n| fixture-1 | a fixture defect | closed |\n\n` +
		"## 2. Optimization lane\n\n| # | Idea | Hypothesis and measure | Evidence | Decision |\n|---|---|---|---|---|\n" +
		"| 1 | **PREREGFIX1** (fixture): a fixture idea | measure: CPU s per run | a profile | **applied** (fixture): see Prereg and Result |\n" +
		`| 2 | a second idea | a measure | a profile | next release |\n\n${blocks}\n` +
		"## 3. Measures\n\n| Measure | Before | After |\n|---|---|---|\n| Change lead time (push → installed) | 35 min | |\n\n## 4. Error budget\n\nWithin budget.\n";
}
function preregRepo(label: string, cards: Record<string, { version: string; text: string }>) {
	const fixture = catchUpRepo(label);
	const { repo, git } = fixture;
	git(fixture.work, ["init", "-q", "-b", "main", repo]);
	mkdirSync(join(repo, "docs/releases"), { recursive: true });
	const shas: Record<string, string> = {};
	for (const [name, { version, text }] of Object.entries(cards)) {
		writeFileSync(join(repo, `docs/releases/v${version}.md`), text);
		git(repo, ["add", "docs"]); git(repo, ["commit", "-qm", `card ${name}`]);
		shas[name] = git(repo, ["rev-parse", "HEAD"]);
	}
	return { ...fixture, shas };
}
function checkCardAt(repo: string, rev: string, version: string, env: Record<string, string>) {
	const result = runFixture(["python3", "-B", join(ROOT, "scripts/release-card-check.py"), "--repo", repo, "--rev", rev, "--version", version], { cwd: repo, env, floor_s: 30 });
	return { rc: result.rc, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
}

test("RELPREREG1 prereg: the stdlib t quantile matches the published table and n recomputes to 7 pairs", () => {
	const probe = `import importlib.util as u
s = u.spec_from_file_location("card", ${JSON.stringify(join(ROOT, "scripts/release-card-check.py"))}); m = u.module_from_spec(s); s.loader.exec_module(m)
print(" ".join(f"{m.t_quantile(p, df):.4f}" for p, df in ((0.975, 1), (0.975, 6), (0.975, 30), (0.975, 60), (0.995, 4))))
print(m.required_pairs(10, 8, 0.05, 0.80), m.required_pairs(10, 0, 0.05, 0.80))`;
	const result = runFixture(["python3", "-B", "-c", probe], { cwd: ROOT, floor_s: 30 });
	expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
	expect(new TextDecoder().decode(result.stdout)).toBe("12.7062 2.4469 2.0423 2.0003 4.6041\n7 1\n");
}, fixtureDeadlineS(30) * 1_000);

test("RELPREREG1 prereg: a 7-pair card ships; underpowered, inconclusive, no-effect and regressed cards refuse", () => {
	const at = (blocks: string) => ({ version: "0.2.94", text: preregCard("0.2.94", blocks) });
	const { work, env, repo, shas } = preregRepo("relprereg-verdicts", {
		shipped: at(preregBlock() + resultBlock(pairsOf(shippedDiffs))),
		// One VOID pair (load1 delta 3.0) is replaced by an eighth pair: the 7 valid pairs still ship.
		voidReplaced: at(preregBlock() + resultBlock([[90, 60, 3.0, 6.0], ...pairsOf(shippedDiffs)])),
		// The pyc-writes endpoint: deterministic (sigma_d 0), one pair, 62 → 0 against mde 10.
		deterministic: at(preregBlock({ endpoint: "pyc_writes_per_create", unit: "writes", mde: "10 writes", sigma_d: "0", sigma_source: "deterministic count", n_pairs: "1" }) + resultBlock([[62, 0]])),
		fivePairs: at(preregBlock() + resultBlock(pairsOf(shippedDiffs.slice(0, 5)))),
		fiveDeclared: at(preregBlock({ n_pairs: "5" }) + resultBlock(pairsOf(shippedDiffs.slice(0, 5)))),
		voidUnreplaced: at(preregBlock() + resultBlock([[90, 60, 3.0, 6.0], ...pairsOf(shippedDiffs.slice(1))])),
		noResult: at(preregBlock()),
		inconclusive: at(preregBlock() + resultBlock(pairsOf([-20, 25, 2, -15, 20, 5, -3]))),
		noEffect: at(preregBlock() + resultBlock(pairsOf([1, -1, 0, 2, -2, 1, -1]))),
		regressed: at(preregBlock() + resultBlock(pairsOf(shippedDiffs.map((d) => -d)))),
		noPrereg: at(resultBlock(pairsOf(shippedDiffs))),
		noMde: at(preregBlock({ mde: "" }) + resultBlock(pairsOf(shippedDiffs))),
	});
	try {
		for (const name of ["shipped", "voidReplaced"]) {
			const result = checkCardAt(repo, shas[name]!, "0.2.94", env);
			expect([name, result.rc], result.out).toEqual([name, 0]);
			expect(result.out).toContain("PREREGFIX1 SHIPPED (n=7, mean d 10 s, 95% CI 2.449..17.55 s, mde 10 s)");
		}
		const deterministic = checkCardAt(repo, shas.deterministic!, "0.2.94", env);
		expect(deterministic.rc, deterministic.out).toBe(0);
		expect(deterministic.out).toContain("PREREGFIX1 SHIPPED (n=1, mean d 62 writes");
		for (const [name, refusal] of [
			["fivePairs", "RELEASE_UNDERPOWERED: applied idea PREREGFIX1 has 5 valid pairs (0 VOID) of the 7 preregistered"],
			["fiveDeclared", "RELEASE_UNDERPOWERED: '### Prereg PREREGFIX1' preregisters n_pairs 5, but mde 10, sigma_d 8, alpha 0.05 and power 0.8 require 7"],
			["voidUnreplaced", "RELEASE_UNDERPOWERED: applied idea PREREGFIX1 has 6 valid pairs (1 VOID) of the 7 preregistered"],
			["noResult", "RELEASE_UNDERPOWERED: applied idea PREREGFIX1 has no '### Result PREREGFIX1' block"],
			["inconclusive", "RELEASE_INCONCLUSIVE: applied idea PREREGFIX1: the CI straddles"],
			["noEffect", "RELEASE_NO_EFFECT: applied idea PREREGFIX1: the CI lies within ±mde"],
			["regressed", "RELEASE_REGRESSED: applied idea PREREGFIX1: the CI lies wholly below 0"],
			["noPrereg", "RELEASE_PREREG_MISSING: applied idea PREREGFIX1 has no '### Prereg PREREGFIX1' block"],
			["noMde", "RELEASE_PREREG_MISSING: '### Prereg PREREGFIX1' lacks field(s): mde"],
		] as const) {
			const result = checkCardAt(repo, shas[name]!, "0.2.94", env);
			expect([name, result.rc], result.out).toEqual([name, 1]);
			expect(result.out).toStartWith(refusal);
			expect(result.out.trim().split("\n")).toHaveLength(1);
		}
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(90) * 1_000);

test("RELPREREG1 prereg: cut cards keep their verdict at their commits; the same card as v0.2.94 needs a Prereg block", () => {
	// The cut cards' committed text (a gitless or fresh-init export has no release history, so read the tracked files).
	const card93 = readFileSync(join(ROOT, "docs/releases/v0.2.93.md"), "utf8");
	const card92 = readFileSync(join(ROOT, "docs/releases/v0.2.92.md"), "utf8");
	const { work, env, repo, shas } = preregRepo("relprereg-grandfather", {
		v92: { version: "0.2.92", text: card92 }, v93: { version: "0.2.93", text: card93 },
		v94: { version: "0.2.94", text: card93.replace("# Release card: v0.2.93", "# Release card: v0.2.94") },
	});
	try {
		for (const [name, version, applied] of [["v92", "0.2.92", "PYCACHE1"], ["v93", "0.2.93", "RUNTIMEMISS1 readback"]] as const) {
			const result = checkCardAt(repo, shas[name]!, version, env);
			expect([name, result.rc], result.out).toEqual([name, 0]);
			expect(result.out).toStartWith(`RELEASE_CARD_OK docs/releases/v${version}.md at ${shas[name]}`);
			expect(result.out).toContain(`applied: ${applied}`);
		}
		const v94 = checkCardAt(repo, shas.v94!, "0.2.94", env);
		expect(v94.rc, v94.out).toBe(1);
		expect(v94.out).toStartWith("RELEASE_PREREG_MISSING: applied idea RUNTIMEMISS1 has no '### Prereg RUNTIMEMISS1' block");
		// The published commits themselves, read with git cat-file, wherever this checkout carries the release history.
		for (const [rev, version] of [["43c45850b6", "0.2.92"], ["a29b8c97ef", "0.2.93"]] as const) {
			if (runFixture(["git", "-C", ROOT, "cat-file", "-e", `${rev}^{commit}`], { cwd: ROOT, floor_s: 30 }).rc !== 0) continue;
			const result = checkCardAt(ROOT, rev, version, env);
			expect([version, result.rc], result.out).toEqual([version, 0]);
			expect(result.out).toStartWith(`RELEASE_CARD_OK docs/releases/v${version}.md at ${rev}`);
		}
	} finally { rmSync(work, { recursive: true, force: true }); }
}, fixtureDeadlineS(60) * 1_000);

// RELREMEDY2 (ompkit-fp72.120.16.274): the recorded 0.2.93 updater result (verbatim, lists only `omp-kit undo <id> --yes`)
// must reconcile through the live-writer class filter release-local.sh actually runs.
{
	const source = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
	const liveWriter = /^RELREMEDY_LIVE_WRITER='([^']*)'$/m.exec(source)![1]!;
	const helpers = /^RELREMEDY_JQ='([^']*)'$/m.exec(source)![1]!;
	const classFilter = /\t\t\tclass_filter='(\.data as \$d \| \$d\.receipt_id[^']*)'/.exec(source)![1]!;
	const recorded = readFileSync(join(ROOT, "tests/fixtures/release-local/0.2.93-install-update.json"), "utf8");
	const home = "/Users/fixture";
	const classify = async (json: string, filter = classFilter) => {
		const result = await run(["jq", "-er", "--arg", "v", "0.2.93", "--arg", "home", home, "--arg", "root", `${home}/.local/state/omp-kit`,
			"--arg", "rx", liveWriter, `${helpers} ${filter}`], { deadline_s: fixtureDeadlineS(30), cwd: ROOT, stdin: json });
		return { rc: result.rc, id: new TextDecoder().decode(result.stdout).trim() };
	};
	test("RELREMEDY2 planted: the recorded 0.2.93 updater PARTIAL reconciles in the live-writer class", async () => {
		expect(JSON.parse(recorded).commands).toEqual(["omp-kit undo ba04340e-a087-4fbd-aa17-1288061f263b --yes"]);
		expect(await classify(recorded)).toEqual({ rc: 0, id: "ba04340e-a087-4fbd-aa17-1288061f263b" });
	});
	test("RELREMEDY2 control: the recorded PARTIAL plus a foreign changed operator path refuses", async () => {
		const foreign = JSON.parse(recorded);
		foreign.data.postcheck_detail.changed_operator_paths = ["~/.omp/agent/config.yml"];
		foreign.data.postcheck_detail.failures.push("Operator file changed during isolated test: ~/.omp/agent/config.yml");
		expect((await classify(JSON.stringify(foreign))).rc).not.toBe(0);
	});
	test("RELREMEDY2 mutant: restoring the commands-list condition refuses the recorded PARTIAL", async () => {
		const mutant = classFilter.replace(/\)\) \| \$id$/, ') and\n(.commands | index("omp-kit update --reconcile " + $id + " --yes") != null)) | $id');
		expect(mutant).not.toBe(classFilter);
		expect((await classify(recorded, mutant)).rc).not.toBe(0);
	});
}

// SUITESERIAL1 (ompkit-fp72.120.16.264): one full suite at a time machine-wide, whatever launched it. Every case runs the
// real judge (scripts/full-suite-verdict.sh, or land's archived copy of it) on a fixture repository whose whole declared
// suite is stub python files that mark when they start and end, with an isolated verdict store and lease dir; the real
// suite never runs. Suite overlap is read from those marks and from the verdict records' per-file started_ms/finished_ms.
{
	const judge = join(ROOT, "scripts/full-suite-verdict.sh");
	const decoder = new TextDecoder();
	type LeaseFixture = { work: string; repo: string; marks: string; lease: string; store: string; env: Record<string, string> };
	type Launch = { done: Promise<{ rc: number | null; out: string; err: string }>; out: string; err: string };

	function leaseFixture(label: string): LeaseFixture {
		const work = realpathSync(ownedTmp(`suite-lease-${label}`, { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const repo = join(work, "repo"), marks = join(work, "marks");
		mkdirSync(join(repo, "scripts"), { recursive: true });
		mkdirSync(join(repo, "tests", "cli"), { recursive: true });
		mkdirSync(marks);
		cpSync(join(ROOT, "scripts/kitlib-tmp.sh"), join(repo, "scripts/kitlib-tmp.sh"));
		const env: Record<string, string> = { ...gitFixtureEnv(work), FULL_SUITE_LEASE_DIR: join(work, "lease"), FULL_SUITE_JOBS: "1",
			OMP_KIT_OMP_SRC_FETCH: "0", KITROOT: ROOT };
		for (const name of ["OMP_KIT_SUITE_HERMETIC_ENABLE", "OMP_KIT_SUITE_FENCE_ENABLE", "FULL_SUITE_LEASE_WAIT_SECS", "FULL_SUITE_LEASE_QUEUE_MAX",
			"FULL_SUITE_VERDICT_CACHE_DIR", "FULL_SUITE_TIMEOUT_SECS"]) delete env[name];
		fixtureGit(repo, env, "init", "-q");
		return { work, repo, marks, lease: join(work, "lease"), store: join(work, "store"), env };
	}
	function fixtureGit(cwd: string, env: Record<string, string>, ...args: string[]): string {
		const result = runFixture(["git", "-c", "user.name=SUITESERIAL1 test", "-c", "user.email=suiteserial1@example.invalid", "-C", cwd, ...args],
			{ cwd, env, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${decoder.decode(result.stderr)}`);
		return decoder.decode(result.stdout).trim();
	}
	// A stub suite file: it marks start, then waits for <marks>/open ("gate"), sleeps 1 s ("sleep") or ends ("fast"), and marks end.
	function stub(fx: LeaseFixture, file: string, tag: string, mode: "gate" | "sleep" | "fast"): void {
		const body = mode === "gate"
			? "deadline = time.monotonic() + 300\nwhile not os.path.exists(os.path.join(marks, 'open')) and time.monotonic() < deadline:\n    time.sleep(0.05)\n"
			: mode === "sleep" ? "time.sleep(1.0)\n" : "";
		writeFileSync(join(fx.repo, "tests", "cli", file), "import os, time\n"
			+ `marks, tag = ${JSON.stringify(fx.marks)}, ${JSON.stringify(tag)}\n`
			+ "def mark(kind):\n    with open(os.path.join(marks, '%s.%s.%d' % (kind, tag, os.getpid())), 'w') as handle:\n        handle.write(str(time.time_ns()))\n"
			+ "mark('start')\n" + body + "mark('end')\n");
	}
	function commit(fx: LeaseFixture, message: string): { sha: string; tree: string } {
		fixtureGit(fx.repo, fx.env, "add", "-A");
		fixtureGit(fx.repo, fx.env, "commit", "-qm", `[test] ${message}`);
		return { sha: fixtureGit(fx.repo, fx.env, "rev-parse", "HEAD"), tree: fixtureGit(fx.repo, fx.env, "rev-parse", "HEAD^{tree}") };
	}
	// Mark times (ns) by kind and tag prefix, e.g. marks(fx, "start", "a").
	function marks(fx: LeaseFixture, kind: "start" | "end", tag: string): number[] {
		return readdirSync(fx.marks).filter(name => name.startsWith(`${kind}.${tag}`)).map(name => Number(readFileSync(join(fx.marks, name), "utf8")));
	}
	// One judge run with stdout/stderr in files, so a test can read them while it runs.
	function launch(fx: LeaseFixture, sha: string, name: string, extra: Record<string, string> = {}, script = judge): Launch {
		const out = join(fx.work, `${name}.out`), err = join(fx.work, `${name}.err`);
		writeFileSync(out, ""); writeFileSync(err, "");
		const done = runFixtureAsync(["sh", "-c", 'exec sh "$0" --repo "$1" --commit "$2" --cache-dir "$3" >"$4" 2>"$5"', script, fx.repo, sha, fx.store, out, err],
			{ cwd: fx.work, env: { ...fx.env, ...extra }, floor_s: 90 })
			.then(result => ({ rc: result.rc, out: readFileSync(out, "utf8"), err: readFileSync(err, "utf8") }));
		return { done, out, err };
	}
	// The awaited conditions live in other processes (stub marks, a judge's stderr, lease tickets) and emit no event this
	// process can await, so they are polled against a load-scaled deadline.
	async function waitFor(what: string, ready: () => boolean, floorS = 60): Promise<void> {
		const deadline = Date.now() + fixtureDeadlineS(floorS) * 1_000;
		while (!ready()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(50);
		}
	}
	const openGate = (fx: LeaseFixture) => writeFileSync(join(fx.marks, "open"), "");
	// The lease queue's tickets; one taken (removed) between listing and reading is skipped.
	function tickets(lease: string): Record<string, unknown>[] {
		const queue = join(lease, "suite-lease", "queue");
		const found: Record<string, unknown>[] = [];
		for (const name of existsSync(queue) ? readdirSync(queue) : []) {
			if (!name.endsWith(".json")) continue;
			try { found.push(JSON.parse(readFileSync(join(queue, name), "utf8")) as Record<string, unknown>); } catch { /* taken meanwhile */ }
		}
		return found;
	}
	// The kitlib flock behind the lease, tried once: RELEASED when it was free.
	function leaseFree(lease: string): string {
		const result = runFixture(["python3", "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import kitlib_lock; "
			+ "print(kitlib_lock.private_lock({'namespace': 'suite-lease', 'name': 'full-suite'}, deadline_s=0, state_dir=sys.argv[2]).release())",
		join(ROOT, "scripts"), lease], { cwd: ROOT, floor_s: 30 });
		return decoder.decode(result.stdout).trim() || decoder.decode(result.stderr).trim();
	}

	test("SUITESERIAL1 suite lease planted: two concurrent launches on one tree run one suite and both read its verdict", async () => {
		const fx = leaseFixture("planted");
		const runs: Launch[] = [];
		try {
			stub(fx, "lease_stub_test.py", "a", "gate");
			const { sha, tree } = commit(fx, "one stub suite");
			runs.push(launch(fx, sha, "first"));
			await waitFor("the first suite to start", () => marks(fx, "start", "a").length === 1);
			runs.push(launch(fx, sha, "second"));
			await waitFor("the second launch to join", () => readFileSync(runs[1]!.err, "utf8").includes("suite-lease: JOINING run "));
			openGate(fx);
			const [first, second] = await Promise.all(runs.map(r => r.done));
			expect(first!.rc, first!.out + first!.err).toBe(0);
			expect(second!.rc, second!.out + second!.err).toBe(0);
			expect(first!.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			const firstRun = first!.out.split("FULL-SUITE: suite lease held by run ")[1]?.split(" ")[0];
			expect(second!.err).toContain(`suite-lease: JOINING run ${firstRun} (full-suite-verdict): it judges the same tree ${tree} role base`);
			expect(second!.out).toContain(`FULL-SUITE: JOINED the suite run for tree ${tree} role=base`);
			expect(second!.out).toContain(`FULL-SUITE: VERDICT REUSED PASS tree=${tree} role=base`);
			expect(second!.out).not.toContain("FULL-SUITE: VERDICT PASS ");
			expect(marks(fx, "start", "a").length).toBe(1);
		} finally {
			openGate(fx);
			await Promise.allSettled(runs.map(r => r.done));
			rmSync(fx.work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(180) * 1_000);

	test("SUITESERIAL1 suite lease negative: a suite on another tree queues while one runs; a full queue or the wait bound refuses", async () => {
		const fx = leaseFixture("negative");
		const runs: Launch[] = [];
		try {
			stub(fx, "lease_stub_test.py", "a", "gate");
			const a = commit(fx, "tree a");
			stub(fx, "lease_stub_test.py", "b", "gate");
			const b = commit(fx, "tree b");
			stub(fx, "lease_stub_test.py", "c", "gate");
			const c = commit(fx, "tree c");
			runs.push(launch(fx, a.sha, "a"));
			await waitFor("suite a to start", () => marks(fx, "start", "a").length === 1);
			runs.push(launch(fx, b.sha, "b"));
			await waitFor("tree b to queue", () => readFileSync(runs[1]!.err, "utf8").includes(`suite-lease: QUEUED tree ${b.tree} role base at position 1 behind run `));
			expect(tickets(fx.lease).map(t => [t.tree, t.launcher, t.commit])).toEqual([[b.tree, "full-suite-verdict", b.sha]]);
			expect(marks(fx, "start", "b")).toEqual([]);
			// A full queue refuses at once with its code; nothing runs and nothing is recorded.
			const full = await launch(fx, c.sha, "c-full", { FULL_SUITE_LEASE_QUEUE_MAX: "1" }).done;
			expect(full.rc, full.out + full.err).toBe(75);
			expect(full.err).toContain("suite-lease: REFUSED SUITE_LEASE_QUEUE_FULL 1 request(s) already wait (FULL_SUITE_LEASE_QUEUE_MAX=1) behind run ");
			expect(full.err).toContain(`FULL-SUITE: REFUSED: no suite lease for tree ${c.tree} role=base (rc=75)`);
			// The wait bound refuses too, and drops its own ticket.
			const late = await launch(fx, c.sha, "c-late", { FULL_SUITE_LEASE_WAIT_SECS: "1" }).done;
			expect(late.rc, late.out + late.err).toBe(75);
			expect(late.err).toContain(`suite-lease: QUEUED tree ${c.tree} role base at position 2 behind run `);
			expect(late.err).toContain("suite-lease: REFUSED SUITE_LEASE_WAIT_TIMEOUT waited 1 s (FULL_SUITE_LEASE_WAIT_SECS)");
			expect(marks(fx, "start", "c")).toEqual([]);
			expect(tickets(fx.lease).map(t => t.tree)).toEqual([b.tree]);
			expect(marks(fx, "start", "b")).toEqual([]);
			openGate(fx);
			const [first, second] = await Promise.all(runs.map(r => r.done));
			expect(first!.rc, first!.out + first!.err).toBe(0);
			expect(second!.rc, second!.out + second!.err).toBe(0);
			expect(second!.out).toContain(`FULL-SUITE: VERDICT PASS tree=${b.tree} role=base`);
			// Serialized: suite b started only after suite a ended.
			expect(marks(fx, "start", "b")[0]!).toBeGreaterThanOrEqual(marks(fx, "end", "a")[0]!);
			expect(tickets(fx.lease)).toEqual([]);
		} finally {
			openGate(fx);
			await Promise.allSettled(runs.map(r => r.done));
			rmSync(fx.work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(180) * 1_000);

	test("SUITESERIAL1 suite lease caps inner workers at 6 when FULL_SUITE_JOBS asks for 28", async () => {
		const fx = leaseFixture("workers");
		try {
			for (let index = 0; index < 8; index++) stub(fx, `lease_stub_${index}_test.py`, `w${index}`, "sleep");
			const { sha, tree } = commit(fx, "eight stub suites");
			const result = await launch(fx, sha, "workers", { FULL_SUITE_JOBS: "28" }).done;
			expect(result.rc, result.out + result.err).toBe(0);
			expect(result.out).toContain("full-suite: FULL_SUITE_JOBS=28 exceeds the inner-worker cap; using 6 (SUITESERIAL1)");
			expect(result.out).toContain("full-suite: global timing-split pool: 6 workers");
			expect(result.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			const starts = marks(fx, "start", "w"), ends = marks(fx, "end", "w");
			expect([starts.length, ends.length]).toEqual([8, 8]);
			const intervals = readdirSync(fx.marks).filter(name => name.startsWith("start.w")).map(name => {
				const [, tag, pid] = name.split(".");
				return [Number(readFileSync(join(fx.marks, name), "utf8")), Number(readFileSync(join(fx.marks, `end.${tag}.${pid}`), "utf8"))] as const;
			});
			const peak = Math.max(...intervals.map(([start]) => intervals.filter(([s, e]) => s <= start && start < e).length));
			expect(peak).toBeGreaterThanOrEqual(1);
			expect(peak).toBeLessThanOrEqual(6);
		} finally { rmSync(fx.work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(120) * 1_000);

	test("SUITESERIAL1 suite lease control: one launch alone runs as before, releases the lease at exit, and a cache hit takes none", async () => {
		const fx = leaseFixture("control");
		try {
			stub(fx, "lease_stub_test.py", "a", "fast");
			const { sha, tree } = commit(fx, "one stub suite");
			const alone = await launch(fx, sha, "alone").done;
			expect(alone.rc, alone.out + alone.err).toBe(0);
			expect(alone.out).toContain(`FULL-SUITE: cache miss for tree ${tree} role=base (no reusable verdict); running the complete suite`);
			expect(alone.out).toContain("FULL-SUITE: suite lease held by run ");
			expect(alone.out).toContain(`for tree ${tree} role=base (holder=`);
			expect(alone.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			for (const word of ["QUEUED", "JOIN", "SUITE_LEASE_ABSENT", "REFUSED"]) expect(alone.out + alone.err).not.toContain(word);
			expect(marks(fx, "start", "a").length).toBe(1);
			// Released on exit: the holder is gone, its record removed, no ticket left, and the flock is free.
			const holder = Number(alone.out.split("(holder=")[1]?.split(" ")[0]);
			expect(Number.isInteger(holder)).toBe(true);
			expect(() => process.kill(holder, 0)).toThrow();
			expect(existsSync(join(fx.lease, "suite-lease", "holder.json"))).toBe(false);
			expect(tickets(fx.lease)).toEqual([]);
			expect(leaseFree(fx.lease)).toBe("RELEASED");
			const again = await launch(fx, sha, "again").done;
			expect(again.rc, again.out + again.err).toBe(0);
			expect(again.out).toContain(`FULL-SUITE: VERDICT REUSED PASS tree=${tree} role=base`);
			expect(again.out).not.toContain("suite lease held");
			expect(marks(fx, "start", "a").length).toBe(1);
		} finally { rmSync(fx.work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(120) * 1_000);

	test("SUITESERIAL1 suite lease mutant: a judge without the lease runs two suites; a closure that lists it refuses without it", async () => {
		const fx = leaseFixture("mutant");
		const runs: Launch[] = [];
		try {
			// A copy of the judge's own closure, as land archives it, without scripts/suite-lease.sh.
			const copy = join(fx.work, "judge");
			const listed = runFixture(["python3", "-B", join(ROOT, "scripts/suite-metrics.py"), "judging-files"], { cwd: ROOT, floor_s: 30 });
			expect(listed.rc).toBe(0);
			const closure = decoder.decode(listed.stdout).trim().split("\n");
			expect(closure).toContain("scripts/suite-lease.sh");
			for (const path of [...closure, "scripts/gate-ci-only.tsv"]) {
				if (path === "scripts/suite-lease.sh" || !existsSync(join(ROOT, path))) continue;
				mkdirSync(join(copy, path, ".."), { recursive: true });
				cpSync(join(ROOT, path), join(copy, path));
			}
			const script = join(copy, "scripts/full-suite-verdict.sh");
			stub(fx, "lease_stub_test.py", "a", "gate");
			const { sha, tree } = commit(fx, "one stub suite");
			// Closure lists the lease, file missing: refused before any suite.
			const missing = await launch(fx, sha, "missing", {}, script).done;
			expect(missing.rc, missing.out + missing.err).toBe(1);
			expect(missing.err).toContain("FULL-SUITE: RED: SUITE_LEASE_MISSING: scripts/suite-lease.sh is absent beside the gate, but this judge's JUDGING_FILES list it");
			expect(marks(fx, "start", "a")).toEqual([]);
			// The mutant: a closure that predates the lease. Two launches on one tree now run two suites at once.
			const metrics = join(copy, "scripts/suite-metrics.py");
			const source = readFileSync(metrics, "utf8");
			const predating = source.replace('"scripts/suite-lease.sh", ', "");
			expect(predating).not.toBe(source);
			writeFileSync(metrics, predating);
			runs.push(launch(fx, sha, "first", {}, script), launch(fx, sha, "second", {}, script));
			await waitFor("both suites to run at once", () => marks(fx, "start", "a").length === 2);
			openGate(fx);
			const [first, second] = await Promise.all(runs.map(r => r.done));
			for (const result of [first!, second!]) {
				expect(result.rc, result.out + result.err).toBe(0);
				expect(result.out).toContain("FULL-SUITE: SUITE_LEASE_ABSENT: this judge's JUDGING_FILES predate scripts/suite-lease.sh, so this run takes no suite lease and may overlap another suite");
				expect(result.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			}
			expect(marks(fx, "start", "a").length).toBe(2);
		} finally {
			openGate(fx);
			await Promise.allSettled(runs.map(r => r.done));
			rmSync(fx.work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(180) * 1_000);

	// `omp-kit land` with PRE_PUSH_FULL_SUITE=push judges the candidate with a judge archived from the base's JUDGING_FILES
	// (src/land.ts archiveFullSuiteJudge). Planted: a second suite holds the lease, so land's judge queues and its suite
	// starts only after that suite ends. Mutant: a base whose closure predates the lease runs land's suite beside it.
	for (const variant of ["leased", "mutant"] as const) {
		test(`SUITESERIAL1 suite lease ${variant === "leased" ? "planted: an inline land judge queues behind a running suite" : "mutant: an inline land judge without the lease overlaps a running suite"}`, async () => {
			// Dynamic on purpose: the helpers build a git template (bare origin, clone, push) when loaded, a cost only these two
			// cases need; a static import would charge every release-local test with it.
			const land = await import("./private-index-land.helpers.ts");
			const fx = leaseFixture(`land-${variant}`);
			const { work, fakeBin } = land.fixture();
			const runs: Launch[] = [];
			try {
				if (variant === "mutant") {
					const metrics = join(work, "scripts/suite-metrics.py");
					const source = readFileSync(metrics, "utf8");
					const predating = source.replace('"scripts/suite-lease.sh", ', "");
					expect(predating).not.toBe(source);
					writeFileSync(metrics, predating);
					land.git(work, ["rm", "-q", "scripts/suite-lease.sh"]);
					land.git(work, ["commit", "-qam", "base predating the suite lease [test]"]);
					land.git(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
				}
				writeFileSync(join(work, "owned.txt"), `land candidate beside a running suite (${variant})\n`);
				const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
				stub(fx, "lease_stub_test.py", "held", "gate");
				const planted = commit(fx, "planted suite");
				runs.push(launch(fx, planted.sha, "planted"));
				await waitFor("the planted suite to start", () => marks(fx, "start", "held").length === 1);
				const landEnv = land.commandEnvironment(work, hold, { amDir: fakeBin, gitEnv: { PRE_PUSH_FULL_SUITE: "push", FULL_SUITE_LEASE_DIR: fx.lease } });
				const landRun = runFixtureAsync(["bun", land.cliPath, "land", ...land.landArgs("owned.txt"), "--json"],
					{ cwd: work, env: land.stringEnvironment(landEnv), floor_s: 180 });
				let queued: Record<string, unknown> | undefined;
				if (variant === "leased") {
					await waitFor("land's judge to queue for the lease", () => (queued = tickets(fx.lease).find(t => t.launcher === "full-suite-verdict" && t.role === "base")) !== undefined, 120);
					expect(marks(fx, "end", "held")).toEqual([]);
					openGate(fx);
				}
				const landed = await landRun;
				openGate(fx);
				const plantedResult = await runs[0]!.done;
				expect(plantedResult.rc, plantedResult.out + plantedResult.err).toBe(0);
				const stdout = decoder.decode(landed.stdout);
				expect(landed.rc, stdout + decoder.decode(landed.stderr)).toBe(0);
				const data = JSON.parse(stdout).data as { overall: string; commit: string };
				expect(data.overall).toBe("PUSHED");
				const tree = land.git(work, ["rev-parse", `${data.commit}^{tree}`]).trim();
				const record = JSON.parse(readFileSync(land.verdictPath(work, tree, "base", landEnv), "utf8")) as { verdict: string; evidence: { files: { started_ms: number }[] } };
				expect(record.verdict).toBe("PASS");
				const landStartedMs = Math.min(...record.evidence.files.map(row => row.started_ms));
				const plantedEndMs = marks(fx, "end", "held")[0]! / 1e6;
				if (variant === "leased") {
					expect(queued?.commit).toBe(data.commit);
					expect(landStartedMs).toBeGreaterThanOrEqual(Math.floor(plantedEndMs));
				} else {
					expect(landStartedMs).toBeLessThan(plantedEndMs);
				}
				expect(tickets(fx.lease)).toEqual([]);
			} finally {
				openGate(fx);
				await Promise.allSettled(runs.map(r => r.done));
				rmSync(fx.work, { recursive: true, force: true });
			}
		}, fixtureDeadlineS(300) * 1_000);
	}
}

// RELFAST1: run the real checksum + fetch + embedded consumer-verifier stage.
// Only gh's authority transport is a fixture; all three fetches must reach the
// barrier before any returns, so the serial implementation cannot pass.
for (const failure of ["none", "fetch", "verify"] as const) {
	test(`RELFAST1 public chains overlap and ${failure === "none" ? "all verify" : failure + " failure refuses the stage"}`, async () => {
		const work = realpathSync(ownedTmp("release-chains", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const bin = join(work, "bin");
		const dist = join(work, "dist");
		const pub = join(work, "public");
		const platforms = ["darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu"];
		for (const dir of [bin, dist, pub]) mkdirSync(dir);
		const digests = new Map<string, string>();
		for (const platform of platforms) {
			const bytes = Buffer.from(platform);
			const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
			digests.set(platform, digest);
			writeFileSync(join(dist, `omp-kit-v0.0.0-${platform}.tar`), bytes);
		}
		writeFileSync(join(dist, "SHA256SUMS"), platforms.map(platform => `${digests.get(platform)}  omp-kit-v0.0.0-${platform}.tar\n`).join(""));
		for (const name of readdirSync(dist)) cpSync(join(dist, name), join(pub, name));
		writeFileSync(join(bin, "gh"), `#!${process.execPath}
import { existsSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.RELEASE_CHAIN_WORK, args = process.argv.slice(2);
if (args[0] === "api" && args.some(a => a.includes("/attestations/"))) {
  const digest = args.find(a => a.includes("/attestations/")).split(":").pop();
  writeFileSync(join(root, "start-" + digest), "");
  const deadline = Date.now() + 5000;
  while (readdirSync(root).filter(n => n.startsWith("start-")).length !== 3) {
    if (Date.now() >= deadline) { console.error("serial fetch: overlap barrier timed out"); process.exit(19); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (process.env.RELEASE_CHAIN_FAILURE === "fetch" && digest === "${digests.get("linux-arm64-gnu")}") process.exit(17);
  console.log("{}"); process.exit(0);
}
if (args[0] === "api" && args.some(a => a.includes("/commits/"))) { console.log("a".repeat(40)); process.exit(0); }
if (args[0] === "attestation" && args[1] === "verify") {
  appendFileSync(join(root, "verified"), args[2] + "\\n");
  if (process.env.RELEASE_CHAIN_FAILURE === "verify" && args[2].includes("linux-arm64-gnu")) process.exit(18);
  process.exit(0);
}
process.exit(99);
`);
		chmodSync(join(bin, "gh"), 0o755);
		const fixture = join(work, "verify.sh");
		writeFileSync(fixture, `${stagePrelude}
ROOT=$2; SRC=$2; PUB="$WORK/public"; SHIP=(${platforms.join(" ")})
stage verify
${releaseStage("substep verify.public-bytes-and-checksums", "substep verify.gatekeeper")}
stage readback
echo VERIFIED_ALL
`);
		try {
			const result = await runFixtureAsync(["bash", fixture, work, ROOT], { cwd: ROOT,
				env: { ...process.env, TMPDIR: work, PATH: `${bin}:${process.env.PATH}`, RELEASE_CHAIN_WORK: work, RELEASE_CHAIN_FAILURE: failure }, floor_s: 45 });
			const stdout = new TextDecoder().decode(result.stdout), stderr = new TextDecoder().decode(result.stderr);
			expect(readdirSync(work).filter(name => name.startsWith("start-")).sort()).toEqual([...digests.values()].map(digest => `start-${digest}`).sort());
			expect(result.rc, stdout + stderr).toBe(failure === "none" ? 0 : 4);
			if (failure === "none") {
				expect(stdout).toContain("VERIFIED_ALL");
				for (const platform of platforms) expect(stdout).toContain(`CONSUMER_VERIFY=ok platform=${platform} sha256=${digests.get(platform)}`);
			} else {
				expect(stdout).not.toContain("VERIFIED_ALL");
				expect(stderr).toContain(failure === "fetch" ? "no attestation bundle for linux-arm64-gnu" : "the consumer verifier refuses linux-arm64-gnu");
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}
