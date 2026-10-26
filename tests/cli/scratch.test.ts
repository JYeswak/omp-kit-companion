import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { applyQuarantineExpiry, applyReap, applyScratch, applyScratchForPressure, applyUnowned, createScratch, defaultLiveness, defaultRunner, fleetTestTmpBase, inspectBunBuildFiles, inspectOne, inspectSession, isApplyFailure, isHarnessServer, killOrphan, lsofClear, parseEtime, parseOwnerFile, planScratch, quarantineBuckets, quarantineDir, quarantineEntryFor, quarantineTimeOf, reapLogPath, releaseScratch, resolveScratchRoots, selectHarnessOrphans, snapshotClear, summarizeScratch, takeLsofSnapshot, UNOWNED_ACTIVE_RULE, type ApplyDeps, type InspectDeps } from "../../src/scratch.ts";
import { exportCommitToScratch, parseFreeOwner, parseTextOwner, releaseBudgetEntry, repoOfRoot } from "../../src/scratch.ts";
import type { ScratchVerdict } from "../../src/scratch.ts";
import { domain, KNOWN_JOBS, runScratchPressureTrigger, scratchPressureChiefRoute, systemdTimer } from "../../src/service.ts";
import { acquireRunLock } from "../../src/service-run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { mintOwnerCapability } from "../../src/kitlib/owner.ts";
import { run as runBounded } from "../../src/kitlib/run.ts";
import { fixtureLauncherTableBin } from "./launcher-table-fixture.ts";

const roots: string[] = [];
const fixtureRepo = resolve(import.meta.dir, "../..");
const AGENT_TMP = join(fixtureRepo, "var", "agent-tmp");
/** A fresh owned dir (src/kitlib/tmp.ts) under the repo's var/agent-tmp; callers still push it to `roots`. */
const agentTmp = (label: string): string => ownedTmp(label, { root: AGENT_TMP }).path;
// Exact-commit gate tests run from a nested archive; register their fixture root so consumer tests
// reach their owner/budget assertions. Root-discovery refusal is covered by scratch-release-now.test.ts.
function registerRepoScratchRoot(repo: string): void {
	process.env.OMP_KIT_SCRATCH_ROOTS = join(repo, "var", "agent-tmp");
}
// `service run scratch-reaper` below sees only this file's own launchers in the host process table.
const LAUNCHER_TABLE = fixtureLauncherTableBin();
const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
const savedState = process.env.XDG_STATE_HOME;
const savedTmp = process.env.TMPDIR;
const savedConfig = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
  else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
  if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfig;
});

/** Production state dirs are 0700; the scratch-users lock refuses group/other bits (PERMISSIVE_MODE). */
function privateKitState(state: string): void {
  mkdirSync(join(state, "omp-kit"), { recursive: true, mode: 0o700 });
}

/** Isolated state dir for in-process apply tests (which append JSONL to XDG state). */
function useState(): string {
  const state = agentTmp("scratch-xdg");
  roots.push(state);
  privateKitState(state);
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
  return { pid: String(process.pid), process_start: start, label, repo: fixtureRepo, created_at: "2026-10-01T00:00:00Z", argv0: "test" };
}

function deadFields(label: string, pid: number): Record<string, string> {
  return { pid: String(pid), process_start: "Thu Jan  1 00:00:00 1970", label, repo: fixtureRepo, created_at: "2026-10-01T00:00:00Z", argv0: "test" };
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

test("a reused PID without a seat or capability cannot authorize scratch release", () => {
  const { home } = cliHome();
  const root = agentTmp("scratch-reused-pid");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const dir = sessionDir(root, "omp", process.pid);
  writeFileSync(join(dir, ".owner"), ownerText({
    pid: String(process.pid), process_start: "stale-process-start", label: "omp", repo: fixtureRepo,
    created_at: new Date().toISOString(), argv0: "test",
  }));
  // The numeric PID is reused, and only the stale start is in .owner; PID liveness never grants release authority.
  const result = releaseScratch(dir, home, depsFor());
  expect(result).toMatchObject({ ok: false, changed: false, reason: "caller-not-owner", ownerPid: process.pid });
  expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
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
  const root = agentTmp("scratch");
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
test("legacy one-line owner stays unproven; structured incarnations reap dead and retain live owners", () => {
  const root = agentTmp("scratch");
  roots.push(root);
  const gone = deadPid();
  const legacy = sessionDir(root, "suite-snap", gone);
  const legacyOwner = `pid=${gone} label=suite-snap repo=${fixtureRepo} created=2026-10-01T00:00:00Z\n`;
  writeFileSync(join(legacy, ".owner"), legacyOwner);
  const legacyPayload = "x".repeat(1024);
  writeFileSync(join(legacy, "payload"), legacyPayload);
  const deps = depsFor();
  const legacyVerdict = inspectSession(legacy, root, deps);
  expect(legacyVerdict).toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
  expect(legacyVerdict.sizeBytes).toBe(Buffer.byteLength(legacyOwner) + Buffer.byteLength(legacyPayload));

  const dead = sessionDir(root, "suite-snap-modern", gone);
  const deadOwner = ownerText(deadFields("suite-snap-modern", gone));
  writeFileSync(join(dead, ".owner"), deadOwner);
  const deadPayload = "dead owner payload\n";
  writeFileSync(join(dead, "payload"), deadPayload);
  const deadVerdict = inspectSession(dead, root, deps);
  expect(deadVerdict).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
  expect(deadVerdict.sizeBytes).toBe(Buffer.byteLength(deadOwner) + Buffer.byteLength(deadPayload));

  const live = sessionDir(root, "suite-snap", process.pid);
  writeFileSync(join(live, ".owner"), ownerText(liveFields("suite-snap")));
  expect(inspectSession(live, root, deps).action).toBe("LIVE");
});
test("nested integrations work dirs use process-incarnation liveness", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const session = join(root, "session-1");
  mkdirSync(session, { recursive: true });
  const gone = deadPid();
  const dead = join(session, `omp-kit-integrations-${gone}-abc`);
  mkdirSync(dead, { recursive: true });
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("omp-kit-integrations", gone)));
  const live = join(session, `omp-kit-integrations-${process.pid}-def`);
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, ".owner"), ownerText(liveFields("omp-kit-integrations")));
  const plan = planScratch(home, depsFor());
  expect(plan.sessions.find(session => session.dir === dead)?.action).toBe("REAP");
  expect(plan.sessions.find(session => session.dir === live)?.action).toBe("LIVE");
  const nestedWork = join(session, "omp-kit-work.xyz");
  mkdirSync(nestedWork, { recursive: true });
  writeFileSync(join(nestedWork, ".owner"), ownerText(deadFields("omp-kit-work", gone)));
  const plan2 = planScratch(home, depsFor());
  expect(plan2.sessions.find(session => session.dir === nestedWork)?.action).toBe("REAP");
});
test("runtime omp-kit-work dirs with dead owners are reaped from system temp", () => {
	const home = useState();
	const root = agentTmp("runtime-work-root");
	roots.push(root);
	delete process.env.OMP_KIT_SCRATCH_ROOTS;
	process.env.TMPDIR = root;
	const work = join(root, "omp-kit-work.dead");
	mkdirSync(work, { recursive: true });
	const dead = deadPid();
	writeFileSync(join(work, ".owner"), ownerText({ pid: String(dead), process_start: "Thu Jan  1 00:00:00 1970", label: "omp-kit-work", repo: fixtureRepo, created_at: "2026-10-01T00:00:00Z", argv0: "runtime-adapter" }));
	writeFileSync(join(work, "payload"), "runtime work\n");
	const deps: ApplyDeps = { ...depsFor(), home };
	const plan = planScratch(home, deps);
	expect(plan.sessions.find(session => session.dir === work)?.action).toBe("REAP");
	const applied = applyScratch(home, deps);
	expect(applied.applied.find(session => session.dir === work)?.action).toBe("REAP");
	expect(existsSync(work)).toBe(false);
});


test("runtime adapter requires a durable caller identity and records its incarnation", async () => {
	const root = agentTmp("runtime-owner-root");
	roots.push(root);
	const adapter = resolve(import.meta.dir, "../../scripts/runtime-adapter.sh");
	const before = readdirSync(root).sort();
	const refused = await runBounded(["sh", "-c", 'OMP_KIT_TEST_WORK_ROOT="$1" OMP_KIT_CASE_CWD="$2" "$3" --workdir',
		"runtime-no-owner", root, fixtureRepo, adapter], { deadline_s: 4 });
	expect(refused.rc).toBe(2);
	expect(new TextDecoder().decode(refused.stderr)).toContain("OMP_KIT_WORK_OWNER_PID");
	expect(readdirSync(root).sort()).toEqual(before);

	const created = await runBounded(["sh", "-c",
		'owner=$$; work=$(OMP_KIT_TEST_WORK_ROOT="$1" OMP_KIT_CASE_CWD="$2" OMP_KIT_WORK_OWNER_PID="$owner" "$3" --workdir) || exit; printf "%s\\n" "$owner" >"$1/owner-pid"; printf "%s\\n" "$work" >"$1/workdir"; /bin/cat "$work/.owner" >"$1/owner-record"',
		"runtime-owner", root, fixtureRepo, adapter], { deadline_s: 4 });
	expect(created.rc, new TextDecoder().decode(created.stderr)).toBe(0);
	const ownerPid = Number(readFileSync(join(root, "owner-pid"), "utf8"));
	const owner = parseOwnerFile(readFileSync(join(root, "owner-record"), "utf8"));
	expect(owner?.pid).toBe(ownerPid);
	expect(owner?.processStart).not.toBeNull();
	const workdir = readFileSync(join(root, "workdir"), "utf8").trim();
	expect(workdir.startsWith(`${root}/`)).toBe(true);
	expect(existsSync(join(workdir, ".owner"))).toBe(true);
});

