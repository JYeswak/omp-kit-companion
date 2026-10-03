import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";
import { applyMutation, inspectPendingMutations, planMutation, undoMutation, type ApplyOptions, type FileMutation, type Image, type MutationPlan, type PendingInspection } from "./mutations.ts";
import { checkExtensionImports } from "./extensions.ts";
import { matchesBounded } from "./regex-guards.ts";
export type ExtensionInput = { root: string; home: string; stateRoot: string; project?: string; profiles?: "all" | readonly string[]; includeDefault?: boolean };
export type ExtensionStep = { kind: "extension" | "profile"; path: string; profile?: string; beforeSha256: string | null; afterSha256: string };
export type ExtensionPlan = {
	readonly destination: string;
	readonly stateRoot: string;
	readonly steps: readonly ExtensionStep[];
	readonly skippedReasons: readonly ProfileSkip[];
	readonly skippedProfiles: readonly string[];
	readonly alreadyListedProfiles: readonly string[];
	readonly guard: GuardInspection;
	readonly mutation: MutationPlan | null;
};
export type GuardInspection = { status: "UNVERIFIED" | "FAIL" | "NOT_APPLICABLE"; loaded: false | null; reason: string };
export type ExtensionApplyResult = { receiptId: string | null; files: number };

const validName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ts$/;
const validProfile = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const configNames = ["config.yml", "config.yaml", "config.json", "settings.json"];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function stop(code: string): never { throw new Error(code); }
function absolute(path: string): string {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) stop("UNSAFE_PATH");
	return path;
}
function inspectDirectory(path: string, absentAllowed = false): boolean {
	const parts: string[] = [];
	for (let cursor = absolute(path); cursor !== resolve(cursor, ".."); cursor = resolve(cursor, "..")) parts.unshift(cursor);
	for (const part of parts) {
		let info: Stats;
		try { info = lstatSync(part); }
		catch (error) {
			if (absentAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
			stop("UNSAFE_PATH");
		}
		if (!info.isDirectory() || info.isSymbolicLink()) stop("UNSAFE_PATH");
	}
	return true;
}
function readOptional(path: string): { bytes: Buffer; image: Image } | null {
	if (!inspectDirectory(resolve(path, ".."), true)) return null;
	let info: Stats;
	try { info = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		return stop("UNSAFE_PATH");
	}
	if (!info.isFile() || info.isSymbolicLink()) stop("UNSAFE_PATH");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const first = fstatSync(fd);
		if (first.ino !== info.ino || first.dev !== info.dev || !first.isFile()) stop("FRESH_PLAN");
		const bytes = readFileSync(fd);
		const last = fstatSync(fd);
		if (last.ino !== first.ino || last.size !== first.size || last.mtimeMs !== first.mtimeMs || last.ctimeMs !== first.ctimeMs) stop("FRESH_PLAN");
		return { bytes, image: { sha256: hash(bytes), size: bytes.length, mode: first.mode & 0o7777, uid: first.uid, gid: first.gid } };
	} finally { closeSync(fd); }
}
function required(path: string): { bytes: Buffer; image: Image } { return readOptional(path) ?? stop("MISSING_EXTENSION_INPUT"); }

