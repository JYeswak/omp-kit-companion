import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inspectProjectTrust } from "../../src/project-trust.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	const root = mkdtempSync(join(base, "project-trust-"));
	roots.push(root);
	const project = join(root, "project");
	const home = join(root, "home");
	mkdirSync(project);
	mkdirSync(home);
	return { root, project, home };
}
function tree(path: string, prefix = ""): string[] {
	return readdirSync(path).sort().flatMap((name) => {
		const full = join(path, name);
		const relative = join(prefix, name);
		const stat = lstatSync(full);
		return stat.isSymbolicLink() ? [`${relative}:symlink`] : stat.isDirectory() ? [`${relative}:dir:${stat.mode & 0o777}`, ...tree(full, relative)] : [`${relative}:file:${stat.mode & 0o777}:${readFileSync(full).toString("hex")}`];
	});
}

// Catches a missing project-extension scan, execution during inventory, leaking absolute paths and treating clean as trusted.
test("hazardous project extension and MCP enable override surface without importing project code", () => {
	const f = fixture();
	mkdirSync(join(f.project, ".omp", "extensions"), { recursive: true });
	const sentinel = join(f.root, "EXECUTED");
	writeFileSync(join(f.project, ".omp", "extensions", "plant.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);
	writeFileSync(join(f.project, ".omp", "config.yml"), "mcp:\n  enableProjectConfig: true\nextensions:\n  - ./scripts/private-extension.ts\n");
	writeFileSync(join(f.project, ".omp", "mcp.json"), "{\"mcpServers\":{\"plant\":{\"command\":\"false\"}}}");
	const beforeProject = tree(f.project), beforeHome = tree(f.home);
	const result = inspectProjectTrust({ project: f.project, ompVersion: "18.3.1", userMcpEnabled: false });
	expect(result.status).toBe("DEGRADED");
	expect(result.evidence?.inputs).toEqual(expect.arrayContaining([
		{ category: "project_extension", path: ".omp/extensions/plant.ts" },
		{ category: "configured_extension", path: ".omp/config.yml#extensions", count: 1 },
		{ category: "project_mcp_config", path: ".omp/mcp.json" },
		{ category: "project_mcp_enable_override", path: ".omp/config.yml#mcp.enableProjectConfig" },
	]));
	expect(result.reason).toContain("override");
	expect(result.recommended_action).toContain("trusted directory");
	expect(result.recommended_action).not.toContain("guard extension");
	expect(JSON.stringify(result)).not.toContain(f.root);
	expect(JSON.stringify(result)).not.toContain("private-extension.ts");
	expect(existsSync(sentinel)).toBe(false);
	expect(tree(f.project)).toEqual(beforeProject);
	expect(tree(f.home)).toEqual(beforeHome);
});

// Catches accidental promotion of an empty known-input inventory into a trust certificate.
test("clean project is not certified safe or trusted", () => {
	const f = fixture();
	const result = inspectProjectTrust({ project: f.project, ompVersion: "18.3.1", userMcpEnabled: false });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.reason).toContain("no known startup inputs detected");
	expect(result.reason.toLowerCase()).not.toContain("trusted");
	expect(result.evidence?.inputs).toEqual([]);
	expect(result.recommended_action).toContain("untrusted clone");
});

// Catches omission of other known import points and alternate MCP/settings files.
test("project tool and pre-hook imports, alternate MCP sources and JSON settings are inventoried", () => {
	const f = fixture();
	mkdirSync(join(f.project, ".omp", "tools", "named"), { recursive: true });
	mkdirSync(join(f.project, ".omp", "hooks", "pre"), { recursive: true });
	mkdirSync(join(f.project, ".claude"));
	writeFileSync(join(f.project, ".omp", "tools", "named", "index.ts"), "export {};");
	writeFileSync(join(f.project, ".omp", "hooks", "pre", "before.ts"), "export {};");
	writeFileSync(join(f.project, ".claude", ".mcp.json"), "{}");
	writeFileSync(join(f.project, ".mcp.json"), "{}");
	writeFileSync(join(f.project, ".claude", "settings.json"), JSON.stringify({ mcp: { enableProjectConfig: true } }));
	const result = inspectProjectTrust({ project: f.project, ompVersion: "18.3.1", userMcpEnabled: false });
	expect(result.evidence?.inputs).toEqual(expect.arrayContaining([
		{ category: "project_tool", path: ".omp/tools/named/index.ts" },
		{ category: "project_pre_hook", path: ".omp/hooks/pre/before.ts" },
		{ category: "project_mcp_config", path: ".claude/.mcp.json" },
		{ category: "project_mcp_config", path: ".mcp.json" },
		{ category: "project_mcp_enable_override", path: ".claude/settings.json#mcp.enableProjectConfig" },
	]));
});

// Catches following symlinked directories or files out of the selected checkout.
test("symlinked project paths remain unverified without reading outside", () => {
	const f = fixture();
	const outside = join(f.root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "config.yml"), "mcp:\n  enableProjectConfig: true\n");
	symlinkSync(outside, join(f.project, ".omp"));
	const result = inspectProjectTrust({ project: f.project, ompVersion: "18.3.1", userMcpEnabled: false });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.evidence?.uncertain_paths).toContain(".omp");
	expect(result.evidence?.inputs).not.toEqual(expect.arrayContaining([{ category: "project_mcp_enable_override", path: ".omp/config.yml#mcp.enableProjectConfig" }]));
	expect(JSON.stringify(result)).not.toContain(f.root);
});

// Catches assuming a present file can be parsed/evaluated or that later OMP versions retain measured semantics.
test("opaque settings and unknown OMP version cannot certify effective MCP behavior", () => {
	const f = fixture();
	mkdirSync(join(f.project, ".omp"));
	writeFileSync(join(f.project, ".omp", "config.yml"), "mcp: [\n");

	writeFileSync(join(f.project, ".omp", "mcp.json"), "{}");
	const result = inspectProjectTrust({ project: f.project, ompVersion: "18.4.0", userMcpEnabled: false });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.evidence?.inputs).toContainEqual({ category: "project_mcp_config", path: ".omp/mcp.json" });
	expect(result.evidence?.uncertain_paths).toContain(".omp/config.yml");
	expect(result.reason).toContain("version");
});
// Catches treating an unreadable project MCP definition as verified merely because its filename exists.
test("opaque MCP config and symlinked extension file remain unverified without following either", () => {
	const f = fixture();
	mkdirSync(join(f.project, ".omp", "extensions"), { recursive: true });
	writeFileSync(join(f.project, ".omp", "mcp.json"), "{invalid");
	const outside = join(f.root, "outside.ts");
	writeFileSync(outside, "throw new Error('must not import');");
	symlinkSync(outside, join(f.project, ".omp", "extensions", "escape.ts"));
	const result = inspectProjectTrust({ project: f.project, ompVersion: "18.3.1", userMcpEnabled: false });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.evidence?.uncertain_paths).toEqual(expect.arrayContaining([".omp/mcp.json", ".omp/extensions/escape.ts"]));
	expect(result.evidence?.inputs).toContainEqual({ category: "project_mcp_config", path: ".omp/mcp.json" });
	expect(JSON.stringify(result)).not.toContain(f.root);
});

test("a symlinked selected project root is not traversed", () => {
	const f = fixture();
	const link = join(f.root, "linked");
	symlinkSync(f.project, link);
	const result = inspectProjectTrust({ project: link, ompVersion: "18.3.1" });
	expect(result.status).toBe("UNVERIFIED");
	expect(result.evidence?.uncertain_paths).toContain("<project>");
});