test("runtime adapter TERM leaves its workdir for no later reaper", async () => {
	const root = agentTmp("runtime-term-root");
	roots.push(root);
	const adapter = resolve(import.meta.dir, "../../scripts/runtime-adapter.sh");
	const child = await runBounded(["sh", "-c", "owner=$$; work=$(OMP_KIT_WORK_OWNER_PID=$$ TMPDIR=\"$1\" \"$2\" --workdir) || exit 1; trap 'rm -rf \"$work\"; exit 143' TERM INT EXIT; printf '%s' \"$work\" > \"$1/workdir\"; kill -TERM $$", "runtime-term", root, adapter], {
		deadline_s: 10,
	});
	expect(child.rc).toBe(143);
	expect(existsSync(join(root, "workdir")), `exit=${child.rc} ${new TextDecoder().decode(child.stderr)}`).toBe(true);
	const workdir = readFileSync(join(root, "workdir"), "utf8");
	expect(existsSync(workdir)).toBe(false);
}, 30_000);
test("inspect uses process identity and open descriptors, not a directory suffix", () => {
	const root = agentTmp("scratch");
	roots.push(root);
	const open = sessionDir(root, "open", deadPid());
	writeFileSync(join(open, ".owner"), ownerText(deadFields("open", Number(open.split(".").at(-1)))));
	writeFileSync(join(open, "held"), "x\n");
	const openRun = () => ({ code: 0, stdout: `sh 999 ${join(open, "held")}`, stderr: "" });
	expect(inspectSession(open, root, depsFor({ run: openRun })).reason).toBe("owner-dead-but-open-fds-present");
	const wrong = join(root, "renamed.3");
	mkdirSync(wrong, { recursive: true });
	writeFileSync(join(wrong, ".owner"), ownerText(deadFields("else", deadPid())));
	expect(inspectSession(wrong, root, depsFor())).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
});
test("dead and live owner incarnations control reaping independent of suffix; fresh malformed owner stays live", () => {
	const root = agentTmp("scratch");
	roots.push(root);
	const dead = deadPid();
	const rehomed = join(root, "tb14-restore");
	mkdirSync(rehomed, { recursive: true });
	writeFileSync(join(rehomed, ".owner"), ownerText(deadFields("tb14-restore", dead)));
	writeFileSync(join(rehomed, "payload"), "keep until apply\n");
	const deps = depsFor({ lsofSnapshot: new Set() });
	expect(inspectOne(rehomed, root, deps)).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	expect(existsSync(rehomed)).toBe(true);

	const live = join(root, "still-working");
	mkdirSync(live, { recursive: true });
	writeFileSync(join(live, ".owner"), ownerText(liveFields("still-working")));
	writeFileSync(join(live, "notes"), "keep\n");
	expect(inspectOne(live, root, deps)).toMatchObject({ action: "LIVE", reason: "owner-alive" });

	const fresh = join(root, "malformed-fresh");
	mkdirSync(fresh, { recursive: true });
	writeFileSync(join(fresh, ".owner"), "pid=not-an-integer\n");
	writeFileSync(join(fresh, "data"), "new\n");
	expect(inspectOne(fresh, root, deps)).toMatchObject({ action: "LIVE", reason: "malformed-owner-file-but-active" });
});


test("idle malformed-owner dirs are quarantined without deletion", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const now = Date.now();
  const malformed = join(root, "malformed.3");
  mkdirSync(malformed, { recursive: true });
  writeFileSync(join(malformed, ".owner"), "pid=not-an-integer\n");
  writeFileSync(join(malformed, "data"), "retain\n");
  backdateTree(malformed, 73 * 3600 * 1000, now);
  const deps = { ...depsFor({ now }), home, now };
  const planned = inspectOne(malformed, root, deps);
  expect(planned?.action).toBe("QUARANTINE");
  const applied = applyUnowned(malformed, root, deps);
  expect(applied.action).toBe("QUARANTINE");
  expect(existsSync(malformed)).toBe(false);
  expect(existsSync(applied.dir)).toBe(true);
  expect(readFileSync(join(applied.dir, "data"), "utf8")).toBe("retain\n");
});
test("a directory PID suffix never overrides the recorded owner incarnation", () => {
  const root = agentTmp("scratch");
  roots.push(root);
  const wrongDead = join(root, "renamed.3");
  mkdirSync(wrongDead, { recursive: true });
  const deadOwnerPid = deadPid();
  writeFileSync(join(wrongDead, ".owner"), ownerText(deadFields("else", deadOwnerPid)));
  writeFileSync(join(wrongDead, "data"), "preserve");
  const planned = inspectOne(wrongDead, root, depsFor());
  expect(planned).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
  expect(planned?.owner?.pid).toBe(deadOwnerPid);
});



test.skipIf(!HAVE_LSOF)("a real open descriptor blocks a real lsof reap", () => {
  const root = agentTmp("scratch");
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
  const root = agentTmp("scratch");
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
  const logs = existsSync(reapLogPath(home)) ? readFileSync(reapLogPath(home), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const failures = logs.filter(row => row.event === "failure");
  expect(failures.some(row => row.dir === raced && row.reason === "final-recheck-refused")).toBe(false);
  const skips = logs.filter(row => row.event === "skip");
  expect(skips.some(row => row.dir === raced && row.reason === "final-recheck-refused")).toBe(true);
});

test("apply records an owner race as a refused skip without failing the run", () => {
  const home = useState();
  const root = agentTmp("scratch-final-recheck");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const dir = sessionDir(root, "appeared", deadPid());
  const pid = Number(dir.split(".").at(-1));
  writeFileSync(join(dir, ".owner"), ownerText(deadFields("appeared", pid)));
  writeFileSync(join(dir, "payload"), "preserve me");
  const liveOwner = ownerText(liveFields("appeared"));
  let lsofCalls = 0;
  const run = (args: readonly string[]) => {
    if (args[0] === "lsof" && ++lsofCalls === 2) writeFileSync(join(dir, ".owner"), liveOwner);
    return clearRun();
  };

  const result = applyScratch(home, { ...depsFor({ run }), home });
  expect(result.applied).toContainEqual(expect.objectContaining({
    dir, action: "SKIP", reason: "final-recheck-refused",
  }));
  expect(result.receipt).toMatchObject({ failed_count: 0, refused_count: 1 });
  expect(existsSync(dir)).toBe(true);
  expect(readFileSync(join(dir, ".owner"), "utf8")).toBe(liveOwner);
  const logs = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(logs).toContainEqual(expect.objectContaining({
    event: "skip", dir, reason: "final-recheck-refused",
  }));
  expect(logs).toContainEqual(expect.objectContaining({
    event: "run-receipt", failed_count: 0, refused_count: 1,
  }));
});

test("apply quarantines idle unowned dirs and deletes expired quarantine after rechecks", () => {
  const home = useState();
  const root = agentTmp("scratch");
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

test("quarantine expiry honors the 24-hour default and configured TTL", () => {
  const home = useState();
  const configHome = agentTmp("scratch-config");
  roots.push(configHome);
  process.env.XDG_CONFIG_HOME = configHome;
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const createQuarantined = (label: string, ageHours: number) => {
    const path = join(qt, quarantineEntryFor(label, new Date(now - ageHours * 3600 * 1000)));
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "data"), label);
    // Owner-less entries must be idle past QUARANTINE_IDLE_MS (72h) to expire (6knq2 guard).
    backdateTree(path, 80 * 3600 * 1000, now);
    return path;
  };
  const overDefault = createQuarantined("over-default", 25);
  const withinDefault = createQuarantined("within-default", 23);
  const defaultResult = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(defaultResult.some(row => row.dir === overDefault && row.action === "DELETE")).toBe(true);
  expect(existsSync(overDefault)).toBe(false);
  expect(existsSync(withinDefault)).toBe(true);

  const configDir = join(configHome, "omp-kit");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, "scratch-reaper.json"), JSON.stringify({ quarantine_ttl_hours: 48 }), { mode: 0o600 });
  const underConfigured = createQuarantined("under-configured", 25);
  const overConfigured = createQuarantined("over-configured", 49);
  const configuredResult = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(existsSync(underConfigured)).toBe(true);
  expect(configuredResult.some(row => row.dir === overConfigured && row.action === "DELETE")).toBe(true);
  expect(existsSync(overConfigured)).toBe(false);
  writeFileSync(join(configDir, "scratch-reaper.json"), JSON.stringify({ quarantine_ttl_hours: 0 }), { mode: 0o600 });
  const invalidConfig = createQuarantined("invalid-config", 25);
  const invalidResult = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(invalidResult).toContainEqual(expect.objectContaining({ dir: qt, action: "SKIP", reason: "quarantine-ttl-config-invalid" }));
  expect(existsSync(invalidConfig)).toBe(true);
  expect(isApplyFailure(invalidResult[0]!)).toBe(true);
});

test("6knq2: an owner-less quarantine entry past its TTL but touched within 72h is kept", () => {
  const home = useState();
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const active = join(qt, quarantineEntryFor("still-active", new Date(now - 25 * 3600 * 1000)));
  mkdirSync(active, { recursive: true });
  writeFileSync(join(active, "data"), "written now");
  const idle = join(qt, quarantineEntryFor("long-idle", new Date(now - 25 * 3600 * 1000)));
  mkdirSync(idle, { recursive: true });
  writeFileSync(join(idle, "data"), "written long ago");
  backdateTree(idle, 80 * 3600 * 1000, now);
  const result = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(result).toContainEqual(expect.objectContaining({ dir: active, action: "SKIP", reason: "quarantine-active-mtime" }));
  expect(existsSync(active)).toBe(true);
  expect(result.some(row => row.dir === idle && row.action === "DELETE")).toBe(true);
  expect(existsSync(idle)).toBe(false);
});

test("5fn07: a group/other-accessible kit state dir refuses the users lock, so expiry keeps the entry", () => {
  const home = useState();
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const entry = join(qt, quarantineEntryFor("permissive-state", new Date(now - 25 * 3600 * 1000)));
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "data"), "expired");
  backdateTree(entry, 80 * 3600 * 1000, now);
  chmodSync(join(home, "omp-kit"), 0o755);
  const refused = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(refused).toContainEqual(expect.objectContaining({ dir: entry, action: "SKIP", reason: "users-lock-busy" }));
  expect(existsSync(entry)).toBe(true);
  chmodSync(join(home, "omp-kit"), 0o700);
  const deleted = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(deleted.some(row => row.dir === entry && row.action === "DELETE")).toBe(true);
  expect(existsSync(entry)).toBe(false);
});

test("expired delete markers log their cause and are retried", () => {
  const home = useState();
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const pid = deadPid();
  const marker = join(qt, `${quarantineEntryFor("retry.1", new Date(now - 25 * 3600 * 1000))}.delete-56789`);
  mkdirSync(marker, { recursive: true });
  writeFileSync(join(marker, ".owner"), ownerText(deadFields("retry", pid)));
  const failedDeps = { ...depsFor(), home, now, remove: () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  } } as ApplyDeps;
  const failed = applyQuarantineExpiry(home, failedDeps);
  expect(failed).toContainEqual(expect.objectContaining({
    dir: marker, action: "SKIP", reason: "delete-failed", cause: "permission",
  }));
  expect(existsSync(marker)).toBe(true);
  const logs = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(logs).toContainEqual(expect.objectContaining({ event: "delete-failed", dir: marker, cause: "permission" }));

  const retried = applyQuarantineExpiry(home, { ...depsFor(), home, now });
  expect(retried).toContainEqual(expect.objectContaining({ dir: marker, action: "DELETE" }));
  expect(existsSync(marker)).toBe(false);
});

