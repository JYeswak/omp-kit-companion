// ompkit-xa5s.54 / PYGATE2 original AC d. Runtime proof, not a forged age/table/owner.
// Before this change, a new PPID1 Python interpreter is never selected (only old harness argv is);
// the old exported numeric killOrphan can also signal an unrelated current PID without ownership.
import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, createScratch, defaultLiveness, defaultRunner, inspectScratchOrphan, killOrphan, listProcesses,
	parseOwnerFile, reapLogPath, updateScratchUsers, type ApplyDeps, type OrphanProcess, type ScratchOrphanProof, type ScratchRunner } from "../../src/scratch.ts";
import { isDead, probeIncarnationSync, type Incarnation } from "../../src/kitlib/proc.ts";
import { privateLock } from "../../src/kitlib/lock.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repo = resolve(import.meta.dir, "../..");
const fixtureParent = join(repo, "var", "agent-tmp");
const python = Bun.which("python3");
const supported = (process.platform === "darwin" || process.platform === "linux") && python !== null && Bun.which("lsof") !== null;
const scratchModule = join(repo, "src", "scratch.ts");
const runModule = join(repo, "src", "kitlib", "run.ts");
const procModule = join(repo, "src", "kitlib", "proc.ts");
interface Interpreter extends Incarnation { dir: string; ownerPid: number }
interface Fixture {
	repo: string;
	root: string;
	home: string;
	deps: ApplyDeps;
	launch: (label: string, options?: { liveOwner?: boolean; fdOnly?: boolean; ignoreTerm?: boolean; service?: boolean; seat?: boolean; inline?: boolean }) => Promise<Interpreter>;
}

// Reparenting and signal delivery are OS events: fake clocks cannot drive their completion.
// Poll the observed condition with a hard bound, never a fixed \"long enough\" sleep.
async function until<T>(read: () => T | null, label: string, timeoutMs = 10000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== null) return value;
		if (Date.now() >= end) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(25);
	}
}

function processRow(child: Interpreter): OrphanProcess {
	const row = listProcesses(defaultRunner).find(row => row.pid === child.pid);
	if (row === undefined) throw new Error(`fixture interpreter ${child.pid} vanished`);
	return row;
}

function eligible(child: Interpreter, fixture: Fixture): ScratchOrphanProof {
	const decision = inspectScratchOrphan(processRow(child), fixture.home, fixture.deps);
	expect(decision.status, JSON.stringify(decision)).toBe("eligible");
	if (decision.proof === undefined) throw new Error(`no orphan proof: ${JSON.stringify(decision)}`);
	expect(decision.proof).toMatchObject({ pid: child.pid, start: child.start, dir: child.dir, ppid: 1, uid: process.getuid?.() });
	return decision.proof;
}

