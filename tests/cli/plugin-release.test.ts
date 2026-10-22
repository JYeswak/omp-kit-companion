// FLEETUPG1 (ompkit-v66l.22): linked plugin vs latest published, per profile and per seat.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { diagnose } from "../../src/diagnostics.ts";
import { compareVersions, inspectPluginRelease, livePluginReleaseIo, seatProfile, type OmpSeat, type PluginLink } from "../../src/plugin-release.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repoRoot = resolve(import.meta.dir, "../..");

const RELINK = Date.parse("2026-10-19T01:40:00Z");
const link = (profile: string, version: string | null, target: string | null = version && `/opt/releases/${version}`): PluginLink =>
	({ profile, path: `/h/${profile}`, target, version, linkedAtMs: target ? RELINK : null });
const io = (latest: string | null, links: PluginLink[], seats: OmpSeat[] | null = []) => ({ latestPublished: () => latest, links: () => links, seats: () => seats });
const verdicts = (rows: unknown) => (rows as { verdict: string }[]).map((row) => row.verdict);

describe("plugin_release", () => {
	test("all links on the latest release are CURRENT and the finding is OK", () => {
		const result = inspectPluginRelease(io("0.2.51", [link("default", "0.2.51"), link("claude", "0.2.51")]));
		expect(result.status).toBe("OK");
		expect(verdicts(result.evidence?.profiles)).toEqual(["CURRENT", "CURRENT"]);
	});

	test("a planted stale link is STALE and degrades the finding", () => {
		const result = inspectPluginRelease(io("0.2.51", [link("default", "0.2.51"), link("codex", "0.2.37")]));
		expect(result.status).toBe("DEGRADED");
		expect(verdicts(result.evidence?.profiles)).toEqual(["CURRENT", "STALE"]);
		expect(result.evidence?.stale_profiles).toEqual(["codex"]);
	});

	test("numeric order: 0.2.9 is behind 0.2.10", () => {
		expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
		expect(inspectPluginRelease(io("0.2.10", [link("default", "0.2.9")])).evidence?.stale_profiles).toEqual(["default"]);
	});

	test("an unreadable latest release is UNKNOWN, never CURRENT", () => {
		const result = inspectPluginRelease(io(null, [link("default", "0.2.51")]));
		expect(result.status).toBe("UNVERIFIED");
		expect(verdicts(result.evidence?.profiles)).toEqual(["UNKNOWN"]);
		expect(result.reason).toContain("UNKNOWN");
	});

	test("a broken link is STALE", () => {
		expect(verdicts(inspectPluginRelease(io("0.2.51", [link("default", null, null)])).evidence?.profiles)).toEqual(["STALE"]);
	});

	test("a seat started before the relink is STALE on loaded; one started after loads the link", () => {
		const seats = [{ pid: 11, startedAtMs: RELINK - 60_000, profile: "claude" }, { pid: 12, startedAtMs: RELINK + 60_000, profile: "claude" }];
		const result = inspectPluginRelease(io("0.2.51", [link("claude", "0.2.51")], seats));
		const rows = result.evidence?.seats as { pid: number; verdict: string; loaded: string | null; loaded_before?: string }[];
		expect(rows.map((row) => [row.pid, row.verdict, row.loaded])).toEqual([[11, "STALE", null], [12, "CURRENT", "0.2.51"]]);
		expect(rows[0]!.loaded_before).toBe("0.2.51");
		expect(result.status).toBe("DEGRADED");
		expect(result.evidence?.stale_seats).toEqual([11]);
	});

	test("unreadable process table leaves seats UNKNOWN", () => {
		const result = inspectPluginRelease(io("0.2.51", [link("default", "0.2.51")], null));
		expect(result.status).toBe("UNVERIFIED");
	});

	test("seat profile comes from --profile, else a profile session path, else default", () => {
		expect(seatProfile(" --profile codex --resume /x")).toBe("codex");
		expect(seatProfile(" --restore /Users/j/.omp/profiles/claude/agent/sessions/a.jsonl")).toBe("claude");
		expect(seatProfile(" --resume /Users/j/.omp/agent/sessions/a.jsonl")).toBe("default");
		const started = performance.now();
		expect(seatProfile(` ${"--profile".repeat(20_000)}`)).toBe("default"); // long near-miss
		expect(performance.now() - started).toBeLessThan(200);
	});

	test("live links read the release version and the relink time from planted symlinks", () => {
		const root = ownedTmp("plugin-release").path;
		try {
			const releases = join(root, "releases");
			for (const version of ["0.2.37", "0.2.51"]) mkdirSync(join(releases, version), { recursive: true });
			const home = join(root, "home");
			const plant = (parts: string[], version: string) => {
				mkdirSync(join(home, ...parts), { recursive: true });
				const path = join(home, ...parts, "omp-kit-companion");
				symlinkSync(join(releases, version), path);
				return path;
			};
			plant([".omp", "plugins", "node_modules"], "0.2.51");
			const stale = plant([".omp", "profiles", "codex", "plugins", "node_modules"], "0.2.37");
			mkdirSync(join(home, ".omp", "profiles", "no-kit"), { recursive: true });
			const live = livePluginReleaseIo(home).links();
			expect(live.map((row) => [row.profile, row.version])).toEqual([["default", "0.2.51"], ["codex", "0.2.37"]]);
			expect(live[1]!.linkedAtMs).toBe(lstatSync(stale).mtimeMs);
			const result = inspectPluginRelease(io("0.2.51", live));
			expect(result.evidence?.stale_profiles).toEqual(["codex"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("doctor --scope plugin_release emits the finding from the planted home", async () => {
		const root = ownedTmp("plugin-release-doctor").path;
		try {
			const home = join(root, "home");
			mkdirSync(join(root, "releases", "0.0.1"), { recursive: true });
			mkdirSync(join(home, ".omp", "plugins", "node_modules"), { recursive: true });
			symlinkSync(join(root, "releases", "0.0.1"), join(home, ".omp", "plugins", "node_modules", "omp-kit-companion"));
			const rows = await diagnose({ root, home, scope: "plugin_release" });
			expect(rows.map((row) => row.component)).toEqual(["plugin_release"]);
			const profiles = rows[0]!.evidence?.profiles as { profile: string; linked: string; verdict: string }[];
			expect(profiles.map((row) => [row.profile, row.linked])).toEqual([["default", "0.0.1"]]);
			// 0.0.1 is behind any published release; offline it is UNKNOWN. Never CURRENT.
			expect(["STALE", "UNKNOWN"]).toContain(profiles[0]!.verdict);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

	test("doctor --scope plugin_release through the CLI accepts the scope (grammar) and reports the finding", () => {
		const root = ownedTmp("plugin-release-cli").path;
		try {
			const home = join(root, "home");
			mkdirSync(join(root, "releases", "0.0.1"), { recursive: true });
			mkdirSync(join(home, ".omp", "plugins", "node_modules"), { recursive: true });
			symlinkSync(join(root, "releases", "0.0.1"), join(home, ".omp", "plugins", "node_modules", "omp-kit-companion"));
			const env = { ...process.env, HOME: home, OMP_KIT_OMP_SRC_FETCH: "0" };
			const child = Bun.spawnSync([process.execPath, "run", join(repoRoot, "src", "cli.ts"), "doctor", "--scope", "plugin_release", "--json"],
				{ env: env as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
			expect(child.exitCode).toBe(0);
			const body = JSON.parse(child.stdout.toString()) as { data: { findings: { component: string }[] } };
			expect(body.data.findings.map((row) => row.component)).toEqual(["plugin_release"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}, 120_000);
