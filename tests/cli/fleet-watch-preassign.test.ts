import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    choosePull,
	defaultPreassignProbes,
	defaultPullProbes,
	FleetWatcher,
	parseReadyRows,
	preassignVerdict,
	runFleetWatchOnce,
	type FleetWatchConfig,
	type FleetWatchSession,
	type PreassignProbes,
	type ReadyRow,
} from "../../src/fleet-watch.ts";
import type { TrackerRecoveryResult } from "../../src/tracker-recovery.ts";

// ompkit-bj08.5.1 PREASSIGN1: nudge eligibility gates with planted negatives.

const repoRoot = resolve(import.meta.dir, "../..");
const session: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 99, sessions: [session] };

const LEAF: ReadyRow = { id: "x-1", status: "open", assignee: null, labels: [], issue_type: "task" };

function scratchLog(): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "fleet-watch-preassign."));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-preassign-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return join(dir, "actions.jsonl");
}

function countKind(logPath: string, kind: string): number {
	return readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes(`"kind":"${kind}"`)).length;
}

function idleDeps(logPath: string, probes: PreassignProbes, recoveries: string[], recovery: TrackerRecoveryResult | null) {
	const sends: { session: string; pane: string; text: string }[] = [];
	return {
		sends,
		coordinatorSends: () => sends.filter((send) => send.pane === "%54"),
		workerSends: () => sends.filter((send) => send.pane === "%1"),
		deps: {
			capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
			send: (session: string, pane: string, text: string) => sends.push({ session, pane, text }),
			sendKeys: () => {},
			logPath,
			now: () => 0,
			recoverTracker: (repo: string, _session: string): TrackerRecoveryResult | null => {
				recoveries.push(repo);
				return recovery;
			},
			preassignProbes: probes,
		},
	};
}
test("[1] planted latched repo: zero nudges, one WRITE_LATCHED naming the flag, silence after", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => ["/repo/.beads/.br_recovery/schema-migrations/flag-1"],
		listReadyRows: () => ({ rows: [LEAF], failure: null }),
	}, recoveries, { kind: "RECOVERY_BLOCKED", text: "Fleet Watch: tracker recovery blocked; live holder." });
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	runFleetWatchOnce(config, run.deps, watcher);
	expect(run.workerSends()).toEqual([]);
	expect(recoveries.length).toBeGreaterThan(0);
	const coordinator = run.coordinatorSends();
	expect(coordinator).toHaveLength(1);
	expect(coordinator[0]?.text).toContain("WRITE_LATCHED");
	expect(coordinator[0]?.text).toContain("flag-1");
	expect(countKind(logPath, "WRITE_LATCHED")).toBe(1);
});

test("[2] planted no-free-leaf frontier: zero nudges, one NO_FREE_LEAF with counts", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const skipped: FleetWatchSession = { ...session, skipLabels: ["owner-decision"] };
	const skippedConfig: FleetWatchConfig = { ...config, sessions: [skipped] };
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => ({ rows: [
			{ id: "h-1", status: "open", assignee: "BusyAgent", labels: [], issue_type: "task" },
			{ id: "e-1", status: "open", assignee: null, labels: [], issue_type: "epic" },
			{ id: "s-1", status: "open", assignee: null, labels: ["owner-decision"], issue_type: "task" },
		], failure: null }),
	}, recoveries, null);
	const watcher = new FleetWatcher(skippedConfig, () => 0);
	runFleetWatchOnce(skippedConfig, run.deps, watcher);
	runFleetWatchOnce(skippedConfig, run.deps, watcher);
	const coordinator = run.coordinatorSends();
	expect(coordinator).toHaveLength(1);
	expect(coordinator[0]?.text).toContain("NO_FREE_LEAF");
	expect(coordinator[0]?.text).toContain("held 1");
	expect(coordinator[0]?.text).toContain("epics 1");
	expect(countKind(logPath, "NO_FREE_LEAF")).toBe(1);
});

test("[3] positive: writable repo with one open leaf nudges as today", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => ({ rows: [LEAF], failure: null }),
	}, recoveries, null);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	const actions = runFleetWatchOnce(config, run.deps, watcher);
	expect(actions.map((action) => action.kind)).toEqual(["NUDGED"]);
	expect(run.workerSends()).toHaveLength(1);
	expect(countKind(logPath, "UNKNOWN")).toBe(0);
});

