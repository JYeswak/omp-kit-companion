import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";
import { resolveOmpIdentity } from "./paths.ts";
import { inspectStateRoot } from "./state-root.ts";
import { ompFingerprint, readTestReceipt } from "./omp-watch.ts";
import type { Image } from "./mutations.ts";
import { checkExtensionImports } from "./extensions.ts";

export type DiagnosticStatus = "OK" | "DEGRADED" | "UNVERIFIED" | "FAIL" | "NOT_RUN";
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
	ompPath?: string;
	jsmPath?: string;
	/** Private kit state root; defaults to $XDG_STATE_HOME/omp-kit or ~/.local/state/omp-kit. */
	stateRoot?: string;
}
export interface ManifestRule { name: string; sha256: string; pack: string }
export type RuleOwnershipRecord = { version: 1; rules: Record<string, Image> };
const HEADER = "name\tsha256\tclass\tpack";
const RECORD_HEADER = "name\tsha256\tpack\tinstalled_utc";
const CLASSES: Record<string, true> = { always: true, tripwire: true, reminder: true, router: true, canary: true };
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
			typeof image.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.sha256) ||
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
export function readManifest(root: string): { rules: ManifestRule[]; sourceUnverified: boolean; error?: string } {
	try {
		if (directoryPath(root, ["rules"]) !== "directory") throw new Error("rules directory is missing or unsafe");
		const manifest = fileBytes(join(root, "MANIFEST.tsv")).toString("utf8");
		if (!manifest.endsWith("\n")) throw new Error("MANIFEST.tsv must end with a newline");
		const lines = manifest.slice(0, -1).split("\n");
		if (lines.shift() !== HEADER || !lines.length) throw new Error("MANIFEST.tsv header or records are invalid");
		const seen = new Set<string>();
		let sourceUnverified = false;
		const rules: ManifestRule[] = [];
		for (const [index, row] of lines.entries()) {
			const fields = row.split("\t");
			if (fields.length !== 4) throw new Error(`manifest row ${index + 2} must have four tab-separated fields`);
			const [name, sha256, ruleClass, pack] = fields as [string, string, string, string];
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || seen.has(name) || !/^[a-f0-9]{64}$/.test(sha256) || !Object.hasOwn(CLASSES, ruleClass) || !/^(?:[a-f0-9]{7,64}|uncommitted-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/.test(pack)) {
				throw new Error(`invalid or duplicate manifest row ${index + 2}`);
			}
			if (pack.startsWith("uncommitted-")) sourceUnverified = true;
			seen.add(name);
			const file = join(root, "rules", `${name}.md`);
			if (pathState(file) !== "file" || digest(fileBytes(file)) !== sha256) throw new Error(`shipped rule hash or file type disagrees with manifest: ${name}`);
			rules.push({ name, sha256, pack });
		}
		for (const entry of readdirSync(join(root, "rules"))) {
			if (entry.endsWith(".md") && !seen.has(entry.slice(0, -3))) throw new Error(`shipped rule omitted from MANIFEST.tsv: ${entry}`);
		}
		return { rules, sourceUnverified };
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
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name === "default" || name.endsWith(".")) continue;
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

/** Read-only inventory: equality is evidence about bytes, never authority to overwrite or retire. */
export async function diagnose(input: DiagnoseInput): Promise<Finding[]> {
	if (![input.root, input.home, ...(input.project ? [input.project] : []), ...(input.ompPath ? [input.ompPath] : []), ...(input.jsmPath ? [input.jsmPath] : [])].every(isAbsolute)) throw new Error("diagnostic paths must be absolute");
	const rows: Finding[] = [inspectOmp(input.ompPath)];
	const root = resolve(input.root);
	const home = resolve(input.home);
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
	const project = input.project && resolve(input.project);
	const projectConfig = inspectProjectConfig(project);
	rows.push(inspectPolicy(root, home, profiles.profiles, projectConfig, profiles.issue, project));
	rows.push(inspectExtensions(root, home, profiles.profiles, projectConfig, profiles.issue));
	rows.push(inspectExtensionImports(home));
	rows.push(inspectRouter(input.jsmPath));
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
	if (findings.some((item) => item.status === "DEGRADED")) return "DEGRADED";
	return findings.length ? "OK" : "UNVERIFIED";
}
