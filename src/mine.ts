import { Database } from "bun:sqlite";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type ReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createGunzip, type Gunzip } from "node:zlib";
import { run } from "./kitlib/run.ts";
import { mineTranscripts } from "./mine-transcripts.ts";
import { mineHistory } from "./mine-history.ts";
import { MINE_SOURCES, type MineSource } from "./mine-ledger.ts";
import { runResumableMine, type MineFileIndex } from "./mine-resume.ts";
export type { MineSource } from "./mine-ledger.ts";

/** Read existing producers only. No ingest, reindex, tracker import/export or model call. */
export interface MineOptions {
	since: string; until: string; all?: boolean; project?: string;
	cwd?: string; home?: string; env?: NodeJS.ProcessEnv; root?: string; resumeDir?: string;
}
export interface MineScanOptions extends MineOptions {
	sources?: readonly MineSource[]; census?: MineProject[]; censusOnly?: boolean; lookupBeads?: boolean;
	seedClasses?: MineClass[]; fileIndex?: MineFileIndex; budgetMultiplier?: number;
	scopeProject?: string;
	verdictOwners?: Readonly<Record<string, string>>;
	onFinding?: (finding: MineSourceFinding) => void;
}
export interface MineEvidence { citation: string; timestamp: string; producer: string; summary: string }
export interface MineCoverage {
	producer: string; location: string; status: "READ" | "MISSING" | "PARTIAL";
	rows: number; first_timestamp: string | null; last_timestamp: string | null; detail: string;
}
export interface MineClass {
	id: string; project: string; count: number;
	measured_minutes_lost: number | null; estimated_minutes_lost: number | null;
	unmeasured_events: number; evidence: MineEvidence[];
	existing_beads: { id: string; title: string }[];
	bead_search: "MATCHES" | "NONE" | "UNAVAILABLE";
	cheapest_enforcement: { kind: "TTSR rule" | "preflight check" | "gate" | "skill line" | "code fix"; change: string };
}
export interface MineSourceFinding {
	class_id: string; project: string; time_ms: number; producer: string; citation: string;
	summary: string; measured_minutes: number | null; proxy_minutes: number; identity: string;
}
export interface MineSourceContext {
	home: string; projects: readonly { name: string; path: string }[]; since_ms: number; until_ms: number;
	sources?: readonly MineSource[]; targetProject?: string; skipFile?: (path: string) => boolean;
	readLines: (path: string, producer: string, consume: (row: Record<string, unknown>, citation: string) => void) => Promise<MineCoverage>;
	emit: (finding: MineSourceFinding) => void;
	markSource: (project: string, producer: string, records: number) => void;
	coverage: (producer: string, location: string, detail?: string) => MineCoverage;
	command: (argv: string[], cwd: string, deadlineSeconds?: number, outputBytes?: number) => Promise<string | null>;
	expired: () => boolean; warn: (message: string) => void;
}
export interface MineProject {
	name: string; path: string; events: number; session_spans: number; telemetry_sources: string[]; source_records: Record<string, number>;
	configured?: boolean;
}
export interface MineReport {
	schema_version: "omp-kit.mine.v1"; since: string; until: string;
	status: "FINDINGS" | "QUIET" | "PARTIAL";
	projects: MineProject[];
	classes: MineClass[]; coverage: MineCoverage[]; warnings: string[];
	inventory: { producer: string; covers: string; limits: string }[];
	excluded_inputs: { unconfigured_scratch_events: number; unbound_cli_events: number; evidence: MineEvidence[] };
	cost_basis: string;
	ledger?: { path: string; totals: Record<"READ" | "PARTIAL" | "MISSING" | "NONE-EXISTS", number>; reused: number; scanned: number;
		cells: { project: string; day: string; source: MineSource; status: "READ" | "PARTIAL" | "MISSING" | "NONE-EXISTS"; reasons: string[] }[] };
}
const MAX_ROWS = 10_000_000, MAX_FILES = 16_384, MAX_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024, MAX_LINE_BYTES = 8 * 1024 * 1024, MAX_COMMAND_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTS = 512, MAX_CLASSES = 2048, MAX_SEARCHES = 128;
const SLOW_MS = 60_000, DEADLINE_MS = 20 * 60_000;
const INVENTORY: MineReport["inventory"] = [
	{ producer: "cc.py gaps / unknowns", covers: "Existing CC gap queue and source/identity/coverage unknowns; mine reads the same cc.db projections and windowed events without running ingest.", limits: "Gap queue is current state, not a month of incidents; missing producer days and attribution remain unknown. Session tool spans have no raw stderr or timeout cause." },
	{ producer: "CC spool / spool-archive", covers: "tool.call, guard.decision, action.result and bead.status, including gzip archives; fallback when cc.db is absent.", limits: "J-43 full-month shared scan budget: 16 GiB decompressed, 1 GiB/file, 8 MiB/record, 10M records, 16384 files and 20 minutes; child output 64 MiB. Truncation is PARTIAL, never quiet proof." },
	{ producer: "gate-events / hook refusal ledgers", covers: "Commit refusals, guard friction and explicit hook timeouts; refusal counts are observations, not proof a guard is wrong.", limits: "Old rows without repo or resolvable bead stay @unattributed; no assignment from the current seat." },
	{ producer: "release-verdict / full-suite verdict store", covers: "Persisted FAIL records, exact record citations and recorded wall time; native store helper resolves shared store identity.", limits: "Legacy overwritten verdicts cannot be recovered; logs without dates are not assigned the current mtime." },
	{ producer: "bead history / REWORK", covers: "CC bead transitions (closed-to-open and rework), plus dated REWORK comments in the existing JSONL export. One read-only br search '-' census per tracker confirms canonical hyphenated ids; local literal issue/comment matches supply up to three existing-bead candidates per class.", limits: "Text matches are candidates, not proof the bead covers the defect. Snapshot diffs are observations, not complete audit history; missing exports/searches are reported. Comments and transitions on the same bead/day coalesce." },
	{ producer: "primary OMP transcripts", covers: "Native project sessions across every profile, including pre-CC October tool failures, refusal messages, timeouts and heuristic user corrections; physical citations and measured endpoints when present.", limits: "Never filtered by mtime. Primary transcripts replace overlapping normalized CC failure/friction counts, not add to them. Heuristic corrections remain labeled; missing/unmapped/oversize records remain explicit." },
	{ producer: "primary tracker / git / repo hook history", covers: "Native .br_history transitions and REWORK witnesses, dated git Revert/Supersedes commits, and timestamped repo gitdir hook/gate logs.", limits: "Snapshot transitions are observations, not complete audit receipts. Read-only snapshots only: no tracker SQLite writes or ingest. Shared/copied tracker origins and same-bead/day events coalesce." },
	{ producer: "scratch mine", covers: "Existing scratch-reap-log flags, owed scratch and expired holds.", limits: "scratch mine itself is a current ownership census, not historical incident mining; it is not invoked and no flag is appended." },
	{ producer: "flywheel", covers: "Existing hook block/audit/timeout JSONL under the flywheel state root; repeated-ritual skill remains the lesson authoring consumer.", limits: "No skill pipeline, agent dispatch or ledger mutation is triggered." },
	{ producer: "cass", covers: "Searchable transcript context for deeper investigation of the cited tool spans.", limits: "Not reindexed or queried by default: search hits repeat CC sessions and are not independently countable incidents. Raw transcript-only causes before CC retention remain a coverage gap." },
];
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const code = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 96 && !/[^a-zA-Z0-9_.:-]/.test(value) ? value : "unknown";
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const round = (n: number): number => Math.round(n * 1000) / 1000;
function timestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
function day(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("mine requires --since and --until as YYYY-MM-DD UTC dates");
	const parsed = Date.parse(`${value}T00:00:00Z`);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error("mine date is not a calendar date");
	return parsed;
}
function physical(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }

