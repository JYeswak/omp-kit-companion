import { afterEach, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultLiveness, planScratch, type InspectDeps } from "../../src/scratch.ts";

const roots: string[] = [];
const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
const savedState = process.env.XDG_STATE_HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
  else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
});

const MB = 1024 * 1024;
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

function sparse(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

test("REAP2 planted: parent size excludes nested plan rows", () => {
  const state = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-nested-xdg-"));
  roots.push(state);
  process.env.XDG_STATE_HOME = state;
  const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scratch-nested-"));
  roots.push(root);
  process.env.OMP_KIT_SCRATCH_ROOTS = root;
  const parent = join(root, `session-omp-test.${process.pid}`);
  mkdirSync(parent, { recursive: true });
  const start = defaultLiveness().processStart(process.pid);
  if (start === null) throw new Error("process identity unavailable");
  writeFileSync(join(parent, ".owner"), `pid=${process.pid}\nprocess_start=${start}\nlabel=session-omp-test\nrepo=test\ncreated_at=2026-10-01T00:00:00Z\nargv0=test\n`);
  sparse(join(parent, "own.bin"), MB);
  const gone = deadPid();
  const child = join(parent, `omp-kit-integrations-${gone}-nested`);
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, ".owner"), `pid=${gone}\nprocess_start=Thu Jan  1 00:00:00 1970\nlabel=omp-kit-integrations\nrepo=test\ncreated_at=2026-10-01T00:00:00Z\nargv0=test\n`);
  sparse(join(child, "nested.bin"), 10 * MB);
  const plan = planScratch(state, depsFor());
  const parentRow = plan.sessions.find(entry => entry.dir === parent);
  const childRow = plan.sessions.find(entry => entry.dir === child);
  expect(childRow?.action).toBe("REAP");
  expect(parentRow?.sizeBytes).toBeLessThan(2 * MB);
  expect(parentRow?.sizeBytes).toBeGreaterThanOrEqual(MB);
  const total = plan.sessions.reduce((n, entry) => n + entry.sizeBytes, 0);
  expect(total).toBeLessThan(12 * MB);
});
