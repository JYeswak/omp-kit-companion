import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
	buildSessionRegistry,
	checkHoldViolations,
	compareVersions,
	defaultRegistryPath,
	extractOwnerPane,
	findOverlaps,
	parseBinaryPin,
	readRegistryFile,
	seedFromMachine,
	validateSessionRegistry,
	writeRegistryFile,
	type SessionRegistry,
	type SessionSeed,
} from "../../src/session-registry.ts";
const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, `session-registry-test.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid} label=session-registry-test repo=${repoRoot} created=${new Date().toISOString()}\n`);

const POLICY_PATH = join(scratch, "upgrade_policy.toml");

const POLICY_TEXT = `[[blackout]]
window_local = "03:00-03:45"
reason = "fixture backup window"
owner = "beta"

[[no_swap_while]]
binaries = ["localbench"]
condition = "a beta pane is running localbench"
swap_window_local = "01:00-03:00"
reason = "avoid swapping tools beta uses"
owner = "beta"

[[ask_before]]
binaries = ["br"]
how = "obtain explicit acknowledgement before upgrading"
condition = "tracker schema migrations must not land during a grading wave"
owner = "alpha"
`;

function missionText(session: string, paneLine: string, pins: string, paths: string, scopes: string): string {
	return `identity = "Fixture ${session}"
stage = "test"
done_rule = "Checks pass on the wired path."
approved_by = "Joshua"
approved_at = "2026-10-04"
approval_quote = "approved"
not_in_mission = ["unrelated work"]
product_paths = ["src/**"]
pillar_ids = ["learning"]
${paneLine}
[blast_radius]
binaries = [${pins}]
paths = [${paths}]
sessions = [${scopes}]
`;
}

function fixtureSeeds(): SessionSeed[] {
	return [
		{
			session: "alpha",
			repo_root: join(scratch, "alpha"),
			mission_file: join(scratch, "alpha", ".omp", "mission.toml"),
			mission_text: missionText("alpha", 'uphill = "reported to alpha %54"', '"br 0.7.4", "ntm"', '"src"', '"fixture alpha"'),
		},
		{
			session: "beta",
			repo_root: join(scratch, "beta"),
			mission_file: join(scratch, "beta", ".omp", "mission.toml"),
			mission_text: missionText("beta", 'approval_source = "Beta pane-1 selection"', '"localbench"', '"bench"', '"fixture beta", "machine load"'),
		},
	];
}

function fixtureRegistry(): SessionRegistry {
	return buildSessionRegistry(fixtureSeeds(), { path: POLICY_PATH, text: POLICY_TEXT });
}

test("complete fixture rows validate with every field sourced", () => {
	const report = validateSessionRegistry(fixtureRegistry());
	expect(report.overall).toBe("VALID");
	expect(report.session_count).toBe(2);
	expect(report.rows.map(row => [row.session, row.complete])).toEqual([["alpha", true], ["beta", true]]);
	expect(report.no_claim).toContain("does not prove a session respects it");
	const alpha = fixtureRegistry().sessions[0];
	if (!alpha) throw new Error("alpha row missing");
	expect(alpha?.owner_pane).toMatchObject({ value: "%54" });
	expect(alpha?.owner_pane.source?.file).toContain(join("alpha", ".omp", "mission.toml"));
	expect(alpha?.shared_binaries.value).toMatchObject([{ name: "br", min_version: "0.7.4" }, { name: "ntm", min_version: null }]);
	const askBefore = alpha?.holds.value.filter(hold => hold.kind === "ask_before");
	expect(askBefore?.length).toBe(1);
	expect(alpha?.holds.source?.file).toBe(POLICY_PATH);
	const beta = fixtureRegistry().sessions[1];
	if (!beta) throw new Error("beta row missing");
	expect(beta?.owner_pane).toMatchObject({ value: "pane-1" });
	expect(beta?.no_upgrade_windows.value.map(window => window.window)).toEqual(["03:00-03:45", "01:00-03:00"]);
});

