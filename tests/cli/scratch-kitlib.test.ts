// KITLIBREAP1 (ompkit-army3): `scratch plan` and `scratch apply` reclaim kitlib owned-temp leftovers in system temp
// (a SIGKILLed `ownedTmp`/`owned_tmp` creator), and leave every other system-temp entry untouched.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { applyScratch, defaultLiveness, defaultRunner, kitlibTmpProblem, planScratch, type ApplyDeps, type ScratchRunner } from "../../src/scratch.ts";

const repo = resolve(import.meta.dir, "../..");
const ENV_KEYS = ["TMPDIR", "OMP_KIT_SCRATCH_ROOTS", "XDG_STATE_HOME", "XDG_CONFIG_HOME"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let owned: OwnedTmp;
/** The system-temp stand-in: the only temp dir plan and apply scan. */
let temp: string;
let home: string;
let sleeper: Subprocess | null = null;
const killed: Subprocess[] = [];

// Real lsof is the open-file evidence; every other command (ps for harness orphans, br) answers "nothing", so apply
// never signals a process outside this test.
const run: ScratchRunner = (args, opts) => args[0] === "lsof" ? defaultRunner(args, opts) : { code: 1, stdout: "", stderr: "" };
const deps = (): ApplyDeps => ({ liveness: defaultLiveness(), run, home, systemTempBases: [temp] });

function deadPid(): number {
	for (let pid = 60000; pid > 1000; pid--) {
		try {
			process.kill(pid, 0);
			continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
			const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe", stderr: "ignore" });
			if (out.exitCode !== 0) return pid;
		}
	}
	throw new Error("no dead pid fixture");
}

/** A kitlib-shaped dir as `ownedTmp` leaves it (repo `/`, so only the kitlib rule can bind it), with overrides. */
function plant(name: string, owner: { pid: number; label: string }, parent = temp, dirMode = 0o700): string {
	const dir = join(parent, name);
	mkdirSync(dir, { mode: 0o700 });
	const processStart = owner.pid === process.pid ? defaultLiveness().processStart(owner.pid) : "Thu Jan  1 00:00:00 1970";
	if (processStart === null) throw new Error("process incarnation unavailable for kitlib fixture");
	writeFileSync(join(dir, ".owner"), `pid=${owner.pid}\nprocess_start=${processStart}\nlabel=${owner.label}\nrepo=/\ncreated_at=${new Date().toISOString()}\nargv0=test\n`, { mode: 0o600 });
	chmodSync(join(dir, ".owner"), 0o600);
	writeFileSync(join(dir, "payload"), "leftover\n");
	chmodSync(dir, dirMode);
	return dir;
}

async function firstLine(child: Subprocess<"ignore", "pipe", "inherit">): Promise<string> {
	const reader = child.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	return text.split("\n")[0]!.trim();
}

beforeAll(() => {
	owned = ownedTmp("scratch-kitlib-test");
	const base = realpathSync(owned.path);
	temp = join(base, "system-temp");
	home = join(base, "home");
	for (const dir of [temp, home, join(base, "roots"), join(base, "state"), join(base, "config")]) mkdirSync(dir, { mode: 0o700 });
	// No real scratch root and no real temp: the override names an empty owned dir, the stand-in is injected.
	process.env.OMP_KIT_SCRATCH_ROOTS = join(base, "roots");
	process.env.TMPDIR = temp;
	process.env.XDG_STATE_HOME = join(base, "state");
	process.env.XDG_CONFIG_HOME = join(base, "config");
});

afterAll(async () => {
	for (const child of [sleeper, ...killed]) {
		if (child === null) continue;
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	owned.cleanup();
});

test("AC1: a dead kitlib owner with no open files is reaped; mismatched directory suffix is not identity", async () => {
	const dead = deadPid();
	const reaped = plant(`ac1-dead.${dead}.a1b2c3`, { pid: dead, label: "ac1-dead" });
	const live = plant(`ctl-live.${process.pid}.l1v3aa`, { pid: process.pid, label: "ctl-live" });
	const held = plant(`ctl-open.${dead}.h3ld00`, { pid: dead, label: "ctl-open" });
	writeFileSync(join(held, "held"), "open\n");
	sleeper = Bun.spawn(["sh", "-c", "exec 3<\"$1\"; exec sleep 600", "sh", join(held, "held")], { stdout: "ignore", stderr: "ignore" });
	const renamed = plant(`ctl-pid.${dead}.p1d000`, { pid: process.pid, label: "ctl-pid" });
	const labelMismatch = plant(`ctl-label.${dead}.lab000`, { pid: dead, label: "someone-else" });
	const notKitlib = plant(`ctl-name.${dead}`, { pid: dead, label: "ctl-name" });
	const target = plant(`ctl-link.${dead}.s1m000`, { pid: dead, label: "ctl-link" }, home);
	const link = join(temp, `ctl-link.${dead}.s1m000`);
	symlinkSync(target, link);
	const loose = plant(`ctl-mode.${dead}.m0de00`, { pid: dead, label: "ctl-mode" }, temp, 0o755);

	// The sleeper holds the descriptor before the plan's lsof snapshot. Real lsof against a real process is the evidence
	// under test, so this polls that condition; no fake clock can stand in for another process opening a file.
	for (let attempt = 0; attempt < 100; attempt++) {
		const seen = defaultRunner(["lsof", "-nP", "-Fn", "-p", String(sleeper.pid)]);
		if (seen.stdout.includes(join(held, "held"))) break;
		await Bun.sleep(20);
	}

	// Structural owner/path checks do not use the numeric suffix as identity.
	expect(kitlibTmpProblem(reaped)).toBeNull();
	expect(kitlibTmpProblem(renamed)).toBeNull();
	expect(kitlibTmpProblem(labelMismatch)).toBe("kitlib-owner-label-mismatch");
	expect(kitlibTmpProblem(notKitlib)).toBe("kitlib-name-mismatch");
	expect(kitlibTmpProblem(link)).toBe("kitlib-dir-is-symlink");
	expect(kitlibTmpProblem(loose)).toBe("kitlib-dir-mode-not-0700");

	const plan = planScratch(home, deps());
	const row = (dir: string) => plan.sessions.find(session => session.dir === dir);
	expect(row(reaped)).toMatchObject({ action: "REAP", reason: "kitlib-owner-dead-no-open-fds" });
	expect(row(live)).toMatchObject({ action: "LIVE", reason: "kitlib-owner-alive" });
	expect(row(renamed)).toMatchObject({ action: "LIVE", reason: "kitlib-owner-alive" });
	expect(row(held)).toMatchObject({ action: "LIVE", reason: "kitlib-owner-dead-but-open-fds-present" });
	for (const refused of [labelMismatch, notKitlib, link, loose]) expect(row(refused)).toBeUndefined();
	expect(plan.sessions.every(session => session.dir.startsWith(`${temp}/`))).toBe(true);

	const applied = applyScratch(home, deps());
	expect(applied.applied.find(session => session.dir === reaped)).toMatchObject({ action: "REAP", reason: "kitlib-owner-dead-no-open-fds-applied" });
	expect(existsSync(reaped)).toBe(false);
	for (const kept of [live, held, renamed, labelMismatch, notKitlib, loose, target]) expect(existsSync(join(kept, ".owner"))).toBe(true);
	expect(lstatSync(link).isSymbolicLink()).toBe(true);
	expect(applied.applied.filter(session => session.action === "REAP").map(session => session.dir)).toEqual([reaped]);
}, 120_000);

test("AC2: SIGKILLed ownedTmp (bun) and owned_tmp (python3) creators are planned REAP and removed by apply", async () => {
	const env = { ...process.env, TMPDIR: temp, KITLIB_ROOT: temp };
	const tsChild = Bun.spawn(["bun", "-e",
		`import { ownedTmp } from ${JSON.stringify(join(repo, "src/kitlib/tmp.ts"))};` +
		`console.log(ownedTmp("ac2-ts", { root: process.env.KITLIB_ROOT }).path); setInterval(() => {}, 1_000_000);`],
	{ cwd: "/", env, stdout: "pipe", stderr: "inherit" });
	const pyChild = Bun.spawn(["python3", "-c",
		`import os, sys, time; sys.path.insert(0, ${JSON.stringify(join(repo, "scripts"))}); import kitlib_tmp; ` +
		`print(kitlib_tmp.owned_tmp("ac2-py", root=os.environ["KITLIB_ROOT"]).path, flush=True); time.sleep(600)`],
	{ cwd: "/", env, stdout: "pipe", stderr: "inherit" });
	killed.push(tsChild, pyChild);
	const tsDir = await firstLine(tsChild);
	const pyDir = await firstLine(pyChild);
	for (const [dir, label, child] of [[tsDir, "ac2-ts", tsChild], [pyDir, "ac2-py", pyChild]] as const) {
		expect(dirname(dir)).toBe(temp);
		expect(basename(dir)).toMatch(new RegExp(`^${label}\\.${child.pid}\\.[a-z0-9]{6}$`));
	}

	// While the creators live, their dirs stay.
	const before = planScratch(home, deps());
	for (const dir of [tsDir, pyDir]) expect(before.sessions.find(session => session.dir === dir)?.action).toBe("LIVE");

	tsChild.kill("SIGKILL");
	pyChild.kill("SIGKILL");
	expect(await tsChild.exited).not.toBe(0);
	expect(await pyChild.exited).not.toBe(0);
	expect(tsChild.signalCode).toBe("SIGKILL");
	expect(pyChild.signalCode).toBe("SIGKILL");
	expect(existsSync(join(tsDir, ".owner"))).toBe(true);
	expect(existsSync(join(pyDir, ".owner"))).toBe(true);

	const plan = planScratch(home, deps());
	for (const dir of [tsDir, pyDir]) {
		expect(plan.sessions.find(session => session.dir === dir)).toMatchObject({ action: "REAP", reason: "kitlib-owner-dead-no-open-fds" });
	}
	const applied = applyScratch(home, deps());
	for (const dir of [tsDir, pyDir]) {
		expect(applied.applied.find(session => session.dir === dir)).toMatchObject({ action: "REAP", reason: "kitlib-owner-dead-no-open-fds-applied" });
		expect(existsSync(dir)).toBe(false);
	}
}, 120_000);
