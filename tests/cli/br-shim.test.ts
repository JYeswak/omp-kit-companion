import { expect, test as bunTest } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { createHash } from "node:crypto";
import { nativeBr } from "./lib/native-br.ts";
import { unlinkSync } from "node:fs";
import { callerScratchRoot } from "../../src/runtime.ts";
import { readJsonl } from "../../src/kitlib/jsonl.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fixturePycachePrefix } from "./lib/fixture-pycache.ts";

// Each scenario owns its scratch, tracker, authority and environment. No case
// observes another case's mutations, so native subprocess waits may overlap.
const test = bunTest.concurrent;
// Native serial cases below are barriers between batches of at most three
// concurrent claim cases. Queue at the test runner, before a case's clock starts,
// not inside claim(): that made later cases spend their 40 s bound waiting.

const root = resolve(import.meta.dir, "../..");
const shimSource = readFileSync(join(root, "scripts/br-shim.sh"), "utf8");
const decoder = new TextDecoder();
// Admission tests are not latency benchmarks. Each case owns at most two load-scaled
// 25s subprocess fixtures plus bounded reap and cleanup; the file gate is unchanged.
// DEADLINETESTS1: a CUTCLAIM1 case's load-normalized p95 is 8.1 s (n=79 full-suite runs at
// load1 >= 18), so one claim gets 3x that whole-case p95, and a case two claims plus setup.
const CASE_BUDGET_MS = fixtureDeadlineS(60) * 1_000;
const claimPrograms = ownedTmp("cutclaim-programs");

// Share immutable executable bytes, never scenario data or tracker mutations.
function claimProgram(name: string, source: string): string {
	const path = join(claimPrograms.path, name);
	if (!existsSync(path)) writeFileSync(path, source, { mode: 0o755 });
	return path;
}

type Scenario = {
	id?: string;
	extraIds?: string[];
	claimArgs?: string[];
	explicitDb?: boolean;
	authority?: "source" | "failed" | "missing" | "invalid";
	config?: "cut" | "malformed" | "missing" | "default-missing" | "unlisted" | "no-milestone";
	labels?: string[];
};


/** Real shell bridge and real source CLI; only external tracker and mail services are fixtures. */
async function claim(options: Scenario = {}) {
	const scratch = ownedTmp("cutclaim-shell-test");
	try {
		const home = join(scratch.path, "home");
		const project = join(scratch.path, "tracker");
		const decoy = join(scratch.path, "unrelated-tracker");
		const release = join(scratch.path, "release");
		const bin = join(scratch.path, "bin");
		for (const path of [home, join(project, ".beads"), join(decoy, ".beads"), join(release, "scripts"), join(release, "bin"), bin]) {
			mkdirSync(path, { recursive: true });
		}
		for (const module of ["kitlib_run.py", "pysafe.py", "claim_verdict.py"]) {
			copyFileSync(join(root, "scripts", module), join(release, "scripts", module));
		}
		// Closed PATH prevents a standalone-Bun fallback; this fixture's authority loads the real source CLI.
		for (const utility of ["dirname", "basename", "python3"]) {
			const executable = Bun.which(utility);
			if (!executable) throw new Error(`CUTCLAIM1 fixture requires ${utility}`);
			symlinkSync(executable, join(bin, utility));
		}
		const shim = join(release, "scripts/br-shim.sh");
		writeFileSync(shim, shimSource);
		const mutations = join(scratch.path, "mutations.jsonl");
		const unexpected = join(scratch.path, "unexpected-tracker-argv");
		const rows = ["k-1", "k-2"].map(id => ({
			id, title: `Claim ${id}`, status: "open", assignee: null,
			labels: options.labels ?? [], dependencies: [], updated_at: "2026-10-30T00:00:00Z",
			acceptance_criteria: "- [ ] [a] [build] claim path works `true` -> rc 0; planted negative: foreign custody refused",
		}));
		const readFlags = ["--no-auto-import", "--no-auto-flush"];
		const trackerArgv = [
			...["k-1", "k-2"].map(id => ["show", id, "--json", ...readFlags]),
			...["k-1", "k-2"].flatMap(first => ["k-1", "k-2"].map(second => ["show", first, second, "--json", ...readFlags])),
			["list", "--status", "all", "--fields", "id,status,assignee,labels", "--json", "--limit", "0", ...readFlags],
			["blocked", "--json", "--limit", "0", ...readFlags],
			["list", "--assignee", "CutClaimShellFixture", "--status", "in_progress", "--json", ...readFlags],
			["where"],
			...["k-1", "k-2"].map(id => ["update", id, "--claim", ...(options.claimArgs ?? []), "--actor", "CutClaimShellFixture"]),
		];
		const realBr = join(bin, "br");
		// Only the external tracker is a protocol fixture. Shell builtins avoid an
		// env -> Python interpreter/import startup for every three-second read.
		// Rows still derive from this scenario; real shim, CLI and verdict readers stay intact.
		symlinkSync(claimProgram("br", `#!/bin/sh
unexpected_argv() {
  printf 'unexpected tracker argv:' >&2
  printf ' <%s>' "$@" >&2
  printf '\\n' >&2
  printf 'unexpected tracker argv: <%s>\\n' "$*" >> "$CUTCLAIM_UNEXPECTED"
  exit 8
}
separator='${String.fromCharCode(31)}'
signature=
database=\${BEADS_DB:-}
verb=; ids=; claim=0; assignee=0; take_db=0; db_count=0
for arg do
  if [ "$take_db" = 1 ]; then database=$arg; take_db=0; continue; fi
  if [ "$arg" != --db ]; then
    case "$arg" in *"$separator"*|*'
'*) unexpected_argv "$@" ;; esac
    if [ -z "$signature" ]; then signature=$arg; else signature="$signature$separator$arg"; fi
  fi
  case "$arg" in
    --db) db_count=$((db_count + 1)); [ "$db_count" = 1 ] || unexpected_argv "$@"; take_db=1 ;;
    --claim) claim=1 ;;
    --assignee) assignee=1 ;;
    --*) ;;
    *) if [ -z "$verb" ]; then verb=$arg; else ids="$ids $arg"; fi ;;
  esac
done
[ "$take_db" = 0 ] || unexpected_argv "$@"
if [ "$database" != "$CUTCLAIM_TRACKER_DB" ]; then
  printf 'wrong tracker database: %s\\n' "$database" >&2
  printf 'wrong tracker database: %s\\n' "$database" >> "$CUTCLAIM_UNEXPECTED"
  exit 9
fi
case "$verb" in
  show|list|blocked|where) [ "$db_count" = 1 ] || unexpected_argv "$@" ;;
  update) [ "$db_count" = "$CUTCLAIM_EXPLICIT_DB" ] || unexpected_argv "$@" ;;
esac
known=0
while IFS= read -r expected; do
  if [ "$signature" = "$expected" ]; then known=1; break; fi
done <<FIXTURE_EXACT_ARGV
$CUTCLAIM_ARGV
FIXTURE_EXACT_ARGV
[ "$known" = 1 ] || unexpected_argv "$@"
row1=$CUTCLAIM_ROW_ONE
row2=$CUTCLAIM_ROW_TWO
mutation1=$CUTCLAIM_MUTATION_ONE
mutation2=$CUTCLAIM_MUTATION_TWO
case "$verb" in
  show)
    found=; count=0
    for id in $ids; do
      case "$id" in k-1) row=$row1 ;; k-2) row=$row2 ;; *) exit 2 ;; esac
      if [ "$count" = 0 ]; then found=$row; else found="$found,$row"; fi
      count=$((count + 1))
    done
    if [ "$count" = 1 ]; then printf '%s\\n' "$found"; else printf '[%s]\\n' "$found"; fi ;;
  list)
    if [ "$assignee" = 1 ]; then printf '[]\\n'; else printf '[%s,%s]\\n' "$row1" "$row2"; fi ;;
  blocked) printf '{"issues":[],"has_more":false}\\n' ;;
  where) printf 'database: %s\\n' "$database" ;;
  update)
    [ "$claim" = 1 ] || exit 8
    case "$ids" in
      " k-1"|" k-1 "*) printf '%s\\n' "$mutation1" >> "$CUTCLAIM_MUTATIONS" ;;
      " k-2"|" k-2 "*) printf '%s\\n' "$mutation2" >> "$CUTCLAIM_MUTATIONS" ;;
      *) exit 2 ;;
    esac ;;
  *) unexpected_argv "$@" ;;
esac
`), realBr);
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"CutClaimShellFixture"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		const authority = options.authority ?? "source";
		if (authority !== "missing") {
			// Exercise malformed native authority data without manufacturing an allow verdict.
			const alteredLauncher = authority === "invalid" ? `#!${process.execPath}
import { run } from ${JSON.stringify(join(root, "src/kitlib/run.ts"))};
import { fixtureDeadlineS } from ${JSON.stringify(join(root, "tests/cli/fixture-process.ts"))};
const result = await run([process.execPath, ${JSON.stringify(join(root, "src/cli.ts"))}, ...process.argv.slice(2)],
  { deadline_s: fixtureDeadlineS(30), cwd: process.cwd(), env: { ...process.env }, max_output_bytes: 4 * 1024 * 1024 });
if (result.timed_out || result.truncated || ![0, 1].includes(result.rc)) {
  throw new Error("real preflight fixture failed: " + new TextDecoder().decode(result.stderr));
}
const doc = JSON.parse(new TextDecoder().decode(result.stdout));
doc.data.findings = null;
console.log(JSON.stringify(doc));
process.exitCode = 0;
` : "";
			const launcher = authority === "failed"
				? `#!${process.execPath}\nconsole.error("native authority unavailable"); process.exitCode = 7;\n`
				: alteredLauncher || `#!${process.execPath}\nimport { runCli } from ${JSON.stringify(join(root, "src/cli.ts"))};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`;
			symlinkSync(claimProgram(`omp-kit-${authority}`, launcher), join(release, "bin/omp-kit"));
		}
		const config = join(scratch.path, "fleet-watch.json");
		if (options.config === "malformed") writeFileSync(config, "{not JSON");
		else if (options.config !== "missing") {
			writeFileSync(config, JSON.stringify({ sessions: [
				{ repo: decoy, milestone: { epic: "decoy", due: "2026-11-01", declaredAt: "2026-10-30T00:00:00Z", pinned: ["k-2"] } },
				{ repo: options.config === "unlisted" ? join(scratch.path, "other-project") : project, ...(options.config === "no-milestone" ? {} : {
					milestone: { epic: "cut", due: "2026-11-01", declaredAt: "2026-10-30T00:00:00Z", pinned: ["k-1"] },
				}) },
			] }));
		}
		const db = join(project, ".beads/beads.db");
		const id = options.id ?? "k-2";
		const env = { ...process.env };
		delete env.OMP_KIT_FLEET_WATCH_CONFIG;
		const result = await run(["/bin/sh", shim, ...(options.explicitDb ? ["--db", db] : []), "update", id, ...(options.extraIds ?? []), "--claim", ...(options.claimArgs ?? [])], {
			cwd: decoy, deadline_s: fixtureDeadlineS(25),
			env: { ...env, HOME: home, PATH: bin, AGENT_NAME: "CutClaimShellFixture",
				XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
				...(options.config === "default-missing" ? {} : { OMP_KIT_FLEET_WATCH_CONFIG: config }), BR_REAL: realBr,
				BEADS_DB: options.explicitDb ? join(decoy, ".beads/beads.db") : db,
				CUTCLAIM_TRACKER_DB: db, CUTCLAIM_MUTATIONS: mutations,
				CUTCLAIM_UNEXPECTED: unexpected,
				CUTCLAIM_EXPLICIT_DB: options.explicitDb ? "1" : "0",
				CUTCLAIM_ARGV: trackerArgv.map(argv => argv.join(String.fromCharCode(31))).join("\n"),
				CUTCLAIM_ROW_ONE: JSON.stringify(rows[0]), CUTCLAIM_ROW_TWO: JSON.stringify(rows[1]),
				CUTCLAIM_MUTATION_ONE: JSON.stringify({ id: "k-1", database: db }),
				CUTCLAIM_MUTATION_TWO: JSON.stringify({ id: "k-2", database: db }),
				TMPDIR: scratch.path },
		});
		// Do not let a changed reader query masquerade as an expected fail-closed verdict.
		if (existsSync(unexpected)) throw new Error(readFileSync(unexpected, "utf8"));
		return { rc: result.rc, timedOut: result.timed_out,
			output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
			mutations: existsSync(mutations) ? readFileSync(mutations, "utf8") : "" };
	} finally {
		scratch.cleanup();
	}
}

