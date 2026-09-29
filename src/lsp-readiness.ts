import { constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { YAML } from "bun";

export interface LspReadinessInput {
	/** The session cwd OMP will use, never derived from the requested file. */
	project: string;
	home: string;
	file?: string;
	ompPath?: string;
	pathEnv?: string;
	platform?: NodeJS.Platform;
}
export interface LspServerReadiness {
	name: string;
	configured: boolean;
	config_source: string;
	command: string;
	resolved_command: string | null;
	executable_found: boolean;
	root_markers: string[];
	file_types: string[];
	disabled: boolean;
	eligible: boolean;
	status: "DEGRADED" | "UNVERIFIED";
	runtime: "NOT_PROBED";
	reason: string;
	recommended_action: string;
}
export interface LspReadinessReport {
	status: "DEGRADED" | "UNVERIFIED";
	cwd: string;
	file: string | null;
	file_outside_cwd: boolean;
	config_layers: string[];
	opaque_layers: string[];
	servers: LspServerReadiness[];
	runtime: "NOT_PROBED";
}
export interface LspSetupInstruction {
	server: string;
	status: "MANUAL" | "UNSUPPORTED";
	command: string | null;
	note: string;
}
export interface LspSetupPlan { report: LspReadinessReport; instructions: LspSetupInstruction[] }

interface ServerConfig { command: string; fileTypes: string[]; rootMarkers: string[]; disabled: boolean }
interface Layer { path: string; servers: Record<string, unknown> }
const FILENAMES = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
// Only the commands verified on macOS in the local handoff, not universal defaults.
const MACOS_MANUAL: Record<string, string> = {
	marksman: "brew install marksman",
	bashls: "brew install bash-language-server",
	yamlls: "brew install yaml-language-server",
	"vscode-html-language-server": "brew install vscode-langservers-extracted",
	"vscode-css-language-server": "brew install vscode-langservers-extracted",
	"vscode-json-language-server": "brew install vscode-langservers-extracted",
	taplo: "brew install taplo",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}
function normalize(raw: Record<string, unknown>): ServerConfig | null {
	const fileTypes = strings(raw.fileTypes);
	const legacy = isRecord(raw.extensionToLanguage) ? Object.keys(raw.extensionToLanguage) : [];
	const rootMarkers = strings(raw.rootMarkers);
	if (typeof raw.command !== "string" || raw.command.length === 0 || (!fileTypes.length && !legacy.length) || (!rootMarkers.length && !legacy.length)) return null;
	return { command: raw.command, fileTypes: fileTypes.length ? fileTypes : legacy, rootMarkers: rootMarkers.length ? rootMarkers : ["."], disabled: Boolean(raw.disabled) };
}
function readableFile(path: string): boolean {
	try { return lstatSync(path).isFile(); } catch { return false; }
}
function parseLayer(path: string): Layer | null {
	const value: unknown = /\.ya?ml$/.test(path) ? YAML.parse(readFileSync(path, "utf8")) : JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(value)) return null;
	const raw = isRecord(value.servers) ? value.servers : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs"));
	if (!isRecord(raw)) return null;
	return { path, servers: raw };
}
function configCandidates(home: string, cwd: string): string[] {
	// Ordered low to high, matching OMP's reverse(getConfigSources(cwd)).
	const locations = [home, ...[".gemini", ".codex", ".claude", ".omp/agent"].map(dir => join(home, dir)),
		...[".gemini", ".codex", ".claude", ".omp"].map(dir => join(cwd, dir)), cwd];
	return locations.flatMap(dir => [...FILENAMES].reverse().map(file => join(dir, file)));
}
function defaults(ompPath: string | undefined): { path: string; servers: Record<string, unknown> } | null {
	if (!ompPath) return null;
	try {
		const root = dirname(dirname(realpathSync(ompPath)));
		const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as unknown;
		if (!isRecord(metadata) || metadata.name !== "@oh-my-pi/pi-coding-agent") return null;
		const path = join(root, "src", "lsp", "defaults.json");
		if (!readableFile(path)) return null;
		const servers = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isRecord(servers) ? { path, servers } : null;
	} catch { return null; }
}
function markersAtCwd(cwd: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	return markers.some(marker => {
		// OMP checks markers in exactly the session cwd, not each ancestor of file.
		if (marker.includes("*")) {
			try { entries ??= readdirSync(cwd); return entries.some(entry => new Bun.Glob(marker).match(entry)); }
			catch { return false; }
		}
		return existsSync(join(cwd, marker));
	});
}
function fileMatches(file: string | null, types: string[]): boolean {
	if (!file) return false;
	const extension = extname(file).toLowerCase();
	const filename = basename(file).toLowerCase();
	return types.some(type => {
		const normalized = type.toLowerCase();
		const bare = normalized.startsWith(".") ? normalized.slice(1) : normalized;
		return normalized === extension || normalized === filename || bare === extension.slice(1) || bare === filename;
	});
}
function executable(command: string, cwd: string, pathEnv: string): string | null {
	if (command.includes("/") && !isAbsolute(command)) return null;
	const candidates: string[] = [];
	if (isAbsolute(command)) candidates.push(command);
	else {
		// OMP looks in project-local bins before PATH, conditioned on marker presence.
		if (markersAtCwd(cwd, ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"])) candidates.push(join(cwd, "node_modules", ".bin", command));
		if (markersAtCwd(cwd, ["pyproject.toml", "ty.toml", "requirements.txt", "setup.py", "Pipfile"])) for (const dir of [".venv/bin", ".venv/Scripts", "venv/bin", "venv/Scripts", ".env/bin", ".env/Scripts"]) candidates.push(join(cwd, dir, command));
		if (markersAtCwd(cwd, ["Gemfile", "Gemfile.lock"])) for (const dir of ["vendor/bundle/bin", "bin"]) candidates.push(join(cwd, dir, command));
		if (markersAtCwd(cwd, ["go.mod", "go.sum", "go.work"])) candidates.push(join(cwd, "bin", command));
		for (const dir of pathEnv.split(":")) if (dir) candidates.push(join(dir, command));
	}
	for (const path of candidates) {
		try {
			const resolved = realpathSync(path);
			const stat = lstatSync(resolved);
			if (stat.isFile() && (stat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH))) return resolved;
		} catch { /* Missing or unusable executable. */ }
	}
	return null;
}
function quote(value: string): string { return /^[\w./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`; }
function doctorCommand(cwd: string, file: string | null): string {
	return `omp-kit doctor --scope lsp --project ${quote(cwd)}${file ? ` --file ${quote(file)}` : ""}`;
}

/** Inventory OMP's source-backed LSP candidates without starting a process or reading OMP settings. */
export function inspectLspReadiness(input: LspReadinessInput): LspReadinessReport {
	const cwd = resolve(input.project);
	const file = input.file ? resolve(cwd, input.file) : null;
	const relativeFile = file ? relative(cwd, file) : "";
	const fileOutsideCwd = Boolean(file && (relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)));
	const config = defaults(input.ompPath);
	const opaque: string[] = [];
	const layers: Layer[] = [];
	if (!config) opaque.push("installed OMP LSP defaults unavailable; supply a source-backed OMP installation");
	for (const path of configCandidates(resolve(input.home), cwd)) {
		if (!existsSync(path)) continue;
		if (!readableFile(path)) { opaque.push(path); continue; }
		try { const layer = parseLayer(path); if (layer) layers.push(layer); else opaque.push(path); }
		catch { opaque.push(path); }
	}
	const merged = new Map<string, { config: ServerConfig; source: string }>();
	for (const layer of [...(config ? [{ path: config.path, servers: config.servers }] : []), ...layers]) {
		for (const [name, value] of Object.entries(layer.servers)) {
			if (!isRecord(value)) { opaque.push(`${layer.path}: ${name}`); continue; }
			const candidate = normalize({ ...merged.get(name)?.config, ...value });
			if (candidate) merged.set(name, { config: candidate, source: layer.path });
			else opaque.push(`${layer.path}: ${name}`);
		}
	}
	const command = doctorCommand(cwd, file);
	const servers: LspServerReadiness[] = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => {
		const { config: server, source } = entry;
		const resolvedCommand = executable(server.command, cwd, input.pathEnv ?? process.env.PATH ?? "");
		const marker = markersAtCwd(cwd, server.rootMarkers);
		const extension = fileMatches(file, server.fileTypes);
		let reason: string;
		let recommendedAction: string;
		if (opaque.length) { reason = "OMP LSP configuration has unreadable or unsupported layers; effective selection is unverified"; recommendedAction = `Inspect ${opaque[0]} and rerun ${command}`; }
		else if (server.disabled) { reason = `Server disabled by ${source}`; recommendedAction = `Review disabled in ${quote(source)}, then run ${command}`; }
		else if (!marker) { reason = `No root marker (${server.rootMarkers.join(", ")}) in session cwd ${cwd}`; recommendedAction = `Start OMP in a cwd containing ${server.rootMarkers.join(" or ")}, or review rootMarkers in ${quote(source)}; rerun ${command}`; }
		else if (!resolvedCommand) { reason = `Executable ${server.command} not found for session cwd`; recommendedAction = `Review omp-kit lsp setup --plan for ${quote(server.command)}, then rerun ${command}`; }
		else if (!file) { reason = "No file selected; file-type eligibility not checked"; recommendedAction = `${command} --file FILE`; }
		else if (!extension) { reason = `${extname(file) || basename(file)} does not match configured file types ${server.fileTypes.join(", ")}`; recommendedAction = `Select a matching file or review fileTypes in ${quote(source)}; rerun ${command}`; }
		else { reason = fileOutsideCwd ? `Eligible by session cwd ${cwd} for an out-of-cwd file; server runtime not probed` : "Eligible by config, binary, cwd marker and file type; server runtime not probed"; recommendedAction = "In the OMP session run lsp reload with file: \"*\", then request a language operation for this file"; }
		const eligible = !opaque.length && !server.disabled && marker && Boolean(resolvedCommand) && extension;
		return { name, configured: true, config_source: source, command: server.command, resolved_command: resolvedCommand,
			executable_found: Boolean(resolvedCommand), root_markers: server.rootMarkers, file_types: server.fileTypes, disabled: server.disabled,
			eligible, status: eligible || opaque.length ? "UNVERIFIED" : "DEGRADED", runtime: "NOT_PROBED", reason, recommended_action: recommendedAction };
	});
	// OMP chooses one TypeScript implementation after its marker/binary filter.
	const native = servers.find(row => row.name === "typescript-native");
	if (!opaque.length && native && !native.disabled && native.executable_found && markersAtCwd(cwd, native.root_markers)) {
		const binary = native.resolved_command!;
		const realBinDir = dirname(binary);
		const packageDirs = [
			...(basename(realBinDir) === "bin" ? [dirname(realBinDir)] : []),
			resolve(dirname(binary), "..", "typescript"),
			join(dirname(binary), "node_modules", "typescript"),
		];
		const packageDir = packageDirs.find(dir => existsSync(join(dir, "package.json")));
		const nativeSpeaksLsp = Boolean(packageDir && !existsSync(join(packageDir, "lib", "tsserver.js")));
		const excluded = nativeSpeaksLsp ? servers.find(row => row.name === "typescript-language-server") : native;
		if (excluded) {
			excluded.eligible = false;
			excluded.status = "DEGRADED";
			excluded.reason = `OMP selects the ${nativeSpeaksLsp ? "typescript-native" : "typescript-language-server"} alternative instead`;
			excluded.recommended_action = `Use the selected TypeScript alternative; rerun ${command}`;
		}
	}
	return { status: opaque.length || servers.some(row => row.status === "UNVERIFIED") ? "UNVERIFIED" : "DEGRADED",
		cwd, file, file_outside_cwd: fileOutsideCwd, config_layers: layers.map(layer => layer.path), opaque_layers: opaque,
		servers, runtime: "NOT_PROBED" };
}

/** Manual guidance only. No server binary or package manager is ever executed. */
export function planLspSetup(input: LspReadinessInput): LspSetupPlan {
	const report = inspectLspReadiness(input);
	const instructions = report.servers.filter(row => !row.executable_found && MACOS_MANUAL[row.command]).map(row => {
		const command = input.platform === "darwin" || (!input.platform && process.platform === "darwin") ? MACOS_MANUAL[row.command]! : null;
		return { server: row.name, status: command ? "MANUAL" : "UNSUPPORTED", command,
			note: command ? "Manual macOS option; check the package source and rerun doctor after installing. Does not prove server runtime health." : "No verified manual installation command for this platform." } satisfies LspSetupInstruction;
	});
	return { report, instructions };
}
