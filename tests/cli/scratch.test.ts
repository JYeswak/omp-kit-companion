import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { applyQuarantineExpiry, applyReap, applyScratch, applyUnowned, createScratch, defaultLiveness, defaultRunner, fleetTestTmpBase, inspectOne, inspectSession, isApplyFailure, isHarnessServer, killOrphan, lsofClear, parseEtime, parseOwnerFile, parsePsStart, planScratch, probeOwner, quarantineDir, quarantineEntryFor, quarantineTimeOf, reapLogPath, releaseScratch, resolveScratchRoots, reuseAfterCreated, selectHarnessOrphans, snapshotClear, summarizeScratch, takeLsofSnapshot, UNOWNED_ACTIVE_RULE, type ApplyDeps, type InspectDeps } from "../../src/scratch.ts";
import { measureScratchTree, readScratchSizeSnapshot } from "../../src/scratch.ts";

const roots: string[] = [];
const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
const savedState = process.env.XDG_STATE_HOME;
const savedTmp = process.env.TMPDIR;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
  else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
});

/** Isolated state dir for in-process apply tests (which append JSONL to XDG state). */
function useState(): string {
  const state = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-xdg-"));
  roots.push(state);
  process.env.XDG_STATE_HOME = state;
  return state;
}

const HAVE_LSOF = Bun.which("lsof") !== null;
const clearRun = () => ({ code: 1, stdout: "", stderr: "" });
const depsFor = (overrides: Partial<InspectDeps> = {}): InspectDeps => ({
  liveness: defaultLiveness(), run: clearRun, ...overrides,
});

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

function ownerText(fields: Record<string, string>): string {
  return `${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function liveFields(label: string): Record<string, string> {
  const start = defaultLiveness().processStart(process.pid);
  if (start === null) throw new Error("process identity unavailable");
  return { pid: String(process.pid), process_start: start, label, repo: "test", created_at: "2026-10-01T00:00:00Z", argv0: "test" };
}

function deadFields(label: string, pid: number): Record<string, string> {
  return { pid: String(pid), process_start: "Thu Jan  1 00:00:00 1970", label, repo: "test", created_at: "2026-10-01T00:00:00Z", argv0: "test" };
}

function sessionDir(root: string, label: string, pid: number | string): string {
  const dir = join(root, `${label}.${pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function backdateTree(dir: string, ageMs: number, now: number): void {
  const past = new Date(now - ageMs);
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
      utimesSync(path, past, past);
    }
  }
  utimesSync(dir, past, past);
}

test("modern and fleet-guard owner files parse strictly", () => {
  const good = ownerText(liveFields("a"));
  expect(parseOwnerFile(good)?.label).toBe("a");
  expect(parseOwnerFile("pid=42\nlabel=omp\nrepo=/repo\ncreated=2026-10-01T00:00:00Z\n"))
    .toMatchObject({ pid: 42, processStart: null, label: "omp", repo: "/repo", createdAt: "2026-10-01T00:00:00Z", argv0: null });
  expect(parseOwnerFile(`${good}pid=2\n`)).toBeNull();
  expect(parseOwnerFile(`${good}owner=x\n`)).toBeNull();
  expect(parseOwnerFile(good.replace("label=a", "label="))).toBeNull();
  expect(parseOwnerFile(good.replace(/pid=\d+/, "pid=0"))).toBeNull();
  expect(parseOwnerFile(good.replace(/pid=\d+/, "pid=abc"))).toBeNull();
  expect(parseOwnerFile(good.replace(/pid=\d+/, "pid=1234567"))).toBeNull();
  expect(parseOwnerFile("owner=x\npurpose=y\ncreated=z\n")).toBeNull();
  expect(parseOwnerFile(good.split("\n").slice(0, 5).join("\n"))).toBeNull();
});

test("releaseScratch refuses a reused owner PID before marking release", () => {
  const { home } = cliHome();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-reused-pid-"));
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const dir = sessionDir(root, "omp", process.pid);
  writeFileSync(join(dir, ".owner"), ownerText({
    pid: String(process.pid), process_start: "stale-process-start", label: "omp", repo: home,
    created_at: new Date().toISOString(), argv0: "test",
  }));
  const result = releaseScratch(dir, home, depsFor({
    liveness: { signalAlive: () => true, psVisible: () => true, processStart: () => "current-process-start" },
  }));
  expect(result).toMatchObject({ ok: false, changed: false, reason: "owner-process-reused", ownerPid: process.pid });
  expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
});

test("probeOwner maps live, reused, dead, unreachable and unknown", () => {
  const live = { signalAlive: () => true, psVisible: () => true, processStart: () => "S" };
  expect(probeOwner(1, "S", live)).toBe("live");
  expect(probeOwner(1, "other", live)).toBe("reused");
  expect(probeOwner(1, "S", { ...live, processStart: () => null })).toBe("unknown");
  const dead = { signalAlive: () => false, psVisible: () => false, processStart: () => "S" };
  expect(probeOwner(1, "S", dead)).toBe("dead");
  expect(probeOwner(1, "S", { ...dead, psVisible: () => true })).toBe("live-unreachable");
});

