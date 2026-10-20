// MP6 cross-session registry (bead ompkit-rc-epic-land-fix-release-dogfood-rz5.98).
// One machine-local row per fleet session, seeded from uds/registries/upgrade_policy.toml
// (holds, no-upgrade windows) and each session mission.toml's blast_radius (shared
// binaries, blast radius). MP2 reads overlaps and hold violations from this module;
// uds's lane reads holds and no-upgrade windows from the generated machine-local JSON
// file instead of its compile-time checkout copy (cutover: crates/uds/src/upgrade_policy.rs
// EMBEDDED_POLICY -> defaultRegistryPath()). This module never launches checks and never
// proves a session respects its row; see no_claim below.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REGISTRY_SCHEMA_VERSION = 1;
export const REGISTRY_FILENAME = "session-registry.json";
export const POLICY_RELATIVE = "registries/upgrade_policy.toml";
export const MISSION_RELATIVE = ".omp/mission.toml";

/** Fleet sessions in seed order. repo_dir is relative to the fleet root (~/Developer). */
export const FLEET_SESSIONS: readonly { session: string; repo_dir: string }[] = [
	{ session: "omp-test", repo_dir: "omp-kit" },
	{ session: "uds", repo_dir: "uds" },
	{ session: "localbench", repo_dir: "localbench" },
	{ session: "jev", repo_dir: "jev" },
	{ session: "cfsios", repo_dir: "clutterfreespaces.ios" },
];

/** Policy owners that name the omp-test session (the omp-kit repo's seat). */
const OMP_TEST_OWNERS: Readonly<Record<string, true>> = { "omp-test": true, "omp-kit": true };

export interface FieldSource {
	readonly file: string;
	readonly stanza: string;
	readonly detail?: string;
}

export interface Sourced<T> {
	readonly value: T;
	readonly source: FieldSource | null;
}

export interface SharedBinary {
	readonly name: string;
	/** Floor version from a "<name> <version>" pin; null when the source pins no version. */
	readonly min_version: string | null;
}

export type HoldKind = "no_swap_while" | "never_touch" | "ask_before" | "must_preserve" | "blackout";

export interface Hold {
	readonly kind: HoldKind;
	readonly owner: string;
	readonly binaries: readonly string[];
	readonly paths: readonly string[];
	readonly condition: string | null;
	readonly window: string | null;
	readonly note: string | null;
}

export interface NoUpgradeWindow {
	readonly window: string | null;
	readonly condition: string | null;
	readonly reason: string;
	readonly owner: string;
}

export interface BlastRadius {
	readonly binaries: readonly string[];
	readonly paths: readonly string[];
	readonly sessions: readonly string[];
}

export interface SessionRegistryRow {
	readonly session: string;
	readonly mission_path: Sourced<string | null>;
	readonly owner_pane: Sourced<string | null>;
	readonly shared_binaries: Sourced<readonly SharedBinary[]>;
	readonly holds: Sourced<readonly Hold[]>;
	readonly no_upgrade_windows: Sourced<readonly NoUpgradeWindow[]>;
	readonly blast_radius: Sourced<BlastRadius | null>;
}

export interface SessionRegistry {
	readonly schema_version: typeof REGISTRY_SCHEMA_VERSION;
	readonly policy_path: string;
	readonly sessions: readonly SessionRegistryRow[];
}

export interface RegistryRowReport {
	readonly session: string;
	readonly complete: boolean;
	readonly errors: readonly string[];
}

export interface RegistryValidationReport {
	readonly overall: "VALID" | "INVALID";
	readonly session_count: number;
	readonly rows: readonly RegistryRowReport[];
	readonly errors: readonly string[];
	readonly no_claim: "The registry records declared ownership; it does not prove a session respects it.";
}

export interface Overlap {
	readonly kind: "binary" | "path" | "session-scope";
	readonly resource: string;
	readonly owners: readonly string[];
	readonly sources: readonly string[];
}

