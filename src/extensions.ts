import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";

/** Kinds of files OMP loads as extensions or hooks, mirroring OMP's own discovery. */
export type ExtensionFileKind = "hook-pre" | "hook-post" | "extension" | "plugin-extension";

export interface ExtensionFile { profile: string; kind: ExtensionFileKind; file: string; }
export interface ImportFinding { profile: string; kind: ExtensionFileKind; file: string; line: number; specifier: string; detail: string; }
export interface ExtensionImportReport {
	status: "OK" | "DEGRADED" | "UNVERIFIED";
	reason: string;
	files_checked: number;
	profiles_checked: string[];
	plugin_packages: string[];
	findings: ImportFinding[];
}

function childFiles(directory: string, accept: (name: string) => boolean): string[] {
	let entries: string[];
	try {
		entries = readdirSync(directory).sort();
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const name of entries) {
		if (!accept(name)) continue;
		const path = join(directory, name);
		let stat: Stats | null = null;
		try {
			stat = lstatSync(path);
		} catch {
			continue;
		}
		if (stat.isFile() || stat.isSymbolicLink()) files.push(path);
	}
	return files;
}

/** Profile agent directories: default plus every named profile with an agent dir. */
export function profileAgentDirs(home: string): { profile: string; agentDir: string }[] {
	const found: { profile: string; agentDir: string }[] = [];
	const append = (profile: string, agentDir: string) => {
		try {
			if (lstatSync(agentDir).isDirectory()) found.push({ profile, agentDir });
		} catch { /* Absent profiles contribute nothing. */ }
	};
	append("default", join(home, ".omp", "agent"));
	let names: string[];
	try {
		names = readdirSync(join(home, ".omp", "profiles")).sort();
	} catch {
		return found;
	}
	for (const name of names) {
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name === "default" || name.endsWith(".")) continue;
		append(name, join(home, ".omp", "profiles", name, "agent"));
	}
	return found;
}

/** Extra extension paths a profile config lists explicitly. */
function configExtensionPaths(agentDir: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(agentDir, "config.yml"), "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const listed = (parsed as Record<string, unknown>).extensions;
	if (!Array.isArray(listed)) return [];
	return listed.filter((entry): entry is string => typeof entry === "string" && isAbsolute(entry));
}

/** Entry points installed plugin packages declare in their own manifests. */
function pluginExtensionFiles(home: string): ExtensionFile[] {
	const files: ExtensionFile[] = [];
	const root = join(home, ".omp", "plugins", "node_modules");
	let names: string[];
	try {
		names = readdirSync(root).sort();
	} catch {
		return [];
	}
	for (const name of names) {
		if (name.startsWith(".")) continue;
		const manifestPath = join(root, name, "package.json");
		let manifest: unknown;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			continue;
		}
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
		const entries = (manifest as Record<string, unknown>).extensions;
		if (!Array.isArray(entries)) continue;
		const base = join(root, name);
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			const file = resolve(base, entry);
			if (file !== base && file.startsWith(`${base}/`)) files.push({ profile: `plugin:${name}`, kind: "plugin-extension", file });
		}
	}
	return files;
}