test("quarantineTimeOf accepts delete markers and rejects malformed or oversized names", () => {
  const at = new Date("2026-10-13T06:00:00.000Z");
  const entry = quarantineEntryFor("valid", at);
  expect(quarantineTimeOf(entry)).toBe(at.getTime());
  expect(quarantineTimeOf(`${entry}.delete-56789`)).toBe(at.getTime());
  expect(quarantineTimeOf(`${entry}.delete-x`)).toBeNull();
  expect(quarantineTimeOf(`${entry}x`)).toBeNull();
  expect(quarantineTimeOf(`${"x".repeat(300)}${entry}`)).toBeNull();
});

test("delete failure reports immutable flags only when observed", () => {
  const home = useState();
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const createMarker = (label: string) => {
    const path = join(qt, `${quarantineEntryFor(label, new Date(now - 25 * 3600 * 1000))}.delete-56789`);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".owner"), ownerText(deadFields(label, deadPid())));
    return path;
  };
  const immutablePath = createMarker("immutable");
  const unverifiedPath = createMarker("unverified");
  const run = (args: readonly string[]) => {
    if (args[0] !== "/bin/ls") return clearRun();
    const path = args[args.length - 1]!;
    const flags = path === immutablePath ? "uchg" : "-";
    return { code: 0, stdout: `drwxr-xr-x 2 josh staff ${flags} 64 Oct 13 06:00 ${path}`, stderr: "" };
  };
  const deps = { ...depsFor({ run }), home, now, remove: () => {
    const error = new Error("operation not permitted") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  } } as ApplyDeps;
  const failed = applyQuarantineExpiry(home, deps);
  expect(failed).toContainEqual(expect.objectContaining({ dir: immutablePath, cause: "immutable-flag" }));
  expect(failed).toContainEqual(expect.objectContaining({ dir: unverifiedPath, cause: "unknown" }));
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
  const root = agentTmp("scratch");
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
    cwd: home, env: { ...process.env, HOME: home, ...extraEnv, PATH: `${LAUNCHER_TABLE}:${extraEnv.PATH ?? process.env.PATH ?? ""}`,
      BUN_OPTIONS: `--preload=${join(home, "browser-inventory.ts")}` }, stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
}

function cliHome(): { home: string; state: string } {
  const home = agentTmp("scratch-cli");
  roots.push(home);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  privateKitState(state);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "omp-kit"), 0o755);
  // PATH's fake ps does not intercept the browser collector's absolute /bin/ps.
  // Keep that inventory empty in both the keeper and its inherited worker;
  // real owner-PID/start and lsof probes remain unchanged.
  writeFileSync(join(home, "browser-inventory.ts"), `
const spawnSync = Bun.spawnSync.bind(Bun);
Bun.spawnSync = ((command, options) => {
  if (Array.isArray(command) && command[0] === "/bin/ps" && command[1] === "-axo") {
    return spawnSync(["/usr/bin/true"], options);
  }
  return spawnSync(command, options);
});
`);
  return { home, state };
}

function fakeLsof(options: { openPath?: string; unknown?: boolean } = {}): { dir: string } {
  const dir = agentTmp("fakebin");
  roots.push(dir);
  const script = options.openPath !== undefined
    ? `#!/bin/sh\nprintf '%s\\n' 'n${options.openPath}'\nexit 0\n`
    : options.unknown
      ? "#!/bin/sh\nprintf '%s\\n' 'lsof: permission denied' >&2\nexit 1\n"
      : "#!/bin/sh\nexit 1\n";
  writeFileSync(join(dir, "lsof"), script, { mode: 0o755 });
  chmodSync(join(dir, "lsof"), 0o755);
  return { dir };
}

function fakePs(): { dir: string } {
  const dir = agentTmp("fakebin");
  roots.push(dir);
  writeFileSync(join(dir, "ps"),
    "#!/bin/sh\nif [ \"$1\" = \"-axo\" ] && [ \"$2\" = \"pid=,ppid=,etime=,command=\" ]; then exit 1; fi\nexec /bin/ps \"$@\"\n",
    { mode: 0o755 });
  chmodSync(join(dir, "ps"), 0o755);
  return { dir };
}

test("capability release quarantines a live owner while keeping unreleased live scratch", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
  roots.push(root);
  const released = sessionDir(root, "omp", process.pid);
  const capability = mintOwnerCapability();
  writeFileSync(join(released, ".owner"), ownerText({ ...liveFields("omp"), capability_sha256: capability.sha256 }));
  writeFileSync(join(released, "work"), "finished\n");
  const live = sessionDir(root, "live", process.pid);
  writeFileSync(join(live, ".owner"), ownerText(liveFields("live")));
  backdateTree(live, 73 * 3600 * 1000, Date.now());
  const lsof = fakeLsof().dir;
  // Service runs gate on machine load; pin a quiet reading so the reaping
  // logic (not runner load) is what's under test. The gate itself is covered
  // by service-run unit tests.
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, OMP_KIT_LOAD_OVERRIDE: "0.5/8",
    PATH: `${lsof}:${process.env.PATH ?? ""}` };

  const marked = cli(["scratch", "release", released, "--capability", capability.token], home, env);
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
 }, 30000);

test("scratch release refuses a live directory owned by a different process", async () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
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
  const root = agentTmp("scratch");
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

test("scratch plan public JSON exposes byte totals, malformed counts, sized skips, and the active rule", () => {
	const { home, state } = cliHome();
	const root = agentTmp("scratch-plan-json");
	roots.push(root);
	const oneGb = 1024 * 1024 * 1024;
	const writeSparse = (dir: string, name: string, bytes: number): void => {
		const fd = openSync(join(dir, name), "w");
		try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
	};
	const json = sessionDir(root, "json", process.pid);
	writeFileSync(join(json, ".owner"), JSON.stringify(liveFields("json")) + "\n");
	writeSparse(json, "live.bin", oneGb);
	const multiline = sessionDir(root, "multiline", process.pid);
	writeFileSync(join(multiline, ".owner"), ownerText(liveFields("multiline")));
	writeFileSync(join(multiline, "data"), "live\n");
	const oneLine = sessionDir(root, "one-line", process.pid);
	writeFileSync(join(oneLine, ".owner"), `pid=${process.pid} label=one-line repo=${fixtureRepo} created=2026-10-01T00:00:00Z\n`);
	writeFileSync(join(oneLine, "data"), "legacy\n");
	const mismatch = join(root, "wrong-name.99999");
	mkdirSync(mismatch, { recursive: true });
	writeFileSync(join(mismatch, ".owner"), ownerText(deadFields("right-name", deadPid())));
	writeSparse(mismatch, "skip.bin", oneGb);
	const malformed = sessionDir(root, "malformed", deadPid());
	writeFileSync(join(malformed, ".owner"), "not an owner record\n");
	writeFileSync(join(malformed, "data"), "malformed\n");
	const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof({ openPath: join(oneLine, "data") }).dir}:${process.env.PATH ?? ""}` };
	const plan = cli(["scratch", "plan"], home, env);
	expect(plan.code).toBe(0);
	const rows = plan.envelope.data.sessions as Array<{ dir: string; action: string; reason: string; sizeBytes?: number }>;
	const liveRow = rows.find(row => row.dir === json);
	const deadRow = rows.find(row => row.dir === mismatch);
	expect(liveRow?.action).toBe("LIVE");
	expect(liveRow?.sizeBytes).toBeGreaterThanOrEqual(oneGb);
	expect(deadRow).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	expect(deadRow?.sizeBytes).toBeGreaterThanOrEqual(oneGb);
	const multilineRow = rows.find(row => row.dir === multiline);
	const oneLineRow = rows.find(row => row.dir === oneLine);
	expect(multilineRow?.action).toBe("LIVE");
	expect(multilineRow?.sizeBytes).toBeGreaterThan(0);
	expect(oneLineRow).toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
	expect(oneLineRow?.sizeBytes).toBeGreaterThan(0);
	expect(rows.find(row => row.dir === malformed)?.sizeBytes).toBeGreaterThan(0);
	expect(rows.filter(row => row.action === "LIVE" || row.action === "SKIP")
		.every(row => typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes))).toBe(true);
	expect(plan.envelope.data.totals.sizeByRoot[root]).toBeGreaterThanOrEqual(oneGb * 2);
	expect(plan.envelope.data.totals.sizeByVerdict["REAP:owner-dead-no-open-fds"]).toBe(deadRow?.sizeBytes);
	expect(plan.envelope.data.totals.countByVerdict["REAP:owner-dead-no-open-fds"]).toBe(1);
	expect(plan.envelope.data.totals.sizeByVerdict[`LIVE:${liveRow?.reason}`]).toBeGreaterThanOrEqual(liveRow?.sizeBytes);
	expect(plan.envelope.data.totals.malformedByRoot[root]).toBe(1);
	expect(plan.envelope.data.unownedActiveRule).toBe(UNOWNED_ACTIVE_RULE);
	expect(Array.isArray(plan.envelope.data.rootMetrics)).toBe(true);
	const help = cli(["help", "scratch"], home);
	expect(help.code).toBe(0);
	expect(help.envelope.data.text).toContain(UNOWNED_ACTIVE_RULE);
});

test("scratch apply removes dead sessions, quarantines idle unowned, and logs JSONL", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
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
  const planned = cli(["scratch", "plan"], home, env);
  expect(planned.envelope.data.unownedActiveRule).toBe(UNOWNED_ACTIVE_RULE);
  expect(planned.envelope.data.sessions.find((value: { dir: string }) => value.dir === old)?.action).toBe("QUARANTINE");
  expect(planned.envelope.data.sessions.find((value: { dir: string }) => value.dir === live)?.action).toBe("LIVE");
  const applied = cli(["scratch", "apply", "--apply", "--yes"], home, env);
  expect(applied.code).toBe(0);
  expect(applied.envelope.data.overall).toBe("OK");
  expect(applied.envelope.data.unownedActiveRule).toBe(planned.envelope.data.unownedActiveRule);
  expect(applied.envelope.data.receipt).toBeDefined();
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(old)).toBe(false);
  const quarantined = applied.envelope.data.sessions.find((v: { action: string }) => v.action === "QUARANTINE");
  expect(quarantined.dir).toContain("scratch-quarantine");
  const lines = readFileSync(join(state, "omp-kit", "scratch-reap-log.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.some(entry => entry.event === "reap" && entry.dir === dead)).toBe(true);
  expect(lines.some(entry => entry.event === "quarantine")).toBe(true);
});

test("scratch apply preserves 73-hour unowned dirs on open-fd and unknown lsof evidence", () => {
	for (const fixture of [
		{ open: true, reason: "owner-released-but-open-fds-present" },
		{ open: false, reason: "lsof-evidence-unavailable" },
	]) {
		const { home, state } = cliHome();
		const root = agentTmp("scratch-lsof-plan");
		roots.push(root);
		const stale = join(root, "stale.9");
		mkdirSync(stale, { recursive: true });
		writeFileSync(join(stale, "data"), "stale\n");
		backdateTree(stale, 73 * 3600 * 1000, Date.now());
		const lsof = fakeLsof(fixture.open ? { openPath: join(stale, "data") } : { unknown: true });
		const applied = cli(["scratch", "apply", "--apply", "--yes"], home, {
			OMP_KIT_SCRATCH_ROOTS: root,
			XDG_STATE_HOME: state,
			PATH: `${lsof.dir}:${process.env.PATH ?? ""}`,
		});
		const row = applied.envelope.data.sessions.find((value: { dir: string }) => value.dir === stale);
		expect(existsSync(stale)).toBe(true);
		expect(row?.action).toBe("SKIP");
		expect(row?.reason).toBe(fixture.reason);
		expect(applied.envelope.data.unownedActiveRule).toBe(UNOWNED_ACTIVE_RULE);
	}
});

test("scratch plan keeps 60-hour idle unowned dirs LIVE (mid-boundary literals)", () => {
	// Literals only: 60h sits strictly between a 48h constant-drift mutant and the real
	// 72h rule, so this passes on current source and MUST fail (QUARANTINE, not LIVE)
	// against a 48h QUARANTINE_IDLE_MS mutant. No UNOWNED_ACTIVE_RULE import.
	const { home, state } = cliHome();
	const root = agentTmp("scratch-midbound");
	roots.push(root);
	const mid = join(root, "mid.9");
	mkdirSync(mid, { recursive: true });
	writeFileSync(join(mid, "data"), "mid\n");
	backdateTree(mid, 60 * 3600 * 1000, Date.now());
	const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}` };
	const planned = cli(["scratch", "plan"], home, { ...env, OMP_KIT_SCRATCH_FREE_PCT: "40" });
	const row = planned.envelope.data.sessions.find((value: { dir: string }) => value.dir === mid);
	expect(row?.action).toBe("LIVE");
	expect(row?.reason).toBe("unowned-but-active");
	expect(String(planned.envelope.data.unownedActiveRule)).toContain("72h");
	// Same dir with the disk at 12% free (RECLAIM): the 12 h bound applies through the real CLI.
	const pressed = cli(["scratch", "plan"], home, { ...env, OMP_KIT_SCRATCH_FREE_PCT: "12" });
	const pressedRow = pressed.envelope.data.sessions.find((value: { dir: string }) => value.dir === mid);
	expect(pressedRow?.action).toBe("QUARANTINE");
	expect(pressedRow?.reason).toBe("unowned-idle-12h-reclaim-would-quarantine");
});