test("lsof maps empty to clear, output to open, diagnostics and missing binary to unavailable", () => {
  expect(lsofClear("/x", clearRun)).toBe(true);
  expect(lsofClear("/x", () => ({ code: 0, stdout: "sh 123 foo /x/bar", stderr: "" }))).toBe(false);
  expect(lsofClear("/x", () => ({ code: 1, stdout: "", stderr: "lsof: WARNING something" }))).toBeNull();
  expect(lsofClear("/x", () => { throw new Error("spawn ENOENT"); })).toBeNull();
});

test("etime and harness patterns parse the ps table", () => {
  expect(parseEtime("00:02")).toBe(2);
  expect(parseEtime("01:02:03")).toBe(3723);
  expect(parseEtime("2-03:04:05")).toBe(183845);
  expect(parseEtime("bogus")).toBeNull();
  expect(isHarnessServer("/k/mock-model.mjs --port 1")).toBe(true);
  expect(isHarnessServer("/k/external-live.mjs")).toBe(true);
  expect(isHarnessServer("/usr/bin/sleep 60")).toBe(false);
  const rows = [
    { pid: 11, ppid: 1, ageSeconds: 7200, command: "bun /k/mock-model.mjs" },
    { pid: 12, ppid: 1, ageSeconds: 60, command: "bun /k/mock-model.mjs" },
    { pid: 13, ppid: 500, ageSeconds: 7200, command: "bun /k/mock-model.mjs" },
    { pid: 14, ppid: 1, ageSeconds: 7200, command: "sleep 60" },
  ];
  expect(selectHarnessOrphans(rows).map(row => row.pid)).toEqual([11]);
});

test("quarantine entry names round-trip their timestamp", () => {
  const at = new Date("2026-09-20T10:00:00.000Z");
  const entry = quarantineEntryFor("lane.123", at);
  expect(entry.startsWith("lane.123.q-")).toBe(true);
  expect(quarantineTimeOf(entry)).toBe(at.getTime());
  expect(quarantineTimeOf("lane.123")).toBeNull();
});

test("inspect keeps live owners, reaps dead ones, and skips missing or legacy owners", () => {
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const live = sessionDir(root, "live", process.pid);
  writeFileSync(join(live, ".owner"), ownerText(liveFields("live")));
  const dead = sessionDir(root, "dead", deadPid());
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("dead", Number(dead.split(".").at(-1)))));
  const naked = join(root, "naked.1");
  mkdirSync(naked, { recursive: true });
  const legacy = join(root, "legacy.2");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, ".owner"), "owner=X\npurpose=y\ncreated=z\n");
  const deps = depsFor();
  expect(inspectSession(live, root, deps).action).toBe("LIVE");
  expect(inspectSession(dead, root, deps).action).toBe("REAP");
  expect(inspectSession(naked, root, deps).reason).toBe("no-owner-file");
  expect(inspectSession(legacy, root, deps).reason).toBe("malformed-owner-file");
});
test("one-line owner files: dead owner reaps with real size, live owner stays live", () => {
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const gone = deadPid();
  const dead = sessionDir(root, "suite-snap", gone);
  const deadOwner = `pid=${gone} label=suite-snap repo=test created=2026-10-01T00:00:00Z\n`;
  writeFileSync(join(dead, ".owner"), deadOwner);
  const payload = "x".repeat(1024);
  writeFileSync(join(dead, "payload"), payload);
  const live = sessionDir(root, "suite-snap", process.pid);
  writeFileSync(join(live, ".owner"), `pid=${process.pid} label=suite-snap repo=test created=${new Date().toISOString()}\n`);
  const deps = depsFor();
  const deadVerdict = inspectSession(dead, root, deps);
  expect(deadVerdict.action).toBe("REAP");
  expect(deadVerdict.reason).toBe("owner-dead-no-open-fds");
  expect(deadVerdict.sizeBytes).toBe(payload.length + Buffer.byteLength(deadOwner));
  expect(inspectSession(live, root, deps).action).toBe("LIVE");
});
test("nested integrations work dirs reap on dead pid and stay live on live pid", () => {
  const home = useState();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const session = join(root, "session-1");
  mkdirSync(session, { recursive: true });
  const gone = deadPid();
  const dead = join(session, `omp-kit-integrations-${gone}-abc`);
  mkdirSync(dead, { recursive: true });
  writeFileSync(join(dead, ".owner"), `pid=${gone} label=omp-kit-integrations repo=test created=2026-10-01T00:00:00Z\n`);
  const live = join(session, `omp-kit-integrations-${process.pid}-def`);
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, ".owner"), `pid=${process.pid} label=omp-kit-integrations repo=test created=${new Date().toISOString()}\n`);
  const plan = planScratch(home, depsFor());
  expect(plan.sessions.find(session => session.dir === dead)?.action).toBe("REAP");
  expect(plan.sessions.find(session => session.dir === live)?.action).toBe("LIVE");
  const nestedWork = join(session, "omp-kit-work.xyz");
  mkdirSync(nestedWork, { recursive: true });
  writeFileSync(join(nestedWork, ".owner"), `pid=${gone} label=omp-kit-work repo=test created=2026-10-01T00:00:00Z\n`);
  const plan2 = planScratch(home, depsFor());
  expect(plan2.sessions.find(session => session.dir === nestedWork)?.action).toBe("REAP");
});
test("runtime omp-kit-work dirs with dead owners are reaped from system temp", () => {
	const home = useState();
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "runtime-work-root-"));
	roots.push(root);
	delete process.env.OMP_KIT_SCRATCH_ROOTS;
	process.env.TMPDIR = root;
	const work = join(root, "omp-kit-work.dead");
	mkdirSync(work, { recursive: true });
	const dead = deadPid();
	writeFileSync(join(work, ".owner"), ownerText({ pid: String(dead), process_start: "Thu Jan  1 00:00:00 1970", label: "omp-kit-work", repo: "test", created_at: "2026-10-01T00:00:00Z", argv0: "runtime-adapter" }));
	writeFileSync(join(work, "payload"), "runtime work\n");
	const deps: ApplyDeps = { ...depsFor(), home };
	const plan = planScratch(home, deps);
	expect(plan.sessions.find(session => session.dir === work)?.action).toBe("REAP");
	const applied = applyScratch(home, deps);
	expect(applied.applied.find(session => session.dir === work)?.action).toBe("REAP");
	expect(existsSync(work)).toBe(false);
});

