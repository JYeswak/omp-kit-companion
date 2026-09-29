import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { YAML } from "bun";
import type { Finding } from "./diagnostics.ts";

export interface ProjectTrustInput {
	project: string;
	/** Version obtained independently from installed OMP package metadata; never starts OMP. */
	ompVersion?: string;
	/** Observed user setting; absence is not proof that project MCP is disabled. */
	userMcpEnabled?: boolean;
}
export interface StartupInput {
	category: "project_extension" | "configured_extension" | "project_tool" | "project_pre_hook" | "project_mcp_config" | "project_mcp_enable_override";
	/** Project-relative known path, never a configured path value or absolute private path. */
	path: string;
	count?: number;
}
export interface ProjectTrustFinding extends Finding {
	component: "project-loading";
	evidence: { inputs: StartupInput[]; uncertain_paths: string[]; omp_version: string | null; version_semantics: "MEASURED_18_3_1" | "UNVERIFIED"; project_mcp: "PROJECT_OVERRIDE_ENABLED" | "USER_DISABLED_NO_OVERRIDE" | "UNVERIFIED" };
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const MAX_CONFIG_BYTES = 1024 * 1024;
const ADVICE = "Do not start OMP with cwd inside an untrusted clone. Start OMP from a trusted directory and inspect the clone as data; a user extension cannot intercept earlier project imports. Review the named paths before intentionally opening the project.";
const CONFIGS = [".omp/config.yml", ".omp/settings.json", ".claude/settings.json"] as const;
const MCP_CONFIGS = [".mcp.json", ".claude/.mcp.json", ".omp/mcp.json"] as const;

type Kind = "missing" | "file" | "directory" | "unsafe";
function kind(path: string): Kind {
	try {
		const stat = lstatSync(path);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return "unsafe";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
	}
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** All intermediate directories are checked independently; symlinks are never followed. */
function safeDirectory(root: string, relative: string): Kind {
	let current = root;
	for (const segment of relative.split("/")) {
		current = join(current, segment);
		const state = kind(current);
		if (state !== "directory") return state === "missing" ? "missing" : "unsafe";
		try {
			const fd = openSync(current, DIRECTORY_FLAGS);
			try { if (!fstatSync(fd).isDirectory() || kind(current) !== "directory") return "unsafe"; }
			finally { closeSync(fd); }
		} catch { return "unsafe"; }
	}
	return "directory";
}
function safeFile(root: string, relative: string): Kind {
	const parts = relative.split("/");
	const parent = parts.slice(0, -1).join("/");
	if (parent) {
		const state = safeDirectory(root, parent);
		if (state !== "directory") return state;
	}
	const path = join(root, ...parts);
	const state = kind(path);
	return state === "file" ? "file" : state === "missing" ? "missing" : "unsafe";
}
function readConfig(root: string, relative: string): Record<string, unknown> {
	if (safeFile(root, relative) !== "file") throw new Error("unsafe config file");
	const path = join(root, relative);
	const fd = openSync(path, FILE_FLAGS);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error("unsafe config size or type");
		const bytes = readFileSync(fd);
		if (bytes.byteLength > MAX_CONFIG_BYTES || safeFile(root, relative) !== "file") throw new Error("config path changed");
		const value: unknown = relative.endsWith(".json") ? JSON.parse(bytes.toString("utf8")) : YAML.parse(bytes.toString("utf8"));
		if (!record(value)) throw new Error("config is not a mapping");
		return value;
	} finally { closeSync(fd); }
}
function entries(root: string, relative: string): string[] {
	if (safeDirectory(root, relative) !== "directory") throw new Error("unsafe directory");
	const path = join(root, relative);
	const fd = openSync(path, DIRECTORY_FLAGS);
	try {
		const initial = fstatSync(fd);
		const names = readdirSync(path);
		const after = fstatSync(fd);
		if (initial.ino !== after.ino || initial.dev !== after.dev || safeDirectory(root, relative) !== "directory" ||
			lstatSync(path).ino !== initial.ino || lstatSync(path).dev !== initial.dev) throw new Error("directory changed during inventory");
		return names.sort();
	} finally { closeSync(fd); }
}

/** Static inventory only. Never imports a project module, runs OMP, or reads a configured target. */
export function inspectProjectTrust(input: ProjectTrustInput): ProjectTrustFinding {
	const inputs: StartupInput[] = [];
	const uncertain = new Set<string>();
	const versionKnown = input.ompVersion === "18.3.1";
	let override = false;
	const project = input.project;
	if (!isAbsolute(project) || kind(project) !== "directory" || safeDirectory("/", project.slice(1)) !== "directory") uncertain.add("<project>");
	else {
		try {
			const fd = openSync(project, DIRECTORY_FLAGS);
			try { if (!fstatSync(fd).isDirectory()) uncertain.add("<project>"); }
			finally { closeSync(fd); }
		} catch { uncertain.add("<project>"); }
	}
	if (!uncertain.has("<project>")) {
		if (safeDirectory(project, ".omp") === "unsafe") uncertain.add(".omp");
		if (safeDirectory(project, ".claude") === "unsafe") uncertain.add(".claude");
		for (const dir of [".omp/extensions", ".omp/hooks/pre", ".omp/tools"] as const) {
			const state = safeDirectory(project, dir);
			if (state === "unsafe") { uncertain.add(dir); continue; }
			if (state === "missing") continue;
			try {
				for (const name of entries(project, dir)) {
					if (dir === ".omp/tools") {
						const tool = `${dir}/${name}`;
						const toolState = safeDirectory(project, tool);
						if (toolState === "unsafe") { uncertain.add(tool); continue; }
						if (toolState === "missing") continue;
						const index = `${tool}/index.ts`;
						const fileState = safeFile(project, index);
						if (fileState === "file") inputs.push({ category: "project_tool", path: index });
						else if (fileState === "unsafe") uncertain.add(index);
					} else if (name.endsWith(".ts")) {
						const file = `${dir}/${name}`;
						const fileState = safeFile(project, file);
						if (fileState === "file") inputs.push({ category: dir === ".omp/extensions" ? "project_extension" : "project_pre_hook", path: file });
						else if (fileState === "unsafe") uncertain.add(file);
					}
				}
			} catch { uncertain.add(dir); }
		}
		for (const config of CONFIGS) {
			const state = safeFile(project, config);
			if (state === "missing") continue;
			if (state === "unsafe") { uncertain.add(config); continue; }
			try {
				const data = readConfig(project, config);
				const extensions = data.extensions;
				if (extensions !== undefined) {
					if (!Array.isArray(extensions) || !extensions.every((entry) => typeof entry === "string")) uncertain.add(`${config}#extensions`);
					else if (extensions.length) inputs.push({ category: "configured_extension", path: `${config}#extensions`, count: extensions.length });
				}
				const mcp = data.mcp;
				if (mcp !== undefined && !record(mcp)) uncertain.add(`${config}#mcp.enableProjectConfig`);
				else if (record(mcp) && Object.hasOwn(mcp, "enableProjectConfig")) {
					if (typeof mcp.enableProjectConfig !== "boolean") uncertain.add(`${config}#mcp.enableProjectConfig`);
					else if (mcp.enableProjectConfig === true) {
						override = true;
						inputs.push({ category: "project_mcp_enable_override", path: `${config}#mcp.enableProjectConfig` });
					}
				}
			} catch { uncertain.add(config); }
		}
		for (const config of MCP_CONFIGS) {
			const state = safeFile(project, config);
			if (state === "file") {
				inputs.push({ category: "project_mcp_config", path: config });
				try { readConfig(project, config); }
				catch { uncertain.add(config); }
			}
			else if (state === "unsafe") uncertain.add(config);
		}
	}
	inputs.sort((a, b) => a.path.localeCompare(b.path) || a.category.localeCompare(b.category));
	const uncertainPaths = [...uncertain].sort();
	const unverified = !versionKnown || uncertainPaths.length > 0;
	const reason = [
		inputs.length ? `${inputs.length} known project startup input(s) detected${override && input.userMcpEnabled === false ? "; project settings override the disabled user MCP setting" : ""}` : "no known startup inputs detected (not a safety certificate)",
		!versionKnown ? "OMP version startup/config semantics UNVERIFIED" : "",
		uncertainPaths.length ? "opaque or unsafe project paths UNVERIFIED" : "",
	].filter(Boolean).join("; ");
	return {
		component: "project-loading",
		status: unverified ? "UNVERIFIED" : inputs.length ? "DEGRADED" : "UNVERIFIED",
		reason,
		recommended_action: ADVICE,
		evidence: {
			inputs, uncertain_paths: uncertainPaths, omp_version: versionKnown ? input.ompVersion! : null,
			version_semantics: versionKnown ? "MEASURED_18_3_1" : "UNVERIFIED",
			project_mcp: versionKnown && !uncertainPaths.length && override ? "PROJECT_OVERRIDE_ENABLED" :
				versionKnown && !uncertainPaths.length && input.userMcpEnabled === false ? "USER_DISABLED_NO_OVERRIDE" : "UNVERIFIED",
		},
	};
}
