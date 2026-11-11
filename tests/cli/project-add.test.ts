import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deliverFirstSeatGoal } from "../../src/send.ts";
import { projectStatus, resolveTurnOnPath, resolveRosterPath } from "../../src/project-add.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

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
const ROOT = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();

type Fixture = {
	dir: string;
	home: string;
	repo: string;
	bin: string;
	stateRoot: string;
	rosterPath: string;
	fleetWatchPath: string;
	sessionFile: (pane: string) => string;
	directorBlock: string;
	workerBlock: string;
	env: Record<string, string>;
	killDecoys: () => void;
};

const assistantEntry = (id: string, parentId: string | null, text = "ready") =>
	JSON.stringify({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }) + "\n";

/** A live `sleep` decoy through kitlib run (owned process group); its pid is the child's first output line. */
async function decoy(cwd: string): Promise<{ pid: number; stop: () => void }> {
	const abort = new AbortController();
	const { promise, resolve } = Promise.withResolvers<number>();
	let buffered = "";
	void run(["sh", "-c", "echo $$; exec sleep 300"], { cwd, deadline_s: fixtureDeadlineS(300), signal: abort.signal, on_output: (_stream, chunk) => {
		buffered += decoder.decode(chunk);
		const newline = buffered.indexOf("\n");
		if (newline > 0) resolve(Number(buffered.slice(0, newline)));
	} }).catch(() => {});
	return { pid: await promise, stop: () => abort.abort() };
}

