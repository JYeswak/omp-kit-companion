// ompkit-774u.15 SCRATCHBIN1 enforcement (Joshua scope 2026-10-20): bead close, review hand-off, wave close,
// push and session end each refuse while the session holds an undisposed dir. Holds are owed until discharged:
// a quarantined hold is vetoed while its bead is open or unprovable, flagged but never deleted once expired,
// and only a closed bead discharges it back to the normal liveness path.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyQuarantineExpiry,
  defaultLiveness,
  disposalGate,
  quarantineDir,
  quarantineEntryFor,
  reapLogPath,
  releaseScratch,
  type ApplyDeps,
  type InspectDeps,
  type LivenessDeps,
  type SeatIdentity,
} from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { normalizeStart } from "../../src/kitlib/proc.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const NOW = Date.parse("2026-10-20T06:00:00.000Z");
const AGENT = "BuildBin4";
const SESSION = "01a156d7-e2c8-732e-abf4-e0333e62902b";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state], ["XDG_CONFIG_HOME", saved.config]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
  probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const seat = (agent: string | null, sessions: string[]) => (): SeatIdentity => ({ agent, sessions, main: sessions[0] ?? null });
const inspect = (caller: () => SeatIdentity): InspectDeps =>
  ({ liveness: noPid, run: () => ({ code: 1, stdout: "", stderr: "" }), now: NOW, callerSeat: caller });
const owner = (pid: number, label: string, extra = "", created = "2026-10-20T05:00:00Z") =>
  `pid=${pid}\nlabel=${label}\nrepo=${repo}\ncreated=${created}\n${extra}`;

function flagRows(home: string): { event: string; point?: string }[] {
  const path = reapLogPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { event: string; point?: string });
}

test("disposalGate refuses at every point while an undisposed dir is owed, and passes once it is released", () => {
  const root = ownedTmp("gates", { root: scratchParent }).path;
  const home = ownedTmp("gates-home", { root: scratchParent }).path;
  cleanup.push(root, home);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  process.env.XDG_STATE_HOME = join(home, "state");
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
  const dir = join(root, "work.61001");
  mkdirSync(dir);
  writeFileSync(join(dir, ".owner"), owner(61001, "work", `agent=${AGENT}\nsession=${SESSION}\nbin=throwaway\n`));
  const caller = inspect(seat(AGENT, [SESSION]));
  for (const point of ["review", "close", "wave", "push", "session-end"] as const) {
    const gate = disposalGate(home, point, caller, NOW);
    expect(gate.decision).toBe("refuse");
    expect(gate.unproven).toBe(false);
    expect(gate.owed.map(row => row.label)).toEqual(["work"]);
  }
  expect(flagRows(home).filter(row => row.event === "flag")).toHaveLength(5);
  expect(releaseScratch(dir, home, caller, { bin: "throwaway" }).ok).toBe(true);
  const after = disposalGate(home, "close", caller, NOW);
  expect(after.decision).toBe("ok");
  expect(after.owed).toEqual([]);
});

test("disposalGate charges only exact caller ownership and excludes live owners", () => {
  const root = ownedTmp("gates-boundary", { root: scratchParent }).path;
  const home = ownedTmp("gates-boundary-home", { root: scratchParent }).path;
  cleanup.push(root, home);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  process.env.XDG_STATE_HOME = join(home, "state");
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
  const liveOwner = (pid: number, label: string, agent: string) =>
    `pid=${pid}\nprocess_start=Mon Oct  5 13:27:00 2026\nlabel=${label}\nrepo=${repo}\ncreated=2026-10-20T05:00:00Z\nargv0=test\nagent=${agent}\nsession=${SESSION}\n`;
  for (const [name, text] of [
    ["parent.61002", liveOwner(61002, "parent", "ParentSeat")],
    ["sibling.61003", liveOwner(61003, "sibling", "SiblingSeat")],
    ["child-live.61006", liveOwner(61006, "child-live", "ChildSeat")],
    ["parent-live-3.61007", liveOwner(61007, "parent-live-3", "ParentSeat")],
  ] as const) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, ".owner"), text);
  }
  const live: LivenessDeps = {
    signalAlive: (pid) => pid !== process.pid,
    psVisible: (pid) => pid !== process.pid,
    processStart: (pid) => pid === process.pid ? "Thu Jan  1 00:00:00 1970" : "Mon Oct  5 13:27:00 2026",
    // The same world as an incarnation probe (ompkit-5m6ej): every other pid runs with the planted start.
    probe: (owner) => ({ state: owner.pid === process.pid ? "dead" : normalizeStart(owner.start) === "Mon Oct 5 13:27:00 2026" ? "live" : "reused",
      evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: null, reason: "planted" } }),
  };
  const caller: InspectDeps = { ...inspect(seat("ChildSeat", [SESSION])), liveness: live };
  const childClean = disposalGate(home, "review", caller, NOW);
  expect(childClean.decision).toBe("ok");
  expect(childClean.owed).toEqual([]);
  const own = join(root, "own.61004");
  mkdirSync(own);
  writeFileSync(join(own, ".owner"), owner(process.pid, "own"));
  const gate = disposalGate(home, "review", caller, NOW);
  expect(gate.decision).toBe("refuse");
  const parentOwn = join(root, "parent-own.61005");
  mkdirSync(parentOwn);
  writeFileSync(join(parentOwn, ".owner"), owner(process.pid, "parent-own", `agent=ParentSeat\nsession=${SESSION}\n`));
  const parentGate = disposalGate(home, "review", { ...inspect(seat("ParentSeat", [SESSION])), liveness: live }, NOW);
  expect(parentGate.decision).toBe("refuse");
  expect(parentGate.owed.map(row => row.label)).toEqual(["own", "parent-own"]);
  expect(gate.owed.map(row => row.label)).toEqual(["own"]);
});

