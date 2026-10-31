import { resolve } from "node:path";
import { productionGraderSourceRuntime, type GraderSourceRuntime, type SourceResult } from "./gradable.ts";
import type { GraderCandidate } from "../grader-next.ts";
import type { RunResult } from "../kitlib/run.ts";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const failed = (source: string, reason: string): SourceResult<never> => ({ status: "FAILED", source, reason });
const unknown = (source: string, reason: string): SourceResult<never> => ({ status: "UNKNOWN", source, reason });

type TrackerBead = { id: string; title: string; created_by: string | null; assignee: string | null; priority: number; status: string };

function parseTracker(value: unknown, ids: string[], source: string): SourceResult<TrackerBead[]> {
	if (!Array.isArray(value)) return failed(source, "br show output must be an array");
	const rows: TrackerBead[] = [];
	for (const item of value) {
		if (!object(item) || typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()
			|| !(typeof item.created_by === "string" || item.created_by === null)
			|| !(typeof item.assignee === "string" || item.assignee === null)
			|| typeof item.priority !== "number" || !Number.isFinite(item.priority) || typeof item.status !== "string") {
			return failed(source, "br show row is incomplete or malformed");
		}
		rows.push({ id: item.id, title: item.title, created_by: item.created_by, assignee: item.assignee,
			priority: item.priority, status: item.status });
	}
	const expected = new Set(ids), observed = new Set(rows.map(row => row.id));
	if (observed.size !== rows.length || observed.size !== expected.size || [...expected].some(id => !observed.has(id))) {
		return failed(source, "br show coverage does not exactly match CC gap bead mappings");
	}
	return { status: "OK", source, rows };
}

export async function ccGapCandidates(
	repo: string,
	runtime: GraderSourceRuntime = productionGraderSourceRuntime,
): Promise<SourceResult<GraderCandidate[]>> {
	const cc = runtime.which("cc.py");
	if (!cc) return unknown("cc.py gaps", "optional cc.py producer is absent");
	const python = runtime.which("python3");
	const br = runtime.which("br");
	if (!python) return unknown("python3", "python3 is absent");
	if (!br) return unknown("br", "br is absent");
	const ccArgs = [python, "-B", cc, "gaps"];
	let output: RunResult;
	try { output = await runtime.run(ccArgs, { cwd: repo, deadline_s: 60, grace_s: 0.2, max_output_bytes: 4 << 20 }); }
	catch (error) { return unknown(ccArgs.join(" "), String(error)); }
	if (output.timed_out || output.truncated) return unknown(ccArgs.join(" "), output.timed_out ? "cc gaps timed out" : "cc gaps output truncated");
	if (output.rc !== 0) return failed(ccArgs.join(" "), `cc gaps exited ${output.rc}: ${new TextDecoder().decode(output.stderr).trim()}`);
	let payload: unknown;
	try { payload = JSON.parse(new TextDecoder().decode(output.stdout)); }
	catch { return failed(ccArgs.join(" "), "cc gaps output is not valid JSON"); }
	if (!object(payload) || !object(payload.gaps) || !Array.isArray(payload.gaps.rows)
		|| typeof payload.gaps.count !== "number" || !Number.isSafeInteger(payload.gaps.count)
		|| payload.gaps.count !== payload.gaps.rows.length) {
		return failed(ccArgs.join(" "), "cc gaps output is incomplete or malformed");
	}
	const section = payload.gaps;
	const rows = section.rows as unknown[];
	if (section.state === "UNKNOWN") return unknown(ccArgs.join(" "), "cc gap view is UNKNOWN");
	if (section.state === "closed" && rows.length === 0) return { status: "OK", source: ccArgs.join(" "), rows: [] };
	if (section.state !== "open" || rows.length === 0) return failed(ccArgs.join(" "), "cc gap state disagrees with its complete row set");
	const ids: string[] = [];
	const costs = new Map<string, number>();
	for (const row of rows) {
		if (!object(row) || typeof row.fix_link !== "string" || !row.fix_link.trim()
			|| row.cost_state !== "VALUE" || typeof row.cost_hours_day !== "number"
			|| !Number.isFinite(row.cost_hours_day) || row.cost_hours_day < 0 || row.state !== "open") {
			return unknown(ccArgs.join(" "), "cc gap row lacks an exact bead mapping or comparable cost");
		}
		const id = row.fix_link.trim();
		ids.push(id);
		costs.set(id, row.cost_hours_day);
	}
	if (new Set(ids).size !== ids.length) return failed(ccArgs.join(" "), "cc gap output maps multiple rows to one bead");
	const brArgs = [br, "show", ...ids, "--no-auto-import", "--no-auto-flush", "--json"];
	let trackerOutput: RunResult;
	try { trackerOutput = await runtime.run(brArgs, { cwd: resolve(repo), deadline_s: 60, grace_s: 0.2, max_output_bytes: 4 << 20 }); }
	catch (error) { return unknown(brArgs.join(" "), String(error)); }
	if (trackerOutput.timed_out || trackerOutput.truncated) return unknown(brArgs.join(" "), trackerOutput.timed_out ? "br show timed out" : "br show output truncated");
	if (trackerOutput.rc !== 0) return failed(brArgs.join(" "), `br show exited ${trackerOutput.rc}: ${new TextDecoder().decode(trackerOutput.stderr).trim()}`);
	let trackerValue: unknown;
	try { trackerValue = JSON.parse(new TextDecoder().decode(trackerOutput.stdout)); }
	catch { return failed(brArgs.join(" "), "br show output is not valid JSON"); }
	const tracker = parseTracker(trackerValue, ids, brArgs.join(" "));
	if (tracker.status !== "OK") return tracker;
	const byId = new Map(tracker.rows.map(row => [row.id, row]));
	const candidates: GraderCandidate[] = [];
	for (const id of ids) {
		const bead = byId.get(id);
		if (!bead || bead.status !== "open") return unknown(brArgs.join(" "), `mapped gap bead ${id} is not open`);
		candidates.push({ id, title: bead.title, author: bead.created_by, assignee: bead.assignee,
			priority: bead.priority, cost: costs.get(id), skillStep: "inspect the CC gap evidence and repair the mapped open bead" });
	}
	return { status: "OK", source: `cc.py gaps + br show (${candidates.length} mapped rows)`, rows: candidates };
}
