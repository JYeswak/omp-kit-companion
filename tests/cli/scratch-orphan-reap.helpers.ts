// ompkit-xa5s.54 / PYGATE2 original AC d. Runtime proof, not a forged age/table/owner.
// Before this change, a new PPID1 Python interpreter is never selected (only old harness argv is);
// the old exported numeric killOrphan can also signal an unrelated current PID without ownership.
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScratch, defaultLiveness, defaultRunner, inspectScratchOrphan, listProcesses,
	type ApplyDeps, type OrphanProcess, type ScratchOrphanProof } from "../../src/scratch.ts";
import { isDead, probeIncarnationSync, type Incarnation } from "../../src/kitlib/proc.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

export const repo = resolve(import.meta.dir, "../..");
const fixtureParent = join(repo, "var", "agent-tmp");
const python = Bun.which("python3");
export const supported = (process.platform === "darwin" || process.platform === "linux") && python !== null && Bun.which("lsof") !== null;
export const scratchModule = join(repo, "src", "scratch.ts");
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

export function processRow(child: Interpreter): OrphanProcess {
	const row = listProcesses(defaultRunner).find(row => row.pid === child.pid);
	if (row === undefined) throw new Error(`fixture interpreter ${child.pid} vanished`);
	return row;
}

export function eligible(child: Interpreter, fixture: Fixture): ScratchOrphanProof {
	const decision = inspectScratchOrphan(processRow(child), fixture.home, fixture.deps);
	expect(decision.status, JSON.stringify(decision)).toBe("eligible");
	if (decision.proof === undefined) throw new Error(`no orphan proof: ${JSON.stringify(decision)}`);
	expect(decision.proof).toMatchObject({ pid: child.pid, start: child.start, dir: child.dir, ppid: 1, uid: process.getuid?.() });
	return decision.proof;
}

export async function runtimeFixture(body: (fixture: Fixture) => Promise<void>, unicode = false): Promise<void> {
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
