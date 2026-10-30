import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { ownedTmp } from "./kitlib/tmp.ts";
import { run, runSync } from "./kitlib/run.ts";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";
import { observeOmpLauncherVersion, observeOmpManagers, resolveOmpIdentity } from "./paths.ts";
import { readDrainStore, staleClaims } from "./drain.ts";
import { defaultLivenessProbe, holderVerdict, readLivenessSources } from "./holder-liveness.ts";
import { scoreFlywheel, type Grade } from "./flywheel-score.ts";
import { scanDerivedText, shouldScanFile } from "./derived-check.ts";
import { inspectStateRoot } from "./state-root.ts";
import { runtimeTempRoot } from "./runtime.ts";
import { isSha256Hex, matchesBounded } from "./regex-guards.ts";
import { ompFingerprint, readTestReceipt } from "./omp-watch.ts";
import type { Image } from "./mutations.ts";
import { checkExtensionImports } from "./extensions.ts";
import { pluginPackageHash } from "./apply-plugin.ts";
import { inspectPluginRelease, livePluginReleaseIo } from "./plugin-release.ts";
import { inspectHooks, liveHookFreshnessIo } from "./hook-refresh.ts";
import { analyzeBeadBreadth, loadPlanningScoreConfig, type LoadedPlanningScoreConfig, type PlanningBead } from "./planning-score.ts";
import { inspectTestScope } from "./test-scope.ts";
import { inspectGatePlane } from "./gate-plane.ts";

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
	/** Presence inventory only; runtime rule activation remains explicitly NOT_RUN. */
	inventoryOnly?: boolean;
	ompPath?: string;
	/** Isolated environment for PATH-selected OMP diagnostics; omitted by CLI callers. */
	ompEnvironment?: Record<string, string | undefined>;
	jsmPath?: string;
	/** Private kit state root; defaults to $XDG_STATE_HOME/omp-kit or ~/.local/state/omp-kit. */
	stateRoot?: string;
	/** Doctor only: persist the rch socket inode baseline on a healthy read. Off, an existing baseline is still read and compared, never written. */
	recordRchBaseline?: boolean;
	/** GitHub billing probe; when present the actions-billing finding is included. */
	actionsBilling?: ActionsBillingProbe | null;
}