test("service run applies scratch reaping and writes a receipt", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
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
test("manual scratch apply returns BUSY with the scheduled reaper holder PID", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
  roots.push(root);
  const jobsDir = join(state, "omp-kit", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const holder = acquireRunLock(jobsDir, "scratch-reaper");
  if (holder.status !== "ACQUIRED") throw new Error("Scheduled reaper fixture could not acquire its keeper");
  try {
    const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakePs().dir}:${fakeLsof().dir}:${process.env.PATH ?? ""}` };
    const run = cli(["scratch", "apply", "--apply", "--yes"], home, env);
    expect(run.code).toBe(4);
    expect(run.envelope.data.overall).toBe("BUSY");
    expect(run.envelope.data.holder_pid).toBe(process.pid);
  } finally {
    holder.lock.release();
  }
});

test("scratch-reaper reports invalid quarantine TTL configuration", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
  const configHome = agentTmp("scratch-config");
  roots.push(root, configHome);
  mkdirSync(join(configHome, "omp-kit"), { recursive: true });
  writeFileSync(join(configHome, "omp-kit", "scratch-reaper.json"), JSON.stringify({ quarantine_ttl_hours: 0 }));
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, XDG_CONFIG_HOME: configHome,
    OMP_KIT_LOAD_OVERRIDE: "0.5/8", PATH: `${fakePs().dir}:${fakeLsof().dir}:${process.env.PATH ?? ""}` };
  const run = cli(["service", "run", "scratch-reaper"], home, env);
  expect(run.code).toBe(1);
  expect(run.envelope.data.expired).toContainEqual(expect.objectContaining({ action: "SKIP", reason: "quarantine-ttl-config-invalid" }));
  const receipt = JSON.parse(readFileSync(join(state, "omp-kit", "jobs", "scratch-reaper.json"), "utf8"));
  expect(receipt.exit).toBe(1);
});


test("resolveScratchRoots honors the override and skips symlinked components", () => {
  const home = agentTmp("scratch-home");
  roots.push(home);
  const emptyTmp = agentTmp("scratch-tmp");
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
    const linkTarget = agentTmp("scratch-real");
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
	expect(lsofClear("/x", recording, 15000)).toBeNull();
	expect(seen).toEqual([{ timeoutMs: 15000 }]);
	expect(lsofClear("/x", () => ({ code: null, stdout: "", stderr: "" }), 15000)).toBeNull();
	expect(lsofClear("/x", recording)).toBeNull();
	expect(seen[seen.length - 1]).toEqual({});
});

test("defaultRunner honors the timeout and reports the kill", () => {
	const slow = defaultRunner(["sleep", "30"], { timeoutMs: 400 });
	expect(slow.code).toBeNull();
	const fast = defaultRunner(["true"], { timeoutMs: 5000 });
	expect(fast.code).toBe(0);
});

test("plan reports progress per directory as verdicts complete", () => {
	const root = agentTmp("scratch");
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
	const root = agentTmp("scratch");
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

test("a PID-only owner stays unproven even when its live pid started after the creation date", () => {
	const root = agentTmp("scratch");
	roots.push(root);
	const pid = deadPid();
	const dir = sessionDir(root, "legacy-owner", pid);
	writeFileSync(join(dir, ".owner"), `pid=${pid}\nlabel=legacy-owner\nrepo=${fixtureRepo}\ncreated=2026-10-01T00:00:00Z\n`);
	writeFileSync(join(dir, "bulk.bin"), "x".repeat(8192));
	const live = { processStart: () => "Mon Oct  5 00:00:01 2026" };
	const verdict = inspectSession(dir, root, depsFor({ liveness: live }));
	expect(verdict).toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
	expect(verdict.sizeBytes).toBe(Buffer.byteLength(readFileSync(join(dir, ".owner"), "utf8")) + 8192);
});

test("a date-only JSON owner without process_start remains unproven", () => {
	const root = agentTmp("scratch");
	roots.push(root);
	const pid = deadPid();
	const dir = sessionDir(root, "grzn1-review", pid);
	writeFileSync(join(dir, ".owner"), JSON.stringify({ pid, label: "grzn1-review", repo: fixtureRepo, created: "2026-10-15T07:16:16Z" }) + "\n");
	const sameDay = { processStart: () => "2026-10-15T07:16:16Z" };
	expect(inspectSession(dir, root, depsFor({ liveness: sameDay })))
		.toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
});
test("a PID-only owner remains unproven regardless of directory suffix and reports its size", () => {
	const root = agentTmp("scratch");
	roots.push(root);
	const pid = deadPid();
	const dir = join(root, "wrong-name.99999");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"), ownerText({ pid: String(pid), label: "right-label", repo: fixtureRepo, created: "2026-10-01T00:00:00Z" }));
	writeFileSync(join(dir, "bulk.bin"), "x".repeat(8192));
	const verdict = inspectSession(dir, root, depsFor());
	expect(verdict).toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
	expect(verdict.sizeBytes).toBeGreaterThanOrEqual(8192);
});


test("plan totals count a planted gigabyte dir whatever its verdict", () => {
	const root = agentTmp("scratch");
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
	const root = ownedTmp("agent-tmp", { root: join(home, "Developer", "proj", "var") }).path;
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
	const repo = agentTmp("scratch-repo");
	roots.push(repo);
	registerRepoScratchRoot(repo);
	const created = createScratch("mylabel", repo, depsFor(), {}, false, join(repo, "scratch-budgets.json"));
	expect(created.ok).toBe(true);
	expect(created.dir).toBe(join(repo, "var", "agent-tmp", `mylabel.${process.pid}`));
	expect(created.exportLine).toBe(`export TMPDIR=${created.dir}`);
	const owner = parseOwnerFile(readFileSync(join(created.dir, ".owner"), "utf8"));
	expect(owner).toMatchObject({ pid: process.pid, label: "mylabel", repo });
	expect(createScratch("../evil", repo, depsFor(), {}, false, join(repo, "scratch-budgets.json")).ok).toBe(false);
	expect(createScratch("", repo, depsFor(), {}, false, join(repo, "scratch-budgets.json")).ok).toBe(false);
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
test("scratch pressure thresholds gate plan classification", () => {
  const home = useState();
  const root = agentTmp("scratch-pressure");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const now = Date.now();
  const classify = (free: number | null) => {
    const statfs = () => free === null ? null : { bavail: free, blocks: 100 };
    return planScratch(home, { ...depsFor({ now }), now, statfs }).pressure;
  };
  expect(classify(19.99)).toBe("RECLAIM");
  expect(classify(20)).toBe("RECLAIM");
  expect(classify(20.01)).toBe("WARN");
  expect(classify(25)).toBe("WARN");
  expect(classify(25.01)).toBe("NORMAL");
  expect(classify(null)).toBe("UNKNOWN");
});
test("pressure reclaims at 20 percent but does not apply above the threshold", () => {
  const root = agentTmp("scratch-pressure-trigger");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;

  const highHome = useState();
  const high = applyScratchForPressure(highHome, {
    ...depsFor(), home: highHome, statfs: () => ({ bavail: 2001, blocks: 10000 }),
  });
  expect(high).toMatchObject({ free_pct: 20.01, pressure: "WARN", result: null });
  expect(existsSync(reapLogPath(highHome))).toBe(false);

  const lowHome = useState();
  const low = applyScratchForPressure(lowHome, {
    ...depsFor(), home: lowHome, statfs: () => ({ bavail: 20, blocks: 100 }),
  });
  expect(low).toMatchObject({ free_pct: 20, pressure: "RECLAIM", result: { receipt: { free_pct_before: 20 } } });
  expect(existsSync(reapLogPath(lowHome))).toBe(true);
});

test("scheduled pressure watcher warns at 25 percent and kicks the reaper at 20", () => {
  const job = KNOWN_JOBS["scratch-pressure"]!;
  expect(job).toMatchObject({ intervalSeconds: 60, runAtLoad: false });
  expect(systemdTimer(job)).toContain("OnUnitActiveSec=60s");
  const calls: (readonly string[])[] = [];
  const run = (args: readonly string[]) => {
    calls.push([...args]);
    return { code: 0, stdout: "started", stderr: "" };
  };
  expect(runScratchPressureTrigger(25, "darwin", run)).toMatchObject({ pressure: "WARN", action: "WARN" });
  expect(runScratchPressureTrigger(20.01, "darwin", run)).toMatchObject({ pressure: "WARN", action: "WARN" });
  expect(calls).toEqual([]);
  expect(runScratchPressureTrigger(20, "darwin", run)).toMatchObject({
    pressure: "RECLAIM",
    action: "RECLAIM_TRIGGERED",
    command: ["launchctl", "kickstart", `${domain()}/com.omp-kit.scratch-reaper`],
  });
  expect(calls).toEqual([["launchctl", "kickstart", `${domain()}/com.omp-kit.scratch-reaper`]]);
});

test("scratch-pressure chief route accepts configured destinations and refuses malformed ones", () => {
  const home = useState();
  const config = join(home, "fleet-watch.json");
  writeFileSync(config, JSON.stringify({ chief: { session: "omp-test", pane: "%57", agent: "RedMaple" } }));
  expect(scratchPressureChiefRoute(home, config)).toEqual({ session: "omp-test", pane: "%57", agent: "RedMaple" });

  writeFileSync(config, JSON.stringify({ chief: { session: "omp-test\nwrong", pane: "%57" } }));
  expect(scratchPressureChiefRoute(home, config)).toBeNull();
  expect(scratchPressureChiefRoute(home, join(home, "missing.json"))).toBeNull();
});

test("scratch root report includes statfs free percent and usage GB", () => {
  const home = useState();
  const root = agentTmp("scratch-metrics");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const dir = sessionDir(root, "metrics", deadPid());
  writeFileSync(join(dir, ".owner"), ownerText(deadFields("metrics", Number(dir.split(".").at(-1)))));
  writeFileSync(join(dir, "payload"), "x".repeat(100));
  const plan = planScratch(home, { ...depsFor(), statfs: () => ({ bavail: 195, blocks: 1000 }) });
  expect(plan.rootMetrics ?? null).toEqual([
    { root, free_pct: 19.5, scratch_gb: plan.totals.sizeByRoot[root]! / 1_000_000_000, sources: ["override"] },
  ]);
});

test("quarantine report separates young, expired-held, and delete-failed bytes", () => {
  const home = useState();
  const root = agentTmp("scratch-buckets");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  // The buckets assume the default 24 h TTL: read it from an empty config dir, never the operator's.
  process.env.XDG_CONFIG_HOME = agentTmp("scratch-config");
  roots.push(process.env.XDG_CONFIG_HOME);
  const now = Date.parse("2026-10-13T07:00:00.000Z");
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const plant = (label: string, ageHours: number, bytes: number, marker = false) => {
    const entry = quarantineEntryFor(label, new Date(now - ageHours * 3600 * 1000)) + (marker ? ".delete-56789" : "");
    const path = join(qt, entry);
    mkdirSync(path, { recursive: true });
    const fd = openSync(join(path, "payload"), "w");
    ftruncateSync(fd, bytes);
    closeSync(fd);
  };
  plant("young", 23, 7);
  plant("held", 25, 5);
  plant("failed", 26, 3, true);
  const plan = planScratch(home, { ...depsFor({ now }), now });
  expect(plan.quarantineBuckets).toEqual({
    young: { entries: 1, bytes: 7 },
    expiredHeld: { entries: 1, bytes: 5 },
    failed: { entries: 1, bytes: 3 },
    oldestAgeMs: 26 * 3600 * 1000,
    readable: true,
    ttlValid: true,
  });
});

test("scratch apply progress reports the exact row total", () => {
  const home = useState();
  const root = agentTmp("scratch-progress");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const first = sessionDir(root, "first", process.pid);
  const second = sessionDir(root, "second", process.pid);
  writeFileSync(join(first, ".owner"), ownerText(liveFields("first")));
  writeFileSync(join(second, ".owner"), ownerText(liveFields("second")));
  const progress: { done: number; total: number }[] = [];
  const onProgress = (_verdict: ScratchVerdict, current?: { done: number; total: number }) => {
    if (current) progress.push(current);
  };
  applyScratch(home, { ...depsFor({ onProgress }), home });
  expect(progress).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }]);
});

test("scratch reaper removes stale bun-build files and keeps the open control", () => {
  const home = useState();
  const repo = agentTmp("bun-build-repo");
  roots.push(repo);
  const scratch = join(repo, "var", "agent-tmp");
  mkdirSync(scratch, { recursive: true });
  process.env.OMP_KIT_SCRATCH_ROOTS = scratch;
  const stale = join(repo, ".deadbeef-00000000.bun-build");
  const held = join(repo, ".feedface-00000000.bun-build");
  writeFileSync(stale, "stale");
  writeFileSync(held, "held");
  const now = Date.now();
  const old = new Date(now - 2 * 3600 * 1000);
  utimesSync(stale, old, old);
  utimesSync(held, old, old);
  const fd = openSync(held, "r");
  try {
    const run = (args: readonly string[]) => args[0] === "lsof"
      ? { code: 0, stdout: `n${held}\n`, stderr: "" } : clearRun();
    const plan = planScratch(home, { ...depsFor({ run, now }), now });
    expect(plan.bunBuilds).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: stale, action: "REAP", reason: "bun-build-stale-no-open-fd" }),
      expect.objectContaining({ path: held, action: "KEEP", reason: "bun-build-open-fd" }),
    ]));
    const result = applyScratch(home, { ...depsFor({ run, now }), home, now });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(held)).toBe(true);
    expect(result.bunBuilds).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: stale, action: "REAP", reason: "bun-build-reaped" }),
      expect.objectContaining({ path: held, action: "KEEP", reason: "bun-build-open-fd" }),
    ]));
    const lines = readFileSync(reapLogPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({ event: "bun-build", dir: stale, action: "REAP" }));
    expect(lines).toContainEqual(expect.objectContaining({ event: "bun-build", dir: held, action: "KEEP" }));
  } finally {
    closeSync(fd);
  }
});

test("scratch apply writes one metrics receipt and rotates logs at one MiB", () => {
  const home = useState();
  const root = agentTmp("scratch-receipt");
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const logPath = reapLogPath(home);
  mkdirSync(join(home, "omp-kit"), { recursive: true });
  writeFileSync(logPath, "x".repeat(1_048_577));
  const now = Date.now();
  const result = applyScratch(home, {
    ...depsFor({ now, statfs: () => ({ bavail: 20, blocks: 100 }) }),
    home,
    now,
  });
  expect(readFileSync(logPath).byteLength).toBeLessThanOrEqual(1_048_576);
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.filter(row => row.event === "run-receipt")).toHaveLength(1);
  expect(result.receipt ?? null).toMatchObject({
    free_pct_before: 20,
    free_pct_after: 20,
    reaped_gb: 0,
    quarantined_gb: 0,
    failed_count: 0,
    refused_count: 0,
  });
});
test("failed expiry stays in the failed bucket across ticks", () => {
  const home = useState();
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const path = join(qt, quarantineEntryFor("failed-persist", new Date(now - 25 * 3600 * 1000)));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "data"), "held");
  backdateTree(path, 80 * 3600 * 1000, now);
  const failed = applyQuarantineExpiry(home, {
    ...depsFor(), home, now, remove: () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    },
  } as ApplyDeps);
  const marked = `${path}.delete-${process.pid}`;
  expect(failed).toContainEqual(expect.objectContaining({
    dir: marked, reason: "delete-failed", cause: "permission",
  }));
  expect(existsSync(path)).toBe(false);
  expect(existsSync(marked)).toBe(true);
  expect(quarantineBuckets(home, now).failed.entries).toBe(1);
  expect(quarantineBuckets(home, now).expiredHeld.entries).toBe(0);
});

test("failure marker does not rename an open or replaced quarantine directory", () => {
  const home = useState();
  const now = Date.now();
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const openPath = join(qt, quarantineEntryFor("open-failure", new Date(now - 25 * 3600 * 1000)));
  mkdirSync(openPath, { recursive: true });
  writeFileSync(join(openPath, "data"), "open");
  backdateTree(openPath, 80 * 3600 * 1000, now);
  let lsofCalls = 0;
  const openResult = applyQuarantineExpiry(home, {
    ...depsFor(), home, now,
    run: () => ++lsofCalls === 1 ? clearRun() : { code: 0, stdout: "open descriptor\n", stderr: "" },
    remove: () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    },
  } as ApplyDeps);
  expect(openResult).toContainEqual(expect.objectContaining({
    dir: openPath, reason: "delete-failed", cause: "open-fd",
  }));
  expect(existsSync(openPath)).toBe(true);
  expect(existsSync(`${openPath}.delete-${process.pid}`)).toBe(false);

  const replacedPath = join(qt, quarantineEntryFor("replaced-failure", new Date(now - 25 * 3600 * 1000)));
  mkdirSync(replacedPath, { recursive: true });
  writeFileSync(join(replacedPath, "data"), "replaced");
  backdateTree(replacedPath, 80 * 3600 * 1000, now);
  const displaced = join(qt, "displaced-original");
  const replacedResult = applyQuarantineExpiry(home, {
    ...depsFor(), home, now,
    remove: (path: string) => {
      // Swap only the entry under test; other expired entries just fail.
      if (path === replacedPath) {
        renameSync(replacedPath, displaced);
        mkdirSync(replacedPath);
      }
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    },
  } as ApplyDeps);
  expect(replacedResult).toContainEqual(expect.objectContaining({
    dir: replacedPath, reason: "delete-failed", cause: "permission",
  }));
  expect(existsSync(replacedPath)).toBe(true);
  expect(existsSync(`${replacedPath}.delete-${process.pid}`)).toBe(false);
});

test("lsof snapshot: a socket open-path holds its dir", () => {
	const fab = takeLsofSnapshot(() => ({ code: 0, stdout: "p9\nn/cache/live.sock\n", stderr: "" }));
	expect(snapshotClear(fab, "/cache")).toBe(false);
	expect(snapshotClear(fab, "/other")).toBe(true);
});

/** sun_path caps a bound unix socket path at 103 bytes on macOS. */
const SUN_PATH_MAX = 103;

/**
 * The platform temp root (Darwin `getconf DARWIN_USER_TEMP_DIR`, else /tmp), never `$TMPDIR`:
 * `omp-kit scratch new --export` and the full-suite gate point TMPDIR into the deep checkout itself.
 */
function platformTempRoot(): string {
	if (process.platform !== "darwin") return realpathSync("/tmp");
	const located = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
	if (located.exitCode !== 0) throw new Error("cannot locate macOS private temp root");
	return realpathSync(located.stdout.toString().trim());
}

/**
 * A fresh realpath'd dir under which `stale.9/s` still fits sun_path. A deep checkout (pre-push
 * gate nesting, an archive replay, a scratch export) falls back to an omp-* dir under the platform
 * temp root. It fails loud when neither fits: a skipped live-socket half reads as a pass, which hid
 * RCHSOCK1's negative from its first non-author replay.
 */
function socketFixtureRoot(primary: string = AGENT_TMP): string {
	for (const [base, label] of [[primary, "rs"], [platformTempRoot(), "omp-rs"]] as const) {
		const root = realpathSync(ownedTmp(label, { root: base }).path);
		roots.push(root);
		if (join(root, "stale.9", "s").length <= SUN_PATH_MAX) return root;
	}
	throw new Error(`no fixture root keeps a socket path within sun_path (${SUN_PATH_MAX} bytes)`);
}

// RCHSOCK1 planted: the fallback ignores TMPDIR. A TMPDIR-following fallback fails both live-socket
// tests in every gate archive and in every scratch export deeper than 73 bytes (5-digit pid).
test("socket fixture root falls back to the platform temp root when the checkout and TMPDIR are both deep (planted)", () => {
	const base = agentTmp("deep");
	roots.push(base);
	const deep = join(base, "d".repeat(SUN_PATH_MAX));
	mkdirSync(deep);
	process.env.TMPDIR = deep;
	const root = socketFixtureRoot(deep);
	expect(join(root, "stale.9", "s").length).toBeLessThanOrEqual(SUN_PATH_MAX);
	expect(root.startsWith(`${platformTempRoot()}/`)).toBe(true);
});

async function connects(sock: string): Promise<boolean> {
	try {
		const client = await Bun.connect({ unix: sock, socket: { data() {}, error() {} } });
		client.end();
		return true;
	} catch {
		return false;
	}
}

test("lsof snapshot: a live unix socket holds its dir, a closed listener releases it", async () => {
	const dir = socketFixtureRoot();
	const sock = join(dir, "s");
	const server = Bun.listen({ unix: sock, socket: { data() {} } });
	try {
		const held = takeLsofSnapshot(defaultRunner);
		expect(held).not.toBeNull();
		expect(snapshotClear(held, dir)).toBe(false);
	} finally {
		server.stop();
	}
	const released = takeLsofSnapshot(defaultRunner);
	expect(released).not.toBeNull();
	expect(snapshotClear(released, dir)).toBe(true);
}, 60000);

// RCHSOCK1 (ompkit-774u.6.4) AC2: a cleanup run over a cache dir that holds a live unix socket
// leaves the socket in place and reports the dir skipped. The control half proves the skip comes
// from the live listener: the identical dir, once the listener is gone, is quarantined (moved out).
test("scratch apply over a dir holding a live unix socket skips it, and quarantines it once the listener is gone", async () => {
	const { home, state } = cliHome();
	const root = socketFixtureRoot();
	const stale = join(root, "stale.9");
	const sock = join(stale, "s");
	mkdirSync(stale, { recursive: true });
	writeFileSync(join(stale, "data"), "stale\n");
	const server = Bun.listen({ unix: sock, socket: { data() {} } });
	const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakePs().dir}:${process.env.PATH ?? ""}` };
	try {
		backdateTree(stale, 73 * 3600 * 1000, Date.now());
		const held = cli(["scratch", "apply", "--apply", "--yes"], home, env);
		const heldRow = held.envelope.data.sessions.find((value: { dir: string }) => value.dir === stale);
		expect(heldRow?.action).toBe("SKIP");
		expect(heldRow?.reason).toBe("owner-released-but-open-fds-present");
		expect(lstatSync(sock).isSocket()).toBe(true);
		expect(existsSync(join(stale, "data"))).toBe(true);
		expect(await connects(sock)).toBe(true);
	} finally {
		server.stop(true);
	}
	backdateTree(stale, 73 * 3600 * 1000, Date.now());
	const released = cli(["scratch", "apply", "--apply", "--yes"], home, env);
	const releasedRow = released.envelope.data.sessions.find((value: { dir: string }) => value.dir.includes("/stale.9"));
	expect(releasedRow?.action).toBe("QUARANTINE");
	expect(releasedRow?.reason).toBe("unowned-idle-72h-quarantined");
	expect(existsSync(stale)).toBe(false);
}, 120000);

