// fleet-round validator (skills/fleet-round). Failure mode: a director's round report is accepted
// on its word: lines and JSON disagree, a claim differs from br, a dead holder's bead counts as
// active, an orphan or cycle passes, a frontier outside focus passes, or an unobservable holder
// reads as PASS. Each planted negative below must go RED; the clean bundle must go GREEN so a
// reject-everything validator also fails. Barrier timer: a missing, rejected or late report, or an
// unreadable source, must keep the barrier from MET, and a repeated blocker must escalate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BarrierResult, type BarrierStateFile, planDelivery, type ProjectResult, STATE_FILE } from "../../skills/fleet-round/scripts/lib/barrier.ts";
import { loadConfig } from "../../skills/fleet-round/scripts/lib/collect.ts";
import { type CheckOptions, checkDag, checkFocus, checkFrontier, checkMission, checkPile, findMissions, metrics, spotCheck } from "../../skills/fleet-round/scripts/lib/checks.ts";
import { holderStatus, parseSeats, parseTracker, type RawBundle, ShapeError } from "../../skills/fleet-round/scripts/lib/model.ts";
import { CITATION, CLAIM_VALUE, DONE_CALLBACK, LABEL_LINE, MAX_LINE, matchLine, NO_EPIC, PATTERNS, ROUND_NUMBER, SEAT } from "../../skills/fleet-round/scripts/lib/patterns.ts";
import { loadMeasured, loadPredictionDoc, scoreAll } from "../../skills/fleet-round/scripts/lib/predictions.ts";
import { validateReport } from "../../skills/fleet-round/scripts/lib/report.ts";
import { runFixture } from "./fixture-process.ts";

const repo = resolve(import.meta.dir, "../..");
const fixtures = join(repo, "tests/fixtures/fleet-round");
const cli = join(repo, "skills/fleet-round/scripts/fleet-round.ts");
const workspace = join(repo, "var", "agent-tmp", `fleet-round-test.${process.pid}`);
const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

beforeAll(() => {
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, ".owner"), `pid=${process.pid}\nlabel=fleet-round-test\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
});
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

// ---- replayable tracker and Tern process observations -------------------------------------------

type Spec = { id: string; status: string; type?: string; assignee?: string; parent?: string; deps?: [string, string][]; comments?: [string, string, number][]; updated?: number; closed?: number };

const LIVE_PANE = "9007199254740997";
const EXITED_PANE = "102";
const TERN_RAW = JSON.stringify({
	sessions: [{ id: "1", name: "demo", tabs: [{ id: "2", name: "work", blocks: [{ id: LIVE_PANE }, { id: EXITED_PANE }] }] }],
	panes: [{ pane: LIVE_PANE, cwd: "/home/user/demo", exited: null, working: false },
		{ pane: EXITED_PANE, cwd: "/home/user/demo", exited: 0, working: false }],
});
const TERN_BINDINGS = [
	{ name: "LiveAgent", session: "demo", pane: `tern:${LIVE_PANE}`,
		process: JSON.stringify({ pane: LIVE_PANE, foreground: { argv: ["omp"], pid: 101, name: "omp", cwd: "/home/user/demo" } }) },
	{ name: "GoneAgent", session: "demo", pane: `tern:${EXITED_PANE}`, process: null },
];
const HOLDERS = Object.fromEntries(TERN_BINDINGS.map(({ name, session, pane }) => [name, { session, pane }]));

function bundle(specs: Spec[], ready: string[], extra: Partial<{ docs: Record<string, string>; tern: string | null; bindings: typeof TERN_BINDINGS }> = {}): RawBundle {
	const byId = new Map(specs.map(s => [s.id, s]));
	const show = specs.map(s => {
		const row: Record<string, unknown> = { id: s.id, title: "t", status: s.status, priority: 1, issue_type: s.type ?? "task", labels: [], created_at: iso(NOW - 200 * HOUR), created_by: "op", updated_at: iso(s.updated ?? NOW - HOUR) };
		if (s.assignee) row.assignee = s.assignee;
		if (s.closed !== undefined) row.closed_at = iso(s.closed);
		if (s.parent) row.parent = s.parent;
		const deps = [...(s.parent ? [[s.parent, "parent-child"] as [string, string]] : []), ...(s.deps ?? [])];
		row.dependencies = deps.map(([id, type]) => ({ id, title: "t", status: byId.get(id)?.status ?? "open", priority: 1, dependency_type: type }));
		row.dependents = [];
		row.comments = (s.comments ?? []).map(([author, text, at], i) => ({ id: i + 1, issue_id: s.id, author, text, created_at: iso(at) }));
		return row;
	});
	const list = specs.map(s => ({ id: s.id, title: "t", status: s.status, priority: 1, issue_type: s.type ?? "task", labels: [], created_at: iso(NOW - 200 * HOUR), created_by: "op", updated_at: iso(s.updated ?? NOW - HOUR), dependency_count: 0, dependent_count: 0, ...(s.assignee ? { assignee: s.assignee } : {}) }));
	return {
		schema: "fleet-round.raw/v1",
		project: "demo",
		root: "/home/user/demo",
		captured_at: iso(NOW),
		br: { version: "br 0.7.4", list: JSON.stringify({ issues: list, total: list.length, limit: 0, offset: 0, has_more: false }), show: JSON.stringify(show), ready: JSON.stringify(ready.map(id => ({ id, title: "t", status: "open", issue_type: "task", priority: 1 }))), policy_yaml: "workflow:\n  statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]\n" },
		git: { repo: "/home/user/demo", ref: "HEAD", head: "0".repeat(40), ls_files: Object.keys(extra.docs ?? CLEAN_DOCS).join("\n") },
		docs: extra.docs ?? CLEAN_DOCS,
		seats: { tern: extra.tern === undefined ? TERN_RAW : extra.tern, tern_error: extra.tern === null ? "Tern unavailable" : null,
			bindings: extra.bindings ?? TERN_BINDINGS },
	};
}

const CLEAN_DOCS = { "README.md": "# Demo\n\n## Mission\n\nShip the demo to every user.\n\nSTATE: PROPOSED\n\n## Other\n\ntext\n" };
const START = NOW - 10 * HOUR;
const CLEAN: Spec[] = [
	{ id: "demo-e1", status: "open", type: "epic" },
	{ id: "demo-e2", status: "open", type: "epic" },
	{ id: "demo-e3", status: "open", type: "epic" },
	{ id: "demo-e1.1", status: "open", parent: "demo-e1" },
	{ id: "demo-e1.2", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", comments: [["LiveAgent", "still on it: tests next", NOW - 2 * HOUR]] },
	{ id: "demo-e2.1", status: "closed", parent: "demo-e2", closed: NOW - 3 * HOUR, comments: [["Reviewer", "verified on archive", NOW - 3 * HOUR]] },
	{ id: "demo-e2.2", status: "open", parent: "demo-e2", deps: [["demo-e1.1", "blocks"]] },
];
const SNAPSHOT = { schema: "fleet-round.snapshot/v1" as const, project: "demo", round_start: iso(START), beads: [{ id: "demo-e1.2", status: "in_progress", assignee: "LiveAgent" }, { id: "demo-e2.1", status: "in_progress", assignee: "Gone" }] };
const options = (over: Partial<CheckOptions> = {}): CheckOptions => ({ now: NOW, staleHours: 24, frontierTop: 3, approver: "Op", focus: ["demo-e1", "demo-e2", "demo-e3"], snapshot: SNAPSHOT, ...over });

function allChecks(raw: RawBundle, opts: CheckOptions) {
	const tracker = parseTracker(raw);
	const seats = parseSeats(raw);
	return { tracker, seats, results: [checkMission(raw.docs, opts.approver), checkPile(tracker, seats, opts), checkDag(tracker), checkFrontier(tracker, opts), checkFocus(tracker, opts)] };
}

function report(lines: string, json: Record<string, unknown>, extraFence = ""): string {
	return `# Round report\n\n${lines}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n${extraFence}`;
}