async function fixture(): Promise<Fixture> {
	const dir = realpathSync(ownedTmp("project-add", { root: process.env.TMPDIR ?? "/tmp" }).path);
	const home = join(dir, "home");
	const repo = join(dir, "repo");
	const bin = join(dir, "fakebin");
	const ternState = join(dir, "tern-state");
	for (const path of [home, repo, bin, ternState]) mkdirSync(path, { recursive: true });
	const stateRoot = join(home, ".local", "state", "omp-kit");
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	// The roster defaults to the turn-on script's own ROSTER (dir above the script dir).
	const rosterPath = join(dir, "fleet-roster.json");
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	const fleetWatchPath = join(home, ".config", "omp-kit", "fleet-watch.json");
	const sessionFile = (pane: string) => join(ternState, `session-${pane}.jsonl`);
	const directorBlock = "9374092541034498";
	const workerBlock = "9374092541034501";
	// Decoys give `tern process` a real, ps-resolvable foreground per pane.
	const decoys = [await decoy(repo), await decoy(repo)];
	const killDecoys = () => { for (const each of decoys) each.stop(); };
	// A real git repo so status reports a real last commit.
	const git = (...args: string[]) => runFixture(["git", ...args], { cwd: repo, label: "project-add git", floor_s: 30 });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "fixture\n");
	git("add", "README.md");
	git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture [test]");

	const minted = ["TurquoisePuma", "FoggyValley"];
	const calls: Fixture["mail"]["calls"] = [];
	let created = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const body = await request.json() as { params?: { name?: string; arguments?: Record<string, unknown> } };
			const name = body.params?.name ?? "";
			const args = body.params?.arguments ?? {};
			calls.push({ tool: name, args });
			const answer = (value: unknown) => Response.json({ result: { structuredContent: value } });
			if (name === "create_agent_identity") {
				const agent = minted[created++] ?? `Minted${created}`;
				return answer({ agent_name: agent });
			}
			if (name === "resolve_pane_identity") {
				const pane = typeof args.pane_id === "string" ? args.pane_id : "";
				const agent = pane === `tern:${directorBlock}` ? minted[0] : pane === `tern:${workerBlock}` ? minted[1] : null;
				return answer(agent === null ? {} : { agent_name: agent, pane_id: pane });
			}
			if (name === "deregister_agent") return answer({ ok: true });
			return Response.json({ error: { message: `unexpected tool ${name}` } }, { status: 400 });
		},
	});


	const write = (path: string, text: string) => writeFileSync(path, text);
	// Fake tern: static inspect/process JSON, send appends staged journal records,
	// goal adoption lands once observation has polled past the pre-send view.
	write(join(bin, "tern"), `#!/usr/bin/env bun
const fs = await import("node:fs");
const dir = ${JSON.stringify(ternState)};
const repo = ${JSON.stringify(repo)};
const args = process.argv.slice(2);
const stateFile = dir + "/inspect-count";
const count = () => { try { return Number(fs.readFileSync(stateFile, "utf8")); } catch { return 0; } };
const stageFile = (block) => dir + "/staged-" + block + ".json";
if (args[0] === "inspect") {
	const n = count() + 1;
	fs.writeFileSync(stateFile, String(n));
	for (const block of [process.env.DIR_BLOCK, process.env.WORKER_BLOCK]) {
		const staged = (() => { try { return JSON.parse(fs.readFileSync(stageFile(block), "utf8")); } catch { return null; } })();
		if (staged !== null && !staged.adopted && n - staged.createdAt >= 4) {
			const objective = staged.payload.startsWith("/goal set ") ? staged.payload.slice("/goal set ".length).trim() : null;
			const entry = objective === null
				? { type: "message", id: "u1", parentId: "m1", message: { role: "user", content: [{ type: "text", text: staged.payload }] } }
				: { type: "mode_change", id: "g1", parentId: "m1", mode: "goal", data: { goal: { id: "goal-1", objective, status: "active" } } };
			fs.appendFileSync(staged.file, JSON.stringify(entry) + "\\n");
			staged.adopted = true;
			fs.writeFileSync(stageFile(block), JSON.stringify(staged));
		}
	}
// Real tern shape: object blocks with numeric ids, pane entries keyed by
// numeric id with exited:null and no live field. Ids interpolate as raw
// JSON numbers so >2^53 digits stay exact on the wire, the way real tern
// serializes its uint64 ids (a JS number here would pre-round them).
const paneJson = (id) => '{"pane": ' + id + ', "cwd": ' + JSON.stringify(repo) + ', "working": false, "exited": null, "omp_session_file": ' + JSON.stringify(dir + "/session-" + id + ".jsonl") + '}';
console.log('{"sessions": [{"id": "2", "name": "skillgrowth", "tabs": [{"name": "skillgrowth", "blocks": [{"id": ' + process.env.DIR_BLOCK + ', "cwd": ' + JSON.stringify(repo) + '}, {"id": ' + process.env.WORKER_BLOCK + ', "cwd": ' + JSON.stringify(repo) + '}]}]}], "panes": [' + paneJson(process.env.DIR_BLOCK) + ', ' + paneJson(process.env.WORKER_BLOCK) + ']}');
	process.exit(0);
}
if (args[0] === "process") {
	const pid = args[1] === process.env.DIR_BLOCK ? Number(process.env.FAKE_PID_5) : Number(process.env.FAKE_PID_6);
	console.log(JSON.stringify({ pane: args[1], foreground: { name: "omp", pid, cwd: repo, argv: ["sleep", "300"] } }));
	process.exit(0);
}
if (args[0] === "send") {
	const block = String(args[1]);
	const file = dir + "/session-" + block + ".jsonl";
	if (args[2] === "paste") {
		const payload = args.slice(3).join(" ");
		const header = JSON.stringify({ type: "session", version: 3, id: "s1-" + block, cwd: repo }) + "\\n";
		const init = JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "ready" }], stopReason: "stop" } }) + "\\n";
		fs.writeFileSync(file, header + init);
		fs.writeFileSync(stageFile(block), JSON.stringify({ payload, file, adopted: false, createdAt: count() }));
		process.exit(0);
	}
	if (args[2] === "keys") { process.exit(0); }
	process.exit(1);
}
if (args[0] === "ctl") {
	// Native-agent-API dispatch used by deliverToTernSeat: the last
	// string.char(...) group carries the payload as UTF-8 bytes, the first
	// the block id. An idle live seat adopts a goal synchronously.
	const lua = args.slice(3).join(" ");
	const parts = lua.split("string.char(");
	if (parts.length < 3) process.exit(1);
	const first = parts[1].slice(0, parts[1].indexOf(")"));
	const last = parts[parts.length - 1].slice(0, parts[parts.length - 1].indexOf(")"));
	const block = Buffer.from(first.split(",").map((s) => Number(s.trim()))).toString("utf8");
	const payload = Buffer.from(last.split(",").map((s) => Number(s.trim()))).toString("utf8");
	const file = dir + "/session-" + block + ".jsonl";
	let parent = "m1";
	let prev = null;
	try {
		const lines = fs.readFileSync(file, "utf8").split("\\n").filter((line) => line.trim() !== "");
		const tip = JSON.parse(lines[lines.length - 1]);
		if (tip !== null && typeof tip === "object" && typeof tip.id === "string" && tip.id !== "") parent = tip.id;
		const n = lines.length;
		for (let i = lines.length - 1; i >= 0; i--) {
			const record = JSON.parse(lines[i]);
			const goal = record !== null && typeof record === "object" && record.type === "mode_change" && record.mode === "goal"
				? (record.data !== null && typeof record.data === "object" ? record.data.goal : null) : null;
			if (goal !== null && typeof goal === "object" && typeof goal.id === "string" && typeof goal.objective === "string") {
				prev = { id: goal.id, objective: goal.objective, n };
				break;
			}
		}
	} catch { /* virgin journal: the assistant root stays the parent */ }
	const stamp = "g" + String(fs.readFileSync(file, "utf8").split("\\n").filter((line) => line.trim() !== "").length + 1);
	if (payload === "/goal drop") {
		const entry = { type: "mode_change", id: stamp, parentId: parent, mode: "goal",
		data: { goal: { id: prev === null ? "goal-none" : prev.id, objective: prev === null ? "" : prev.objective, status: "dropped" } } };
		fs.appendFileSync(file, JSON.stringify(entry) + "\\n");
		process.exit(0);
	}
	if (process.env.PROJECTGOAL_NO_SET === "1" && payload.startsWith("/goal set ")) process.exit(0);
	const objective = payload.startsWith("/goal set ") ? payload.slice("/goal set ".length).trim() : null;
	const entry = objective === null
		? { type: "message", id: stamp, parentId: parent, message: { role: "user", content: [{ type: "text", text: payload }] } }
		: { type: "mode_change", id: stamp, parentId: parent, mode: "goal", data: { goal: { id: "goal-" + stamp, objective, status: "active" } } };
	fs.appendFileSync(file, JSON.stringify(entry) + "\\n");
	process.exit(0);
}
if (args[0] === "close") {
	fs.appendFileSync(dir + "/closed.jsonl", args.slice(1).join(" ") + "\\n");
	process.exit(0);
}
process.exit(1);
`);
	// Fake turn-on: validates the prescribed argv, prints the real ALL_NAMED shape.
	write(join(bin, "respawn_seat.py"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
const want = ["--turn-on", "--session", "skillgrowth", "--profile", "codex", "--apply", "--json"];
const ok = want.every((flag, i) => args[i] === flag);
if (!ok) { console.error("unexpected turn-on argv: " + JSON.stringify(args)); process.exit(3); }
console.log(JSON.stringify({ at: "2026-11-10T00:00:00Z", session: "skillgrowth", profile: "codex", named: "2/2", profile_mismatch: [],
	rows: [
		{ block: process.env.DIR_BLOCK, role: "director", name: "TurquoisePuma", action: "start", result: "STARTED" },
		{ block: process.env.WORKER_BLOCK, role: "worker", name: "FoggyValley", action: "start", result: "STARTED" },
	], result: "ALL_NAMED" }));
`);
	// Fake am: resolve-pane answers the two created pane identities.
	write(join(bin, "am"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "agents" && args[1] === "resolve-pane") {
	const pane = String(args[args.indexOf("--pane") + 1] ?? "");
	const id = pane.startsWith("tern:") ? pane.slice(5) : pane;
	const name = id === process.env.DIR_BLOCK ? "TurquoisePuma" : id === process.env.WORKER_BLOCK ? "FoggyValley" : null;
	if (name === null) { console.error("unknown pane " + pane); process.exit(1); }
	const project = String(args[args.indexOf("--project") + 1] ?? "");
	console.log(JSON.stringify({ agent_name: name, pane_id: pane, project_key: project, binding: "legacy-unverified" }));
	process.exit(0);
}
process.exit(1);
`);
	// Fake br: canned ready/in-progress counts.
	write(join(bin, "br"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "ready") { console.log(JSON.stringify({ issues: [{ id: "a" }], total: 1 })); process.exit(0); }
if (args[0] === "list") { console.log(JSON.stringify({ issues: [{ id: "b" }, { id: "c" }], total: 2 })); process.exit(0); }
process.exit(1);
`);
	for (const script of ["tern", "respawn_seat.py", "br", "am"]) chmodSync(join(bin, script), 0o755);

	const env: Record<string, string> = {
		...process.env as Record<string, string>,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		OMP_KIT_FLEET_WATCH_CONFIG: fleetWatchPath,
		TERN_CTL_BIN: join(bin, "tern"),
		OMP_KIT_RESPAWN_SEAT: join(bin, "respawn_seat.py"),
		BR_BIN: join(bin, "br"),
		DIR_BLOCK: directorBlock,
		WORKER_BLOCK: workerBlock,
		FAKE_PID_5: String(decoys[0]!.pid),
		FAKE_PID_6: String(decoys[1]!.pid),
		AGENTMAIL_HTTP_URL: `http://127.0.0.1:${server.port}/api`,
		AGENTMAIL_HTTP_BEARER_TOKEN: "test-token",
		PATH: `${bin}:${process.env.PATH ?? ""}`,
	};
	return { dir, home, repo, bin, stateRoot, rosterPath, fleetWatchPath, sessionFile, killDecoys, directorBlock, workerBlock,
		env, mail: { calls, minted, port: server.port, server } };
}