// REAPSKIP1 (ompkit-3tgm): every SKIP class has a terminal path. An owner-label-invalid
// dir whose owner is dead, fd-clear and 73 h idle quarantines; a live one stays SKIP.
test("an invalid owner label still reaches quarantine once its owner is dead and idle", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const now = Date.now();
  const dead = deadPid();
  const dir = sessionDir(root, "bad label", dead);
  writeFileSync(join(dir, ".owner"), ownerText(deadFields("bad label", dead)));
  writeFileSync(join(dir, "payload"), "keep\n");
  backdateTree(dir, 73 * 3600 * 1000, now);
  const deps = { ...depsFor({ now }), home, now };
  expect(inspectSession(dir, root, deps)).toMatchObject({ action: "SKIP", reason: "owner-label-invalid" });
  const planned = inspectOne(dir, root, deps);
  expect(planned).toMatchObject({ action: "QUARANTINE", reason: "owner-label-invalid-idle-72h-would-quarantine" });
  const applied = applyUnowned(dir, root, deps, planned!);
  expect(applied).toMatchObject({ action: "QUARANTINE", reason: "owner-label-invalid-idle-72h-quarantined" });
  expect(existsSync(dir)).toBe(false);
  expect(readFileSync(join(applied.dir, "payload"), "utf8")).toBe("keep\n");

  const liveDir = sessionDir(root, "also bad", process.pid);
  writeFileSync(join(liveDir, ".owner"), ownerText(liveFields("also bad")));
  expect(inspectOne(liveDir, root, deps)).toMatchObject({ action: "SKIP", reason: "owner-label-invalid" });
  expect(existsSync(liveDir)).toBe(true);
});

