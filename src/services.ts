import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ServiceClass = "RUNNING" | "IDLE_OK" | "FAILING" | "NOT_LOADED" | "BROKEN" | "LOADED_NO_PLIST" | "LOADED_PATH_MISMATCH" | "UNVERIFIED";
export type ServiceDomain = "user" | "global-agent" | "system";

export interface ServiceRow {
	label: string;
	class: ServiceClass;
	domain: ServiceDomain;
	loaded: "yes" | "no" | "unknown";
	pid: number | null;
	last_exit: number | null;
	trigger: string;
	program: string;
	program_ok: string;
	plist: string | null;
	/** Plist path launchd actually loaded, from launchctl print; null when unasked or unanswered. */
	loaded_plist: string | null;
	tags: string[];
	omp_related: boolean;
	verified: boolean;
}

export interface DeclaredJob {
	label: string;
	name: string;
	healthy_exit: number[];
	require_log_line: Record<string, string>;
	log_file: string | null;
}

const LOG_BYTES_MAX = 1024 * 1024;

export interface RequiredResult {
	name: string;
	label: string;
	status: "OK" | "MISSING" | "UNHEALTHY";
	detail: string;
}

export interface ServiceLauncher {
	label: string;
	pid: number;
	program: string;
}

export interface ServicesAdmission {
	/** Observed launcher members: every inventoried row with a live pid. */
	launchers: ServiceLauncher[];
	/** No pause declaration source is bound in this scope; recorded, never assumed. */
	authority: { state: "UNKNOWN"; confirmed: false; generation: null; reason: string };
}

export interface ServicesReport {
	status: "OK" | "DEGRADED" | "UNVERIFIED";
	rows: ServiceRow[];
	duplicates: { program: string; labels: string[] }[];
	required: RequiredResult[];
	reason: string;
	admission: ServicesAdmission;
}

function servicesAdmission(rows: ServiceRow[]): ServicesAdmission {
	const launchers: ServiceLauncher[] = [];
	for (const row of rows) {
		if (row.pid !== null) launchers.push({ label: row.label, pid: row.pid, program: row.program });
	}
	return {
		launchers,
		authority: { state: "UNKNOWN", confirmed: false, generation: null, reason: "services scope observes launchd liveness only; no pause declaration source is bound here" },
	};
}

export interface ServicesInput {
	home: string;
	servicesPath?: string;
	pathEnv?: string;
}

const PLIST_BYTES_MAX = 1024 * 1024;
const DECLARED_BYTES_MAX = 64 * 1024;
// Bare "omp" only matches as a standalone path/label token: substring matching
// false-positives on words like "companion" or "company" (measured on a real
// machine against GoogleUpdater's enterprise_companion arg).
const OMP_TOKEN = /(^|[\s/._-])omp($|[\s/._-])/i;
const OMP_RELATED = /oh-my-pi|uca|localbench|sbh|omp-kit|kit-guard/i;
function isOmpRelated(haystack: string): boolean {
	return OMP_TOKEN.test(haystack) || OMP_RELATED.test(haystack);
}
const INTERPRETERS = new Set(["sh", "bash", "zsh"]);
const SYSTEM_PATHS = new Set(["/bin", "/usr/bin"]);

export class ServicesInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ServicesInputError";
	}
}

interface PlistProgram {
	program: string;
	args: string;
	trigger: string;
}

function decodeEntities(value: string): string {
	return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
}

