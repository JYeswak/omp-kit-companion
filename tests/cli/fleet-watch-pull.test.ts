import { expect, test } from "bun:test";
import { YAML } from "bun";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	WORKER_REPLIES,
	choosePull,
	gradingQueue,
	loadFleetWatchConfig,
	nudgeText,
	parseIssuesJsonl,
	parsePolicy,
	parseReadyRows,
	parseTriage,
	parseWorkerReply,
	reportCommand,
	reviewStatuses,
	runFleetWatchOnce,
	runJson,
	type FleetWatchConfig,
	type FleetWatchOnceDeps,
	type FleetWatchSession,
	type PullPick,
	type PullProbes,
	type ReadyRow,
	type TrackerIssue,
	type TrackerPolicy,
	type TriageResult,
} from "../../src/fleet-watch.ts";

// ompkit-364w: decisions Q20 (pull order, close rule) and Q22 (reply vocabulary, NO-WORK), with planted negatives.

const repoRoot = resolve(import.meta.dir, "../..");
const fixtures = join(repoRoot, "tests", "fixtures", "fleet-watch");
const policyOf = (name: string): TrackerPolicy => parsePolicy(YAML.parse(readFileSync(join(fixtures, name), "utf8")))!;
const OMP_KIT_POLICY = policyOf("policy.omp-kit.yaml");
const UDS_POLICY = policyOf("policy.uds.yaml");
const C8_NOW = 1_792_598_400_000;

const session: FleetWatchSession = {
	session: "work",
	coordinatorSession: "work",
	coordinatorPane: "%54",
	repo: "/repo",
	workerPanes: ["%1", "%2"],
	focusEpics: ["x-epic"],
	mission: "ROADMAP.md:9",
	round: 1,
	phase: "SORT",
};
const SEATS: Record<string, string> = { "%1": "GreenWorker", "%2": "BlueWorker" };

const leaf = (id: string): ReadyRow => ({ id, status: "open", assignee: null, labels: [], issue_type: "task" });
const issue = (id: string, extra: Partial<TrackerIssue> = {}): TrackerIssue => ({ id, status: "open", priority: 2, labels: [], parents: [], comments: [], ...extra });
const review = (id: string, assignee: string): ReadyRow => ({ id, status: "in_review", assignee, labels: [], issue_type: "task" });

type World = {
	readyRows: ReadyRow[] | null;
	readyFailure?: string | null;
	statusRows: ReadyRow[] | null;
	issues: TrackerIssue[] | null;
	triage: TriageResult;
	seats: Record<string, string>;
};

function world(overrides: Partial<World> = {}): World {
	return { readyRows: [], statusRows: [], issues: [], triage: { usable: true, ids: [] }, seats: SEATS, ...overrides };
}

function scratchDir(): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	return ownedTmp("fleet-watch-pull", { root: parent, bead: "ompkit-fp72.120.16.10.11" }).path;
}

type HarnessOptions = {
	cc?: boolean;
	now?: () => number;
	capture?: (session: string, pane: string) => { code: number; stdout: string; stderr: string };
	admission?: FleetWatchOnceDeps["admission"];
	send?: (session: string, pane: string, text: string) => void;
	workAudit?: FleetWatchOnceDeps["workAudit"];
};

/** Idle panes, injected probes; `state` persists idle counts and parks across fresh invocations like the service. */
function harness(
	config: FleetWatchConfig,
	current: { world: World },
	busy: string[] = [],
	policy: TrackerPolicy = OMP_KIT_POLICY,
	options: HarnessOptions = {},
) {
	const dir = scratchDir();
	const ccStateDir = options.cc ? join(dir, "cc-state") : undefined;
	if (ccStateDir !== undefined) {
		mkdirSync(ccStateDir);
		mkdirSync(join(ccStateDir, "spool"));
	}
	const sends: { pane: string; text: string }[] = [];
	const pullProbes: PullProbes = {
		readPolicy: () => policy,
		listStatuses: () => current.world.statusRows,
		readIssues: () => current.world.issues,
		triage: () => current.world.triage,
		resolveWorker: (_repo, pane) => current.world.seats[pane] ?? null,
		resolveWorkerIdentity: (_repo, pane) => {
			const agent = current.world.seats[pane];
			return agent === undefined ? null : { agent, binding: null };
		},
		readNativeState: () => ({ ok: false, reason: "synthetic selection fixture supplies no native custody observation" }),
	};
	const deps = {
		capture: options.capture ?? ((_session: string, pane: string) => ({ code: 0, stdout: busy.includes(pane) ? "⠋ working" : "idle", stderr: "" })),
		send: (session: string, pane: string, text: string) => {
			sends.push({ pane, text });
			options.send?.(session, pane, text);
		},
		sendKeys: () => {},
		logPath: join(dir, "fleet-watch.jsonl"),
		statePath: join(dir, "fleet-watch-state.json"),
		now: options.now ?? (() => 0),
		recoverTracker: () => null,
		preassignProbes: { findRecoveryFlags: () => [], listReadyRows: () => ({ rows: current.world.readyRows, failure: current.world.readyFailure ?? null }) },
		pullProbes,
		...(ccStateDir === undefined ? {} : { ccStateDir }),
		...(options.admission === undefined ? {} : { admission: options.admission }),
		...(options.workAudit === undefined ? {} : { workAudit: options.workAudit }),
	};
	return {
		sends,
		tick: () => runFleetWatchOnce(config, deps),
		worker: (pane: string) => sends.filter((send) => send.pane === pane).map((send) => send.text),
		coordinator: () => sends.filter((send) => send.pane === "%54").map((send) => send.text),
		state: () => JSON.parse(readFileSync(deps.statePath, "utf8")),
		statePath: deps.statePath,
		logPath: deps.logPath,
		ccStateDir,
	};
}