// UNOWNEDGATE1 (ompkit-qmdtp), J-2026-10-22-03: while its disk is at RECLAIM pressure an unowned dir idle
// 12 h with no open fds is quarantined; at normal pressure the same dir waits out 72 h, a recently
// touched dir stays LIVE under pressure, and open fds still stop the move.
test("an unowned dir idle 12 h is quarantined only while its disk is at RECLAIM pressure", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const now = Date.now();
  const leftover = join(root, "export-leftover");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "data"), "x\n");
  backdateTree(leftover, 13 * 3600 * 1000, now);
  const running = join(root, "export-running");
  mkdirSync(running, { recursive: true });
  writeFileSync(join(running, "data"), "y\n");
  backdateTree(running, 3600 * 1000, now);
  const tight = { ...depsFor({ now, statfs: () => ({ bavail: 12, blocks: 100 }) }), home, now };
  const roomy = { ...depsFor({ now, statfs: () => ({ bavail: 40, blocks: 100 }) }), home, now };
  const busy = { ...tight, run: () => ({ code: 0, stdout: `bun 4242 josh cwd DIR ${leftover}\n`, stderr: "" }) };

  expect(inspectOne(leftover, root, roomy)).toMatchObject({ action: "LIVE", reason: "unowned-but-active" });
  expect(inspectOne(running, root, tight)).toMatchObject({ action: "LIVE", reason: "unowned-but-active" });
  const planned = inspectOne(leftover, root, tight);
  expect(planned).toMatchObject({ action: "QUARANTINE", reason: "unowned-idle-12h-reclaim-would-quarantine" });
  expect(applyUnowned(leftover, root, roomy, planned!)).toMatchObject({ action: "LIVE", reason: "unowned-but-active" });
  expect(applyUnowned(leftover, root, busy, planned!)).toMatchObject({ action: "SKIP", cause: "open-fd" });
  expect(existsSync(leftover)).toBe(true);
  const applied = applyUnowned(leftover, root, tight, planned!);
  expect(applied).toMatchObject({ action: "QUARANTINE", reason: "unowned-idle-12h-reclaim-quarantined" });
  expect(existsSync(leftover)).toBe(false);
  expect(readFileSync(join(applied.dir, "data"), "utf8")).toBe("x\n");
});

// REAPSKIP1 (ompkit-3tgm): the recorded quarantine reason keeps the plan's class, so a
// malformed owner that rode the unowned path is named malformed, not unowned.
test("an idle malformed owner quarantines under a malformed reason", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const now = Date.now();
  const malformed = join(root, "malformed.3");
  mkdirSync(malformed, { recursive: true });
  writeFileSync(join(malformed, ".owner"), "pid=not-an-integer\n");
  writeFileSync(join(malformed, "data"), "retain\n");
  backdateTree(malformed, 73 * 3600 * 1000, now);
  const deps = { ...depsFor({ now }), home, now };
  const planned = inspectOne(malformed, root, deps);
  expect(planned).toMatchObject({ action: "QUARANTINE", reason: "unowned-idle-72h-would-quarantine" });
  const applied = applyUnowned(malformed, root, deps, planned!);
  expect(applied).toMatchObject({ action: "QUARANTINE", reason: "malformed-owner-idle-72h-quarantined" });
  expect(existsSync(malformed)).toBe(false);
  expect(readFileSync(join(applied.dir, "data"), "utf8")).toBe("retain\n");
});

// REAPSKIP1 (ompkit-3tgm) positive: an induced quarantine-creation failure names the exact
// path, action and OS error on the verdict and fails the run instead of vanishing.
test("a blocked quarantine dir fails the action with its OS error recorded", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const now = Date.now();
  const dead = join(root, "stranded");
  mkdirSync(dead, { recursive: true });
  writeFileSync(join(dead, ".owner"), "pid=not-an-integer\n");
  writeFileSync(join(dead, "data"), "dead\n");
  backdateTree(dead, 73 * 3600 * 1000, now);
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  chmodSync(qt, 0o555);
  try {
    const deps = { ...depsFor({ now }), home, now };
    const planned = inspectOne(dead, root, deps);
    expect(planned?.reason).toBe("unowned-idle-72h-would-quarantine");
    const applied = applyUnowned(dead, root, deps, planned!);
    expect(applied).toMatchObject({ dir: dead, action: "SKIP", reason: "atomic-quarantine-failed" });
    expect(applied.error ?? "").toMatch(/EACCES/);
    expect(isApplyFailure(applied)).toBe(true);
    expect(existsSync(dead)).toBe(true);
  } finally {
    chmodSync(qt, 0o755);
  }
});

