import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run } from "../../src/kitlib/run";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";

// Integration test: exercises real SIGTERM delivery and child reaping against
// the platform clock. Fake timers cannot work: the waits synchronize with a
// live subprocess, not in-process timers.

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Pids whose ancestor chain reaches root, via ps. -ax is required: bare ps
 * only lists the caller's session, which never contains piped children, so
 * without it this walk always returns [] and the reap check passes vacuously. */
async function descendants(root: number): Promise<number[]> {
	const child = Bun.spawnSync(["ps", "-ax", "-o", "pid=", "-o", "ppid="], { stdout: "pipe", stderr: "pipe" });
	const edges = new Map<number, number>();
	for (const line of child.stdout.toString().split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		edges.set(Number(parts[0]), Number(parts[1]));
	}
	const marked = new Set<number>([root]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, ppid] of edges) {
			if (!marked.has(pid) && marked.has(ppid)) {
				marked.add(pid);
				changed = true;
			}
		}
	}
	marked.delete(root);
	return [...marked];
}

async function alive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("SIGTERM stops e2e-live within 10 s with no surviving children", async () => {
	const child = Bun.spawn(["sh", "scripts/e2e-live.sh"], {
		cwd: REPO_ROOT,
		env: { ...process.env, OMP_KIT_E2E_JOBS: "4", ONLY: "canary-fire canary-near pipe-exit-fire pipe-exit-near glob-silenced-fire glob-silenced-near" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.pid === undefined) throw new Error("e2e-live did not start");
	// Gate TERM on a started marker the script prints to stderr (unbuffered, so
	// it arrives in real time; stdout is block-buffered and would arrive late),
	// never on a fixed delay: the marker proves an OMP run is live, so the trap
	// path is always exercised. One pump per stream consumes both end to end so
	// post-TERM output can never block a pipe; the wait resolves on the marker
	// or on early exit.
	const decoder = new TextDecoder();
	let out = "";
	let err = "";
	let started = false;
	let exitedCode: number | null = null;
	const { promise: markerSeen, resolve: markStarted } = Promise.withResolvers<void>();
	const pumpOut = (async () => {
		for await (const chunk of child.stdout) out += decoder.decode(chunk, { stream: true });
	})();
	const pumpErr = (async () => {
		for await (const chunk of child.stderr) {
			err += decoder.decode(chunk, { stream: true });
			// First turn seeds natives; terminate only after the parallel workers start.
			if (!started && [...err.matchAll(/e2e-live: started scenario=\S+ omp_pid=\d+/g)].length >= 5) {
				started = true;
				markStarted();
			}
		}
	})();
	const exitSeen = child.exited.then(code => { exitedCode = code ?? 1; });
	while (!started && exitedCode === null) await Promise.race([markerSeen, exitSeen]);
	if (!started) {
		throw new Error(`e2e-live never started a scenario (exited=${exitedCode}):\n${err.slice(-2000)}`);
	}
	let observed = await descendants(child.pid);
	expect(observed.length).toBeGreaterThan(0);
	const termAt = Date.now();
	child.kill(15);
	const code = await child.exited;
	await pumpOut;
	await pumpErr;
	const elapsedMs = Date.now() - termAt;
	const stderr = err;
	expect(code).toBe(143);
	expect(elapsedMs).toBeLessThan(10_000);
	expect(stderr).toContain("e2e-live: stopped on signal, exit 143");
	for (let i = 0; i < 50 && observed.some(pid => true); i++) {
		const states = await Promise.all(observed.map(pid => alive(pid)));
		observed = observed.filter((_, index) => states[index]);
		if (observed.length === 0) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	expect(observed).toEqual([]);
}, 300_000);

test("lingering scenario child is reaped and the tree removes cleanly", async () => {
	// fp72.48 planted negative: a stub OMP detaches a writer into the
	// scenario dir and exits at once. Only a session-group reap kills it;
	// without one the writer survives the suite and a later tree removal
	// races live writes (native Errno 66 masking a 900 s timeout).
	// Integration test: exercises real child reaping against the platform
	// clock. Fake timers cannot work: process death is observed through
	// kill(2), not in-process timers.
	const stubDir = ownedTmp("e2e-stub").path;
	const stub = join(stubDir, "stub-omp.sh");
	writeFileSync(stub, [
		"#!/bin/sh",
		"# Daemon-shaped: the writer detaches with closed stdio (like the CI",
		"# orphan), so only its file writes -- not held pipes -- can wedge the run.",
		"# The --version probe answers quietly: it runs with the repo cwd, and a",
		"# writer there would pollute the checkout instead of the work tree.",
		'if [ "$1" = "--version" ]; then echo "stub-omp 0.0.0"; exit 0; fi',
		'echo started >> "$PWD/lingering.txt"',
		'(while true; do echo tick >> "$PWD/lingering.txt"; sleep 1; done) </dev/null >/dev/null 2>&1 &',
		'echo $! > "$STUB_OUT/writer.pid"',
		"exit 0",
		""].join("\n"));
	chmodSync(stub, 0o755);
	const child = Bun.spawn(["sh", "scripts/e2e-live.sh"], {
		cwd: REPO_ROOT,
		env: { ...process.env, OMP: stub, STUB_OUT: stubDir, ONLY: "canary-near",
			TIMEOUT: "60", KEEP: "1", OMP_KIT_TEST_NO_COVERAGE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const decoder = new TextDecoder();
	let out = "";
	let err = "";
	const pumpOut = (async () => {
		for await (const chunk of child.stdout) out += decoder.decode(chunk, { stream: true });
	})();
	const pumpErr = (async () => {
		for await (const chunk of child.stderr) err += decoder.decode(chunk, { stream: true });
	})();
	await child.exited;
	await pumpOut;
	await pumpErr;
	const kept = /kept private e2e output: (\S+) \(work root (\S+)\)/.exec(`${out}\n${err}`);
	const pidText = readFileSync(join(stubDir, "writer.pid"), "utf8").trim();
	const writer = Number(pidText);
	if (!Number.isInteger(writer) || writer <= 0) throw new Error(`stub wrote no writer pid: ${pidText}`);
	const sleep = (ms: number) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	};
	let dead = false;
	for (let i = 0; i < 100; i++) {
		if (!await alive(writer)) { dead = true; break; }
		await sleep(100);
	}
	expect(dead).toBe(true);
	const tree = kept[1];
	const projs = readdirSync(tree).filter(name => name.startsWith("proj-"));
	expect(projs.length).toBeGreaterThan(0);
	expect(existsSync(join(tree, projs[0], "lingering.txt"))).toBe(true);
	rmSync(kept[2], { recursive: true, force: true });
	expect(existsSync(kept[2])).toBe(false);
	rmSync(stubDir, { recursive: true, force: true });
}, 300_000);

test("parallel live cases retain ordered reports, private models and read-only native bytes", async () => {
	const fixture = ownedTmp("e2e-pool");
	const reportPath = join(fixture.path, "cases.jsonl");
	const names = ["standing-law-system", "canary-fire", "canary-near", "unsafe-router-fire", "unsafe-router-near"];
	try {
		const env = Object.fromEntries(Object.entries({
			...process.env, OMP_KIT_E2E_JOBS: "4", ONLY: names.join(" "), KEEP: "1",
			OMP_KIT_TEST_WORK_ROOT: fixture.path, OMP_KIT_CASE_CWD: REPO_ROOT,
			OMP_KIT_TEST_CASE_REPORT: reportPath, OMP_KIT_TEST_CASE_SCOPE: "e2e-live",
		}).filter((entry): entry is [string, string] => entry[1] !== undefined));
		const result = await run(["sh", "scripts/e2e-live.sh"], { cwd: REPO_ROOT, env, deadline_s: 120 });
		const stdout = Buffer.from(result.stdout).toString(), stderr = Buffer.from(result.stderr).toString();
		expect(result.rc, stdout + stderr).toBe(0);
		expect(stdout.split("\n").filter(line => line.startsWith("ok    ")).map(line => line.slice(6))).toEqual(names);
		const kept = /kept private e2e output: (\S+) \(work root (\S+)\)/.exec(stdout);
		expect(kept).not.toBeNull();
		const tree = kept![1]!;
		const models = names.map((_, index) => readFileSync(join(tree, `home-${index}`, ".omp/agent/models.yml"), "utf8"));
		expect(new Set(models).size).toBe(names.length);
		const rows = readFileSync(reportPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(rows.filter(row => row.event === "case").map(row => row.name)).toEqual([...names, "launchd-isolation", "mock-server-cleanup"]);
		expect(rows.at(-1)).toMatchObject({ event: "end", cases: names.length + 2 });
		const nativeRoot = join(tree, "home-1/.omp/natives");
		if (existsSync(nativeRoot)) {
			const versions = readdirSync(nativeRoot);
			const binding = readdirSync(join(nativeRoot, versions[0]!)).find(name => name.endsWith(".node"))!;
			const first = statSync(join(nativeRoot, versions[0]!, binding));
			const next = statSync(join(tree, "home-2/.omp/natives", versions[0]!, binding));
			expect(first.ino).toBe(next.ino);
			expect(first.mode & 0o222).toBe(0);
		}
		const firstCache = join(tree, "home-1/.cache/bun");
		if (existsSync(firstCache)) {
			for (const group of readdirSync(firstCache)) {
				for (const file of readdirSync(join(firstCache, group)).filter(name => name.endsWith(".pile"))) {
					const first = join(firstCache, group, file);
					const next = join(tree, "home-2/.cache/bun", group, file);
					if (!existsSync(next)) continue;
					expect(statSync(first).ino).not.toBe(statSync(next).ino);
					expect(readFileSync(first)).toEqual(readFileSync(next));
				}
			}
		}
		rmSync(kept![2]!, { recursive: true, force: true });
	} finally { fixture.cleanup(); }
}, 180_000);

test("LIVEEVAL1: a failing scenario's transcript is copied into OMP_KIT_E2E_EVIDENCE_DIR and its FAIL line names the copy", async () => {
	// Planted failure: a stub OMP sends one tool-bearing request to the scenario's mock model, so the mock writes a
	// one-request transcript and the verdict fails (it wants >= 2 requests). The work root is then deleted, as the
	// ci-only export is; only the evidence copy may survive. A mutant that skips the copy leaves no evidence file.
	const fixture = ownedTmp("e2e-evidence");
	try {
		const evidenceRoot = join(fixture.path, "evidence");
		mkdirSync(evidenceRoot, { mode: 0o700 });
		const stub = join(fixture.path, "stub-omp.sh");
		writeFileSync(stub, [
			"#!/bin/sh",
			'if [ "$1" = "--version" ]; then echo "stub-omp 0.0.0"; exit 0; fi',
			"port=$(sed -n 's#.*baseUrl: http://127.0.0.1:\\([0-9]*\\)/v1#\\1#p' \"$HOME/.omp/agent/models.yml\")",
			'curl -sS -o /dev/null -X POST -H "content-type: application/json" "http://127.0.0.1:$port/v1/chat/completions" \\',
			"  -d '{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"bash\"}}],\"messages\":[{\"role\":\"user\",\"content\":\"LIVEEVAL1 planted transcript\"}]}'",
			"",
		].join("\n"));
		chmodSync(stub, 0o755);
		const env = Object.fromEntries(Object.entries({
			...process.env, OMP: stub, ONLY: "canary-near", TIMEOUT: "60", OMP_KIT_TEST_NO_COVERAGE: "1",
			OMP_KIT_TEST_WORK_ROOT: fixture.path, OMP_KIT_CASE_CWD: REPO_ROOT, OMP_KIT_E2E_EVIDENCE_DIR: evidenceRoot,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined));
		const result = await run(["sh", "scripts/e2e-live.sh"], { cwd: REPO_ROOT, env, deadline_s: fixtureDeadlineS(150) });
		const stdout = Buffer.from(result.stdout).toString(), stderr = Buffer.from(result.stderr).toString();
		expect(result.rc, stdout + stderr).toBe(1);
		const failure = /^FAIL {2}canary-near :: .*transcript: (\S+)\)$/m.exec(stdout);
		expect(failure, stdout + stderr).not.toBeNull();
		const copy = failure![1]!;
		const runDir = /^failure evidence kept: (\S+)$/m.exec(stdout)?.[1];
		expect(runDir).toBe(join(evidenceRoot, readdirSync(evidenceRoot)[0]!));
		expect(copy).toBe(join(runDir!, "log-canary-near.jsonl"));
		const kept = /kept private e2e output: (\S+) \(work root (\S+)\)/.exec(stdout);
		expect(kept, stdout).not.toBeNull();
		const original = readFileSync(join(kept![1]!, "log-canary-near.jsonl"));
		rmSync(kept![2]!, { recursive: true, force: true });
		expect(readFileSync(copy)).toEqual(original);
		expect(original.toString()).toContain("LIVEEVAL1 planted transcript");
		expect(readdirSync(runDir!).sort()).toEqual(["log-canary-near.jsonl", "mock-canary-near.txt", "out-canary-near.txt"]);
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

const realPython3 = Bun.which("python3", { PATH: process.env.PATH ?? "" });
test.skipIf(!realPython3)("LIVEEVAL1: a python3 that stalls past OMP's probe budget still leaves the eval tool a pinned working interpreter", async () => {
	// Planted: a `python` and `python3` that stall 12 s before starting (OMP probes every PATH python under one 10 s
	// budget; a cold macOS xcrun shim took up to 9.9 s) sit first on PATH. e2e-live must still pin the interpreter
	// python3 launches as python.interpreter in the isolated config, and real OMP's own Python availability check
	// (`omp setup python --json`, the probe eval uses) must accept it. Mutant: the same config without that pin fails
	// the check, which is eval's "Python backend is unavailable". Control: with a fast python3 the pin is that
	// interpreter and the unpinned check still passes. No model is called: a stub OMP ends each scenario at once, and
	// plant mode skips packaging a kit candidate; only the base isolated HOME is read.
	const fixture = ownedTmp("e2e-python-pin");
	try {
		const omp = resolveOmpIdentity(process.env).launcher;
		const stub = join(fixture.path, "stub-omp.sh");
		writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "stub-omp 0.0.0"; fi\nexit 0\n');
		chmodSync(stub, 0o755);
		const slow = join(fixture.path, "slow-bin");
		mkdirSync(slow);
		for (const name of ["python", "python3"]) {
			writeFileSync(join(slow, name), `#!/bin/sh\nsleep 12\nexec ${JSON.stringify(realPython3)} "$@"\n`);
			chmodSync(join(slow, name), 0o755);
		}
		const harness = async (path: string) => {
			const env = Object.fromEntries(Object.entries({ ...process.env, OMP: stub, PATH: path, TIMEOUT: "60",
				OMP_KIT_TEST_WORK_ROOT: fixture.path, OMP_KIT_CASE_CWD: REPO_ROOT,
			}).filter((entry): entry is [string, string] => entry[1] !== undefined));
			const result = await run(["sh", "scripts/e2e-live.sh", "--plant"], { cwd: REPO_ROOT, env, deadline_s: fixtureDeadlineS(120) });
			const stdout = Buffer.from(result.stdout).toString(), stderr = Buffer.from(result.stderr).toString();
			const kept = /kept private e2e output: (\S+) \(work root (\S+)\)/.exec(stdout);
			expect(kept, stdout + stderr).not.toBeNull();
			const pin = /^python: (\S+) \(python\.interpreter\)$/m.exec(stdout)?.[1];
			expect(pin, stdout + stderr).toBeDefined();
			const config = readFileSync(join(kept![1]!, "home", ".omp", "agent", "config.yml"), "utf8");
			rmSync(kept![2]!, { recursive: true, force: true });
			return { pin: pin!, config };
		};
		const check = async (path: string, config: string, label: string) => {
			const home = join(fixture.path, `home-${label}`);
			mkdirSync(join(home, ".omp", "agent"), { recursive: true });
			mkdirSync(join(home, "tmp"));
			writeFileSync(join(home, ".omp", "agent", "config.yml"), config);
			const result = await run([omp, "setup", "python", "--json"], { cwd: home, deadline_s: fixtureDeadlineS(60),
				env: { PATH: path, HOME: home, TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, ".config"),
					XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") } });
			const stdout = Buffer.from(result.stdout).toString();
			return { rc: result.rc, report: JSON.parse(stdout) as { available: boolean; pythonPath?: string } };
		};
		const unpin = (config: string) => config.replace(/^python:\n {2}interpreter: .*\n/m, "");
		const fastPath = process.env.PATH ?? "", slowPath = `${slow}:${fastPath}`;
		const planted = await harness(slowPath);
		expect(planted.pin.startsWith(slow)).toBe(false);
		expect(planted.config).toContain(`python:\n  interpreter: ${JSON.stringify(planted.pin)}\n`);
		expect(await check(slowPath, planted.config, "planted")).toEqual({ rc: 0, report: expect.objectContaining({ available: true, pythonPath: planted.pin }) });
		const mutant = await check(slowPath, unpin(planted.config), "mutant");
		expect(unpin(planted.config)).not.toContain("interpreter:");
		expect(mutant.rc).toBe(1);
		expect(mutant.report.available).toBe(false);
		expect(mutant.report.pythonPath?.startsWith(slow)).toBe(true);
		const control = await harness(fastPath);
		expect(control.pin).toBe(planted.pin);
		expect(unpin(control.config)).toBe(unpin(planted.config));
		expect((await check(fastPath, control.config, "control")).report).toMatchObject({ available: true, pythonPath: control.pin });
		expect((await check(fastPath, unpin(control.config), "control-unpinned")).report.available).toBe(true);
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(300) * 1000);

afterAll(() => cleanupAllOwnedTmp());
