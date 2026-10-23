import { afterAll, afterEach, expect, test } from "bun:test";
import { lessonRecordId, type LessonEntry } from "../../src/lessons.ts";
import { buildFleetLessonsReport, differentBlockerTrigger, gradeFailureRunIds, lowThroughputTriggers, parseLessonsConfig, readLessonsConfig, runClefShadow, runFleetLessonsOnce, scoreChanges, targetStageSurvey, type ClefClassifierConfig, type FleetHourlySample } from "../../src/fleet-lessons.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { bunCapExec, runWithCap } from "../../src/service-run.ts";
import { writeBundledHarness, writeReleaseManifest } from "./release-manifest-fixture.ts";
import { fixtureLauncherTableBin } from "./launcher-table-fixture.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

// Every `service run` below sees only this file's own launchers in the host process table.
const LAUNCHER_TABLE = fixtureLauncherTableBin();

const envStack: { key: string; value: string | undefined }[][] = [];
afterEach(() => {
	const frame = envStack.pop();
	if (!frame) return;
	for (const { key, value } of frame) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
/** Pin process env for the rest of the test; restored by afterEach even on failure. */
function withEnv(vars: Record<string, string | undefined>) {
	envStack.push(Object.entries(vars).map(([key, value]) => {
		const prev = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		return { key, value: prev };
	}));
}
function lesson(repo: string, what: string, lessonClass: LessonEntry["class"] = "SCOPE_GAP"): LessonEntry {
	return {
		ts: "2026-10-05T11:00:00.000Z", repo, agent: "OliveCedar", pane: "%42", model: "codex-test",
		kind: "LESSON", class: lessonClass, what, evidence: "commit abc1234",
		cost_minutes: null, applies_to: "fleet", proposed_fix: null, bead: null,
	};
}

function report(existingExternalRefs: readonly string[] = [], shadow?: {
	status: "OK" | "UNAVAILABLE" | "DISABLED" | "NOT_RUN";
	results: Readonly<Record<string, { class: string | null; grouping: string | null }>>;
	reason?: string;
}) {
	return buildFleetLessonsReport({
		generatedAt: new Date("2026-10-05T12:00:00.000Z"),
		previousReportAt: null,
		repos: [
			{ name: "repo-one", status: "OK", entries: [lesson("repo-one", "Avoid closing a bead before the proof is independently checked.")] },
			{ name: "repo-two", status: "OK", entries: [lesson("repo-two", "  AVOID   closing a bead before the proof is independently checked.  ")] },
			{ name: "repo-three", status: "MISSING", entries: [] },
		],
		scoreChanges: [],
		existingExternalRefs,
		...(shadow ? { shadow } : {}),
	});
}

test("currency report retains B as history while A and C still reach real cross-repo intake", () => {
	const a = lesson("repo-one", "A: current replacement");
	const b = { ...lesson("repo-one", "B: retired advice"), superseded_by: lessonRecordId(a) };
	const c = lesson("repo-one", "C: unrelated useful advice");
	const result = buildFleetLessonsReport({
		generatedAt: new Date("2026-10-05T12:00:00.000Z"), previousReportAt: null,
		repos: [
			{ name: "repo-one", status: "OK", entries: [a, b, c] },
			{ name: "repo-two", status: "OK", entries: [lesson("repo-two", a.what), lesson("repo-two", c.what)] },
		], scoreChanges: [],
	});
	expect(result.rule_groups.map(group => group.what).sort()).toEqual([a.what, c.what]);
	expect(result.intake_plan.map(item => item.what).sort()).toEqual([a.what, c.what]);
	expect(result.history_count).toBe(1);
	expect(result.entries_total).toBe(5);
	expect(result.repos[0]?.history.map(row => row.entry)).toEqual([b]);
	expect(result.unresolved).toEqual([]);
});

const configText = `[checkins]
interval_minutes = 120

[fleet]
report_interval_seconds = 21600
intake_tracker = "~/Developer/omp-kit"
repos = [
  { name = "omp-kit-companion", path = "~/Developer/omp-kit-companion", tracker = "~/Developer/omp-kit" },
  { name = "uds", path = "~/Developer/uds" },
  { name = "jev", path = "~/Developer/jev" },
  { name = "localbench", path = "~/Developer/localbench" },
  { name = "clutterfreespaces.ios", path = "~/Developer/clutterfreespaces.ios" },
]

[classifier]
mode = "shadow"
endpoint = "http://127.0.0.1:8010/v1/systemone"
model = "clef-flash"
max_cpu_busy_pct = 80
timeout_ms = 10000
guard_script = "~/Developer/jev/scripts/local-model-guard.sh"
`;

const classifier: ClefClassifierConfig = {
	mode: "shadow", endpoint: "http://127.0.0.1:8010/v1/systemone", model: "clef-flash",
	guardScript: "/fixture/home/Developer/jev/scripts/local-model-guard.sh", maxCpuBusyPct: 80, timeoutMs: 10_000,
};

function otherClassReport() {
	return buildFleetLessonsReport({
		generatedAt: new Date("2026-10-05T12:00:00.000Z"), previousReportAt: null,
		repos: [
			{ name: "repo-one", status: "OK", entries: [lesson("repo-one", "Guard evidence is not preserved.", "OTHER:unclassified")] },
			{ name: "repo-two", status: "OK", entries: [lesson("repo-two", "A separate exact rule gap exists.", "SCOPE_GAP")] },
		], scoreChanges: [],
	});
}

function successfulPost(_url: string, body: unknown) {
	const request = body as { questions: Record<string, { criteria: Record<string, string> }> };
	const answers = Object.fromEntries(Object.keys(request.questions).map(key => {
		const options = request.questions[key]?.criteria ?? {};
		const choice = key.endsWith("_class") ? "FALSE_CLAIM" : Object.keys(options).find(option => option !== "KEEP_SEPARATE") ?? "KEEP_SEPARATE";
		return [key, { type: "choice", choice }];
	}));
	return { httpStatus: 200, body: JSON.stringify({ answers, usage: { input_tokens: 300, output_tokens: 0 } }) };
}

test("fleet report groups normalized cross-repo lessons and keeps missing repos visible", () => {
	const result = report();
	expect(result.repos.map(repo => ({ name: repo.name, status: repo.status }))).toEqual([
		{ name: "repo-one", status: "OK" },
		{ name: "repo-two", status: "OK" },
		{ name: "repo-three", status: "MISSING" },
	]);
	expect(result.rule_groups).toHaveLength(1);
	expect(result.rule_groups[0]).toMatchObject({
		class: "SCOPE_GAP", repo_names: ["repo-one", "repo-two"], cross_repo: true,
	});
	expect(result.intake_plan).toHaveLength(1);
	expect(result.intake_plan[0]).toMatchObject({
		labels: ["uphill", "lesson"], class: "SCOPE_GAP", repo_names: ["repo-one", "repo-two"],
	});
});

test("fleet report reruns do not plan a duplicate uphill bead for the same class and normalized what", () => {
	const first = report();
	const reference = first.intake_plan[0]?.external_ref;
	expect(reference).toBeDefined();
	const rerun = report([reference!]);
	expect(rerun.rule_groups).toHaveLength(1);
	expect(rerun.intake_plan).toHaveLength(0);
});

test("a Clef shadow class and group sit beside, but never replace, the rules verdict", () => {
	const primary = otherClassReport();
	const groups = primary.rule_groups;
	const shadow = runClefShadow(groups, classifier, {
		guard: () => ({ code: 0, stdout: "local-model-guard: GPU free", stderr: "" }),
		load: () => ({ status: "OK", cpuBusyPct: 25 }),
		post: successfulPost,
	});
	const annotated = buildFleetLessonsReport({
		generatedAt: new Date("2026-10-05T12:00:00.000Z"), previousReportAt: null,
		repos: [
			{ name: "repo-one", status: "OK", entries: [lesson("repo-one", "Guard evidence is not preserved.", "OTHER:unclassified")] },
			{ name: "repo-two", status: "OK", entries: [lesson("repo-two", "A separate exact rule gap exists.", "SCOPE_GAP")] },
		], scoreChanges: [], shadow,
	});
	const other = annotated.rule_groups.find(group => group.class === "OTHER:unclassified");
	expect(shadow.status).toBe("OK");
	expect(other?.shadow).toMatchObject({ status: "OK", class: "FALSE_CLAIM" });
	expect(annotated.rule_groups.find(group => group.id === other?.id)?.class).toBe("OTHER:unclassified");
	expect(annotated.intake_plan).toEqual(primary.intake_plan);
});

test("Clef shadow sends a guarded, unauthenticated System One POST to loopback", async () => {
	const serverCode = [
		'const server = Bun.serve({',
		'  hostname: "127.0.0.1", port: 0,',
		'  async fetch(request) {',
		'    const body = await request.json();',
		'    const answers = Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: "choice", choice: key.endsWith("_class") ? "FALSE_CLAIM" : "KEEP_SEPARATE" }]));',
		'    process.stdout.write(JSON.stringify({ method: request.method, authorization: request.headers.get("authorization"), contentType: request.headers.get("content-type"), model: body.model, state: body.state }) + String.fromCharCode(10));',
		'    return Response.json({ answers, usage: { input_tokens: 100, output_tokens: 20 } });',
		'  },',
		'});',
		'console.log(server.url.port);',
		'setInterval(() => {}, 1000);',
	].join("\n");
	const child = Bun.spawn(["bun", "-e", serverCode], { stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const readLine = async (): Promise<string> => {
		for (;;) {
			const boundary = buffered.indexOf("\n");
			if (boundary >= 0) {
				const line = buffered.slice(0, boundary);
				buffered = buffered.slice(boundary + 1);
				return line;
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error("CLEF_FIXTURE_EXITED_EARLY");
			buffered += decoder.decode(chunk.value, { stream: true });
		}
	};
	try {
		const port = await readLine();
		const result = runClefShadow(otherClassReport().rule_groups, { ...classifier, endpoint: "http://127.0.0.1:" + port + "/v1/systemone" }, {
			guard: () => ({ code: 0, stdout: "guard allowed", stderr: "" }),
			load: () => ({ status: "OK", cpuBusyPct: 10 }),
		});
		const request = JSON.parse(await readLine()) as { method: string; authorization: string | null; contentType: string | null; model: string; state: { groups: unknown[] } };
		expect(result.status).toBe("OK");
		expect(request.method).toBe("POST");
		expect(request.authorization).toBeNull();
		expect(request.contentType).toContain("application/json");
		expect(request.model).toBe("clef-flash");
		expect(Object.keys(request.state.groups[0] as Record<string, unknown>)).toEqual(["id", "class", "what", "repos"]);
	} finally {
		child.kill();
		reader.releaseLock();
		await child.exited;
	}
});
test("a guard refusal reports Clef UNAVAILABLE and never sends a request", () => {
	let requests = 0;
	const result = runClefShadow(otherClassReport().rule_groups, classifier, {
		guard: () => ({ code: 2, stdout: "", stderr: "local-model-guard: still waiting" }),
		load: () => ({ status: "OK", cpuBusyPct: 25 }),
		post: () => { requests += 1; return { httpStatus: 200, body: "{}" }; },
	});
	expect(result.status).toBe("UNAVAILABLE");
	expect(requests).toBe(0);
});

test("an over-80 CPU load blocks Clef and a failed HTTP response preserves the rule result", () => {
	let requests = 0;
	const overLoad = runClefShadow(otherClassReport().rule_groups, classifier, {
		guard: () => ({ code: 0, stdout: "GPU free", stderr: "" }),
		load: () => ({ status: "OK", cpuBusyPct: 80 }),
		post: () => { requests += 1; return { httpStatus: 200, body: "{}" }; },
	});
	expect(overLoad.status).toBe("UNAVAILABLE");
	expect(requests).toBe(0);
	const httpFailure = runClefShadow(otherClassReport().rule_groups, classifier, {
		guard: () => ({ code: 0, stdout: "GPU free", stderr: "" }),
		load: () => ({ status: "OK", cpuBusyPct: 12 }),
		post: () => { requests += 1; return { httpStatus: 500, body: "server error" }; },
	});
	expect(httpFailure.status).toBe("UNAVAILABLE");
	expect(otherClassReport().rule_groups[0]?.class).toBe("OTHER:unclassified");
});

test("lessons config expands repo and tracker paths and keeps Clef shadow-only", () => {
	const config = parseLessonsConfig(configText, "/fixture/home", "/fixture/kit");
	expect(config.checkinIntervalMinutes).toBe(120);
	expect(config.reportIntervalSeconds).toBe(21600);
	expect(config.repos.map(repo => repo.name)).toEqual([
		"omp-kit-companion", "uds", "jev", "localbench", "clutterfreespaces.ios",
	]);
	expect(config.repos[0]).toMatchObject({
		path: "/fixture/home/Developer/omp-kit-companion", trackerPath: "/fixture/home/Developer/omp-kit",
	});
	expect(config.classifier).toMatchObject({ mode: "shadow", endpoint: "http://127.0.0.1:8010/v1/systemone",
		model: "clef-flash", maxCpuBusyPct: 80, timeoutMs: 10000,
		guardScript: "/fixture/home/Developer/jev/scripts/local-model-guard.sh" });
});

test("lessons config refuses invalid intervals and any primary Clef mode", () => {
	expect(() => parseLessonsConfig(configText.replace('mode = "shadow"', 'mode = "primary"'), "/fixture/home", "/fixture/kit"))
		.toThrow(/LESSONS_CONFIG_CLASSIFIER_MODE_INVALID/);
	expect(() => parseLessonsConfig(configText.replace("report_interval_seconds = 21600", "report_interval_seconds = 0"), "/fixture/home", "/fixture/kit"))
		.toThrow(/interval/i);
});
test("grader failures require two distinct structured run IDs per bead", () => {
	expect(gradeFailureRunIds(["GRADE_FAIL:run-1", "repeated GRADE_FAIL:run-1", "GRADE_FAIL:run_2", "GRADE_FAIL:"])).toEqual(["run-1", "run_2"]);
});

test("low throughput needs two complete consecutive zero-close and zero-shipped samples", () => {
	const samples: FleetHourlySample[] = [
		{ repo: "quiet", start_at: "2026-10-05T10:00:00.000Z", end_at: "2026-10-05T11:00:00.000Z", status: "OK", closes: 0, shipped_commits: 0 },
		{ repo: "quiet", start_at: "2026-10-05T11:00:00.000Z", end_at: "2026-10-05T12:00:00.000Z", status: "OK", closes: 0, shipped_commits: 0 },
		{ repo: "active", start_at: "2026-10-05T10:00:00.000Z", end_at: "2026-10-05T11:00:00.000Z", status: "OK", closes: 0, shipped_commits: 0 },
		{ repo: "active", start_at: "2026-10-05T11:00:00.000Z", end_at: "2026-10-05T12:00:00.000Z", status: "OK", closes: 1, shipped_commits: 0 },
		{ repo: "unknown", start_at: "2026-10-05T10:00:00.000Z", end_at: "2026-10-05T11:00:00.000Z", status: "UNAVAILABLE", closes: null, shipped_commits: null },
		{ repo: "unknown", start_at: "2026-10-05T11:00:00.000Z", end_at: "2026-10-05T12:00:00.000Z", status: "OK", closes: 0, shipped_commits: 0 },
	];
	expect(lowThroughputTriggers(samples)).toMatchObject([{ kind: "LOW_THROUGHPUT", repo: "quiet" }]);
});

test("score deltas preserve status transitions and numeric movement", () => {
	const before = [{ kind: "mission", repo: "repo", mission: "build", status: "PASS", weighted_score: 70 }];
	const after = [{ kind: "mission", repo: "repo", mission: "build", status: "FAIL", weighted_score: 55 }];
	expect(scoreChanges(before, after)).toEqual([{ repo: "repo", mission: "build", from: { status: "PASS", weighted_score: 70 },
		to: { status: "FAIL", weighted_score: 55 }, weighted_score_delta: -15 }]);
});

test("score deltas include the fleet aggregate row", () => {
	const before = [{ kind: "overall", repo: "fleet", mission: "all", status: "PASS", weighted_score: 90 }];
	const after = [{ kind: "overall", repo: "fleet", mission: "all", status: "FAIL", weighted_score: 80 }];
	expect(scoreChanges(before, after)).toEqual([{ repo: "fleet", mission: "all", from: { status: "PASS", weighted_score: 90 },
		to: { status: "FAIL", weighted_score: 80 }, weighted_score_delta: -10 }]);
});
test("blocker trigger fires only when consecutive job blocker sets differ", () => {
	expect(differentBlockerTrigger(["repo-a"], ["repo-a"])).toBeNull();
	expect(differentBlockerTrigger(["repo-a"], ["repo-b"])).toMatchObject({ kind: "DIFFERENT_BLOCKERS", evidence: { previous_blockers: ["repo-a"], current_blockers: ["repo-b"] } });
});

test("target-stage survey emits every metric for each mission and not the aggregate row", () => {
	const rows = [{ kind: "mission", repo: "repo", mission: "build", stage: "implementation", metrics: {
		plan_present: { status: "PASS", value: true }, main_green: { status: "FAIL", value: false },
	} }, { kind: "overall", repo: "fleet", mission: "all", metrics: { main_green: { status: "PASS", value: true } } }];
	expect(targetStageSurvey(rows)).toEqual([
		{ repo: "repo", mission: "build", stage: "implementation", target: "main_green", status: "FAIL", value: false },
		{ repo: "repo", mission: "build", stage: "implementation", target: "plan_present", status: "PASS", value: true },
	]);
});

test("A11 scheduled learning writes a real fleet report instead of accepting matcher success", async () => {
	const repoRoot = resolve(import.meta.dir, "../..");
	const scratchRoot = join(repoRoot, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const home = ownedTmp("a11-consumer", { root: scratchRoot }).path;
	writeFileSync(join(home, ".owner"), `pid=${process.pid}\nlabel=a11-consumer\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`);
	const kitRoot = join(home, "release");
	for (const directory of ["release/bin", "release/config", "build-config", "build-cache", "build-data", "build-state", "build-bun"])
		mkdirSync(join(home, directory), { recursive: true });
	const fixtureEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home,
		XDG_CONFIG_HOME: join(home, "build-config"), XDG_CACHE_HOME: join(home, "build-cache"),
		XDG_DATA_HOME: join(home, "build-data"), XDG_STATE_HOME: join(home, "build-state"),
		BUN_INSTALL: join(home, "build-bun") };
	const executable = join(kitRoot, "bin", "omp-kit");
	const built = Bun.spawnSync([process.execPath, "build", join(repoRoot, "src", "cli.ts"),
		"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
		"--outfile=" + executable], { cwd: repoRoot, env: fixtureEnv, stdout: "pipe", stderr: "pipe" });
	expect(built.exitCode, built.stderr.toString()).toBe(0);
	const fixtureConfig = readFileSync(join(repoRoot, "config", "lessons.toml"), "utf8")
		.replace('mode = "shadow"', 'mode = "off"');
	writeFileSync(join(kitRoot, "config", "lessons.toml"), fixtureConfig);
	writeFileSync(join(kitRoot, "config", "planning-score.toml"), readFileSync(join(repoRoot, "config", "planning-score.toml")));
	// oq1h.7: shipped fleet lists are empty; the fixture fleet arrives via the
	// operator overlay, exactly like production. Pin XDG so no ambient overlay leaks in.
	withEnv({ XDG_CONFIG_HOME: join(home, "build-config"), OMP_KIT_FLEET_CONFIG: undefined });
	const overlayPath = join(home, "build-config", "omp-kit", "fleet.toml");
	const intakeDir = join(home, "intake");
	function writeOverlay(intake: string, repoOneTracker = intake) {
		mkdirSync(join(home, "build-config", "omp-kit"), { recursive: true });
		writeFileSync(overlayPath, `[fleet]\nintake_tracker = ${JSON.stringify(intake)}\nrepos = [\n` +
			`  { name = "a11-one", path = ${JSON.stringify(join(home, "a11-one"))}, tracker = ${JSON.stringify(repoOneTracker)} },\n` +
			`  { name = "a11-two", path = ${JSON.stringify(join(home, "a11-two"))}, tracker = ${JSON.stringify(join(home, "tracker-two"))} },\n]\n`);
	}
	writeOverlay(intakeDir);
	const config = readLessonsConfig(kitRoot, home);
	for (const repo of config.repos) {
		mkdirSync(join(repo.path, ".omp"), { recursive: true });
		const entry = { ...lesson(repo.name, "Shared fixture failure requiring a fleet intake."),
			proposed_fix: "Existing fixture remediation is recorded." };
		writeFileSync(join(repo.path, ".omp", "lessons.jsonl"), JSON.stringify(entry) + "\n");
		if (repo.trackerPath) {
			mkdirSync(repo.trackerPath, { recursive: true });
			const initialized = Bun.spawnSync(["br", "--db", join(repo.trackerPath, ".beads", "beads.db"), "init", "--prefix", "a11"], { cwd: repo.trackerPath,
				env: fixtureEnv, stdout: "pipe", stderr: "pipe" });
			expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
		}
	}
	const intakeDatabase = join(config.intakeTracker, ".beads", "beads.db");
	const seededRefs: string[] = [];
	for (let index = 0; index < 51; index++) {
		const externalRef = "fixture-existing:" + index;
		const seeded = Bun.spawnSync(["br", "--db", intakeDatabase, "--no-auto-import", "--no-auto-flush",
			"create", "--title", "Existing unrelated intake " + index, "--labels", "uphill,lesson",
			"--external-ref", externalRef, "--json"], {
			cwd: config.intakeTracker, env: fixtureEnv, stdout: "pipe", stderr: "pipe",
		});
		expect(seeded.exitCode, seeded.stderr.toString()).toBe(0);
		seededRefs.push(externalRef);
	}
	const launcher = join(home, ".local", "bin", "omp-kit");
	mkdirSync(dirname(launcher), { recursive: true });
	writeFileSync(launcher, "#!/bin/sh\nif [ \"$1\" = test ]; then printf '%s\\n' '{\"legacy_matcher\":true}'; exit 0; fi\nexec "
		+ JSON.stringify(executable) + " \"$@\"\n", { mode: 0o755 });
	const reportPath = join(home, ".local", "state", "omp-kit", "fleet-lessons", "latest.json");
	const incumbent = Bun.spawnSync([launcher, "test", "--record", "--json"], {
		cwd: home, env: fixtureEnv, stdout: "pipe", stderr: "pipe",
	});
	expect(incumbent.exitCode, incumbent.stderr.toString()).toBe(0);
	expect(JSON.parse(incumbent.stdout.toString())).toEqual({ legacy_matcher: true });
	expect(existsSync(reportPath)).toBe(false);
	async function runService(extra: Record<string, string> = {}) {
		const child = Bun.spawn([executable, "service", "run", "fleet-lessons", "--json"], {
			cwd: home, env: { ...fixtureEnv, XDG_STATE_HOME: join(home, ".local", "state"),
				PATH: LAUNCHER_TABLE + delimiter + fixtureEnv.PATH,
				OMP_KIT_LOAD_OVERRIDE: "0/1", OMP_KIT_RUN_CAP_MS: "10000", AGENT_NAME: "A11Fixture", ...extra },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { stdout, stderr, code, envelope: JSON.parse(stdout) };
	}
	const { stdout, stderr, code, envelope } = await runService();
	expect(existsSync(reportPath), `service exit=${code}\nstdout=${stdout}\nstderr=${stderr}`).toBe(true);
	const produced = JSON.parse(readFileSync(reportPath, "utf8"));
	expect(produced.schema).toBe("omp-kit.fleet-lessons/v1");
	expect(produced.classifier.status).toBe("DISABLED");
	expect(produced.survey.intake_beads).toEqual([{
		external_ref: produced.intake_plan[0].external_ref, status: "CREATED", bead_id: expect.any(String),
	}]);
	const intakeId = produced.survey.intake_beads[0].bead_id;
	const readback = Bun.spawnSync(["br", "--db", intakeDatabase, "--no-auto-import", "--no-auto-flush",
		"show", intakeId, "--json"], { cwd: config.intakeTracker, env: fixtureEnv, stdout: "pipe", stderr: "pipe" });
	expect(readback.exitCode, readback.stderr.toString()).toBe(0);
	const intake = JSON.parse(readback.stdout.toString())[0];
	expect(intake.external_ref).toBe(produced.intake_plan[0].external_ref);
	expect(intake.status).toBe("open");
	expect(intake.labels).toEqual(["lesson", "uphill"]);
	expect(intake.description).toContain("Shared fixture failure requiring a fleet intake.");
	for (const repo of config.repos) {
		expect(intake.description).toContain(repo.name);
		if (!repo.trackerPath || repo.trackerPath === config.intakeTracker) continue;
		const foreign = Bun.spawnSync(["br", "--db", join(repo.trackerPath, ".beads", "beads.db"),
			"--no-auto-import", "--no-auto-flush", "list", "--status", "all", "--limit", "0", "--json"], {
			cwd: repo.trackerPath, env: fixtureEnv, stdout: "pipe", stderr: "pipe",
		});
		expect(foreign.exitCode, foreign.stderr.toString()).toBe(0);
		expect(JSON.parse(foreign.stdout.toString()).issues).toEqual([]);
	}
	// These fixture repos deliberately have no planning inputs; a created intake is not a healthy planning score.
	expect(produced.run_status).toBe("BLOCKED");
	expect(produced.blockers).toEqual(["planning-score-unavailable"]);
	expect(envelope.data.receipt.exit).toBe(1);
	expect(envelope.data.receipt.status).toBe("FAILED");
	expect(code).toBe(1);

	const replay = await runService();
	const replayReport = JSON.parse(readFileSync(reportPath, "utf8"));
	expect(replay.code).toBe(1);
	expect(replayReport.blockers).toEqual(["planning-score-unavailable"]);
	expect(replayReport.intake_plan).toEqual([]);
	expect(replayReport.survey.intake_beads).toEqual([]);
	const inventory = Bun.spawnSync(["br", "--db", intakeDatabase, "--no-auto-import", "--no-auto-flush",
		"list", "--status", "all", "--limit", "0", "--json"], {
		cwd: config.intakeTracker, env: fixtureEnv, stdout: "pipe", stderr: "pipe",
	});
	expect(inventory.exitCode, inventory.stderr.toString()).toBe(0);
	expect(JSON.parse(inventory.stdout.toString()).issues.map((issue: { external_ref: string }) => issue.external_ref).sort())
		.toEqual([...seededRefs, intake.external_ref].sort());

	const unregisteredRoot = join(home, "not-registered");
	mkdirSync(unregisteredRoot, { recursive: true });
	const unregisteredDatabase = join(unregisteredRoot, ".beads", "beads.db");
	const initializedOutside = Bun.spawnSync(["br", "--db", unregisteredDatabase, "init", "--prefix", "outside"], {
		cwd: unregisteredRoot, env: fixtureEnv, stdout: "pipe", stderr: "pipe",
	});
	expect(initializedOutside.exitCode, initializedOutside.stderr.toString()).toBe(0);
	const beforeOutside = readFileSync(reportPath, "utf8");
	writeOverlay(unregisteredRoot, intakeDir);
	const refusedOutside = await runService();
	expect(refusedOutside.code).toBe(1);
	expect(refusedOutside.envelope.data.receipt.status).toBe("FAILED");
	expect(readFileSync(reportPath, "utf8")).toBe(beforeOutside);
	const outsideInventory = Bun.spawnSync(["br", "--db", unregisteredDatabase, "--no-auto-import", "--no-auto-flush",
		"list", "--status", "all", "--limit", "0", "--json"], {
		cwd: unregisteredRoot, env: fixtureEnv, stdout: "pipe", stderr: "pipe",
	});
	expect(outsideInventory.exitCode, outsideInventory.stderr.toString()).toBe(0);
	expect(JSON.parse(outsideInventory.stdout.toString()).issues).toEqual([]);
	expect(existsSync(join(home, ".local", "state", "omp-kit", "jobs", "fleet-lessons.lock"))).toBe(false);
	writeOverlay(intakeDir);

	const beforeRefusal = readFileSync(reportPath, "utf8");
	const refused = await runService({ OMP_KIT_FLEET_LESSONS_CLAIM: "not-a-current-keeper" });
	expect(refused.code).toBe(2);
	expect(refused.envelope.errors[0].code).toBe("FLEET_LESSONS_KEEPER_CHANGED");
	expect(readFileSync(reportPath, "utf8")).toBe(beforeRefusal);

	writeFileSync(join(config.repos[0]!.path, ".omp", "lessons.jsonl"), "invalid lesson JSON\n");
	const failed = await runService();
	const failedReport = JSON.parse(readFileSync(reportPath, "utf8"));
	expect(failedReport.run_status).toBe("BLOCKED");
	expect(failedReport.blockers).toContain("repo-log-invalid:" + config.repos[0]!.name);
	expect(failed.code).toBe(1);
	expect(failed.envelope.data.receipt.exit).toBe(1);
	expect(failed.envelope.data.receipt.status).toBe("FAILED");
	expect(existsSync(join(home, ".local", "state", "omp-kit", "jobs", "fleet-lessons.lock"))).toBe(false);

	const beforeTimeout = readFileSync(reportPath, "utf8");
	const timed = await runService({ OMP_KIT_RUN_CAP_MS: "1" });
	expect(timed.code).toBe(1);
	expect(timed.envelope.data.status).toBe("TIMEOUT");
	expect(timed.envelope.data.receipt.status).toBe("TIMEOUT");
	expect(readFileSync(reportPath, "utf8")).toBe(beforeTimeout);
	expect(existsSync(join(home, ".local", "state", "omp-kit", "jobs", "fleet-lessons.lock"))).toBe(false);
}, 60000);

test("fleet producer refuses an intake tracker outside its registered repositories before effects", () => {
	const repoRoot = resolve(import.meta.dir, "../..");
	const scratchRoot = join(repoRoot, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const home = ownedTmp("a11-intake", { root: scratchRoot }).path;
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	writeFileSync(join(home, ".owner"), `pid=${process.pid}\nlabel=a11-intake\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`);
	const kitRoot = join(home, "kit");
	mkdirSync(join(kitRoot, "config"), { recursive: true });
	writeFileSync(join(kitRoot, "config", "lessons.toml"), configText.replace(
		'intake_tracker = "~/Developer/omp-kit"', 'intake_tracker = "~/unregistered-intake"'));
	const stateRoot = join(home, "state");
	expect(() => runFleetLessonsOnce({ kitRoot, home, stateRoot }, {
		planningScore: () => { throw new Error("unexpected planning work"); },
		tracker: () => { throw new Error("unexpected tracker work"); },
	})).toThrow("FLEET_LESSONS_INTAKE_NOT_REGISTERED");
	expect(existsSync(stateRoot)).toBe(false);
	expect(existsSync(join(home, "unregistered-intake"))).toBe(false);
});

test("a fleet lessons OFF transition before child execution is no-run, not a success receipt", async () => {
	const kitRoot = resolve(import.meta.dir, "../..");
	const scratchRoot = join(kitRoot, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const home = ownedTmp("a11-off-race", { root: scratchRoot }).path;
	writeFileSync(join(home, ".owner"), `pid=${process.pid}\nlabel=a11-off-race\nrepo=${kitRoot}\ncreated=${new Date().toISOString()}\n`);
	const launcher = join(home, ".local", "bin", "omp-kit");
	mkdirSync(dirname(launcher), { recursive: true });
	writeFileSync(launcher, "#!/bin/sh\nprintf '%s\\n' 'race-injected' > "
		+ JSON.stringify(join(home, ".local", "state", "omp-kit", "fleet-lessons.off"))
		+ "\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(join(kitRoot, "src", "cli.ts")) + " \"$@\"\n", { mode: 0o755 });
	const child = Bun.spawn([process.execPath, join(kitRoot, "src", "cli.ts"), "service", "run", "fleet-lessons", "--json"], {
		cwd: home, env: { ...process.env, HOME: home, TMPDIR: home, XDG_STATE_HOME: join(home, ".local", "state"),
			PATH: LAUNCHER_TABLE + delimiter + (process.env.PATH ?? "/usr/bin:/bin"),
			OMP_KIT_LOAD_OVERRIDE: "0/1", OMP_KIT_RUN_CAP_MS: "10000", AGENT_NAME: "A11OffFixture" },
		stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect(code, stderr).toBe(0);
	const envelope = JSON.parse(stdout);
	expect(envelope.data.status).toBe("OFF");
	expect(envelope.data.reason).toBe("race-injected");
	expect(envelope.data.receipt).toBeUndefined();
	const state = join(home, ".local", "state", "omp-kit");
	expect(existsSync(join(state, "jobs", "fleet-lessons.json"))).toBe(false);
	expect(existsSync(join(state, "jobs", "fleet-lessons.lock"))).toBe(false);
	expect(existsSync(join(state, "fleet-lessons", "latest.json"))).toBe(false);
}, 30000);

test("a capped producer group leaves no active nested process after timeout", async () => {
	const kitRoot = resolve(import.meta.dir, "../..");
	const scratchRoot = join(kitRoot, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = ownedTmp("a11-descendant", { root: scratchRoot }).path;
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=a11-descendant\nrepo=${kitRoot}\ncreated=${new Date().toISOString()}\n`);
	const marker = join(scratch, "descendant.pid");
	const result = await runWithCap({
		argv: ["/bin/sh", "-c", "sleep 60 & kid=$!; printf '%s\\n' \"$kid\" > " + JSON.stringify(marker) + "; wait \"$kid\""],
		cwd: scratch, env: { PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: scratch },
		capMs: 300, exec: bunCapExec(),
	});
	const pid = Number(readFileSync(marker, "utf8").trim());
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Owned descendant PID was not recorded");
	const state = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "pipe" });
	const active = state.exitCode === 0 && !state.stdout.toString().trim().startsWith("Z");
	try {
		expect(result.status).toBe("TIMEOUT");
		expect(active, `owned descendant ${pid} remains ${state.stdout.toString()}`).toBe(false);
	} finally {
		if (active) {
			try { process.kill(pid, "SIGKILL"); } catch { /* only our recorded descendant, already exited */ }
		}
	}
}, 10000);

test.each([
	{ name: "malformed row", inventory: [null] },
	{ name: "partial page", inventory: { issues: [], total: 1, offset: 0, has_more: true } },
	{ name: "unknown inventory", inventory: { unexpected: [] } },
])("fleet intake holds native writes for $name", ({ inventory }) => {
	const repoRoot = resolve(import.meta.dir, "../..");
	const scratchRoot = join(repoRoot, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const home = ownedTmp("a11-inventory", { root: scratchRoot }).path;
	withEnv({ XDG_CONFIG_HOME: join(home, "xdg"), OMP_KIT_FLEET_CONFIG: undefined });
	writeFileSync(join(home, ".owner"), `pid=${process.pid}\nlabel=a11-inventory\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`);
	const kitRoot = join(home, "kit");
	mkdirSync(join(kitRoot, "config"), { recursive: true });
	writeFileSync(join(kitRoot, "config", "lessons.toml"), configText.replace('mode = "shadow"', 'mode = "off"'));
	const config = readLessonsConfig(kitRoot, home);
	for (const repo of config.repos) {
		mkdirSync(join(repo.path, ".omp"), { recursive: true });
		writeFileSync(join(repo.path, ".omp", "lessons.jsonl"), JSON.stringify({
			...lesson(repo.name, "Do not create intake from an untrustworthy inventory."),
			proposed_fix: "An existing remediation is recorded.",
		}) + "\n");
	}
	const database = join(config.intakeTracker, ".beads", "beads.db");
	mkdirSync(config.intakeTracker, { recursive: true });
	const env = { ...process.env, HOME: home, TMPDIR: home };
	const initialized = Bun.spawnSync(["br", "--db", database, "init", "--prefix", "a11"], {
		cwd: config.intakeTracker, env, stdout: "pipe", stderr: "pipe",
	});
	expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
	const produced = runFleetLessonsOnce({ kitRoot, home, stateRoot: join(home, "state") }, {
		tracker: (path, args) => {
			if (args[0] === "list") return { code: 0, stdout: JSON.stringify(inventory), stderr: "" };
			const result = Bun.spawnSync(["br", "--db", path, "--no-auto-import", "--no-auto-flush", ...args], {
				cwd: config.intakeTracker, env, stdout: "pipe", stderr: "pipe",
			});
			return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		},
	});
	const readback = Bun.spawnSync(["br", "--db", database, "--no-auto-import", "--no-auto-flush",
		"list", "--status", "all", "--limit", "0", "--json"], {
		cwd: config.intakeTracker, env, stdout: "pipe", stderr: "pipe",
	});
	expect(readback.exitCode, readback.stderr.toString()).toBe(0);
	expect(JSON.parse(readback.stdout.toString()).issues).toEqual([]);
	expect(produced.report.blockers).toContain("intake-tracker-list-invalid");
	expect(produced.report.classifier.status).toBe("DISABLED");
});

test("service bodies refuse unsupported jobs while omp-watch still executes the native matcher", async () => {
	const repoRoot = resolve(import.meta.dir, "../..");
	const scratchRoot = join(repoRoot, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const home = ownedTmp("a11-service-bodies", { root: scratchRoot }).path;
	writeFileSync(join(home, ".owner"), `pid=${process.pid}\nlabel=a11-service-bodies\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`);
	const release = join(home, "release");
	mkdirSync(join(release, "bin"), { recursive: true });
	const selected = resolveOmpIdentity(process.env);
	const packageMetadata = JSON.parse(readFileSync(join(selected.packageRoot, "package.json"), "utf8"));
	if (typeof packageMetadata.bin?.omp !== "string") throw new Error("real OMP package declares no omp executable");
	const identityBin = join(home, "omp-identity-bin");
	mkdirSync(identityBin, { recursive: true });
	// A host wrapper can depend on HOME. Pin the same real package's declared executable instead.
	symlinkSync(resolve(selected.packageRoot, packageMetadata.bin.omp), join(identityBin, "omp"));
	const fixturePath = identityBin + delimiter + (process.env.PATH ?? "/usr/bin:/bin");
	const identity = resolveOmpIdentity({ PATH: fixturePath });
	const env = { PATH: fixturePath, HOME: home, TMPDIR: home,
		XDG_CONFIG_HOME: join(home, "build-config"), XDG_CACHE_HOME: join(home, "build-cache"),
		XDG_DATA_HOME: join(home, "build-data"), XDG_STATE_HOME: join(home, ".local", "state"),
		BUN_INSTALL: join(home, "build-bun"),
		OMP_KIT_CASE_CWD: process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || repoRoot,
		OMP: identity.launcher, OMP_BIN: identity.launcher, OMP_PATH: identity.launcher, OMP_SRC: identity.source };
	// Package only runtime assets, as the matcher fixtures do; an archive has no Git HEAD.
	for (const directory of ["rules", "retired", "cases", "policy", "extensions"]) {
		cpSync(join(repoRoot, directory), join(release, directory), { recursive: true });
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["build-manifest.sh", "kitlib-tmp.sh", "runtime-adapter.sh", "rule-class.ts"]) {
		cpSync(join(repoRoot, "scripts", file), join(release, "scripts", file));
	}
	writeBundledHarness(release);
	const executable = join(release, "bin", "omp-kit");
	const built = Bun.spawnSync([process.execPath, "build", join(repoRoot, "src", "cli.ts"),
		"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
		"--outfile=" + executable], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
	expect(built.exitCode, built.stderr.toString()).toBe(0);
	const manifest = Bun.spawnSync(["sh", join(release, "scripts", "build-manifest.sh"), "--stdout"], {
		cwd: home, env, stdout: "pipe", stderr: "pipe",
	});
	expect(manifest.exitCode, manifest.stderr.toString()).toBe(0);
	writeFileSync(join(release, "MANIFEST.tsv"), manifest.stdout);
	writeReleaseManifest(release);
	const launcher = join(home, ".local", "bin", "omp-kit");
	const matcherOutput = join(home, "matcher-output.json");
	mkdirSync(dirname(launcher), { recursive: true });
	const preload = join(home, "register-fixture-job.ts");
	// Exercise a genuinely missing body without pretending an implemented job is unsupported.
	writeFileSync(preload, "import { KNOWN_JOBS } from " + JSON.stringify(join(repoRoot, "src", "service.ts"))
		+ ';\nKNOWN_JOBS["fixture-unimplemented"] = { name: "fixture-unimplemented", label: "com.omp-kit.fixture-unimplemented", kind: "interval", intervalSeconds: 60, runAtLoad: false };\n');
	writeFileSync(launcher, "#!/bin/sh\n" + JSON.stringify(executable) + " \"$@\" > " + JSON.stringify(matcherOutput)
		+ "\nchild_rc=$?\ncat " + JSON.stringify(matcherOutput) + "\nexit \"$child_rc\"\n", { mode: 0o755 });
	async function runJob(job: string) {
		const child = Bun.spawn([process.execPath, "--preload", preload, join(repoRoot, "src", "cli.ts"), "service", "run", job, "--json"], {
			cwd: home, env: { ...env, PATH: LAUNCHER_TABLE + delimiter + fixturePath,
				OMP_KIT_LOAD_OVERRIDE: "0/1", OMP_KIT_RUN_CAP_MS: "60000", AGENT_NAME: "A11BodyFixture" },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr, envelope: JSON.parse(stdout) };
	}
	for (const [job, error] of [["not-a-job", "UNKNOWN_JOB"], ["fixture-unimplemented", "SERVICE_BODY_UNIMPLEMENTED"]] as const) {
		const refused = await runJob(job);
		expect(refused.code, refused.stderr).toBe(2);
		expect(refused.envelope.errors[0].code).toBe(error);
		expect(existsSync(matcherOutput)).toBe(false);
		expect(existsSync(join(home, ".local", "state", "omp-kit", "jobs", job + ".lock"))).toBe(false);
	}
	const watched = await runJob("omp-watch");
	expect(existsSync(matcherOutput), watched.stdout + "\n" + watched.stderr).toBe(true);
	const matcher = JSON.parse(readFileSync(matcherOutput, "utf8")).data.test;
	expect(matcher.proofs.G1_registration.status, JSON.stringify(matcher.blocker)).toBe("PASS");
	expect(matcher.proofs.G2_payload.status).toBe("PASS");
	expect(matcher.proofs.G3_quiet_prefix.status).toBe("PASS");
	const receipt = JSON.parse(readFileSync(join(home, ".local", "state", "omp-kit", "last-test.json"), "utf8"));
	expect(receipt).toMatchObject({ scope: "fast", status: matcher.status });
	expect(watched.envelope.data.receipt.exit).toBe(matcher.exitCode);
	expect(watched.code).toBe(matcher.exitCode === 0 ? 0 : 1);
}, 90000);

afterAll(() => cleanupAllOwnedTmp());
