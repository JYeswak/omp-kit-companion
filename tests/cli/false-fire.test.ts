import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const APPROVED_FIELDS = ["rule", "expect", "source", "tool", "path", "snippet"] as const;
const STABLE_HASH_FIELDS = [
	"omp_launcher_sha256", "omp_package_sha256", "matcher_sha256", "omp_rule_parser_sha256", "native_sha256",
	"harness_runtime_sha256", "kit_harness_sha256", "policy_sha256", "rule_loader_sha256", "rule_sha256",
] as const;
let base = "";
let binary = "";
let unrelatedCwd = "";
let environment: Record<string, string>;

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = mkdtempSync(join(tmpdir(), "omp-kit-false-fire-"));
	const release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	unrelatedCwd = join(base, "unrelated-project");
	const home = join(base, "isolated-home");
	for (const directory of [join(release, "bin"), join(release, "scripts"), unrelatedCwd, home,
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "scripts/ttsr-harness.ts", "scripts/rule-class.ts"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
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
}, 60_000);
type FalseFireEnvelope = {
	data?: {
		overall?: string;
		replay_fixture?: Record<string, unknown>;
		test?: { status?: string; scope?: string; counts?: { cases?: number } };
		live?: { status?: string; snapshots?: { unchanged?: boolean } };
	};
	errors?: { code?: string }[];
};

function runCli(args: string[]) {
	const child = Bun.spawnSync([binary, ...args], { cwd: unrelatedCwd, env: environment, stdout: "pipe", stderr: "pipe" });
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${stderr}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as FalseFireEnvelope, stdout, stderr };
}

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

