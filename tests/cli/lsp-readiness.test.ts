import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inspectLspReadiness, planLspSetup, type LspReadinessReport } from "../../src/lsp-readiness.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "lsp-readiness-"));
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
