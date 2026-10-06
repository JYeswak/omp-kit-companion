import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";
import { resolveOmpIdentity } from "./paths.ts";
import { inspectStateRoot } from "./state-root.ts";
import { isSha256Hex, matchesBounded } from "./regex-guards.ts";
import { ompFingerprint, readTestReceipt } from "./omp-watch.ts";
import type { Image } from "./mutations.ts";
import { checkExtensionImports } from "./extensions.ts";
import { record } from "./mcp-sources.ts";

export type DiagnosticStatus = "OK" | "DEGRADED" | "DRIFT" | "UNVERIFIED" | "FAIL" | "NOT_RUN";
export interface Finding {
	component: string;
	status: DiagnosticStatus;
	reason: string;
	recommended_action: string;
	evidence?: Record<string, unknown>;
}
export interface DiagnoseInput {
	root: string;
	home: string;
	project?: string;
	scope?: string;
	ompPath?: string;
	jsmPath?: string;
	/** Private kit state root; defaults to $XDG_STATE_HOME/omp-kit or ~/.local/state/omp-kit. */
	stateRoot?: string;
}
export type RuleClass = "always" | "tripwire" | "reminder" | "router" | "canary";
export interface ManifestRule { name: string; sha256: string; ruleClass: RuleClass; pack: string }
export type RuleOwnershipRecord = { version: 1; rules: Record<string, Image> };
const HEADER = "name\tsha256\tclass\tpack";
const RECORD_HEADER = "name\tsha256\tpack\tinstalled_utc";
const CLASSES: Record<RuleClass, true> = { always: true, tripwire: true, reminder: true, router: true, canary: true };
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function fileBytes(path: string): Buffer {
	const fd = openSync(path, NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${path}`);
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Shared strict schema: a checksum or legacy installed.tsv is never an ownership grant. */
export function parseRuleOwnership(bytes: Uint8Array): RuleOwnershipRecord {
	let parsed: unknown;
	try { parsed = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : Buffer.from(bytes).toString("utf8")); }
	catch { throw new Error("STATE_UNSAFE"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("STATE_UNSAFE");
	const row = parsed as Record<string, unknown>;
	if (Object.keys(row).sort().join(",") !== "rules,version" || row.version !== 1 ||
		!row.rules || typeof row.rules !== "object" || Array.isArray(row.rules)) throw new Error("STATE_UNSAFE");
	for (const [name, value] of Object.entries(row.rules)) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("STATE_UNSAFE");
		const image = value as Record<string, unknown>;
		if (Object.keys(image).sort().join(",") !== "gid,mode,sha256,size,uid" ||
			typeof image.sha256 !== "string" || !isSha256Hex(image.sha256) ||
			![image.size, image.mode, image.uid, image.gid].every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0) ||
			(image.mode as number) > 0o7777) throw new Error("STATE_UNSAFE");
	}
	return row as RuleOwnershipRecord;
}

function readImage(path: string): { bytes: Buffer; image: Image } {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe image");
	const fd = openSync(path, NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) throw new Error("unsafe image");
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		if (after.ino !== info.ino || after.size !== info.size || after.mode !== info.mode ||
			after.uid !== info.uid || after.gid !== info.gid || after.mtimeMs !== info.mtimeMs ||
			after.ctimeMs !== info.ctimeMs) throw new Error("unsafe image");
		return { bytes, image: { sha256: digest(bytes), size: bytes.length, mode: info.mode & 0o7777, uid: info.uid, gid: info.gid } };
	} finally { closeSync(fd); }
}

function currentOwnership(home: string): { status: "MISSING" | "UNSAFE" | "PRESENT"; rules?: Record<string, Image> } {
	const directory = directoryPath(home, [".agents"]);
	if (directory === "missing") return { status: "MISSING" };
	if (directory === "unsafe") return { status: "UNSAFE" };
	const path = join(home, ".agents", "omp-kit-ownership.json");
	const kind = pathState(path);
	if (kind === "missing") return { status: "MISSING" };
	if (kind !== "file") return { status: "UNSAFE" };
	try {
		const file = readImage(path);
		if (file.image.mode !== 0o600 || file.image.uid !== process.getuid?.()) return { status: "UNSAFE" };
		return { status: "PRESENT", rules: parseRuleOwnership(file.bytes).rules };
	} catch { return { status: "UNSAFE" }; }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function pathState(path: string): "missing" | "directory" | "file" | "unsafe" {
	try {
		const stat = lstatSync(path);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return "unsafe";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		return "unsafe";
	}
}
function directoryPath(base: string, segments: readonly string[]): "missing" | "directory" | "unsafe" {
	let current = base;
	for (const segment of segments) {
		current = join(current, segment);
		const state = pathState(current);
		if (state === "missing") return "missing";
		if (state !== "directory") return "unsafe";
	}
	return "directory";
}
function finding(component: string, status: DiagnosticStatus, reason: string, recommended_action: string, evidence?: Record<string, unknown>): Finding {
	return { component, status, reason, recommended_action, ...(evidence ? { evidence } : {}) };
}
export function parseRuleManifest(manifest: string): ManifestRule[] {
	if (!manifest.endsWith("\n")) throw new Error("MANIFEST.tsv must end with a newline");
	const lines = manifest.slice(0, -1).split("\n");
	if (lines.shift() !== HEADER || !lines.length) throw new Error("MANIFEST.tsv header or records are invalid");
	const seen = new Set<string>();
	const rules: ManifestRule[] = [];
	for (const [index, row] of lines.entries()) {
		const fields = row.split("\t");
		if (fields.length !== 4) throw new Error("manifest row " + (index + 2) + " must have four tab-separated fields");
		const [name, sha256, ruleClass, pack] = fields as [string, string, string, string];
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || seen.has(name) || !isSha256Hex(sha256) || !Object.hasOwn(CLASSES, ruleClass) || !/^(?:[a-f0-9]{7,64}|uncommitted-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/.test(pack)) {
			throw new Error("invalid or duplicate manifest row " + (index + 2));
		}
		seen.add(name);
		rules.push({ name, sha256, ruleClass: ruleClass as RuleClass, pack });
	}
	return rules;
}

export function readManifest(root: string): { rules: ManifestRule[]; sourceUnverified: boolean; error?: string } {
	try {
		if (directoryPath(root, ["rules"]) !== "directory") throw new Error("rules directory is missing or unsafe");
		const rules = parseRuleManifest(fileBytes(join(root, "MANIFEST.tsv")).toString("utf8"));
		const seen = new Set<string>();
		for (const rule of rules) {
			seen.add(rule.name);
			const file = join(root, "rules", rule.name + ".md");
			if (pathState(file) !== "file" || digest(fileBytes(file)) !== rule.sha256) throw new Error("shipped rule hash or file type disagrees with manifest: " + rule.name);
		}
		for (const entry of readdirSync(join(root, "rules"))) {
			if (entry.endsWith(".md") && !seen.has(entry.slice(0, -3))) throw new Error("shipped rule omitted from MANIFEST.tsv: " + entry);
		}
		return { rules, sourceUnverified: rules.some(rule => rule.pack.startsWith("uncommitted-")) };
	} catch (error) {
		return { rules: [], sourceUnverified: false, error: errorText(error) };
	}
}
function legacyRecord(home: string, rules: readonly ManifestRule[]): "LEGACY_RECORD_ONLY" | "UNVERIFIED" {
	if (directoryPath(home, [".local", "state", "omp-kit"]) !== "directory") return "UNVERIFIED";
	try {
		const lines = fileBytes(join(home, ".local", "state", "omp-kit", "installed.tsv")).toString("utf8").trimEnd().split("\n");
		if (lines.shift() !== RECORD_HEADER || lines.length !== rules.length) return "UNVERIFIED";
		const expected = new Map(rules.map((rule) => [rule.name, rule]));
		for (const row of lines) {
			const [name, sha256, pack, time, ...extra] = row.split("\t");
			const rule = expected.get(name ?? "");
			if (extra.length || !rule || rule.sha256 !== sha256 || rule.pack !== pack || !time) return "UNVERIFIED";
			expected.delete(name ?? "");
		}
		return expected.size ? "UNVERIFIED" : "LEGACY_RECORD_ONLY";
	} catch { return "UNVERIFIED"; }
}
function inspectOmp(path?: string): Finding {
	try {
		if (path && !isAbsolute(path)) throw new Error("OMP launcher must be an absolute path");
		const provided = path && pathState(path) === "missing";
		if (provided) return finding("omp", "FAIL", "OMP launcher is unavailable", "Install OMP or supply an existing OMP launcher.", { availability: "UNAVAILABLE", version: null });
		const identity = resolveOmpIdentity(path ? { PATH: dirname(path) } : process.env);
		if (path && realpathSync(path) !== identity.launcher) throw new Error("OMP launcher identity differs from requested path");
		const metadata: unknown = JSON.parse(fileBytes(join(identity.packageRoot, "package.json")).toString("utf8"));
		const version = metadata && typeof metadata === "object" && "version" in metadata && typeof metadata.version === "string" && metadata.version.trim() ? metadata.version : null;
		return finding("omp", version ? "OK" : "UNVERIFIED", version ? "OMP launcher and package version resolved from metadata" : "OMP launcher resolved but package version is not verifiable", version ? "No action required." : "Inspect the installed OMP package metadata before relying on its version.", {
			availability: "PRESENT", location: identity.launcher, package_root: identity.packageRoot, version, version_proof: version ? "PACKAGE_METADATA" : "UNVERIFIED",
		});
	} catch (error) {
		const reason = errorText(error);
		const unavailable = reason.includes("executable not found on PATH") || (path !== undefined && pathState(path) === "missing");
		return finding("omp", unavailable ? "FAIL" : "UNVERIFIED", reason, unavailable ? "Install OMP and put its launcher on PATH." : "Inspect the OMP launcher, package metadata and identity before testing.", { availability: unavailable ? "UNAVAILABLE" : "UNVERIFIED", version: null });
	}
}

type ConfigInspection = { name: string; dir: string; data?: Record<string, unknown>; issue?: string };
type DisabledConflict = { profile: string; name: string; provider: "global" | "project" | "unknown" };
const CONFIG_NAMES = ["config.yml", "config.yaml", "config.json", "settings.json"] as const;
const POLICY_KEYS = ["enabled", "repeatMode", "repeatGap", "contextMode", "disabledRules"] as const;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function readJsonObject(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(fileBytes(path).toString("utf8"));
	if (!record(value)) throw new Error(`expected a JSON object: ${path}`);
	return value;
}
function readProfile(name: string, dir: string, home: string): ConfigInspection {
	const segments = name === "default" ? [".omp", "agent"] : [".omp", "profiles", name, "agent"];
	if (directoryPath(home, segments) !== "directory") return { name, dir, issue: "profile agent directory was removed or is unsafe" };
	const present = CONFIG_NAMES.filter((file) => pathState(join(dir, file)) !== "missing");
	if (!present.length) return { name, dir, issue: "no on-disk profile config; OMP defaults and migrations were not resolved" };
	const selected = present[0];
	if (!selected || present.length !== 1 || selected === "config.json" || selected === "settings.json") return { name, dir, issue: "legacy or multiple profile settings formats are not safely resolved" };
	const config = join(dir, selected);
	try {
		if (pathState(config) !== "file") throw new Error("unsafe config file");
		const value: unknown = YAML.parse(fileBytes(config).toString("utf8"));
		if (!record(value)) throw new Error("config root is not a mapping");
		if (directoryPath(home, segments) !== "directory") throw new Error("profile disappeared during inspection");
		return { name, dir, data: value };
	} catch (error) { return { name, dir, issue: `unrecognized config: ${errorText(error)}` }; }
}
function inspectProfiles(home: string): { profiles: ConfigInspection[]; issue?: string } {
	const profiles = [readProfile("default", join(home, ".omp", "agent"), home)];
	const state = directoryPath(home, [".omp", "profiles"]);
	if (state === "unsafe") return { profiles, issue: "named profile directory is unsafe" };
	if (state === "missing") return { profiles };
	let issue: string | undefined;
	try {
		for (const name of readdirSync(join(home, ".omp", "profiles")).sort()) {
			if (!matchesBounded(name, 128, /^[a-z0-9][a-z0-9._-]{0,63}$/) || name === "default" || name.endsWith(".")) continue;
			const agent = join(home, ".omp", "profiles", name, "agent");
			const status = directoryPath(home, [".omp", "profiles", name, "agent"]);
			if (status === "directory") profiles.push(readProfile(name, agent, home));
			else if (pathState(join(home, ".omp", "profiles", name)) !== "missing") {
				issue = `named profile ${name} has no safe agent directory (removed or unsafe); it was not recreated`;
			}
		}
		return { profiles, ...(issue ? { issue } : {}) };
	} catch (error) { return { profiles, issue: `named profiles could not be listed: ${errorText(error)}` }; }
}
type ProjectConfig = { override?: "EMPTY_ARRAY"; disabledRules?: string[]; issue?: string };
function inspectProjectConfig(project?: string): ProjectConfig {
	if (!project) return {};
	if (pathState(project) !== "directory") return { issue: "selected project is missing or unsafe" };
	for (const path of [join(project, ".omp", "settings.json"), join(project, ".claude", "settings.json")]) {
		if (pathState(path) !== "missing") return { issue: `additional project settings require effective precedence proof: ${path}` };
	}
	const folder = directoryPath(project, [".omp"]);
	if (folder === "unsafe") return { issue: "project .omp directory is unsafe" };
	if (folder === "missing") return {};
	const path = join(project, ".omp", "config.yml");
	if (pathState(path) === "missing") return {};
	try {
		if (pathState(path) !== "file") throw new Error("project config file is unsafe");
		const config: unknown = YAML.parse(fileBytes(path).toString("utf8"));
		if (!record(config)) throw new Error("project config root is not a mapping");
		if (Object.hasOwn(config, "extensions") && !strings(config.extensions)) throw new Error("project extensions are not a list of paths");
		if (Object.hasOwn(config, "ttsr") && !record(config.ttsr)) throw new Error("project ttsr is not a mapping");
		if (record(config.ttsr) && Object.hasOwn(config.ttsr, "disabledRules") && !strings(config.ttsr.disabledRules)) throw new Error("project disabledRules are not a list of names");
		return {
			...(Array.isArray(config.extensions) && config.extensions.length === 0 ? { override: "EMPTY_ARRAY" as const } : {}),
			...(record(config.ttsr) && strings(config.ttsr.disabledRules) ? { disabledRules: config.ttsr.disabledRules } : {}),
		};
	} catch (error) { return { issue: `project config could not be recognized: ${errorText(error)}` }; }
}
function disabledProvider(name: string, home: string, project?: string): DisabledConflict["provider"] {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return "unknown";
	if (directoryPath(home, [".agents", "rules"]) === "directory" && pathState(join(home, ".agents", "rules", `${name}.md`)) !== "missing") return "global";
	if (project && directoryPath(project, [".omp", "rules"]) === "directory" && pathState(join(project, ".omp", "rules", `${name}.md`)) !== "missing") return "project";
	return "unknown"; // A missing global file does not prove a builtin, project elsewhere, or user provider absent.
}
function inspectPolicy(root: string, home: string, profiles: readonly ConfigInspection[], projectConfig: ProjectConfig, inventoryIssue?: string, project?: string): Finding {
	const matching: string[] = [], drifted: string[] = [], unverified: string[] = [];
	const conflicts: DisabledConflict[] = [];
	let policy: Record<string, unknown>;
	try {
		if (directoryPath(root, ["policy"]) !== "directory") throw new Error("release policy directory is missing or unsafe");
		policy = readJsonObject(join(root, "policy", "ttsr.json"));
		if (Object.keys(policy).length !== POLICY_KEYS.length || POLICY_KEYS.some((key) => !Object.hasOwn(policy, key)) ||
			typeof policy.enabled !== "boolean" || typeof policy.repeatMode !== "string" || typeof policy.repeatGap !== "number" ||
			typeof policy.contextMode !== "string" || !strings(policy.disabledRules)) throw new Error("release policy shape is not recognized");
	} catch (error) { return finding("policy", "UNVERIFIED", `Shipped opt-in policy could not be read: ${errorText(error)}`, "Inspect the release policy and back up affected profile settings before changing policy."); }
	for (const profile of profiles) {
		const current = profile.data?.ttsr;
		if (profile.issue || !record(current) || POLICY_KEYS.some((key) => !Object.hasOwn(current, key)) ||
			typeof current.enabled !== "boolean" || typeof current.repeatMode !== "string" || typeof current.repeatGap !== "number" ||
			typeof current.contextMode !== "string" || !strings(current.disabledRules)) {
			unverified.push(profile.name);
			continue;
		}
		const disabled = current.disabledRules as string[];
		for (const name of disabled.filter((entry) => !(policy.disabledRules as string[]).includes(entry))) {
			conflicts.push({ profile: profile.name, name, provider: disabledProvider(name, home, project) });
		}
		(POLICY_KEYS.every((key) => JSON.stringify(current[key]) === JSON.stringify(policy[key])) ? matching : drifted).push(profile.name);
	}
	if (projectConfig.disabledRules) for (const name of projectConfig.disabledRules.filter((entry) => !(policy.disabledRules as string[]).includes(entry))) {
		conflicts.push({ profile: "project", name, provider: disabledProvider(name, home, project) });
	}
	return finding("policy", inventoryIssue || projectConfig.issue || unverified.length ? "UNVERIFIED" : drifted.length || conflicts.length ? "DEGRADED" : "OK",
		inventoryIssue || projectConfig.issue || unverified.length ? "Some profile or project policy settings cannot be recognized without a migratory read" :
			drifted.length || conflicts.length ? "Opt-in policy differs from on-disk profile or project disabled settings; disabled names may have other providers" :
				"Shipped opt-in policy matches the observed on-disk profile settings, not runtime activation",
		"Review policy and a guarded plan; Do not re-enable disabled rules solely because a global file is missing.",
		{ matching_profiles: matching, drifted_profiles: drifted, unverified_profiles: unverified, disabled_conflicts: conflicts,
			...(inventoryIssue ? { inventory_issue: inventoryIssue } : {}), ...(projectConfig.issue ? { project_issue: projectConfig.issue } : {}) });
}
function inspectExtensions(root: string, home: string, profiles: readonly ConfigInspection[], shadow: ProjectConfig, inventoryIssue?: string): Finding {
	let policy: Record<string, unknown>;
	try {
		if (directoryPath(root, ["policy"]) !== "directory") throw new Error("release policy directory is missing or unsafe");
		policy = readJsonObject(join(root, "policy", "extensions.json"));
		if (Object.keys(policy).length !== 2 || !strings(policy.extensions) || !strings(policy.skipProfiles) ||
			(policy.extensions as string[]).some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ts$/.test(name))) throw new Error("release extension manifest shape is not recognized");
	} catch (error) { return finding("extensions", "UNVERIFIED", `Opt-in extension manifest could not be read: ${errorText(error)}`, "Inspect the shipped extension manifest before planning an opt-in install."); }
	const skip = new Set(policy.skipProfiles as string[]);
	const checked: string[] = [], missing: string[] = [], drifted: string[] = [], unsafe: string[] = [], listed: string[] = [], unverified: string[] = [], skipped: string[] = [];
	const notCovered: { profile: string; reason: string }[] = [];
	const destinations: string[] = [];
	for (const name of policy.extensions as string[]) {
		const source = join(root, "extensions", name), destination = join(home, ".omp", "omp-extensions", name);
		destinations.push(destination);
		try {
			if (directoryPath(root, ["extensions"]) !== "directory" || pathState(source) !== "file") throw new Error("shipped extension is missing or unsafe");
			const expected = digest(fileBytes(source));
			const state = directoryPath(home, [".omp", "omp-extensions"]);
			const kind = state === "directory" ? pathState(destination) : state;
			if (kind === "missing") missing.push(name);
			else if (kind !== "file") unsafe.push(name);
			else (digest(fileBytes(destination)) === expected ? checked : drifted).push(name);
		} catch { unsafe.push(name); }
	}
	for (const profile of profiles) {
		if (skip.has(profile.name)) {
			skipped.push(profile.name);
			notCovered.push({ profile: profile.name, reason: "policy skipProfiles: profile opted out of extension installs" });
			continue;
		}
		if (profile.issue || !strings(profile.data?.extensions)) {
			unverified.push(profile.name);
			if (profile.issue) {
				const files = CONFIG_NAMES.filter(file => pathState(join(profile.dir, file)) !== "missing");
				const reason = profile.issue.includes("no on-disk profile config") ? "NO_CONFIG: no config.yml/yaml present; the kit creates nothing unasked" :
					files.length > 1 ? `DUAL_CONFIG: ${files.join(" + ")} present; OMP loads config.yml first and merges settings.json separately, so a single-file edit cannot be proven effective` :
					/removed or is unsafe|disappeared|unsafe config|not safely resolved|could not be listed/.test(profile.issue) ? `UNREADABLE: ${profile.issue}` :
					`UNPARSEABLE: ${profile.issue}`;
				notCovered.push({ profile: profile.name, reason });
			}
			continue;
		}
		if (destinations.every((path) => (profile.data!.extensions as string[]).includes(path))) listed.push(profile.name);
		else missing.push(`profile:${profile.name}`);
	}
	const uncertain = !!inventoryIssue || !!shadow.issue || !!shadow.override || unverified.length > 0 || unsafe.length > 0;
	return finding("extensions", uncertain ? "UNVERIFIED" : missing.length || drifted.length ? "DEGRADED" : "OK",
		shadow.override ? "Selected project overrides extensions with an empty list; opt-in guard is inactive there" :
			uncertain ? "Extension bytes or per-profile listing cannot establish effective loading" :
			missing.length || drifted.length ? "Opt-in extension bytes or profile listing differ from the shipped manifest" :
				"Opt-in extension bytes and on-disk profile lists match; runtime loading remains unverified",
		"Review the extension opt-in plan and project settings; never infer guard activation from installed bytes.",
		{ matching_bytes: checked, missing, drifted, unsafe, listed_profiles: listed, unverified_profiles: unverified,
			skipped_profiles: skipped, ...(shadow.override ? { project_override: shadow.override } : {}),
			not_covered_profiles: notCovered,
			...(shadow.issue ? { project_issue: shadow.issue } : {}), ...(inventoryIssue ? { inventory_issue: inventoryIssue } : {}) });
}
function inspectExtensionImports(home: string): Finding {
	const report = checkExtensionImports({ home });
	return finding("extension_imports", report.status, report.status === "OK" ?
		`${report.reason}; OMP reports unloadable extensions only at session start` : report.reason,
	report.status === "DEGRADED" ? "Fix or remove the unresolvable import before restarting sessions; OMP reports it only at session start." :
		"Extension and hook files are read as text and resolved without execution.",
		{ files_checked: report.files_checked, profiles_checked: report.profiles_checked,
			plugin_packages: report.plugin_packages, findings: report.findings });
}
function inspectAgentMailGuard(): Finding {
	const root = process.env.AGENT_MAIL_STORAGE_ROOT;
	if (!root) return finding("agent_mail_guard", "UNVERIFIED", "AGENT_MAIL_STORAGE_ROOT is unset in this process; the pre-commit guard falls back to the legacy archive root and fails open in shells without it",
		"Export AGENT_MAIL_STORAGE_ROOT from the live server root before committing (fleet-guard sessions do this at load); never infer reservation enforcement from a passing commit.",
		{ storage_root: null });
	let state: string;
	try { state = pathState(root); } catch { state = "unsafe"; }
	if (state !== "directory") return finding("agent_mail_guard", "DEGRADED", `AGENT_MAIL_STORAGE_ROOT names a ${state} path; the guard cannot resolve reservations against it`,
		"Point AGENT_MAIL_STORAGE_ROOT at the live Agent Mail root.", { storage_root: root });
	return finding("agent_mail_guard", "OK", `Pre-commit guard resolves reservations against ${root}; bare shells without the variable still fail open`,
		"None.", { storage_root: root });
}

/** Dicklesworthstone stack currency: binary to release repo plus the one chosen install source (tap formula preferred). Formula names follow the JS1 bead inventory; anything without a tap formula is undecided until Josh approves a source. */
const STACK_SOURCE: Record<string, { repo: string; formula: string | null }> = {
	ntm: { repo: "ntm", formula: "ntm" },
	br: { repo: "beads_rust", formula: "br" },
	bv: { repo: "beads_viewer", formula: "bv" },
	am: { repo: "mcp_agent_mail_rust", formula: "mcp-agent-mail" },
	dcg: { repo: "destructive_command_guard", formula: "dcg" },
	slb: { repo: "slb", formula: "slb" },
	ubs: { repo: "ultimate_bug_scanner", formula: "ubs" },
	rch: { repo: "remote_compilation_helper", formula: "rch" },
	dsr: { repo: "doodlestein_self_releaser", formula: null },
	ru: { repo: "repo_updater", formula: "ru" },
	cass: { repo: "coding_agent_session_search", formula: "cass" },
	cm: { repo: "cass_memory_system", formula: "cm" },
	caam: { repo: "coding_agent_account_manager", formula: "caam" },
	sbh: { repo: "storage_ballast_helper", formula: null },
	pt: { repo: "process_triage", formula: null },
	rano: { repo: "rano", formula: null },
	ms: { repo: "meta_skill", formula: null },
	ee: { repo: "eidetic_engine_cli", formula: "ee" },
	vc: { repo: "vibe_cockpit", formula: null },
	ft: { repo: "frankenterm", formula: null },
	fg: { repo: "frankengit", formula: null },
	caut: { repo: "coding_agent_usage_tracker", formula: null },
	acfs: { repo: "agentic_coding_flywheel_setup", formula: null },
	apr: { repo: "automated_plan_reviser_pro", formula: null },
	giil: { repo: "giil", formula: null },
	xf: { repo: "xf", formula: "xf" },
	skillranker: { repo: "skillranker", formula: null },
	fad: { repo: "franken_agent_detection", formula: null },
	tru: { repo: "toon_rust", formula: null },
	csctf: { repo: "chat_shared_conversation_to_file", formula: "csctf" },
};
export interface StackToolReport { bin: string; repo: string; source: string; installed: boolean; install_path: string | null; installed_version: string | null; latest_release: string | null; state: "current" | "behind" | "ahead" | "absent" | "unknown" }
/** Numeric-triplet ordering where a prerelease suffix on equal numbers counts as behind the release. */
function compareVersions(installed: string, latest: string): "current" | "behind" | "ahead" | null {
	const parse = (value: string): { numbers: number[]; suffix: string } | null => {
		const match = /(\d+\.\d+(?:\.\d+)*)(.*)$/.exec(value);
		if (!match?.[1]) return null;
		return { numbers: match[1].split(".").map(Number), suffix: (match[2] ?? "").trim() };
	};
	const mine = parse(installed), theirs = parse(latest);
	if (!mine || !theirs) return null;
	const width = Math.max(mine.numbers.length, theirs.numbers.length);
	for (let index = 0; index < width; index += 1) {
		const left = mine.numbers[index] ?? 0, right = theirs.numbers[index] ?? 0;
		if (left !== right) return left < right ? "behind" : "ahead";
	}
	if (mine.suffix && !theirs.suffix) return "behind";
	return "current";
}
export async function inspectDicklesworthstone(): Promise<Finding> {
	const firstLine = (command: string, args: readonly string[]): string | null => {
		try {
			const child = spawnSync(command, [...args], { encoding: "utf8", timeout: 15000 });
			if (child.error) return null;
			const line = String(child.stdout ?? "").split("\n")[0]?.trim() ?? "";
			return line ? line.slice(0, 120) : null;
		} catch { return null; }
	};
	const bins = Object.keys(STACK_SOURCE).sort();
	const query = `query { ${bins.map((bin, index) => `r${index}: repository(owner: "Dicklesworthstone", name: "${STACK_SOURCE[bin]!.repo}") { latestRelease { tagName } }`).join(" ")} }`;
	const latestTag = (lookup: Record<string, unknown>, alias: string): string | null => {
		const entry = lookup[alias];
		if (!record(entry) || !record(entry.latestRelease)) return null;
		const tag = entry.latestRelease.tagName;
		return typeof tag === "string" && tag.trim() ? tag.trim() : null;
	};
	let releases: Record<string, unknown> = {};
	try {
		const child = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], { encoding: "utf8", timeout: 20000 });
		const parsed: unknown = JSON.parse(String(child.stdout ?? "{}"));
		if (record(parsed) && record(parsed.data)) releases = parsed.data;
	} catch { /* A failed release lookup leaves every latest unknown; the finding says so. */ }
	const tools: StackToolReport[] = await Promise.all(bins.map(async (bin, index) => {
		const spec = STACK_SOURCE[bin]!;
		let installPath: string | null = null;
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			try { if (statSync(join(dir, bin)).isFile()) { installPath = join(dir, bin); break; } } catch { /* Not in this directory. */ }
		}
		const installedVersion = installPath ? firstLine(installPath, ["--version"]) : null;
		const latestRelease = latestTag(releases, `r${index}`);
		const source = spec.formula ? `homebrew dicklesworthstone/tap/${spec.formula}` : "undecided: no tap formula; install source needs approval";
		const state = !installPath ? "absent" : !installedVersion || !latestRelease ? "unknown" : compareVersions(installedVersion, latestRelease) ?? "unknown";
		return { bin, repo: spec.repo, source, installed: installPath !== null, install_path: installPath, installed_version: installedVersion, latest_release: latestRelease, state };
	}));
	const behind = tools.filter((tool) => tool.state === "behind").map((tool) => tool.bin);
	const unknown = tools.filter((tool) => tool.state === "unknown").map((tool) => tool.bin);
	const status = behind.length ? "DEGRADED" : unknown.length ? "UNVERIFIED" : "OK";
	return finding("dicklesworthstone", status,
		behind.length ? `${behind.length} installed tools are behind their latest release: ${behind.join(", ")}` :
			unknown.length ? `No installed tool is provably behind, but latest or installed versions are unknown for: ${unknown.join(", ")}` :
				"Every installed stack tool matches its latest release",
		behind.length ? "Update through each tool's chosen source (tap formula preferred); never switch a real-machine install source without approval." : "None.",
		{ tools, behind, unknown });
}
function inspectRouter(jsmPath?: string): Finding {
	const paths = jsmPath ? [jsmPath] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "jsm"));
	const available = paths.some((path) => {
		try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
	});
	return finding("router", available ? "UNVERIFIED" : "DEGRADED", available ?
		"Optional JSM executable is present; router skill indexing/search was not executed" :
		"Optional JSM router is unavailable; public kit rules and tests do not require it",
		available ? "To verify optional router skills, inspect JSM separately with consent." :
			"Install JSM separately only if optional router skills are wanted.",
		{ optional: true, availability: available ? "PRESENT" : "UNAVAILABLE", proof: "EXECUTABLE_ONLY" });
}
const REGEX_TOOLS: ReadonlyArray<{ readonly bin: string; readonly install: string }> = [
	{ bin: "grex", install: "cargo install grex" },
	{ bin: "pomsky", install: "cargo install pomsky" },
	{ bin: "regexploit", install: "pip3 install --user regexploit" },
	{ bin: "regexploit-js", install: "pip3 install --user regexploit, then npm install --omit=dev in the regexploit bin/javascript dir" },
	{ bin: "regexploit-py", install: "pip3 install --user regexploit" },
	{ bin: "rgx", install: "cargo install rgx --features pcre2-engine,redos" },
];
export function inspectRegexTools(pathValue = process.env.PATH ?? ""): Finding {
	const directories = pathValue === "" ? [] : pathValue.split(delimiter).map((directory) => directory || ".");
	const tools = REGEX_TOOLS.map(({ bin, install }) => {
		let installPath: string | null = null;
		for (const directory of directories) {
			const candidate = join(directory, bin);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) { installPath = candidate; break; }
			} catch { /* Continue through PATH; inaccessible entries are not installations. */ }
		}
		return { bin, installed: installPath !== null, install_path: installPath, install };
	});
	const missing = tools.filter((tool) => !tool.installed);
	return finding("regex-tools", missing.length ? "DEGRADED" : "OK",
		missing.length ? `Regex engineering tools are missing from PATH: ${missing.map((tool) => `${tool.bin} (${tool.install})`).join(", ")}` :
			"All required regex engineering tools are executable on PATH",
		missing.length ? "Install each missing tool with its command and rerun omp-kit doctor --scope regex-tools." : "No action required.",
		{ tools, missing: missing.map((tool) => tool.bin), proof: "EXECUTABLE_ON_PATH" });
}
export interface PaneIdentity { session: string; window: string; index: string; id: string }
export interface PaneIdentityAgent { name: string; lastActiveMs: number | null }
export interface PaneIdentityDeps {
	/** Live panes, or null when tmux is unavailable. */
	listPanes(): PaneIdentity[] | null;
	/** Agent name for a pane id, or null when no identity file matches. */
	resolvePane(id: string): string | null;
	/** Registered agents, or null when the roster is unreadable. */
	listAgents(): PaneIdentityAgent[] | null;
	now?: number;
}

const PANE_AGENT_STALE_MS = 7 * 24 * 3600 * 1000;

function paneArgs(binary: string, args: readonly string[]): { code: number; out: string } {
	try {
		const run = Bun.spawnSync([binary, ...args], { stdout: "pipe", stderr: "ignore" });
		return { code: run.exitCode, out: run.stdout.toString() };
	} catch {
		return { code: 127, out: "" };
	}
}

export function defaultPaneIdentity(projectKey: string): PaneIdentityDeps {
	return {
		listPanes: () => {
			const panes = paneArgs("tmux", ["list-panes", "-a", "-F", "#{session_name} #{window_index} #{pane_index} #{pane_id}"]);
			if (panes.code !== 0) return null;
			const rows: PaneIdentity[] = [];
			for (const line of panes.out.split("\n")) {
				const parts = line.trim().split(/\s+/);
				if (parts.length !== 4 || !parts[3]) continue;
				rows.push({ session: parts[0]!, window: parts[1]!, index: parts[2]!, id: parts[3]! });
			}
			return rows;
		},
		resolvePane: (id) => {
			const resolved = paneArgs("am", ["agents", "resolve-pane", "--project", projectKey, "--pane", id, "--json"]);
			if (resolved.code !== 0) return null;
			try {
				const value: unknown = JSON.parse(resolved.out);
				const record = (Array.isArray(value) ? value[0] : value) as { name?: unknown } | null;
				return record !== null && typeof record === "object" && typeof record.name === "string" && record.name !== "" ? record.name : null;
			} catch {
				return null;
			}
		},
		listAgents: () => {
			const listed = paneArgs("am", ["agents", "list", "--project", projectKey, "--format", "json"]);
			if (listed.code !== 0) return null;
			try {
				const value: unknown = JSON.parse(listed.out);
				if (!Array.isArray(value)) return null;
				return value
					.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
					.map((entry) => ({
						name: typeof entry.name === "string" ? entry.name : "",
						lastActiveMs: typeof entry.last_active_ts === "string" && Number.isFinite(Date.parse(entry.last_active_ts))
							? Date.parse(entry.last_active_ts as string) : null,
					}))
					.filter((entry) => entry.name !== "");
			} catch {
				return null;
			}
		},
	};
}

export function inspectPaneIdentity(deps: PaneIdentityDeps): Finding {
	const panes = deps.listPanes();
	if (panes === null) return finding("identity", "UNVERIFIED", "Live tmux panes are unavailable; pane identities were not inspected", "Run on the machine hosting the fleet with tmux on PATH, then rerun omp-kit doctor --scope identity.");
	const now = deps.now ?? Date.now();
	const byName = new Map<string, string[]>();
	const noFile: string[] = [];
	for (const pane of panes) {
		const name = deps.resolvePane(pane.id);
		if (name === null) {
			noFile.push(pane.id);
			continue;
		}
		const ids = byName.get(name) ?? [];
		ids.push(pane.id);
		byName.set(name, ids);
	}
	const shared = [...byName.entries()].filter(([, ids]) => ids.length > 1)
		.map(([name, ids]) => ({ name, panes: [...ids].sort() }));
	const liveNames = new Set(byName.keys());
	const stale: Array<{ name: string; idle_ms: number | null }> = [];
	const agents = deps.listAgents();
	if (agents !== null) {
		for (const agent of agents) {
			if (liveNames.has(agent.name)) continue;
			if (agent.lastActiveMs === null || now - agent.lastActiveMs < PANE_AGENT_STALE_MS) continue;
			stale.push({ name: agent.name, idle_ms: now - agent.lastActiveMs });
		}
	}
	const status = shared.length ? "FAIL" : noFile.length || stale.length ? "DEGRADED" : "OK";
	return finding("identity", status,
		status === "OK" ? "Every live pane resolves to exactly one registered identity" :
		shared.length ? `One identity resolves on multiple live panes: ${shared.map((row) => `${row.name} (${row.panes.join(", ")})`).join("; ")}` :
		`Pane identity gaps: ${noFile.length ? `${noFile.length} live pane(s) without an identity file` : ""}${noFile.length && stale.length ? "; " : ""}${stale.length ? `idle registration(s) with no live pane: ${stale.map((row) => row.name).join(", ")}` : ""}`,
		"Register each pane at spawn (agent-spawn-env.sh) and give every pane its own identity; resolve collisions before trusting that pane's writes.",
		{ live_panes: panes.length, no_file_panes: noFile, shared, stale });
}



/** Read-only inventory: equality is evidence about bytes, never authority to overwrite or retire. */
type EffectiveRuleProbe = (profile: string, command: "ttsr" | "plugin") => unknown;
export interface EffectiveRulesInput { home: string; ompPath: string; kitVersion: string | null; ompVersion: string | null; rules: readonly string[]; always_rules?: readonly string[]; profiles: readonly { name: string; issue?: string }[]; probe?: EffectiveRuleProbe }

function nativeProfileArgs(ompPath: string, profile: string, command: "ttsr" | "plugin"): readonly string[] {
	return [ompPath, ...(profile === "default" ? [] : ["--profile", profile]), command, "list", "--json"];
}


export function runEffectiveRuleProbe(ompPath: string, home: string, profile: string, command: "ttsr" | "plugin"): unknown {
	const [executable, ...args] = nativeProfileArgs(ompPath, profile, command);
	const env = { ...process.env, HOME: home };
	delete env.OMP_PROFILE; delete env.PI_PROFILE; delete env.PI_CODING_AGENT_DIR;
	const result = spawnSync(executable!, args, { cwd: home, env, encoding: "utf8", timeout: 15000 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? "unknown"}`);
	return JSON.parse(result.stdout);
}
function pluginEntries(value: unknown): Record<string, unknown>[] {
	if (!record(value)) return [];
	return ["npm", "marketplace"].flatMap(key => Array.isArray(value[key]) ? value[key].filter(record) : []);
}

