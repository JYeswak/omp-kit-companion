import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let sessions = "";
let release = "";
let environment: Record<string, string>;

function toolCall(id: string, name: string, args: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, timestamp: "2026-09-30T10:01:00.000Z",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
}

function assistantText(id: string, text: string): string {
	return JSON.stringify({ type: "message", id, timestamp: "2026-09-30T10:01:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] } });
}

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = mkdtempSync(join(tmpdir(), "omp-kit-corpus-"));
	release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	sessions = join(base, "sessions");
	for (const directory of [join(release, "bin"), join(release, "scripts"), sessions,
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	writeFileSync(join(sessions, "s1.jsonl"), [
		`{"type":"title","v":1,"title":"fixture","updatedAt":"2026-09-30T10:00:00.000Z"}`,
		`{"type":"session","version":3,"id":"s1","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`,
		assistantText("t1", "fixture note"),
		toolCall("c1", "bash", { command: "echo zzzz_systemwide_canary_9c42" }),
		toolCall("c2", "bash", { command: "grep -rl 'x' crates/*/Cargo.toml 2>/dev/null" }),
		toolCall("c3", "bash", { command: "echo hello" }),
	].join("\n") + "\n");
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	chmodSync(binary, 0o755);
	environment = {
		HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: process.env.PATH ?? "/usr/bin:/bin", OMP: omp.launcher, OMP_BIN: omp.launcher,
		OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

type CorpusRule = { rule?: string; kind?: string; scanned?: number; fires?: number; rate?: number;
	ci_low?: number; ci_high?: number; upper_3n?: number | null };

function runCli(args: string[]): { exitCode: number; envelope: Record<string, unknown> } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as Record<string, unknown> };
}

function corpusOf(envelope: Record<string, unknown>): { overall?: string; corpus?: {
	files?: number; assistant_messages?: number; parse_errors?: number; versions?: string[];
	events?: Record<string, number>; rules?: CorpusRule[] } } {
	return envelope.data as { overall?: string; corpus?: {
		files?: number; assistant_messages?: number; parse_errors?: number; versions?: string[];
		events?: Record<string, number>; rules?: CorpusRule[] } };
}

function findRule(set: CorpusRule[] | undefined, rule: string, kind: string): CorpusRule {
	const row = (set ?? []).find(entry => entry.rule === rule && entry.kind === kind);
	if (!row) throw new Error(`missing corpus row ${rule}/${kind}`);
	return row;
}

test("corpus reports exact planted fire counts with Wilson intervals", () => {
	const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--json"]);
	expect(exitCode, JSON.stringify(envelope.errors)).toBe(0);
	const set = corpusOf(envelope);
	expect(set.overall).toBe("OK");
	expect(set.corpus?.files).toBe(1);
	expect(set.corpus?.assistant_messages).toBe(4);
	expect(set.corpus?.versions).toEqual(["v:1", "version:3"]);
	expect(set.corpus?.events).toMatchObject({ bash: 3, text: 1 });
	const canary = findRule(set.corpus?.rules, "zz-canary-scope-probe", "bash");
	expect(canary.scanned).toBe(3);
	expect(canary.fires).toBe(1);
	expect(canary.rate).toBeCloseTo(1 / 3, 6);
	expect(canary.ci_low).toBeCloseTo(0.0615, 3);
	expect(canary.ci_high).toBeCloseTo(0.7923, 3);
	expect(canary.upper_3n).toBeNull();
	const glob = findRule(set.corpus?.rules, "bash-glob-silenced", "bash");
	expect(glob.scanned).toBe(3);
	expect(glob.fires).toBe(1);
	const close = findRule(set.corpus?.rules, "kit-close-needs-evidence", "bash");
	expect(close.scanned).toBe(3);
	expect(close.fires).toBe(0);
	expect(close.rate).toBe(0);
	expect(close.upper_3n).toBeCloseTo(1, 6);
}, 300_000);

test("corpus redacts command text and writes only to the chosen path", () => {
	const before = new Set(readdirSync(sessions));
	const out = join(base, "corpus-report.json");
	const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--out", out, "--json"]);
	expect(exitCode, JSON.stringify(envelope.errors)).toBe(0);
	expect(JSON.parse(readFileSync(out, "utf8")).corpus.files).toBe(1);
	expect(JSON.stringify(envelope)).not.toContain("crates/*/Cargo.toml");
	expect(JSON.stringify(envelope)).not.toContain("sample_fire");
	expect(new Set(readdirSync(sessions))).toEqual(before);
}, 300_000);

test("corpus --plan prints the schema without reading anything", () => {
	const missing = join(base, "no-such-dir");
	const { exitCode, envelope } = runCli(["corpus", "--plan", "--sessions", missing, "--json"]);
	expect(exitCode).toBe(0);
	const plan = (envelope.data as { corpus_plan?: { reads?: string[]; accepted_versions?: string[]; refuses?: string } }).corpus_plan;
	expect(plan?.reads?.length).toBeGreaterThan(0);
	expect(plan?.accepted_versions).toContain("top-level numeric version 3 (session rows)");
	expect(plan?.refuses).toContain("unknown session schema version");
}, 120_000);

test("CORPUS_SCHEMA_PLANT: an unknown session schema version refuses with no counts", () => {
	const badDir = join(base, "bad-sessions");
	mkdirSync(badDir, { recursive: true });
	writeFileSync(join(badDir, "s9.jsonl"), [
		`{"type":"session","version":99,"id":"s9","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`,
		toolCall("c9", "bash", { command: "echo zzzz_systemwide_canary_9c42" }),
	].join("\n") + "\n");
	const { exitCode, envelope } = runCli(["corpus", "--sessions", badDir, "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code, JSON.stringify(envelope.errors)).toBe("UNKNOWN_SESSION_SCHEMA");
	expect(envelope.data).not.toHaveProperty("corpus");
}, 300_000);

test("corpus producer errors keep kit-relative module paths", () => {
	const harness = join(release, "scripts", "ttsr-harness.ts");
	const original = readFileSync(harness, "utf8");
	try {
		writeFileSync(harness, `await import(${JSON.stringify(join(release, "scripts", "missing-module.ts"))});\n`);
		const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--json"]);
		const error = (envelope.errors as { message?: string }[] | undefined)?.[0]?.message ?? "";
		expect(exitCode, JSON.stringify(envelope.errors)).toBe(2);
		expect(error).toContain("producer_rc=1");
		expect(error).toContain("./scripts/missing-module.ts");
		expect(error).toContain("./scripts/ttsr-harness.ts");
		expect(error).not.toContain(base);
	} finally {
		writeFileSync(harness, original);
	}
}, 300_000);

test("corpus refuses a relative sessions dir", () => {
	const { exitCode, envelope } = runCli(["corpus", "--sessions", "relative/path", "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code).toBe("INVALID_CORPUS_SELECTION");
}, 120_000);
