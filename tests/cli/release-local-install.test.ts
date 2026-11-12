import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);
import { helperScript, releaseStage, stagePrelude } from "./release-local-fixture.ts";

const ROOT = join(import.meta.dir, "..", "..");

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
			git("add", "."); git("commit", "-qm", "fixture base", "-m", "Bead: ompkit-old-release");
			const base = git("rev-parse", "HEAD");
			if (!dirty) {
				// Version lines and unrelated package data belong to different landed
				// beads. Release authority must cover only the former's attribution.
				writeFileSync(join(repo, "package.json"), '{\n  "version": "1.2.3",\n  "description": "landed peer change",\n  "omp": { "version": "1.2.3" }\n}\n');
				git("add", "package.json"); git("commit", "-qm", "peer metadata", "-m", "Bead: ompkit-peer");
				writeFileSync(join(repo, ".git/hooks/commit-msg"), `#!/bin/sh\nexec sh ${JSON.stringify(join(ROOT, "scripts/check-stale-worktree.sh"))} "$1"\n`);
				chmodSync(join(repo, ".git/hooks/commit-msg"), 0o755);
			}
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
				// Reusing the release message must not authorize reverting peer data,
				// even on a version-bearing path. Run the real hook against that index.
				writeFileSync(join(work, "release-message"), message);
				writeFileSync(join(repo, "package.json"), readFileSync(join(repo, "package.json"), "utf8").replace('  "description": "landed peer change",\n', ""));
				git("add", "package.json");
				const negative = runFixture(["sh", join(ROOT, "scripts/check-stale-worktree.sh"), join(work, "release-message")],
					{ cwd: repo, env: { ...env, TMPDIR: work }, floor_s: 60 });
				expect(negative.rc).toBe(1);
				expect(new TextDecoder().decode(negative.stderr)).toContain("from bead ompkit-peer");
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}