export const DIAGNOSTIC_SCOPE_COMPONENTS: Readonly<Record<string, readonly string[]>> = {
	kit: ["kit", "manifest", "planning_skill"],
	beads: ["beads", "bead_breadth"],
	omp: ["omp"],
	rules: ["installed_rules", "effective_rules", "retired_rules", "unknown_rules", "project_rules"],
	profile: ["effective_profile"],
	settings: ["policy"],
	extensions: ["extensions", "extension_imports"],
	browsers: ["browsers"],
	identity: ["identity"],
	hooks: ["hooks"],
	"regex-tools": ["regex-tools"],
	"test-scope": ["test-scope"],
	gates: ["gates"],
	rch: ["rch", "rch_gc_roots", "rch_workers"],
	activation: ["activation"],
};
export type RuleClass = "always" | "tripwire" | "reminder" | "router" | "canary";
export interface ManifestRule { name: string; sha256: string; ruleClass: RuleClass; pack: string }
export type RuleOwnershipRecord = { version: 1; rules: Record<string, Image>; fleetRules: Record<string, Image> };
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
	const keys = Object.keys(row).sort().join(",");
	if ((keys !== "rules,version" && keys !== "fleetRules,rules,version") || row.version !== 1 ||
		!row.rules || typeof row.rules !== "object" || Array.isArray(row.rules) ||
		(row.fleetRules !== undefined && (typeof row.fleetRules !== "object" || Array.isArray(row.fleetRules)))) throw new Error("STATE_UNSAFE");
	const owned: Array<[string, unknown]> = [...Object.entries(row.rules as Record<string, unknown>)];
	if (row.fleetRules !== undefined) owned.push(...Object.entries(row.fleetRules as Record<string, unknown>));
	for (const [name, value] of owned) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("STATE_UNSAFE");
		const image = value as Record<string, unknown>;
		if (Object.keys(image).sort().join(",") !== "gid,mode,sha256,size,uid" ||
			typeof image.sha256 !== "string" || !isSha256Hex(image.sha256) ||
			![image.size, image.mode, image.uid, image.gid].every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0) ||
			(image.mode as number) > 0o7777) throw new Error("STATE_UNSAFE");
	}
	return { version: 1, rules: row.rules as Record<string, Image>, fleetRules: (row.fleetRules as Record<string, Image> | undefined) ?? {} };
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
		const record = parseRuleOwnership(file.bytes);
		return { status: "PRESENT", rules: { ...record.rules, ...record.fleetRules } };
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
/** GitHub billing probe for the checkout's origin repo. Nulls mean unknown (gh missing, unauthenticated or offline): UNVERIFIED, never OK. A gh collector fills this in the wiring slice. */
export interface ActionsBillingProbe { repo: string; isPrivate: boolean | null; actionsEnabled: boolean | null }
export function inspectActionsBilling(probe: ActionsBillingProbe): Finding {
	if (probe.isPrivate === null || probe.actionsEnabled === null)
		return finding("actions-billing", "UNVERIFIED", `Cannot determine billing exposure for ${probe.repo}: GitHub repo visibility or Actions state is unknown`, "Run with gh authenticated and network reachable, then rerun omp-kit doctor.", { repo: probe.repo, proof: "GH_API_UNREACHABLE" });
	if (probe.isPrivate && probe.actionsEnabled)
		return finding("actions-billing", "FAIL", `Private repo ${probe.repo} has GitHub Actions enabled: runs are billable`, "Disable Actions on the private repo (gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false) or make the repo public.", { repo: probe.repo, proof: "PRIVATE_ACTIONS_ENABLED" });
	return finding("actions-billing", "OK", probe.isPrivate ? `Private repo ${probe.repo} has Actions disabled` : `Public repo ${probe.repo}: Actions runs are not billable`, "No action required.", { repo: probe.repo, proof: "NO_BILLABLE_EXPOSURE" });
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
/** Unscoped inventory never executes the OMP launcher. The launcher-version
 * cross-check (a subprocess execution) runs only under the explicit omp scope;
 * every other inventory reports presence from package metadata with the
 * launcher check NOT_RUN. */
function inspectOmp(path?: string, env: Record<string, string | undefined> = process.env, probeLauncher = false): Finding {
	const managers = observeOmpManagers(env);
	const managerEvidence = {
		manager_source: managers.source,
		manager_source_provenance: managers.sourceProvenance,
		manager_versions: managers.versions,
	};
	if (path && !isAbsolute(path)) {
		return finding("omp", "UNVERIFIED", "OMP launcher must be an absolute path", "Use the exact PATH-selected OMP launcher and inspect its manager metadata.", {
			availability: "UNVERIFIED", location: managers.launcher, requested_location: path, version: null, version_proof: "UNVERIFIED", launcher_version: null, launcher_version_proof: "UNVERIFIED", ...managerEvidence,
		});
	}
	if (path && pathState(path) === "missing") {
		return finding("omp", "FAIL", "OMP launcher is unavailable", "Install OMP or supply the PATH-selected OMP launcher.", {
			availability: "UNAVAILABLE", location: managers.launcher, requested_location: path, version: null, version_proof: "UNVERIFIED", launcher_version: null, launcher_version_proof: "UNVERIFIED", ...managerEvidence,
		});
	}
	if (!managers.launcher) {
		return finding("omp", "FAIL", "OMP executable not found on PATH", "Install OMP and put its launcher on PATH.", {
			availability: "UNAVAILABLE", location: null, version: null, version_proof: "UNVERIFIED", launcher_version: null, launcher_version_proof: "UNVERIFIED", ...managerEvidence,
		});
	}
	try {
		const requested = path ? realpathSync(path) : managers.launcher;
		if (requested !== managers.launcher) {
			return finding("omp", "UNVERIFIED", "Requested OMP launcher differs from the PATH-selected launcher", "Use the PATH winner or resolve its manager metadata before relying on its version.", {
				availability: "UNVERIFIED", location: managers.launcher, requested_location: requested, version: null, version_proof: "UNVERIFIED", launcher_version: null, launcher_version_proof: "UNVERIFIED", ...managerEvidence,
			});
		}
		const identity = resolveOmpIdentity(env);
		if (identity.launcher !== managers.launcher) throw new Error("PATH-selected OMP launcher changed during inspection");
		const metadata: unknown = JSON.parse(fileBytes(join(identity.packageRoot, "package.json")).toString("utf8"));
		const version = metadata && typeof metadata === "object" && "version" in metadata && typeof metadata.version === "string" && metadata.version.trim() ? metadata.version : null;
		const managerVersion = managers.source === "tern" ? managers.versions.tern : managers.source === "bun" ? managers.versions.bun : null;
		if (!probeLauncher) {
			return finding("omp", version ? "OK" : "UNVERIFIED",
				version ? "OMP launcher and package version resolved from metadata" : "OMP launcher resolved but package version is not verifiable",
				version ? "No action required." : "Inspect the installed OMP package metadata before relying on its version.", {
					availability: "PRESENT",
					location: identity.launcher,
					package_root: identity.packageRoot,
					manager_version: managerVersion?.version ?? null,
					manager_version_provenance: managerVersion?.provenance ?? "UNVERIFIED",
					version,
					version_proof: version ? "PACKAGE_METADATA" : "UNVERIFIED",
					launcher_version: null,
					launcher_version_proof: "NOT_RUN",
					...managerEvidence,
				});
		}
		const launcherVersion = observeOmpLauncherVersion(identity.launcher, env);
		const mismatches: string[] = [];
		if (managers.source === "unknown") mismatches.push("manager source is unknown");
		else if (!managerVersion || managerVersion.status !== "PRESENT") mismatches.push(managerVersion?.reason ?? "manager version is unverified");
		if (!version) mismatches.push("OMP package metadata version is unavailable");
		if (!launcherVersion) mismatches.push("OMP launcher version is unavailable");
		if (managerVersion?.status === "PRESENT" && version !== managerVersion.version) mismatches.push("manager and package versions disagree");
		if (version && launcherVersion !== version) mismatches.push("launcher and package versions disagree");
		const verified = mismatches.length === 0;
		const reason = verified ? "PATH-selected OMP manager, launcher and package versions agree" : `OMP manager/version evidence is unverified: ${mismatches.join("; ")}`;
		return finding("omp", verified ? "OK" : "UNVERIFIED", reason,
			verified ? "No action required." : "Inspect the PATH-selected OMP launcher and manager metadata before relying on its version.", {
				availability: verified ? "PRESENT" : "UNVERIFIED",
				location: identity.launcher,
				package_root: identity.packageRoot,
				manager_version: managerVersion?.version ?? null,
				manager_version_provenance: managerVersion?.provenance ?? "UNVERIFIED",
				version,
				version_proof: version ? "PACKAGE_METADATA" : "UNVERIFIED",
				launcher_version: launcherVersion,
				launcher_version_proof: launcherVersion ? "OMP_LAUNCHER" : "UNVERIFIED",
				...managerEvidence,
			});
	} catch (error) {
		const reason = errorText(error);
		const unavailable = managers.launcher === null || (path !== undefined && pathState(path) === "missing");
		return finding("omp", unavailable ? "FAIL" : "UNVERIFIED", reason, unavailable ? "Install OMP and put its launcher on PATH." : "Inspect the OMP launcher, manager metadata and package identity before testing.", {
			availability: unavailable ? "UNAVAILABLE" : "UNVERIFIED",
			location: managers.launcher,
			requested_location: path,
			version: null,
			version_proof: "UNVERIFIED",
			launcher_version: probeLauncher && managers.launcher ? observeOmpLauncherVersion(managers.launcher, env) : null,
			launcher_version_proof: probeLauncher ? "UNVERIFIED" : "NOT_RUN",
			...managerEvidence,
		});
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

function inspectPluginLinks(root: string, home: string): Finding {
	let installedRoot: string;
	let installedHash: string;
	try {
		installedRoot = realpathSync(root);
		installedHash = pluginPackageHash(installedRoot);
	} catch (error) {
		return finding("plugin_links", "UNVERIFIED", `Installed kit plugin package could not be verified: ${errorText(error)}`,
			"Use an intact, verified omp-kit release.", { release_root: root });
	}
	// STAMP1 (ompkit-fp72.3): the installed release's own version from its
	// release-manifest.json. Profile plugin copies compare their package.json
	// version against this baseline, not against another package.json copy.
	let manifestBaseline: string | null = null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(installedRoot, "release-manifest.json"), "utf8"));
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") manifestBaseline = parsed.version;
	} catch {
		manifestBaseline = null;
	}
	const profiles = new Set(["default"]);
	let inventoryIssue: string | undefined;
	const namedDirectory = join(home, ".omp", "profiles");
	const namedState = directoryPath(home, [".omp", "profiles"]);
	if (namedState === "directory") {
		try {
			for (const name of readdirSync(namedDirectory).sort()) {
				if (!matchesBounded(name, 128, /^[a-z0-9][a-z0-9._-]{0,63}$/) || name === "default" || name.endsWith(".")) continue;
				const profilePath = join(namedDirectory, name);
				const agentState = directoryPath(home, [".omp", "profiles", name, "agent"]);
				if (agentState === "directory") profiles.add(name);
				else if (pathState(profilePath) !== "missing")
					inventoryIssue = `named profile ${name} has no safe agent directory (removed or unsafe); it was not recreated`;
			}
		} catch (error) { inventoryIssue = `named profiles could not be listed: ${errorText(error)}`; }
	} else if (namedState === "unsafe") inventoryIssue = "named profile directory is unsafe";

	const observations: Array<Record<string, unknown>> = [];
	const staleProfiles: string[] = [], missingProfiles: string[] = [], unverifiedProfiles: string[] = [];
	const mismatchProfiles: string[] = [], mismatchDetail: Array<{ profile: string; plugin: string; release: string }> = [];
	for (const profile of [...profiles].sort()) {
		const parent = profile === "default"
			? [".omp", "plugins", "node_modules"]
			: [".omp", "profiles", profile, "plugins", "node_modules"];
		const linkPath = join(home, ...parent, "omp-kit-companion");
		const parentState = directoryPath(home, parent);
		if (parentState === "missing") {
			missingProfiles.push(profile);
			observations.push({ profile, path: linkPath, status: "MISSING" });
			continue;
		}
		if (parentState === "unsafe") {
			unverifiedProfiles.push(profile);
			observations.push({ profile, path: linkPath, status: "UNVERIFIED", reason: "plugin parent path is unsafe" });
			continue;
		}
		try {
			const stat = lstatSync(linkPath);
			if (stat.isSymbolicLink()) {
				let target: string;
				try { target = realpathSync(linkPath); }
				catch {
					staleProfiles.push(profile);
					observations.push({ profile, path: linkPath, status: "STALE", target: null, reason: "plugin symlink is broken" });
					continue;
				}
				const current = target === installedRoot;
				observations.push({ profile, path: linkPath, status: current ? "CURRENT" : "STALE", target,
					...(current ? {} : { reason: "plugin symlink points to a different release" }) });
				if (!current) staleProfiles.push(profile);
			} else if (stat.isDirectory()) {
				const actualHash = pluginPackageHash(resolve(linkPath));
				const current = actualHash === installedHash;
				observations.push({ profile, path: linkPath, status: current ? "CURRENT" : "STALE", package_sha256: actualHash,
					...(current ? {} : { reason: "copied plugin package differs from installed release" }) });
				if (!current) staleProfiles.push(profile);
			} else {
				unverifiedProfiles.push(profile);
				observations.push({ profile, path: linkPath, status: "UNVERIFIED", reason: "plugin path is neither a directory nor a symlink" });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				missingProfiles.push(profile);
				observations.push({ profile, path: linkPath, status: "MISSING" });
			} else {
				unverifiedProfiles.push(profile);
				observations.push({ profile, path: linkPath, status: "UNVERIFIED", reason: errorText(error) });
			}
		}
		// STAMP1: even a structurally current link can pin a stale plugin
		// version in its lock file (live case: lock 0.2.37, release 0.2.38).
		// A mismatch is DEGRADED with versionMismatch, not FAIL.
		if (manifestBaseline !== null) {
			try {
				const lockDir = profile === "default"
					? join(home, ".omp", "plugins")
					: join(home, ".omp", "profiles", profile, "plugins");
				const lockParsed: unknown = JSON.parse(readFileSync(join(lockDir, "omp-plugins.lock.json"), "utf8"));
				if (lockParsed && typeof lockParsed === "object" && "plugins" in lockParsed) {
					const lockPlugins = lockParsed.plugins;
					if (lockPlugins && typeof lockPlugins === "object" && "omp-kit-companion" in lockPlugins) {
						const lockEntry: unknown = lockPlugins["omp-kit-companion"];
						if (lockEntry && typeof lockEntry === "object" && "version" in lockEntry) {
							const lockVersion: unknown = lockEntry.version;
							if (typeof lockVersion === "string" && lockVersion !== manifestBaseline) {
								mismatchProfiles.push(profile);
								mismatchDetail.push({ profile, plugin: lockVersion, release: manifestBaseline });
								observations.push({ profile, path: join(lockDir, "omp-plugins.lock.json"), status: "STALE", versionMismatch: `${lockVersion} vs ${manifestBaseline}` });
							}
						}
					}
				}
			} catch {
				// No readable lock: the hash comparison above still guards integrity.
			}
		}
	}
	const status = staleProfiles.length ? "FAIL" : unverifiedProfiles.length || inventoryIssue ? "UNVERIFIED" : missingProfiles.length || mismatchProfiles.length ? "DEGRADED" : "OK";
	const reason = staleProfiles.length
		? `Plugin links for profile(s) ${staleProfiles.join(", ")} differ from installed release ${installedRoot}`
		: missingProfiles.length ? `Kit plugin is not installed for profile(s) ${missingProfiles.join(", ")}`
			: mismatchProfiles.length ? `Plugin lock version differs from installed release ${manifestBaseline} for profile(s) ${mismatchProfiles.join(", ")}`
				: unverifiedProfiles.length || inventoryIssue ? `Plugin link inspection is incomplete${inventoryIssue ? `: ${inventoryIssue}` : ` for profile(s) ${unverifiedProfiles.join(", ")}`}`
					: "All covered profile plugin links match the installed release";
	const recommendedAction = staleProfiles.length || missingProfiles.length || mismatchProfiles.length
		? "Run omp-kit apply plugin --apply --yes --profiles all --include-default; retain the plugin receipt so the relink can be undone."
		: unverifiedProfiles.length || inventoryIssue ? "Resolve the unsafe or incomplete profile-path inspection, then rerun omp-kit doctor." : "No action required.";
	return finding("plugin_links", status, reason, recommendedAction, {
		release_root: installedRoot, expected_package_sha256: installedHash, links: observations,
		stale_profiles: staleProfiles, missing_profiles: missingProfiles, unverified_profiles: unverifiedProfiles,
		mismatch_profiles: mismatchProfiles, mismatch_detail: mismatchDetail,
		...(inventoryIssue ? { inventory_issue: inventoryIssue } : {}),
	});
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
	const unversioned: { profile: string; path: string; reason: string }[] = [];
	const shipped = new Map<string, string>();
	const destinations: string[] = [];
	for (const name of policy.extensions as string[]) {
		const source = join(root, "extensions", name), destination = join(home, ".omp", "omp-extensions", name);
		destinations.push(destination);
		try {
			if (directoryPath(root, ["extensions"]) !== "directory" || pathState(source) !== "file") throw new Error("shipped extension is missing or unsafe");
			const expected = digest(fileBytes(source));
			shipped.set(name, expected);
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
		for (const entry of profile.data!.extensions as string[]) {
			if (typeof entry !== "string" || !isAbsolute(entry)) continue;
			const expected = shipped.get(basename(entry));
			let reason: string | null = null;
			if (expected === undefined) reason = `NO_MANIFEST_ENTRY: ${basename(entry)} is profile-listed but no shipped extension of that name exists`;
			else {
				try {
					if (pathState(entry) !== "file" || digest(fileBytes(entry)) !== expected) reason = `BYTES_DRIFTED: listed bytes differ from the shipped ${basename(entry)} copy`;
				} catch { reason = `UNREADABLE: listed path cannot be read: ${entry}`; }
			}
			if (reason) unversioned.push({ profile: profile.name, path: entry, reason });
		}
	}
	const uncertain = !!inventoryIssue || !!shadow.issue || !!shadow.override || unverified.length > 0 || unsafe.length > 0;
	return finding("extensions", uncertain ? "UNVERIFIED" : missing.length || drifted.length || unversioned.length ? "DEGRADED" : "OK",
		shadow.override ? "Selected project overrides extensions with an empty list; opt-in guard is inactive there" :
			uncertain ? "Extension bytes or per-profile listing cannot establish effective loading" :
			missing.length || drifted.length || unversioned.length ? "Opt-in extension bytes or profile listing differ from the shipped manifest" :
				"Opt-in extension bytes and on-disk profile lists match; runtime loading remains unverified",
		"Review the extension opt-in plan and project settings; never infer guard activation from installed bytes.",
		{ matching_bytes: checked, missing, drifted, unsafe, listed_profiles: listed, unverified_profiles: unverified,
			unversioned_extensions: unversioned,
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

/** Dicklesworthstone stack currency: binary to release repo plus the one chosen install source (tap formula preferred). Exported so the setup-guide pin test reads the same probe list as the doctor. Formula names follow the JS1 bead inventory; anything without a tap formula is undecided until Josh approves a source. */
export const STACK_SOURCE: Record<string, { repo: string; formula: string | null }> = {
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
/** How strongly a pane->agent binding is evidenced. Only qualified live-pane runtime evidence is verified. */
export type PaneBindingStrength = "verified" | "unverified";
export interface PaneBinding {
	/** Resolved agent name; never inferred from legacy names or adopted-dead roster rows. */
	name: string;
	/** Project key this binding was observed under; null when the source reports none. One seat may carry several project/name bindings. */
	project?: string | null;
	/** Where the binding came from, e.g. "agent-mail:resolve-pane". */
	source: string;
	strength: PaneBindingStrength;
	/** Required when strength is unverified: why this binding cannot verify a sender. */
	reason?: string;
	/** Native seat/session observed with the binding, when the source reports one. */
	seat?: string | null;
}
export interface PaneIdentityDeps {
	/** Project key the deps were built for; retained in identity evidence. */
	project?: string;
	/** Live panes, or null when tmux is unavailable. */
	listPanes(): PaneIdentity[] | null;
	/** Agent name for a pane id, or null when no identity file matches. Prefer resolvePaneBinding: a bare name carries no source or strength. */
	resolvePane(id: string): string | null;
	/** Binding-preserving resolver; preferred over resolvePane when present. */
	resolvePaneBinding?(id: string): PaneBinding | null;
	/** Every observed binding for a pane (e.g. one per project); preferred over resolvePaneBinding when present. Defaults to the single resolvePaneBinding result. */
	resolvePaneBindings?(id: string): PaneBinding[] | null;
	/** Reservation holders observed for the readback scope, or null when the source is unreadable. Read-only: never mutates leases. */
	listReservations?(): ReservationHolder[] | null;
	/** Registered agents, or null when the roster is unreadable. */
	listAgents(): PaneIdentityAgent[] | null;
	now?: number;
}
/** An exclusive or shared reservation holder as observed, before custody classification. */
export interface ReservationHolder {
	/** Holder identity as recorded, e.g. a lease holder name. */
	holder: string;
	/** Native seat the holder resolves to, when the source reports one. */
	seat?: string | null;
	/** True for exclusive leases; shared/observe-only otherwise. */
	exclusive?: boolean;
	/** Project key the reservation was observed under, when the source reports one. */
	project?: string | null;
}
export type HolderCustody = "held-by-this-pane" | "peer" | "unresolved";
export interface SeatHolderAttribution {
	holder: string;
	seat: string | null;
	custody: HolderCustody;
	exclusive: boolean;
	/** Required when custody is unresolved: why the holder cannot be attributed to a live seat. */
	reason?: string;
}
export interface SeatBindingRow {
	/** Native seat/session this row describes. */
	seat: string;
	/** Every verified project/name binding observed for the seat. */
	bindings: Array<{ project: string | null; name: string; source: string }>;
	/** All known holders classified relative to this seat. */
	holders: SeatHolderAttribution[];
}
/** Acknowledgement record to attribute to an exact acking-seat binding. */
export interface IdentityAck {
	/** Native seat that acknowledged, when the source reports one. */
	seat?: string | null;
	/** Sender name claimed by the acknowledgement, when present. */
	name?: string | null;
}

const PANE_AGENT_STALE_MS = 7 * 24 * 3600 * 1000;

function paneArgs(binary: string, args: readonly string[]): { code: number; out: string } {
	try {
		// env is passed explicitly: Bun resolves the binary against the PATH
		// in effect at call time, not a startup snapshot.
		const run = Bun.spawnSync([binary, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env } });
		return { code: run.exitCode, out: run.stdout.toString() };
	} catch {
		return { code: 127, out: "" };
	}
}

export function defaultPaneIdentity(projectKey: string): PaneIdentityDeps {
	const resolvePaneBinding = (id: string): PaneBinding | null => {
		const resolved = paneArgs("am", ["agents", "resolve-pane", "--project", projectKey, "--pane", id, "--json"]);
		if (resolved.code !== 0) return null;
		try {
			const value: unknown = JSON.parse(resolved.out);
			const record: unknown = Array.isArray(value) ? value[0] : value;
			if (record !== null && typeof record === "object") {
				let name: string | null = null;
				for (const key of ["agent_name", "name"] as const) {
					if (!(key in record)) continue;
					const candidate: unknown = record[key];
					if (typeof candidate === "string" && candidate !== "") { name = candidate; break; }
				}
				if (name === null) return null;
				let seat: string | null = null;
				for (const key of ["seat", "session", "pane"] as const) {
					if (!(key in record)) continue;
					const candidate: unknown = record[key];
					if (typeof candidate === "string" && candidate !== "") { seat = candidate; break; }
				}
				return { name, project: projectKey, source: "agent-mail:resolve-pane", strength: "verified", seat };
			}
			return null;
		} catch {
			return null;
		}
	};
	return {
		project: projectKey,
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
		resolvePane: (id) => resolvePaneBinding(id)?.name ?? null,
		resolvePaneBinding,
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
	const unverified: Array<{ pane: string; name: string; source: string; reason: string }> = [];
	const seats = new Set<string>();
	const seatBindings = new Map<string, Array<{ project: string | null; name: string; source: string }>>();
	const checkedPanes = new Set<string>();
	const nameToSeat = new Map<string, string>();
	const ambiguousNames = new Set<string>();
	const bindingsFor = (pane: PaneIdentity): PaneBinding[] | null => {
		if (deps.resolvePaneBindings) return deps.resolvePaneBindings(pane.id);
		const single = deps.resolvePaneBinding?.(pane.id) ?? null;
		return single === null ? null : [single];
	};
	for (const pane of panes) {
		const observed = bindingsFor(pane);
		if (observed === null || observed.length === 0) {
			const name = deps.resolvePane(pane.id);
			if (name === null) {
				noFile.push(pane.id);
				continue;
			}
			unverified.push({ pane: pane.id, name, source: "bare-name-resolver", reason: "resolver returned a bare name with no source or strength; name-only bindings never verify a sender" });
			continue;
		}
		for (const binding of observed) {
			if (binding.strength !== "verified") {
				unverified.push({ pane: pane.id, name: binding.name, source: binding.source, reason: binding.reason ?? "binding is not qualified runtime evidence" });
				continue;
			}
			const seat = binding.seat !== undefined && binding.seat !== null && binding.seat !== "" ? binding.seat : pane.session;
			if (binding.seat !== undefined && binding.seat !== null && binding.seat !== "") seats.add(binding.seat);
			const ids = byName.get(binding.name) ?? [];
			ids.push(pane.id);
			byName.set(binding.name, ids);
			checkedPanes.add(pane.id);
			const rows = seatBindings.get(seat) ?? [];
			const project = binding.project ?? null;
			if (!rows.some((row) => row.project === project && row.name === binding.name && row.source === binding.source)) {
				rows.push({ project, name: binding.name, source: binding.source });
			}
			seatBindings.set(seat, rows);
			const known = nameToSeat.get(binding.name);
			if (known === undefined) nameToSeat.set(binding.name, seat);
			else if (known !== seat) ambiguousNames.add(binding.name);
		}
	}
	const liveSeats = new Set(seatBindings.keys());
	const reservations = deps.listReservations?.() ?? null;
	const classifyHolder = (holder: ReservationHolder, seat: string): SeatHolderAttribution => {
		const exclusive = holder.exclusive ?? false;
		let holderSeat = holder.seat ?? null;
		if (holderSeat === null || holderSeat === "") {
			if (ambiguousNames.has(holder.holder)) {
				return { holder: holder.holder, seat: null, custody: "unresolved", exclusive, reason: `holder ${holder.holder} is verified on multiple seats with no holder seat; seat-less attribution never verifies` };
			}
			holderSeat = nameToSeat.get(holder.holder) ?? null;
		}
		if (holderSeat === null || holderSeat === "") {
			return { holder: holder.holder, seat: null, custody: "unresolved", exclusive, reason: "holder resolves to no observed live-seat binding; invented peers never verify" };
		}
		if (!liveSeats.has(holderSeat)) {
			return { holder: holder.holder, seat: holderSeat, custody: "unresolved", exclusive, reason: `holder seat ${holderSeat} has no live pane in this readback` };
		}
		return { holder: holder.holder, seat: holderSeat, custody: holderSeat === seat ? "held-by-this-pane" : "peer", exclusive };
	};
	const seat_rows: SeatBindingRow[] = [...seatBindings.entries()]
		.map(([seat, bindings]) => ({
			seat,
			bindings: [...bindings].sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.name.localeCompare(b.name)),
			holders: (reservations ?? []).map((holder) => classifyHolder(holder, seat)),
		}))
		.sort((a, b) => a.seat.localeCompare(b.seat));
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
	const checked = checkedPanes.size;
	const unchecked = noFile.length + unverified.length;
	const status = shared.length ? "FAIL" : noFile.length || unverified.length || stale.length ? "DEGRADED" : "OK";
	return finding("identity", status,
		status === "OK" ? `Every live pane resolves to exactly one verified identity (${checked}/${panes.length} checked)` :
		shared.length ? `One identity resolves on multiple live panes: ${shared.map((row) => `${row.name} (${row.panes.join(", ")})`).join("; ")}` :
		`Pane identity gaps (${unchecked}/${panes.length} unchecked): ${noFile.length ? `${noFile.length} live pane(s) without an identity file` : ""}${(noFile.length && (unverified.length || stale.length)) ? "; " : ""}${unverified.length ? `${unverified.length} pane(s) with unverified bindings: ${unverified.map((row) => `${row.pane}->${row.name} (${row.reason})`).join("; ")}` : ""}${((noFile.length || unverified.length) && stale.length) ? "; " : ""}${stale.length ? `idle registration(s) with no live pane: ${stale.map((row) => row.name).join(", ")}` : ""}`,
		"Register each pane with native Agent Mail, then project its verified own-caller identity with agent-spawn-env.sh; resolve collisions before trusting writes.",
		{ project: deps.project ?? null, live_panes: panes.length, checked_panes: checked, unchecked_panes: unchecked, no_file_panes: noFile, shared, stale, unverified, seats: [...seats].sort(), seat_rows, reservations: reservations === null ? "unavailable" : reservations.length });
}

/** Attribute an acknowledgement to the exact acking-seat binding; UNKNOWN unless the seat carries that verified binding. */
export function attributeAckSender(seatRows: SeatBindingRow[], ack: IdentityAck): { sender: string | null; attribution: "verified" | "unknown"; reason: string } {
	const seat = ack.seat ?? null;
	if (seat === null || seat === "") {
		return { sender: null, attribution: "unknown", reason: "acknowledgement carries no seat; missing binding cannot yield verified attribution" };
	}
	const row = seatRows.find((candidate) => candidate.seat === seat) ?? null;
	if (row === null) {
		return { sender: null, attribution: "unknown", reason: `seat ${seat} has no live binding in this readback; stale seats never verify` };
	}
	if (row.bindings.length === 0) {
		return { sender: null, attribution: "unknown", reason: `seat ${seat} has no verified project/name binding` };
	}
	if (ack.name !== undefined && ack.name !== null && ack.name !== "") {
		const exact = row.bindings.find((binding) => binding.name === ack.name) ?? null;
		if (exact === null) {
			return { sender: null, attribution: "unknown", reason: `claimed sender ${ack.name} is not a verified binding of seat ${seat}; substituted names never verify` };
		}
		return { sender: exact.name, attribution: "verified", reason: `exact acking-seat binding ${exact.name} on seat ${seat}` };
	}
	const names = [...new Set(row.bindings.map((binding) => binding.name))].sort();
	if (names.length === 1) {
		return { sender: names[0], attribution: "verified", reason: `seat ${seat} carries exactly one verified name` };
	}
	return { sender: null, attribution: "unknown", reason: `seat ${seat} carries ${names.length} verified names with no exact acking-seat binding selected` };
}

const FLYWHEEL_STATUS: Record<Grade, DiagnosticStatus> = { A: "OK", B: "DEGRADED", C: "DEGRADED", D: "FAIL", F: "FAIL", "N/A": "UNVERIFIED" };

/** FLY2 (ompkit-8m75): seven fleet-practice grades from the tracker's beads.db and repo git. Read-only. */
export function inspectFlywheelScope(project: string): Finding[] {
	const dir = resolve(project);
	// Tracker database: the project's own .beads, else br's native BEADS_DB (git repo and tracker live in different checkouts in this fleet).
	const localDb = join(dir, ".beads", "beads.db");
	const envDb = process.env.BEADS_DB;
	const beadsDb = pathState(localDb) === "file" ? localDb : (typeof envDb === "string" && envDb && pathState(envDb) === "file" ? envDb : null);
	if (!beadsDb) {
		return [finding("flywheel", "UNVERIFIED", `No tracker database at ${localDb} and no usable BEADS_DB; flywheel grades were not computed`,
			"Pass the tracker checkout (the repo holding .beads/beads.db) as --project, or set BEADS_DB to its beads.db.", { project: dir })];
	}
	const run = (cmd: string[], env?: Record<string, string>) => {
		const [executable, ...args] = cmd;
		// An explicit env replaces the inherited one outright, so callers can
		// scrub redirecting variables (GIT_DIR) instead of overlaying them.
		const result = env
			? Bun.spawnSync([executable!, ...args], { stdout: "pipe", stderr: "pipe", env })
			: Bun.spawnSync([executable!, ...args], { stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode, stdout: result.stdout.toString() };
	};
	try {
		return scoreFlywheel({ repo: dir, beadsDb }, run).map(metric => finding("flywheel", FLYWHEEL_STATUS[metric.grade],
			`${metric.metric}: ${metric.display} — grade ${metric.grade} (${metric.threshold})`,
			metric.grade === "A" ? "None." : metric.grade === "N/A" ? "No sample in the window; widen the window or seed the practice, then rerun." : `Raise ${metric.metric}: ${metric.detail || metric.display}.`,
			{ metric: metric.metric, value: Number.isNaN(metric.value) ? "n/a" : metric.value, display: metric.display, threshold: metric.threshold, grade: metric.grade, detail: metric.detail }));
	} catch (error) {
		return [finding("flywheel", "UNVERIFIED", `Flywheel scoring failed: ${error instanceof Error ? error.message : String(error)}`,
			"Rerun with a reachable tracker database and git history.", { project: dir })];
	}
}

/** DERIVE1 B3 (ompkit-rc-epic-land-fix-release-dogfood-rz5.119): literal probe-readable facts in config files. Read-only. */
export function inspectDerivedScope(project: string): Finding[] {
	const dir = resolve(project);
	const hits: { file: string; line: number; kind: string; text: string; probe: string }[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			const relative = full.slice(dir.length + 1);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile() || !shouldScanFile(relative)) continue;
			try {
				const text = readFileSync(full, "utf8");
				hits.push(...scanDerivedText(relative, text));
			} catch {
				continue;
			}
		}
	}
	if (!hits.length) {
		return [finding("derived", "OK", "No literal probe-readable facts in config or registry files",
			"None.", { project: dir, files_with_hits: 0 })];
	}
	const byKind: Record<string, number> = {};
	const byFile: Record<string, true> = {};
	for (const hit of hits) {
		byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1;
		byFile[hit.file] = true;
	}
	return [finding("derived", "DEGRADED", `${hits.length} literal probe-readable fact(s) in config files`,
		"Move each fact to its probe (see evidence), or record a reason on the line to mark a decision.",
		{ project: dir, files_with_hits: Object.keys(byFile).length, by_kind: byKind, hits: hits.slice(0, 20) })];
}

/** PUB1f B2 (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.6): standard layout deviations. Read-only. */
export function inspectLayoutScope(project: string, kitRoot: string): Finding[] {
	const dir = resolve(project);
	const script = join(resolve(kitRoot), "scripts", "repo-layout-check.sh");
	let out = "";
	try {
		const result = Bun.spawnSync(["sh", script, dir], { stdout: "pipe", stderr: "pipe" });
		out = `${result.stdout.toString()}\n${result.stderr.toString()}`;
	} catch {
		return [finding("layout", "UNVERIFIED", "Layout checker could not run",
			"Rerun with a readable kit release and project.", { project: dir })];
	}
	const warns = out.split("\n").filter(line => line.includes("layout: WARN")).map(line => line.replace(/^.*layout: WARN /, ""));
	if (!warns.length) {
		return [finding("layout", "OK", "Standard repo layout holds (src, tests, scripts, docs, docs/adr; scratch ignored)",
			"None.", { project: dir })];
	}
	return [finding("layout", "DEGRADED", `${warns.length} layout deviation(s): ${warns.join("; ")}`,
		"Align the repo with docs/repo-layout.md, or opt in to strict for RED.",
		{ project: dir, deviations: warns })];
}

/** PUB1e B1 (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.5): standard public files. Read-only. */
export function inspectPublicFilesScope(project: string, kitRoot: string): Finding[] {
	const dir = resolve(project);
	const script = join(resolve(kitRoot), "scripts", "public-files-check.sh");
	let out = "";
	let code: number | null = null;
	try {
		const result = Bun.spawnSync(["sh", script, dir], { stdout: "pipe", stderr: "pipe" });
		code = result.exitCode;
		out = `${result.stdout.toString()}\n${result.stderr.toString()}`;
	} catch {
		return [finding("public-files", "UNVERIFIED", "Public files checker could not run",
			"Rerun with a readable kit release and project.", { project: dir })];
	}
	const missing = out.replace(/public-files:\s*(OK|MISSING)?/g, "").replace(/\([^)]*\)/g, "").split(/\s+/).map(part => part.trim()).filter(part => part.length > 0);
	if (code === 0) {
		return [finding("public-files", "OK", "Every standard public file is present",
			"None.", { project: dir })];
	}
	return [finding("public-files", "DEGRADED", `Missing standard public files: ${missing.join(", ")}`,
		"Add the listed files from the kit templates.",
		{ project: dir, missing })];
}
/** Read-only inventory: equality is evidence about bytes, never authority to overwrite or retire. */
type EffectiveRuleProbe = (profile: string, command: "ttsr" | "plugin") => unknown;
export interface EffectiveRulesInput { home: string; ompPath: string; kitVersion: string | null; ompVersion: string | null; rules: readonly string[]; always_rules?: readonly string[]; ruleSha256?: (ruleName: string) => string | null; profiles: readonly { name: string; issue?: string }[]; probe?: EffectiveRuleProbe }

function nativeProfileArgs(ompPath: string, profile: string, command: "ttsr" | "plugin"): readonly string[] {
	return [ompPath, ...(profile === "default" ? [] : ["--profile", profile]), command, "list", "--json"];
}

/** Config bytes copied per OMP state dir; OMP databases and stores stay behind. */
const PROBE_CONFIG_COPY_BYTES = 1024 * 1024;

/** Copy small non-database files so OMP resolves the profile; skip the rest. */
function copyProbeConfigs(fromDir: string, toDir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(fromDir);
	} catch {
		return;
	}
	mkdirSync(toDir, { recursive: true });
	for (const entry of entries) {
		if (entry === "." || entry === "..") continue;
		const source = join(fromDir, entry);
		let stat;
		try {
			stat = lstatSync(source);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		if (stat.size > PROBE_CONFIG_COPY_BYTES) continue;
		const lower = entry.toLowerCase();
		if (lower.endsWith(".db") || lower.endsWith(".db-wal") || lower.endsWith(".db-shm") || lower.endsWith(".db-journal")) continue;
		try {
			writeFileSync(join(toDir, entry), readFileSync(source));
		} catch {
			// Unreadable config reads as absent; the probe reports it.
		}
	}
}

/** Profile plugin scope: default resolves under ~/.omp, named profiles under ~/.omp/profiles/<name>. Both the probe copy and the link read below resolve through this so they can never disagree. */
export function pluginScopeSegments(profile: string): readonly string[] {
	return profile === "default" ? [".omp"] : [".omp", "profiles", profile];
}

/** Recreate a link tree (plugin node_modules): symlinks come back as symlinks so OMP resolves the same bytes; small files copy, directories recurse. */
function replicateLinkTree(fromDir: string, toDir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(fromDir);
	} catch {
		return;
	}
	mkdirSync(toDir, { recursive: true });
	for (const entry of entries) {
		if (entry === "." || entry === "..") continue;
		const source = join(fromDir, entry);
		const dest = join(toDir, entry);
		let stat;
		try {
			stat = lstatSync(source);
		} catch {
			continue;
		}
		try {
			lstatSync(dest);
			continue;
		} catch {
			// Absent: create below.
		}
		try {
			if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), dest);
			else if (stat.isFile()) {
				if (stat.size <= PROBE_CONFIG_COPY_BYTES) writeFileSync(dest, readFileSync(source));
			} else if (stat.isDirectory()) replicateLinkTree(source, dest);
		} catch {
			// Unreadable entry reads as absent; the probe reports it.
		}
	}
}

