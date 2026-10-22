import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readPlistProgram } from "./services.ts";
import { readSafeFile } from "./safe-file.ts";
import { YAML } from "bun";

export interface MemoryReadinessInput {
	home: string;
	project?: string;
	profile?: string;
	ompPath?: string;
	/** Resolved CASS executable for read-only status metadata; null means unavailable. */
	cassPath?: string | null;
	/** Explicit OMP XDG state root, if the caller has verified its environment. */
	xdgStateHome?: string;
}
export type MemoryReadinessStatus = "DEGRADED" | "UNVERIFIED";
export interface MemoryRedactorReport {
	status: "MISSES" | "UNVERIFIED";
	version: string | null;
	coverage: "SYNTHETIC_ONLY" | "NOT_PROBED";
	missed: string[];
	reason: string;
}
export interface MemoryCassReadiness {
	configured: boolean;
	observed: "AVAILABLE" | "MAINTENANCE_REQUIRED" | "UNAVAILABLE" | "UNVERIFIED";
	retrieval_qualified: false;
	first_required_command: "cass status --json";
	source_ref: string | null;
	exit_code: number | null;
	database_exists: boolean | null;
	index_stale: boolean | null;
	reason: string;
	authorization_boundary: string;
}
export interface MemorySchedulerEntry {
	job: string;
	label: string;
	frequency: "INTERVAL" | "CALENDAR";
	source_ref: string;
}
export interface MemorySchedulerReadiness {
	state: "OBSERVED" | "UNAVAILABLE" | "UNVERIFIED";
	scheduler: "launchd" | "UNKNOWN";
	owner: "UNKNOWN";
	actual_state: "NOT_PROBED";
	source_ref: string;
	source_refs: string[];
	entries: MemorySchedulerEntry[];
	authorization_boundary: string;
}
export interface MemoryReadinessReport {
	status: MemoryReadinessStatus;
	backend: "off" | "mnemopi" | "OTHER" | "UNVERIFIED";
	configured: boolean;
	store: "NOT_APPLICABLE" | "NOT_CREATED" | "OBSERVED_SCHEMA_UNVERIFIED" | "UNKNOWN_SCHEMA" | "INACCESSIBLE" | "UNVERIFIED";
	auto_retain: boolean | null;
	auto_recall: boolean | null;
	scoping: "global" | "per-project" | "per-project-tagged" | null;
	model: "NOT_APPLICABLE" | "DISABLED" | "UNRESOLVED_ROLE" | "UNVERIFIED_LOCAL" | "UNVERIFIED_REMOTE" | "UNVERIFIED";
	embedding: "NOT_APPLICABLE" | "DISABLED_FTS_ONLY" | "UNVERIFIED_LOCAL" | "UNVERIFIED_REMOTE" | "UNVERIFIED";
	runtime: "NOT_PROBED";
	retrieval_qualified: false;
	source_refs: string[];
	cass: MemoryCassReadiness;
	scheduler: MemorySchedulerReadiness;
	reason: string;
	recommended_action: string;
	redactor: MemoryRedactorReport;
}

