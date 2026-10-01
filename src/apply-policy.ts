import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Finding } from "./diagnostics.ts";
import { ensureMutationStateRoot, fsyncDirectory, inspectPendingMutations, writePrivate, type Image } from "./mutations.ts";
import { resolveOmpIdentity } from "./paths.ts";
import { runtimeTempRoot } from "./runtime.ts";

export type PolicyInput = Readonly<{ root: string; home: string; ompPath?: string; stateRoot?: string; project?: string; profiles?: "all" | readonly string[]; includeDefault?: boolean; profileConfigHome?: string }>;
export type PolicyStep = Readonly<{ profile: string; path: string; key: PolicyKey; command: string; beforeSha256: string | null; beforeMode: number | null; beforeValue: PolicyValue; value: PolicyValue }>;
export type PolicyPlan = Readonly<{ scope: "policy"; profiles: readonly string[]; steps: readonly PolicyStep[]; blockedProfiles: readonly Readonly<{ profile: string; names: readonly string[] }>[] }>;
export type PolicyReceipt = Readonly<{ status: "APPLIED" | "UNCHANGED"; backupId: string | null; files: number; keys: number }>;

type FileImage = { bytes: Buffer; image: Image };
type PolicyConfig = { name: string; directory: string; path: string; file: FileImage | null; issue?: string };
const profileName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ruleName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const configNames = ["config.yml", "config.yaml", "config.json", "settings.json"];
const policyKeys = ["enabled", "repeatMode", "repeatGap", "contextMode", "disabledRules"] as const;
type PolicyKey = typeof policyKeys[number];
type PolicyValue = boolean | string | number | string[];
type PolicySettings = Readonly<Record<PolicyKey, PolicyValue>>;
type Prepared = { input: PolicyInput; signature: string; profiles: readonly PolicyConfig[] };
const privatePlans = new WeakMap<PolicyPlan, Prepared>();
const nativePolicyKeys: Record<PolicyKey, `ttsr.${PolicyKey}`> = {
	enabled: "ttsr.enabled", repeatMode: "ttsr.repeatMode", repeatGap: "ttsr.repeatGap",
	contextMode: "ttsr.contextMode", disabledRules: "ttsr.disabledRules",
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code: string, paths?: readonly string[]): never {
	throw new Error(paths?.length ? `${code}: ${paths.join(", ")}` : code);
}
function absolute(path: string): string {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) fail("UNSAFE_PATH");
	return path;
}
function safeDirectory(path: string, allowMissing = false): boolean {
	const parts: string[] = [];
	for (let cursor = absolute(path); cursor !== resolve(cursor, ".."); cursor = resolve(cursor, "..")) parts.unshift(cursor);
	for (const part of parts) {
		let info: Stats;
		try { info = lstatSync(part); }
		catch (error) {
			if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
			fail("UNSAFE_PATH");
		}
		if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH");
	}
	return true;
}
function optionalFile(path: string): FileImage | null {
	if (!safeDirectory(resolve(path, ".."), true)) return null;
	let before: Stats;
	try { before = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		fail("UNSAFE_PATH");
	}
	if (!before.isFile() || before.isSymbolicLink()) fail("UNSAFE_PATH");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) fail("FRESH_PLAN");
		const bytes = readFileSync(fd), after = fstatSync(fd);
		if (after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail("FRESH_PLAN");
		return { bytes, image: { sha256: hash(bytes), size: bytes.length, mode: info.mode & 0o7777, uid: info.uid, gid: info.gid } };
	} finally { closeSync(fd); }
}
function requirePolicy(root: string): { value: PolicySettings; digest: string } {
	const source = optionalFile(join(root, "policy", "ttsr.json"));
	if (!source) fail("INVALID_POLICY");
	let value: unknown;
	try { value = JSON.parse(source.bytes.toString("utf8")); } catch { fail("INVALID_POLICY"); }
	if (!record(value) || Object.keys(value).sort().join(",") !== [...policyKeys].sort().join(",") ||
		typeof value.enabled !== "boolean" || !["once", "after-gap"].includes(String(value.repeatMode)) ||
		typeof value.repeatGap !== "number" || !Number.isFinite(value.repeatGap) || value.repeatGap < 0 ||
		!["discard", "keep"].includes(String(value.contextMode)) || !Array.isArray(value.disabledRules) ||
		!value.disabledRules.every((name: unknown) => typeof name === "string" && ruleName.test(name))) fail("INVALID_POLICY");
	return { value: value as PolicySettings, digest: source.image.sha256 };
}
function operatorProfileList(home: string, configHomeValue?: string): string[] | null {
	const configHome = configHomeValue ?? join(home, ".config");
	if (!isAbsolute(configHome) || resolve(configHome) !== configHome) fail("PROFILE_LIST_UNVERIFIED");
	let source: FileImage | null;
	try { source = optionalFile(join(configHome, "omp-kit", "ttsr-profiles.json")); }
	catch { fail("PROFILE_LIST_UNVERIFIED"); }
	if (!source) return null;
	let value: unknown;
	try { value = JSON.parse(source.bytes.toString("utf8")); }
	catch { fail("PROFILE_LIST_UNVERIFIED"); }
	if (!Array.isArray(value) || !value.length ||
		value.some((name: unknown) => typeof name !== "string" || (name !== "default" && (!profileName.test(name) || name.endsWith(".")))) ||
		new Set(value).size !== value.length) fail("PROFILE_LIST_UNVERIFIED");
	return value as string[];
}

