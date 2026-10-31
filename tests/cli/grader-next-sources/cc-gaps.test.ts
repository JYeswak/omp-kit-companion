import { describe, expect, test } from "bun:test";
import { ccGapCandidates } from "../../../src/grader-next-sources/cc-gaps.ts";
import type { GraderSourceRuntime } from "../../../src/grader-next-sources/gradable.ts";
import type { RunResult } from "../../../src/kitlib/run.ts";

const result = (text = "", overrides: Partial<RunResult> = {}): RunResult => ({
	rc: 0, timed_out: false, killed: false, stdout: new TextEncoder().encode(text), stderr: new Uint8Array(),
	truncated: false, elapsed_s: 0, total_truncated: false, captured_bytes: text.length, streamed_bytes: 0,
	stream_dropped_bytes: 0, sink_error: null, ...overrides,
});
const gaps = (rows: unknown[]) => JSON.stringify({ schema_version: "cc-view/v1", view: "v_gaps", gaps: {
	state: rows.length ? "open" : "closed", count: rows.length, rows,
} });
const gapRow = (id: string, cost = 2) => ({ fix_link: id, cost_state: "VALUE", cost_hours_day: cost, state: "open" });
const tracker = (ids: string[]) => JSON.stringify(ids.map(id => ({ id, title: `Gap ${id}`, created_by: "Other", assignee: null, priority: 1, status: "open" })));
const runtime = (ccOutput = gaps([gapRow("gap-1")]), brOutput = tracker(["gap-1"]), options: { ccExists?: boolean; ccResult?: RunResult; brResult?: RunResult } = {}): GraderSourceRuntime => ({
	home: "/home/test", exists: () => false, readText: async () => "", realpath: path => path,
	which: command => command === "cc.py" ? (options.ccExists === false ? null : "/opt/omp-kit/scripts/cc/cc.py")
		: command === "python3" ? "/usr/bin/python3" : command === "br" ? "/usr/bin/br" : null,
	run: async argv => argv[3] === "gaps" ? options.ccResult ?? result(ccOutput) : options.brResult ?? result(brOutput),
});

describe("CC gap source", () => {
	test("maps complete measured rows to exact open beads and preserves comparable costs", async () => {
		const output = await ccGapCandidates("/repo", runtime(gaps([gapRow("gap-1", 9), gapRow("gap-2", 3)]), tracker(["gap-1", "gap-2"])));
		expect(output).toMatchObject({ status: "OK", rows: [
			{ id: "gap-1", cost: 9, author: "Other", assignee: null, title: "Gap gap-1" },
			{ id: "gap-2", cost: 3, author: "Other", assignee: null, title: "Gap gap-2" },
		] });
	});

	test("only a complete closed report is a known empty queue", async () => {
		expect(await ccGapCandidates("/repo", runtime(gaps([]), "[]"))).toMatchObject({ status: "OK", rows: [] });
		const unknownView = JSON.stringify({ gaps: { state: "UNKNOWN", count: 0, rows: [] } });
		expect((await ccGapCandidates("/repo", runtime(unknownView))).status).toBe("UNKNOWN");
	});

	test("missing producer, missing bead mapping, and non-comparable cost never become empty", async () => {
		const absent = runtime(gaps([]), "[]", { ccExists: false });
		const unmapped = runtime(gaps([{ ...gapRow("gap-1"), fix_link: null }]), tracker(["gap-1"]));
		const unpriced = runtime(gaps([{ fix_link: "gap-1", cost_state: "UNKNOWN", cost_hours_day: null, state: "open" }]), tracker(["gap-1"]));
		expect((await ccGapCandidates("/repo", absent)).status).toBe("UNKNOWN");
		expect((await ccGapCandidates("/repo", unmapped)).status).toBe("UNKNOWN");
		expect((await ccGapCandidates("/repo", unpriced)).status).toBe("UNKNOWN");
	});

	test("refused, malformed, truncated, and incomplete tracker reads fail closed", async () => {
		const refused = runtime(gaps([gapRow("gap-1")]), "", { brResult: result("", { rc: 2, stderr: new TextEncoder().encode("REFUSED") }) });
		const malformed = runtime("not-json");
		const truncated = runtime(gaps([gapRow("gap-1")]), "", { ccResult: result("", { truncated: true }) });
		const incomplete = runtime(gaps([gapRow("gap-1")]), "[]");
		expect((await ccGapCandidates("/repo", refused)).status).toBe("FAILED");
		expect((await ccGapCandidates("/repo", malformed)).status).toBe("FAILED");
		expect((await ccGapCandidates("/repo", truncated)).status).toBe("UNKNOWN");
		expect((await ccGapCandidates("/repo", incomplete)).status).toBe("FAILED");
	});
});