function ruleSource(home: string, profile: string, item: Record<string, unknown>, pluginVersion: string | null, kitPackageDir: string | null): "kit_plugin" | "native_overlay" | "legacy" | "absent" {
	const path = typeof item.path === "string" ? item.path : "";
	if (!path) return "absent";
	const underKit = kitPackageDir !== null
		? path === kitPackageDir || path.startsWith(`${kitPackageDir}/`)
		: path.includes("omp-kit-companion");
	if (underKit) return pluginVersion ? "kit_plugin" : "absent";
	if (path.startsWith(join(home, ".agents", "rules"))) return "legacy";
	if (path.startsWith(join(home, ".omp", "agent", "rules")) || path.startsWith(join(home, ".omp", "profiles", profile, "agent", "rules"))) return "native_overlay";
	return "absent";
}

export function inspectEffectiveRules(input: EffectiveRulesInput): Finding {
	const probe = input.probe ?? ((profile, command) => runEffectiveRuleProbe(input.ompPath, input.home, profile, command));
	const profileRows: Record<string, unknown>[] = [];
	let failed = false;
	for (const profile of input.profiles) {
		if (profile.issue) { profileRows.push({ profile: profile.name, status: "UNVERIFIED", issue: profile.issue }); failed = true; continue; }
		try {
			const rules = probe(profile.name, "ttsr");
			const plugins = pluginEntries(probe(profile.name, "plugin"));
			const kitPlugin = plugins.find(item => typeof item.name === "string" && /omp-kit-companion/i.test(item.name));
			const pluginVersion = kitPlugin && typeof kitPlugin.version === "string" ? kitPlugin.version : null;
			const kitPackageDir = kitPlugin && typeof kitPlugin.path === "string" ? kitPlugin.path : null;
			const ruleRows = Array.isArray(rules) ? rules.filter(record) : [];
			const byName = new Map(ruleRows.map(item => [typeof item.name === "string" ? item.name : "", item]));
			const alwaysRules = new Set(input.always_rules ?? []);
			const conditionalRules = input.rules.filter(name => !alwaysRules.has(name));
			const missing = conditionalRules.filter(name => !byName.has(name) || (byName.has(name) && ruleSource(input.home, profile.name, byName.get(name)!, pluginVersion, kitPackageDir) === "absent"));
			const legacy = conditionalRules.filter(name => byName.has(name) && ruleSource(input.home, profile.name, byName.get(name)!, pluginVersion, kitPackageDir) === "legacy");
			const overlays = conditionalRules.filter(name => byName.has(name) && ruleSource(input.home, profile.name, byName.get(name)!, pluginVersion, kitPackageDir) === "native_overlay");
			const pluginRules = conditionalRules.filter(name => byName.has(name) && ruleSource(input.home, profile.name, byName.get(name)!, pluginVersion, kitPackageDir) === "kit_plugin");
			const pluginPath = kitPlugin && typeof kitPlugin.path === "string" ? kitPlugin.path : null;
			const alwaysMissing = [...alwaysRules].filter(name => !pluginPath || !existsSync(join(pluginPath, "rules", `${name}.md`)));
			const versionMismatch = pluginRules.length > 0 && input.kitVersion !== null && pluginVersion !== input.kitVersion;
			const status = missing.length || legacy.length || versionMismatch || alwaysMissing.length || !pluginRules.length && !overlays.length ? "DEGRADED" : "OK";
			if (status !== "OK") failed = true;
			profileRows.push({ profile: profile.name, status, plugin_version: pluginVersion, expected_kit_version: input.kitVersion, omp_version: input.ompVersion, kit_rules: { plugin: pluginRules, overlays, legacy, missing, always_apply: { rules: [...alwaysRules], missing: alwaysMissing, method: "plugin-rules-dir" } }, extensions: kitPlugin?.extensions ?? kitPlugin?.extension_paths ?? [] });
		} catch (error) {
			failed = true;
			profileRows.push({ profile: profile.name, status: "UNVERIFIED", issue: errorText(error) });
		}
	}
	return finding("effective_rules", failed ? "DEGRADED" : "OK", failed ? "One or more OMP profiles do not load every kit rule from the matching plugin" : "Every covered OMP profile loads kit rules from the matching plugin or a declared native overlay", "Run omp-kit apply plugin --plan, then apply the approved per-profile plugin plan; legacy ~/.agents/rules copies are owned by migrate.", { profiles: profileRows, kit_version: input.kitVersion, omp_version: input.ompVersion, legacy_rules_not_considered_authority: true });
}
async function runEffectiveRuleProbeAsync(ompPath: string, home: string, profile: string, command: "ttsr" | "plugin"): Promise<unknown> {
	const [executable, ...args] = nativeProfileArgs(ompPath, profile, command);
	const env = { ...process.env, HOME: home };
	delete env.OMP_PROFILE; delete env.PI_PROFILE; delete env.PI_CODING_AGENT_DIR;
	const child = Bun.spawn([executable!, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
	const status = await child.exited;
	if (status !== 0) throw new Error(`${command} exited ${status}`);
	return JSON.parse(await new Response(child.stdout).text());
}

export async function inspectEffectiveRulesAsync(input: EffectiveRulesInput, concurrency = 6): Promise<Finding> {
	const started = performance.now();
	const outputs = new Map<string, { ttsr: unknown; plugin: unknown } | Error>();
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, input.profiles.length) }, async () => {
		while (cursor < input.profiles.length) {
			const profile = input.profiles[cursor++]!;
			if (profile.issue) continue;
			try { const [ttsr, plugin] = await Promise.all([runEffectiveRuleProbeAsync(input.ompPath, input.home, profile.name, "ttsr"), runEffectiveRuleProbeAsync(input.ompPath, input.home, profile.name, "plugin")]); outputs.set(profile.name, { ttsr, plugin }); }
			catch (error) { outputs.set(profile.name, error instanceof Error ? error : new Error(String(error))); }
		}
	});
	await Promise.all(workers);
	const finding = inspectEffectiveRules({ ...input, probe: (profile, command) => { const result = outputs.get(profile); if (result instanceof Error) throw result; if (!result) throw new Error("profile probe missing"); return result[command]; } });
	return { ...finding, evidence: { ...(finding.evidence ?? {}), probe_method: "bounded_async_native_spawn", probe_concurrency: concurrency, probe_elapsed_ms: performance.now() - started } };
}
function inspectPlanningSkill(root: string, home: string): Finding {
	const kitPath = join(root, "skills", "jeff-planning-enhanced", "SKILL.md");
	const localPath = join(home, ".agents", "skills", "jeff-planning-enhanced", "SKILL.md");
	if (pathState(kitPath) !== "file") return finding("planning_skill", "UNVERIFIED", "Kit planning skill is missing or unsafe", "Repair the kit release; doctor does not write either skill copy.", { kit_path: kitPath });
	let kitBytes: Buffer;
	try { kitBytes = fileBytes(kitPath); }
	catch { return finding("planning_skill", "UNVERIFIED", "Kit planning skill cannot be read safely", "Inspect the kit-owned skill file without changing either copy.", { kit_path: kitPath }); }
	const localState = pathState(localPath);
	if (localState === "missing") return finding("planning_skill", "DRIFT", "Local planning skill copy is missing", "Review the kit-owned skill source and restore the local copy explicitly.", { kit_path: kitPath, local_path: localPath, kit_sha256: digest(kitBytes), local_status: "MISSING" });
	if (localState !== "file") return finding("planning_skill", "UNVERIFIED", "Local planning skill path is unsafe or unreadable", "Inspect the local skill path; doctor never replaces or follows it.", { kit_path: kitPath, local_path: localPath, local_status: "UNSAFE" });
	try {
		const localBytes = fileBytes(localPath);
		const matches = kitBytes.equals(localBytes);
		return finding("planning_skill", matches ? "OK" : "DRIFT", matches ? "Local planning skill matches the kit-owned source" : "Local planning skill differs from the kit-owned source", matches ? "No action required." : "Review and synchronize the local copy from the kit-owned skill file.", { kit_path: kitPath, local_path: localPath, kit_sha256: digest(kitBytes), local_sha256: digest(localBytes) });
	} catch {
		return finding("planning_skill", "UNVERIFIED", "Local planning skill cannot be read safely", "Inspect the local skill path; doctor never writes either copy.", { kit_path: kitPath, local_path: localPath });
	}
}

