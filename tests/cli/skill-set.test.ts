import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { runCapabilitiesCheck, runContextInventory } from "../../src/context.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let release = "";
let environment: Record<string, string>;

const SKILL = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body.\n`;

const SESSION = (id: string, lines: string[]): string =>
	[`{"type":"session","version":3,"id":"${id}","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`, ...lines].join("\n") + "\n";

function sessionRow(id: string, role: string, text: string): string {
	return JSON.stringify({ type: "message", id, timestamp: "2026-09-30T10:01:00.000Z",
		message: { role, content: [{ type: "text", text }] } });
}

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = mkdtempSync(join(tmpdir(), "omp-kit-skill-set-"));
	release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	const agentSkills = join(home, ".omp", "agent", "skills");
	const otherSessions = join(home, ".omp", "profiles", "other", "agent", "sessions", "proj");
	const otherSkills = join(home, ".omp", "profiles", "other", "agent", "skills");
	for (const directory of [join(release, "bin"), join(release, "scripts"), agentSkills, otherSessions, otherSkills,
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
	for (const name of ["alpha", "gamma", "delta"]) {
		const dir = join(agentSkills, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), SKILL(name, `${name} fixture skill`));
	}
	const epsilonDir = join(otherSkills, "epsilon");
	mkdirSync(epsilonDir, { recursive: true });
	writeFileSync(join(epsilonDir, "SKILL.md"), SKILL("epsilon", "other-profile fixture skill"));
	const sessions = join(home, ".omp", "agent", "sessions", "proj");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "s1.jsonl"), SESSION("s1", [
		sessionRow("m1", "user", "check this with /skill:gamma please"),
		sessionRow("m2", "assistant", "reading skill://alpha now"),
		sessionRow("m3", "toolResult", "read skill://alpha complete"),
	]));
	const stale = join(sessions, "stale.jsonl");
	writeFileSync(stale, SESSION("stale", [sessionRow("m9", "assistant", "reading skill://zeta now")]));
	utimesSync(stale, (Date.now() - 30 * 86400 * 1000) / 1000, (Date.now() - 30 * 86400 * 1000) / 1000);
	writeFileSync(join(otherSessions, "s2.jsonl"), SESSION("s2", [
		sessionRow("m1", "assistant", "reading skill://epsilon now"),
	]));
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

function runCli(args: string[]): { exitCode: number; envelope: Record<string, unknown> } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as Record<string, unknown> };
}

test("skill-set derives the exact usage candidate and renders a measured recipe", () => {
	const { exitCode, envelope } = runCli(["examples", "skill-set", "--from-history", "7", "--json"]);
	expect(exitCode).toBe(0);
	const data = envelope.data as { overall?: string; skill_set?: {
		candidate_skills?: string[]; reads?: Record<string, number>; explicit?: Record<string, number>;
		bytes_before?: number; bytes_after?: number; listed_before?: number; listed_after?: number;
		capability_check?: { overall?: string; missing?: number }; recipe?: string;
		history?: { files_scanned?: number; files_skipped_window?: number };
	} };
	expect(data.overall).toBe("OK");
	const set = data.skill_set;
	expect(set?.candidate_skills).toEqual(["alpha", "gamma"]);
	expect(set?.reads).toMatchObject({ alpha: 2 });
	expect(set?.explicit).toMatchObject({ gamma: 1 });
	expect(set?.history?.files_skipped_window).toBe(1);
	expect(set?.listed_before).toBe(3);
	expect(set?.listed_after).toBe(2);
	expect(set?.bytes_after).toBeLessThan(set?.bytes_before ?? 0);
	expect(set?.capability_check?.overall).toBe("PASS");
	expect(set?.capability_check?.missing).toBe(0);
	expect(set?.recipe).toContain("includeSkills:");
	expect(set?.recipe).toContain("- alpha");
}, 300_000);

test("skill-set reads only the selected profile history", () => {
	const { exitCode, envelope } = runCli(["examples", "skill-set", "--from-history", "7", "--profile", "other", "--json"]);
	expect(exitCode).toBe(0);
	const set = (envelope.data as { skill_set?: { candidate_skills?: string[] } }).skill_set;
	expect(set?.candidate_skills).toEqual(["epsilon"]);
}, 300_000);

test("SKILL_SET_GATE: a required capability outside the candidate set exits 1 naming it", async () => {
	const caps = join(base, "caps-gate.json");
	writeFileSync(caps, JSON.stringify({ schema_version: 1, skills: ["alpha", "gamma", "delta"] }));
	const report = await runCapabilitiesCheck({ root: release, executablePath: binary, home,
		profile: "default", project: home, overrides: { includeSkills: ["alpha", "gamma"] }, capabilitiesPath: caps });
	expect(report.overall).toBe("FAIL");
	const delta = report.capabilities.find(item => item.name === "delta");
	expect(delta?.status).toBe("MISSING");
	const bogus = join(base, "caps-bogus.json");
	writeFileSync(bogus, JSON.stringify({ schema_version: 1, skills: ["bogus-skill"] }));
	const { exitCode, envelope } = runCli(["test", "--capabilities", bogus, "--project", home, "--json"]);
	expect(exitCode).toBe(1);
	expect((envelope.data as { overall?: string }).overall).toBe("FAIL");
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code).toBe("CAPABILITY_MISSING");
}, 300_000);

test("skill-set bytes-after is loader-measured, not estimated", async () => {
	const direct = await runContextInventory({ root: release, executablePath: binary, home,
		profile: "default", project: home, overrides: { includeSkills: ["alpha", "gamma"] } });
	const { envelope } = runCli(["examples", "skill-set", "--from-history", "7", "--json"]);
	const set = (envelope.data as { skill_set?: { bytes_after?: number; listed_after?: number } }).skill_set;
	expect(set?.bytes_after).toBe(direct.skills.listed_bytes);
	expect(set?.listed_after).toBe(direct.skills.listed);
}, 300_000);

test("skill-set refuses a bad window", () => {
	const { exitCode, envelope } = runCli(["examples", "skill-set", "--from-history", "0", "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code).toBe("INVALID_HISTORY_WINDOW");
}, 120_000);
