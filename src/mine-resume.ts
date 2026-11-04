import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { run } from "./kitlib/run.ts";
import { MineLedger, MINE_SOURCES, type MineCell, type MineCellStatus, type MineSource } from "./mine-ledger.ts";
import { enforcement, mergeMineFindings, mineFindingEvidence, mineFindingKey, mineFindingOccurrence, rankMineWaste, scanMine, type MineClass, type MineCoverage, type MineOptions, type MineProject, type MineReport, type MineSourceFinding } from "./mine.ts";

export interface MineFileIndex {
	canSkip(path: string, since: number, until: number): boolean;
	signature(path: string): string | undefined;
	record(path: string, signature: string, min: number | null, max: number | null): void;
}
type TimeReceipt = { signature: string; min: number | null; max: number | null };
type Payload = { report: Omit<MineReport, "occurrences" | "classes" | "waste_classes">; findings: MineSourceFinding[] };
const key = (project: string, day: string, source: MineSource) => JSON.stringify([project, day, source]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const physical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Indexes only fully decoded files, by observed record timestamps, never filename or mtime. */
class FileTimeIndex implements MineFileIndex {
	private entries: Record<string, TimeReceipt> = {};
	private dirty = false;
	constructor(private path: string) {
		try {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error("unsafe timestamp index");
			const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (object(doc) && doc.version === 1 && object(doc.entries)) for (const [name, value] of Object.entries(doc.entries)) {
				if (isAbsolute(name) && object(value) && typeof value.signature === "string"
					&& (value.min === null || typeof value.min === "number" && Number.isFinite(value.min))
					&& (value.max === null || typeof value.max === "number" && Number.isFinite(value.max))) this.entries[name] = value as TimeReceipt;
			}
		} catch (error) {
			if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw error;
			// A corrupt/missing index cannot certify a skip; source files are scanned again.
		}
	}
	signature(path: string): string | undefined {
		try { const s = lstatSync(path, { bigint: true }); return s.isFile() && !s.isSymbolicLink() ? [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":") : undefined; }
		catch { return undefined; }
	}
	canSkip(path: string, since: number, until: number): boolean {
		const old = this.entries[physical(path)], signature = this.signature(path);
		return !!old && !!signature && old.signature === signature && (old.min === null || old.max === null || old.max < since || old.min >= until);
	}
	record(path: string, signature: string, min: number | null, max: number | null): void {
		if (this.signature(path) !== signature) return; // An actively appended file never gets a stale skip receipt.
		this.entries[physical(path)] = { signature, min, max }; this.dirty = true;
	}
	flush(): void {
		if (!this.dirty) return;
		const bytes = Buffer.from(JSON.stringify({ version: 1, entries: this.entries }));
		if (bytes.length > 32 * 1024 * 1024) throw new Error("MINE_TIME_INDEX_LIMIT");
		atomicReplaceBytes(this.path, bytes, { mode: 0o600, durability: "full" }); this.dirty = false;
	}
}

function sourceOf(producer: string): MineSource {
	if (producer === "omp-transcript") return "transcripts";
	if (producer === "bead export" || producer === "bead history snapshots") return "tracker";
	if (producer === "git correction commits") return "git";
	if (producer.startsWith("CC")) return "cc";
	return "hooks";
}
function compactCoverage(rows: MineCoverage[], source: MineSource, project: string, day: string): MineCoverage[] {
	const relevant = rows.filter(row => sourceOf(row.producer) === source), read = relevant.filter(row => row.status === "READ");
	return [...relevant.filter(row => row.status !== "READ").map(row => ({ ...row, detail: row.detail.length <= 1024 ? row.detail : `${row.detail.slice(0, 512)} […] ${row.detail.slice(-512)}` })),
		...(read.length ? [{ producer: source, location: `${project}#${day}`, status: "READ" as const,
			rows: read.reduce((sum, row) => sum + row.rows, 0), first_timestamp: read.map(row => row.first_timestamp).filter((t): t is string => !!t).sort()[0] ?? null,
			last_timestamp: read.map(row => row.last_timestamp).filter((t): t is string => !!t).sort().at(-1) ?? null,
			detail: `${read.length} readable source entries examined or excluded by a complete unchanged event-time index; source record counts may include repeated context reads.` }] : [])];
}
function payload(value: unknown): value is Payload {
	if (!object(value) || !object(value.report) || value.report.schema_version !== "omp-kit.mine.v1" || !Array.isArray(value.report.projects)
		|| !Array.isArray(value.report.coverage) || !Array.isArray(value.findings) || !object(value.report.excluded_inputs)) return false;
	return value.findings.every(row => object(row) && typeof row.identity === "string" && typeof row.project === "string" && typeof row.class_id === "string"
		&& typeof row.time_ms === "number" && Number.isFinite(row.time_ms) && typeof row.producer === "string" && typeof row.citation === "string" && typeof row.summary === "string"
		&& (row.measured_minutes === null || typeof row.measured_minutes === "number" && Number.isFinite(row.measured_minutes) && row.measured_minutes >= 0)
		&& typeof row.proxy_minutes === "number" && Number.isFinite(row.proxy_minutes) && row.proxy_minutes >= 0);
}
/** One logical cell: split receipts are reassembled in recorded order; a missing or stale part forces a rescan. */
function whole(ledger: MineLedger, cell: MineCell<unknown>): MineCell<Payload> | null {
	if (!cell.part) return payload(cell.result) ? cell as MineCell<Payload> : null;
	const parts = ledger.parts<Partial<Payload>>(cell.project, cell.day, cell.source, cell.input_fingerprint);
	if (!parts) return null;
	const { part: _part, ...head } = parts[0]!, findings = parts.flatMap(part => Array.isArray(part.result.findings) ? part.result.findings : []);
	const result = { report: head.result.report, findings };
	return payload(result) ? { ...head, result } as MineCell<Payload> : null;
}
/**
 * Records one cell within the per-file ledger bound (MINECELLCAP1). An oversized result keeps its summary in part 0 and
 * packs findings into bounded sub-cells. What cannot be split is omitted and the cell is PARTIAL with the reason:
 * a finding too large for any sub-cell (named by citation), or a summary whose coverage rows alone exceed the bound.
 */
function record(ledger: MineLedger, input: Omit<MineCell<Payload>, "version" | "attempts" | "part">): MineCell<Payload> {
	if (ledger.fits(input)) return ledger.put(input);
	const { results, oversized } = ledger.split(input, input.result.findings, findings => ({ findings }));
	const reasons = [...input.reasons, ...oversized.map(finding => `${finding.citation.slice(0, 2048)}: MINECELLCAP1 finding of ${Buffer.byteLength(JSON.stringify(finding))} bytes exceeds one ledger sub-cell; omitted from this receipt and retried on resume`)];
	let head = { ...input, status: oversized.length ? "PARTIAL" as const : input.status, reasons, result: { report: input.result.report, findings: [] as MineSourceFinding[] } };
	if (!ledger.fits(head)) head = { ...head, status: "PARTIAL", result: { ...head.result, report: { ...head.result.report, coverage: [] } },
		reasons: [...reasons, `MINECELLCAP1: cell summary exceeds the ledger bound; its ${head.result.report.coverage.length} coverage rows are omitted from this receipt and retried on resume`] };
	if (head.reasons.length > 2048) throw new Error(`MINE_REASON_LIMIT: ${input.project} ${input.day} ${input.source}`);
	const cell = whole(ledger, ledger.putParts<Partial<Payload>>(head, results)[0]!);
	if (!cell) throw new Error(`MINE_LEDGER_SPLIT_READBACK: ${input.project} ${input.day} ${input.source}`);
	return cell;
}

/** Metadata is a cache invalidator only; event inclusion still always uses event timestamps. */
function fingerprint(paths: string[], shallowPaths: readonly string[] = []): string {
	const hash = createHash("sha256"); let entries = 0;
	function visit(path: string, depth = 0, recursive = true): void {
		if (++entries > 200_000 || depth > 40) throw new Error(`MINE_INPUT_CENSUS_BOUND: ${path}`);
		try {
			const s = lstatSync(path, { bigint: true });
			hash.update(JSON.stringify([path, String(s.dev), String(s.ino), String(s.mode), String(s.size), String(s.mtimeNs), String(s.ctimeNs)]));
			if (s.isSymbolicLink()) { const target = physical(path); if (target !== path) visit(target, depth + 1, recursive); }
			else if (s.isDirectory() && recursive) for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
		} catch (error) { hash.update(JSON.stringify([path, String(error)])); if (String(error).includes("MINE_INPUT_CENSUS_BOUND")) throw error; }
	}
	for (const path of [...new Set(paths)].sort()) visit(path, 0, !shallowPaths.includes(path));
	return hash.digest("hex");
}
function gitdir(project: string): string | null {
	const path = join(project, ".git");
	try {
		if (lstatSync(path).isDirectory()) return physical(path);
		const text = readFileSync(path, "utf8").trim();
		if (text.startsWith("gitdir: ")) return physical(resolve(project, text.slice(8)));
	} catch { /* Absence is reported by the existing source adapter, not invented here. */ }
	return null;
}

export async function runResumableMine(options: MineOptions): Promise<MineReport> {
	const census = await scanMine({ ...options, censusOnly: true, lookupBeads: false });
	const censusFailures = census.coverage.filter(row => row.status === "PARTIAL").map(row => ({
		...row, detail: `Project census incomplete: ${row.detail}`,
	}));
	const env = options.env ?? process.env, home = options.home ?? env.HOME ?? homedir();
	const root = physical(options.resumeDir ?? join(options.root ?? options.cwd ?? process.cwd(), "var", "mine"));
	const revisionHash = createHash("sha256");
	for (const name of ["mine.ts", "mine-resume.ts", "mine-ledger.ts", "mine-history.ts", "mine-transcripts.ts", "mine-cause.ts", "mine-replay.ts", "secret-output-policy.v1.json", "../extensions/secret-output-guard.ts"]) {
		try { revisionHash.update(readFileSync(new URL(name, import.meta.url))); }
		catch { revisionHash.update(`${name}:${fingerprint([process.execPath])}`); }
	}
	const ledger = new MineLedger(root, { since: options.since, until: options.until }, revisionHash.digest("hex"));
	const index = new FileTimeIndex(join(dirname(ledger.path), "file-times.json"));
	const old = new Map(ledger.cells.map(cell => [key(cell.project, cell.day, cell.source), cell]));
	const days: string[] = [];
	for (let t = Date.parse(`${options.since}T00:00:00Z`); t < Date.parse(`${options.until}T00:00:00Z`); t += 86400_000) days.push(new Date(t).toISOString().slice(0, 10));
	const state = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "omp-kit"), profiles = join(home, ".omp", "profiles");
	const transcriptRoots: string[] = [];
	if (existsSync(profiles)) for (const entry of readdirSync(profiles, { withFileTypes: true })) if (entry.isDirectory()) transcriptRoots.push(join(profiles, entry.name, "agent", "sessions"));
	const targets = [...census.projects.map(p => p.path), ...(options.all ? ["@unattributed"] : [])];
	const verdictOwners: Record<string, string> = {}, stores = new Map<string, string[]>();
	const childEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (value !== undefined && !name.startsWith("GIT_") && !name.startsWith("BR_") && !name.startsWith("BEADS_")) childEnv[name] = value;
	childEnv.HOME = home; childEnv.PYTHONDONTWRITEBYTECODE = "1";
	for (const p of census.projects) {
		const own: string[] = [], dir = gitdir(p.path);
		if (dir) own.push(join(dir, "omp-kit", "full-suite-verdicts"));
		const helper = options.root ? join(options.root, "scripts", "full-suite-verdict-store.py") : "";
		if (dir && helper && existsSync(helper)) {
			const result = await run(["nice", "-n", "10", "python3", "-B", helper, "timings", "--repo", p.path], { env: childEnv, cwd: p.path, deadline_s: 10, max_output_bytes: 64 * 1024 });
			const text = new TextDecoder().decode(result.stdout).trim();
			if (result.rc === 0 && !result.timed_out && !result.truncated && isAbsolute(text)) own.push(dirname(text));
		}
		stores.set(p.path, own);
		for (const store of own) {
			const canonical = physical(store), previous = census.projects.find(candidate => candidate.path === verdictOwners[canonical]);
			if (!previous || p.configured && !previous.configured) verdictOwners[canonical] = p.path;
		}
	}
	const fingerprints = new Map<string, string>(), pathFingerprints = new Map<string, string>();
	const flywheel = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "flywheel");
	// The scanner admits only top-level regular hook logs, not nested agent homes or their repository symlinks.
	const flywheelLogs = existsSync(flywheel) ? readdirSync(flywheel, { withFileTypes: true })
		.filter(entry => entry.isFile() && /(?:block|refus|timeout|audit).*\.jsonl$/.test(entry.name)).map(entry => join(flywheel, entry.name)) : [];
	for (const target of targets) for (const source of MINE_SOURCES) {
		const dir = target === "@unattributed" ? null : gitdir(target);
		const paths = source === "transcripts" ? [...transcriptRoots, ...(env.OMP_KIT_MINE_SESSION_ROOTS?.split(delimiter).filter(Boolean) ?? []), join(state, "mail-wake.jsonl"), ...(env.OMP_KIT_OWNER_CORRECTIONS_PATH ? [env.OMP_KIT_OWNER_CORRECTIONS_PATH] : [])] : source === "tracker" ? [join(target, ".beads", "issues.jsonl"), join(target, ".beads", ".br_history")]
			: source === "git" ? dir ? [join(dir, "HEAD"), join(dir, "refs"), join(dir, "packed-refs"), join(dir, "commondir"), join(dir, "shallow")] : [join(target, ".git")]
			: source === "cc" ? [env.CC_STATE ?? join(state, "cc")]
			: [join(state, "gate-events.jsonl"), join(state, "gate-events.jsonl.1"), join(state, "scratch-reap-log.jsonl"), join(state, "scratch-reap-log.jsonl.1"), flywheel, ...flywheelLogs, ...(dir ? [join(dir, "omp-kit")] : []), ...(stores.get(target) ?? [])];
		const shallow = source === "hooks" ? [flywheel] : [];
		const pathsKey = JSON.stringify([paths, shallow]), digest = pathFingerprints.get(pathsKey) ?? fingerprint(paths, shallow);
		pathFingerprints.set(pathsKey, digest);
		fingerprints.set(JSON.stringify([target, source]), digest);
	}
	let reused = 0, scanned = 0;
	const current: MineCell<Payload>[] = [];
	for (const target of targets) for (const source of MINE_SOURCES) for (const date of days) {
		const signature = fingerprints.get(JSON.stringify([target, source]))!, previous = old.get(key(target, date, source));
		const reusable = previous && previous.input_fingerprint === signature && previous.status !== "PARTIAL" && !(source === "cc" && censusFailures.length) ? whole(ledger, previous) : null;
		if (reusable) { current.push(reusable); reused++; continue; }
		const findings: MineSourceFinding[] = [], until = new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
		const synthetic = target === "@unattributed" && source !== "cc" && source !== "hooks" && source !== "transcripts";
		const report = synthetic ? { ...census, projects: [], classes: [], coverage: [], warnings: [], excluded_inputs: { unconfigured_scratch_events: 0, unbound_cli_events: 0, duplicate_events: {}, evidence: [] } }
			: await scanMine({ ...options, since: date, until, all: target === "@unattributed", project: target === "@unattributed" ? undefined : target,
				census: census.projects, scopeProject: target, sources: [source], lookupBeads: false, fileIndex: index, verdictOwners,
				budgetMultiplier: Math.min(4, 2 ** Math.min(2, previous?.attempts ?? 0)), onFinding: finding => { if (finding.project === target) findings.push(finding); } });
		if (source === "cc") report.coverage.push(...censusFailures.map(row => ({ ...row })));
		const relevant = report.coverage.filter(row => sourceOf(row.producer) === source);
		const partial = relevant.filter(row => row.status === "PARTIAL"), missing = relevant.filter(row => row.status === "MISSING");
		const read = source === "transcripts"
			? report.projects.some(p => p.path === target && Object.hasOwn(p.source_records, "omp-transcript"))
			: relevant.some(row => row.status === "READ");
		const retentionGap = source === "cc" && missing.some(row => row.detail.includes("No retained CC rows"));
		const bounded = report.warnings.filter(warning => (warning.includes(" bound") || warning.includes("limit reached")) && !warning.includes("bead search") || warning.includes("deadline"));
		let status: MineCellStatus = partial.length || bounded.length ? "PARTIAL" : retentionGap ? "MISSING" : read || findings.length ? "READ" : "NONE-EXISTS";
		if (status === "NONE-EXISTS" && previous && previous.status !== "NONE-EXISTS") status = "MISSING";
		const explain = (row: MineCoverage) => `${row.location}: ${row.detail.length > 1024 ? `${row.detail.slice(0, 512)} […] ${row.detail.slice(-512)}` : row.detail || "Previously inventoried source is now absent"}`;
		const reasons = status === "PARTIAL" ? [...partial.map(explain), ...bounded]
			: status === "MISSING" ? missing.map(explain)
			: status === "NONE-EXISTS" ? ["No matching source exists in the currently inventoried stores; this is not proof that historical work was quiet."] : [];
		if (reasons.length > 2048) throw new Error(`MINE_REASON_LIMIT: ${target} ${date} ${source}`);
		report.coverage = compactCoverage(report.coverage, source, target, date).filter(row => status !== "NONE-EXISTS" || row.status !== "READ");
		report.projects = report.projects.filter(p => p.path === target);
		index.flush();
		// Class/occurrence projections are rebuilt from findings; persist their evidence once, even on long export paths.
		const { occurrences: _occurrences, classes: _classes, waste_classes: _wasteClasses, ...summary } = report;
		current.push(record(ledger, { project: target, day: date, source, input_fingerprint: signature, status, reasons, result: { report: summary, findings } })); scanned++;
	}
	const uniqueFindings = new Map<string, MineSourceFinding>(), classes = new Map<string, MineClass>();
	const projects = census.projects.map(p => ({ ...p, events: 0, session_spans: 0, telemetry_sources: [] as string[], source_records: {} as Record<string, number> }));
	const excluded: MineReport["excluded_inputs"] = { unconfigured_scratch_events: 0, unbound_cli_events: 0, duplicate_events: {}, evidence: [] };
	for (const cell of current) {
		const p = projects.find(p => p.path === cell.project), sourceProject = cell.result.report.projects.find(p => p.path === cell.project);
		if (p && sourceProject) {
			p.session_spans += sourceProject.session_spans;
			for (const name of sourceProject.telemetry_sources) if (!p.telemetry_sources.includes(name)) p.telemetry_sources.push(name);
			for (const [name, rows] of Object.entries(sourceProject.source_records)) p.source_records[name] = (p.source_records[name] ?? 0) + rows;
		}
		const value = cell.result.report.excluded_inputs;
		if (cell.project === "@unattributed" || !options.all && cell.project === targets[0]) {
			excluded.unconfigured_scratch_events += value.unconfigured_scratch_events; excluded.unbound_cli_events += value.unbound_cli_events;
			for (const evidence of value.evidence) if (excluded.evidence.length < 5) excluded.evidence.push(evidence);
		} else for (const evidence of value.evidence) {
			// --all: this project cell's own duplicate citations (each summary names its reason); scratch/unbound rows come from @unattributed.
			if (excluded.evidence.length < 5 && Object.keys(value.duplicate_events).some(reason => evidence.summary.includes(`(${reason})`))) excluded.evidence.push(evidence);
		}
		// Each cell counted duplicates for its own project only (scanMine scopeProject), so every cell's counts sum once.
		for (const [reason, count] of Object.entries(value.duplicate_events)) excluded.duplicate_events[reason] = (excluded.duplicate_events[reason] ?? 0) + count;
		for (const finding of cell.result.findings) {
			const key = mineFindingKey(finding), previous = uniqueFindings.get(key);
			uniqueFindings.set(key, previous ? mergeMineFindings(previous, finding) : finding);
		}
	}
	for (const finding of uniqueFindings.values()) {
		const classKey = `${finding.project}\0${finding.class_id}`;
		let entry = classes.get(classKey);
		if (!entry) { entry = { id: finding.class_id, project: finding.project, count: 0, measured_minutes_lost: null, estimated_minutes_lost: null, unmeasured_events: 0, evidence: [], existing_beads: [], bead_search: "UNAVAILABLE", proof_it_fires: null, cheapest_enforcement: enforcement(finding.class_id) }; classes.set(classKey, entry); }
		const p = projects.find(project => project.path === finding.project);
		entry.count++; if (p) p.events++;
		if (finding.measured_minutes === null) entry.unmeasured_events++; else entry.measured_minutes_lost = (entry.measured_minutes_lost ?? 0) + finding.measured_minutes;
		if (finding.measured_minutes !== null || finding.proxy_minutes > 0) entry.estimated_minutes_lost = (entry.estimated_minutes_lost ?? 0) + (finding.measured_minutes ?? finding.proxy_minutes);
		if (entry.evidence.length < 5) entry.evidence.push(mineFindingEvidence(finding));
		for (const evidence of finding.related_evidence ?? []) {
			if (entry.evidence.length >= 5) break;
			if (!entry.evidence.some(row => row.citation === evidence.citation)) entry.evidence.push(evidence);
		}
	}
	const joined = await scanMine({ ...options, sources: [], census: projects, seedClasses: [...classes.values()], lookupBeads: true });
	const admittedClasses = new Set(joined.classes.map(c => `${c.project}\0${c.id}`));
	for (const finding of uniqueFindings.values()) {
		if (admittedClasses.has(`${finding.project}\0${finding.class_id}`)) joined.occurrences.push(mineFindingOccurrence(finding));
	}
	joined.projects = projects; joined.excluded_inputs = excluded;
	joined.coverage = current.flatMap(cell => cell.result.report.coverage);
	const totals: Record<MineCellStatus, number> = { READ: 0, PARTIAL: 0, MISSING: 0, "NONE-EXISTS": 0 };
	for (const cell of current) totals[cell.status]++;
	joined.ledger = { path: ledger.path, totals, reused, scanned, cells: current.map(cell => ({ project: cell.project, day: cell.day, source: cell.source, status: cell.status, reasons: cell.status === "READ" ? [] : cell.reasons })) };
	joined.warnings = [...new Set([...joined.warnings.filter(w => !w.startsWith("Some projects have no observed telemetry")),
		...(censusFailures.length ? ["CC project census is incomplete; configured projects are mined, but additional observed-only projects may be missing. See the named PARTIAL CC cells."] : []),
		...(totals.PARTIAL ? [`${totals.PARTIAL} source/day cells remain PARTIAL; each unresolved source and reason is named in the coverage ledger.`] : []),
		...(totals.MISSING ? [`${totals.MISSING} source/day cells are MISSING (including pre-retention/deleted inputs); missing history is not recoverable by replaying current files.`] : []),
		"Interrupted manifests contain completed receipts only; not-started project/day/source cells are rebuilt from the requested window and refreshed project census on resume.",
		"NONE-EXISTS means no matching source currently exists in the inventoried stores, not historical quiet. Resume skips unchanged completed cells; changed fingerprints invalidate receipts."])].sort();
	joined.status = totals.PARTIAL || totals.MISSING ? "PARTIAL" : joined.classes.length ? "FINDINGS" : "QUIET";
	rankMineWaste(joined);
	return joined;
}
