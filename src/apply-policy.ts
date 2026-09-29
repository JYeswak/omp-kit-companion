import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { YAML } from "bun";
import { readManifest } from "./diagnostics.ts";
import { applyMutation, inspectPendingMutations, planMutation, type FileMutation, type Image, type MutationPlan } from "./mutations.ts";

export type PolicyInput = Readonly<{ root: string; home: string; stateRoot?: string; project?: string; profiles?: "all" | readonly string[]; includeDefault?: boolean }>;
export type PolicyStep = Readonly<{ profile: string; path: string; beforeSha256: string; afterSha256: string }>;
export type PolicyPlan = Readonly<{ scope: "policy"; profiles: readonly string[]; steps: readonly PolicyStep[]; blockedProfiles: readonly Readonly<{ profile: string; names: readonly string[] }>[] }>;
export type PolicyReceipt = Readonly<{ status: "APPLIED" | "UNCHANGED"; id: string | null; files: number }>;

type FileImage = { bytes: Buffer; image: Image };
type PolicyConfig = { name: string; path: string; file: FileImage; data: Record<string, unknown> };
type Prepared = { input: PolicyInput; signature: string; mutation: MutationPlan | null };
const privatePlans = new WeakMap<PolicyPlan, Prepared>();
const profileName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ruleName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const configNames = ["config.yml", "config.yaml", "config.json", "settings.json"];
const policyKeys = ["enabled", "repeatMode", "repeatGap", "contextMode", "disabledRules"];
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
function requirePolicy(root: string): { value: Record<string, unknown>; digest: string } {
	const source = optionalFile(join(root, "policy", "ttsr.json"));
	if (!source) fail("INVALID_POLICY");
	let value: unknown;
	try { value = JSON.parse(source.bytes.toString("utf8")); } catch { fail("INVALID_POLICY"); }
	if (!record(value) || Object.keys(value).sort().join(",") !== [...policyKeys].sort().join(",") ||
		typeof value.enabled !== "boolean" || typeof value.repeatMode !== "string" ||
		typeof value.repeatGap !== "number" || !Number.isFinite(value.repeatGap) ||
		typeof value.contextMode !== "string" || !Array.isArray(value.disabledRules) ||
		!value.disabledRules.every((name: unknown) => typeof name === "string" && ruleName.test(name))) fail("INVALID_POLICY");
	return { value, digest: source.image.sha256 };
}
function globalPreflight(root: string, home: string): string {
	const manifest = readManifest(root);
	if (manifest.error) fail("SOURCE_INVALID");
	const retiredDir = join(root, "retired");
	if (!safeDirectory(retiredDir)) fail("SOURCE_INVALID");
	const retired: string[] = [];
	for (const entry of readdirSync(retiredDir).sort()) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		if (!ruleName.test(name) || manifest.rules.some(rule => rule.name === name) || !optionalFile(join(retiredDir, entry))) fail("SOURCE_INVALID");
		retired.push(name);
	}
	const target = join(home, ".agents", "rules");
	const violations: string[] = [];
	const installed = new Map<string, string>();
	if (!safeDirectory(target, true)) {
		for (const rule of manifest.rules) violations.push(`.agents/rules/${rule.name}.md`);
	} else {
		for (const rule of manifest.rules) {
			const path = `.agents/rules/${rule.name}.md`;
			let actual: FileImage | null = null;
			try { actual = optionalFile(join(target, `${rule.name}.md`)); }
			catch { violations.push(path); continue; }
			if (!actual || actual.image.sha256 !== rule.sha256) violations.push(path);
			installed.set(rule.name, actual?.image.sha256 ?? "missing");
		}
		for (const name of retired) {
			const path = `.agents/rules/${name}.md`;
			try { if (optionalFile(join(target, `${name}.md`))) violations.push(path); }
			catch { violations.push(path); }
		}
	}
	if (violations.length) fail("GLOBAL_PREFLIGHT_FAILED", violations);
	const release = optionalFile(join(root, "MANIFEST.tsv"));
	if (!release) fail("SOURCE_INVALID");
	return hash(Buffer.from(JSON.stringify({ manifest: release.image.sha256, retired, installed: [...installed].sort() })));
}
function selectedProfiles(input: PolicyInput): PolicyConfig[] {
	const home = input.home, namedDir = join(home, ".omp", "profiles");
	const candidates: { name: string; dir: string }[] = [{ name: "default", dir: join(home, ".omp", "agent") }];
	if (safeDirectory(namedDir, true)) for (const name of readdirSync(namedDir).sort()) {
		if (!profileName.test(name) || name === "default" || name.endsWith(".")) fail("UNRECOGNIZED_PROFILE");
		const dir = join(namedDir, name, "agent");
		if (!safeDirectory(dir, true)) fail("UNRECOGNIZED_PROFILE");
		candidates.push({ name, dir });
	}
	const requested = input.profiles ?? "all";
	let names: Set<string>;
	if (requested === "all") {
		names = new Set(candidates.length === 1 || input.includeDefault ? candidates.map(candidate => candidate.name) : candidates.slice(1).map(candidate => candidate.name));
	} else {
		if (!Array.isArray(requested) || !requested.length || requested.some(name => name !== "default" && (!profileName.test(name) || name.endsWith(".")))) fail("INVALID_PROFILE_SELECTION");
		names = new Set(requested);
		if (input.includeDefault) names.add("default");
		for (const name of names) if (!candidates.some(candidate => candidate.name === name)) fail("MISSING_PROFILE");
	}
	return candidates.filter(candidate => names.has(candidate.name)).map(candidate => {
		if (!safeDirectory(candidate.dir, true)) fail("MISSING_PROFILE");
		const present = configNames.filter(name => optionalFile(join(candidate.dir, name)) !== null);
		if (present.length !== 1 || !["config.yml", "config.yaml"].includes(present[0]!)) fail("UNRECOGNIZED_PROFILE_CONFIG");
		const path = join(candidate.dir, present[0]!);
		const file = optionalFile(path)!;
		let data: unknown;
		try { data = YAML.parse(file.bytes.toString("utf8")); } catch { fail("UNRECOGNIZED_PROFILE_CONFIG"); }
		if (!record(data) || (Object.hasOwn(data, "ttsr") && !record(data.ttsr))) fail("UNRECOGNIZED_PROFILE_CONFIG");
		const settings = record(data.ttsr) ? data.ttsr : {};
		if (!Array.isArray(settings.disabledRules) ||
			!settings.disabledRules.every((entry: unknown) => typeof entry === "string")) fail("UNRECOGNIZED_DISABLED_RULES");
		return { name: candidate.name, path, file, data };
	});
}

