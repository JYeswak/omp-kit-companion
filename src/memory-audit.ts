import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { inspectMemoryReadiness, type MemoryRedactorReport } from "./memory-readiness.ts";

/** Explicit, separate opt-in. Never call from default status/doctor. */
export interface MemoryAuditInput {
	consent?: "AUDIT_PRIVATE_MEMORY";
	home: string;
	project: string;
	/** Absolute directory containing mnemopi.db and optional banks/<name>/mnemopi.db. */
	storeRoot: string;
	ompPath: string;
	/** If supplied, must match *all* discovered banks exactly; never restrict scanning to this subset. */
	expectedBanks?: readonly string[];
}
export interface MemoryAuditCoverage {
	banks_discovered: number;
	banks_scanned: number;
	stores_discovered: number;
	stores_scanned: number;
	working_rows: number;
	episodic_rows: number;
	total_rows: number;
	fields: readonly ["working_memory.content", "episodic_memory.content"];
}
export type MemoryAuditReason = "CONSENT_REQUIRED" | "UNSUPPORTED_SOURCE" | "UNSAFE_STORE" | "UNSUPPORTED_SCHEMA" | "INCOMPLETE_BANKS";
export interface MemoryAuditReport {
	status: "MATCHES" | "NO_MATCHES_IN_COVERED_CLASSES" | "UNVERIFIED";
	reason: MemoryAuditReason | "COVERED_CONTENT_ONLY";
	version: string | null;
	coverage: MemoryAuditCoverage | null;
	categories: Record<CredentialCategory, number>;
	redactor?: MemoryRedactorReport;
}

type CredentialCategory = "provider_token" | "bearer_token" | "private_key" | "password_assignment" | "credential_url";
type PackageName = "agent" | "mnemopi";
type SourcePin = readonly [PackageName, string, string];
const REVIEWED_SOURCE_PIN_SETS: readonly (readonly SourcePin[])[] = [
	[
		// OMP and pi-mnemopi 18.4.2 source tuple, reviewed for the covered schema.
		["agent", "src/mnemopi/config.ts", "d2a82faea2c60a1ace7f5ace41fb467ee3287b567bda309de66804c594d9be6c"],
		["agent", "src/mnemopi/state.ts", "5977f6855b7cbca1d68dda1328d5554b63f7581b0778b3f533e6a394e81ab3e4"],
		["mnemopi", "src/core/banks.ts", "8368a0b90565969abbf7d8af108589fd40ff6926ee4b7a1c087ef9f3a02c23c2"],
		["mnemopi", "src/core/beam/schema.ts", "95490e3c2b7e4325cde97fadf3572d76f11e28491e24574b27ff885171058ed0"],
		["mnemopi", "src/db.ts", "f953df31825c4df7c0051186fb6ad5a50507b63dd70a068e01b70bd8be9174fd"],
		["mnemopi", "src/core/episodic-graph.ts", "1148ffd68c02296b862660fa1ebed8a3bf7e262fd329b40682b493366f09621d"],
		["mnemopi", "src/core/query-cache.ts", "6c9968cfd5125834e5c99b76b2557abb9a4176ef5ebc133a3cbc35617e022b58"],
		["mnemopi", "src/core/shmr.ts", "dfc705b023e5516f83f725385b16aba249b830a018528406e241ee97f1afc180"],
		["mnemopi", "src/core/veracity-consolidation.ts", "eade612e425dad988aa7f3d0dd7139d75a1691ceb392621196b68b4d14f6afaf"],
		["mnemopi", "src/core/binary-vectors.ts", "e153448eb784e9d7ded5ee6107c790831011cbe50563eb5d133c3506502b220f"],
		["mnemopi", "src/core/cost-log.ts", "8de00ca9309093999f6ec733140c255660de94b16af93d5bbb90af4d6061606e"],
	],
	[
		// Studio OMP and pi-mnemopi 18.4.4 source tuple; newer release labels may match these exact bytes.
		["agent", "src/mnemopi/config.ts", "d2a82faea2c60a1ace7f5ace41fb467ee3287b567bda309de66804c594d9be6c"],
		["agent", "src/mnemopi/state.ts", "bcfae4f87015f8dd0cc6ba5c15a0cff7099e17fcabdc6c01df820a3d7f6dc7c7"],
		["mnemopi", "src/core/banks.ts", "8368a0b90565969abbf7d8af108589fd40ff6926ee4b7a1c087ef9f3a02c23c2"],
		["mnemopi", "src/core/beam/schema.ts", "95490e3c2b7e4325cde97fadf3572d76f11e28491e24574b27ff885171058ed0"],
		["mnemopi", "src/db.ts", "f953df31825c4df7c0051186fb6ad5a50507b63dd70a068e01b70bd8be9174fd"],
		["mnemopi", "src/core/episodic-graph.ts", "d7d3df0530b059e85505a5d380cdfbaaaa3b5b97af7e15b2ae0d85baf0994418"],
		["mnemopi", "src/core/query-cache.ts", "ea0044afbe49833c50e2e04e3f362276a37fb35361550262e243969189bb86dc"],
		["mnemopi", "src/core/shmr.ts", "dfc705b023e5516f83f725385b16aba249b830a018528406e241ee97f1afc180"],
		["mnemopi", "src/core/veracity-consolidation.ts", "6aad4bc4a847879a612a34a3f7768326a873c979b2d0ad5616c2d61aca49e088"],
		["mnemopi", "src/core/binary-vectors.ts", "e153448eb784e9d7ded5ee6107c790831011cbe50563eb5d133c3506502b220f"],
		["mnemopi", "src/core/cost-log.ts", "8de00ca9309093999f6ec733140c255660de94b16af93d5bbb90af4d6061606e"],
	],
];
const CONTENT_FIELDS = ["working_memory.content", "episodic_memory.content"] as const;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const BANK_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const STANDARD_TABLES: Record<string, true> = {
	working_memory: true, episodic_memory: true, scratchpad: true, memoria_facts: true,
	memoria_timelines: true, memoria_instructions: true, memoria_preferences: true, memoria_kg: true,
	consolidation_log: true, memory_embeddings: true, memory_validations: true, facts: true,
	annotations: true, triples: true, fts_episodes: true, fts_working: true, fts_facts: true,
	sqlite_sequence: true,
	// Known lazy tables from the additional hash-pinned producers above.
	gists: true, graph_edges: true, query_cache: true, harmonic_beliefs: true,
	memory_resonance_log: true, consolidated_facts: true, conflicts: true,
	binary_vectors: true, cost_entries: true,
};
const FTS_SHADOW = /^fts_(?:episodes|working|facts)_(?:data|idx|content|docsize|config)$/;

