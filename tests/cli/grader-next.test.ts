import { resolve } from "node:path";
import { run as runBounded } from "../../src/kitlib/run";
import { describe, expect, test } from "bun:test";
import { chooseGraderNext, formatGraderSelection, validatePriorArtComment, type GraderCandidate, type GraderQueue, type QueueObservation } from "../../src/grader-next.ts";
const entry = resolve(import.meta.dir, "../../src/cli.ts");

function known<T>(value: T, source = "fixture"): QueueObservation<T> { return { status: "KNOWN", source, value }; }
const unknown = (source: string, reason = "unavailable"): QueueObservation<never> => ({ status: "UNKNOWN", source, reason });
const candidate = (id: string, overrides: Partial<GraderCandidate> = {}): GraderCandidate => ({
	id, title: id, author: "Other", assignee: null, priority: 2, skillStep: "inspect and repair the reported condition", exportSha: "a1b2c3d", ...overrides,
});
const queue = (overrides: Partial<GraderQueue> = {}): GraderQueue => ({
	gradable: known([]),
	cutAdmission: known({ cut: [], failures: [] }),
	gaps: known([]),
	downtime: known([]),
	...overrides,
});

describe("grader next fixed priority", () => {
	test("selects the highest-priority eligible gradable bead and excludes authored or assigned work", () => {
		const selected = chooseGraderNext("Grader", "/repo", queue({
			gradable: known([
				candidate("mine", { author: "Grader", priority: 0 }),
				candidate("assigned", { assignee: "Grader", priority: 0 }),
				candidate("later", { priority: 2 }),
				candidate("first", { priority: 1 }),
			]),
			cutAdmission: known({ cut: ["cut-fail"], failures: [candidate("cut-fail")] }),
		}));

		expect(selected.status).toBe("ACTION");
		if (selected.status !== "ACTION") throw Error("expected a selected action");
		expect(selected.action).toMatchObject({ step: 1, bead: "first", marker: null, research: null });
		expect(selected.action.command).toContain("omp-kit verify 'first' --export 'a1b2c3d'");
	});

	test("fails closed when candidate authorship is unknown at every priority", () => {
		const selected = chooseGraderNext("Grader", "/repo", queue({
			gradable: known([candidate("unknown-gradable", { author: null })]),
			cutAdmission: known({ cut: ["unknown-cut"], failures: [candidate("unknown-cut", { author: null })] }),
			gaps: known([candidate("unknown-gap", { author: null, cost: 10 })]),
			downtime: known([candidate("unknown-chore", { author: null })]),
		}));

		expect(selected).toEqual({ status: "EMPTY", reason: "all priority classes are known and empty" });
	});

	test("routes an idle grader to a failing-admission bead inside the declared nonempty cut", () => {
		const selected = chooseGraderNext("Grader", "/repo", queue({
			cutAdmission: known({ cut: ["cut-fail"], failures: [candidate("outside"), candidate("cut-fail")] }, "BACKLOGMIG1"),
			gaps: known([candidate("expensive-gap", { cost: 500 })]),
		}));

		expect(selected.status).toBe("ACTION");
		if (selected.status !== "ACTION") throw Error("expected a selected action");
		expect(selected.action).toMatchObject({ step: 2, bead: "cut-fail", marker: null, research: null });
		expect(selected.action.command).toContain("omp-kit preflight claim 'cut-fail'");
	});

	test("a known empty cut skips admission failures and selects the top-cost unowned gap", () => {
		const selected = chooseGraderNext("Grader", "/repo", queue({
			cutAdmission: known({ cut: [], failures: [candidate("not-in-cut")] }, "BACKLOGMIG1"),
			gaps: known([
				candidate("assigned-gap", { cost: 100, assignee: "Other" }),
				candidate("authored-gap", { cost: 90, author: "Grader" }),
				candidate("lower-cost", { cost: 10 }),
				candidate("top-cost", { cost: 50 }),
			]),
		}));

		expect(selected.status).toBe("ACTION");
		if (selected.status !== "ACTION") throw Error("expected a selected action");
		expect(selected.action).toMatchObject({ step: 3, bead: "top-cost", marker: "grader-next-step-3" });
		expect(selected.action.research).toContain("prior=<url#Lx-Ly>");
		expect(selected.action.command).toContain("--add-label 'grader-next-step-3'");
	});

	test("downtime chores are the fourth rung and still require a prior-art step", () => {
		const selected = chooseGraderNext("Grader", "/repo", queue({ downtime: known([candidate("flake-triage")]) }));

		expect(selected.status).toBe("ACTION");
		if (selected.status !== "ACTION") throw Error("expected a selected action");
		expect(selected.action).toMatchObject({ step: 4, bead: "flake-triage", marker: "grader-next-step-4" });
		expect(selected.action.research).toContain("nothing-found");
		expect(selected.action.command).toContain("--add-label 'grader-next-step-4'");
	});

	test("an unknown higher-priority source blocks lower-rung recommendations", () => {
		const selected = chooseGraderNext("Grader", "/repo", queue({
			gradable: unknown("grade_wave.py", "not installed"),
			cutAdmission: known({ cut: ["cut-fail"], failures: [candidate("cut-fail")] }),
		}));

		expect(selected).toEqual({ status: "UNKNOWN", source: "grade_wave.py", reason: "not installed" });
	});
	test("prints every unavailable source and preserves failures without returning an empty queue", () => {
		const sources = queue({
			gradable: unknown("grade_wave.py", "not installed"),
			cutAdmission: { status: "FAILED", source: "fleet-seat-cut", reason: "tracker read failed" },
			gaps: known([]),
			downtime: { status: "FAILED", source: "downtime", reason: "producer unavailable" },
		});
		const selected = chooseGraderNext("Grader", "/repo", sources);

		expect(selected).toEqual({ status: "UNKNOWN", source: "grade_wave.py", reason: "not installed" });
		expect(formatGraderSelection(selected, sources)).toContain("UNKNOWN grade_wave.py: not installed");
		expect(formatGraderSelection(selected, sources)).toContain("FAILED fleet-seat-cut: tracker read failed");
		expect(formatGraderSelection(selected, sources)).toContain("FAILED downtime: producer unavailable");
	});
	test("a failed higher-priority source blocks lower-rung actions", () => {
		const sources = queue({
			gradable: known([]),
			cutAdmission: { status: "FAILED", source: "fleet-seat-cut", reason: "tracker read failed" },
			gaps: known([candidate("expensive-gap", { cost: 100 })]),
		});
		const selected = chooseGraderNext("Grader", "/repo", sources);

		expect(selected).toEqual({ status: "FAILED", source: "fleet-seat-cut", reason: "tracker read failed" });
		expect(formatGraderSelection(selected, sources)).toContain("FAILED fleet-seat-cut: tracker read failed");
	});

	test("returns EMPTY only when all four queue sources are known and empty", () => {
		expect(chooseGraderNext("Grader", "/repo", queue())).toEqual({ status: "EMPTY", reason: "all priority classes are known and empty" });
	});
});