/** Copy one small file; missing, oversized or non-file sources stay absent. */
function copyProbeFile(source: string, dest: string): void {
	try {
		const stat = lstatSync(source);
		if (!stat.isFile() || stat.size > PROBE_CONFIG_COPY_BYTES) return;
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, readFileSync(source));
	} catch {
		// Unreadable file reads as absent; the probe reports it.
	}
}

/**
 * Isolated HOME for OMP probes. OMP initializes SQLite state (agent.db-wal
 * and agent.db-shm) under $HOME on startup, so probing with the inspected
 * HOME mutates it. The isolated copy carries the small config files OMP needs
 * to resolve the profile, plus the profile's plugin scope (lock files,
 * node_modules links, marketplaces) and its native overlay rules, so plugin
 * and rule paths resolve exactly as they do under the inspected HOME.
 * Without the scope's plugins tree the spawned OMP sees no plugin and every
 * kit rule reads missing. Database, cache, session and state subtrees stay
 * behind, and probes run only read-only list commands, so neither the
 * inspected HOME nor the linked releases are written. Cleanup removes the
 * whole tree; call it in a finally.
 */
export function isolatedProbeHome(home: string, profile: string): { home: string; cleanup: () => void } {
	// Owned: a killed probe used to leak omp-kit-probe-home-* (139 dirs, 11 GB).
	const owned = ownedTmp("omp-kit-probe-home");
	const root = owned.path;
	const tempHome = join(root, "home");
	copyProbeConfigs(join(home, ".omp", "agent"), join(tempHome, ".omp", "agent"));
	const agentDir = profile === "default" ? join(home, ".omp", "agent") : join(home, ".omp", "profiles", profile, "agent");
	const tempAgentDir = profile === "default" ? join(tempHome, ".omp", "agent") : join(tempHome, ".omp", "profiles", profile, "agent");
	if (profile !== "default") copyProbeConfigs(agentDir, tempAgentDir);
	const scope = pluginScopeSegments(profile);
	copyProbeConfigs(join(home, ...scope, "plugins"), join(tempHome, ...scope, "plugins"));
	replicateLinkTree(join(home, ...scope, "plugins", "node_modules"), join(tempHome, ...scope, "plugins", "node_modules"));
	copyProbeFile(join(home, ...scope, "marketplaces.json"), join(tempHome, ...scope, "marketplaces.json"));
	copyProbeConfigs(join(agentDir, "rules"), join(tempAgentDir, "rules"));
	return { home: tempHome, cleanup: () => {
		try {
			owned.cleanup();
		} catch {
			// Best effort; the exit/signal registry retries and the reaper reads .owner.
		}
	} };
}


