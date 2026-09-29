import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const limiter = resolve(import.meta.dir, "../../scripts/limit-process-tree.sh");

test("bounded G4 launcher kills a forked descendant before it can mutate an unrelated path", async () => {
 const work = mkdtempSync(join(tmpdir(), "omp-kit-timeout-"));
 const marker = join(work, "must-not-appear");
 try {
  const source = `(sleep 2; printf leaked > '${marker}') & wait`;
  const child = Bun.spawnSync(["/bin/sh", limiter, "1", "/bin/sh", "-c", source], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(124);
  // Platform-process integration: real SIGALRM/SIGTERM and a real descendant must outlive the 1s limit.
  const { promise, resolve: elapsed } = Promise.withResolvers<void>();
  setTimeout(elapsed, 2300);
  await promise;
  expect(existsSync(marker)).toBe(false);
 } finally { rmSync(work, { recursive: true, force: true }); }
});