const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";
// Hash order: memory-backend/settings.ts, memory-backend/resolve.ts, config/settings.ts.
const MEMORY_CONFIG_SOURCE_FINGERPRINTS = new Set([
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:a8d31351ac47afac206af4a1555842074c12199f41f26a1343d71368c2f2bb2f",
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:24df81c28f1610924e3e26330db04c22508bb40c60f9dee3ce94acaf550f6584",
	// OMP 18.4.10/18.4.11 share these reviewed source hashes: default off, no-op fallback, legacy false -> off.
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:d7929e81066485010e65740f79b4cf13c6375acd52952018dc321aa0e979d023",
	// OMP 18.5.0: default off, no-op fallback, and legacy false -> off.
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:f6e978edd59e67e596cb47adfcca821aceb25c735258ca51c1cf4b141a45fa09",
	// OMP 18.7.0: default off, no-op fallback, and legacy false -> off.
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:b6667a6edd3079abe1b56c1473a9d2306ca7da6201674279d40355d338f20476",
	// OMP 18.8.1-18.8.5: config/settings.ts only makes #deepMerge assign keys as own properties (a
	// `__proto__` key no longer replaces the prototype); memory default off, no-op fallback, legacy false -> off unchanged.
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:4e41a9b93263ea27ae3a339bfc3f30eb0d4bc8d234550d5f1443d208c0ca60cf",
	// OMP 18.8.6: adds one reload when a live config file watch is armed; on-disk memory semantics unchanged.
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:b997d3564231364d176976a02a127bb91951c82ce29fc7b241dc39ddf4a4e716",
	// OMP 18.9.2: config/settings.ts only adds a read-only getConfigFiles() accessor over the existing #configFiles;
	// memory default off, no-op fallback and legacy false -> off unchanged. Agent-reviewed for omp-certify PR #90
	// (ompkit-issue-pr-autopilot-w159).
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:6a4b300e8b14ceb406aed6dbd5d9d518183195744249fb054084e107b3b326a0",
	// OMP 18.12.5/18.12.6 adds legacy memory migrations. Explicit memory.backend
	// remains authoritative, but a legacy mnemosyne object is refused below;
	// migrated provider.memoryModel remains an unverified model role.
	"64c3de6e80b7dd24207024c2a4c3f075bc4bdfb4663f4633abbbff3d5e978b29:3eb39ad1b2ef2c84b06d79a24371d1fe053db064d86e6a36f5cb321148a8bc76:0d740c1ea27a5903d6e41d10f3582940d7496b11b3ebcf617b7ef47522e47771",
]);
const MEMORY_CONFIG_SOURCE_FILES = [
	"src/memory-backend/settings.ts",
	"src/memory-backend/resolve.ts",
	"src/config/settings.ts",
] as const;
// OMP 18.5.0 memory-backend/redact.ts has this same reviewed digest; trust remains content-based.
const REDACTOR_SOURCE_SHA256 = "bec8892217e1b7a3ea577b25ff52631883fc41646351ea1f5a7b5e3359564270";
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function state(path: string): "missing" | "directory" | "file" | "unsafe" {
	try {
		const stat = lstatSync(path);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; }
	return "unsafe";
}
function safeDirectories(base: string, segments: readonly string[]): boolean {
	if (state(base) !== "directory") return false;
	let current = base;
	for (const segment of segments) { current = join(current, segment); if (state(current) !== "directory") return false; }
	return true;
}
const CASS_STATUS_COMMAND = "cass status --json";
const CASS_STATUS_TIMEOUT_MS = 2_000;
const MAX_CASS_STATUS_BYTES = 64 * 1024;
const MAX_LAUNCH_AGENT_BYTES = 64 * 1024;
const MAX_LAUNCH_AGENT_ENTRIES = 20;
const CASS_LAUNCH_AGENT_PREFIX = "com.dicklesworthstone.cass.";