function cli(f: Fixture, argv: string[]): Promise<{ code: number | null; out: string; err: string }> {
	return run([process.execPath, join(ROOT, "src/cli.ts"), ...argv], {
		cwd: ROOT, env: f.env, deadline_s: fixtureDeadlineS(150), max_output_bytes: 1 << 20,
	}).then((result) => ({ code: result.rc, out: decoder.decode(result.stdout), err: decoder.decode(result.stderr) }));
}

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
			{ tool: "create_agent_identity", args: { project_key: f.repo } },
			{ tool: "create_agent_identity", args: { project_key: f.repo } },
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

async function goalFixture(): Promise<Fixture> {
	const f = await fixture();
	writeFileSync(f.rosterPath, `{\n  "chiefs": { "lead": "PeachLeopard" },\n  "sessions": {\n    "other": { "director": "D", "workers": [] }\n  }\n}\n`);
	writeFileSync(f.fleetWatchPath, JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
		sessions: [{ session: "other", coordinatorPane: "tern:9", coordinatorSession: "other", repo: "/other", workerPanes: [] }] }, null, 2) + "\n");
	const applied = await cli(f, ["project", "add", f.repo, "--session", "skillgrowth", "--workers", "1", "--profile", "codex", "--mission", "skillgrowth:104", "--goal", "Grow the skill library", "--orientation", "Take goals from the director", "--apply", "--yes", "--json"]);
	expect(applied.code, applied.out + applied.err).toBe(0);
	return f;
}