test("[4] UNKNOWN readiness refuses with the reason reported", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => ({ rows: null, failure: "br ready --json: timeout after 15000 ms (status null, signal SIGTERM, 15012 ms)" }),
	}, recoveries, null);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	runFleetWatchOnce(config, run.deps, watcher);
	expect(run.workerSends()).toEqual([]);
	const coordinator = run.coordinatorSends();
	expect(coordinator).toHaveLength(1);
	expect(coordinator[0]?.text).toContain("UNKNOWN");
	expect(coordinator[0]?.text).toContain("timeout after 15000 ms");
	expect(countKind(logPath, "UNKNOWN")).toBe(1);
	const unknownRecord = readFileSync(logPath, "utf8").split("\n").filter(line => line.includes("\"kind\":\"UNKNOWN\"")).map(line => JSON.parse(line) as { text?: string })[0];
	expect(unknownRecord?.text).toContain("timeout after 15000 ms");
});

test("[5] reverting the check makes the latched case nudge", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => ({ rows: [LEAF], failure: null }),
	}, recoveries, null);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	const actions = runFleetWatchOnce(config, run.deps, watcher);
	expect(actions.map((action) => action.kind)).toEqual(["NUDGED"]);
	expect(run.workerSends()).toHaveLength(1);
});

test("verdict: PROCEEDED recovery clears the episode", () => {
	expect(preassignVerdict("s", ["flag-1"], "RECOVERY_PROCEEDED", [LEAF], []).ready).toBe(true);
	expect(preassignVerdict("s", ["flag-1"], "RECOVERY_BLOCKED", [LEAF], []).ready).toBe(false);
	expect(preassignVerdict("s", ["flag-1"], null, [LEAF], []).ready).toBe(false);
	expect(preassignVerdict("s", [], null, [LEAF], []).ready).toBe(true);
	expect(preassignVerdict("s", null, null, [LEAF], []).ready).toBe(false);
});

test("rows: malformed tracker output is UNKNOWN, good rows parse", () => {
	expect(parseReadyRows([{ id: "a", status: "open" }])).toEqual([{ id: "a", status: "open", assignee: null, labels: [], issue_type: "" }]);
	expect(parseReadyRows([{ id: "a" }])).toBeNull();
	expect(parseReadyRows("nope")).toBeNull();
	expect(parseReadyRows([{ id: 7, status: "open" }])).toBeNull();
});