function selectedProfiles(input: PolicyInput, allowMissing = false): PolicyConfig[] {
	const home = input.home, namedDir = join(home, ".omp", "profiles"), defaultDir = join(home, ".omp", "agent");
	const candidates: { name: string; directory: string; issue?: string }[] = [{ name: "default", directory: defaultDir }];
	let namedProfilesAvailable = false;
	try { namedProfilesAvailable = safeDirectory(namedDir, true); } catch { fail("PROFILE_INVENTORY_UNVERIFIED"); }
	if (namedProfilesAvailable) for (const name of readdirSync(namedDir).sort()) {
		if (!profileName.test(name) || name === "default" || name.endsWith(".")) fail("UNRECOGNIZED_PROFILE");
		const directory = join(namedDir, name, "agent");
		let available = false, unsafe = false;
		try { available = safeDirectory(directory, true); } catch { unsafe = true; }
		candidates.push({ name, directory, ...(!available ? { issue: unsafe ? "PROFILE_AGENT_DIRECTORY_UNAVAILABLE" : "PROFILE_AGENT_DIRECTORY_MISSING" } : {}) });
	}
	const requested = input.profiles ?? operatorProfileList(home, input.profileConfigHome) ?? "all";
	let names: Set<string>;
	if (requested === "all") {
		names = new Set(candidates.length === 1 || input.includeDefault ? candidates.map(candidate => candidate.name) : candidates.slice(1).map(candidate => candidate.name));
	} else {
		if (!Array.isArray(requested) || !requested.length || requested.some(name => name !== "default" && (!profileName.test(name) || name.endsWith(".")))) fail("INVALID_PROFILE_SELECTION");
		names = new Set(requested);
		if (input.includeDefault) names.add("default");
		const missing = [...names].filter(name => !candidates.some(candidate => candidate.name === name));
		if (missing.length && !allowMissing) fail("MISSING_PROFILE");
		for (const name of missing) candidates.push({ name, directory: name === "default" ? defaultDir : join(namedDir, name, "agent"), issue: "PROFILE_NOT_FOUND" });
	}
	return candidates.filter(candidate => names.has(candidate.name)).map(candidate => {
		if (candidate.issue) return { ...candidate, path: join(candidate.directory, "config.yml"), file: null };
		let available = false, unsafe = false;
		try { available = safeDirectory(candidate.directory, true); } catch { unsafe = true; }
		if (!available) return { ...candidate, path: join(candidate.directory, "config.yml"), file: null,
			...(candidate.name !== "default" || unsafe ? { issue: "PROFILE_AGENT_DIRECTORY_UNAVAILABLE" } : {}) };
		let present: { name: string; file: FileImage }[];
		try { present = configNames.flatMap(name => { const file = optionalFile(join(candidate.directory, name)); return file ? [{ name, file }] : []; }); }
		catch { return { ...candidate, path: join(candidate.directory, "config.yml"), file: null, issue: "PROFILE_CONFIG_UNREADABLE" }; }
		if (present.length > 1 || present.some(entry => entry.name !== "config.yml"))
			return { ...candidate, path: join(candidate.directory, "config.yml"), file: null, issue: "UNRECOGNIZED_PROFILE_CONFIG" };
		const config = present[0];
		return { ...candidate, path: join(candidate.directory, config?.name ?? "config.yml"), file: config?.file ?? null };
	});
}