/** Minimal Info.plist reader for the keys launchd inventory needs; anything else is BROKEN. */
function readPlistProgram(text: string): { label: string; program: PlistProgram } | null {
	const dict = text.match(/<dict>([\s\S]*)<\/dict>/);
	if (!dict) return null;
	const body = dict[1] ?? "";
	const entries = new Map<string, { tag: string; inner: string }>();
	const keyPattern = /<key>([^<]*)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<integer>(-?\d+)<\/integer>|<array>([\s\S]*?)<\/array>|<dict>([\s\S]*?)<\/dict>|<(true|false)\/>)/g;
	let match: RegExpExecArray | null;
	while ((match = keyPattern.exec(body)) !== null) {
		const tag = match[6] ? match[6] : match[2] !== undefined ? "string" : match[3] !== undefined ? "integer" : match[4] !== undefined ? "array" : "dict";
		const inner = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
		entries.set(match[1] ?? "", { tag, inner });
	}
	const label = entries.get("Label");
	if (label === undefined) return null;
	const stringValue = (raw: { tag: string; inner: string } | undefined): string | null => {
		if (raw === undefined || raw.tag !== "string") return null;
		return decodeEntities(raw.inner);
	};
	const labelText = stringValue(label);
	if (labelText === null || labelText.length === 0) return null;
	const program = stringValue(entries.get("Program")) ?? "";
	const arrayItems: string[] = [];
	const arrayRaw = entries.get("ProgramArguments");
	if (arrayRaw !== undefined) {
		if (arrayRaw.tag !== "array") return null;
		const itemPattern = /<string>([\s\S]*?)<\/string>/g;
		let item: RegExpExecArray | null;
		while ((item = itemPattern.exec(arrayRaw.inner)) !== null) arrayItems.push(decodeEntities(item[1] ?? ""));
	}
	const resolvedProgram = program || arrayItems[0] || "?";
	const flag = (key: string): boolean => entries.get(key)?.tag === "true";
	const intValue = (key: string): number | null => {
		const raw = entries.get(key);
		if (raw?.tag !== "integer" || !/^-?\d+$/.test(raw.inner)) return null;
		return Number(raw.inner);
	};
	const triggers: string[] = [];
	if (flag("KeepAlive")) triggers.push("keepalive");
	if (flag("RunAtLoad")) triggers.push("atload");
	const interval = intValue("StartInterval");
	if (interval !== null) triggers.push(`every${interval}s`);
	if (entries.has("StartCalendarInterval")) triggers.push("calendar");
	if (entries.has("WatchPaths")) triggers.push("watch");
	return { label: labelText, program: { program: resolvedProgram, args: arrayItems.join(" "), trigger: triggers.join(",") } };
}

export function parseLaunchdList(text: string): Map<string, { pid: number | null; exit: number | null }> {
	const rows = new Map<string, { pid: number | null; exit: number | null }>();
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3) continue;
	 const label = parts.slice(2).join(" ");
		if (label === "Label" || label === "-") continue;
		const pid = parts[0] === "-" ? null : Number(parts[0]);
		const exit = parts[1] === "-" ? null : Number(parts[1]);
		rows.set(label, {
			pid: pid !== null && Number.isSafeInteger(pid) ? pid : null,
			exit: exit !== null && Number.isSafeInteger(exit) ? exit : null,
		});
	}
	return rows;
}

/** First `path = ...` line of launchctl print output; null when absent. */
export function parsePrintPath(text: string): string | null {
	for (const line of text.split("\n")) {
		const match = /^[ \t]*path[ \t]*=[ \t]*(.+?)[ \t]*$/.exec(line);
		if (match) return match[1] ?? null;
	}
	return null;
}

function executableOnPath(program: string, pathEnv: string): boolean {
	if (program.includes("/")) return false;
	for (const directory of pathEnv.split(":")) {
		if (!directory) continue;
		try {
			const stat = statSync(join(directory, program));
			if (stat.isFile()) return true;
		} catch { /* next directory */ }
	}
	return false;
}

function isExecutableFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Duplicate keys resolve through shell wrappers to the script that actually runs. */
export function resolveDuplicateKey(program: string, args: string): string {
	const base = program.split("/").pop() ?? program;
	if (INTERPRETERS.has(base)) {
		for (const token of args.split(/\s+/)) {
			if (!token.startsWith("/") || SYSTEM_PATHS.has(token.split("/").slice(0, 3).join("/"))) continue;
			const parent = token.split("/").slice(0, -1).join("/") || "/";
			if (SYSTEM_PATHS.has(parent)) continue;
		return token;
		}
	}
	return program;
}