test("RETIREGUARD1 actual shim claims unpinned authorized work with its explicit tracker", async () => {
	for (const explicitDb of [false, true]) {
		const allowed = await claim({ explicitDb });
		expect(allowed.timedOut).toBe(false);
		expect(allowed.rc, allowed.output).toBe(0);
		expect(allowed.mutations).toContain('"id":"k-2"');
	}
}, CASE_BUDGET_MS);

for (const authority of ["missing", "failed", "invalid"] as const) {
	bunTest.serial(`native ${authority} authority cannot grant unreadable custody`, async () => {
		const result = await claim({ authority, id: "k-1" });
		expect(result.rc).toBe(4);
		expect(result.output).toContain("BR_SHIM_CLAIM_UNKNOWN");
		expect(result.mutations).toBe("");
	}, CASE_BUDGET_MS);
}

test("native multi-ID claims remain target-bound", async () => {
	const result = await claim({ id: "k-1", extraIds: ["k-2"] });
	expect(result.rc).toBe(4);
	expect(result.output).toContain("BR_SHIM_CLAIM_UNKNOWN");
	expect(result.output).toContain("multi-ID");
	expect(result.mutations).toBe("");
}, CASE_BUDGET_MS);

for (const config of ["missing", "malformed"] as const) {
	test(`RETIREGUARD1 ${config} irrelevant cut does not veto actual shim claim`, async () => {
		const result = await claim({ config, id: "k-1" });
		expect(result.rc, result.output).toBe(0);
		expect(result.mutations).toContain('"id":"k-1"');
	}, CASE_BUDGET_MS);
}

for (const config of ["default-missing", "unlisted", "no-milestone"] as const) {
	test(`CUTCLAIM1 ${config} admits an outsider without a pillar through the actual shim`, async () => {
		const allowed = await claim({ config });
		expect(allowed.timedOut).toBe(false);
		expect(allowed.rc).toBe(0);
		expect(allowed.mutations).toContain('"id":"k-2"');
	}, CASE_BUDGET_MS);
}

bunTest.serial("CUTCLAIM1 value flags do not become extra claim targets", async () => {
	const result = await claim({ id: "k-1", claimArgs: ["-p", "1", "--description", "ordinary claim metadata", "--add-label", "gate"] });
	expect(result.rc).toBe(0);
	expect(result.mutations).toContain('"id":"k-1"');
}, CASE_BUDGET_MS);
async function publicationGit(repo: string, args: string[]): Promise<string> {
	const result = await run(["git", "-C", repo, ...args], {
		deadline_s: fixtureDeadlineS(30), cwd: repo, env: { ...process.env }, max_output_bytes: 1024 * 1024,
	});
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr)}`);
	return decoder.decode(result.stdout).trim();
}

test("PUBLISHGATE1 actual br shim refuses transitions until origin/main contains cited commits", async () => {
	const scratch = ownedTmp("publish-gate-shim");
	try {
		const repo = join(scratch.path, "repo");
		const origin = join(scratch.path, "origin.git");
		const bin = join(scratch.path, "bin");
		const scripts = join(scratch.path, "scripts");
		mkdirSync(repo, { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(scripts, { recursive: true });
		await publicationGit(scratch.path, ["init", "--bare", origin]);
		await publicationGit(repo, ["init", "-q", "-b", "main"]);
		await publicationGit(repo, ["config", "user.email", "test@invalid.example"]);
		await publicationGit(repo, ["config", "user.name", "Test"]);
		await publicationGit(repo, ["commit", "--no-verify", "--allow-empty", "-m", "published parent"]);
		await publicationGit(repo, ["remote", "add", "origin", origin]);
		await publicationGit(repo, ["push", "--set-upstream", "origin", "main"]);
		await publicationGit(repo, ["commit", "--no-verify", "--allow-empty", "-m", "unpublished candidate", "-m", "Bead: k-pub", "-m", "Agent: Builder"]);
		const sha = await publicationGit(repo, ["rev-parse", "HEAD"]);
		const db = join(repo, ".beads/beads.db");
		mkdirSync(join(repo, ".beads"), { recursive: true });
		const mutations = join(scratch.path, "mutations.jsonl");
		const shim = join(scripts, "br-shim.sh");
		const guard = join(scripts, "close-guard.sh");
		writeFileSync(shim, readFileSync(join(root, "scripts/br-shim.sh"), "utf8"), { mode: 0o755 });
		writeFileSync(guard, readFileSync(join(root, "scripts/close-guard.sh"), "utf8"), { mode: 0o755 });
		writeFileSync(join(scripts, "br-update-lint.py"), `#!/usr/bin/env python3
import os, runpy, sys
real = ${JSON.stringify(join(root, "scripts/br-update-lint.py"))}
if sys.argv[1:2] == ["publication-citations"]:
    sys.path.insert(0, os.path.dirname(real))
    sys.argv[0] = real
    runpy.run_path(real, run_name="__main__")
else:
    raise SystemExit(0)
`, { mode: 0o755 });
		const fakeBr = join(bin, "br");
		writeFileSync(fakeBr, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--db") args.splice(0, 2);
if (args[0] === "show" && args[1] === "k-pub") {
  console.log(JSON.stringify({ id: "k-pub", assignee: "Builder", updated_at: "2026-11-01T00:00:00Z" }));
} else if (args[0] === "update" || args[0] === "close") {
  appendFileSync(process.env.PUBLISH_MUTATIONS, JSON.stringify(args) + "\\n");
} else {
  console.error("unexpected br command " + JSON.stringify(args));
  process.exit(2);
}
`, { mode: 0o755 });
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"Verifier"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		const runShim = async (args: string[]) => {
			const result = await run(["sh", shim, ...args], {
				deadline_s: fixtureDeadlineS(30), cwd: repo, env: {
					...process.env, AGENT_NAME: "Verifier", BEADS_DB: db, BR_REAL: fakeBr,
					PUBLISH_MUTATIONS: mutations,
					PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				}, max_output_bytes: 1024 * 1024,
			});
			return { rc: result.rc, output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
		};
		const update = (reason: string) => runShim(["update", "k-pub", "--status", "in_review", "--transition-comment", reason]);
		const close = (reason: string) => runShim(["close", "k-pub", "--reason", reason]);
		for (const rejected of [
			await update(`DONE k-pub ${sha} evidence`),
			await close(`Lesson: none\nexport ${sha}`),
		]) {
			expect(rejected.rc, rejected.output).toBe(4);
			expect(rejected.output).toContain("NOT_PUBLISHED");
			expect(rejected.output).toContain(sha);
			expect(rejected.output).toContain("git_converge.py --push");
		}
		expect(existsSync(mutations)).toBe(false);
		for (const reason of ["export 0000000000000000000000000000000000000000"]) {
			const rejected = await update(reason);
			expect(rejected.rc, rejected.output).toBe(4);
			expect(rejected.output).toContain("NOT_PUBLISHED");
			expect(rejected.output).toContain("UNKNOWN");
		}
		await publicationGit(repo, ["push", "origin", "main"]);
		for (const admitted of [
			await update(`DONE k-pub ${sha} evidence`),
			await close(`Lesson: none\nexport ${sha}`),
		]) {
			expect(admitted.rc, admitted.output).toBe(0);
			expect(admitted.output).toContain("close-guard: OK");
		}
		const beforeFetchFailure = readFileSync(mutations, "utf8");
		await publicationGit(repo, ["remote", "set-url", "origin", join(scratch.path, "missing.git")]);
		const fetchFailure = await update(`DONE k-pub ${sha} evidence`);
		expect(fetchFailure.rc, fetchFailure.output).toBe(4);
		expect(fetchFailure.output).toContain("NOT_PUBLISHED");
		expect(fetchFailure.output).toContain("UNKNOWN");
		expect(readFileSync(mutations, "utf8")).toBe(beforeFetchFailure);
		const beforeNoCitation = readFileSync(mutations, "utf8");
		const noCitationClose = await close("Lesson: none");
		expect(noCitationClose.rc, noCitationClose.output).toBe(0);
		expect(noCitationClose.output).toContain("close-guard: OK");
		const afterNoCitation = readFileSync(mutations, "utf8");
		expect(afterNoCitation.slice(beforeNoCitation.length)).toBe(`${JSON.stringify(["close", "k-pub", "--reason", "Lesson: none", "--actor", "Verifier"])}\n`);
	} finally {
		scratch.cleanup();
	}
}, CASE_BUDGET_MS);