async function runtimeFixture(body: (fixture: Fixture) => Promise<void>, unicode = false): Promise<void> {
	mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
	const arena = ownedTmp("scratch-orphan-reap", { root: fixtureParent, autoCleanup: false });
	let fixtureRepo = ownedTmp("fixture-repo", { root: arena.path, autoCleanup: false }).path;
	if (unicode) {
		const renamed = join(arena.path, "répertoire");
		renameSync(fixtureRepo, renamed);
		fixtureRepo = renamed;
	}
	const home = ownedTmp("fixture-home", { root: arena.path, autoCleanup: false }).path;
	const root = join(fixtureRepo, "var", "agent-tmp");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const envKeys = ["OMP_KIT_SCRATCH_ROOTS", "XDG_STATE_HOME", "OMP_KIT_SESSION_OWNERS_DIR", "TMPDIR", "LC_ALL"] as const;
	const saved = new Map(envKeys.map(key => [key, process.env[key]]));
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.OMP_KIT_SESSION_OWNERS_DIR = join(home, "seats");
	process.env.TMPDIR = arena.path;
	if (unicode) process.env.LC_ALL = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
	mkdirSync(process.env.XDG_STATE_HOME, { mode: 0o700 });
	mkdirSync(process.env.OMP_KIT_SESSION_OWNERS_DIR, { mode: 0o700 });
	const children: Interpreter[] = [];
	const deps: ApplyDeps = { home, run: defaultRunner, liveness: defaultLiveness(), systemTempBases: [], callerSeat: () => ({ agent: null, main: null, sessions: [] }) };
	const fixture: Fixture = { repo: fixtureRepo, root, home, deps, launch: async (label, options = {}) => {
		if (python === null) throw new Error("python3 required for real interpreter proof");
		const handoff = join(arena.path, `${label}.json`);
		let liveDir: string | null = null;
		if (options.liveOwner) {
			const created = createScratch(label, fixtureRepo, deps, {}, true, join(home, "budgets.json"));
			if (!created.ok) throw new Error(`live control createScratch: ${JSON.stringify(created)}`);
			liveDir = created.dir;
		}
		const worker = [
			"import json, os, signal, socket, time",
			"held = open(__file__, 'rb')",
			...(options.ignoreTerm ? ["signal.signal(signal.SIGTERM, signal.SIG_IGN)"] : []),
			...(options.service ? ["listener = socket.socket()", "listener.bind(('127.0.0.1', 0))", "listener.listen(1)"] : []),
			// No live/unknown pipe client: stdio is explicitly detached before publishing atomic readiness.
			"null = os.open(os.devnull, os.O_RDWR)",
			"for fd in (0, 1, 2): os.dup2(null, fd)",
			"os.close(null)",
			"ready = os.path.join(os.path.dirname(__file__), 'ready.json')",
			"with open(ready + '.pending', 'w') as output: json.dump({'pid': os.getpid()}, output)",
			"os.replace(ready + '.pending', ready)",
			"time.sleep(180)",
		].join("\n");
		const inlineTail = [
			"private_marker = 'py54-inline-private-payload'",
			...(options.fdOnly ? ["held = open(os.path.join(fixture_dir, 'linkage.data'), 'rb')"] : []),
			...(options.ignoreTerm ? ["signal.signal(signal.SIGTERM, signal.SIG_IGN)"] : []),
			...(options.service ? ["listener = socket.socket()", "listener.bind(('127.0.0.1', 0))", "listener.listen(1)"] : []),
			"null = os.open(os.devnull, os.O_RDWR)",
			"[os.dup2(null, fd) for fd in (0, 1, 2)]",
			"os.close(null)",
			"ready = os.path.join(fixture_dir, 'ready.json')",
			"output = open(ready + '.pending', 'w')",
			"json.dump({'pid': os.getpid()}, output)",
			"output.close()",
			"os.replace(ready + '.pending', ready)",
			"time.sleep(180)",
		].join("; ");
		// Both process launches use kitlib. The owner crashes deliberately after recording its child's
		// genuine incarnation; nested run() owns a distinct session, so the interpreter really becomes PPID1.
		// No fork/spawn escape hatch, handcrafted .owner, installed CLI, or forged one-hour age is involved.
		const driver = `
import { createScratch, defaultRunner, defaultLiveness } from ${JSON.stringify(scratchModule)};
import { run } from ${JSON.stringify(runModule)};
import { incarnationSync } from ${JSON.stringify(procModule)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const made = ${liveDir === null ? `createScratch(${JSON.stringify(label)}, ${JSON.stringify(fixtureRepo)}, { run: defaultRunner, liveness: defaultLiveness(), callerSeat: () => (${options.seat ? '{ agent: "OrphanFixture", main: "orphan-fixture-session", sessions: ["orphan-fixture-session"] }' : "{ agent: null, main: null, sessions: [] }"}) }, {}, true, ${JSON.stringify(join(home, `${label}-budgets.json`))})` : `{ ok: true, dir: ${JSON.stringify(liveDir)} }`};
if (!made.ok) throw new Error(JSON.stringify(made));
let argv;
if (${options.inline === true}) {
  // This is literally Python -c import ..., not exec(open(script)) or a renamed script fixture.
  writeFileSync(join(made.dir, "linkage.data"), "owned descriptor linkage\\n", { mode: 0o600 });
  const program = "import json, os, signal, socket, time; fixture_dir = " + JSON.stringify(made.dir) + "; " + ${JSON.stringify(inlineTail)};
  argv = [${JSON.stringify(python)}, "-c", program];
} else {
  const script = join(made.dir, "interpreter.py");
  writeFileSync(script, ${JSON.stringify(worker)}, { mode: 0o600 });
  argv = [${JSON.stringify(python)}, script];
}
const controller = new AbortController();
const running = run(argv, { deadline_s: 180, grace_s: 0.2, max_output_bytes: 4096,
  cwd: ${options.fdOnly ? JSON.stringify(fixtureRepo) : "made.dir"}, env: { ...process.env, TMPDIR: made.dir }, signal: controller.signal });
const ready = join(made.dir, "ready.json"), deadline = Date.now() + 10000;
try {
  // This observes a real OS child after its descriptors are detached; fake clocks cannot publish readiness.
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error("fixture interpreter readiness timed out");
    await Bun.sleep(25);
  }
  const { pid } = JSON.parse(readFileSync(ready, "utf8"));
  const child = incarnationSync(pid);
  if (child === null) throw new Error("fixture child incarnation unavailable");
  writeFileSync(${JSON.stringify(handoff)}, JSON.stringify({ ...child, dir: made.dir, ownerPid: process.pid }), { mode: 0o600 });
  process.kill(process.pid, "SIGKILL");
} finally {
  // Normal failure drains the group; the deliberate SIGKILL alone skips this and exercises the orphan path.
  controller.abort(new Error("fixture owner failed before deliberate crash"));
  await running.catch(() => undefined);
}
`;
		const result = await run([process.execPath, "-e", driver], { deadline_s: 20, grace_s: 0.2, max_output_bytes: 16384,
			cwd: repo, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
		if (!existsSync(handoff)) throw new Error(`fixture owner failed rc=${result.rc}: ${new TextDecoder().decode(result.stderr)}`);
		const child: Interpreter = JSON.parse(readFileSync(handoff, "utf8"));
		children.push(child); // Cleanup authority is the recorded child incarnation, never a name or process-table match.
		expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(-9);
		await until(() => {
			const row = listProcesses(defaultRunner).find(row => row.pid === child.pid);
			return row?.ppid === 1 ? row : null;
		}, "real PPID1 adoption");
		expect(probeIncarnationSync(child).state).toBe("live");
		return child;
	} };
	try {
		await body(fixture);
	} finally {
		try {
			for (const child of children) {
				const before = probeIncarnationSync(child);
				if (before.state === "live") process.kill(child.pid, "SIGKILL");
				else if (!isDead(before)) throw new Error(`refusing cleanup of unknown fixture incarnation ${child.pid}`);
				await until(() => isDead(probeIncarnationSync(child)) ? true : null, `fixture ${child.pid} exit`);
			}
			arena.cleanup();
		} finally {
			for (const key of envKeys) {
				const old = saved.get(key);
				if (old === undefined) delete process.env[key]; else process.env[key] = old;
			}
		}
	}
}

// Deliberately no age wait/bypass. Replay the observed Python -c import ... boundary literally.
test.skipIf(!supported)("scratch apply stops a real PPID1 Python -c import interpreter, receipts PID/start/path/linkage, and preserves a live-owned PPID1 -c control", async () => {
	await runtimeFixture(async fixture => {
		const orphan = await fixture.launch("abandoned", { inline: true });
		const control = await fixture.launch("live-owned", { inline: true, liveOwner: true });
		const owner = parseOwnerFile(readFileSync(join(orphan.dir, ".owner"), "utf8"));
		expect(owner?.pid).toBe(orphan.ownerPid);
		expect(owner?.processStart).not.toBeNull();
		const proof = eligible(orphan, fixture);
		expect(proof).toMatchObject({ invocation: "python-c", script: null });
		expect(existsSync(join(orphan.dir, "interpreter.py"))).toBe(false);
		expect(proof.ageSeconds).toBeLessThan(3600);
		expect(proof.linkage.some(link => link.kind === "cwd" && link.path === orphan.dir)).toBe(true);
		expect(proof.linkage.every(link => link.kind === "cwd")).toBe(true); // The inline positive has no script/FD surrogate.
		const result = applyScratch(fixture.home, fixture.deps);
		const stopped = result.killed.find(row => row.pid === orphan.pid);
		expect(stopped).toMatchObject({ pid: orphan.pid, start: orphan.start, path: orphan.dir, status: "terminated", ok: true });
		expect(stopped?.linkage.length).toBeGreaterThan(0);
		expect(isDead(probeIncarnationSync(orphan))).toBe(true);
		expect(probeIncarnationSync(control).state).toBe("live");
		expect(result.orphanDecisions.find(row => row.pid === control.pid)).toMatchObject({ status: "preserved", reason: "owner-live" });
		expect(result.killed.some(row => row.pid === control.pid)).toBe(false);
		expect(result.receipt.orphan_processes).toContainEqual(expect.objectContaining({
			pid: orphan.pid, start: orphan.start, path: orphan.dir, status: "terminated", ok: true }));
		expect(result.receipt.orphan_processes).toContainEqual(expect.objectContaining({
			pid: control.pid, start: control.start, path: control.dir, status: "preserved", ok: false }));
		expect(JSON.stringify(result)).not.toContain("py54-inline-private-payload");
		const events: { event: string; pid?: number; start?: string; path?: string; ok?: boolean }[] = readFileSync(reapLogPath(fixture.home), "utf8")
			.trim().split("\n").map(line => JSON.parse(line));
		expect(events).toContainEqual(expect.objectContaining({ event: "orphan-kill", pid: orphan.pid, start: orphan.start, path: orphan.dir, ok: true }));
		expect(JSON.stringify(events)).not.toContain("py54-inline-private-payload");
	});
}, 90000);

test.skipIf(!supported)("FD-linked orphan is positive; shared socket services and live registered users remain protected", async () => {
	await runtimeFixture(async fixture => {
		const fdOnly = await fixture.launch("fd-linked", { inline: true, fdOnly: true });
		const proof = eligible(fdOnly, fixture);
		expect(proof.linkage.some(link => link.kind === "fd" && link.path === join(fdOnly.dir, "linkage.data"))).toBe(true);
		expect(proof.linkage.some(link => link.kind === "cwd")).toBe(false);
		const unregisteredReader = openSync(join(fdOnly.dir, "linkage.data"), "r");
		try {
			expect(killOrphan(proof, fixture.deps)).toMatchObject({ ok: false, status: "preserved", reason: "other-process-using-scratch" });
			expect(probeIncarnationSync(fdOnly).state).toBe("live");
		} finally { closeSync(unregisteredReader); }
		const service = await fixture.launch("shared-service", { service: true });
		expect(inspectScratchOrphan(processRow(service), fixture.home, fixture.deps).status).not.toBe("eligible");
		const registration = await updateScratchUsers(fdOnly.dir, process.pid, "use", { home: fixture.home, liveness: fixture.deps.liveness });
		expect(registration.ok).toBe(true);
		expect(killOrphan(proof, fixture.deps)).toMatchObject({ ok: false, status: "preserved", reason: "registered-user-live-or-unknown" });
		expect(probeIncarnationSync(fdOnly).state).toBe("live");
		const unknownUser: ApplyDeps = { ...fixture.deps, liveness: { ...defaultLiveness(), probe: user => user.pid === process.pid
			? { state: "unknown", evidence: { pid: user.pid, recorded_start: user.start, observed_start: null, stat: null,
				signal0: null, reason: "planted unavailable registered-user observation" } } : probeIncarnationSync(user) } };
		expect(killOrphan(proof, unknownUser)).toMatchObject({ ok: false, reason: "registered-user-live-or-unknown" });
		expect((await updateScratchUsers(fdOnly.dir, process.pid, "unuse", { home: fixture.home, liveness: fixture.deps.liveness })).ok).toBe(true);
		// A fresh complete proof (not the pre-registration snapshot) authorizes the FD-only positive.
		expect(killOrphan(eligible(fdOnly, fixture), fixture.deps)).toMatchObject({ ok: true, status: "terminated" });
		expect(probeIncarnationSync(service).state).toBe("live");
	});
}, 90000);

test.skipIf(!supported)("unknown owner/seat/user state, reused incarnation and unavailable process metadata never authorize TERM", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("guards");
		const proof = eligible(child, fixture);
		const signals: string[] = [];
		const noSignal: ApplyDeps = { ...fixture.deps, kill: (_pid, signal) => { signals.push(signal); return true; } };
		expect(killOrphan({ ...proof, start: "Mon Jan 1 00:00:00 1900" }, noSignal)).toMatchObject({ ok: false, reason: "incarnation-reused" });
		const unknownOwner: ApplyDeps = { ...noSignal, liveness: { ...defaultLiveness(), probe: owner => ({ state: "unknown", evidence: {
			pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: null, reason: "planted unavailable owner observation" } }) } };
		expect(killOrphan(proof, unknownOwner)).toMatchObject({ ok: false, reason: "owner-unknown" });
		const failedRun: ScratchRunner = (args, options) => args[0] === "ps" && args.includes(String(child.pid))
			? { code: null, stdout: "", stderr: "planted metadata timeout" } : defaultRunner(args, options);
		expect(killOrphan(proof, { ...noSignal, run: failedRun }).ok).toBe(false);
		const foreignUidRun: ScratchRunner = (args, options) => {
			const out = defaultRunner(args, options);
			if (args[0] !== "ps" || !args.includes("uid=") || !args.includes(String(child.pid))) return out;
			const text = out.stdout.trimStart(), end = text.indexOf(" ");
			return end < 0 ? out : { ...out, stdout: `${(process.getuid?.() ?? 0) + 1}${text.slice(end)}` };
		};
		expect(killOrphan(proof, { ...noSignal, run: foreignUidRun })).toMatchObject({ ok: false, reason: "foreign-uid" });
		renameSync(join(child.dir, ".owner"), join(child.dir, "original-owner"));
		try { expect(killOrphan(proof, noSignal)).toMatchObject({ ok: false, reason: "owner-or-users-metadata-unproven" }); }
		finally { renameSync(join(child.dir, "original-owner"), join(child.dir, ".owner")); }
		writeFileSync(join(child.dir, ".users"), "malformed", { mode: 0o600 });
		expect(killOrphan(proof, noSignal)).toMatchObject({ ok: false, reason: "registered-user-live-or-unknown" });
		const seated = await fixture.launch("unknown-seat", { seat: true });
		const seatDeps: ApplyDeps = { ...noSignal, liveness: { ...defaultLiveness(), seatLive: () => null } };
		expect(inspectScratchOrphan(processRow(seated), fixture.home, seatDeps)).toMatchObject({ status: "preserved", reason: "owner-seat-live-or-unknown" });
		expect(signals).toEqual([]);
		expect(probeIncarnationSync(child).state).toBe("live");
		expect(probeIncarnationSync(seated).state).toBe("live");
	});
}, 90000);