test("runtime adapter TERM leaves its workdir for no later reaper", async () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "runtime-term-root-"));
	roots.push(root);
	const adapter = resolve(import.meta.dir, "../../scripts/runtime-adapter.sh");
	const child = Bun.spawn(["sh", "-c", "work=$(TMPDIR=\"$1\" \"$2\" --workdir) || exit 1; trap 'rm -rf \"$work\"; exit 143' TERM INT EXIT; printf '%s' \"$work\" > \"$1/workdir\"; kill -TERM $$", "runtime-term", root, adapter], { stdout: "ignore", stderr: "ignore" });
	for (let attempt = 0; attempt < 100 && !existsSync(join(root, "workdir")); attempt++) await Bun.sleep(10);
	expect(existsSync(join(root, "workdir"))).toBe(true);
	await child.exited;
	const workdir = readFileSync(join(root, "workdir"), "utf8");
	expect(existsSync(workdir)).toBe(false);
}, 30_000);
test("inspect refuses a dead owner with open descriptors and a name that mismatches", () => {
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const open = sessionDir(root, "open", deadPid());
  writeFileSync(join(open, ".owner"), ownerText(deadFields("open", Number(open.split(".").at(-1)))));
  writeFileSync(join(open, "held"), "x\n");
  const openRun = () => ({ code: 0, stdout: `sh 999 ${join(open, "held")}`, stderr: "" });
  expect(inspectSession(open, root, depsFor({ run: openRun })).reason).toBe("owner-dead-but-open-fds-present");
  const wrong = join(root, "renamed.3");
  mkdirSync(wrong, { recursive: true });
  writeFileSync(join(wrong, ".owner"), ownerText(deadFields("else", deadPid())));
  expect(inspectSession(wrong, root, depsFor()).reason).toBe("session-name-owner-mismatch");
});

test.skipIf(!HAVE_LSOF)("a real open descriptor blocks a real lsof reap", () => {
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const open = sessionDir(root, "realopen", deadPid());
  writeFileSync(join(open, ".owner"), ownerText(deadFields("realopen", Number(open.split(".").at(-1)))));
  writeFileSync(join(open, "held"), "x\n");
  const fd = openSync(join(open, "held"), "r");
  try {
    const verdict = inspectSession(open, root, depsFor({ run: defaultRunner }));
    expect(verdict.action).toBe("LIVE");
  } finally {
    closeSync(fd);
  }
});

test("apply removes a proven-dead session after quarantine and restores on an owner race", () => {
  const home = useState();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const deps: ApplyDeps = { ...depsFor(), home };
  const dead = sessionDir(root, "gone", deadPid());
  const pid = Number(dead.split(".").at(-1));
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", pid)));
  writeFileSync(join(dead, "data"), "dead\n");
  const verdict = inspectSession(dead, root, deps);
  expect(verdict.action).toBe("REAP");
  const applied = applyReap(dead, root, verdict, deps);
  expect(applied.action).toBe("REAP");
  expect(existsSync(dead)).toBe(false);
  const raced = sessionDir(root, "raced", deadPid());
  const rpid = Number(raced.split(".").at(-1));
  writeFileSync(join(raced, ".owner"), ownerText(deadFields("raced", rpid)));
  const rverdict = inspectSession(raced, root, deps);
  expect(rverdict.action).toBe("REAP");
  writeFileSync(join(raced, ".owner"), ownerText(deadFields("raced2", deadPid())));
  const restored = applyReap(raced, root, rverdict, deps);
  expect(restored.action).toBe("SKIP");
  expect(restored.reason).toBe("final-recheck-refused");
  expect(existsSync(raced)).toBe(true);
  expect(restored.status).toBe("REFUSED");
  expect(isApplyFailure(restored)).toBe(false);
  const refusals = readFileSync(reapLogPath(home), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.event === "refused");
  expect(refusals.some(row => row.dir === raced && row.reason === "final-recheck-refused")).toBe(true);
});