function inspectCassStatus(requestedPath?: string | null): MemoryCassReadiness {
	const path = requestedPath === undefined ? Bun.which("cass") : requestedPath;
	const unavailable = (configured: boolean, source_ref: string | null, exit_code: number | null, reason: string): MemoryCassReadiness => ({
		configured, observed: configured ? "UNVERIFIED" : "UNAVAILABLE", retrieval_qualified: false,
		first_required_command: CASS_STATUS_COMMAND, source_ref, exit_code, database_exists: null, index_stale: null, reason,
		authorization_boundary: "Read-only CASS status metadata only; no searches, memory rows, repairs, indexing, or retrieval qualification.",
	});
	if (!path || !isAbsolute(path)) return unavailable(false, null, null, "CASS executable is unavailable on PATH");
	let executable: string;
	try { executable = realpathSync(path); if (state(executable) !== "file") return unavailable(false, path, null, "CASS executable path is not a regular file"); }
	catch { return unavailable(false, path, null, "CASS executable path could not be resolved"); }
	let resultStatus: number | null;
	let output: string;
	let commandError = false;
	try {
		const result = spawnSync(executable, ["status", "--json"], { encoding: "utf8", timeout: CASS_STATUS_TIMEOUT_MS, maxBuffer: MAX_CASS_STATUS_BYTES });
		resultStatus = result.status;
		output = typeof result.stdout === "string" ? result.stdout : "";
		commandError = result.error !== undefined;
	} catch { return unavailable(true, executable, null, "CASS status command failed to start"); }
	let summary: Record<string, unknown> | null = null;
	let parseFailed = false;
	try { const parsed: unknown = JSON.parse(output); if (record(parsed)) summary = parsed; else parseFailed = true; }
	catch { parseFailed = true; }
	const database = summary && record(summary.database) ? summary.database : null;
	const index = summary && record(summary.index) ? summary.index : null;
	const databaseExists = database && typeof database.exists === "boolean" ? database.exists : null;
	const indexStale = index && typeof index.stale === "boolean" ? index.stale : null;
	const observed: MemoryCassReadiness["observed"] = resultStatus === 5 || summary?.healthy === false ? "MAINTENANCE_REQUIRED" :
		!commandError && resultStatus === 0 && summary?.healthy === true ? "AVAILABLE" : "UNVERIFIED";
	const reason = observed === "MAINTENANCE_REQUIRED" ? "CASS status reports maintenance required; retrieval remains unqualified" :
		observed === "AVAILABLE" ? "CASS status metadata responded; retrieval remains unqualified" :
		commandError || resultStatus === null ? "CASS status command failed or timed out" :
		parseFailed ? "CASS status returned malformed JSON" : `CASS status exit ${resultStatus} lacks qualified health evidence`;
	return {
		configured: true, observed, retrieval_qualified: false, first_required_command: CASS_STATUS_COMMAND,
		source_ref: executable, exit_code: resultStatus, database_exists: databaseExists, index_stale: indexStale, reason,
		authorization_boundary: "Only `cass status --json` metadata was read; a successful status, database, or schedule never proves retrieval. No search, memory rows, repairs, or indexing were run.",
	};
}