/** Read-only. Without evidence for every effective project and builtin provider, no disabled name is re-enabled. */
export function planPolicy(input: PolicyInput): PolicyPlan {
	const root = absolute(input.root), home = absolute(input.home);
	const stateRoot = absolute(input.stateRoot ?? join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "omp-kit"));
	safeDirectory(stateRoot, true);
	if (home === sep || root === home || !safeDirectory(root) || !safeDirectory(home)) fail("UNSAFE_PATH");
	if (input.project && !safeDirectory(absolute(input.project))) fail("UNSAFE_PROJECT");
	const source = requirePolicy(root);
	const inventory = globalPreflight(root, home);
	const profiles = selectedProfiles(input);
	const steps: PolicyStep[] = [], blockedProfiles: { profile: string; names: readonly string[] }[] = [], files: FileMutation[] = [];
	for (const profile of profiles) {
		const settings = profile.data.ttsr as Record<string, unknown>;
		const disabled = settings.disabledRules as string[];
		const leaving = disabled.filter(name => !(source.value.disabledRules as string[]).includes(name));
		if (leaving.length) {
			blockedProfiles.push(Object.freeze({ profile: profile.name, names: Object.freeze([...new Set(leaving)].sort()) }));
			continue;
		}
		const changed = policyKeys.some(key => JSON.stringify(settings[key]) !== JSON.stringify(source.value[key]));
		if (!changed) continue;
		const bytes = Buffer.from(YAML.stringify({ ...profile.data, ttsr: { ...settings, ...source.value } }));
		const relativePath = relative(home, profile.path);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) fail("UNSAFE_PATH");
		files.push({ root: "home", relativePath, expectedBefore: profile.file.image,
			after: { bytes, mode: profile.file.image.mode, uid: profile.file.image.uid, gid: profile.file.image.gid } });
		steps.push(Object.freeze({ profile: profile.name, path: relativePath, beforeSha256: profile.file.image.sha256, afterSha256: hash(bytes) }));
	}
	const mutation = files.length && blockedProfiles.length === 0 ? planMutation({ stateRoot, roots: [{ id: "home", path: home }], files }) : null;
	const plan: PolicyPlan = Object.freeze({ scope: "policy", profiles: Object.freeze(profiles.map(profile => profile.name)), steps: Object.freeze(steps), blockedProfiles: Object.freeze(blockedProfiles) });
	const signature = hash(Buffer.from(JSON.stringify({ source: source.digest, inventory,
		profiles: profiles.map(profile => [profile.name, profile.path, profile.file.image]) })));
	privatePlans.set(plan, { input: { ...input, stateRoot }, signature, mutation });
	return plan;
}

/** Generic confirmation authorizes only safe policy changes, never a disabled-rule re-enable. */
export function applyPolicyPlan(plan: PolicyPlan, options: { confirmed: true }): PolicyReceipt {
	if (options?.confirmed !== true) fail("INVALID_PLAN");
	const prepared = privatePlans.get(plan);
	if (!prepared) fail("INVALID_PLAN");
	if (plan.blockedProfiles.length) fail("DISABLED_RULE_REFUSED");
	let fresh: PolicyPlan;
	try { fresh = planPolicy(prepared.input); } catch { return fail("FRESH_PLAN"); }
	if (privatePlans.get(fresh)?.signature !== prepared.signature || JSON.stringify(fresh.steps) !== JSON.stringify(plan.steps) ||
		JSON.stringify(fresh.profiles) !== JSON.stringify(plan.profiles) || fresh.blockedProfiles.length) fail("FRESH_PLAN");
	const stateRoot = prepared.input.stateRoot!;
	if (!prepared.mutation) {
		if (inspectPendingMutations(stateRoot).length) fail("PENDING_RECOVERY");
		return { status: "UNCHANGED", id: null, files: 0 };
	}
	const receipt = applyMutation(prepared.mutation, { onBoundary: boundary => {
		if (boundary !== "pending-synced") return;
		try {
			const current = planPolicy(prepared.input);
			if (privatePlans.get(current)?.signature !== prepared.signature || current.blockedProfiles.length ||
				JSON.stringify(current.steps) !== JSON.stringify(plan.steps)) fail("FRESH_PLAN");
		} catch { fail("FRESH_PLAN"); }
	} });
	return { status: "APPLIED", id: receipt.id, files: receipt.files };
}