/**
 * Rewrite isolated-HOME-rooted paths in probe output back to the inspected
 * HOME. The isolated tree mirrors the inspected one, so every path OMP
 * reports under it names the same file under the inspected HOME. Findings
 * therefore match a real-HOME run path for path. JSON round-trip keeps the
 * rewrite to plain strings; both probe commands already parse stdout as JSON.
 */
function rehomeProbeOutput(output: unknown, isolatedHome: string, home: string): unknown {
	if (isolatedHome === home) return output;
	return JSON.parse((JSON.stringify(output) ?? "null").split(isolatedHome).join(home));
}

function probeEnv(isolatedHome: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	env.HOME = isolatedHome;
	delete env.OMP_PROFILE; delete env.PI_PROFILE; delete env.PI_CODING_AGENT_DIR;
	return env;
}

function spawnProbeSync(ompPath: string, home: string, isolatedHome: string, profile: string, command: "ttsr" | "plugin"): unknown {
	const [executable, ...args] = nativeProfileArgs(ompPath, profile, command);
	const result = runSync([executable!, ...args], { deadline_s: 15, cwd: home, env: probeEnv(isolatedHome) });
	if (result.truncated) throw new Error(`${command} output exceeded the capture cap`);
	if (result.rc !== 0) throw new Error(`${command} exited ${result.rc ?? "unknown"}`);
	return JSON.parse(Buffer.from(result.stdout).toString("utf8"));
}

async function spawnProbeAsync(ompPath: string, home: string, isolatedHome: string, profile: string, command: "ttsr" | "plugin"): Promise<unknown> {
	const [executable, ...args] = nativeProfileArgs(ompPath, profile, command);
	const result = await run([executable!, ...args], { deadline_s: 15, cwd: home, env: probeEnv(isolatedHome) });
	if (result.truncated) throw new Error(`${command} output exceeded the capture cap`);
	if (result.rc !== 0) throw new Error(`${command} exited ${result.rc ?? "unknown"}`);
	return JSON.parse(Buffer.from(result.stdout).toString("utf8"));
}

export function runEffectiveRuleProbe(ompPath: string, home: string, profile: string, command: "ttsr" | "plugin"): unknown {
	const isolated = isolatedProbeHome(home, profile);
	try {
		return rehomeProbeOutput(spawnProbeSync(ompPath, home, isolated.home, profile, command), isolated.home, home);
	} finally {
		isolated.cleanup();
	}
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

/** Link-level activation of one plugin rule for one profile: ON only when the link resolves, its version matches the release, and the rule bytes match the manifest. */
export type PluginRuleActivation = "ON" | "STALE" | "MISSING" | "UNVERIFIED";
export interface PluginRuleStatus {
	status: PluginRuleActivation;
	profile: string;
	rule: string;
	link: string;
	target: string | null;
	version: string | null;
	expected_version: string | null;
	sha256: string | null;
	expected_sha256: string | null;
	reason: string;
}
export interface PluginRuleRelease {
	version: string | null;
	sha256: (rule: string) => string | null;
}
export function profilePluginRuleStatus(home: string, profile: string, rule: string, release: PluginRuleRelease): PluginRuleStatus {
	const link = join(home, ...pluginScopeSegments(profile), "plugins", "node_modules", "omp-kit-companion");
	const base = { profile, rule, link, target: null as string | null, version: null as string | null, expected_version: release.version, sha256: null as string | null, expected_sha256: null as string | null };
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule)) return { ...base, status: "UNVERIFIED", reason: `refused unsafe rule name: ${rule}` };
	try {
		const stat = lstatSync(link);
		if (!stat.isSymbolicLink() && !stat.isDirectory()) return { ...base, status: "UNVERIFIED", reason: "plugin path is neither a directory nor a symlink" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...base, status: "MISSING", reason: "plugin link is absent" };
		return { ...base, status: "UNVERIFIED", reason: `plugin link is unreadable: ${errorText(error)}` };
	}
	let target: string;
	try {
		target = realpathSync(link);
	} catch {
		return { ...base, status: "STALE", reason: "plugin symlink is broken" };
	}
	// Lock version first (a current link can pin a stale lock, STAMP1), then the linked package.
	let version: string | null = null;
	try {
		const lock: unknown = JSON.parse(readFileSync(join(home, ...pluginScopeSegments(profile), "plugins", "omp-plugins.lock.json"), "utf8"));
		const plugins = record(lock) ? (lock as Record<string, unknown>).plugins : undefined;
		const entry = record(plugins) ? (plugins as Record<string, unknown>)["omp-kit-companion"] : undefined;
		if (record(entry) && typeof entry.version === "string") version = entry.version;
	} catch {
		// Fall through to the linked package below.
	}
	if (version === null) {
		try {
			const pkg: unknown = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
			if (record(pkg) && typeof pkg.version === "string") version = pkg.version;
		} catch {
			// Version stays null: currency is unproven below.
		}
	}
	let sha: string | null = null;
	try {
		sha = digest(fileBytes(join(target, "rules", `${rule}.md`)));
	} catch {
		sha = null;
	}
	const expectedSha = release.sha256(rule);
	if (sha === null) return { ...base, target, version, expected_sha256: expectedSha, status: "MISSING", reason: "rule file is absent from the linked plugin" };
	if (version === null || release.version === null) return { ...base, target, version, sha256: sha, expected_sha256: expectedSha, status: "UNVERIFIED", reason: "plugin version is unreadable; link currency is unproven" };
	if (version !== release.version) return { ...base, target, version, sha256: sha, expected_sha256: expectedSha, status: "STALE", reason: `plugin version ${version} differs from release ${release.version}` };
	if (expectedSha === null || sha !== expectedSha) return { ...base, target, version, sha256: sha, expected_sha256: expectedSha, status: "STALE", reason: "linked rule bytes differ from the release manifest" };
	return { ...base, target, version, sha256: sha, expected_sha256: expectedSha, status: "ON", reason: "linked plugin version and rule bytes match the release" };
}