function descriptionHasAcceptanceSection(description: string): boolean {
	for (const raw of description.split("\n")) {
		let line = raw.trim().toLowerCase();
		if (line.startsWith("#")) {
			const space = line.indexOf(" ");
			line = space < 0 ? line.slice(1).trim() : line.slice(space + 1).trim();
		}
		for (const section of ["acceptance", "tests"]) {
			if (!line.startsWith(section)) continue;
			const next = line.slice(section.length, section.length + 1);
			if (next === "" || next === ":" || next === " " || next === "(") return true;
		}
	}
	return false;
}

function inspectBeadAcceptance(project: string): Finding {
	const trackerPath = join(project, ".beads", "issues.jsonl");
	if (pathState(trackerPath) !== "file") return finding("beads", "UNVERIFIED", "Tracker issues export is missing or unsafe", "Run doctor --scope beads --project PATH on the tracker repository.", { tracker_path: trackerPath });
	let rows: unknown[];
	try { rows = fileBytes(trackerPath).toString("utf8").split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line)); }
	catch { return finding("beads", "UNVERIFIED", "Tracker issues export cannot be read as JSONL", "Repair the read-only tracker export before checking acceptance-field placement.", { tracker_path: trackerPath }); }
	const missingAcceptance = rows.filter(record).flatMap((row) => {
		const description = typeof row.description === "string" ? row.description : "";
		const acceptance = typeof row.acceptance_criteria === "string" ? row.acceptance_criteria.trim() : "";
		if (acceptance || !descriptionHasAcceptanceSection(description)) return [];
		return [{ id: typeof row.id === "string" ? row.id : "UNKNOWN", title: typeof row.title === "string" ? row.title : "" }];
	});
	return missingAcceptance.length
		? finding("beads", "FAIL", "Beads put acceptance in the description while the acceptance_criteria field is empty", "Move tests and acceptance into acceptance_criteria; do not restate them in the description.", { tracker_path: trackerPath, missing_acceptance: missingAcceptance })
		: finding("beads", "OK", "No description acceptance section is missing its acceptance_criteria field", "No action required.", { tracker_path: trackerPath, checked_beads: rows.length });
}
const DUPLICATE_PAIR_SIMILARITY = 0.75;
const DUPLICATE_MIN_TOKENS = 10;
const DUPLICATE_MAX_PAIRS = 20;

function beadWordTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (token.length >= 2) tokens.add(token);
	}
	return tokens;
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / (a.size + b.size - shared);
}

function beadSearchText(row: Record<string, unknown>): Set<string> {
	const title = typeof row.title === "string" ? row.title : "";
	const description = typeof row.description === "string" ? row.description : "";
	const acceptance = typeof row.acceptance_criteria === "string" ? row.acceptance_criteria : "";
	return beadWordTokens(`${title}\n${description}\n${acceptance}`);
}

function inspectBeadDuplicates(project: string): Finding {
	const trackerPath = join(project, ".beads", "issues.jsonl");
	if (pathState(trackerPath) !== "file") return finding("beads", "UNVERIFIED", "Tracker issues export is missing or unsafe", "Run doctor --scope beads --project PATH on the tracker repository.", { tracker_path: trackerPath });
	let rows: unknown[];
	try { rows = fileBytes(trackerPath).toString("utf8").split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line)); }
	catch { return finding("beads", "UNVERIFIED", "Tracker issues export cannot be read as JSONL", "Repair the read-only tracker export before checking for duplicate beads.", { tracker_path: trackerPath }); }
	const tokenized = rows.filter(record)
		.filter((row) => row.status !== "closed" && row.status !== "tombstone")
		.map((row) => ({
			id: typeof row.id === "string" ? row.id : "UNKNOWN",
			title: typeof row.title === "string" ? row.title : "",
			tokens: beadSearchText(row),
		}))
		.filter((bead) => bead.tokens.size >= DUPLICATE_MIN_TOKENS);
	const pairs: Array<{ a_id: string; a_title: string; b_id: string; b_title: string; similarity: number }> = [];
	for (let i = 0; i < tokenized.length && pairs.length < DUPLICATE_MAX_PAIRS; i++) {
		for (let j = i + 1; j < tokenized.length && pairs.length < DUPLICATE_MAX_PAIRS; j++) {
			const similarity = tokenOverlap(tokenized[i]!.tokens, tokenized[j]!.tokens);
			if (similarity < DUPLICATE_PAIR_SIMILARITY) continue;
			pairs.push({ a_id: tokenized[i]!.id, a_title: tokenized[i]!.title, b_id: tokenized[j]!.id, b_title: tokenized[j]!.title, similarity: Math.round(similarity * 1000) / 1000 });
		}
	}
	pairs.sort((a, b) => b.similarity - a.similarity);
	return pairs.length
		? finding("beads", "FAIL", "Likely duplicate beads share most of their title, description and acceptance text", "Merge each pair into one canonical bead, keeping the richer testing specs and dependency chain.", { tracker_path: trackerPath, duplicate_pairs: pairs })
		: finding("beads", "OK", "No live bead pair shares enough text to look duplicated", "No action required.", { tracker_path: trackerPath, checked_beads: tokenized.length, duplicate_pairs: pairs });
}