test("planted row missing owner pane and mission fails validation", () => {
	const seeds = fixtureSeeds();
	const planted: SessionSeed[] = [...seeds, { session: "ghost", repo_root: join(scratch, "ghost"), mission_file: join(scratch, "ghost", ".omp", "mission.toml"), mission_text: null }];
	const report = validateSessionRegistry(buildSessionRegistry(planted, { path: POLICY_PATH, text: POLICY_TEXT }));
	expect(report.overall).toBe("INVALID");
	const ghost = report.rows.find(row => row.session === "ghost");
	expect(ghost?.complete).toBe(false);
	expect(ghost?.errors).toContain("REGISTRY_FIELD_MISSING:ghost:mission_path");
	expect(ghost?.errors).toContain("REGISTRY_FIELD_MISSING:ghost:owner_pane");
	expect(ghost?.errors).toContain("REGISTRY_FIELD_MISSING:ghost:blast_radius");
});

test("planted row with a value but no source fails validation", () => {
	const registry = fixtureRegistry();
	const alpha = registry.sessions[0];
	if (!alpha) throw new Error("alpha row missing");
	const planted: SessionRegistry = {
		...registry,
		sessions: [{ ...alpha, owner_pane: { value: "%99", source: null } }, ...registry.sessions.slice(1)],
	};
	const report = validateSessionRegistry(planted);
	expect(report.overall).toBe("INVALID");
	expect(report.errors).toContain("REGISTRY_FIELD_UNSOURCED:alpha:owner_pane");
});

test("planted second owner for a session scope is flagged as an overlap", () => {
	const registry = fixtureRegistry();
	expect(findOverlaps(registry)).toEqual([]);
	const beta = registry.sessions[1];
	if (!beta?.blast_radius.value) throw new Error("beta blast radius missing");
	const planted: SessionRegistry = {
		...registry,
		sessions: [
			...registry.sessions,
			{
				session: "poacher",
				mission_path: { value: join(scratch, "poacher", ".omp", "mission.toml"), source: { file: "planted", stanza: "record" } },
				owner_pane: { value: "%98", source: { file: "planted", stanza: "prose" } },
				shared_binaries: { value: [], source: { file: "planted", stanza: "record" } },
				holds: { value: [], source: { file: POLICY_PATH, stanza: "consulted" } },
				no_upgrade_windows: { value: [], source: { file: POLICY_PATH, stanza: "consulted" } },
				blast_radius: {
					value: { binaries: [], paths: [], sessions: ["machine load", "fixture beta"] },
					source: { file: "planted", stanza: "record" },
				},
			},
		],
	};
	const flagged = findOverlaps(planted);
	const scopeHit = flagged.find(hit => hit.kind === "session-scope" && hit.resource === "machine load");
	expect(scopeHit?.owners).toEqual(["beta", "poacher"]);
	const betaScope = flagged.find(hit => hit.kind === "session-scope" && hit.resource === "fixture beta");
	expect(betaScope?.owners).toEqual(["beta", "poacher"]);
});

test("live machine seed enumerates every fleet session with its sources", () => {
	const home = process.env.HOME ?? "";
	const { registry, attempted } = seedFromMachine({ home });
	expect(registry.sessions.map(row => row.session)).toEqual(["omp-test", "uds", "localbench", "jev", "cfsios"]);
	expect(registry.policy_path).toContain("upgrade_policy.toml");
	expect(attempted.length).toBe(6);
	const report = validateSessionRegistry(registry);
	expect(report.session_count).toBe(5);
	expect(Array.isArray(report.errors)).toBe(true);
	for (const row of registry.sessions) {
		for (const field of [row.mission_path, row.owner_pane, row.shared_binaries, row.holds, row.no_upgrade_windows, row.blast_radius]) {
			expect("source" in field).toBe(true);
		}
	}
	expect(report.errors).toContain("REGISTRY_FIELD_MISSING:uds:mission_path");
});