export function inspectEffectiveRules(input: EffectiveRulesInput): Finding {
	// The ttsr and plugin outputs of one profile are compared path-by-path, so both commands observe a single isolated HOME per profile. Separate homes diverge (different temp roots) and every kit rule reads absent.
	const sharedHomes = input.probe ? undefined : new Map<string, { home: string; cleanup: () => void }>();
	const probe = input.probe ?? ((profile, command) => {
		let isolated = sharedHomes?.get(profile);
		if (!isolated) {
			isolated = isolatedProbeHome(input.home, profile);
			sharedHomes?.set(profile, isolated);
		}
		return rehomeProbeOutput(spawnProbeSync(input.ompPath, input.home, isolated.home, profile, command), isolated.home, input.home);
	});
	const profileRows: Record<string, unknown>[] = [];
	let failed = false;
	try {
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
			const alwaysMissing = [...alwaysRules].filter(name => profilePluginRuleStatus(input.home, profile.name, name, { version: input.kitVersion, sha256: input.ruleSha256 ?? (() => null) }).status !== "ON");
			const versionMismatch = pluginRules.length > 0 && input.kitVersion !== null && pluginVersion !== input.kitVersion;
			const status = missing.length || legacy.length || versionMismatch || alwaysMissing.length || !pluginRules.length && !overlays.length ? "DEGRADED" : "OK";
			if (status !== "OK") failed = true;
			profileRows.push({ profile: profile.name, status, plugin_version: pluginVersion, expected_kit_version: input.kitVersion, ...(versionMismatch ? { versionMismatch: `${pluginVersion} vs ${input.kitVersion}` } : {}), omp_version: input.ompVersion, kit_rules: { plugin: pluginRules, overlays, legacy, missing, always_apply: { rules: [...alwaysRules], missing: alwaysMissing, method: "plugin-rules-dir" } }, extensions: kitPlugin?.extensions ?? kitPlugin?.extension_paths ?? [] });
		} catch (error) {
			failed = true;
			profileRows.push({ profile: profile.name, status: "UNVERIFIED", issue: errorText(error) });
		}
	}
	} finally {
		if (sharedHomes) for (const isolated of sharedHomes.values()) {
			try {
				isolated.cleanup();
			} catch {
				// Best effort; the exit/signal registry retries and the reaper reads .owner.
			}
		}
	}
	return finding("effective_rules", failed ? "DEGRADED" : "OK", failed ? "One or more OMP profiles do not load every kit rule from the matching plugin" : "Every covered OMP profile loads kit rules from the matching plugin or a declared native overlay", "Run omp-kit apply plugin --plan, then apply the approved per-profile plugin plan; legacy ~/.agents/rules copies are owned by migrate.", { profiles: profileRows, kit_version: input.kitVersion, omp_version: input.ompVersion, legacy_rules_not_considered_authority: true });
}
export async function inspectEffectiveRulesAsync(input: EffectiveRulesInput, concurrency = 6): Promise<Finding> {
	const started = performance.now();
	const outputs = new Map<string, { ttsr: unknown; plugin: unknown } | Error>();
	const sharedHomes = new Map<string, { home: string; cleanup: () => void }>();
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, input.profiles.length) }, async () => {
		while (cursor < input.profiles.length) {
			const profile = input.profiles[cursor++]!;
			if (profile.issue) continue;
			// One isolated HOME per profile: both commands must observe the same tree or their paths diverge.
			let isolated = sharedHomes.get(profile.name);
			if (!isolated) {
				isolated = isolatedProbeHome(input.home, profile.name);
				sharedHomes.set(profile.name, isolated);
			}
			try { const [ttsr, plugin] = await Promise.all([spawnProbeAsync(input.ompPath, input.home, isolated.home, profile.name, "ttsr"), spawnProbeAsync(input.ompPath, input.home, isolated.home, profile.name, "plugin")]); outputs.set(profile.name, { ttsr: rehomeProbeOutput(ttsr, isolated.home, input.home), plugin: rehomeProbeOutput(plugin, isolated.home, input.home) }); }
			catch (error) { outputs.set(profile.name, error instanceof Error ? error : new Error(String(error))); }
		}
	});
	try {
		await Promise.all(workers);
	} finally {
		for (const isolated of sharedHomes.values()) {
			try {
				isolated.cleanup();
			} catch {
				// Best effort; the exit/signal registry retries and the reaper reads .owner.
			}
		}
	}
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

function inspectBeadBreadth(project: string, kitRoot: string, home: string): Finding {
	const trackerPath = join(project, ".beads", "issues.jsonl");
	if (pathState(trackerPath) !== "file")
		return finding("bead_breadth", "UNVERIFIED", "Tracker issues export is missing or unsafe", "Run doctor --scope beads --project PATH on the tracker repository.", { tracker_path: trackerPath });
	let rows: unknown[];
	try {
		rows = [];
		for (const line of fileBytes(trackerPath).toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			rows.push(JSON.parse(line));
		}
	} catch {
		return finding("bead_breadth", "UNVERIFIED", "Tracker issues export cannot be read as JSONL", "Repair the read-only tracker export before measuring bead breadth.", { tracker_path: trackerPath });
	}
	let config: LoadedPlanningScoreConfig;
	try { config = loadPlanningScoreConfig(kitRoot, project, home); }
	catch (error) {
		return finding("bead_breadth", "UNVERIFIED", "Planning-score breadth limits are missing or invalid",
			"Restore valid bead breadth limits in config/planning-score.toml or the repository override.",
			{ tracker_path: trackerPath, config_error: error instanceof Error ? error.message : String(error) });
	}
	const maxFiles = config.tuning.targets.bead_breadth_max_files;
	const maxComponents = config.tuning.targets.bead_breadth_max_components;
	if (typeof maxFiles !== "number" || typeof maxComponents !== "number")
		return finding("bead_breadth", "UNVERIFIED", "Planning-score breadth limits are unavailable",
			"Restore valid bead breadth limits in config/planning-score.toml or the repository override.", { tracker_path: trackerPath });
	const beads: PlanningBead[] = [];
	let malformedRows = false;
	for (const row of rows) {
		if (record(row)) beads.push(row);
		else malformedRows = true;
	}
	const analysis = analyzeBeadBreadth(beads, { maxFiles, maxComponents });
	const oversizedIds: string[] = [];
	for (const bead of analysis.oversized_beads) oversizedIds.push(bead.id);
	const unknownIds = [...analysis.unknown_ids];
	if (malformedRows && !unknownIds.includes("UNKNOWN")) unknownIds.push("UNKNOWN");
	unknownIds.sort();
	const status = analysis.oversized_beads.length ? "FAIL" : unknownIds.length ? "UNVERIFIED" : "OK";
	const reason = analysis.oversized_beads.length ? "Active beads exceed the configured file or component breadth limits" :
		unknownIds.length ? "Some active beads lack parseable acceptance file evidence" : "No active bead exceeds the configured breadth limits";
	const recommendation = analysis.oversized_beads.length
		? "Split oversized beads into child beads grouped by the reported components; keep integration acceptance in the parent."
		: unknownIds.length ? "Add backtick-delimited repository-relative file paths to active acceptance criteria, or repair malformed tracker rows." : "No action required.";
	const evidence = {
		tracker_path: trackerPath, limits: { max_files: maxFiles, max_components: maxComponents }, active_beads: analysis.active_beads,
		checked_beads: analysis.checked_beads, oversized_ids: oversizedIds, oversized_beads: analysis.oversized_beads, unknown_ids: unknownIds,
	};
	return finding("bead_breadth", status, reason, recommendation, evidence);
}
/** DRAIN1 (ompkit-kdbz.1): stale in-progress claims from the tracker's beads.db. Read-only. */
function inspectDrainStaleClaims(project: string): Finding {
	const dir = resolve(project);
	const localDb = join(dir, ".beads", "beads.db");
	const envDb = process.env.BEADS_DB;
	const beadsDb = pathState(localDb) === "file" ? localDb : (typeof envDb === "string" && envDb && pathState(envDb) === "file" ? envDb : null);
	if (!beadsDb) {
		return finding("beads", "UNVERIFIED", "No tracker database at the project .beads and no usable BEADS_DB; stale claims were not checked",
			"Pass the tracker checkout (the repo holding .beads/beads.db) as --project, or set BEADS_DB to its beads.db.", { project: dir });
	}
	let rows;
	try {
		const store = readDrainStore(beadsDb);
		const now = Date.now();
		const sources = readLivenessSources(defaultLivenessProbe(), now);
		rows = staleClaims(store.issues, store.comments, now, holder => holderVerdict(holder, sources, now));
	} catch {
		return finding("beads", "UNVERIFIED", "Tracker database cannot be read; stale claims were not checked",
			"Repair read-only access to the tracker's beads.db, then rerun.", { project: dir });
	}
	return rows.length
		? finding("beads", "FAIL", `${rows.length} in-progress claim(s) untouched 24 h with no live holder (or holder liveness unreadable)`, "Reclaim each NO_HOLDER/DEAD row with its listed command; for UNKNOWN rows restore the named liveness source, then rerun.", { project: dir, stale_claims: rows })
		: finding("beads", "OK", "No stale in-progress claims", "No action required.", { project: dir, stale_claims: rows });
}

function inspectTmuxSockets(home: string): Finding {
	const uid = process.getuid?.();
	if (uid === undefined) return finding("tmux_sockets", "UNVERIFIED", "The current user ID is unavailable; tmux socket paths were not inspected", "Run doctor on macOS or Linux with a supported runtime.");
	const directory = join(home, ".tmux-sockets", "tmux-" + uid);
	const state = pathState(directory);
	if (state === "missing") return finding("tmux_sockets", "OK", "No per-user tmux socket directory exists", "No action required.", { socket_directory: directory, live_sockets: [], stale_sockets: [] });
	if (state !== "directory") return finding("tmux_sockets", "UNVERIFIED", "The per-user tmux socket path is not a readable directory", "Inspect the path without replacing it.", { socket_directory: directory });
	let names: string[];
	try { names = readdirSync(directory).sort(); }
	catch { return finding("tmux_sockets", "UNVERIFIED", "The per-user tmux socket directory could not be read", "Check directory permissions, then rerun omp-kit doctor.", { socket_directory: directory }); }
	const live: string[] = [];
	const stale: string[] = [];
	const uncertain: string[] = [];
	for (const name of names) {
		const socket = join(directory, name);
		let info: ReturnType<typeof lstatSync>;
		try { info = lstatSync(socket); }
		catch { uncertain.push(socket); continue; }
		if (info.isDirectory()) continue;
		if (!info.isSocket()) { stale.push(socket); continue; }
		try {
			const probe = spawnSync("tmux", ["-S", socket, "display-message", "-p", "-F", "#{socket_path}"], { encoding: "utf8", timeout: 2000 });
			if (probe.error) {
				if ((probe.error as NodeJS.ErrnoException).code === "ENOENT") return finding("tmux_sockets", "UNVERIFIED", "tmux is unavailable; socket liveness could not be checked", "Install tmux or put it on PATH, then rerun omp-kit doctor.", { socket_directory: directory, live_sockets: live, stale_sockets: stale, unverified_sockets: [...uncertain, socket] });
				uncertain.push(socket);
			} else if (probe.status === 0) live.push(socket);
			else if (probe.status !== null && String(probe.stderr ?? "").includes("no server running on")) stale.push(socket);
			else uncertain.push(socket);
		} catch { uncertain.push(socket); }
	}
	const status = stale.length ? "DEGRADED" : uncertain.length ? "UNVERIFIED" : "OK";
	const reason = stale.length ? "No live tmux server owns socket path(s): " + stale.join(", ") : uncertain.length ? "Could not determine tmux socket liveness for: " + uncertain.join(", ") : "No stale tmux socket paths were found";
	return finding("tmux_sockets", status, reason, stale.length ? "Confirm no tmux server uses the listed paths before removing stale socket entries." : uncertain.length ? "Resolve the inspection failure and rerun omp-kit doctor." : "No action required.", { socket_directory: directory, live_sockets: live, stale_sockets: stale, ...(uncertain.length ? { unverified_sockets: uncertain } : {}) });
}

/** RCHSOCK1 (ompkit-774u.6.4): rchd alive but its socket path unlinked. Read-only. */
export interface RchDaemonReport {
	running: boolean;
	/** The socket path the daemon itself reports, or null when unreported. */
	socketPath: string | null;
}

export interface RchReachabilityDeps {
	/** Login uid for the daemon lookup, or null when unavailable. */
	uid: number | null;
	/** Platform that selects the pid lookup and the restore advice. */
	platform: NodeJS.Platform;
	/** Parsed `rch --json daemon status`, or null when rch is missing/unrunnable/unparseable. */
	daemon(): RchDaemonReport | null;
	/** Live pid of the rch daemon (macOS: com.rch.daemon under launchd; elsewhere: the single rchd process of this uid), or null when none or ambiguous. */
	daemonPid(): number | null;
	/** Unix-socket paths the pid holds listening, or null when lsof is unavailable. */
	lsofUnixSockets(pid: number): string[] | null;
	/** lstat view of a path: socket with inode, non-socket, or missing. */
	statSocket(path: string): { kind: "socket" | "other" | "missing"; ino: number | null };
	/** Baseline of the socket inode from the last healthy read; absent without a state-backed store (legacy path-existence checks apply). */
	readSocketBaseline?: () => RchSocketBaseline | null;
	/** Persist the baseline after a healthy read; write failures never fail the finding. Absent beside a reader, the baseline is compared but never written. */
	recordSocketBaseline?: (baseline: RchSocketBaseline) => void;
	/** Clock for baseline timestamps; defaults to Date.now. */
	now?: () => number;
}