const HANDOFF_AC = "- [x] [a] [build] preserve the source payload; reject a missing payload `sh tests/replay.sh` -> rc 0";

/** Native Git and tracker state; only the optional external mail transport is a protocol fixture. */
async function handoffRepo(companion = false, storegate = false) {
	const scratch = ownedTmp("handoff-repo-native");
	const tracker = join(scratch.path, "tracker");
	const code = join(scratch.path, storegate ? ".claude" : "source @ quoted'path");
	const bin = join(scratch.path, "bin");
	const origin = join(scratch.path, "origin.git");
	const backend = nativeBr();
	for (const path of [tracker, code, bin]) mkdirSync(path);
	const env: Record<string, string> = {
		HOME: scratch.path, TMPDIR: scratch.path, XDG_STATE_HOME: join(scratch.path, "state"),
		XDG_CONFIG_HOME: join(scratch.path, "config"), PATH: `${bin}:${process.env.PATH ?? ""}`,
		AGENT_NAME: "HandoffAuthor", BR_REAL: backend, PYTHONDONTWRITEBYTECODE: "1",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
	};
	const checked = async (argv: string[], cwd = tracker) => {
		const result = await run(argv, { cwd, env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4 << 20 });
		if (result.rc !== 0 || result.timed_out || result.truncated) {
			throw new Error(`${argv.join(" ")}: ${result.rc}\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
		}
		return decoder.decode(result.stdout).trim();
	};
	try {
		symlinkSync(backend, join(bin, "br"));
		// suite-metrics.py runtime (called here and by the shim's storegate key) ignores the caller's PATH:
		// it rebuilds PATH from scripts/fixed-env.sh under this fixture's HOME, where bun is found only at
		// fixed system paths or $HOME/.bun/bin. CI installs bun under the runner's real HOME, so the fixture
		// HOME carries its own entry for the running bun.
		mkdirSync(join(scratch.path, ".bun", "bin"), { recursive: true });
		symlinkSync(process.execPath, join(scratch.path, ".bun", "bin", "bun"));
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"HandoffAuthor"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		await checked(["git", "init", "--bare", "-q", "--template=", origin]);
		for (const repo of [tracker, code]) {
			await checked(["git", "init", "-q", "--template=", "-b", "main", repo]);
			await checked(["git", "-C", repo, "config", "user.name", "Fixture"]);
			await checked(["git", "-C", repo, "config", "user.email", "fixture@invalid.example"]);
			mkdirSync(join(repo, "tests"));
			writeFileSync(join(repo, "payload.txt"), "preserved\n");
			writeFileSync(join(repo, "tests/replay.sh"), "#!/bin/sh\ntest -f payload.txt\n");
		}
		if (companion) {
			mkdirSync(join(code, "scripts"));
			writeFileSync(join(code, "scripts/fresh-gate.sh"), "#!/bin/sh\nexit 97\n");
		}
		if (storegate) {
			mkdirSync(join(scratch.path, "Developer"));
			symlinkSync(root, join(scratch.path, "Developer/omp-kit-companion"));
			mkdirSync(join(code, ".githooks/hooks.d/pre-push"), { recursive: true });
			writeFileSync(join(code, ".githooks/hooks.d/pre-push/10-pre-push"), "#!/bin/bash\nexit 0\n");
			writeFileSync(join(code, ".githooks/hooks.d/pre-push/storegate-verdict.py"), "raise SystemExit(0)\n");
			await checked(["git", "-C", code, "commit", "--allow-empty", "-qm", "source parent"]);
			await checked(["git", "-C", code, "add", ".githooks"]);
		}
		await checked(["git", "-C", code, "add", "payload.txt", "tests", ...(companion ? ["scripts"] : [])]);
		await checked(["git", "-C", code, "commit", "-qm", "owned source fixture", "-m", "Agent: HandoffAuthor"]);
		const commit = await checked(["git", "-C", code, "rev-parse", "HEAD"]);
		await checked(["git", "-C", code, "remote", "add", "origin", origin]);
		await checked(["git", "-C", code, "push", "-q", "--set-upstream", "origin", "main"]);
		const db = join(tracker, ".beads/beads.db");
		const br = (args: string[]) => checked([backend, "--db", db, "--no-auto-import", "--no-auto-flush", ...args]);
		await br(["init", "--prefix", "hh", "--actor", "HandoffAuthor"]);
		const beads = ["hh-owned", "hh-other"].map(id => ({
			id, title: "Preserve native source handoff", issue_type: "task", priority: 2,
			status: "in_progress", assignee: "HandoffAuthor", created_by: "HandoffAuthor",
			created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
			labels: ["fixture"], dependencies: [], comments: [],
			description: "WHAT: preserve the exact source handoff. WHY: a missing observation must refuse without changing native state.",
			acceptance_criteria: HANDOFF_AC,
		}));
		writeFileSync(join(tracker, ".beads/issues.jsonl"), beads.map(b => JSON.stringify(b)).join("\n") + "\n");
		await br(["sync", "--import-only", "--actor", "HandoffAuthor"]);
		const shim = (args: string[], input?: string, cwd = code) => run(["sh", join(root, "scripts/br-shim.sh"), "--db", db, ...args], {
			cwd, env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4 << 20,
			...(input === undefined ? {} : { stdin: input }),
		});
		const status = async (id = "hh-owned") => {
			const values = JSON.parse(await br(["show", id, "--json"]));
			return (Array.isArray(values) ? values[0] : values).status;
		};
		const comments = async () => JSON.parse(await br(["comments", "list", "hh-owned", "--json"]));
		const ledger = (rc = 0, observedCommit = commit, complete = true) => {
			const dir = join(code, ".git/omp-kit");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "fresh-gate-runs.jsonl"), JSON.stringify({
				version: 2, commit: observedCommit, rc, evidence: { complete },
			}) + "\n");
		};
		return { scratch, tracker, code, commit, shim, status, comments, ledger, checked, br, env,
			done: `DONE ${code}@${commit}: exact native source observation` };
	} catch (error) {
		scratch.cleanup();
		throw error;
	}
}

test("HANDOFFREPO1 unknown repo refuses without mutation and never borrows a companion ledger", async () => {
	const f = await handoffRepo();
	try {
		const before = await f.comments();
		const result = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		const out = decoder.decode(result.stderr);
		expect(result.rc).toBe(4);
		expect(out).toContain("HANDOFF_UNGATED");
		// HANDOFFPUSHCHECK1: an unknown repo without .omp/push-check names committing
		// the check and the push-check command, never a script the repo lacks.
		expect(out).toContain("commit an executable .omp/push-check");
		expect(out).toContain("omp-kit push-check --commit");
		expect(out).not.toContain("fresh-gate.sh");
		expect(out).toContain(`${f.code}@${f.commit}`);
		expect(await f.status()).toBe("in_progress");
		expect(await f.comments()).toEqual(before);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("HANDOFFREPO1 any repo admits only its own exact complete GREEN fresh-gate observation", async () => {
	const f = await handoffRepo();
	try {
		const before = await f.comments();
		for (const [rc, commit, complete] of [
			[1, f.commit, true], [0, f.commit, false], [0, "0".repeat(40), true],
		] as const) {
			f.ledger(rc, commit, complete);
			const refused = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
			expect(refused.rc, decoder.decode(refused.stderr)).toBe(4);
			expect(await f.status()).toBe("in_progress");
			expect(await f.comments()).toEqual(before);
		}
		f.ledger();
		const admitted = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(admitted.rc, decoder.decode(admitted.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("HANDOFFREPO1 companion still requires its ledger even if its committed script is missing from the worktree", async () => {
	const f = await handoffRepo(true);
	try {
		unlinkSync(join(f.code, "scripts/fresh-gate.sh"));
		const refused = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(refused.rc).toBe(4);
		expect(decoder.decode(refused.stderr)).toContain("no declared gate exists");
		expect(await f.status()).toBe("in_progress");
		f.ledger();
		const control = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(control.rc, decoder.decode(control.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("HANDOFFREPO1 native storegate requires the exact current marker, not queue success or JSON PASS", async () => {
	const f = await handoffRepo(false, true);
	try {
		const handoff = () => f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		const missing = await handoff();
		expect(missing.rc).toBe(4);
		expect(decoder.decode(missing.stderr)).toContain(`python3 .githooks/hooks.d/pre-push/storegate-verdict.py queue ${f.commit}`);
		await f.checked(["python3", ".githooks/hooks.d/pre-push/storegate-verdict.py", "queue", f.commit], f.code);
		f.ledger();
		const ledgerOnly = await handoff();
		expect(ledgerOnly.rc, decoder.decode(ledgerOnly.stderr)).toBe(4);
		expect(await f.status()).toBe("in_progress");
		const dir = join(f.code, ".git/omp-kit/storegate-pass");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "verdict.json"), '{"verdict":"PASS"}\n');
		expect((await handoff()).rc).toBe(4);
		const tree = await f.checked(["git", "-C", f.code, "rev-parse", `${f.commit}^{tree}`]);
		const parent = await f.checked(["git", "-C", f.code, "rev-parse", `${f.commit}^`]);
		const hook = await f.checked(["git", "-C", f.code, "hash-object", ".githooks/hooks.d/pre-push/10-pre-push"]);
		const runtime = await f.checked(["python3", join(root, "scripts/suite-metrics.py"), "runtime"]);
		const payload = `storegate-v2\n${tree}\n${parent}\n${hook}\n${runtime}\n`;
		const hashed = await run(["git", "-C", f.code, "hash-object", "--stdin"], {
			env: f.env, stdin: payload, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4096,
		});
		expect(hashed.rc).toBe(0);
		const marker = join(dir, decoder.decode(hashed.stdout).trim());
		writeFileSync(marker, "");
		writeFileSync(join(f.code, ".githooks/hooks.d/pre-push/10-pre-push"), "#!/bin/bash\nexit 0\n# changed\n");
		expect((await handoff()).rc).toBe(4);
		writeFileSync(join(f.code, ".githooks/hooks.d/pre-push/10-pre-push"), "#!/bin/bash\nexit 0\n");
		unlinkSync(marker);
		expect((await handoff()).rc).toBe(4);
		writeFileSync(marker, "");
		const green = await handoff();
		expect(green.rc, decoder.decode(green.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test.each(["separate", "equals"] as const)(
	"HANDOFFSOURCE1 tracker-cwd review reads the %s append-notes DONE source and requires its exact complete GREEN row",
	async (form: "separate" | "equals") => {
		const f = await handoffRepo(true);
		try {
			const notes = form === "separate" ? ["--append-notes", f.done] : [`--append-notes=${f.done}`];
			const handoff = () => f.shim(["update", "hh-owned", "--status", "in_review", ...notes], undefined, f.tracker);
			const before = await f.comments();
			const missing = await handoff();
			expect(decoder.decode(missing.stderr)).toContain(`${f.code}@${f.commit}`);
			expect(missing.rc).toBe(4);
			expect(await f.status()).toBe("in_progress");
			for (const [rc, observedCommit, complete] of [
				[1, f.commit, true], [0, "f".repeat(40), true], [0, f.commit, false],
			] as const) {
				f.ledger(rc, observedCommit, complete);
				const refused = await handoff();
				expect(refused.rc, decoder.decode(refused.stderr)).toBe(4);
				expect(decoder.decode(refused.stderr)).toContain(`${f.code}@${f.commit}`);
				expect(await f.status()).toBe("in_progress");
			}
			expect(await f.comments()).toEqual(before);
			f.ledger();
			const admitted = await handoff();
			expect(admitted.rc, decoder.decode(admitted.stderr)).toBe(0);
			expect(await f.status()).toBe("in_review");
			const bead = JSON.parse(await f.br(["show", "hh-owned", "--json"]));
			expect((Array.isArray(bead) ? bead[0] : bead).notes).toContain(f.done);
		} finally { f.scratch.cleanup(); }
	}, fixtureDeadlineS(120) * 1_000,
);

test("HANDOFFSOURCE1 a GREEN source ledger cannot admit review without a DONE source", async () => {
	const f = await handoffRepo(true);
	try {
		f.ledger();
		const result = await f.shim(["update", "hh-owned", "--status", "in_review", "--append-notes",
			"Implementation evidence without a source claim"], undefined, f.tracker);
		expect(result.rc).toBe(4);
		expect(decoder.decode(result.stderr)).toContain("HANDOFF_UNGATED");
		expect(await f.status()).toBe("in_progress");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("HANDOFFTREE1 a GREEN candidate differing from the landed commit only in author and committer time admits the handoff; other parent, tree, message, author/committer email or rc 1 refuse", async () => {
	const f = await handoffRepo(true);
	try {
		const tree = await f.checked(["git", "-C", f.code, "rev-parse", `${f.commit}^{tree}`]);
		const parents = (await f.checked(["git", "-C", f.code, "rev-parse", `${f.commit}^@`])).split("\n").filter(Boolean);
		const authorDate = await f.checked(["git", "-C", f.code, "log", "-1", "--format=%ad", "--date=raw", f.commit]);
		const laterCommitterDate = `${Number(authorDate.split(" ")[0]) + 21} +0000`;
		// FULLHANDOFF1: the commit gate builds its candidate with commit-tree when judging starts, so its
		// author time precedes the landed commit's by the gate's duration (139 s on e67c648bae).
		const earlierAuthorDate = `${Number(authorDate.split(" ")[0]) - 139} +0000`;
		const commitTree = async (treeId: string, parentIds: string[], extra: Record<string, string> = {},
			message = "owned source fixture") => {
			const result = await run(["git", "-C", f.code, "commit-tree", treeId, ...parentIds.flatMap(p => ["-p", p]),
				"-m", message, "-m", "Agent: HandoffAuthor"], {
				cwd: f.code, deadline_s: fixtureDeadlineS(30), max_output_bytes: 1 << 20,
				env: { ...f.env, GIT_COMMITTER_DATE: laterCommitterDate, GIT_AUTHOR_DATE: earlierAuthorDate, ...extra },
			});
			expect(result.rc, decoder.decode(result.stderr)).toBe(0);
			return decoder.decode(result.stdout).trim();
		};
		const candidate = await commitTree(tree, parents);
		expect(candidate).not.toBe(f.commit);
		const otherParent = await commitTree(tree, [candidate]);
		const emptyTree = await f.checked(["git", "-C", f.code, "hash-object", "-t", "tree", "-w", "/dev/null"]);
		const otherTree = await commitTree(emptyTree, parents);
		const otherMessage = await commitTree(tree, parents, {}, "changed source fixture");
		const otherAuthor = await commitTree(tree, parents, { GIT_AUTHOR_EMAIL: "other@invalid.example" });
		const otherCommitter = await commitTree(tree, parents, { GIT_COMMITTER_EMAIL: "other@invalid.example" });
		const ledger = (commit: string, rc = 0) => {
			const dir = join(f.code, ".git/omp-kit");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "fresh-gate-runs.jsonl"), JSON.stringify({ version: 2, commit, rc, evidence: { complete: true } }) + "\n");
		};
		const handoff = () => f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		for (const [commit, rc] of [[otherParent, 0], [otherTree, 0], [otherMessage, 0], [otherAuthor, 0], [otherCommitter, 0],
			[candidate, 1], ["f".repeat(40), 0]] as const) {
			ledger(commit, rc);
			const refused = await handoff();
			expect(refused.rc, `${commit} rc=${rc}`).toBe(4);
			expect(decoder.decode(refused.stderr)).toContain("HANDOFF_UNGATED");
			expect(await f.status()).toBe("in_progress");
		}
		// EMPTYROW1: land's second fresh-gate pass appends a passing row that selected nothing; it must not
		// shadow the complete row before it. A later failing row still refuses.
		const rows = (commit: string, ...entries: object[]) => writeFileSync(join(f.code, ".git/omp-kit/fresh-gate-runs.jsonl"),
			entries.map(entry => JSON.stringify({ version: 2, commit, ...entry }) + "\n").join(""));
		rows(candidate, { rc: 0, evidence: { complete: true } }, { rc: 1, evidence: { complete: false, declared_files: [], files: [] } });
		expect((await handoff()).rc).toBe(4);
		expect(await f.status()).toBe("in_progress");
		// TRAILBLANK1: the gate's commit-tree candidate keeps trailing blank message lines that git commit strips
		// (bb5ef520ba); only those may differ.
		const messageFile = join(f.code, ".git", "trailing-message.txt");
		writeFileSync(messageFile, "owned source fixture\n\nAgent: HandoffAuthor\n\n\n");
		const trailing = await f.checked(["git", "-C", f.code, "commit-tree", tree, ...parents.flatMap(p => ["-p", p]), "-F", messageFile]);
		rows(trailing, { rc: 0, evidence: { complete: true } }, { rc: 0, evidence: { complete: false, declared_files: [], files: [] } });
		const admitted = await handoff();
		expect(admitted.rc, decoder.decode(admitted.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

/** Native Git and tracker state with a committed executable .omp/push-check (HANDOFFPUSHCHECK1). */
async function pushCheckHandoffRepo(checkBody: string) {
	const scratch = ownedTmp("pushcheck-handoff-native");
	const tracker = join(scratch.path, "tracker");
	const code = join(scratch.path, "source @ quoted'path");
	const bin = join(scratch.path, "bin");
	const origin = join(scratch.path, "origin.git");
	const backend = nativeBr();
	for (const path of [tracker, code, bin]) mkdirSync(path);
	const env: Record<string, string> = {
		HOME: scratch.path, TMPDIR: scratch.path, XDG_STATE_HOME: join(scratch.path, "state"),
		XDG_CONFIG_HOME: join(scratch.path, "config"), PATH: `${bin}:${process.env.PATH ?? ""}`,
		AGENT_NAME: "HandoffAuthor", BR_REAL: backend, PYTHONDONTWRITEBYTECODE: "1",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
	};
	const checked = async (argv: string[], cwd = tracker) => {
		const result = await run(argv, { cwd, env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4 << 20 });
		if (result.rc !== 0 || result.timed_out || result.truncated) {
			throw new Error(`${argv.join(" ")}: ${result.rc}\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
		}
		return decoder.decode(result.stdout).trim();
	};
	try {
		symlinkSync(backend, join(bin, "br"));
		mkdirSync(join(scratch.path, ".bun", "bin"), { recursive: true });
		symlinkSync(process.execPath, join(scratch.path, ".bun", "bin", "bun"));
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"HandoffAuthor"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		await checked(["git", "init", "--bare", "-q", "--template=", origin]);
		for (const repo of [tracker, code]) {
			await checked(["git", "init", "-q", "--template=", "-b", "main", repo]);
			await checked(["git", "-C", repo, "config", "user.name", "Fixture"]);
			await checked(["git", "-C", repo, "config", "user.email", "fixture@invalid.example"]);
			mkdirSync(join(repo, "tests"));
			writeFileSync(join(repo, "payload.txt"), "preserved\n");
			writeFileSync(join(repo, "tests/replay.sh"), "#!/bin/sh\ntest -f payload.txt\n");
		}
		mkdirSync(join(code, ".omp"));
		writeFileSync(join(code, ".omp/push-check"), checkBody, { mode: 0o755 });
		await checked(["git", "-C", code, "add", "payload.txt", "tests/replay.sh", ".omp/push-check"]);
		await checked(["git", "-C", code, "commit", "-qm", "owned source fixture", "-m", "Agent: HandoffAuthor"]);
		const commit = await checked(["git", "-C", code, "rev-parse", "HEAD"]);
		await checked(["git", "-C", code, "remote", "add", "origin", origin]);
		await checked(["git", "-C", code, "push", "-q", "--set-upstream", "origin", "main"]);
		const db = join(tracker, ".beads/beads.db");
		const br = (args: string[]) => checked([backend, "--db", db, "--no-auto-import", "--no-auto-flush", ...args]);
		await br(["init", "--prefix", "hh", "--actor", "HandoffAuthor"]);
		const beads = ["hh-owned", "hh-other"].map(id => ({
			id, title: "Preserve native source handoff", issue_type: "task", priority: 2,
			status: "in_progress", assignee: "HandoffAuthor", created_by: "HandoffAuthor",
			created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
			labels: ["fixture"], dependencies: [], comments: [],
			description: "WHAT: preserve the exact source handoff. WHY: a missing observation must refuse without changing native state.",
			acceptance_criteria: HANDOFF_AC,
		}));
		writeFileSync(join(tracker, ".beads/issues.jsonl"), beads.map(b => JSON.stringify(b)).join("\n") + "\n");
		await br(["sync", "--import-only", "--actor", "HandoffAuthor"]);
		const shim = (args: string[], input?: string, cwd = code) => run(["sh", join(root, "scripts/br-shim.sh"), "--db", db, ...args], {
			cwd, env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4 << 20,
			...(input === undefined ? {} : { stdin: input }),
		});
		const status = async (id = "hh-owned") => {
			const values = JSON.parse(await br(["show", id, "--json"]));
			return (Array.isArray(values) ? values[0] : values).status;
		};
		const handoff = (id: string, done: string) =>
			shim(["update", id, "--status", "in_review", "--transition-comment", done]);
		const tree = await checked(["git", "-C", code, "rev-parse", `${commit}^{tree}`]);
		const checkSha256 = createHash("sha256").update(checkBody).digest("hex");
		const pushCheck = (sha: string) => run([process.execPath, join(root, "src", "cli.ts"),
			"push-check", "--commit", sha, "--repo", code, "--json"], {
			cwd: code, env, deadline_s: fixtureDeadlineS(60), max_output_bytes: 4 << 20,
		});
		const ledgerPath = join(code, ".git", "omp-kit", "push-check-runs.jsonl");
		const pushRows = () => existsSync(ledgerPath)
			? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
			: [];
		const plantPushRow = (row: object) => {
			mkdirSync(join(code, ".git", "omp-kit"), { recursive: true });
			writeFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
		};
		const pushEnvelope = async (sha: string) => {
			const result = await pushCheck(sha);
			expect(result.rc, decoder.decode(result.stderr)).toBe(0);
			return JSON.parse(decoder.decode(result.stdout)).data;
		};
		return { scratch, tracker, code, commit, tree, checkSha256, checkBody, shim, status, handoff,
			checked, br, env, done: `DONE ${code}@${commit}: exact native source observation`,
			pushCheck, pushRows, plantPushRow, pushEnvelope };
	} catch (error) {
		scratch.cleanup();
		throw error;
	}
}

test("HANDOFFPUSHCHECK1 a GREEN push-check row admits the handoff; no row, an rc 1 row and a stale check_sha256 row refuse", async () => {
	const f = await pushCheckHandoffRepo("#!/bin/sh\nexit 0\n");
	try {
		const refused = await f.handoff("hh-owned", f.done);
		expect(refused.rc, decoder.decode(refused.stderr)).toBe(4);
		expect(decoder.decode(refused.stderr)).toContain("HANDOFF_UNGATED");
		expect(await f.status()).toBe("in_progress");
		const data = await f.pushEnvelope(f.commit);
		expect(data.overall).toBe("PASS");
		expect(data.commit).toBe(f.commit);
		expect(data.rc).toBe(0);
		const rows = f.pushRows();
		expect(rows.length).toBe(1);
		expect(rows[0]).toMatchObject({ version: 1, commit: f.commit, tree: f.tree, check_sha256: f.checkSha256, rc: 0 });
		expect(typeof rows[0].at).toBe("string");
		const admitted = await f.handoff("hh-owned", f.done);
		expect(admitted.rc, decoder.decode(admitted.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
		f.plantPushRow({ version: 1, commit: f.commit, tree: f.tree, check_sha256: f.checkSha256, rc: 1, at: new Date().toISOString() });
		const failing = await f.handoff("hh-other", f.done);
		expect(failing.rc, decoder.decode(failing.stderr)).toBe(4);
		expect(decoder.decode(failing.stderr)).toContain("HANDOFF_UNGATED");
		expect(await f.status("hh-other")).toBe("in_progress");
		f.plantPushRow({ version: 1, commit: f.commit, tree: f.tree, check_sha256: "0".repeat(64), rc: 0, at: new Date().toISOString() });
		const stale = await f.handoff("hh-other", f.done);
		expect(stale.rc, decoder.decode(stale.stderr)).toBe(4);
		expect(decoder.decode(stale.stderr)).toContain("HANDOFF_UNGATED");
		expect(await f.status("hh-other")).toBe("in_progress");
		const authorDate = await f.checked(["git", "-C", f.code, "log", "-1", "--format=%ad", "--date=raw", f.commit]);
		const laterDate = `${Number(authorDate.split(" ")[0]) + 21} +0000`;
		const candidateRun = await run(["git", "-C", f.code, "commit-tree", f.tree,
			"-m", "owned source fixture", "-m", "Agent: HandoffAuthor"], {
			cwd: f.code, deadline_s: fixtureDeadlineS(30), max_output_bytes: 1 << 20,
			env: { ...f.env, GIT_AUTHOR_DATE: laterDate, GIT_COMMITTER_DATE: laterDate },
		});
		expect(candidateRun.rc, decoder.decode(candidateRun.stderr)).toBe(0);
		const candidate = decoder.decode(candidateRun.stdout).trim();
		expect(candidate).not.toBe(f.commit);
		f.plantPushRow({ version: 1, commit: candidate, tree: f.tree, check_sha256: f.checkSha256, rc: 0, at: new Date().toISOString() });
		const retimed = await f.handoff("hh-other", f.done);
		expect(retimed.rc, decoder.decode(retimed.stderr)).toBe(0);
		expect(await f.status("hh-other")).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1_000);

test("HANDOFFPUSHCHECK1 without .omp/push-check the refusal names committing the check and the push-check command; companion keeps the fresh-gate requirement", async () => {
	const f = await handoffRepo();
	try {
		const refused = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		const err = decoder.decode(refused.stderr);
		expect(refused.rc, err).toBe(4);
		expect(err).toContain("HANDOFF_UNGATED");
		expect(err).toContain(".omp/push-check");
		expect(err).toContain("omp-kit push-check --commit");
		expect(err).not.toContain("fresh-gate.sh");
		expect(await f.status()).toBe("in_progress");
	} finally { f.scratch.cleanup(); }
	const g = await handoffRepo(true);
	try {
		const refused = await g.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", g.done]);
		const err = decoder.decode(refused.stderr);
		expect(refused.rc, err).toBe(4);
		expect(err).toContain("scripts/fresh-gate.sh");
		expect(await g.status()).toBe("in_progress");
		g.ledger();
		const admitted = await g.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", g.done]);
		expect(admitted.rc, decoder.decode(admitted.stderr)).toBe(0);
		expect(await g.status()).toBe("in_review");
	} finally { g.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1_000);

test("HANDOFFREPO1 missing observations cannot admit an ambiguous multiple-bead update", async () => {
	const f = await handoffRepo();
	try {
		const result = await f.shim(["update", "hh-owned", "hh-other", "--status", "in_review", "--transition-comment", f.done]);
		expect(result.rc).toBe(4);
		expect(await f.status()).toBe("in_progress");
		expect(await f.status("hh-other")).toBe("in_progress");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

type HermeticFixture = {
	path: string;
	database: string;
	env: Record<string, string>;
	backend: string;
	cleanup(): void;
};

function hermeticFixture(): HermeticFixture {
	const fixtureRoot = join(root, "var/agent-tmp");
	mkdirSync(fixtureRoot, { recursive: true });
	const scratch = ownedTmp("shim-hermetic-test", { root: fixtureRoot });
	const bin = join(scratch.path, "bin");
	mkdirSync(bin);
	// Only the external mail service is unavailable; the tracker is native br.
	writeFileSync(join(bin, "am"), "#!/bin/sh\nprintf 'fixture project is not registered\\n' >&2\nexit 2\n", { mode: 0o755 });
	const backend = nativeBr();
	return {
		path: scratch.path, database: join(scratch.path, ".beads/beads.db"), backend,
		// PYCACHE1: the fresh HOME must not make every shim python3 recompile its imports.
		env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: scratch.path,
			TMPDIR: scratch.path, XDG_STATE_HOME: join(scratch.path, "state"),
			OMP_KIT_CASE_CWD: root, BR_REAL: backend, PYTHONPYCACHEPREFIX: fixturePycachePrefix() },
		cleanup: () => scratch.cleanup(),
	};
}

async function hermeticCall(fixture: HermeticFixture, args: string[], options: {
	shim?: string; env?: Record<string, string>; native?: boolean; implicit?: boolean;
} = {}) {
	// FIXTUREDEADLINE1: load-aware bound, floor 30 s like this file's other shim-driven fixtures. A shim create runs
	// the fixture-scope helper, Agent Mail, the create guard (whose own hops are bounded at 30 s) and native br; at
	// the load gate's concurrency 6 it was measured at up to 30.3 s (load1 32), and the old 15 s floor (34 s at the
	// gate's load1 18) SIGTERMed TRACKERLEASE1 creates at -15 before the product could answer.
	const result = await run(options.native
		? [fixture.backend, "--db", fixture.database, ...args]
		: ["/bin/sh", options.shim ?? join(root, "scripts/br-shim.sh"), ...(options.implicit ? [] : ["--db", fixture.database]), ...args],
	{ cwd: fixture.path, env: options.env ?? fixture.env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 1024 * 1024 });
	return { rc: result.rc, timedOut: result.timed_out, truncated: result.truncated,
		stdout: decoder.decode(result.stdout), output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

function fixtureOwnerFields(text: string): Record<string, string> {
	return Object.fromEntries(text.split("\n").filter(Boolean).map(line => {
		const separator = line.indexOf("=");
		if (separator < 0) throw new Error("Expected kitlib's key=value owner fixture");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
}

test.each(["identity-unset", "unregistered-actor", "json-owner"] as const)(
	"SHIMHERMETIC1 native init/create work for an owned %s fixture", async (mode: "identity-unset" | "unregistered-actor" | "json-owner") => {
		const fixture = hermeticFixture();
		try {
			if (mode === "json-owner") {
				const owner = join(fixture.path, ".owner");
				writeFileSync(owner, `\ufeff${JSON.stringify(fixtureOwnerFields(readFileSync(owner, "utf8")))}\ufeff`);
			}
			expect(callerScratchRoot(fixture.path, root)).toBe(fixture.path);
			const env = mode === "unregistered-actor" ? { ...fixture.env, AGENT_NAME: "UnregisteredPane" } : fixture.env;
			const initialized = await hermeticCall(fixture, ["init", "--prefix", "hx"], { env });
			expect(initialized.output).not.toContain("BR_SHIM_IDENTITY_REQUIRED");
			expect(initialized.rc).toBe(0);
			expect(initialized.timedOut || initialized.truncated).toBe(false);
			const created = await hermeticCall(fixture, ["create", "Owned native fixture task", "--actor", "FixtureAuthor", "--json"], { env });
			expect(created.rc).toBe(0);
			expect(created.timedOut || created.truncated).toBe(false);
			const id = JSON.parse(created.stdout).id;
			expect(id).toStartWith("hx-");
			const observed = await hermeticCall(fixture, ["show", id, "--json"], { native: true });
			expect(observed.rc).toBe(0);
			const row = JSON.parse(observed.stdout);
			const issue = Array.isArray(row) ? row[0] : row;
			expect({ id: issue.id, title: issue.title, status: issue.status, author: issue.created_by })
				.toEqual({ id, title: "Owned native fixture task", status: "open", author: "FixtureAuthor" });
		} finally { fixture.cleanup(); }
	}, CASE_BUDGET_MS,
);

test("SHIMHERMETIC1 owner/physical/production negatives preserve the native tracker", async () => {
	const fixture = hermeticFixture();
	const ownerPath = join(fixture.path, ".owner");
	const originalOwner = readFileSync(ownerPath, "utf8");
	try {
		const initialized = await hermeticCall(fixture, ["init", "--prefix", "hx"], { native: true });
		expect(initialized.rc).toBe(0);
		const created = await hermeticCall(fixture, ["create", "Protected native fixture task", "--json"], { native: true });
		expect(created.rc).toBe(0);
		const id = JSON.parse(created.stdout).id;
		const foreign = join(fixture.path, "foreign-workspace");
		mkdirSync(foreign);
		const alias = join(fixture.path, "scratch-alias");
		symlinkSync(fixture.path, alias);
		const savedOwner = join(fixture.path, "saved-owner");
		writeFileSync(savedOwner, originalOwner);
		for (const kind of ["symlink-root", "missing-owner", "foreign-owner", "symlink-owner", "oversize-owner", "numeric-owner-capability", "outside-workspace", "production-root"] as const) {
			let env = fixture.env;
			let database = fixture.database;
			if (kind === "symlink-root") database = join(alias, ".beads/beads.db");
			if (kind === "missing-owner") unlinkSync(ownerPath);
			if (kind === "foreign-owner") writeFileSync(ownerPath, originalOwner.replace(`repo=${root}`, `repo=${foreign}`));
			if (kind === "symlink-owner") { unlinkSync(ownerPath); symlinkSync(savedOwner, ownerPath); }
			if (kind === "oversize-owner") writeFileSync(ownerPath, `${originalOwner}${" ".repeat(4097)}`);
			if (kind === "numeric-owner-capability") {
				writeFileSync(ownerPath, JSON.stringify({ ...fixtureOwnerFields(originalOwner), capability_sha256: Number("1".repeat(64)) }));
				expect(() => callerScratchRoot(fixture.path, root)).toThrow();
			}
			if (kind === "outside-workspace") {
				env = { ...fixture.env, OMP_KIT_CASE_CWD: foreign };
				writeFileSync(ownerPath, originalOwner.replace(`repo=${root}`, `repo=${foreign}`));
			}
			if (kind === "production-root") {
				env = { ...fixture.env, OMP_KIT_CASE_CWD: fixture.path };
				writeFileSync(ownerPath, originalOwner.replace(`repo=${root}`, `repo=${fixture.path}`));
			}
			const before = createHash("sha256").update(readFileSync(fixture.database)).digest("hex");
			const denied = await hermeticCall({ ...fixture, database }, ["comments", "add", id, "-m", "must not reach native storage"], { env });
			expect({ kind, rc: denied.rc, incomplete: denied.timedOut || denied.truncated })
				.toEqual({ kind, rc: 4, incomplete: false });
			expect(denied.output.includes("BR_SHIM_IDENTITY_REQUIRED") || denied.output.includes("BR_SHIM_RESERVATION_UNKNOWN")).toBe(true);
			expect(createHash("sha256").update(readFileSync(fixture.database)).digest("hex")).toBe(before);
			if (existsSync(ownerPath) || kind === "symlink-owner") unlinkSync(ownerPath);
			writeFileSync(ownerPath, originalOwner);
		}
		const observed = await hermeticCall(fixture, ["comments", "list", id, "--json"], { native: true });
		expect(observed.rc).toBe(0);
		expect(JSON.parse(observed.stdout)).toEqual([]);
	} finally {
		if (existsSync(ownerPath)) unlinkSync(ownerPath);
		writeFileSync(ownerPath, originalOwner);
		fixture.cleanup();
	}
}, CASE_BUDGET_MS);

test("SHIMHERMETIC1 an always-false owner predicate loses the same native positive", async () => {
	const fixture = hermeticFixture();
	try {
		expect((await hermeticCall(fixture, ["init", "--prefix", "hx"], { native: true })).rc).toBe(0);
		const release = join(fixture.path, "release");
		mkdirSync(release);
		const shim = join(release, "br-shim.sh");
		copyFileSync(join(root, "scripts/br-shim.sh"), shim);
		const predicate = readFileSync(join(root, "scripts/br-fixture-scope.py"), "utf8");
		const boundary = '    """Fail closed on the physical root, marker, uid and canonical repo binding."""';
		if (!predicate.includes(boundary)) throw new Error("SHIMHERMETIC1 predicate mutation did not match");
		writeFileSync(join(release, "br-fixture-scope.py"), predicate.replace(boundary, `${boundary}\n    return False`));
		const args = ["create", "Paired owner predicate control", "--json"];
		const admitted = await hermeticCall(fixture, args);
		expect(admitted.rc).toBe(0);
		const id = JSON.parse(admitted.stdout).id;
		const before = createHash("sha256").update(readFileSync(fixture.database)).digest("hex");
		const denied = await hermeticCall(fixture, args, { shim });
		expect(denied.rc).toBe(4);
		expect(denied.output).toContain("BR_SHIM_IDENTITY_REQUIRED");
		expect(denied.timedOut || denied.truncated).toBe(false);
		expect(createHash("sha256").update(readFileSync(fixture.database)).digest("hex")).toBe(before);
		const observed = await hermeticCall(fixture, ["list", "--all", "--json"], { native: true });
		expect(observed.rc).toBe(0);
		const listed = JSON.parse(observed.stdout);
		const rows = Array.isArray(listed) ? listed : listed.issues;
		expect(rows.map((row: { id: string; title: string }) => ({ id: row.id, title: row.title })))
			.toEqual([{ id, title: "Paired owner predicate control" }]);
	} finally { fixture.cleanup(); }
}, CASE_BUDGET_MS);

test("SHIMHERMETIC1 actual DB selection preserves explicit, ambient and local fixture bindings", async () => {
	const a = hermeticFixture();
	const b = hermeticFixture();
	try {
		expect((await hermeticCall(a, ["init", "--prefix", "hxa"], { native: true })).rc).toBe(0);
		expect((await hermeticCall(b, ["init", "--prefix", "hxb"], { native: true })).rc).toBe(0);
		const env = { ...a.env, BEADS_DB: b.database };
		const explicit = await hermeticCall(a, ["create", "Explicit A beats ambient B", "--json"], { env });
		expect(explicit.rc).toBe(0);
		expect(JSON.parse(explicit.stdout).id).toStartWith("hxa-");
		const ambient = await hermeticCall(a, ["create", "Ambient B from A cwd", "--json"], { env, implicit: true });
		expect(ambient.rc).toBe(0);
		expect(JSON.parse(ambient.stdout).id).toStartWith("hxb-");
		const local = await hermeticCall(a, ["create", "Local A without an ambient selector", "--json"], { implicit: true });
		expect(local.rc).toBe(0);
		expect(JSON.parse(local.stdout).id).toStartWith("hxa-");
		for (const [fixture, expected] of [[a, ["Explicit A beats ambient B", "Local A without an ambient selector"]],
			[b, ["Ambient B from A cwd"]]] as const) {
			const observed = await hermeticCall(fixture, ["list", "--all", "--json"], { native: true });
			expect(observed.rc).toBe(0);
			const listed = JSON.parse(observed.stdout);
			const rows = Array.isArray(listed) ? listed : listed.issues;
			expect(rows.map((row: { title: string }) => row.title).sort()).toEqual([...expected].sort());
		}
	} finally { a.cleanup(); b.cleanup(); }
}, CASE_BUDGET_MS);

function leaseCreate(title: string, extra: string[] = []): string[] {
	return ["create", "--title", title, "-t", "task", "-l", "kind:intake",
		"--description", "WHAT: (a) native lease fixture. WHY: prove deferred export safety.",
		"--acceptance-criteria", "- [ ] [a] [build] native mutation persists; planted negative: a leased export cannot be written `true` -> rc 0",
		"--actor", "LeasePeer", ...extra, "--json"];
}

type LeaseFixture = HermeticFixture & { first: string; second: string; exportFile: string };
type NativeLeaseRow = { id: string; title: string; priority: number };
type NativeLeaseComment = { text: string };

async function leaseRead(fixture: HermeticFixture, args: string[]) {
	const result = await hermeticCall(fixture, [...args, "--no-auto-import", "--no-auto-flush"], { native: true });
	if (result.rc !== 0 || result.timedOut || result.truncated) throw new Error(result.output);
	return JSON.parse(result.stdout);
}

async function leaseRows(fixture: HermeticFixture): Promise<NativeLeaseRow[]> {
	const data = await leaseRead(fixture, ["list", "--all", "--limit", "0", "--json"]);
	return Array.isArray(data) ? data : data.issues;
}

function leaseExport(fixture: LeaseFixture): NativeLeaseRow[] {
	const stream = readJsonl(fixture.exportFile);
	if (stream.missing || stream.more || stream.pending_tail_bytes !== 0 || stream.errors.length !== 0)
		throw new Error(`Native export is incomplete: ${JSON.stringify(stream)}`);
	return stream.rows.map(row => {
		if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string"
			|| !("title" in row) || typeof row.title !== "string" || !("priority" in row) || typeof row.priority !== "number")
			throw new Error(`Invalid native exported issue: ${JSON.stringify(row)}`);
		return { id: row.id, title: row.title, priority: row.priority };
	});
}

async function nativeLeaseFixture(priority = 2): Promise<LeaseFixture> {
	const fixture = hermeticFixture();
	fixture.env = { ...fixture.env, AGENT_NAME: "LeasePeer", OMP_KIT_CASE_CWD: fixture.path,
		AM_LEASE_MODE: "none", OMP_KIT_FLEET_WATCH_CONFIG: join(fixture.path, "fleet-watch.json") };
	writeFileSync(fixture.env.OMP_KIT_FLEET_WATCH_CONFIG, JSON.stringify({
		sessions: [{ repo: fixture.path, p0Cap: 1, coordinatorSession: "fixture", coordinatorPane: "%57" }],
	}));
	// The external authority supplies lease states; every database operation is native br.
	writeFileSync(join(fixture.path, "bin/am"), `#!/bin/sh
case "$1:$2" in
 agents:show) printf '{"name":"LeasePeer"}\\n' ;;
 file_reservations:conflicts)
  case "\${AM_LEASE_MODE:-none}" in
   none) printf 'No conflicts detected.\\n' ;;
   query-fail) printf 'AM_UNAVAILABLE\\n' >&2; exit 7 ;;
   malformed) printf '1 conflict(s) found:\\nPATH HOLDER PATTERN EXPIRES\\nmissing-fields\\n' ;;
   database) printf '1 conflict(s) found:\\nPATH HOLDER PATTERN EXPIRES\\n.beads/beads.db ExportKeeper .beads/beads.db 2099-12-31T23:59:59Z\\n' ;;
   mixed) printf '2 conflict(s) found:\\nPATH HOLDER PATTERN EXPIRES\\n.beads/issues.jsonl ExportKeeper .beads/issues.jsonl 2099-12-31T23:59:59Z\\n.beads/beads.db ExportKeeper .beads/beads.db 2099-12-31T23:59:59Z\\n' ;;
   *) printf '1 conflict(s) found:\\nPATH HOLDER PATTERN EXPIRES\\n.beads/issues.jsonl ExportKeeper .beads/issues.jsonl 2099-12-31T23:59:59Z\\n' ;;
  esac ;;
 file_reservations:list)
  if [ "\${AM_LEASE_MODE:-}" = lookup-fail ]; then exit 7; fi
  printf 'ID PATTERN AGENT EXPIRES REASON\\n42 .beads/issues.jsonl ExportKeeper 2099-12-31T23:59:59Z export\\n43 .beads/beads.db ExportKeeper 2099-12-31T23:59:59Z database\\n' ;;
 *) exit 9 ;;
esac
`, { mode: 0o755 });
	try {
		const initialized = await hermeticCall(fixture, ["init", "--prefix", "lease"], { native: true });
		if (initialized.rc !== 0) throw new Error(initialized.output);
		const first = await hermeticCall(fixture, leaseCreate("Baseline anchor alpha", ["-p", String(priority)]), { native: true });
		const second = await hermeticCall(fixture, leaseCreate("Baseline anchor beta"), { native: true });
		if (first.rc !== 0 || second.rc !== 0) throw new Error(first.output + second.output);
		const flushed = await hermeticCall(fixture, ["sync", "--flush-only"], { native: true });
		if (flushed.rc !== 0) throw new Error(flushed.output);
		return { ...fixture, first: JSON.parse(first.stdout).id, second: JSON.parse(second.stdout).id,
			exportFile: join(fixture.path, ".beads/issues.jsonl") };
	} catch (error) { fixture.cleanup(); throw error; }
}

test("TRACKERLEASE1 lease: native create/dep/comments defer export and a later flush is complete", async () => {
	const fixture = await nativeLeaseFixture();
	try {
		const original = readFileSync(fixture.exportFile);
		fixture.env.AM_LEASE_MODE = "export";
		const created = await hermeticCall(fixture, leaseCreate("Deferred native payload"));
		expect(created.rc).toBe(0);
		const id = JSON.parse(created.stdout).id;
		expect(id).toStartWith("lease-");
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const dependency = await hermeticCall(fixture, ["dep", "add", id, fixture.first, "--type", "blocks"]);
		expect(dependency.rc).toBe(0);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const comment = await hermeticCall(fixture, ["comments", "add", id, "-m", "Deferred native comment"]);
		expect(comment.rc).toBe(0);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const commentFile = join(fixture.path, "leased-comment.txt");
		writeFileSync(commentFile, "Deferred file comment");
		expect((await hermeticCall(fixture, ["comments", "add", id, "--file", commentFile])).rc).toBe(0);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		writeFileSync(commentFile, "Single restriction already set");
		expect((await hermeticCall(fixture, ["--no-auto-flush", "comments", "add", id, "--file", commentFile])).rc).toBe(0);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		expect((await hermeticCall(fixture, ["--actor", "LeasePeer", "comments", "add", id, "--", "--no-db"])).rc).toBe(0);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const rows = await leaseRows(fixture);
		expect(rows.map(row => ({ id: row.id, title: row.title })).sort((a, b) => a.id.localeCompare(b.id)))
			.toEqual([{ id: fixture.first, title: "Baseline anchor alpha" }, { id: fixture.second, title: "Baseline anchor beta" },
				{ id, title: "Deferred native payload" }].sort((a, b) => a.id.localeCompare(b.id)));
		const edges = await leaseRead(fixture, ["dep", "list", id, "--direction", "down", "--json"]);
		expect(edges.map((edge: { depends_on_id: string; type: string }) => ({ id: edge.depends_on_id, type: edge.type })))
			.toEqual([{ id: fixture.first, type: "blocks" }]);
		const comments = await leaseRead(fixture, ["comments", "list", id, "--json"]);
		expect(comments.map((row: NativeLeaseComment) => row.text).sort())
			.toEqual(["Deferred native comment", "Deferred file comment", "Single restriction already set", "--no-db"].sort());
		const forbiddenFlush = await hermeticCall(fixture, ["sync", "--flush-only"]);
		expect(forbiddenFlush.rc).toBe(4);
		expect(forbiddenFlush.output).toContain("BR_SHIM_TRACKER_RESERVED");
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const jsonlOnly = await hermeticCall(fixture, ["update", id, "--title", "Forbidden export edit", "--no-db"]);
		expect(jsonlOnly.rc).toBe(4);
		expect(jsonlOnly.output).toContain("BR_SHIM_TRACKER_RESERVED");
		expect((await leaseRows(fixture)).find(row => row.id === id)?.title).toBe("Deferred native payload");
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		fixture.env.AM_LEASE_MODE = "none";
		const flushed = await hermeticCall(fixture, ["sync", "--flush-only"]);
		expect(flushed.rc).toBe(0);
		expect(leaseExport(fixture).map(row => row.id).sort()).toEqual((await leaseRows(fixture)).map(row => row.id).sort());
		expect(leaseExport(fixture).find(row => row.id === id)?.title).toBe("Deferred native payload");
		const normal = await hermeticCall(fixture, leaseCreate("Ordinary unleased export"));
		expect(normal.rc).toBe(0);
		const normalId = JSON.parse(normal.stdout).id;
		expect(leaseExport(fixture).find(row => row.id === normalId)?.title).toBe("Ordinary unleased export");
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("TRACKERLEASE1 lease: delegated comment-target and P0 displacement preserve admission and export", async () => {
	const fixture = await nativeLeaseFixture(0);
	try {
		const original = readFileSync(fixture.exportFile);
		fixture.env.AM_LEASE_MODE = "export";
		const rejected = await hermeticCall(fixture, ["create", "--title", "Unspecified unsafe task"]);
		expect(rejected.rc).toBe(4);
		expect(rejected.output).toContain("LINT_REFUSED");
		expect((await leaseRows(fixture)).map(row => row.id).sort()).toEqual([fixture.first, fixture.second].sort());
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const followup = await hermeticCall(fixture, leaseCreate("Existing issue followup", ["--comment-target", fixture.first]));
		expect(followup.rc).toBe(0);
		expect((await leaseRows(fixture)).map(row => row.id).sort()).toEqual([fixture.first, fixture.second].sort());
		const firstComments = await leaseRead(fixture, ["comments", "list", fixture.first, "--json"]);
		expect(firstComments.some((row: NativeLeaseComment) => row.text.includes("Follow-up requested for: Existing issue followup"))).toBe(true);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const displaced = await hermeticCall(fixture, leaseCreate("Urgent replacement payload", ["-p", "0", "--displaces", fixture.first]));
		expect(displaced.rc).toBe(0);
		const id = JSON.parse(displaced.stdout).id;
		const rows = await leaseRows(fixture);
		expect(rows.find(row => row.id === fixture.first)?.priority).toBe(1);
		expect(rows.find(row => row.id === id)?.priority).toBe(0);
		const oldComments = await leaseRead(fixture, ["comments", "list", fixture.first, "--json"]);
		const newComments = await leaseRead(fixture, ["comments", "list", id, "--json"]);
		expect(oldComments.some((row: NativeLeaseComment) => row.text.includes(`Displaced by ${id}`))).toBe(true);
		expect(newComments.some((row: NativeLeaseComment) => row.text.includes(`Displaces ${fixture.first}`))).toBe(true);
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		fixture.env.AM_LEASE_MODE = "none";
		expect((await hermeticCall(fixture, ["sync", "--flush-only"])).rc).toBe(0);
		expect(leaseExport(fixture).map(row => ({ id: row.id, priority: row.priority })).sort((a, b) => a.id.localeCompare(b.id)))
			.toEqual(rows.map(row => ({ id: row.id, priority: row.priority })).sort((a, b) => a.id.localeCompare(b.id)));
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("TRACKERLEASE1 lease: DB custody, mixed conflicts and unknown authority remain fail-closed", async () => {
	const fixture = await nativeLeaseFixture();
	try {
		const original = readFileSync(fixture.exportFile);
		for (const mode of ["database", "mixed", "query-fail", "malformed", "lookup-fail"]) {
			fixture.env.AM_LEASE_MODE = mode;
			const denied = await hermeticCall(fixture, ["comments", "add", fixture.first, "-m", `Forbidden ${mode}`]);
			expect({ mode, rc: denied.rc, incomplete: denied.timedOut || denied.truncated })
				.toEqual({ mode, rc: 4, incomplete: false });
			expect(denied.output.includes("BR_SHIM_TRACKER_RESERVED") || denied.output.includes("BR_SHIM_RESERVATION_UNKNOWN")).toBe(true);
			expect(readFileSync(fixture.exportFile)).toEqual(original);
			expect(await leaseRead(fixture, ["comments", "list", fixture.first, "--json"])).toEqual([]);
			expect((await leaseRows(fixture)).map(row => ({ id: row.id, title: row.title })).sort((a, b) => a.id.localeCompare(b.id)))
				.toEqual([{ id: fixture.first, title: "Baseline anchor alpha" }, { id: fixture.second, title: "Baseline anchor beta" }]
					.sort((a, b) => a.id.localeCompare(b.id)));
		}
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

test("TRACKERLEASE1 lease: disabling the explicit-flush guard exposes the same native export leak", async () => {
	const fixture = await nativeLeaseFixture();
	try {
		fixture.env.AM_LEASE_MODE = "export";
		const original = readFileSync(fixture.exportFile);
		const created = await hermeticCall(fixture, leaseCreate("Causal flush boundary payload"));
		expect(created.rc).toBe(0);
		const id = JSON.parse(created.stdout).id;
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const denied = await hermeticCall(fixture, ["sync", "--flush-only"]);
		expect(denied.rc).toBe(4);
		expect(denied.output).toContain("BR_SHIM_TRACKER_RESERVED");
		expect(readFileSync(fixture.exportFile)).toEqual(original);
		const guard = '[ "$gate_sub" = sync ] || ';
		if (!shimSource.includes(guard)) throw new Error("TRACKERLEASE1 flush mutation did not match");
		const mutated = join(fixture.path, "flush-guard-mutant.sh");
		writeFileSync(mutated, shimSource.replace(guard, ""));
		const leaked = await hermeticCall(fixture, ["sync", "--flush-only"], { shim: mutated });
		expect(leaked.rc).toBe(0);
		expect(leaked.timedOut || leaked.truncated).toBe(false);
		expect(leaseExport(fixture).find(row => row.id === id)?.title).toBe("Causal flush boundary payload");
		expect(leaseExport(fixture).map(row => row.id).sort()).toEqual((await leaseRows(fixture)).map(row => row.id).sort());
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(120) * 1_000);

/* SHIMCHAIN1 (ompkit-fp72.120.16.247): a pane shim ahead of a grade_wave grader dispatcher whose BAKED_REAL is a pane
   shim. The dispatcher is a fixture shaped like grade_wave's header (BAKED_* lines, identity reset, exec of BAKED_REAL);
   the backend records each call and touches no tracker; `am` refuses every identity and records which one it judged.
   Each shim is this checkout's exact br-shim.sh bytes, copied alone into its directory: with no br-fixture-scope.py
   beside it no tracker can be an owned fixture, every write meets the reservation check, and a call starts no Python
   except the dispatcher (run without site imports), so the cases stay cheap at the load gate's concurrency. */
const SHIMCHAIN_START = "# SHIMCHAIN1 (";
const SHIMCHAIN_END = "# SHIMHELP1 (";

function shimChainFixture(delegate: "pane-shim" | "backend") {
	const scratch = ownedTmp("shimchain1");
	const dir = (name: string) => { const path = join(scratch.path, name); mkdirSync(path, { recursive: true }); return path; };
	const pane = dir("pane"), inner = dir("inner"), dispatch = dir("dispatch"), backend = dir("backend"), tools = dir("tools"), mutant = dir("mutant");
	const foreign = dir("foreign");
	mkdirSync(join(foreign, ".beads"));
	const install = (bin: string, source: string) => {
		writeFileSync(join(bin, "br-shim.sh"), source, { mode: 0o755 });
		symlinkSync(join(bin, "br-shim.sh"), join(bin, "br"));
	};
	install(pane, shimSource);
	install(inner, shimSource);
	const start = shimSource.indexOf(SHIMCHAIN_START), end = shimSource.indexOf(SHIMCHAIN_END);
	if (start < 0 || end < start) throw new Error("SHIMCHAIN1 mutation did not match");
	install(mutant, shimSource.slice(0, start) + shimSource.slice(end));
	const brLog = join(scratch.path, "backend.log"), amLog = join(scratch.path, "am.log");
	writeFileSync(join(backend, "br"), `#!/bin/sh\nprintf '%s|%s\\n' "\${AGENT_NAME-}" "$*" >> "$BR_LOG"\nprintf '[{"id":"fx-1"}]\\n'\n`, { mode: 0o755 });
	writeFileSync(join(tools, "am"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$AM_LOG"\nprintf 'fixture mail refuses every identity\\n' >&2\nexit 2\n`, { mode: 0o755 });
	const system = "/usr/bin:/bin";
	const py = (value: string) => { if (value.includes("'")) throw new Error("SHIMCHAIN1 fixture path holds a quote"); return `'${value}'`; };
	const bakedReal = delegate === "pane-shim" ? join(inner, "br") : join(backend, "br");
	writeFileSync(join(dispatch, "br"), [
		"#!/usr/bin/env -S python3 -S -E",
		`BAKED_SCRATCH = ${py(scratch.path)}`,
		"BAKED_AGENT = 'GraderBaked'",
		`BAKED_REAL = ${py(bakedReal)}`,
		`BAKED_PATH = ${py(`${inner}:${backend}:${tools}:${system}`)}`,
		"import os, sys",
		"os.environ['AGENT_NAME'] = BAKED_AGENT",
		"os.environ['PATH'] = BAKED_PATH",
		"os.execv(BAKED_REAL, [BAKED_REAL] + sys.argv[1:])",
		"",
	].join("\n"), { mode: 0o755 });
	// No BR_REAL: each shim resolves its next hop from PATH.
	const env = { AGENT_NAME: "ShellPane", HOME: scratch.path, TMPDIR: scratch.path, XDG_STATE_HOME: join(scratch.path, "state"),
		BR_LOG: brLog, AM_LOG: amLog };
	const call = async (entry: string, args: string[], pathHead = pane) => {
		const result = await run([entry, ...args], { cwd: scratch.path, env: { ...env, PATH: `${pathHead}:${dispatch}:${backend}:${tools}:${system}` },
			deadline_s: fixtureDeadlineS(30), max_output_bytes: 1024 * 1024 });
		const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
		return { rc: result.rc, incomplete: result.timed_out || result.truncated,
			output: decoder.decode(result.stdout) + decoder.decode(result.stderr), backend: read(brLog), judged: read(amLog) };
	};
	const reset = () => { for (const path of [brLog, amLog]) if (existsSync(path)) unlinkSync(path); };
	return { scratch, pane, dispatch, mutant, foreign, call, reset };
}

test("SHIMCHAIN1 planted: pane shim ahead of a shim-bound dispatcher reads under the dispatcher's actor; a write is judged once, under that identity", async () => {
	const f = shimChainFixture("pane-shim");
	try {
		const read = await f.call(join(f.pane, "br"), ["show", "fx-1", "--json"]);
		expect({ rc: read.rc, incomplete: read.incomplete }, read.output).toEqual({ rc: 0, incomplete: false });
		expect(read.backend).toEqual(["GraderBaked|show fx-1 --json --actor GraderBaked"]);
		f.reset();
		const write = await f.call(join(f.pane, "br"), ["--db", join(f.foreign, ".beads/beads.db"), "update", "fx-1", "--add-label", "probe"]);
		expect({ rc: write.rc, incomplete: write.incomplete }, write.output).toEqual({ rc: 4, incomplete: false });
		expect(write.output).toContain("BR_SHIM_RESERVATION_UNKNOWN Agent Mail cannot verify GraderBaked");
		expect(write.judged.map(line => line.split(" ").at(-1))).toEqual(["GraderBaked"]);
		expect(write.backend).toEqual([]);
	} finally { f.scratch.cleanup(); }
}, CASE_BUDGET_MS);

test("SHIMCHAIN1 control: the dispatcher first is unchanged; a dispatcher whose delegate is not a pane shim keeps the outer shim's full policy", async () => {
	const first = shimChainFixture("pane-shim");
	try {
		const read = await first.call(join(first.dispatch, "br"), ["show", "fx-1", "--json"], first.dispatch);
		expect(read.rc, read.output).toBe(0);
		expect(read.backend).toEqual(["GraderBaked|show fx-1 --json --actor GraderBaked"]);
		first.reset();
		const write = await first.call(join(first.dispatch, "br"), ["--db", join(first.foreign, ".beads/beads.db"), "update", "fx-1", "--add-label", "probe"], first.dispatch);
		expect(write.rc, write.output).toBe(4);
		expect(write.judged.map(line => line.split(" ").at(-1))).toEqual(["GraderBaked"]);
		expect(write.backend).toEqual([]);
	} finally { first.scratch.cleanup(); }
	const direct = shimChainFixture("backend");
	try {
		const read = await direct.call(join(direct.pane, "br"), ["show", "fx-1", "--json"]);
		expect(read.rc, read.output).toBe(0);
		expect(read.backend).toEqual(["GraderBaked|show fx-1 --json --actor ShellPane"]);
		direct.reset();
		const write = await direct.call(join(direct.pane, "br"), ["--db", join(direct.foreign, ".beads/beads.db"), "update", "fx-1", "--add-label", "probe"]);
		expect(write.rc, write.output).toBe(4);
		expect(write.output).toContain("Agent Mail cannot verify ShellPane");
		expect(write.judged.map(line => line.split(" ").at(-1))).toEqual(["ShellPane"]);
		expect(write.backend).toEqual([]);
	} finally { direct.scratch.cleanup(); }
}, CASE_BUDGET_MS);

test("SHIMCHAIN1 mutant: without the chain rule the same pane-shim-first read is refused BR_SHIM_ACTOR_MISMATCH", async () => {
	const f = shimChainFixture("pane-shim");
	try {
		const read = await f.call(join(f.mutant, "br"), ["show", "fx-1", "--json"], f.mutant);
		expect({ rc: read.rc, incomplete: read.incomplete }, read.output).toEqual({ rc: 4, incomplete: false });
		expect(read.output).toContain("BR_SHIM_ACTOR_MISMATCH refusing --actor ShellPane for pane identity GraderBaked");
		expect(read.backend).toEqual([]);
	} finally { f.scratch.cleanup(); }
}, CASE_BUDGET_MS);
