import { describe, expect, test } from "bun:test";
import { declaredMilestonePins, gradableCandidates, type GraderSourceRuntime } from "../../../src/grader-next-sources/gradable.ts";
import type { RunResult } from "../../../src/kitlib/run.ts";

const result = (text = "", overrides: Partial<RunResult> = {}): RunResult => ({
	rc: 0, timed_out: false, killed: false, stdout: new TextEncoder().encode(text), stderr: new Uint8Array(),
	truncated: false, elapsed_s: 0, total_truncated: false, captured_bytes: text.length, streamed_bytes: 0,
	stream_dropped_bytes: 0, sink_error: null, ...overrides,
});
const admission = (pins: string[]) => ({
	gradable: pins,
	items: pins.map(bead => ({ bead, gradable: true, code: "ADMITTED", detail: "admitted", subjects: [{ commit: "a1b2c3d", repo: "/repo", landing_ref: "origin/main" }] })),
	installed_kit: "0.2.80",
});
const tracker = (pins: string[]) => pins.map(id => ({ id, title: `Bead ${id}`, created_by: "Director", assignee: null, priority: 1, status: "in_review" }));
const runtime = (grade = admission(["A"]), beads = tracker(["A"]), options: { gradeResult?: RunResult; trackerResult?: RunResult; scriptExists?: boolean; scriptConfigured?: boolean } = {}): GraderSourceRuntime => ({
	home: "/home/test",
	env: { OMP_KIT_GRADE_WAVE: options.scriptConfigured === false ? undefined : "/opt/omp-kit/grade_wave.py" },
	exists: () => options.scriptExists ?? true,
	readText: async () => JSON.stringify({ sessions: [] }),
	realpath: path => path,
	which: () => "/usr/bin/tool",
	run: async argv => argv[0] === "python3"
		? options.gradeResult ?? result(JSON.stringify(grade))
		: options.trackerResult ?? result(JSON.stringify(beads)),
});

describe("gradable milestone source", () => {
	test("an unconfigured grade-wave producer is UNKNOWN instead of a host-specific path fallback", async () => {
		const source = runtime(admission(["A"]), tracker(["A"]), { scriptConfigured: false });
		source.run = async () => { throw new Error("unconfigured producer must not run"); };
		expect(await gradableCandidates("/repo", "Worker", ["A"], source)).toMatchObject({
			status: "UNKNOWN", source: "OMP_KIT_GRADE_WAVE",
		});
	});
	test("uses the exact matching repo pins and preserves a known empty pin set", async () => {
		const source = runtime();
		source.readText = async () => JSON.stringify({ sessions: [
			{ repo: "/other", milestone: { pinned: ["X"] } },
			{ repo: "/repo", milestone: { pinned: ["B", "A", "A"] } },
		] });
		expect(await declaredMilestonePins("/repo", source)).toMatchObject({ status: "OK", rows: ["A", "B"] });
		source.readText = async () => JSON.stringify({ sessions: [] });
		expect(await declaredMilestonePins("/repo", source)).toMatchObject({ status: "OK", rows: [] });
	});

	test("unreadable or incomplete fleet-watch pins do not become empty", async () => {
		const source = runtime();
		source.readText = async () => { throw new Error("permission denied"); };
		expect((await declaredMilestonePins("/repo", source)).status).toBe("UNKNOWN");
		source.readText = async () => JSON.stringify({ sessions: [{ repo: "/repo", milestone: {} }] });
		expect((await declaredMilestonePins("/repo", source)).status).toBe("FAILED");
	});

	test("a known empty pin set returns an empty queue without running producers", async () => {
		const source = runtime(admission([]), tracker([]), { scriptExists: false });
		source.run = async () => { throw new Error("empty pin set must not run producers"); };
		expect(await gradableCandidates("/repo", "Worker", [], source)).toEqual({
			status: "OK", source: "grade_wave.py gradable + br show (0 pins)", rows: [],
		});
	});

	test("does not treat malformed pin coverage as an empty gradable queue", async () => {
		const source = runtime({ gradable: [], items: [], installed_kit: "0.2.80" });
		const result = await gradableCandidates("/repo", "Worker", ["A"], source);
		expect(result.status).toBe("FAILED");
	});

	test("joins complete grade-wave admission to exact tracker rows", async () => {
		const result = await gradableCandidates("/repo", "Worker", ["A"], runtime());
		expect(result).toMatchObject({ status: "OK", rows: [{ id: "A", author: "Director", exportSha: "a1b2c3d", skillStep: "non-author bead review" }] });
	});
	test("runs the configured grade-wave producer path", async () => {
		const source = runtime();
		source.run = async argv => {
			if (argv[0] === "python3") {
				expect(argv.slice(0, 3)).toEqual(["python3", "-B", "/opt/omp-kit/grade_wave.py"]);
				return result(JSON.stringify(admission(["A"])));
			}
			return result(JSON.stringify(tracker(["A"])));
		};
		expect((await gradableCandidates("/repo", "Worker", ["A"], source)).status).toBe("OK");
	});

	test("reports command refusal, malformed, missing, and truncated producers without empty fallback", async () => {
		const refused = runtime(admission(["A"]), tracker(["A"]), { gradeResult: result("", { rc: 2, stderr: new TextEncoder().encode("REFUSED BAD_INPUT") }) });
		const validEmpty = runtime({ gradable: [], items: [{ bead: "A", gradable: false, code: "OWN_BEAD", detail: "not eligible for this grader" }], installed_kit: "0.2.80" }, tracker(["A"]));
		const missing = runtime(admission(["A"]), tracker(["A"]), { scriptExists: false });
		const truncated = runtime(admission(["A"]), tracker(["A"]), { gradeResult: result("", { truncated: true }) });
		const malformed = runtime({ gradable: ["A"], items: [{ bead: "A", gradable: true, code: "ADMITTED", detail: "admitted" }], installed_kit: "0.2.80" });
		const missingTracker = runtime(admission(["A"]), []);
		expect((await gradableCandidates("/repo", "Worker", ["A"], refused)).status).toBe("FAILED");
		expect(await gradableCandidates("/repo", "Worker", ["A"], validEmpty)).toMatchObject({ status: "OK", rows: [] });
		expect((await gradableCandidates("/repo", "Worker", ["A"], missing)).status).toBe("UNKNOWN");
		expect((await gradableCandidates("/repo", "Worker", ["A"], truncated)).status).toBe("UNKNOWN");
		expect((await gradableCandidates("/repo", "Worker", ["A"], malformed)).status).toBe("FAILED");
		expect((await gradableCandidates("/repo", "Worker", ["A"], missingTracker)).status).toBe("FAILED");
	});
});