test("PROJECTGOAL1 replace: drop proven, set proven, previous text reported, status shows the new goal", async () => {
	const f = await goalFixture();
	try {
		const journalBefore = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		// Plan is the default and changes nothing.
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		const plan = JSON.parse(planned.out).data;
		expect(plan.action).toBe("PLAN");
		expect(plan.seat).toBe(`tern:${f.directorBlock}`);
		expect(plan.current_goal).toBe("Grow the skill library");
		expect(plan.new_goal).toBe("Own skillgrowth: land the queue");
		expect(plan.deliveries).toEqual([{ seat: `tern:${f.directorBlock}`, kind: "goal-drop" }, { seat: `tern:${f.directorBlock}`, kind: "goal-set" }]);
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).toBe(journalBefore);
		// Apply drops the old goal, then sets the new one, each proven from the journal.
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("APPLIED");
		expect(done.seat).toBe(`tern:${f.directorBlock}`);
		expect(done.previous_goal).toBe("Grow the skill library");
		expect(typeof done.goal_id).toBe("string");
		expect(done.dropped).toBe(true);
		const journal = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		expect(journal).toContain('"status":"dropped"');
		expect(journal).toContain('"objective":"Own skillgrowth: land the queue"');
		// Status reads the new active goal from the journal.
		const status = await cli(f, ["project", "status", "skillgrowth", "--json"]);
		expect(status.code, status.out + status.err).toBe(0);
		expect(JSON.parse(status.out).data.seats[0].activeGoal).toBe("Own skillgrowth: land the queue");
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 set on a goal-less seat sends no drop", async () => {
	const f = await goalFixture();
	try {
		// A restarted seat whose journal carries no active goal.
		const lines = readFileSync(f.sessionFile(f.directorBlock), "utf8").split("\n");
		writeFileSync(f.sessionFile(f.directorBlock), lines.slice(0, 2).join("\n") + "\n");
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		expect(JSON.parse(planned.out).data.current_goal).toBe(null);
		expect(JSON.parse(planned.out).data.deliveries).toEqual([{ seat: `tern:${f.directorBlock}`, kind: "goal-set" }]);
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("APPLIED");
		expect(done.previous_goal).toBe(null);
		expect(done.dropped).toBe(false);
		expect(typeof done.goal_id).toBe("string");
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).not.toContain('"status":"dropped"');
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 a paused seat is refused with zero sends", async () => {
	const f = await goalFixture();
	try {
		const path = f.sessionFile(f.directorBlock);
		const before = readFileSync(path, "utf8");
		const tip = JSON.parse(before.split("\n").filter((line) => line.trim() !== "").pop()!);
		writeFileSync(path, before + JSON.stringify({ type: "mode_change", id: "gp1", parentId: tip.id, mode: "goal_paused" }) + "\n");
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code).toBe(2);
		expect(JSON.parse(changed.out).errors[0].code).toBe("GATE_PAUSED");
		expect(readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length)
			.toBe(before.split("\n").filter((line) => line.trim() !== "").length + 1);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 goal text refusals: empty, over cap, and a line starting with /", async () => {
	const f = await goalFixture();
	try {
		const before = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		const empty = await cli(f, ["project", "goal", "skillgrowth", "--set", "   ", "--apply", "--yes", "--json"]);
		expect(empty.code).toBe(2);
		expect(JSON.parse(empty.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const slashed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Legit line\n/goal drop", "--apply", "--yes", "--json"]);
		expect(slashed.code).toBe(2);
		expect(JSON.parse(slashed.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const crSlashed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Legit line\r/goal drop", "--apply", "--yes", "--json"]);
		expect(crSlashed.code).toBe(2);
		expect(JSON.parse(crSlashed.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const indented = await cli(f, ["project", "goal", "skillgrowth", "--set", "Legit line\n   /goal drop", "--apply", "--yes", "--json"]);
		expect(indented.code).toBe(2);
		expect(JSON.parse(indented.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const nul = join(f.dir, "nul-goal.txt");
		writeFileSync(nul, "Own skillgrowth: " + String.fromCharCode(0) + "land the queue");
		const nulled = await cli(f, ["project", "goal", "skillgrowth", "--from-file", nul, "--apply", "--yes", "--json"]);
		expect(nulled.code).toBe(2);
		expect(JSON.parse(nulled.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const big = join(f.dir, "big-goal.txt");
		writeFileSync(big, "x".repeat(16 * 1024 + 1));
		const capped = await cli(f, ["project", "goal", "skillgrowth", "--from-file", big, "--apply", "--yes", "--json"]);
		expect(capped.code).toBe(2);
		expect(JSON.parse(capped.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const missing = await cli(f, ["project", "goal", "nosuch", "--set", "Something", "--apply", "--yes", "--json"]);
		expect(missing.code).toBe(2);
		expect(JSON.parse(missing.out).errors[0].code).toBe("PROJECT_SESSION_UNKNOWN");
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).toBe(before);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 set unproven after a proven drop reports the partial state", async () => {
	const f = await goalFixture();
	try {
		f.env.PROJECTGOAL_NO_SET = "1";
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code).toBe(1);
		const errors = JSON.parse(changed.out).errors;
		expect(errors[0].code).toBe("PROJECT_GOAL_UNPROVEN");
		expect(errors[0].message).toContain("drop proven but set unproven");
		expect(errors[0].message).toContain("goal-less");
		const journal = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		expect(journal).toContain('"status":"dropped"');
		expect(journal).not.toContain('"objective":"Own skillgrowth: land the queue"');
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);
