// project-add.helpers.ts: shared fixture for the project add, status and goal test files (split for the 90 s per-file budget, MINTFIELDS1 ompkit-1ra0d.249).
import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deliverFirstSeatGoal } from "../../src/send.ts";
import { projectStatus, resolveTurnOnPath, resolveRosterPath } from "../../src/project-add.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

export const ROOT = resolve(import.meta.dir, "../..");
export const decoder = new TextDecoder();

export type Fixture = {
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

export const assistantEntry = (id: string, parentId: string | null, text = "ready") =>
	JSON.stringify({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }) + "\n";

/** A live `sleep` decoy through kitlib run (owned process group); its pid is the child's first output line. */
export async function decoy(cwd: string): Promise<{ pid: number; stop: () => void }> {
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

export async function fixture(): Promise<Fixture> {
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
				// Agent Mail 0.3.39 refuses an identity without program and model (MINTFIELDS1).
				if (typeof args.program !== "string" || typeof args.model !== "string") {
					return Response.json({ error: { message: "Input validation failed: root: missing required field: program; root: missing required field: model" } }, { status: 400 });
				}
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
	// GOALPARK1: the park legs interrupt (Esc) before they send. The turn
	// carries only the block id, so it never reaches the payload parser.
	if (lua.includes("cx.agents:interrupt")) {
		fs.appendFileSync(dir + "/dispatched.log", JSON.stringify("interrupt") + "\\n");
		process.exit(0);
	}
	const parts = lua.split("string.char(");
	if (parts.length < 3) process.exit(1);
	const first = parts[1].slice(0, parts[1].indexOf(")"));
	// The ask turn carries long text in <=100-byte string.char chunks; only
	// reassembling every chunk restores the payload the seat would journal.
	const rest = parts.slice(2).map((part) => part.slice(0, part.indexOf(")"))).join(",");
	const block = Buffer.from(first.split(",").map((s) => Number(s.trim()))).toString("utf8");
	const payload = Buffer.from(rest.split(",").map((s) => Number(s.trim()))).toString("utf8");
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
	fs.appendFileSync(dir + "/dispatched.log", JSON.stringify(payload) + "\\n");
	if (payload === "/goal resume") {
		const entry = { type: "mode_change", id: stamp, parentId: parent, mode: "goal",
		data: { goal: { id: prev === null ? "goal-resumed" : prev.id, objective: prev === null ? "resumed" : prev.objective, status: "active" } } };
		fs.appendFileSync(file, JSON.stringify(entry) + "\\n");
		process.exit(0);
	}
	if (payload === "/goal pause") {
		if (process.env.PROJECTGOAL_NO_PARK !== "1") {
			const entry = { type: "mode_change", id: stamp, parentId: parent, mode: "goal_paused" };
			fs.appendFileSync(file, JSON.stringify(entry) + "\\n");
		}
		process.exit(0);
	}
	if (payload === "/goal drop") {
		const dropEntry = { type: "mode_change", id: stamp, parentId: parent, mode: "goal",
		data: { goal: { id: prev === null ? "goal-none" : prev.id, objective: prev === null ? "" : prev.objective, status: "dropped" } } };
		fs.appendFileSync(file, JSON.stringify(dropEntry) + "\\n");
		process.exit(0);
	}
	// GOALPARK1: the drop leg never sends /goal drop text; it asks the
	// seat to call its own goal tool with op=drop, and the seat journals a
	// goal-less (dropped-status) entry the same way the modal path would.
	if (payload.includes("op=drop")) {
		if (process.env.PROJECTGOAL_NO_PARK !== "1") {
			const toolDrop = { type: "mode_change", id: stamp, parentId: parent, mode: "goal",
			data: { goal: { id: prev === null ? "goal-none" : prev.id, objective: prev === null ? "" : prev.objective, status: "dropped" } } };
			fs.appendFileSync(file, JSON.stringify(toolDrop) + "\\n");
		}
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

export function cli(f: Fixture, argv: string[]): Promise<{ code: number | null; out: string; err: string }> {
	return run([process.execPath, join(ROOT, "src/cli.ts"), ...argv], {
		cwd: ROOT, env: f.env, deadline_s: fixtureDeadlineS(150), max_output_bytes: 1 << 20,
	}).then((result) => ({ code: result.rc, out: decoder.decode(result.stdout), err: decoder.decode(result.stderr) }));
}

export async function goalFixture(): Promise<Fixture> {
	const f = await fixture();
	writeFileSync(f.rosterPath, `{\n  "chiefs": { "lead": "PeachLeopard" },\n  "sessions": {\n    "other": { "director": "D", "workers": [] }\n  }\n}\n`);
	writeFileSync(f.fleetWatchPath, JSON.stringify({ enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
		sessions: [{ session: "other", coordinatorPane: "tern:9", coordinatorSession: "other", repo: "/other", workerPanes: [] }] }, null, 2) + "\n");
	const applied = await cli(f, ["project", "add", f.repo, "--session", "skillgrowth", "--workers", "1", "--profile", "codex", "--mission", "skillgrowth:104", "--goal", "Grow the skill library", "--orientation", "Take goals from the director", "--apply", "--yes", "--json"]);
	expect(applied.code, applied.out + applied.err).toBe(0);
	return f;
}

/** Every native payload the fake tern dispatched, in order (`/goal set`, `/goal resume`, never `/goal drop`). */
export function dispatchedPayloads(f: Fixture): string[] {
	const path = join(f.dir, "tern-state", "dispatched.log");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as string);
}