const GOOD_LINES = "ROUND: 0\nPROJECT: demo\nSEAT: demo:0.1\nPHASE: insight\nSTATUS: done\nMISSION: README.md:3\nFOCUS: demo-e1, demo-e2, demo-e3\nCLAIM C1: in_progress = 1\nPREDICTION P1: ready stays above 1";
const GOOD_JSON = { schema: "fleet-round.report/v1", round: 0, project: "demo", seat: "demo:0.1", phase: "insight", status: "done", mission: "README.md:3", focus: ["demo-e1", "demo-e2", "demo-e3"], claims: [{ id: "C1", metric: "in_progress", value: 1, evidence: "br list --status in_progress --json" }], predictions: [{ id: "P1", metric: "ready", expect_min: 1 }] };

function measuredFor(raw: RawBundle, opts = options()) {
	const { tracker, results } = allChecks(raw, opts);
	return metrics(tracker, results, findMissions(raw.docs).length);
}

// ---- positive control --------------------------------------------------------------------------

test("clean bundle: every pass-bar check is PASS (positive control)", () => {
	const { results } = allChecks(bundle(CLEAN, ["demo-e1.1", "demo-e2.2"]), options());
	expect(results.map(r => [r.name, r.status])).toEqual([["mission", "PASS"], ["pile", "PASS"], ["dag", "PASS"], ["frontier", "PASS"], ["focus", "PASS"]]);
});

test("clean report: ACCEPTED with the claim VERIFIED against the recomputation", () => {
	const raw = bundle(CLEAN, ["demo-e1.1", "demo-e2.2"]);
	const verdict = validateReport(report(GOOD_LINES, GOOD_JSON), measuredFor(raw), "demo");
	expect(verdict.errors).toEqual([]);
	expect(verdict.status).toBe("ACCEPTED");
	expect(verdict.claims).toEqual([{ id: "C1", metric: "in_progress", reported: "1", measured: 1, status: "VERIFIED", evidence: "br list --status in_progress --json" }]);
	expect(verdict.fields.focus).toEqual(["demo-e1", "demo-e2", "demo-e3"]);
});

// ---- report negatives --------------------------------------------------------------------------

test("planted: labeled line says in_progress=0 but JSON says 3 -> REJECTED naming the field", () => {
	const raw = bundle(CLEAN, ["demo-e1.1"]);
	const lines = GOOD_LINES.replace("CLAIM C1: in_progress = 1", "CLAIM C1: in_progress = 0");
	const json = { ...GOOD_JSON, claims: [{ id: "C1", metric: "in_progress", value: 3, evidence: "br list --status in_progress --json" }] };
	const verdict = validateReport(report(lines, json), measuredFor(raw), "demo");
	expect(verdict.status).toBe("REJECTED");
	expect(verdict.errors).toContain("CLAIM C1 field in_progress disagrees: line says in_progress=0, json says 3");
});

test("planted: claim agrees with itself but not with br -> REJECTED naming claim and both values", () => {
	const raw = bundle(CLEAN, ["demo-e1.1"]);
	const lines = GOOD_LINES.replace("CLAIM C1: in_progress = 1", "CLAIM C1: in_progress = 3");
	const json = { ...GOOD_JSON, claims: [{ id: "C1", metric: "in_progress", value: 3, evidence: "br list --status in_progress --json" }] };
	const verdict = validateReport(report(lines, json), measuredFor(raw), "demo");
	expect(verdict.status).toBe("REJECTED");
	expect(verdict.errors).toEqual(["CLAIM C1 in_progress: reported 3, validator measured 1"]);
	expect(verdict.claims[0]!.status).toBe("MISMATCH");
});

test("planted: two json blocks -> REJECTED", () => {
	const raw = bundle(CLEAN, ["demo-e1.1"]);
	const verdict = validateReport(report(GOOD_LINES, GOOD_JSON, '\n```json\n{"schema":"fleet-round.report/v1"}\n```\n'), measuredFor(raw), "demo");
	expect(verdict.status).toBe("REJECTED");
	expect(verdict.errors).toContain("expected exactly one fenced json block, found 2");
});

test("planted: a json block nested in a list item still counts as a duplicate", () => {
	const nested = report(GOOD_LINES, GOOD_JSON, '\n- note\n\n  ```json\n  {}\n  ```\n');
	expect(validateReport(nested, measuredFor(bundle(CLEAN, ["demo-e1.1"])), "demo").errors).toContain("expected exactly one fenced json block, found 2");
});

test("planted: malformed json, missing SEAT, duplicate ROUND, line/json field disagreement", () => {
	const measured = measuredFor(bundle(CLEAN, ["demo-e1.1"]));
	const malformed = `# r\n\n${GOOD_LINES}\n\n\`\`\`json\n{"schema": "fleet-round.report/v1",}\n\`\`\`\n`;
	expect(validateReport(malformed, measured, "demo").errors.some(e => e.startsWith("json block is malformed:"))).toBe(true);
	const noSeat = validateReport(report(GOOD_LINES.replace("SEAT: demo:0.1\n", ""), GOOD_JSON), measured, "demo");
	expect(noSeat.errors).toContain("missing labeled line SEAT");
	const twice = validateReport(report(`${GOOD_LINES}\n\nROUND: 1`, GOOD_JSON), measured, "demo");
	expect(twice.errors.some(e => e.startsWith("ROUND appears twice"))).toBe(true);
	const phase = validateReport(report(GOOD_LINES.replace("PHASE: insight", "PHASE: agree"), GOOD_JSON), measured, "demo");
	expect(phase.errors).toContain('field phase disagrees: line PHASE says "agree", json.phase says "insight"');
});

test("planted: labeled line rewritten by inline markdown is refused, not read", () => {
	const verdict = validateReport(report(GOOD_LINES.replace("STATUS: done", "STATUS: _done_"), GOOD_JSON), measuredFor(bundle(CLEAN, ["demo-e1.1"])), "demo");
	expect(verdict.errors.some(e => e.includes("not verbatim in the source"))).toBe(true);
});

test("labeled lines inside a blockquote are not report lines", () => {
	const quoted = report(GOOD_LINES.replace("SEAT: demo:0.1\n", ""), GOOD_JSON).replace("# Round report\n", "# Round report\n\n> SEAT: demo:0.1\n");
	expect(validateReport(quoted, measuredFor(bundle(CLEAN, ["demo-e1.1"])), "demo").errors).toContain("missing labeled line SEAT");
});

test("a claim on an unknown metric is UNVERIFIED, never ACCEPTED", () => {
	const lines = `${GOOD_LINES}\nCLAIM C2: vibes = 9`;
	const json = { ...GOOD_JSON, claims: [...GOOD_JSON.claims, { id: "C2", metric: "vibes", value: 9, evidence: "echo 9" }] };
	const verdict = validateReport(report(lines, json), measuredFor(bundle(CLEAN, ["demo-e1.1"])), "demo");
	expect(verdict.status).toBe("UNVERIFIED");
	expect(verdict.unverified).toEqual(["CLAIM C2 metric vibes is not recomputable by the validator"]);
});

// ---- pile and holder liveness ------------------------------------------------------------------

test("planted: in_progress 30h old with a dead assignee -> pile FAIL naming the bead", () => {
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "GoneAgent", updated: NOW - 30 * HOUR }];
	const { results } = allChecks(bundle(specs, ["demo-e1.1"]), options({ snapshot: null }));
	const pile = results.find(r => r.name === "pile")!;
	expect(pile.status).toBe("FAIL");
	expect(pile.findings.filter(f => f.kind === "stale-no-holder").map(f => f.id)).toEqual(["demo-e1.3"]);
	expect(pile.findings[0]!.detail).toContain("GoneAgent");
});

test("planted: Tern pane inventory unobservable -> UNKNOWN, not PASS", () => {
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }];
	const pile = allChecks(bundle(specs, ["demo-e1.1"], { tern: null }), options({ snapshot: null })).results.find(r => r.name === "pile")!;
	expect(pile.status).toBe("UNKNOWN");
	expect(pile.findings.map(f => [f.kind, f.id])).toContainEqual(["stale-holder-unknown", "demo-e1.3"]);
});

