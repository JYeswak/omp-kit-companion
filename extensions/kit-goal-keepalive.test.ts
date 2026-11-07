import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import kitGoalKeepalive, { type GoalKeepaliveContext } from "./kit-goal-keepalive.ts";
import { incarnationSync, isDead, probeIncarnationSync, safePid, type Incarnation } from "../src/kitlib/proc.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "../tests/cli/fixture-process.ts";

// Default: hermetic owner-decision and re-arm-mutant checks.
// Live: OMP_KIT_TERN_LIVE=1 bun test extensions/kit-goal-keepalive.test.ts -t NATIVESESSION1
// Opens a real Tern window on macOS. Its working directory must be short enough
// for Darwin's 104-byte Unix socket path limit; long export roots cannot run it.

afterAll(cleanupAllOwnedTmp);
const root = resolve(import.meta.dir, "..");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type Observer = typeof kitGoalKeepalive;
async function timerCount(observer: Observer): Promise<number> {
	const handlers = new Map<string, (event: never, ctx: GoalKeepaliveContext) => unknown>();
	let timers = 0;
	const ctx = { setTimeout() { timers++; }, clearTimer() {}, sessionManager: { getBranch: () => [] } };
	await observer({ on(name, handler) { handlers.set(name, handler); } }, { env: { AGENT_NAME: "NativeOwner" } });
	for (const name of ["session_start", "goal_updated", "agent_end", "session_stop"]) {
		await handlers.get(name)?.({ goal: { status: "active" }, state: { enabled: true } } as never, ctx);
	}
	return timers;
}

test("NATIVESESSION1: no kit timer re-arms a seat; a planted re-arm timer is killed", async () => {
	expect(await timerCount(kitGoalKeepalive)).toBe(0);
	const dir = ownedTmp("native-session-mutant").path;
	const source = readFileSync(join(import.meta.dir, "kit-goal-keepalive.ts"), "utf8");
	const mutant = source.replace('pi.on("agent_end", (_event, ctx) => {', 'pi.on("agent_end", (_event, ctx) => {\n(ctx as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(() => {}, 120000);');
	expect(mutant).not.toBe(source);
	writeFileSync(join(dir, "mutant.ts"), mutant.replace('"../src/release-verdict-mail.ts"', JSON.stringify(join(root, "src/release-verdict-mail.ts"))));
	const loaded = await import(join(dir, "mutant.ts")) as { default: Observer };
	// The exact same no-rearm oracle rejects the old behavior, not a source-string approximation.
	expect(await timerCount(loaded.default)).toBeGreaterThan(0);
});

type RestoreIntent = { id: string; active: boolean };
function snapshotIntent(goal: { id: string; status: string }, enabled: boolean | undefined): RestoreIntent {
	return { id: goal.id, active: enabled === true && goal.status === "active" };
}
function resumeTargets(intents: ReadonlyMap<number, RestoreIntent>): number[] {
	return [...intents].filter(([, intent]) => intent.active).map(([seat]) => seat);
}

test("NATIVESESSION1: owner snapshots pause intent and resumes only previously active goals", () => {
	const paused = { goal: { id: "paused", status: "active" }, enabled: false };
	const active = { goal: { id: "active", status: "active" }, enabled: true };
	const completed = { goal: { id: "completed", status: "completed" }, enabled: true };
	const intents = new Map([paused, active, completed].map((reading, seat) =>
		[seat, snapshotIntent(reading.goal, reading.enabled)]));
	expect(intents.get(0)).toEqual({ id: "paused", active: false });
	expect(resumeTargets(intents)).toEqual([1]);
	// Native restore may change current state; it must not overwrite the owner's snapshot.
	paused.enabled = true;
	active.goal.status = "paused";
	expect(resumeTargets(intents)).toEqual([1]);
	expect(resumeTargets(intents)).not.toContain(0);
	expect(resumeTargets(intents)).not.toContain(2);
});

