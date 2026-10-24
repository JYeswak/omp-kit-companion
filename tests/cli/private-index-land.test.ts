import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";

type SchemaNode = { type?: string | string[]; required?: string[]; properties?: Record<string, SchemaNode>; items?: SchemaNode; enum?: unknown[];
	const?: unknown; allOf?: { if: SchemaNode; then?: SchemaNode; else?: SchemaNode }[] };

/** The checks the published schema makes, enough for land's data: type, enum, required, properties, items, const, if/then/else. */
function schemaViolations(value: unknown, node: SchemaNode, at = "data"): string[] {
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

const landSchema = COMMANDS.find((command) => command.name === "land")?.dataSchema as unknown as SchemaNode;

/** A real land response must satisfy the schema `omp-kit schema` publishes for it (ompkit-rhy9.9). */
function expectLandSchema(data: unknown): void {
	expect(schemaViolations(data, landSchema)).toEqual([]);
}

test("the published land schema rejects what land never emits and what a PUSHED land must carry", () => {
	const check = { status: "PASS", path: ".omp/push-check", sha256: null, selected_executable: null, selected_version: null, candidate_sha: null, checked_sha: null, pushed_sha: null, exit_code: null };
	const pushed = { overall: "PUSHED", commit: "a".repeat(40), candidate_sha: "a".repeat(40), pushed_sha: "a".repeat(40), owner: "x", paths: ["p"], base: "b", convergence: {}, check };
	expect(schemaViolations({ overall: "REFUSED", check: { ...check, status: "UNRUN", reason: "not_started" } }, landSchema)).toEqual([]);
	expect(schemaViolations({ ...pushed, overall: "SAVED_NOT_PUBLISHED" }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ ...pushed, pushed_sha: null }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ ...pushed, commit: null }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ ...pushed, check: { ...check, status: "MAYBE" } }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ overall: "UNRUN" }, landSchema)).not.toEqual([]);
});
test("the published grammar lists exit 77 as not_run", () => {
	const child = spawnSync(process.execPath, ["run", cliPath, "schema", "--json"], { stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" } as NodeJS.ProcessEnv });
	expect(child.status).toBe(0);
	const body = JSON.parse(child.stdout.toString()) as { data: { exit_codes: Record<string, number> } };
	expect(body.data.exit_codes).toMatchObject({ not_run: 77, success: 0, finding: 1 });
});

const repoRoot = resolve(import.meta.dir, "../..");
const cliPath = join(repoRoot, "src", "cli.ts");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, `private-index-land.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid} label=private-index-land repo=${repoRoot} created=${new Date().toISOString()}\n`);
// land's push-time scratch disposal gate scans the scratch roots for dirs the
// caller owns. Every land run here reads this empty fixture root instead of the
// real ~/Developer/*/var/agent-tmp roots, so a dir held by whoever runs the suite
// (or a dead owner whose pid a land child reuses) cannot change a test's result.
const landScratchRoot = join(scratch, "land-scratch-root");
mkdirSync(landScratchRoot);
let fixtureNumber = 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Fixture = { work: string; fakeBin: string };


function command(cwd: string, args: string[], holds: unknown, options: {
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
}) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_INDEX_FILE;
	Object.assign(env, options.gitEnv);
	env.PATH = `${options.amDir}:${env.PATH ?? "/usr/bin:/bin"}`;
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
	env.FAKE_AM_PROJECT = options.expectedAmProject ?? cwd;
	env.FAKE_TERN_PANE = options.ternPane ?? "";
	env.FAKE_HERDR_PANE = options.registeredHerdrPane ?? options.herdrPaneId ?? "";
	env.FAKE_HERDR_AGENT = options.herdrAgent ?? options.agent ?? "DarkFern";
	env.FAKE_HOLDS_JSON = JSON.stringify(holds);
	env.FAKE_AM_MODE = options.reservationMode ?? "ok";
	const run = spawnSync("bun", [cliPath, options.subcommand ?? "land", ...args, "--json"], { cwd, env, encoding: "utf8", timeout: 30_000 });
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(run.stdout);
	} catch {
		throw new Error(`land command emitted invalid JSON (status ${run.status}): ${run.stdout}\n${run.stderr}`);
	}
	return { status: run.status ?? 1, body };
}