test("BOARDIDENTITY1 legacy identity and Board whoami are not pane proof; exact Tern binding reports the holder", () => {
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }];
	const legacy = bundle(specs, ["demo-e1.1"], { tern: null, bindings: [] });
	Object.assign(legacy.seats, { identity: [{ key: "demo", files: { [LIVE_PANE]: '{"name":"LiveAgent","pane_pid":101}' } }],
		board_whoami: { profile: "liveagent" } });
	expect(holderStatus("LiveAgent", parseSeats(legacy)).status).toBe("UNKNOWN");
	const otherPane = bundle(specs, ["demo-e1.1"], { bindings: [{ ...TERN_BINDINGS[0]!, pane: "tern:404" }] });
	expect(holderStatus("LiveAgent", parseSeats(otherPane)).status).toBe("UNKNOWN");
	const unrelated = bundle(specs, ["demo-e1.1"], { bindings: [{ ...TERN_BINDINGS[0]!,
		process: JSON.stringify({ pane: LIVE_PANE, foreground: { argv: ["omp"], pid: 101, name: "omp", cwd: "/elsewhere" } }) }] });
	expect(holderStatus("LiveAgent", parseSeats(unrelated)).status).toBe("UNKNOWN");
	const mismatch = parseSeats(bundle(specs, ["demo-e1.1"]), {
		repo: "/home/user/demo", holders: { LiveAgent: { session: "demo", pane: "tern:404" } },
	});
	expect(holderStatus("LiveAgent", mismatch).status).toBe("UNKNOWN");
	const pile = allChecks(legacy, options({ snapshot: null }));
	expect(metrics(pile.tracker, pile.results, 0)).not.toHaveProperty("stale_no_holder");
	const view = parseSeats(bundle(specs, ["demo-e1.1"]));
	expect(holderStatus("LiveAgent", view)).toMatchObject({ status: "LIVE", seat: `tern:${LIVE_PANE}` });
	expect(holderStatus("GoneAgent", view).status).toBe("DEAD");
});

test("planted: snapshot bead still in_progress under a dead holder is unsorted; outcome without a comment is unevidenced", () => {
	const specs = CLEAN.map(s => (s.id === "demo-e2.1" ? { ...s, comments: [] } : s));
	const snapshot = { ...SNAPSHOT, beads: [...SNAPSHOT.beads, { id: "demo-e1.4", status: "in_progress", assignee: "GoneAgent" }] };
	const raw = bundle([...specs, { id: "demo-e1.4", status: "in_progress", parent: "demo-e1", assignee: "GoneAgent", updated: NOW - 2 * HOUR }], ["demo-e1.1"]);
	const pile = allChecks(raw, options({ snapshot })).results.find(r => r.name === "pile")!;
	expect(pile.status).toBe("FAIL");
	expect(pile.findings.map(f => [f.kind, f.id])).toEqual([["outcome-without-evidence", "demo-e2.1"], ["unsorted", "demo-e1.4"]]);
	expect(pile.data!.outcomes).toEqual({ closed: ["demo-e2.1"], reclaimed: [], blocked: [], active: ["demo-e1.2"], "review-queue": [], unsorted: ["demo-e1.4"], unknown: [] });
});

test("DONE callback comment puts a bead in the review queue; blocked needs owner and route", () => {
	const specs = [...CLEAN, { id: "demo-e1.5", status: "in_progress", parent: "demo-e1", assignee: "GoneAgent", comments: [["GoneAgent", "DONE demo-e1.5 abc1234 tests green", NOW - HOUR]] }, { id: "demo-e1.6", status: "blocked", parent: "demo-e1" }];
	const snapshot = { ...SNAPSHOT, beads: [{ id: "demo-e1.5", status: "in_progress", assignee: "GoneAgent" }, { id: "demo-e1.6", status: "in_progress", assignee: "X" }] };
	const pile = allChecks(bundle(specs, ["demo-e1.1"]), options({ snapshot })).results.find(r => r.name === "pile")!;
	expect(pile.data!.outcomes).toMatchObject({ "review-queue": ["demo-e1.5"], blocked: ["demo-e1.6"] });
	expect(pile.findings.map(f => [f.kind, f.id])).toEqual([["blocked-without-owner-route", "demo-e1.6"]]);
});

// ---- dag ----------------------------------------------------------------------------------------

test("planted: dependency cycle -> dag FAIL naming the cycle", () => {
	const specs = [...CLEAN, { id: "demo-e3.1", status: "open", parent: "demo-e3", deps: [["demo-e3.2", "blocks"]] as [string, string][] }, { id: "demo-e3.2", status: "open", parent: "demo-e3", deps: [["demo-e3.1", "blocks"]] as [string, string][] }];
	const dag = checkDag(parseTracker(bundle(specs, [])));
	expect(dag.status).toBe("FAIL");
	expect(dag.findings).toEqual([{ kind: "cycle", status: "FAIL", id: "demo-e3.1", detail: "dependency cycle: demo-e3.1 -> demo-e3.2" }]);
});

test("planted: orphan without a no-epic reason fails; a recorded reason passes; blocked-on-closed fails", () => {
	const specs = [...CLEAN, { id: "demo-lone", status: "open" }, { id: "demo-why", status: "open", comments: [["Op", "no-epic: one-off chore outside every epic", NOW]] as [string, string, number][] }, { id: "demo-e2.3", status: "blocked", parent: "demo-e2", deps: [["demo-e2.1", "blocks"]] as [string, string][] }];
	const dag = checkDag(parseTracker(bundle(specs, [])));
	expect(dag.findings.map(f => [f.kind, f.id])).toEqual([["orphan", "demo-lone"], ["blocked-on-closed", "demo-e2.3"]]);
});

test("dotted id counts as parent link when the prefix bead exists", () => {
	const specs = [...CLEAN, { id: "demo-e3.7", status: "open" }];
	expect(checkDag(parseTracker(bundle(specs, []))).status).toBe("PASS");
});

// ---- frontier and focus -------------------------------------------------------------------------

test("planted: ready frontier outside the focus epics -> frontier FAIL", () => {
	const frontier = checkFrontier(parseTracker(bundle(CLEAN, ["demo-e2.2", "demo-e1.1"])), options({ focus: ["demo-e1", "demo-e3", "demo-e1.1"] }));
	expect(frontier.status).toBe("FAIL");
	expect(frontier.findings.map(f => f.id)).toEqual(["demo-e2.2"]);
	expect(checkFrontier(parseTracker(bundle(CLEAN, [])), options()).findings[0]!.kind).toBe("frontier-empty");
	expect(checkFrontier(parseTracker(bundle(CLEAN, ["demo-e1.1"])), options({ focus: null })).status).toBe("UNKNOWN");
});
test("frontier-empty only fails when an open unblocked task exists", () => {
	const readyButEmpty = checkFrontier(parseTracker(bundle(CLEAN, [])), options());
	expect(readyButEmpty.status).toBe("FAIL");
	expect(readyButEmpty.findings.map(f => f.kind)).toEqual(["frontier-empty"]);

	const blockedOnly = CLEAN.map(spec => spec.id === "demo-e1.1" ? { ...spec, status: "blocked" } : spec);
	const noClaimableWork = checkFrontier(parseTracker(bundle(blockedOnly, [])), options());
	expect(noClaimableWork.status).toBe("PASS");
	expect(noClaimableWork.findings).toEqual([]);
});

test("planted: focus naming a closed, missing or childless non-epic bead -> focus FAIL", () => {
	const specs = [...CLEAN, { id: "demo-done", status: "closed", type: "epic", closed: NOW }];
	const focus = checkFocus(parseTracker(bundle(specs, [])), options({ focus: ["demo-done", "demo-ghost", "demo-e2.2"] }));
	expect(focus.findings.map(f => [f.kind, f.id])).toEqual([["focus-not-open", "demo-done"], ["focus-missing", "demo-ghost"], ["focus-not-epic", "demo-e2.2"]]);
});

// ---- mission -------------------------------------------------------------------------------------

test("mission: exactly one, cited at its heading line, STATE PROPOSED", () => {
	const mission = checkMission(CLEAN_DOCS, "Op");
	expect(mission.status).toBe("PASS");
	expect(mission.summary).toBe("README.md:3 STATE PROPOSED");
});