test.skipIf(!supported)("replaced recognized root and busy users lock refuse the previously valid proof before TERM", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("root-race");
		const proof = eligible(child, fixture);
		const lock = await privateLock({ namespace: "scratch-users", path: child.dir }, { deadline_s: 0 });
		try { expect(killOrphan(proof, fixture.deps)).toMatchObject({ ok: false, reason: "users-lock-busy" }); }
		finally { lock.release(); }
		renameSync(fixture.root, `${fixture.root}.original`);
		mkdirSync(fixture.root, { mode: 0o700 });
		expect(killOrphan(proof, fixture.deps).ok).toBe(false);
		expect(probeIncarnationSync(child).state).toBe("live");
	});
}, 60000);

test.skipIf(!supported)("ownership metadata changed after real TERM vetoes escalation to KILL", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("kill-race", { ignoreTerm: true });
		const proof = eligible(child, fixture);
		const signals: string[] = [];
		const result = killOrphan(proof, { ...fixture.deps, kill: (pid, signal) => {
			signals.push(signal);
			process.kill(pid, signal);
			if (signal === "SIGTERM") writeFileSync(join(child.dir, ".users"), "metadata became unknown", { mode: 0o600 });
			return true;
		} });
		expect(result).toMatchObject({ ok: false, status: "preserved", reason: "registered-user-live-or-unknown" });
		expect(signals).toEqual(["SIGTERM"]);
		expect(probeIncarnationSync(child).state).toBe("live");
	});
}, 60000);