function tagRow(label: string, program: string, args: string): string[] {
	const haystack = `${label} ${program} ${args}`.toLowerCase();
	const tags = new Set<string>();
	for (const keyword of ["oh-my-pi", "uca", "localbench", "sbh", "ntm", "process-compose", "ollama", "docker", "homebrew"]) {
		if (haystack.includes(keyword)) tags.add(keyword);
	}
	if (OMP_TOKEN.test(haystack)) tags.add("omp");
	return [...tags].sort();
}

export interface InventoryDeps {
	listAll: () => { code: number; stdout: string };
	printDomain: (domain: string, label: string) => number;
	/** Loaded plist path via launchctl print; null when the domain is unprintable here. */
	printPath: (domain: ServiceDomain, label: string) => string | null;
	plistDirs: () => { directory: string; domain: ServiceDomain }[];
	pathEnv: string;
}

function defaultDirs(home: string): { directory: string; domain: ServiceDomain }[] {
	return [
		{ directory: join(home, "Library", "LaunchAgents"), domain: "user" },
		{ directory: "/Library/LaunchAgents", domain: "global-agent" },
		{ directory: "/Library/LaunchDaemons", domain: "system" },
	];
}

function readDeclared(path: string): DeclaredJob[] {
	let raw: Buffer;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > DECLARED_BYTES_MAX) throw new Error("unsafe declared file");
		raw = readFileSync(path);
	} catch {
		throw new ServicesInputError("INVALID_SERVICES_FILE", "Declared services file must be a regular file under 64 KiB");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf-8"));
	} catch {
		throw new ServicesInputError("INVALID_SERVICES_FILE", "Declared services file must be schema_version 1 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ServicesInputError("INVALID_SERVICES_FILE", "Declared services file must be a JSON object");
	}
	const record = parsed as Record<string, unknown>;
	if (record["schema_version"] !== 1 || !Array.isArray(record["jobs"])) {
		throw new ServicesInputError("INVALID_SERVICES_FILE", "Declared services file needs schema_version 1 and a jobs array");
	}
	const jobs: DeclaredJob[] = [];
	for (const entry of record["jobs"] as unknown[]) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new ServicesInputError("INVALID_SERVICES_FILE", "Each declared job needs a label and a name");
		}
		const job = entry as Record<string, unknown>;
		if (typeof job["label"] !== "string" || job["label"].length === 0 || typeof job["name"] !== "string" || job["name"].length === 0) {
			throw new ServicesInputError("INVALID_SERVICES_FILE", "Each declared job needs a label and a name");
		}
		const allowed = new Set(["label", "name", "healthy_exit", "log_file", "require_log_line"]);
		const predicates: Record<string, string> = {};
		for (const key of Object.keys(job)) {
			const legacy = /^require_log_line_if_exit_(\d+)$/.exec(key);
			if (legacy) {
				if (typeof job[key] !== "string" || (job[key] as string).length === 0) {
					throw new ServicesInputError("INVALID_SERVICES_FILE", "Log predicates must be non-empty strings");
				}
				predicates[legacy[1] as string] = job[key] as string;
			} else if (!allowed.has(key)) {
				throw new ServicesInputError("INVALID_SERVICES_FILE", `Unknown declared job key: ${key}`);
			}
		}
		let healthy = [0];
		if (job["healthy_exit"] !== undefined) {
			if (!Array.isArray(job["healthy_exit"]) || job["healthy_exit"].length === 0 ||
				!job["healthy_exit"].every(code => Number.isSafeInteger(code) && (code as number) >= 0 && (code as number) <= 255)) {
				throw new ServicesInputError("INVALID_SERVICES_FILE", "healthy_exit must be a non-empty array of exit codes 0..255");
			}
			healthy = [...(job["healthy_exit"] as number[])].sort((a, b) => a - b);
		}
		if (job["require_log_line"] !== undefined) {
			if (typeof job["require_log_line"] !== "object" || job["require_log_line"] === null || Array.isArray(job["require_log_line"])) {
				throw new ServicesInputError("INVALID_SERVICES_FILE", "require_log_line must map exit codes to substrings");
			}
			for (const [code, text] of Object.entries(job["require_log_line"] as Record<string, unknown>)) {
				if (!/^\d+$/.test(code) || typeof text !== "string" || text.length === 0) {
					throw new ServicesInputError("INVALID_SERVICES_FILE", "require_log_line maps exit codes to non-empty substrings");
				}
				predicates[code] = text;
			}
		}
		let logFile: string | null = null;
		if (job["log_file"] !== undefined) {
			if (typeof job["log_file"] !== "string" || job["log_file"].length === 0) {
				throw new ServicesInputError("INVALID_SERVICES_FILE", "log_file must be an absolute or ~/ path");
			}
			logFile = job["log_file"] as string;
		}
		if (Object.keys(predicates).length > 0 && logFile === null) {
			throw new ServicesInputError("INVALID_SERVICES_FILE", "Log predicates need a log_file to check");
		}
		jobs.push({ label: job["label"] as string, name: job["name"] as string,
			healthy_exit: healthy, require_log_line: predicates, log_file: logFile });
	}
	return jobs;
}