test("planted: duplicate missions, missing STATE, APPROVED without the approver, mission only in a code fence", () => {
	expect(checkMission({ ...CLEAN_DOCS, "docs/x.md": "## Mission statement\n\nOther.\n\nSTATE: PROPOSED\n" }, null).findings[0]!.kind).toBe("mission-duplicate");
	expect(checkMission({ "README.md": "## Mission (approved 2026-10-04)\n\nShip.\n" }, null).findings.map(f => f.kind)).toEqual(["mission-state"]);
	expect(checkMission({ "README.md": "## Mission\n\nShip.\n\nSTATE: APPROVED\nAPPROVED_BY: Someone 2026-10-04\n" }, "Op").findings.map(f => f.kind)).toEqual(["mission-approval"]);
	expect(checkMission({ "README.md": "# R\n\n```md\n## Mission\n\nShip.\n```\n" }, null).findings.map(f => f.kind)).toEqual(["mission-missing"]);
});

// ---- real capture --------------------------------------------------------------------------------

test("real omp-kit capture parses and reproduces the probe's findings", () => {
	const raw: RawBundle = JSON.parse(readFileSync(join(fixtures, "real-omp-kit.raw.json"), "utf8"));
	const now = Date.parse(raw.captured_at);
	const { tracker, results } = allChecks(raw, { now, staleHours: 24, frontierTop: 3, approver: null, focus: null, snapshot: null });
	expect(tracker.statuses).toEqual(["open", "in_progress", "in_review", "rework", "blocked", "deferred", "closed"]);
	expect(tracker.beads.get("ompkit-v66l.4")!.parent).toBe("ompkit-v66l");
	const dag = results.find(r => r.name === "dag")!;
	expect(dag.data!.blocked_on_closed).toEqual(["ompkit-rc-epic-land-fix-release-dogfood-rz5.45->ompkit-jdeq", "ompkit-rc-epic-land-fix-release-dogfood-rz5.45->ompkit-rc-epic-land-fix-release-dogfood-rz5.36"]);
	expect(dag.data!.orphans).toContain("ompkit-2w7h");
	const pile = results.find(r => r.name === "pile")!;
	expect(pile.findings.find(f => f.id === "ompkit-2w7h")).toMatchObject({ kind: "stale-holder-unknown", status: "UNKNOWN" });
	expect(pile.findings.find(f => f.id === "ompkit-x5iv.2")).toMatchObject({ kind: "stale-holder-unknown", status: "UNKNOWN" });
	expect(results.find(r => r.name === "mission")!.findings.map(f => f.kind)).toEqual(["mission-state"]);
});

test("planted: br list total that disagrees with its rows is a shape error, not zero beads", () => {
	const raw = bundle(CLEAN, []);
	raw.br.list = JSON.stringify({ issues: [], total: 7, limit: 0, offset: 0, has_more: false });
	expect(() => parseTracker(raw)).toThrow(ShapeError);
	const missing = bundle(CLEAN, []);
	missing.br.show = JSON.stringify(JSON.parse(missing.br.show).map((r: Record<string, unknown>) => ({ ...r, status: undefined })));
	expect(() => parseTracker(missing)).toThrow("field status is missing");
});

// ---- predictions and spot check ------------------------------------------------------------------

test("prediction scoring against a fixture: per-prediction error and per-author aggregate", () => {
	const doc = loadPredictionDoc(readFileSync(join(fixtures, "predictions.md"), "utf8"), "predictions.md");
	const values = loadMeasured(readFileSync(join(fixtures, "measured.json"), "utf8"), "measured.json");
	const { predictions, authors } = scoreAll([doc], values);
	expect(predictions.map(p => [p.id, p.status, p.error === null ? null : Math.round(p.error * 1000) / 1000])).toEqual([
		["P1", "MISS", 0.06],
		["P2", "MISS", 0.18],
		["P3", "HIT", 0],
		["P4", "MISS", 3],
		["P5", "HIT", 0],
		["P6", "UNMEASURED", null],
	]);
	expect(authors).toHaveLength(1);
	expect(authors[0]).toMatchObject({ author: "FixtureChief", predictions: 6, measured: 5, hits: 2, hit_rate: 0.4 });
	expect(authors[0]!.mean_normalized_error).toBeCloseTo(0.648, 6);
});

test("spot check: seeded, reproducible, ceil(10%) of beads closed in the window", () => {
	const specs: Spec[] = Array.from({ length: 23 }, (_, i) => ({ id: `demo-c${i}`, status: "closed", closed: NOW - (i + 1) * HOUR }));
	const tracker = parseTracker(bundle([...specs, { id: "demo-old", status: "closed", closed: NOW - 500 * HOUR }], []));
	const a = spotCheck(tracker, NOW - 100 * HOUR, NOW, "round-0", 0.1);
	expect(a.population).toHaveLength(23);
	expect(a.sample).toHaveLength(3);
	expect(spotCheck(tracker, NOW - 100 * HOUR, NOW, "round-0", 0.1).sample).toEqual(a.sample);
	expect(spotCheck(tracker, NOW - 100 * HOUR, NOW, "round-1", 0.1).sample).not.toEqual(a.sample);
});

// ---- CLI end to end ------------------------------------------------------------------------------

function run(args: string[], env: Record<string, string | undefined> = {}): { code: number | null; out: string } {
	const child = runFixture([process.execPath, "run", "--no-env-file", "--config=/dev/null", cli, ...args],
		{ cwd: repo, env: { ...process.env, ...env }, floor_s: 30 });
	const decoder = new TextDecoder();
	return { code: child.rc, out: `${decoder.decode(child.stdout)}${decoder.decode(child.stderr)}` };
}

test("CLI validate: clean report exits 0, planted report exits 1, unknown holder exits 3", () => {
	const config = join(workspace, "config.json");
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo", holders: HOLDERS } }, approver: "Op" }));
	const raw = join(workspace, "raw.json");
	writeFileSync(raw, JSON.stringify(bundle(CLEAN, ["demo-e1.1", "demo-e2.2"])));
	const snapshot = join(workspace, "snapshot.json");
	writeFileSync(snapshot, JSON.stringify(SNAPSHOT));
	const good = join(workspace, "good.md");
	writeFileSync(good, report(GOOD_LINES, GOOD_JSON));
	const accepted = run(["validate", "--config", config, "--project", "demo", "--raw", raw, "--snapshot", snapshot, "--report", good, "--now", iso(NOW)]);
	expect(accepted.code).toBe(0);
	expect(JSON.parse(accepted.out)).toMatchObject({ pass_bar: "PASS", report: { status: "ACCEPTED" } });
	const bad = join(workspace, "bad.md");
	writeFileSync(bad, report(GOOD_LINES.replace("MISSION: README.md:3", "MISSION: README.md:9"), { ...GOOD_JSON, mission: "README.md:9" }));
	const rejected = run(["validate", "--config", config, "--project", "demo", "--raw", raw, "--snapshot", snapshot, "--report", bad, "--now", iso(NOW)]);
	expect(rejected.code).toBe(1);
	expect(JSON.parse(rejected.out).report.errors).toEqual(["field mission: report cites README.md:9, validator found README.md:3"]);
	const unknownRaw = join(workspace, "unknown.json");
	writeFileSync(unknownRaw, JSON.stringify(bundle([...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }], ["demo-e1.1"], { tern: null })));
	const unknown = run(["check", "--config", config, "--project", "demo", "--raw", unknownRaw, "--snapshot", snapshot, "--focus", "demo-e1,demo-e2,demo-e3", "--now", iso(NOW)]);
	expect(unknown.code).toBe(3);
	expect(JSON.parse(unknown.out).pass_bar).toBe("UNKNOWN");
	expect(run(["check", "--config", config, "--project", "nope", "--raw", raw]).code).toBe(2);
	const focusFlag = run(["validate", "--config", config, "--project", "demo", "--raw", raw, "--report", good, "--focus", "demo-e1"]);
	expect(focusFlag.code).toBe(2);
	expect(focusFlag.out).toContain("validate does not take --focus");
});

// ---- regexes -------------------------------------------------------------------------------------

test("every shipped regex is pinned in references/regex-conformance.json with its exact source and flags", () => {
	const suite = JSON.parse(readFileSync(join(repo, "skills/fleet-round/references/regex-conformance.json"), "utf8"));
	for (const [name, pattern] of Object.entries(PATTERNS)) {
		const cases = suite.cases.filter((c: { id: string }) => c.id.startsWith(`${name}:`));
		expect(cases.length).toBeGreaterThanOrEqual(3);
		for (const c of cases) {
			expect(c.pattern).toBe(pattern.source);
			expect(c.flags).toBe(pattern.flags);
		}
	}
});