test("nested grader next uses its handler and preserves unavailable inputs as UNKNOWN", async () => {
	const p = await runBounded([process.execPath, entry, "grader", "next", "--repo", "/repo", "--agent", "Grader", "--json"], {
		deadline_s: 15,
		env: { ...process.env, NO_COLOR: "1", CI: "true", TERM: "dumb" },
	});
	const stdout = new TextDecoder().decode(p.stdout);
	const result = JSON.parse(stdout);
	expect(p.rc).toBe(3);
	expect(result.errors[0].code).toBe("UNKNOWN");
	expect(result.data.status).toBe("UNKNOWN");
	expect(result.data.next_action).toBeNull();
	const sources = result.data.unknown_sources.map((source: { source: string }) => source.source);
	for (const source of ["BACKLOGMIG1", "cc.py gaps", "scratch plan gap report", "PySafe findings", "bead_lint_backlog", "sitrep dirt/no_fix", "downtime chores"]) {
		expect(sources).toContain(source);
	}
});

describe("PRIORART queue close evidence", () => {
	test("PRIORART refuses a docs-only citation", () => {
		const verdict = validatePriorArtComment("prior=https://github.com/acme/tool/blob/main/docs/guide.md#L12-L18 did=Explain the practice applied=Use the practice quoted=This guide describes it");
		expect(verdict.status).toBe("REFUSED");
	});

	test("PRIORART admits a public source-code citation with a line range and quoted implementation", () => {
		const verdict = validatePriorArtComment("prior=https://github.com/JYeswak/omp-kit-companion/blob/main/src/next.ts#L120-L151 did=Sort beads by priority and stable id applied=Reuse explicit ordering for grader actions quoted=const sorted = [...issues].sort((a, b) => Number(a.priority ?? 4) - Number(b.priority ?? 4) || String(a.id).localeCompare(String(b.id)));");
		expect(verdict.status).toBe("CODE");
	});

	test("PRIORART refuses code URLs without quoted source lines", () => {
		const verdict = validatePriorArtComment("prior=https://github.com/acme/tool/blob/main/src/queue.ts#L12-L18 did=Sort candidates applied=Reuse ordering");
		expect(verdict.status).toBe("REFUSED");
	});

	test("PRIORART rejects unsafe line-range integers", () => {
		const verdict = validatePriorArtComment("prior=https://github.com/acme/tool/blob/main/src/queue.ts#L9007199254740993-L9007199254740993 did=Sort candidates applied=Reuse ordering quoted=const items = [];");
		expect(verdict.status).toBe("REFUSED");
	});

	test("PRIORART accepts nothing-found only with repositories, queries, and applied work", () => {
		const admitted = validatePriorArtComment("prior=nothing-found repos=repo-a,repo-b queries=\"queue selection\",\"grader prior art\" did=nothing-found after source searches applied=Implement the bounded selector and retain the search record");
		const refused = validatePriorArtComment("prior=nothing-found did=nothing-found applied=Implement a selector");
		expect(admitted.status).toBe("NOTHING_FOUND");
		expect(refused.status).toBe("REFUSED");
	});
});
