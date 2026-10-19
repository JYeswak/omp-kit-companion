import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { inspectLspReadiness, planLspSetup, resolveOmpDefaults, type LspReadinessReport } from "../../src/lsp-readiness.ts";
import { buildLspJsonRpcReceipt, classifyLspProbeOutcome, probeLspReadiness } from "../../src/lsp-probe.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ompSrcRestores: Array<() => void> = [];
afterEach(() => { for (const restore of ompSrcRestores.splice(0)) restore(); });
/** Hermetic source tree for binary-only launchers (ompkit-fp72.36): version is read
 * from the launcher itself so a substituted version fails loudly instead of silently. */
/** Hermetic source tree for binary-only launchers: version is read from the
 * launcher itself so a substituted version fails loudly instead of silently.
 * The defaults are the COMPLETE real server inventory (copied from a resolved
 * OMP package), never a fabricated subset: the probe disables every non-target
 * server named there, so a truncated map would fan workspace/symbol out to
 * undisabled servers and fail the absent-symbol control. */
function realDefaultsSource(): string {
	const candidates = [
		join(process.env.HOME ?? "/Users/josh", ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/lsp/defaults.json"),
	];
	try {
		const npmRoot = Bun.spawnSync(["npm", "root", "-g"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim().split("\n")[0];
		if (npmRoot) candidates.push(join(npmRoot, "@oh-my-pi/pi-coding-agent/src/lsp/defaults.json"));
	} catch { /* npm lookup is best-effort; candidates already held. */ }
	for (const candidate of candidates) {
		try {
			const text = readFileSync(candidate, "utf8");
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)["typescript-language-server"]) return candidate;
		} catch { /* try the next candidate. */ }
	}
	throw new Error("no complete OMP defaults.json found (bun-global or npm-global OMP package required); refusing a fabricated subset");
}
function sourceTreeFor(root: string, ompPath: string): string | null {
	// An npm-installed launcher (CI) already has its package source beside it. Adding OMP_SRC
	// there is the mixed identity the product refuses (planted test below), so only a
	// binary-only launcher gets the hermetic tree.
	const beside = process.env.OMP_SRC === undefined ? resolveOmpDefaults(ompPath) : null;
	if (beside !== null) {
		console.log(`OMP_SRC-UNNEEDED source=${beside.root} server=typescript-language-server`);
		return null;
	}
	const probed = Bun.spawnSync([ompPath, "--version"], { stdout: "pipe", stderr: "pipe" });
	const version = /(\d+\.\d+\.\d+)/.exec(probed.stdout.toString())?.[1];
	if (!version) throw new Error(`cannot read omp version from ${ompPath}; refusing an unversioned OMP_SRC`);
	const dir = join(root, "ompsrc");
	mkdirSync(join(dir, "src", "lsp"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
	writeFileSync(join(dir, "src", "lsp", "defaults.json"), readFileSync(realDefaultsSource(), "utf8"));
	const previous = process.env.OMP_SRC;
	process.env.OMP_SRC = dir;
	ompSrcRestores.push(() => {
		if (previous === undefined) delete process.env.OMP_SRC;
		else process.env.OMP_SRC = previous;
	});
	console.log(`OMP_SRC-RESOLVED version=${version} server=typescript-language-server`);
	return dir;
}

function fixture(base = scratch) {
	const root = mkdtempSync(join(base, "lsp-readiness-"));
	fixtures.push(root);
	const home = join(root, "home");
	const project = join(root, "project");
	const other = join(root, "other");
	const bin = join(root, "bin");
	const pkg = join(root, "omp");
	for (const dir of [home, project, other, bin, join(pkg, "dist"), join(pkg, "src", "lsp")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.2" }));
	writeFileSync(join(pkg, "src", "lsp", "defaults.json"), JSON.stringify({
		"typescript-language-server": { command: "typescript-language-server", fileTypes: [".ts"], rootMarkers: ["package.json"] },
		"typescript-native": { command: "tsc", fileTypes: [".ts"], rootMarkers: ["package.json"] },
		"marksman": { command: "marksman", fileTypes: [".md"], rootMarkers: [".git"] },
	}));
	const ompPath = join(pkg, "dist", "cli.js");
	writeFileSync(ompPath, `#!/bin/sh\nprintf executed > '${join(root, "executed")}'\n`);
	const binary = (name: string) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\nprintf executed > '${join(root, "executed")}'\n`); chmodSync(path, 0o755); return path; };
	const inspect = (cwd = project, file = join(cwd, "index.ts")) => inspectLspReadiness({ home, project: cwd, file, ompPath, pathEnv: bin, platform: "darwin" });
	return { root, home, project, other, bin, ompPath, binary, inspect };
}

function tree(dir: string, relative = ""): string[] {
	return readdirSync(dir).sort().flatMap(name => {
		const path = join(dir, name);
		const rel = join(relative, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) return [`${rel}:dir:${stat.mode & 0o777}`, ...tree(path, rel)];
		return [`${rel}:file:${stat.mode & 0o777}:${readFileSync(path).toString("hex")}`];
	});
}

const server = (report: LspReadinessReport, name: string) => {
	const result = report.servers.find(entry => entry.name === name);
	if (!result) throw new Error(`missing server ${name}`);
	return result;
};

test("two session cwd roots select their own markers even with identical file extensions", () => {
	const f = fixture();
	f.binary("typescript-language-server");
	writeFileSync(join(f.project, "package.json"), "{}");
	const eligible = server(f.inspect(), "typescript-language-server");
	const other = server(f.inspect(f.other), "typescript-language-server");
	expect(eligible.configured).toBe(true);
	expect(eligible.executable_found).toBe(true);
	expect(eligible.eligible).toBe(true);
	expect(eligible.runtime).toBe("NOT_PROBED");
	expect(other.eligible).toBe(false);
	expect(other.reason).toContain("package.json");
	expect(other.recommended_action).toContain(`--project ${f.other}`);
});

test("out-of-cwd target does not inherit marker or config from file ancestor", () => {
	const f = fixture();
	f.binary("typescript-language-server");
	writeFileSync(join(f.other, "package.json"), "{}");
	writeFileSync(join(f.other, ".lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { rootMarkers: ["."] } } }));
	const result = f.inspect(f.project, join(f.other, "index.ts"));
	expect(result.cwd).toBe(f.project);
	expect(result.file).toBe(join(f.other, "index.ts"));
	expect(server(result, "typescript-language-server").eligible).toBe(false);
	expect(server(result, "typescript-language-server").reason).toContain("package.json");
	writeFileSync(join(f.project, "package.json"), "{}");
	const routed = f.inspect(f.project, join(f.other, "index.ts"));
	expect(server(routed, "typescript-language-server").eligible).toBe(true);
	expect(routed.file_outside_cwd).toBe(true);
	expect(server(routed, "typescript-language-server").runtime).toBe("NOT_PROBED");
});

test("higher-priority project layer changes effective marker and extension without rewriting HOME", () => {
	const f = fixture();
	f.binary("typescript-language-server");
	writeFileSync(join(f.project, "package.json"), "{}");
	writeFileSync(join(f.home, ".lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { rootMarkers: ["never-here"], fileTypes: [".js"] } } }));
	mkdirSync(join(f.project, ".omp"));
	writeFileSync(join(f.project, ".omp", "lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { rootMarkers: ["package.json"], fileTypes: [".ts"] } } }));
	const before = [tree(f.home), tree(f.project)];
	const row = server(f.inspect(), "typescript-language-server");
	expect(row.eligible).toBe(true);
	expect(row.config_source).toBe(join(f.project, ".omp", "lsp.json"));
	expect([tree(f.home), tree(f.project)]).toEqual(before);
});

test("missing binary, disabled server, mismatched extension and alternative remain distinct", () => {
	const f = fixture();
	writeFileSync(join(f.project, "package.json"), "{}");
	let row = server(f.inspect(), "typescript-language-server");
	expect(row.executable_found).toBe(false);
	expect(row.eligible).toBe(false);
	expect(row.recommended_action).toContain("typescript-language-server");
	f.binary("typescript-language-server");
	writeFileSync(join(f.project, ".lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { disabled: true } } }));
	row = server(f.inspect(), "typescript-language-server");
	expect(row.disabled).toBe(true);
	expect(row.eligible).toBe(false);
	expect(row.recommended_action).toContain(".lsp.json");
	writeFileSync(join(f.project, ".lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { disabled: false } } }));
	row = server(f.inspect(f.project, join(f.project, "notes.md")), "typescript-language-server");
	expect(row.eligible).toBe(false);
	expect(row.reason).toContain(".md");
	f.binary("tsc");
	const alternative = f.inspect();
	expect(server(alternative, "typescript-native").eligible).toBe(false);
	expect(server(alternative, "typescript-native").reason).toContain("alternative");
	expect(server(alternative, "typescript-language-server").eligible).toBe(true);
});

test("unparseable or unsupported effective config does not certify eligibility", () => {
	const f = fixture();
	f.binary("typescript-language-server");
	writeFileSync(join(f.project, "package.json"), "{}");
	writeFileSync(join(f.project, "lsp.json"), "{ bad JSON");
	const report = f.inspect();
	expect(report.status).toBe("UNVERIFIED");
	expect(server(report, "typescript-language-server").eligible).toBe(false);
	expect(server(report, "typescript-language-server").recommended_action).toContain("lsp.json");
});

test("read-only plan preserves directory bytes/modes and gives macOS-only manual instructions", () => {
	const f = fixture();
	writeFileSync(join(f.project, ".git"), "marker");
	const before = [tree(f.home), tree(f.project), tree(f.bin)];
	const input = { home: f.home, project: f.project, file: join(f.project, "README.md"), ompPath: f.ompPath, pathEnv: f.bin, platform: "darwin" as const };
	const plan = planLspSetup(input);
	expect(plan.report.status).not.toBe("OK");
	expect(plan.instructions.some(row => row.server === "marksman" && row.command === "brew install marksman")).toBe(true);
	expect(plan.instructions.every(row => !row.command?.includes("postgres"))).toBe(true);
	expect([tree(f.home), tree(f.project), tree(f.bin)]).toEqual(before);
	const unsupported = planLspSetup({ ...input, platform: "linux" });
	expect([tree(f.home), tree(f.project), tree(f.bin)]).toEqual(before);
	expect(existsSync(join(f.root, "executed"))).toBe(false);
	expect(unsupported.instructions.some(row => row.server === "marksman" && row.status === "UNSUPPORTED" && row.command === null)).toBe(true);
});

test("extensionToLanguage grammar selects a custom server and dotted/undotted filenames", () => {
	const f = fixture();
	f.binary("custom-ls");
	writeFileSync(join(f.project, ".lsp.json"), JSON.stringify({ servers: { custom: { command: "custom-ls", extensionToLanguage: { xyz: "xyz" } } } }));
	expect(server(f.inspect(f.project, join(f.project, "model.xyz")), "custom").eligible).toBe(true);
	expect(basename(server(f.inspect(f.project, join(f.project, "model.xyz")), "custom").resolved_command!)).toBe("custom-ls");
});



test("deep LSP preflight distinguishes a missing server and a wrong root marker without launching it", async () => {
	const missing = fixture();
	writeFileSync(join(missing.project, "package.json"), "{}");
	writeFileSync(join(missing.project, "index.ts"), "export const value = 1;\n");
	missing.binary("node");
	const missingProbe = await probeLspReadiness({ readiness: missing.inspect(), home: missing.home, ompPath: missing.ompPath, pathEnv: missing.bin });
	expect(missingProbe.status).toBe("MISSING");
	expect(existsSync(join(missing.root, "executed"))).toBe(false);

	const wrongMarker = fixture();
	wrongMarker.binary("node");
	wrongMarker.binary("typescript-language-server");
	writeFileSync(join(wrongMarker.project, "index.ts"), "export const value = 1;\n");
	const markerProbe = await probeLspReadiness({ readiness: wrongMarker.inspect(), home: wrongMarker.home, ompPath: wrongMarker.ompPath, pathEnv: wrongMarker.bin });
	expect(markerProbe.status).toBe("WRONG_MARKER");
	expect(existsSync(join(wrongMarker.root, "executed"))).toBe(false);
});

test("deep LSP never launches a project-configured server command", async () => {
	const f = fixture();
	f.binary("node");
	f.binary("typescript-language-server");
	writeFileSync(join(f.project, "package.json"), "{}");
	writeFileSync(join(f.project, "index.ts"), "export const value = 1;\n");
	writeFileSync(join(f.project, ".lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { command: "typescript-language-server", fileTypes: [".ts"], rootMarkers: ["package.json"] } } }));
	const before = [tree(f.home), tree(f.project), tree(f.bin)];
	const report = f.inspect(f.project, join(f.project, "index.ts"));
	const result = await probeLspReadiness({ readiness: report, home: f.home, ompPath: f.ompPath, pathEnv: f.bin });
	expect(result.status).toBe("UNVERIFIED");

	expect(existsSync(join(f.root, "executed"))).toBe(false);
	expect([tree(f.home), tree(f.project), tree(f.bin)]).toEqual(before);
});

test("deep LSP refuses a server from another checkout without executing it", async () => {
	const f = fixture();
	f.binary("typescript-language-server");
	mkdirSync(join(f.root, ".git"));
	writeFileSync(join(f.project, "package.json"), "{}");
	writeFileSync(join(f.project, "index.ts"), "export const value = 1;\n");
	const before = tree(f.root);
	const result = await probeLspReadiness({ readiness: f.inspect(), home: f.home, ompPath: f.ompPath, pathEnv: f.bin });
	expect(result.status).toBe("UNVERIFIED");
	expect(existsSync(join(f.root, "executed"))).toBe(false);
	expect(tree(f.root)).toEqual(before);
});

const installedOmp = process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
const nativeLspTest = installedOmp && Bun.which("typescript-language-server") && Bun.which("node") && Bun.which("git") ? test : test.skip;
nativeLspTest("one alternative root marker permits a real cold request and preserves absent alternatives", async () => {
	if (!installedOmp) throw new Error("installed OMP required");
	const f = fixture();
	sourceTreeFor(f.root, installedOmp);
	writeFileSync(join(f.project, "package.json"), "{}");
	const file = join(f.project, "index.ts");
	writeFileSync(file, "export const value = 1;\n");
	mkdirSync(join(f.project, ".omp"));
	writeFileSync(join(f.project, ".omp", "lsp.json"), JSON.stringify({ servers: { "typescript-native": { disabled: true } } }));
	const before = tree(f.root);
	const input = { home: f.home, project: f.project, file, ompPath: installedOmp, pathEnv: process.env.PATH };
	const report = await probeLspReadiness({ ...input, readiness: inspectLspReadiness(input), timeoutMs: 60_000 });
	expect(report.status).toBe("PASS");
	expect(report.elapsed_ms).toBeGreaterThan(0);
	expect(report.checks.known_positive_reference).toBe(true);
	expect(report.checks.server_ready_after_request).toBe(true);
	for (const marker of ["jsconfig.json", "tsconfig.json"]) {
		expect(report.protected_input_snapshots?.before[join(f.project, marker)]).toEqual({ kind: "absent" });
		expect(report.protected_input_snapshots?.after[join(f.project, marker)]).toEqual({ kind: "absent" });
	}
	const references = report.calls.filter(call => call.action === "references").at(-1)?.result;
	expect(references).toContain("src/uses.ts:2:28");
	expect(report.checks.lsp_mux_stopped).toBe(true);
	expect(report.temporary_workspace_removed).toBe(true);
	expect(tree(f.root)).toEqual(before);
	if (process.env.CI === "true") {
		const calls: Array<Record<string, unknown>> = [];
		for (const call of report.calls) {
			const entry: Record<string, unknown> = {
				action: call.action,
				elapsed_ms: call.elapsed_ms ?? null,
			};
			if (call.action === "status") {
				entry.readiness = call.result.includes("Language servers: typescript-language-server (ready)") ? "ready" : "not_ready";
			}
			calls.push(entry);
		}
		const trace: Array<Record<string, unknown>> = [];
		for (const call of report.json_rpc_trace ?? []) {
			trace.push({ method: call.method, id: call.id, elapsed_ms: call.elapsed_ms, result_bytes: call.result_bytes });
		}
		const timing = {
			platform: process.platform,
			status: report.status,
			elapsed_ms: report.elapsed_ms,
			known_positive_reference: report.checks.known_positive_reference,
			server_ready_after_request: report.checks.server_ready_after_request,
			calls,
			json_rpc_trace: report.json_rpc_trace ? trace : null,
		};
		console.log("B10_LSP_TIMING " + JSON.stringify(timing));
	}
}, 90_000);

nativeLspTest("a non-Git parent workspace dependency binary is never launched", async () => {
	if (!installedOmp) throw new Error("installed OMP required");
	let parent = "/tmp";
	if (process.platform === "darwin") {
		const located = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
		expect(located.exitCode).toBe(0);
		parent = located.stdout.toString().trim();
	}
	const f = fixture(realpathSync(parent));
	sourceTreeFor(f.root, installedOmp);
	for (let directory = f.root;;) {
		expect(existsSync(join(directory, ".git"))).toBe(false);
		const ancestor = dirname(directory);
		if (ancestor === directory) break;
		directory = ancestor;
	}
	const dependencyBin = join(f.root, "node_modules", ".bin");
	mkdirSync(dependencyBin, { recursive: true });
	const marker = join(f.root, "workspace-server-started");
	const executable = join(dependencyBin, "typescript-language-server");
	writeFileSync(executable, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); process.exit(23);\n`, { mode: 0o700 });
	writeFileSync(join(f.project, "package.json"), "{}");
	const file = join(f.project, "index.ts");
	writeFileSync(file, "export const value = 1;\n");
	mkdirSync(join(f.project, ".omp"));
	writeFileSync(join(f.project, ".omp", "lsp.json"), JSON.stringify({ servers: { "typescript-native": { disabled: true } } }));
	const input = { home: f.home, project: f.project, file, ompPath: installedOmp, pathEnv: dependencyBin + delimiter + process.env.PATH };
	const readiness = inspectLspReadiness(input);
	expect(server(readiness, "typescript-language-server").eligible).toBe(true);
	expect(server(readiness, "typescript-language-server").resolved_command).toBe(executable);
	const before = tree(f.root);
	const report = await probeLspReadiness({ ...input, readiness });
	expect(report.status).toBe("UNVERIFIED");
	expect(report.omp_rc).toBeNull();
	expect(existsSync(marker)).toBe(false);
	expect(tree(f.root)).toEqual(before);
});
test("OMP_SRC supplies the source tree for a binary-only launcher", () => {
	const f = fixture();
	const macho = join(f.bin, "omp-macho");
	writeFileSync(macho, `#!/bin/sh\nexit 0\n`);
	chmodSync(macho, 0o755);
	const source = join(f.root, "ompsrc");
	mkdirSync(join(source, "src", "lsp"), { recursive: true });
	writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.10.0" }));
	writeFileSync(join(source, "src", "lsp", "defaults.json"), JSON.stringify({
		"typescript-language-server": { command: "typescript-language-server", fileTypes: [".ts"], rootMarkers: ["package.json"] },
	}));
	writeFileSync(join(f.project, "package.json"), "{}");
	writeFileSync(join(f.project, "index.ts"), "export const value = 1;\n");
	f.binary("typescript-language-server");
	const previous = process.env.OMP_SRC;
	process.env.OMP_SRC = source;
	try {
		const report = inspectLspReadiness({ home: f.home, project: f.project, file: join(f.project, "index.ts"), ompPath: macho, pathEnv: f.bin });
		expect(report.opaque_layers).toEqual([]);
		expect(server(report, "typescript-language-server").eligible).toBe(true);
		const usedVersion = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
		expect(usedVersion).toBe("18.10.0");
		console.log(`OMP_SRC-RESOLVED version=${usedVersion} server=typescript-language-server`);
	} finally {
		if (previous === undefined) delete process.env.OMP_SRC;
		else process.env.OMP_SRC = previous;
	}
});

test("planted: OMP_SRC at a wrong package, or clashing with a beside-binary source, refuses", () => {
	const f = fixture();
	const macho = join(f.bin, "omp-macho");
	writeFileSync(macho, `#!/bin/sh\nexit 0\n`);
	chmodSync(macho, 0o755);
	writeFileSync(join(f.project, "package.json"), "{}");
	const previous = process.env.OMP_SRC;
	const other = join(f.root, "other-src");
	mkdirSync(join(other, "src", "lsp"), { recursive: true });
	writeFileSync(join(other, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
	writeFileSync(join(other, "src", "lsp", "defaults.json"), JSON.stringify({}));
	process.env.OMP_SRC = other;
	try {
		const wrong = inspectLspReadiness({ home: f.home, project: f.project, ompPath: macho, pathEnv: f.bin });
		expect(wrong.opaque_layers.length).toBeGreaterThan(0);
	} finally {
		if (previous === undefined) delete process.env.OMP_SRC;
		else process.env.OMP_SRC = previous;
	}
});

test("planted: OMP_SRC clashing with a valid beside-binary source refuses mixed identities", () => {
	const f = fixture();
	const other = join(f.root, "other-src");
	mkdirSync(join(other, "src", "lsp"), { recursive: true });
	writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "9.9.9" }));
	writeFileSync(join(other, "src", "lsp", "defaults.json"), JSON.stringify({
		"typescript-language-server": { command: "typescript-language-server", fileTypes: [".ts"], rootMarkers: ["package.json"] },
	}));
	writeFileSync(join(f.project, "package.json"), "{}");
	const previous = process.env.OMP_SRC;
	process.env.OMP_SRC = other;
	try {
		const report = inspectLspReadiness({ home: f.home, project: f.project, ompPath: join(f.root, "omp", "dist", "cli.js"), pathEnv: f.bin });
		expect(report.opaque_layers.length).toBeGreaterThan(0);
	} finally {
		if (previous === undefined) delete process.env.OMP_SRC;
		else process.env.OMP_SRC = previous;
	}
});

test("planted: isolated cold-refusal inputs stay distinguishable and missing evidence never passes", async () => {
	// Classifier propagation: each refusal mode maps to exactly one state.
	expect(classifyLspProbeOutcome({ timed_out: false, server_missing: false, wrong_marker: false, immediate_exit: false, checks_passed: true })).toBe("PASS");
	expect(classifyLspProbeOutcome({ timed_out: false, server_missing: false, wrong_marker: false, immediate_exit: false, checks_passed: false })).toBe("INCOMPLETE");
	expect(classifyLspProbeOutcome({ timed_out: true, server_missing: false, wrong_marker: false, immediate_exit: false, checks_passed: true })).toBe("TIMEOUT");
	expect(classifyLspProbeOutcome({ timed_out: false, server_missing: true, wrong_marker: false, immediate_exit: false, checks_passed: false })).toBe("MISSING");
	expect(classifyLspProbeOutcome({ timed_out: false, server_missing: false, wrong_marker: true, immediate_exit: false, checks_passed: false })).toBe("WRONG_MARKER");
	expect(classifyLspProbeOutcome({ timed_out: false, server_missing: false, wrong_marker: false, immediate_exit: true, checks_passed: false })).toBe("IMMEDIATE_EXIT");
	// Missing evidence (no checks passed, no refusal signal) is INCOMPLETE, never PASS.
	const missing = classifyLspProbeOutcome({ timed_out: false, server_missing: false, wrong_marker: false, immediate_exit: false, checks_passed: false });
	expect(missing).not.toBe("PASS");
	// Receipt propagation: refusal-shaped retained calls stay bounded, redacted, and
	// distinguishable by method/size; PASS omits the receipt. Deleting propagation fails this test.
	const emptyReferences = "Found 0 reference(s)\n";
	const timeoutText = "lsp references timed out after 60000ms\n";
	const serverExit = "server exited during initialize\n";
	const refusalCalls = [
		{ action: "status", elapsed_ms: 12.5, result: "Language servers: typescript-language-server (configured, not started)" },
		{ action: "capabilities", elapsed_ms: 230.25, result: "typescript-language-server: referencesProvider=true" },
		{ action: "references", elapsed_ms: 60123.75, result: emptyReferences },
	];
	for (const state of ["INCOMPLETE", "TIMEOUT", "IMMEDIATE_EXIT"] as const) {
		const receipt = buildLspJsonRpcReceipt(state, state === "TIMEOUT"
			? [...refusalCalls.slice(0, 2), { action: "references", elapsed_ms: 60123.75, result: timeoutText }]
			: state === "IMMEDIATE_EXIT"
				? [...refusalCalls.slice(0, 1), { action: "capabilities", elapsed_ms: 45.5, result: serverExit }]
				: refusalCalls);
		expect(receipt).toBeDefined();
		expect(receipt!.length).toBeGreaterThan(0);
		expect(receipt!.length).toBeLessThanOrEqual(64);
		for (const entry of receipt!) {
			expect(entry.method.startsWith("lsp/")).toBe(true);
			expect(entry).not.toHaveProperty("result");
			expect(typeof entry.result_bytes).toBe("number");
		}
		expect(receipt!.at(-1)).toMatchObject({ method: state === "IMMEDIATE_EXIT" ? "lsp/capabilities" : "lsp/references" });
	}
	const timeoutReceipt = buildLspJsonRpcReceipt("TIMEOUT", [{ action: "references", elapsed_ms: 1, result: timeoutText }]);
	const exitReceipt = buildLspJsonRpcReceipt("IMMEDIATE_EXIT", [{ action: "capabilities", elapsed_ms: 1, result: serverExit }]);
	expect(timeoutReceipt![0]!.result_bytes).not.toBe(exitReceipt![0]!.result_bytes);
	expect(buildLspJsonRpcReceipt("PASS", refusalCalls)).toBeUndefined();
	// Hermetic probe: no candidate server is MISSING, never PASS, with zeroed readiness timing.
	const report = await probeLspReadiness({
		home: "/nonexistent-home", ompPath: "/nonexistent-omp",
		// A .ts file with no candidate server reaches MISSING before any filesystem use.
		readiness: { status: "UNVERIFIED", cwd: "/tmp", file: "/tmp/lsp-probe-missing-fixture.ts", file_outside_cwd: false, config_layers: [], opaque_layers: [], servers: [], runtime: "NOT_PROBED" },
	});
	expect(report.status).toBe("MISSING");
	expect(report.status).not.toBe("PASS");
	expect(report.elapsed_ms).toBe(0);
});