test("regexes: positive controls, rejects and boundaries in Bun/JSC", () => {
	expect(matchLine(LABEL_LINE, "CLAIM C1: in_progress = 3")?.slice(1)).toEqual(["CLAIM", "C1", "in_progress = 3"]);
	expect(matchLine(LABEL_LINE, "ROUND: 0")?.slice(1)).toEqual(["ROUND", undefined, "0"]);
	expect(matchLine(LABEL_LINE, "round: 0")).toBeNull();
	expect(matchLine(LABEL_LINE, "ROUND:0")).toBeNull();
	expect(matchLine(CLAIM_VALUE, "in_progress = 3 (br list)")?.slice(1)).toEqual(["in_progress", "3"]);
	expect(matchLine(CLAIM_VALUE, "in_progress=0")?.slice(1)).toEqual(["in_progress", "0"]);
	expect(matchLine(CLAIM_VALUE, "In_progress = 3")).toBeNull();
	expect(matchLine(SEAT, "uds--burn-down:0.6")?.slice(1)).toEqual(["uds--burn-down", "0", "6"]);
	expect(matchLine(SEAT, "omp-test:0.01")).toBeNull();
	expect(matchLine(CITATION, "docs/a b.md:3")).toBeNull();
	expect(matchLine(CITATION, "ROADMAP.md:9")?.slice(1)).toEqual(["ROADMAP.md", "9"]);
	expect(matchLine(ROUND_NUMBER, "00")).toBeNull();
	expect(matchLine(DONE_CALLBACK, "DONE ompkit-1iku 3b617e6 tests")?.slice(1)).toEqual(["ompkit-1iku", "3b617e6"]);
	expect(matchLine(DONE_CALLBACK, "DONE ompkit-1iku notasha")).toBeNull();
	expect(matchLine(NO_EPIC, "no-epic: release chore")?.[1]).toBe("release chore");
	expect(matchLine(NO_EPIC, "no-epic:")).toBeNull();
	expect(matchLine(LABEL_LINE, `ROUND: ${"0".repeat(MAX_LINE)}`)).toBeNull();
});

function matchCpuMs(pattern: RegExp, input: string, iterations = 2_000): number {
	const start = process.cpuUsage();
	for (let i = 0; i < iterations; i++) matchLine(pattern, input);
	const elapsed = process.cpuUsage(start);
	return (elapsed.user + elapsed.system) / 1_000;
}

function requireBoundedCpuGrowth(pattern: RegExp, short: number, long: number): number {
	const ratio = long / Math.max(short, 0.5);
	if (!(ratio < 4)) throw new Error(`REGEX_CPU_GROWTH ${pattern}: short=${short}ms long=${long}ms ratio=${ratio} limit=4`);
	return ratio;
}

test("regexes: doubled near-misses stay bounded (linear, capped)", () => {
	const families: [RegExp, (n: number) => string][] = [
		[LABEL_LINE, n => `CLAIM ${"a".repeat(Math.min(n, 63))}:${" ".repeat(n)}`],
		[CLAIM_VALUE, n => `in_progress${" ".repeat(n)}=${" ".repeat(n)}`],
		[CITATION, n => `${"a".repeat(n)}:`],
		[DONE_CALLBACK, n => `DONE x ${"a".repeat(Math.min(n, 39))}g${" ".repeat(n)}`],
		[NO_EPIC, n => `no-epic:${" ".repeat(n)}`],
		[SEAT, n => `${"a".repeat(Math.min(n, 63))}:${"1".repeat(n)}`],
	];
	for (const [pattern, make] of families) {
		// This checks matcher work, not time the runner was descheduled.
		// Keep the original inputs, warmup, iteration count, floor and growth bound.
		const time = (n: number): number => matchCpuMs(pattern, make(n));
		time(1000);
		const short = time(1000);
		const long = time(2000);
		expect(matchLine(pattern, make(2000))).toBeNull();
		expect(requireBoundedCpuGrowth(pattern, short, long)).toBeLessThan(4);
	}
});

test("regexes: CPU growth gate rejects the strict fourfold boundary", () => {
	expect(() => requireBoundedCpuGrowth(NO_EPIC, 1, 4)).toThrow("REGEX_CPU_GROWTH");
});

test("regexes: CPU growth gate rejects a genuine superlinear matcher", () => {
	const pattern = new RegExp("a(a|aa)+b");
	expect(matchLine(pattern, "aaab")?.[0]).toBe("aaab");
	const short = matchCpuMs(pattern, `${"a".repeat(16)}!`, 1);
	const longInput = `${"a".repeat(32)}!`;
	const long = matchCpuMs(pattern, longInput, 1);
	expect(matchLine(pattern, longInput)).toBeNull();
	expect(() => requireBoundedCpuGrowth(pattern, short, long)).toThrow("REGEX_CPU_GROWTH");
});

// ---- barrier timer -------------------------------------------------------------------------------

const BOARD_ROOT = "3001";
const BOARD_CHANNEL = "fleet";
const BOARD_THREAD = "c140d989-3baf-45b3-9971-834ebac1e22c";
const MINUTE = 60_000;
const T0 = NOW - 3 * HOUR;
const DEADLINE = T0 + 2 * HOUR;
type BoardReplyFixture = { from: string; body: string; at: number; editedAt?: number; thread?: string; channel?: string; revision?: number };

/** Simulate only the Board CLI transport; the real driver and parser judge the returned frame. */
function boardFixture(name: string, replies: BoardReplyFixture[], root?: Record<string, unknown>): string {
	const path = join(workspace, `${name}.board.json`);
	const message = { id: BOARD_ROOT, channel: BOARD_CHANNEL, thread: BOARD_THREAD, replyTo: null, re: null,
		createdAt: iso(T0), editedAt: null, text: "The round is open.", deleted: false, revision: 1,
		by: { actor: "local:chief", profile: "chief" }, ...root };
	writeFileSync(path, JSON.stringify({ message, cursor: "4000", schedules: [], replies: replies.map((reply, i) => ({
		id: String(BOARD_ROOT.length + 4000 + i), channel: reply.channel ?? BOARD_CHANNEL, thread: reply.thread ?? BOARD_THREAD,
		replyTo: null, re: BOARD_ROOT, createdAt: iso(reply.at), editedAt: reply.editedAt === undefined ? null : iso(reply.editedAt),
		text: reply.body, deleted: false, revision: reply.revision ?? 1,
		by: { actor: `local:${reply.from}`, profile: reply.from },
	})) }));
	return path;
}

function boardEnvironment(frame: string): Record<string, string> {
	const bin = join(workspace, "board-bin");
	mkdirSync(bin, { recursive: true });
	const client = join(bin, "vb");
	writeFileSync(client, "#!/bin/sh\n[ \"$#\" -eq 3 ] && [ \"$1\" = read ] && [ \"$2\" = 3001 ] && [ \"$3\" = --json ] || exit 2\n[ -r \"$FLEET_ROUND_TEST_FRAME\" ] || exit 1\nexec /bin/cat \"$FLEET_ROUND_TEST_FRAME\"\n", { mode: 0o755 });
	return { OMP_KIT_BOARD_CLI: client, BOARD_URL: "http://127.0.0.1:1/api/board", BOARD_PROFILE: "fixture-chief", FLEET_ROUND_TEST_FRAME: frame };
}

function reportFor(project: string, { phase = "insight", round = 0, inProgress = 1 } = {}): string {
	const lines = GOOD_LINES.replace("ROUND: 0", `ROUND: ${round}`).replace("PROJECT: demo", `PROJECT: ${project}`).replace("SEAT: demo:0.1", `SEAT: ${project}:0.1`).replace("PHASE: insight", `PHASE: ${phase}`).replace("in_progress = 1", `in_progress = ${inProgress}`);
	return report(lines, { ...GOOD_JSON, round, project, seat: `${project}:0.1`, phase, claims: [{ ...GOOD_JSON.claims[0], value: inProgress }] });
}

const READY = ["demo-e1.1", "demo-e2.2"];
function rawFile(name: string, raw: RawBundle): string {
	const path = join(workspace, `${name}.raw.json`);
	writeFileSync(path, JSON.stringify(raw));
	return path;
}
const raws = (): string[] => [`demo=${rawFile("demo", bundle(CLEAN, READY))}`, `kit=${rawFile("kit", { ...bundle(CLEAN, READY), project: "kit" })}`];

