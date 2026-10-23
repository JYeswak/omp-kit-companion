/** oq1h.7 portability: stock runners report NOT_CONFIGURED/NO_REPOS; the fleet lives in the user overlay. */
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_LESSONS_NOT_CONFIGURED, readLessonsConfig, runFleetLessonsOnce } from "../../src/fleet-lessons.ts";
import { readUserFleetRepos } from "../../src/fleet-user-config.ts";
import { runPlanningScore } from "../../src/planning-score.ts";
import { defaultTrackedRepos, pollRepos, type CiCacheFile } from "../../src/ci-cache.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const envStack: { key: string; value: string | undefined }[][] = [];
afterEach(() => {
	const frame = envStack.pop();
	if (!frame) return;
	for (const { key, value } of frame) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
function withEnv(vars: Record<string, string | undefined>) {
	envStack.push(Object.entries(vars).map(([key, value]) => {
		const prev = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		return { key, value: prev };
	}));
}

function scratch(): { base: string; home: string; kitRoot: string } {
	const base = ownedTmp("portability", { root: process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp") }).path;
	dirs.push(base);
	const home = join(base, "home"), kitRoot = join(base, "kit");
	mkdirSync(join(kitRoot, "config"), { recursive: true });
	mkdirSync(home, { recursive: true });
	return { base, home, kitRoot };
}

const EMPTY_LESSONS = `[checkins]
interval_minutes = 120

[fleet]
report_interval_seconds = 21600
repos = []

[classifier]
mode = "off"
`;

function writeEmptyShipped(kitRoot: string) {
	writeFileSync(join(kitRoot, "config", "lessons.toml"), EMPTY_LESSONS);
	writeFileSync(join(kitRoot, "config", "planning-score.toml"),
		`version = 1\n\n[plan]\ndefault = "PLAN_{mission}.md"\n\n[targets]\nplan_present = true\nplan_rounds = 4\nplan_last_diff = 0.05\nconverted_once = 1\ncoverage_checks = 1\npolish_rounds = 6\npolish_last_changed = 0.05\nbead_self_contained_median_chars = 300\nbead_self_contained_acceptance_present_share = 0.4\nbead_self_contained_deps_per_bead = 1.0\nbead_breadth_max_files = 5\nbead_breadth_max_components = 3\nplan_to_code_hours = 24\nplan_ship_ratio_7d = 2.0\nmain_green = true\n\n[weights]\nplan_present = 1.0\nplan_rounds = 1.0\nplan_last_diff = 1.0\nconverted_once = 1.0\ncoverage_checks = 1.0\npolish_rounds = 1.0\npolish_last_changed = 1.0\nbead_self_contained = 1.0\nbead_breadth = 1.0\nplan_to_code_hours = 1.0\nplan_ship_ratio_7d = 1.0\nmain_green = 1.0\n\n[ci]\nmode = "hosted"\nbranch = "main"\nrequired_workflow = "ci.yml"\n\n[fleet]\nrepos = []\n`);
}

test("stock lessons run throws NOT_CONFIGURED before any state or repo effect", () => {
	const { home, kitRoot } = scratch();
	writeEmptyShipped(kitRoot);
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	const stateRoot = join(home, "state");
	expect(() => runFleetLessonsOnce({ kitRoot, home, stateRoot }, {
		planningScore: () => { throw new Error("unexpected planning work"); },
		tracker: () => { throw new Error("unexpected tracker work"); },
	})).toThrow(FLEET_LESSONS_NOT_CONFIGURED);
	expect(existsSync(stateRoot)).toBe(false);
});

test("user overlay fleet merges over the empty shipped list and passes the gate", () => {
	const { home, kitRoot } = scratch();
	writeEmptyShipped(kitRoot);
	const repo = join(home, "temp-repo"), intake = join(home, "intake");
	mkdirSync(repo, { recursive: true });
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	mkdirSync(join(home, "xdg", "omp-kit"), { recursive: true });
	writeFileSync(join(home, "xdg", "omp-kit", "fleet.toml"),
		`[fleet]\nintake_tracker = ${JSON.stringify(intake)}\nrepos = [\n  { name = "temp-repo", path = ${JSON.stringify(repo)}, tracker = ${JSON.stringify(intake)} },\n]\n`);
	const config = readLessonsConfig(kitRoot, home);
	expect(config.repos.map(entry => entry.name)).toEqual(["temp-repo"]);
	expect(config.repos[0]?.path).toBe(repo);
	expect(config.intakeTracker).toBe(intake);
	expect(readUserFleetRepos(home, kitRoot).map(entry => entry.name)).toEqual(["temp-repo"]);
	// Gate passes (no NOT_CONFIGURED); the run continues to tracker work with stub deps.
	const produced = runFleetLessonsOnce({ kitRoot, home, stateRoot: join(home, "state") }, {
		planningScore: () => ({ code: 0, data: { kind: "summary", status: "UNKNOWN", weighted_score: null, mission_count: 0, metrics: {}, text: "" }, jsonl: [] }),
		tracker: () => ({ code: 0, stdout: "[]", stderr: "" }),
	});
	expect(produced.report.schema).toBe("omp-kit.fleet-lessons/v1");
});

test("user overlay naming an excluded path still validates like shipped config", () => {
	const { home, kitRoot } = scratch();
	writeEmptyShipped(kitRoot);
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	mkdirSync(join(home, "xdg", "omp-kit"), { recursive: true });
	writeFileSync(join(home, "xdg", "omp-kit", "fleet.toml"), `[fleet]\nrepos = [ { name = "bad!!", path = "/tmp/x" } ]\n`);
	expect(() => readLessonsConfig(kitRoot, home)).toThrow("LESSONS_CONFIG_REPO_0_NAME_INVALID");
});

test("planning score --fleet with empty lists reports NOT_CONFIGURED exit 3", () => {
	const { home, kitRoot } = scratch();
	writeEmptyShipped(kitRoot);
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	const result = runPlanningScore({ kitRoot, home, fleet: true });
	expect(result.code).toBe(3);
	expect(result.errors?.[0]?.code).toBe("NOT_CONFIGURED");
});

test("planning score --fleet reads a user-config temp repo instead of reporting unconfigured", () => {
	const { home, kitRoot } = scratch();
	writeEmptyShipped(kitRoot);
	const repo = join(home, "temp-repo");
	mkdirSync(repo, { recursive: true });
	// Hermetic repo (ompkit-kl9p3): without its own .git, git walks up from the scratch and scores the
	// enclosing checkout's history, reaching gh when that history holds plan(...) commits.
	expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
	expect(Bun.spawnSync(["git", "-C", repo, "rev-parse", "--show-toplevel"]).stdout.toString().trim()).toBe(realpathSync(repo));
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	mkdirSync(join(home, "xdg", "omp-kit"), { recursive: true });
	writeFileSync(join(home, "xdg", "omp-kit", "fleet.toml"),
		`[fleet]\nrepos = [\n  { name = "temp-repo", path = ${JSON.stringify(repo)} },\n]\n`);
	const result = runPlanningScore({ kitRoot, home, fleet: true });
	// The overlay repo is scored: an unscorable repo is UNKNOWN, which shares exit 3 with NOT_CONFIGURED,
	// so the scored path (no errors, PERFORMED, a mission row for the overlay path) tells them apart.
	expect(result.errors).toBeUndefined();
	expect(result.verification).toBe("PERFORMED");
	expect((result.jsonl ?? []).filter(row => row.kind === "mission").map(row => row.repo)).toEqual([repo]);
});

test("ci-poller defaults to no repos; empty poll makes no network call", async () => {
	const { base, home } = scratch();
	// Planted decoy (ompkit-kl9p3): an ambient fleet-watch config, like an operator's real
	// ~/.config/omp-kit/fleet-watch.json, which the stock default under a fresh HOME must never see.
	const decoy = join(base, "ambient-fleet-watch.json");
	writeFileSync(decoy, JSON.stringify({ sessions: [{ repo: join(base, "ambient-repo") }] }));
	withEnv({ OMP_KIT_CI_REPOS: undefined, OMP_KIT_FLEET_WATCH_CONFIG: decoy });
	expect(defaultTrackedRepos().length).toBe(1);
	expect(defaultTrackedRepos({ HOME: home })).toEqual([]);
	const cache: CiCacheFile = { version: 1, repos: {} };
	const result = await pollRepos({ fetch: () => { throw new Error("network must not be touched"); } }, cache, []);
	expect(result.requestsMade).toBe(0);
	expect(result.repos).toEqual({});
});

test("ci-poller honors OMP_KIT_CI_REPOS when set", () => {
	const saved = process.env.OMP_KIT_CI_REPOS;
	process.env.OMP_KIT_CI_REPOS = "acme/one, acme/two";
	try {
		expect(defaultTrackedRepos()).toEqual(["acme/one", "acme/two"]);
	} finally {
		if (saved === undefined) delete process.env.OMP_KIT_CI_REPOS;
		else process.env.OMP_KIT_CI_REPOS = saved;
	}
});

test("stock run makes no read under an unreadable ~/Developer tripwire", () => {
	const { home, kitRoot } = scratch();
	writeEmptyShipped(kitRoot);
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	const developer = join(home, "Developer");
	mkdirSync(developer, { recursive: true });
	writeFileSync(join(developer, "CANARY.txt"), "any read under here must fail the run\n");
	chmodSync(developer, 0o000);
	try {
		expect(() => runFleetLessonsOnce({ kitRoot, home, stateRoot: join(home, "state") }, {
			planningScore: () => { throw new Error("unexpected planning work"); },
			tracker: () => { throw new Error("unexpected tracker work"); },
		})).toThrow(FLEET_LESSONS_NOT_CONFIGURED);
		const planning = runPlanningScore({ kitRoot, home, fleet: true });
		expect(planning.code).toBe(3);
	} finally {
		chmodSync(developer, 0o700);
	}
});