// REAPSKIP1 (ompkit-3tgm) positive: a quarantine dir that cannot be created fails with
// the OS error instead of an empty refusal.
test("a file blocking the quarantine dir fails creation with its OS error recorded", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const now = Date.now();
  const dead = sessionDir(root, "gone", deadPid());
  const pid = Number(dead.split(".").at(-1));
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", pid)));
  backdateTree(dead, 73 * 3600 * 1000, now);
  mkdirSync(quarantineDir(home), { recursive: true });
  rmSync(quarantineDir(home), { recursive: true, force: true });
  writeFileSync(quarantineDir(home), "not a directory\n");
  const deps = { ...depsFor({ now }), home, now };
  const verdict = inspectSession(dead, root, deps);
  expect(verdict.action).toBe("REAP");
  const applied = applyReap(dead, root, verdict, deps);
  expect(applied).toMatchObject({ action: "SKIP", reason: "quarantine-create-failed" });
  expect(applied.error ?? "").toMatch(/EEXIST|ENOTDIR/);
  expect(isApplyFailure(applied)).toBe(true);
  expect(existsSync(dead)).toBe(true);
});

// REAPSKIP1 (ompkit-3tgm) negative: an unexpected OS failure on the rollback rename is a
// recorded failure (quarantine-rollback-failed), never swallowed as a refusal. The lsof
// hook poisons only quarantine paths: it reports an open fd (forcing the rollback) and
// plants a file where the dir stood (failing the rollback rename).
test("a failed quarantine rollback is a failure with its OS error, not a refusal", () => {
  const home = useState();
  const root = agentTmp("scratch");
  roots.push(root);
  const qt = quarantineDir(home);
  const dead = sessionDir(root, "gone", deadPid());
  const pid = Number(dead.split(".").at(-1));
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", pid)));
  writeFileSync(join(dead, "payload"), "preserve me\n");
  const run = (args: readonly string[]) => {
    const target = args[args.length - 1] ?? "";
    if (args[0] === "lsof" && target.startsWith(`${qt}/`)) {
      writeFileSync(dead, "rollback blocker\n");
      return { code: 0, stdout: `sh 999 test ${target}/payload`, stderr: "" };
    }
    return clearRun();
  };
  const deps = { ...depsFor({ run }), home };
  const verdict = inspectSession(dead, root, deps);
  expect(verdict.action).toBe("REAP");
  const applied = applyReap(dead, root, verdict, deps);
  expect(applied).toMatchObject({ action: "SKIP", reason: "quarantine-rollback-failed" });
  expect(applied.error ?? "").toMatch(/ENOTDIR|EEXIST|EPERM/);
  expect(isApplyFailure(applied)).toBe(true);
  expect(applied.dir.startsWith(`${qt}/`)).toBe(true);
  expect(readFileSync(join(applied.dir, "payload"), "utf8")).toBe("preserve me\n");
});

// REAPSKIP1 (ompkit-3tgm) positive, CLI: a real apply whose quarantine rename is refused
// by permissions exits nonzero with the path, action and OS error on stderr and the receipt.
test("scratch apply names a permission failure on stderr and the receipt and exits nonzero", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
  roots.push(root);
  const dead = sessionDir(root, "gone", deadPid());
  writeFileSync(join(dead, ".owner"), ownerText(deadFields("gone", Number(dead.split(".").at(-1)))));
  writeFileSync(join(dead, "data"), "dead\n");
  backdateTree(dead, 73 * 3600 * 1000, Date.now());
  const qt = join(state, "omp-kit", "scratch-quarantine");
  mkdirSync(qt, { recursive: true });
  chmodSync(qt, 0o555);
  try {
    const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}` };
    const result = cli(["scratch", "apply", "--apply", "--yes"], home, env);
    expect(result.code).toBe(1);
    const row = result.envelope.data.sessions.find((value: { dir: string }) => value.dir === dead);
    expect(row).toMatchObject({ action: "SKIP", reason: "atomic-quarantine-failed" });
    expect(row.error ?? "").toMatch(/EACCES/);
    expect(result.envelope.data.receipt).toMatchObject({ failed_count: 1, refused_count: 0 });
    expect(result.stderr).toContain(`SKIP ${dead} (atomic-quarantine-failed)`);
    const progress = result.stderr.split("\n").find(line => line.includes(dead) && line.includes("atomic-quarantine-failed"));
    expect(progress ?? "").toMatch(/EACCES/);
    expect(existsSync(dead)).toBe(true);
  } finally {
    chmodSync(qt, 0o755);
  }
}, 30000);

// REAPSKIP1 (ompkit-3tgm) negative, CLI: a run whose only refused action is a correctly
// refused quarantine expiry (owner provably alive) exits 0 with correct counts.
test("scratch apply with only a correctly refused expiry exits 0 with refused counts", () => {
  const { home, state } = cliHome();
  const root = agentTmp("scratch");
  roots.push(root);
  const qt = join(state, "omp-kit", "scratch-quarantine");
  mkdirSync(qt, { recursive: true });
  const entry = quarantineEntryFor("held.1", new Date(Date.now() - 25 * 3600 * 1000));
  const held = join(qt, entry);
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, ".owner"), ownerText(liveFields("held")));
  writeFileSync(join(held, "data"), "live\n");
  const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}` };
  const result = cli(["scratch", "apply", "--apply", "--yes"], home, env);
  expect(result.code).toBe(0);
  expect(result.envelope.data.receipt).toMatchObject({ failed_count: 0, refused_count: 1 });
  expect(result.envelope.data.expired).toContainEqual(
    expect.objectContaining({ dir: held, action: "SKIP", reason: "quarantine-owner-active" }));
  expect(existsSync(join(held, "data"))).toBe(true);
}, 30000);

// PIDIDENT1: the scheduled scratch reaper honors owner incarnation, never the creator PID retained in the directory name.
test("scratch-reaper recognizes a live process owner with a rehomed directory suffix", () => {
	const { home, state } = cliHome();
	const root = agentTmp("scratch");
	roots.push(root);
	const live = join(root, "mismatch-live");
	mkdirSync(live, { recursive: true });
	writeFileSync(join(live, ".owner"), ownerText(liveFields("mismatch-live")));
	writeFileSync(join(live, "work"), "live\n");
	const env = { OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, OMP_KIT_LOAD_OVERRIDE: "0.5/8",
		PATH: `${fakeLsof().dir}:${process.env.PATH ?? ""}` };
	const run = cli(["service", "run", "scratch-reaper"], home, env);
	expect(run.code).toBe(0);
	const sessions = run.envelope.data.sessions as { dir: string; action: string; reason: string }[];
	expect(sessions.find(value => value.dir === live)).toMatchObject({ action: "LIVE", reason: "owner-alive" });
	expect(existsSync(live)).toBe(true);
}, 30_000);

test("SCRATCHLEAK1: legacy colon text owners parse; bare prose does not", () => {
	expect(parseTextOwner("agent: ReplayNOFIXKIT\nlabel: kg88-remeasure\nrepo: omp-kit\nbead: ompkit-kg88\ncreated: 2026-10-18\n"))
		.toMatchObject({ agent: "ReplayNOFIXKIT", label: "kg88-remeasure", bead: "ompkit-kg88" });
	expect(parseTextOwner("Grade303")).toBeNull();
	expect(parseTextOwner("label: w\nbogus: 1\n")).toBeNull();
	expect(parseTextOwner("label: w\nlabel: w\n")).toBeNull();
	expect(parseOwnerFile("pid: 42\nlabel: w\nrepo: r\ncreated: 2026-10-18\n")).toMatchObject({ pid: 42, bead: null });
	expect(parseOwnerFile("pid: 42\nlabel: w\nrepo: r\ncreated: 2026-10-18\nbead: ompkit-1\n")).toMatchObject({ pid: 42, bead: "ompkit-1" });
});