/** A job is healthy when it runs, or when its last exit is declared healthy
 * for it, including any log-line predicate for that exit. Exit codes are not
 * universally failure: localbench omp-update exits 1 by design when STALE
 * work is queued, proven by its refresh log. */
function readLogSnippet(home: string, file: string): string | null {
	const expanded = file.startsWith("~/") ? join(home, file.slice(2)) : file;
	if (!expanded.startsWith("/")) return null;
	try {
		const stat = lstatSync(expanded);
		if (!stat.isFile() || stat.size > LOG_BYTES_MAX) return null;
		return readFileSync(expanded, "utf-8");
	} catch {
		return null;
	}
}

function judgeRequired(row: ServiceRow | null, job: DeclaredJob, home: string): RequiredResult {
	if (!row) return { name: job.name, label: job.label, status: "MISSING", detail: "Declared job has no inventory row" };
	if (row.class === "LOADED_PATH_MISMATCH") {
		return { name: job.name, label: job.label, status: "UNHEALTHY",
			detail: `LOADED_PATH_MISMATCH: launchd loaded ${row.loaded_plist ?? "an unknown path"}, expected ${row.plist ?? "the on-disk plist"}` };
	}
	if (row.class === "RUNNING") {
		return { name: job.name, label: job.label, status: "OK", detail: `Running with pid ${row.pid ?? "unknown"}` };
	}
	if (row.class === "BROKEN" || row.class === "UNVERIFIED" || row.class === "NOT_LOADED") {
		return { name: job.name, label: job.label, status: "UNHEALTHY", detail: `Inventory class ${row.class}; no exit to evaluate` };
	}
	if (row.last_exit === null || !job.healthy_exit.includes(row.last_exit)) {
		return { name: job.name, label: job.label, status: "UNHEALTHY",
			detail: `Exit ${row.last_exit === null ? "unrecorded" : row.last_exit} not in declared healthy_exit [${job.healthy_exit.join(", ")}]` };
	}
	const predicate = job.require_log_line[String(row.last_exit)];
	if (predicate === undefined) {
		return { name: job.name, label: job.label, status: "OK", detail: `Exit ${row.last_exit} is declared healthy` };
	}
	if (job.log_file === null) {
		return { name: job.name, label: job.label, status: "UNHEALTHY", detail: `Exit ${row.last_exit} needs a log predicate with no log_file` };
	}
	const log = readLogSnippet(home, job.log_file);
	if (log === null) {
		return { name: job.name, label: job.label, status: "UNHEALTHY", detail: `Log predicate unproven: ${job.log_file} is unreadable` };
	}
	if (!log.includes(predicate)) {
		return { name: job.name, label: job.label, status: "UNHEALTHY",
			detail: `Exit ${row.last_exit} lacks required log line` };
	}
	return { name: job.name, label: job.label, status: "OK",
		detail: `Exit ${row.last_exit} is declared healthy with its required log line` };
}