const configOf = (overrides: Partial<FleetWatchSession> = {}): FleetWatchConfig => ({ enabled: true, intervalSeconds: 120, noDecisionChecks: 99, sessions: [{ ...session, ...overrides }] });

/** Two idle ticks: the second reaches the nudge threshold. */
function nudgeOnce(config: FleetWatchConfig, current: World, busy: string[] = ["%2"], policy: TrackerPolicy = OMP_KIT_POLICY) {
	const run = harness(config, { world: current }, busy, policy);
	run.tick();
	run.tick();
	return run;
}

test("[grade] eligible in_review bead by another author is named first, with both outcomes, even with zero ready leaves", () => {
	const run = nudgeOnce(configOf(), world({ readyRows: [], statusRows: [review("x-9", "BlueWorker")], triage: { usable: true, ids: ["x-1"] } }));
	const [text] = run.worker("%1");
	expect(text).toContain("Grade x-9 first (in_review, author BlueWorker; never grade your own)");
	expect(text).toContain("br close it with the evidence in the close reason, then omp-kit send work %54 \"CLOSED x-9 <sha> <evidence>\"");
	expect(text).toContain("naming each failed item with its evidence command and output and what success looks like");
	expect(text).toContain("regex-engineering, verification-before-completion); set status rework; unassign; then omp-kit send work %54 \"REWORK x-9 <gaps>\"");
	expect(text).toContain("mission ROADMAP.md:9; round 1 SORT; focus x-epic.");
	expect(run.coordinator()).toEqual([]);
});

test("[grade] a grader is never handed its own bead: own item skipped, next item chosen", () => {
	const run = nudgeOnce(configOf(), world({ statusRows: [review("x-own", "GreenWorker"), review("x-other", "BlueWorker")] }));
	const [text] = run.worker("%1");
	expect(text).toContain("Grade x-other first");
	expect(text).not.toContain("x-own");
});

test("[grade] an unresolved seat identity is never handed a grading item (authorship unprovable)", () => {
	const run = nudgeOnce(configOf(), world({ seats: {}, statusRows: [review("x-9", "BlueWorker")], readyRows: [leaf("x-1")], triage: { usable: true, ids: ["x-1"] }, issues: [issue("x-1", { parents: ["x-epic"] })] }));
	const [text] = run.worker("%1");
	expect(text).not.toContain("x-9");
	expect(text).toContain("take x-1 (bv --robot-triage #1, under x-epic)");
});

test("[grade] a known worker cannot verify unknown authorship while healthy product work remains", () => {
	const choice = choosePull({
		sessionName: "work", worker: "GreenWorker", liveWorkers: new Set(),
		grading: [{ id: "x-unknown", status: "in_review", author: null, via: "in_review", labels: [] }],
		rework: [], triage: { usable: true, ids: ["x-healthy"] }, issues: [],
		readyRows: [leaf("x-healthy")], policy: OMP_KIT_POLICY, focus: [], skipLabels: [], taken: new Set(),
		coordinator: { actor: "Director", session: "work", pane: "%54" },
	});
	expect(choice).toMatchObject({
		ready: true, pick: { id: "x-healthy", kind: "TRIAGE" },
		refusals: [{ bead: "x-unknown", class: "unsafe_custody", actor: "Director", next: expect.stringContaining("implementer") }],
	});
});

test("[grade] DONE callbacks join the queue until another author answers", () => {
	const done = { author: "BlueWorker", text: "DONE x-5 abc1234 landed, tests green" };
	const queued = (comments: TrackerIssue["comments"]) => gradingQueue([], [issue("x-5", { status: "in_progress", comments })], ["in_review"]).map((item) => `${item.id}:${item.author}`);
	expect(queued([done])).toEqual(["x-5:BlueWorker"]);
	expect(queued([done, { author: "BlueWorker", text: "GRADE PASS self-check" }])).toEqual(["x-5:BlueWorker"]);
	expect(queued([done, { author: "GreenWorker", text: "REWORK x-5 2 gaps: A1 A3" }])).toEqual([]);
	expect(queued([done, { author: "GreenWorker", text: "CLOSED x-5 abc1234 all acceptance verified" }])).toEqual([]);
	expect(queued([done, { author: "GreenWorker", text: "GRADE PASS: abc1234 independently verified" }])).toEqual([]);
	expect(queued([{ author: "BlueWorker", text: "DONE x-5 PASS abc1234 (pre-Q22 shape)" }])).toEqual([]);
	expect(queued([{ author: "BlueWorker", text: "DONE x-6 abc1234 wrong bead" }])).toEqual([]);
});

test("[rework] rework item is picked before triage, also with zero ready leaves", () => {
	const reworkRow: ReadyRow = { id: "x-7", status: "rework", assignee: null, labels: [], issue_type: "task" };
	const run = nudgeOnce(configOf(), world({ readyRows: [], statusRows: [reworkRow], triage: { usable: true, ids: ["x-1"] } }));
	const [text] = run.worker("%1");
	expect(text).toContain("Nothing to grade; rework x-7: its latest rework comment is the brief");
	expect(text).toContain("set it in_review again");
});

test("[rework] the original implementer gets its rework item while its seat is live; any worker otherwise", () => {
	const reworkRow: ReadyRow = { id: "x-7", status: "rework", assignee: null, labels: [], issue_type: "task" };
	const issues = [issue("x-7", { status: "rework", comments: [{ author: "BlueWorker", text: "DONE x-7 abc1234 first attempt" }] }), issue("x-1", { parents: ["x-epic"] })];
	const base = world({ readyRows: [leaf("x-1")], statusRows: [reworkRow], issues, triage: { usable: true, ids: ["x-1"] } });
	const live = nudgeOnce(configOf(), base, []);
	expect(live.worker("%1")[0]).toContain("take x-1");
	expect(live.worker("%2")[0]).toContain("rework x-7 (implementer BlueWorker)");
	const gone = nudgeOnce(configOf(), { ...base, seats: { "%1": "GreenWorker" } }, ["%2"]);
	expect(gone.worker("%1")[0]).toContain("rework x-7 (implementer BlueWorker)");
});

