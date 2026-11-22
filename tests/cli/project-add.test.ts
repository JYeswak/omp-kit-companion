import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { deliverFirstSeatGoal } from "../../src/send.ts";
import { applyProjectAdd } from "../../src/project-add.ts";
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
		if (applied.code !== 0) {
			const file = f.sessionFile(f.directorBlock);
			throw new Error(`${applied.out}${applied.err}\nDirector fixture journal: ${existsSync(file) ? readFileSync(file, "utf8") : "(absent)"}`);
		}
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

test.each(["adopted", "never", "wrong-goal", "unreadable-restored", "hidden-restored", "resumed-old-goal"])("GOALPROOFWAIT1 %s at the existing 20-second bound", async scenario => {
	const f = await fixture();
	const previous = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = f.fleetWatchPath;
	const attempts: { block: string; payload: string; at: number }[] = [];
	const pending = new Map<string, string>();
	let elapsed = 0;
	const resumed = scenario === "resumed-old-goal";
	const restored = scenario === "unreadable-restored" || scenario === "hidden-restored" || resumed;
	const originalTime = Date.UTC(2026, 0, 1);
	const directorPath = f.sessionFile(f.directorBlock);
	const journal = (block: string) => {
		const payload = pending.get(block)!;
		const isGoal = payload.startsWith("/goal set ");
		const now = Date.now();
		const createdAt = restored && isGoal ? originalTime : now;
		const entry = isGoal
			? { type: "mode_change", mode: "goal", data: { goal: {
				id: "goal-fresh", status: "active", createdAt, updatedAt: createdAt,
				objective: scenario === "wrong-goal" ? "Different objective" : payload.slice("/goal set ".length),
			} } }
			: { type: "message", message: { role: "user", content: [{ type: "text", text: payload }] } };
		writeFileSync(f.sessionFile(block), [
			JSON.stringify({ type: "session", version: 3, id: `s1-${block}`, cwd: f.repo }),
			assistantEntry("m1", null).trimEnd(),
			JSON.stringify({ ...entry, id: "accepted", parentId: "m1", timestamp: new Date(createdAt).toISOString() }),
		].join("\n") + "\n");
	};
	try {
		if (restored) {
			pending.set(f.directorBlock, "/goal set Grow the skill library");
			journal(f.directorBlock);
			pending.delete(f.directorBlock);
		}
		const result = await applyProjectAdd({
			repo: f.repo, session: "skillgrowth", workers: 1, profile: "codex", goal: "Grow the skill library",
			orientation: "Take goals from the director", env: f.env,
			deps: {
				exec: { async run(argv, options) {
					const r = await run(argv, { cwd: options?.cwd ?? f.repo, env: f.env, deadline_s: fixtureDeadlineS(15) });
					return { code: r.rc ?? 1, out: decoder.decode(r.stdout), err: decoder.decode(r.stderr) };
				} },
				mail: { async call(name, args) {
					const response = await fetch(`http://127.0.0.1:${f.mail.port}`, {
						method: "POST", body: JSON.stringify({ params: { name, arguments: args } }),
					});
					if (!response.ok) throw new Error(`owned mail fixture: ${response.status}`);
					return (await response.json()).result.structuredContent;
				} },
				io: {
					run(argv) {
						const [, verb, block, action, payload] = argv;
						if (verb !== "send" || block === undefined) throw new Error(`unexpected terminal command ${argv.join(" ")}`);
						if (action === "paste" && payload !== undefined) pending.set(block, payload);
						else if (action === "keys" && payload === "Enter" && pending.has(block)) {
							attempts.push({ block, payload: pending.get(block)!, at: elapsed });
							if (block === f.workerBlock) journal(block);
						} else throw new Error(`unexpected terminal payload ${argv.join(" ")}`);
						return { code: 0, out: "" };
					},
					readSessionFile(path) {
						if (scenario === "unreadable-restored" && path === directorPath && attempts.length === 0) return null;
						return existsSync(path) ? readFileSync(path, "utf8") : null;
					},
					async wait(ms) { throw new Error(`unowned wait ${ms}`); },
				},
				async observe(seat) {
					const block = seat.pane.slice("tern:".length);
					const path = f.sessionFile(block);
					if ((scenario === "hidden-restored" || resumed) && path === directorPath && attempts.length === 0) return { sessionFile: null };
					return { sessionFile: existsSync(path) ? path : null };
				},
				async wait(ms) {
					elapsed += ms;
					if (elapsed !== 20_000) return;
					if (resumed) {
						const now = Date.now();
						const entry = { type: "mode_change", mode: "goal", id: "resumed", parentId: "accepted",
							timestamp: new Date(now).toISOString(), data: { goal: { id: "goal-fresh", status: "active",
								createdAt: originalTime, updatedAt: now, objective: "Grow the skill library" } } };
						appendFileSync(directorPath, JSON.stringify(entry) + "\n");
					} else if (scenario !== "never" && !existsSync(directorPath)) journal(f.directorBlock);
				},
			},
		});
		console.log(JSON.stringify({ obligation: "GOALPROOFWAIT1", scenario, elapsed, attempts, result }));
		if (scenario === "unreadable-restored") {
			expect(result).toMatchObject({ ok: false, code: "PROJECT_GOAL_UNPROVEN" });
			expect(attempts).toEqual([]);
			expect(pending.size).toBe(0);
			return;
		}
		expect(attempts[0]).toEqual({ block: f.directorBlock, payload: "/goal set Grow the skill library", at: 0 });
		expect(elapsed).toBe(20_000);
		if (scenario === "adopted") {
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(attempts).toHaveLength(2);
			expect(attempts[1]).toMatchObject({ block: f.workerBlock, at: 20_000 });
			expect(attempts[1]!.payload).toContain("Take goals from the director");
		} else {
			expect(result).toMatchObject({ ok: false, code: "PROJECT_GOAL_UNPROVEN" });
			expect(attempts).toHaveLength(1);
			expect(existsSync(directorPath)).toBe(scenario !== "never");
		}
	} finally {
		if (previous === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		else process.env.OMP_KIT_FLEET_WATCH_CONFIG = previous;
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(45) * 1000);

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
	inspectOut?: (repo: string) => string;
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
			if (plant.inspectOut !== undefined) return { code: 0, out: plant.inspectOut(repo), err: "" };
			return { code: 0, out: JSON.stringify({
				sessions: [{ id: "2", name: "skillgrowth", tabs: [{ name: "skillgrowth", blocks: plant.blocks }] }],
				panes: plant.panes.map(row => row !== null && typeof row === "object" ? { cwd: repo, ...row } : row),
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

test("PROJECTSTATUS108 out-of-project panes remain unknown despite matching ids", async () => {
	const h = statusHarness({ blocks: [5, 6],
		panes: [{ pane: 5, cwd: "/unrelated-project", exited: null }, { pane: 6, cwd: "/unrelated-project", exited: null }],
		am: statusNames, br: statusCounts });
	try {
		const reported = await projectStatus({ session: "skillgrowth", env: h.env, deps: { exec: h.exec } });
		if (!reported.ok) throw new Error(reported.detail);
		expect(reported.status.seats.map(seat => seat.alive)).toEqual([null, null]);
		expect(reported.status.coverage.state).toBe("UNKNOWN");
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
	const inspectOut = (repo: string) => `{"sessions": [{"id": "2", "name": "skillgrowth", "tabs": [{"name": "skillgrowth", "blocks": [{"id": ${director}}, {"id": ${worker}}]}]}], `
		+ `"panes": [{"pane": ${director}, "cwd": ${JSON.stringify(repo)}, "program": "/bin/zsh", "working": true, "exited": null, "omp_session_file": null}, `
		+ `{"pane": ${worker}, "cwd": ${JSON.stringify(repo)}, "program": "/bin/zsh", "working": true, "exited": null, "omp_session_file": null}]}`;
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

test("REPOMANAGED1 conflicting duplicate registration refuses and preserves every store", async () => {
	const f = await fixture();
	try {
		const applied = await cli(f, ["project", "add", f.repo, "--session", "skillgrowth", "--workers", "1", "--profile", "codex", "--apply", "--yes", "--json"]);
		expect(applied.code, applied.out + applied.err).toBe(0);
		const fleetBefore = readFileSync(f.fleetWatchPath, "utf8");
		const rosterBefore = readFileSync(f.rosterPath, "utf8");
		const optInBefore = readFileSync(join(f.repo, ".omp", "fleet.json"), "utf8");
		const receiptsBefore = readdirSync(f.stateRoot).filter((name) => name.startsWith("project-add-")).sort();
		expect(f.mail.calls.filter((call) => call.tool === "create_agent_identity").length).toBe(2);

		// Planted negative: the same repo under a second session must not register.
		const duplicate = await cli(f, ["project", "add", f.repo, "--session", "secondseat", "--profile", "codex", "--apply", "--yes", "--json"]);
		expect(duplicate.code, duplicate.out + duplicate.err).toBe(2);
		const refusal = JSON.parse(duplicate.out).errors[0];
		expect(refusal.code).toBe("PROJECT_REPO_MANAGED");
		expect(refusal.message).toContain("skillgrowth");
		expect(refusal.message).toContain(f.repo);

		// A symlinked input resolves to the same canonical repo and refuses too.
		const alias = join(f.dir, "aliasrepo");
		symlinkSync(f.repo, alias);
		const aliased = await cli(f, ["project", "add", alias, "--session", "thirdseat", "--profile", "codex", "--apply", "--yes", "--json"]);
		expect(aliased.code, aliased.out + aliased.err).toBe(2);
		expect(JSON.parse(aliased.out).errors[0].code).toBe("PROJECT_REPO_MANAGED");
		expect(JSON.parse(aliased.out).errors[0].message).toContain("skillgrowth");

		// Neither refusal minted, wrote, or receipted anything.
		expect(f.mail.calls.filter((call) => call.tool === "create_agent_identity").length).toBe(2);
		expect(readFileSync(f.fleetWatchPath, "utf8")).toBe(fleetBefore);
		expect(readFileSync(f.rosterPath, "utf8")).toBe(rosterBefore);
		expect(readFileSync(join(f.repo, ".omp", "fleet.json"), "utf8")).toBe(optInBefore);
		expect(readdirSync(f.stateRoot).filter((name) => name.startsWith("project-add-")).sort()).toEqual(receiptsBefore);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("REPOMANAGED1 unrelated new repo still applies past a stale registry row", async () => {
	const f = await fixture();
	try {
		// A verified-absent registry repo cannot be the live repo, so it never blocks.
		writeFileSync(f.fleetWatchPath, JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
			sessions: [{ session: "ghost", coordinatorPane: "tern:9", coordinatorSession: "ghost", repo: join(f.dir, "gone-repo"), workerPanes: [] }] }, null, 2) + "\n");
		const other = join(f.dir, "repo2");
		mkdirSync(other, { recursive: true });
		// The fake tern reports its baked repo cwd; point it at the control repo
		// so seat observation binds (the product compares real repo paths only).
		const ternPath = join(f.bin, "tern");
		const ternBefore = readFileSync(ternPath, "utf8");
		const baked = JSON.stringify(f.repo);
		if (ternBefore.split(baked).length !== 2) throw new Error("fake tern repo line changed shape");
		writeFileSync(ternPath, ternBefore.replace(baked, JSON.stringify(other)));
		const applied = await cli(f, ["project", "add", other, "--session", "skillgrowth", "--workers", "1", "--profile", "codex", "--apply", "--yes", "--json"]);
		expect(applied.code, applied.out + applied.err).toBe(0);
		expect(JSON.parse(applied.out).data.action).toBe("APPLIED");
		const fleet = JSON.parse(readFileSync(f.fleetWatchPath, "utf8"));
		expect(fleet.sessions.find((row: { session: string }) => row.session === "ghost").repo).toBe(join(f.dir, "gone-repo"));
		expect(fleet.sessions.find((row: { session: string }) => row.session === "skillgrowth").repo).toBe(realpathSync(other));
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("REPOMANAGED1 stored symlink pane-less session still names the live coordinator", async () => {
	// No seat host: the refusal lands before any mint, write, turn-on, or receipt.
	const task = ownedTmp("repomanage-symlink");
	try {
		const root = realpathSync(task.path);
		const home = join(root, "home");
		const repo = join(root, "repo");
		mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
		mkdirSync(repo, { recursive: true });
		const alias = join(root, "oldlink");
		symlinkSync(repo, alias);
		const fleetWatchPath = join(home, ".config", "omp-kit", "fleet-watch.json");
		writeFileSync(fleetWatchPath, JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
			sessions: [{ session: "oldseat", coordinatorPane: "", coordinatorSession: "oldseat", repo: alias, workerPanes: [] }] }, null, 2) + "\n");
		const fleetBefore = readFileSync(fleetWatchPath, "utf8");
		let minted = 0;
		const refused = await applyProjectAdd({ repo, session: "newseat", workers: 1, profile: "codex",
			env: { HOME: home, OMP_KIT_RESPAWN_SEAT: join(root, "turn-on") } as NodeJS.ProcessEnv,
			deps: { mail: { call: async () => { minted += 1; return { agent_name: "Minted" }; } } } });
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("duplicate registered");
		expect(refused.code).toBe("PROJECT_REPO_MANAGED");
		expect(refused.detail).toContain("oldseat");
		expect(refused.detail).toContain(repo);
		expect("receiptId" in refused ? refused.receiptId : undefined).toBeUndefined();
		expect(minted).toBe(0);
		expect(readFileSync(fleetWatchPath, "utf8")).toBe(fleetBefore);
		expect(existsSync(join(repo, ".omp", "fleet.json"))).toBe(false);
	} finally {
		task.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);

test("REPOMANAGED1 registry row without verifiable repo aborts unverified", async () => {
	const task = ownedTmp("repomanage-unverified");
	try {
		const root = realpathSync(task.path);
		const home = join(root, "home");
		const repo = join(root, "repo");
		mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
		mkdirSync(repo, { recursive: true });
		const fleetWatchPath = join(home, ".config", "omp-kit", "fleet-watch.json");
		const config = JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
			sessions: [{ session: "ghost", coordinatorPane: "tern:9", coordinatorSession: "ghost", workerPanes: [] }] }, null, 2) + "\n";
		writeFileSync(fleetWatchPath, config);
		let minted = 0;
		const refused = await applyProjectAdd({ repo, session: "newseat", workers: 1, profile: "codex",
			env: { HOME: home, OMP_KIT_RESPAWN_SEAT: join(root, "turn-on") } as NodeJS.ProcessEnv,
			deps: { mail: { call: async () => { minted += 1; return { agent_name: "Minted" }; } } } });
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unverified registry admitted");
		expect(refused.code).toBe("PROJECT_FLEET_WATCH_INVALID");
		expect("receiptId" in refused ? refused.receiptId : undefined).toBeUndefined();
		expect(minted).toBe(0);
		expect(readFileSync(fleetWatchPath, "utf8")).toBe(config);
		expect(existsSync(join(repo, ".omp", "fleet.json"))).toBe(false);
	} finally {
		task.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);