test("apply quarantines idle unowned dirs and deletes expired quarantine after rechecks", () => {
  const home = useState();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const now = Date.now();
  const deps: ApplyDeps = { ...depsFor(), home, now };
  const old = join(root, "stale.9");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "data"), "stale\n");
  backdateTree(old, 73 * 3600 * 1000, now);
  const moved = applyUnowned(old, root, deps);
  expect(moved.action).toBe("QUARANTINE");
  expect(existsSync(old)).toBe(false);
  expect(existsSync(moved.dir)).toBe(true);
  const fresh = join(root, "fresh.9");
  mkdirSync(fresh, { recursive: true });
  expect(applyUnowned(fresh, root, deps).action).toBe("LIVE");
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const expired = join(qt, quarantineEntryFor("ancient.1", new Date(now - 8 * 24 * 3600 * 1000)));
  mkdirSync(expired, { recursive: true });
  writeFileSync(join(expired, ".owner"), ownerText(deadFields("ancient", deadPid())));
  backdateTree(expired, 8 * 24 * 3600 * 1000, now);
  const deleted = applyQuarantineExpiry(home, deps);
  expect(deleted.map(v => v.dir)).toContain(expired);
  expect(existsSync(expired)).toBe(false);
  expect(isApplyFailure({ dir: "x", action: "SKIP", reason: "delete-failed", owner: null, sizeBytes: 0 })).toBe(true);
  expect(isApplyFailure({ dir: "x", action: "LIVE", reason: "owner-alive", owner: null, sizeBytes: 0 })).toBe(false);
});

test("killOrphan reaps a real sleeper and reports a missing pid as gone", () => {
  // A reparented grandchild behaves like a true orphan: no zombie lingers for us.
  const launcher = Bun.spawnSync(["sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!"], { stdout: "pipe", stderr: "ignore" });
  const orphanPid = Number(launcher.stdout.toString().trim());
  expect(Number.isSafeInteger(orphanPid)).toBe(true);
  const deps: ApplyDeps = { ...depsFor(), home: "/tmp" };
  expect(killOrphan(orphanPid, deps)).toBe(true);
  expect(killOrphan(deadPid(), deps)).toBe(true);
});
test("apply kills only selected harness orphans and logs JSONL", () => {
  const home = useState();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  try {
    const killed: number[] = [];
    const psTable = "  PID  PPID ELAPSED COMMAND\n90210     1 02:00:00 bun /k/mock-model.mjs --port 9\n90211   500 02:00:00 bun /k/mock-model.mjs\n";
    const deps: ApplyDeps = { liveness: defaultLiveness(),
      run: (args: readonly string[]) => args[0] === "ps"
        ? { code: 0, stdout: psTable, stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
      home, kill: (pid: number) => { killed.push(pid); return true; } };
    const result = applyScratch(home, deps);
    expect(killed).toEqual([90210]);
    const lines = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const event = lines.find(entry => entry.event === "orphan-kill");
    expect(event).toMatchObject({ pid: 90210, ok: true });
  } finally {
    if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
    else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
  }
});

function cli(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
    cwd: home, env: { ...process.env, HOME: home, ...extraEnv }, stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
}

function cliHome(): { home: string; state: string } {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-cli-"));
  roots.push(home);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "omp-kit"), 0o755);
  return { home, state };
}

function fakeLsof(): { dir: string } {
  const dir = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "fakebin-"));
  roots.push(dir);
  writeFileSync(join(dir, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  chmodSync(join(dir, "lsof"), 0o755);
  return { dir };
}

function fakePs(): { dir: string } {
  const dir = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "fakebin-"));
  roots.push(dir);
  writeFileSync(join(dir, "ps"),
    "#!/bin/sh\nif [ \"$1\" = \"-axo\" ] && [ \"$2\" = \"pid=,ppid=,etime=,command=\" ]; then exit 1; fi\nexec /bin/ps \"$@\"\n",
    { mode: 0o755 });
  chmodSync(join(dir, "ps"), 0o755);
  return { dir };
}

test("scratch release quarantines its live owner while leaving unreleased live scratch", () => {
  const { home, state } = cliHome();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const released = sessionDir(root, "omp", process.pid);
  writeFileSync(join(released, ".owner"),
    `pid=${process.pid}\nlabel=omp\nrepo=${home}\ncreated=${new Date().toISOString()}\n`);
  writeFileSync(join(released, "work"), "finished\n");
  const live = sessionDir(root, "live", process.pid);
  writeFileSync(join(live, ".owner"),
    `pid=${process.pid}\nlabel=live\nrepo=${home}\ncreated=${new Date().toISOString()}\n`);
  backdateTree(live, 73 * 3600 * 1000, Date.now());
  const lsof = fakeLsof().dir;
  // Service runs gate on machine load; pin a quiet reading so the reaping
  // logic (not runner load) is what's under test. The gate itself is covered
  // by service-run unit tests.
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, OMP_KIT_LOAD_OVERRIDE: "0.5/8",
    PATH: `${lsof}:${process.env.PATH ?? ""}` };

  const marked = cli(["scratch", "release", released], home, env);
  expect(marked.code).toBe(0);
  expect(marked.envelope.data).toMatchObject({ overall: "CHANGED", action: "RELEASED", dir: released });

  const run = cli(["service", "run", "scratch-reaper"], home, { ...env,
    PATH: `${fakePs().dir}:${lsof}:${process.env.PATH ?? ""}` });
  expect(run.code).toBe(0);
  expect(existsSync(released)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(run.envelope.data.sessions.find((v: { dir: string }) => v.dir === live)?.action).toBe("LIVE");
  expect(run.envelope.data.sessions.some((v: { action: string; reason: string }) =>
    v.action === "QUARANTINE" && v.reason.includes("owner-released"))).toBe(true);
  const quarantine = join(state, "omp-kit", "scratch-quarantine");
  expect(readdirSync(quarantine)).toHaveLength(1);
  const oldEntry = quarantineEntryFor(`omp.${process.pid}`, new Date(Date.now() - 8 * 24 * 3600 * 1000));
  const onlyEntry = readdirSync(quarantine)[0]!;
  renameSync(join(quarantine, onlyEntry), join(quarantine, oldEntry));
  const expired = cli(["service", "run", "scratch-reaper"], home, { ...env,
    PATH: `${fakePs().dir}:${lsof}:${process.env.PATH ?? ""}` });
  expect(expired.code).toBe(0);
  expect(existsSync(join(quarantine, oldEntry))).toBe(false);
  expect(expired.envelope.data.expired.some((v: { reason: string }) =>
    v.reason === "quarantine-expired-7d-owner-released")).toBe(true);
 }, 30000);

