// fleet-round validator (skills/fleet-round). Failure mode: a director's round report is accepted
// on its word: lines and JSON disagree, a claim differs from br, a dead holder's bead counts as
// active, an orphan or cycle passes, a frontier outside focus passes, or an unobservable holder
// reads as PASS. Each planted negative below must go RED; the clean bundle must go GREEN so a
// reject-everything validator also fails. Barrier timer: a missing, rejected or late report, or an
// unreadable source, must keep the barrier from MET, and a repeated blocker must escalate.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CheckOptions, checkDag, checkFocus, checkFrontier, checkMission, checkPile, findMissions, metrics, spotCheck } from "../../skills/fleet-round/scripts/lib/checks.ts";
import { identityDirName, parseSeats, parseTracker, type RawBundle, sanitizePaneKey, ShapeError } from "../../skills/fleet-round/scripts/lib/model.ts";
import { CITATION, CLAIM_VALUE, DONE_CALLBACK, LABEL_LINE, MAX_LINE, matchLine, NO_EPIC, PATTERNS, ROUND_NUMBER, SEAT } from "../../skills/fleet-round/scripts/lib/patterns.ts";
import { loadMeasured, loadPredictionDoc, scoreAll } from "../../skills/fleet-round/scripts/lib/predictions.ts";
import { validateReport } from "../../skills/fleet-round/scripts/lib/report.ts";

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

// ---- a clean bundle in the exact shapes br/tmux/ps/identity files emit (references/evidence.md) ----

type Spec = { id: string; status: string; type?: string; assignee?: string; parent?: string; deps?: [string, string][]; comments?: [string, string, number][]; updated?: number; closed?: number };

function bundle(specs: Spec[], ready: string[], extra: Partial<{ docs: Record<string, string>; identity: Record<string, string> | null; tmux: string | null; ps: string | null }> = {}): RawBundle {
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
		seats: {
			tmux: [{ socket: "/tmp/tmux-test/default", output: extra.tmux === undefined ? "demo:0.1\t%7\t100\tdemo\t0\t1\n" : extra.tmux, error: extra.tmux === null ? "socket does not exist" : null }],
			ps: extra.ps === undefined ? "  100     1 -zsh\n  101   100 bun /home/user/.bun/bin/omp --profile x\n" : extra.ps,
			identity_root: "/home/user/.config/agent-mail/identity",
			identity: [{ key: "/home/user/demo", dir: `/home/user/.config/agent-mail/identity/${identityDirName("/home/user/demo")}`, files: extra.identity === undefined ? { "7": '{"name":"LiveAgent","session_name":"demo","pane_id":"%7","pane_pid":100,"socket_path":"/tmp/tmux-test/default","written_at":"2026-10-12T00:00:00Z"}' } : extra.identity }],
			agent_markers: ["/.bun/bin/omp", "/pi-coding-agent/dist/cli.js"],
		},
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
	expect(pile.findings[0]!.detail).toContain("no agent pane binds GoneAgent");
});

test("planted: holder liveness unobservable (no identity dir) -> UNKNOWN, not PASS", () => {
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }];
	const pile = allChecks(bundle(specs, ["demo-e1.1"], { identity: null }), options({ snapshot: null })).results.find(r => r.name === "pile")!;
	expect(pile.status).toBe("UNKNOWN");
	expect(pile.findings.map(f => [f.kind, f.id])).toContainEqual(["stale-holder-unknown", "demo-e1.3"]);
});

test("planted: tmux unavailable -> UNKNOWN, not PASS", () => {
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }];
	const pile = allChecks(bundle(specs, ["demo-e1.1"], { tmux: null }), options({ snapshot: null })).results.find(r => r.name === "pile")!;
	expect(pile.status).toBe("UNKNOWN");
});

