#!/usr/bin/env bun
/**
 * context-inventory.ts — capability listing-cost report and required-capability
 * check through OMP's own loaders (Settings.loadReadOnly, loadSkills,
 * loadCapability skills/rules/tools/mcps, loadProjectContextFiles, the LSP
 * config resolver, and the skill:// protocol handler for serve proofs).
 *
 * Read-only by construction: settings load read-only, the skill description
 * catalog is never opened (previewSkillDescription is pure), and no MCP
 * server or language server is started.
 *
 * Two processes: the parent validates arguments and re-executes itself as
 * --inventory-child with the inspected HOME/profile/XDG identity, because
 * OMP resolves its directories at module load. OMP modules are imported
 * dynamically from the runtime-selected OMP_SRC after the identity is fixed;
 * static imports cannot work because the source directory is only known here.
 *
 * Usage:
 *   bun scripts/context-inventory.ts --home DIR [--profile NAME] --project DIR
 *     --mode inventory [--timeout-ms N]
 *   bun scripts/context-inventory.ts --home DIR [--profile NAME] --project DIR
 *     --mode check --capabilities ABS_FILE [--timeout-ms N]
 * Output: one compact JSON envelope on stdout; diagnostics on stderr.
 * Exit: 0 inventory/check completed (check reports PASS/FAIL in-band);
 *   2 invalid invocation/input; 3 harness unavailable or timed out.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";

const fail = (code: number, reason: string, detail?: string): never => {
	console.log(JSON.stringify({ status: "UNAVAILABLE", scope: "CONTEXT_INVENTORY", reason, ...(detail ? { detail } : {}) }));
	process.exit(code);
	throw new Error("unreachable");
};

const option = (flag: string): string => {
	const index = process.argv.indexOf(flag);
	return index < 0 ? "" : (process.argv[index + 1] ?? "");
};

const CHILD = "--inventory-child";

function parent(): void {
	const home = option("--home");
	const profile = option("--profile") || "default";
	const project = option("--project");
	const mode = option("--mode");
	const capabilitiesPath = option("--capabilities");
	const rawTimeout = option("--timeout-ms");
	if (!home || !isAbsolute(home)) fail(2, "INVALID_HOME", "--home requires an absolute directory");
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith(".")) {
		fail(2, "INVALID_PROFILE", "Profile names match OMP profile rules without path separators");
	}
	if (!project || !isAbsolute(project)) fail(2, "INVALID_PROJECT", "--project requires an absolute directory");
	if (mode !== "inventory" && mode !== "check") fail(2, "INVALID_MODE", "--mode must be inventory or check");
	if (mode === "check" && (!capabilitiesPath || !isAbsolute(capabilitiesPath))) {
		fail(2, "INVALID_CAPABILITIES", "--mode check requires an absolute --capabilities JSON file");
	}
	const timeoutMs = rawTimeout === "" ? 120_000 : Number(rawTimeout);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 600_000) {
		fail(2, "INVALID_TIMEOUT", "--timeout-ms must be 5000..600000");
	}
	let entry: string;
	try {
		entry = realpathSync(process.argv[1] ?? "");
		if (!statSync(entry).isFile()) throw new Error("not a file");
	} catch {
		fail(2, "INVALID_ENTRYPOINT", "Harness entrypoint is not a resolvable file");
	}
	const args = [entry, "--home", home, "--profile", profile, "--project", project,
		"--mode", mode, "--timeout-ms", String(timeoutMs), CHILD];
	if (mode === "check") args.splice(args.length - 1, 0, "--capabilities", capabilitiesPath);
	const childEnv: Record<string, string> = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "NO_COLOR"] as const) {
		const value = process.env[key];
		if (value !== undefined) childEnv[key] = value;
	}
	const ompSrc = process.env.OMP_SRC;
	if (ompSrc) childEnv.OMP_SRC = ompSrc;
	childEnv.HOME = home;
	childEnv.XDG_CONFIG_HOME = join(home, ".config");
	childEnv.XDG_DATA_HOME = join(home, ".local", "share");
	childEnv.XDG_STATE_HOME = join(home, ".local", "state");
	const cache = process.env.XDG_CACHE_HOME;
	if (cache) childEnv.XDG_CACHE_HOME = cache;
	childEnv.BUN_BE_BUN = "1";
	if (profile !== "default") childEnv.OMP_PROFILE = profile;
	const child = spawnSync(process.execPath, args, { env: childEnv, encoding: "utf-8", timeout: timeoutMs + 30_000, maxBuffer: 64 * 1024 * 1024 });
	if (child.error) fail(3, "HARNESS_FAILED", `Inventory child did not run: ${String(child.error).slice(0, 200)}`);
	const stdout = typeof child.stdout === "string" ? child.stdout : "";
	process.stdout.write(stdout);
	if (child.status !== 0) process.exit(typeof child.status === "number" ? child.status : 3);
}

const bytesOf = (value: string): number => Buffer.byteLength(value, "utf-8");

interface SkillRow {
	name: string;
	description: string;
	hide: boolean;
	source: string;
	filePath: string;
	listed_bytes: number;
}

async function childMain(): Promise<void> {
	const project = option("--project");
	const mode = option("--mode");
	const capabilitiesPath = option("--capabilities");
	const ompSrc = process.env.OMP_SRC ?? "";
	if (!ompSrc) fail(2, "INVALID_OMP_SRC", "OMP_SRC is required to load OMP modules");
	const { Settings } = await import(join(ompSrc, "config/settings.ts"));
	const skillSettings = await import(join(ompSrc, "extensibility/settings.ts"));
	const lspSettings = await import(join(ompSrc, "lsp/settings.ts"));
	const skillsExt = await import(join(ompSrc, "extensibility/skills.ts"));
	const skillDescriptions = await import(join(ompSrc, "extensibility/skill-descriptions.ts"));
	const capabilityIndex = await import(join(ompSrc, "capability/index.ts"));
	const sysPrompt = await import(join(ompSrc, "system-prompt.ts"));
	const toolNames = await import(join(ompSrc, "tools/builtin-names.ts"));
	const lspConfig = await import(join(ompSrc, "lsp/config.ts"));
	const lspServers = await import(join(ompSrc, "lsp/servers.ts"));
	const skillProtocol = await import(join(ompSrc, "internal-urls/skill-protocol.ts"));
	const urlParse = await import(join(ompSrc, "internal-urls/parse.ts"));

	const settings = await Settings.loadReadOnly({ cwd: project });
	const knob = (handle: { get: (s: unknown) => unknown }, fallback: unknown): unknown => {
		try {
			return handle.get(settings);
		} catch {
			return fallback;
		}
	};
	const knobs = {
		enabled: knob(skillSettings.cfgSkillsEnabled, true),
		includeSkills: knob(skillSettings.cfgSkillsIncludeSkills, []),
		ignoredSkills: knob(skillSettings.cfgSkillsIgnoredSkills, []),
		customDirectories: knob(skillSettings.cfgSkillsCustomDirectories, []),
		enableSkillCommands: knob(skillSettings.cfgSkillsEnableSkillCommands, true),
		enableCodexUser: knob(skillSettings.cfgSkillsEnableCodexUser, false),
		enableClaudeUser: knob(skillSettings.cfgSkillsEnableClaudeUser, false),
		enableClaudeProject: knob(skillSettings.cfgSkillsEnableClaudeProject, true),
		enablePiUser: knob(skillSettings.cfgSkillsEnablePiUser, true),
		enablePiProject: knob(skillSettings.cfgSkillsEnablePiProject, true),
		enableAgentsUser: knob(skillSettings.cfgSkillsEnableAgentsUser, true),
		enableAgentsProject: knob(skillSettings.cfgSkillsEnableAgentsProject, true),
		disabledExtensions: knob(skillSettings.cfgDisabledExtensions, []),
		lspEnabled: knob(lspSettings.cfgLspEnabled, true),
	};
	const asStringArray = (value: unknown): string[] =>
		Array.isArray(value) && value.every(item => typeof item === "string") ? (value as string[]) : [];
	const asBoolean = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;

	const skillOptions = {
		cwd: project,
		enabled: asBoolean(knobs.enabled, true),
		includeSkills: asStringArray(knobs.includeSkills),
		ignoredSkills: asStringArray(knobs.ignoredSkills),
		customDirectories: asStringArray(knobs.customDirectories),
		enableSkillCommands: asBoolean(knobs.enableSkillCommands, true),
		enableCodexUser: asBoolean(knobs.enableCodexUser, false),
		enableClaudeUser: asBoolean(knobs.enableClaudeUser, false),
		enableClaudeProject: asBoolean(knobs.enableClaudeProject, true),
		enablePiUser: asBoolean(knobs.enablePiUser, true),
		enablePiProject: asBoolean(knobs.enablePiProject, true),
		enableAgentsUser: asBoolean(knobs.enableAgentsUser, true),
		enableAgentsProject: asBoolean(knobs.enableAgentsProject, true),
		disabledExtensions: asStringArray(knobs.disabledExtensions),
	};
	const active = await skillsExt.loadSkills(skillOptions);
	const discovered = await capabilityIndex.loadCapability("skills", { cwd: project, includeDisabled: true });
	const discoveredNames = new Set<string>(((discovered.all ?? []) as { name: string }[]).map(item => item.name));
	const activeByName = new Map<string, (typeof active.skills)[number]>();
	for (const skill of active.skills) activeByName.set(skill.name, skill);

	const handler = new skillProtocol.SkillProtocolHandler();
	const served = async (name: string): Promise<boolean> => {
		try {
			const url = urlParse.parseInternalUrl(`skill://${name}`);
			return (await handler.locate(url, { skills: active.skills })) !== null;
		} catch {
			return false;
		}
	};

	const listed: SkillRow[] = [];
	let hiddenCount = 0;
	const hiddenNames: string[] = [];
	for (const skill of active.skills) {
		const description = typeof skill.description === "string" ? skill.description : "";
		if (skill.hide === true) {
			hiddenCount += 1;
			hiddenNames.push(skill.name);
			continue;
		}
		const preview = skillDescriptions.previewSkillDescription(description);
		listed.push({ name: skill.name, description: preview, hide: false,
			source: typeof skill.source === "string" ? skill.source : "unknown",
			filePath: typeof skill.filePath === "string" ? skill.filePath : "",
			listed_bytes: bytesOf(skill.name) + bytesOf(preview) });
	}
	listed.sort((a, b) => a.name.localeCompare(b.name));
	const listedBytes = listed.reduce((sum: number, row: SkillRow) => sum + row.listed_bytes, 0);

	const contextFiles = await sysPrompt.loadProjectContextFiles({ cwd: project });
	const contextRows = (contextFiles as { path: string; content?: string }[]).map(file => ({
		path: file.path, bytes: bytesOf(file.content ?? ""),
	}));
	const contextBytes = contextRows.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0);

	const ruleCaps = await capabilityIndex.loadCapability("rules", { cwd: project, includeDisabled: true });
	const ruleRows: { name: string; path: string; bytes: number | null }[] = [];
	for (const rule of (ruleCaps.all ?? []) as { name: string; path?: string; filePath?: string }[]) {
		const candidate = typeof rule.path === "string" ? rule.path : (typeof rule.filePath === "string" ? rule.filePath : "");
		let size: number | null = null;
		try {
			if (candidate && existsSync(candidate) && statSync(candidate).isFile()) size = readFileSync(candidate).length;
		} catch {
			size = null;
		}
		ruleRows.push({ name: rule.name, path: candidate, bytes: size });
	}
	ruleRows.sort((a, b) => a.name.localeCompare(b.name));
	const ruleBytes = ruleRows.reduce((sum: number, row: { bytes: number | null }) => sum + (row.bytes ?? 0), 0);
	const ruleBytesKnown = ruleRows.every(row => row.bytes !== null);

	const toolCaps = await capabilityIndex.loadCapability("tools", { cwd: project, includeDisabled: true });
	const customTools = ((toolCaps.all ?? []) as { name: string }[]).map(item => item.name).sort();
	const mcpCaps = await capabilityIndex.loadCapability("mcps", { cwd: project, includeDisabled: true });
	const mcpServers = ((mcpCaps.all ?? []) as { name: string; enabled?: boolean; state?: string }[]).map(item => ({
		name: item.name,
		state: typeof item.state === "string" ? item.state : (item.enabled === false ? "disabled" : "declared"),
	})).sort((a, b) => a.name.localeCompare(b.name));
	const builtinTools = [...(toolNames.BUILTIN_TOOL_NAMES ?? [])].sort();
	const hiddenTools = [...(toolNames.HIDDEN_TOOL_NAMES ?? [])].sort();

	const lspConfigLoaded = lspConfig.loadConfig(project);
	const probeFiles: Record<string, string> = {
		typescript: "probe.ts", javascript: "probe.js", python: "probe.py", rust: "probe.rs",
		go: "probe.go", json: "probe.json", html: "probe.html", css: "probe.css", bash: "probe.sh",
	};
	const lspLanguages: Record<string, string[]> = {};
	for (const [language, file] of Object.entries(probeFiles)) {
		try {
			const servers = lspServers.getLspServersForFile(lspConfigLoaded, join(project, file)) as [string, unknown][];
			lspLanguages[language] = servers.map(([name]) => name);
		} catch {
			lspLanguages[language] = [];
		}
	}

	const inventory = {
		status: "OK" as const,
		scope: "CONTEXT_INVENTORY",
		project,
		knobs,
		skills: {
			active: active.skills.length,
			listed: listed.length,
			listed_bytes: listedBytes,
			hidden: hiddenCount,
			hidden_names: hiddenNames.sort(),
			discovered: discoveredNames.size,
			rows: listed,
		},
		context_files: { count: contextRows.length, bytes: contextBytes, rows: contextRows },
		rules: { count: ruleRows.length, bytes: ruleBytes, bytes_known: ruleBytesKnown, rows: ruleRows },
		tools: {
			builtin: builtinTools.length,
			builtin_names: builtinTools,
			hidden_builtin_names: hiddenTools,
			custom: customTools,
			mcp_servers: mcpServers,
			inline_descriptors: "UNVERIFIED",
			inline_descriptors_reason: "Inline tool descriptor bytes need a live session tool set; static counts above are exact.",
		},
		lsp: { enabled: knobs.lspEnabled, languages: lspLanguages },
	};

	if (mode === "inventory") {
		console.log(JSON.stringify(inventory));
		return;
	}
	const raw = readFileSync(capabilitiesPath, "utf-8");
	let declared: unknown;
	try {
		declared = JSON.parse(raw);
	} catch {
		fail(2, "INVALID_CAPABILITIES", "Capabilities file is not valid JSON");
	}
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	if (!isRecord(declared) || !Object.keys(declared).every(key =>
		["schema_version", "skills", "tools", "rules", "lsp"].includes(key))) {
		fail(2, "INVALID_CAPABILITIES", "Capabilities file allows only schema_version, skills, tools, rules, lsp");
	}
	if (declared.schema_version !== 1) fail(2, "INVALID_CAPABILITIES", "Capabilities schema_version must be 1");
	const stringList = (value: unknown, field: string): string[] => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
			fail(2, "INVALID_CAPABILITIES", `Capabilities field ${field} must be an array of strings`);
		}
		return value as string[];
	};
	const want = {
		skills: stringList(declared.skills, "skills"),
		tools: stringList(declared.tools, "tools"),
		rules: stringList(declared.rules, "rules"),
		lsp: stringList(declared.lsp, "lsp"),
	};
	type Verdict = { kind: string; name: string; status: "RESOLVED" | "HIDDEN_BUT_READABLE" | "MISSING"; detail: string };
	const verdicts: Verdict[] = [];
	for (const name of want.skills) {
		const skill = activeByName.get(name);
		if (skill && skill.hide !== true) {
			const ok = await served(name);
			verdicts.push({ kind: "skill", name, status: ok ? "RESOLVED" : "MISSING",
				detail: ok ? "Listed in the prompt and served on read" : "Listed but the skill:// read path did not resolve it" });
		} else if (skill) {
			const ok = await served(name);
			verdicts.push({ kind: "skill", name, status: ok ? "HIDDEN_BUT_READABLE" : "MISSING",
				detail: ok ? "Hidden from the listing (hide: true) but served on read" : "Hidden and not served on read" });
		} else if (discoveredNames.has(name)) {
			const ok = await served(name);
			verdicts.push({ kind: "skill", name, status: ok ? "HIDDEN_BUT_READABLE" : "MISSING",
				detail: ok ? "Filtered from the active set but still served on read" : "Discovered but filtered from the active set (ignoredSkills, includeSkills, source toggle, or disabled) and not served" });
		} else {
			verdicts.push({ kind: "skill", name, status: "MISSING", detail: "Not discovered by OMP in this profile and cwd" });
		}
	}
	const builtinSet = new Set(builtinTools);
	const hiddenSet = new Set(hiddenTools);
	const customSet = new Set(customTools);
	const mcpByName = new Map(mcpServers.map(server => [server.name, server.state]));
	for (const name of want.tools) {
		if (hiddenSet.has(name)) {
			verdicts.push({ kind: "tool", name, status: "HIDDEN_BUT_READABLE", detail: "Builtin hidden tool: constructed but not listed" });
		} else if (builtinSet.has(name) || customSet.has(name)) {
			verdicts.push({ kind: "tool", name, status: "RESOLVED", detail: "Builtin or extension-provided tool name" });
		} else if (name.startsWith("mcp:")) {
			const server = name.slice(4);
			const state = mcpByName.get(server);
			verdicts.push(state === undefined
				? { kind: "tool", name, status: "MISSING", detail: "No declared MCP server by this name" }
				: { kind: "tool", name, status: "RESOLVED", detail: `Declared MCP server (state ${state}); tools resolve at session start, servers are never started by this check` });
		} else {
			verdicts.push({ kind: "tool", name, status: "MISSING",
				detail: "No builtin, extension, or mcp:server tool by this name; MCP tool names need a live session" });
		}
	}
	const ruleNames = new Set(ruleRows.map(row => row.name));
	for (const name of want.rules) {
		verdicts.push(ruleNames.has(name)
			? { kind: "rule", name, status: "RESOLVED", detail: "Discovered by OMP rule loading" }
			: { kind: "rule", name, status: "MISSING", detail: "Not discovered by OMP rule loading in this profile and cwd" });
	}
	for (const language of want.lsp) {
		const servers = (lspLanguages as Record<string, string[]>)[language];
		if (servers === undefined) {
			verdicts.push({ kind: "lsp", name: language, status: "MISSING",
				detail: `Unknown language key (known: ${Object.keys(probeFiles).sort().join(", ")})` });
		} else if (servers.length > 0) {
			verdicts.push({ kind: "lsp", name: language, status: "RESOLVED", detail: `Servers: ${servers.join(", ")}` });
		} else {
			verdicts.push({ kind: "lsp", name: language, status: "MISSING", detail: "OMP resolves no language server for this language here" });
		}
	}
	const missing = verdicts.filter(item => item.status === "MISSING").length;
	console.log(JSON.stringify({ ...inventory, scope: "CAPABILITY_CHECK",
		overall: missing === 0 ? "PASS" : "FAIL", missing, capabilities: verdicts }));
}

if (process.argv.includes(CHILD)) {
	const rawTimeout = option("--timeout-ms");
	const timeoutMs = rawTimeout === "" ? 120_000 : Number(rawTimeout);
	const alarm = setTimeout(() => fail(3, "TIMEOUT", "Context inventory exceeded its budget"), timeoutMs);
	childMain().then(
		() => clearTimeout(alarm),
		(error) => {
			clearTimeout(alarm);
			console.error(String(error?.stack ?? error));
			fail(3, "HARNESS_FAILED", String(error?.message ?? error).slice(0, 300));
		},
	);
} else {
	parent();
}
