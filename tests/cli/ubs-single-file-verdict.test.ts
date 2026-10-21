import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "ubs-single-file-"));
const script = join(root, "scripts/ubs-single-file-verdict.sh");
const input = join(dir, "fixture.ts");
const fakeBin = join(dir, "bin");
const fakeUbs = join(fakeBin, "ubs");
writeFileSync(input, "export const control = 1;\n");
writeFileSync(fakeUbs, "#!/bin/sh\nprintf '%s\\n' '{\"status\":\"ok\",\"files\":1,\"findings\":[]}'\n");
chmodSync(fakeUbs, 0o755);

test("control explicit file produces a complete machine-readable verdict", () => {
  const run = Bun.spawnSync([script, "--file", input, "--repo", root], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout.toString())).toMatchObject({ status: "ok", files: 1 });
});

test("planted timeout is typed UNKNOWN and exits nonzero", () => {
  writeFileSync(fakeUbs, "#!/bin/sh\nsleep 5\n");
  chmodSync(fakeUbs, 0o755);
  const run = Bun.spawnSync([script, "--file", input, "--repo", root, "--timeout", "1"], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(2);
  expect(JSON.parse(run.stdout.toString())).toMatchObject({ status: "timeout", verdict: "UNKNOWN", timeout_seconds: 1 });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
