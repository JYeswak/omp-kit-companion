import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("commit-gate-merge");
afterAll(() => scratch.cleanup());

const installer = join(root, "scripts/install-commit-msg-bead.sh");
const gateSrc = join(root, "scripts/check-commit-gate.sh");

function baseEnv(extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TMPDIR: scratch.path,
    HOME: scratch.path,
    XDG_STATE_HOME: join(scratch.path, "state"),
    XDG_CONFIG_HOME: join(scratch.path, "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "MergeFixture",
    GIT_AUTHOR_EMAIL: "merge@invalid.example",
    GIT_COMMITTER_NAME: "MergeFixture",
    GIT_COMMITTER_EMAIL: "merge@invalid.example",
    OMP_KIT_GATE_EVENTS_SKIP: undefined,
    ...extra,
  };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[k];
  return env;
}

async function sh(cwd: string, argv: string[], extra: Record<string, string | undefined> = {}) {
  return runFixtureAsync(argv, { cwd, env: baseEnv(extra), floor_s: 30 });
}

let seq = 0;
async function fixtureRepo() {
  const repo = join(scratch.path, `merge-${++seq}`);
  mkdirSync(repo, { recursive: true });
  await sh(repo, ["git", "init", "--template=", "-q", "-b", "main"]);
  const bin = join(scratch.path, `brbin-${seq}`);
  mkdirSync(bin, { recursive: true });
  const calls = join(scratch.path, `br-calls-${seq}`);
  writeFileSync(calls, "");
  writeFileSync(join(bin, "br"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 3\n`);
  chmodSync(join(bin, "br"), 0o755);
  const withBr = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, BR_BIN: join(bin, "br"), BR_CALLS: calls };
  await sh(repo, ["git", "config", "user.email", "merge@invalid.example"]);
  await sh(repo, ["git", "config", "user.name", "Merge"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  await sh(repo, ["git", "add", "base.txt"]);
  await sh(repo, ["git", "commit", "-q", "--no-verify", "--allow-empty", "--message", "root"]);
  await sh(repo, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
  mkdirSync(join(repo, ".beads"), { recursive: true });
  writeFileSync(join(repo, ".beads", "beads.db"), "");
  const r = await sh(repo, ["sh", installer, repo], withBr);
  expect(r.rc).toBe(0);
  return { repo, withBr };
}

type GateRow = { gate: string; kind: string; act: string };
function isGateRow(value: unknown): value is GateRow {
  if (!value || typeof value !== "object") return false;
  return "gate" in value && "kind" in value && "act" in value
    && typeof value.gate === "string" && typeof value.kind === "string" && typeof value.act === "string";
}

test("COMMITMERGE1 aggregator refuses missing bead and missing level once with both findings", async () => {
  const { repo, withBr } = await fixtureRepo();
  const msg = join(repo, "msg");
  writeFileSync(msg, "fix widgets with no identity\n");
  const stateDir = join(scratch.path, `state-a-${seq}`);
  mkdirSync(stateDir, { recursive: true });
  const env = { ...withBr, BEADS_DB: join(repo, ".beads", "beads.db"), OMP_KIT_FINDINGS_JSON: "1", XDG_STATE_HOME: stateDir };
  await sh(repo, ["sh", gateSrc, "--prepare", msg], env);
  const chained = await sh(repo, ["sh", join(repo, ".git/hooks/commit-msg"), msg], env);
  const text = new TextDecoder().decode(chained.stdout) + new TextDecoder().decode(chained.stderr);
  expect(chained.rc, text).not.toBe(0);
  const rows = new TextDecoder().decode(chained.stdout).split("\n").filter((l) => l.startsWith("FINDING\t")).map((l) => l.split("\t"));
  expect(rows.length, text).toBe(2);
  expect([...new Set(rows.map((r) => r[1]))].sort(), text).toEqual(["55-omp-kit-commit-gate"]);
  const codes = rows.map((r) => r[2]).join("\n");
  expect(codes, text).toMatch(/40-omp-kit-commit-msg-bead/);
  expect(codes, text).toMatch(/41-omp-kit-commit-msg-vlevel/);
  const ledgerFile = join(stateDir, "omp-kit", "gate-events.jsonl");
  expect(existsSync(ledgerFile), text).toBe(true);
  const parsed: unknown[] = readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
  const refuses = parsed.filter(isGateRow).filter((r) => r.kind === "refuse" && r.act === "commit");
  const refuseGates = new Set(refuses.map((r) => r.gate));
  expect(refuseGates.has("55-omp-kit-commit-gate"), JSON.stringify(refuses)).toBe(true);
  expect(refuseGates.has("40-omp-kit-commit-msg-bead"), JSON.stringify(refuses)).toBe(false);
  expect(refuseGates.has("41-omp-kit-commit-msg-vlevel"), JSON.stringify(refuses)).toBe(false);
  // LOW: prepare mirrors the hook merge/template exemption; a merge-shaped
  // message the real commit admits must not produce a bead finding here.
  const mergeMsg = join(repo, "merge-msg");
  writeFileSync(mergeMsg, "Merge branch 'feature'\n");
  const preparedMerge = await sh(repo, ["sh", gateSrc, "--prepare", mergeMsg], env);
  const preparedMergeOut = new TextDecoder().decode(preparedMerge.stdout);
  expect(preparedMerge.rc, preparedMergeOut).toBe(0);
  expect(preparedMergeOut.includes("40-omp-kit-commit-msg-bead"), preparedMergeOut).toBe(false);
}, fixtureDeadlineS(120) * 1000);

test("COMMITMERGE1-kept hazards keep their own codes; second-branch push still refused", async () => {
  const { repo, withBr } = await fixtureRepo();
  const cm = join(repo, ".git/hooks/hooks.d/commit-msg");
  const pp = join(repo, ".git/hooks/hooks.d/pre-push");
  const pc = join(repo, ".git/hooks/hooks.d/pre-commit");
  for (const p of [
    join(pp, "30-omp-kit-on-main"),
    join(repo, ".git/hooks/hooks.d/reference-transaction/40-omp-kit-ref-txn-bead"),
    join(cm, "49-omp-kit-stale-worktree"),
    join(pc, "49-omp-kit-staged-pysafe"),
  ]) expect(existsSync(p), p).toBe(true);
  for (const p of [
    join(cm, "40-omp-kit-commit-msg-bead"),
    join(cm, "41-omp-kit-commit-msg-vlevel"),
    join(cm, "46-omp-kit-commit-notes"),
    join(cm, "48-omp-kit-deploy-step"),
  ]) expect(existsSync(p), p).toBe(false);
  // No folded helper may shadow the legacy sibling name in the chain root:
  // the moved legacy impl keeps working until the end-retire removes it.
  expect(existsSync(join(cm, "commit-msg-verification-level.sh")), "legacy sibling retired, no helper collision").toBe(false);
  for (const p of [
    join(cm, "scripts", "commit-msg-bead.sh"),
    join(cm, "scripts", "commit-msg-verification-level.sh"),
    join(cm, "scripts", "check-commit-notes.sh"),
    join(cm, "scripts", "check-deploy-step.sh"),
  ]) {
    expect(existsSync(p), p).toBe(true);
    expect(statSync(p).mode & 0o111, p).toBe(0);
  }
  await sh(repo, ["git", "checkout", "-q", "-b", "second"]);
  writeFileSync(join(repo, "second.txt"), "second\n");
  await sh(repo, ["git", "add", "second.txt"]);
  await sh(repo, ["git", "commit", "-q", "--no-verify", "--allow-empty", "--message", "[test] second ompkit-2w7h"]);
  const secondSha = new TextDecoder().decode((await sh(repo, ["git", "rev-parse", "HEAD"])).stdout).trim();
  const member = join(pp, "30-omp-kit-on-main");
  const emptyLines = await sh(repo, ["sh", member], withBr);
  expect(emptyLines.rc).toBe(0);
  const refused = await runFixtureAsync(["sh", member], {
    cwd: repo,
    env: baseEnv({ ...withBr }),
    stdin: `refs/heads/second ${secondSha} refs/heads/second 0000000000000000000000000000000000000000\n`,
    floor_s: 30,
  });
  const refusedText = new TextDecoder().decode(refused.stdout) + new TextDecoder().decode(refused.stderr);
  expect(refused.rc, refusedText).not.toBe(0);
  expect(refusedText, refusedText).toMatch(/30-omp-kit-on-main|only main is published|One history per repo/);
}, fixtureDeadlineS(120) * 1000);