test.skipIf(process.env.OMP_KIT_TERN_LIVE !== "1" || process.platform !== "darwin" || Bun.which("tern") === null || Bun.which("omp") === null)(
	"NATIVESESSION1: daemon stopped with SIGTERM and restarted; owner resumes only previously active native goals",
	async () => {
		// Keep sockets in owned scratch; this live fixture requires a short checkout path.
		const scratchRoot = join(root, "var/agent-tmp");
		mkdirSync(scratchRoot, { recursive: true });
		const dir = ownedTmp("ns", { root: scratchRoot }).path;
		const socket = join(dir, "d.sock");
		const control = join(dir, "c.sock");
		const env = { ...process.env, TERN_CONFIG_DIR: join(dir, "cfg"), TERN_DAEMON_SOCKET: socket };
		const invoke = (argv: string[]) => runFixture(argv, { cwd: dir, env, floor_s: 20 });
		const tern = (...argv: string[]) => {
			const result = invoke(["tern", ...argv]);
			if (result.rc !== 0) throw new Error(`tern ${argv.join(" ")}: ${decode(result.stderr)}`);
			return decode(result.stdout);
		};
		let lastReading = "";
		const until = async <T,>(read: () => T | undefined): Promise<T> => {
			const end = Date.now() + fixtureDeadlineS(30) * 1000;
			while (Date.now() < end) {
				const value = read();
				if (value !== undefined) return value;
				// These conditions are produced by real Tern/OMP processes, not this test's clock.
				await Bun.sleep(50);
			}
			throw new Error(`native session condition was not observed: ${lastReading}`);
		};
		const owned = new Map<string, Incarnation>();
		const socketOwners = (name: string): number[] => {
			const result = invoke(["lsof", "-t", "-a", "-U", "--", name]);
			if (result.rc !== 0 && result.rc !== 1) throw new Error(`cannot inspect owned socket ${name}: ${decode(result.stderr)}`);
			return decode(result.stdout).split("\n").filter(Boolean).map(safePid);
		};
		const remember = (pid: number) => {
			const record = incarnationSync(safePid(pid));
			if (record !== null) owned.set(`${record.pid}:${record.start}`, record);
			return pid;
		};
		const daemonPid = () => {
			for (const pid of socketOwners(socket)) {
				const command = invoke(["ps", "-p", String(pid), "-o", "command="]);
				if (command.rc === 0 && decode(command.stdout).includes(` daemon --socket ${socket}`)) return remember(pid);
			}
			return undefined;
		};
		const remaining = (): Incarnation[] => {
			for (const name of [control, socket]) for (const pid of socketOwners(name)) remember(pid);
			return [...owned.values()].filter(record => !isDead(probeIncarnationSync(record)));
		};
		const waitStopped = async () => {
			const end = Date.now() + fixtureDeadlineS(2) * 1000;
			while (Date.now() < end) {
				if (remaining().length === 0) return;
				await Bun.sleep(50); // Real process exit cannot be advanced with a fake clock.
			}
		};
		const stopRecorded = (signal: "SIGTERM" | "SIGKILL") => {
			for (const record of remaining()) {
				const probe = probeIncarnationSync(record);
				if (isDead(probe)) continue;
				if (probe.state !== "live") throw new Error(`cannot safely signal recorded pid ${record.pid}: ${probe.evidence.reason}`);
				try { process.kill(safePid(record.pid), signal); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
			}
		};
		// A daemon must not retain the supervisor's capture pipe after the window exits.
		const window = runFixtureAsync(["/bin/sh", "-c", 'log=$1; shift; exec "$@" >"$log" 2>&1', "native-session", join(dir, "window.log"), "tern", "--control", control, "--dir", dir], { cwd: dir, env, floor_s: 180 });
		// Always observe the promise, including failed startup paths.
		void window.catch(() => {});
		let session: number | undefined;
		try {
			await until(() => {
				const result = invoke(["tern", "ls", "--json"]);
				lastReading = `${result.rc}: ${decode(result.stdout)} ${decode(result.stderr)}`;
				if (result.rc !== 0) return undefined;
				const state = JSON.parse(decode(result.stdout));
				return state.sessions?.[0]?.id as number | undefined;
			}).then(id => { session = id; });
			for (const pid of socketOwners(control)) remember(pid);
			const request = async (block: number, id: string, op: string) => {
				tern("send", String(block), "text", JSON.stringify({ id, type: "goal", op, objective: "NATIVESESSION1 owned canary" }));
				tern("send", String(block), "keys", "Enter");
				return until(() => {
					const text = tern("capture", String(block), "--surfaces");
					lastReading = text;
					for (const line of text.split("\n")) {
						try {
							const response = JSON.parse(line);
							if (response.id === id && response.type === "response") {
								expect(response.success).toBe(true);
								return response.data;
							}
						} catch (error) { if (!(error instanceof SyntaxError)) throw error; }
					}
					const inventory = JSON.parse(tern("ls", "--json"));
					for (const row of inventory.sessions ?? []) for (const tab of row.tabs ?? []) for (const pane of tab.blocks ?? []) {
						if (pane.id === block && pane.exited !== null) throw new Error(`native OMP exited: ${text}`);
					}
					return undefined;
				});
			};
			const ready = (block: number) => until(() => {
				const text = tern("capture", String(block), "--scrollback", "--surfaces");
				lastReading = text;
				return text.includes('"type":"ready"') ? true : undefined;
			});
			const panes: number[] = [];
			for (const name of ["paused", "active"]) {
				const home = join(dir, name);
				mkdirSync(home);
				// An existing nonempty native session is durable without a model/auth fixture.
				// Only history is seeded: goal changes below use real OMP RPC.
				const sessionFile = join(home, "session.jsonl");
				const timestamp = new Date().toISOString();
				writeFileSync(sessionFile, [
					{ type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd: dir },
					{ type: "message", id: "11111111", parentId: null, timestamp, message: {
						role: "user", content: [{ type: "text", text: "Historical input for the persistence canary." }], timestamp: Date.now(),
					} },
				].map(row => JSON.stringify(row)).join("\n") + "\n");
				// --restore is TUI-only; RPC restores the exact file through --resume.
				// Metadata-only goal RPC needs a resolvable model, not inference. This
				// non-secret credential and unreachable loopback prevent use of real auth.
				const pane = JSON.parse(tern("new", "tab", String(session), "--keep-open", "--json", "--", "env", `PI_CODING_AGENT_DIR=${home}`, "AGENT_NAME=NativeOwner", "OPENAI_API_KEY=nativesession-fixture-only", "OPENAI_BASE_URL=http://127.0.0.1:1", "omp", "--model", "openai/gpt-5.4", "--resume", sessionFile, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-tools"));
				panes.push(pane.block);
				await ready(pane.block);
				const created = await request(pane.block, `create-${name}`, "create");
				expect(created.state.enabled).toBe(true);
				if (name === "paused") expect((await request(pane.block, "owner-pause", "pause")).state.enabled).toBe(false);
			}
			// OMP 18.18 goals/settings.ts:3–39 has no startup keep-active switch.
			// rpc-goal.ts:312–316 deliberately pauses resumed processes; only
			// the restore owner may restore previously active intent with native RPC.
			const intents = new Map<number, RestoreIntent>();
			for (const block of panes) {
				const saved = await request(block, `snapshot-${block}`, "get");
				expect(saved.goal).not.toBeNull();
				intents.set(block, snapshotIntent(saved.goal, saved.state?.enabled));
			}
			const before = await until(daemonPid);
			process.kill(safePid(before), "SIGTERM");
			tern("daemon", "--socket", socket, "--login");
			const after = await until(() => { const pid = daemonPid(); return pid !== undefined && pid !== before ? pid : undefined; });
			expect(after).not.toBe(before);
			for (const block of panes) {
				const restored = await request(block, `restored-${block}`, "get");
				expect(restored.goal?.id).toBe(intents.get(block)!.id);
			}
			const resumed: number[] = [];
			for (const block of resumeTargets(intents)) {
				const result = await request(block, `owner-resume-${block}`, "resume");
				expect(result.goal.id).toBe(intents.get(block)!.id);
				resumed.push(block);
			}
			expect(resumed).toEqual([panes[1]!]);
			expect(resumed).not.toContain(panes[0]!);
			const paused = await request(panes[0]!, "get-paused-after-restart", "get");
			const active = await request(panes[1]!, "get-active-after-restart", "get");
			expect(paused.goal, JSON.stringify(paused)).not.toBeNull();
			expect(paused.state?.enabled ?? false, JSON.stringify(paused)).toBe(false);
			expect(active.state?.enabled, JSON.stringify(active)).toBe(true);
			expect(paused.goal.id).toBe(intents.get(panes[0]!)!.id);
			expect(active.goal.id).toBe(intents.get(panes[1]!)!.id);
			expect(owned.size).toBeGreaterThanOrEqual(3);
		} finally {
			if (session !== undefined) invoke(["tern", "kill", "session", String(session)]);
			invoke(["tern", "ctl", "--control", control, "quit"]);
			// Closing a native window need not terminate its app, and it can
			// restart its daemon. Discover only this fixture's socket owners,
			// retain incarnation evidence, and bound each shutdown phase.
			await waitStopped();
			stopRecorded("SIGTERM");
			await waitStopped();
			stopRecorded("SIGKILL");
			await waitStopped();
			expect(remaining().map(record => record.pid)).toEqual([]);
			await window;
			expect(remaining().map(record => record.pid)).toEqual([]);
			console.info(`NATIVESESSION1 teardown recorded=${JSON.stringify([...owned.values()])} live=[]`);
		}
	}, fixtureDeadlineS(180) * 1000,
);