function git(cwd: string, args: string[]): string {
	const run = spawnSync("git", ["-c", "user.name=LAND1 test", "-c", "user.email=land1@example.invalid", ...args], {
		cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 10_000,
	});
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed (${run.status}): ${String(run.stderr)}`);
	return String(run.stdout);
}
function remoteHead(cwd: string): string {
	const output = git(cwd, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const [sha, ref] = output.split("\t");
	if (!sha || ref !== "refs/heads/main") throw new Error(`unexpected origin/main response: ${output}`);
	return sha;
}
function committedGateFile(path: string): Buffer {
	const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });
	if (head.error) throw new Error(`cannot identify fixture source HEAD: ${head.error.message}`);
	if (head.status === 0) {
		const file = spawnSync("git", ["show", `HEAD:${path}`], { cwd: repoRoot, timeout: 10_000 });
		if (file.error || file.status !== 0) throw new Error(`cannot read committed gate file ${path}: ${String(file.stderr ?? "")}`);
		return Buffer.isBuffer(file.stdout) ? file.stdout : Buffer.from(String(file.stdout ?? ""));
	}
	return readFileSync(join(repoRoot, path));
}

function fixture(): Fixture {
	const id = fixtureNumber++;
	const bare = join(scratch, `origin-${id}.git`);
	const work = join(scratch, `work-${id}`);
	git(scratch, ["init", "--bare", "--initial-branch=main", bare]);
	git(scratch, ["clone", bare, work]);
	git(work, ["config", "user.name", "LAND1 test"]);
	git(work, ["config", "user.email", "land1@example.invalid"]);
	mkdirSync(join(work, "var", "agent-tmp"), { recursive: true });
	writeFileSync(join(work, "owned.txt"), "base owned\n");
	writeFileSync(join(work, "peer.txt"), "peer baseline\n");
	writeFileSync(join(work, "untouched.txt"), "untouched baseline\n");
	mkdirSync(join(work, "tests", "cli"), { recursive: true });
	writeFileSync(join(work, "suite-contract.txt"), "PASS\n");
	writeFileSync(join(work, "tests", "cli", "land-suite.test.sh"), "#!/bin/sh\nset -eu\nif grep -Fxq SLOW suite-contract.txt; then sleep 10; fi\ngrep -Fxq PASS suite-contract.txt\n", { mode: 0o755 });
	mkdirSync(join(work, "scripts"), { recursive: true });
	const gateFiles = ["scripts/full-suite-verdict.sh", "scripts/fresh-gate.sh", "scripts/kitlib-tmp.sh"];
	if (existsSync(join(repoRoot, "scripts", "gate-ci-only.tsv"))) gateFiles.push("scripts/gate-ci-only.tsv");
	for (const path of gateFiles)
		writeFileSync(join(work, path), committedGateFile(path), { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
	git(work, ["add", "-A"]);
	git(work, ["commit", "-m", "base [test]"]);
	git(work, ["push", "-u", "origin", "HEAD:refs/heads/main"]);
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

function landArgs(...paths: string[]): string[] {
	return [...paths.flatMap((path) => ["--paths", path]), "--message", "feat(land): publish reserved fixture [test]", "--apply", "--yes"];
}

function responseCode(body: Record<string, unknown>): string | undefined {
	const errors = body.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	const first = errors[0];
	return first !== null && typeof first === "object" && "code" in first && typeof first.code === "string" ? first.code : undefined;
}

function registerPushCheck(work: string, body: string): string {
	mkdirSync(join(work, ".omp"), { recursive: true });
	const path = join(work, ".omp", "push-check");
	writeFileSync(path, body, { mode: 0o755 });
	git(work, ["add", "--", ".omp/push-check"]);
	git(work, ["commit", "-m", "register push check [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	return createHash("sha256").update(body).digest("hex");
}

test("checks the exact candidate with the base-registered push check before publishing", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, ".omp"), { recursive: true });
	const checkBody = [
		"#!/bin/bash",
		"set -eu",
		'printf "%s\\n" "$OMP_LAND_CANDIDATE_SHA" > "$OMP_LAND_CHECK_SHA_FILE"',
		'git -C "$OMP_LAND_REPOSITORY" show "$OMP_LAND_CANDIDATE_SHA:owned.txt" > "$OMP_LAND_CHECK_CONTENT_FILE"',
	].join("\n") + "\n";
	const checkPath = join(work, ".omp", "push-check");
	writeFileSync(checkPath, checkBody, { mode: 0o755 });
	git(work, ["add", "--", ".omp/push-check"]);
	git(work, ["commit", "-m", "register push check [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);

	writeFileSync(join(work, "owned.txt"), "candidate owned content\n");
	writeFileSync(join(work, ".git", "hooks", "post-commit"),
		`#!/bin/sh\nprintf 'post-commit worktree edit\\n' > '${join(work, "owned.txt")}'\n`);
	chmodSync(join(work, ".git", "hooks", "post-commit"), 0o755);
	const checkShaFile = join(scratch, `checked-sha-${fixtureNumber}.txt`);
	const checkContentFile = join(scratch, `checked-content-${fixtureNumber}.txt`);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	writeFileSync(join(work, "scripts", "fresh-gate.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin,
		gitEnv: {
			OMP_LAND_CHECK_SHA_FILE: checkShaFile,
			OMP_LAND_REPOSITORY: work,
			OMP_LAND_CHECK_CONTENT_FILE: checkContentFile,
		},
	});
	expect(run.status).toBe(0);
	const data = run.body.data as {
		overall: string;
		commit: string;
		check?: {
			status: string;
			path: string;
			sha256: string;
			selected_executable: string;
			selected_version: string;
			checked_sha: string;
			pushed_sha: string;
		};
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.check?.status).toBe("PASS");
	expect(data.check?.path).toBe(".omp/push-check");
	expect(data.check?.sha256).toBe(createHash("sha256").update(checkBody).digest("hex"));
	// land.ts records the realpath of the shebang interpreter: /bin/bash on macOS, /usr/bin/bash on usr-merged Linux.
	expect(data.check?.selected_executable).toBe(realpathSync("/bin/bash"));
	expect(data.check?.selected_version.length).toBeGreaterThan(0);
	expect(data.check?.checked_sha).toBe(data.commit);
	expect(data.check?.pushed_sha).toBe(data.commit);
	expect(readFileSync(checkShaFile, "utf8")).toBe(`${data.commit}\n`);
	expect(readFileSync(checkContentFile, "utf8")).toBe("candidate owned content\n");
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("post-commit worktree edit\n");
	const tree = git(work, ["rev-parse", `${data.commit}^{tree}`]).trim();
	const verdictPath = join(work, ".git", "omp-kit", "full-suite-verdicts", `${tree}.json`);
	const expectedChecks = createHash("sha256")
		.update(git(work, ["show", `${data.commit}:scripts/full-suite-verdict.sh`]))
		.update(git(work, ["show", `${data.commit}:scripts/fresh-gate.sh`]))
		.update(git(work, ["show", `${data.commit}:scripts/kitlib-tmp.sh`]))
		.update(git(work, ["show", `${data.commit}:scripts/gate-ci-only.tsv`]))
		.digest("hex");
	expect(JSON.parse(readFileSync(verdictPath, "utf8"))).toMatchObject({
		tree, checks: expectedChecks, verdict: "PASS", evidence: { complete: true },
	});
	expect(remoteHead(work)).toBe(data.commit);
});
test("contradictory cached PASS evidence is a cache miss and cannot publish", () => {
	const { work } = fixture();
	writeFileSync(join(work, "suite-contract.txt"), "FAIL\n");
	git(work, ["add", "suite-contract.txt"]);
	git(work, ["commit", "-m", "plant red suite [test]"]);
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const script = join(work, "scripts", "full-suite-verdict.sh");
	const cache = join(work, ".git", "omp-kit", "full-suite-verdicts");
	const first = spawnSync("sh", [script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
		cwd: work, encoding: "utf8", env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" }, timeout: 30_000,
	});
	expect(first.status, first.stdout + first.stderr).toBe(1);
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const verdictPath = join(cache, `${tree}.json`);
	const entry = JSON.parse(readFileSync(verdictPath, "utf8")) as { verdict: string; exit_code: number; evidence: Record<string, unknown> };
	entry.verdict = "PASS";
	entry.exit_code = 0;
	entry.evidence.shell_fail = 1;
	writeFileSync(verdictPath, JSON.stringify(entry) + "\n");
	const contradictory = spawnSync("sh", [script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
		cwd: work, encoding: "utf8", env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" }, timeout: 30_000,
	});
	expect(contradictory.status, contradictory.stdout + contradictory.stderr).toBe(1);
	expect(`${contradictory.stdout}${contradictory.stderr}`).toContain("cache miss");
	const missingCount = JSON.parse(readFileSync(verdictPath, "utf8")) as { verdict: string; exit_code: number; evidence: Record<string, unknown> };
	missingCount.verdict = "PASS";
	missingCount.exit_code = 0;
	delete missingCount.evidence.bun_files;
	missingCount.evidence.bun_ran = 0;
	missingCount.evidence.bun_fail = 0;
	missingCount.evidence.shell_fail = 0;
	missingCount.evidence.py_fail = 0;
	writeFileSync(verdictPath, JSON.stringify(missingCount) + "\n");
	const missing = spawnSync("sh", [script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
		cwd: work, encoding: "utf8", env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" }, timeout: 30_000,
	});
	expect(missing.status, missing.stdout + missing.stderr).toBe(1);
	expect(`${missing.stdout}${missing.stderr}`).toContain("cache miss");
});
test("missing or corrupt suite logs are not reused as cached PASS", async () => {
	const { work } = fixture();
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const script = join(work, "scripts", "full-suite-verdict.sh");
	// Use the candidate judge so this fixture exercises the implementation under test.
	writeFileSync(script, readFileSync(join(repoRoot, "scripts", "full-suite-verdict.sh")), { mode: 0o755 });
	const cache = join(work, ".git", "omp-kit", "full-suite-verdicts");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.OMP_KIT_OMP_SRC_FETCH = "0";
	const runOnce = async () => {
		const result = await kitlibRun(["sh", script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
			cwd: work, env, deadline_s: 30,
		});
		const decoder = new TextDecoder();
		return { status: result.rc, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
	};
	const first = await runOnce();
	expect(first.status, first.stdout + first.stderr).toBe(0);
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const logPath = join(cache, `${tree}.log`);
	const originalLog = readFileSync(logPath, "utf8");
	expect(originalLog).toContain("GREEN script-suite tests/cli/land-suite.test.sh");
	const initialEntry = JSON.parse(readFileSync(join(cache, `${tree}.json`), "utf8")) as { evidence: { log_sha256?: string } };
	expect(initialEntry.evidence.log_sha256).toBe(createHash("sha256").update(originalLog).digest("hex"));

	for (const damage of ["corrupt", "missing"] as const) {
		if (damage === "corrupt") writeFileSync(logPath, "corrupted suite evidence\n");
		else unlinkSync(logPath);
		const replay = await runOnce();
		const output = `${replay.stdout}${replay.stderr}`;
		expect(replay.status, output).toBe(0);
		expect(output).toContain("FULL-SUITE: cache miss");
		expect(output).not.toContain("FULL-SUITE: VERDICT REUSED PASS");
		expect(readFileSync(logPath, "utf8")).toBe(originalLog);
	}
}, 35_000);
test("refuses a candidate whose exact full suite is red before origin advances", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	const contract = join(work, "suite-contract.txt");
	writeFileSync(contract, "FAIL\n");
	writeFileSync(join(work, "owned.txt"), "candidate with failing full suite\n");
	const hold = [
		{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: "suite-contract.txt", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("owned.txt", "suite-contract.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_FULL_SUITE_FAILED");
	expect(remoteHead(work)).toBe(base);
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const verdictPath = join(work, ".git", "omp-kit", "full-suite-verdicts", `${tree}.json`);
	expect(JSON.parse(readFileSync(verdictPath, "utf8"))).toMatchObject({
		tree, verdict: "FAIL", evidence: { complete: true },
	});
});

test("refuses incomplete full-suite evidence before origin advances", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "suite-contract.txt"), "SLOW\n");
	writeFileSync(join(work, "owned.txt"), "candidate with incomplete full suite\n");
	const hold = [
		{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: "suite-contract.txt", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("owned.txt", "suite-contract.txt"), hold, {
		amDir: fakeBin,
		gitEnv: { FULL_SUITE_TIMEOUT_SECS: "1" },
	});
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_FULL_SUITE_UNRUN");
	expect(remoteHead(work)).toBe(base);
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const verdictPath = join(work, ".git", "omp-kit", "full-suite-verdicts", `${tree}.json`);
	expect(existsSync(verdictPath)).toBe(false);
});
test("requires explicit --yes before publishing", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--paths", "owned.txt", "--message", "feat(land): require explicit confirmation [test]", "--apply"], hold, { amDir: fakeBin });
	expect(run.status).toBe(2);
	expect(responseCode(run.body)).toBe("CONSENT_REQUIRED");

	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});
