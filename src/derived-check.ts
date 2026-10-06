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
const VERSION = /\b\d+\.\d+\.\d+[-+.\w]*\b/;
const COUNT = /\b\d+\s+(?:profiles?|beads?|rules?|leases?|workers?|panes?)\b/;
const PID = /\bpid\s*[:=]\s*\d{3,}\b/i;
const REASON = /reason\s*:|because|why\s*:|#\s*\S/i;
/** Decision fields whose value is a human choice, not a copied fact. */
const DECISION_FIELD = /"(?:version|name|description|license|author)"\s*:/;

const PROBE: Record<DerivedFinding["kind"], string> = {
	path: "read the path from $HOME or config at run time, never a literal",
	version: "read the version from the package manager or omp --version at run time",
	count: "count live (br list, profile enumeration) at run time",
	pid: "resolve the live process at run time, never a stored pid",
};

const SCAN_EXT: Record<string, true> = { ".json": true, ".toml": true, ".yml": true, ".yaml": true };
const SKIP_DIRS: Record<string, true> = { ".git": true, "var": true, "node_modules": true, "target": true, "dist": true };

function checkLine(text: string): { kind: DerivedFinding["kind"]; probe: string } | null {
	if (text.length > MAX_LINE) return null;
	if (REASON.test(text)) return null;
	if (DECISION_FIELD.test(text)) return null;
	if (HOME_PATH.test(text)) return { kind: "path", probe: PROBE.path };
	if (PID.test(text)) return { kind: "pid", probe: PROBE.pid };
	if (COUNT.test(text)) return { kind: "count", probe: PROBE.count };
	if (VERSION.test(text)) return { kind: "version", probe: PROBE.version };
	return null;
}

export function scanDerivedText(relative: string, text: string): DerivedFinding[] {
	const findings: DerivedFinding[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const hit = checkLine(lines[index] ?? "");
		if (hit) findings.push({ file: relative, line: index + 1, kind: hit.kind, text: (lines[index] ?? "").trim().slice(0, 160), probe: hit.probe });
	}
	return findings;
}

export function shouldScanFile(path: string): boolean {
	const parts = path.split("/");
	if (parts.some(part => SKIP_DIRS[part] === true)) return false;
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	return SCAN_EXT[path.slice(dot)] === true;
}
