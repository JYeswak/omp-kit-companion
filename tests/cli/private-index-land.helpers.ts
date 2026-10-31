/** Shared fixture and command helpers for the private-index-land test files (split for the per-file test budget). */
import { expect } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { runSync as kitlibRunSync } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";

export type SchemaNode = { type?: string | string[]; required?: string[]; properties?: Record<string, SchemaNode>; items?: SchemaNode; enum?: unknown[];
	const?: unknown; allOf?: { if: SchemaNode; then?: SchemaNode; else?: SchemaNode }[] };

/** The checks the published schema makes, enough for land's data: type, enum, required, properties, items, const, if/then/else. */
export function schemaViolations(value: unknown, node: SchemaNode, at = "data"): string[] {
	const problems: string[] = [];
	if (node.enum && !node.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} not in enum`);
	if (node.const !== undefined && value !== node.const) problems.push(`${at}: not ${JSON.stringify(node.const)}`);
	const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
	const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	if (types.length > 0 && !types.includes(kind)) problems.push(`${at}: ${kind} is not ${types.join("|")}`);
	if (kind === "object") {
		const record = value as Record<string, unknown>;
		for (const key of node.required ?? []) if (!(key in record)) problems.push(`${at}.${key}: required`);
		for (const [key, child] of Object.entries(node.properties ?? {})) if (key in record) problems.push(...schemaViolations(record[key], child, `${at}.${key}`));
	}
	if (kind === "array" && node.items) (value as unknown[]).forEach((entry, index) => problems.push(...schemaViolations(entry, node.items!, `${at}[${index}]`)));
	for (const rule of node.allOf ?? []) {
		const matches = schemaViolations(value, rule.if, at).length === 0;
		const branch = matches ? rule.then : rule.else;
		if (branch) problems.push(...schemaViolations(value, branch, at));
	}
	return problems;
}

export const landSchema = COMMANDS.find((command) => command.name === "land")?.dataSchema as unknown as SchemaNode;

/** A real land response must satisfy the schema `omp-kit schema` publishes for it (ompkit-rhy9.9). */
export function expectLandSchema(data: unknown): void {
	expect(schemaViolations(data, landSchema)).toEqual([]);
}

export const repoRoot = resolve(import.meta.dir, "../..");
export const cliPath = join(repoRoot, "src", "cli.ts");
export const ownedScratch = ownedTmp("private-index-land");
export const scratch = ownedScratch.path;
// land's push-time scratch disposal gate scans the scratch roots for dirs the
// caller owns. Every land run here reads this empty fixture root instead of the
// real ~/Developer/*/var/agent-tmp roots, so a dir held by whoever runs the suite
// (or a dead owner whose pid a land child reuses) cannot change a test's result.
export const landScratchRoot = join(scratch, "land-scratch-root");
mkdirSync(landScratchRoot);
// The fixture counter is shared by these helpers and by test bodies that bump it (`peer-${fixtureNumber++}`),
// which an imported binding cannot do, so it lives on globalThis: one counter per process, however many
// of the split files a bun run loads, and no two fixtures or markers share a scratch name.
declare global {
	var fixtureNumber: number;
}
globalThis.fixtureNumber ??= 0;
// No afterAll here: bun shares this module across the split files of one run, so the first file's
// afterAll would remove the scratch the next file still uses. ownedTmp removes it at process exit.

export type Fixture = { work: string; fakeBin: string };


export type CommandOptions = {
	agent?: string;
	claimed?: string;
	amDir: string;
	reservationMode?: string;
	gitEnv?: NodeJS.ProcessEnv;
	tmuxPane?: string | null;
	ternPane?: string;
	ternAgent?: string;
	herdrEnv?: string;
	herdrPaneId?: string;
	registeredHerdrPane?: string;
	herdrAgent?: string;
	expectedAmProject?: string;
	subcommand?: string;
	timeoutMs?: number;
};

export function commandEnvironment(cwd: string, holds: unknown, options: CommandOptions): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_INDEX_FILE;
	Object.assign(env, options.gitEnv);
	env.PATH = `${options.amDir}:${env.PATH ?? "/usr/bin:/bin"}`;
	env.FULL_SUITE_VERDICT_CACHE_DIR = join(cwd, "var", "agent-tmp", "full-suite-verdicts");
	env.OMP_KIT_SCRATCH_ROOTS = landScratchRoot;

	if (options.tmuxPane === null) delete env.TMUX_PANE;
	else env.TMUX_PANE = options.tmuxPane ?? "%60";
	env.AGENT_NAME = options.claimed ?? "DarkFern";
	env.FAKE_AGENT = options.agent ?? "DarkFern";
	delete env.TERN_PANE;
	delete env.HERDR_ENV;
	delete env.HERDR_PANE_ID;
	if (options.ternPane !== undefined) env.TERN_PANE = options.ternPane;
	if (options.herdrEnv !== undefined) env.HERDR_ENV = options.herdrEnv;
	if (options.herdrPaneId !== undefined) env.HERDR_PANE_ID = options.herdrPaneId;
	if (options.ternAgent !== undefined) env.FAKE_TERN_AGENT = options.ternAgent;
	// land passes `git rev-parse --show-toplevel`, which is a realpath: under a symlinked temp root (/tmp ->
	// /private/tmp, the default when TMPDIR is unset) a plain cwd never matched and every land read OWNER_UNKNOWN.
	env.FAKE_AM_PROJECT = options.expectedAmProject ?? realpathSync(cwd);
	env.FAKE_TERN_PANE = options.ternPane ?? "";
	env.FAKE_HERDR_PANE = options.registeredHerdrPane ?? options.herdrPaneId ?? "";
	env.FAKE_HERDR_AGENT = options.herdrAgent ?? options.agent ?? "DarkFern";
	env.FAKE_HOLDS_JSON = JSON.stringify(holds);
	env.FAKE_AM_MODE = options.reservationMode ?? "ok";
	return env;
}

/** One land command's own deadline (command() below). A test's cap never cuts it off first. */
export const LAND_COMMAND_DEADLINE_MS = 30_000;

export function command(cwd: string, args: string[], holds: unknown, options: CommandOptions) {
	const env = commandEnvironment(cwd, holds, options);
	const result = kitlibRunSync(["bun", cliPath, options.subcommand ?? "land", ...args, "--json"], {
		cwd, env: stringEnvironment(env), deadline_s: (options.timeoutMs ?? LAND_COMMAND_DEADLINE_MS) / 1000,
	});
	const decoder = new TextDecoder();
	const stdout = decoder.decode(result.stdout);
	const stderr = decoder.decode(result.stderr);
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(stdout);
	} catch {
		throw new Error(`land command emitted invalid JSON (status ${result.rc}): ${stdout}\n${stderr}`);
	}
	return { status: result.rc === null || result.rc < 0 ? 1 : result.rc, body };
}

// GATEFLAKE1 (ompkit-ll72v): a fixture git spawn's deadline is a property of the machine, not of the
// program, so it comes from one place: a 10 s quiet-machine floor scaled by min(4, loadavg1/ncpu*4)
// (never below 1). A spawn that runs out of it is reported as TIMEOUT_UNDER_LOAD with the load, the
// core count and the worker count on one line, never as a bare `git ... failed (null)`.
// OMP_KIT_TEST_SPAWN_SLEEP=<s> is a test-only planted load, off by default: each template git spawn
// after the bare init (the setup every test in this file shares)
// first sleeps <s> quiet-machine seconds, stretched by the same load factor as the deadline, so a
// planted 12 s spawn always exceeds the 10 s floor (TIMEOUT_UNDER_LOAD) and a planted 1 s spawn
// always fits, whatever the machine's load when the planted run happens.
export const SPAWN_FLOOR_S = 10;
export const plantedSpawnSleepS = Number(process.env.OMP_KIT_TEST_SPAWN_SLEEP ?? "0");
if (!Number.isFinite(plantedSpawnSleepS) || plantedSpawnSleepS < 0)
	throw new Error(`OMP_KIT_TEST_SPAWN_SLEEP must be a non-negative number of seconds, got ${process.env.OMP_KIT_TEST_SPAWN_SLEEP}`);

export function spawnLoad(): { load1: number; ncpu: number; factor: number } {
	const load1 = loadavg()[0] ?? 0;
	const ncpu = availableParallelism();
	return { load1, ncpu, factor: Math.max(1, Math.min(4, (load1 / ncpu) * 4)) };
}

// The same rule bounds a whole test: bun's 5 s per-test default is the quiet-machine figure, and a
// test making two or three land runs (each a bun CLI plus a full-suite judge, 1.8-2.3 s at load 19)
// ran 5.0-6.5 s at load 22 on 32 cores and was cut off with no assertion failed. The default is scaled
// by the load factor at module load; tests carrying their own explicit cap keep it. It is never below
// one land command's own deadline: in the 2026-10-30 15:52Z pre-push gate (4 bun workers, load 13-15)
// two one-run tests that take 4.1 s alone were killed by a 10.4 s per-test cap (status -9/-15, empty
// stdout), before the land command's 30 s deadline could report anything.
export const LAND_DEFAULT_TIMEOUT_MS = Math.max(Math.round(5_000 * spawnLoad().factor), LAND_COMMAND_DEADLINE_MS);

export function git(cwd: string, args: string[], planted = false): string {
	const { load1, ncpu, factor } = spawnLoad();
	const deadlineS = SPAWN_FLOOR_S * factor;
	const gitArgv = ["git", "-c", "user.name=LAND1 test", "-c", "user.email=land1@example.invalid", ...args];
	// runSync SIGKILLs only sh at the deadline, so the planted sleep writes to no pipe of ours: an
	// orphaned sleep holding stdout would otherwise keep the call open past its deadline.
	const argv = planted && plantedSpawnSleepS > 0
		? ["sh", "-c", 'sleep "$0" </dev/null >/dev/null 2>&1 & wait "$!"; exec "$@"', (plantedSpawnSleepS * factor).toFixed(3), ...gitArgv]
		: gitArgv;
	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] ??= value;
	const run = kitlibRunSync(argv, { cwd, env, deadline_s: deadlineS });
	if (run.timed_out)
		throw new Error(`TIMEOUT_UNDER_LOAD git ${args.join(" ")} killed after ${Math.round(run.elapsed_s * 1000)} ms at its ${Math.round(deadlineS * 1000)} ms deadline `
			+ `loadavg=${load1.toFixed(2)} ncpu=${ncpu} workers=${process.env.OMP_KIT_TEST_WORKERS ?? "unreported"} `
			+ `planted_sleep_s=${plantedSpawnSleepS}`);
	const decode = new TextDecoder();
	if (run.rc !== 0) throw new Error(`git ${args.join(" ")} failed (${run.rc}): ${decode.decode(run.stderr)}`);
	return decode.decode(run.stdout);
}
export function remoteHead(cwd: string): string {
	const output = git(cwd, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const [sha, ref] = output.split("\t");
	if (!sha || ref !== "refs/heads/main") throw new Error(`unexpected origin/main response: ${output}`);
	return sha;
}

export function stringEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) if (value !== undefined) environment[key] = value;
	return environment;
}
export function verdictPath(work: string, tree: string, role: "base" | "main", env: NodeJS.ProcessEnv, checks?: string): string {
	const cache = env.FULL_SUITE_VERDICT_CACHE_DIR ?? join(work, "var", "agent-tmp", "full-suite-verdicts");
	const args = ["path", "--repo", work, "--cache-dir", cache, "--tree", tree, "--role", role, "--judge-root", work];
	if (checks !== undefined) args.push("--checks", checks);
	const result = kitlibRunSync(["python3", join(work, "scripts", "full-suite-verdict-store.py"), ...args],
		{ cwd: work, env: stringEnvironment(env), deadline_s: 30 });
	const decoder = new TextDecoder();
	if (result.rc !== 0 || result.timed_out || result.killed || result.truncated || result.total_truncated)
		throw new Error(`verdict-store path failed: ${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
	return decoder.decode(result.stdout).trim();
}

// GATEFLAKE1 (ompkit-ll72v): every fixture is a directory copy of one Git-built template (its own bare
// origin, clone, base commit and upstream), so a fixture no longer costs seven serial git spawns.
// The 61 fixture() calls were 427 spawns; the template costs 5 once, built at module load so its
// spawns run under their own deadline and not inside one test's timeout. Each copy is a distinct
// real repository: its origin URL is rewritten to its own bare copy, the base commit is pushed, and
// the copied index needs a stat refresh (more work for land, not less).
export const templateRoot = join(scratch, "template");
export const templateBare = join(templateRoot, "origin.git");
export const templateWork = join(templateRoot, "work");
// A failed build (a TIMEOUT_UNDER_LOAD included) fails module load, where bun runs no afterAll.
try {
	mkdirSync(templateRoot);
	git(templateRoot, ["init", "--bare", "--initial-branch=main", templateBare]);
	git(templateRoot, ["clone", templateBare, templateWork], true);
	writeFileSync(join(templateWork, ".git", "config"),
		readFileSync(join(templateWork, ".git", "config"), "utf8") + "[user]\n\tname = LAND1 test\n\temail = land1@example.invalid\n");
	// land keeps its full-suite gate scratch (src/land.ts) and this file's verdict cache under var/agent-tmp/,
	// which a kit checkout never shows as untracked. The fixture repository ignores it itself, as the kit's
	// own .gitignore does, instead of borrowing the caller's global excludes: a hermetic suite HOME has none,
	// and then `git status` grew a `?? var/` line that no land change caused.
	mkdirSync(join(templateWork, ".git", "info"), { recursive: true });
	writeFileSync(join(templateWork, ".git", "info", "exclude"), "/var/agent-tmp/\n", { flag: "a" });
	mkdirSync(join(templateWork, "var", "agent-tmp"), { recursive: true });
	writeFileSync(join(templateWork, "owned.txt"), "base owned\n");
	writeFileSync(join(templateWork, "peer.txt"), "peer baseline\n");
	writeFileSync(join(templateWork, "untouched.txt"), "untouched baseline\n");
	mkdirSync(join(templateWork, "tests", "cli"), { recursive: true });
	writeFileSync(join(templateWork, "suite-contract.txt"), "PASS\n");
	writeFileSync(join(templateWork, "tests", "cli", "land-suite.test.sh"), "#!/bin/sh\nset -eu\nif grep -Fxq SLOW suite-contract.txt; then sleep 10; fi\ngrep -Fxq PASS suite-contract.txt\n", { mode: 0o755 });
	mkdirSync(join(templateWork, "scripts"), { recursive: true });
	mkdirSync(join(templateWork, ".github"), { recursive: true });
	// The JUDGING_FILES closure of scripts/suite-metrics.py: a fixture missing one cannot run its gate.
	const gateFiles = ["scripts/full-suite-verdict.sh", "scripts/full-suite-verdict-store.py", "scripts/fresh-gate.sh", "scripts/pre-push-gate.sh", "scripts/kitlib-tmp.sh",
		"scripts/suite-metrics.py", "scripts/suite-hermetic-env.sh", "scripts/kitlib_run.py", "scripts/kitlib_tmp.py",
		"scripts/pysafe.py", "scripts/test-budget.ts", "scripts/regexploit-gate.py", ".github/test-budget.json"];
	if (existsSync(join(repoRoot, "scripts", "gate-ci-only.tsv"))) gateFiles.push("scripts/gate-ci-only.tsv");
	for (const path of gateFiles)
		writeFileSync(join(templateWork, path), readFileSync(join(repoRoot, path)), { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
	git(templateWork, ["add", "-A"], true);
	git(templateWork, ["commit", "-m", "base [test]"], true);
	git(templateWork, ["push", "-u", "origin", "HEAD:refs/heads/main"], true);
} catch (error) {
	ownedScratch.cleanup();
	throw error;
}

export function fixture(): Fixture {
	const id = fixtureNumber++;
	const bare = join(scratch, `origin-${id}.git`);
	const work = join(scratch, `work-${id}`);
	cpSync(templateBare, bare, { recursive: true });
	cpSync(templateWork, work, { recursive: true });
	const configPath = join(work, ".git", "config");
	const config = readFileSync(configPath, "utf8");
	if (!config.includes(templateBare)) throw new Error(`template config does not name its origin ${templateBare}`);
	writeFileSync(configPath, config.replaceAll(templateBare, bare));
	const fakeBin = join(scratch, `fake-am-${id}`);
	mkdirSync(fakeBin);
	const fakeAm = join(fakeBin, "am");
	writeFileSync(fakeAm, String.raw`#!/bin/sh
case "$1 $2" in
  "agents resolve-pane")
    if [ "$FAKE_AM_MODE" = "unregistered" ] || [ "$4" != "$FAKE_AM_PROJECT" ]; then exit 1; fi
    case "$6" in
      tern:*) [ "$6" = "tern:$FAKE_TERN_PANE" ] || exit 1; agent="$FAKE_TERN_AGENT" ;;
      herdr:*) [ "$6" = "herdr:$FAKE_HERDR_PANE" ] || exit 1; agent="$FAKE_HERDR_AGENT" ;;
      *) agent="$FAKE_AGENT" ;;
    esac
    if [ "$FAKE_AM_MODE" = "ambiguous" ]; then printf '{"agent_name":["%s","OtherAgent"]}\n' "$agent"; exit 0; fi
    if [ -z "$agent" ]; then agent="$FAKE_AGENT"; fi
    printf '{"agent_name":"%s"}\n' "$agent" ;;
  "robot reservations")
    case "$FAKE_AM_MODE" in
      unavailable) exit 7 ;;
      unreadable) printf 'not-json\n' ;;
      stale) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"stale","database_matches_server":true,"storage_root_matches_server":true}}\n' "$FAKE_HOLDS_JSON" ;;
      database-mismatch) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"current","database_matches_server":false,"storage_root_matches_server":true}}\n' "$FAKE_HOLDS_JSON" ;;
      storage-mismatch) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":false}}\n' "$FAKE_HOLDS_JSON" ;;
      *) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}}\n' "$FAKE_HOLDS_JSON" ;;
    esac ;;
  *) exit 2 ;;
esac
`);
	chmodSync(fakeAm, 0o755);
	return { work, fakeBin };
}

export function landArgs(...paths: string[]): string[] {
	return [...paths.flatMap((path) => ["--paths", path]), "--message", "feat(land): publish reserved fixture [test]", "--apply", "--yes"];
}

export function responseCode(body: Record<string, unknown>): string | undefined {
	const errors = body.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	const first = errors[0];
	return first !== null && typeof first === "object" && "code" in first && typeof first.code === "string" ? first.code : undefined;
}

export function registerPushCheck(work: string, body: string): string {
	mkdirSync(join(work, ".omp"), { recursive: true });
	const path = join(work, ".omp", "push-check");
	writeFileSync(path, body, { mode: 0o755 });
	git(work, ["add", "--", ".omp/push-check"]);
	git(work, ["commit", "-m", "register push check [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	return createHash("sha256").update(body).digest("hex");
}


/** Selected-hunk patch mode (ompkit-rhy9.8): caller patch, peer advance, stale checkout. */
export const SERVICE_BASE = Array.from({ length: 30 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`).join("\n") + "\n";

export function numberedLines(from: number, to: number): string[] {
	const out: string[] = [];
	for (let i = from; i <= to; i++) out.push(`line${String(i).padStart(2, "0")}`);
	return out;
}

export function writeServiceLines(work: string, mutate: (lines: string[]) => void): void {
	const lines = readFileSync(join(work, "service.txt"), "utf8").split("\n");
	mutate(lines);
	writeFileSync(join(work, "service.txt"), lines.join("\n"));
}

export type HunkSetup = { work: string; fakeBin: string; bare: string; base: string; caller: string; patch: string; checkContent: string; checkAdded: string };

export function hunkSetup(peer: "shift" | "conflict" | "none"): HunkSetup {
	const { work, fakeBin } = fixture();
	const bare = git(work, ["remote", "get-url", "origin"]).trim();
	const checkContent = join(scratch, `patch-check-content-${fixtureNumber}.txt`);
	const checkAdded = join(scratch, `patch-check-added-${fixtureNumber}.txt`);
	registerPushCheck(work, [
		"#!/bin/bash",
		"set -eu",
		'git -C "$OMP_LAND_REPOSITORY" show "$OMP_LAND_CANDIDATE_SHA:service.txt" > "$OMP_LAND_CHECK_CONTENT_FILE"',
		'git -C "$OMP_LAND_REPOSITORY" show "$OMP_LAND_CANDIDATE_SHA:feature/added.txt" > "$OMP_LAND_CHECK_ADDED_FILE"',
		"exit 0",
	].join("\n") + "\n");
	writeFileSync(join(work, "service.txt"), SERVICE_BASE);
	git(work, ["add", "service.txt"]);
	git(work, ["commit", "-m", "service base [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const base = remoteHead(work);
	const caller = join(scratch, `caller-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", bare, caller]);
	git(caller, ["config", "user.name", "caller"]);
	git(caller, ["config", "user.email", "caller@example.invalid"]);
	if (peer !== "none") {
		const peerDir = join(scratch, `peer-${fixtureNumber}`);
		git(scratch, ["clone", "--branch", "main", bare, peerDir]);
		git(peerDir, ["config", "user.name", "peer"]);
		git(peerDir, ["config", "user.email", "peer@example.invalid"]);
		writeServiceLines(peerDir, (lines) => {
			lines.unshift("peer header 1", "peer header 2", "peer header 3");
			if (peer === "shift") {
				lines[19] = "peer changed line17";
				lines[23] = "peer changed region";
			} else {
				lines[10] = "peer other A11"; lines[11] = "peer other A12"; lines[12] = "peer other A13"; lines[13] = "peer other A14"; lines[14] = "peer other A15";
			}
		});
		git(peerDir, ["add", "service.txt"]);
		git(peerDir, ["commit", "-m", "peer advance [test]"]);
		git(peerDir, ["push", "origin", "HEAD:refs/heads/main"]);
	}
	writeServiceLines(caller, (lines) => {
		lines[10] = "caller new A11"; lines[11] = "caller new A12"; lines[12] = "caller new A13"; lines[13] = "caller new A14"; lines[14] = "caller new A15";
	});
	mkdirSync(join(caller, "feature"), { recursive: true });
	writeFileSync(join(caller, "feature", "added.txt"), "caller added file\n");
	git(caller, ["add", "service.txt", join("feature", "added.txt")]);
	git(caller, ["commit", "-m", "caller selection [test]"]);
	const patch = join(scratch, `caller-${fixtureNumber}.patch`);
	writeFileSync(patch, git(caller, ["diff", base, "HEAD"]));
	return { work, fakeBin, bare, base, caller, patch, checkContent, checkAdded };
}

export function patchHold(): unknown[] {
	return [
		{ agent: "DarkFern", path: "service.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: "feature/added.txt", exclusive: true, remaining_seconds: 3600 },
	];
}

export const EXPECTED_SERVICE = ["peer header 1", "peer header 2", "peer header 3", ...numberedLines(1, 10),
	"caller new A11", "caller new A12", "caller new A13", "caller new A14", "caller new A15",
	"line16", "peer changed line17", "line18", "line19", "line20", "peer changed region", ...numberedLines(22, 30)].join("\n") + "\n";


/** Actual-parent publication qualification (ompkit-rhy9.10): the candidate is
 * qualified against its real construction parent, never a dispatch seed. */

export function actualParentSetup(): { work: string; fakeBin: string; seed: string; parent: string } {
	const { work, fakeBin } = fixture();
	const seed = remoteHead(work);
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const peerDir = join(scratch, `actual-parent-peer-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, peerDir]);
	git(peerDir, ["config", "user.name", "actual-parent peer"]);
	git(peerDir, ["config", "user.email", "actual-parent-peer@example.invalid"]);
	writeFileSync(join(peerDir, "owned.txt"), "actual parent bytes\n");
	git(peerDir, ["add", "--", "owned.txt"]);
	git(peerDir, ["commit", "-m", "actual parent advances owned bytes [test]"]);
	git(peerDir, ["push", "origin", "HEAD:refs/heads/main"]);
	const parent = remoteHead(work);
	expect(parent).not.toBe(seed);
	git(work, ["fetch", "origin"]);
	git(work, ["merge", "--ff-only", "origin/main"]);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(parent);
	return { work, fakeBin, seed, parent };
}