test("live jev row pins br 0.7.4 with its mission source when the checkout exists", () => {
	const home = process.env.HOME ?? "";
	const jevMission = join(home, "Developer", "jev", ".omp", "mission.toml");
	let present = false;
	try {
		readFileSync(jevMission, "utf8");
		present = true;
	} catch {
		present = false;
	}
	if (!present) return;
	const { registry } = seedFromMachine({ home });
	const jev = registry.sessions.find(row => row.session === "jev");
	const br = jev?.shared_binaries.value.find(binary => binary.name === "br");
	expect(br?.min_version).toBe("0.7.4");
	expect(jev?.shared_binaries.source?.file).toContain(join("jev", ".omp", "mission.toml"));
});

test("installed br below the pinned floor is a violation; equal, newer, and unparseable stay quiet", () => {
	const registry = fixtureRegistry();
	expect(checkHoldViolations(registry, { br: "0.7.3" })).toMatchObject([{ session: "alpha", binary: "br", floor: "0.7.4", installed: "0.7.3" }]);
	expect(checkHoldViolations(registry, { br: "0.7.4" })).toEqual([]);
	expect(checkHoldViolations(registry, { br: "0.9.0" })).toEqual([]);
	expect(checkHoldViolations(registry, { br: "unknown" })).toEqual([]);
	expect(checkHoldViolations(registry, {})).toEqual([]);
});

test("version compare is numeric per segment and refuses non-versions", () => {
	expect(compareVersions("0.7.3", "0.7.4")).toBe(-1);
	expect(compareVersions("0.7.4", "0.7.4")).toBe(0);
	expect(compareVersions("1.37.0", "1.36.1")).toBe(1);
	expect(compareVersions("1.9", "1.10")).toBe(-1);
	expect(compareVersions("v1", "1.0")).toBe(null);
	expect(parseBinaryPin("br 0.7.4")).toEqual({ name: "br", min_version: "0.7.4" });
	expect(parseBinaryPin("localbench")).toEqual({ name: "localbench", min_version: null });
});

test("owner pane prefers declarations over neighbour pane references", () => {
	expect(extractOwnerPane({ approval_source: "Jev pane-1 selection", neighbours: { a: "%55" } })?.pane).toBe("pane-1");
	expect(extractOwnerPane({ uphill: "reported to omp-test %54" })?.pane).toBe("%54");
	expect(extractOwnerPane({ identity: "no pane here" })).toBe(null);
});

test("in-tree known-bad registry files are refused, and good files round-trip", () => {
	const dir = mkdtempSync(join(scratch, "files."));
	const good = join(dir, "good.json");
	writeRegistryFile(good, fixtureRegistry());
	expect(readRegistryFile(good).sessions.length).toBe(2);
	const garbage = join(dir, "garbage.json");
	writeFileSync(garbage, "not json{{{");
	expect(() => readRegistryFile(garbage)).toThrow("REGISTRY_FILE_UNREADABLE");
	const foreign = join(dir, "foreign.json");
	writeFileSync(foreign, JSON.stringify({ schema_version: 999, policy_path: "x", sessions: [] }));
	expect(() => readRegistryFile(foreign)).toThrow("REGISTRY_SCHEMA_UNSUPPORTED");
	const malformed = join(dir, "malformed.json");
	writeFileSync(malformed, JSON.stringify({ schema_version: 1, policy_path: "x" }));
	expect(() => readRegistryFile(malformed)).toThrow("REGISTRY_FILE_MALFORMED");
});


test("default registry path stays in private machine state, never the repo", () => {
	expect(defaultRegistryPath("/home/u", {})).toBe("/home/u/.local/state/omp-kit/session-registry.json");
	expect(defaultRegistryPath("/home/u", { XDG_STATE_HOME: "/xdg" })).toBe("/xdg/omp-kit/session-registry.json");
	expect(defaultRegistryPath("/home/u", { XDG_STATE_HOME: "" })).toBe("/home/u/.local/state/omp-kit/session-registry.json");
});