test("[rework] grading picks the rework route the policy allows", () => {
	const pick = (policy: TrackerPolicy, status: string) => choosePull({
		sessionName: "work", worker: "GreenWorker", liveWorkers: new Set(), grading: [{ id: "x-9", status, author: "BlueWorker", via: status, labels: [] }],
		rework: [], triage: { usable: true, ids: [] }, issues: [], readyRows: [], policy, focus: [], skipLabels: [], taken: new Set(),
	});
	expect(pick(OMP_KIT_POLICY, "in_review")).toMatchObject({ ready: true, pick: { kind: "GRADE", rework: "set status rework" } });
	expect(pick(UDS_POLICY, "grading")).toMatchObject({ ready: true, pick: { kind: "GRADE", rework: "set status open, add label rework" } });
});

test("[triage] the first bv recommendation under a focus epic wins; a higher-ranked pick outside focus is not chosen", () => {
	const issues = [issue("y-1"), issue("x-2", { parents: ["x-epic"] }), issue("x-epic.3")];
	const run = nudgeOnce(configOf(), world({ readyRows: [leaf("y-1"), leaf("x-2"), leaf("x-epic.3")], issues, triage: { usable: true, ids: ["y-1", "x-2", "x-epic.3"] } }));
	const [text] = run.worker("%1");
	expect(text).toContain("take x-2 (bv --robot-triage #2, under x-epic)");
	expect(text).not.toContain("y-1");
});

test("[triage] a recommendation br ready does not confirm as a claimable leaf is skipped", () => {
	const issues = [issue("x-2", { parents: ["x-epic"] }), issue("x-3", { parents: ["x-epic"] })];
	const run = nudgeOnce(configOf(), world({ readyRows: [{ ...leaf("x-2"), assignee: "SomeoneElse" }, leaf("x-3")], issues, triage: { usable: true, ids: ["x-2", "x-3"] } }));
	expect(run.worker("%1")[0]).toContain("take x-3 (bv --robot-triage #2, under x-epic)");
});

test("[fallback] bv unavailable falls back to br ready order under focus and says so", () => {
	const issues = [issue("y-1"), issue("x-2", { parents: ["x-epic"] })];
	const run = nudgeOnce(configOf(), world({ readyRows: [leaf("y-1"), leaf("x-2")], issues, triage: { usable: false, reason: "bv --robot-triage exited 1" } }));
	const [text] = run.worker("%1");
	expect(text).toContain("bv unusable: bv --robot-triage exited 1, so this is the br ready fallback: take x-2 (under x-epic)");
});

test("[triage] bv top-N with no focus leaf falls through to the first focus ready leaf (FWFOCUS1)", () => {
	const issues = [issue("y-1"), issue("y-2"), issue("x-5", { parents: ["x-epic"] })];
	const run = nudgeOnce(configOf(), world({ readyRows: [leaf("y-1"), leaf("y-2"), leaf("x-5")], issues, triage: { usable: true, ids: ["y-1", "y-2"] } }));
	expect(run.worker("%1")[0]).toContain("bv top-2 has no focus leaf, so this is the br ready fallback: take x-5 (under x-epic)");
	const none = nudgeOnce(configOf(), world({ readyRows: [leaf("y-1"), leaf("y-2")], issues: [issue("y-1"), issue("y-2")], triage: { usable: true, ids: ["y-1", "y-2"] } }), ["%2"]);
	expect(none.worker("%1")).toEqual([]);
	expect(none.coordinator()[0]).toContain("NO_TRIAGE_PICK");
});

test("[pause] round phase INSIGHT and pullEnabled false send no pull nudge, no escalation", () => {
	const busyWorld = world({ statusRows: [review("x-9", "BlueWorker")], readyRows: [leaf("x-1")] });
	for (const paused of [{ phase: "INSIGHT" }, { pullEnabled: false }]) {
		const run = harness(configOf(paused), { world: busyWorld }, ["%2"]);
		for (let tick = 0; tick < 6; tick++) run.tick();
		expect(run.sends).toEqual([]);
	}
	const control = nudgeOnce(configOf({ phase: "SORT" }), busyWorld);
	expect(control.worker("%1")).toHaveLength(1);
});

test("[transport] every nudge reports with omp-kit send, never ntm send", () => {
	const picks: PullPick[] = [
		{ kind: "GRADE", id: "x-9", via: "in_review", author: "BlueWorker", rework: "set status rework" },
		{ kind: "REWORK", id: "x-7", implementer: null },
		{ kind: "TRIAGE", id: "x-2", rank: 1, epic: "x-epic" },
		{ kind: "READY", id: "x-2", reason: "bv unusable: missing", epic: null },
	];
	for (const pick of picks) {
		const text = nudgeText(session, pick);
		expect(text).toContain("omp-kit send work %54 \"");
		expect(text).not.toContain("ntm send");
	}
});