/** RCHSOCK1 follow-up (ompkit-774u.6.4): the daemon socket inode baseline.
 * `lsof` reports no inode for a unix socket, so a path replaced by a different
 * socket is invisible to path-existence checks. The doctor records the inode it
 * sees on a healthy (RUNNING) read and compares it on later reads. */
export interface RchSocketBaseline { path: string; ino: number; at: string }
export const RCH_SOCKET_BASELINE_FILE = "rch-socket-ino.json";
/** A baseline older than this is refreshed on the next healthy read, never failed. */
export const RCH_SOCKET_BASELINE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function rchSocketBaselinePath(stateRoot: string): string {
	return join(stateRoot, RCH_SOCKET_BASELINE_FILE);
}

export function readRchSocketBaseline(stateRoot: string): RchSocketBaseline | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(rchSocketBaselinePath(stateRoot), "utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record["path"] !== "string" || record["path"] === "" ||
		typeof record["ino"] !== "number" || !Number.isFinite(record["ino"]) ||
		typeof record["at"] !== "string" || Number.isNaN(Date.parse(record["at"]))) return null;
	return { path: record["path"], ino: record["ino"], at: record["at"] };
}

/** Persists the baseline into the private kit state root; false when the root is unsafe. Never throws and never fails the finding. */
export function writeRchSocketBaseline(stateRoot: string, baseline: RchSocketBaseline): boolean {
	try {
		mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}
	if (inspectStateRoot(stateRoot)) return false;
	try {
		for (const name of readdirSync(stateRoot)) {
			if (name.endsWith(".tmp")) { try { rmSync(join(stateRoot, name)); } catch { /* best effort */ } }
		}
	} catch { /* best effort: a stale crash orphan is never fatal */ }
	const path = rchSocketBaselinePath(stateRoot), temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(baseline)}\n`, { mode: 0o600 });
		renameSync(temp, path);
		return true;
	} catch {
		try {
			rmSync(temp, { force: true });
		} catch {
			/* best effort */
		}
		return false;
	}
}

/** File-backed baseline store for the live doctor path. */
export function rchSocketBaselineStore(stateRoot: string, clock: () => number = Date.now): Pick<RchReachabilityDeps, "readSocketBaseline" | "recordSocketBaseline" | "now"> {
	return {
		readSocketBaseline: () => readRchSocketBaseline(stateRoot),
		recordSocketBaseline: (baseline) => { writeRchSocketBaseline(stateRoot, baseline); },
		now: clock,
	};
}

type RchSocketView = { kind: "socket" | "other" | "missing"; ino: number | null };

function inspectRchSocketIno(input: { path: string; pid: number; bound: boolean; stat: RchSocketView; restore: string; baseline: RchSocketBaseline | null; record: ((baseline: RchSocketBaseline) => void) | undefined; now: () => number }): Finding {
	const base = { socket_path: input.path };
	const fresh = input.baseline !== null && input.baseline.path === input.path &&
		Number.isFinite(input.baseline.ino) && !Number.isNaN(Date.parse(input.baseline.at)) &&
		input.now() - Date.parse(input.baseline.at) <= RCH_SOCKET_BASELINE_MAX_AGE_MS;
	const baseline = fresh ? (input.baseline as RchSocketBaseline) : null;
	if (input.stat.kind !== "socket" || input.stat.ino === null) {
		if (baseline !== null) {
			return finding("rch", "FAIL", `rchd pid ${input.pid} is alive and held ${input.path} at baseline (ino ${baseline.ino}), but the path is now ${input.stat.kind === "missing" ? "missing: the socket was unlinked under the live daemon" : "not a socket: the socket was replaced under the live daemon"}`,
				input.restore, { ...base, state: "SOCKET_UNLINKED", pid: input.pid, expected_ino: baseline.ino });
		}
		if (input.stat.kind === "missing" && input.bound) {
			return finding("rch", "FAIL", `rchd pid ${input.pid} is alive and holds ${input.path}, but the path is missing: the socket was unlinked under the live daemon`,
				input.restore, { ...base, state: "SOCKET_UNLINKED", pid: input.pid });
		}
		return finding("rch", "FAIL", `rchd pid ${input.pid} is alive but ${input.path} is not its bound socket (path ${input.stat.kind}${input.bound ? "" : ", not held by the daemon"})`,
			input.restore, { ...base, state: "SOCKET_UNLINKED", pid: input.pid });
	}
	if (baseline !== null && input.stat.ino !== baseline.ino) {
		return finding("rch", "FAIL", `rchd pid ${input.pid} is alive and holds ${input.path}, but the socket inode changed (baseline ${baseline.ino}, now ${input.stat.ino}): the socket was replaced under the live daemon`,
			input.restore, { ...base, state: "SOCKET_UNLINKED", pid: input.pid, ino: input.stat.ino, expected_ino: baseline.ino });
	}
	if (!input.bound) {
		return finding("rch", "FAIL", `rchd pid ${input.pid} is alive but ${input.path} is not its bound socket (path socket, not held by the daemon)`,
			input.restore, { ...base, state: "SOCKET_UNLINKED", pid: input.pid, ino: input.stat.ino });
	}
	if (baseline === null) {
		if (!input.record) {
			return finding("rch", "OK", `rchd pid ${input.pid} is reachable on ${input.path}; no current socket inode baseline (omp-kit doctor records one)`,
				"No action required.", { ...base, state: "RUNNING", pid: input.pid, ino: input.stat.ino, baseline: "absent" });
		}
		input.record({ path: input.path, ino: input.stat.ino, at: new Date(input.now()).toISOString() });
		return finding("rch", "OK", `rchd pid ${input.pid} is reachable on ${input.path}; socket inode baseline just taken (ino ${input.stat.ino})`,
			"No action required.", { ...base, state: "RUNNING", pid: input.pid, ino: input.stat.ino, baseline: "recorded" });
	}
	return finding("rch", "OK", `rchd pid ${input.pid} is reachable on ${input.path}`, "No action required.", { ...base, state: "RUNNING", pid: input.pid, ino: input.stat.ino, baseline: "matched" });
}

export function inspectRchReachability(deps: RchReachabilityDeps): Finding {
	const report = deps.daemon();
	if (report === null) {
		return finding("rch", "UNVERIFIED", "rch is unavailable; daemon reachability was not inspected",
			"Install rch or put it on PATH, then rerun omp-kit doctor.", { state: "RCH_UNAVAILABLE" });
	}
	if (!report.running) {
		return finding("rch", "OK", "rchd reports it is not running; remote builds are unavailable until it starts",
			"No action required unless remote builds are needed.", { state: "NOT_RUNNING" });
	}
	const path = report.socketPath;
	if (path === null || path === "") {
		return finding("rch", "UNVERIFIED", "rchd reports running but names no socket path; reachability is unknown",
			"Inspect `rch --json daemon status` output, then rerun omp-kit doctor.", { state: "SOCKET_PATH_UNKNOWN" });
	}
	const base = { socket_path: path };
	const pid = deps.daemonPid();
	if (pid === null) {
		return finding("rch", "UNVERIFIED", `rchd reports running on ${path} but no single live rchd pid was found; reachability is unknown`,
			"Check that exactly one rchd runs for this user (macOS: com.rch.daemon in the login launchd domain), then rerun omp-kit doctor.", { ...base, state: "PID_UNKNOWN" });
	}
	const held = deps.lsofUnixSockets(pid);
	if (held === null) {
		return finding("rch", "UNVERIFIED", `rchd pid ${pid} is live but its held sockets could not be listed; reachability is unknown`,
			"Ensure lsof is available, then rerun omp-kit doctor.", { ...base, state: "LSOF_UNAVAILABLE", pid });
	}
	const bound = held.includes(path);
	const stat = deps.statSocket(path);
	const restore = rchRestoreAdvice(deps.platform, deps.uid);
	const readBaseline = deps.readSocketBaseline;
	if (readBaseline) {
		return inspectRchSocketIno({ path, pid, bound, stat, restore, baseline: readBaseline(), record: deps.recordSocketBaseline, now: deps.now ?? Date.now });
	}
	if (stat.kind === "missing" && bound) {
		return finding("rch", "FAIL", `rchd pid ${pid} is alive and holds ${path}, but the path is missing: the socket was unlinked under the live daemon`,
			restore, { ...base, state: "SOCKET_UNLINKED", pid });
	}
	if (stat.kind !== "socket" || !bound) {
		return finding("rch", "FAIL", `rchd pid ${pid} is alive but ${path} is not its bound socket (path ${stat.kind}${bound ? "" : ", not held by the daemon"})`,
			restore, { ...base, state: "SOCKET_UNLINKED", pid });
	}
	return finding("rch", "OK", `rchd pid ${pid} is reachable on ${path}`, "No action required.", { ...base, state: "RUNNING", pid });
}

/** The documented rchd restore (docs/rch-lease.md). Never automated by doctor: the kickstart drops in-flight jobs. */
function rchRestoreAdvice(platform: NodeJS.Platform, uid: number | null): string {
	return platform === "darwin"
		? `Restore with \`launchctl kickstart -k gui/${uid ?? "<uid>"}/com.rch.daemon\` only when \`rch status --jobs\` shows an empty queue; verify with \`rch status\` (Daemon Running, workers, slots). Never automate the kickstart from doctor.`
		: "Restart rchd under its service manager only when `rch status --jobs` shows an empty queue; verify with `rch status` (Daemon Running, workers, slots). Never automate the restart from doctor.";
}

/** The rch config directory as rch selects it: RCH_CONFIG_DIR, else the XDG dir, else the macOS native dir when only that exists. */
export function rchConfigDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
	const xdgConfig = join(env.XDG_CONFIG_HOME || join(home, ".config"), "rch");
	const nativeConfig = process.platform === "darwin" ? join(home, "Library", "Application Support", "com.rch.rch") : xdgConfig;
	const configured = env.RCH_CONFIG_DIR;
	if (configured) return configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
	return [xdgConfig, nativeConfig].find(path => {
		try { return statSync(path).isDirectory(); } catch { return false; }
	}) ?? xdgConfig;
}

/** ompkit-5vph: rch gc never covered ~/rch-build/rch-remote by default (84 GB reclaimable under critical worker disk, measured 2026-10-03). */
export const RCH_GC_EXTRA_ROOTS_KEY = "remediation.pooled_target.gc_extra_roots";
export type RchConfigRead = { path: string; text: string } | { path: string; text: null; reason: "missing" | "unreadable" };
export interface RchGcRootsDeps {
	/** Absolute home directory the expected root lives under. */
	home: string;
	/** The rch user config file (config.toml); injected so fixtures never touch the real one. */
	readConfig(): RchConfigRead;
}

export function inspectRchGcRoots(deps: RchGcRootsDeps): Finding {
	const root = join(deps.home, "rch-build", "rch-remote");
	const config = deps.readConfig();
	const base = { config_path: config.path, key: RCH_GC_EXTRA_ROOTS_KEY, expected_root: root };
	if (config.text === null && config.reason === "unreadable") {
		return finding("rch_gc_roots", "UNVERIFIED", `${config.path} could not be read; ${RCH_GC_EXTRA_ROOTS_KEY} was not checked`,
			`Make ${config.path} readable, then rerun omp-kit doctor.`, { ...base, state: "GC_ROOTS_UNVERIFIED" });
	}
	let listed: unknown = undefined;
	if (config.text !== null) {
		let parsed: unknown;
		try { parsed = Bun.TOML.parse(config.text); } catch {
			return finding("rch_gc_roots", "UNVERIFIED", `${config.path} is not valid TOML; ${RCH_GC_EXTRA_ROOTS_KEY} was not checked`,
				`Fix the TOML syntax in ${config.path}, then rerun omp-kit doctor.`, { ...base, state: "GC_ROOTS_UNVERIFIED" });
		}
		let node: unknown = parsed;
		for (const part of RCH_GC_EXTRA_ROOTS_KEY.split(".")) {
			node = typeof node === "object" && node !== null && !Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined;
		}
		listed = node;
	}
	if (listed !== undefined && !Array.isArray(listed)) {
		return finding("rch_gc_roots", "UNVERIFIED", `${RCH_GC_EXTRA_ROOTS_KEY} in ${config.path} is not an array of paths`,
			`Set it to an array, e.g. \`gc_extra_roots = ["${root}"]\` under [remediation.pooled_target], then rerun omp-kit doctor.`, { ...base, state: "GC_ROOTS_UNVERIFIED" });
	}
	const roots = (listed ?? []) as unknown[];
	const paths = roots.filter((entry): entry is string => typeof entry === "string");
	if (paths.some(entry => entry === root || entry === `${root}/`)) {
		return finding("rch_gc_roots", "OK", `${RCH_GC_EXTRA_ROOTS_KEY} lists ${root}`, "No action required.", { ...base, state: "GC_ROOTS_OK", listed_roots: paths });
	}
	const line = `gc_extra_roots = [${[...paths, root].map(entry => JSON.stringify(entry)).join(", ")}]`;
	const where = config.text === null ? `${config.path} does not exist, so rch gc uses its default roots` : listed === undefined ? `${RCH_GC_EXTRA_ROOTS_KEY} is not set in ${config.path}` : `${RCH_GC_EXTRA_ROOTS_KEY} in ${config.path} does not list ${root}`;
	return finding("rch_gc_roots", "DEGRADED", `${where}: rch gc never reclaims ${root}, so worker build overlays accumulate there`,
		`Add \`${line}\` under [remediation.pooled_target] in ${config.path} (absolute path, no \`~\`), then rerun omp-kit doctor. Doctor edits nothing.`,
		{ ...base, state: "GC_ROOTS_MISSING", listed_roots: paths });
}

