/**
 * derived-check.ts — DERIVE1 B3 (ompkit-rc-epic-land-fix-release-dogfood-rz5.119):
 * doctor --scope derived lists literal probe-readable facts in config and
 * registry files, each with the probe that should replace it.
 *
 * Patterns follow the regex-engineering skill: line-oriented, exclusive
 * repeated classes, no nested quantifiers, lines over 4KB skipped before
 * matching. A literal with a reason on the same line stays quiet (a decision
 * records who and when; only bare facts are listed).
 */
export interface DerivedFinding {
	file: string;
	line: number;
	kind: "path" | "version" | "count" | "pid";
	text: string;
	probe: string;
}

const MAX_LINE = 4096;

const HOME_PATH = /\/(Users\/[^/\s]+|home\/[^/\s]+)/;
const VERSION_PIN = /(?:^|[^A-Za-z0-9_])(?:pinned|omp[_-]?version|current[_-]?version|installed[_-]?version|runtime[_-]?version|version_pin)(?:[^A-Za-z0-9_]|$)\s*[:=]\s*["']?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?/i;
const COUNT = /\b\d+\s+(?:profiles?|beads?|rules?|leases?|workers?|panes?)\b/;
const PID = /\bpid\s*[:=]\s*\d{3,}\b/i;
const REASON = /reason\s*:|because|why\s*:|#\s*\S/i;
const PRECEDING_DECISION = /^[ \t]*#\s*(?:decision|reason|why)\s*[:=]\s*\S/i;
/** Decision fields whose value is a human choice, not a copied fact. */
const DECISION_FIELD = /"(?:version|name|description|license|author)"\s*:/;

const PROBE: Record<DerivedFinding["kind"], string> = {
	path: "read the path from $HOME or config at run time, never a literal",
	version: "read the version from the package manager or omp --version at run time",
	count: "count live (br list, profile enumeration) at run time",
	pid: "resolve the live process at run time, never a stored pid",
};

const SCAN_EXT: Record<string, true> = { ".json": true, ".toml": true, ".yml": true, ".yaml": true };
const CONFIG_DIRS: Record<string, true> = {
	".omp": true, "config": true, "configs": true,
	"policy": true, "policies": true, "registry": true, "registries": true,
	"settings": true,
};
const SKIP_DIRS: Record<string, true> = {
	".cache": true, ".git": true, "artifacts": true, "build": true, "cache": true,
	"coverage": true, "docs": true, "dist": true, "fixtures": true, "generated": true,
	"logs": true, "node_modules": true, "out": true, "reports": true, "runs": true,
	"samples": true, "snapshots": true, "target": true, "testdata": true, "tests": true,
	"var": true, "vendor": true,
};
const ROOT_CONFIG_NAMES: Record<string, true> = {
	"config.json": true, "config.toml": true, "config.yaml": true, "config.yml": true,
	"fleet-watch.json": true, "upgrade_policy.toml": true,
};
const CONFIG_SUFFIXES = [
	".config.json", ".config.toml", ".config.yaml", ".config.yml",
	".policy.json", ".policy.toml", ".policy.yaml", ".policy.yml",
	".registry.json", ".registry.toml", ".registry.yaml", ".registry.yml",
];

function checkLine(text: string): { kind: DerivedFinding["kind"]; probe: string } | null {
	if (text.length > MAX_LINE) return null;
	if (REASON.test(text)) return null;
	if (DECISION_FIELD.test(text)) return null;
	if (HOME_PATH.test(text)) return { kind: "path", probe: PROBE.path };
	if (PID.test(text)) return { kind: "pid", probe: PROBE.pid };
	if (COUNT.test(text)) return { kind: "count", probe: PROBE.count };
	if (VERSION_PIN.test(text)) return { kind: "version", probe: PROBE.version };
	return null;
}

export function scanDerivedText(relative: string, text: string): DerivedFinding[] {
	const findings: DerivedFinding[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const previous = index > 0 ? lines[index - 1] ?? "" : "";
		const hit = checkLine(line);
		if (hit && !PRECEDING_DECISION.test(previous)) {
			findings.push({ file: relative, line: index + 1, kind: hit.kind, text: line.trim().slice(0, 160), probe: hit.probe });
		}
	}
	return findings;
}

export function shouldScanFile(path: string): boolean {
	const parts = path.split("/");
	let configDirectory = false;
	let githubWorkflow = false;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index] ?? "";
		if (SKIP_DIRS[part] === true || part.includes("fixture") || part.includes("selftest") || part.startsWith(".scratch-") || part.startsWith("scratch-") || part.startsWith("retired-") || part.startsWith("archive-")) return false;
		if (part === ".omp" && index === parts.length - 2 && parts[index + 1] === "mission.toml") return false;
		if (part === ".beads") {
			const configFile = parts[index + 1] ?? "";
			const directConfig = index === parts.length - 2 && (
				configFile === "config.json" || configFile === "config.toml" ||
				configFile === "config.yaml" || configFile === "config.yml"
			);
			if (!directConfig) return false;
		}
		if (CONFIG_DIRS[part] === true) configDirectory = true;
		if (part === ".github" && parts[index + 1] === "workflows") githubWorkflow = true;
	}
	const filename = parts[parts.length - 1] ?? "";
	const dot = filename.lastIndexOf(".");
	if (dot < 0 || SCAN_EXT[filename.slice(dot)] !== true) return false;
	if (configDirectory || githubWorkflow || ROOT_CONFIG_NAMES[filename] === true) return true;
	for (const suffix of CONFIG_SUFFIXES) {
		if (filename.endsWith(suffix)) return true;
	}
	return false;
}
