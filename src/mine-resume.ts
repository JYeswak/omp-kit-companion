import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { run } from "./kitlib/run.ts";
import { MineLedger, MINE_SOURCES, type MineCell, type MineCellStatus, type MineSource } from "./mine-ledger.ts";
import { enforcement, scanMine, type MineClass, type MineCoverage, type MineOptions, type MineProject, type MineReport, type MineSourceFinding } from "./mine.ts";

export interface MineFileIndex {
	canSkip(path: string, since: number, until: number): boolean;
	signature(path: string): string | undefined;
	record(path: string, signature: string, min: number | null, max: number | null): void;
}
type TimeReceipt = { signature: string; min: number | null; max: number | null };
type Payload = { report: MineReport; findings: MineSourceFinding[] };
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
		|| !Array.isArray(value.report.coverage) || !Array.isArray(value.report.classes) || !Array.isArray(value.findings) || !object(value.report.excluded_inputs)) return false;
	return value.findings.every(row => object(row) && typeof row.identity === "string" && typeof row.project === "string" && typeof row.class_id === "string"
		&& typeof row.time_ms === "number" && Number.isFinite(row.time_ms) && typeof row.producer === "string" && typeof row.citation === "string" && typeof row.summary === "string"
		&& (row.measured_minutes === null || typeof row.measured_minutes === "number" && Number.isFinite(row.measured_minutes) && row.measured_minutes >= 0)
		&& typeof row.proxy_minutes === "number" && Number.isFinite(row.proxy_minutes) && row.proxy_minutes >= 0);
}