/** ompkit-5vph: the daemon's per-worker view, from `rch --json status` (data.daemon.workers). */
export interface RchDaemonWorker {
	id: string;
	status: string;
	circuitState: string | null;
	consecutiveFailures: number | null;
	lastError: string | null;
	telemetryFresh: boolean | null;
	telemetryAgeSecs: number | null;
}
/** A direct connectivity probe of one worker, from `rch --json workers probe --all` (data.results). */
export interface RchProbeWorker { id: string; status: string; ok: boolean }
export interface RchWorkerHealthDeps {
	uid: number | null;
	platform: NodeJS.Platform;
	/** Daemon status view, or null when `rch status` is unavailable or unparseable. */
	daemonWorkers(): RchDaemonWorker[] | null;
	/** Direct probe of every worker, or null when unavailable. Called only when the daemon flags a worker, since a probe opens an ssh connection per worker. */
	probeWorkers(): RchProbeWorker[] | null;
}

/** Daemon statuses an operator chose; they are not health findings. */
const RCH_OPERATOR_WORKER_STATES: readonly string[] = ["healthy", "draining", "disabled"];

function rchDisagreementCause(worker: RchDaemonWorker): { cause: string; detail: string } {
	if (worker.telemetryFresh === false) {
		return { cause: "STALE_DAEMON_HEALTH", detail: `daemon health telemetry for ${worker.id} is stale${worker.telemetryAgeSecs === null ? "" : ` (${worker.telemetryAgeSecs}s old)`}; its ${worker.status} mark is not a current observation` };
	}
	if ((worker.circuitState !== null && worker.circuitState !== "closed") || (worker.consecutiveFailures ?? 0) > 0) {
		return { cause: "DAEMON_CIRCUIT_NOT_RECOVERED", detail: `daemon circuit for ${worker.id} is ${worker.circuitState ?? "unknown"} after ${worker.consecutiveFailures ?? 0} consecutive failure(s)${worker.lastError ? ` (last error: ${worker.lastError})` : ""} and has not re-tested the worker` };
	}
	return { cause: "DAEMON_HEALTH_UNEXPLAINED", detail: `daemon marks ${worker.id} ${worker.status} with fresh telemetry and a closed circuit; status output gives no cause` };
}

export function inspectRchWorkerHealth(deps: RchWorkerHealthDeps): Finding {
	const component = "rch_workers";
	const workers = deps.daemonWorkers();
	if (workers === null) {
		return finding(component, "UNVERIFIED", "`rch --json status` gave no worker list; worker health was not compared with a probe",
			"Run `rch status`, then rerun omp-kit doctor.", { state: "WORKER_STATUS_UNAVAILABLE" });
	}
	const flagged = workers.filter(worker => !RCH_OPERATOR_WORKER_STATES.includes(worker.status.toLowerCase()));
	const totals = { workers_total: workers.length, workers_healthy: workers.filter(worker => worker.status.toLowerCase() === "healthy").length };
	if (flagged.length === 0) {
		return finding(component, "OK", `daemon marks no worker degraded or unreachable (${totals.workers_healthy}/${totals.workers_total} healthy)`, "No action required.", { ...totals, state: "WORKERS_HEALTHY" });
	}
	const probes = deps.probeWorkers();
	if (probes === null) {
		return finding(component, "UNVERIFIED", `daemon marks ${flagged.map(worker => `${worker.id} ${worker.status}`).join(", ")} but a direct probe could not run`,
			"Run `rch workers probe --all --json` by hand to compare, then rerun omp-kit doctor.", { ...totals, state: "PROBE_UNAVAILABLE", daemon_flagged: flagged.map(worker => worker.id) });
	}
	const rows = flagged.map(worker => {
		const probe = probes.find(row => row.id === worker.id);
		return { worker, probe, verdict: probe === undefined ? "unprobed" : probe.ok ? "disagree" : "confirmed" } as const;
	});
	const disagree = rows.filter(row => row.verdict === "disagree");
	const evidence = rows.map(row => ({ id: row.worker.id, daemon_status: row.worker.status, probe_status: row.probe?.status ?? null, verdict: row.verdict }));
	if (disagree.length === 0) {
		const confirmed = rows.filter(row => row.verdict === "confirmed");
		return finding(component, confirmed.length ? "DEGRADED" : "UNVERIFIED",
			confirmed.length
				? `daemon and a direct probe agree: ${confirmed.map(row => `${row.worker.id} is ${row.worker.status} (probe ${row.probe?.status})`).join(", ")}`
				: `daemon marks ${flagged.map(worker => worker.id).join(", ")} ${flagged.length > 1 ? "unhealthy" : flagged[0]?.status} but the probe returned no row for them`,
			"Inspect the worker with `rch workers probe <id> --json` and fix it at the host; restarting rchd does not repair a worker.",
			{ ...totals, state: confirmed.length ? "WORKERS_UNHEALTHY_CONFIRMED" : "PROBE_INCOMPLETE", workers: evidence });
	}
	const causes = disagree.map(row => ({ id: row.worker.id, ...rchDisagreementCause(row.worker) }));
	const distinct = [...new Set(causes.map(row => row.cause))];
	const probeOk = probes.filter(row => row.ok).length;
	return finding(component, "DEGRADED",
		`daemon marks ${disagree.map(row => `${row.worker.id} ${row.worker.status}`).join(", ")} (${totals.workers_healthy}/${totals.workers_total} healthy) but a direct probe finds them healthy (${probeOk}/${probes.length} ok); cause ${distinct.join("+")}: ${causes.map(row => row.detail).join("; ")}`,
		`${rchRestoreAdvice(deps.platform, deps.uid)} Then rerun omp-kit doctor: the rch finding must be RUNNING (the socket exists) and this one OK. Use only this documented restart (docs/rch-lease.md), never \`rch daemon restart\`: it removed the socket on a real host (ompkit-5vph).`,
		{ ...totals, state: "DAEMON_PROBE_DISAGREE", cause: distinct.join("+"), probe_ok: probeOk, probe_total: probes.length, workers: evidence, causes });
}

function rchArgs(binary: string, args: readonly string[], timeoutMs: number): { code: number; out: string } | null {
	let privateRoot: string | undefined;
	try {
		let env: NodeJS.ProcessEnv = process.env;
		if (binary === "rch") {
			const home = process.env.HOME || homedir();
			const config = rchConfigDir(home, process.env);
			const cache = process.platform === "darwin" ? join(home, "Library", "Caches")
				: process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : join(home, ".cache");
			// RCH's default socket constructor creates its cache directory unless
			// XDG_RUNTIME_DIR is set. Pin the SAME read-only socket parent before
			// redirecting HOME/cache; config and RCH_SOCKET_PATH still override it.
			const runtime = process.env.XDG_RUNTIME_DIR?.trim() ? process.env.XDG_RUNTIME_DIR : join(cache, "rch");
			privateRoot = ownedTmp("omp-kit-rch-probe", { root: runtimeTempRoot() }).path;
			const privateHome = join(privateRoot, "home");
			const privateTmp = join(privateRoot, "tmp");
			for (const directory of ["home", "tmp", "config", "cache", "data", "state"]) mkdirSync(join(privateRoot, directory), { mode: 0o700 });
			env = {
				...env, HOME: privateHome, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp,
				XDG_CONFIG_HOME: join(privateRoot, "config"), XDG_CACHE_HOME: join(privateRoot, "cache"),
				XDG_DATA_HOME: join(privateRoot, "data"), XDG_STATE_HOME: join(privateRoot, "state"),
				RCH_CONFIG_DIR: config, XDG_RUNTIME_DIR: runtime,
			};
		}
		const run = Bun.spawnSync([binary, ...args], { stdout: "pipe", stderr: "ignore", env, timeout: timeoutMs });
		return { code: run.exitCode, out: run.stdout.toString() };
	} catch {
		return null;
	} finally {
		if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
	}
}

function parseRchStatus(out: string): RchDaemonReport | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return null;
	}
	const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["data"] : undefined;
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (typeof record["running"] !== "boolean") return null;
	const socketPath = record["socket_path"];
	return { running: record["running"], socketPath: typeof socketPath === "string" && socketPath !== "" ? socketPath : null };
}

type RchRun = (binary: string, args: readonly string[], timeoutMs: number) => { code: number; out: string } | null;

/** The one rchd process this uid owns, or null when there is none or several: an ambiguous match is never guessed. */
function singleRchdPid(uid: number | null, run: RchRun): number | null {
	if (uid === null) return null;
	const listed = run("pgrep", ["-u", String(uid), "-x", "rchd"], 5000);
	if (listed === null || listed.code !== 0) return null;
	const pids = listed.out.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
	return pids.length === 1 ? Number(pids[0]) : null;
}

export function defaultRchReachability(run: RchRun = rchArgs, platform: NodeJS.Platform = process.platform): RchReachabilityDeps {
	const uid = process.getuid?.() ?? null;
	return {
		uid,
		platform,
		daemon: () => {
			const status = run("rch", ["--json", "daemon", "status"], 5000);
			if (status === null || status.code !== 0) return null;
			return parseRchStatus(status.out);
		},
		daemonPid: () => {
			if (platform !== "darwin") return singleRchdPid(uid, run);
			if (uid === null) return null;
			const printed = run("launchctl", ["print", `gui/${uid}/com.rch.daemon`], 5000);
			if (printed === null || printed.code !== 0) return null;
			const match = printed.out.match(/\bpid\s*=\s*(\d+)/);
			return match?.[1] ? Number(match[1]) : null;
		},
		lsofUnixSockets: (pid) => {
			const listed = run("lsof", ["-a", "-p", String(pid), "-U", "-Fn"], 15000);
			if (listed === null || listed.code !== 0) return null;
			return listed.out.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
		},
		statSocket: (path) => {
			let info: Stats;
			try {
				info = lstatSync(path);
			} catch {
				return { kind: "missing", ino: null };
			}
			return info.isSocket() ? { kind: "socket", ino: info.ino } : { kind: "other", ino: null };
		},
	};
}

export function defaultRchGcRoots(home: string, env: NodeJS.ProcessEnv = process.env): RchGcRootsDeps {
	return {
		home,
		readConfig: () => {
			const path = join(rchConfigDir(home, env), "config.toml");
			try {
				return { path, text: readFileSync(path, "utf8") };
			} catch (error) {
				return { path, text: null, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
			}
		},
	};
}

function objectRows(value: unknown): Record<string, unknown>[] | null {
	return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row)) : null;
}