test("disposalGate is fail-open when the ownership census cannot be listed: never a block, nothing logged", () => {
  const root = ownedTmp("gates-unproven", { root: scratchParent }).path;
  const home = ownedTmp("gates-unproven-home", { root: scratchParent }).path;
  cleanup.push(root, home);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  process.env.XDG_STATE_HOME = join(home, "state");
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
  const dir = join(root, "work.61002");
  mkdirSync(dir);
  writeFileSync(join(dir, ".owner"), owner(61002, "work", `agent=${AGENT}\nsession=${SESSION}\n`));
  const broken: InspectDeps = { ...inspect(seat(AGENT, [SESSION])), callerSeat: () => { throw new Error("seat lookup failed"); } };
  const gate = disposalGate(home, "push", broken, NOW);
  expect(gate.decision).toBe("ok");
  expect(gate.unproven).toBe(true);
  expect(gate.owed).toEqual([]);
  expect(flagRows(home)).toEqual([]);
});

test("quarantine expiry vetoes a hold while its bead is open or unprovable, and never deletes an expired hold", () => {
  const home = ownedTmp("gates-qt-home", { root: scratchParent }).path;
  cleanup.push(home);
  process.env.XDG_STATE_HOME = join(home, "state");
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
  delete process.env.XDG_CONFIG_HOME;
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const old = new Date(NOW - 8 * 24 * 3600 * 1000);
  const plantHold = (label: string, expires: string, created: string): string => {
    const path = join(qt, quarantineEntryFor(label, old));
    mkdirSync(path, { recursive: true });
    // A hold parses only when its expiry postdates creation (max 14 days out): backdate creation so each hold below
    // is well-formed and reaches the veto instead of the malformed-owner path.
    writeFileSync(join(path, ".owner"),
      owner(62001, label, `agent=${AGENT}\nsession=${SESSION}\nbin=hold\nbead=ompkit-774u.15\nexpires=${expires}\n`, created));
    return path;
  };
  const active = plantHold("hold-active.62001", "2026-10-25T00:00:00Z", "2026-10-15T00:00:00Z");
  const expired = plantHold("hold-expired.62002", "2026-10-19T00:00:00Z", "2026-10-10T00:00:00Z");
  const deps: ApplyDeps = { ...inspect(seat(AGENT, [SESSION])), home, beadClosed: () => false };
  const rows = applyQuarantineExpiry(home, deps);
  const reasonOf = (dir: string): string | undefined => rows.find(row => row.dir === dir)?.reason;
  expect(rows.find(row => row.dir === active)?.action).toBe("SKIP");
  expect(reasonOf(active)).toBe("quarantine-hold-active");
  // Planted negative: the expired hold is flagged, never deleted.
  expect(rows.find(row => row.dir === expired)?.action).toBe("SKIP");
  expect(reasonOf(expired)).toBe("quarantine-hold-expired");
  expect(existsSync(active)).toBe(true);
  expect(existsSync(expired)).toBe(true);
  const unprovable: ApplyDeps = { ...inspect(seat(AGENT, [SESSION])), home, beadClosed: () => null };
  const retried = applyQuarantineExpiry(home, unprovable);
  expect(retried.find(row => row.dir === active)?.reason).toBe("quarantine-hold-active");
  expect(existsSync(active)).toBe(true);
});

test("a closed bead discharges the hold back to the normal liveness path", () => {
  const home = ownedTmp("gates-discharge-home", { root: scratchParent }).path;
  cleanup.push(home);
  process.env.XDG_STATE_HOME = join(home, "state");
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
  delete process.env.XDG_CONFIG_HOME;
  const qt = quarantineDir(home);
  mkdirSync(qt, { recursive: true });
  const start = defaultLiveness().processStart(process.pid);
  expect(start).not.toBeNull();
  const path = join(qt, quarantineEntryFor("hold-discharged", new Date(NOW - 8 * 24 * 3600 * 1000)));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".owner"),
    `pid=${process.pid}\nprocess_start=${start}\nlabel=hold-discharged\nrepo=${repo}\ncreated_at=2026-10-15T00:00:00Z\nargv0=test\nagent=${AGENT}\nsession=${SESSION}\nbin=hold\nbead=ompkit-774u.15\nexpires=2026-10-25T00:00:00Z\n`);
  const deps: ApplyDeps = { liveness: defaultLiveness(), run: () => ({ code: 1, stdout: "", stderr: "" }), home, now: NOW, beadClosed: () => true };
  const rows = applyQuarantineExpiry(home, deps);
  // The veto did not fire: the live owner's dir falls through to the liveness path, and survives.
  expect(rows.some(row => row.dir === path && row.reason.startsWith("quarantine-hold-"))).toBe(false);
  expect(rows.find(row => row.dir === path)?.reason).toBe("quarantine-owner-active");
  expect(existsSync(path)).toBe(true);
});