/** Metadata is a cache invalidator only; event inclusion still always uses event timestamps. */
function fingerprint(paths: string[]): string {
	const hash = createHash("sha256"); let entries = 0;
	function visit(path: string, depth = 0): void {
		if (++entries > 200_000 || depth > 40) throw new Error(`MINE_INPUT_CENSUS_BOUND: ${path}`);
		try {
			const s = lstatSync(path, { bigint: true });
			hash.update(JSON.stringify([path, String(s.dev), String(s.ino), String(s.mode), String(s.size), String(s.mtimeNs), String(s.ctimeNs)]));
			if (s.isSymbolicLink()) { const target = physical(path); if (target !== path) visit(target, depth + 1); }
			else if (s.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
		} catch (error) { hash.update(JSON.stringify([path, String(error)])); if (String(error).includes("MINE_INPUT_CENSUS_BOUND")) throw error; }
	}
	for (const path of [...new Set(paths)].sort()) visit(path);
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
	if (census.status === "PARTIAL") throw new Error(`MINE_CENSUS_INCOMPLETE: ${census.coverage.filter(c => c.status === "PARTIAL").map(c => c.detail).join("; ")}`);
	const env = options.env ?? process.env, home = options.home ?? env.HOME ?? homedir();
	const root = physical(options.resumeDir ?? join(options.root ?? options.cwd ?? process.cwd(), "var", "mine"));
	const revisionHash = createHash("sha256");
	for (const name of ["mine.ts", "mine-resume.ts", "mine-ledger.ts", "mine-history.ts", "mine-transcripts.ts"]) {
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
	for (const target of targets) for (const source of MINE_SOURCES) {
		const dir = target === "@unattributed" ? null : gitdir(target);
		const paths = source === "transcripts" ? transcriptRoots : source === "tracker" ? [join(target, ".beads", "issues.jsonl"), join(target, ".beads", ".br_history")]
			: source === "git" ? dir ? [join(dir, "HEAD"), join(dir, "refs"), join(dir, "packed-refs"), join(dir, "commondir"), join(dir, "shallow")] : [join(target, ".git")]
			: source === "cc" ? [env.CC_STATE ?? join(state, "cc")]
			: [join(state, "gate-events.jsonl"), join(state, "gate-events.jsonl.1"), join(state, "scratch-reap-log.jsonl"), join(state, "scratch-reap-log.jsonl.1"), join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "flywheel"), ...(dir ? [join(dir, "omp-kit")] : []), ...(stores.get(target) ?? [])];
		const pathsKey = JSON.stringify(paths), digest = pathFingerprints.get(pathsKey) ?? fingerprint(paths);
		pathFingerprints.set(pathsKey, digest);
		fingerprints.set(JSON.stringify([target, source]), digest);
	}
	let reused = 0, scanned = 0;
	const current: MineCell<Payload>[] = [];
	for (const target of targets) for (const source of MINE_SOURCES) for (const date of days) {
		const signature = fingerprints.get(JSON.stringify([target, source]))!, previous = old.get(key(target, date, source));
		if (previous && previous.input_fingerprint === signature && previous.status !== "PARTIAL" && payload(previous.result)) { current.push(previous as MineCell<Payload>); reused++; continue; }
		const findings: MineSourceFinding[] = [], until = new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
		const synthetic = target === "@unattributed" && source !== "cc" && source !== "hooks";
		const report = synthetic ? { ...census, projects: [], classes: [], coverage: [], warnings: [], excluded_inputs: { unconfigured_scratch_events: 0, unbound_cli_events: 0, evidence: [] } }
			: await scanMine({ ...options, since: date, until, all: target === "@unattributed", project: target === "@unattributed" ? undefined : target,
				census: census.projects, scopeProject: target, sources: [source], lookupBeads: false, fileIndex: index, verdictOwners,
				budgetMultiplier: Math.min(4, 2 ** Math.min(2, previous?.attempts ?? 0)), onFinding: finding => { if (finding.project === target) findings.push(finding); } });
		const relevant = report.coverage.filter(row => sourceOf(row.producer) === source);
		const partial = relevant.filter(row => row.status === "PARTIAL"), missing = relevant.filter(row => row.status === "MISSING");
		const read = source === "transcripts"
			? report.projects.some(p => p.path === target && Object.hasOwn(p.source_records, "omp-transcript"))
			: relevant.some(row => row.status === "READ");
		const retentionGap = source === "cc" && missing.some(row => row.detail.includes("No retained CC rows"));
		const bounded = report.warnings.filter(warning => warning.includes("bound") && !warning.includes("bead search") || warning.includes("deadline"));
		let status: MineCellStatus = partial.length || bounded.length ? "PARTIAL" : retentionGap ? "MISSING" : read || findings.length ? "READ" : "NONE-EXISTS";
		if (status === "NONE-EXISTS" && previous && previous.status !== "NONE-EXISTS") status = "MISSING";
		const explain = (row: MineCoverage) => `${row.location}: ${row.detail.length > 1024 ? `${row.detail.slice(0, 512)} […] ${row.detail.slice(-512)}` : row.detail || "Previously inventoried source is now absent"}`;
		const reasons = status === "PARTIAL" ? [...partial.map(explain), ...bounded]
			: status === "MISSING" ? missing.map(explain)
			: status === "NONE-EXISTS" ? ["No matching source exists in the currently inventoried stores; this is not proof that historical work was quiet."] : [];
		if (reasons.length > 2048) throw new Error(`MINE_REASON_LIMIT: ${target} ${date} ${source}`);
		report.coverage = compactCoverage(report.coverage, source, target, date).filter(row => status !== "NONE-EXISTS" || row.status !== "READ");
		report.classes = report.classes.filter(c => c.project === target);
		report.projects = report.projects.filter(p => p.path === target);
		index.flush();
		current.push(ledger.put({ project: target, day: date, source, input_fingerprint: signature, status, reasons, result: { report, findings } })); scanned++;
	}
	const primary = new Set(current.filter(cell => cell.source === "transcripts" && cell.result.report.projects.some(p => (p.source_records["omp-transcript"] ?? 0) > 0)).map(cell => `${cell.project}\0${cell.day}`));
	const seen = new Set<string>(), classes = new Map<string, MineClass>();
	const projects = census.projects.map(p => ({ ...p, events: 0, session_spans: 0, telemetry_sources: [] as string[], source_records: {} as Record<string, number> }));
	const excluded: MineReport["excluded_inputs"] = { unconfigured_scratch_events: 0, unbound_cli_events: 0, evidence: [] };
	for (const cell of current) {
		const p = projects.find(p => p.path === cell.project), sourceProject = cell.result.report.projects.find(p => p.path === cell.project);
		if (p && sourceProject) {
			p.session_spans += sourceProject.session_spans;
			for (const name of sourceProject.telemetry_sources) if (!p.telemetry_sources.includes(name)) p.telemetry_sources.push(name);
			for (const [name, rows] of Object.entries(sourceProject.source_records)) p.source_records[name] = (p.source_records[name] ?? 0) + rows;
		}
		if (cell.project === "@unattributed" || !options.all && cell.project === targets[0]) {
			const value = cell.result.report.excluded_inputs;
			excluded.unconfigured_scratch_events += value.unconfigured_scratch_events; excluded.unbound_cli_events += value.unbound_cli_events;
			for (const evidence of value.evidence) if (excluded.evidence.length < 5) excluded.evidence.push(evidence);
		}
		for (const finding of cell.result.findings) {
			if (seen.has(finding.identity) || cell.source === "cc" && primary.has(`${cell.project}\0${cell.day}`) && finding.class_id !== "rework" && finding.class_id !== "reopened-bead") continue;
			seen.add(finding.identity);
			const classKey = `${finding.project}\0${finding.class_id}`;
			let entry = classes.get(classKey);
			if (!entry) { entry = { id: finding.class_id, project: finding.project, count: 0, measured_minutes_lost: null, estimated_minutes_lost: null, unmeasured_events: 0, evidence: [], existing_beads: [], bead_search: "UNAVAILABLE", cheapest_enforcement: enforcement(finding.class_id) }; classes.set(classKey, entry); }
			entry.count++; if (p) p.events++;
			if (finding.measured_minutes === null) entry.unmeasured_events++; else entry.measured_minutes_lost = (entry.measured_minutes_lost ?? 0) + finding.measured_minutes;
			if (finding.measured_minutes !== null || finding.proxy_minutes > 0) entry.estimated_minutes_lost = (entry.estimated_minutes_lost ?? 0) + (finding.measured_minutes ?? finding.proxy_minutes);
			if (entry.evidence.length < 5) entry.evidence.push({ citation: finding.citation, timestamp: new Date(finding.time_ms).toISOString(), producer: finding.producer, summary: finding.summary });
		}
	}
	const joined = await scanMine({ ...options, sources: [], census: projects, seedClasses: [...classes.values()], lookupBeads: true });
	joined.projects = projects; joined.excluded_inputs = excluded;
	joined.coverage = current.flatMap(cell => cell.result.report.coverage);
	const totals: Record<MineCellStatus, number> = { READ: 0, PARTIAL: 0, MISSING: 0, "NONE-EXISTS": 0 };
	for (const cell of current) totals[cell.status]++;
	joined.ledger = { path: ledger.path, totals, reused, scanned, cells: current.map(cell => ({ project: cell.project, day: cell.day, source: cell.source, status: cell.status, reasons: cell.status === "READ" ? [] : cell.reasons })) };
	joined.warnings = [...new Set([...joined.warnings.filter(w => !w.startsWith("Some projects have no observed telemetry")),
		...(totals.PARTIAL ? [`${totals.PARTIAL} source/day cells remain PARTIAL; each unresolved source and reason is named in the coverage ledger.`] : []),
		...(totals.MISSING ? [`${totals.MISSING} source/day cells are MISSING (including pre-retention/deleted inputs); missing history is not recoverable by replaying current files.`] : []),
		"Interrupted manifests contain completed receipts only; not-started project/day/source cells are rebuilt from the requested window and refreshed project census on resume.",
		"NONE-EXISTS means no matching source currently exists in the inventoried stores, not historical quiet. Resume skips unchanged completed cells; changed fingerprints invalidate receipts."])].sort();
	joined.status = totals.PARTIAL || totals.MISSING ? "PARTIAL" : joined.classes.length ? "FINDINGS" : "QUIET";
	return joined;
}