function roundDir(name: string): string {
	const dir = join(workspace, `round-${name}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

function barrier(frame: string, opts: { state: string; phase?: string; opened?: number; now?: number; raw?: string[]; outMd?: string; root?: string | null; channel?: string | null }): { code: number | null; json: BarrierResult; out: string } {
	const config = join(workspace, "barrier-config.json");
	const root = opts.root === undefined ? BOARD_ROOT : opts.root;
	const channel = opts.channel === undefined ? BOARD_CHANNEL : opts.channel;
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" }, kit: { root: join(workspace, "no-such-kit-root") } }, approver: "Op", barrier: { board_channel: channel, hours: { INSIGHT: 2, AGREE: 1, SORT: 8 } } }));
	const args = ["barrier", "--config", config, ...(root === null ? [] : ["--board-root", root]), "--round", "0", "--phase", opts.phase ?? "INSIGHT", "--opened-at", iso(opts.opened ?? T0), "--state", opts.state, "--now", iso(opts.now ?? NOW), ...(opts.raw ?? raws()).flatMap(spec => ["--raw", spec])];
	const result = run(opts.outMd ? [...args, "--out-json", join(opts.state, "barrier.json"), "--out-md", opts.outMd] : args, boardEnvironment(frame));
	const json = JSON.parse(opts.outMd ? readFileSync(join(opts.state, "barrier.json"), "utf8") : result.out) as BarrierResult;
	return { code: result.code, json, out: result.out };
}
const verdicts = (json: BarrierResult): Record<string, string> => Object.fromEntries(json.projects.map(p => [p.project, p.verdict]));
const projectOf = (json: BarrierResult, name: string) => json.projects.find(p => p.project === name)!;

test("BOARDTHREAD1 exact Board root and channel accept on-time reports -> MET with real validator", () => {
	const db = boardFixture("met", [
		{ from: "DemoDirector", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit"), at: T0 + 40 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { round: 1, inProgress: 9 }), at: T0 + 50 * MINUTE },
	]);
	const early = barrier(db, { state: roundDir("met"), now: T0 + HOUR });
	expect(early.code).toBe(0);
	expect(early.json.state).toBe("MET");
	expect(verdicts(early.json)).toEqual({ demo: "ACCEPTED", kit: "ACCEPTED" });
	expect(early.json.board.other_messages).toBe(2);
	const after = barrier(db, { state: roundDir("met-after") });
	expect([after.code, after.json.state]).toEqual([0, "MET"]);
	const sort = barrier(boardFixture("sort", [{ from: "D", body: reportFor("demo", { phase: "execute" }), at: T0 + HOUR }, { from: "K", body: reportFor("kit", { phase: "execute" }), at: T0 + HOUR }]), { state: roundDir("sort"), phase: "SORT" });
	expect([sort.code, sort.json.state]).toEqual([0, "MET"]);
});

test("planted: a project with no report -> MISSING; OPEN before the deadline (exit 4), MISSED after (exit 1)", () => {
	const db = boardFixture("missing", [
		{ from: "DemoDirector", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { phase: "agree" }), at: T0 + 30 * MINUTE },
	]);
	const open = barrier(db, { state: roundDir("missing-open"), now: T0 + HOUR });
	expect([open.code, open.json.state]).toEqual([4, "OPEN"]);
	expect(verdicts(open.json)).toEqual({ demo: "ACCEPTED", kit: "MISSING" });
	const missed = barrier(db, { state: roundDir("missing") });
	expect([missed.code, missed.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(missed.json, "kit")).toMatchObject({ verdict: "MISSING", reasons: ["no insight report for round 0 in Board #3001"] });
});

test("planted: a report whose claim differs from br -> REJECTED naming the claim; barrier MISSED", () => {
	const db = boardFixture("rejected", [
		{ from: "DemoDirector", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { inProgress: 5 }), at: T0 + 30 * MINUTE },
	]);
	const result = barrier(db, { state: roundDir("rejected") });
	expect([result.code, result.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(result.json, "kit")).toMatchObject({ verdict: "REJECTED", reasons: ["CLAIM C1 in_progress: reported 5, validator measured 1"] });
	expect(projectOf(result.json, "demo").verdict).toBe("ACCEPTED");
});

test("planted: a report after the deadline -> LATE; one exactly at the deadline is on time", () => {
	const late = barrier(boardFixture("late", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: DEADLINE + MINUTE }]), { state: roundDir("late") });
	expect([late.code, late.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(late.json, "kit").verdict).toBe("LATE");
	expect(projectOf(late.json, "kit").reasons[0]).toContain("after the deadline 2026-10-12T11:00:00.000Z");
	const edge = barrier(boardFixture("edge", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: DEADLINE }]), { state: roundDir("edge") });
	expect([edge.code, edge.json.state]).toEqual([0, "MET"]);
	const edited = barrier(boardFixture("edited-late", [
		{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "K", body: reportFor("kit"), at: T0 + 25 * MINUTE, editedAt: DEADLINE + MINUTE },
	]), { state: roundDir("edited-late") });
	expect([edited.code, projectOf(edited.json, "kit").verdict]).toEqual([1, "LATE"]);
});

test("BOARDTHREAD1 missing, unavailable, malformed or mismatched Board evidence is UNKNOWN, even before deadline", () => {
	const both = [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: T0 + 30 * MINUTE }];
	const valid = boardFixture("valid-for-negative", both);
	const malformed = join(workspace, "malformed-board.json");
	writeFileSync(malformed, "not a Board response");
	for (const [name, frame, root, channel] of [
		["unavailable", join(workspace, "absent.board.json"), BOARD_ROOT, BOARD_CHANNEL],
		["malformed", malformed, BOARD_ROOT, BOARD_CHANNEL],
		["missing-root", valid, null, BOARD_CHANNEL],
		["missing-channel", valid, BOARD_ROOT, null],
		["wrong-root", boardFixture("other-root", both, { id: "3002" }), BOARD_ROOT, BOARD_CHANNEL],
		["wrong-channel", boardFixture("other-channel", both, { channel: "another-channel" }), BOARD_ROOT, BOARD_CHANNEL],
		["wrong-thread", boardFixture("other-thread", [{ ...both[0]!, thread: "another-thread" }, both[1]!]), BOARD_ROOT, BOARD_CHANNEL],
		["wrong-reply-channel", boardFixture("other-reply-channel", [{ ...both[0]!, channel: "another-channel" }, both[1]!]), BOARD_ROOT, BOARD_CHANNEL],
	] as const) {
		const result = barrier(frame, { state: roundDir(name), now: T0 + HOUR, root, channel });
		expect([result.code, result.json.state]).toEqual([3, "UNKNOWN"]);
		expect(result.json.board.available).toBe(false);
		expect(verdicts(result.json)).toEqual({ demo: "UNKNOWN", kit: "UNKNOWN" });
		expect(existsSync(join(roundDir(name), STATE_FILE))).toBe(false);
	}
	const noTracker = barrier(valid, { state: roundDir("no-tracker"), now: T0 + HOUR, raw: [raws()[0]!] });
	expect(noTracker.code).toBe(3);
	expect(verdicts(noTracker.json)).toEqual({ demo: "ACCEPTED", kit: "UNKNOWN" });
	expect(noTracker.json.unavailable).toEqual(["kit"]);
	const legacyConfig = join(workspace, "legacy-mail-config.json");
	writeFileSync(legacyConfig, JSON.stringify({ schema: "fleet-round.config/v1", identity_root: workspace,
		projects: { demo: { root: "/home/user/demo", identity_projects: [workspace] } },
		barrier: { agent_mail_db: valid, mail_project: BOARD_CHANNEL, hours: { INSIGHT: 2, AGREE: 1, SORT: 8 } } }));
	const gone = run(["barrier", "--config", legacyConfig, "--board-root", BOARD_ROOT, "--round", "0", "--phase", "INSIGHT",
		"--opened-at", iso(T0), "--state", roundDir("legacy-mail")], boardEnvironment(valid));
	expect(gone.code).toBe(3);
	expect(JSON.parse(gone.out)).toMatchObject({ state: "UNKNOWN", board: { available: false } });
});

test("planted: the same blocker at two consecutive barriers -> ESCALATE; a different blocker does not", () => {
	const agreeOpen = DEADLINE + 5 * MINUTE;
	const agreeNow = agreeOpen + HOUR + 5 * MINUTE;
	const db = boardFixture("escalate", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "D", body: reportFor("demo", { phase: "agree" }), at: agreeOpen + 10 * MINUTE }]);
	const dir = roundDir("escalate");
	const first = barrier(db, { state: dir, now: DEADLINE + MINUTE });
	expect([first.code, first.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(first.json, "kit")).toMatchObject({ verdict: "MISSING", consecutive_misses: 1, escalate: false });
	const md = join(dir, "barrier.md");
	const second = barrier(db, { state: dir, phase: "AGREE", opened: agreeOpen, now: agreeNow, outMd: md });
	expect(second.code).toBe(1);
	expect(projectOf(second.json, "kit")).toMatchObject({ verdict: "MISSING", consecutive_misses: 2, escalate: true });
	expect(projectOf(second.json, "demo")).toMatchObject({ verdict: "ACCEPTED", consecutive_misses: 0, escalate: false });
	expect(second.json.escalate).toEqual(["kit"]);
	expect(readFileSync(md, "utf8")).toContain("| kit | ESCALATE (MISSING) | - | - | 2 |");
	const rerun = barrier(db, { state: dir, phase: "AGREE", opened: agreeOpen, now: agreeNow + 10 * MINUTE });
	expect(projectOf(rerun.json, "kit")).toMatchObject({ consecutive_misses: 2, escalate: true }); // re-running a barrier records it once

	const mixed = boardFixture("mixed", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "D", body: reportFor("demo", { phase: "agree" }), at: agreeOpen + 10 * MINUTE }, { from: "K", body: reportFor("kit", { phase: "agree", inProgress: 5 }), at: agreeOpen + 10 * MINUTE }]);
	const other = roundDir("mixed");
	barrier(mixed, { state: other, now: DEADLINE + MINUTE });
	const changed = barrier(mixed, { state: other, phase: "AGREE", opened: agreeOpen, now: agreeNow });
	expect(projectOf(changed.json, "kit")).toMatchObject({ verdict: "REJECTED", consecutive_misses: 2, escalate: false });
});

test("a report is judged once, when first seen: later tracker work cannot flip it", () => {
	const db = boardFixture("cache", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: T0 + 30 * MINUTE }]);
	const moved = [raws()[0]!, `kit=${rawFile("kit-moved", { ...bundle([...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent" }], READY), project: "kit" })}`];
	const dir = roundDir("cache");
	expect(barrier(db, { state: dir, now: T0 + 40 * MINUTE }).json.state).toBe("MET");
	const later = barrier(db, { state: dir, raw: moved });
	expect(projectOf(later.json, "kit")).toMatchObject({ verdict: "ACCEPTED", cached: true });
	const fresh = barrier(db, { state: roundDir("cache-fresh"), raw: moved });
	expect(projectOf(fresh.json, "kit")).toMatchObject({ verdict: "REJECTED", cached: false });
	const edited = boardFixture("cache-edited", [
		{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "K", body: reportFor("kit", { inProgress: 7 }), at: T0 + 30 * MINUTE, editedAt: T0 + 45 * MINUTE, revision: 2 },
	]);
	expect(projectOf(barrier(edited, { state: dir }).json, "kit")).toMatchObject({ verdict: "REJECTED", cached: false });
});

test("barrier usage: missing barrier config, bad phase or round, missing state dir exit 2", () => {
	const config = join(workspace, "plain-config.json");
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" } } }));
	const dir = roundDir("usage");
	const base = ["--round", "0", "--phase", "INSIGHT", "--opened-at", iso(T0), "--state", dir];
	expect(run(["barrier", "--config", config, ...base]).out).toContain('needs a "barrier" section');
	const db = boardFixture("usage", []);
	barrier(db, { state: dir });
	const configured = join(workspace, "barrier-config.json");
	for (const bad of [["--phase", "MEASURE"], ["--round", "01"], ["--state", join(workspace, "absent-dir")]]) {
		const args = [...base];
		args[args.indexOf(bad[0]!) + 1] = bad[1]!;
		expect(run(["barrier", "--config", configured, ...args]).code).toBe(2);
	}
});

// ---- barrier delivery (ompkit-axpa): the timer wakes seats via omp-kit send -----------------------

const CHIEF_SEAT = { session: "chief-sess", pane: "%1" };
const DEMO_SEAT = { session: "demo-sess", pane: "%2" };
const DIRECTORS = { demo: DEMO_SEAT };

function deliveryProject(over: Partial<ProjectResult> & { project: string }): ProjectResult {
	return { verdict: "ACCEPTED", reasons: [], message: null, reports: 0, cached: false, blocker: null, consecutive_misses: 0, escalate: false, ...over };
}
function deliveryResult(over: Partial<BarrierResult> & { projects: ProjectResult[] }): BarrierResult {
	return { schema: "fleet-round.barrier/v2", round: 0, phase: "INSIGHT", report_phase: "insight", thread: BOARD_THREAD,
		board_root: BOARD_ROOT, board_channel: BOARD_CHANNEL, opened_at: iso(T0), timebox_hours: 2, deadline: iso(DEADLINE),
		now: iso(NOW), state: "OPEN", board: { available: true, reason: null, messages: 0, other_messages: 0 }, escalate: [], unavailable: [], ...over };
}
function deliveryState(notified: Record<string, string> = {}): BarrierStateFile {
	return { schema: "fleet-round.barrier-state/v1", barriers: {}, validated: {}, notified };
}
const rejectedDemo = (cached: boolean): ProjectResult => deliveryProject({ project: "demo", verdict: "REJECTED", reasons: ["claim in_progress differs: line 1, json 3"], message: { id: "7", sender: "D", created_at: iso(T0 + 20 * MINUTE) }, reports: 1, cached, blocker: "rejected" });

test("delivery: a fresh REJECTED wakes that project's director only, never the chief", () => {
	const result = deliveryResult({ projects: [rejectedDemo(false), deliveryProject({ project: "kit" })] });
	const got = planDelivery(result, deliveryState(), true, CHIEF_SEAT, DIRECTORS, null);
	expect(got).toHaveLength(1);
	expect(got[0]).toMatchObject({ key: "rejected:0:INSIGHT:demo:7", session: "demo-sess", pane: "%2" });
	expect(got[0]!.text).toContain("report 7 REJECTED");
	expect(got[0]!.text).toContain("Fix and resend to Board #3001 (fleet)");
	expect(got.every(d => d.session !== "chief-sess")).toBe(true);
});

test("delivery: a rerun on unchanged state plans nothing (dedup via notified keys)", () => {
	const result = deliveryResult({ state: "MET", projects: [deliveryProject({ project: "demo" }), deliveryProject({ project: "kit" })] });
	const first = planDelivery(result, deliveryState(), true, CHIEF_SEAT, DIRECTORS, "md");
	expect(first).toHaveLength(1);
	const sent: Record<string, string> = {};
	for (const d of first) sent[d.key] = iso(NOW);
	expect(planDelivery(result, deliveryState(sent), true, CHIEF_SEAT, DIRECTORS, "md")).toEqual([]);
});

test("delivery: first-seen MET wakes the chief exactly once, with the barrier md path", () => {
	const result = deliveryResult({ state: "MET", projects: [deliveryProject({ project: "demo" }), deliveryProject({ project: "kit" })] });
	const md = join(workspace, "round-deliver", "barrier.md");
	const got = planDelivery(result, deliveryState(), true, CHIEF_SEAT, DIRECTORS, md);
	expect(got).toHaveLength(1);
	expect(got[0]).toMatchObject({ key: "barrier:0:INSIGHT:MET", session: "chief-sess", pane: "%1" });
	expect(got[0]!.text).toContain("MET");
	expect(got[0]!.text).toContain(md);
});

test("delivery: deliver false plans nothing; OPEN plans nothing; cached REJECTED plans nothing", () => {
	const fresh = deliveryResult({ projects: [rejectedDemo(false), deliveryProject({ project: "kit" })] });
	expect(planDelivery(fresh, deliveryState(), false, CHIEF_SEAT, DIRECTORS, null)).toEqual([]);
	const open = deliveryResult({ projects: [deliveryProject({ project: "demo" }), deliveryProject({ project: "kit" })] });
	expect(planDelivery(open, deliveryState(), true, CHIEF_SEAT, DIRECTORS, null)).toEqual([]);
	const seen = deliveryResult({ projects: [rejectedDemo(true), deliveryProject({ project: "kit" })] });
	expect(planDelivery(seen, deliveryState(), true, CHIEF_SEAT, DIRECTORS, null)).toEqual([]);
});

test("delivery: a newly escalated project wakes the chief; seats without an address are skipped", () => {
	const result = deliveryResult({ state: "MISSED", escalate: ["kit"], projects: [rejectedDemo(false), deliveryProject({ project: "kit", verdict: "MISSING", reasons: ["no insight report for round 0 in Board #3001"], blocker: "missing", consecutive_misses: 2, escalate: true })] });
	const got = planDelivery(result, deliveryState(), true, CHIEF_SEAT, {}, null);
	expect(got.map(d => d.key).sort()).toEqual(["barrier:0:INSIGHT:MISSED", "escalated:0:INSIGHT:kit"]);
	expect(got.every(d => d.session === "chief-sess")).toBe(true);
	expect(got.find(d => d.key.startsWith("escalated:"))!.text).toContain("ESCALATE");
	const noChief = planDelivery(result, deliveryState(), true, null, {}, null);
	expect(noChief).toEqual([]);
});

test("config: barrier deliver and project director parse, chief lives at top level; bad seats rejected", () => {
	const base = { schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" } }, barrier: { board_channel: BOARD_CHANNEL, hours: { INSIGHT: 2, AGREE: 1, SORT: 8 } } };
	const good = loadConfig(JSON.stringify({ ...base, chief: { session: "c", pane: "%2" }, projects: { demo: { root: "/home/user/demo", director: { session: "s", pane: "%1" } } }, barrier: { ...base.barrier, deliver: true } }), "good");
	expect(good.barrier).toMatchObject({ deliver: true });
	expect(good.chief).toEqual({ session: "c", pane: "%2" });
	expect(good.projects.demo?.director).toEqual({ session: "s", pane: "%1" });
	const dflt = loadConfig(JSON.stringify(base), "dflt");
	expect(dflt.barrier).toMatchObject({ deliver: false });
	expect(dflt.chief).toBeNull();
	expect(dflt.projects.demo?.director).toBeNull();
	const badDeliver = JSON.stringify({ ...base, barrier: { ...base.barrier, deliver: "yes" } });
	expect(() => loadConfig(badDeliver, "bad")).toThrow("barrier.deliver must be a boolean");
	const nestedChief = JSON.stringify({ ...base, barrier: { ...base.barrier, chief: { session: "c", pane: "%2" } } });
	expect(() => loadConfig(nestedChief, "bad")).toThrow("barrier.chief moved to top-level chief");
	const badChief = JSON.stringify({ ...base, chief: { session: "", pane: "%2" } });
	expect(() => loadConfig(badChief, "bad")).toThrow("chief must be {session, pane}");
	const badDirector = JSON.stringify({ ...base, projects: { demo: { root: "/home/user/demo", director: { pane: "%1" } } } });
	expect(() => loadConfig(badDirector, "bad")).toThrow("projects.demo.director must be {session, pane}");
});

function deliverCli(name: string, deliver: boolean): { code: number | null; out: string; dir: string } {
	const frame = boardFixture(name, [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: T0 + 30 * MINUTE }]);
	const dir = roundDir(name);
	const config = join(workspace, `${name}-config.json`);
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", chief: { session: "no-such-axpa", pane: "tern:999" }, projects: { demo: { root: "/home/user/demo" }, kit: { root: join(workspace, "no-such-kit-root") } }, approver: "Op", barrier: { board_channel: BOARD_CHANNEL, hours: { INSIGHT: 2, AGREE: 1, SORT: 8 }, deliver } }));
	const result = run(["barrier", "--config", config, "--board-root", BOARD_ROOT, "--round", "0", "--phase", "INSIGHT", "--opened-at", iso(T0), "--state", dir, "--now", iso(T0 + HOUR), ...raws().flatMap(spec => ["--raw", spec])], boardEnvironment(frame));
	return { code: result.code, out: result.out, dir };
}

test("CLI barrier with deliver:false and a MET barrier sends nothing and exits 0", () => {
	const result = deliverCli("deliver-off", false);
	expect(result.code).toBe(0);
	expect(result.out).toContain("MET");
});

test("CLI barrier with deliver:true and undeliverable seats fails loudly and records no notified keys", () => {
	const result = deliverCli("deliver-loud", true);
	expect(result.code).toBe(2);
	expect(result.out).toContain("not proved");
	const state = JSON.parse(readFileSync(join(result.dir, STATE_FILE), "utf8")) as BarrierStateFile;
	expect(state.notified ?? {}).toEqual({});
});

// ---- MISSION: PROPOSED (decisions Q9) -----------------------------------------------------------

const PROPOSED_LINES = GOOD_LINES.replace("MISSION: README.md:3", "MISSION: PROPOSED");
const PROPOSED_JSON = { ...GOOD_JSON, mission: "PROPOSED", mission_proposed: "Ship the demo to every user." };
const NO_MISSION_DOCS = { "README.md": "# Demo\n\nNo mission stated yet.\n" };

function validateCli(name: string, raw: RawBundle, body: string): { code: number | null; report: { status: string; errors: string[] } } {
	const config = join(workspace, "proposed-config.json");
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" } }, approver: "Op" }));
	const path = join(workspace, `${name}.md`);
	writeFileSync(path, body);
	const result = run(["validate", "--config", config, "--project", "demo", "--raw", rawFile(name, raw), "--report", path, "--now", iso(NOW)]);
	return { code: result.code, report: JSON.parse(result.out).report };
}

test("round 0: MISSION: PROPOSED with its drafted text is ACCEPTED where the repo states no mission", () => {
	const raw = bundle(CLEAN, READY, { docs: NO_MISSION_DOCS });
	const verdict = validateReport(report(PROPOSED_LINES, PROPOSED_JSON), measuredFor(raw), "demo");
	expect(verdict.errors).toEqual([]);
	expect(verdict.fields).toMatchObject({ mission: "PROPOSED", mission_proposed: "Ship the demo to every user." });
	expect(validateCli("proposed", raw, report(PROPOSED_LINES, PROPOSED_JSON)).report).toMatchObject({ status: "ACCEPTED", errors: [] });
});

test("planted: PROPOSED without text, after round 0, beside a stated mission, or text without PROPOSED -> REJECTED", () => {
	const raw = bundle(CLEAN, READY, { docs: NO_MISSION_DOCS });
	expect(validateReport(report(PROPOSED_LINES, { ...PROPOSED_JSON, mission_proposed: " " }), measuredFor(raw), "demo").errors).toEqual(["MISSION: PROPOSED needs the drafted mission text in json.mission_proposed"]);
	expect(validateReport(report(PROPOSED_LINES.replace("ROUND: 0", "ROUND: 1"), { ...PROPOSED_JSON, round: 1 }), measuredFor(raw), "demo").errors).toEqual(["MISSION: PROPOSED is accepted in round 0 only; cite the approved mission as path:line"]);
	expect(validateReport(report(GOOD_LINES, { ...GOOD_JSON, mission_proposed: "x" }), measuredFor(bundle(CLEAN, READY)), "demo").errors).toEqual(["json.mission_proposed is set but MISSION is not PROPOSED"]);
	expect(validateReport(report(GOOD_LINES.replace("MISSION: README.md:3", "MISSION: TBD"), { ...GOOD_JSON, mission: "TBD" }), measuredFor(raw), "demo").errors).toEqual(['mission "TBD" is neither a path:line citation nor PROPOSED']);
	const stated = validateCli("proposed-stated", bundle(CLEAN, READY), report(PROPOSED_LINES, PROPOSED_JSON));
	expect(stated.code).toBe(1);
	expect(stated.report.errors).toEqual(["field mission: report says PROPOSED, but the repo states a mission at README.md:3; cite it"]);
});