type NativePolicyRead = { profile: string; status: "OK" | "UNVERIFIED"; values?: Partial<PolicySettings>; issue?: string };
type NativeConfigResult = { exitCode: number | null; stdout: string; stderr: string };
function validPolicyValue(key: PolicyKey, value: unknown): value is PolicyValue {
	switch (key) {
		case "enabled": return typeof value === "boolean";
		case "repeatMode": return value === "once" || value === "after-gap";
		case "repeatGap": return typeof value === "number" && Number.isFinite(value) && value >= 0;
		case "contextMode": return value === "discard" || value === "keep";
		case "disabledRules": return Array.isArray(value) && value.every((name: unknown) => typeof name === "string" && ruleName.test(name));
	}
}
function encodePolicyValue(value: PolicyValue): string {
	if (Array.isArray(value)) return JSON.stringify(value);
	return String(value);
}
function policyCommand(profile: string, key: PolicyKey, value: PolicyValue): string {
	const args = ["omp", ...(profile === "default" ? [] : ["--profile", profile]), "config", "set", nativePolicyKeys[key], encodePolicyValue(value)];
	return args.map(value => /^[a-zA-Z0-9._:/-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'").join(" ");
}
function policyOmpPath(requested?: string): string {
	const selected = resolveOmpIdentity(process.env).launcher;
	if (requested !== undefined && requested !== selected) fail("OMP_IDENTITY_MISMATCH");
	return selected;
}
function nativeEnvironment(home: string, scratch?: string): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, NO_COLOR: "1", TERM: "dumb" };
	for (const key of ["LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "CI"]) { const value = process.env[key]; if (value !== undefined) env[key] = value; }
	if (scratch) {
		env.TMPDIR = join(scratch, "tmp"); env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR;
		env.XDG_CONFIG_HOME = join(scratch, "xdg-config"); env.XDG_CACHE_HOME = join(scratch, "xdg-cache");
		env.XDG_DATA_HOME = join(scratch, "xdg-data"); env.XDG_STATE_HOME = join(scratch, "xdg-state");
		env.BUN_INSTALL = join(scratch, "bun-install");
	} else {
		for (const key of ["TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BUN_INSTALL"]) {
			const value = process.env[key]; if (value !== undefined) env[key] = value;
		}
	}
	env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
	return env;
}
function runNativeConfig(ompPath: string, home: string, profile: string, action: "get" | "set", key: PolicyKey, value?: string, scratch?: string): NativeConfigResult {
	const args = [ompPath, ...(profile === "default" ? [] : ["--profile", profile]), "config", action, nativePolicyKeys[key], ...(value === undefined ? [] : [value]), "--json"];
	try {
		const result = Bun.spawnSync(args, { cwd: scratch ? join(scratch, "project") : home, env: nativeEnvironment(home, scratch), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	} catch { return { exitCode: null, stdout: "", stderr: "" }; }
}
function readNativeValue(result: NativeConfigResult, key: PolicyKey): { value?: PolicyValue; issue?: string } {
	if (result.exitCode !== 0 || result.stderr.trim() || result.stdout.length > 64 * 1024) return { issue: "NATIVE_CONFIG_UNAVAILABLE" };
	let parsed: unknown;
	try { parsed = JSON.parse(result.stdout); } catch { return { issue: "NATIVE_CONFIG_RESULT_INVALID" }; }
	if (!record(parsed) || parsed.key !== nativePolicyKeys[key] || !Object.hasOwn(parsed, "value") || !validPolicyValue(key, parsed.value))
		return { issue: "NATIVE_CONFIG_RESULT_INVALID" };
	return { value: parsed.value };
}
function sameFileImage(left: FileImage | null, right: FileImage | null): boolean {
	if (!left || !right) return left === right;
	return left.image.sha256 === right.image.sha256 && left.image.size === right.image.size && left.image.mode === right.image.mode &&
		left.image.uid === right.image.uid && left.image.gid === right.image.gid;
}
function sameFileContents(left: FileImage | null, right: FileImage | null): boolean {
	if (!left || !right) return left === right;
	return left.image.sha256 === right.image.sha256 && left.image.size === right.image.size;
}
function nativePolicyRead(ompPath: string, home: string, profiles: readonly PolicyConfig[]): NativePolicyRead[] {
	const scratch = mkdtempSync(join(runtimeTempRoot(), "omp-kit-ttsr-read-"));
	try {
		const scratchInfo = lstatSync(scratch);
		if (!scratchInfo.isDirectory() || scratchInfo.isSymbolicLink() || scratchInfo.uid !== process.getuid?.() || (scratchInfo.mode & 0o077) !== 0)
			return profiles.map(profile => ({ profile: profile.name, status: "UNVERIFIED", issue: "PRIVATE_WORKSPACE_UNSAFE" }));
		const cloneHome = join(scratch, "home"), project = join(scratch, "project");
		for (const path of [cloneHome, project, ...["tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "bun-install"].map(name => join(scratch, name))])
			mkdirSync(path, { recursive: true, mode: 0o700 });
		const clonePaths = new Map<string, string>();
		for (const profile of profiles) {
			if (profile.issue) continue;
			const rel = relative(home, profile.path);
			if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { clonePaths.set(profile.name, ""); continue; }
			const clonePath = join(cloneHome, rel); clonePaths.set(profile.name, clonePath);
			if (profile.file) { mkdirSync(dirname(clonePath), { recursive: true, mode: 0o700 }); writeFileSync(clonePath, profile.file.bytes, { flag: "wx", mode: 0o600 }); }
		}
		return profiles.map(profile => {
			if (profile.issue || clonePaths.get(profile.name) === "") return { profile: profile.name, status: "UNVERIFIED", issue: profile.issue ?? "PROFILE_PATH_UNSAFE" };
			const values: Partial<Record<PolicyKey, PolicyValue>> = {};
			for (const key of policyKeys) {
				const read = readNativeValue(runNativeConfig(ompPath, cloneHome, profile.name, "get", key, undefined, scratch), key);
				if (read.value !== undefined) values[key] = read.value;
				else return { profile: profile.name, status: "UNVERIFIED", values, issue: read.issue };
			}
			const clonePath = clonePaths.get(profile.name)!;
			const cloned = optionalFile(clonePath);
			if (!sameFileContents(cloned, profile.file)) return { profile: profile.name, status: "UNVERIFIED", values, issue: "NATIVE_CONFIG_READ_CHANGED_CLONE" };
			if (!sameFileImage(optionalFile(profile.path), profile.file)) return { profile: profile.name, status: "UNVERIFIED", values, issue: "PROFILE_CHANGED_DURING_READ" };
			return { profile: profile.name, status: "OK", values: values as PolicySettings };
		});
	} catch { return profiles.map(profile => ({ profile: profile.name, status: "UNVERIFIED", issue: "NATIVE_CONFIG_UNAVAILABLE" })); }
	finally { rmSync(scratch, { recursive: true, force: true }); }
}
export function inspectPolicySettings(input: Pick<PolicyInput, "root" | "home" | "ompPath" | "profileConfigHome">): Finding {
	try {
		const home = absolute(input.home), root = absolute(input.root);
		const ompPath = policyOmpPath(input.ompPath);
		if (!isAbsolute(ompPath)) fail("OMP_CONFIG_UNAVAILABLE");
		const policy = requirePolicy(root).value;
		const configuredProfiles = operatorProfileList(home, input.profileConfigHome);
		const profiles = selectedProfiles({ root, home, ompPath, profiles: configuredProfiles ?? "all",
			includeDefault: configuredProfiles === null }, true);
		const reads = nativePolicyRead(ompPath, home, profiles);
		let hasDrift = false, hasUnverified = false;
		const rows = reads.map(read => {
			const keys = policyKeys.map(key => {
				const status = read.status !== "OK" || read.values?.[key] === undefined ? "UNVERIFIED" :
					JSON.stringify(read.values[key]) === JSON.stringify(policy[key]) ? "OK" : "DRIFT";
				if (status === "DRIFT") hasDrift = true; if (status === "UNVERIFIED") hasUnverified = true;
				return { key: nativePolicyKeys[key], status };
			});
			const status = keys.some(key => key.status === "UNVERIFIED") ? "UNVERIFIED" : keys.some(key => key.status === "DRIFT") ? "DRIFT" : "OK";
			return { profile: read.profile, status, keys };
		});
		const status = hasUnverified ? "UNVERIFIED" : hasDrift ? "DEGRADED" : "OK";
		const reason = hasUnverified ? "Native OMP config get could not verify every listed profile TTSR key" :
			hasDrift ? "One or more profile TTSR keys differ from the declared kit policy" : "Native OMP config get matches the declared TTSR policy for every listed profile; runtime activation is not proven";
		const unverifiedProfiles = rows.filter(row => row.status === "UNVERIFIED").map(row => row.profile);
		const driftedProfiles = rows.filter(row => row.status === "DRIFT").map(row => row.profile);
		const matchingProfiles = rows.filter(row => row.status === "OK").map(row => row.profile);
		const allowedDisabled = new Set(policy.disabledRules as string[]);
		const disabledConflicts = reads.flatMap(read => { const disabled = read.values?.disabledRules; return Array.isArray(disabled) ? disabled.filter(name => !allowedDisabled.has(name)).map(name => ({ profile: read.profile, name })) : []; });
		return { component: "policy", status, reason, recommended_action: "Use apply policy --plan to review exact native per-profile config set commands; this finding does not prove a running session loaded them.", evidence: { source: "OMP_CONFIG_GET", profiles: rows, matching_profiles: matchingProfiles, drifted_profiles: driftedProfiles, unverified_profiles: unverifiedProfiles, disabled_conflicts: disabledConflicts } };
	} catch { return { component: "policy", status: "UNVERIFIED", reason: "Native OMP TTSR settings could not be verified for every listed profile", recommended_action: "Inspect the named profiles and OMP config reader; no profile YAML was written.", evidence: { source: "OMP_CONFIG_GET", profiles: [], matching_profiles: [], drifted_profiles: [], unverified_profiles: [], disabled_conflicts: [] } }; }
}

function persistPolicyBackup(stateRoot: string, home: string, profiles: readonly PolicyConfig[]): string {
	ensureMutationStateRoot(stateRoot);
	const backupRoot = join(stateRoot, "policy-backups");
	if (!safeDirectory(backupRoot, true)) mkdirSync(backupRoot, { mode: 0o700 });
	const rootInfo = lstatSync(backupRoot);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (typeof process.getuid === "function" && rootInfo.uid !== process.getuid()) || (rootInfo.mode & 0o077) !== 0) fail("STATE_UNSAFE");
	const id = randomUUID(), backupDir = join(backupRoot, id);
	mkdirSync(backupDir, { mode: 0o700 }); fsyncDirectory(backupRoot);
	try {
		const entries: { profile: string; config_path: string; present: boolean; sha256: string | null; mode: number | null; uid: number | null; gid: number | null; backup_file: string | null }[] = [];
		for (const profile of profiles) {
			if (!sameFileImage(optionalFile(profile.path), profile.file)) fail("FRESH_PLAN");
			const configPath = relative(home, profile.path);
			if (configPath.startsWith("..") || isAbsolute(configPath)) fail("UNSAFE_PATH");
			const backupFile = profile.file ? join("profiles", profile.name, basename(profile.path)) : null;
			if (profile.file && backupFile) { const destination = join(backupDir, backupFile); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); writePrivate(destination, profile.file.bytes); }
			entries.push({ profile: profile.name, config_path: configPath, present: profile.file !== null, sha256: profile.file?.image.sha256 ?? null, mode: profile.file?.image.mode ?? null, uid: profile.file?.image.uid ?? null, gid: profile.file?.image.gid ?? null, backup_file: backupFile });
		}
		if (profiles.some(profile => profile.file !== null)) fsyncDirectory(join(backupDir, "profiles"));
		const manifest = Buffer.from(JSON.stringify({ schema_version: 1, id, scope: "ttsr-policy", created_at: new Date().toISOString(), profiles: entries }, null, 2) + "\n");
		writePrivate(join(backupDir, "manifest.json"), manifest);
		fsyncDirectory(backupDir); fsyncDirectory(backupRoot);
		return id;
	} catch (error) {
		try { rmSync(backupDir, { recursive: true, force: true }); fsyncDirectory(backupRoot); } catch { /* preserve the original backup failure */ }
		throw error;
	}
}
/** Read-only. Without evidence for every effective project and builtin provider, no disabled name is re-enabled. */
function planProfilePolicy(home: string, profile: PolicyConfig, read: NativePolicyRead | undefined, policy: PolicySettings): { steps: PolicyStep[]; blockedProfile?: Readonly<{ profile: string; names: readonly string[] }> } {
	if (!read || read.status !== "OK" || !read.values || policyKeys.some(key => !Object.hasOwn(read.values!, key))) fail("UNVERIFIED_PROFILE", [profile.name]);
	const values = read.values as PolicySettings;
	const leaving = (values.disabledRules as string[]).filter(name => !(policy.disabledRules as string[]).includes(name));
	if (leaving.length) return { steps: [], blockedProfile: Object.freeze({ profile: profile.name, names: Object.freeze([...new Set(leaving)].sort()) }) };
	const relativePath = relative(home, profile.path);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) fail("UNSAFE_PATH");
	const steps: PolicyStep[] = [];
	for (const key of policyKeys) {
		if (JSON.stringify(values[key]) === JSON.stringify(policy[key])) continue;
		steps.push(Object.freeze({ profile: profile.name, path: relativePath, key, command: policyCommand(profile.name, key, policy[key]),
			beforeSha256: profile.file?.image.sha256 ?? null, beforeMode: profile.file?.image.mode ?? null, beforeValue: values[key], value: policy[key] }));
	}
	return { steps };
}
export function planPolicy(input: PolicyInput): PolicyPlan {
	const root = absolute(input.root), home = absolute(input.home);
	const stateRoot = absolute(input.stateRoot ?? join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "omp-kit"));
	safeDirectory(stateRoot, true);
	if (home === sep || root === home || !safeDirectory(root) || !safeDirectory(home)) fail("UNSAFE_PATH");
	if (input.project && !safeDirectory(absolute(input.project))) fail("UNSAFE_PROJECT");
	const source = requirePolicy(root);
	const profiles = selectedProfiles(input);
	const ompPath = policyOmpPath(input.ompPath);
	if (!isAbsolute(ompPath)) fail("OMP_CONFIG_UNAVAILABLE");
	const settings = nativePolicyRead(ompPath, home, profiles);
	const settingsByProfile = new Map(settings.map(entry => [entry.profile, entry]));
	const steps: PolicyStep[] = [], blockedProfiles: Readonly<{ profile: string; names: readonly string[] }>[] = [];
	for (const profile of profiles) {
		const result = planProfilePolicy(home, profile, settingsByProfile.get(profile.name), source.value);
		steps.push(...result.steps);
		if (result.blockedProfile) blockedProfiles.push(result.blockedProfile);
	}
	const plan: PolicyPlan = Object.freeze({ scope: "policy", profiles: Object.freeze(profiles.map(profile => profile.name)), steps: Object.freeze(steps), blockedProfiles: Object.freeze(blockedProfiles) });
	const signature = hash(Buffer.from(JSON.stringify({ source: source.digest, settings,
		profiles: profiles.map(profile => [profile.name, profile.path, profile.file?.image ?? null]) })));
	privatePlans.set(plan, { input: { ...input, ompPath, stateRoot }, signature, profiles });
	return plan;
}

function revalidatePolicyPlan(plan: PolicyPlan, prepared: Prepared): void {
	let fresh: PolicyPlan;
	try { fresh = planPolicy(prepared.input); } catch { return fail("FRESH_PLAN"); }
	const current = privatePlans.get(fresh);
	if (!current || current.signature !== prepared.signature || JSON.stringify(fresh.steps) !== JSON.stringify(plan.steps) ||
		JSON.stringify(fresh.profiles) !== JSON.stringify(plan.profiles) || fresh.blockedProfiles.length) fail("FRESH_PLAN");
}

function changedPolicyProfiles(plan: PolicyPlan, profiles: readonly PolicyConfig[]): PolicyConfig[] {
	const byName = new Map(profiles.map(profile => [profile.name, profile]));
	const affected: PolicyConfig[] = [];
	for (const name of new Set(plan.steps.map(step => step.profile))) {
		const profile = byName.get(name);
		if (!profile) fail("INVALID_PLAN");
		affected.push(profile);
	}
	return affected;
}

type NativePolicyApplyContext = { backupId: string; home: string; ompPath: string; scratch: string; profiles: Map<string, PolicyConfig>; currentImages: Map<string, FileImage | null>; writeStarted: boolean };

function applyNativePolicyStep(step: PolicyStep, profile: PolicyConfig, context: NativePolicyApplyContext): void {
	try {
		if (!sameFileImage(optionalFile(profile.path), context.currentImages.get(profile.name) ?? null)) fail("FRESH_PLAN");
		const before = readNativeValue(runNativeConfig(context.ompPath, context.home, profile.name, "get", step.key, undefined, context.scratch), step.key);
		if (before.issue || JSON.stringify(before.value) !== JSON.stringify(step.beforeValue)) fail("FRESH_PLAN");
		context.writeStarted = true;
		const setResult = readNativeValue(runNativeConfig(context.ompPath, context.home, profile.name, "set", step.key, encodePolicyValue(step.value), context.scratch), step.key);
		if (setResult.issue || JSON.stringify(setResult.value) !== JSON.stringify(step.value)) fail("NATIVE_CONFIG_SET_FAILED");
		const readback = readNativeValue(runNativeConfig(context.ompPath, context.home, profile.name, "get", step.key, undefined, context.scratch), step.key);
		if (readback.issue || JSON.stringify(readback.value) !== JSON.stringify(step.value)) fail("POLICY_READBACK_FAILED");
		const afterImage = optionalFile(profile.path);
		if (!afterImage) fail("POLICY_READBACK_FAILED");
		context.currentImages.set(profile.name, afterImage);
	} catch (error) {
		if (!context.writeStarted) throw error;
		throw new Error("POLICY_APPLY_PARTIAL:" + context.backupId + ":" + step.profile + ":" + step.key);
	}
}

function applyNativePolicySteps(plan: PolicyPlan, context: NativePolicyApplyContext): number {
	const written = new Set<string>();
	for (const step of plan.steps) {
		const profile = context.profiles.get(step.profile);
		if (!profile) throw new Error("POLICY_APPLY_PARTIAL:" + context.backupId + ":" + step.profile + ":" + step.key);
		applyNativePolicyStep(step, profile, context);
		written.add(profile.name);
	}
	return written.size;
}

/** Applies only a freshly replanned TTSR policy; the full profile config is backed up before native config writes. */
export function applyPolicyPlan(plan: PolicyPlan, options: { confirmed: true }): PolicyReceipt {
	if (options?.confirmed !== true) fail("INVALID_PLAN");
	const prepared = privatePlans.get(plan);
	if (!prepared) fail("INVALID_PLAN");
	if (plan.blockedProfiles.length) fail("DISABLED_RULE_REFUSED");
	revalidatePolicyPlan(plan, prepared);
	const stateRoot = prepared.input.stateRoot!, home = prepared.input.home;
	if (inspectPendingMutations(stateRoot).length) fail("PENDING_RECOVERY");
	if (!plan.steps.length) return { status: "UNCHANGED", backupId: null, files: 0, keys: 0 };
	const originals = changedPolicyProfiles(plan, prepared.profiles);
	const ompPath = policyOmpPath(prepared.input.ompPath);
	const backupId = persistPolicyBackup(stateRoot, home, originals);
	const scratch = join(stateRoot, "policy-backups", backupId);
	try { for (const name of ["project", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "bun-install"]) mkdirSync(join(scratch, name), { mode: 0o700 }); }
	catch { throw new Error("POLICY_APPLY_PARTIAL:" + backupId + ":setup:scratch"); }
	const context: NativePolicyApplyContext = { backupId, home, ompPath, scratch,
		profiles: new Map(prepared.profiles.map(profile => [profile.name, profile])),
		currentImages: new Map(originals.map(profile => [profile.name, profile.file])), writeStarted: false }
	const files = applyNativePolicySteps(plan, context);
	return { status: "APPLIED", backupId, files, keys: plan.steps.length };
}
