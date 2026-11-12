// lifecycle.ts -- LIFECYCLEMANIFEST1 (ompkit-1ra0d.217): the idea-to-happy-product
// lifecycle as a checked manifest, not hand-written prose.
//
// omp-kit docs/plan/lifecycle-map-2026-11-12.md will drift like the docs it
// criticizes, so this file makes the phase table machine-readable: one row per
// phase naming its exit criterion, verbs (in the src/commands.ts registry),
// doc path, test file and turnline metric. docs/lifecycle.json is the source;
// scripts/lifecycle-check.ts renders docs/lifecycle.md from it and fails on
// drift; the daily loop-close job (src/loop-close.ts) files or updates one
// bead per gap. A human is never the scheduled consumer.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { COMMANDS } from "./commands.ts";

/** The eleven phases, in lifecycle order. */
export const LIFECYCLE_PHASES = [
	"discover",
	"validate",
	"plan",
	"build",
	"verify",
	"release",
	"launch",
	"operate",
	"measure-value",
	"revenue",
	"learn",
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface LifecycleRow {
	phase: string;
	exit_criterion: string;
	/** Null (or empty) means no verb automates this phase: a gap the daily job files. */
	verbs: string[] | null;
	/** Repo-relative path, or null when no doc covers this phase. */
	doc: string | null;
	/** Repo-relative path, or null when no test covers this phase. */
	test: string | null;
	/** A turnline field name, a value_<slug>/unsaved_<slug> field, or UNKNOWN (a gap). */
	metric: string;
	/** Honesty note about the row (e.g. automation with no registry verb); never a gap. */
	note?: string | null;
}

export interface LifecycleManifest {
	version: 1;
	rows: LifecycleRow[];
}

export type LifecycleFacet = "verbs" | "doc" | "test" | "metric";
export interface LifecycleGap {
	phase: string;
	facet: LifecycleFacet;
}

/** Bounded manifest read; the manifest stays small but never unbounded. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** turnline.py FIELDS plus its per-repo families (private there, named here). */
const TURNLINE_FIELDS: Record<string, true> = {
	refusals_7d: true,
	codes_7d: true,
	new_codes_7d: true,
	gate_min_7d: true,
	open: true,
	p01_share: true,
	creates_7d: true,
	closes_7d: true,
	cfs_refusals_7d: true,
	state_gb: true,
	unclassified_share: true,
};
const VALUE_METRIC = /^value_[a-z0-9_]+$/;
const UNSAVED_METRIC = /^unsaved_[a-z0-9_]+$/;

/** Every addressable verb: top-level names plus "parent sub" routes. */
export function registryVerbs(): string[] {
	const verbs: string[] = [];
	for (const command of COMMANDS) {
		verbs.push(command.name);
		if ("subcommands" in command && Array.isArray(command.subcommands)) {
			for (const sub of command.subcommands) {
				if (sub !== null && typeof sub === "object" && "name" in sub && typeof sub.name === "string" && sub.name !== "") {
					verbs.push(`${command.name} ${sub.name}`);
				}
			}
		}
	}
	return verbs;
}

/** The manifest file load: null manifest with "absent" means the loop is not installed in this tree. */
export function loadLifecycleManifest(path: string): { manifest: unknown; reason: "ok" | "absent" | "unreadable" | "oversize" | "invalid-json" } {
	try {
		if (!existsSync(path)) return { manifest: null, reason: "absent" };
		if (statSync(path).size > MAX_MANIFEST_BYTES) return { manifest: null, reason: "oversize" };
		return { manifest: JSON.parse(readFileSync(path, "utf8")) as unknown, reason: "ok" };
	} catch (error) {
		if (error instanceof SyntaxError) return { manifest: null, reason: "invalid-json" };
		return { manifest: null, reason: "unreadable" };
	}
}

function insideRoot(root: string, candidate: string): boolean {
	const base = resolve(root);
	return candidate === base || candidate.startsWith(`${base}${sep}`);
}

/** Parsed-JSON boundary shapes: every field stays unknown until the checks below. */
type RawManifest = { version?: unknown; rows?: unknown };
type RawRow = { phase?: unknown; exit_criterion?: unknown; verbs?: unknown; doc?: unknown; test?: unknown; metric?: unknown; note?: unknown };

/** Structural validation against the registry and the tree; UNKNOWN metrics are gaps, never findings. */
export function validateLifecycleManifest(manifest: unknown, root: string): string[] {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		return ["LIFECYCLE_MANIFEST_SHAPE: manifest is not a JSON object"];
	}
	const doc = manifest as RawManifest;
	const findings: string[] = [];
	if (doc.version !== 1) {
		findings.push("LIFECYCLE_MANIFEST_VERSION: manifest version must be 1");
	}
	if (!Array.isArray(doc.rows)) {
		return [...findings, "LIFECYCLE_MANIFEST_SHAPE: manifest rows is not an array"];
	}
	const verbs = registryVerbs();
	const seen: Record<string, true> = {};
	doc.rows.forEach((entry: unknown, index: number) => {
		const where = `row ${index}`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			findings.push(`LIFECYCLE_MANIFEST_SHAPE: ${where} is not an object`);
			return;
		}
		const { phase, exit_criterion, verbs: rowVerbs, doc: rowDoc, test: rowTest, metric, note } = entry as RawRow;
		if (typeof phase !== "string" || !(LIFECYCLE_PHASES as readonly string[]).includes(phase)) {
			findings.push(`LIFECYCLE_MANIFEST_UNKNOWN_PHASE: ${where} names no lifecycle phase`);
			return;
		}
		if (seen[phase] === true) {
			findings.push(`LIFECYCLE_MANIFEST_DUPLICATE_PHASE: phase ${phase} appears twice`);
		}
		seen[phase] = true;
		if (typeof exit_criterion !== "string" || exit_criterion.trim() === "") {
			findings.push(`LIFECYCLE_MANIFEST_EXIT: phase ${phase} names no exit criterion`);
		}
		if (rowVerbs !== null && rowVerbs !== undefined) {
			if (!Array.isArray(rowVerbs) || rowVerbs.some(verb => typeof verb !== "string" || verb === "")) {
				findings.push(`LIFECYCLE_MANIFEST_VERBS: phase ${phase} verbs is not an array of names`);
			} else {
				for (const verb of rowVerbs) {
					if (typeof verb === "string" && !verbs.includes(verb)) {
						findings.push(`LIFECYCLE_MANIFEST_UNKNOWN_VERB: phase ${phase} names missing verb ${JSON.stringify(verb)}`);
					}
				}
			}
		}
		for (const [facet, value] of [["doc", rowDoc], ["test", rowTest]] as const) {
			if (value === null || value === undefined) continue;
			if (typeof value !== "string" || value === "") {
				findings.push(`LIFECYCLE_MANIFEST_PATH: phase ${phase} ${facet} is not a path`);
				continue;
			}
			const absolute = resolve(root, value);
			if (!insideRoot(root, absolute)) {
				findings.push(`LIFECYCLE_MANIFEST_PATH: phase ${phase} ${facet} escapes the repo: ${JSON.stringify(value)}`);
				continue;
			}
			let isFile = false;
			try {
				isFile = statSync(absolute).isFile();
			} catch {
				isFile = false;
			}
			if (!isFile) {
				findings.push(`LIFECYCLE_MANIFEST_MISSING_${facet === "doc" ? "DOC" : "TEST"}: phase ${phase} ${facet} does not exist: ${JSON.stringify(value)}`);
			}
		}
		if (typeof metric !== "string" || metric === "") {
			findings.push(`LIFECYCLE_MANIFEST_METRIC: phase ${phase} names no metric or UNKNOWN`);
		} else if (metric !== "UNKNOWN" && TURNLINE_FIELDS[metric] !== true && !VALUE_METRIC.test(metric) && !UNSAVED_METRIC.test(metric)) {
			findings.push(`LIFECYCLE_MANIFEST_UNKNOWN_METRIC: phase ${phase} names no turnline field: ${JSON.stringify(metric)}`);
		}
		if (note !== null && note !== undefined && (typeof note !== "string" || note.trim() === "")) {
			findings.push(`LIFECYCLE_MANIFEST_NOTE: phase ${phase} note is not nonempty text`);
		}
	});
	for (const phase of LIFECYCLE_PHASES) {
		if (seen[phase] !== true) {
			findings.push(`LIFECYCLE_MANIFEST_MISSING_PHASE: no row for phase ${phase}`);
		}
	}
	return findings;
}