/** Extension and hook files OMP's discovery would load for these profiles. */
export function listExtensionFiles(home: string): ExtensionFile[] {
	const files: ExtensionFile[] = [];
	const seen = new Set<string>();
	const push = (candidate: ExtensionFile) => {
		const key = resolve(candidate.file);
		if (seen.has(key)) return;
		seen.add(key);
		files.push({ ...candidate, file: key });
	};
	for (const { profile, agentDir } of profileAgentDirs(home)) {
		for (const file of childFiles(join(agentDir, "hooks", "pre"), (name) => name.endsWith(".ts") || name.endsWith(".js"))) {
			push({ profile, kind: "hook-pre", file });
		}
		for (const file of childFiles(join(agentDir, "hooks", "post"), (name) => name.endsWith(".ts") || name.endsWith(".js"))) {
			push({ profile, kind: "hook-post", file });
		}
		for (const file of childFiles(join(agentDir, "extensions"), (name) => !/\.d\.[mc]?ts$/.test(name) &&
			(name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")))) {
			push({ profile, kind: "extension", file });
		}
		for (const file of configExtensionPaths(agentDir)) push({ profile, kind: "extension", file });
	}
	for (const candidate of pluginExtensionFiles(home)) push(candidate);
	return files;
}

export interface ImportSpecifier { specifier: string; line: number; }

/**
 * Static import specifiers with 1-based line numbers. Type-only imports and
 * exports never execute at load, so they cannot fail resolution and are skipped.
 * No execution: the source is only read as text.
 */
export function extractImportSpecifiers(source: string): ImportSpecifier[] {
	const found: ImportSpecifier[] = [];
	const lines = source.split("\n");
	let open = false;
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		const number = index + 1;
		if (line.startsWith("//")) continue;
		if (/^(import|export)\s+type\b/.test(line)) { open = false; continue; }
		const from = /\bfrom\s*["']([^"']+)["']/.exec(line);
		if (from?.[1] && (open || /\b(import|export)\b/.test(line))) {
			found.push({ specifier: from[1], line: number });
			open = false;
			continue;
		}
		if (/^(import|export)\b/.test(line)) {
			open = !line.includes(";");
			const sideEffect = /^\s*import\s*["']([^"']+)["']/.exec(raw);
			if (sideEffect?.[1]) {
				found.push({ specifier: sideEffect[1], line: number });
				open = false;
			}
			continue;
		}
		if (open) {
			if (line.includes(";")) open = false;
			continue;
		}
		const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(line);
		if (dynamic?.[1]) {
			found.push({ specifier: dynamic[1], line: number });
			continue;
		}
		const required = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/.exec(line);
		if (required?.[1]) found.push({ specifier: required[1], line: number });
	}
	return found;
}

const SOURCE_BYTES_MAX = 1024 * 1024;

function resolveSpecifier(specifier: string, fromFile: string): string | null {
	try {
		return Bun.resolveSync(specifier, fromFile);
	} catch {
		return null;
	}
}

function readSource(file: string): string | null {
	try {
		const text = readFileSync(file, "utf8");
		return text.length > SOURCE_BYTES_MAX ? null : text;
	} catch {
		return null;
	}
}

export interface CheckExtensionImportsInput {
	home: string;
	/** Profile whose files are checked; when omitted every listed profile is checked. */
	profile?: string;
}

/**
 * Read-only extension/hook import check. Every candidate file OMP would load
 * has each static import specifier resolved from its own directory with
 * Bun.resolveSync; nothing is executed or imported. Unresolvable specifiers
 * (the jev incident: a relative import valid only from another cwd) are
 * reported with file and line.
 */
export function checkExtensionImports(input: CheckExtensionImportsInput): ExtensionImportReport {
	if (!isAbsolute(input.home) || resolve(input.home) !== input.home) {
		return { status: "UNVERIFIED", reason: "Extension import check needs an absolute HOME", files_checked: 0, profiles_checked: [], plugin_packages: [], findings: [] };
	}
	const candidates = listExtensionFiles(input.home)
		.filter((file) => input.profile === undefined || file.profile === input.profile);
	const findings: ImportFinding[] = [];
	let checked = 0;
	for (const candidate of candidates) {
		const source = readSource(candidate.file);
		if (source === null) {
			findings.push({ profile: candidate.profile, kind: candidate.kind, file: candidate.file, line: 0, specifier: "", detail: "unreadable or oversized source" });
			continue;
		}
		checked += 1;
		for (const { specifier, line } of extractImportSpecifiers(source)) {
			if (resolveSpecifier(specifier, candidate.file) === null) {
				findings.push({ profile: candidate.profile, kind: candidate.kind, file: candidate.file, line, specifier, detail: "unresolvable from the file's directory" });
			}
		}
	}
	const profiles = [...new Set(candidates.map((candidate) => candidate.profile))].sort();
	const packages = [...new Set(candidates.filter((candidate) => candidate.kind === "plugin-extension")
		.map((candidate) => candidate.profile.replace(/^plugin:/, "")))].sort();
	if (!candidates.length) {
		return { status: "UNVERIFIED", reason: "No extension or hook files are installed for the listed profiles", files_checked: 0, profiles_checked: profiles, plugin_packages: packages, findings };
	}
	if (findings.length) {
		const first = findings[0]!;
		return { status: "DEGRADED", reason: `${findings.length} unresolvable import${findings.length === 1 ? "" : "s"} would fail extension load: ${first.file}:${first.line} '${first.specifier}'`, files_checked: checked, profiles_checked: profiles, plugin_packages: packages, findings };
	}
	return { status: "OK", reason: `All ${checked} extension and hook files resolve their imports`, files_checked: checked, profiles_checked: profiles, plugin_packages: packages, findings };
}