test("legacy identity file without pane_pid is unverified -> UNKNOWN; pid mismatch is stale -> DEAD", () => {
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }];
	const legacy = allChecks(bundle(specs, ["demo-e1.1"], { identity: { "7": "LiveAgent\n" } }), options({ snapshot: null })).results.find(r => r.name === "pile")!;
	expect(legacy.status).toBe("UNKNOWN");
	const stale = allChecks(bundle(specs, ["demo-e1.1"], { identity: { "7": '{"name":"LiveAgent","pane_id":"%7","pane_pid":999}' } }), options({ snapshot: null })).results.find(r => r.name === "pile")!;
	expect(stale.status).toBe("FAIL");
	expect(stale.findings.find(f => f.id === "demo-e1.3")!.detail).toContain("earlier pane_pid");
});

test("composite pane key binds too (session:window:pane sanitized to session-window-pane)", () => {
	expect(sanitizePaneKey("omp-test:0:1")).toBe("omp-test-0-1");
	expect(sanitizePaneKey("%38")).toBe("38");
	const specs = [...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }];
	const view = parseSeats(bundle(specs, [], { identity: { "demo-0-1": '{"name":"LiveAgent","pane_id":"%7","pane_pid":100}' } }));
	expect(view.bindings.get("demo:0.1")).toEqual([{ name: "LiveAgent", verified: true, stale: false, file: `/home/user/.config/agent-mail/identity/${identityDirName("/home/user/demo")}/demo-0-1` }]);
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
	expect(pile.findings.find(f => f.id === "ompkit-2w7h")).toMatchObject({ kind: "stale-no-holder", status: "FAIL" });
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

function run(args: string[]): { code: number | null; out: string } {
	const child = Bun.spawnSync(["bun", "run", "--no-env-file", "--config=/dev/null", cli, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

test("CLI validate: clean report exits 0, planted report exits 1, unknown holder exits 3", () => {
	const config = join(workspace, "config.json");
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" } }, approver: "Op" }));
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
	writeFileSync(unknownRaw, JSON.stringify(bundle([...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent", updated: NOW - 30 * HOUR }], ["demo-e1.1"], { identity: null })));
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
		const time = (n: number): number => {
			const input = make(n);
			const start = performance.now();
			for (let i = 0; i < 2_000; i++) matchLine(pattern, input);
			return performance.now() - start;
		};
		time(1000);
		const short = time(1000);
		const long = time(2000);
		expect(matchLine(pattern, make(2000))).toBeNull();
		expect(long / Math.max(short, 0.5)).toBeLessThan(4);
	}
});

// ---- barrier timer -------------------------------------------------------------------------------

// Agent Mail's three tables exactly as `.schema` printed them on the reference host (REA
// ev_245b51e8..., references/evidence.md), minus triggers and indexes the timer never touches.
const MAIL_DDL = `
CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, human_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL, program TEXT NOT NULL, model TEXT NOT NULL, task_description TEXT NOT NULL DEFAULT '', inception_ts INTEGER NOT NULL, last_active_ts INTEGER NOT NULL, attachments_policy TEXT NOT NULL DEFAULT 'auto', contact_policy TEXT NOT NULL DEFAULT 'auto', reaper_exempt INTEGER NOT NULL DEFAULT 0, registration_token TEXT, retired_at INTEGER, UNIQUE(project_id, name));
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), sender_id INTEGER NOT NULL REFERENCES agents(id), thread_id TEXT, topic TEXT COLLATE NOCASE, subject TEXT NOT NULL, body_md TEXT NOT NULL, importance TEXT NOT NULL DEFAULT 'normal', ack_required INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, recipients_json TEXT NOT NULL DEFAULT '{}', attachments TEXT NOT NULL DEFAULT '[]');
`;
const FLEET_KEY = "/home/user/fleet";
const MINUTE = 60_000;
const T0 = NOW - 3 * HOUR; // INSIGHT opens; 2 h timebox, so its deadline is NOW - 1 h
const DEADLINE = T0 + 2 * HOUR;
type Mail = { from: string; body: string; at: number; thread?: string; key?: string };

/** A store with the observed schema; created_ts in integer microseconds as observed. */
function mailDb(name: string, mails: Mail[], ddl = MAIL_DDL): string {
	const path = join(workspace, `${name}.sqlite3`);
	rmSync(path, { force: true });
	const db = new Database(path);
	db.exec(ddl);
	const projects = new Map<string, number>();
	const agents = new Map<string, number>();
	const projectId = (key: string): number => {
		if (!projects.has(key)) projects.set(key, Number(db.query("INSERT INTO projects (slug, human_key, created_at) VALUES (?, ?, ?)").run(key.slice(1).split("/").join("-"), key, T0 * 1000).lastInsertRowid));
		return projects.get(key)!;
	};
	projectId(FLEET_KEY);
	for (const mail of mails) {
		const project = projectId(mail.key ?? FLEET_KEY);
		const who = `${project}:${mail.from}`;
		if (!agents.has(who)) agents.set(who, Number(db.query("INSERT INTO agents (project_id, name, program, model, inception_ts, last_active_ts) VALUES (?, ?, 'omp', 'm', ?, ?)").run(project, mail.from, T0 * 1000, T0 * 1000).lastInsertRowid));
		db.query("INSERT INTO messages (project_id, sender_id, thread_id, subject, body_md, created_ts) VALUES (?, ?, ?, 'round report', ?, ?)").run(project, agents.get(who)!, mail.thread ?? "fleet-round-0", mail.body, mail.at * 1000 + 123);
	}
	db.close();
	return path;
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

type BarrierJson = { state: string; projects: { project: string; verdict: string; reasons: string[]; cached: boolean; consecutive_misses: number; escalate: boolean }[]; escalate: string[]; unavailable: string[]; mail: { available: boolean; reason: string | null; other_messages: number } };
function barrier(db: string, opts: { state: string; phase?: string; opened?: number; now?: number; raw?: string[]; outMd?: string }): { code: number | null; json: BarrierJson; out: string } {
	const config = join(workspace, "barrier-config.json");
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" }, kit: { root: join(workspace, "no-such-kit-root") } }, approver: "Op", barrier: { agent_mail_db: db, mail_project: FLEET_KEY, hours: { INSIGHT: 2, AGREE: 1, SORT: 8 } } }));
	const args = ["barrier", "--config", config, "--round", "0", "--phase", opts.phase ?? "INSIGHT", "--opened-at", iso(opts.opened ?? T0), "--state", opts.state, "--now", iso(opts.now ?? NOW), ...(opts.raw ?? raws()).flatMap(spec => ["--raw", spec])];
	const result = run(opts.outMd ? [...args, "--out-json", join(opts.state, "barrier.json"), "--out-md", opts.outMd] : args);
	const json = JSON.parse(opts.outMd ? readFileSync(join(opts.state, "barrier.json"), "utf8") : result.out) as BarrierJson;
	return { code: result.code, json, out: result.out };
}
const verdicts = (json: BarrierJson): Record<string, string> => Object.fromEntries(json.projects.map(p => [p.project, p.verdict]));
const projectOf = (json: BarrierJson, name: string) => json.projects.find(p => p.project === name)!;

test("barrier: every report accepted before the deadline -> MET, exit 0 (positive control)", () => {
	const db = mailDb("met", [
		{ from: "Chief", body: "Round 0 is open.\n\nPHASE: insight\n", at: T0 + MINUTE },
		{ from: "DemoDirector", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit"), at: T0 + 40 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { round: 1, inProgress: 9 }), at: T0 + 50 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { inProgress: 9 }), at: T0 + 55 * MINUTE, thread: "fleet-round-1" },
	]);
	const early = barrier(db, { state: roundDir("met"), now: T0 + HOUR });
	expect(early.code).toBe(0);
	expect(early.json.state).toBe("MET");
	expect(verdicts(early.json)).toEqual({ demo: "ACCEPTED", kit: "ACCEPTED" });
	expect(early.json.mail.other_messages).toBe(2);
	const after = barrier(db, { state: roundDir("met-after") });
	expect([after.code, after.json.state]).toEqual([0, "MET"]);
	const sort = barrier(mailDb("sort", [{ from: "D", body: reportFor("demo", { phase: "execute" }), at: T0 + HOUR }, { from: "K", body: reportFor("kit", { phase: "execute" }), at: T0 + HOUR }]), { state: roundDir("sort"), phase: "SORT" });
	expect([sort.code, sort.json.state]).toEqual([0, "MET"]);
});

test("planted: a project with no report -> MISSING; OPEN before the deadline (exit 4), MISSED after (exit 1)", () => {
	const db = mailDb("missing", [
		{ from: "DemoDirector", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { phase: "agree" }), at: T0 + 30 * MINUTE },
	]);
	const open = barrier(db, { state: roundDir("missing-open"), now: T0 + HOUR });
	expect([open.code, open.json.state]).toEqual([4, "OPEN"]);
	expect(verdicts(open.json)).toEqual({ demo: "ACCEPTED", kit: "MISSING" });
	const missed = barrier(db, { state: roundDir("missing") });
	expect([missed.code, missed.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(missed.json, "kit")).toMatchObject({ verdict: "MISSING", reasons: ["no insight report for round 0 in fleet-round-0"] });
});

test("planted: a report whose claim differs from br -> REJECTED naming the claim; barrier MISSED", () => {
	const db = mailDb("rejected", [
		{ from: "DemoDirector", body: reportFor("demo"), at: T0 + 20 * MINUTE },
		{ from: "KitDirector", body: reportFor("kit", { inProgress: 5 }), at: T0 + 30 * MINUTE },
	]);
	const result = barrier(db, { state: roundDir("rejected") });
	expect([result.code, result.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(result.json, "kit")).toMatchObject({ verdict: "REJECTED", reasons: ["CLAIM C1 in_progress: reported 5, validator measured 1"] });
	expect(projectOf(result.json, "demo").verdict).toBe("ACCEPTED");
});

test("planted: a report after the deadline -> LATE; one exactly at the deadline is on time", () => {
	const late = barrier(mailDb("late", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: DEADLINE + MINUTE }]), { state: roundDir("late") });
	expect([late.code, late.json.state]).toEqual([1, "MISSED"]);
	expect(projectOf(late.json, "kit").verdict).toBe("LATE");
	expect(projectOf(late.json, "kit").reasons[0]).toContain("after the deadline 2026-10-12T11:00:00.000Z");
	const edge = barrier(mailDb("edge", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: DEADLINE }]), { state: roundDir("edge") });
	expect([edge.code, edge.json.state]).toEqual([0, "MET"]);
});

test("planted: an unreadable source -> exit 3, never MET", () => {
	const both = [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: T0 + 30 * MINUTE }];
	const noDb = barrier(join(workspace, "absent.sqlite3"), { state: roundDir("no-db") });
	expect(noDb.code).toBe(3);
	expect(noDb.json.state).toBe("UNKNOWN");
	expect(verdicts(noDb.json)).toEqual({ demo: "UNKNOWN", kit: "UNKNOWN" });
	// Every report is on time and would be ACCEPTED, but kit's tracker cannot be read: not MET.
	const noTracker = barrier(mailDb("no-tracker", both), { state: roundDir("no-tracker"), now: T0 + HOUR, raw: [raws()[0]!] });
	expect(noTracker.code).toBe(3);
	expect(noTracker.json.state).toBe("OPEN");
	expect(verdicts(noTracker.json)).toEqual({ demo: "ACCEPTED", kit: "UNKNOWN" });
	expect(noTracker.json.unavailable).toEqual(["kit"]);
	const drift = barrier(mailDb("drift", [], MAIL_DDL.replace("created_ts INTEGER", "created_at INTEGER")), { state: roundDir("drift") });
	expect(drift.code).toBe(3);
	expect(drift.json.mail.reason).toContain("lacks created_ts");
	const otherKey = barrier(mailDb("other-key", both.map(m => ({ ...m, key: "/home/user/elsewhere" }))), { state: roundDir("other-key") });
	expect(otherKey.code).toBe(1); // the configured key exists with no reports: a definite miss, not unknown
	const unregistered = join(workspace, "unregistered.sqlite3");
	rmSync(unregistered, { force: true });
	const bare = new Database(unregistered);
	bare.exec(MAIL_DDL);
	bare.close();
	const noProject = barrier(unregistered, { state: roundDir("no-project") });
	expect([noProject.code, noProject.json.state]).toEqual([3, "UNKNOWN"]);
	expect(noProject.json.mail.reason).toContain("0 projects with key /home/user/fleet");
});

test("planted: the same blocker at two consecutive barriers -> ESCALATE; a different blocker does not", () => {
	const agreeOpen = DEADLINE + 5 * MINUTE;
	const agreeNow = agreeOpen + HOUR + 5 * MINUTE;
	const db = mailDb("escalate", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "D", body: reportFor("demo", { phase: "agree" }), at: agreeOpen + 10 * MINUTE }]);
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

	const mixed = mailDb("mixed", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "D", body: reportFor("demo", { phase: "agree" }), at: agreeOpen + 10 * MINUTE }, { from: "K", body: reportFor("kit", { phase: "agree", inProgress: 5 }), at: agreeOpen + 10 * MINUTE }]);
	const other = roundDir("mixed");
	barrier(mixed, { state: other, now: DEADLINE + MINUTE });
	const changed = barrier(mixed, { state: other, phase: "AGREE", opened: agreeOpen, now: agreeNow });
	expect(projectOf(changed.json, "kit")).toMatchObject({ verdict: "REJECTED", consecutive_misses: 2, escalate: false });
});

test("a report is judged once, when first seen: later tracker work cannot flip it", () => {
	const db = mailDb("cache", [{ from: "D", body: reportFor("demo"), at: T0 + 20 * MINUTE }, { from: "K", body: reportFor("kit"), at: T0 + 30 * MINUTE }]);
	const moved = [raws()[0]!, `kit=${rawFile("kit-moved", { ...bundle([...CLEAN, { id: "demo-e1.3", status: "in_progress", parent: "demo-e1", assignee: "LiveAgent" }], READY), project: "kit" })}`];
	const dir = roundDir("cache");
	expect(barrier(db, { state: dir, now: T0 + 40 * MINUTE }).json.state).toBe("MET");
	const later = barrier(db, { state: dir, raw: moved });
	expect(projectOf(later.json, "kit")).toMatchObject({ verdict: "ACCEPTED", cached: true });
	const fresh = barrier(db, { state: roundDir("cache-fresh"), raw: moved });
	expect(projectOf(fresh.json, "kit")).toMatchObject({ verdict: "REJECTED", cached: false });
});

test("barrier usage: missing barrier config, bad phase or round, missing state dir exit 2", () => {
	const config = join(workspace, "plain-config.json");
	writeFileSync(config, JSON.stringify({ schema: "fleet-round.config/v1", projects: { demo: { root: "/home/user/demo" } } }));
	const dir = roundDir("usage");
	const base = ["--round", "0", "--phase", "INSIGHT", "--opened-at", iso(T0), "--state", dir];
	expect(run(["barrier", "--config", config, ...base]).out).toContain('needs a "barrier" section');
	const db = mailDb("usage", []);
	barrier(db, { state: dir });
	const configured = join(workspace, "barrier-config.json");
	for (const bad of [["--phase", "MEASURE"], ["--round", "01"], ["--state", join(workspace, "absent-dir")]]) {
		const args = [...base];
		args[args.indexOf(bad[0]!) + 1] = bad[1]!;
		expect(run(["barrier", "--config", configured, ...args]).code).toBe(2);
	}
});