test("scratch release refuses a live directory owned by a different process", async () => {
  const { home, state } = cliHome();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const owner = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  try {
    const dir = sessionDir(root, "omp", owner.pid);
    writeFileSync(join(dir, ".owner"),
      `pid=${owner.pid}\nlabel=omp\nrepo=${home}\ncreated=${new Date().toISOString()}\n`);
    const result = cli(["scratch", "release", dir], home, {
      OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}`,
    });
    expect(result.code).toBe(2);
    expect(result.envelope.errors[0].code).toBe("SCRATCH_RELEASE_REFUSED");
    expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
  } finally {
    owner.kill("SIGTERM");
    await owner.exited;
  }
});

test("scratch plan reports planted sessions and apply refuses without consent", () => {
  const { home, state } = cliHome();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const dead = sessionDir(root, "gone", deadPid());
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", Number(dead.split(".").at(-1)))));
  const live = sessionDir(root, "live", process.pid);
  writeFileSync(join(live, ".owner"), ownerText(liveFields("live")));
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}` };
  const plan = cli(["scratch", "plan"], home, env);
  expect(plan.code).toBe(0);
  const byDir = Object.fromEntries(plan.envelope.data.sessions.map((v: { dir: string; action: string }) => [v.dir, v.action]));
  expect(byDir[dead]).toBe("REAP");
  expect(byDir[live]).toBe("LIVE");
  const refused = cli(["scratch", "apply"], home, env);
  expect(refused.code).toBe(2);
  expect(refused.envelope.errors[0].code).toBe("SCRATCH_REQUIRES_APPLY");
  expect(existsSync(dead)).toBe(true);
});

test("scratch apply removes dead sessions, quarantines idle unowned, and logs JSONL", () => {
  const { home, state } = cliHome();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const dead = sessionDir(root, "gone", deadPid());
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", Number(dead.split(".").at(-1)))));
  writeFileSync(join(dead, "data"), "dead\n");
  const live = sessionDir(root, "live", process.pid);
  writeFileSync(join(live, ".owner"), ownerText(liveFields("live")));
  const old = join(root, "stale.9");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "data"), "stale\n");
  backdateTree(old, 73 * 3600 * 1000, Date.now());
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}` };
  const applied = cli(["scratch", "apply", "--apply", "--yes"], home, env);
  expect(applied.code).toBe(0);
  expect(applied.envelope.data.overall).toBe("OK");
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(old)).toBe(false);
  const quarantined = applied.envelope.data.sessions.find((v: { action: string }) => v.action === "QUARANTINE");
  expect(quarantined.dir).toContain("scratch-quarantine");
  const lines = readFileSync(join(state, "omp-kit", "scratch-reap-log.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.some(entry => entry.event === "reap" && entry.dir === dead)).toBe(true);
  expect(lines.some(entry => entry.event === "quarantine")).toBe(true);
});

test("service run applies scratch reaping and writes a receipt", () => {
  const { home, state } = cliHome();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
  roots.push(root);
  const dead = sessionDir(root, "gone", deadPid());
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", Number(dead.split(".").at(-1)))));
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, OMP_KIT_LOAD_OVERRIDE: "0.5/8",
    PATH: `${fakePs().dir}:${fakeLsof().dir}:${process.env.PATH ?? ""}` };
  const run = cli(["service", "run", "scratch-reaper"], home, env);
  expect(run.code).toBe(0);
  expect(run.envelope.data.stats.reapableBytes).toBeGreaterThan(0);
  expect(existsSync(dead)).toBe(false);
  expect(run.envelope.data.sessions.some((v: { action: string }) => v.action === "REAP")).toBe(true);
  const receipt = JSON.parse(readFileSync(join(state, "omp-kit", "jobs", "scratch-reaper.json"), "utf8"));
  expect(typeof receipt.started_at).toBe("string");
  expect(receipt.exit).toBe(0);
});

test("resolveScratchRoots honors the override and skips symlinked components", () => {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-home-"));
  roots.push(home);
  const emptyTmp = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-tmp-"));
  roots.push(emptyTmp);
  process.env.OMP_KIT_SCRATCH_ROOTS = `/a${delimiter}/b`;
  try {
    expect(resolveScratchRoots(home)).toEqual(["/a", "/b"]);
  } finally {
    if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
    else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
  }
  delete process.env.OMP_KIT_SCRATCH_ROOTS;
  process.env.TMPDIR = emptyTmp;
  try {
    const linkTarget = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-real-"));
    roots.push(linkTarget);
    mkdirSync(join(home, "Developer"), { recursive: true });
    Bun.spawnSync(["ln", "-s", linkTarget, join(home, "Developer", "linkproj")], { stdout: "ignore", stderr: "ignore" });
    mkdirSync(join(linkTarget, "var", "agent-tmp"), { recursive: true });
    const found = resolveScratchRoots(home);
    expect(found.some(root => root.includes("linkproj"))).toBe(false);
    expect(found.filter(root => root.startsWith(emptyTmp))).toEqual([]);
  } finally {
    if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
    else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
  }
});

test("lsof forwards the per-dir timeout and treats a killed run as unavailable", () => {
	const seen: { timeoutMs?: number }[] = [];
	const recording = (args: readonly string[], opts?: { timeoutMs?: number }) => {
		seen.push(opts ?? {});
		return { code: 0, stdout: "", stderr: "" };
	};
	expect(lsofClear("/x", recording, 15000)).toBe(true);
	expect(seen).toEqual([{ timeoutMs: 15000 }]);
	expect(lsofClear("/x", () => ({ code: null, stdout: "", stderr: "" }), 15000)).toBeNull();
	expect(lsofClear("/x", recording)).toBe(true);
	expect(seen[seen.length - 1]).toEqual({});
});

test("defaultRunner honors the timeout and reports the kill", () => {
	const slow = defaultRunner(["sleep", "30"], { timeoutMs: 400 });
	expect(slow.code).toBeNull();
	const fast = defaultRunner(["true"], { timeoutMs: 5000 });
	expect(fast.code).toBe(0);
});

test("plan reports progress per directory as verdicts complete", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
	roots.push(root);
	const live = sessionDir(root, "live", process.pid);
	writeFileSync(join(live, ".owner"), ownerText(liveFields("live")));
	const naked = join(root, "naked.1");
	mkdirSync(naked, { recursive: true });
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	const seen: string[] = [];
	const plan = planScratch(root, { ...depsFor(), now: Date.now(), onProgress: verdict => { seen.push(`${verdict.action} ${verdict.dir}`); } });
	expect(plan.sessions.length).toBe(2);
	expect(seen.sort()).toEqual(plan.sessions.map(v => `${v.action} ${v.dir}`).sort());
});

test("a timed-out lsof keeps the directory instead of reaping it", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
	roots.push(root);
	const dead = sessionDir(root, "gone", deadPid());
	writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", Number(dead.split(".").at(-1)))));
 const hanging = (args: readonly string[]) => {
		if (args[0] === "lsof") return { code: null, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};
	const verdict = inspectSession(dead, root, { ...depsFor(), run: hanging, lsofTimeoutMs: 100 });
	expect(verdict.action).toBe("SKIP");
	expect(verdict.reason).toBe("lsof-evidence-unavailable");
	expect(existsSync(dead)).toBe(true);
});

test("JSON owner files parse to the same owner as key=value", () => {
	const kv = parseOwnerFile("pid=42\nlabel=omp\nrepo=/repo\ncreated=2026-10-01T00:00:00Z\n");
	const json = parseOwnerFile(JSON.stringify({ pid: 42, label: "omp", repo: "/repo", created: "2026-10-01T00:00:00Z" }));
	expect(json).toEqual(kv);
	expect(json).toMatchObject({ pid: 42, processStart: null, label: "omp" });
	const modern = ownerText(liveFields("a"));
	const modernJson = parseOwnerFile(JSON.stringify(Object.fromEntries(modern.trim().split("\n").map(line => {
		const eq = line.indexOf("=");
		return [line.slice(0, eq), line.slice(eq + 1)];
	}))));
	expect(modernJson).toEqual(parseOwnerFile(modern));
	expect(parseOwnerFile("{not json")).toBeNull();
	expect(parseOwnerFile(JSON.stringify({ pid: 42, label: "omp" }))).toBeNull();
	expect(parseOwnerFile(JSON.stringify({ pid: 42, label: "omp", repo: "/repo", created: "2026-10-01T00:00:00Z", evil: 1 }))).toBeNull();
});

test("one-line owner files parse like the multi-line form", () => {
	const pid = deadPid();
	const oneLine = `pid=${pid} label=jev-snap repo=/repo created=2026-10-01T00:00:00Z`;
	const multi = `pid=${pid}\nlabel=jev-snap\nrepo=/repo\ncreated=2026-10-01T00:00:00Z\n`;
	expect(parseOwnerFile(oneLine)).toEqual(parseOwnerFile(multi));
	expect(parseOwnerFile(`${oneLine}\n`)).toEqual(parseOwnerFile(multi));
	expect(parseOwnerFile(oneLine)).toMatchObject({ pid, label: "jev-snap" });
	expect(parseOwnerFile("BrRepair")).toBeNull();
	expect(parseOwnerFile(`pid=${pid} label=`)).toBeNull();
	expect(parseOwnerFile(`pid=${pid} label=x label=y repo=/r created=2026-10-01T00:00:00Z`)).toBeNull();
});

test("parsePsStart reads ctime lstart output", () => {
	expect(parsePsStart("Mon Oct  5 13:27:00 2026")).toBe(Date.UTC(2026, 9, 5, 13, 27, 0));
	expect(parsePsStart("Thu Jan  1 00:00:00 1970")).toBe(0);
	expect(parsePsStart("garbage")).toBeNull();
	expect(parsePsStart("")).toBeNull();
});

test("reuseAfterCreated proves PID reuse from the created timestamp", () => {
	const owner = { pid: 1, processStart: null, label: "x", repo: "r", createdAt: "2026-10-01T00:00:00Z", argv0: null };
	const after = { signalAlive: () => true, psVisible: () => true, processStart: () => "Mon Oct  5 00:00:01 2026" };
	const before = { signalAlive: () => true, psVisible: () => true, processStart: () => "Mon Sep  1 00:00:00 2025" };
	expect(reuseAfterCreated(owner, after)).toBe(true);
	expect(reuseAfterCreated(owner, before)).toBe(false);
	expect(reuseAfterCreated(owner, { signalAlive: () => true, psVisible: () => true, processStart: () => null })).toBeNull();
	expect(reuseAfterCreated({ ...owner, createdAt: "not-a-date" }, after)).toBeNull();
});

test("legacy owner with reused pid reaps instead of staying LIVE", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
	roots.push(root);
	const pid = deadPid();
	const dir = sessionDir(root, "2nb8-head-ffea66a0", pid);
	writeFileSync(join(dir, ".owner"), `pid=${pid}\nlabel=other-label\nrepo=/repo\ncreated=2026-10-01T00:00:00Z\n`);
	writeFileSync(join(dir, "bulk.bin"), "x".repeat(4096));
	const reused = { signalAlive: () => true, psVisible: () => true, processStart: () => "Mon Oct  5 00:00:01 2026" };
	const verdict = inspectSession(dir, root, depsFor({ liveness: reused }));
	expect(verdict.action).toBe("REAP");
	expect(verdict.reason).toBe("owner-dead-pid-reused-no-open-fds");
	expect(verdict.sizeBytes).toBeGreaterThanOrEqual(4096);
	const alive = { signalAlive: () => true, psVisible: () => true, processStart: () => "Mon Sep  1 00:00:00 2025" };
	const live = inspectSession(dir, root, depsFor({ liveness: alive }));
	expect(live.action).toBe("LIVE");
	expect(live.reason).toBe("owner-alive-start-unverified");
	expect(live.sizeBytes).toBeGreaterThanOrEqual(4096);
});

test("every verdict carries its size, including mismatches", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
	roots.push(root);
	const pid = deadPid();
	const dir = join(root, "wrong-name.99999");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"), ownerText({ pid: String(pid), label: "right-label", repo: "test", created: "2026-10-01T00:00:00Z" }));
	writeFileSync(join(dir, "bulk.bin"), "x".repeat(8192));
	const verdict = inspectSession(dir, root, depsFor());
	expect(verdict.reason).toBe("session-name-owner-mismatch");
	expect(verdict.sizeBytes).toBeGreaterThanOrEqual(8192);
});

test("plan totals count a planted gigabyte dir whatever its verdict", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-"));
	roots.push(root);
	const pid = deadPid();
	const dir = sessionDir(root, "plant", pid);
	writeFileSync(join(dir, ".owner"), "BrRepair");
	const fd = openSync(join(dir, "plant.bin"), "w");
	ftruncateSync(fd, 1024 * 1024 * 1024);
	closeSync(fd);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	const plan = planScratch(root, depsFor());
	expect(plan.totals.sizeByRoot[root]).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
	expect(plan.totals.malformedByRoot[root]).toBe(1);
	expect(plan.unownedActiveRule).toBe(UNOWNED_ACTIVE_RULE);
	expect(Object.values(plan.totals.sizeByVerdict).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
});

test("legacy release quarantines while the session lives; unreleased stays LIVE", () => {
	const { home } = cliHome();
	mkdirSync(join(home, "Developer", "proj", "var"), { recursive: true });
	const root = mkdtempSync(join(home, "Developer", "proj", "var", "agent-tmp"));
	const run = (args: readonly string[]) => {
		if (args[0] === "ps") return { code: 1, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};
	const deps = { liveness: defaultLiveness(), run, now: Date.now() };
	const released = join(root, "task.9289");
	const held = join(root, "other.9289");
	mkdirSync(released, { recursive: true });
	mkdirSync(held, { recursive: true });
	writeFileSync(join(released, ".owner"), "BrRepair");
	writeFileSync(join(held, ".owner"), "BrRepair");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	expect(releaseScratch(released, home, deps).ok).toBe(false);
	expect(releaseScratch(released, home, deps, { legacyOwner: true }).reason).toBe("owner-file-invalid");
	const done = releaseScratch(released, home, deps, { legacyOwner: true, reason: "task finished, session lives on" });
	expect(done).toMatchObject({ ok: true, changed: true, reason: "owner-released-legacy" });
	const planned = inspectOne(released, root, deps);
	expect(planned?.action).toBe("QUARANTINE");
	const idle = inspectOne(held, root, deps);
	expect(idle?.action).toBe("LIVE");
	expect(idle?.reason).toBe("malformed-owner-file-but-active");
	const applied = applyScratch(home, { ...deps, home });
	expect(applied.applied.find(v => v.dir.endsWith(".q-") || v.reason === "owner-released-quarantined") ?? applied.applied.find(v => v.action === "QUARANTINE")).toBeDefined();
	expect(existsSync(released)).toBe(false);
	expect(existsSync(held)).toBe(true);
});

test("createScratch makes a dir with a valid owner and an export line", () => {
	const repo = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-repo-"));
	roots.push(repo);
	const created = createScratch("mylabel", repo, depsFor());
	expect(created.ok).toBe(true);
	expect(created.dir).toBe(join(repo, "var", "agent-tmp", `mylabel.${process.pid}`));
	expect(created.exportLine).toBe(`export TMPDIR=${created.dir}`);
	const owner = parseOwnerFile(readFileSync(join(created.dir, ".owner"), "utf8"));
	expect(owner).toMatchObject({ pid: process.pid, label: "mylabel", repo });
	expect(createScratch("../evil", repo, depsFor()).ok).toBe(false);
	expect(createScratch("", repo, depsFor()).ok).toBe(false);
});

test("fleet test tmp base lives outside git trees and home", () => {
	const base = fleetTestTmpBase();
	expect(base.startsWith(process.env.HOME ?? "/nonexistent-home")).toBe(false);
	expect(base).not.toContain(".git");
	expect(summarizeScratch([], [base]).sizeByRoot).toEqual({});
});

test("lsof snapshot: held file deep in a tree is HELD, empty is clear, failure is SKIP", () => {
	const held = takeLsofSnapshot(() => ({ code: 0, stdout: "p123\nf3\nn/deep/tree/file.txt\n", stderr: "" }));
	expect(snapshotClear(held, "/deep/tree")).toBe(false);
	expect(snapshotClear(held, "/other")).toBe(true);
	const empty = takeLsofSnapshot(() => ({ code: 1, stdout: "", stderr: "" }));
	expect(snapshotClear(empty, "/deep/tree")).toBe(true);
	const failed = takeLsofSnapshot(() => { throw new Error("no lsof"); });
	expect(snapshotClear(failed, "/deep/tree")).toBeNull();
	const diag = takeLsofSnapshot(() => ({ code: 0, stdout: "", stderr: "lsof: no such file" }));
	expect(snapshotClear(diag, "/deep/tree")).toBeNull();
});

test("lsof snapshot prefix match does not confuse sibling names", () => {
	const snap = takeLsofSnapshot(() => ({ code: 0, stdout: "p1\nn/a/bc/x\n", stderr: "" }));
	expect(snapshotClear(snap, "/a/b")).toBe(true);
	expect(snapshotClear(snap, "/a/bc")).toBe(false);
});

test("REAP1 mutation OS failure names action path and OS error while refusal remains nonfailure", () => {
  const home = useState();
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-reap1-"));
  roots.push(root);
  const pid = deadPid();
  const dir = sessionDir(root, "finished", pid);
  writeFileSync(join(dir, ".owner"), ownerText(deadFields("finished", pid)));
  const deps: ApplyDeps = { ...depsFor(), home };
  const verdict = inspectSession(dir, root, deps);
  mkdirSync(join(process.env.XDG_STATE_HOME!, "omp-kit"), { recursive: true });
  writeFileSync(quarantineDir(home), "not a directory");
  const terminal = applyReap(dir, root, verdict, deps);
  expect(terminal).toMatchObject({ dir, action: "SKIP", status: "FAILED", reason: "quarantine-create-failed" });
  expect(terminal.error).toMatch(/EEXIST|ENOTDIR/);
  expect(isApplyFailure(terminal)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  const events = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ event: "failure", action: "REAP", dir, error: terminal.error });
});

test("REAP1 tree budget never promotes partial size to complete idle evidence", () => {
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-tree-"));
  roots.push(root);
  writeFileSync(join(root, "payload"), "size");
  const partial = measureScratchTree(root, { deadlineMs: Date.now() + 1000, maxEntries: 1 });
  expect(partial).toMatchObject({ status: "partial", reason: "tree-budget-exhausted" });
  const complete = measureScratchTree(root, { deadlineMs: Date.now() + 1000 });
  expect(complete).toMatchObject({ status: "complete", sizeBytes: 4 });
});

test("REAP1 canonical create and release publish size-only identity-bound snapshots", () => {
  const home = useState();
  const repo = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-snapshot-"));
  roots.push(repo);
  const deps = depsFor();
  const created = createScratch("snapshot", repo, deps);
  expect(created.ok).toBe(true);
  const initial = readScratchSizeSnapshot(created.dir);
  expect(initial?.status).toBe("complete");
  writeFileSync(join(created.dir, "payload"), "after-create");
  process.env.OMP_KIT_SCRATCH_ROOTS = join(repo, "var", "agent-tmp");
  const released = releaseScratch(created.dir, home, { ...deps, run: defaultRunner });
  expect(released.ok).toBe(true);
  expect(readScratchSizeSnapshot(created.dir)!.sizeBytes).toBeGreaterThan(initial!.sizeBytes);
  writeFileSync(join(created.dir, ".owner"), "changed owner");
  expect(readScratchSizeSnapshot(created.dir)).toBeNull();
});

test("REAP1 expired UNKNOWN ownership is refused rather than deleted from age alone", () => {
  const home = useState();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const now = Date.now();
  const unknown = join(qt, quarantineEntryFor("unknown", new Date(now - 8 * 24 * 3600_000)));
  mkdirSync(unknown);
  writeFileSync(join(unknown, ".owner"), "unparseable owner");
  writeFileSync(join(unknown, "keep"), "unknown ownership is a destructive veto");
  const terminal = applyQuarantineExpiry(home, { ...depsFor(), home, now }).find(row => row.dir === unknown);
  expect(terminal).toMatchObject({ action: "SKIP", status: "REFUSED", reason: "expiry-owner-or-fd-proof-unavailable" });
  expect(isApplyFailure(terminal!)).toBe(false);
  expect(readFileSync(join(unknown, "keep"), "utf8")).toBe("unknown ownership is a destructive veto");
});
