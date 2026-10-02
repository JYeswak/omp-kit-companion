import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");
const fixtures: string[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-kit-cli-"));
	fixtures.push(root);
	return root;
}

function installedOmp(root: string): string {
	const pkg = join(root, "omp", "releases", "v1");
	const bin = join(root, "omp", "bin");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	mkdirSync(join(pkg, "src", "export"), { recursive: true });
	mkdirSync(join(pkg, "src", "capability"), { recursive: true });
	mkdirSync(join(pkg, "src", "discovery"), { recursive: true });
	mkdirSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "1.2.3" }));
	writeFileSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	writeFileSync(join(pkg, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(pkg, "dist", "cli.js"), 0o755);
	for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) writeFileSync(join(pkg, "src", file), "export {};\n");
	symlinkSync(join(pkg, "dist", "cli.js"), join(bin, "omp"));
	return bin;
}
const MEMORY_SOURCE_FILES = [
	"src/memory-backend/redact.ts",
	"src/memory-backend/settings.ts",
	"src/memory-backend/resolve.ts",
	"src/config/settings.ts",
] as const;
function copyReviewedMemorySources(ompPackage: string): void {
	const launcher = process.env.OMP_MEMORY_SOURCE_PATH ?? process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
	if (!launcher) throw new Error("memory doctor fixture requires an installed OMP source package");
	const root = dirname(dirname(realpathSync(launcher)));
	for (const relative of MEMORY_SOURCE_FILES) {
		const target = join(ompPackage, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readFileSync(join(root, relative)));
	}
}