export async function diagnose(input: DiagnoseInput): Promise<Finding[]> {
	if (![input.root, input.home, ...(input.project ? [input.project] : []), ...(input.ompPath ? [input.ompPath] : []), ...(input.jsmPath ? [input.jsmPath] : [])].every(isAbsolute)) throw new Error("diagnostic paths must be absolute");
	const rows: Finding[] = [inspectOmp(input.ompPath)];
	const root = resolve(input.root);
	const home = resolve(input.home);
	if (input.scope === "kit" || pathState(join(root, "skills", "jeff-planning-enhanced", "SKILL.md")) === "file") {
		rows.push(inspectPlanningSkill(root, home));
	}
	if (input.scope === "beads" && input.project) rows.push(inspectBeadAcceptance(resolve(input.project)));
	if (input.scope === "beads" && input.project) rows.push(inspectBeadDuplicates(resolve(input.project)));
	const manifest = readManifest(root);
	rows.push(finding("kit", manifest.error ? "FAIL" : manifest.sourceUnverified ? "UNVERIFIED" : "OK", manifest.error ? "Release rule inventory cannot be verified" : manifest.sourceUnverified ? "Shipped bytes match an uncommitted source pack; release provenance is unverified" : "Release rule inventory is readable", manifest.error || manifest.sourceUnverified ? "Use an intact, verified omp-kit release." : "No action required.", { release_root: root, source_proof: manifest.sourceUnverified ? "SOURCE_UNVERIFIED" : manifest.error ? "INVALID" : "MANIFEST_HASHES" }));
	rows.push(finding("manifest", manifest.error ? "FAIL" : manifest.sourceUnverified ? "UNVERIFIED" : "OK", manifest.error ?? (manifest.sourceUnverified ? "Shipped rule hashes match but pack is uncommitted" : "All manifest entries match shipped rule bytes"), manifest.error || manifest.sourceUnverified ? "Replace or repair the release before relying on its provenance." : "No action required.", { rule_count: manifest.rules.length, source_proof: manifest.sourceUnverified ? "SOURCE_UNVERIFIED" : manifest.error ? "INVALID" : "MANIFEST_HASHES" }));
	if (manifest.error) {
		rows.push(finding("installed_rules", "UNVERIFIED", "Source manifest is invalid; no installed hashes can be certified", "Replace the release, then run omp-kit apply rules --plan."));
		rows.push(finding("retired_rules", "UNVERIFIED", "Source manifest is invalid", "Replace the release before assessing retirement."));
		rows.push(finding("unknown_rules", "UNVERIFIED", "Source manifest is invalid", "Replace the release before assessing extras."));
		rows.push(finding("project_rules", "UNVERIFIED", "Source manifest is invalid", "Replace the release before assessing project shadows."));
	} else {
		const target = join(home, ".agents", "rules");
		const state = directoryPath(home, [".agents", "rules"]);
		const matching: string[] = [], missing: string[] = [], drifted: string[] = [], unsafe: string[] = [];
		const images = new Map<string, Image>();
		if (state === "directory") {
			for (const rule of manifest.rules) {
				const path = join(target, `${rule.name}.md`);
				const kind = pathState(path);
				if (kind === "missing") missing.push(rule.name);
				else if (kind !== "file") unsafe.push(rule.name);
				else {
					try {
						const installed = readImage(path);
						images.set(rule.name, installed.image);
						(installed.image.sha256 === rule.sha256 ? matching : drifted).push(rule.name);
					} catch { unsafe.push(rule.name); }
				}
			}
		} else if (state === "missing") missing.push(...manifest.rules.map((rule) => rule.name));
		else unsafe.push(...manifest.rules.map((rule) => rule.name));
		const record = currentOwnership(home);
		const owned: string[] = [], ownershipDrift: string[] = [];
		if (record.status === "PRESENT") for (const rule of manifest.rules) {
			const claim = record.rules?.[rule.name];
			if (!claim) continue;
			const actual = images.get(rule.name);
			if (!actual || claim.sha256 !== rule.sha256 || claim.sha256 !== actual.sha256 ||
				claim.size !== actual.size || claim.mode !== actual.mode || claim.uid !== actual.uid || claim.gid !== actual.gid)
				ownershipDrift.push(rule.name);
			else owned.push(rule.name);
		}
		const ownership = record.status === "UNSAFE" ? "UNSAFE_RECORD" : record.status === "MISSING" ?
			legacyRecord(home, manifest.rules) : owned.length === manifest.rules.length && !ownershipDrift.length ? "KIT_OWNED" : "UNVERIFIED";
		const installedStatus = unsafe.length || drifted.length || missing.length || ownershipDrift.length || record.status === "UNSAFE" ? "DEGRADED" :
			owned.length === manifest.rules.length && record.status === "PRESENT" ? "OK" : "UNVERIFIED";
		rows.push(finding("installed_rules", installedStatus, unsafe.length ? "Installed rule path is unsafe or unreadable" : drifted.length ? "Installed rule bytes differ from the release" : missing.length ? "Kit rules have not all been applied" :
			record.status === "UNSAFE" ? "Rule ownership record is unsafe or unreadable" : ownershipDrift.length ? "Kit ownership image differs from installed metadata or release" :
			installedStatus === "OK" ? "All installed rule images match the manifest and kit ownership record; runtime activation remains unverified" :
			"Installed rule bytes match; ownership and effective activation remain unverified",
			"Inspect omp-kit apply rules --plan; never overwrite or retire solely from byte equality.", {
				matching, missing, drifted, unsafe, owned, ownershipDrift, ownership, expected: manifest.rules.length, target,
			}));
		const retired: string[] = [], unknown: string[] = [], retiredUnsafe: string[] = [];
		let retirementError: string | undefined;
		if (directoryPath(root, ["retired"]) === "directory") {
			try { for (const name of readdirSync(join(root, "retired"))) {
				if (!name.endsWith(".md")) continue;
				if (pathState(join(root, "retired", name)) !== "file") throw new Error(`unsafe retired entry: ${name}`);
				retired.push(name.slice(0, -3));
			} } catch (error) { retirementError = errorText(error); }
		} else retirementError = "retired directory is missing or unsafe";
		const present: string[] = [], presentUnsafe: string[] = [];
		let extrasError: string | undefined;
		if (state === "directory") {
			try {
				const managed = new Set(manifest.rules.map((rule) => `${rule.name}.md`));
				for (const name of readdirSync(target)) {
					if (!name.endsWith(".md") || managed.has(name)) continue;
					const base = name.slice(0, -3);
					const kind = pathState(join(target, name));
					if (retired.includes(base)) (kind === "file" ? present : presentUnsafe).push(base);
					else (kind === "file" ? unknown : retiredUnsafe).push(base);
				}
			} catch (error) { extrasError = errorText(error); }
		} else if (state === "unsafe") extrasError = "installed rules directory is unsafe";
		rows.push(finding("retired_rules", retirementError || extrasError || state === "missing" ? "UNVERIFIED" : present.length || presentUnsafe.length ? "DEGRADED" : "OK", retirementError || extrasError || (state === "missing" ? "Installed rules directory is absent; retired entries were not inspected" : present.length || presentUnsafe.length ? "Retired names remain installed; ownership is not established" : "No retired names found in installed rules"), "Inspect omp-kit apply rules --plan; do not remove unowned files automatically.", { present: present.sort(), unsafe: presentUnsafe.sort() }));
		rows.push(finding("unknown_rules", extrasError || state === "missing" ? "UNVERIFIED" : unknown.length || retiredUnsafe.length ? "DEGRADED" : "OK", extrasError ?? (state === "missing" ? "Installed rules directory is absent; extra Markdown was not inspected" : unknown.length || retiredUnsafe.length ? "Unmanaged Markdown exists in the installed rule directory" : "No extra Markdown found"), "Inspect installed rules when present; omp-kit does not own unknown Markdown.", { names: unknown.sort(), unsafe: retiredUnsafe.sort() }));
		if (!input.project) rows.push(finding("project_rules", "UNVERIFIED", "No project was selected for shadow inspection", "Pass an absolute --project path to inspect project shadows."));
		else {
			const project = resolve(input.project);
			const projectState = directoryPath(project, [".omp", "rules"]);
			const shadows: string[] = [], mismatched: string[] = [], projectUnsafe: string[] = [];
			if (projectState === "directory") for (const rule of manifest.rules) {
				const candidate = join(project, ".omp", "rules", `${rule.name}.md`);
				const kind = pathState(candidate);
				if (kind === "file") {
					try { (digest(fileBytes(candidate)) === rule.sha256 ? shadows : mismatched).push(rule.name); }
					catch { projectUnsafe.push(rule.name); }
				} else if (kind !== "missing") projectUnsafe.push(rule.name);
			}
			rows.push(finding("project_rules", projectState === "unsafe" || projectState === "missing" && pathState(project) === "missing" || projectUnsafe.length ? "UNVERIFIED" : mismatched.length || shadows.length ? "DEGRADED" : "OK", projectState === "unsafe" ? "Project rule directory is unsafe" : projectState === "missing" && pathState(project) === "missing" ? "Selected project is missing; shadows were not inspected" : mismatched.length || shadows.length ? "Project-local rules shadow managed globals" : "No managed project-local shadows found", "Review the selected project and its .omp/rules before relying on global rule behavior.", { matching_shadows: shadows, mismatched_shadows: mismatched, unsafe: projectUnsafe, project }));
		}
	}
	const profiles = inspectProfiles(home);
	const effectiveOmpEvidence = rows.find(row => row.component === "omp")?.evidence;
	let kitVersion: string | null = null;
	try {
		const packageValue = JSON.parse(fileBytes(join(root, "package.json")).toString("utf8"));
		kitVersion = record(packageValue) && typeof packageValue.version === "string" ? packageValue.version : null;
	} catch {}
	const alwaysRules = manifest.rules.filter(rule => { try { return /^alwaysApply:\s*true/m.test(fileBytes(join(root, "rules", `${rule.name}.md`)).toString("utf8")); } catch { return false; } }).map(rule => rule.name);
	if (input.ompPath) {
		const effectiveRules = !manifest.error
			? await inspectEffectiveRulesAsync({ home, ompPath: input.ompPath, kitVersion, ompVersion: typeof effectiveOmpEvidence?.version === "string" ? effectiveOmpEvidence.version : null, rules: manifest.rules.map(rule => rule.name), always_rules: alwaysRules, profiles: profiles.profiles })
			: finding("effective_rules", "UNVERIFIED", "Native OMP identity or release manifest is unavailable; effective per-profile rules were not inspected", "Install OMP and rerun omp-kit doctor --scope rules.");
		rows.push(effectiveRules);
	}
	const project = input.project && resolve(input.project);
	const projectConfig = inspectProjectConfig(project);
	rows.push(inspectPolicy(root, home, profiles.profiles, projectConfig, profiles.issue, project));
	rows.push(inspectExtensions(root, home, profiles.profiles, projectConfig, profiles.issue));
	rows.push(inspectExtensionImports(home));
	rows.push(inspectRouter(input.jsmPath));
	rows.push(inspectAgentMailGuard());
	const stateRoot = input.stateRoot ?? join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "omp-kit");
	const stateIssue = inspectStateRoot(stateRoot);
	rows.push(stateIssue === null
		? finding("state_root", "OK", "Private state root is absent or a private directory you own", "None.")
		: finding("state_root", stateIssue.problem === "MODE" ? "DEGRADED" : "FAIL",
			`Private state root has ${stateIssue.problem === "MODE" ? `mode ${stateIssue.mode}` : stateIssue.problem.toLowerCase()}; receipts, audit, undo and update refuse until it is a 0700 directory you own`,
			stateIssue.problem === "MODE" ? "Run omp-kit repair --scope state --plan, then --apply --yes." : "Make it a real directory you own with mode 0700, or move it aside.",
			{ path: stateRoot, problem: stateIssue.problem, mode: stateIssue.mode }));
	// OMP moves under the kit (operator updaters run every few hours): compare against the last recorded test.
	const ompEvidence = rows.find((row) => row.component === "omp")?.evidence;
	const lastTest = readTestReceipt(stateRoot);
	if (typeof ompEvidence?.location !== "string" || typeof ompEvidence.package_root !== "string")
		rows.push(finding("omp_drift", "NOT_RUN", "OMP is not resolvable, so drift since the last test cannot be checked", "Install OMP, then run omp-kit test --record."));
	else if (!lastTest)
		rows.push(finding("omp_drift", "NOT_RUN", "No kit test has been recorded against this OMP yet", "Run omp-kit test --record (add --full for live scenarios)."));
	else {
		const now = ompFingerprint({ launcher: ompEvidence.location, packageRoot: ompEvidence.package_root });
		const same = now.version === lastTest.version && now.launcher_sha256 === lastTest.launcher_sha256;
		const evidence = { tested: { version: lastTest.version, scope: lastTest.scope, status: lastTest.status, recorded_at: lastTest.recorded_at }, current: { version: now.version } };
		rows.push(same && lastTest.status === "PASS"
			? finding("omp_drift", "OK", `Last kit test passed against this OMP (${now.version ?? "unknown version"}, ${lastTest.scope})`, "None.", evidence)
			: same
				? finding("omp_drift", "DEGRADED", `Last kit test against this OMP did not pass (${lastTest.status})`, "Run omp-kit test --record --json and read its failures.", evidence)
				: finding("omp_drift", "DEGRADED", `OMP changed since the last kit test (${lastTest.version ?? "unknown"} → ${now.version ?? "unknown"})`, "Run omp-kit test --record (add --full for live scenarios) against the new OMP.", evidence));
	}
	const backupScope = [join(home, ".omp", "settings.json"),
		...profiles.profiles.flatMap((profile) => [...CONFIG_NAMES, "agent.db"].map((name) => join(profile.dir, name)))];
	if (input.project) backupScope.push(join(input.project, ".omp", "config.yml"), join(input.project, ".omp", "settings.json"), join(input.project, ".claude", "settings.json"));
	rows.push(finding("effective_profile", "UNVERIFIED", "On-disk settings cannot prove OMP effective values, runtime overlays or activation",
		"Inspect effective values with OMP itself: omp config list (named profiles: omp --profile NAME config list). Back up the files listed in evidence.backup_scope before changing any of them.",
		{ profiles: profiles.profiles.map((profile) => profile.name), backup_scope: backupScope, ...(profiles.issue ? { inventory_issue: profiles.issue } : {}) }));
	rows.push(finding("matcher", "NOT_RUN", "Matcher was not exercised by the inventory", "Run omp-kit test for matcher evidence."));
	return rows.sort((a, b) => a.component.localeCompare(b.component));
}

/** Strict precedence never promotes an unperformed or uncertain probe to OK. */
export function health(findings: readonly Finding[]): "OK" | "DEGRADED" | "UNVERIFIED" | "FAIL" {
	if (findings.some((item) => item.status === "FAIL")) return "FAIL";
	if (findings.some((item) => item.status === "UNVERIFIED" || item.status === "NOT_RUN")) return "UNVERIFIED";
	if (findings.some((item) => item.status === "DEGRADED" || item.status === "DRIFT")) return "DEGRADED";
	return findings.length ? "OK" : "UNVERIFIED";
}