function inspectMemoryScheduler(home: string): MemorySchedulerReadiness {
	const source_ref = "~/Library/LaunchAgents";
	const source_refs = [source_ref];
	const authorization_boundary = "Static LaunchAgent declarations only; loaded state, logs, job execution, memory rows, and maintainer identity are not inspected.";
	const unavailable = {
		scheduler: "UNKNOWN" as const, owner: "UNKNOWN" as const, actual_state: "NOT_PROBED" as const,
		source_ref, source_refs, entries: [] as MemorySchedulerEntry[], authorization_boundary,
	};
	const directory = join(home, "Library", "LaunchAgents");
	if (state(directory) === "missing") return { state: "UNAVAILABLE", ...unavailable };
	if (!safeDirectories(home, ["Library", "LaunchAgents"])) return { state: "UNVERIFIED", ...unavailable };
	let names: string[];
	try {
		names = readdirSync(directory).filter(name => name.startsWith(CASS_LAUNCH_AGENT_PREFIX) && name.endsWith(".plist")).sort();
	} catch { return { state: "UNVERIFIED", ...unavailable }; }
	if (!names.length) return { state: "UNAVAILABLE", ...unavailable };
	const truncated = names.length > MAX_LAUNCH_AGENT_ENTRIES;
	const entries: MemorySchedulerEntry[] = [];
	let unverified = truncated;
	for (const name of names.slice(0, MAX_LAUNCH_AGENT_ENTRIES)) {
		const fileRef = `${source_ref}/${name}`;
		source_refs.push(fileRef);
		const path = join(directory, name);
		let bytes: Buffer | null = null;
		if (state(path) === "file") {
			try { bytes = readSafeFile(path, MAX_LAUNCH_AGENT_BYTES); }
			catch { /* Keep its source reference; malformed or oversized input remains unverified. */ }
		}
		if (!bytes) { unverified = true; continue; }
		const parsed = readPlistProgram(bytes.toString("utf8"));
		const program = parsed?.program;
		const args = program?.arguments;
		const triggers = (program?.trigger ?? "").split(",");
		const interval = triggers.some(trigger => trigger.startsWith("every"));
		const calendar = triggers.includes("calendar");
		if (!parsed || parsed.label !== name.slice(0, -".plist".length) || !program || !args || basename(program.program) !== "cass" ||
			!args.includes("schedule") || !args.includes("run") || interval === calendar) {
			unverified = true;
			continue;
		}
		const jobFlag = args.indexOf("--job"), job = jobFlag >= 0 ? args[jobFlag + 1] : undefined;
		if (!job) { unverified = true; continue; }
		entries.push({ job, label: parsed.label, frequency: interval ? "INTERVAL" : "CALENDAR", source_ref: fileRef });
	}
	return {
		state: unverified ? "UNVERIFIED" : "OBSERVED",
		scheduler: entries.length ? "launchd" : "UNKNOWN", owner: "UNKNOWN", actual_state: "NOT_PROBED",
		source_ref, source_refs, entries, authorization_boundary,
	};
}
function configAt(dir: string): { data?: Record<string, unknown>; issue?: string; present: boolean; source?: string } {
	const names = ["config.yml", "config.yaml", "config.json", "settings.json"];
	const found = names.filter(name => state(join(dir, name)) !== "missing");
	if (!found.length) return { present: false };
	if (found.length !== 1 || !["config.yml", "config.yaml"].includes(found[0]!))
		return { present: true, issue: "Ambiguous or legacy profile format" };
	const source = found[0]!;
	try {
		const file = join(dir, source);
		if (state(file) !== "file") throw new Error("unsafe config");
		const parsed: unknown = YAML.parse(readSafeFile(file).toString("utf8"));
		if (!record(parsed)) throw new Error("invalid config root");
		return { present: true, data: parsed, source };
	} catch { return { present: true, issue: "Unreadable or unrecognized config", source }; }
}
function setting(root: Record<string, unknown>, group: string, key: string): unknown {
	const block = root[group];
	return record(block) ? block[key] : undefined;
}
function invalidConfig(root: Record<string, unknown>): boolean {
	for (const group of ["memory", "mnemopi", "modelRoles", "fallbackChains", "memories"]) {
		if (Object.hasOwn(root, group) && !record(root[group])) return true;
	}
	return false;
}
function inspectStore(path: string, roots: readonly string[]): MemoryReadinessReport["store"] {
	// Restrict custom paths to selected HOME/project/XDG roots and reject link traversal.
	const absolute = resolve(path);
	const base = roots.find(root => {
		const rel = relative(root, absolute);
		return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	});
	if (!base || state(base) !== "directory") return "INACCESSIBLE";
	let current = base;
	for (const segment of relative(base, dirname(absolute)).split(sep).filter(Boolean)) {
		current = join(current, segment);
		if (state(current) === "unsafe") return "INACCESSIBLE";
		if (state(current) === "missing") return "NOT_CREATED";
	}
	if (state(absolute) === "missing") return "NOT_CREATED";
	if (state(absolute) !== "file") return "INACCESSIBLE";
	try {
		const fd = openSync(absolute, NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || (stat.mode & 0o444) === 0) return "INACCESSIBLE";
			const header = Buffer.allocUnsafe(16);
			return readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from("SQLite format 3\0"))
				? "OBSERVED_SCHEMA_UNVERIFIED" : "UNKNOWN_SCHEMA";
		} finally { closeSync(fd); }
	} catch { return "INACCESSIBLE"; }
}
function installedPackage(ompPath?: string): { root: string; version: string } | null {
	if (!ompPath || !isAbsolute(ompPath)) return null;
	try {
		const launcher = realpathSync(ompPath);
		if (state(launcher) !== "file") return null;
		const root = dirname(dirname(launcher));
		const manifest: unknown = JSON.parse(readSafeFile(join(root, "package.json")).toString("utf8"));
		return record(manifest) && manifest.name === PACKAGE_NAME && typeof manifest.version === "string" ? { root, version: manifest.version } : null;
	} catch { return null; }
}
type MemoryConfigSourceReview = { reviewed: true; source_refs: string[] } | { reviewed: false; reason: string; source_refs: string[] };
function memoryConfigSourcesReviewed(root: string, version: string): MemoryConfigSourceReview {
	const source_refs: string[] = [];
	for (const directory of ["src/memory-backend", "src/config"] as const) {
		if (!safeDirectories(root, directory.split("/")))
			return { reviewed: false, reason: `OMP ${version} memory source directory ${directory} is missing or unsafe`, source_refs };
	}
	const hashes: string[] = [];
	for (const source of MEMORY_CONFIG_SOURCE_FILES) {
		try {
			const hash = createHash("sha256").update(readSafeFile(join(root, source))).digest("hex");
			hashes.push(hash);
			source_refs.push(`${source} sha256=${hash}`);
		} catch {
			source_refs.push(`${source} sha256=UNAVAILABLE`);
			return { reviewed: false, reason: `OMP ${version} memory config source hash unavailable: ${source}`, source_refs };
		}
	}
	const fingerprint = hashes.join(":");
	if (MEMORY_CONFIG_SOURCE_FINGERPRINTS.has(fingerprint)) return { reviewed: true, source_refs };
	const reviewedTuples = Array.from(MEMORY_CONFIG_SOURCE_FINGERPRINTS, value => value.split(":"));
	const unknown = hashes.flatMap((sha, index) => reviewedTuples.some(tuple => tuple[index] === sha)
		? [] : [`${MEMORY_CONFIG_SOURCE_FILES[index]} sha256=${sha}`]);
	const detail = unknown.length
		? `unreviewed file hash: ${unknown.join(", ")}`
		: `unreviewed source fingerprint combination: ${MEMORY_CONFIG_SOURCE_FILES.map((source, index) => `${source} sha256=${hashes[index]}`).join(", ")}`;
	return { reviewed: false, reason: `OMP ${version} memory config ${detail}`, source_refs };
}
function installedRedactor(ompPath?: string): { bytes: Buffer; version: string; source: string; sha256: string } | null {
	const pkg = installedPackage(ompPath);
	if (!pkg) return null;
	try {
		const source = join(pkg.root, "src", "memory-backend", "redact.ts");
		if (!safeDirectories(pkg.root, ["src", "memory-backend"]) || state(source) !== "file") return null;
		const bytes = readSafeFile(source);
		const sha = createHash("sha256").update(bytes).digest("hex");
		return { bytes, version: pkg.version, source: "src/memory-backend/redact.ts", sha256: sha };
	} catch { return null; }
}
async function probeRedactor(ompPath?: string): Promise<MemoryRedactorReport> {
	const pinned = installedRedactor(ompPath);
	if (!pinned) return { status: "UNVERIFIED", version: null, coverage: "NOT_PROBED", missed: [], reason: "Installed OMP redactor source unavailable: src/memory-backend/redact.ts (SHA-256 unavailable)" };
	if (pinned.sha256 !== REDACTOR_SOURCE_SHA256) return { status: "UNVERIFIED", version: pinned.version, coverage: "NOT_PROBED", missed: [],
		reason: `OMP ${pinned.version} redactor source hash is unreviewed: ${pinned.source} sha256=${pinned.sha256}` };
	try {
		// Evaluate only the hash-pinned, import-free installed module in memory. A
		// dynamic import (even a data URL) writes Bun's transpiler cache to XDG_CACHE_HOME.
		const js = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(pinned.bytes.toString("utf8"));
		const code = js.replaceAll(/^export function /gm, "function ");
		if (code === js || /^(?:export|import)\s/m.test(code)) throw new Error("unsupported redactor module");
		const redact: unknown = new Function(`${code}\nreturn redactMemorySecrets;`)();
		if (typeof redact !== "function") throw new Error("redactor export unavailable");
		const redactSecrets = redact as (value: string) => string;
		const cases: [string, string][] = [
			["prefixed_provider_token", ["ghp_", "SyntheticLettersAndDigits123456789"].join("")],
			["bearer_without_digits", "Bearer syntheticbearerlettersonlyforevertoken"],
			["pem_private_key", ["-----BEGIN ", "PRIVATE KEY-----\n", "syntheticprivatekeymaterialnotvalid", "\n-----END PRIVATE KEY-----"].join("")],
			["password_assignment", ["password", "=", "syntheticlettersforpasswordvalue"].join("")],
			["postgres_url", "postgres://syntheticuser:syntheticpassword@invalid.example/test"],
		];
		const missed = cases.filter(([, canary]) => {
			const output = redactSecrets(canary);
			return typeof output !== "string" || output === canary || output.includes(canary);
		}).map(([name]) => name);
		return { status: missed.length ? "MISSES" : "UNVERIFIED", version: pinned.version, coverage: "SYNTHETIC_ONLY", missed,
			reason: missed.length ? "Synthetic credential classes passed redaction unchanged; historical rows are not audited" : "Synthetic classes passed; other secret forms and historical rows are not certified" };
	} catch { return { status: "UNVERIFIED", version: pinned.version, coverage: "NOT_PROBED", missed: [], reason: "Pinned OMP redactor could not be safely exercised" }; }
}