/** Read-only launchd inventory plus declared-job validation; never loads, unloads, or writes. */
export function inventoryServices(input: ServicesInput, deps: InventoryDeps): ServicesReport {
	const listed = deps.listAll();
	if (listed.code !== 0) {
		return { status: "UNVERIFIED", rows: [], duplicates: [], required: [],
			admission: servicesAdmission([]),
			reason: "launchctl list is unavailable on this machine; service inventory needs launchd" };
	}
	const loaded = parseLaunchdList(listed.stdout);
	const rows: ServiceRow[] = [];
	let systemUnverified = false;
	for (const { directory, domain } of deps.plistDirs()) {
		let names: string[];
		try {
			names = readdirSync(directory).sort();
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".plist")) continue;
			const plist = join(directory, name);
			let stat;
			try {
				stat = lstatSync(plist);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.size > PLIST_BYTES_MAX) {
				rows.push({ label: name, class: "BROKEN", domain, loaded: "no", pid: null, last_exit: null,
					trigger: "-", program: "?", program_ok: "missing", plist, loaded_plist: null,
					tags: [], omp_related: false, verified: true });
				continue;
			}
			let parsed;
			try {
				parsed = readPlistProgram(readFileSync(plist, "utf-8"));
			} catch {
				parsed = null;
			}
			if (!parsed) {
				rows.push({ label: name, class: "BROKEN", domain, loaded: "no", pid: null, last_exit: null,
					trigger: "-", program: "?", program_ok: "missing", plist, loaded_plist: null,
					tags: [], omp_related: false, verified: true });
				continue;
			}
			const { program, args, trigger } = parsed.program;
			let programOk: string;
			if (program === "?") {
				programOk = "missing";
			} else if (program.startsWith("/")) {
				programOk = isExecutableFile(program) ? "ok" : "missing";
			} else {
				programOk = executableOnPath(program, deps.pathEnv) ? "ok" : "missing";
			}
			if (programOk === "ok") {
				const base = program.split("/").pop() ?? program;
				if (INTERPRETERS.has(base)) {
					const resolved = resolveDuplicateKey(program, args);
					if (resolved !== program) programOk = isExecutableFile(resolved) ? "ok" : `missing:${resolved}`;
				}
			}
			const entry = loaded.get(parsed.label);
			let rowLoaded: "yes" | "no" | "unknown" = "no";
			let verified = true;
			if (domain === "user" || domain === "global-agent") {
				rowLoaded = entry ? "yes" : "no";
			} else if (deps.printDomain("system", parsed.label) === 0) {
				rowLoaded = "yes";
			} else {
				rowLoaded = "unknown";
				verified = false;
				systemUnverified = true;
			}
			const pid = entry && rowLoaded === "yes" ? entry.pid : null;
			const exit = entry && rowLoaded === "yes" ? entry.exit : null;
			// A job loaded from a different plist than the on-disk one is not the
			// validated job, even when its program still exists: today's incident.
			const loadedPlist = rowLoaded === "yes" ? deps.printPath(domain, parsed.label) : null;
			const pathMismatch = loadedPlist !== null && loadedPlist !== plist;
			let cls: ServiceClass;
			if (!verified) {
				cls = "UNVERIFIED";
			} else if (programOk !== "ok") {
				cls = "BROKEN";
			} else if (pathMismatch) {
				cls = "LOADED_PATH_MISMATCH";
			} else if (rowLoaded === "no") {
				cls = "NOT_LOADED";
			} else if (pid !== null) {
				cls = "RUNNING";
			} else if (exit === 0) {
				cls = "IDLE_OK";
			} else {
				cls = "FAILING";
			}
			const tags = tagRow(parsed.label, program, args);
			rows.push({ label: parsed.label, class: cls, domain, loaded: rowLoaded, pid, last_exit: exit,
				trigger: trigger || "-", program, args, program_ok: programOk, plist, loaded_plist: loadedPlist,
				tags, omp_related: isOmpRelated(`${parsed.label} ${program} ${args}`), verified });
		}
	}
	for (const [label, entry] of loaded) {
		if (label.startsWith("com.apple.") || label.startsWith("application.") || label.includes(".anonymous.")) continue;
		if (rows.some(row => row.label === label)) continue;
		rows.push({ label, class: "LOADED_NO_PLIST", domain: "user", loaded: "yes", pid: entry.pid,
			last_exit: entry.exit, trigger: "-", program: "?", program_ok: "missing", plist: null,
		loaded_plist: null, tags: tagRow(label, "", ""), omp_related: isOmpRelated(label), verified: true });
	}
	const byProgram = new Map<string, string[]>();
	for (const row of rows) {
		if (row.loaded !== "yes" || row.program === "?") continue;
		const key = resolveDuplicateKey(row.program, row.args);
		const labels = byProgram.get(key) ?? [];
		labels.push(row.label);
		byProgram.set(key, labels);
	}
	const duplicates = [...byProgram].filter(([, labels]) => labels.length > 1)
		.map(([program, labels]) => ({ program, labels: labels.sort() }))
		.sort((a, b) => a.program.localeCompare(b.program));
	const required: RequiredResult[] = [];
	if (input.servicesPath !== undefined) {
		for (const job of readDeclared(input.servicesPath)) {
			required.push(judgeRequired(rows.find(candidate => candidate.label === job.label) ?? null, job, input.home));
		}
	}
	const flagged = required.filter(item => item.status !== "OK");
	const cleared = new Set(required.filter(item => item.status === "OK").map(item => item.label));
	const unhealthyOmp = rows.filter(row => row.omp_related && !cleared.has(row.label) && (row.class === "FAILING" || row.class === "BROKEN" || row.class === "LOADED_PATH_MISMATCH"));
	if (flagged.length > 0 || unhealthyOmp.length > 0) {
		const parts: string[] = [];
		if (flagged.length > 0) parts.push(`${flagged.length} declared jobs need attention: ${flagged.map(item => `${item.name} (${item.status})`).join(", ")}`);
		if (unhealthyOmp.length > 0) parts.push(`${unhealthyOmp.length} OMP-related jobs failing: ${unhealthyOmp.map(row => row.class === "LOADED_PATH_MISMATCH"
			? `${row.label} (LOADED_PATH_MISMATCH: loaded ${row.loaded_plist ?? "?"} != ${row.plist ?? "?"})`
			: `${row.label} (${row.class})`).join(", ")}`);
		if (systemUnverified) parts.push("system domain loaded state is UNVERIFIED without elevated privileges");
		return { status: "DEGRADED", rows, duplicates, required, admission: servicesAdmission(rows), reason: parts.join("; ") };
	}
	if (systemUnverified) {
		return { status: "UNVERIFIED", rows, duplicates, required, admission: servicesAdmission(rows),
			reason: "System domain loaded state is UNVERIFIED without elevated privileges; user-domain rows are exact" };
	}
	return { status: "OK", rows, duplicates, required, admission: servicesAdmission(rows),
		reason: required.length > 0 ? "Every declared job is healthy" : "No failing or broken OMP-related jobs" };
}