function run(args: string[], root: string, path = "/usr/bin:/bin") {
	const result = Bun.spawnSync([process.execPath, entry, ...args], {
		cwd: root,
		env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"), PATH: `${path}:/usr/bin:/bin`, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", NO_COLOR: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function robot(args: string[], root: string, path?: string) {
	const result = run(args, root, path);
	const data = JSON.parse(result.stdout);
	expect(result.stdout.trim().split("\n")).toHaveLength(1);
	return { ...result, data };
}

function snapshot(root: string, prefix = ""): string[] {
	return readdirSync(root).sort().flatMap((name) => {
		const path = join(root, name);
		const relative = join(prefix, name);
		const stat = lstatSync(path);
		const mode = (stat.mode & 0o777).toString(8);
		if (stat.isDirectory()) return [`${relative}:directory:${mode}`, ...snapshot(path, relative)];
		if (stat.isSymbolicLink()) return [`${relative}:symlink:${readlinkSync(path)}`];
		return [`${relative}:file:${mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
	});
}

function compiledDiagnosticFixture() {
	const base = realpathSync(workspace());
	const release = join(base, "release");
	const home = join(base, "home");
	const project = join(base, "project");
	const otherProject = join(base, "other-project");
	const binary = join(release, "bin", "omp-kit");
	const ompPackage = join(base, "omp", "releases", "v1");
	const ompBin = join(base, "omp", "bin");
	const launcherInvocation = join(base, "omp-launcher-invoked");
	const serverInvocation = join(base, "lsp-server-invoked");
	for (const dir of [
		ompBin, join(ompPackage, "dist"), join(ompPackage, "src", "export"),
		join(ompPackage, "src", "capability"), join(ompPackage, "src", "discovery"),
		join(ompPackage, "src", "lsp"), join(ompPackage, "src", "mcp"),
		join(ompPackage, "node_modules", "@oh-my-pi", "pi-natives"),
	]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.0" }));
	writeFileSync(join(ompPackage, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	for (const relative of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts", "discovery/builtin.ts", "mcp/config.ts"]) {
		writeFileSync(join(ompPackage, "src", relative), "export {};\n");
	}
	writeFileSync(join(ompPackage, "src", "lsp", "defaults.json"), JSON.stringify({
		"typescript-language-server": { command: "typescript-language-server", rootMarkers: ["package.json"], fileTypes: [".ts"] },
		marksman: { command: "marksman", rootMarkers: [".git"], fileTypes: [".md"] },
	}));
	const launcher = join(ompPackage, "dist", "cli.js");
	writeFileSync(launcher, `#!/bin/sh\nprintf 'invoked\\n' > ${JSON.stringify(launcherInvocation)}\nexit 97\n`);
	chmodSync(launcher, 0o755);
	symlinkSync(launcher, join(ompBin, "omp"));
	const languageServer = join(ompBin, "typescript-language-server");
	writeFileSync(languageServer, `#!/bin/sh\nprintf 'invoked\\n' > ${JSON.stringify(serverInvocation)}\nexit 98\n`);
	chmodSync(languageServer, 0o755);
	for (const dir of [release, join(release, "bin"), join(release, "rules"), join(release, "retired"), home, project, otherProject, join(home, ".omp")]) mkdirSync(dir, { recursive: true });
	mkdirSync(join(release, "examples", "profiles", "v1"), { recursive: true });
	for (const name of ["memory-off.yml", "mnemopi-manual.yml", "model-roles.yml"]) {
		writeFileSync(join(release, "examples", "profiles", "v1", name),
			readFileSync(join(import.meta.dir, "../../examples/profiles/v1", name)));
	}
	const rule = "# Rule A\n";
	writeFileSync(join(release, "rules", "rule-a.md"), rule);
	writeFileSync(join(release, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nrule-a\t${createHash("sha256").update(rule).digest("hex")}\ttripwire\tabc1234\n`);
	writeFileSync(join(home, ".omp", "settings.json"), "{\"opaque_user_profile\":true}\n");
	writeFileSync(join(project, "project.txt"), "project contents must not run\n");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", entry, "--outfile", binary], {
		cwd: base, stdout: "pipe", stderr: "pipe",
	});
	if (build.exitCode !== 0) throw new Error(`compiled diagnostic CLI failed: ${build.stderr.toString()}`);
	const realOmp = resolveOmpIdentity({ PATH: ompBin }).launcher;
	const invoke = (args: string[], envOverride: Record<string, string> = {}) => {
		const beforeHome = snapshot(home);
		const beforeProject = snapshot(project);
		const beforeOtherProject = snapshot(otherProject);
		const result = Bun.spawnSync([binary, ...args, "--json"], {
			cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_STATE_HOME: join(home, "xdg-state"), XDG_DATA_HOME: join(home, "xdg-data"), XDG_CACHE_HOME: join(home, "xdg-cache"), PATH: `${ompBin}:/usr/bin:/bin`, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", ...envOverride },
		});
		expect(snapshot(home)).toEqual(beforeHome);
		expect(snapshot(project)).toEqual(beforeProject);
		expect(snapshot(otherProject)).toEqual(beforeOtherProject);
		expect(existsSync(launcherInvocation)).toBe(false);
		expect(existsSync(serverInvocation)).toBe(false);
		expect(result.stderr.toString()).toBe("");
		const stdout = result.stdout.toString();
		expect(stdout.trim().split("\n")).toHaveLength(1);
		return { code: result.exitCode, envelope: JSON.parse(stdout), realOmp };
	};
	return { release, home, project, otherProject, ompPackage, invoke: (...args: string[]) => invoke(args), invokeWithEnv: invoke };
}

function compiledTest(name: string, run: () => void): void {
	test(name, run, 30_000);
}

type SchemaShape = {
	type?: "object" | "array" | "string" | "boolean" | "number" | "null" | ("object" | "array" | "string" | "boolean" | "number" | "null")[];
	required?: string[];
	properties?: Record<string, SchemaShape>;
	items?: SchemaShape;
	enum?: unknown[];
	anyOf?: SchemaShape[];
};

function conforms(value: unknown, shape: SchemaShape): boolean {
	if (shape.anyOf) return shape.anyOf.some((option) => conforms(value, option));
	if (shape.enum && !shape.enum.includes(value)) return false;
	if (Array.isArray(shape.type)) return shape.type.some((type) => conforms(value, { ...shape, type }));
	if (shape.type === "null") return value === null;
	if (shape.type === "array") {
		if (!Array.isArray(value)) return false;
		const items = shape.items;
		return !items || value.every((entry) => conforms(entry, items));
	}
	if (shape.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const record: Record<string, unknown> = value as Record<string, unknown>;
		if (shape.required?.some((key) => !(key in record))) return false;
		return Object.entries(shape.properties ?? {}).every(([key, property]) => !(key in record) || conforms(record[key], property));
	}
	return !shape.type || typeof value === shape.type;
}

describe("omp-kit CLI grammar and refusal", () => {

	test("-h uses the help grammar before and after a verb, never treating it as an unknown mutation", () => {
		const root = workspace();
		const global = run(["-h"], root);
		const topic = robot(["update", "-h", "--robot"], root);
		expect(global.code).toBe(0);
		expect(global.stdout).toContain("Usage: omp-kit");
		expect(topic.code).toBe(0);
	});

	test("bare status identifies an installed OMP without certifying operator profile or matcher", () => {
		const root = workspace();
		const result = robot(["--robot", "--json"], root, installedOmp(root));
		expect(result.code).toBe(0);
		expect(result.data.ok).toBe(true);
		expect(result.data.meta.schema_version).toBeDefined();
		expect(result.data.data.omp.version).toBe("1.2.3");
		expect(result.data.data.omp.location).toContain("/omp/releases/v1/dist/cli.js");
		expect(result.data.data.overall).toBe("UNVERIFIED");
		expect(result.data.data.evidence.effective_profile).toBe("UNVERIFIED");
		expect(result.data.data.evidence.matcher).toBe("NOT_RUN");
	});

	test("missing OMP is a dependency error, not green empty inventory", () => {
		const result = robot(["status", "--json"], workspace());
		expect(result.code).toBe(3);
		expect(result.data.ok).toBe(false);
		expect(result.data.errors[0].code).toBe("OMP_UNAVAILABLE");
	});

	test("global flags work on either side and topic help returns typed JSON text", () => {
		const root = workspace();
		const before = robot(["--robot", "help", "update"], root);
		const after = robot(["help", "update", "--robot"], root);
		expect(before.code).toBe(0);
		expect(before.stdout).toBe(after.stdout);
		expect(before.data.data.text).toContain("--yes");
	});

	test("retired OMP update scopes and channel consent cannot reach an updater or mutate state", () => {
		const root = workspace();
		const ompBin = installedOmp(root);
		const launcher = join(root, "omp", "releases", "v1", "dist", "cli.js");
		const invoked = join(root, "omp-launcher-invoked");
		writeFileSync(launcher, `#!/bin/sh\nprintf 'invoked\\n' > ${JSON.stringify(invoked)}\nexit 97\n`, { mode: 0o755 });
		const beforeOmp = snapshot(join(root, "omp"));
		for (const args of [
			["update", "--scope", "omp", "--apply", "--yes", "--json"],
			["update", "--scope", "all", "--apply", "--yes", "--json"],
			["update", "--allow-channel-change", "--apply", "--yes", "--json"],
		]) {
			const result = robot(args, root, ompBin);
			expect(result.code).toBe(2);
			expect(["INVALID_FLAG", "UNKNOWN_FLAG"]).toContain(result.data.errors[0].code);
			expect(snapshot(join(root, "omp"))).toEqual(beforeOmp);
			expect(existsSync(invoked)).toBe(false);
			expect(existsSync(join(root, "xdg-state"))).toBe(false);
		}
	});


	test("versioned schema validates observed status, help and usage-error envelopes with command data shapes", () => {
		const root = workspace();
		const shapes = robot(["schema", "--json"], root).data.data;
		const status = robot(["status", "--robot"], root, installedOmp(root));
		const help = robot(["help", "update", "--robot"], root);
		const error = robot(["--robot", "apply", "ruls", "--apply", "--yes"], root);
		expect(shapes.schema_version).toBe(status.data.meta.schema_version);
		expect(shapes.command_data.status.required).toEqual(expect.arrayContaining(["kit", "omp", "evidence", "findings"]));
		expect(shapes.command_data.help.required).toContain("text");
		expect(shapes.usage_error_data.required).toContain("overall");
		for (const response of [status, help, error]) expect(conforms(response.data, shapes.envelope)).toBe(true);
		expect(conforms(status.data.data, shapes.command_data.status)).toBe(true);
		expect(conforms(help.data.data, shapes.command_data.help)).toBe(true);
		expect(conforms(error.data.data, shapes.usage_error_data)).toBe(true);
		const missingEvidence = { ...status.data.data, evidence: undefined };
		expect(conforms(missingEvidence, shapes.command_data.status)).toBe(false);
	});

	test("completion exposes documented subcommands but not unsupported spelling", () => {
		const result = robot(["completion", "bash", "--json"], workspace());
		expect(result.code).toBe(0);
		expect(result.data.data.text).toContain("rules");
		expect(result.data.data.text).toContain("policy");
		expect(result.data.data.text).not.toContain("jsno");
	});

	test("topic --help exposes its subcommands even without a selected mutation", () => {
		const result = run(["apply", "--help"], workspace());
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("apply rules");
		expect(result.stdout).toContain("apply policy");
	});


	test("unknown --jsno yields exit 2 and an exact --json hint", () => {
		const result = robot(["--robot", "status", "--jsno"], workspace());
		expect(result.code).toBe(2);
		expect(result.data.errors[0].code).toBe("UNKNOWN_FLAG");
		expect(result.data.errors[0].remediation).toContain("--json");
	});

	test("unknown mutating token refuses without creating a target", () => {
		const root = workspace();
		const result = robot(["--robot", "apply", "ruls", "--apply", "--yes"], root);
		expect(result.code).toBe(2);
		expect(result.data.errors[0].code).toBe("UNKNOWN_SUBCOMMAND");
		expect(result.data.errors[0].remediation).toContain("apply rules");
		expect(existsSync(join(root, ".omp"))).toBe(false);
	});

	test("--info reports source identity without claiming a release or OMP success", () => {
		const result = robot(["--info", "--robot"], workspace());
		expect(result.code).toBe(0);
		expect(result.data.data.release.identity).toBe("UNVERIFIED");
		expect(result.data.data.omp.status).toBe("UNAVAILABLE");
	});

	compiledTest("compiled status, health and doctor inventory on a supported OMP-layout fixture never invokes OMP or changes HOME/project", () => {
		const { invoke } = compiledDiagnosticFixture();
		const status = invoke("status");
		expect(status.code).toBe(0);
		expect(status.envelope.ok).toBe(true);
		expect(status.envelope.data.omp.location).toBe(status.realOmp);
		expect(status.envelope.data.omp.version).toBe("18.4.0");
		expect(status.envelope.data.findings.find((row: { component: string }) => row.component === "installed_rules").status).toBe("DEGRADED");
		expect(status.envelope.data.evidence.effective_profile).toBe("UNVERIFIED");
		expect(status.envelope.data.evidence.matcher).toBe("NOT_RUN");
		expect(status.envelope.data.recommended_actions.some((action: string) => action.includes("omp-kit apply rules --plan"))).toBe(true);
		const health = invoke("health");
		expect(health.code).toBe(1);
		expect(health.envelope.ok).toBe(false);
		expect(health.envelope.data.overall).toBe("UNVERIFIED");
		expect(health.envelope.data.findings.find((row: { component: string }) => row.component === "installed_rules").status).toBe("DEGRADED");
		expect(health.envelope.data.findings.find((row: { component: string }) => row.component === "omp_drift").status).toBe("NOT_RUN");
		expect(health.envelope.data.not_judged.find((row: { component: string }) => row.component === "effective_profile").status).toBe("UNVERIFIED");
		expect(health.envelope.data.not_judged.find((row: { component: string }) => row.component === "matcher").status).toBe("NOT_RUN");
		expect(health.envelope.data.not_judged.some((row: { component: string }) => ["kit", "manifest", "omp", "state_root", "installed_rules", "omp_drift"].includes(row.component))).toBe(false);
		const doctor = invoke("doctor");
		expect(doctor.code).toBe(0);
		expect(doctor.envelope.ok).toBe(true);
		expect(doctor.envelope.data.findings.find((row: { component: string }) => row.component === "effective_profile").status).toBe("UNVERIFIED");
		const kitOnly = invoke("doctor", "--scope", "kit");
		expect(kitOnly.envelope.data.findings.map((row: { component: string }) => row.component)).toEqual(["kit", "manifest"]);
		const policy = invoke("doctor", "--scope", "policy");
		expect(policy.code).toBe(0);
		expect(policy.envelope.data.findings).toEqual(expect.arrayContaining([expect.objectContaining({ component: "policy", status: "UNVERIFIED" })]));
		const schemas = invoke("schema").envelope.data.command_data;
		expect(conforms(status.envelope.data, schemas.status)).toBe(true);
		expect(conforms(health.envelope.data, schemas.health)).toBe(true);
		expect(conforms(doctor.envelope.data, schemas.doctor)).toBe(true);
		const capabilities = invoke("capabilities");
		expect(capabilities.envelope.data.commands.map((command: { name: string }) => command.name)).toEqual(expect.arrayContaining(["status", "health", "doctor"]));
	});

	compiledTest("compiled inventory exposes manifest failure, installed drift, retired/unknown rules and project shadow without modifying either tree", () => {
		const { release, home, project, invoke } = compiledDiagnosticFixture();
		const shipped = join(release, "rules", "rule-a.md");
		writeFileSync(shipped, "tampered release\n");
		const badManifest = invoke("status");
		expect(badManifest.code).toBe(1);
		expect(badManifest.envelope.data.findings.find((row: { component: string }) => row.component === "manifest").status).toBe("FAIL");
		writeFileSync(shipped, "# Rule A\n");
		mkdirSync(join(home, ".agents", "rules"), { recursive: true });
		writeFileSync(join(home, ".agents", "rules", "rule-a.md"), "user-edited bytes\n");
		const drift = invoke("doctor", "--scope", "rules");
		expect(drift.code).toBe(0);
		expect(drift.envelope.data.findings.find((row: { component: string }) => row.component === "installed_rules").evidence.drifted).toEqual(["rule-a"]);
		expect(drift.envelope.data.recommended_actions.some((action: string) => action.includes("omp-kit apply rules --plan"))).toBe(true);
		writeFileSync(join(release, "retired", "old-rule.md"), "retired source\n");
		writeFileSync(join(home, ".agents", "rules", "old-rule.md"), "unowned retirement\n");
		writeFileSync(join(home, ".agents", "rules", "other.md"), "unmanaged extra\n");
		mkdirSync(join(project, ".omp", "rules"), { recursive: true });
		writeFileSync(join(project, ".omp", "rules", "rule-a.md"), "#!/bin/sh\nexit 72\n");
		const shadow = invoke("status");
		expect(shadow.code).toBe(0);
		expect(shadow.envelope.data.findings.find((row: { component: string }) => row.component === "project_rules").evidence.mismatched_shadows).toEqual(["rule-a"]);
		expect(shadow.envelope.data.findings.find((row: { component: string }) => row.component === "retired_rules").evidence.present).toEqual(["old-rule"]);
		expect(shadow.envelope.data.findings.find((row: { component: string }) => row.component === "unknown_rules").evidence.names).toEqual(["other"]);
	});
	compiledTest("compiled LSP doctor and setup use the selected project cwd, keep out-of-cwd files distinct, and never invoke binaries", () => {
		const { project, otherProject, invoke } = compiledDiagnosticFixture();
		writeFileSync(join(project, "package.json"), "{\"private\":true}\n");
		const target = join(project, "src", "index.ts");
		const doctor = invoke("doctor", "--scope", "lsp", "--file", target);
		expect(doctor.code).toBe(0);
		expect(doctor.envelope.data.overall).toBe("UNVERIFIED");
		expect(doctor.envelope.data.report).toEqual(expect.objectContaining({
			cwd: project, file: target, file_outside_cwd: false, runtime: "NOT_PROBED",
		}));
		expect(doctor.envelope.data.report.servers.find((row: { name: string }) => row.name === "typescript-language-server")).toEqual(
			expect.objectContaining({ eligible: true, executable_found: true, status: "UNVERIFIED", runtime: "NOT_PROBED" }),
		);
		const outside = invoke("doctor", "--scope", "lsp", "--project", otherProject, "--file", target);
		expect(outside.code).toBe(0);
		expect(outside.envelope.data.report).toEqual(expect.objectContaining({
			cwd: otherProject, file: target, file_outside_cwd: true, runtime: "NOT_PROBED",
		}));
		expect(outside.envelope.data.report.servers.find((row: { name: string }) => row.name === "typescript-language-server")).toEqual(
			expect.objectContaining({ eligible: false, status: "DEGRADED" }),
		);
		const relative = invoke("doctor", "--scope", "lsp", "--project", "../other-project", "--file", "src/index.ts");
		expect(relative.envelope.data.report).toEqual(expect.objectContaining({
			cwd: otherProject, file: join(otherProject, "src", "index.ts"), file_outside_cwd: false,
		}));
		const plan = invoke("lsp", "setup", "--plan", "--project", otherProject, "--file", target);
		expect(plan.code).toBe(0);
		expect(plan.envelope.data.overall).toBe("DEGRADED");
		expect(plan.envelope.data.report).toEqual(expect.objectContaining({ cwd: otherProject, file_outside_cwd: true, runtime: "NOT_PROBED" }));
		expect(plan.envelope.data.instructions).toContainEqual(expect.objectContaining({ server: "marksman", status: expect.stringMatching(/^(MANUAL|UNSUPPORTED)$/) }));
		const schemas = invoke("schema").envelope.data.command_data;
		expect(conforms(doctor.envelope.data, schemas.doctor)).toBe(true);
		expect(conforms(plan.envelope.data, schemas["lsp setup"])).toBe(true);
	});

	compiledTest("LSP grammar advertises only read-only routes and missing OMP remains an environment refusal", () => {
		const { invoke, invokeWithEnv, otherProject } = compiledDiagnosticFixture();
		const capabilities = invoke("capabilities").envelope.data.commands;
		expect(capabilities.find((row: { name: string }) => row.name === "lsp")?.subcommands.map((row: { name: string }) => row.name)).toEqual(["setup"]);
		const help = invoke("help", "doctor").envelope.data;
		expect(help.text).toContain("--file");
		expect(help.text).toContain("--project");
		expect(help.text).toContain("lsp");
		const completion = invoke("completion", "bash").envelope.data.text;
		expect(completion).toContain("lsp:setup)");
		expect(completion).toContain("--plan --project --file");
		const missingOmp = invokeWithEnv(["lsp", "setup", "--plan"], { PATH: otherProject });
		expect(missingOmp.code).toBe(3);
		expect(missingOmp.envelope.errors[0].code).toBe("OMP_UNAVAILABLE");
		expect(missingOmp.envelope.data.overall).toBe("UNVERIFIED");
		const doctorWithoutOmp = invokeWithEnv(["doctor", "--scope", "lsp"], { PATH: otherProject });
		expect(doctorWithoutOmp.code).toBe(3);
		expect(doctorWithoutOmp.envelope.errors[0].code).toBe("OMP_UNAVAILABLE");
		const nonAbsoluteHome = invokeWithEnv(["doctor", "--scope", "lsp"], { HOME: "not-an-absolute-home" });
		expect(nonAbsoluteHome.code).toBe(3);
		expect(nonAbsoluteHome.envelope.errors[0].code).toBe("INVENTORY_UNAVAILABLE");
		const noApply = invoke("lsp", "setup", "--apply");
		expect(noApply.code).toBe(2);
		const noScope = invoke("doctor", "--project", ".");
		expect(noScope.code).toBe(2);
		const nonexistentProject = invoke("lsp", "setup", "--plan", "--project", join(otherProject, "missing"));
		expect(nonexistentProject.code).toBe(2);
		expect(nonexistentProject.envelope.errors[0].code).toBe("INVALID_PROJECT");
	});
	compiledTest("compiled project-loading doctor inventories clone startup inputs without running code, disclosing checkout paths, or granting trust", () => {
		const { project, otherProject, ompPackage, invoke } = compiledDiagnosticFixture();
		writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.3.1" }));
		const clean = invoke("doctor", "--scope", "project-loading");
		expect(clean.code).toBe(0);
		expect(clean.envelope.data.overall).toBe("UNVERIFIED");
		expect(clean.envelope.data.findings).toEqual([expect.objectContaining({
			component: "project-loading", status: "UNVERIFIED",
			evidence: expect.objectContaining({ inputs: [], version_semantics: "MEASURED_18_3_1" }),
		})]);
		expect(JSON.stringify(clean.envelope)).not.toContain(project);

		mkdirSync(join(otherProject, ".omp", "extensions"), { recursive: true });
		const sentinel = join(otherProject, "EXECUTED");
		writeFileSync(join(otherProject, ".omp", "extensions", "startup.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed");\n`);
		writeFileSync(join(otherProject, ".omp", "config.yml"), "extensions:\n  - ./private-extension.ts\nmcp:\n  enableProjectConfig: true\n");
		writeFileSync(join(otherProject, ".omp", "mcp.json"), "{\"mcpServers\":{}}\n");
		const hazard = invoke("doctor", "--scope", "project-loading", "--project", "../other-project");
		expect(hazard.code).toBe(0);
		expect(hazard.envelope.data.overall).toBe("DEGRADED");
		const finding = hazard.envelope.data.findings[0];
		expect(finding.evidence.inputs).toEqual(expect.arrayContaining([
			{ category: "project_extension", path: ".omp/extensions/startup.ts" },
			{ category: "configured_extension", path: ".omp/config.yml#extensions", count: 1 },
			{ category: "project_mcp_config", path: ".omp/mcp.json" },
			{ category: "project_mcp_enable_override", path: ".omp/config.yml#mcp.enableProjectConfig" },
		]));
		expect(finding.recommended_action).toContain("trusted directory");
		expect(finding.evidence.project_mcp).toBe("PROJECT_OVERRIDE_ENABLED");
		expect(existsSync(sentinel)).toBe(false);
		expect(JSON.stringify(hazard.envelope)).not.toContain(otherProject);
		const schema = invoke("schema").envelope.data.command_data.doctor;
		expect(conforms(hazard.envelope.data, schema)).toBe(true);
	});

	compiledTest("compiled project-loading doctor leaves unsafe clone paths opaque, including a symlinked selected root", () => {
		const { project, otherProject, ompPackage, invoke } = compiledDiagnosticFixture();
		writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.3.1" }));
		mkdirSync(join(otherProject, ".claude"), { recursive: true });
		writeFileSync(join(otherProject, ".claude", "settings.json"), "{invalid");
		mkdirSync(join(project, ".omp"));
		writeFileSync(join(project, ".omp", "config.yml"), "mcp:\n  enableProjectConfig: true\n");
		symlinkSync(join(project, ".omp"), join(otherProject, ".omp"));
		const opaque = invoke("doctor", "--scope", "project-loading", "--project", otherProject);
		expect(opaque.code).toBe(0);
		expect(opaque.envelope.data.overall).toBe("UNVERIFIED");
		expect(opaque.envelope.data.findings[0].evidence.uncertain_paths).toEqual(expect.arrayContaining([".omp", ".claude/settings.json"]));
		const linked = join(otherProject, "..", "linked-project");
		symlinkSync(otherProject, linked);
		const root = invoke("doctor", "--scope", "project-loading", "--project", linked);
		expect(root.code).toBe(0);
		expect(root.envelope.data.findings[0].evidence.uncertain_paths).toContain("<project>");
		expect(JSON.stringify(root.envelope)).not.toContain(linked);
		const help = invoke("help", "doctor").envelope.data.text;
		expect(help).toContain("project-loading");
		expect(invoke("completion", "bash").envelope.data.text).toContain("project-loading");
	});
	compiledTest("compiled examples renders each release-bundled profile recipe without touching HOME or activating a profile", () => {
		const { invoke } = compiledDiagnosticFixture();
		const schemas = invoke("schema").envelope.data.command_data;
		const expectedSettings = {
			"memory-off": ["backend: off"],
			"mnemopi-manual": ["backend: mnemopi", "autoRetain: false", "autoRecall: false", "noEmbeddings: true", "llmMode: none"],
			"model-roles": ["modelRoles: {}"],
		};
		for (const [kind, settings] of Object.entries(expectedSettings)) {
			const result = invoke("examples", kind);
			expect(result.code).toBe(0);
			expect(result.envelope.data).toEqual(expect.objectContaining({ kind, version: 1, status: "UNVERIFIED" }));
			for (const setting of settings) expect(result.envelope.data.content).toContain(setting);
			expect(conforms(result.envelope.data, schemas[`examples ${kind}`])).toBe(true);
			expect(JSON.stringify(result.envelope).toLowerCase()).not.toMatch(/(?:api[_-]?key|password|bearer )[:=]\s*["'][^"']+["']/);
		}
		const bare = invoke("examples");
		expect(bare.code).toBe(0);
		expect(typeof bare.envelope.data.text).toBe("string");
		expect(conforms(bare.envelope.data, schemas.examples)).toBe(true);
		expect(invoke("help", "examples").envelope.data.text).toContain("mnemopi-manual");
		expect(invoke("completion", "bash").envelope.data.text).toContain("examples:mnemopi-manual)");
		const caps = invoke("capabilities").envelope.data.commands;
		expect(caps.find((row: { name: string }) => row.name === "examples")?.subcommands.map((row: { name: string }) => row.name)).toEqual(
			["memory-off", "mnemopi-manual", "model-roles", "mcp", "skill-set", "omp-watch"],
		);
		const unknown = invoke("examples", "unknown-kind");
		expect(unknown.code).toBe(2);
		expect(unknown.envelope.errors[0].code).toBe("UNKNOWN_SUBCOMMAND");
	});
	compiledTest("compiled memory doctor reports reviewed on-disk settings without reading rows or invoking OMP", () => {
		const { home, ompPackage, invoke } = compiledDiagnosticFixture();
		writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.9" }));
		copyReviewedMemorySources(ompPackage);
		mkdirSync(join(home, ".omp", "agent"), { recursive: true });
		writeFileSync(join(home, ".omp", "agent", "config.yml"), "memory:\n  backend: off\n");
		const off = invoke("doctor", "--scope", "memory");
		expect(off.code).toBe(0);
		expect(off.envelope.data.overall).toBe("DEGRADED");
		expect(off.envelope.data.findings[0]).toEqual(expect.objectContaining({
			component: "memory", status: "DEGRADED", evidence: expect.objectContaining({
				backend: "off", store: "NOT_APPLICABLE", runtime: "NOT_PROBED",
				redactor: expect.objectContaining({ status: "MISSES", version: "18.4.9", coverage: "SYNTHETIC_ONLY", missed: expect.arrayContaining(["pem_private_key"]) }),
				profile_observation: { selected: "default", source: "DEFAULT_ON_DISK", effective_active_profile: "UNVERIFIED" },
			}),
		}));
		mkdirSync(join(home, ".omp", "profiles", "manual", "agent"), { recursive: true });
		writeFileSync(join(home, ".omp", "profiles", "manual", "agent", "config.yml"),
			"memory:\n  backend: mnemopi\nmnemopi:\n  autoRetain: false\n  autoRecall: false\n  scoping: per-project\n  noEmbeddings: true\n  llmMode: none\n");
		const manual = invoke("doctor", "--scope", "memory", "--profile", "manual");
		expect(manual.code).toBe(0);
		expect(manual.envelope.data.overall).toBe("DEGRADED");
		expect(manual.envelope.data.findings[0].evidence).toEqual(expect.objectContaining({
			backend: "mnemopi", configured: true, store: "NOT_CREATED", auto_retain: false, auto_recall: false,
			scoping: "per-project", model: "DISABLED", embedding: "DISABLED_FTS_ONLY", runtime: "NOT_PROBED",
			redactor: expect.objectContaining({ status: "MISSES", version: "18.4.9", missed: expect.arrayContaining(["pem_private_key"]) }),
			profile_observation: { selected: "manual", source: "NAMED_ON_DISK", effective_active_profile: "UNVERIFIED" },
		}));
		expect(JSON.stringify(manual.envelope)).not.toContain(["ghp_", "SyntheticLettersAndDigits"].join(""));
		expect(invoke("help", "doctor").envelope.data.text).toContain("--profile");
		expect(invoke("completion", "bash").envelope.data.text).toContain("--profile");
		expect(conforms(manual.envelope.data, invoke("schema").envelope.data.command_data.doctor)).toBe(true);
	});

	compiledTest("memory doctor leaves malformed config and changed source bytes unverified and missing OMP unavailable", () => {
		const { home, ompPackage, otherProject, invoke, invokeWithEnv } = compiledDiagnosticFixture();
		writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.9" }));
		copyReviewedMemorySources(ompPackage);
		mkdirSync(join(home, ".omp", "agent"), { recursive: true });
		writeFileSync(join(home, ".omp", "agent", "config.yml"), "memory: [\n");
		const opaque = invoke("doctor", "--scope", "memory");
		expect(opaque.envelope.data.overall).toBe("UNVERIFIED");
		expect(opaque.envelope.data.findings[0].evidence.backend).toBe("UNVERIFIED");
		const settingsPath = join(ompPackage, "src/memory-backend/settings.ts");
		const settingsBytes = Buffer.from(readFileSync(settingsPath));
		settingsBytes[0] = (settingsBytes[0] ?? 0) ^ 1;
		writeFileSync(settingsPath, settingsBytes);
		const changedSource = invoke("doctor", "--scope", "memory");
		expect(changedSource.envelope.data.overall).toBe("UNVERIFIED");
		expect(changedSource.envelope.data.findings[0].reason).toContain("source hashes");
		const missingOmp = invokeWithEnv(["doctor", "--scope", "memory"], { PATH: otherProject });
		expect(missingOmp.code).toBe(3);
		expect(missingOmp.envelope.errors[0].code).toBe("OMP_UNAVAILABLE");
		expect(invoke("doctor", "--scope", "lsp", "--profile", "manual").code).toBe(2);
	});
	compiledTest("compiled named-profile MCP doctor inventories candidates and disabled servers without starting them or disclosing env tokens", () => {
		const { home, ompPackage, project, invoke } = compiledDiagnosticFixture();
		writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.2" }));
		const agent = join(home, ".omp", "profiles", "named", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), "disabledProviders: []\n");
		const canary = "DO_NOT_ECHO_MCP_CONFIG_TOKEN";
		const profileConfig = join(agent, "mcp.json");
		writeFileSync(profileConfig, JSON.stringify({ mcpServers: {
			local: { type: "stdio", command: "typescript-language-server", args: [], env: { TOKEN: canary } },
		} }));
		const candidate = invoke("doctor", "--scope", "mcp", "--profile", "named");
		expect(candidate.code).toBe(0);
		expect(candidate.envelope.data.overall).toBe("UNVERIFIED");
		expect(candidate.envelope.data.findings[0]).toEqual(expect.objectContaining({
			component: "mcp", status: "UNVERIFIED", evidence: expect.objectContaining({
				profile: "named", proof: "ON_DISK_INVENTORY_ONLY",
				servers: [expect.objectContaining({ name: "local", discoverable: "CANDIDATE", executable_found: true,
					startup_ready: "NOT_PROBED", actually_callable: "NOT_PROBED" })],
			}),
		}));
		expect(JSON.stringify(candidate.envelope)).not.toContain(canary);
		expect(JSON.stringify(candidate.envelope)).not.toContain(profileConfig);
		expect(JSON.stringify(candidate.envelope)).not.toContain(project);
		writeFileSync(profileConfig, JSON.stringify({ disabledServers: ["local"], mcpServers: {
			local: { type: "stdio", command: "typescript-language-server", env: { TOKEN: canary } },
		} }));
		const denied = invoke("doctor", "--scope", "mcp", "--profile", "named");
		expect(denied.envelope.data.overall).toBe("DEGRADED");
		expect(denied.envelope.data.findings[0].evidence.servers[0]).toEqual(expect.objectContaining({
			discoverable: "BLOCKED", startup_ready: "NOT_PROBED", actually_callable: "NOT_PROBED",
		}));
		expect(JSON.stringify(denied.envelope)).not.toContain(canary);
		expect(conforms(denied.envelope.data, invoke("schema").envelope.data.command_data.doctor)).toBe(true);
	});

	compiledTest("MCP grammar requires an existing named profile and examples mcp remains a static manual template", () => {
		const { home, otherProject, invoke, invokeWithEnv } = compiledDiagnosticFixture();
		expect(invoke("doctor", "--scope", "mcp").code).toBe(2);
		expect(invoke("doctor", "--scope", "mcp", "--profile", "default").code).toBe(2);
		const absent = invoke("doctor", "--scope", "mcp", "--profile", "absent");
		expect(absent.code).toBe(2);
		expect(absent.envelope.errors[0].code).toBe("PROFILE_UNAVAILABLE");
		expect(existsSync(join(home, ".omp", "profiles", "absent"))).toBe(false);
		mkdirSync(join(home, ".omp", "profiles", "present", "agent"), { recursive: true });
		const missingOmp = invokeWithEnv(["doctor", "--scope", "mcp", "--profile", "present"], { PATH: otherProject });
		expect(missingOmp.code).toBe(3);
		expect(missingOmp.envelope.errors[0].code).toBe("OMP_UNAVAILABLE");
		const example = invoke("examples", "mcp");
		expect(example.code).toBe(0);
		expect(example.envelope.data.text).toContain("YOUR_EXISTING_MCP_EXECUTABLE");
		expect(example.envelope.data.text).toContain("NOT_PROBED");
		expect(conforms(example.envelope.data, invoke("schema").envelope.data.command_data["examples mcp"])).toBe(true);
		expect(invoke("help", "examples").envelope.data.text).toContain("examples mcp");
		expect(invoke("completion", "bash").envelope.data.text).toContain("examples:mcp)");
	});
});