/** Every null/empty verbs, null doc/test, or UNKNOWN metric is one bead the daily job files. */
export function lifecycleGaps(manifest: LifecycleManifest): LifecycleGap[] {
	const gaps: LifecycleGap[] = [];
	for (const row of manifest.rows) {
		if (row.verbs === null || row.verbs === undefined || row.verbs.length === 0) {
			gaps.push({ phase: row.phase, facet: "verbs" });
		}
		if (row.doc === null || row.doc === undefined || row.doc === "") {
			gaps.push({ phase: row.phase, facet: "doc" });
		}
		if (row.test === null || row.test === undefined || row.test === "") {
			gaps.push({ phase: row.phase, facet: "test" });
		}
		if (row.metric === "UNKNOWN") {
			gaps.push({ phase: row.phase, facet: "metric" });
		}
	}
	return gaps;
}

const cell = (value: string | null): string => (value === null || value === undefined || value === "" ? "—" : `\`${value}\``);

/** Deterministic render of docs/lifecycle.md; no timestamps, rows in manifest order. */
export function renderLifecycleDoc(manifest: LifecycleManifest): string {
	const lines = [
		"# Lifecycle manifest (generated)",
		"",
		"<!-- generated by `bun scripts/lifecycle-check.ts` from `docs/lifecycle.json`; do not edit -->",
		"",
		"This table is the checked version of the idea-to-happy-product phase map",
		"(omp-kit `docs/plan/lifecycle-map-2026-11-12.md`, superseded by this page once",
		"LIFECYCLEMANIFEST1 `ompkit-1ra0d.217` lands). Every measured signal gets an",
		"automatic consumer: the daily loop-close job files or updates one bead per gap",
		"row below (`lifecycle:<phase>:<facet>`) and comments when a gap closes.",
		"",
		"| Phase | Exit criterion | Verbs | Doc | Test | Metric |",
		"|---|---|---|---|---|---|",
	];
	for (const row of manifest.rows) {
		const verbs = row.verbs === null || row.verbs === undefined || row.verbs.length === 0
			? "—"
			: row.verbs.map(verb => `\`${verb}\``).join(", ");
		lines.push(`| ${row.phase} | ${row.exit_criterion} | ${verbs} | ${cell(row.doc)} | ${cell(row.test)} | \`${row.metric}\` |`);
	}
	lines.push("", "## Row notes");
	lines.push("");
	const noted = manifest.rows.filter(row => row.note !== null && row.note !== undefined && row.note !== "");
	if (noted.length === 0) {
		lines.push("None.");
	} else {
		for (const row of noted) {
			lines.push(`- \`${row.phase}\`: ${row.note}`);
		}
	}
	lines.push("", "## Open gaps");
	lines.push("");
	const gaps = lifecycleGaps(manifest);
	if (gaps.length === 0) {
		lines.push("None: every phase names a verb, doc, test and metric.");
	} else {
		const byPhase: Record<string, string[]> = {};
		for (const gap of gaps) {
			const facets = byPhase[gap.phase] ?? [];
			facets.push(gap.facet);
			byPhase[gap.phase] = facets;
		}
		for (const row of manifest.rows) {
			const facets = byPhase[row.phase];
			if (facets === undefined) continue;
			lines.push(`- \`${row.phase}\`: ${facets.join(", ")}`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}`;
}

/** Manifest path for a run root (the companion checkout the job audits). */
export function lifecycleManifestPath(root: string): string {
	return join(root, "docs", "lifecycle.json");
}