// RELREMEDY1 (ompkit-fp72.120.16.246): writer-* replay the 0.2.91 PARTIAL whose only failures are the kit's own live
// writers (gate-events.jsonl, inbox-wake/*.json) plus the state-root snapshot budget overflow.
const writerScenarios = ["writer-partial", "writer-foreign", "writer-mutant"] as const;
const reconcileScenarios = ["reconciled-complete", "reconciled-missing-profile", "reconciled-wrong-store", "reconciled-stale-link", "reconciled-no-receipt", "reconciled-new-profile"] as const;
// RELDIAG1 (ompkit-1ra0d.210): the exact 0.2.125 shape, whose only changed files are the kit's own
// diagnostics/handler-*.json files, plus a foreign-path negative outside the kit state dir.
const diagnosticsScenarios = ["diagnostics-partial", "diagnostics-foreign"] as const;
for (const scenario of ["updated", "symlinked-work", "browser-partial", "foreign-write", "stale-link", "wrong-version", "reconcile-refused", ...writerScenarios, ...diagnosticsScenarios, ...reconcileScenarios] as const) {
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
  if (scenario.startsWith("diagnostics-")) {
    // The exact 0.2.125 PARTIAL: only the kit's own diagnostics handler files changed.
    const changed = ["~/.local/state/omp-kit/diagnostics/handler-5735d1e1dc677c5aa334220edd816432.json", "~/.local/state/omp-kit/diagnostics/handler-8c2064fd6b9c2bcdabf25f719ce89a18.json",
      ...(scenario === "diagnostics-foreign" ? ["~/.config/operator.json"] : [])];
    emit({ action: "PARTIAL", receipt_id: "cd03799d-67fd", active_version: "0.0.0", matcher: "PASS", live: "PASS", postcheck: "FAIL",
      postcheck_detail: { status: "FAIL", changed_operator_paths: changed, failed_stages: [], deferred_stages: [],
        failures: changed.map(path => "Operator file changed during isolated test: " + path),
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
			const successful = scenario === "updated" || scenario === "symlinked-work" || scenario === "browser-partial" || scenario === "writer-partial" || scenario === "diagnostics-partial" || scenario.startsWith("reconciled-");
			expect(result.rc, stderr).toBe(successful ? 0 : 4);
			const calls = readFileSync(join(work, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
			expect(calls[0]).toEqual(["update", "--apply", "--yes", "--version", "0.0.0", "--index", join(work, "public/release-index.json"),
				"--archive", join(work, "public/omp-kit-v0.0.0-darwin-arm64-none.tar.gz"), "--json"]);
			expect(calls.filter(args => args.includes("--reconcile")).length).toBe(["browser-partial", "reconcile-refused", "writer-partial", "diagnostics-partial"].includes(scenario) || scenario.startsWith("reconciled-") ? 1 : 0);
			if (scenario === "writer-partial") {
				expect(calls.find(args => args.includes("--reconcile"))).toEqual(["update", "--reconcile", "cd03799d-67fd", "--yes", "--json"]);
				expect(stdout).toContain("substep install.reconcile-kit-live-writer-state");
				expect(stderr).toContain("release-local: postcheck: ~/.local/state/omp-kit: exceeds the postcheck snapshot budget");
				expect(stderr).toContain("gate-events.jsonl: written by a kit service during the isolated test (live-writer race)");
			}
			if (scenario === "diagnostics-partial") {
				expect(calls.find(args => args.includes("--reconcile"))).toEqual(["update", "--reconcile", "cd03799d-67fd", "--yes", "--json"]);
				expect(stdout).toContain("substep install.reconcile-kit-live-writer-state");
				expect(stderr).toContain("diagnostics/handler-5735d1e1dc677c5aa334220edd816432.json: written by a kit service during the isolated test (live-writer race)");
				expect(stderr).toContain("diagnostics/handler-8c2064fd6b9c2bcdabf25f719ce89a18.json: written by a kit service during the isolated test (live-writer race)");
			}
			if (scenario === "writer-foreign" || scenario === "writer-mutant" || scenario === "diagnostics-foreign") {
				expect(stderr).toContain("not the known live-browser, kit live-writer or deferred-live PARTIAL");
				expect(stderr).toContain(`reconcile it with: ${kit} update --reconcile cd03799d-67fd --yes`);
				const apply = /re-apply with: (\S+) update --apply --yes --version 0\.0\.0 --index (\/\S+) --archive (\/\S+)$/m.exec(stderr);
				expect(apply?.[1]).toBe(kit);
				for (const source of [apply![2]!, apply![3]!]) { expect(existsSync(source)).toBe(true); expect(source.startsWith(join(work, "public"))).toBe(false); }
				if (scenario === "writer-foreign") expect(stderr).toContain("~/.omp/agent/config.yml: changed outside the kit live-writer class");
				if (scenario === "diagnostics-foreign") expect(stderr).toContain("~/.config/operator.json: changed outside the kit live-writer class");
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
				const refusal = scenario === "foreign-write" || scenario === "writer-foreign" || scenario === "writer-mutant" || scenario === "diagnostics-foreign" ? "not the known live-browser, kit live-writer or deferred-live PARTIAL"
					: scenario === "stale-link" ? "installed profile alignment is stale"
					: scenario === "wrong-version" ? "installed CLI version readback differs"
					: "live-browser-state reconcile refused";
				expect(stderr).toContain(refusal);
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}

// RELPENDINGWORD1 (ompkit-1ra0d.210): 0.2.124/0.2.125 ended rc 4 although the updater left the new
// version active with its live check pending (KITLIVEDEFER1 deferred PARTIAL), and the refusal
// skipped the all-profile relink, so the fleet kept running the old hooks.
for (const scenario of ["deferred-pending", "deferred-undone", "deferred-mutant"] as const) {
	test(`RELPENDINGWORD1 release install ${scenario} finishes the relink while the live check is pending`, async () => {
		const work = realpathSync(ownedTmp("release-pending", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
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
		const kit = join(prefix, "bin/omp-kit");
		writeFileSync(kit, `#!${process.execPath}
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
const root = process.env.RELEASE_TEST_WORK;
const scenario = process.env.RELEASE_TEST_SCENARIO;
const prefix = join(process.env.HOME, ".local/opt/omp-kit");
const store = join(prefix, "releases/0.0.0");
const args = process.argv.slice(2);
appendFileSync(join(root, "calls"), JSON.stringify(args) + "\\n");
const emit = (data, commands = [], ok = true) => console.log(JSON.stringify({ ok, data, commands }));
if (args[0] === "--version") { console.log("omp-kit 0.0.0"); process.exit(0); }
if (args[0] === "update") {
  const active = scenario === "deferred-undone" ? "0.0.1" : "0.0.0";
  emit({ action: "PARTIAL", receipt_id: "deadbeef-1234", active_version: active, matcher: "PASS", live: "NOT_RUN",
    postcheck: "DEFERRED", reason: "KIT_POSTCHECK_DEFERRED",
    postcheck_detail: { failed_stages: [], deferred_stages: ["live"], live_state_paths: [] } },
    ["omp-kit undo deadbeef-1234 --yes"], false);
  process.exit(1);
}
if (args[0] === "apply" && args[1] === "plugin") {
  for (const profile of ["", "profiles/claude/", "profiles/codex/"]) {
    const link = join(process.env.HOME, ".omp", profile, "plugins/node_modules/omp-kit-companion");
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(store, link);
  }
  emit({ action: "APPLIED" }); process.exit(0);
}
process.exit(99);
`);
		chmodSync(kit, 0o755);
		// Planted negative: today's install stage has no deferred-live branch, so the
		// PENDING-with-new-version-active case must fall through to the refusal. The
		// neuter keeps the structure identical and only makes the deferred filter
		// unreachable, which is exactly today's behavior for this envelope.
		const neuter = '($d.postcheck == "DEFERRED" or $d.reason == "KIT_POSTCHECK_DEFERRED")';
		expect(stagePrelude).toContain(neuter);
		const mutantHelpers = stagePrelude.replace(neuter, '($d.postcheck == "DEFERRED-NEVER" or false)');
		expect(mutantHelpers).not.toBe(stagePrelude);
		const installHelpers = scenario === "deferred-mutant" ? mutantHelpers : stagePrelude;
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
			const result = await runFixtureAsync(["bash", fixture, work, ROOT, home], { cwd: ROOT, env: env as Record<string, string>, floor_s: 30 });
			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);
			const calls = readFileSync(join(work, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
			if (scenario === "deferred-pending") {
				expect(result.rc, stderr).toBe(0);
				expect(stdout).toContain("live check pending (receipt deadbeef-1234");
				expect(calls.find(args => args[0] === "apply")).toEqual(["apply", "plugin", "--apply", "--yes", "--store", store, "--profiles", "all", "--include-default", "--json"]);
				expect(calls.filter(args => args.includes("--reconcile"))).toEqual([]);
				expect(JSON.parse(readFileSync(join(work, "install-align.json"), "utf8")).links).toHaveLength(3);
				expect(stdout).toContain('"installed": true');
			} else {
				expect(result.rc, stderr).toBe(4);
				expect(stdout).not.toContain('"installed": true');
				expect(stdout).not.toContain("live check pending");
				expect(calls.filter(args => args[0] === "apply")).toEqual([]);
				expect(stderr).toContain("refusing reconciliation");
			}
		} finally { rmSync(work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(60) * 1_000);
}