test.skipIf(!supported)("unchanged abandoned interpreter ignoring TERM is revalidated and actually exits after KILL", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("kill-positive", { ignoreTerm: true });
		const result = killOrphan(eligible(child, fixture), fixture.deps);
		expect(result).toMatchObject({ pid: child.pid, start: child.start, path: child.dir, ok: true, status: "terminated" });
		expect(isDead(probeIncarnationSync(child))).toBe(true);
	});
}, 60000);

test.skipIf(!supported)("Unicode scratch paths retain their real open-FD veto while ps keeps stable identity dates", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("unicode-owned", { inline: true });
		const descriptor = openSync(join(child.dir, "linkage.data"), "r");
		try {
			const result = applyScratch(fixture.home, fixture.deps);
			expect(existsSync(child.dir)).toBe(true);
			expect(probeIncarnationSync(child).state).toBe("live");
			expect(result.killed.some(row => row.pid === child.pid)).toBe(false);
			expect(result.orphanDecisions.find(row => row.pid === child.pid)).toMatchObject({
				status: "preserved", reason: "other-process-using-scratch",
			});
		} finally { closeSync(descriptor); }
	}, true);
}, 90000);

test.skipIf(!supported)("FIFO ownership metadata refuses promptly and a regular absent-users control remains eligible", async () => {
	await runtimeFixture(async fixture => {
		const child = await fixture.launch("fifo-users", { inline: true });
		const fifo = join(child.dir, ".users");
		const made = await run(["mkfifo", fifo], { deadline_s: 5, max_output_bytes: 4096 });
		expect(made.rc).toBe(0);
		const program = `
import { inspectScratchOrphan, listProcesses, defaultRunner, defaultLiveness } from ${JSON.stringify(scratchModule)};
const proc = listProcesses(defaultRunner).find(row => row.pid === ${child.pid});
if (proc === undefined) throw new Error("owned interpreter vanished");
const decision = inspectScratchOrphan(proc, ${JSON.stringify(fixture.home)}, {
  run: defaultRunner, liveness: defaultLiveness(), systemTempBases: [] });
console.log(JSON.stringify({ status: decision.status, reason: decision.reason }));
`;
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
		const refused = await run([process.execPath, "-e", program], { cwd: repo, env, deadline_s: 8, max_output_bytes: 8192 });
		expect(refused.timed_out).toBe(false);
		expect(refused.rc, new TextDecoder().decode(refused.stderr)).toBe(0);
		expect(JSON.parse(new TextDecoder().decode(refused.stdout))).toEqual({
			status: "refused", reason: "owner-or-users-metadata-unproven",
		});
		expect(probeIncarnationSync(child).state).toBe("live");
		unlinkSync(fifo);
		expect(eligible(child, fixture).pid).toBe(child.pid);
	});
}, 90000);