export interface HoldViolation {
	readonly session: string;
	readonly binary: string;
	readonly floor: string;
	readonly installed: string;
	readonly source: FieldSource;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Default machine-local registry path: private state, never the public repo. */
export function defaultRegistryPath(home: string, env: Record<string, string | undefined> = process.env): string {
	const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(home, ".local", "state");
	return join(state, "omp-kit", REGISTRY_FILENAME);
}

function parseToml(textContent: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = Bun.TOML.parse(textContent);
		return record(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Split a "br 0.7.4" pin into name + floor; a bare name carries no version claim. */
export function parseBinaryPin(entry: string): SharedBinary {
	const match = /^([A-Za-z0-9_.@/-]+)\s+([0-9][A-Za-z0-9._-]*)$/.exec(entry.trim());
	if (!match) return Object.freeze({ name: entry.trim(), min_version: null });
	return Object.freeze({ name: match[1] ?? entry.trim(), min_version: match[2] ?? null });
}

/** Numeric dotted-version compare; null when either side is not a plain version. */
export function compareVersions(installed: string, floor: string): number | null {
	const parts = (value: string): number[] | null => {
		if (!/^[0-9]+(?:\.[0-9]+)*$/.test(value.trim())) return null;
		return value.trim().split(".").map(Number);
	};
	const left = parts(installed);
	const right = parts(floor);
	if (!left || !right) return null;
	const width = Math.max(left.length, right.length);
	for (let index = 0; index < width; index++) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Owner pane from the mission record only: an explicit `owner_pane` key wins, then a
 * `pane-N` declaration (e.g. jev's approval_source "Jev pane-1"), then a `%NN` pane
 * reference in prose (e.g. omp-kit's "reported to omp-test %54"). Neighbour `%NN`
 * references name other sessions' panes, so prose panes lose to declarations.
 */
export function extractOwnerPane(mission: Record<string, unknown>): { pane: string; stanza: string } | null {
	const declared = text(mission.owner_pane);
	if (declared) return { pane: declared, stanza: "owner_pane" };
	const approval = text(mission.approval_source);
	const paneDeclined = /pane[- ](\d+)/i.exec(approval ?? "");
	if (paneDeclined) return { pane: `pane-${paneDeclined[1]}`, stanza: "approval_source" };
	const allText = JSON.stringify(mission);
	const paneProse = /pane[- ](\d+)/i.exec(allText);
	if (paneProse) return { pane: `pane-${paneProse[1]}`, stanza: "prose" };
	const ref = /%(\d{2})\b/.exec(allText);
	if (ref) return { pane: `%${ref[1]}`, stanza: "prose" };
	return null;
}

function policyOwnerSession(owner: string, session: string): string | null {
	if (owner === session) return session;
	if (session === "omp-test" && OMP_TEST_OWNERS[owner]) return session;
	return null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

interface PolicySlices {
	holds: Hold[];
	windows: NoUpgradeWindow[];
}


function collectPolicy(policy: Record<string, unknown>, session: string): PolicySlices {
	const slices: PolicySlices = { holds: [], windows: [] };
	const push = (entry: unknown, kind: HoldKind): void => {
		if (!record(entry)) return;
		const owner = text(entry.owner);
		if (!owner || policyOwnerSession(owner, session) !== session) return;
		const binaries = [...asStringArray(entry.binaries), ...asStringArray(entry.applies_to)];
		if (typeof entry.binary === "string" && entry.binary.trim() !== "") binaries.push(entry.binary.trim());
		const hold: Hold = Object.freeze({
			kind,
			owner,
			binaries: Object.freeze(binaries),
			paths: Object.freeze(asStringArray(entry.paths)),
			condition: text(entry.condition),
			window: text(entry.window_local) ?? text(entry.swap_window_local),
			note: text(entry.reason) ?? text(entry.contract) ?? text(entry.how) ?? text(entry.check) ?? null,
		});
		slices.holds.push(hold);
		const window = text(entry.window_local) ?? text(entry.swap_window_local);
		const reason = text(entry.reason) ?? text(entry.contract) ?? text(entry.how) ?? "";
		if (window || entry.condition) {
			slices.windows.push(Object.freeze({
				window,
				condition: text(entry.condition),
				reason: reason || kind,
				owner,
			}));
		}
	};
	const lists: [unknown, HoldKind][] = [
		[policy.blackout, "blackout"],
		[policy.never_touch, "never_touch"],
		[policy.no_swap_while, "no_swap_while"],
		[policy.must_preserve, "must_preserve"],
		[policy.ask_before, "ask_before"],
	];
	for (const [list, kind] of lists) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) push(entry, kind);
	}
	return slices;
}

export interface SessionSeed {
	readonly session: string;
	readonly repo_root: string;
	readonly mission_file: string;
	readonly mission_text: string | null;
}

function buildRow(seed: SessionSeed, policy: Record<string, unknown> | null, policyPath: string): SessionRegistryRow {
	const mission = seed.mission_text === null ? null : parseToml(seed.mission_text);
	const missionSource: FieldSource = { file: seed.mission_file, stanza: "record" };
	const policySource: FieldSource = { file: policyPath, stanza: "consulted" };
	const blast = mission && record(mission.blast_radius) ? mission.blast_radius : null;
	const binaries = blast ? [...asStringArray(blast.binaries), ...asStringArray(blast.shared_binaries)] : null;
	const paths = blast ? [...asStringArray(blast.paths), ...asStringArray(blast.installs_outside_repo)] : null;
	const sessions = blast ? asStringArray(blast.sessions) : null;
	const pane = mission ? extractOwnerPane(mission) : null;
	const slices = policy ? collectPolicy(policy, seed.session) : { holds: [], windows: [] };
	return Object.freeze({
		session: seed.session,
		mission_path: Object.freeze({
			value: seed.mission_text === null ? null : seed.mission_file,
			source: seed.mission_text === null ? null : missionSource,
		}),
		owner_pane: Object.freeze({
			value: pane ? pane.pane : null,
			source: pane ? Object.freeze({ file: seed.mission_file, stanza: pane.stanza }) : null,
		}),
		shared_binaries: Object.freeze({
			value: Object.freeze((binaries ?? []).map(parseBinaryPin)),
			source: mission && binaries ? missionSource : null,
		}),
		holds: Object.freeze({ value: Object.freeze(slices.holds), source: policy ? policySource : null }),
		no_upgrade_windows: Object.freeze({ value: Object.freeze(slices.windows), source: policy ? policySource : null }),
		blast_radius: Object.freeze({
			value: blast && binaries && paths && sessions
				? Object.freeze({ binaries: Object.freeze(binaries), paths: Object.freeze(paths), sessions: Object.freeze(sessions) })
				: null,
			source: blast && binaries && paths && sessions ? missionSource : null,
		}),
	});
}

/** Pure build from seed texts: fixtures pass strings, never touch the live tree. */
export function buildSessionRegistry(seeds: readonly SessionSeed[], policy: { path: string; text: string } | null): SessionRegistry {
	const parsed = policy ? parseToml(policy.text) : null;
	return Object.freeze({
		schema_version: REGISTRY_SCHEMA_VERSION,
		policy_path: policy ? policy.path : "",
		sessions: Object.freeze(seeds.map(seed => buildRow(seed, parsed, policy ? policy.path : ""))),
	});
}

function rowErrors(row: SessionRegistryRow): string[] {
	const errors: string[] = [];
	const id = row.session;
	if (row.mission_path.value === null) errors.push(`REGISTRY_FIELD_MISSING:${id}:mission_path`);
	else if (!row.mission_path.source) errors.push(`REGISTRY_FIELD_UNSOURCED:${id}:mission_path`);
	if (row.owner_pane.value === null) errors.push(`REGISTRY_FIELD_MISSING:${id}:owner_pane`);
	else if (!row.owner_pane.source) errors.push(`REGISTRY_FIELD_UNSOURCED:${id}:owner_pane`);
	if (!row.shared_binaries.source) errors.push(`REGISTRY_FIELD_UNSOURCED:${id}:shared_binaries`);
	if (!row.holds.source) errors.push(`REGISTRY_FIELD_UNSOURCED:${id}:holds`);
	if (!row.no_upgrade_windows.source) errors.push(`REGISTRY_FIELD_UNSOURCED:${id}:no_upgrade_windows`);
	if (row.blast_radius.value === null) errors.push(`REGISTRY_FIELD_MISSING:${id}:blast_radius`);
	else if (!row.blast_radius.source) errors.push(`REGISTRY_FIELD_UNSOURCED:${id}:blast_radius`);
	return errors;
}

/** Every row needs every field with its source; list fields may be empty but never unsourced. */
export function validateSessionRegistry(registry: SessionRegistry): RegistryValidationReport {
	const rows: RegistryRowReport[] = [];
	const errors: string[] = [];
	for (const row of registry.sessions) {
		const rowError = rowErrors(row);
		rows.push(Object.freeze({ session: row.session, complete: rowError.length === 0, errors: Object.freeze(rowError) }));
		errors.push(...rowError);
	}
	return Object.freeze({
		overall: errors.length === 0 ? "VALID" : "INVALID",
		session_count: registry.sessions.length,
		rows: Object.freeze(rows),
		errors: Object.freeze(errors),
		no_claim: "The registry records declared ownership; it does not prove a session respects it.",
	});
}

/**
 * Overlaps for MP2: the same binary name, path, or session-scope string claimed by two
 * or more sessions. Exact-string matches only; paraphrases are never merged.
 */
export function findOverlaps(registry: SessionRegistry): Overlap[] {
	const claimants = new Map<string, { owners: Set<string>; sources: Set<string> }>();
	const claim = (kind: Overlap["kind"], resource: string, owner: string, source: string): void => {
		if (resource.trim() === "") return;
		const key = `${kind}:${resource}`;
		let entry = claimants.get(key);
		if (!entry) {
			entry = { owners: new Set(), sources: new Set() };
			claimants.set(key, entry);
		}
		entry.owners.add(owner);
		entry.sources.add(source);
	};
	for (const row of registry.sessions) {
		const missionFile = typeof row.mission_path.value === "string" ? row.mission_path.value : row.session;
		for (const binary of row.shared_binaries.value) claim("binary", binary.name, row.session, missionFile);
		const blast = row.blast_radius.value;
		if (!blast) continue;
		for (const binary of blast.binaries) claim("binary", binary, row.session, missionFile);
		for (const path of blast.paths) claim("path", path, row.session, missionFile);
		for (const scope of blast.sessions) claim("session-scope", scope, row.session, missionFile);
		for (const hold of row.holds.value) {
			for (const binary of hold.binaries) claim("binary", binary, row.session, registry.policy_path);
			for (const path of hold.paths) claim("path", path, row.session, registry.policy_path);
		}
	}
	const overlaps: Overlap[] = [];
	for (const [key, entry] of claimants) {
		if (entry.owners.size < 2) continue;
		const separator = key.indexOf(":");
		overlaps.push(Object.freeze({
			kind: key.slice(0, separator) as Overlap["kind"],
			resource: key.slice(separator + 1),
			owners: Object.freeze([...entry.owners].sort()),
			sources: Object.freeze([...entry.sources].sort()),
		}));
	}
	overlaps.sort((left, right) => left.resource.localeCompare(right.resource));
	return overlaps;
}

/**
 * Hold violations for MP2: an installed binary below the floor pinned in a registry row
 * (e.g. jev pins br 0.7.4). A newer installed version is compliant; an unparseable
 * version makes no claim rather than a false violation.
 */
export function checkHoldViolations(registry: SessionRegistry, installed: Readonly<Record<string, string>>): HoldViolation[] {
	const violations: HoldViolation[] = [];
	for (const row of registry.sessions) {
		for (const binary of row.shared_binaries.value) {
			if (!binary.min_version) continue;
			const have = installed[binary.name];
			if (typeof have !== "string") continue;
			const order = compareVersions(have, binary.min_version);
			if (order !== null && order < 0 && row.shared_binaries.source) {
				violations.push(Object.freeze({
					session: row.session,
					binary: binary.name,
					floor: binary.min_version,
					installed: have,
					source: row.shared_binaries.source,
				}));
			}
		}
	}
	return violations;
}

export function writeRegistryFile(path: string, registry: SessionRegistry): void {
	writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Read a registry file; planted corrupt or foreign-schema files are refused, never coerced. */
export function readRegistryFile(path: string): SessionRegistry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("REGISTRY_FILE_UNREADABLE");
	}
	if (!record(parsed)) throw new Error("REGISTRY_FILE_MALFORMED");
	if (parsed.schema_version !== REGISTRY_SCHEMA_VERSION) throw new Error("REGISTRY_SCHEMA_UNSUPPORTED");
	if (typeof parsed.policy_path !== "string" || !Array.isArray(parsed.sessions)) throw new Error("REGISTRY_FILE_MALFORMED");
	return parsed as SessionRegistry;
}

export interface MachineSeedOptions {
	readonly home: string;
	readonly fleet_root?: string;
	readonly policy_path?: string;
	readonly read_text?: (path: string) => string | null;
}

function defaultReadText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Seed rows from the live machine: every fleet session enumerated, count reported. */
export function seedFromMachine(options: MachineSeedOptions): { registry: SessionRegistry; attempted: readonly string[] } {
	const fleetRoot = options.fleet_root ?? join(options.home, "Developer");
	const policyPath = options.policy_path ?? join(fleetRoot, "uds", POLICY_RELATIVE);
	const readText = options.read_text ?? defaultReadText;
	const attempted: string[] = [policyPath];
	const seeds: SessionSeed[] = FLEET_SESSIONS.map(({ session, repo_dir }) => {
		const missionFile = join(fleetRoot, repo_dir, MISSION_RELATIVE);
		attempted.push(missionFile);
		return { session, repo_root: join(fleetRoot, repo_dir), mission_file: missionFile, mission_text: readText(missionFile) };
	});
	const registry = buildSessionRegistry(seeds, { path: policyPath, text: readText(policyPath) ?? "" });
	return { registry, attempted: Object.freeze(attempted) };
}

if (import.meta.main) {
	const home = process.env.HOME ?? "";
	const out = Bun.argv.includes("--out") ? Bun.argv[Bun.argv.indexOf("--out") + 1] ?? "" : "";
	const { registry, attempted } = seedFromMachine({ home });
	const report = validateSessionRegistry(registry);
	const overlaps = findOverlaps(registry);
	const payload = { registry, validation: report, overlaps, attempted };
	if (out !== "") {
		mkdirSync(dirname(out), { recursive: true });
		writeRegistryFile(out, registry);
	}
	console.log(JSON.stringify(payload, null, 2));
}
