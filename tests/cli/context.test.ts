import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { ensureOmpSource } from "../../src/omp-source-cache.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { writeBundledHarness } from "./release-manifest-fixture.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
function certifiedOmpVersion(): string {
	const value: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/omp-compat.json"), "utf8"));
	if (!value || typeof value !== "object" || !("certified" in value) || typeof value.certified !== "string") {
		throw new Error("scripts/omp-compat.json must contain a certified OMP version");
	}
	return value.certified;
}
const OMP_VERSION = certifiedOmpVersion();

let base = "";
let binary = "";
let home = "";
let project = "";
let tsProject = "";
let environment: Record<string, string>;

const SKILL_ALPHA = `---\nname: alpha\ndescription: Alpha fixture skill for the context check.\n---\n\nAlpha body.\n`;
const SKILL_HIDDEN = `---\nname: beta-hidden\ndescription: Hidden fixture skill for the context check.\nhide: true\n---\n\nBeta body.\n`;
const SKILL_GAMMA = `---\nname: gamma\ndescription: Named-profile fixture skill.\n---\n\nGamma body.\n`;
const RULE_FIXTURE = `---\ncondition: CTX_PROBE_FIRE\nscope: tool:bash\ninterruptMode: never\n---\nProbe rule.\n`;

function writeSkill(root: string, dir: string, name: string, body: string): void {
	const skillDir = join(root, dir, `${name}`);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), body);
}

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "omp-kit-context-"));
	home = join(base, "home");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(base, "tmp"), { recursive: true });
	const toolBin = join(base, "tools");
	mkdirSync(toolBin, { recursive: true });
	symlinkSync(process.execPath, join(toolBin, "bun"));
	const tsServer = join(toolBin, "typescript-language-server");
	writeFileSync(tsServer, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'typescript-language-server 0.0.0-test\\n'; exit 0; fi\nexit 64\n");
	chmodSync(tsServer, 0o755);
	const sourceCache = join(tmpdir(), `omp-kit-context-omp-source-${process.pid}`);
	const ompPackage = ensureOmpSource(OMP_VERSION, {
		HOME: home, TMPDIR: join(base, "tmp"), PATH: `${toolBin}:/usr/bin:/bin`,
		OMP_KIT_OMP_SRC_CACHE: sourceCache,
	});
	const ompDir = join(dirname(dirname(ompPackage)), ".bin");
	const omp = resolveOmpIdentity({
		PATH: `${ompDir}:${toolBin}:/usr/bin:/bin`, HOME: home, BUN_INSTALL: join(base, "no-bun"),
		OMP_KIT_OMP_SRC_CACHE: sourceCache, OMP_KIT_OMP_SRC_FETCH: "0",
	});
	const release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	project = join(base, "project");
	tsProject = join(base, "tsproject");
	const profileAgent = join(home, ".omp", "profiles", "ctxprobe", "agent");
	for (const directory of [join(release, "bin"), join(release, "scripts"), project, tsProject,
		join(project, ".git"), join(tsProject, ".git"),
		join(home, ".omp", "agent", "rules"), profileAgent,
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
	for (const file of ["rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	writeBundledHarness(release);
	writeSkill(home, join(".omp", "agent", "skills"), "alpha", SKILL_ALPHA);
	writeSkill(home, join(".omp", "agent", "skills"), "beta-hidden", SKILL_HIDDEN);
	writeFileSync(join(home, ".omp", "agent", "rules", "ctx-probe-rule.md"), RULE_FIXTURE);
	writeSkill(home, join(".omp", "profiles", "ctxprobe", "agent", "skills"), "gamma", SKILL_GAMMA);
	writeFileSync(join(project, "notes.txt"), "context probe project\n");
	writeFileSync(join(tsProject, "package.json"), '{"name": "ctx-probe-ts"}\n');
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
		PATH: `${ompDir}:${toolBin}:/usr/bin:/bin`, BUN_INSTALL: join(base, "no-bun"),
		OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
		OMP_KIT_OMP_SRC_CACHE: sourceCache, OMP_KIT_OMP_SRC_FETCH: "0",
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

type Envelope = {
	data?: {
		overall?: string;
		findings?: { component?: string; status?: string; reason?: string; evidence?: Record<string, unknown> }[];
		capabilities?: { overall?: string; missing?: number; capabilities?: { kind?: string; name?: string; status?: string }[] };
	};
	errors?: { code?: string }[];
};

function runCli(args: string[], extraEnv: Record<string, string> = {}): { exitCode: number; envelope: Envelope } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: project, env: { ...environment, ...extraEnv }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as Envelope };
}

function capabilitiesFile(name: string, content: unknown): string {
	const path = join(base, name);
	writeFileSync(path, JSON.stringify(content));
	return path;
}

test("doctor --scope context reports exact listing costs through OMP loaders", () => {
	const { exitCode, envelope } = runCli(["doctor", "--scope", "context", "--project", project, "--json"]);
	expect(exitCode).toBe(0);
	const finding = (envelope.data?.findings ?? []).find(item => item.component === "context");
	expect(finding?.status).toBe("OK");
	const evidence = finding?.evidence as {
		profile_source?: string; skills?: { active?: number; listed?: number; listed_bytes?: number; hidden?: number; hidden_names?: string[] };
		context_files?: { count?: number }; rules?: { count?: number; rows?: { name?: string; bytes?: number | null }[] };
		tools?: { builtin?: number }; knobs?: { ignoredSkills?: string[] };
	};
	expect(evidence.profile_source).toBe("DEFAULT_ON_DISK");
	expect(evidence.skills?.active).toBe(2);
	expect(evidence.skills?.listed).toBe(1);
	expect(evidence.skills?.hidden).toBe(1);
	expect(evidence.skills?.hidden_names).toEqual(["beta-hidden"]);
	expect(evidence.skills?.listed_bytes).toBeGreaterThan(10);
	expect(evidence.context_files?.count).toBe(0);
	const probe = (evidence.rules?.rows ?? []).find(row => row.name === "ctx-probe-rule");
	expect(probe?.bytes).toBe(RULE_FIXTURE.length);
	expect(evidence.tools?.builtin).toBeGreaterThan(20);
	expect(evidence.knobs?.ignoredSkills).toEqual([]);
}, 120_000);

test("doctor --scope context inspects a named profile without touching the default", () => {
	const { exitCode, envelope } = runCli(["doctor", "--scope", "context", "--profile", "ctxprobe", "--project", project, "--json"],
		{ OMP_PROFILE: "ctxprobe" });
	expect(exitCode).toBe(0);
	const finding = (envelope.data?.findings ?? []).find(item => item.component === "context");
	const evidence = finding?.evidence as { profile_selected?: string; profile_source?: string; skills?: { rows?: { name?: string }[] } };
	expect(evidence.profile_selected).toBe("ctxprobe");
	expect(evidence.profile_source).toBe("NAMED_ON_DISK");
	expect((evidence.skills?.rows ?? []).map(row => row.name)).toContain("gamma");
}, 120_000);

test("test --capabilities passes a fully resolved set", () => {
	const path = capabilitiesFile("caps-pass.json", { schema_version: 1,
		skills: ["alpha", "beta-hidden"], tools: ["bash"], rules: ["ctx-probe-rule"], lsp: ["typescript"] });
	const { exitCode, envelope } = runCli(["test", "--capabilities", path, "--project", tsProject, "--json"]);
	expect(exitCode).toBe(0);
	expect(envelope.data?.overall).toBe("PASS");
	const verdicts = envelope.data?.capabilities?.capabilities ?? [];
	expect(verdicts.find(item => item.name === "alpha")?.status).toBe("RESOLVED");
	expect(verdicts.find(item => item.name === "beta-hidden")?.status).toBe("HIDDEN_BUT_READABLE");
	expect(verdicts.find(item => item.name === "bash")?.status).toBe("RESOLVED");
	expect(verdicts.find(item => item.name === "ctx-probe-rule")?.status).toBe("RESOLVED");
	expect(verdicts.find(item => item.name === "typescript")?.status).toBe("RESOLVED");
}, 120_000);

test("IGNORED_SKILL_PLANTED: ignoredSkills drops a required skill to MISSING", () => {
	writeFileSync(join(home, ".omp", "agent", "config.yml"), "skills:\n  ignoredSkills:\n    - alpha\n");
	const path = capabilitiesFile("caps-ignored.json", { schema_version: 1, skills: ["alpha", "beta-hidden"] });
	const { exitCode, envelope } = runCli(["test", "--capabilities", path, "--project", project, "--json"]);
	expect(exitCode).toBe(1);
	expect(envelope.data?.overall).toBe("FAIL");
	expect(envelope.errors?.[0]?.code).toBe("CAPABILITY_MISSING");
	const verdicts = envelope.data?.capabilities?.capabilities ?? [];
	expect(verdicts.find(item => item.name === "alpha")?.status).toBe("MISSING");
	expect(verdicts.find(item => item.name === "beta-hidden")?.status).toBe("HIDDEN_BUT_READABLE");
	rmSync(join(home, ".omp", "agent", "config.yml"), { force: true });
}, 120_000);

test("test --capabilities refuses an unknown field and conflicting flags", () => {
	const bad = capabilitiesFile("caps-bad.json", { schema_version: 1, skills: [], session_transcript: "no" });
	const refused = runCli(["test", "--capabilities", bad, "--project", project, "--json"]);
	expect(refused.exitCode).toBe(2);
	expect(refused.envelope.errors?.[0]?.code).toBe("INVALID_CAPABILITIES");
	const conflict = runCli(["test", "--capabilities", bad, "--full", "--json"]);
	expect(conflict.exitCode).toBe(2);
	expect(conflict.envelope.errors?.[0]?.code).toBe("CONFLICTING_FLAGS");
}, 120_000);

test("doctor --scope context refuses --file", () => {
	const { exitCode, envelope } = runCli(["doctor", "--scope", "context", "--file", "x.ts", "--json"]);
	expect(exitCode).toBe(2);
	expect(envelope.errors?.[0]?.code).toBe("INVALID_FLAG");
}, 120_000);