/** Match cclib.open_readonly (CCWALREAD1): recreate absent WAL side files, never the database or its rows. */
function openMineDatabase(path: string): Database {
	const sideFiles = [`${path}-wal`, `${path}-shm`];
	for (const name of [path, ...sideFiles]) {
		const info = lstatSync(name, { throwIfNoEntry: false });
		if (info?.isSymbolicLink() || info?.isFile() && info.nlink > 1) throw new Error(`Linked database path refused: ${name}`);
	}
	let database: Database | undefined;
	try {
		database = new Database(path, { readonly: true, create: false });
		database.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
	} catch (error) {
		database?.close();
		if (!(error instanceof Error && "code" in error && error.code === "SQLITE_CANTOPEN")
			|| sideFiles.some(name => lstatSync(name, { throwIfNoEntry: false }) !== undefined)) throw error;
		database = new Database(path, { readwrite: true, create: false });
	}
	try { database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN"); }
	catch (error) { database.close(); throw error; }
	return database;
}
export function enforcement(id: string): MineClass["cheapest_enforcement"] {
	if (id.startsWith("commit-refusal:")) return { kind: "preflight check", change: `Expose ${id.slice(15)} in omp-kit preflight before the commit attempt; retain the commit gate as authority.` };
	if (id.startsWith("release-fail")) return { kind: "code fix", change: "Fix the failing suite/file named by the verdict evidence; do not weaken the release gate or regenerate a passing verdict." };
	if (id === "reopened-bead" || id === "rework") return { kind: "gate", change: "Require non-author replay of the original acceptance on the exact published revision before close; include this bead's failed witness." };
	if (id.startsWith("timeout:")) return { kind: "code fix", change: "Bound and cancel the named producer's entire process group and diagnose its slow dependency; preserve timeout as failure." };
	if (id.startsWith("guard-failure:")) return { kind: "code fix", change: "Repair the named guard engine's failed observation/transport; keep a missing observation UNKNOWN instead of treating it as permission or blaming the guarded command." };
	if (id.startsWith("tool-error:")) return { kind: "code fix", change: "Replay the exact failing invocation in the cited transcript, repair its input/implementation at the responsible layer, and keep the error visible until the real path succeeds." };
	if (id === "user-correction") return { kind: "skill line", change: "Preserve the user's corrected requirement in the role's action contract; inspect the cited heuristic before promoting it into an automatic prohibition." };
	if (id.startsWith("git-")) return { kind: "code fix", change: "Inspect the cited correction commit and its reverted/superseded behavior; carry its regression witness into the owning change rather than treating a revert as proof of the root cause." };
	if (id === "bead-blocked") return { kind: "preflight check", change: "Resolve the cited blocked dependency or missing input before dispatch; do not count a snapshot status as an independent verification receipt." };
	if (id.startsWith("slow-command:")) return { kind: "code fix", change: "Profile the cited tool/command before changing it; reuse the existing bounded runner and remove the measured redundant work." };
	if (id.startsWith("scratch:")) return { kind: "skill line", change: "At task completion release owned scratch with omp-kit scratch release DIR --now; never move durable code into scratch." };
	if (/cross.repo|wrong.repo|misplac/i.test(id)) return { kind: "preflight check", change: "Resolve canonical owning repository and reservation before the write; do not use the active cwd as ownership proof." };
	return { kind: "preflight check", change: `Surface ${id.replace(/^guard-friction:/, "")} and its existing remedy before dispatch; preserve the guard and check the cited refusal for false positives.` };
}

/** Native commands supply root and resume under var/; library callers may explicitly stay ephemeral. */
export async function runMine(options: MineOptions): Promise<MineReport> {
	return options.root || options.resumeDir ? runResumableMine(options) : scanMine(options);
}

/** Existing producers remain the sole analyzers; the resume driver scopes this scanner to one cell. */
export async function scanMine(options: MineScanOptions): Promise<MineReport> {
	const since = day(options.since), until = day(options.until);
	if (until <= since || until - since > 366 * 86400_000) throw new Error("mine window must be positive and at most 366 days; --until is exclusive");
	if (options.all && options.project) throw new Error("mine accepts --project or --all, not both");
	const env = options.env ?? process.env, home = options.home ?? env.HOME ?? homedir();
	const cwd = physical(options.cwd ?? process.cwd());
	const wanted = (source: MineSource) => (options.sources ?? MINE_SOURCES).includes(source);
	const multiplier = Math.max(1, Math.min(4, options.budgetMultiplier ?? 1));
	const byteLimit = MAX_BYTES * multiplier, rowLimit = MAX_ROWS * multiplier, fileLimit = MAX_FILES * multiplier;
	const state = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "omp-kit");
	const cc = env.CC_STATE ?? join(state, "cc");
	const config = env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "omp-kit", "fleet-watch.json");
	const report: MineReport = { schema_version: "omp-kit.mine.v1", since: options.since, until: options.until, status: "QUIET", projects: [], classes: [], coverage: [], warnings: [], inventory: INVENTORY,
		excluded_inputs: { unconfigured_scratch_events: 0, unbound_cli_events: 0, evidence: [] },
		cost_basis: "Ranking: available minute estimates descending (unknown ranks at zero, not claimed zero harm), count descending, project/class lexical. Explicit cost_min or failed-tool/verdict wall time is used when recorded; unmeasured event proxies: commit refusal 2m, guard friction 1m, release FAIL 15m, REWORK/blocked/git correction 5m, reopen 10m, scratch 1m, timeout 1m. Primary transcript records without measured endpoints have unknown minutes, not invented loss. Successful slow calls count only excess over 60s. Recorded spans are summed work-time proxies, not exclusive human time or causal proof. Same-bead/day REWORK/reopen events coalesce across histories. First 5 citations per class; counts include all admitted events. UTC [since,until)." };
	const warn = (message: string) => { if (!report.warnings.includes(message)) report.warnings.push(message); };
	const projects = new Map<string, MineProject>();
	const configuredProjects = new Set<string>();
	const classes = new Map<string, MineClass>((options.seedClasses ?? []).map(c => [`${c.project}\0${c.id}`, c]));
	const beads = new Map<string, string>();
	const beadDocuments = new Map<string, string>();
	const seen = new Set<string>();
	const telemetrySeen = new Set<string>();
	const actions = new Map<string, { surface: string; repo: string | null }>();
	const deferredCc = new Map<string, MineSourceFinding>();
	const primaryObserved = new Set<string>();
	const start = performance.now(); let rows = 0, files = 0, bytes = 0, searches = 0;
	const fileLimitBytes = options.fileIndex ? byteLimit : MAX_FILE_BYTES;
	const expired = () => performance.now() - start >= DEADLINE_MS;
	function addProject(path: string, name?: string): string | null {
		if (!isAbsolute(path)) return null;
		if (projects.has(path)) return path;
		const canonical = physical(path);
		// Configured identity wins over lexical aliases such as macOS /var -> /private/var.
		if (projects.has(canonical)) return canonical;
		// Explicit fleet entries are trusted; incidental test/scratch cwds are not new projects.
		if (name === undefined && (["/tmp", "/private/tmp", "/var/tmp"].includes(path) || path.includes("/var/agent-tmp/") || path.includes("/var/folders/") || path.startsWith("/tmp/") || path.startsWith("/private/tmp/"))) return null;
		path = canonical;
		if (!projects.has(path)) {
			if (projects.size >= MAX_PROJECTS) { warn("Project limit reached (512); coverage is partial."); return null; }
			projects.set(path, { name: name ?? basename(path), path, events: 0, session_spans: 0, telemetry_sources: [], source_records: {} });
		}
		return path;
	}
	function coverage(producer: string, location: string, detail = ""): MineCoverage {
		const row: MineCoverage = { producer, location, status: "READ", rows: 0, first_timestamp: null, last_timestamp: null, detail };
		report.coverage.push(row); return row;
	}
	function observe(cov: MineCoverage, t: number | null) {
		cov.rows++;
		if (t === null || t < since || t >= until) return;
		const iso = new Date(t).toISOString();
		if (!cov.first_timestamp || iso < cov.first_timestamp) cov.first_timestamp = iso;
		if (!cov.last_timestamp || iso > cov.last_timestamp) cov.last_timestamp = iso;
	}
	function projectFor(row: Record<string, unknown>): string {
		const raw = text(row.repo) ?? text(row.cwd) ?? text(row.project_path) ?? text(row.repo_path);
		if (raw && isAbsolute(raw)) return addProject(raw) ?? "@excluded-scratch";
		if (raw) {
			const matches = [...projects.values()].filter(p => p.name === raw);
			if (matches.length === 1) return matches[0]!.path;
		}
		const bead = text(row.bead) ?? text(row.target);
		return bead && beads.has(bead) ? beads.get(bead)! : "@unattributed";
	}
	function emit(id: string, project: string, t: number, producer: string, citation: string, summary: string, measured: number | null, proxy: number, identity: string) {
		if (t < since || t >= until || seen.has(identity)) return;
		if (producer === "CC observations" || producer === "CC observations:spool") {
			if (!deferredCc.has(identity)) deferredCc.set(identity, { class_id: id, project, time_ms: t, producer: producer.endsWith(":spool") ? "CC spool" : "CC projections", citation, summary, measured_minutes: measured, proxy_minutes: proxy, identity });
			return;
		}
		seen.add(identity);
		const key = `${project}\0${id}`;
		let entry = classes.get(key);
		if (!entry) {
			if (classes.size >= MAX_CLASSES) { warn("Class limit reached (2048); coverage is partial."); return; }
			entry = { id, project, count: 0, measured_minutes_lost: null, estimated_minutes_lost: null, unmeasured_events: 0, evidence: [], existing_beads: [], bead_search: "UNAVAILABLE", cheapest_enforcement: enforcement(id) };
			classes.set(key, entry);
		}
		entry.count++;
		options.onFinding?.({ class_id: id, project, time_ms: t, producer, citation, summary, measured_minutes: measured, proxy_minutes: proxy, identity });
		if (measured !== null) entry.measured_minutes_lost = (entry.measured_minutes_lost ?? 0) + measured;
		else entry.unmeasured_events++;
		if (measured !== null || proxy > 0) entry.estimated_minutes_lost = (entry.estimated_minutes_lost ?? 0) + (measured ?? proxy);
		if (entry.evidence.length < 5) entry.evidence.push({ citation, timestamp: new Date(t).toISOString(), producer, summary });
		const p = projects.get(project);
		if (p) { p.events++; if (!p.telemetry_sources.includes(producer)) p.telemetry_sources.push(producer); }
	}
	function event(row: Record<string, unknown>, citation: string, producer: string, forcedProject?: string) {
		const data = object(row.data) ?? row;
		const t = timestamp(row.time_ms ?? row.time ?? row.ts ?? row.at ?? row.timestamp ?? row.recorded_at ?? row.finished_ms ?? data.start_ms);
		if (t === null) return;
		const type = text(row.type) ?? "";
		const actionId = text(data.action_id), action = actionId ? actions.get(actionId) : undefined;
		if (type === "action.attempt" && t < until) {
			if (actionId) actions.set(actionId, { surface: code(data.surface), repo: text(row.repo) });
			return;
		}
		if (t < since || t >= until) return;
		const project = forcedProject ?? projectFor(action?.repo && !text(row.repo) ? { ...row, repo: action.repo } : row);
		const identity = text(row.event_id) ?? text(row.id) ?? citation;
		if (project === "@excluded-scratch" || (type === "action.result" && project === "@unattributed")) {
			if (!seen.has(identity)) {
				seen.add(identity);
				if (project === "@excluded-scratch") report.excluded_inputs.unconfigured_scratch_events++;
				else report.excluded_inputs.unbound_cli_events++;
				if (report.excluded_inputs.evidence.length < 5) report.excluded_inputs.evidence.push({
					citation, timestamp: new Date(t).toISOString(), producer,
					summary: project === "@excluded-scratch" ? "Unconfigured scratch/test cwd: excluded from operational loss ranking" : "Unbound CLI result: may include planted test failures; not attributed or ranked",
				});
			}
			return;
		}
		const p = projects.get(project);
		if (p && !telemetrySeen.has(identity)) {
			telemetrySeen.add(identity);
			if (type === "tool.call") p.session_spans++;
			const source = type === "tool.call" ? "session spans" : type === "guard.decision" ? "guard decisions" : producer;
			if (!p.telemetry_sources.includes(source)) p.telemetry_sources.push(source);
		}
		const startMs = number(data.start_ms), endMs = number(data.end_ms);
		const duration = number(data.duration_ms) ?? number(data.elapsed_ms) ?? (startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null);
		const cost = number(data.cost_min) ?? (duration !== null ? duration / 60_000 : null);
		const decision = text(data.guard_decision) ?? text(data.decision) ?? text(data.kind) ?? text(data.outcome) ?? "";
		const rule = code(data.guard_rule ?? data.rule ?? data.gate ?? data.code ?? data.reason ?? data.hook);
		const tool = code(data.tool ?? data.verb ?? action?.surface ?? (type === "action.result" ? data.code : null) ?? (text(data.hook) ? basename(String(data.hook)) : producer));
		const exit = data.exit_code ?? data.code ?? data.rc;
		const timeout = data.timed_out === true || exit === 124 || exit === 142 || decision === "timeout" || data.reason === "timeout";
		if (type === "bead.status" || producer === "bead-transitions") {
			const to = text(data.to_status) ?? text(data.status), from = text(data.from_status);
			const bead = text(row.bead) ?? text(data.bead) ?? "unknown";
			if (to === "rework") emit("rework", project, t, producer, citation, `REWORK ${code(bead)}`, null, 5, `rework:${project}:${bead}:${new Date(t).toISOString().slice(0, 10)}`);
			else if (from === "closed" && to && to !== "closed" && to !== "tombstone") emit("reopened-bead", project, t, producer, citation, `closed -> ${code(to)} ${code(bead)}`, null, 10, `reopen:${project}:${bead}:${new Date(t).toISOString().slice(0, 10)}`);
			return;
		}
		if (data.verdict === "FAIL") {
			const timing = object(data.timing);
			const wall = number(timing?.wall_ms);
			emit("release-fail", project, t, producer, citation, `FAIL tree=${code(data.tree)} role=${code(data.judge_role)}`, wall === null ? null : wall / 60_000, 15, `verdict:${project}:${code(data.tree)}:${code(data.checks)}:${t}`);
			return;
		}
		if (timeout) emit(`timeout:${tool}`, project, t, producer, citation, `Explicit timeout ${tool}`, cost, 1, `timeout:${identity}`);
		else if (["refuse", "refusal", "deny", "block", "blocked", "refused", "warn", "inject"].includes(decision.toLowerCase())) {
			const commit = data.act === "commit";
			emit(`${commit ? "commit-refusal" : "guard-friction"}:${rule}`, project, t, producer, citation, `${commit ? "Commit refusal" : "Guard friction"} ${rule}`, cost, commit ? 2 : 1, `refusal:${identity}`);
		} else if (type === "guard.decision" && decision === "failure") {
			emit(`guard-failure:${code(data.engine)}`, project, t, producer, citation, `Guard engine failed to observe: ${code(data.engine)}`, cost, 1, `guard-failure:${identity}`);
		} else if (data.is_error === true || data.is_error === 1 || (typeof exit === "number" && exit !== 0) || decision === "failed" || decision === "failure") {
			emit(`command-failure:${tool}`, project, t, producer, citation, `Failed ${tool}; exit=${typeof exit === "number" ? exit : "unknown"}`, cost, 1, `failure:${identity}`);
		} else if ((type === "action.result" || (type === "tool.call" && (data.category === "process" || tool === "bash" || tool === "eval"))) && duration !== null && duration > SLOW_MS) {
			emit(`slow-command:${tool}`, project, t, producer, citation, `${tool} wall=${round(duration / 1000)}s; excess above 60s`, (duration - SLOW_MS) / 60_000, 0, `slow:${identity}`);
		} else if (producer === "scratch mine" && /flag|owed|hold.expired/i.test(String(data.event ?? ""))) {
			emit(`scratch:${code(data.event)}`, project, t, producer, citation, "Historical scratch disposal flag", null, 1, `scratch:${identity}`);
		}
	}
	function json(path: string, max = MAX_FILE_BYTES): unknown {
		const st = lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink() || st.size > max || bytes + st.size > byteLimit) throw new Error("bounded regular file required");
		bytes += st.size; return JSON.parse(readFileSync(path, "utf8"));
	}
	async function lines(path: string, producer: string, consume: (row: Record<string, unknown>, citation: string) => void) {
		const cov = coverage(producer, path);
		if (!existsSync(path)) { cov.status = "MISSING"; return cov; }
		if (producer === "omp-transcript" && options.fileIndex?.canSkip(path, since, until)) { cov.detail = "Unchanged complete timestamp index proves no records in this UTC cell."; return cov; }
		if (++files > fileLimit || expired()) { cov.status = "PARTIAL"; cov.detail = `${path}:1: Cell file/deadline bound reached`; return cov; }
		let stream: ReadStream | Gunzip | undefined;
		let source: ReadStream | undefined;
		let line = 0, min: number | null = null, max: number | null = null, safeIndex = true;
		const signature = producer === "omp-transcript" ? options.fileIndex?.signature(path) : undefined;
		try {
			const st = lstatSync(path);
			if (!st.isFile() || st.isSymbolicLink()) throw new Error("not regular");
			source = createReadStream(path, { highWaterMark: 64 * 1024 });
			stream = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
			if (stream !== source) source.on("error", error => stream?.destroy(error));
			let pending = "", length = 0, dropping = false;
			const decoder = new TextDecoder("utf-8", { fatal: true });
			for await (const chunk of stream) {
				length += chunk.length; bytes += chunk.length;
				if (length > fileLimitBytes || bytes > byteLimit || expired()) throw new Error("Cell byte/deadline bound reached");
				let decoded = decoder.decode(chunk, { stream: true });
				if (dropping) {
					const newline = decoded.indexOf("\n");
					if (newline < 0) continue;
					decoded = decoded.slice(newline + 1); line++; rows++; dropping = false;
				}
				pending += decoded;
				let end: number;
				while ((end = pending.indexOf("\n")) >= 0) {
					const raw = pending.slice(0, end); pending = pending.slice(end + 1); line++;
					if (++rows > rowLimit) throw new Error("Cell row bound reached");
					if (Buffer.byteLength(raw) > MAX_LINE_BYTES) { cov.status = "PARTIAL"; cov.detail = `${path}:${line}: Oversize record omitted; later records still scanned`; safeIndex = false; continue; }
					if (!raw.trim()) continue;
					try {
						const row = object(JSON.parse(raw));
						if (!row) throw new Error("nonobject");
						const time = timestamp(row.time_ms ?? row.time ?? row.ts ?? row.at ?? row.timestamp ?? object(row.message)?.timestamp);
						if (row.type !== "title" && row.type !== "session") {
							if (time === null) safeIndex = false;
							else { min = min === null ? time : Math.min(min, time); max = max === null ? time : Math.max(max, time); }
						}
						observe(cov, time);
						consume(row, `${path}:${line}`);
					} catch (error) { cov.status = "PARTIAL"; cov.detail = `${path}:${line}: Malformed or unprocessable row: ${String(error).slice(0, 300)}`; safeIndex = false; }
				}
				if (pending.length > MAX_LINE_BYTES) { pending = ""; dropping = true; cov.status = "PARTIAL"; cov.detail = `${path}:${line + 1}: Oversize record omitted; later records still scanned`; safeIndex = false; }
			}
			pending += decoder.decode();
			if (pending.trim() || dropping) { cov.status = "PARTIAL"; cov.detail ||= `${path}:${line + 1}: Unterminated tail omitted`; safeIndex = false; }
			if (signature && safeIndex && cov.status === "READ") options.fileIndex?.record(path, signature, min, max);
		} catch (error) { cov.status = "PARTIAL"; cov.detail ||= `${path}:${line + 1}: ${String(error).slice(0, 300)}; unread content remains unknown`; }
		finally { stream?.destroy(); source?.destroy(); }
		return cov;
	}
	try {
		const doc = options.census ? null : object(json(config, 2 * 1024 * 1024));
		for (const key of ["sessions", "herdr"]) for (const row of Array.isArray(doc?.[key]) ? doc[key] : []) {
			const p = object(row);
			if (text(p?.repo)) { const path = addProject(String(p!.repo), text(p?.session) ?? basename(String(p!.repo))); if (path) configuredProjects.add(path); }
		}
		for (const p of options.census ?? []) {
			const path = addProject(p.path, p.name); if (path && p.configured) configuredProjects.add(path);
		}
	} catch { warn("Fleet configuration unavailable; project census falls back to observed CC repos and cwd."); }
	if (!options.all && !options.project) addProject(cwd);
	let database: Database | undefined;
	const dbPath = join(cc, "cc.db");
	if ((wanted("cc") || options.censusOnly) && existsSync(dbPath)) {
		const cov = coverage("CC projections", dbPath, "Read-only snapshot of windowed tool spans, guards, action failures and bead transitions; raw sessions are not rescanned.");
		try {
			database = openMineDatabase(dbPath);
			const sql = options.censusOnly
				? "SELECT DISTINCT repo FROM events WHERE repo IS NOT NULL AND time_ms>=? AND time_ms<? LIMIT ?"
				: "SELECT e.event_id,e.cursor,e.type,e.time_ms,e.repo,e.bead,e.data FROM events e WHERE e.type IN ('tool.call','guard.decision','action.attempt','action.result','bead.status') AND (e.type<>'action.attempt' OR e.repo IS NOT NULL) AND ((e.time_ms>=? AND e.time_ms<?) OR (e.type='action.attempt' AND e.time_ms>=? AND e.time_ms<?)) ORDER BY e.time_ms,e.cursor LIMIT ?";
			const parameters = options.censusOnly ? [since, until, rowLimit + 1] : [since, until, since - 86400_000, since, rowLimit + 1];
			for (const raw of database.query(sql).iterate(...parameters)) {
				if (++rows > rowLimit || expired()) { cov.status = "PARTIAL"; cov.detail += " Cell row/deadline bound reached."; break; }
				const row = object(raw); if (!row) continue;
				observe(cov, timestamp(row.time_ms));
				if (text(row.repo)) addProject(String(row.repo));
				if (options.censusOnly) continue;
				try { row.data = JSON.parse(String(row.data)); event(row, `${dbPath}#events.cursor=${row.cursor}`, row.type === "bead.status" ? "CC projections" : "CC observations"); }
				catch { cov.status = "PARTIAL"; cov.detail += " Invalid event data."; }
			}
			const first = object(database.query("SELECT MIN(time_ms) AS first FROM events WHERE type='tool.call'").get());
			if (!options.censusOnly && (number(first?.first) === null || Number(first?.first) > since)) {
				warn("CC session history starts after --since (or is empty); earlier days are not proven quiet.");
				if (cov.rows === 0) { cov.status = "MISSING"; cov.detail = `${dbPath}: No retained CC rows in this day; first retained tool span ${first?.first === null ? "unknown" : new Date(Number(first?.first)).toISOString()}. Earlier records cannot be recovered from this store.`; }
			}
		} catch (error) { cov.status = "PARTIAL"; cov.detail = `${dbPath}: ${String(error).slice(0, 300)}; no ingest performed.`; }
		finally { database?.close(); }
	} else if (wanted("cc") || options.censusOnly) {
		coverage("CC projections", dbPath).status = "MISSING";
		for (const base of [join(cc, "spool-archive"), join(cc, "spool")]) {
			if (!existsSync(base)) { coverage("CC spool", base).status = "MISSING"; continue; }
			for (const producer of readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => compare(a.name, b.name))) {
				for (const entry of readdirSync(join(base, producer.name), { withFileTypes: true }).filter(d => d.isFile() && /\.jsonl(?:\.gz)?$/.test(d.name)).sort((a, b) => compare(a.name, b.name))) {
					// Day is append/observation day, not event time. Include later shards (backfills), then filter each event's time.
					if (/^\d{4}-\d{2}-\d{2}/.test(entry.name) && entry.name.slice(0, 10) < new Date(since - 86400_000).toISOString().slice(0, 10)) continue;
					await lines(join(base, producer.name, entry.name), "CC spool", (row, citation) => { if (text(row.repo)) addProject(String(row.repo)); event(row, citation, row.type === "bead.status" ? "CC spool" : "CC observations:spool"); });
				}
			}
		}
	}
	let targetProject = options.scopeProject;
	if (options.project) {
		if (isAbsolute(options.project) && existsSync(options.project) && lstatSync(physical(options.project)).isDirectory()) addProject(options.project, basename(options.project));
		const matches = [...projects.values()].filter(p => p.name === options.project || basename(p.path) === options.project || p.path === physical(options.project!));
		if (matches.length !== 1) throw new Error("--project must identify exactly one fleet/observed project or existing absolute checkout path");
		targetProject ??= matches[0]!.path;
		if (!options.census) for (const key of projects.keys()) if (key !== matches[0]!.path) projects.delete(key);
	} else if (!options.all) {
		targetProject ??= cwd;
		if (!options.census) for (const key of projects.keys()) if (key !== cwd) projects.delete(key);
	}
	const selectedProjects = targetProject ? new Set([targetProject]) : new Set(projects.keys());
	if (options.censusOnly) {
		report.projects = [...projects.values()].filter(p => options.all || selectedProjects.has(p.path)).map(p => ({ ...p, configured: configuredProjects.has(p.path) })).sort((a, b) => compare(a.path, b.path));
		report.status = report.coverage.some(c => c.status === "PARTIAL") ? "PARTIAL" : "QUIET";
		return report;
	}
	if (!projects.size && options.all) warn("No configured or observed projects were found.");
	// Resolve bead ids before reading old gate rows, whose only project binding may be target=BEAD.
	const trackerExports = new Set<string>();
	for (const p of wanted("tracker") || wanted("hooks") || wanted("cc") || options.lookupBeads !== false ? projects.values() : []) {
		const exportPath = join(p.path, ".beads", "issues.jsonl");
		const canonicalExport = physical(exportPath);
		if (trackerExports.has(canonicalExport)) {
			coverage("bead export", exportPath, `Shared export ${canonicalExport}; already read once.`);
			continue;
		}
		trackerExports.add(canonicalExport);
		const trackerOwner = projects.has(dirname(dirname(canonicalExport))) ? dirname(dirname(canonicalExport)) : p.path;
		await lines(exportPath, "bead export", (row, citation) => {
			const id = text(row.id); if (!id) return;
			const declaredOrigin = text(row.source_repo_path), origin = declaredOrigin && isAbsolute(declaredOrigin) ? physical(declaredOrigin) : trackerOwner;
			const beadOwner = projects.has(origin) ? origin : trackerOwner;
			beads.set(id, beadOwner);
			beadDocuments.set(`${canonicalExport}\0${id}`, [text(row.title), text(row.description), text(row.notes),
				...(Array.isArray(row.comments) ? row.comments.map(c => text(object(c)?.text) ?? text(object(c)?.body)) : [])].filter(Boolean).join("\n").toLowerCase());
			for (const comment of wanted("tracker") ? Array.isArray(row.comments) ? row.comments : [] : []) {
				const c = object(comment); const content = text(c?.text) ?? text(c?.body) ?? "";
				const t = timestamp(c?.created_at ?? c?.timestamp);
				if (t !== null && /^(?:REWORK\b|(?:VERDICT|Verdict):[ \t]*REWORK\b)/.test(content.trimStart())) emit("rework", beadOwner, t, "bead export", `${citation}#comment=${code(c?.id)}`, `REWORK ${code(id)}`, null, 5, `rework:${beadOwner}:${id}:${new Date(t).toISOString().slice(0, 10)}`);
			}
		});
	}
	if (wanted("hooks")) {
	for (const suffix of [".1", ""]) await lines(join(state, `gate-events.jsonl${suffix}`), "gate-events", (r, c) => event(r, c, "gate-events"));
	for (const suffix of [".1", ""]) await lines(join(state, `scratch-reap-log.jsonl${suffix}`), "scratch mine", (r, c) => event(r, c, "scratch mine"));
	const flywheel = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "flywheel");
	if (existsSync(flywheel)) {
		let oldFiles = 0;
		for (const entry of readdirSync(flywheel, { withFileTypes: true }).filter(d => d.isFile() && /(?:block|refus|timeout|audit).*\.jsonl$/.test(d.name)).sort((a, b) => compare(a.name, b.name))) {
			// A log last written before the window cannot contain contemporaneously recorded October events.
			// Never use mtime to timestamp an event; newer/backfilled files still filter every row's timestamp.
			if (lstatSync(join(flywheel, entry.name)).mtimeMs < since) { oldFiles++; continue; }
			await lines(join(flywheel, entry.name), "hook refusals", (row, citation) => event(row, citation, "hook refusals"));
		}
		if (oldFiles) coverage("hook refusals", flywheel, `${oldFiles} historical logs last written before --since were not read; no event dates inferred from mtime.`);
	} else coverage("hook refusals", flywheel).status = "MISSING";
	}
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined && !key.startsWith("BEADS_") && !key.startsWith("BR_") && !key.startsWith("GIT_")) childEnv[key] = value;
	childEnv.HOME = home; childEnv.PYTHONDONTWRITEBYTECODE = "1";
	async function command(argv: string[], cwd: string, deadlineSeconds = 3, outputBytes = 1024 * 1024): Promise<string | null> {
		if (expired() || bytes >= byteLimit) return null;
		try {
			const result = await run(["nice", "-n", "10", ...argv], { cwd, env: childEnv, deadline_s: Math.min(deadlineSeconds, Math.max(0.05, (DEADLINE_MS - (performance.now() - start)) / 1000)), grace_s: 0.1, max_output_bytes: Math.min(outputBytes, byteLimit - bytes) });
			bytes += result.stdout.length + result.stderr.length;
			if (result.rc !== 0 || result.timed_out || result.truncated) return null;
			return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
		} catch { return null; }
	}
	// Cache the native tracker census once, before large session archives can consume the scan budget.
	const searchCache = new Map<string, { id: string; title: string; document: string }[] | null>();
	for (const p of options.lookupBeads === false ? [] : projects.values()) {
		if ((!options.all && !selectedProjects.has(p.path)) || searches >= MAX_SEARCHES || expired()) continue;
		const tracker = join(p.path, ".beads", "issues.jsonl");
		if (!existsSync(tracker)) continue;
		const canonicalTracker = physical(tracker);
		if (searchCache.has(canonicalTracker)) continue;
		searches++;
		const result = await command(["br", "--db", join(p.path, ".beads", "beads.db"), "--no-db", "--no-auto-import", "--no-auto-flush", "search", "-", "--all", "--limit", "0", "--sort", "title", "--json"], p.path, 20, MAX_COMMAND_BYTES);
		searchCache.set(canonicalTracker, null);
		if (result !== null) try {
			const parsed: unknown = JSON.parse(result), records = Array.isArray(parsed) ? parsed : object(parsed)?.issues;
			if (Array.isArray(records)) searchCache.set(canonicalTracker, records.flatMap(value => {
				const row = object(value), id = text(row?.id), title = text(row?.title);
				return id && title ? [{ id, title, document: beadDocuments.get(`${canonicalTracker}\0${id}`) ?? [title, text(row?.description), text(row?.notes)].filter(Boolean).join("\n").toLowerCase() }] : [];
			}));
		} catch { /* Invalid native census stays UNAVAILABLE. */ }
	}
	const sourceContext: MineSourceContext = {
		home, projects: [...projects.values()].filter(p => options.census || options.all || selectedProjects.has(p.path)), since_ms: since, until_ms: until,
		sources: options.sources, targetProject, skipFile: options.fileIndex ? path => options.fileIndex!.canSkip(path, since, until) : undefined,
		readLines: lines, command, expired, warn, coverage,
		emit: f => emit(f.class_id, f.project, f.time_ms, f.producer, f.citation, f.summary, f.measured_minutes, f.proxy_minutes, f.identity),
		markSource: (project, producer, records) => {
			const p = projects.get(project); if (!p) return;
			if (!p.telemetry_sources.includes(producer)) p.telemetry_sources.push(producer);
			p.source_records[producer] = (p.source_records[producer] ?? 0) + records;
			if (producer.includes("transcript") && records > 0) primaryObserved.add(project);
		},
	};
	// Compact tracker/git evidence must not be starved by large primary session archives.
	await mineHistory(sourceContext);
	const stores = new Map<string, string>();
	for (const p of wanted("hooks") ? projects.values() : []) {
		if (expired()) break;
		if (!options.all && !selectedProjects.has(p.path)) continue;
		if (targetProject && p.path !== targetProject) continue;
		// git walks upward: never charge an unversioned nested project for its ancestor's failures.
		const top = await command(["git", "-C", p.path, "rev-parse", "--show-toplevel"], p.path);
		if (!top || physical(top) !== p.path) continue;
		const gitdir = await command(["git", "-C", p.path, "rev-parse", "--absolute-git-dir"], p.path);
		if (gitdir && isAbsolute(gitdir)) stores.set(join(gitdir, "omp-kit", "full-suite-verdicts"), p.path);
		const helper = options.root ? join(options.root, "scripts", "full-suite-verdict-store.py") : null;
		if (helper && existsSync(helper)) {
			const timings = await command(["python3", "-B", helper, "timings", "--repo", p.path], p.path);
			if (timings && isAbsolute(timings)) {
				const store = dirname(timings), previous = stores.get(store);
				// A shared origin store belongs to the configured canonical checkout, not the last observed disposable clone.
				if (!previous || (configuredProjects.has(p.path) && !configuredProjects.has(previous))) stores.set(store, p.path);
			}
			else warn(`Shared verdict store resolution unavailable for ${p.path}.`);
		}
	}
	for (const [store, project] of [...stores].sort((a, b) => compare(a[0], b[0]))) {
		if (options.verdictOwners?.[physical(store)] && options.verdictOwners[physical(store)] !== project) continue;
		if (!existsSync(store)) { coverage("release-verdict", store).status = "MISSING"; continue; }
		for (const directory of [store, join(store, "ci-only")]) {
			if (!existsSync(directory)) continue;
			for (const entry of readdirSync(directory, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith(".json")).sort((a, b) => compare(a.name, b.name))) {
				const path = join(directory, entry.name), cov = coverage("release-verdict", path);
				if (++files > fileLimit || expired()) { cov.status = "PARTIAL"; cov.detail = `${path}: Cell file/deadline bound`; break; }
				try {
					const row = object(json(path, 4 * 1024 * 1024));
					if (!row || (row.verdict !== "PASS" && row.verdict !== "FAIL")) { cov.detail = "Not a complete verdict record; ignored"; continue; }
					const timing = object(row.timing), t = timestamp(row.recorded_at ?? row.finished_ms ?? timing?.started_ms);
					observe(cov, t);
					if (t === null) { cov.status = "PARTIAL"; cov.detail = "Undated verdict cannot be placed in requested month"; continue; }
					event({ ...row, time_ms: t }, path, "release-verdict", project);
				} catch { cov.status = "PARTIAL"; cov.detail = "Unreadable or invalid verdict record"; }
			}
		}
	}
	if (wanted("transcripts")) await mineTranscripts(sourceContext);
	for (const f of deferredCc.values()) if (!primaryObserved.has(f.project)) emit(f.class_id, f.project, f.time_ms, f.producer, f.citation, f.summary, f.measured_minutes, f.proxy_minutes, f.identity);
	report.projects = [...projects.values()].filter(p => options.all || selectedProjects.has(p.path)).sort((a, b) => compare(a.path, b.path));
	for (const p of report.projects) p.telemetry_sources.sort(compare);
	report.classes = [...classes.values()].filter(c => (options.all ? projects.has(c.project) || c.project === "@unattributed" : selectedProjects.has(c.project)))
		.sort((a, b) => (b.estimated_minutes_lost ?? 0) - (a.estimated_minutes_lost ?? 0) || b.count - a.count || compare(a.project, b.project) || compare(a.id, b.id));
	for (const c of report.classes) {
		c.measured_minutes_lost = c.measured_minutes_lost === null ? null : round(c.measured_minutes_lost);
		c.estimated_minutes_lost = c.estimated_minutes_lost === null ? null : round(c.estimated_minutes_lost);
		if (c.project === "@unattributed") continue;
		const tracker = join(c.project, ".beads", "issues.jsonl");
		if (!existsSync(tracker)) continue;
		const canonicalTracker = physical(tracker);
		const candidates = searchCache.get(canonicalTracker);
		if (!candidates) continue;
		const query = (c.id === "reopened-bead" ? "reopen" : c.id === "release-fail" ? "release" : c.id.includes(":") ? c.id.slice(c.id.indexOf(":") + 1) : c.id.replaceAll("-", " ")).toLowerCase();
		c.existing_beads = candidates.filter(row => row.document.includes(query)).slice(0, 3).map(({ id, title }) => ({ id, title }));
		c.bead_search = c.existing_beads.length ? "MATCHES" : "NONE";
	}
	if (report.classes.some(c => c.bead_search === "UNAVAILABLE")) warn("Some existing-bead searches unavailable or bounded; UNAVAILABLE is not 'none'. @unattributed events are not assigned by guess.");
	if (report.excluded_inputs.unconfigured_scratch_events || report.excluded_inputs.unbound_cli_events) warn("Unconfigured scratch/test cwds and unbound CLI telemetry are quarantined in excluded_inputs, not ranked as operational loss.");
	if (report.projects.some(p => p.telemetry_sources.length === 0)) warn("Some projects have no observed telemetry in this window; their zero events do not mean quiet.");
	if (expired()) warn("20-minute mining deadline reached; output is partial.");
	if (bytes >= byteLimit || rows >= rowLimit || files >= fileLimit) warn("Mining cell resource bound reached; output is partial.");
	if (report.coverage.some(c => c.status === "PARTIAL") || report.warnings.length) report.status = "PARTIAL";
	else report.status = report.classes.length ? "FINDINGS" : "QUIET";
	report.warnings.sort(compare);
	return report;
}

