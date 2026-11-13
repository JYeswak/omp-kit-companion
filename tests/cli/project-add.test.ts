import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deliverFirstSeatGoal } from "../../src/send.ts";
import { projectStatus, resolveTurnOnPath, resolveRosterPath } from "../../src/project-add.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { ROOT, assistantEntry, cli, decoder, fixture, type Fixture } from "./project-add.helpers.ts";

afterAll(cleanupAllOwnedTmp);

test("wake health uses the configured state root and handles absent seat records", async () => {
	const task = ownedTmp("project-wake-health");
	const home = join(task.path, "home"), stateHome = join(task.path, "state");
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	mkdirSync(join(stateHome, "omp-kit"), { recursive: true });
	writeFileSync(join(home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{
		session: "test", repo: task.path, coordinatorSession: "test", coordinatorPane: "tern:1", workerPanes: ["tern:2"],
	}] }));
	const env = { HOME: home, XDG_STATE_HOME: stateHome };
	const input = { session: "test", env, deps: {
		exec: { run: async (argv: readonly string[]) => argv[0] === "am"
			? { code: 0, out: JSON.stringify({ agent_name: argv.includes("tern:1") ? "Director" : "Worker" }), err: "" }
			: { code: 0, out: "{}", err: "" } },
	} };
	const previous = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	try {
		const absent = await projectStatus(input);
		if (!absent.ok) throw new Error(absent.detail);
		expect(absent.status.seats.map(seat => seat.wake)).toEqual([
			{ outcome: "no wake recorded", at: null }, { outcome: "no wake recorded", at: null },
		]);
		writeFileSync(join(stateHome, "omp-kit", "mail-wake.jsonl"), [
			{ recipient: "Worker", status: "WAKE_QUEUED", ts: "2026-11-10T12:00:00Z" },
			{ recipient: "Worker", status: "UNSIGNALED", ts: "2026-11-10T12:02:00Z" },
			{ recipient: "Worker", status: "WAKE_DELIVERED", ts: "invalid" },
		].map(row => JSON.stringify(row)).join("\n") + "\n");
		const recorded = await projectStatus(input);
		if (!recorded.ok) throw new Error(recorded.detail);
		expect(recorded.status.seats[0]!.wake).toEqual({ outcome: "no wake recorded", at: null });
		expect(recorded.status.seats[1]!.wake).toEqual({ outcome: "UNSIGNALED", at: "2026-11-10T12:02:00Z" });
	} finally {
		if (previous === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		else process.env.OMP_KIT_FLEET_WATCH_CONFIG = previous;
		task.cleanup();
	}
});
test("PROJECTADD1 fixture apply writes stores, delivers the goal with proof, and undo restores byte-identically", async () => {
	const f = await fixture();
	try {
		writeFileSync(f.rosterPath, `{\n  "chiefs": { "lead": "PeachLeopard" },\n  "sessions": {\n    "other": { "director": "D", "workers": [] }\n  }\n}\n`);
		writeFileSync(f.fleetWatchPath, JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
			sessions: [{ session: "other", coordinatorPane: "tern:9", coordinatorSession: "other", repo: "/other", workerPanes: [] }] }, null, 2) + "\n");
		const rosterBefore = readFileSync(f.rosterPath, "utf8");
		const fleetBefore = readFileSync(f.fleetWatchPath, "utf8");

		// Plan first: no side effects, proves the command wiring.
		const planned = await cli(f, ["project", "add", f.repo, "--session", "skillgrowth", "--workers", "1", "--profile", "codex", "--mission", "skillgrowth:104", "--goal", "Grow the skill library", "--orientation", "Take goals from the director", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		const plan = JSON.parse(planned.out).data;
		expect(plan.action).toBe("PLAN");
		expect(plan.turnOn.argv).toEqual([join(f.bin, "respawn_seat.py"), "--turn-on", "--session", "skillgrowth", "--profile", "codex", "--apply", "--json"]);
		expect(f.mail.calls).toEqual([]);
		expect(existsSync(join(f.repo, ".omp", "fleet.json"))).toBe(false);

		// Apply: the full act.
		const applied = await cli(f, ["project", "add", f.repo, "--session", "skillgrowth", "--workers", "1", "--profile", "codex", "--mission", "skillgrowth:104", "--goal", "Grow the skill library", "--orientation", "Take goals from the director", "--apply", "--yes", "--json"]);
		expect(applied.code, applied.out + applied.err).toBe(0);
		const done = JSON.parse(applied.out).data;
		expect(done.action).toBe("APPLIED");
		expect(done.census).toEqual({ named: "2/2" });
		const receiptId = done.receipt_id as string;
		expect(typeof receiptId).toBe("string");

		// Opt-in written.
		expect(readFileSync(join(f.repo, ".omp", "fleet.json"), "utf8")).toBe('{"enabled": true}\n');
		// Roster: minimal insertion — every old line survives in order, one entry added.
		const rosterAfter = readFileSync(f.rosterPath, "utf8");
		const oldLines = rosterBefore.split("\n");
		const newLines = rosterAfter.split("\n");
		expect(newLines.length).toBe(oldLines.length + 1);
		let at = 0;
		for (const line of oldLines) {
			const found = newLines.indexOf(line, at);
			expect(found).toBeGreaterThanOrEqual(at);
			at = found + 1;
		}
		expect(JSON.parse(rosterAfter).sessions.skillgrowth).toEqual({ director: "TurquoisePuma", workers: ["FoggyValley"] });
		// Fleet-watch: session recorded with the created pane ids.
		const fleet = JSON.parse(readFileSync(f.fleetWatchPath, "utf8"));
		const session = fleet.sessions.find((row: { session: string }) => row.session === "skillgrowth");
		expect(session).toMatchObject({ coordinatorPane: `tern:${f.directorBlock}`, coordinatorSession: "skillgrowth", repo: f.repo, workerPanes: [`tern:${f.workerBlock}`], mission: "skillgrowth:104" });
		// Agent Mail: two identities minted in the repo's project.
		expect(f.mail.calls.filter((call) => call.tool === "create_agent_identity")).toEqual([
			{ tool: "create_agent_identity", args: { project_key: f.repo, program: "omp", model: "omp-profile:codex" } },
			{ tool: "create_agent_identity", args: { project_key: f.repo, program: "omp", model: "omp-profile:codex" } },
		]);
		// Director goal proven from the new session file.
		const goalText = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		expect(goalText).toContain('"objective":"Grow the skill library"');
		// Status: seats named and alive, bead counts, real last commit.
		writeFileSync(join(f.stateRoot, "mail-wake.jsonl"), [
			{ recipient: "TurquoisePuma", status: "WOKEN_INPROCESS", ts: "2026-11-10T12:01:00Z" },
			{ recipient: "TurquoisePuma", status: "UNSIGNALED", ts: "2026-11-10T12:00:00Z" },
			{ recipient: "UnrelatedSeat", status: "WAKE_DELIVERED", ts: "2026-11-10T12:02:00Z" },
		].map(row => JSON.stringify(row)).join("\n") + "\n{torn");
		const status = await cli(f, ["project", "status", "skillgrowth", "--json"]);
		expect(status.code, status.out + status.err).toBe(0);
		const reported = JSON.parse(status.out).data;
		expect(reported.census).toEqual({ named: "2/2" });
		expect(reported.seats).toMatchObject([
			{ role: "director", name: "TurquoisePuma", pane: `tern:${f.directorBlock}`, alive: true, named: true, activeGoal: "Grow the skill library",
				wake: { outcome: "WOKEN_INPROCESS", at: "2026-11-10T12:01:00Z" } },
			{ role: "worker", name: "FoggyValley", pane: `tern:${f.workerBlock}`, alive: true, named: true,
				wake: { outcome: "no wake recorded", at: null } },
		]);
	expect(reported.beads).toEqual({ ready: 1, inProgress: 2, error: null });
		const head = decoder.decode(runFixture(["git", "-C", f.repo, "rev-parse", "HEAD"], { cwd: f.repo, label: "project-add head" }).stdout).trim();
		expect(reported.last_commit.sha).toBe(head);
		expect(typeof reported.last_commit.subject).toBe("string");

		// Undo restores all four stores byte-identically and closes the seats.
		const undone = await cli(f, ["project", "add", f.repo, "--session", "skillgrowth", "--undo", receiptId, "--yes", "--json"]);
		expect(undone.code, undone.out + undone.err).toBe(0);
		expect(JSON.parse(undone.out).data.action).toBe("UNDONE");
		expect(existsSync(join(f.repo, ".omp", "fleet.json"))).toBe(false);
		expect(readFileSync(f.rosterPath, "utf8")).toBe(rosterBefore);
		expect(readFileSync(f.fleetWatchPath, "utf8")).toBe(fleetBefore);
		expect(f.mail.calls.filter((call) => call.tool === "deregister_agent").length).toBe(2);
		const closedPath = join(f.dir, "tern-state", "closed.jsonl");
		expect(existsSync(closedPath)).toBe(true);
		expect(readFileSync(closedPath, "utf8").split("\n").filter(Boolean).sort()).toEqual([`skillgrowth/${f.directorBlock}`, `skillgrowth/${f.workerBlock}`].sort());
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTADD1 first goal needs a virgin seat and a real form; a taken seat refuses", async () => {
	const f = await fixture();
	try {
		const header = JSON.stringify({ type: "session", version: 3, id: "s1", cwd: f.repo }) + "\n";
		const settled = header + assistantEntry("m1", null);
		const io = {
			run: (_argv: readonly string[]) => ({ code: 0, out: "{}" }),
			readSessionFile: (path: string) => path === f.sessionFile("5") ? settled : null,
			wait: async (_ms: number) => {},
		};
		const observe = async () => ({ sessionFile: f.sessionFile("5") as string | null });
		// Planted: a fresh seat would prove, but this seat already has a file.
		const taken = await deliverFirstSeatGoal({
			seat: { session: "skillgrowth", pane: "tern:5", cwd: f.repo }, text: "/goal set Grow the skill library",
			io, observe, pollMs: 1, deadlineMs: 50, wait: async () => {},
		});
		expect(taken.status).toBe("REFUSED");
		expect(taken.code).toBe("FIRST_SEAT_TAKEN");
		// Controls: bare /goal and empty text never send.
		for (const text of ["/goal", ""]) {
			const refused = await deliverFirstSeatGoal({
				seat: { session: "skillgrowth", pane: "tern:5", cwd: f.repo }, text,
				io: { ...io, readSessionFile: () => null }, observe: async () => ({ sessionFile: null }),
				pollMs: 1, deadlineMs: 50, wait: async () => {},
			});
			expect(refused.status).toBe("REFUSED");
			expect(refused.sends).toBe(0);
		}
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
});

test("PROJECTADD1 turn-on and roster paths resolve from env, fleet-watch, or refuse naming both", async () => {
	const bin = join("/", "x", "skills", "s", "scripts", "respawn_seat.py");
	const viaEnv = resolveTurnOnPath({ OMP_KIT_RESPAWN_SEAT: bin } as NodeJS.ProcessEnv, "/nowhere/fleet-watch.json");
	if (!viaEnv.ok) throw new Error("env turn-on path rejected");
	expect(viaEnv.bin).toBe(bin);
	expect(resolveRosterPath({} as NodeJS.ProcessEnv, bin)).toBe(join("/", "x", "skills", "s", "fleet-roster.json"));
	expect(resolveRosterPath({ OMP_KIT_FLEET_ROSTER: "/r.json" } as NodeJS.ProcessEnv, bin)).toBe("/r.json");
	const f = await fixture();
	try {
		writeFileSync(f.fleetWatchPath, JSON.stringify({ sessions: [], respawnSeat: bin }));
		const viaFile = resolveTurnOnPath({} as NodeJS.ProcessEnv, f.fleetWatchPath);
		if (!viaFile.ok) throw new Error("fleet-watch turn-on path rejected");
		expect(viaFile.bin).toBe(bin);
		const missing = resolveTurnOnPath({} as NodeJS.ProcessEnv, join(f.dir, "absent.json"));
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.code).toBe("PROJECT_TURN_ON_UNCONFIGURED");
			expect(missing.remediation).toContain("OMP_KIT_RESPAWN_SEAT");
			expect(missing.remediation).toContain("respawnSeat");
		}
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
});

type StatusRun = { code: number; out: string; err: string };

function statusHarness(plant: {
	director?: string;
	worker?: string;
	blocks: unknown;
	panes: unknown[];
	inspectOut?: string;
	am: (pane: string) => StatusRun;
	br: (sub: string[]) => StatusRun;
}): {
	env: Record<string, string>;
	exec: { run: (argv: readonly string[]) => Promise<StatusRun> };
	cleanup: () => void;
} {
	const director = plant.director ?? "5";
	const worker = plant.worker ?? "6";
	const task = ownedTmp("project-status-108", { root: process.env.TMPDIR ?? "/tmp" });
	const home = realpathSync(task.path);
	const repo = join(home, "repo");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	const fleetWatchPath = join(home, ".config", "omp-kit", "fleet-watch.json");
	writeFileSync(fleetWatchPath, JSON.stringify({ sessions: [{
		session: "skillgrowth", repo, coordinatorSession: "skillgrowth", coordinatorPane: `tern:${director}`, workerPanes: [`tern:${worker}`],
	}] }));
	const exec = { run: async (argv: readonly string[]): Promise<StatusRun> => {
		if (argv[0] === "tern") {
			if (plant.inspectOut !== undefined) return { code: 0, out: plant.inspectOut, err: "" };
			return { code: 0, out: JSON.stringify({
				sessions: [{ id: "2", name: "skillgrowth", tabs: [{ name: "skillgrowth", blocks: plant.blocks }] }],
				panes: plant.panes,
			}), err: "" };
		}
		if (argv[0] === "am") {
			const at = argv.indexOf("--pane");
			return plant.am(at < 0 ? "" : String(argv[at + 1] ?? ""));
		}
		if (argv[0] === "br") return plant.br(argv.slice(1, argv.indexOf("--json")));
		if (argv[0] === "git") return { code: 1, out: "", err: "no repo" };
		return { code: 1, out: "", err: "unexpected " + String(argv[0]) };
	} };
	const env: Record<string, string> = {
		HOME: home, XDG_STATE_HOME: join(home, "state"),
		TERN_CTL_BIN: "tern", BR_BIN: "br", AM_BIN: "am",
	};
	const previousWatch = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = fleetWatchPath;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (previousWatch === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		else process.env.OMP_KIT_FLEET_WATCH_CONFIG = previousWatch;
		task.cleanup();
	};
	return { env, exec, cleanup };
}

const statusNames = (pane: string): StatusRun => ({ code: 0,
	out: JSON.stringify({ agent_name: pane === "tern:5" ? "Director" : "Worker" }), err: "" });

const statusCounts = (sub: string[]): StatusRun => sub[0] === "ready"
	? { code: 0, out: JSON.stringify([{ id: "a" }]), err: "" }
	: { code: 0, out: JSON.stringify([{ id: "b" }, { id: "c" }]), err: "" };

test("PROJECTGOALTRUTH1 latest pause or drop clears historical active goals", async () => {
	const panes = [{ pane: 5, exited: null, omp_session_file: "" }, { pane: 6, exited: null }];
	const h = statusHarness({ blocks: [5, 6], panes, am: statusNames, br: statusCounts });
	const journal = join(h.env.HOME!, "director.jsonl");
	panes[0]!.omp_session_file = journal;
	const active = { type: "mode_change", id: "active", mode: "goal",
		data: { goal: { id: "goal-1", status: "active", objective: "Do owned work" } } };
	const paused = { type: "mode_change", id: "paused", mode: "goal_paused",
		data: { goal: { id: "goal-1", status: "paused", objective: "Do owned work" } } };
	const dropped = { type: "mode_change", id: "dropped", mode: "none" };
	try {
		for (const [tail, expected] of [
			[[], "Do owned work"],
			[[paused], null],
			[[dropped], null],
			[[paused, { ...active, id: "resumed" }], "Do owned work"],
		] as const) {
			writeFileSync(journal, [active, ...tail].map(row => JSON.stringify(row)).join("\n")
				+ '\n{"unfinished":');
			const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
			if (!reported.ok) throw new Error(reported.detail);
			expect(reported.status.seats[0]!.activeGoal).toBe(expected);
		}
	} finally {
		h.cleanup();
	}
});

test("PROJECTSTATUS108 bare-number blocks with present panes read alive", async () => {
	const h = statusHarness({ blocks: [5, 6],
		panes: [{ pane: 5, exited: null }, { pane: 6, exited: null }],
		am: statusNames, br: statusCounts });
	try {
		const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
		if (!reported.ok) throw new Error(reported.detail);
		expect(reported.status.seats.map((seat) => seat.alive)).toEqual([true, true]);
		expect(reported.status.seats.map((seat) => seat.named)).toEqual([true, true]);
		expect(reported.status.seats.map((seat) => seat.name)).toEqual(["Director", "Worker"]);
		expect(reported.status.seats.map((seat) => seat.nameError)).toEqual([null, null]);
		expect(reported.status.beads).toEqual({ ready: 1, inProgress: 2, error: null });
	} finally {
		h.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);

test("PROJECTSTATUS108 planted dead panes read not alive", async () => {
	const h = statusHarness({ blocks: [5, 6],
		panes: [{ pane: 5, live: false, exited: null }, { pane: 6, exited: "boom" }],
		am: statusNames, br: statusCounts });
	try {
		const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
		if (!reported.ok) throw new Error(reported.detail);
		expect(reported.status.seats.map((seat) => seat.alive)).toEqual([false, false]);
		expect(reported.status.seats.map((seat) => seat.named)).toEqual([true, true]);
	} finally {
		h.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);

test("PROJECTSTATUS108 resolve-pane failure reports nameError instead of bare false", async () => {
	const h = statusHarness({ blocks: [5, 6],
		panes: [{ pane: 5, exited: null }, { pane: 6, exited: null }],
		am: (pane) => pane === "tern:5"
			? { code: 0, out: JSON.stringify({ agent_name: "Director" }), err: "" }
			: { code: 1, out: "", err: "unknown pane tern:6" },
		br: statusCounts });
	try {
		const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
		if (!reported.ok) throw new Error(reported.detail);
		expect(reported.status.seats[0]).toMatchObject({ named: true, name: "Director", nameError: null });
		expect(reported.status.seats[1]!.named).toBe(false);
		expect(reported.status.seats[1]!.name).toBe(null);
		expect(reported.status.seats[1]!.nameError ?? "").toContain("am agents resolve-pane exited 1");
		expect(reported.status.seats[1]!.nameError ?? "").toContain("unknown pane tern:6");
	} finally {
		h.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);

test("PROJECTSTATUS108 br shim refusal reports the beads reason", async () => {
	const h = statusHarness({ blocks: [5, 6],
		panes: [{ pane: 5, exited: null }, { pane: 6, exited: null }],
		am: statusNames,
		br: (sub) => sub[0] === "ready"
			? { code: 4, out: "", err: "BR_SHIM_IDENTITY_REQUIRED refusing to run br without AGENT_NAME (pane identity not resolved at spawn)" }
			: { code: 0, out: JSON.stringify([{ id: "b" }, { id: "c" }]), err: "" } });
	try {
		const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
		if (!reported.ok) throw new Error(reported.detail);
		expect(reported.status.beads.ready).toBe(null);
		expect(reported.status.beads.inProgress).toBe(2);
		expect(reported.status.beads.error ?? "").toContain("BR_SHIM_IDENTITY_REQUIRED");
	} finally {
		h.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);

test("PROJECTSTATUS108 odd id beyond 2^53 resolves and reads alive", async () => {
	const director = "9374092541034498";
	const worker = "9374096836001793";
	const inspectOut = `{"sessions": [{"id": "2", "name": "skillgrowth", "tabs": [{"name": "skillgrowth", "blocks": [{"id": ${director}}, {"id": ${worker}}]}]}], `
		+ `"panes": [{"pane": ${director}, "program": "/bin/zsh", "working": true, "exited": null, "omp_session_file": null}, `
		+ `{"pane": ${worker}, "program": "/bin/zsh", "working": true, "exited": null, "omp_session_file": null}]}`;
	const h = statusHarness({ director, worker, blocks: [], panes: [], inspectOut,
		am: (pane) => ({ code: 0, out: JSON.stringify({ agent_name: pane === `tern:${director}` ? "Director" : "Worker" }), err: "" }),
		br: statusCounts });
	try {
		const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
		if (!reported.ok) throw new Error(reported.detail);
		expect(reported.status.seats.map((seat) => seat.name)).toEqual(["Director", "Worker"]);
		expect(reported.status.seats.map((seat) => seat.named)).toEqual([true, true]);
		expect(reported.status.seats.map((seat) => seat.alive)).toEqual([true, true]);
	} finally {
		h.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);