function parseRchJsonData(out: string): Record<string, unknown> | null {
	try {
		const data = (JSON.parse(out) as Record<string, unknown> | null)?.["data"];
		return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/** `rch --json status` -> data.daemon.workers; a worker row without a string id or status is unknown, so the whole view is. */
export function parseRchDaemonWorkers(out: string): RchDaemonWorker[] | null {
	const daemon = parseRchJsonData(out)?.["daemon"];
	const rows = objectRows(typeof daemon === "object" && daemon !== null ? (daemon as Record<string, unknown>)["workers"] : undefined);
	if (rows === null) return null;
	const workers: RchDaemonWorker[] = [];
	for (const row of rows) {
		if (typeof row["id"] !== "string" || typeof row["status"] !== "string") return null;
		const lastError = row["last_error"];
		workers.push({
			id: row["id"], status: row["status"],
			circuitState: typeof row["circuit_state"] === "string" ? row["circuit_state"] : null,
			consecutiveFailures: typeof row["consecutive_failures"] === "number" ? row["consecutive_failures"] : null,
			lastError: typeof lastError === "string" && lastError !== "" ? lastError : null,
			telemetryFresh: typeof row["pressure_telemetry_fresh"] === "boolean" ? row["pressure_telemetry_fresh"] : null,
			telemetryAgeSecs: typeof row["pressure_telemetry_age_secs"] === "number" ? row["pressure_telemetry_age_secs"] : null,
		});
	}
	return workers;
}

/** `rch --json workers probe --all` -> data.results; only the probe's own `ok` status counts as healthy. */
export function parseRchProbeWorkers(out: string): RchProbeWorker[] | null {
	const rows = objectRows(parseRchJsonData(out)?.["results"]);
	if (rows === null) return null;
	const probes: RchProbeWorker[] = [];
	for (const row of rows) {
		if (typeof row["id"] !== "string" || typeof row["status"] !== "string") return null;
		probes.push({ id: row["id"], status: row["status"], ok: row["status"] === "ok" });
	}
	return probes;
}

export function defaultRchWorkerHealth(uid: number | null, run: RchRun = rchArgs, platform: NodeJS.Platform = process.platform): RchWorkerHealthDeps {
	return {
		uid,
		platform,
		daemonWorkers: () => {
			const status = run("rch", ["--json", "status"], 15000);
			return status === null || status.code !== 0 ? null : parseRchDaemonWorkers(status.out);
		},
		probeWorkers: () => {
			// A probe that finds some workers down may exit nonzero yet still print every row; the rows decide, not the exit code.
			const probed = run("rch", ["--json", "workers", "probe", "--all"], 60000);
			return probed === null ? null : parseRchProbeWorkers(probed.out);
		},
	};
}

export async function diagnose(input: DiagnoseInput): Promise<Finding[]> {
	if (![input.root, input.home, ...(input.project ? [input.project] : []), ...(input.ompPath ? [input.ompPath] : []), ...(input.jsmPath ? [input.jsmPath] : [])].every(isAbsolute)) throw new Error("diagnostic paths must be absolute");
	const selected = input.scope ? DIAGNOSTIC_SCOPE_COMPONENTS[input.scope] ?? [input.scope] : undefined;
	const wants = (...components: string[]) => !selected || components.some(component => selected.includes(component));
	const rows: Finding[] = [];
	if (wants("omp", "effective_rules", "omp_drift")) rows.push(inspectOmp(input.ompPath, input.ompEnvironment ?? process.env, input.scope === "omp"));
	const root = resolve(input.root);
	const home = resolve(input.home);
	if (wants("tmux_sockets")) rows.push(inspectTmuxSockets(home));
	const scoped = Boolean(input.scope);
	const stateRoot = input.stateRoot ?? join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "omp-kit");
	if (wants("rch")) {
		// Only the doctor records the socket baseline (docs/rch-lease.md); status, repair plans and plain test compare against it without writing.
		const { recordSocketBaseline, ...baselineReader } = rchSocketBaselineStore(stateRoot);
		const rchDeps: RchReachabilityDeps = { ...defaultRchReachability(), ...baselineReader, ...(input.recordRchBaseline ? { recordSocketBaseline } : {}) };
		const rch = inspectRchReachability(rchDeps);
		// Fleet tools are judged only where they exist: an unscoped inventory omits an rch that is not installed, while an explicit rch scope still reports it.
		if (scoped || rch.evidence?.state !== "RCH_UNAVAILABLE") rows.push(rch);
		if (rch.evidence?.state !== "RCH_UNAVAILABLE") rows.push(inspectRchGcRoots(defaultRchGcRoots(home)));
		// Worker health is compared with a probe only through a reachable daemon: an unlinked socket is already reported above and makes the daemon's view unreadable.
		if (rch.evidence?.state === "RUNNING") rows.push(inspectRchWorkerHealth(defaultRchWorkerHealth(rchDeps.uid)));
	}
	// Unscoped, the planning skill is judged only when the user has a local copy to drift from; a scope names it explicitly.
	const planningShipped = pathState(join(root, "skills", "jeff-planning-enhanced", "SKILL.md")) === "file";
	const planningLocal = pathState(join(home, ".agents", "skills", "jeff-planning-enhanced", "SKILL.md")) !== "missing";
	if (wants("planning_skill") && (input.scope === "kit" || (planningShipped && (scoped || planningLocal)))) {
		rows.push(inspectPlanningSkill(root, home));
	}
	if (input.scope === "beads" && input.project) rows.push(inspectBeadAcceptance(resolve(input.project)));
	if (input.scope === "beads" && input.project) rows.push(inspectBeadDuplicates(resolve(input.project)));
	if (input.scope === "beads" && input.project) rows.push(inspectBeadBreadth(resolve(input.project), root, home));
	if (input.scope === "beads" && input.project) rows.push(inspectDrainStaleClaims(resolve(input.project)));
	if (input.scope === "identity" && input.project) rows.push(inspectPaneIdentity(defaultPaneIdentity(resolve(input.project))));
	if (input.scope === "flywheel" && input.project) rows.push(...inspectFlywheelScope(resolve(input.project)));
	if (input.scope === "derived" && input.project) rows.push(...inspectDerivedScope(resolve(input.project)));
	if (input.scope === "layout" && input.project) rows.push(...inspectLayoutScope(resolve(input.project), root));
	if (input.scope === "public-files" && input.project) rows.push(...inspectPublicFilesScope(resolve(input.project), root));
	if (input.scope === "test-scope") rows.push(inspectTestScope());
	if (input.scope === "gates") rows.push(await inspectGatePlane({ root, home }));
	if (wants("actions-billing") && input.actionsBilling) rows.push(inspectActionsBilling(input.actionsBilling));
	const manifest = wants("kit", "manifest", "installed_rules", "effective_rules", "retired_rules", "unknown_rules", "project_rules") ? readManifest(root) : undefined;
	if (manifest) {
	rows.push(finding("kit", manifest.error ? "FAIL" : manifest.sourceUnverified ? "UNVERIFIED" : "OK", manifest.error ? "Release rule inventory cannot be verified" : manifest.sourceUnverified ? "Shipped bytes match an uncommitted source pack; release provenance is unverified" : "Release rule inventory is readable", manifest.error || manifest.sourceUnverified ? "Use an intact, verified omp-kit release." : "No action required.", { release_root: root, source_proof: manifest.sourceUnverified ? "SOURCE_UNVERIFIED" : manifest.error ? "INVALID" : "MANIFEST_HASHES" }));
	rows.push(finding("manifest", manifest.error ? "FAIL" : manifest.sourceUnverified ? "UNVERIFIED" : "OK", manifest.error ?? (manifest.sourceUnverified ? "Shipped rule hashes match but pack is uncommitted" : "All manifest entries match shipped rule bytes"), manifest.error || manifest.sourceUnverified ? "Replace or repair the release before relying on its provenance." : "No action required.", { rule_count: manifest.rules.length, source_proof: manifest.sourceUnverified ? "SOURCE_UNVERIFIED" : manifest.error ? "INVALID" : "MANIFEST_HASHES" }));
	if (manifest.error) {
		rows.push(finding("installed_rules", "UNVERIFIED", "Source manifest is invalid; no installed hashes can be certified", "Replace the release, then run omp-kit apply rules --plan."));
		rows.push(finding("retired_rules", "UNVERIFIED", "Source manifest is invalid", "Replace the release before assessing retirement."));
		rows.push(finding("unknown_rules", "UNVERIFIED", "Source manifest is invalid", "Replace the release before assessing extras."));
		rows.push(finding("project_rules", "UNVERIFIED", "Source manifest is invalid", "Replace the release before assessing project shadows."));
	} else if (wants("installed_rules", "retired_rules", "unknown_rules", "project_rules")) {
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
	} // Manifest-dependent inventory.
	const profiles = wants("effective_rules", "effective_profile", "policy", "extensions") ? inspectProfiles(home) : undefined;
	if (wants("plugin_links")) rows.push(inspectPluginLinks(root, home));
	// FLEETUPG1: only on an explicit scope, since it asks GitHub for the latest release.
	if (input.scope === "plugin_release") rows.push(inspectPluginRelease(livePluginReleaseIo(home)));
	// HOOKREFRESH1: per-repo hook members vs the active release; explicit scope
	// only (like plugin_release): it reads every fleet repo and stays out of
	// the unscoped inventory.
	if (input.scope === "hooks") rows.push(...inspectHooks(liveHookFreshnessIo(home, root)));
	if (wants("effective_rules") && input.inventoryOnly && !input.scope) {
		rows.push(finding("effective_rules", "NOT_RUN", "Presence inventory did not probe runtime rule activation", "Run omp-kit doctor --scope rules --json for live per-profile rule evidence."));
	} else if (wants("effective_rules") && input.ompPath && manifest && profiles) {
	const effectiveOmpEvidence = rows.find(row => row.component === "omp")?.evidence;
	let kitVersion: string | null = null;
	try {
		const packageValue = JSON.parse(fileBytes(join(root, "package.json")).toString("utf8"));
		kitVersion = record(packageValue) && typeof packageValue.version === "string" ? packageValue.version : null;
	} catch {}
const alwaysRules = manifest.rules.filter(rule => { try { return /^alwaysApply:\s*true/m.test(fileBytes(join(root, "rules", `${rule.name}.md`)).toString("utf8")); } catch { return false; } }).map(rule => rule.name);
const ruleSha256 = new Map(manifest.rules.map(rule => [rule.name, rule.sha256] as const));
	const effectiveRules = !manifest.error
		? await inspectEffectiveRulesAsync({ home, ompPath: input.ompPath, kitVersion, ompVersion: typeof effectiveOmpEvidence?.version === "string" ? effectiveOmpEvidence.version : null, rules: manifest.rules.map(rule => rule.name), always_rules: alwaysRules, ruleSha256: (name) => ruleSha256.get(name) ?? null, profiles: profiles.profiles })
			: finding("effective_rules", "UNVERIFIED", "Native OMP identity or release manifest is unavailable; effective per-profile rules were not inspected", "Install OMP and rerun omp-kit doctor --scope rules.");
		rows.push(effectiveRules);
	}
	const project = input.project && resolve(input.project);
	const projectConfig = wants("policy", "extensions") ? inspectProjectConfig(project) : undefined;
	if (wants("policy") && profiles && projectConfig) rows.push(inspectPolicy(root, home, profiles.profiles, projectConfig, profiles.issue, project));
	if (wants("extensions") && profiles && projectConfig) rows.push(inspectExtensions(root, home, profiles.profiles, projectConfig, profiles.issue));
	if (wants("extension_imports")) rows.push(inspectExtensionImports(home));
	if (wants("router")) rows.push(inspectRouter(input.jsmPath));
	if (wants("agent_mail_guard")) rows.push(inspectAgentMailGuard());
	if (wants("state_root")) {
	const stateIssue = inspectStateRoot(stateRoot);
	rows.push(stateIssue === null
		? finding("state_root", "OK", "Private state root is absent or a private directory you own", "None.")
		: finding("state_root", stateIssue.problem === "MODE" ? "DEGRADED" : "FAIL",
			`Private state root has ${stateIssue.problem === "MODE" ? `mode ${stateIssue.mode}` : stateIssue.problem.toLowerCase()}; receipts, audit, undo and update refuse until it is a 0700 directory you own`,
			stateIssue.problem === "MODE" ? "Run omp-kit repair --scope state --plan, then --apply --yes." : "Make it a real directory you own with mode 0700, or move it aside.",
			{ path: stateRoot, problem: stateIssue.problem, mode: stateIssue.mode }));
	}
	// OMP moves under the kit (operator updaters run every few hours): compare against the last recorded test.
	if (wants("omp_drift")) {
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
	}
	if (wants("effective_profile") && profiles) {
	const backupScope = [join(home, ".omp", "settings.json"),
		...profiles.profiles.flatMap((profile) => [...CONFIG_NAMES, "agent.db"].map((name) => join(profile.dir, name)))];
	if (input.project) backupScope.push(join(input.project, ".omp", "config.yml"), join(input.project, ".omp", "settings.json"), join(input.project, ".claude", "settings.json"));
	rows.push(finding("effective_profile", "UNVERIFIED", "On-disk settings cannot prove OMP effective values, runtime overlays or activation",
		"Inspect effective values with OMP itself: omp config list (named profiles: omp --profile NAME config list). Back up the files listed in evidence.backup_scope before changing any of them.",
		{ profiles: profiles.profiles.map((profile) => profile.name), backup_scope: backupScope, ...(profiles.issue ? { inventory_issue: profiles.issue } : {}) }));
	}
	if (wants("matcher")) rows.push(finding("matcher", "NOT_RUN", "Matcher was not exercised by the inventory", "Run omp-kit test for matcher evidence."));
	return rows.filter(row => wants(row.component) || row.component === "omp").sort((a, b) => a.component.localeCompare(b.component));
}

/** Strict precedence never promotes an unperformed or uncertain probe to OK. */
export function health(findings: readonly Finding[]): "OK" | "DEGRADED" | "UNVERIFIED" | "FAIL" {
	if (findings.some((item) => item.status === "FAIL")) return "FAIL";
	if (findings.some((item) => item.status === "UNVERIFIED" || item.status === "NOT_RUN")) return "UNVERIFIED";
	if (findings.some((item) => item.status === "DEGRADED" || item.status === "DRIFT")) return "DEGRADED";
	return findings.length ? "OK" : "UNVERIFIED";
}