test("[no-work] empty queues park the seat silently; another worker's DONE moving a bead to in_review wakes it next tick", () => {
	const current = { world: world({ readyRows: [], triage: { usable: true, ids: [] } }) };
	const run = harness(configOf(), current, ["%2"]);
	run.tick();
	run.tick();
	expect(run.worker("%1")).toEqual([]);
	expect(run.coordinator()).toHaveLength(1);
	expect(run.coordinator()[0]).toContain("NO_FREE_LEAF");
	expect(run.state().panes["work:%1"].parked).toBe(true);
	for (let tick = 0; tick < 4; tick++) run.tick();
	expect(run.sends).toHaveLength(1);
	current.world = world({ readyRows: [], statusRows: [review("x-9", "BlueWorker")] });
	run.tick();
	expect(run.worker("%1")).toHaveLength(1);
	expect(run.worker("%1")[0]).toContain("Grade x-9 first");
	expect(run.state().panes["work:%1"].parked).toBeUndefined();
});

test("[no-work] a parked seat also wakes on a new ready leaf, not only a focus change", () => {
	const current = { world: world({ readyRows: [leaf("y-1")], issues: [issue("y-1")], triage: { usable: true, ids: ["y-1"] } }) };
	const run = harness(configOf(), current, ["%2"]);
	run.tick();
	run.tick();
	expect(run.coordinator()[0]).toContain("NO_TRIAGE_PICK");
	run.tick();
	current.world = world({ readyRows: [leaf("y-1"), leaf("x-4")], issues: [issue("y-1"), issue("x-4", { parents: ["x-epic"] })], triage: { usable: true, ids: ["y-1", "x-4"] } });
	run.tick();
	expect(run.worker("%1")[0]).toContain("take x-4");
});