type ProfileConfig = { name: string; path: string; source: { bytes: Buffer; image: Image } | null; data: Record<string, unknown> };
export interface ProfileSkip { name: string; reason: string }
function profiles(home: string, skip: readonly string[], requested: "all" | readonly string[] = "all", includeDefault = false): { selected: ProfileConfig[]; skipped: ProfileSkip[] } {
	const skipped: ProfileSkip[] = [];
	const paths: { name: string; dir: string }[] = [{ name: "default", dir: join(home, ".omp", "agent") }];
	const named = join(home, ".omp", "profiles");
	if (inspectDirectory(named, true)) for (const name of readdirSync(named).sort()) {
		if (!matchesBounded(name, 128, validProfile) || name === "default" || name.endsWith(".")) {
			skipped.push({ name, reason: "UNREADABLE: profile directory name is not addressable" });
			continue;
		}
		const dir = join(named, name, "agent");
		if (!inspectDirectory(dir, true)) {
			skipped.push({ name, reason: "UNREADABLE: profile agent directory is missing or unsafe" });
			continue;
		}
		paths.push({ name, dir });
	}
	let names: Set<string>;
	if (requested === "all") {
		names = new Set(paths.length === 1 || includeDefault ? paths.map(({ name }) => name) : paths.slice(1).map(({ name }) => name));
	} else {
		if (!Array.isArray(requested) || !requested.length || requested.some(name => name !== "default" && !matchesBounded(name, 128, validProfile))) stop("INVALID_PROFILE_SELECTION");
		names = new Set(requested);
		if (includeDefault) names.add("default");
		for (const name of names) if (!paths.some(profile => profile.name === name)) stop("MISSING_PROFILE");
	}
	const chosen = paths.filter(({ name }) => names.has(name));
	for (const { name } of chosen.filter(({ name }) => skip.includes(name))) {
		skipped.push({ name, reason: "policy skipProfiles: profile opted out of extension installs" });
	}
	const selected = chosen.filter(({ name }) => !skip.includes(name)).map(({ name, dir }) => {
		if (!inspectDirectory(dir, true)) {
			if (name === "default") return { name, path: join(dir, "config.yml"), source: null, data: {} };
			skipped.push({ name, reason: "UNREADABLE: profile agent directory is missing or unsafe" });
			return null;
		}
		const present = configNames.filter(file => readOptional(join(dir, file)) !== null);
		if (!present.length) {
			if (name === "default") return { name, path: join(dir, "config.yml"), source: null, data: {} };
			skipped.push({ name, reason: "NO_CONFIG: no config.yml/yaml present; the kit creates nothing unasked" });
			return null;
		}
		if (present.length !== 1 || !["config.yml", "config.yaml"].includes(present[0]!)) {
			skipped.push({ name, reason: `DUAL_CONFIG: ${present.join(" + ")} present; OMP loads config.yml first and merges settings.json separately, so a single-file edit cannot be proven effective` });
			return null;
		}
		const path = join(dir, present[0]!);
		const source = readOptional(path);
		if (!source) {
			skipped.push({ name, reason: "UNREADABLE: config file vanished or is unsafe" });
			return null;
		}
		let data: unknown;
		try { data = YAML.parse(source.bytes.toString("utf8")); } catch {
			skipped.push({ name, reason: "UNPARSEABLE: config YAML does not parse; left untouched for operator review" });
			return null;
		}
		if (!record(data) || (Object.hasOwn(data, "extensions") && !stringArray(data.extensions))) {
			skipped.push({ name, reason: "UNPARSEABLE: config root is not a mapping with a string extensions list" });
			return null;
		}
		return { name, path, source, data };
	}).filter((entry): entry is ProfileConfig => entry !== null);
	return { selected, skipped };
}

/** Pure append decision; never removes an existing path, an unrelated key, or a skipped profile. */
export function planExtensionChanges(destination: string, profile: string, current: readonly string[], skip: readonly string[]): { action: "skip" | "already-listed" | "append"; extensions: readonly string[] } {
	if (skip.includes(profile)) return { action: "skip", extensions: current };
	if (current.includes(destination)) return { action: "already-listed", extensions: current };
	return { action: "append", extensions: [...current, destination] };
}

/** On-disk evidence cannot establish activation; a project empty-list override establishes inactivation. */
export function inspectExtensionGuard(input: ExtensionInput): GuardInspection {
	if (!input.project) return { status: "UNVERIFIED", loaded: null, reason: "No project selected; runtime guard loading was not observed" };
	const project = absolute(input.project);
	if (!inspectDirectory(project)) stop("UNSAFE_PROJECT");
	const marker = readOptional(join(project, ".omp", "kit-guard.json"));
	if (!marker) return { status: "NOT_APPLICABLE", loaded: false, reason: "Project does not opt in to the kit guard" };
	if (inspectDirectory(join(project, ".omp", "extensions", "kit-guard"), true))
		return { status: "UNVERIFIED", loaded: null, reason: "Project provides its own guard; kit loader deliberately deduplicates it; runtime loading not observed" };
	if (readOptional(join(project, ".omp", "settings.json")) || readOptional(join(project, ".claude", "settings.json")))
		return { status: "UNVERIFIED", loaded: null, reason: "Additional project settings make effective extensions precedence unverified" };
	const config = readOptional(join(project, ".omp", "config.yml"));
	if (config) {
		let data: unknown;
		try { data = YAML.parse(config.bytes.toString("utf8")); }
		catch { return { status: "UNVERIFIED", loaded: null, reason: "Project config cannot be parsed; effective guard loading is unverified" }; }
		if (!record(data) || (Object.hasOwn(data, "extensions") && !stringArray(data.extensions)))
			return { status: "UNVERIFIED", loaded: null, reason: "Project extensions setting is unrecognized; effective guard loading is unverified" };
		if (Array.isArray(data.extensions) && data.extensions.length === 0)
			return { status: "FAIL", loaded: false, reason: "Project extensions: [] shadows the profile list; opted-in guard is not loaded and fail-closed handler cannot run" };
	}
	return { status: "UNVERIFIED", loaded: null, reason: "Project opts in, but installed bytes and profile list cannot establish effective guard loading" };
}

