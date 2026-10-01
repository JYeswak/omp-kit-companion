import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { YAML } from "bun";

export interface MemoryReadinessInput {
	home: string;
	project?: string;
	profile?: string;
	ompPath?: string;
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
	reason: string;
	recommended_action: string;
	redactor: MemoryRedactorReport;
}

const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";
// OMP 18.4.9 memory.backend enum, resolver and explicit-setting migration match 18.4.2.
// Other versions remain UNVERIFIED for config semantics; the redactor stays 18.4.2-only.
const MEMORY_CONFIG_OMP_VERSIONS = new Set(["18.4.2", "18.4.9"]);
// The synthetic redactor probe remains pinned to the inspected, import-free 18.4.2 source.
const REDACTOR_SHA_18_4_2 = "bec8892217e1b7a3ea577b25ff52631883fc41646351ea1f5a7b5e3359564270";
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
function fileBytes(path: string): Buffer {
	const fd = openSync(path, NOFOLLOW);
	try { if (!fstatSync(fd).isFile()) throw new Error("unsafe file"); return readFileSync(fd); }
	finally { closeSync(fd); }
}
function configAt(dir: string): { data?: Record<string, unknown>; issue?: string; present: boolean } {
	const names = ["config.yml", "config.yaml", "config.json", "settings.json"];
	const found = names.filter(name => state(join(dir, name)) !== "missing");
	if (!found.length) return { present: false };
	if (found.length !== 1 || !["config.yml", "config.yaml"].includes(found[0]!)) return { present: true, issue: "Ambiguous or legacy profile format" };
	try {
		const file = join(dir, found[0]!);
		if (state(file) !== "file") throw new Error("unsafe config");
		const parsed: unknown = YAML.parse(fileBytes(file).toString("utf8"));
		if (!record(parsed)) throw new Error("invalid config root");
		return { present: true, data: parsed };
	} catch { return { present: true, issue: "Unreadable or unrecognized config" }; }
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
		const manifest: unknown = JSON.parse(fileBytes(join(root, "package.json")).toString("utf8"));
		return record(manifest) && manifest.name === PACKAGE_NAME && typeof manifest.version === "string" ? { root, version: manifest.version } : null;
	} catch { return null; }
}
function installedRedactor(ompPath?: string): { bytes: Buffer; version: string } | null {
	const pkg = installedPackage(ompPath);
	if (!pkg || pkg.version !== "18.4.2") return null;
	try {
		const source = join(pkg.root, "src", "memory-backend", "redact.ts");
		if (!safeDirectories(pkg.root, ["src", "memory-backend"]) || state(source) !== "file") return null;
		const bytes = fileBytes(source);
		const sha = createHash("sha256").update(bytes).digest("hex");
		return sha === REDACTOR_SHA_18_4_2 ? { bytes, version: pkg.version } : null;
	} catch { return null; }
}
async function probeRedactor(ompPath?: string): Promise<MemoryRedactorReport> {
	const pinned = installedRedactor(ompPath);
	if (!pinned) return { status: "UNVERIFIED", version: null, coverage: "NOT_PROBED", missed: [], reason: "Installed OMP redactor source/version is not pinned and inspectable" };
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

/** Inspect selected on-disk settings and store metadata only; never open a memory row or invoke OMP/models. */
export async function inspectMemoryReadiness(input: MemoryReadinessInput): Promise<MemoryReadinessReport> {
	const redactor = await probeRedactor(input.ompPath);
	const base = { auto_retain: null, auto_recall: null, scoping: null, model: "UNVERIFIED" as const,
		embedding: "UNVERIFIED" as const, runtime: "NOT_PROBED" as const, redactor };
	const unknown = (reason: string, action: string): MemoryReadinessReport => ({ ...base, status: "UNVERIFIED", backend: "UNVERIFIED", configured: false,
		store: "UNVERIFIED", reason, recommended_action: action });
	const ompPackage = installedPackage(input.ompPath);
	if (!ompPackage || !MEMORY_CONFIG_OMP_VERSIONS.has(ompPackage.version))
		return unknown("Installed OMP version has unverified memory config semantics", "Inspect the installed OMP version and its memory settings schema before relying on this report.");
	const home = resolve(input.home);
	const name = input.profile ?? "default";
	if (name !== "default" && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name.endsWith("."))) return unknown("Profile name is unsupported", "Select an existing safe named profile.");
	const parts = name === "default" ? [".omp", "agent"] : [".omp", "profiles", name, "agent"];
	if (!safeDirectories(home, parts)) return unknown("Selected profile directory is absent or unsafe", "Inspect the selected on-disk profile without starting OMP.");
	const agentDir = join(home, ...parts);
	const profile = configAt(agentDir);
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
			if (override.issue) return unknown("Project config is unreadable or unsupported", "Inspect project YAML and rerun without executing OMP.");
			if (override.data) {
				if (invalidConfig(override.data)) return unknown("Project setting group has an unsupported shape", "Inspect project memory/modelRoles YAML.");
				data = Object.fromEntries(Object.keys(data).map(key => [key, record(data[key]) && record(override.data?.[key]) ? { ...data[key], ...override.data[key] } : data[key]]));
				for (const [key, value] of Object.entries(override.data)) if (!Object.hasOwn(data, key)) data[key] = value;
			}
		}
	} else return unknown("Project-scoped effective settings were not inspected", "Provide the session project to inspect project overrides.");
	const backend = setting(data, "memory", "backend");
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
	const degraded = redactor.status === "MISSES" || store === "INACCESSIBLE" || store === "UNKNOWN_SCHEMA";
	const reason = redactor.status === "MISSES" ? "Synthetic redactor misses make private retention risky" :
		store === "NOT_CREATED" ? "Mnemopi configured; no local store has been created; runtime not probed" :
		store === "OBSERVED_SCHEMA_UNVERIFIED" ? "Local SQLite header observed, schema and memory rows not inspected" :
		store === "INACCESSIBLE" || store === "UNKNOWN_SCHEMA" ? "Local store cannot be safely verified" : "Mnemopi configured; runtime availability not proved";
	const actions: string[] = [];
	if (redactor.status === "MISSES") actions.push("Do not auto-retain sensitive material; review historical rows privately and upgrade or harden the OMP redactor.");
	if (store === "INACCESSIBLE" || store === "UNKNOWN_SCHEMA") actions.push("Inspect the local store path, access and schema privately without reading memory rows by default.");
	if (model === "UNVERIFIED_LOCAL") actions.push("Verify the local model is installed and runnable out of band; a configured role can be deliberately parked.");
	else if (model === "UNRESOLVED_ROLE") actions.push("Review the memory model role and fallbacks; config alone does not prove model availability.");
	if (!actions.length) actions.push("Check embeddings and backend at runtime only with explicit consent; configuration and store metadata never certify readiness.");
	return { status: degraded ? "DEGRADED" : "UNVERIFIED", backend: "mnemopi", configured: true, store,
		auto_retain: autoRetain, auto_recall: autoRecall, scoping, model, embedding, runtime: "NOT_PROBED", redactor, reason,
		recommended_action: actions.join(" ") };
}