function emptyCategories(): Record<CredentialCategory, number> {
	return { provider_token: 0, bearer_token: 0, private_key: 0, password_assignment: 0, credential_url: 0 };
}
function denied(reason: MemoryAuditReason, version: string | null, redactor?: MemoryRedactorReport): MemoryAuditReport {
	return { status: "UNVERIFIED", reason, version, coverage: null, categories: emptyCategories(), ...(redactor && { redactor }) };
}
function safeFile(path: string): Buffer {
	const before = lstatSync(path);
	if (!before.isFile() || (before.mode & 0o444) === 0 || before.size > MAX_STORE_BYTES) throw new Error("unsafe file");
	const fd = openSync(path, NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("changed file");
		const bytes = readFileSync(fd);
		const after = fstatSync(fd), pathname = lstatSync(path);
		if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size ||
			pathname.ino !== before.ino || pathname.dev !== before.dev || pathname.size !== before.size) throw new Error("changed file");
		return bytes;
	} finally { closeSync(fd); }
}
function safeDirectory(path: string): void {
	const info = lstatSync(path);
	if (!info.isDirectory() || (info.mode & 0o500) !== 0o500) throw new Error("unsafe directory");
}
function within(root: string, child: string): boolean {
	const rel = relative(root, child);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function safeAncestors(absolutePath: string): void {
	let path = parse(absolutePath).root;
	safeDirectory(path);
	for (const segment of relative(path, absolutePath).split(sep)) {
		if (!segment) continue;
		path = join(path, segment);
		safeDirectory(path);
	}
}
function validateRoots(home: string, project: string, storeRoot: string): void {
	if (![home, project, storeRoot].every(isAbsolute)) throw new Error("relative path");
	const selected = [home, project].find(root => within(root, storeRoot));
	if (!selected) throw new Error("store outside selected roots");
	safeAncestors(home); safeAncestors(project);
	let path = selected;
	for (const segment of relative(selected, storeRoot).split(sep)) {
		path = join(path, segment);
		safeDirectory(path);
	}
}
function matchesReviewedSourcePins(agent: string, mnemopi: string): boolean {
	const referencePins = REVIEWED_SOURCE_PIN_SETS[0];
	if (!referencePins) return false;
	const hashes = new Map<string, string>();
	for (const [pkg, source] of referencePins) {
		const bytes = safeFile(join(pkg === "agent" ? agent : mnemopi, source));
		hashes.set(pkg + ":" + source, createHash("sha256").update(bytes).digest("hex"));
	}
	if (hashes.size !== referencePins.length) return false;
	return REVIEWED_SOURCE_PIN_SETS.some(pins => pins.length === referencePins.length &&
		pins.every(([pkg, source, sha]) => hashes.get(pkg + ":" + source) === sha));
}

function sourceVersion(ompPath: string): string | null {
	try {
		if (!isAbsolute(ompPath)) return null;
		const launcher = realpathSync(ompPath);
		const agent = dirname(dirname(launcher));
		let dependencyBase = agent;
		let mnemopi: string | undefined;
		for (;;) {
			const candidate = join(dependencyBase, "node_modules", "@oh-my-pi", "pi-mnemopi");
			try { safeFile(join(candidate, "package.json")); mnemopi = realpathSync(candidate); break; }
			catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
			const parent = dirname(dependencyBase);
			if (parent === dependencyBase) return null;
			dependencyBase = parent;
		}
		const manifest = JSON.parse(safeFile(join(agent, "package.json")).toString("utf8"));
		const engine = JSON.parse(safeFile(join(mnemopi, "package.json")).toString("utf8"));
		if (manifest.name !== "@oh-my-pi/pi-coding-agent" || typeof manifest.version !== "string" || !manifest.version ||
			engine.name !== "@oh-my-pi/pi-mnemopi" || engine.version !== manifest.version || !lstatSync(launcher).isFile()) return null;
		return matchesReviewedSourcePins(agent, mnemopi) ? manifest.version : null;
	} catch { return null; }
}
function stores(root: string): { paths: string[]; banks: string[] } {
	const paths = [join(root, "mnemopi.db")], banks = ["default"];
	let hasBanks = false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === "mnemopi.db" && entry.isFile()) continue;
		if (entry.name === "banks" && entry.isDirectory()) { hasBanks = true; continue; }
		throw new Error("unexpected root entry");
	}
	if (hasBanks) {
		const banksPath = join(root, "banks"); safeDirectory(banksPath);
		for (const entry of readdirSync(banksPath, { withFileTypes: true })) {
			if (!entry.isDirectory() || !BANK_NAME.test(entry.name) || entry.name === "default") throw new Error("unsafe bank entry");
			const bankDir = join(banksPath, entry.name);
			safeDirectory(bankDir);
			const entries = readdirSync(bankDir, { withFileTypes: true });
			if (entries.length !== 1 || entries[0].name !== "mnemopi.db" || !entries[0].isFile()) throw new Error("incomplete bank store");
			banks.push(entry.name);
			paths.push(join(bankDir, "mnemopi.db"));
		}
	}
	return { paths, banks };
}
function categoriesFor(content: string): CredentialCategory[] {
	const result: CredentialCategory[] = [];
	if (/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(content)) result.push("provider_token");
	if (/\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/i.test(content)) result.push("bearer_token");
	if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(content)) result.push("private_key");
	if (/\b(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*[^\s,;"']{8,}/i.test(content)) result.push("password_assignment");
	if (/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/i.test(content)) result.push("credential_url");
	return result;
}
function countStore(bytes: Buffer, categories: Record<CredentialCategory, number>): { working: number; episodic: number } {
	if (!bytes.subarray(0, 16).equals(SQLITE_HEADER)) throw new Error("not SQLite");
	// Deserialize the no-follow read bytes in memory. No SQLite connection to a
	// live pathname: no journal/WAL creation, migration, checkpoint or lock file.
	const db = Database.deserialize(bytes);
	try {
		const names = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
		if (names.some(({ name }) => !Object.hasOwn(STANDARD_TABLES, name) && !FTS_SHADOW.test(name))) throw new Error("unknown tables");
		for (const table of ["working_memory", "episodic_memory"] as const) {
			if (!names.some(row => row.name === table)) throw new Error("missing content table");
			const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number }[];
			if (!columns.some(c => c.name === "id" && c.type.toUpperCase() === "TEXT") ||
				!columns.some(c => c.name === "content" && c.type.toUpperCase() === "TEXT" && c.notnull === 1)) throw new Error("opaque content column");
		}
		const counts = { working: 0, episodic: 0 };
		for (const [table, key] of [["working_memory", "working"], ["episodic_memory", "episodic"]] as const) {
			for (const row of db.query(`SELECT content FROM ${table}`).iterate() as Iterable<{ content: unknown }>) {
				if (typeof row.content !== "string") throw new Error("opaque row");
				counts[key]++;
				for (const category of categoriesFor(row.content)) categories[category]++;
			}
		}
		return counts;
	} finally { db.close(); }
}

function requireNoSidecars(paths: readonly string[]): void {
	for (const path of paths) {
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			try { lstatSync(`${path}${suffix}`); throw new Error("active sidecar"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
}

/** Counts only two pinned content columns in all banks under one explicitly selected root.
 * A no-match result is NOT an all-store, all-field, or universal secret-freedom certificate. */
export async function auditMemoryAtRest(input: MemoryAuditInput): Promise<MemoryAuditReport> {
	if (input.consent !== "AUDIT_PRIVATE_MEMORY") return denied("CONSENT_REQUIRED", null);
	const version = sourceVersion(input.ompPath);
	if (!version) return denied("UNSUPPORTED_SOURCE", null);
	try { validateRoots(input.home, input.project, input.storeRoot); }
	catch { return denied("UNSAFE_STORE", version); }
	// Readiness keeps an independent content-hash gate; its redactor result does not certify historical rows.
	let redactor: MemoryRedactorReport | undefined;
	try {
		redactor = (await inspectMemoryReadiness({ home: input.home, project: input.project, ompPath: input.ompPath })).redactor;
	} catch { /* The local redactor diagnostic is optional; it cannot certify historical rows. */ }
	try {
		const { paths, banks } = stores(input.storeRoot);
		if (input.expectedBanks && (new Set(input.expectedBanks).size !== input.expectedBanks.length ||
			input.expectedBanks.length !== banks.length || input.expectedBanks.some(bank => !banks.includes(bank))))
			return denied("INCOMPLETE_BANKS", version, redactor);
		// Check all banks and sidecars BEFORE inspecting a single row. Refuse a
		// potentially live WAL even if its size is zero or the main DB seems clean.
		requireNoSidecars(paths);
		for (const path of paths) {
			const file = lstatSync(path);
			if (!file.isFile() || (file.mode & 0o444) === 0 || file.size > MAX_STORE_BYTES) throw new Error("unsafe file");
		}
		const categories = emptyCategories(), images: string[] = [];
		let working = 0, episodic = 0;
		for (const path of paths) {
			const bytes = safeFile(path);
			images.push(createHash("sha256").update(bytes).digest("hex"));
			const count = countStore(bytes, categories);
			working += count.working; episodic += count.episodic;
		}
		// A writer racing our initial read invalidates coverage even though we
		// never open or modify the live SQLite handle ourselves.
		for (let i = 0; i < paths.length; i++) {
			if (createHash("sha256").update(safeFile(paths[i])).digest("hex") !== images[i]) throw new Error("changed store");
		}
		const observed = stores(input.storeRoot);
		if (observed.paths.length !== paths.length || observed.paths.some((path, index) => path !== paths[index])) throw new Error("changed bank set");
		requireNoSidecars(paths);
		const coverage: MemoryAuditCoverage = { banks_discovered: banks.length, banks_scanned: banks.length,
			stores_discovered: paths.length, stores_scanned: paths.length, working_rows: working, episodic_rows: episodic,
			total_rows: working + episodic, fields: CONTENT_FIELDS };
		return { status: Object.values(categories).some(value => value > 0) ? "MATCHES" : "NO_MATCHES_IN_COVERED_CLASSES",
			reason: "COVERED_CONTENT_ONLY", version, coverage, categories, ...(redactor && { redactor }) };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		return denied(message === "unknown tables" || message === "missing content table" || message === "opaque content column" || message === "opaque row" || message === "not SQLite"
			? "UNSUPPORTED_SCHEMA" : "UNSAFE_STORE", version, redactor);
	}
}