export function defaultInventoryDeps(home: string, pathEnv: string, dirsOverride?: string[]): InventoryDeps {
	return {
		listAll: () => {
			try {
				const child = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
				return { code: child.exitCode, stdout: child.stdout.toString() };
			} catch {
				return { code: 127, stdout: "" };
			}
		},
		printDomain: (domain: string, label: string) => {
			try {
				const child = Bun.spawnSync(["launchctl", "print", `${domain}/${label}`], { stdout: "pipe", stderr: "pipe" });
				return child.exitCode;
			} catch {
				return 127;
			}
		},
		printPath: (domain: ServiceDomain, label: string) => {
			const uid = typeof process.getuid === "function" ? process.getuid() : null;
			const spec = domain === "system" ? `system/${label}`
				: uid === null ? null : `gui/${uid}/${label}`;
			if (spec === null) return null;
			try {
				const child = Bun.spawnSync(["launchctl", "print", spec], { stdout: "pipe", stderr: "pipe" });
				if (child.exitCode !== 0) return null;
				return parsePrintPath(child.stdout.toString());
			} catch {
				return null;
			}
		},
		plistDirs: () => dirsOverride !== undefined
			? dirsOverride.map(directory => ({ directory, domain: "user" as ServiceDomain }))
			: defaultDirs(home),
		pathEnv,
	};
}