/** Inspect memory configuration, CASS status metadata, and static scheduler declarations only; never open memory rows or invoke OMP/models/jobs. */
export async function inspectMemoryReadiness(input: MemoryReadinessInput): Promise<MemoryReadinessReport> {
	const home = resolve(input.home);
	const cass = inspectCassStatus(input.cassPath);
	const scheduler = inspectMemoryScheduler(home);
	const sourceRefs = [
		`CASS status: ${cass.source_ref ?? "unavailable"} (${cass.first_required_command})`,
		...scheduler.source_refs,
	];
	const redactor = await probeRedactor(input.ompPath);
	const base = { auto_retain: null, auto_recall: null, scoping: null, model: "UNVERIFIED" as const,
		embedding: "UNVERIFIED" as const, runtime: "NOT_PROBED" as const, retrieval_qualified: false as const, source_refs: sourceRefs, cass, scheduler, redactor };
	const unknown = (reason: string, action: string): MemoryReadinessReport => ({ ...base, status: "UNVERIFIED", backend: "UNVERIFIED", configured: false,
		store: "UNVERIFIED", source_refs: [...sourceRefs], reason, recommended_action: action });
	const ompPackage = installedPackage(input.ompPath);
	if (!ompPackage) return unknown("Installed OMP package is unavailable", "Verify the installed OMP package path before relying on this report.");
	const sourceReview = memoryConfigSourcesReviewed(ompPackage.root, ompPackage.version);
	sourceRefs.push(...sourceReview.source_refs);
	if (!sourceReview.reviewed) return unknown(sourceReview.reason, "Review the exact OMP source path and SHA-256 named in this report.");
	const name = input.profile ?? "default";
	if (name !== "default" && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name.endsWith("."))) return unknown("Profile name is unsupported", "Select an existing safe named profile.");
	const parts = name === "default" ? [".omp", "agent"] : [".omp", "profiles", name, "agent"];
	if (!safeDirectories(home, parts)) return unknown("Selected profile directory is absent or unsafe", "Inspect the selected on-disk profile without starting OMP.");
	const agentDir = join(home, ...parts);
	const profile = configAt(agentDir);
	if (profile.source) sourceRefs.push(`profile config: ${relative(home, join(agentDir, profile.source)).split(sep).join("/")}`);
	if (!profile.data || profile.issue) return unknown(profile.issue ?? "No on-disk profile configuration", "Inspect the selected YAML profile; do not run migratory omp config get.");
	if (invalidConfig(profile.data)) return unknown("Profile setting group has an unsupported shape", "Inspect memory/modelRoles YAML without running OMP.");
	let data = profile.data;
	if (input.project) {
		const project = resolve(input.project);
		if (state(project) !== "directory" || state(join(project, ".omp")) === "unsafe" || state(join(project, ".claude")) === "unsafe")
			return unknown("Project configuration location is unsafe", "Inspect project settings and rerun with a safe directory.");
		for (const file of [join(project, ".omp", "settings.json"), join(project, ".claude", "settings.json")]) {
			if (state(file) !== "missing") return unknown("Additional project settings precedence is unverified", "Inspect all effective project settings before relying on memory configuration.");
		}
		if (state(join(project, ".omp")) === "directory") {
			const override = configAt(join(project, ".omp"));
			if (override.source) sourceRefs.push(`project config: ${relative(project, join(project, ".omp", override.source)).split(sep).join("/")}`);
			if (override.issue) return unknown("Project config is unreadable or unsupported", "Inspect project YAML and rerun without executing OMP.");
			if (override.data) {
				if (invalidConfig(override.data)) return unknown("Project setting group has an unsupported shape", "Inspect project memory/modelRoles YAML.");
				data = Object.fromEntries(Object.keys(data).map(key => [key, record(data[key]) && record(override.data?.[key]) ? { ...data[key], ...override.data[key] } : data[key]]));
				for (const [key, value] of Object.entries(override.data)) if (!Object.hasOwn(data, key)) data[key] = value;
			}
		}
	} else return unknown("Project-scoped effective settings were not inspected", "Provide the session project to inspect project overrides.");
	const backend = setting(data, "memory", "backend");
	if (backend === "mnemopi" && Object.hasOwn(data, "mnemosyne"))
		return unknown("Legacy mnemosyne settings may be migrated into the effective Mnemopi config", "Inspect legacy mnemosyne settings before relying on the memory report.");
	if (backend === undefined && setting(data, "memories", "enabled") !== undefined)
		return unknown("Legacy memories.enabled requires OMP migration to resolve", "Inspect current memory.backend explicitly; do not migrate by reading settings.");
	if (backend === undefined) return unknown("Backend unset; OMP defaults and overrides are not proven", "Inspect the installed OMP defaults and selected profile before relying on memory.");
	if (backend === "off") return { ...base, status: "DEGRADED", backend, configured: false, store: "NOT_APPLICABLE", model: "NOT_APPLICABLE", embedding: "NOT_APPLICABLE",
		reason: "Selected on-disk backend OFF; runtime overrides not probed", recommended_action: "Enable memory only if desired; rule-pack testing does not require it." };
	if (backend !== "mnemopi") {
		if (["local", "hindsight", "sharpshooter"].includes(String(backend))) return { ...base, status: "UNVERIFIED", backend: "OTHER", configured: true, store: "NOT_APPLICABLE",
			reason: "Configured memory backend is not Mnemopi", recommended_action: "Inspect the selected backend separately; Mnemopi readiness is not applicable." };
		return unknown("Unknown memory.backend value", "Review backend against the installed OMP settings schema.");
	}
	const m = record(data.mnemopi) ? data.mnemopi : {};
	const bool = (key: string) => m[key] === undefined || typeof m[key] === "boolean";
	if (!["autoRetain", "autoRecall", "noEmbeddings"].every(bool) ||
		(m.scoping !== undefined && !["global", "per-project", "per-project-tagged"].includes(String(m.scoping))) ||
		(m.llmMode !== undefined && !["none", "smol", "remote"].includes(String(m.llmMode))) ||
		["dbPath", "embeddingModel", "embeddingApiUrl"].some(key => m[key] !== undefined && typeof m[key] !== "string"))
		return unknown("Mnemopi settings have unsupported values", "Inspect types and values against the installed OMP settings schema.");
	const autoRetain = m.autoRetain !== false, autoRecall = m.autoRecall !== false;
	const scoping = (m.scoping ?? "per-project") as MemoryReadinessReport["scoping"];
	const modelRoles = record(data.modelRoles) ? data.modelRoles : {};
	const selectedRole = [modelRoles.memory, modelRoles.tiny, modelRoles.smol].find(value => typeof value === "string" && value.trim()) as string | undefined;
	const llmMode = m.llmMode ?? "smol";
	const model: MemoryReadinessReport["model"] = llmMode === "none" ? "DISABLED" : llmMode === "remote" ? "UNVERIFIED_REMOTE" :
		!selectedRole ? "UNRESOLVED_ROLE" : /^(?:ollama|local|llamacpp)\//i.test(selectedRole) ? "UNVERIFIED_LOCAL" : "UNVERIFIED_REMOTE";
	const embedding: MemoryReadinessReport["embedding"] = m.noEmbeddings === true ? "DISABLED_FTS_ONLY" : m.embeddingApiUrl ? "UNVERIFIED_REMOTE" : "UNVERIFIED_LOCAL";
	const xdgHome = input.xdgStateHome ? resolve(input.xdgStateHome) : null;
	const xdgApp = xdgHome ? join(xdgHome, "omp") : null;
	const xdgRoot = xdgApp ? join(xdgApp, ...(name === "default" ? [] : ["profiles", name])) : null;
	if (xdgHome && [xdgHome, xdgApp!, xdgRoot!].some(path => state(path) === "unsafe"))
		return unknown("XDG state root is unsafe", "Inspect XDG state location without following links.");
	if (xdgApp && name !== "default" && state(join(xdgApp, "profiles")) === "unsafe")
		return unknown("XDG state profile is unsafe", "Inspect the named XDG state location without following links.");
	const stateRoot = xdgRoot && state(xdgRoot) === "directory" ? xdgRoot : agentDir;
	const dbPath = typeof m.dbPath === "string" && m.dbPath.trim() ? resolve(input.project!, m.dbPath) : join(stateRoot, "memories", "mnemopi", "mnemopi.db");
	const store = inspectStore(dbPath, [home, resolve(input.project!), ...(xdgRoot ? [xdgRoot] : [])]);
	const degraded = redactor.status === "MISSES" || store === "INACCESSIBLE" || store === "UNKNOWN_SCHEMA" ||
		cass.observed === "MAINTENANCE_REQUIRED";
	const reason = redactor.status === "MISSES" ? "Synthetic redactor misses make private retention risky" :
		cass.observed === "MAINTENANCE_REQUIRED" ? "CASS status reports maintenance required; retrieval remains unqualified" :
		store === "NOT_CREATED" ? "Mnemopi configured; no local store has been created; runtime not probed" :
		store === "OBSERVED_SCHEMA_UNVERIFIED" ? "Local SQLite header observed, schema and memory rows not inspected" :
		store === "INACCESSIBLE" || store === "UNKNOWN_SCHEMA" ? "Local store cannot be safely verified" : "Mnemopi configured; runtime availability not proved";
	const actions: string[] = [];
	if (redactor.status === "MISSES") actions.push("Do not auto-retain sensitive material; review historical rows privately and upgrade or harden the OMP redactor.");
	if (store === "INACCESSIBLE" || store === "UNKNOWN_SCHEMA") actions.push("Inspect the local store path, access and schema privately without reading memory rows by default.");
	if (model === "UNVERIFIED_LOCAL") actions.push("Verify the local model is installed and runnable out of band; a configured role can be deliberately parked.");
	else if (model === "UNRESOLVED_ROLE") actions.push("Review the memory model role and fallbacks; config alone does not prove model availability.");
	actions.push("Actual retrieval remains unqualified; where CASS is available, the first read-only command is `cass status --json`. No repair or indexing was run, and the scheduler maintainer is UNKNOWN.");
	return { ...base, status: degraded ? "DEGRADED" : "UNVERIFIED", backend: "mnemopi", configured: true, store,
		auto_retain: autoRetain, auto_recall: autoRecall, scoping, model, embedding, runtime: "NOT_PROBED", redactor,
		retrieval_qualified: false, source_refs: [...sourceRefs], cass, scheduler, reason, recommended_action: actions.join(" ") };
}