/** Read-only plan. Existing differing extension bytes are never adopted, even with generic --apply consent. */
export function planExtensions(input: ExtensionInput): ExtensionPlan {
	const root = absolute(input.root), home = absolute(input.home), stateRoot = absolute(input.stateRoot);
	if (!inspectDirectory(root) || !inspectDirectory(home)) stop("UNSAFE_PATH");
	const policy = required(join(root, "policy", "extensions.json"));
	let manifest: unknown;
	try { manifest = JSON.parse(policy.bytes.toString("utf8")); } catch { stop("INVALID_EXTENSION_POLICY"); }
	if (!record(manifest) || !stringArray(manifest.extensions) || !stringArray(manifest.skipProfiles) ||
		Object.keys(manifest).length !== 2 || manifest.extensions.length < 1 || !manifest.extensions.every(name => matchesBounded(name, 256, validName)) || !manifest.skipProfiles.every(name => name === "default" || matchesBounded(name, 128, validProfile))) stop("INVALID_EXTENSION_POLICY");
	const names = [...new Set(manifest.extensions)];
	if (names.length !== manifest.extensions.length) stop("INVALID_EXTENSION_POLICY");
	const { selected, skipped } = profiles(home, manifest.skipProfiles, input.profiles, input.includeDefault);
	const steps: ExtensionStep[] = [], files: FileMutation[] = [], roots = [{ id: "extensions", path: join(home, ".omp", "omp-extensions") }];
	const skippedReasons: ProfileSkip[] = [...skipped];
	const installableNames: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const source = required(join(root, "extensions", name));
		const destinationDir = join(home, ".omp", "omp-extensions");
		inspectDirectory(destinationDir, true);
		const destination = join(destinationDir, name);
		const existing = readOptional(destination);
		if (existing && !existing.bytes.equals(source.bytes)) {
			skippedReasons.push({ name, reason: "SKIPPED_UNMANAGED" });
			continue;
		}
		if (seen.has(destination)) stop("INVALID_EXTENSION_POLICY");
		seen.add(destination);
		installableNames.push(name);
		if (!existing) {
			files.push({ root: "extensions", relativePath: name, expectedBefore: null, after: { bytes: source.bytes, mode: source.image.mode } });
			steps.push({ kind: "extension", path: destination, beforeSha256: null, afterSha256: source.image.sha256 });
		}
	}
	const skippedProfiles = skipped.map(entry => entry.name), alreadyListedProfiles: string[] = [];
	const destinations = installableNames.map(name => join(home, ".omp", "omp-extensions", name));
	for (const profile of selected) {
		let current: readonly string[] = stringArray(profile.data.extensions) ? profile.data.extensions as string[] : [];
		let listed = true;
		for (const destination of destinations) {
			const decision = planExtensionChanges(destination, profile.name, current, manifest.skipProfiles);
			if (decision.action === "skip") { listed = false; break; }
			if (decision.action !== "already-listed") listed = false;
			current = decision.extensions;
		}
		if (listed) { alreadyListedProfiles.push(profile.name); continue; }
		const next = Buffer.from(YAML.stringify({ ...profile.data, extensions: current }));
		const rootId = `profile-${steps.length}`;
		roots.push({ id: rootId, path: resolve(profile.path, "..") });
		files.push({ root: rootId, relativePath: basename(profile.path), expectedBefore: profile.source?.image ?? null,
			after: { bytes: next, mode: profile.source?.image.mode ?? 0o600, ...(profile.source ? { uid: profile.source.image.uid, gid: profile.source.image.gid } : {}) } });
		steps.push({ kind: "profile", path: profile.path, profile: profile.name, beforeSha256: profile.source?.image.sha256 ?? null, afterSha256: hash(next) });
	}
	return { destination: destinations[0] ?? join(home, ".omp", "omp-extensions"), stateRoot, steps, skippedProfiles, skippedReasons, alreadyListedProfiles, guard: inspectExtensionGuard(input),
		mutation: files.length ? planMutation({ stateRoot, roots, files }) : null };
}

export function applyExtensions(plan: ExtensionPlan, options?: ApplyOptions): ExtensionApplyResult {
	if (!plan.mutation) {
		if (inspectPendingMutations(plan.stateRoot).length) stop("PENDING_RECOVERY");
		return { receiptId: null, files: 0 };
	}
	const receipt = applyMutation(plan.mutation, options);
	if (plan.steps.some(step => step.kind === "extension")) {
		const imports = checkExtensionImports({ home: resolve(plan.destination, "..", "..", "..") });
		if (imports.status === "DEGRADED") {
			undoMutation(plan.stateRoot, receipt.id, { confirmed: true });
			stop("EXTENSION_IMPORTS_UNRESOLVED");
		}
	}
	return { receiptId: receipt.id, files: receipt.files };
}
export function inspectPendingExtensions(stateRoot: string): PendingInspection[] { return inspectPendingMutations(stateRoot); }