function textFixture(owner: string): { dir: string; root: string } {
	const root = agentTmp("text-owner");
	roots.push(root);
	const dir = join(root, `case.${process.pid}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), owner);
	return { dir, root };
}

function textRun(lsofOpen: boolean, beadStatus: string | null) {
	return (args: readonly string[]) => {
		if (args[0] === "lsof") return lsofOpen ? { code: 0, stdout: "bash 1234 cwd DIR", stderr: "" } : { code: 1, stdout: "", stderr: "" };
		if (args[0] === "br") return beadStatus === null
			? { code: 1, stdout: "", stderr: "not found" }
			: { code: 0, stdout: JSON.stringify([{ id: "b", status: beadStatus }]), stderr: "" };
		return { code: 127, stdout: "", stderr: "" };
	};
}

test("SCRATCHLEAK1: text owner, closed bead, no fds reaps; open fds keep it (planted)", () => {
	const owner = (repo: string) => `agent: X\nlabel: t\nrepo: ${repo}\nbead: ompkit-kg88\ncreated: 2026-10-18\n`;
	const closed = textFixture(owner(fixtureRepo));
	const reaped = inspectSession(closed.dir, closed.root, depsFor({ run: textRun(false, "closed") as never }));
	expect(reaped).toMatchObject({ action: "REAP", reason: "text-owner-bead-closed-no-fds" });
	const held = textFixture(owner(fixtureRepo));
	const kept = inspectSession(held.dir, held.root, depsFor({ run: textRun(true, "closed") as never }));
	expect(kept).toMatchObject({ action: "LIVE", reason: "text-owner-open-fds-present" });
});

test("SCRATCHLEAK1: text owner with no bead field reaps when clear; open bead stays live", () => {
	const plain = textFixture(`agent: X\nlabel: t\nrepo: ${fixtureRepo}\ncreated: 2026-10-18\n`);
	expect(inspectSession(plain.dir, plain.root, depsFor({ run: textRun(false, null) as never })))
		.toMatchObject({ action: "REAP", reason: "text-owner-no-bead-no-fds" });
	const open = textFixture(`agent: X\nlabel: t\nrepo: ${fixtureRepo}\nbead: ompkit-open\ncreated: 2026-10-18\n`);
	expect(inspectSession(open.dir, open.root, depsFor({ run: textRun(false, "open") as never })))
		.toMatchObject({ action: "LIVE", reason: "text-owner-bead-open" });
});

test("SCRATCHLEAK1: scratch new writes a valid JSON owner carrying the bead", () => {
	const repo = agentTmp("newrepo");
	roots.push(repo);
	registerRepoScratchRoot(repo);
	const made = createScratch("probe", repo, depsFor(), { bead: "ompkit-fp72.19.1.43" }, true, join(repo, "scratch-budgets.json"));
	expect(made.ok).toBe(true);
	const raw = readFileSync(join(made.dir, ".owner"), "utf8");
	expect(JSON.parse(raw)).toMatchObject({ label: "probe", bead: "ompkit-fp72.19.1.43" });
	expect(parseOwnerFile(raw)).toMatchObject({ bead: "ompkit-fp72.19.1.43" });
	expect(made.exportLine).toBe(`export TMPDIR=${made.dir}`);
});

/**
 * A one-commit git repo the test owns. Never the suite's own checkout: a scratch export has no .git
 * and sits in the enclosing repo's ignored var/agent-tmp, and the full-suite gate archive is a
 * commitless `git init`, so neither has a HEAD to export.
 */
function commitFixture(): { source: string; head: string } {
	const source = agentTmp("export-src");
	roots.push(source);
	mkdirSync(join(source, "sub"));
	writeFileSync(join(source, "package.json"), "{}\n");
	writeFileSync(join(source, "sub", "inner.txt"), "inner\n");
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CONFIG_NOSYSTEM" && key !== "GIT_CONFIG_GLOBAL") delete env[key];
	const git = (...args: string[]): string => {
		const child = Bun.spawnSync(["git", "-C", source, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", ...args],
			{ env, stdout: "pipe", stderr: "pipe" });
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return child.stdout.toString().trim();
	};
	git("init", "-q");
	git("add", "package.json", "sub");
	git("commit", "-q", "-m", "fixture");
	return { source, head: git("rev-parse", "HEAD") };
}

test("SCRATCHLEAK1: export materializes the exact commit; unknown sha refused (planted)", () => {
	const { source, head } = commitFixture();
	const repo = agentTmp("newrepo");
	roots.push(repo);
	registerRepoScratchRoot(repo);
	const made = createScratch("exp", repo, depsFor(), {}, true, join(repo, "scratch-budgets.json"));
	expect(made.ok).toBe(true);
	expect(exportCommitToScratch(source, head, made.dir, defaultRunner)).toBeNull();
	expect(readFileSync(join(made.dir, "package.json"), "utf8")).toBe("{}\n");
	expect(readFileSync(join(made.dir, "sub", "inner.txt"), "utf8")).toBe("inner\n");
	expect(exportCommitToScratch(source, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", made.dir, defaultRunner)).toBe("export-commit-unknown");
}, 60000);

// SCRATCHLEAK1 planted: `scratch new --export` exports from its cwd. Below the work-tree root a bare
// `git archive` holds only that subtree, and an untracked one (an export nested in its repo's
// var/agent-tmp) is an empty tar with exit 0, so the export reported OK with nothing in it.
test("SCRATCHLEAK1: export asked from a subdirectory still materializes the whole commit (planted)", () => {
	const { source, head } = commitFixture();
	mkdirSync(join(source, "loose"));
	for (const from of ["sub", "loose"]) {
		const repo = agentTmp("newrepo");
		roots.push(repo);
		registerRepoScratchRoot(repo);
		const made = createScratch("exp", repo, depsFor(), {}, true, join(repo, "scratch-budgets.json"));
		expect(made.ok).toBe(true);
		expect(exportCommitToScratch(join(source, from), head, made.dir, defaultRunner), from).toBeNull();
		expect(existsSync(join(made.dir, "package.json")), from).toBe(true);
		expect(existsSync(join(made.dir, "sub", "inner.txt")), from).toBe(true);
	}
}, 60000);

test("SCRATCHLEAK1: pipe-format single-line text owners parse", () => {
	expect(parseTextOwner("agent: X | label: t | repo: omp-kit | bead: ompkit-1 | created: 2026-10-18"))
		.toMatchObject({ agent: "X", label: "t", bead: "ompkit-1" });
	expect(parseTextOwner("label: t | bogus: 1")).toBeNull();
});

test("SCRATCHLEAK1: text owner with gone repo reaps when clear", () => {
	const gone = textFixture(`agent: X\nlabel: t\nrepo: /no/such/repo-xyz\nbead: ompkit-1\ncreated: 2026-10-18\n`);
	expect(inspectSession(gone.dir, gone.root, depsFor({ run: textRun(false, null) as never })))
		.toMatchObject({ action: "REAP", reason: "text-owner-repo-gone-no-fds" });
});

function quotaRepo(): { repo: string; ledger: string } {
	const repo = agentTmp("quotarepo");
	roots.push(repo);
	registerRepoScratchRoot(repo);
	return { repo, ledger: join(repo, "budgets.json") };
}

test("SCRATCHQUOTA1: seat at cap is refused; release re-admits (planted)", () => {
	const saved = process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
	process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES = "250";
	try {
		const { repo, ledger } = quotaRepo();
		const first = createScratch("q1", repo, depsFor(), { budgetBytes: 100 }, true, ledger);
		expect(first.ok).toBe(true);
		const refused = createScratch("q2", repo, depsFor(), { budgetBytes: 200 }, true, ledger);
		expect(refused.ok).toBe(false);
		expect(refused.reason).toBe("seat-budget-exceeded");
		expect(refused.detail ?? "").toContain("q2");
		expect(releaseBudgetEntry(ledger, first.dir)).toBe(true);
		const admitted = createScratch("q3", repo, depsFor(), { budgetBytes: 200 }, true, ledger);
		expect(admitted.ok).toBe(true);
	} finally {
		if (saved === undefined) delete process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
		else process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES = saved;
	}
});
test("SCRATCHQUOTA1: missing scratch roots release stale reservations without freeing live dirs", () => {
	const saved = process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
	process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES = "250";
	try {
		const { repo, ledger } = quotaRepo();
		const missing = join(repo, "var", "agent-tmp", "removed.1");
		writeFileSync(ledger, JSON.stringify({ version: 1, dirs: {
			[missing]: { budget: 250, agent: "TurquoiseSummit:scratch-ledger-test", bead: null, released: false },
		} }));
		const deps = depsFor({ callerSeat: () => ({ agent: "TurquoiseSummit", sessions: ["scratch-ledger-test"], main: "scratch-ledger-test" }) });
		const admitted = createScratch("fresh", repo, deps, { budgetBytes: 1 }, true, ledger);
		expect(admitted.ok).toBe(true);
		expect(JSON.parse(readFileSync(ledger, "utf8")).dirs[missing]).toMatchObject({ released: true });

		const liveRepo = quotaRepo();
		const live = join(liveRepo.repo, "var", "agent-tmp", "still-live.1");
		mkdirSync(live, { recursive: true });
		writeFileSync(liveRepo.ledger, JSON.stringify({ version: 1, dirs: {
			[live]: { budget: 250, agent: "TurquoiseSummit:scratch-ledger-test", bead: null, released: false },
		} }));
		const refused = createScratch("blocked", liveRepo.repo, deps, { budgetBytes: 1 }, true, liveRepo.ledger);
		expect(refused).toMatchObject({ ok: false, reason: "seat-budget-exceeded" });
	} finally {
		if (saved === undefined) delete process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
		else process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES = saved;
	}
});


test("SCRATCHQUOTA1: corrupt ledger fails closed; unbudgeted dirs count the default", () => {
	const saved = process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
	process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES = "250";
	try {
		const { repo, ledger } = quotaRepo();
		writeFileSync(ledger, "not json{{{");
		expect(createScratch("qc", repo, depsFor(), { budgetBytes: 10 }, true, ledger).reason).toBe("ledger-unavailable");
		const { repo: repo2, ledger: ledger2 } = quotaRepo();
		const big = createScratch("qd", repo2, depsFor(), {}, true, ledger2);
		expect(big.ok).toBe(false);
		expect(big.reason).toBe("seat-budget-exceeded");
	} finally {
		if (saved === undefined) delete process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
		else process.env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES = saved;
	}
});

function ttlFixture(owner: string, run: (args: readonly string[]) => { code: number | null; stdout: string; stderr: string }): { dir: string; root: string; deps: ApplyDeps } {
	const home = useState();
	const root = agentTmp("ttl");
	roots.push(root);
	const dir = join(root, `ttl.${process.pid}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), owner);
	writeFileSync(join(dir, "data"), "ttl\n");
	return { dir, root, deps: { ...depsFor({ run: run as never }), home } };
}

function ttlRun(beadStatus: string | null) {
	return (args: readonly string[]) => {
		if (args[0] === "lsof") return { code: 1, stdout: "", stderr: "" };
		if (args[0] === "br") return beadStatus === null
			? { code: 1, stdout: "", stderr: "not found" }
			: { code: 0, stdout: JSON.stringify([{ id: "b", status: beadStatus }]), stderr: "" };
		return { code: 127, stdout: "", stderr: "" };
	};
}

test("BEADTTL1: closed-bead text owner deletes promptly without quarantine wait", () => {
	const root0 = agentTmp("ttl");
	roots.push(root0);
	const owner = `agent: X\nlabel: t\nrepo: ${root0}\nbead: ompkit-closed\ncreated: 2026-10-18\n`;
	const { dir, root, deps } = ttlFixture(owner, ttlRun("closed"));
	const verdict = inspectSession(dir, root, depsFor({ run: ttlRun("closed") as never }));
	expect(verdict.action).toBe("REAP");
	const applied = applyReap(dir, root, verdict, deps);
	expect(applied).toMatchObject({ action: "REAP" });
	expect(existsSync(dir)).toBe(false);
});

test("BEADTTL1: open bead at apply time rolls back and keeps the dir", () => {
	const root0 = agentTmp("ttl");
	roots.push(root0);
	const owner = `agent: X\nlabel: t\nrepo: ${root0}\nbead: ompkit-open\ncreated: 2026-10-18\n`;
	const { dir, root, deps } = ttlFixture(owner, ttlRun("closed"));
	const verdict = inspectSession(dir, root, depsFor({ run: ttlRun("closed") as never }));
	expect(verdict.action).toBe("REAP");
	const openDeps = { ...deps, run: ttlRun("open") as never };
	const applied = applyReap(dir, root, verdict, openDeps);
	expect(applied.action).toBe("SKIP");
	expect(existsSync(dir)).toBe(true);
});

test("V261FREE: free-prose owners parse bead from text, label from dirname", () => {
	expect(parseFreeOwner("BuildW12 (LavenderBeacon), bead cfs-j2wma.12\n", "BuildW12.j2wma12"))
		.toMatchObject({ label: "BuildW12", bead: "cfs-j2wma.12" });
	expect(parseFreeOwner("Grade303\n", "Grade303.9736")).toBeNull();
	expect(parseFreeOwner("beady: nothing here\n", "x.1")).toBeNull();
	expect(parseFreeOwner("xbead: nope\n", "x.1")).toBeNull();
	expect(repoOfRoot("/r/var/agent-tmp")).toBe("/r");
	expect(repoOfRoot("/r/other")).toBeNull();
});

test("V261FREE: free owner with closed bead reaps via root repo", () => {
	const vat = join(fixtureRepo, "var", "agent-tmp");
	const dir = join(vat, "BuildW12.j2wma12");
	if (!existsSync(dir)) mkdirSync(dir);
	roots.push(dir);
	writeFileSync(join(dir, ".owner"), "BuildW12 (LavenderBeacon), bead cfs-j2wma.12\n");
	const v = inspectSession(dir, vat, depsFor({ run: textRun(false, "closed") as never }));
	expect(v).toMatchObject({ action: "REAP", reason: "text-owner-bead-closed-no-fds" });
});