test("[tick] two idle seats in one tick get different items", () => {
	const run = nudgeOnce(configOf(), world({ statusRows: [review("x-8", "Third"), review("x-9", "Third")] }), []);
	expect(run.worker("%1")[0]).toContain("Grade x-8 first");
	expect(run.worker("%2")[0]).toContain("Grade x-9 first");
});
test("[C8] pull.attempt mirrors watcher outcomes with stable identity and per-pass coverage", () => {
	const current = world({
		readyRows: [leaf("ompkit-c8")],
		issues: [issue("ompkit-c8", { parents: ["x-epic"] })],
		triage: { usable: true, ids: ["ompkit-c8"] },
	});
	let nowMs = C8_NOW;
	const run = harness(configOf({ workerPanes: ["%1"] }), { world: current }, [], OMP_KIT_POLICY, {
		cc: true,
		now: () => nowMs++,
	});
	for (let i = 0; i < 5; i++) run.tick();

	const spool = join(run.ccStateDir!, "spool", "watcher", `${new Date(C8_NOW).toISOString().slice(0, 10)}.jsonl`);
	const events = readFileSync(spool, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const pulls = events.filter((event) => event.type === "pull.attempt");
	const ticks = events.filter((event) => event.type === "source.tick");
	expect(pulls.map((event) => event.data.outcome)).toEqual(["NUDGED", "ESCALATED"]);
	expect(pulls[0]).toMatchObject({
		seat: "work/%1",
		session: "work",
		binding: null,
		agent: "GreenWorker",
		data: { outcome: "NUDGED", refusal_class: null, picked_bead: "ompkit-c8" },
	});
	expect(Object.keys(pulls[0]!.data).sort()).toEqual(["outcome", "picked_bead", "refusal_class"]);
	expect(ticks).toHaveLength(5);
	expect(ticks[1]!.data).toMatchObject({
		records_seen: 1,
		records_emitted: 1,
		records_ignored: 0,
		records_quarantined: 0,
		coverage: [{ record_type: "record:NUDGED", runtime_version: "1", disposition: "emitted", reason: null, count: 1 }],
	});
	const positions = [...pulls, ...ticks].map((event) => event.position);
	expect(new Set(positions).size).toBe(positions.length);
	const logRows = readFileSync(run.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const loggedKinds = logRows.map((row) => row.kind);
	expect(loggedKinds.filter((kind) => kind === "NUDGED" || kind === "ESCALATED")).toEqual(["NUDGED", "ESCALATED"]);
	expect(pulls.map((event) => event.time)).toEqual(logRows.filter((row) => row.kind === "NUDGED" || row.kind === "ESCALATED").map((row) => row.at));
});

test("[C8] all pane action classes use typed outcomes and never copy capture text", () => {
	const token = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;
	const failedCapture = harness(configOf({ workerPanes: ["%1"] }), { world: world() }, [], OMP_KIT_POLICY, {
		cc: true,
		now: () => C8_NOW,
		capture: () => ({ code: 1, stdout: "", stderr: `capture failed ${token}` }),
	});
	failedCapture.tick();
	const day = new Date(C8_NOW).toISOString().slice(0, 10);
	const failedPath = join(failedCapture.ccStateDir!, "spool", "watcher", `${day}.jsonl`);
	const failedText = readFileSync(failedPath, "utf8");
	const failedEvents = failedText.trim().split("\n").map((line) => JSON.parse(line));
	const failedPull = failedEvents.find((event) => event.type === "pull.attempt");
	expect(failedPull!.data).toEqual({ outcome: "NO_DECISION", refusal_class: null, picked_bead: null });
	expect(failedText).not.toContain(token);

	const steering = harness(configOf({ workerPanes: ["%1"] }), { world: world() }, [], OMP_KIT_POLICY, {
		cc: true,
		now: () => C8_NOW,
		capture: () => ({ code: 0, stdout: "Steering · 1\n⌥↑ to edit", stderr: "" }),
	});
	steering.tick();
	const steeringPath = join(steering.ccStateDir!, "spool", "watcher", `${day}.jsonl`);
	const steeringEvents = readFileSync(steeringPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(steeringEvents.find((event) => event.type === "pull.attempt")!.data).toEqual({
		outcome: "STEERING_SUBMITTED",
		refusal_class: null,
		picked_bead: null,
	});
});

test("[C8] denied watcher sends produce an ADMISSION_REFUSED event with the selected bead", () => {
	const run = harness(configOf({ workerPanes: ["%1"] }), {
		world: world({
			readyRows: [leaf("ompkit-c8")],
			issues: [issue("ompkit-c8", { parents: ["x-epic"] })],
			triage: { usable: true, ids: ["ompkit-c8"] },
		}),
	}, [], OMP_KIT_POLICY, {
		cc: true,
		now: () => C8_NOW,
		admission: {
			launcherBinding: "none",
			authority: "OFF",
			authorityConfirmed: true,
			authorityGeneration: null,
			launchers: [],
			keeper: null,
			packet: { action: "send", ownedAction: "send", generation: null },
			governedActions: ["send"],
		},
	});
	run.tick();
	run.tick();
	const spool = join(run.ccStateDir!, "spool", "watcher", `${new Date(C8_NOW).toISOString().slice(0, 10)}.jsonl`);
	const events = readFileSync(spool, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const pull = events.find((event) => event.type === "pull.attempt");
	expect(pull!.data).toEqual({
		outcome: "ADMISSION_REFUSED",
		refusal_class: "ADMISSION_REFUSED",
		picked_bead: "ompkit-c8",
	});
	expect(readFileSync(run.logPath, "utf8").includes('"kind":"ADMISSION_REFUSED"')).toBe(true);
});

test("[C8] append failure is quarantined and reported with record:emit_failed on the next source tick", () => {
	let producerDir = "";
	const run = harness(configOf({ workerPanes: ["%1"] }), {
		world: world({
			readyRows: [leaf("ompkit-c8")],
			issues: [issue("ompkit-c8", { parents: ["x-epic"] })],
			triage: { usable: true, ids: ["ompkit-c8"] },
		}),
	}, [], OMP_KIT_POLICY, {
		cc: true,
		now: () => C8_NOW,
		send: () => chmodSync(producerDir, 0o555),
	});
	producerDir = join(run.ccStateDir!, "spool", "watcher");
	writeFileSync(run.statePath, JSON.stringify({ version: 1, panes: { "work:%1": { checks: 1 } } }), { mode: 0o600 });
	mkdirSync(producerDir);
	run.tick();
	chmodSync(producerDir, 0o755);
	run.tick();
	const spool = join(producerDir, `${new Date(C8_NOW).toISOString().slice(0, 10)}.jsonl`);
	const events = readFileSync(spool, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const ticks = events.filter((event) => event.type === "source.tick");
	expect(events.some((event) => event.type === "pull.attempt")).toBe(false);
	expect(ticks).toHaveLength(1);
	expect(ticks[0]!.data).toMatchObject({
		records_seen: 2,
		records_emitted: 0,
		records_ignored: 0,
		records_quarantined: 2,
		coverage: [{ record_type: "record:emit_failed", runtime_version: "1", disposition: "unknown", reason: "SPOOL_APPEND_FAILED", count: 2 }],
	});
});
test("[C8] administrative ADMISSION_REFUSED rows have typed events with exact timestamps", () => {
	let nowMs = C8_NOW;
	const config: FleetWatchConfig = {
		...configOf({ workerPanes: [] }),
		registeredTrackers: [{ repo: "/registered", session: "work" }],
	};
	const workAudit: NonNullable<FleetWatchOnceDeps["workAudit"]> = {
		repos: [{
			name: "repo",
			path: "/repo",
			status: "WARN",
			dirty_file_count: 1,
			tracked_dirty_file_count: 1,
			untracked_file_count: 0,
			untracked_file_cap: 1000,
			untracked_scan_status: "OK",
			commits_ahead: 0,
			commits_behind: 0,
			unpushed_commits: 0,
			has_upstream: true,
			has_remote: true,
			no_upstream: false,
			no_remote: false,
			stash_count: 0,
			detached: false,
			branch: "main",
			last_commit_epoch: 0,
			last_commit_age_days: 0,
			active_worktrees: 0,
			worktree_paths: [],
			reservation_scan_status: "OK",
			stale_uncommitted_edits: [{
				path: "src/main.ts",
				path_pattern: "src/main.ts",
				agent_name: "GreenWorker",
				bead: "ompkit-c8",
				age_minutes: 10000,
			}],
			risk_score: 1,
			findings: [],
			stranded: true,
			conditions: [],
		}],
	};
	const run = harness(config, { world: world() }, [], OMP_KIT_POLICY, {
		cc: true,
		now: () => nowMs++,
		admission: {
			launcherBinding: "none",
			authority: "OFF",
			authorityConfirmed: true,
			authorityGeneration: null,
			launchers: [],
			keeper: null,
			packet: { action: "send", ownedAction: "send", generation: null },
			governedActions: ["send", "tracker-recovery", "tracker-quarantine-retention", "git-lock-reap"],
		},
		workAudit,
	});
	run.tick();
	const refused = readFileSync(run.logPath, "utf8").trim().split("\n")
		.map((line) => JSON.parse(line))
		.filter((row) => row.kind === "ADMISSION_REFUSED");
	const day = new Date(C8_NOW).toISOString().slice(0, 10);
	const spool = join(run.ccStateDir!, "spool", "watcher", `${day}.jsonl`);
	const events = readFileSync(spool, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const attempts = events.filter((event) => event.type === "pull.attempt" && event.data.outcome === "ADMISSION_REFUSED");
	expect(refused).toHaveLength(7);
	expect(attempts).toHaveLength(refused.length);
	expect(attempts.map((event) => [event.session, event.seat, event.time, event.data.outcome])).toEqual(
		refused.map((row) => [row.session, `${row.session}/${row.pane}`, row.at, row.kind]),
	);
	for (const event of attempts) {
		expect(event.data.refusal_class).toBe("ADMISSION_REFUSED");
		expect(event.data.picked_bead).toBeNull();
		expect(event.data).not.toHaveProperty("text");
	}
	expect(events.find((event) => event.type === "source.tick")?.data).toMatchObject({
		records_seen: refused.length,
		records_emitted: refused.length,
		records_quarantined: 0,
		coverage: [{ record_type: "record:ADMISSION_REFUSED", count: refused.length }],
	});
});

const REPLY_CASES: Record<string, { match: string; miss: string }> = {
	CLOSED: { match: "CLOSED x-1 abc1234 tests green", miss: "CLOSED x-1 not-a-sha tests green" },
	REWORK: { match: "REWORK x-1 2 gaps", miss: "REWORK x-1" },
	DONE: { match: "DONE x-1 abc1234 bun test 12 pass", miss: "DONE x-1 PASS abc1234" },
	PROGRESS: { match: "PROGRESS x-1 abc1234 two items left", miss: "PROGRESS x-1 abc12 two items left" },
	SPLIT: { match: "SPLIT x-1 x-1.1 x-1.2", miss: "SPLIT x-1 ," },
	FILED: { match: "FILED x-2 x-epic", miss: "FILED  " },
	OBSOLETE: { match: "OBSOLETE x-1 superseded by abc1234", miss: "OBSOLETE: x-1 gone" },
	BLOCKED: { match: "BLOCKED x-1 credential cmd=op-read-exit-1 tried=signin->2FA;env->unset fix=infisical-secrets:40 next=x-2", miss: "BLOCKED x-1 tired cmd=a tried=b fix=c next=d" },
	QUESTION: { match: "QUESTION x-1 which epic owns this?", miss: "QUESTION x-1" },
	SKIP: { match: "SKIP x-1 owner-decision label", miss: "SKIPPED x-1 owner-decision label" },
	"NO-WORK": { match: "NO-WORK grading 0 rework 0 ready 0", miss: "NO WORK grading 0" },
	UNHEALTHY: { match: "UNHEALTHY disk 2 GB free", miss: "UNHEALTHY mood bad" },
	HANDOFF: { match: "HANDOFF x-1 comment 1568", miss: "handoff x-1 comment 1568" },
};

test("[replies] one table: every verb has a required match and an anchored near-miss reject", () => {
	expect(WORKER_REPLIES.map((reply) => reply.verb).sort()).toEqual(Object.keys(REPLY_CASES).sort());
	for (const [verb, cases] of Object.entries(REPLY_CASES)) {
		expect(parseWorkerReply(cases.match)?.verb).toBe(verb as never);
		expect(parseWorkerReply(cases.miss)?.verb).not.toBe(verb as never);
		expect(parseWorkerReply(`note: ${cases.match}`)).toBeNull();
	}
	expect(parseWorkerReply("DONE x-1 abc1234 evidence\nsecond line")).toEqual({ verb: "DONE", role: "implementer", bead: "x-1" });
	expect(parseWorkerReply("NO-WORK all empty")).toEqual({ verb: "NO-WORK", role: "status", bead: null });
});

test("[replies] the nudge renders its report lines from the same table", () => {
	const text = nudgeText(session, { kind: "TRIAGE", id: "x-2", rank: 1, epic: null });
	for (const verb of ["DONE", "PROGRESS", "BLOCKED", "QUESTION", "SPLIT", "OBSOLETE"]) {
		const row = WORKER_REPLIES.find((reply) => reply.verb === verb)!;
		expect(text).toContain(`${verb} ${row.args.replace("<bead>", "x-2")}`);
	}
});

test("[replies] a BLOCKED without researched evidence is not a reply (Josh 2026-10-12)", () => {
	expect(parseWorkerReply("BLOCKED x-1 reservation cmd=edit-refused tried=reserve->held;ask->no-reply fix=am-force-release:2h next=x-3")).toEqual({ verb: "BLOCKED", role: "status", bead: "x-1" });
	for (const thin of [
		"BLOCKED x-1 credential ask the director",
		"BLOCKED x-1 credential tried=a->b;c->d fix=skill:x next=x-2",
		"BLOCKED x-1 credential cmd=x-exit-1 fix=skill:x next=x-2",
		"BLOCKED x-1 credential cmd=x-exit-1 tried=a->b;c->d next=x-2",
		"BLOCKED x-1 credential cmd=x-exit-1 tried=a->b;c->d fix=skill:x",
		"BLOCKED x-1 credential cmd= tried=a->b fix=skill:x next=x-2",
		"BLOCKED x-1 credential cmd=a retried=b prefix=c context=d",
	]) expect(parseWorkerReply(thin)).toBeNull();
});

test("[replies] each pattern stays linear on a long near-miss", () => {
	const time = (input: string) => {
		const start = performance.now();
		for (let i = 0; i < 2000; i++) parseWorkerReply(input);
		return performance.now() - start;
	};
	for (const reply of WORKER_REPLIES) {
		const nearMiss = (length: number) => `${reply.verb} x-1 ${"a".repeat(length)}`;
		time(nearMiss(128));
		const short = time(nearMiss(256));
		const long = time(nearMiss(4096));
		expect(long / Math.max(short, 1)).toBeLessThan(6);
	}
});

test("[shapes] captured bv, br and policy fixtures parse as the watcher reads them", () => {
	const triage = parseTriage(JSON.parse(readFileSync(join(fixtures, "bv-robot-triage.omp-kit.json"), "utf8")));
	expect(triage.usable).toBe(true);
	expect(triage.usable && triage.ids.length).toBe(10);
	expect(parseTriage({ source_authority: { state: "partial", claim_safe: false }, triage: { recommendations: [] } })).toEqual({ usable: false, reason: "source not claim-safe (partial)" });
	expect(parseTriage({ triage: {} })).toEqual({ usable: false, reason: "no triage.recommendations array" });
	const listed = JSON.parse(readFileSync(join(fixtures, "br-list-in_review.omp-kit.json"), "utf8"));
	expect(parseReadyRows(listed.issues)?.map((row) => `${row.id}:${row.status}:${row.assignee}`)).toEqual(["ompkit-114o:in_review:WhiteHarbor", "ompkit-1iku:in_review:LavenderFortress"]);
	expect(reviewStatuses(OMP_KIT_POLICY)).toEqual(["in_review"]);
	expect(reviewStatuses(UDS_POLICY)).toEqual(["in_review", "grading"]);
	const JEV_POLICY: TrackerPolicy = {
		statuses: ["open", "in_progress", "in_review", "rework", "blocked", "deferred", "closed"],
		transitions: {
			open: ["in_progress", "blocked", "deferred", "closed"],
			in_progress: ["in_review", "open", "blocked", "deferred"],
			in_review: ["closed", "rework"],
			rework: ["in_progress"],
			blocked: ["open", "in_progress"],
			deferred: ["open", "closed"],
			closed: ["open"],
		},
		ready: ["open", "rework"],
	};
	expect(reviewStatuses(JEV_POLICY)).toEqual(["in_review"]);
	expect(OMP_KIT_POLICY.statuses).toContain("rework");
	const issues = parseIssuesJsonl(readFileSync(join(fixtures, "issues.omp-kit-1iku.jsonl"), "utf8"))!;
	expect(gradingQueue([], [{ ...issues[0]!, status: "in_progress" }], ["in_review"]).map((item) => item.author)).toEqual(["LavenderFortress"]);
	expect(parseIssuesJsonl("{\"id\":\"x\"}\n")).toBeNull();
});

test("[config] Q20 fields load; missing fields keep pulling on; malformed fields are refused", () => {
	const dir = scratchDir();
	const write = (extra: Record<string, unknown>) => {
		const path = join(dir, `config-${Object.keys(extra).join("-") || "plain"}.json`);
		writeFileSync(path, JSON.stringify({ sessions: [{ ...session, focusEpics: undefined, mission: undefined, round: undefined, phase: undefined, ...extra }] }));
		return path;
	};
	const loaded = loadFleetWatchConfig(write({ focusEpics: ["x-epic"], mission: "/abs/ROADMAP.md:9", round: 2, phase: "AGREE", pullEnabled: true }));
	expect(loaded.sessions[0]).toMatchObject({ focusEpics: ["x-epic"], mission: "/abs/ROADMAP.md:9", round: 2, phase: "AGREE", pullEnabled: true });
	expect(loadFleetWatchConfig(write({})).sessions[0]?.pullEnabled).toBeUndefined();
	expect(() => loadFleetWatchConfig(write({ mission: "ROADMAP.md" }))).toThrow("sessions[0].mission");
	expect(() => loadFleetWatchConfig(write({ focusEpics: "x-epic" }))).toThrow("sessions[0].focusEpics");
	expect(() => loadFleetWatchConfig(write({ pullEnabled: "no" }))).toThrow("sessions[0].pullEnabled");
});

test("[legacy] a session without Q20 fields still nudges toward the bv pick", () => {
	const plain = { ...session, focusEpics: undefined, mission: undefined, round: undefined, phase: undefined };
	const run = nudgeOnce(configOf(plain), world({ readyRows: [leaf("y-1")], triage: { usable: true, ids: ["y-1"] } }));
	expect(run.worker("%1")).toEqual([nudgeText(plain, { kind: "TRIAGE", id: "y-1", rank: 1, epic: null })]);
	expect(run.worker("%1")[0]).toStartWith("Fleet watch: idle for 4+ minutes. Nothing to grade or rework; take y-1");
});

// Q23: one escalation chain, worker -> director -> chief -> Josh. Workers reply only to the director.
const ALL_PICKS: PullPick[] = [
	{ kind: "GRADE", id: "x-9", via: "in_review", author: "BlueWorker", rework: "set status rework" },
	{ kind: "REWORK", id: "x-7", implementer: "BlueWorker" },
	{ kind: "TRIAGE", id: "x-2", rank: 1, epic: "x-epic" },
	{ kind: "READY", id: "x-2", reason: "bv unusable: missing", epic: null },
];

test("[route] every reply verb's command goes to the director pane and nowhere else", () => {
	for (const reply of WORKER_REPLIES) {
		const command = reportCommand(session, reply.verb, "x-1");
		expect(command).toStartWith(`omp-kit send work %54 "${reply.verb} `);
	}
});

test("[route] every worker-facing nudge sends only to the director and names no chief or Josh route", () => {
	const owned = { ...session, skipLabels: ["owner-decision", "human-gate"] };
	for (const pick of ALL_PICKS) {
		const text = nudgeText(owned, pick);
		const sends = text.split("omp-kit send ").slice(1);
		expect(sends.length).toBeGreaterThan(0);
		for (const send of sends) expect(send).toStartWith("work %54 \"");
		expect(text).toContain("Every reply, including UNHEALTHY and BLOCKED owner-decision or live-action, goes only to your director %54; the director escalates.");
		expect(text.toLowerCase()).not.toContain("chief");
		expect(text.toLowerCase()).not.toContain("josh");
	}
});

test("[route] DEAD: a pane that cannot be captured is reported to the director first, never to the worker", () => {
	const sends: { session: string; pane: string; text: string }[] = [];
	const config = configOf();
	runFleetWatchOnce({ ...config, noDecisionChecks: 1 }, {
		capture: () => ({ code: 1, stdout: "", stderr: "can't find pane: %1" }),
		send: (target, pane, text) => { sends.push({ session: target, pane, text }); },
		sendKeys: () => { throw new Error("no keys"); },
		logPath: "/dev/null",
		statePath: null,
		now: () => 0,
		recoverTracker: () => null,
	});
	expect(sends.length).toBeGreaterThan(0);
	for (const send of sends) expect(`${send.session} ${send.pane}`).toBe("work %54");
});

const BUN = process.execPath;

test("[runJson] a probe sleeping past the timeout names timeout with elapsed ms", () => {
	const outcome = runJson([BUN, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)"], undefined, { timeoutMs: 150 });
	expect(outcome.ok).toBe(false);
	if (!outcome.ok) {
		expect(outcome.failure.kind).toBe("timeout");
		expect(outcome.failure.detail).toContain("timeout after 150 ms");
		expect(outcome.failure.elapsed_ms).toBeGreaterThanOrEqual(100);
	}
}, 10000);

test("[runJson] output past maxBuffer names the buffer bound", () => {
	const outcome = runJson([BUN, "-e", "console.log(\"x\".repeat(100000))"], undefined, { maxBuffer: 1000 });
	expect(outcome.ok).toBe(false);
	if (!outcome.ok) {
		expect(outcome.failure.kind).toBe("buffer");
		expect(outcome.failure.detail).toContain("maxBuffer 1000 bytes exceeded");
	}
}, 10000);

test("[runJson] non-zero exit names the code and first stderr line", () => {
	const outcome = runJson([BUN, "-e", "console.error(\"first problem\"); console.error(\"second\"); process.exit(3)"], undefined);
	expect(outcome.ok).toBe(false);
	if (!outcome.ok) {
		expect(outcome.failure.kind).toBe("exit");
		expect(outcome.failure.status).toBe(3);
		expect(outcome.failure.detail).toBe("first problem");
	}
}, 10000);

test("[runJson] a signal death names the signal, not an exit", () => {
	const outcome = runJson([BUN, "-e", "process.kill(process.pid, \"SIGTERM\")"], undefined);
	expect(outcome.ok).toBe(false);
	if (!outcome.ok) {
		expect(outcome.failure.kind).toBe("signal");
		expect(outcome.failure.status).toBeNull();
		expect(outcome.failure.detail).toBe("SIGTERM");
	}
}, 10000);

test("[runJson] non-JSON output and valid JSON stay distinct", () => {
	const bad = runJson([BUN, "-e", "console.log(\"not json\")"], undefined);
	expect(bad.ok).toBe(false);
	if (!bad.ok) expect(bad.failure.kind).toBe("bad-json");
	const good = runJson([BUN, "-e", "console.log(JSON.stringify({ a: 1 }))"], undefined);
	expect(good).toMatchObject({ ok: true, value: { a: 1 } });
}, 10000);

test("[fallback] null ready rows carry the probe failure into the UNKNOWN notice", () => {
	const run = nudgeOnce(configOf(), world({ readyRows: null, readyFailure: "br ready --json: timeout after 15000 ms (status null, signal SIGTERM, 15012 ms)" }));
	const [text] = run.coordinator();
	expect(text).toContain("UNKNOWN");
	expect(text).toContain("timeout after 15000 ms");
});

test("[defer] a close edge never promotes blocked or deferred work into the review queue", () => {
	const policy = parsePolicy({
		workflow: {
			statuses: ["open", "in_progress", "in_review", "deferred", "blocked", "closed"],
			transitions: {
				in_progress: ["in_review", "deferred", "blocked"],
				in_review: ["closed"],
				deferred: ["closed"],
				blocked: ["closed"],
			},
			status_groups: { ready: ["open"] },
		},
	});
	if (policy === null) throw new Error("parked-work policy fixture is invalid");
	expect(reviewStatuses(policy)).toEqual(["in_review"]);
});

test("[defer] native nudge never grades a parked deferred bead; a legit review row is still assigned once to a non-author", () => {
	const policy = parsePolicy({
		workflow: {
			statuses: ["open", "in_progress", "in_review", "deferred", "blocked", "closed"],
			transitions: {
				in_progress: ["in_review", "deferred", "blocked"],
				in_review: ["closed"],
				deferred: ["closed"],
				blocked: ["closed"],
			},
			status_groups: { ready: ["open"] },
		},
	});
	if (policy === null) throw new Error("parked-work nudge fixture is invalid");
	// jev-b35c.11 shape plus the exact BrownGoose recurrence bead jev-b35c.32.4.4
	// (deferred duplicate roll-up under a recorded STAYS DEFERRED disposition):
	// parked deferred rows listed ahead of the legit review row, plus an
	// available ready leaf the free author-pane should pull instead of parked beads.
	const parked11: ReadyRow = { id: "jev-b35c.11", status: "deferred", assignee: "ThirdWorker", labels: [], issue_type: "task" };
	const parked44: ReadyRow = { id: "jev-b35c.32.4.4", status: "deferred", assignee: "", labels: [], issue_type: "task" };
	const run = nudgeOnce(configOf(), world({
		readyRows: [leaf("x-1")],
		statusRows: [parked11, parked44, review("x-9", "BlueWorker")],
		issues: [issue("x-1", { parents: ["x-epic"] })],
		triage: { usable: true, ids: ["x-1"] },
	}), [], policy);
	const all = [...run.worker("%1"), ...run.worker("%2"), ...run.coordinator()];
	expect(all.some((text) => text.includes("jev-b35c.11"))).toBe(false);
	expect(all.some((text) => text.includes("jev-b35c.32.4.4"))).toBe(false);
	expect(all.filter((text) => text.includes("Grade "))).toHaveLength(1);
	const [grade] = run.worker("%1");
	expect(grade).toContain("Grade x-9 first (in_review, author BlueWorker; never grade your own)");
	const [pull] = run.worker("%2");
	expect(pull).toContain("take x-1 (bv --robot-triage #1, under x-epic)");
});