function nativePullFixture() {
	const project = resolve(scratchLog(), "..");
	const db = join(project, ".beads", "beads.db");
	const created: string[] = [];
	const native = (args: string[], actor = "PullFixture"): string => {
		const result = Bun.spawnSync(["br", ...args, "--db", db, "--actor", actor, "--json", "--no-auto-import", "--no-auto-flush"], {
			cwd: project,
			env: { ...process.env, HOME: project },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		if (result.exitCode !== 0) {
			throw new Error(`native br ${args.join(" ")} exited ${result.exitCode}\n${result.stdout.toString()}\n${result.stderr.toString()}`);
		}
		return result.stdout.toString();
	};
	const create = (title: string, labels: string[] = []): string => {
		const value: unknown = JSON.parse(native(["create", "--title", title, ...labels.flatMap(label => ["--labels", label])]));
		if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
			throw new Error("native br create returned no issue id");
		}
		created.push(value.id);
		return value.id;
	};
	native(["init", "--prefix", "pa"]);
	const choose = (ranked: string[] = created, overrides: Partial<Parameters<typeof choosePull>[0]> = {}) => {
		const readyRows = parseReadyRows(JSON.parse(native(["ready", "--unassigned"])));
		if (readyRows === null) throw new Error("native ready observation is malformed");
		return choosePull({
			sessionName: "fixture", worker: "Worker", liveWorkers: new Set<string>(),
			grading: [], rework: [], triage: { usable: true, ids: ranked }, issues: [], readyRows,
			policy: { statuses: [], transitions: {}, ready: ["open"] },
			focus: [], skipLabels: [], taken: new Set<string>(),
			coordinator: { actor: "Director", session: "fixture", pane: "tern:coordinator" },
			nativeState: defaultPullProbes.readNativeState(project, created, "Director"),
			...overrides,
		});
	};
	return { project, native, create, choose };
}

test("PULLADMIT1: native process work is never product supply, even without configured skip labels", () => {
	const { native, create } = nativePullFixture();
	const protectedId = create("Director-owned process repair", ["kind:process"]);
	const protectedRows = parseReadyRows(JSON.parse(native(["ready", "--unassigned"])));
	if (protectedRows === null) throw new Error("native br ready returned malformed rows");
	expect(protectedRows.map(row => row.id)).toContain(protectedId);
	const refused = preassignVerdict("fixture", [], null, protectedRows, []);
	expect(refused.ready).toBe(false);
	expect(refused).toMatchObject({
		refusals: [{
			bead: protectedId,
			class: "unsupported_native",
			actor: expect.stringContaining("UNKNOWN"),
			next: expect.stringContaining("director"),
		}],
	});

	const productId = create("Eligible product repair");
	const mixedRows = parseReadyRows(JSON.parse(native(["ready", "--unassigned"])));
	if (mixedRows === null) throw new Error("native br ready returned malformed rows");
	expect(mixedRows.map(row => row.id)).toContain(productId);
	expect(preassignVerdict("fixture", [], null, mixedRows, []).ready).toBe(true);
});

test("PULLADMIT1: stale ranked work names its native blocker owner without freezing an eligible leaf", () => {
	const { project, native, create } = nativePullFixture();
	const blocker = create("Open prerequisite");
	native(["update", blocker, "--claim"], "BlockerOwner");
	const blocked = create("Previously ranked product leaf");
	const healthy = create("Current eligible product leaf");
	native(["dep", "add", blocked, blocker]);
	const readyRows = parseReadyRows(JSON.parse(native(["ready", "--unassigned"])));
	if (readyRows === null) throw new Error("native ready observation is malformed");
	expect(readyRows.map(row => row.id)).toEqual([healthy]);
	const choice = choosePull({
		sessionName: "fixture",
		worker: "Worker",
		liveWorkers: new Set<string>(),
		grading: [],
		rework: [],
		triage: { usable: true, ids: [blocked] },
		issues: [],
		readyRows,
		policy: { statuses: [], transitions: {}, ready: ["open"] },
		focus: [],
		skipLabels: [],
		taken: new Set<string>(),
		coordinator: { actor: "Director", session: "fixture", pane: "tern:coordinator" },
		nativeState: defaultPullProbes.readNativeState(project, [blocked, blocker], "Director"),
	});
	expect(choice).toMatchObject({
		ready: true,
		pick: { id: healthy },
		refusals: [{
			bead: blocked,
			class: "tool_read_failure",
			actor: "BlockerOwner",
			next: expect.stringContaining(blocker),
		}],
	});
});

test("PULLADMIT1: protected native work names its director instead of silently disappearing", () => {
	const fixture = nativePullFixture();
	const id = fixture.create("Director process action", ["kind:process"]);
	expect(fixture.choose()).toMatchObject({
		ready: false,
		refusals: [{ bead: id, class: "unsupported_native", actor: "Director" }],
	});
});

test("PULLADMIT1: a later worker question cannot erase a native decision citation", () => {
	const fixture = nativePullFixture();
	const id = fixture.create("Previously decided owner question", ["owner-decision"]);
	const decision: unknown = JSON.parse(fixture.native(["comments", "add", id, "DECISION: retain the existing no-spend route"], "Director"));
	if (typeof decision !== "object" || decision === null || !("id" in decision) || typeof decision.id !== "number") {
		throw new Error("native comment has no citation id");
	}
	fixture.native(["comments", "add", id, "QUESTION: may I spend anyway?"], "Worker");
	expect(fixture.choose()).toMatchObject({
		ready: false,
		refusals: [{ bead: id, actor: "Director", citation: expect.stringContaining(`comment ${decision.id}`) }],
	});
	fixture.native(["close", id, "--reason", "fixture decision resolved"], "FixtureCloser");
	expect(fixture.choose()).toMatchObject({
		ready: false,
		refusals: [{ bead: id, actor: "Director", citation: expect.stringContaining(`comment ${decision.id}`) }],
	});
});

test("PULLADMIT1: a human-gate label and login wording do not manufacture a physical act", () => {
	const fixture = nativePullFixture();
	const id = fixture.create("Login parser source repair", ["human-gate"]);
	fixture.native(["update", id, "--description", "The login parser needs a source fix; no payment, portal login or OS permission is required."]);
	const healthy = fixture.create("Ordinary login parser regression");
	expect(fixture.choose()).toMatchObject({
		ready: true,
		pick: { id: healthy },
		refusals: [{ bead: id, class: "unsupported_native", actor: "Director" }],
	});
});

test("PULLADMIT1: runtime reads current native blocker custody and preserves the stale export", () => {
	const fixture = nativePullFixture();
	const decoy = fixture.create("Unrelated held work");
	fixture.native(["update", decoy, "--claim"], "DecoyOwner");
	const blocker = fixture.create("Actual prerequisite");
	fixture.native(["update", blocker, "--claim"], "PreviousOwner");
	const blocked = fixture.create("Export-ranked leaf");
	fixture.create("Healthy fallback leaf");
	fixture.native(["sync", "--flush-only"]);
	const exportPath = join(fixture.project, ".beads", "issues.jsonl");
	const exported = readFileSync(exportPath, "utf8");
	fixture.native(["update", blocker, "--assignee", "CurrentOwner"]);
	fixture.native(["dep", "add", blocked, blocker]);
	const nativeSession: FleetWatchSession = {
		session: "fixture", coordinatorSession: "fixture", coordinatorPane: "%54",
		repo: fixture.project, workerPanes: ["%1"],
	};
	const nativeConfig: FleetWatchConfig = { ...config, sessions: [nativeSession] };
	const logPath = join(fixture.project, "native-actions.jsonl");
	const watcher = new FleetWatcher(nativeConfig, () => 0);
	const deps = {
		logPath, statePath: null, now: () => 0,
		capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
		// Transport and identity are fixture adapters, never live plane/delivery proof.
		send: () => {}, sendKeys: () => {},
		recoverTracker: () => null,
		preassignProbes: defaultPreassignProbes,
		pullProbes: {
			...defaultPullProbes,
			triage: () => ({ usable: true as const, ids: [blocked] }),
			resolveWorker: () => "Director",
		},
	};
	runFleetWatchOnce(nativeConfig, deps, watcher);
	runFleetWatchOnce(nativeConfig, deps, watcher);
	const records = readFileSync(logPath, "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
	expect(records).toContainEqual(expect.objectContaining({
		kind: "PULL_WARNINGS",
		refusals: expect.arrayContaining([expect.objectContaining({
			bead: blocked, class: "tool_read_failure", actor: "CurrentOwner",
			next: expect.stringContaining(blocker),
		})]),
	}));
	expect(readFileSync(exportPath, "utf8")).toBe(exported);
});

test("PULLADMIT1: focus exhaustion retains the native blocker route rather than replacing it with UNKNOWN", () => {
	const fixture = nativePullFixture();
	const blocker = fixture.create("Focused prerequisite");
	fixture.native(["update", blocker, "--claim"], "PrerequisiteOwner");
	const blocked = fixture.create("Focused blocked leaf");
	fixture.native(["dep", "add", blocked, blocker]);
	const outside = fixture.create("Healthy leaf outside the selected focus");
	const choice = fixture.choose([blocked], {
		focus: ["focus-epic"],
		issues: [{ id: outside, status: "open", priority: 2, labels: [], parents: [], comments: [] }],
	});
	expect(choice).toMatchObject({
		ready: false, kind: "NO_TRIAGE_PICK",
		refusals: expect.arrayContaining([expect.objectContaining({
			bead: blocked, class: "tool_read_failure", actor: "PrerequisiteOwner", next: expect.stringContaining(blocker),
		})]),
	});
});

test("PULLADMIT1: a closed decision citation cannot replace a separately observed prerequisite owner", () => {
	const fixture = nativePullFixture();
	const blocker = fixture.create("Unresolved prerequisite");
	fixture.native(["update", blocker, "--claim"], "PrerequisiteOwner");
	const decided = fixture.create("Decided candidate");
	fixture.native(["dep", "add", decided, blocker]);
	fixture.native(["comments", "add", decided, "DECISION: retain current scope"], "Director");
	const before = defaultPullProbes.readNativeState(fixture.project, [decided, blocker], "Director");
	fixture.native(["close", decided, "--reason", "fixture resolved decision", "--force"], "FixtureCloser");
	const after = defaultPullProbes.readNativeState(fixture.project, [decided, blocker], "Director");
	if (!before.ok || !after.ok) throw new Error("native fixture observations are unavailable");
	// Native blocked and show are separate reads: a close may occur between them.
	const choice = fixture.choose([decided], { nativeState: { ...after, blockers: before.blockers } });
	expect(choice).toMatchObject({
		ready: false,
		refusals: expect.arrayContaining([expect.objectContaining({
			bead: decided, actor: "PrerequisiteOwner", next: expect.stringContaining(blocker),
			citation: expect.stringContaining("Director"),
		})]),
	});
});