test("LOST_FALSE_FIRE: relocated CLI reduces and replays named G2/G3 fires while refusing a miss", () => {
	const rules = join(base, "public-synthetic-rules");
	mkdirSync(rules, { recursive: true });
	const rule = "public-synthetic-false-fire";
	const ruleFile = join(rules, `${rule}.md`);
	const ruleMarkdown = [
		"---", "condition:", "  - 'PUBLIC DANGER'", "scope:", "  - text", "interruptMode: never", "---",
		"Synthetic-only regression rule.", "",
	].join("\n");
	writeFileSync(ruleFile, ruleMarkdown);
	const prefix = "PUBLIC WRAPPER START: benign test context";
	const suffix = "PUBLIC WRAPPER END: benign test context";
	const seedSnippet = [prefix, "BENIGN SYNTHETIC FILLER ALPHA", "PUBLIC DANGER", "BENIGN SYNTHETIC FILLER OMEGA", suffix].join("\n");
	const fixture = join(base, "false-fire-v1.json");
	const fixtureInput = {
		schema_version: 1,
		classification: "public-synthetic",
		approved_fields: APPROVED_FIELDS,
		witness: { rule, expect: "quiet", source: "text", tool: "-", path: "-", snippet: seedSnippet },
		preserve: { prefix, suffix },
		predicate: "G2",
	};
	writeFileSync(fixture, JSON.stringify(fixtureInput, null, 2));

	const reduction = runCli(["review", "reduce", "--rules", rules, "--fixture", fixture, "--json"]);
	expect(reduction.exitCode).toBe(0);
	expect(reduction.envelope.data?.overall).toBe("REDUCED");
	const reducedFixture = reduction.envelope.data?.replay_fixture as {
		schema_version?: number; classification?: string; approved_fields?: string[];
		witness?: { rule?: string; expect?: string; source?: string; tool?: string; path?: string; snippet?: string };
		preserve?: { prefix?: string; suffix?: string }; predicate?: string;
		identity_pins?: Record<string, string>;
	};
	expect(reducedFixture).toMatchObject({
		schema_version: 1, classification: "public-synthetic", approved_fields: APPROVED_FIELDS,
		witness: { rule, expect: "quiet", source: "text", tool: "-", path: "-" },
		preserve: { prefix, suffix }, predicate: "G2",
	});
	expect(Object.keys(reducedFixture.witness ?? {}).sort()).toEqual([...APPROVED_FIELDS].sort());
	expect(reducedFixture.witness?.snippet?.startsWith(prefix)).toBe(true);
	expect(reducedFixture.witness?.snippet?.endsWith(suffix)).toBe(true);
	expect(reducedFixture.witness?.snippet).toContain("PUBLIC DANGER");
	expect(reducedFixture.witness?.snippet).not.toContain("FILLER");
	const hashes = reducedFixture.identity_pins ?? {};
	expect(hashes.cases_sha256).toBeUndefined();
	expect(Object.keys(hashes).sort()).toEqual([...STABLE_HASH_FIELDS].sort());
	expect(Object.values(hashes).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
	expect(JSON.stringify(reduction.envelope)).not.toContain(unrelatedCwd);
	expect(JSON.stringify(reduction.envelope)).not.toContain(base);
	expect(reduction.stderr).toBe("");
	const reorderedPath = join(base, "reordered-approved-fields.json");
	writeFileSync(reorderedPath, JSON.stringify({ ...fixtureInput, approved_fields: [...APPROVED_FIELDS].reverse() }));
	const reordered = runCli(["review", "reduce", "--rules", rules, "--fixture", reorderedPath, "--replay-only", "--json"]);
	expect(reordered.exitCode).toBe(0);
	expect(reordered.envelope.data?.overall).toBe("REPRODUCED");
	expect(reordered.envelope.data?.replay_fixture).toMatchObject({ approved_fields: APPROVED_FIELDS });
	const g3FixturePath = join(base, "false-fire-g3.json");
	writeFileSync(g3FixturePath, JSON.stringify({ ...fixtureInput, predicate: "G3" }));
	const g3 = runCli(["review", "reduce", "--rules", rules, "--fixture", g3FixturePath, "--json"]);
	expect(g3.exitCode).toBe(0);
	expect(g3.envelope.data?.overall).toBe("REDUCED");
	expect(g3.envelope.data?.replay_fixture).toMatchObject({ predicate: "G3", preserve: { prefix, suffix } });

	const replayPath = join(base, "reduced-replay.json");
	writeFileSync(replayPath, JSON.stringify(reducedFixture));
	const replay = runCli(["review", "reduce", "--rules", rules, "--fixture", replayPath, "--replay-only", "--json"]);
	expect(replay.exitCode).toBe(0);
	expect(replay.envelope.data?.overall).toBe("REPRODUCED");
	expect(replay.envelope.data?.replay_fixture).toMatchObject(reducedFixture);
	expect(JSON.stringify(replay.envelope)).not.toContain(base);
	expect(replay.stderr).toBe("");
	const changedPinPath = join(base, "changed-pin.json");
	writeFileSync(changedPinPath, JSON.stringify({
		...reducedFixture, identity_pins: { ...hashes, rule_sha256: "0".repeat(64) },
	}));
	const changedPin = runCli(["review", "reduce", "--rules", rules, "--fixture", changedPinPath, "--replay-only", "--json"]);
	expect(changedPin.exitCode).toBe(3);
	expect(changedPin.envelope.data?.overall).toBe("UNAVAILABLE");
	expect(changedPin.envelope.data?.replay_fixture).toBeNull();
	const partialPinPath = join(base, "partial-pin.json");
	writeFileSync(partialPinPath, JSON.stringify({ ...fixtureInput, identity_pins: { rule_sha256: hashes.rule_sha256 } }));
	const partialPin = runCli(["review", "reduce", "--rules", rules, "--fixture", partialPinPath, "--replay-only", "--json"]);
	expect(partialPin.exitCode).toBe(2);
	expect(partialPin.envelope.data?.replay_fixture).toBeUndefined();


	writeFileSync(ruleFile, ruleMarkdown.replace("PUBLIC DANGER", "PUBLIC NEVER MATCH"));
	const missed = runCli(["review", "reduce", "--rules", rules, "--fixture", fixture, "--replay-only", "--json"]);
	expect(missed.exitCode).toBe(1);
	expect(missed.envelope.data?.overall).toBe("NOT_REPRODUCED");
	expect(missed.envelope.data?.replay_fixture).toBeNull();

	const rejectedPath = join(base, "unknown-field.json");
	writeFileSync(rejectedPath, JSON.stringify({ ...fixtureInput, private_transcript: "must not appear" }));
	const rejected = runCli(["review", "reduce", "--rules", rules, "--fixture", rejectedPath, "--replay-only", "--json"]);
	expect(rejected.exitCode).toBe(2);
	expect(JSON.stringify(rejected.envelope)).not.toContain("private_transcript");
	expect(JSON.stringify(rejected.envelope)).not.toContain("must not appear");
	const invalidUtf8Path = join(base, "invalid-utf8.json");
	writeFileSync(invalidUtf8Path, new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
	const invalidUtf8 = runCli(["review", "reduce", "--rules", rules, "--fixture", invalidUtf8Path, "--replay-only", "--json"]);
	expect(invalidUtf8.exitCode).toBe(2);
	expect(JSON.stringify(invalidUtf8.envelope)).not.toContain("\\ufffd");
}, 60_000);
test("test --live-fixture routes to strict schema validation; plain and --full modes stay separate", () => {
	const rules = join(base, "external-live-rules");
	mkdirSync(rules, { recursive: true });
	writeFileSync(join(rules, "public-live-marker.md"),
		'---\ndescription: "Public synthetic live marker test"\ncondition: "PUBLIC_BLOCK_SAMPLE"\nscope: "tool:write"\ninterruptMode: always\n---\nBlock the public synthetic write.\n',
		{ flag: "wx", mode: 0o600 });
	const cases = join(base, "external-live-cases.tsv");
	writeFileSync(cases, [
		"rule\texpect\tsource\ttool\tpath\tsnippet\tnote",
		"public-live-marker\tfire\ttool\twrite\t.marker\tPUBLIC_BLOCK_SAMPLE\tblock witness",
		"public-live-marker\tquiet\ttool\twrite\t.marker\tPUBLIC_ALLOW_SAMPLE\tquiet witness",
		"",
	].join("\n"), { flag: "wx", mode: 0o600 });
	const fixture = join(base, "invalid-external-live-fixture.json");
	writeFileSync(fixture, JSON.stringify({ schema_version: 1, classification: "public-synthetic",
		rule: "public-live-marker", scenarios: [], command: "must not execute" }), { flag: "wx", mode: 0o600 });

	const live = runCli(["test", "--rules", rules, "--cases", cases, "--live-fixture", fixture, "--json"]);
	expect(live.exitCode).toBe(2);
	expect(live.envelope.errors?.[0]?.code).toBe("INVALID_EXTERNAL_LIVE_SCHEMA");
	expect(JSON.stringify(live.envelope)).not.toContain("must not execute");
	expect(live.stderr).toBe("");

	const plain = runCli(["test", "--rules", rules, "--cases", cases, "--json"]);
	expect(plain.exitCode).toBe(0);
	expect(plain.envelope.data?.overall).toBe("PASS");
	expect(plain.envelope.data?.test).toMatchObject({ status: "PASS", scope: "EXTERNAL_G1_G3" });
	expect(plain.envelope.data?.live).toBeUndefined();

	const fullRefusal = runCli(["test", "--rules", rules, "--cases", cases, "--live-fixture", fixture, "--full", "--json"]);
	expect(fullRefusal.exitCode).toBe(2);
	expect(fullRefusal.envelope.errors?.[0]?.code).toBe("CONFLICTING_FLAGS");
}, 60_000);
