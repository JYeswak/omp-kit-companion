import { expect, test } from "bun:test";
import type { LessonEntry } from "../../src/lessons.ts";
import { buildFleetLessonsReport, differentBlockerTrigger, gradeFailureRunIds, lowThroughputTriggers, parseLessonsConfig, runClefShadow, scoreChanges, targetStageSurvey, type ClefClassifierConfig, type FleetHourlySample } from "../../src/fleet-lessons.ts";

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