test("refuses a failing registered check without moving origin", () => {
	const { work, fakeBin } = fixture();
	const checkSha = registerPushCheck(work, "#!/bin/bash\nexit 1\n");
	writeFileSync(join(work, "owned.txt"), "candidate that fails check\n");
	const base = remoteHead(work);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_CHECK_FAILED");
	const data = run.body.data as {
		overall: string;
		candidate_sha: string;
		check: { status: string; sha256: string; checked_sha: string; pushed_sha: string | null };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("FAIL");
	expect(data.check.sha256).toBe(checkSha);
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(remoteHead(work)).toBe(base);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("candidate that fails check\n");
});

test("changed check bytes are skipped and never executed in the same candidate", () => {
	const { work, fakeBin } = fixture();
	const checkMarker = join(scratch, `changed-check-${fixtureNumber}.txt`);
	const registeredBody = `#!/bin/bash\nprintf 'old-check\\n' > \"$OMP_LAND_CHECK_MARKER_FILE\"\nexit 0\n`;
	const registeredSha = registerPushCheck(work, registeredBody);
	const changedBody = `#!/bin/bash\nprintf 'changed-check-ran\\n' > \"$OMP_LAND_CHECK_MARKER_FILE\"\nexit 0\n`;
	writeFileSync(join(work, ".omp", "push-check"), changedBody, { mode: 0o755 });
	writeFileSync(join(work, "owned.txt"), "owner change with check update\n");
	const hold = [
		{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: ".omp/push-check", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("owned.txt", ".omp/push-check"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(0);
	const data = run.body.data as {
		overall: string;
		commit: string;
		check: { status: string; reason: string; sha256: string; candidate_sha256: string; checked_sha: string | null; pushed_sha: string };
	};
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("SKIP");
	expect(data.check.reason).toBe("hash_changed");
	expect(data.check.sha256).toBe(registeredSha);
	expect(data.check.candidate_sha256).toBe(createHash("sha256").update(changedBody).digest("hex"));
	expect(data.check.checked_sha).toBeNull();
	expect(data.check.pushed_sha).toBe(data.commit);
	expect(existsSync(checkMarker)).toBe(false);
	expect(remoteHead(work)).toBe(data.commit);
});

test("first check registration is skipped until a later landing", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, ".omp"), { recursive: true });
	const checkMarker = join(scratch, `new-check-${fixtureNumber}.txt`);
	const body = `#!/bin/bash\nprintf 'new-check-ran\\n' > \"$OMP_LAND_CHECK_MARKER_FILE\"\nexit 0\n`;
	writeFileSync(join(work, ".omp", "push-check"), body, { mode: 0o755 });
	writeFileSync(join(work, "new-owned.txt"), "first registration\n");
	const hold = [
		{ agent: "DarkFern", path: "new-owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: ".omp/push-check", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("new-owned.txt", ".omp/push-check"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string; check: { status: string; reason: string; checked_sha: string | null } };
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("SKIP");
	expect(data.check.reason).toBe("unregistered");
	expect(data.check.checked_sha).toBeNull();
	expect(existsSync(checkMarker)).toBe(false);
	expect(remoteHead(work)).toBe(data.commit);
});

test("unavailable registered check returns UNRUN before commit or publication", () => {
	const { work, fakeBin } = fixture();
	registerPushCheck(work, "#!/not/a/real/land-check-runner\nexit 0\n");
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_CHECK_UNRUN");
	const data = run.body.data as { overall: string; commit: null; check: { status: string; reason: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("UNRUN");
	expect(data.commit).toBeNull();
	expect(data.check.status).toBe("UNRUN");
	expect(data.check.reason).toBe("check_interpreter_unavailable");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

test("a rejecting commit-msg hook refuses before origin moves", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const before = remoteHead(work);
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hookMarker = join(scratch, `commit-msg-${fixtureNumber}.txt`);
	const hook = join(work, ".git", "hooks", "commit-msg");
	writeFileSync(hook, `#!/bin/sh\nprintf 'hook-ran\\n' > '${hookMarker}'\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("COMMIT_CREATION_REFUSED");
	const data = run.body.data as { overall: string; commit: null; check: { status: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.commit).toBeNull();
	expect(data.check.status).toBe("SKIP");
	expect(readFileSync(hookMarker, "utf8")).toBe("hook-ran\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(before);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

test("publishes only the reserved path on shared main and preserves a peer staged deletion", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	git(work, ["rm", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(commit.length).toBe(40);
	expect([...commit].every((character) => (character >= "0" && character <= "9") || (character >= "a" && character <= "f"))).toBe(true);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	const commitBlob = git(work, ["ls-tree", commit, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(commitBlob);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"]).trim()).toBe("");
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("base owned\nowner change\n");
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
});
test("excludes foreign partially staged and unstaged content from the published candidate", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	writeFileSync(join(work, "untouched.txt"), "peer staged version\n");
	git(work, ["add", "untouched.txt"]);
	writeFileSync(join(work, "untouched.txt"), "peer staged version\npeer unstaged line\n");
	const peerContents = readFileSync(join(work, "untouched.txt"));
	const peerEntry = git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim()).toBe(peerEntry);
	const commitBlob = git(work, ["ls-tree", commit, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(commitBlob);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(peerContents);
});

const reservationRefusalCases = [
	["missing reservation", [], "DarkFern", "DarkFern"],
	["missing pane identity", [], "", "DarkFern"],
	["foreign owner", [{ agent: "OtherAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], "DarkFern", "DarkFern"],
	["nonexclusive hold", [{ agent: "DarkFern", path: "owned.txt", exclusive: false, remaining_seconds: 3600 }], "DarkFern", "DarkFern"],
	["expired hold", [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 0 }], "DarkFern", "DarkFern"],
	["identity mismatch", [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], "DarkFern", "OtherAgent"],
] as const;
for (const [reason, hold, agent, claimed] of reservationRefusalCases) {
	test(`refuses ${reason} without mutation`, () => {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), hold, { agent, claimed, amDir: fakeBin });
		expect(run.status).not.toBe(0);
		expect(["OWNER", "RESERVATION"].some((prefix) => responseCode(run.body)?.startsWith(prefix))).toBe(true);
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	});
}
test("refuses unreadable reservation sources and uncovered paths", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	for (const reservationMode of ["unavailable", "unreadable", "stale", "database-mismatch", "storage-mismatch"]) {
		const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, reservationMode });
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe(reservationMode === "unavailable" ? "RESERVATION_UNAVAILABLE" : "RESERVATION_UNREADABLE");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
	}
	const uncovered = command(work, landArgs("untouched.txt"), hold, { amDir: fakeBin });
	expect(uncovered.status).not.toBe(0);
	expect(responseCode(uncovered.body)).toBe("RESERVATION_REQUIRED");
}, 15_000);

test("refuses a partially staged reserved path instead of publishing staged and unstaged peer content", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "staged version\n");
	git(work, ["add", "owned.txt"]);
	writeFileSync(join(work, "owned.txt"), "staged version\nunstaged peer line\n");
	const index = readFileSync(join(work, ".git", "index"));
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("STAGED_OWNED_PATH_REFUSED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
});

test("converges an advanced origin while preserving the actual landed commit on shared main", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const writer = join(scratch, `baseline-writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	git(writer, ["config", "user.name", "baseline writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "new baseline\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "advance baseline [test]"]);
	git(writer, ["push", "origin", "HEAD:refs/heads/main"]);
	const initialHead = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("PUSHED");
	expect(data.commit).not.toBe(initialHead);
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, remoteHead(work)])).toBe("");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(remoteHead(work));
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("new baseline\n");
});

test("refuses an origin advance after candidate check without retry or force", () => {
	const { work, fakeBin } = fixture();
	const checkMarker = join(scratch, `checked-before-push-${fixtureNumber}.txt`);
	registerPushCheck(work, `#!/bin/bash\nprintf "%s\\n" "$OMP_LAND_CANDIDATE_SHA" > "$OMP_LAND_CHECK_MARKER_FILE"\nexit 0\n`);
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const writer = join(scratch, `writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	git(writer, ["config", "user.name", "competing writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "concurrent remote change\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "competing writer [test]"]);
	const attempts = join(scratch, `push-attempts-${fixtureNumber}.txt`);
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\ngit -C '${writer}' push origin HEAD:refs/heads/main\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUSH_REJECTED");
	const data = run.body.data as {
		overall: string;
		commit: string;
		candidate_sha: string;
		check: { status: string; checked_sha: string; pushed_sha: string | null };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(readFileSync(checkMarker, "utf8")).toBe(`${data.candidate_sha}\n`);
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
	expect(remoteHead(work)).toBe(git(writer, ["rev-parse", "HEAD"]).trim());
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, "refs/heads/main"])).toBe("");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(git(work, ["rev-parse", "refs/heads/main"]).trim());
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("owner change\n");
});
test("distinguishes a rejected push from an origin advance", () => {
	const { work, fakeBin } = fixture();
	const checkMarker = join(scratch, `check-before-reject-${fixtureNumber}.txt`);
	registerPushCheck(work, `#!/bin/bash\nprintf "%s\\n" "$OMP_LAND_CANDIDATE_SHA" > "$OMP_LAND_CHECK_MARKER_FILE"\nexit 0\n`);
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const base = remoteHead(work);
	const attempts = join(scratch, `rejected-push-attempts-${fixtureNumber}.txt`);
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	const data = run.body.data as {
		overall: string;
		candidate_sha: string;
		check: { status: string; checked_sha: string; pushed_sha: string | null };
		convergence: { reason: string };
		phases: { publication: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(data.convergence.reason).toBe("PUSH_FAILED");
	expect(data.phases.publication).toBe("NOT_APPLIED");
	expect(readFileSync(checkMarker, "utf8")).toBe(`${data.candidate_sha}\n`);
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
	expect(remoteHead(work)).toBe(base);
});

test("ignores inherited Git repository overrides", () => {
	const a = fixture();
	const b = fixture();
	writeFileSync(join(a.work, "owned.txt"), "owner change\n");
	writeFileSync(join(b.work, "owned.txt"), "poisoned repository B change\n");
	const aHead = git(a.work, ["rev-parse", "HEAD"]).trim();
	const aRemote = remoteHead(a.work);
	const bHead = git(b.work, ["rev-parse", "HEAD"]).trim();
	const bRemote = remoteHead(b.work);
	const bIndex = readFileSync(join(b.work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(a.work, landArgs("owned.txt"), hold, {
		amDir: a.fakeBin,
		gitEnv: { GIT_DIR: join(b.work, ".git"), GIT_WORK_TREE: b.work },
	});
	let commit = "";
	if (run.status === 0) {
		const data = run.body.data;
		commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	} else {
		expect(run.status).toBe(1);
		expect(remoteHead(a.work)).toBe(aRemote);
		expect(git(a.work, ["rev-parse", "HEAD"]).trim()).toBe(aHead);
	}
	expect(remoteHead(b.work)).toBe(bRemote);
	expect(git(b.work, ["rev-parse", "HEAD"]).trim()).toBe(bHead);
	expect(readFileSync(join(b.work, ".git", "index"))).toEqual(bIndex);
	if (run.status === 0) {
		expect(commit.length).toBe(40);
		expect(git(a.work, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
		expect(remoteHead(a.work)).toBe(commit);
		expect(git(a.work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
		expect(git(a.work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
		expect(git(a.work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
	}
});
test("saves and publishes consecutive owned commits directly on shared main", () => {
	const { work, fakeBin } = fixture();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	writeFileSync(join(work, "owned.txt"), "base owned\nfirst change\n");
	const first = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(first.status).toBe(0);
	const firstData = first.body.data;
	expect(firstData !== null && typeof firstData === "object" && "overall" in firstData && firstData.overall).toBe("PUSHED");
	const firstSha = firstData !== null && typeof firstData === "object" && "commit" in firstData && typeof firstData.commit === "string" ? firstData.commit : "";
	expect(firstSha.length).toBe(40);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(firstSha);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(firstSha);
	expect(remoteHead(work)).toBe(firstSha);
	const firstBlob = git(work, ["ls-tree", firstSha, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(firstBlob);
	const writer = join(scratch, `consecutive-writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	writeFileSync(join(writer, "untouched.txt"), "remote between owned lands\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "advance between owned lands [test]"]);
	git(writer, ["push", "origin", "main"]);
	writeFileSync(join(work, "peer.txt"), "peer staged between lands\n");
	git(work, ["add", "peer.txt"]);
	writeFileSync(join(work, "peer.txt"), "peer dirty between lands\n");
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	writeFileSync(join(work, "owned.txt"), "base owned\nfirst change\nsecond change\n");
	const second = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(second.status).toBe(0);
	const secondData = second.body.data;
	expect(secondData !== null && typeof secondData === "object" && "overall" in secondData && secondData.overall).toBe("PUSHED");
	const secondSha = secondData !== null && typeof secondData === "object" && "commit" in secondData && typeof secondData.commit === "string" ? secondData.commit : "";
	expect(secondSha.length).toBe(40);
	expect(secondSha).not.toBe(firstSha);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(remoteHead(work));
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(remoteHead(work));
	expect(git(work, ["merge-base", "--is-ancestor", secondSha, remoteHead(work)])).toBe("");
	expect(git(work, ["merge-base", "--is-ancestor", firstSha, secondSha])).toBe("");
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer dirty between lands\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("remote between owned lands\n");
	const secondBlob = git(work, ["ls-tree", secondSha, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(secondBlob);
});
test("refuses detached HEAD without creating or publishing an off-main candidate", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	git(work, ["checkout", "--detach", "HEAD"]);
	const detached = git(work, ["rev-parse", "HEAD"]).trim();
	const elsewhere = git(work, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "stale main [test]"]).trim();
	git(work, ["update-ref", "refs/heads/main", elsewhere]);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_MAIN_REQUIRED");
	expect(remoteHead(work)).toBe(detached);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(elsewhere);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(detached);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});
test("preserves worktree edits made during publication without off-main catch-up", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'post-build edit\n' >> '${work}/owned.txt'\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(remoteHead(work)).toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(git(work, ["show", ":owned.txt"])).toBe("owner change\n");
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\npost-build edit\n");
});
test("shared-main landing preserves peer staged and worktree bytes", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	writeFileSync(join(work, "untouched.txt"), "peer staged version\n");
	git(work, ["add", "untouched.txt"]);
	writeFileSync(join(work, "untouched.txt"), "peer staged version\npeer unstaged line\n");
	const peerContents = readFileSync(join(work, "untouched.txt"));
	const peerEntry = git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(peerContents);
	expect(git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim()).toBe(peerEntry);
	const commitBlob = git(work, ["ls-tree", commit, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(commitBlob);
});
test("refuses an unregistered pane identity without mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, reservationMode: "unregistered" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});
test("lands for a registered Tern caller through the tern key", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "tern owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "TernAgent" });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(commit.length).toBe(40);
	expect(head).not.toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
});
test("refuses an unregistered Tern pane without mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "9999999999999", ternAgent: "TernAgent", claimed: "TernAgent", reservationMode: "unregistered" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});
test("refuses a Tern caller whose claim does not match without mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "OtherAgent" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});
test("refuses an absent or malformed Tern pane key without mutation", () => {
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	for (const ternPane of [undefined, "", "12ab", "tern:1756641624115"]) {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane, ternAgent: "TernAgent", claimed: "TernAgent" });
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
	}
});
test("keeps tmux precedence when both pane keys are present", () => {
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const first = fixture();
	writeFileSync(join(first.work, "owned.txt"), "tmux owner change\n");
	const tmuxRun = command(first.work, landArgs("owned.txt"), hold, { amDir: first.fakeBin, ternPane: "1756641624115", ternAgent: "OtherAgent", claimed: "DarkFern" });
	expect(tmuxRun.status).toBe(0);
	const tmuxData = tmuxRun.body.data;
	expect(tmuxData !== null && typeof tmuxData === "object" && "overall" in tmuxData && tmuxData.overall).toBe("PUSHED");
	const second = fixture();
	writeFileSync(join(second.work, "owned.txt"), "unpublished change\n");
	const head = git(second.work, ["rev-parse", "HEAD"]).trim();
	const mismatch = command(second.work, landArgs("owned.txt"), hold, { amDir: second.fakeBin, ternPane: "1756641624115", ternAgent: "OtherAgent", claimed: "OtherAgent" });
	expect(mismatch.status).not.toBe(0);
	expect(responseCode(mismatch.body)).toBe("OWNER_MISMATCH");
	expect(git(second.work, ["rev-parse", "HEAD"]).trim()).toBe(head);
});
test("lands through the registered Herdr pane key and canonical project identity", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "Herdr owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin, agent: "TmuxFallback", claimed: "HerdrAgent", tmuxPane: null,
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	expect(data !== null && typeof data === "object" && "owner" in data && data.owner).toBe("HerdrAgent");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(head).not.toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
});

test("Herdr identity can land only its exact current reservation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "HerdrAgent", path: "peer.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin, claimed: "HerdrAgent", tmuxPane: null,
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});

test("refuses incomplete or spoofed Herdr identity without borrowing tmux", () => {
	const attempts: Array<{ herdrEnv?: string; herdrPaneId?: string }> = [
		{ herdrEnv: "1" },
		{ herdrPaneId: "w2:p3" },
	];
	for (const attempt of attempts) {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = remoteHead(work);
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
			amDir: fakeBin, agent: "DarkFern", claimed: "DarkFern", tmuxPane: "%60", ...attempt,
		});
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe("OWNER_UNAVAILABLE");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(remoteHead(work)).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
	}
});

test("refuses ambiguous Herdr and outer-pane identity markers before mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
		amDir: fakeBin, agent: "TmuxFallback", claimed: "HerdrAgent", tmuxPane: "%60",
		ternPane: "1756641624115", ternAgent: "TernFallback",
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_AMBIGUOUS");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});

test("refuses stale and cross-project Herdr bindings before mutation", () => {
	for (const binding of [
		{ registeredHerdrPane: "w1:p1", expectedAmProject: undefined },
		{ registeredHerdrPane: "w2:p3", expectedAmProject: "/other/project" },
	]) {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = remoteHead(work);
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
			amDir: fakeBin, claimed: "HerdrAgent", tmuxPane: null,
			herdrEnv: "1", herdrPaneId: "w2:p3", herdrAgent: "HerdrAgent", ...binding,
		});
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(remoteHead(work)).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
	}
});

test("refuses ambiguous Herdr resolver output before mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
		amDir: fakeBin, claimed: "HerdrAgent", tmuxPane: null, reservationMode: "ambiguous",
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});

test("refuses a Herdr pane whose claimed agent name differs", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
		amDir: fakeBin, claimed: "DifferentAgent", tmuxPane: null,
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});
test("refuses a Tern caller without a covering lease", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "OtherAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "TernAgent" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});

test("keeps the saved commit and peer state when both sides changed the owned path", () => {
	const { work, fakeBin } = fixture();
	const writer = join(scratch, `conflicting-writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	writeFileSync(join(writer, "owned.txt"), "remote owner edit\n");
	git(writer, ["add", "owned.txt"]);
	git(writer, ["commit", "-m", "remote conflicting edit [test]"]);
	git(writer, ["push", "origin", "main"]);
	const remote = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "local owner edit\n");
	writeFileSync(join(work, "peer.txt"), "peer staged\n");
	git(work, ["add", "peer.txt"]);
	writeFileSync(join(work, "peer.txt"), "peer dirty\n");
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("REFUSED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.commit);
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("local owner edit\n");
	expect(remoteHead(work)).toBe(remote);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer dirty\n");
});

test("refuses directory reservations rather than committing unreserved descendants", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, "owned-dir"));
	writeFileSync(join(work, "owned-dir", "unreserved.txt"), "not owned\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned-dir", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned-dir"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATH_INVALID");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
});

test("publishes a new owned file without committing peer staging", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "new-owned.txt"), "new file\n");
	writeFileSync(join(work, "peer.txt"), "peer staged\n");
	git(work, ["add", "peer.txt"]);
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "new-owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("new-owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expect(git(work, ["show", "HEAD:new-owned.txt"])).toBe("new file\n");
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(git(work, ["show", "HEAD:peer.txt"])).toBe("peer baseline\n");
});

test("commits an owned tracked deletion on shared main while leaving peer entries alone", () => {
	const { work, fakeBin } = fixture();
	unlinkSync(join(work, "owned.txt"));
	writeFileSync(join(work, "peer.txt"), "peer staging\n");
	git(work, ["add", "peer.txt"]);
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expect(git(work, ["ls-tree", "HEAD", "--", "owned.txt"])).toBe("");
	expect(existsSync(join(work, "owned.txt"))).toBe(false);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(remoteHead(work));
});

test("a failed ordinary commit is not reported as saved or published", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hook = join(work, ".git", "hooks", "pre-commit");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n");
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("COMMIT_CREATION_REFUSED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

test("refuses a deleted directory that expands to unreserved tracked deletions", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, "owned-dir"));
	for (const name of ["a.txt", "b.txt"]) writeFileSync(join(work, "owned-dir", name), "baseline\n");
	git(work, ["add", "owned-dir/a.txt", "owned-dir/b.txt"]);
	git(work, ["commit", "-m", "directory deletion baseline [test]"]);
	git(work, ["push", "origin", "main"]);
	for (const name of ["a.txt", "b.txt"]) unlinkSync(join(work, "owned-dir", name));
	rmdirSync(join(work, "owned-dir"));
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned-dir", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned-dir"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATH_INVALID");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(git(work, ["diff", "--name-only"]).trim().split("\n")).toEqual(["owned-dir/a.txt", "owned-dir/b.txt"]);
});

test("reports commit-only phase evidence and preserves foreign state after a post-commit interruption", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "saved before hook interruption\n");
	unlinkSync(join(work, "peer.txt"));
	git(work, ["add", "-u", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign unstaged postimage\n");
	const before = remoteHead(work);
	const stagedPeer = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const stagedPeerDiff = git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"]);
	const foreignWorktree = readFileSync(join(work, "untouched.txt"));
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_COMMIT_INTERRUPTED");
	const data = run.body.data as {
		overall: string; commit: string; base: string;
		phases: {
			candidate_sha: string; actual_parents: string[]; publication_ref: string;
			construction: string; publication: string; local_catch_up: string;
			observed_local_main: string; observed_publication_head: string;
		};
	};
	expect(data.overall).toBe("UNRUN");
	expect(data.base).toBe(before);
	expect(data.phases).toEqual({
		candidate_sha: data.commit,
		actual_parents: [before],
		publication_ref: "refs/heads/main",
		construction: "APPLIED",
		publication: "NOT_APPLIED",
		local_catch_up: "NOT_APPLIED",
		observed_local_main: data.commit,
		observed_publication_head: before,
	});
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.commit);
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("saved before hook interruption\n");
	expect(git(work, ["show", ":owned.txt"])).toBe("saved before hook interruption\n");
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(stagedPeer);
	expect(git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"])).toBe(stagedPeerDiff);
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(foreignWorktree);
	expect(git(work, ["diff", "--name-only", "--", "untouched.txt"]).trim()).toBe("untouched.txt");
	expect(remoteHead(work)).toBe(before);
});

test("reports local catch-up without claiming publication or retrying", () => {
	const { work, fakeBin } = fixture();
	const peerWork = join(scratch, `peer-${fixtureNumber++}`);
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	git(scratch, ["clone", origin, peerWork]);
	git(peerWork, ["config", "user.name", "LAND1 peer"]);
	git(peerWork, ["config", "user.email", "land1-peer@example.invalid"]);
	writeFileSync(join(peerWork, "remote.txt"), "peer origin advance\n");
	git(peerWork, ["add", "remote.txt"]);
	git(peerWork, ["commit", "-m", "peer origin advance [test]"]);
	const peerTip = git(peerWork, ["rev-parse", "HEAD"]).trim();

	writeFileSync(join(work, "owned.txt"), "owned before catch-up\n");
	unlinkSync(join(work, "peer.txt"));
	git(work, ["add", "-u", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign unstaged postimage\n");
	const before = remoteHead(work);
	const stagedPeer = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const stagedPeerDiff = git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"]);
	const foreignWorktree = readFileSync(join(work, "untouched.txt"));
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit -C '${peerWork}' push origin main\n`);
	chmodSync(postCommit, 0o755);
	const attempts = join(work, "pre-push-count.txt");
	const prePush = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePush, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 1\n`);
	chmodSync(prePush, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];

	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	const data = run.body.data as {
		overall: string; commit: string; base: string; localMain: string;
		convergence: { reason: string };
		phases: {
			candidate_sha: string; actual_parents: string[]; publication_ref: string;
			construction: string; publication: string; local_catch_up: string;
			observed_local_main: string; observed_publication_head: string;
		};
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.convergence.reason).toBe("PUSH_FAILED");
	expect(data.base).toBe(before);
	expect(data.phases).toEqual({
		candidate_sha: data.commit,
		actual_parents: [before],
		publication_ref: "refs/heads/main",
		construction: "APPLIED",
		publication: "NOT_APPLIED",
		local_catch_up: "APPLIED",
		observed_local_main: data.localMain,
		observed_publication_head: peerTip,
	});
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, data.localMain]).length).toBe(0);
	expect(git(work, ["merge-base", "--is-ancestor", peerTip, data.localMain]).length).toBe(0);
	expect(remoteHead(work)).toBe(peerTip);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(stagedPeer);
	expect(git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"])).toBe(stagedPeerDiff);
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(foreignWorktree);
	expect(git(work, ["diff", "--name-only", "--", "untouched.txt"]).trim()).toBe("untouched.txt");
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);

});
test("recovery after interruption never overwrites foreign postimages changed before retry", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned first save\n");
	writeFileSync(join(work, "peer.txt"), "foreign staged v1\n");
	git(work, ["add", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign worktree v1\n");
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const interrupted = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(interrupted.status).toBe(77);
	expect(responseCode(interrupted.body)).toBe("LAND_COMMIT_INTERRUPTED");
	const firstData = interrupted.body.data as { commit: string };
	const first = firstData.commit;
	// The interrupted candidate must contain only the owned path even though a
	// foreign change was staged; otherwise --only was lost and foreign work leaked in.
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", first]).trim()).toBe("owned.txt");
	// A foreign actor changes F before recovery: the staged index entry and the
	// worktree bytes both move on after the interruption was reported.
	writeFileSync(join(work, "peer.txt"), "foreign staged v2\n");
	git(work, ["add", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign worktree v2\n");
	const stagedPostimage = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	// The faulty hook is repaired before recovery; the saved commit is kept, not undone.
	unlinkSync(hook);
	writeFileSync(join(work, "owned.txt"), "owned second save\n");
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const runData = run.body.data as { overall: string; commit: string };
	expect(runData.overall).toBe("PUSHED");
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", runData.commit]).trim()).toBe("owned.txt");
	expect(git(work, ["merge-base", "--is-ancestor", first, runData.commit]).length).toBe(0);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(stagedPostimage);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("foreign staged v2\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("foreign worktree v2\n");
	expect(git(work, ["diff", "--name-only", "--", "untouched.txt"]).trim()).toBe("untouched.txt");
	expect(remoteHead(work)).toBe(runData.commit);
}, 60_000);

test("lost publication observability stays UNKNOWN instead of a false zero-effects claim", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "untouched.txt"), "foreign unstaged postimage\n");
	const foreignWorktree = readFileSync(join(work, "untouched.txt"));
	const before = remoteHead(work);
	git(work, ["remote", "remove", "origin"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	const runData = run.body.data as {
		overall: string; commit: string; base: string;
		phases: {
			candidate_sha: string; actual_parents: string[]; publication_ref: string;
			construction: string; publication: string; local_catch_up: string;
			observed_local_main: string | null; observed_publication_head: string | null;
		};
	};
	// Only the dependent publication is blocked; the save itself is real and kept.
	expect(run.status).toBe(1);
	expect(runData.overall).toBe("REFUSED");
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(runData.base).toBe(before);
	expect(runData.phases.candidate_sha).toBe(runData.commit);
	expect(runData.phases.actual_parents).toEqual([before]);
	expect(runData.phases.publication_ref).toBe("refs/heads/main");
	expect(runData.phases.construction).toBe("APPLIED");
	// Publication observability is gone, so this must stay explicitly UNKNOWN:
	// a NOT_APPLIED here would be a false zero-effects claim about origin.
	expect(runData.phases.publication).toBe("UNKNOWN");
	expect(runData.phases.observed_publication_head).toBeNull();
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(runData.commit);
	expect(git(work, ["show", `${runData.commit}:owned.txt`])).toBe("owned save\n");
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(foreignWorktree);
}, 60_000);

test("an already-published candidate is confirmed, never published twice", () => {
	const { work, fakeBin } = fixture();
	const baseCount = Number(git(work, ["rev-list", "--count", "HEAD"]).trim());
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	const attempts = join(work, "pre-push-count.txt");
	const prePush = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePush, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 0\n`);
	chmodSync(prePush, 0o755);
	// The candidate reaches origin out-of-band from the save hook before land's
	// own convergence runs, so the publication phase must observe it, not redo it.
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, '#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit push -q --no-verify origin main\n');
	chmodSync(postCommit, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const runData = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string;
		phases: { candidate_sha: string; construction: string; publication: string; local_catch_up: string };
	};
	expect(runData.overall).toBe("PUSHED");
	expect(runData.pushed_sha).toBe(runData.commit);
	expect(runData.phases.candidate_sha).toBe(runData.commit);
	expect(runData.phases.construction).toBe("APPLIED");
	// Independently observed on the publication ref: applied, not assumed, not retried.
	expect(runData.phases.publication).toBe("APPLIED");
	expect(remoteHead(work)).toBe(runData.commit);
	// Exactly one push attempt for one candidate and exactly one new origin
	// commit: no blind retry loop and no duplicate publication of the candidate.
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
	expect(Number(git(work, ["rev-list", "--count", "refs/remotes/origin/main"]).trim())).toBe(baseCount + 1);
	const originCommits = git(work, ["rev-list", "refs/remotes/origin/main"]).trim().split("\n");
	expect(originCommits.filter((sha) => sha === runData.commit)).toHaveLength(1);
}, 60_000);


test("attributes the actual owned commit when a peer advances HEAD before Git returns", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "peer.txt"), "peer later save\n");
	const hook = join(work, ".git", "hooks", "post-commit");
	// The independent peer has its own Git environment, not this call's nonce.
	writeFileSync(hook, '#!/bin/sh\nif [ "$PEER_LANDED" != 1 ]; then\n  unset GIT_REFLOG_ACTION\n  PEER_LANDED=1 git commit --only -m "peer later save [test]" -- peer.txt\nfi\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("PUSHED");
	const tip = git(work, ["rev-parse", "HEAD"]).trim();
	expect(data.commit).not.toBe(tip);
	expect(git(work, ["rev-parse", "HEAD^"]).trim()).toBe(data.commit);
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", data.commit]).trim()).toBe("owned.txt");
	expect(git(work, ["show", `${data.commit}:peer.txt`])).toBe("peer baseline\n");
	expect(git(work, ["show", "HEAD:peer.txt"])).toBe("peer later save\n");
	expect(remoteHead(work)).toBe(tip);
});

test("refuses publication when inherited hook attribution is ambiguous", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "peer.txt"), "nested hook save\n");
	const before = remoteHead(work);
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nif [ "$PEER_LANDED" != 1 ]; then\n  PEER_LANDED=1 git commit --only -m "nested hook save [test]" -- peer.txt\nfi\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(77);
	const data = run.body.data as { overall: string; commit: null; base: string };
	expect(data.overall).toBe("UNRUN");
	expect(data.commit).toBeNull();
	expect(data.base).toBe(before);
	expect(responseCode(run.body)).toBe("LAND_COMMIT_UNVERIFIED");
	expect(git(work, ["show", "HEAD:owned.txt"])).toBe("owned save\n");
	expect(remoteHead(work)).toBe(before);
});

/** Selected-hunk patch mode (ompkit-rhy9.8): caller patch, peer advance, stale checkout. */
const SERVICE_BASE = Array.from({ length: 30 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`).join("\n") + "\n";

function numberedLines(from: number, to: number): string[] {
	const out: string[] = [];
	for (let i = from; i <= to; i++) out.push(`line${String(i).padStart(2, "0")}`);
	return out;
}

function writeServiceLines(work: string, mutate: (lines: string[]) => void): void {
	const lines = readFileSync(join(work, "service.txt"), "utf8").split("\n");
	mutate(lines);
	writeFileSync(join(work, "service.txt"), lines.join("\n"));
}

type HunkSetup = { work: string; fakeBin: string; bare: string; base: string; patch: string; checkContent: string; checkAdded: string };

function hunkSetup(peer: "shift" | "conflict" | "none"): HunkSetup {
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
	return { work, fakeBin, bare, base, patch, checkContent, checkAdded };
}

function patchHold(): unknown[] {
	return [
		{ agent: "DarkFern", path: "service.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: "feature/added.txt", exclusive: true, remaining_seconds: 3600 },
	];
}

const EXPECTED_SERVICE = ["peer header 1", "peer header 2", "peer header 3", ...numberedLines(1, 10),
	"caller new A11", "caller new A12", "caller new A13", "caller new A14", "caller new A15",
	"line16", "peer changed line17", "line18", "line19", "line20", "peer changed region", ...numberedLines(22, 30)].join("\n") + "\n";

test("reconstructs only caller-selected hunks onto fresh origin/main", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, bare, base, patch } = setup;
	const fresh = remoteHead(work);
	expect(fresh).not.toBe(base);
	// Without three-way reconstruction this exact specimen cannot land: the peer
	// advance shifted the caller hunk and changed its trailing context.
	const checker = join(scratch, `plain-check-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", bare, checker]);
	const plain = spawnSync("git", ["apply", "--check", patch], { cwd: checker, encoding: "utf8", timeout: 10_000 });
	expect(plain.status).not.toBe(0);
	expect(String(plain.stderr)).toContain("service.txt");
	// The shared checkout stays stale with unrelated staged and worktree bytes.
	writeFileSync(join(work, "peer.txt"), "staged peer bytes\n");
	git(work, ["add", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "unstaged worktree bytes\n");
	const stagedOid = git(work, ["rev-parse", ":peer.txt"]).trim();
	const statusBefore = git(work, ["status", "--porcelain"]);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	const run = command(work, ["--patch", patch, "-m", "feat(land): selected hunks [test]", "--apply", "--yes"], patchHold(), {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status).toBe(0);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; owner: string; paths: string[];
		base: string; localMain: string; check: { status: string; sha256: string; checked_sha: string; pushed_sha: string };
		convergence: { state: string; reason: string | null; applied: boolean; pushed: boolean; published_commits: number; remote_after: string };
		phases: { construction: string; publication: string; observed_publication_head: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(fresh);
	expect(data.localMain).toBe(base);
	expect([...data.paths].sort()).toEqual(["feature/added.txt", "service.txt"]);
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.commit);
	expect(data.check.pushed_sha).toBe(data.commit);
	expect(data.convergence.state).toBe("FAST_FORWARD");
	expect(data.convergence.reason).toBeNull();
	expect(data.convergence.applied).toBe(false);
	expect(data.convergence.pushed).toBe(true);
	expect(data.convergence.published_commits).toBe(1);
	expect(data.convergence.remote_after).toBe(data.commit);
	expect(data.phases.construction).toBe("APPLIED");
	expect(data.phases.publication).toBe("APPLIED");
	expect(data.phases.observed_publication_head).toBe(data.commit);
	expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(fresh);
	expect(remoteHead(work)).toBe(data.commit);
	expect(git(work, ["diff", "--name-only", fresh, data.commit]).trim().split("\n").sort()).toEqual(["feature/added.txt", "service.txt"]);
	expect(git(work, ["show", `${data.commit}:service.txt`])).toBe(EXPECTED_SERVICE);
	expect(git(work, ["show", `${data.commit}:feature/added.txt`])).toBe("caller added file\n");
	expect(readFileSync(setup.checkContent, "utf8")).toBe(EXPECTED_SERVICE);
	expect(readFileSync(setup.checkAdded, "utf8")).toBe("caller added file\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(git(work, ["rev-parse", ":peer.txt"]).trim()).toBe(stagedOid);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("staged peer bytes\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("unstaged worktree bytes\n");
	expect(readFileSync(join(work, "service.txt"), "utf8")).toBe(SERVICE_BASE);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("refuses a patch whose exact full suite is red before origin advances", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, bare, base, patch } = setup;
	const caller = join(scratch, `full-suite-caller-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", bare, caller]);
	git(caller, ["config", "user.name", "caller"]);
	git(caller, ["config", "user.email", "caller@example.invalid"]);
	writeFileSync(join(caller, "suite-contract.txt"), "FAIL\n");
	git(caller, ["add", "suite-contract.txt"]);
	git(caller, ["commit", "-m", "break declared suite [test]"]);
	writeFileSync(patch, `${readFileSync(patch, "utf8")}${git(caller, ["diff", base, "HEAD"])}`);
	const hold = [
		...patchHold(),
		{ agent: "DarkFern", path: "suite-contract.txt", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, ["--patch", patch, "--message", "feat(land): reject failing full suite [test]", "--apply", "--yes"], hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_FULL_SUITE_FAILED");
	expect(remoteHead(work)).toBe(base);
	const data = run.body.data;
	if (data === null || typeof data !== "object" || !("commit" in data) || typeof data.commit !== "string")
		throw new Error("land patch refusal omitted its constructed candidate commit");
	const candidate = data.commit;
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const verdictPath = join(work, ".git", "omp-kit", "full-suite-verdicts", `${tree}.json`);
	expect(JSON.parse(readFileSync(verdictPath, "utf8"))).toMatchObject({
		tree, verdict: "FAIL", evidence: { complete: true },
	});
});

test("refuses a true three-way conflict naming the file and hunks", () => {
	const setup = hunkSetup("conflict");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	expect(originBefore).not.toBe(base);
	const refsBefore = git(work, ["for-each-ref", "refs/heads"]);
	const treesBefore = git(work, ["worktree", "list", "--porcelain"]);
	const statusBefore = git(work, ["status", "--porcelain"]);
	const run = command(work, ["--patch", patch, "--message", "feat(land): conflicting selection [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("PATCH_CONFLICT");
	const data = run.body.data as { overall: string; commit: null; base: string; check: { status: string }; phases: { construction: string; publication: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.commit).toBeNull();
	expect("candidate_sha" in data).toBe(false);
	expect(data.base).toBe(originBefore);
	expect(data.check.status).toBe("UNRUN");
	expect(data.phases.construction).toBe("NOT_APPLIED");
	expect(data.phases.publication).toBe("UNKNOWN");
	const message = (run.body.errors as { message: string }[])[0]?.message ?? "";
	expect(message).toContain("service.txt");
	expect(message).toContain("@@");
	expect(remoteHead(work)).toBe(originBefore);
	// Patch mode fetches fresh origin/main by design, so only local branches must be untouched.
	expect(git(work, ["for-each-ref", "refs/heads"])).toBe(refsBefore);
	expect(git(work, ["rev-parse", "refs/remotes/origin/main"]).trim()).toBe(originBefore);
	expect(git(work, ["worktree", "list", "--porcelain"])).toBe(treesBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("refuses origin movement during construction without publishing", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, bare, base, patch } = setup;
	const writer = join(scratch, `writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", bare, writer]);
	git(writer, ["config", "user.name", "writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "concurrent remote change\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "competing writer [test]"]);
	const writerSha = git(writer, ["rev-parse", "HEAD"]).trim();
	const commitMsg = join(work, ".git", "hooks", "commit-msg");
	// The reconstruction commit runs in a linked scratch worktree, whose absolute
	// GIT_DIR would otherwise capture the nested push into the wrong repository.
	writeFileSync(commitMsg, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE\ngit -C '${writer}' push origin HEAD:refs/heads/main\nexit 0\n`);
	chmodSync(commitMsg, 0o755);
	const attempts = join(scratch, `patch-push-attempts-${fixtureNumber}.txt`);
	const prePush = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePush, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 0\n`);
	chmodSync(prePush, 0o755);
	const statusBefore = git(work, ["status", "--porcelain"]);
	const run = command(work, ["--patch", patch, "--message", "feat(land): moved origin [test]", "--apply", "--yes"], patchHold(), {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_ORIGIN_MOVED");
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null; base: string;
		check: { status: string; checked_sha: string; pushed_sha: null }; phases: { publication: string };
		convergence: { state: string; reason: string | null; pushed: boolean; remote_after: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.base).toBe(base);
	expect(data.candidate_sha).toBe(data.commit);
	expect(data.pushed_sha).toBeNull();
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(data.phases.publication).toBe("NOT_APPLIED");
	expect(data.convergence.state).toBe("REFUSED");
	expect(data.convergence.reason).toBe("ORIGIN_MOVED");
	expect(data.convergence.pushed).toBe(false);
	expect(data.convergence.remote_after).toBe(writerSha);
	expect(remoteHead(work)).toBe(writerSha);
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(existsSync(attempts)).toBe(false);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("refuses a patch naming a path outside the owner reservation", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	const hold = [{ agent: "DarkFern", path: "peer.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--patch", patch, "--message", "feat(land): uncovered selection [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	const errors = run.body.errors as { message: string }[];
	expect(errors[0]?.message ?? "").toContain("service.txt");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("refuses worktree paths combined with a patch file", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	const run = command(work, ["--paths", "service.txt", "--patch", patch, "--message", "feat(land): mixed modes [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATCH_EXCLUSIVE");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

/** Actual-parent publication qualification (ompkit-rhy9.10): the candidate is
 * qualified against its real construction parent, never a dispatch seed. */
import { qualifyPublicationCandidate } from "../../src/land.ts";

function actualParentSetup(): { work: string; fakeBin: string; seed: string; parent: string } {
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

test("publishes only the approved owned delta parented on the actual parent", () => {
	const { work, fakeBin, parent } = actualParentSetup();
	writeFileSync(join(work, "owned.txt"), "actual parent bytes plus approved delta\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; owner: string;
		paths: string[]; base: string; localMain: string;
		phases: { candidate_sha: string; actual_parents: string[]; publication_ref: string; construction: string; publication: string };
	};
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(parent);
	expect(data.owner).toBe("DarkFern");
	expect(data.candidate_sha).toBe(data.commit);
	expect(data.pushed_sha).toBe(data.commit);
	expect(data.localMain).toBe(data.commit);
	// The candidate is parented on exactly the actual publication parent.
	expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(parent);
	expect(data.phases.actual_parents).toEqual([parent]);
	expect(data.phases.publication_ref).toBe("refs/heads/main");
	expect(data.phases.construction).toBe("APPLIED");
	expect(data.phases.publication).toBe("APPLIED");
	// The candidate publishes ONLY the approved owned delta.
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", data.commit]).trim()).toBe("owned.txt");
	// Nonauthor native observer: real tree/ref/index/worktree postimages.
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("actual parent bytes plus approved delta\n");
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(data.commit);
	expect(git(work, ["rev-parse", ":owned.txt"]).trim()).toBe(git(work, ["rev-parse", `${data.commit}:owned.txt`]).trim());
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("actual parent bytes plus approved delta\n");
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer baseline\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("untouched baseline\n");
	expect(remoteHead(work)).toBe(data.commit);
});

test("refuses a caller patch restoring bytes the actual parent superseded", () => {
	const { work, fakeBin, seed, parent } = actualParentSetup();
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const caller = join(scratch, `stale-caller-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, caller]);
	git(caller, ["config", "user.name", "stale caller"]);
	git(caller, ["config", "user.email", "stale-caller@example.invalid"]);
	// The caller selection restores the seed bytes onto the actual parent.
	writeFileSync(join(caller, "owned.txt"), "base owned\n");
	git(caller, ["add", "--", "owned.txt"]);
	git(caller, ["commit", "-m", "stale restore [test]"]);
	const patch = join(scratch, `stale-restore-${fixtureNumber}.patch`);
	writeFileSync(patch, git(caller, ["diff", parent, "HEAD"]));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const localBefore = git(work, ["rev-parse", "HEAD"]).trim();
	const run = command(work, ["--patch", patch, "--message", "feat(land): stale restore [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_STALE_RESTORE");
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null;
		phases: { candidate_sha: string; actual_parents: string[]; publication_ref: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.pushed_sha).toBeNull();
	// The refused candidate really was parented on the actual parent with stale bytes.
	expect(git(work, ["show", "-s", "--format=%P", data.candidate_sha]).trim()).toBe(parent);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("base owned\n");
	expect(data.phases.actual_parents).toEqual([parent]);
	expect(data.phases.publication_ref).toBe("refs/heads/main");
	// Zero publication: the seed bytes never reach origin and local refs never move.
	expect(remoteHead(work)).toBe(parent);
	expect(git(work, ["show", `${parent}:owned.txt`])).toBe("actual parent bytes\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(localBefore);
	expect(seed).not.toBe(parent);
});

test("refuses when the publication parent advances before publication", () => {
	const { work, fakeBin, parent } = actualParentSetup();
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const peerDir = join(scratch, `race-peer-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, peerDir]);
	git(peerDir, ["config", "user.name", "race peer"]);
	git(peerDir, ["config", "user.email", "race-peer@example.invalid"]);
	// B3 advances the same owned path, so no silent merge can absorb it.
	writeFileSync(join(peerDir, "owned.txt"), "peer raced publication\n");
	git(peerDir, ["add", "--", "owned.txt"]);
	git(peerDir, ["commit", "-m", "race advance [test]"]);
	const raced = git(peerDir, ["rev-parse", "HEAD"]).trim();
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit -C '${peerDir}' push origin main\n`);
	chmodSync(postCommit, 0o755);
	writeFileSync(join(work, "owned.txt"), "approved delta raced by peer\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null; base: string;
		convergence: { reason: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.base).toBe(parent);
	expect(data.pushed_sha).toBeNull();
	// The saved candidate is preserved parented on B2, but origin holds B3: zero publication.
	expect(git(work, ["show", "-s", "--format=%P", data.candidate_sha]).trim()).toBe(parent);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("approved delta raced by peer\n");
	expect(remoteHead(work)).toBe(raced);
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["show", `${raced}:owned.txt`])).toBe("peer raced publication\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
});

test("refuses when live custody lapses between save and publication", () => {
	const { work } = fixture();
	const base = remoteHead(work);
	const holdsFile = join(scratch, `custody-holds-${fixtureNumber++}.json`);
	const currentHolds = JSON.stringify({ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 });
	const attestation = `"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}`;
	writeFileSync(holdsFile, `{"my_reservations":[${currentHolds}],${attestation}}`);
	const expiredHolds = JSON.stringify({ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 0 });
	const statefulBin = join(scratch, `stateful-am-${fixtureNumber}`);
	mkdirSync(statefulBin);
	writeFileSync(join(statefulBin, "am"), String.raw`#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") printf '{"agent_name":"DarkFern"}\n' ;;
  "robot reservations") cat "$FAKE_HOLDS_FILE" ;;
  *) exit 2 ;;
esac
`);
	chmodSync(join(statefulBin, "am"), 0o755);
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nprintf '{"my_reservations":[%s],%s}' '${expiredHolds}' '${attestation}' > "$FAKE_HOLDS_FILE"\n`);
	chmodSync(postCommit, 0o755);
	writeFileSync(join(work, "owned.txt"), "owned save with lapsing custody\n");
	const run = command(work, landArgs("owned.txt"), [], { amDir: statefulBin, gitEnv: { FAKE_HOLDS_FILE: holdsFile } });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_CUSTODY_EXPIRED");
	expectLandSchema(run.body.data);
	const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: null };
	expect(data.overall).toBe("REFUSED");
	expect(data.pushed_sha).toBeNull();
	// The save is real and kept, but nothing was published after custody lapsed.
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("owned save with lapsing custody\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
	expect(remoteHead(work)).toBe(base);
});

test("the actual-parent guard names its ref and reads real parents", () => {
	const { work } = fixture();
	const base = git(work, ["rev-parse", "HEAD"]).trim();
	const unnamed = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "", qualifiedBlobs: {},
	});
	expect("refusal" in unnamed && unnamed.refusal.errors?.[0]?.code).toBe("LAND_PUBLICATION_REF_UNNAMED");
	const foreign = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/feature", qualifiedBlobs: {},
	});
	expect("refusal" in foreign && foreign.refusal.errors?.[0]?.code).toBe("LAND_PUBLICATION_REF_UNSUPPORTED");
	const absent = qualifyPublicationCandidate(work, {
		candidate: "f".repeat(40), base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/main", qualifiedBlobs: {},
	});
	expect("refusal" in absent && absent.refusal.errors?.[0]?.code).toBe("LAND_ACTUAL_PARENT_UNREADABLE");
	// The root fixture commit has no parent at all, so it can never qualify against itself as base.
	const mismatch = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/main", qualifiedBlobs: {},
	});
	expect("refusal" in mismatch && mismatch.refusal.errors?.[0]?.code).toBe("LAND_ACTUAL_PARENT_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("doctor reports the land guard identities and decision", () => {
	const { work, fakeBin } = fixture();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--scope", "land"], hold, { amDir: fakeBin, subcommand: "doctor" });
	const data: unknown = run.body.data;
	const findings: unknown = data !== null && typeof data === "object" && "findings" in data ? data.findings : undefined;
	expect(Array.isArray(findings)).toBe(true);
	const land = (Array.isArray(findings) ? findings : []).find((entry): entry is { component: unknown; status: unknown; reason: unknown; evidence: unknown } =>
		typeof entry === "object" && entry !== null && "component" in entry && entry.component === "land");
	expect(land?.status).toBe("OK");
	const evidence: unknown = land !== undefined && typeof land.evidence === "object" && land.evidence !== null ? land.evidence : undefined;
	expect(evidence).toMatchObject({
		guard: "actual-parent-custody-v1",
		publication_ref: "refs/heads/main",
		owner: "DarkFern",
		owner_capability: "verified-current",
		actual_parent_capability: "native-git",
		decision: "READY",
	});
	expect(typeof land?.reason).toBe("string");
});