function markdown(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/[\r\n]/g, " ").replaceAll("`", "'"); }
export function renderMine(report: MineReport): string {
	const lines = [`# Mining ${report.since} to ${report.until} (UTC, exclusive)`, "", `Status: **${report.status}**. ${report.projects.length} projects; ${report.classes.reduce((sum, c) => sum + c.count, 0)} observed incidents in ${report.classes.length} classes.`, "", report.cost_basis, "", "| Rank | Project | Class | Count | Recorded min | Ranked estimate min | Existing bead | Cheapest enforcement |", "| --- | --- | --- | ---: | ---: | ---: | --- | --- |"];
	for (const [index, c] of report.classes.entries()) lines.push(`| ${index + 1} | ${markdown(c.project)} | ${c.id} | ${c.count} | ${c.measured_minutes_lost ?? "unknown"} | ${c.estimated_minutes_lost ?? "unknown"} | ${c.existing_beads.map(b => markdown(b.id)).join(", ") || (c.bead_search === "NONE" ? "none" : "UNAVAILABLE")} | ${c.cheapest_enforcement.kind}: ${markdown(c.cheapest_enforcement.change)} |`);
	if (!report.classes.length) lines.push("", "No matching events found in readable inputs; missing/partial coverage is not proof that the month was quiet.");
	for (const c of report.classes) {
		lines.push("", `## ${markdown(c.project)} — ${c.id}`, c.cheapest_enforcement.change);
		for (const e of c.evidence) lines.push(`- ${e.timestamp} ${e.producer}: ${markdown(e.summary)} — \`${markdown(e.citation)}\``);
	}
	if (report.ledger) {
		lines.push("", "## Resumable UTC coverage ledger", `Ledger: \`${markdown(report.ledger.path)}\``,
			`READ ${report.ledger.totals.READ}; PARTIAL ${report.ledger.totals.PARTIAL}; MISSING ${report.ledger.totals.MISSING}; NONE-EXISTS ${report.ledger.totals["NONE-EXISTS"]}. Reused ${report.ledger.reused}; scanned ${report.ledger.scanned} cells.`,
			"Each cell is one project, one UTC day and one source. NONE-EXISTS describes currently inventoried stores, not proof of historical quiet.");
		for (const cell of report.ledger.cells) if (cell.status !== "READ" && cell.status !== "NONE-EXISTS") lines.push(`- ${cell.status} ${cell.day} ${cell.source} \`${markdown(cell.project)}\`: ${cell.reasons.map(markdown).join("; ")}`);
	}
	lines.push("", "## Project census");
	for (const p of report.projects) {
		lines.push(`- ${markdown(p.name)}: \`${markdown(p.path)}\` — ${p.events} observed events; ${p.session_spans} normalized CC spans; sources: ${p.telemetry_sources.map(source => `${markdown(source)}${p.source_records[source] !== undefined ? ` (${p.source_records[source]} records)` : ""}`).join(", ") || "NONE (not proof of quiet)"}`);
		const top = report.classes.filter(c => c.project === p.path).slice(0, 3);
		if (top.length) lines.push(`  - Top classes: ${top.map(c => `${c.id}: ${c.count} events, ${c.estimated_minutes_lost ?? "unknown"} estimated min`).join("; ")}`);
	}
	lines.push("", "## Quarantined telemetry (not ranked)",
		`Unconfigured scratch/test events: ${report.excluded_inputs.unconfigured_scratch_events}; unbound CLI results: ${report.excluded_inputs.unbound_cli_events}. These are retained as a data-quality defect, never assigned to a project by guess.`);
	for (const e of report.excluded_inputs.evidence) lines.push(`- ${e.timestamp}: ${e.summary} — \`${markdown(e.citation)}\``);
	lines.push("", "## Coverage and limitations");
	for (const warning of report.warnings) lines.push(`- **${markdown(warning)}**`);
	for (const c of report.coverage) if (c.status !== "READ" || c.rows > 0) lines.push(`- ${c.status} ${c.producer}: \`${markdown(c.location)}\` (${c.rows} rows; window ${c.first_timestamp ?? "unknown"} … ${c.last_timestamp ?? "unknown"}) ${markdown(c.detail)}`);
	lines.push("", "## Existing mining inventory");
	for (const item of report.inventory) lines.push(`- **${item.producer}**: ${item.covers} Limitation: ${item.limits}`);
	return lines.join("\n") + "\n";
}
